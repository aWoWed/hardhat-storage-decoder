/**
 * Byte-level primitives shared by the whole core: keccak256, 32-byte word padding, big-endian
 * integer conversion, hex and UTF-8 conversion, EIP-55 checksumming and packed-field extraction.
 *
 * Slot derivation (`slots/deriveSlot.ts`) uses these to build keccak preimages and mapping-key
 * encodings; decoding (`slots/decode.ts`) and the query layer use them to normalize RPC results
 * into storage words and turn the bytes of a word into native values. Everything here is pure
 * and works on `Uint8Array`/`bigint`/`string`; the keccak implementation is the only import.
 */
import { keccak_256 } from '@noble/hashes/sha3';

/** Size of an EVM storage word, in bytes. */
export const WORD_SIZE = 32;

/**
 * keccak256 over raw bytes. The single cryptographic primitive this package needs.
 *
 * @param data - The preimage bytes.
 * @returns The 32-byte digest.
 */
export function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

/**
 * Concatenate byte arrays into one newly allocated array, in argument order.
 *
 * Used to build a mapping slot's keccak preimage (`encodedKey ++ slot`) and to join the data
 * slots of a long `string`/`bytes` value before truncating to its length.
 *
 * @param parts - The arrays to join; none of them is modified.
 * @returns A new array whose length is the sum of the parts' lengths (empty for no parts).
 */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Pad to 32 bytes by prepending zeros, i.e. keep the bytes as the low-order end of a word.
 *
 * Its one caller is {@link toStorageWord}, which uses it to restore the leading zeros of an
 * RPC result shorter than a full word. Mapping keys of value types and the `keccak256(slot)`
 * base derivation get the same left alignment through {@link bigIntToBytes} instead.
 *
 * @param bytes - At most 32 bytes.
 * @returns A 32-byte array. Input that is already 32 bytes long is returned as the same
 *   instance, not a copy.
 * @throws {RangeError} when `bytes` is longer than 32 bytes.
 */
export function leftPad32(bytes: Uint8Array): Uint8Array {
  if (bytes.length === WORD_SIZE) return bytes;
  if (bytes.length > WORD_SIZE) {
    throw new RangeError(`cannot left-pad ${bytes.length} bytes into a 32-byte word`);
  }
  const out = new Uint8Array(WORD_SIZE);
  out.set(bytes, WORD_SIZE - bytes.length);
  return out;
}

/**
 * Pad to 32 bytes by appending zeros — the alignment used for `bytesN` mapping keys.
 * This is deliberately the opposite direction from {@link leftPad32}; getting it backwards
 * silently derives a wrong slot rather than failing.
 *
 * @param bytes - At most 32 bytes.
 * @returns A 32-byte array. Input that is already 32 bytes long is returned as the same
 *   instance, not a copy.
 * @throws {RangeError} when `bytes` is longer than 32 bytes.
 */
export function rightPad32(bytes: Uint8Array): Uint8Array {
  if (bytes.length === WORD_SIZE) return bytes;
  if (bytes.length > WORD_SIZE) {
    throw new RangeError(`cannot right-pad ${bytes.length} bytes into a 32-byte word`);
  }
  const out = new Uint8Array(WORD_SIZE);
  out.set(bytes, 0);
  return out;
}

/**
 * Big-endian unsigned interpretation of `bytes`.
 *
 * @param bytes - Bytes of any length, most significant first.
 * @returns The non-negative integer they encode; `0n` for an empty array.
 */
export function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * Big-endian two's-complement interpretation of `bytes`.
 *
 * The sign bit is the top bit of the first byte, so the width of the integer is the length of
 * the array — pass exactly the bytes the `intN` occupies, not the whole storage word.
 *
 * @param bytes - Bytes of any length, most significant first.
 * @returns The signed integer they encode; `0n` for an empty array.
 */
export function bytesToSignedBigInt(bytes: Uint8Array): bigint {
  const unsigned = bytesToBigInt(bytes);
  if (bytes.length === 0) return 0n;
  const bits = BigInt(bytes.length * 8);
  const signBit = 1n << (bits - 1n);
  return (unsigned & signBit) === 0n ? unsigned : unsigned - (1n << bits);
}

/**
 * Big-endian encoding of `value` into exactly `size` bytes.
 * Negative values are encoded as two's complement (sign-extended across the full width),
 * which is what makes a negative `int256` mapping key hash correctly.
 *
 * @remarks
 * The value is reduced modulo `2^(8 * size)`, so one that does not fit is wrapped rather than
 * rejected. Callers that need a range check (mapping-key encoding) do it before calling.
 *
 * @param value - The integer to encode; may be negative.
 * @param size - Output length in bytes. Defaults to {@link WORD_SIZE}.
 * @returns A new array of `size` bytes, most significant first.
 */
export function bigIntToBytes(value: bigint, size = WORD_SIZE): Uint8Array {
  const modulus = 1n << BigInt(size * 8);
  let normalized = value % modulus;
  if (normalized < 0n) normalized += modulus;
  const out = new Uint8Array(size);
  for (let i = size - 1; i >= 0; i -= 1) {
    out[i] = Number(normalized & 0xffn);
    normalized >>= 8n;
  }
  return out;
}

/** Matches a string made only of hex digits, either case; also matches the empty string. */
const HEX_RE = /^[0-9a-fA-F]*$/;

/**
 * Parse a `0x`-prefixed (or bare) hex string into bytes.
 *
 * @param hex - Hex digits in either case, with an optional `0x`/`0X` prefix. `"0x"` and `""`
 *   give an empty array.
 * @returns One byte per pair of digits, in order.
 * @throws {TypeError} when the digit count is odd, or a character is not a hex digit.
 */
export function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (body.length % 2 !== 0) {
    throw new TypeError(`hex string must have an even number of digits, got "${hex}"`);
  }
  if (!HEX_RE.test(body)) {
    throw new TypeError(`invalid hex string: "${hex}"`);
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Format bytes as a lowercase, `0x`-prefixed hex string, two digits per byte.
 *
 * @param bytes - The bytes to format.
 * @returns The hex string; `"0x"` for an empty array.
 */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '0x';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Shared UTF-8 encoder behind {@link utf8ToBytes}. */
const UTF8_ENCODER = new TextEncoder();
/**
 * Shared UTF-8 decoder behind {@link bytesToUtf8}. Non-fatal: a malformed sequence decodes to
 * U+FFFD instead of throwing. `ignoreBOM` makes it keep a leading byte-order mark in the
 * output instead of dropping it.
 */
const UTF8_DECODER = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * Encode text as UTF-8 — the unpadded byte form a `string` mapping key takes in the keccak
 * preimage, and the input to the EIP-55 hash in {@link toChecksumAddress}.
 *
 * @param text - The text to encode.
 * @returns Its UTF-8 bytes.
 */
export function utf8ToBytes(text: string): Uint8Array {
  return UTF8_ENCODER.encode(text);
}

/**
 * Decode UTF-8 bytes into text; used for the contents of a Solidity `string`.
 *
 * Storage does not guarantee valid UTF-8. Malformed sequences are replaced with U+FFFD rather
 * than raising, so the result is not always convertible back to the original bytes. A leading
 * UTF-8 byte-order mark (`EF BB BF`) is kept, as U+FEFF: nothing in storage makes those
 * bytes anything but part of the value.
 *
 * @param bytes - The bytes to decode.
 * @returns The decoded text.
 */
export function bytesToUtf8(bytes: Uint8Array): string {
  return UTF8_DECODER.decode(bytes);
}

/**
 * EIP-55 mixed-case checksum encoding of a 20-byte address.
 *
 * @param address - 40 hex digits in any case, with an optional `0x`/`0X` prefix. An existing
 *   checksum in the input is not validated; the casing is recomputed.
 * @returns The `0x`-prefixed address with EIP-55 casing.
 * @throws {TypeError} when the input is not exactly 40 hex digits after the prefix.
 */
export function toChecksumAddress(address: string): string {
  const body = (address.startsWith('0x') || address.startsWith('0X')
    ? address.slice(2)
    : address
  ).toLowerCase();
  if (body.length !== 40 || !HEX_RE.test(body)) {
    throw new TypeError(`invalid address: "${address}"`);
  }
  const hash = bytesToHex(keccak256(utf8ToBytes(body))).slice(2);
  let out = '0x';
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] as string;
    const nibble = Number.parseInt(hash[i] as string, 16);
    out += nibble >= 8 ? char.toUpperCase() : char;
  }
  return out;
}

/**
 * Extract the byte window a packed variable occupies inside a 32-byte storage word.
 *
 * solc's `offset` counts bytes from the LEAST significant (rightmost) end of the word,
 * so a variable of `size` bytes at `offset` occupies `word[32 - offset - size, 32 - offset)`
 * in big-endian order. That window holds the value's own big-endian bytes verbatim — which
 * is why the same extraction serves both integers and `bytesN`.
 *
 * @param word - The full 32-byte storage word.
 * @param offset - Byte offset of the variable from the least significant end of the word.
 * @param size - Width of the variable in bytes.
 * @returns A copy of the `size` bytes the variable occupies, most significant first.
 * @throws {RangeError} when `word` is not 32 bytes long, when `size` is not positive, or when
 *   `offset + size` exceeds 32. `offset` is assumed non-negative and is not checked.
 */
export function extractPackedBytes(word: Uint8Array, offset: number, size: number): Uint8Array {
  if (word.length !== WORD_SIZE) {
    throw new RangeError(`expected a 32-byte storage word, got ${word.length} bytes`);
  }
  const end = WORD_SIZE - offset;
  const start = end - size;
  if (start < 0 || size <= 0) {
    throw new RangeError(
      `packed field of ${size} byte(s) at offset ${offset} does not fit in a 32-byte word`
    );
  }
  return word.slice(start, end);
}

/**
 * Normalize any `eth_getStorageAt`-shaped result into exactly 32 bytes.
 *
 * A result shorter than a word is treated as having lost its leading zeros and is left-padded.
 *
 * @param value - A hex string (with or without `0x`) or raw bytes, at most 32 bytes long.
 * @returns A 32-byte word. A 32-byte `Uint8Array` input is returned as the same instance.
 * @throws {TypeError} when `value` is a string that is not valid even-length hex.
 * @throws {RangeError} when `value` is longer than 32 bytes.
 */
export function toStorageWord(value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === 'string' ? hexToBytes(value) : value;
  if (bytes.length === WORD_SIZE) return bytes;
  if (bytes.length > WORD_SIZE) {
    throw new RangeError(`storage word must be at most 32 bytes, got ${bytes.length}`);
  }
  return leftPad32(bytes);
}
