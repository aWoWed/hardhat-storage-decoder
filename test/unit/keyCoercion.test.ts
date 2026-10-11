import { describe, expect, it } from 'vitest';
import type { TypeInfo, ValueKind } from '../../src/core/layout/parseStorageLayout.js';
import { IndexOutOfBoundsError, UnsupportedTypeError } from '../../src/core/query/errors.js';
import {
  type MappingKeyValue,
  type PathSegment,
  deriveSlot,
  encodeMappingKey,
} from '../../src/core/slots/deriveSlot.js';
import { bytesToHex, hexToBytes } from '../../src/core/util/bytes.js';
import { loadLayout } from './helpers.js';

/** A value type as the parser would produce it, for a key type no fixture declares. */
function valueType(label: string, valueKind: ValueKind, numberOfBytes: number): TypeInfo {
  return { id: `t_${label}`, kind: 'value', encoding: 'inplace', label, numberOfBytes, valueKind };
}

const INT8 = valueType('int8', { family: 'int', bits: 8, bytes: 1 }, 1);
const UINT8 = valueType('uint8', { family: 'uint', bits: 8, bytes: 1 }, 1);
const INT256 = valueType('int256', { family: 'int', bits: 256, bytes: 32 }, 32);
const UINT256 = valueType('uint256', { family: 'uint', bits: 256, bytes: 32 }, 32);
const BOOL = valueType('bool', { family: 'bool' }, 1);
const ADDRESS = valueType('address', { family: 'address' }, 20);
const BYTES4 = valueType('bytes4', { family: 'bytesN', size: 4 }, 4);
const STRING: TypeInfo = {
  id: 't_string_memory_ptr',
  kind: 'dynamicBytes',
  encoding: 'bytes',
  label: 'string',
  numberOfBytes: 32,
  valueKind: { family: 'string' },
};
const BYTES: TypeInfo = { ...STRING, id: 't_bytes_memory_ptr', label: 'bytes', valueKind: { family: 'bytes' } };

const encoded = (type: TypeInfo, value: MappingKeyValue): string =>
  bytesToHex(encodeMappingKey(type, value));

/** A 32-byte word written out as hex: `fill` repeated, then the given low-order bytes. */
const wordHex = (fill: string, low: string): string =>
  `0x${fill.repeat(32 - low.length / 2)}${low}`;

describe('signed integer keys', () => {
  it.each([
    [-1, wordHex('ff', 'ff')],
    [-128, wordHex('ff', '80')],
    [127, wordHex('00', '7f')],
    [0, wordHex('00', '00')],
    [-1n, wordHex('ff', 'ff')],
    ['-128', wordHex('ff', '80')],
  ])('sign-extends the int8 key %s across the whole word', (value, expected) => {
    expect(encoded(INT8, value)).toBe(expected);
  });

  it.each([128, -129, 255, 256n, '-200'])(
    'rejects the int8 key %s instead of wrapping it into another key',
    (value) => {
      expect(() => encodeMappingKey(INT8, value)).toThrow(TypeError);
      expect(() => encodeMappingKey(INT8, value)).toThrow(
        /mapping key of type int8 must fit in 8 bits \(-128\.\.127\)/
      );
    }
  );

  it('accepts both ends of int256 and rejects one past each', () => {
    const min = -(2n ** 255n);
    const max = 2n ** 255n - 1n;
    expect(encoded(INT256, min)).toBe(`0x80${'00'.repeat(31)}`);
    expect(encoded(INT256, max)).toBe(`0x7f${'ff'.repeat(31)}`);
    expect(() => encodeMappingKey(INT256, min - 1n)).toThrow(/must fit in 256 bits/);
    expect(() => encodeMappingKey(INT256, max + 1n)).toThrow(/must fit in 256 bits/);
  });

  it('reads a Uint8Array as an unsigned number, so it cannot carry a negative key', () => {
    expect(encoded(INT8, new Uint8Array([0x7f]))).toBe(wordHex('00', '7f'));
    expect(() => encodeMappingKey(INT8, new Uint8Array([0xff]))).toThrow(/must fit in 8 bits/);
  });
});

describe('unsigned integer keys', () => {
  it('accepts both ends of uint8 and uint256', () => {
    expect(encoded(UINT8, 0)).toBe(wordHex('00', '00'));
    expect(encoded(UINT8, 255)).toBe(wordHex('00', 'ff'));
    expect(encoded(UINT256, 2n ** 256n - 1n)).toBe(`0x${'ff'.repeat(32)}`);
  });

  it('rejects a value outside the width', () => {
    expect(() => encodeMappingKey(UINT8, 256)).toThrow(/must fit in 8 bits \(0\.\.255\), got 256/);
    expect(() => encodeMappingKey(UINT8, -1)).toThrow(/must not be negative, got -1/);
    expect(() => encodeMappingKey(UINT256, 2n ** 256n)).toThrow(/must fit in 256 bits/);
  });

  it('takes a boolean as 0 or 1, and a Uint8Array as a big-endian number', () => {
    expect(encoded(UINT8, true)).toBe(wordHex('00', '01'));
    expect(encoded(UINT8, false)).toBe(wordHex('00', '00'));
    expect(encoded(UINT256, new Uint8Array([0x01, 0x02]))).toBe(wordHex('00', '0102'));
    expect(() => encodeMappingKey(UINT8, new Uint8Array([1, 0]))).toThrow(/must fit in 8 bits/);
    expect(() => encodeMappingKey(UINT256, new Uint8Array(33).fill(1))).toThrow(
      /must fit in 256 bits/
    );
  });

  it.each([1.5, -0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects the non-integer number %s',
    (value) => {
      expect(() => encodeMappingKey(UINT256, value)).toThrow(TypeError);
      expect(() => encodeMappingKey(UINT256, value)).toThrow(
        /mapping key of type uint256 must be an integer/
      );
    }
  );

  it.each([null, undefined, {}, Symbol.iterator])(
    'rejects %s, which is no key at all',
    (value) => {
      expect(() => encodeMappingKey(UINT256, value as never)).toThrow(TypeError);
      expect(() => encodeMappingKey(UINT256, value as never)).toThrow(/unsupported value/);
    }
  );

  it('names null in the message', () => {
    expect(() => encodeMappingKey(UINT256, null as never)).toThrow(
      'mapping key of type uint256 has unsupported value null'
    );
  });
});

describe('number keys and indices beyond Number.MAX_SAFE_INTEGER', () => {
  const MAPPINGS = loadLayout('NestedMapping.sol:NestedMapping');
  const ARRAYS = loadLayout('ArrayStorage.sol:ArrayStorage');
  const key = (value: MappingKeyValue): PathSegment => ({ kind: 'key', value });
  const index = (value: number | bigint): PathSegment => ({ kind: 'index', value });

  // 12345678901234567890 is not representable: the number that arrives is ...567168.
  it.each([2 ** 53, 2 ** 53 + 2, 12345678901234567890, -(2 ** 53), 1e30])(
    'rejects the number key %s, which JavaScript may already have rounded',
    (value) => {
      expect(() => encodeMappingKey(UINT256, value)).toThrow(TypeError);
      expect(() => encodeMappingKey(UINT256, value)).toThrow(/bigint/);
      expect(() => encodeMappingKey(INT256, value)).toThrow(/bigint/);
      expect(() => encodeMappingKey(BOOL, value)).toThrow(/bigint/);
      expect(() => deriveSlot(MAPPINGS, 'bySigned', [key(value)])).toThrow(/bigint/);
    }
  );

  it('accepts the same magnitudes as a bigint, and the largest safe number', () => {
    expect(encoded(UINT256, 12345678901234567890n)).toBe(wordHex('00', 'ab54a98ceb1f0ad2'));
    expect(encoded(UINT256, 2n ** 53n + 1n)).toBe(wordHex('00', '20000000000001'));
    expect(encoded(UINT256, Number.MAX_SAFE_INTEGER)).toBe(wordHex('00', '1fffffffffffff'));
    expect(encoded(INT256, Number.MIN_SAFE_INTEGER)).toBe(wordHex('ff', 'e0000000000001'));
  });

  it.each([2 ** 53, 2 ** 53 + 2, 1e30])(
    'rejects the number index %s with a TypeError that asks for a bigint',
    (value) => {
      const read = (): unknown => deriveSlot(ARRAYS, 'words', [index(value)]);
      expect(read).toThrow(TypeError);
      expect(read).toThrow(/bigint/);
      expect(read).not.toThrow(IndexOutOfBoundsError);
    }
  );

  it('accepts the same indices as a bigint, and the largest safe number', () => {
    expect(deriveSlot(ARRAYS, 'words', [index(2n ** 53n + 1n)]).obligations[0]?.index).toBe(
      9007199254740993n
    );
    expect(
      deriveSlot(ARRAYS, 'words', [index(Number.MAX_SAFE_INTEGER)]).obligations[0]?.index
    ).toBe(9007199254740991n);
  });

  it('keeps the earlier answers for the other bad indices', () => {
    expect(() => deriveSlot(ARRAYS, 'words', [index(1.5)])).toThrow(IndexOutOfBoundsError);
    expect(() => deriveSlot(ARRAYS, 'words', [index(-1)])).toThrow(IndexOutOfBoundsError);
    expect(() => deriveSlot(ARRAYS, 'words', [index(Number.NaN)])).toThrow(
      /must be a finite integer/
    );
  });
});

describe('bool keys', () => {
  it.each([
    [true, '01'],
    [false, '00'],
    [1, '01'],
    [0, '00'],
    [2, '01'],
    [5n, '01'],
    ['0', '00'],
    ['0x1', '01'],
    [new Uint8Array([0, 0]), '00'],
    [new Uint8Array([0, 3]), '01'],
  ])('coerces %s to a full word', (value, low) => {
    expect(encoded(BOOL, value)).toBe(wordHex('00', low));
  });

  it('rejects a string that is not an integer', () => {
    expect(() => encodeMappingKey(BOOL, 'true')).toThrow(/not a valid integer: "true"/);
    expect(() => encodeMappingKey(BOOL, '')).toThrow(/not a valid integer/);
  });
});

describe('address keys', () => {
  const ALICE = '0x1111111111111111111111111111111111111111';

  it('left-pads 20 bytes given as hex, with or without a prefix, or as bytes', () => {
    const expected = wordHex('00', '11'.repeat(20));
    expect(encoded(ADDRESS, ALICE)).toBe(expected);
    expect(encoded(ADDRESS, '11'.repeat(20))).toBe(expected);
    expect(encoded(ADDRESS, hexToBytes(ALICE))).toBe(expected);
  });

  it.each([`0x${'11'.repeat(19)}`, `0x${'11'.repeat(21)}`, '0x', new Uint8Array(32)])(
    'rejects %j, which is not 20 bytes',
    (value) => {
      expect(() => encodeMappingKey(ADDRESS, value)).toThrow(TypeError);
      expect(() => encodeMappingKey(ADDRESS, value)).toThrow(/must be a 20-byte address, got/);
    }
  );

  it.each([5, 5n, true])('rejects the %s, which is neither hex nor bytes', (value) => {
    expect(() => encodeMappingKey(ADDRESS, value)).toThrow(/must be a hex string or Uint8Array/);
  });

  it('rejects text that is not hex', () => {
    expect(() => encodeMappingKey(ADDRESS, 'alice')).toThrow(TypeError);
    expect(() => encodeMappingKey(ADDRESS, `0x${'zz'.repeat(20)}`)).toThrow(/invalid hex string/);
  });
});

describe('bytesN keys', () => {
  it('RIGHT-pads a full-width and a shorter key', () => {
    expect(encoded(BYTES4, '0xdeadbeef')).toBe(`0xdeadbeef${'00'.repeat(28)}`);
    expect(encoded(BYTES4, '0x12')).toBe(`0x12${'00'.repeat(31)}`);
    expect(encoded(BYTES4, '0x')).toBe(`0x${'00'.repeat(32)}`);
    expect(encoded(BYTES4, new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe(
      `0xdeadbeef${'00'.repeat(28)}`
    );
  });

  it('rejects a key longer than N', () => {
    expect(() => encodeMappingKey(BYTES4, '0x0102030405')).toThrow(TypeError);
    expect(() => encodeMappingKey(BYTES4, '0x0102030405')).toThrow(
      'mapping key of type bytes4 must be at most 4 byte(s), got 5'
    );
    expect(() => encodeMappingKey(BYTES4, new Uint8Array(5))).toThrow(/at most 4 byte\(s\), got 5/);
  });

  it('rejects a number, and odd-length hex', () => {
    expect(() => encodeMappingKey(BYTES4, 0x12345678)).toThrow(
      /must be a hex string or Uint8Array, got number 305419896/
    );
    expect(() => encodeMappingKey(BYTES4, '0x123')).toThrow(/even number of digits/);
  });
});

describe('string and bytes keys', () => {
  it('uses a string key\'s UTF-8 bytes unpadded, even when it looks like hex', () => {
    expect(encoded(STRING, 'abc')).toBe('0x616263');
    expect(encoded(STRING, '')).toBe('0x');
    expect(encoded(STRING, '0x12')).toBe('0x30783132');
    expect(encoded(STRING, 'é')).toBe('0xc3a9');
  });

  it.each([
    [5, 'number 5'],
    [true, 'boolean true'],
    [new Uint8Array(3), 'Uint8Array(3)'],
    [null, 'null'],
  ])('rejects the non-string %s for a string key', (value, described) => {
    expect(() => encodeMappingKey(STRING, value as never)).toThrow(TypeError);
    expect(() => encodeMappingKey(STRING, value as never)).toThrow(
      `mapping key of type string must be a string, got ${described}`
    );
  });

  it('uses a bytes key as it is, from hex or from a Uint8Array', () => {
    expect(encoded(BYTES, '0x0badc0de')).toBe('0x0badc0de');
    expect(encoded(BYTES, new Uint8Array([1, 2, 3]))).toBe('0x010203');
    expect(encoded(BYTES, '')).toBe('0x');
    expect(() => encodeMappingKey(BYTES, 'not hex')).toThrow(TypeError);
    expect(() => encodeMappingKey(BYTES, 7)).toThrow(/must be a hex string or Uint8Array/);
  });
});

describe('types that cannot be a mapping key', () => {
  it('refuses a composite type and a type with no resolved value kind', () => {
    const struct: TypeInfo = {
      id: 't_struct(S)1_storage',
      kind: 'struct',
      encoding: 'inplace',
      label: 'struct S',
      numberOfBytes: 32,
      members: [],
    };
    const unresolved: TypeInfo = { ...UINT256, valueKind: undefined };
    for (const type of [struct, unresolved]) {
      expect(() => encodeMappingKey(type, 1)).toThrow(UnsupportedTypeError);
      expect(() => encodeMappingKey(type, 1)).toThrow(/cannot be used as a mapping key/);
    }
  });
});
