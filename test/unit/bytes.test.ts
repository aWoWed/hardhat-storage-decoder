import { describe, expect, it } from 'vitest';
import {
  bigIntToBytes,
  bytesToBigInt,
  bytesToHex,
  bytesToSignedBigInt,
  extractPackedBytes,
  hexToBytes,
  keccak256,
  leftPad32,
  rightPad32,
  toChecksumAddress,
  toStorageWord,
} from '../../src/core/util/bytes.js';

describe('keccak256', () => {
  // Literal anchors, independent of anything in this package: these are the canonical
  // published values, and they are what every array-base derivation is built on.
  it('matches published values', () => {
    expect(bytesToHex(keccak256(new Uint8Array(0)))).toBe(
      '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
    );
    expect(bytesToHex(keccak256(new Uint8Array(32)))).toBe(
      '0x290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563'
    );
    expect(bytesToHex(keccak256(bigIntToBytes(1n, 32)))).toBe(
      '0xb10e2d527612073b26eecdfd717e6a320cf44b4afac2b0732d9fcbe2b7fa0cf6'
    );
  });
});

describe('padding', () => {
  it('pads in opposite directions', () => {
    const four = hexToBytes('0xdeadbeef');
    expect(bytesToHex(leftPad32(four))).toBe(
      '0x00000000000000000000000000000000000000000000000000000000deadbeef'
    );
    expect(bytesToHex(rightPad32(four))).toBe(
      '0xdeadbeef00000000000000000000000000000000000000000000000000000000'
    );
    // Getting this backwards derives a plausible but wrong slot, so it is asserted directly.
    expect(bytesToHex(leftPad32(four))).not.toBe(bytesToHex(rightPad32(four)));
  });
});

describe('integer encoding', () => {
  it('encodes negatives as two\'s complement across the full width', () => {
    expect(bytesToHex(bigIntToBytes(-1n, 32))).toBe(
      '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    );
    expect(bytesToHex(bigIntToBytes(-2n, 32))).toBe(
      '0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe'
    );
    // A negative int128 key is sign-extended across all 32 bytes, not zero-padded.
    expect(bytesToHex(bigIntToBytes(-5n, 32)).slice(0, 10)).toBe('0xffffffff');
  });

  it('round-trips signed values', () => {
    for (const value of [0n, 1n, -1n, 127n, -128n, 2n ** 127n - 1n, -(2n ** 127n)]) {
      expect(bytesToSignedBigInt(bigIntToBytes(value, 16))).toBe(value);
    }
  });

  it('reads unsigned big-endian', () => {
    expect(bytesToBigInt(hexToBytes('0x0102'))).toBe(0x0102n);
  });
});

describe('extractPackedBytes', () => {
  const word = hexToBytes('0x00000000000000000000000000000000aabbccddeeff00112233445566778899');

  it('reads the window at a byte offset from the LOW end', () => {
    expect(bytesToHex(extractPackedBytes(word, 0, 4))).toBe('0x66778899');
    expect(bytesToHex(extractPackedBytes(word, 4, 4))).toBe('0x22334455');
    expect(bytesToHex(extractPackedBytes(word, 0, 16))).toBe('0xaabbccddeeff00112233445566778899');
    // The high half of this word is empty, so a window up there reads zeros.
    expect(bytesToHex(extractPackedBytes(word, 16, 16))).toBe(
      '0x00000000000000000000000000000000'
    );
  });

  it('rejects a window that does not fit', () => {
    expect(() => extractPackedBytes(word, 30, 4)).toThrow(RangeError);
  });
});

describe('toChecksumAddress', () => {
  it('matches the EIP-55 test vectors', () => {
    expect(toChecksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')).toBe(
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
    );
    expect(toChecksumAddress('0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359')).toBe(
      '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359'
    );
    expect(toChecksumAddress('0xde709f2102306220921060314715629080e2fb77')).toBe(
      '0xde709f2102306220921060314715629080e2fb77'
    );
  });
});

describe('toStorageWord', () => {
  it('left-pads short RPC results to 32 bytes', () => {
    expect(toStorageWord('0x01')).toHaveLength(32);
    expect(bytesToBigInt(toStorageWord('0x01'))).toBe(1n);
    expect(bytesToBigInt(toStorageWord('0x'))).toBe(0n);
  });

  it('rejects oversized words', () => {
    expect(() => toStorageWord(new Uint8Array(33))).toThrow(RangeError);
  });
});
