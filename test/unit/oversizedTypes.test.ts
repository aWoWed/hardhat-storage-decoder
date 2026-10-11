import { describe, expect, it } from 'vitest';
import {
  type RawStorageLayout,
  getTypeInfo,
  parseStorageLayout,
} from '../../src/core/layout/parseStorageLayout.js';
import { UnsupportedTypeError } from '../../src/core/query/errors.js';
import { type PathSegment, deriveSlot } from '../../src/core/slots/deriveSlot.js';

// solc 0.8.26 output for:
//   contract Gap {
//     uint8 head;
//     uint256[2**64] gap;
//     uint8 tail;
//     struct S { uint256[2**64] big; uint8 after_; }
//     S s;
//     mapping(uint256 => uint256[2**64]) m;
//   }
// The array's length and the sizes of the array and of the struct are beyond what a `number`
// holds exactly. Every slot is a decimal string and stays exact as a bigint.
const BIG_ARRAY = 't_array(t_uint256)18446744073709551616_storage';
const BIG_MAPPING = `t_mapping(t_uint256,${BIG_ARRAY})`;
const GAP: RawStorageLayout = {
  storage: [
    { astId: 3, contract: 'Gap.sol:Gap', label: 'head', offset: 0, slot: '0', type: 't_uint8' },
    { astId: 9, contract: 'Gap.sol:Gap', label: 'gap', offset: 0, slot: '1', type: BIG_ARRAY },
    {
      astId: 11,
      contract: 'Gap.sol:Gap',
      label: 'tail',
      offset: 0,
      slot: '18446744073709551617',
      type: 't_uint8',
    },
    {
      astId: 23,
      contract: 'Gap.sol:Gap',
      label: 's',
      offset: 0,
      slot: '18446744073709551618',
      type: 't_struct(S)20_storage',
    },
    {
      astId: 31,
      contract: 'Gap.sol:Gap',
      label: 'm',
      offset: 0,
      slot: '36893488147419103235',
      type: BIG_MAPPING,
    },
  ],
  types: {
    [BIG_ARRAY]: {
      base: 't_uint256',
      encoding: 'inplace',
      label: 'uint256[18446744073709551616]',
      numberOfBytes: '590295810358705651712',
    },
    [BIG_MAPPING]: {
      encoding: 'mapping',
      key: 't_uint256',
      label: 'mapping(uint256 => uint256[18446744073709551616])',
      numberOfBytes: '32',
      value: BIG_ARRAY,
    },
    't_struct(S)20_storage': {
      encoding: 'inplace',
      label: 'struct Gap.S',
      members: [
        { astId: 17, contract: 'Gap.sol:Gap', label: 'big', offset: 0, slot: '0', type: BIG_ARRAY },
        {
          astId: 19,
          contract: 'Gap.sol:Gap',
          label: 'after_',
          offset: 0,
          slot: '18446744073709551616',
          type: 't_uint8',
        },
      ],
      numberOfBytes: '590295810358705651744',
    },
    t_uint256: { encoding: 'inplace', label: 'uint256', numberOfBytes: '32' },
    t_uint8: { encoding: 'inplace', label: 'uint8', numberOfBytes: '1' },
  },
};

const index = (value: number | bigint): PathSegment => ({ kind: 'index', value });
const field = (name: string): PathSegment => ({ kind: 'field', name });
const key = (value: number): PathSegment => ({ kind: 'key', value });

describe('a contract with one type too large for a number', () => {
  it('still parses', () => {
    expect(() => parseStorageLayout(GAP)).not.toThrow();
  });

  it('reads the ordinary variables around the oversized one at their exact slots', () => {
    const layout = parseStorageLayout(GAP);
    expect(deriveSlot(layout, 'head', []).readPlan).toEqual({ kind: 'single', slot: 0n });
    expect(deriveSlot(layout, 'tail', []).readPlan).toEqual({
      kind: 'single',
      slot: 18446744073709551617n,
    });
  });

  it('reads a field that follows an oversized member inside a struct', () => {
    const layout = parseStorageLayout(GAP);
    // The struct's own size is oversized too, but a field needs only its member slot.
    expect(deriveSlot(layout, 's', [field('after_')]).readPlan).toEqual({
      kind: 'single',
      slot: 18446744073709551618n + 18446744073709551616n,
    });
  });

  it.each([
    ['the oversized array itself', 'gap', [index(0)]],
    ['the oversized array inside a struct', 's', [field('big'), index(0)]],
    ['the oversized array as a mapping value', 'm', [key(5), index(0)]],
  ] as const)('refuses to index %s, naming the size', (_what, variable, segments) => {
    const layout = parseStorageLayout(GAP);
    const walk = (): unknown => deriveSlot(layout, variable, segments);
    expect(walk).toThrow(UnsupportedTypeError);
    expect(walk).toThrow(/18446744073709551616/);
    expect(walk).toThrow(/MAX_SAFE_INTEGER/);
  });

  it('reports a path that stops on the oversized array as too short, like any other', () => {
    const layout = parseStorageLayout(GAP);
    expect(() => deriveSlot(layout, 'gap', [])).toThrow(/still needs/);
    expect(() => deriveSlot(layout, 'm', [key(5)])).toThrow(/still needs/);
  });

  it('indexes an array whose length is safe although its byte size is not', () => {
    // `uint256[2**50] wide; uint8 after_;` — 2^50 elements, 2^55 bytes.
    const id = 't_array(t_uint256)1125899906842624_storage';
    const layout = parseStorageLayout({
      storage: [{ astId: 5, contract: 'W.sol:W', label: 'wide', offset: 0, slot: '0', type: id }],
      types: {
        [id]: {
          base: 't_uint256',
          encoding: 'inplace',
          label: 'uint256[1125899906842624]',
          numberOfBytes: '36028797018963968',
        },
        t_uint256: { encoding: 'inplace', label: 'uint256', numberOfBytes: '32' },
      },
    });
    expect(getTypeInfo(layout, id).oversized).toMatch(/numberOfBytes/);
    expect(getTypeInfo(layout, id).fixedLength).toBe(2 ** 50);
    expect(deriveSlot(layout, 'wide', [index(2n ** 50n - 1n)]).readPlan).toEqual({
      kind: 'single',
      slot: 2n ** 50n - 1n,
    });
    expect(() => deriveSlot(layout, 'wide', [index(2n ** 50n)])).toThrow(/out of bounds/);
  });

  it('refuses the inner array of `uint256[2**60+1][3]` and never derives a rounded slot', () => {
    // The shape behind the original wrong-slot report: element 1 starts at slot 2^60 + 1, and
    // a rounded element size would have put it at 2^60.
    const inner = 't_array(t_uint256)1152921504606846977_storage';
    const outer = `t_array(${inner})3_storage`;
    const layout = parseStorageLayout({
      storage: [
        { astId: 7, contract: 'F.sol:F', label: 'big', offset: 0, slot: '0', type: outer },
        {
          astId: 9,
          contract: 'F.sol:F',
          label: 'tail',
          offset: 0,
          slot: '3458764513820540931',
          type: 't_uint256',
        },
      ],
      types: {
        [inner]: {
          base: 't_uint256',
          encoding: 'inplace',
          label: 'uint256[1152921504606846977]',
          numberOfBytes: '36893488147419103264',
        },
        [outer]: {
          base: inner,
          encoding: 'inplace',
          label: 'uint256[1152921504606846977][3]',
          numberOfBytes: '110680464442257309792',
        },
        t_uint256: { encoding: 'inplace', label: 'uint256', numberOfBytes: '32' },
      },
    });
    expect(deriveSlot(layout, 'tail', []).readPlan).toEqual({
      kind: 'single',
      slot: 3n * (2n ** 60n + 1n),
    });
    const walk = (): unknown => deriveSlot(layout, 'big', [index(1), index(0)]);
    expect(walk).toThrow(UnsupportedTypeError);
    expect(walk).toThrow(/MAX_SAFE_INTEGER/);
  });

  it('marks the types whose size is not exact, and no others', () => {
    const layout = parseStorageLayout(GAP);
    expect(getTypeInfo(layout, BIG_ARRAY).oversized).toMatch(/MAX_SAFE_INTEGER/);
    expect(getTypeInfo(layout, BIG_ARRAY).fixedLength).toBeUndefined();
    expect(getTypeInfo(layout, 't_struct(S)20_storage').oversized).toMatch(/MAX_SAFE_INTEGER/);
    expect(getTypeInfo(layout, 't_uint8').oversized).toBeUndefined();
    expect(getTypeInfo(layout, BIG_MAPPING).oversized).toBeUndefined();
  });

  it('refuses an array whose elements are an oversized struct', () => {
    const layout = parseStorageLayout({
      storage: [
        {
          astId: 40,
          contract: 'Gap.sol:Gap',
          label: 'pair',
          offset: 0,
          slot: '0',
          type: 't_array(t_struct(S)20_storage)2_storage',
        },
      ],
      types: {
        ...GAP.types,
        't_array(t_struct(S)20_storage)2_storage': {
          base: 't_struct(S)20_storage',
          encoding: 'inplace',
          label: 'struct Gap.S[2]',
          numberOfBytes: '1180591620717411303488',
        },
      },
    });
    const walk = (): unknown => deriveSlot(layout, 'pair', [index(1), field('after_')]);
    expect(walk).toThrow(UnsupportedTypeError);
    expect(walk).toThrow(/MAX_SAFE_INTEGER/);
  });
});
