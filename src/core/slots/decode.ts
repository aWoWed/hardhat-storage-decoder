/**
 * Reading and decoding: the I/O half that follows slot derivation.
 *
 * Given the read plan and bounds obligations produced by `deriveSlot`, the functions here
 * check dynamic-array bounds against stored lengths, fetch the slot words a value occupies
 * (resolving the short/long form of `string`/`bytes` on the way) and turn those words into a
 * native value. All storage access goes through a caller-supplied {@link SingleSlotReader},
 * so this file performs no RPC of its own.
 */

import type { ValueKind } from '../layout/parseStorageLayout.js';
import { IndexOutOfBoundsError, UnsupportedTypeError } from '../query/errors.js';
import type { SingleSlotReader } from '../rpc/getStorageAt.js';
import {
  WORD_SIZE,
  bytesToBigInt,
  bytesToHex,
  bytesToSignedBigInt,
  bytesToUtf8,
  concatBytes,
  extractPackedBytes,
  toChecksumAddress,
  toStorageWord,
} from '../util/bytes.js';
import { type BoundsObligation, type ReadPlan, wrapSlot } from './deriveSlot.js';

/**
 * Native representation handed back to callers.
 *
 * Variants:
 *  - `bigint` — `uint`/`int` of any width, and enums
 *  - `boolean` — `bool`
 *  - `string` — an EIP-55 checksummed address (`address` and contract types), `0x` hex
 *    (`bytesN`, `bytes`, and the raw bytes of a function-typed variable: 24 for an external
 *    function, 8 for an internal one), or the decoded text of a Solidity `string`
 */
export type DecodedValue = bigint | boolean | string;

/** What the header slot of a `string`/`bytes` value says about how it is stored. */
export interface DynamicBytesInfo {
  /** Length in bytes of the stored `string`/`bytes` value. */
  readonly length: number;
  /** True when the value is stored inline in the header slot's high-order bytes. */
  readonly short: boolean;
}

/** The slot words fetched for one {@link ReadPlan}, ready to pass to {@link decode}. */
export interface ResolvedRead {
  /**
   * The 32-byte words {@link decode} works on. For a single-slot plan and for short
   * `string`/`bytes` this is the one slot read (`[word]` / `[header]`); for long values it is
   * the data slots, in order, without the header.
   */
  readonly slotValues: readonly Uint8Array[];
  /** The header/base slot's raw bytes — what a caller gets back as `rawSlotValue`. */
  readonly rawSlotValue: Uint8Array;
  /** The header/base slot number — what a caller gets back as `slot`. */
  readonly slot: bigint;
  /** Length and storage form of a `string`/`bytes` value. Absent for a single-slot plan. */
  readonly dynamic?: DynamicBytesInfo;
}

/**
 * Refuse absurd lengths rather than trying to allocate them. A garbage header slot would
 * otherwise ask for an unbounded number of reads.
 */
const MAX_DYNAMIC_BYTE_LENGTH = 1 << 24; // 16 MiB

/**
 * Resolve every bounds obligation the walk emitted, issuing one length read at a time.
 *
 * Deliberately sequential and in path order: for a path like `arr[999][3]`, the inner
 * obligation was derived from an outer index that may not exist, so evaluating it would be
 * meaningless. The outermost failure is the one reported.
 *
 * @remarks
 * The package's own query pipeline does not call this function; it issues the length reads
 * up front and checks them with {@link awaitObligationsInOrder}. This one is exported for
 * callers that drive the read phases themselves, and should be awaited before any value read.
 *
 * @param obligations - The obligations to check, in path order (outermost first).
 * @param read - Reads one slot; called once per obligation, with its `lengthSlot`, and not
 *   called for obligations after the first failure.
 * @throws {IndexOutOfBoundsError} when an index is greater than or equal to the length stored
 *   in its array's slot.
 * @throws {TypeError} when `read` returns a string that is not valid even-length hex.
 * @throws {RangeError} when `read` returns more than 32 bytes.
 */
export async function resolveObligations(
  obligations: readonly BoundsObligation[],
  read: SingleSlotReader
): Promise<void> {
  for (const obligation of obligations) {
    const word = toStorageWord(await read(obligation.lengthSlot));
    const length = bytesToBigInt(word);
    if (obligation.index >= length) {
      throw new IndexOutOfBoundsError(
        obligation.index,
        length,
        obligation.typeLabel,
        obligation.variableName
      );
    }
  }
}

/**
 * Phase 1 (and, for long values, phase 2) of the read pipeline.
 *
 * For a `string`/`bytes` plan the header slot is read first. Its low-order byte's least
 * significant bit distinguishes the two storage forms:
 *  - even: short. The low byte holds `2 * length` and the value itself sits in the slot's
 *    HIGH-order bytes — the one place solc inverts its usual low-order alignment.
 *  - odd: long. The whole word holds `2 * length + 1` and the data occupies
 *    `ceil(length / 32)` slots starting at `keccak256(headerSlot)`, continuing at slot 0
 *    after the last slot (slot numbers wrap modulo 2^256).
 *
 * A single-slot plan needs one read and nothing else. The data slots of a long value are
 * requested concurrently.
 *
 * @param plan - The read plan produced by slot derivation.
 * @param read - Reads one slot. Called first with `plan.slot` (or `plan.headerSlot`), then once
 *   per data slot of a long value.
 * @returns The fetched words, the header/base slot and its raw bytes, and for a multi-slot
 *   plan the value's byte length and storage form.
 * @throws {RangeError} when a short-form header encodes a length above 31 bytes, a long-form
 *   header encodes a length below 32 bytes or above the 16 MiB safety limit, or `read` returns
 *   more than 32 bytes.
 * @throws {TypeError} when `read` returns a string that is not valid even-length hex.
 */
export async function resolveReadPlan(
  plan: ReadPlan,
  read: SingleSlotReader
): Promise<ResolvedRead> {
  if (plan.kind === 'single') {
    const word = toStorageWord(await read(plan.slot));
    return { slotValues: [word], rawSlotValue: word, slot: plan.slot };
  }

  const header = toStorageWord(await read(plan.headerSlot));
  const lowByte = header[WORD_SIZE - 1] as number;

  if ((lowByte & 1) === 0) {
    const length = lowByte >> 1;
    if (length > WORD_SIZE - 1) {
      throw new RangeError(
        `storage slot ${plan.headerSlot} is not a valid short string/bytes header:` +
          ` it encodes a length of ${length}, which does not fit inline`
      );
    }
    return {
      slotValues: [header],
      rawSlotValue: header,
      slot: plan.headerSlot,
      dynamic: { length, short: true },
    };
  }

  const encoded = (bytesToBigInt(header) - 1n) / 2n;
  if (encoded > BigInt(MAX_DYNAMIC_BYTE_LENGTH)) {
    throw new RangeError(
      `storage slot ${plan.headerSlot} encodes a string/bytes length of ${encoded},` +
        ` which exceeds the ${MAX_DYNAMIC_BYTE_LENGTH}-byte safety limit`
    );
  }
  // solc stores anything under 32 bytes inline, so a long form this short is not a value it
  // wrote. Refused rather than decoded: a declared length of 0 would also leave no data slot.
  // `expand` in `query/dump.ts` relies on this check for a long form below 32 bytes: it
  // leaves such a value uncounted so that the failure reported is this one.
  if (encoded < BigInt(WORD_SIZE)) {
    throw new RangeError(
      `storage slot ${plan.headerSlot} is not a valid long string/bytes header:` +
        ` it encodes a length of ${encoded}, which would be stored inline`
    );
  }
  const length = Number(encoded);
  const slotCount = Math.ceil(length / WORD_SIZE);
  // Issued in parallel: `read` is already bound to one address and one block tag.
  const slotValues = await Promise.all(
    Array.from({ length: slotCount }, async (_unused, i) =>
      toStorageWord(await read(wrapSlot(plan.dataBaseSlot + BigInt(i))))
    )
  );

  return {
    slotValues,
    rawSlotValue: header,
    slot: plan.headerSlot,
    dynamic: { length, short: false },
  };
}

/**
 * Decode a resolved read into a native value.
 *
 * Text of a `string` is decoded as UTF-8; invalid byte sequences become U+FFFD rather than
 * raising an error. A leading UTF-8 byte-order mark is kept, as U+FEFF: the bytes are part of
 * the stored value. A function-typed value is returned as the `0x` hex of its raw bytes.
 *
 * @param slotValues - The words from {@link ResolvedRead.slotValues}. Value types use only
 *   the first.
 * @param offset - Byte offset of the value within its slot, counted from the least significant
 *   end. Ignored for `string`/`bytes`.
 * @param numberOfBytes - Width of the value in bytes. Ignored for `string`/`bytes`.
 * @param valueKind - The resolved leaf kind that selects the decoding rule: contracts arrive
 *   as `address`, enums as a small `uint`, resolved user-defined value types as what they wrap.
 * @param dynamic - Length and storage form from {@link resolveReadPlan}; required when
 *   `valueKind` is `string` or `bytes`, unused otherwise.
 * @returns The native value; {@link DecodedValue} lists the form each Solidity type takes.
 * @throws {TypeError} when `slotValues` is empty, `dynamic` is missing for a `string`/`bytes`
 *   value, or an `address` kind is paired with a width other than 20 bytes.
 * @throws {RangeError} when the first word is not 32 bytes, or `offset`/`numberOfBytes` do
 *   not describe a window inside it.
 * @throws {UnsupportedTypeError} when `valueKind` is a user-defined value type whose
 *   underlying type is unknown.
 */
export function decode(
  slotValues: readonly Uint8Array[],
  offset: number,
  numberOfBytes: number,
  valueKind: ValueKind,
  dynamic?: DynamicBytesInfo
): DecodedValue {
  if (valueKind.family === 'string' || valueKind.family === 'bytes') {
    if (dynamic === undefined) {
      throw new TypeError(
        'decoding a string/bytes value requires the length resolved by resolveReadPlan'
      );
    }
    const first = slotValues[0];
    if (first === undefined) {
      throw new TypeError('decoding a string/bytes value requires at least one slot value');
    }
    const raw = dynamic.short
      ? first.slice(0, dynamic.length)
      : concatBytes(...slotValues).slice(0, dynamic.length);
    return valueKind.family === 'string' ? bytesToUtf8(raw) : bytesToHex(raw);
  }

  const word = slotValues[0];
  if (word === undefined) {
    throw new TypeError('decoding a value requires at least one slot value');
  }
  const raw = extractPackedBytes(word, offset, numberOfBytes);

  switch (valueKind.family) {
    case 'uint':
      return bytesToBigInt(raw);
    case 'int':
      return bytesToSignedBigInt(raw);
    case 'bool':
      return bytesToBigInt(raw) !== 0n;
    case 'address':
      return toChecksumAddress(bytesToHex(raw));
    case 'bytesN':
    case 'function':
      return bytesToHex(raw);
    case 'unresolvedUserDefinedValueType':
      throw new UnsupportedTypeError(
        valueKind.name,
        `t_userDefinedValueType(${valueKind.name})`,
        `the underlying type is unknown, so the ${valueKind.numberOfBytes}-byte value cannot be` +
          ` decoded unambiguously (bytes32 and uint256 are indistinguishable by size). Supply it` +
          ` via parseStorageLayout's "userDefinedValueTypes" option (see extractUserDefinedValueTypes)`
      );
  }
}

/**
 * The concurrent counterpart of {@link resolveObligations}: the length reads are already in
 * flight, and are examined strictly in path order.
 *
 * Promise `i + 1` is not even awaited until obligation `i` has passed, so a rejected or
 * meaningless inner read (its slot was derived from an outer index that may not exist) can
 * never be reported in place of the outermost failure.
 *
 * @remarks
 * Precondition: every promise in `lengthReads` must already have a rejection handler attached.
 * After the first failure the remaining promises are never awaited here, so one that rejects
 * without a handler would surface as an unhandled rejection. Both callers in the query layer
 * attach a no-op `.catch` when they issue the reads.
 *
 * @param obligations - The obligations to check, in path order (outermost first).
 * @param lengthReads - The pending length-slot reads, one per obligation and in the same
 *   order: `lengthReads[i]` is the read of `obligations[i].lengthSlot`.
 * @throws {IndexOutOfBoundsError} when an index is greater than or equal to the length its
 *   read returned.
 * @throws {TypeError} when a length read resolves to a string that is not valid even-length hex.
 * @throws {RangeError} when a length read resolves to more than 32 bytes.
 * @throws {Error} the rejection reason of the first failing length read, when it is reached
 *   before any out-of-bounds index.
 */
export async function awaitObligationsInOrder(
  obligations: readonly BoundsObligation[],
  lengthReads: readonly Promise<Uint8Array>[]
): Promise<void> {
  for (const [i, obligation] of obligations.entries()) {
    const length = bytesToBigInt(toStorageWord(await (lengthReads[i] as Promise<Uint8Array>)));
    if (obligation.index >= length) {
      throw new IndexOutOfBoundsError(
        obligation.index,
        length,
        obligation.typeLabel,
        obligation.variableName
      );
    }
  }
}

/**
 * Byte length a `string`/`bytes` header word declares, in either the short or the long form.
 *
 * The header is taken at face value: unlike {@link resolveReadPlan}, nothing is rejected here,
 * so a malformed short header can report up to 127 and a long one is not capped.
 *
 * @param header - The 32-byte header slot word.
 * @returns `lowByte / 2` when the low-order bit is clear (short form), otherwise
 *   `(word - 1) / 2` (long form).
 */
export function dynamicBytesLength(header: Uint8Array): bigint {
  const lowByte = header[WORD_SIZE - 1] as number;
  return (lowByte & 1) === 0 ? BigInt(lowByte >> 1) : (bytesToBigInt(header) - 1n) / 2n;
}
