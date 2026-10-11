/**
 * Shared machinery for the golden-JSON unit layer.
 *
 * Two deliberate properties:
 *  1. The storage layouts are REAL solc 0.8.26 output (see `scripts/generate-fixtures.mjs`),
 *     not hand-authored JSON, so the suite cannot agree with the implementation about a
 *     layout shape that solc does not actually produce.
 *  2. The expected slot arithmetic below (`mappingSlot`, `arrayBase`) composes the slot here
 *     rather than by calling `deriveSlot`, so the tests check how the derivation is put
 *     together. It is NOT independent of the byte primitives: it imports the same
 *     `keccak256`, padding and conversion functions `deriveSlot` uses. Those are pinned by
 *     literal vectors in `bytes.test.ts`, and whole composed slots by the hard-coded values in
 *     `slotLiterals.test.ts`.
 */
import type {
  ParsedStorageLayout,
  RawStorageLayout,
} from '../../src/core/layout/parseStorageLayout.js';
import { parseStorageLayout } from '../../src/core/layout/parseStorageLayout.js';
import type { BlockTag, GetStorageAt, SingleSlotReader } from '../../src/core/rpc/getStorageAt.js';
import {
  WORD_SIZE,
  bigIntToBytes,
  bytesToBigInt,
  concatBytes,
  hexToBytes,
  keccak256,
  rightPad32,
  utf8ToBytes,
} from '../../src/core/util/bytes.js';
import rawFixtures from './fixtures/layouts.json';

interface FixtureContract {
  readonly contractName: string;
  readonly sourceName: string;
  readonly storageLayout: RawStorageLayout;
  readonly userDefinedValueTypes: Record<string, string>;
  readonly constantAndImmutableNames: string[];
  readonly declaringContracts: Record<string, string>;
}

interface FixtureFile {
  readonly solcVersion: string;
  readonly contracts: Record<string, FixtureContract>;
}

const fixtures = rawFixtures as unknown as FixtureFile;

export const SOLC_VERSION = fixtures.solcVersion;

export function fixtureNames(): string[] {
  return Object.keys(fixtures.contracts);
}

/** Load a fixture layout by fully-qualified name, e.g. `"ArrayStorage.sol:ArrayStorage"`. */
export function loadLayout(fullyQualifiedName: string): ParsedStorageLayout {
  const entry = fixtures.contracts[fullyQualifiedName];
  if (entry === undefined) {
    throw new Error(
      `no fixture layout for "${fullyQualifiedName}"; available: ${fixtureNames().join(', ')}`
    );
  }
  return parseStorageLayout(entry.storageLayout, {
    contractName: fullyQualifiedName,
    userDefinedValueTypes: entry.userDefinedValueTypes,
    constantAndImmutableNames: entry.constantAndImmutableNames,
    declaringContracts: entry.declaringContracts,
  });
}

/** Load a layout WITHOUT the AST-derived extras, to exercise the degraded paths. */
export function loadBareLayout(fullyQualifiedName: string): ParsedStorageLayout {
  const entry = fixtures.contracts[fullyQualifiedName];
  if (entry === undefined) throw new Error(`no fixture layout for "${fullyQualifiedName}"`);
  return parseStorageLayout(entry.storageLayout, { contractName: fullyQualifiedName });
}

// ---------------------------------------------------------------------------------------
// Expected-slot arithmetic: composed here, on the byte primitives src/core/util/bytes.ts exports
// ---------------------------------------------------------------------------------------

export function pad32(value: bigint): Uint8Array {
  return bigIntToBytes(value, WORD_SIZE);
}

/** `keccak256(keyBytes ++ leftPad32(slot))`. `keyBytes` must already be padded per key type. */
export function mappingSlot(keyBytes: Uint8Array, slot: bigint): bigint {
  return bytesToBigInt(keccak256(concatBytes(keyBytes, pad32(slot))));
}

/** `keccak256(leftPad32(slot))` — element base of a dynamic array, data base of a long value. */
export function arrayBase(slot: bigint): bigint {
  return bytesToBigInt(keccak256(pad32(slot)));
}

export function addressKey(address: string): Uint8Array {
  return pad32(bytesToBigInt(hexToBytes(address)));
}

export function uintKey(value: bigint | number): Uint8Array {
  return pad32(BigInt(value));
}

/** Two's complement across all 32 bytes — the sign extension a negative key needs. */
export function intKey(value: bigint | number): Uint8Array {
  return pad32(BigInt(value));
}

export function bytesNKey(hex: string): Uint8Array {
  return rightPad32(hexToBytes(hex));
}

export function stringKey(text: string): Uint8Array {
  return utf8ToBytes(text);
}

export function bytesKey(hex: string): Uint8Array {
  return hexToBytes(hex);
}

// ---------------------------------------------------------------------------------------
// In-memory storage
// ---------------------------------------------------------------------------------------

export const ZERO_WORD = new Uint8Array(WORD_SIZE);

/** Build a 32-byte word from packed fields, each at a byte `offset` from the LOW end. */
export function packWord(
  ...fields: readonly { offset: number; size: number; value: bigint | Uint8Array }[]
): Uint8Array {
  const word = new Uint8Array(WORD_SIZE);
  for (const field of fields) {
    const bytes =
      field.value instanceof Uint8Array ? field.value : bigIntToBytes(field.value, field.size);
    if (bytes.length !== field.size) {
      throw new Error(`field at offset ${field.offset} must be ${field.size} bytes`);
    }
    word.set(bytes, WORD_SIZE - field.offset - field.size);
  }
  return word;
}

export function word(value: bigint | number): Uint8Array {
  return bigIntToBytes(BigInt(value), WORD_SIZE);
}

/** Header word for a `string`/`bytes` value shorter than 32 bytes. */
export function shortBytesWord(data: Uint8Array): Uint8Array {
  if (data.length > WORD_SIZE - 1) throw new Error('short form holds at most 31 bytes');
  const out = new Uint8Array(WORD_SIZE);
  out.set(data, 0); // data occupies the HIGH-order bytes
  out[WORD_SIZE - 1] = data.length * 2; // low byte is 2 * length
  return out;
}

/** Header word for a `string`/`bytes` value of 32 bytes or more. */
export function longBytesHeader(byteLength: number): Uint8Array {
  return bigIntToBytes(BigInt(byteLength) * 2n + 1n, WORD_SIZE);
}

/** Split a payload into the 32-byte data slots a long `string`/`bytes` occupies. */
export function dataSlots(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < data.length; at += WORD_SIZE) {
    const slotBytes = new Uint8Array(WORD_SIZE);
    slotBytes.set(data.subarray(at, at + WORD_SIZE), 0);
    out.push(slotBytes);
  }
  return out;
}

export interface RecordedRead {
  readonly slot: bigint;
  readonly blockTag: BlockTag;
  readonly address: string;
}

/**
 * A synchronous slot map behind an async reader. `deriveSlot` never touches it — only the
 * driver phases do — which is precisely the property the obligation design exists to keep.
 */
export class MockStorage {
  readonly #slots = new Map<string, Uint8Array>();
  readonly reads: RecordedRead[] = [];

  set(slot: bigint, value: Uint8Array): this {
    this.#slots.set(slot.toString(), value);
    return this;
  }

  /** Write consecutive slots starting at `slot`. */
  setMany(slot: bigint, values: readonly Uint8Array[]): this {
    values.forEach((value, i) => this.set(slot + BigInt(i), value));
    return this;
  }

  /** Store a `string`/`bytes` value the way the EVM would, header slot plus data slots. */
  setDynamicBytes(headerSlot: bigint, data: Uint8Array): this {
    if (data.length < WORD_SIZE) return this.set(headerSlot, shortBytesWord(data));
    this.set(headerSlot, longBytesHeader(data.length));
    return this.setMany(arrayBase(headerSlot), dataSlots(data));
  }

  setString(headerSlot: bigint, text: string): this {
    return this.setDynamicBytes(headerSlot, utf8ToBytes(text));
  }

  get(slot: bigint): Uint8Array {
    return this.#slots.get(slot.toString()) ?? ZERO_WORD;
  }

  reader(address = '0x0000000000000000000000000000000000000000', blockTag: BlockTag = 'latest') {
    const read: SingleSlotReader = async (slot) => {
      this.reads.push({ slot, blockTag, address });
      return this.get(slot);
    };
    return read;
  }

  get getStorageAt(): GetStorageAt {
    return async ({ address, slot, blockTag }) => {
      this.reads.push({ slot, blockTag, address });
      return this.get(slot);
    };
  }
}
