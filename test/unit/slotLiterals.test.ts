/**
 * Whole derived slots pinned to hard-coded values.
 *
 * Every expected value in this file is a literal computed OUTSIDE the package (keccak-256 from
 * `@noble/hashes` over hand-assembled preimages, in `.omc/state/probes-fix/`), never by a
 * helper that shares code with `src/core`. A mistake made identically in `deriveSlot` and in
 * `helpers.ts` — a swapped `key ++ slot` order, say — fails here.
 */
import { describe, expect, it } from 'vitest';
import {
  type ParsedStorageLayout,
  type RawStorageLayout,
  parseStorageLayout,
} from '../../src/core/layout/parseStorageLayout.js';
import { resolveReadPlan } from '../../src/core/slots/decode.js';
import { type PathSegment, deriveSlot } from '../../src/core/slots/deriveSlot.js';
import { MockStorage, loadLayout, longBytesHeader, word } from './helpers.js';

const WORD_MODULUS = 2n ** 256n;
const MAX_SLOT = WORD_MODULUS - 1n;

// keccak256(pad32(n)): where the elements of a dynamic array declared at slot n start.
const KECCAK_OF_SLOT_3 = 0xc2575a0e9e593c00f959f8c92f12db2869c3395a3b0502d05e2516446f71f85bn;
const KECCAK_OF_SLOT_8 = 0xf3f7a9fe364faab93b216da50a3214154f22a0a2b415b23a84c8169e8b636ee3n;

const key = (value: string | number | bigint): PathSegment => ({ kind: 'key', value });
const index = (value: number | bigint): PathSegment => ({ kind: 'index', value });
const field = (name: string): PathSegment => ({ kind: 'field', name });

/** `mapping(uint256 => uint256)` declared twice, at slots 0 and 1. */
const TWO_MAPPINGS: RawStorageLayout = {
  storage: [
    { label: 'first', offset: 0, slot: '0', type: 't_mapping(t_uint256,t_uint256)' },
    { label: 'second', offset: 0, slot: '1', type: 't_mapping(t_uint256,t_uint256)' },
  ],
  types: {
    't_mapping(t_uint256,t_uint256)': {
      encoding: 'mapping',
      key: 't_uint256',
      label: 'mapping(uint256 => uint256)',
      numberOfBytes: '32',
      value: 't_uint256',
    },
    t_uint256: { encoding: 'inplace', label: 'uint256', numberOfBytes: '32' },
  },
};

function slotOf(
  layout: ParsedStorageLayout,
  variable: string,
  ...segments: readonly PathSegment[]
): bigint {
  const { readPlan } = deriveSlot(layout, variable, segments);
  if (readPlan.kind !== 'single') throw new Error('expected a single-slot plan');
  return readPlan.slot;
}

describe('mapping slots against published values', () => {
  const layout = parseStorageLayout(TWO_MAPPINGS);

  it('derives keccak256(pad32(1) ++ pad32(0)) for key 1 of the mapping at slot 0', () => {
    expect(slotOf(layout, 'first', key(1))).toBe(
      0xada5013122d395ba3c54772283fb069b10426056ef8ca54750cb9bb552a59e7dn
    );
  });

  it('derives keccak256(pad32(0) ++ pad32(1)) for key 0 of the mapping at slot 1', () => {
    expect(slotOf(layout, 'second', key(0))).toBe(
      0xa6eef7e35abe7026729641147f7915573c7e97b47efa546f5f6e3230263bcb49n
    );
  });

  it('hashes the outer key first in a nested mapping', () => {
    // mapping(address => mapping(string => uint256)) at slot 3:
    // keccak256(utf8("abc") ++ keccak256(pad32(0x11…11) ++ pad32(3))).
    const nested = parseStorageLayout({
      storage: [{ label: 'm', offset: 0, slot: '3', type: 't_outer' }],
      types: {
        t_outer: {
          encoding: 'mapping',
          key: 't_address',
          label: 'mapping(address => mapping(string => uint256))',
          numberOfBytes: '32',
          value: 't_inner',
        },
        t_inner: {
          encoding: 'mapping',
          key: 't_string_memory_ptr',
          label: 'mapping(string => uint256)',
          numberOfBytes: '32',
          value: 't_uint256',
        },
        t_address: { encoding: 'inplace', label: 'address', numberOfBytes: '20' },
        t_string_memory_ptr: { encoding: 'bytes', label: 'string', numberOfBytes: '32' },
        t_uint256: { encoding: 'inplace', label: 'uint256', numberOfBytes: '32' },
      },
    });
    expect(slotOf(nested, 'm', key(`0x${'11'.repeat(20)}`), key('abc'))).toBe(
      0xe664dfe29e148dcbfdaeff7f2ca51e79799dc392e0681c6814963d33afcf4abcn
    );
  });

  it('RIGHT-pads a bytes4-backed user-defined value type key', () => {
    // ZZFunctionStorage.byTag, `mapping(Tag => uint256)` at slot 3, `type Tag is bytes4`:
    // keccak256(0x12345678 ++ 28 zero bytes ++ pad32(3)).
    const layout4 = loadLayout('ZZFunctionStorage.sol:ZZFunctionStorage');
    const slot = slotOf(layout4, 'byTag', key('0x12345678'));
    expect(slot).toBe(0xd0c16b22edb3dbdacec85c050bd064631f9695216527da0e71532ddec7a644a6n);
    // The slot a LEFT-padded key (the uint32 reading of the same digits) would give.
    expect(slot).not.toBe(0xfd81c96e8c279514072033c54ad58031a4d9d2ee052dc3818e1e37edbbfbfa88n);
  });
});

describe('dynamic array bases against published values', () => {
  const layout = loadLayout('ArrayStorage.sol:ArrayStorage');

  it('starts a dynamic array\'s elements at keccak256(pad32(slot))', () => {
    expect(slotOf(layout, 'words', index(0))).toBe(KECCAK_OF_SLOT_3);
    expect(slotOf(layout, 'words', index(2))).toBe(KECCAK_OF_SLOT_3 + 2n);
    expect(slotOf(layout, 'pairs', index(0), field('who'))).toBe(KECCAK_OF_SLOT_8 + 1n);
  });
});

describe('slot arithmetic wraps modulo 2^256', () => {
  const layout = loadLayout('ArrayStorage.sol:ArrayStorage');

  it('wraps a one-slot element whose slot passes 2^256', () => {
    // words: uint256[] at slot 3. The index that lands exactly on 2^256 + 5, written as a
    // literal: 2^256 - keccak256(pad32(3)) + 5.
    const wrapping =
      27889059366240281169193357100633332908378892778709981755071813198463099602858n;
    expect(wrapping).toBe(WORD_MODULUS - KECCAK_OF_SLOT_3 + 5n);
    expect(slotOf(layout, 'words', index(wrapping))).toBe(5n);
    expect(slotOf(layout, 'words', index(wrapping - 6n))).toBe(MAX_SLOT);
    expect(slotOf(layout, 'words', index(wrapping - 5n))).toBe(0n);
  });

  it('keeps the bounds obligation on the index as given', () => {
    const wrapping = WORD_MODULUS - KECCAK_OF_SLOT_3 + 5n;
    const { obligations } = deriveSlot(layout, 'words', [index(wrapping)]);
    expect(obligations).toEqual([
      { lengthSlot: 3n, index: wrapping, typeLabel: 'uint256[]', variableName: 'words', segmentIndex: 0 },
    ]);
  });

  it('wraps a multi-slot element, and a struct member slot past the last slot', () => {
    // pairs: Pair[] at slot 8, two slots per element. Element i starts at the LAST slot,
    // 2^256 - 1, for i = (2^256 - 1 - keccak256(pad32(8))) / 2 (the hash is odd).
    const last = 2721241278951752125306575359572678766943356708942451592547670514960859809934n;
    expect(KECCAK_OF_SLOT_8 + 2n * last).toBe(MAX_SLOT);
    expect(slotOf(layout, 'pairs', index(last), field('left'))).toBe(MAX_SLOT);
    // `who` is the struct's second slot: slot + 1 wraps to 0.
    expect(slotOf(layout, 'pairs', index(last), field('who'))).toBe(0n);
    // One element further is 2^256 + 1 before reduction.
    expect(slotOf(layout, 'pairs', index(last + 1n), field('left'))).toBe(1n);
    expect(slotOf(layout, 'pairs', index(last + 1n), field('who'))).toBe(2n);
  });

  it('never yields a slot outside [0, 2^256) for an index of any size', () => {
    for (const huge of [MAX_SLOT, WORD_MODULUS, 2n ** 300n]) {
      const slot = slotOf(layout, 'words', index(huge));
      expect(slot >= 0n && slot <= MAX_SLOT).toBe(true);
      expect(slot).toBe((KECCAK_OF_SLOT_3 + huge) % WORD_MODULUS);
    }
  });

  it('wraps the data slots of a long string whose data starts at the last slot', async () => {
    const storage = new MockStorage()
      .set(9n, longBytesHeader(40))
      .set(MAX_SLOT, word(0xaan))
      .set(0n, word(0xbbn));
    const resolved = await resolveReadPlan(
      { kind: 'multi', headerSlot: 9n, dataBaseSlot: MAX_SLOT },
      storage.reader()
    );
    expect(storage.reads.map((r) => r.slot)).toEqual([9n, MAX_SLOT, 0n]);
    expect(resolved.slotValues).toEqual([word(0xaan), word(0xbbn)]);
  });
});
