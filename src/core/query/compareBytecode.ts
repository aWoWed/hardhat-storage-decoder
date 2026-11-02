/**
 * Does the code deployed at an address match a contract's compiled runtime bytecode?
 *
 * Every byte has to match except the ones that legitimately differ between an artifact and a
 * deployment of it: the metadata trailer, immutables and library addresses. Nothing here reads
 * from the outside world, and nothing depends on which Hardhat major produced the artifact.
 */

import type { ByteRange, ExpectedBytecode } from './StorageQueryBuilder.js';

/**
 * The CBOR text-string encodings a metadata map can start with: the source hash when there is
 * one (`ipfs`, `bzzr0`, `bzzr1`), then `experimental`, then `solc`. solc writes them in that
 * order, so the first key of a real trailer is always one of these.
 */
const TRAILER_FIRST_KEYS = [
  '6469706673',
  '65627a7a7230',
  '65627a7a7231',
  '6c6578706572696d656e74616c',
  '64736f6c63',
];

/**
 * The start of a metadata map whose first entry is a source hash: map head, key, byte-string
 * head. Group 1 is `ipfs` (a 34-byte multihash); group 2 is `bzzr0` or `bzzr1` (32 bytes).
 */
const INTERIOR_HASH_MARKER = /a[1-3](?:(64697066735822)|(65627a7a723[01]5820))/g;

/** A library placeholder in unlinked bytecode: `__$` + 34 hex characters + `$__`, 20 bytes. */
const LIBRARY_PLACEHOLDER = /__\$[0-9a-f]{34}\$__/g;

/**
 * Remove the metadata trailer from code, if it has one.
 *
 * The last two bytes hold the CBOR length. They only count as such when that range fits the
 * code and starts with a CBOR map whose first key is a known metadata key, because code built
 * with `appendCBOR: false` ends in ordinary instructions.
 *
 * @param code - Bare lower-case hex.
 * @returns The code without the trailer; unchanged when it has none.
 */
function stripTrailer(code: string): string {
  if (code.length < 4) return code;
  const cborLength = Number.parseInt(code.slice(-4), 16);
  const start = code.length - 4 - cborLength * 2;
  if (!(cborLength > 0) || start < 0) return code;
  const head = Number.parseInt(code.slice(start, start + 2), 16);
  // CBOR major type 5, a map of 1 to 23 entries.
  if (!(head >= 0xa1 && head <= 0xb7)) return code;
  const firstKeyAt = start + 2;
  return TRAILER_FIRST_KEYS.some((key) => code.startsWith(key, firstKeyAt))
    ? code.slice(0, start)
    : code;
}

/**
 * Mark interior metadata hashes: contract code embedded for `new X` carries its own trailer,
 * whose hash changes with the source path even when the code does not.
 *
 * A hash is ignored only where both sides have the same marker at the same offset, so a marker
 * on one side alone still counts as a difference.
 *
 * @param expected - The artifact's code, bare hex, trailer removed.
 * @param actual - The deployed code, same length as `expected`.
 * @param mask - One flag per byte; set for the payload of every hash found.
 */
function maskInteriorHashes(expected: string, actual: string, mask: Uint8Array): void {
  for (const match of expected.matchAll(INTERIOR_HASH_MARKER)) {
    if (match.index % 2 !== 0 || !actual.startsWith(match[0], match.index)) continue;
    const payloadStart = (match.index + match[0].length) / 2;
    mask.fill(1, payloadStart, payloadStart + (match[1] !== undefined ? 34 : 32));
  }
}

/**
 * Compare an artifact's runtime bytecode with the code deployed at an address.
 *
 * @param expected - The artifact's side. `object` must be bare lower-case hex, in which library
 *   placeholders may remain.
 * @param actual - The deployed code, bare lower-case hex.
 * @returns `undefined` when they match, otherwise the reason, naming the byte counts or the
 *   first differing byte. Offsets count from the start of the code.
 */
export function compareBytecode(expected: ExpectedBytecode, actual: string): string | undefined {
  const expectedCode = stripTrailer(expected.object);
  const actualCode = stripTrailer(actual);
  if (actualCode.length !== expectedCode.length) {
    return (
      `the deployed code is ${actualCode.length / 2} bytes but the artifact's deployedBytecode` +
      ` is ${expectedCode.length / 2} bytes, leaving out the metadata trailer of each`
    );
  }

  const size = expectedCode.length / 2;
  const mask = new Uint8Array(size);
  const ranges: readonly (readonly [string, ByteRange])[] = [
    ...Object.values(expected.immutableReferences ?? {})
      .flat()
      .map((range) => ['immutable', range] as const),
    ...Object.values(expected.linkReferences ?? {})
      .flatMap((file) => Object.values(file).flat())
      .map((range) => ['library', range] as const),
  ];
  for (const [kind, { start, length }] of ranges) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 ||
        start + length > size) {
      return (
        `the artifact's ${kind} reference (start ${start}, length ${length}) falls outside its` +
        ` ${size} bytes of code`
      );
    }
    mask.fill(1, start, start + length);
  }
  for (const match of expectedCode.matchAll(LIBRARY_PLACEHOLDER)) {
    if (match.index % 2 === 0) mask.fill(1, match.index / 2, match.index / 2 + 20);
  }
  maskInteriorHashes(expectedCode, actualCode, mask);

  for (let byte = 0; byte < size; byte += 1) {
    const at = byte * 2;
    if (mask[byte] === 1 || expectedCode.slice(at, at + 2) === actualCode.slice(at, at + 2)) continue;
    // Never weakened for want of references: an immutable then differs and rejects, and this
    // says how a correct address can land here. It is only a possibility: the contract may have
    // no immutables, or the compiler may predate them.
    const note =
      expected.immutableReferences === undefined || expected.immutableReferences === null
        ? ', and the artifact lists no immutable references, so any immutable there was not ignored'
        : '';
    return `the deployed code differs from the artifact's deployedBytecode at byte ${byte}${note}`;
  }
  return undefined;
}
