import { describe, expect, it } from 'vitest';
import {
  IndexOutOfBoundsError,
  PathSegmentCountMismatchError,
  PathSegmentKindMismatchError,
  UnsupportedTypeError,
} from '../../src/core/query/errors.js';
import { type PathSegment, deriveSlot } from '../../src/core/slots/deriveSlot.js';
import {
  addressKey,
  arrayBase,
  bytesKey,
  bytesNKey,
  intKey,
  loadBareLayout,
  loadLayout,
  mappingSlot,
  stringKey,
  uintKey,
} from './helpers.js';

const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';

function single(
  fqn: string,
  variable: string,
  ...segments: readonly PathSegment[]
): { slot: bigint; offset: number } {
  const result = deriveSlot(loadLayout(fqn), variable, segments);
  if (result.readPlan.kind !== 'single') {
    throw new Error(`expected a single-slot plan for ${variable}, got ${result.readPlan.kind}`);
  }
  return { slot: result.readPlan.slot, offset: result.offset };
}

const k = (value: string | number | bigint | boolean | Uint8Array): PathSegment => ({
  kind: 'key',
  value,
});
const i = (value: number | bigint): PathSegment => ({ kind: 'index', value });
const f = (name: string): PathSegment => ({ kind: 'field', name });

// -----------------------------------------------------------------------------------------
// Simple + packed
// -----------------------------------------------------------------------------------------

describe('simple and packed variables', () => {
  it('reads a declared slot straight through', () => {
    expect(single('SimpleStorage.sol:SimpleStorage', 'count')).toEqual({ slot: 0n, offset: 0 });
    expect(single('SimpleStorage.sol:SimpleStorage', 'digest')).toEqual({ slot: 3n, offset: 0 });
  });

  it('carries the declared byte offset for packed variables', () => {
    expect(single('PackedStorage.sol:PackedStorage', 'a')).toEqual({ slot: 0n, offset: 0 });
    expect(single('PackedStorage.sol:PackedStorage', 'b')).toEqual({ slot: 0n, offset: 16 });
    expect(single('PackedStorage.sol:PackedStorage', 'e')).toEqual({ slot: 0n, offset: 29 });
    expect(single('PackedStorage.sol:PackedStorage', 'g')).toEqual({ slot: 1n, offset: 16 });
    expect(single('PackedStorage.sol:PackedStorage', 'i')).toEqual({ slot: 2n, offset: 20 });
  });

  it('resolves inherited variables', () => {
    expect(single('InheritedStorage.sol:InheritedStorage', 'midPacked')).toEqual({
      slot: 1n,
      offset: 16,
    });
    expect(single('InheritedStorage.sol:InheritedStorage', 'childValue')).toEqual({
      slot: 3n,
      offset: 0,
    });
  });
});

// -----------------------------------------------------------------------------------------
// Mappings — one case per padding rule
// -----------------------------------------------------------------------------------------

describe('mapping keys', () => {
  const FQN = 'NestedMapping.sol:NestedMapping';

  it('re-hashes iteratively for arbitrarily deep nesting', () => {
    // triple lives at slot 0: keccak(k3 ++ keccak(k2 ++ keccak(k1 ++ 0)))
    const level1 = mappingSlot(addressKey(ALICE), 0n);
    const level2 = mappingSlot(addressKey(BOB), level1);
    const level3 = mappingSlot(uintKey(7), level2);
    expect(single(FQN, 'triple', k(ALICE), k(BOB), k(7))).toEqual({ slot: level3, offset: 0 });
  });

  it('left-pads value-type keys', () => {
    expect(single(FQN, 'bySmallUint', k(3))).toEqual({
      slot: mappingSlot(uintKey(3), 6n),
      offset: 0,
    });
    expect(single(FQN, 'byFlag', k(true))).toEqual({
      slot: mappingSlot(uintKey(1), 5n),
      offset: 0,
    });
  });

  it('sign-extends negative integer keys', () => {
    expect(single(FQN, 'bySigned', k(-42))).toEqual({
      slot: mappingSlot(intKey(-42n), 3n),
      offset: 0,
    });
    // A sign-extended key must not equal the zero-padded encoding of the same magnitude.
    expect(single(FQN, 'bySigned', k(-42)).slot).not.toBe(mappingSlot(uintKey(42), 3n));
  });

  it('RIGHT-pads bytesN keys', () => {
    expect(single(FQN, 'bySelector', k('0xdeadbeef'))).toEqual({
      slot: mappingSlot(bytesNKey('0xdeadbeef'), 4n),
      offset: 0,
    });
    // The distinguishing assertion: left-padding the same key gives a different slot.
    expect(single(FQN, 'bySelector', k('0xdeadbeef')).slot).not.toBe(
      mappingSlot(uintKey(0xdeadbeefn), 4n)
    );
  });

  it('does not pad string or bytes keys at all', () => {
    expect(single(FQN, 'byName', k('alice'))).toEqual({
      slot: mappingSlot(stringKey('alice'), 1n),
      offset: 0,
    });
    expect(single(FQN, 'byBlob', k('0x0badc0de'))).toEqual({
      slot: mappingSlot(bytesKey('0x0badc0de'), 2n),
      offset: 0,
    });
  });

  it('encodes enum and contract keys by their underlying representation', () => {
    const FQN_EC = 'EnumAndContractStorage.sol:EnumAndContractStorage';
    expect(single(FQN_EC, 'byToken', k(ALICE))).toEqual({
      slot: mappingSlot(addressKey(ALICE), 1n),
      offset: 0,
    });
    expect(single(FQN_EC, 'byStatus', k(1))).toEqual({
      slot: mappingSlot(uintKey(1), 2n),
      offset: 0,
    });
  });

  it('rejects a negative key for an unsigned key type', () => {
    expect(() => single(FQN, 'bySmallUint', k(-1))).toThrow(/must not be negative/);
  });

  it('rejects a uint8 key wider than 8 bits instead of silently wrapping it', () => {
    // 256 does not fit in uint8. Without a range check, bigIntToBytes would silently mod-reduce
    // it to the same encoding as key 0 — a plausible-looking wrong slot rather than an error.
    expect(() => single(FQN, 'bySmallUint', k(256))).toThrow(/must fit in 8 bits/);
    // The boundary value itself must still work.
    expect(single(FQN, 'bySmallUint', k(255))).toEqual({
      slot: mappingSlot(uintKey(255), 6n),
      offset: 0,
    });
  });

  it.each(['', ' ', '\t\n'])(
    'rejects the blank string %j for an integer key instead of reading key 0',
    (blank) => {
      // BigInt('') is 0n, so without a check a blank key silently addresses mapping[0].
      expect(() => single(FQN, 'bySmallUint', k(blank))).toThrow(TypeError);
      expect(() => single(FQN, 'bySmallUint', k(blank))).toThrow(/not a valid integer/);
    }
  );

  it('rejects a string that is not an integer literal for an integer key', () => {
    expect(() => single(FQN, 'bySmallUint', k('abc'))).toThrow(TypeError);
    expect(() => single(FQN, 'bySmallUint', k('abc'))).toThrow(/not a valid integer: "abc"/);
  });

  it('still accepts an integer key given as a padded decimal or hex string', () => {
    const expected = { slot: mappingSlot(uintKey(5), 6n), offset: 0 };
    expect(single(FQN, 'bySmallUint', k(' 5 '))).toEqual(expected);
    expect(single(FQN, 'bySmallUint', k('0x5'))).toEqual(expected);
  });

  it('names a bigint key in the message when the key type does not take one', () => {
    // JSON.stringify throws on a bigint; the description must not go through it.
    expect(() => single(FQN, 'byName', k(5n))).toThrow(/must be a string, got bigint 5n/);
    expect(() => single(FQN, 'bySelector', k(5n))).toThrow(
      /must be a hex string or Uint8Array, got bigint 5n/
    );
  });
});

describe('user-defined value type keys', () => {
  const FQN = 'UserDefinedTypes.sol:UserDefinedTypes';
  const ID = '0x1122334455667788112233445566778811223344556677881122334455667788';

  it('follows the UNDERLYING type\'s padding rule, not a blanket rule', () => {
    // type Id is bytes32 -> right-padded (a no-op at 32 bytes, but dispatched as bytesN)
    expect(single(FQN, 'byId', k(ID))).toEqual({ slot: mappingSlot(bytesNKey(ID), 2n), offset: 0 });

    // type Signed is int128 -> sign-extended across all 32 bytes
    expect(single(FQN, 'bySigned', k(-7))).toEqual({
      slot: mappingSlot(intKey(-7n), 3n),
      offset: 0,
    });
    expect(single(FQN, 'bySigned', k(-7)).slot).not.toBe(mappingSlot(uintKey(7), 3n));

    // type Amount is uint96 -> plain left pad
    expect(single(FQN, 'byAmount', k(1234))).toEqual({
      slot: mappingSlot(uintKey(1234), 4n),
      offset: 0,
    });
  });

  it('carries the resolved value kind onto the variable itself', () => {
    const layout = loadLayout(FQN);
    expect(deriveSlot(layout, 'signedVar', []).valueKind).toEqual({
      family: 'int',
      bits: 128,
      bytes: 16,
    });
    expect(deriveSlot(layout, 'amountVar', []).offset).toBe(16);
  });

  it('refuses to guess when the underlying type is unknown', () => {
    const bare = loadBareLayout(FQN);
    expect(() => deriveSlot(bare, 'byId', [k(ID)])).toThrow(UnsupportedTypeError);
    expect(() => deriveSlot(bare, 'byId', [k(ID)])).toThrow(/underlying type/);
  });
});

// -----------------------------------------------------------------------------------------
// Arrays — the packing arithmetic
// -----------------------------------------------------------------------------------------

describe('dynamic arrays', () => {
  const FQN = 'ArrayStorage.sol:ArrayStorage';

  it('places one 20-byte element per slot', () => {
    const base = arrayBase(0n);
    expect(single(FQN, 'addresses', i(0))).toEqual({ slot: base, offset: 0 });
    expect(single(FQN, 'addresses', i(1))).toEqual({ slot: base + 1n, offset: 0 });
    expect(single(FQN, 'addresses', i(5))).toEqual({ slot: base + 5n, offset: 0 });
  });

  it('packs two 16-byte elements per slot with no remainder', () => {
    const base = arrayBase(1n);
    expect(single(FQN, 'exactPacked', i(0))).toEqual({ slot: base, offset: 0 });
    expect(single(FQN, 'exactPacked', i(1))).toEqual({ slot: base, offset: 16 });
    expect(single(FQN, 'exactPacked', i(2))).toEqual({ slot: base + 1n, offset: 0 });
    expect(single(FQN, 'exactPacked', i(3))).toEqual({ slot: base + 1n, offset: 16 });
  });

  it('leaves the 8-byte trailing gap in a uint96[] unused', () => {
    // THE structurally distinguishing case: floor(32/12) = 2 per slot, 24 bytes used, 8 wasted.
    // A naive `index * 12 / 32` stride would place element 2 at offset 24 of slot base+0.
    const base = arrayBase(2n);
    expect(single(FQN, 'gapPacked', i(0))).toEqual({ slot: base, offset: 0 });
    expect(single(FQN, 'gapPacked', i(1))).toEqual({ slot: base, offset: 12 });
    expect(single(FQN, 'gapPacked', i(2))).toEqual({ slot: base + 1n, offset: 0 });
    expect(single(FQN, 'gapPacked', i(3))).toEqual({ slot: base + 1n, offset: 12 });
    expect(single(FQN, 'gapPacked', i(4))).toEqual({ slot: base + 2n, offset: 0 });

    // Explicitly assert the wrong answer is not produced.
    expect(single(FQN, 'gapPacked', i(2))).not.toEqual({ slot: base, offset: 24 });
  });

  it('gives each multi-slot element its own whole slots', () => {
    // struct Pair is 64 bytes -> 2 slots per element, always at offset 0.
    const base = arrayBase(8n);
    expect(single(FQN, 'pairs', i(0), f('left'))).toEqual({ slot: base, offset: 0 });
    expect(single(FQN, 'pairs', i(0), f('right'))).toEqual({ slot: base, offset: 16 });
    expect(single(FQN, 'pairs', i(0), f('who'))).toEqual({ slot: base + 1n, offset: 0 });
    expect(single(FQN, 'pairs', i(3), f('who'))).toEqual({ slot: base + 7n, offset: 0 });
  });

  it('gives a struct element its own whole slot even when its fields would fit packed', () => {
    // TinyPair{uint8,uint8} would be 2 bytes if solc reported struct types by their packed
    // field size — it does not. solc rounds a composite type's own numberOfBytes up to a whole
    // slot, so `placeArrayElement`'s B<=32 packing branch sees B=32 here (not 2), and correctly
    // gives every element its own slot rather than packing several tiny structs together.
    // Verified against real solc 0.8.26 output (see test/unit/fixtures/layouts.json) before
    // writing this assertion, in response to an external review that flagged this as a risk.
    const base = arrayBase(10n);
    expect(single(FQN, 'tinyPairs', i(0), f('a'))).toEqual({ slot: base, offset: 0 });
    expect(single(FQN, 'tinyPairs', i(0), f('b'))).toEqual({ slot: base, offset: 1 });
    expect(single(FQN, 'tinyPairs', i(1), f('a'))).toEqual({ slot: base + 1n, offset: 0 });
    expect(single(FQN, 'tinyPairs', i(1), f('b'))).toEqual({ slot: base + 1n, offset: 1 });

    // Explicitly assert the wrong (byte-count-only-packing) answer is not produced.
    expect(single(FQN, 'tinyPairs', i(1), f('a'))).not.toEqual({ slot: base, offset: 2 });
  });

  it('emits a bounds obligation against the array\'s own declared slot', () => {
    const result = deriveSlot(loadLayout(FQN), 'addresses', [i(9)]);
    expect(result.obligations).toEqual([
      {
        lengthSlot: 0n,
        index: 9n,
        typeLabel: 'address[]',
        variableName: 'addresses',
        segmentIndex: 0,
      },
    ]);
  });

  it('rejects a negative index without any I/O', () => {
    expect(() => single(FQN, 'addresses', i(-1))).toThrow(IndexOutOfBoundsError);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects the index %s with a message of its own',
    (index) => {
      // None of these converts to a bigint, so they cannot be carried by IndexOutOfBoundsError.
      expect(() => single(FQN, 'addresses', i(index))).toThrow(TypeError);
      expect(() => single(FQN, 'addresses', i(index))).toThrow(/must be a finite integer/);
    }
  );

  it.each([
    [1.5, 1n],
    [-1.5, -1n],
  ])('reports the fractional index %s truncated toward zero, with no length', (index, shown) => {
    const read = (): unknown => single(FQN, 'addresses', i(index));
    expect(read).toThrow(IndexOutOfBoundsError);
    expect(read).toThrow(expect.objectContaining({ index: shown, length: undefined }));
  });

  it.each(['', '1', undefined, null, true])(
    'rejects the index %j, which is neither a number nor a bigint',
    (index) => {
      // Reachable from plain JavaScript only. BigInt('') is 0n, so '' would read element 0.
      expect(() => single(FQN, 'addresses', i(index as never))).toThrow(TypeError);
      expect(() => single(FQN, 'addresses', i(index as never))).toThrow(
        /must be a number or bigint/
      );
    }
  );
});

describe('fixed-size arrays', () => {
  const FQN = 'ArrayStorage.sol:ArrayStorage';

  it('packs elements in place with no keccak', () => {
    // uint8[10] at slot 4: 32 per slot, so all ten share slot 4 at ascending offsets.
    expect(single(FQN, 'fixedPacked', i(0))).toEqual({ slot: 4n, offset: 0 });
    expect(single(FQN, 'fixedPacked', i(1))).toEqual({ slot: 4n, offset: 1 });
    expect(single(FQN, 'fixedPacked', i(9))).toEqual({ slot: 4n, offset: 9 });
  });

  it('uses the label-parsed length for bounds, not a byte ratio', () => {
    // numberOfBytes is 32, so a ratio would allow index 31. The real length is 10.
    expect(() => single(FQN, 'fixedPacked', i(10))).toThrow(IndexOutOfBoundsError);
    expect(() => single(FQN, 'fixedPacked', i(10))).toThrow(/length 10/);
  });

  it('checks bounds statically, emitting no obligation', () => {
    const result = deriveSlot(loadLayout(FQN), 'fixedWords', [i(2)]);
    expect(result.obligations).toEqual([]);
    expect(result.readPlan).toEqual({ kind: 'single', slot: 7n });
    expect(() => single(FQN, 'fixedWords', i(3))).toThrow(IndexOutOfBoundsError);
  });

  it('strides multi-slot elements', () => {
    // Inner is 96 bytes -> 3 slots; fixedInners lives at slot 7.
    const FQN_S = 'StructStorage.sol:StructStorage';
    expect(single(FQN_S, 'fixedInners', i(0), f('a'))).toEqual({ slot: 7n, offset: 0 });
    expect(single(FQN_S, 'fixedInners', i(1), f('d'))).toEqual({ slot: 12n, offset: 0 });
  });
});

describe('nested dynamic arrays', () => {
  it('turns the outer element slot into the inner array\'s header slot', () => {
    const FQN = 'ArrayStorage.sol:ArrayStorage';
    const outerBase = arrayBase(9n); // `nested` is declared at slot 9
    const innerHeader = outerBase + 2n; // uint256[] element is 32 bytes -> 1 per slot
    const innerBase = arrayBase(innerHeader);
    expect(single(FQN, 'nested', i(2), i(5))).toEqual({ slot: innerBase + 5n, offset: 0 });
  });

  it('orders obligations outermost first', () => {
    const result = deriveSlot(loadLayout('ArrayStorage.sol:ArrayStorage'), 'nested', [i(2), i(5)]);
    expect(result.obligations.map((o) => [o.lengthSlot, o.index])).toEqual([
      [9n, 2n],
      [arrayBase(9n) + 2n, 5n],
    ]);
  });
});

// -----------------------------------------------------------------------------------------
// Structs and compositions
// -----------------------------------------------------------------------------------------

describe('struct fields', () => {
  const FQN = 'StructStorage.sol:StructStorage';

  it('adds the member slot DELTA and takes the member offset within that slot', () => {
    // outer is at slot 1; Outer members: id +0, inner +1, tail +4. Inner members: a +0/0, b +0/16.
    expect(single(FQN, 'outer', f('id'))).toEqual({ slot: 1n, offset: 0 });
    expect(single(FQN, 'outer', f('inner'), f('a'))).toEqual({ slot: 2n, offset: 0 });
    expect(single(FQN, 'outer', f('inner'), f('b'))).toEqual({ slot: 2n, offset: 16 });
    expect(single(FQN, 'outer', f('inner'), f('c'))).toEqual({ slot: 3n, offset: 0 });
    expect(single(FQN, 'outer', f('inner'), f('d'))).toEqual({ slot: 4n, offset: 0 });
    expect(single(FQN, 'outer', f('tail'))).toEqual({ slot: 5n, offset: 0 });
  });

  it('resolves a struct in an array in a mapping', () => {
    // records: mapping(address => Inner[]) at slot 0. Inner is 96 bytes -> 3 slots each.
    const arrayHeader = mappingSlot(addressKey(ALICE), 0n);
    const elementBase = arrayBase(arrayHeader);
    expect(single(FQN, 'records', k(ALICE), i(2), f('b'))).toEqual({
      slot: elementBase + 6n,
      offset: 16,
    });
    expect(single(FQN, 'records', k(ALICE), i(2), f('d'))).toEqual({
      slot: elementBase + 8n,
      offset: 0,
    });
  });

  it('resolves a struct behind a mapping', () => {
    const structBase = mappingSlot(uintKey(42), 6n);
    expect(single(FQN, 'outers', k(42), f('inner'), f('c'))).toEqual({
      slot: structBase + 2n,
      offset: 0,
    });
  });
});

describe('mappings whose value is an array', () => {
  const FQN = 'MappingToArrayStorage.sol:MappingToArrayStorage';

  it('uses the mapping\'s derived slot as the array\'s header slot', () => {
    const header = mappingSlot(addressKey(ALICE), 0n);
    expect(single(FQN, 'listByAddress', k(ALICE), i(3))).toEqual({
      slot: arrayBase(header) + 3n,
      offset: 0,
    });
  });

  it('keeps the packing arithmetic through the composition', () => {
    const header = mappingSlot(addressKey(BOB), 1n);
    expect(single(FQN, 'packedListByAddress', k(BOB), i(3))).toEqual({
      slot: arrayBase(header) + 1n,
      offset: 12,
    });
  });

  it('bounds-checks against the derived header slot', () => {
    const result = deriveSlot(loadLayout(FQN), 'listByAddress', [k(ALICE), i(3)]);
    expect(result.obligations).toEqual([
      {
        lengthSlot: mappingSlot(addressKey(ALICE), 0n),
        index: 3n,
        typeLabel: 'uint256[]',
        variableName: 'listByAddress',
        segmentIndex: 1,
      },
    ]);
  });

  it('composes two mapping levels with an array', () => {
    const level1 = mappingSlot(addressKey(ALICE), 2n);
    const level2 = mappingSlot(uintKey(9), level1);
    expect(single(FQN, 'nestedListByAddress', k(ALICE), k(9), i(1))).toEqual({
      slot: arrayBase(level2) + 1n,
      offset: 0,
    });
  });
});

// -----------------------------------------------------------------------------------------
// string / bytes plans
// -----------------------------------------------------------------------------------------

describe('string and bytes read plans', () => {
  const FQN = 'StringStorage.sol:StringStorage';

  it('always emits a multi plan, because short vs long is a property of the VALUE', () => {
    const result = deriveSlot(loadLayout(FQN), 'shortText', []);
    expect(result.readPlan).toEqual({
      kind: 'multi',
      headerSlot: 0n,
      dataBaseSlot: arrayBase(0n),
    });
    expect(result.valueKind).toEqual({ family: 'string' });
  });

  it('composes with a mapping', () => {
    const header = mappingSlot(addressKey(ALICE), 4n);
    const result = deriveSlot(loadLayout(FQN), 'textByAddress', [k(ALICE)]);
    expect(result.readPlan).toEqual({
      kind: 'multi',
      headerSlot: header,
      dataBaseSlot: arrayBase(header),
    });
  });

  it('composes with an array, including the bounds obligation', () => {
    const header = arrayBase(5n) + 2n;
    const result = deriveSlot(loadLayout(FQN), 'texts', [i(2)]);
    expect(result.readPlan).toEqual({
      kind: 'multi',
      headerSlot: header,
      dataBaseSlot: arrayBase(header),
    });
    expect(result.obligations).toEqual([
      { lengthSlot: 5n, index: 2n, typeLabel: 'string[]', variableName: 'texts', segmentIndex: 0 },
    ]);
  });

  it('distinguishes bytes from string', () => {
    expect(deriveSlot(loadLayout(FQN), 'longBlob', []).valueKind).toEqual({ family: 'bytes' });
  });
});

// -----------------------------------------------------------------------------------------
// Failure modes
// -----------------------------------------------------------------------------------------

describe('path segment count mismatches', () => {
  it('rejects a path that stops on a mapping', () => {
    expect(() => deriveSlot(loadLayout('NestedMapping.sol:NestedMapping'), 'triple', [])).toThrow(
      PathSegmentCountMismatchError
    );
    expect(() =>
      deriveSlot(loadLayout('NestedMapping.sol:NestedMapping'), 'triple', [k(ALICE)])
    ).toThrow(/still needs a mapping key/);
  });

  it('rejects a path that stops on an array', () => {
    expect(() => deriveSlot(loadLayout('ArrayStorage.sol:ArrayStorage'), 'words', [])).toThrow(
      /still needs an array index/
    );
  });

  it('rejects a path that stops on a struct', () => {
    expect(() => deriveSlot(loadLayout('StructStorage.sol:StructStorage'), 'outer', [])).toThrow(
      /still needs a struct field/
    );
  });

  it('reports the minimum number of segments the type requires', () => {
    try {
      deriveSlot(loadLayout('NestedMapping.sol:NestedMapping'), 'triple', []);
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PathSegmentCountMismatchError);
      expect((error as PathSegmentCountMismatchError).expected).toBe(3);
      expect((error as PathSegmentCountMismatchError).given).toBe(0);
    }
  });

  it('rejects extra segments past a terminal type', () => {
    expect(() =>
      deriveSlot(loadLayout('SimpleStorage.sol:SimpleStorage'), 'count', [i(0)])
    ).toThrow(PathSegmentCountMismatchError);
    expect(() =>
      deriveSlot(loadLayout('StringStorage.sol:StringStorage'), 'longText', [i(0)])
    ).toThrow(/terminal type/);
  });
});

describe('path segment KIND mismatches', () => {
  it('rejects .index() against a mapping', () => {
    expect(() =>
      deriveSlot(loadLayout('InheritedStorage.sol:InheritedStorage'), 'childMap', [i(0)])
    ).toThrow(PathSegmentKindMismatchError);
    expect(() =>
      deriveSlot(loadLayout('InheritedStorage.sol:InheritedStorage'), 'childMap', [i(0)])
    ).toThrow(/is a mapping and needs a key/);
  });

  it('rejects .key() against an array', () => {
    expect(() =>
      deriveSlot(loadLayout('ArrayStorage.sol:ArrayStorage'), 'words', [k(1)])
    ).toThrow(/is an array and needs an index/);
  });

  it('rejects .field() against a mapping or an array', () => {
    expect(() =>
      deriveSlot(loadLayout('InheritedStorage.sol:InheritedStorage'), 'childMap', [f('x')])
    ).toThrow(PathSegmentKindMismatchError);
    expect(() =>
      deriveSlot(loadLayout('ArrayStorage.sol:ArrayStorage'), 'words', [f('x')])
    ).toThrow(PathSegmentKindMismatchError);
  });

  it('rejects .index() or .key() against a struct', () => {
    expect(() =>
      deriveSlot(loadLayout('StructStorage.sol:StructStorage'), 'outer', [i(0)])
    ).toThrow(/is a struct and needs a field name/);
    expect(() =>
      deriveSlot(loadLayout('StructStorage.sol:StructStorage'), 'outer', [k(1)])
    ).toThrow(PathSegmentKindMismatchError);
  });

  it('names the available fields when the field does not exist', () => {
    expect(() =>
      deriveSlot(loadLayout('StructStorage.sol:StructStorage'), 'outer', [f('nope')])
    ).toThrow(/has no field "nope" \(available: id, inner, tail\)/);
  });

  it('reports the position of the offending segment', () => {
    try {
      deriveSlot(loadLayout('StructStorage.sol:StructStorage'), 'records', [k(ALICE), f('a')]);
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PathSegmentKindMismatchError);
      expect((error as PathSegmentKindMismatchError).segmentIndex).toBe(1);
    }
  });
});

describe('purity', () => {
  it('never performs I/O — the whole matrix runs synchronously', () => {
    const layout = loadLayout('StructStorage.sol:StructStorage');
    const result = deriveSlot(layout, 'records', [k(ALICE), i(1), f('c')]);
    // If the walk read a slot to bounds-check, this could not be a plain synchronous value.
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.obligations).toHaveLength(1);
  });
});
