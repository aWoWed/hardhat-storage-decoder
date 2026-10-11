/**
 * Round structure and error precedence of the read pipeline.
 *
 * The deferred chain holds every RPC call open, so each test can assert exactly which calls
 * are issued together before any of them has answered.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ContractMismatchError,
  IndexOutOfBoundsError,
  PathSegmentCountMismatchError,
  PathSegmentKindMismatchError,
  VariableNotFoundError,
} from '../../src/core/query/errors.js';
import { StorageQueryBuilder } from '../../src/core/query/StorageQueryBuilder.js';
import { DeferredChain, slotLabel } from './deferred.js';
import { addressKey, arrayBase, longBytesHeader, mappingSlot, word } from './helpers.js';

const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
const TARGET = '0x3333333333333333333333333333333333333333';
const OTHER_TARGET = '0x4444444444444444444444444444444444444444';

function setup() {
  const chain = new DeferredChain();
  const builder = new StorageQueryBuilder(chain.context());
  return {
    chain,
    builder,
    simple: builder.contract('SimpleStorage.sol:SimpleStorage').target(TARGET),
    arrays: builder.contract('ArrayStorage.sol:ArrayStorage').target(TARGET),
    strings: builder.contract('StringStorage.sol:StringStorage').target(TARGET),
    inherited: builder.contract('InheritedStorage.sol:InheritedStorage').target(TARGET),
  };
}

/** Attach the assertion first, so a rejection is never momentarily unhandled. */
async function settle<T>(chain: DeferredChain, pending: Promise<T>) {
  const outcome = pending.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error })
  );
  const rounds = await chain.drain();
  return { rounds, ...(await outcome) };
}

// nested (uint256[][]) lives at slot 9.
const NESTED_OUTER = arrayBase(9n);
const nestedInnerHeader = (outer: bigint) => NESTED_OUTER + outer;
const nestedValue = (outer: bigint, inner: bigint) => arrayBase(nestedInnerHeader(outer)) + inner;

describe('one round per read', () => {
  it('issues the contract check and a plain value together', async () => {
    const { chain, simple } = setup();
    chain.storage.set(0n, word(7));

    const { rounds, value } = await settle(chain, simple.name('count').read());

    expect(rounds).toEqual([['code', slotLabel(0n)]]);
    expect(value?.value).toBe(7n);
  });

  it('issues both array lengths and the value together for nested[1][2]', async () => {
    const { chain, arrays } = setup();
    chain.storage
      .set(9n, word(2))
      .set(nestedInnerHeader(1n), word(3))
      .set(nestedValue(1n, 2n), word(42));

    const { rounds, value } = await settle(chain, arrays.name('nested').index(1).index(2).read());

    expect(rounds).toEqual([
      ['code', slotLabel(9n), slotLabel(nestedInnerHeader(1n)), slotLabel(nestedValue(1n, 2n))].sort(),
    ]);
    expect(value?.value).toBe(42n);
  });

  it('reads a long string behind an index in two rounds: header, then data', async () => {
    const { chain, strings } = setup();
    const text = 'z'.repeat(80);
    const header = arrayBase(5n);
    chain.storage.set(5n, word(1)).setString(header, text);

    const { rounds, value } = await settle(chain, strings.name('texts').index(0).read());

    expect(rounds[0]).toEqual(['code', slotLabel(5n), slotLabel(header)].sort());
    expect(rounds[1]).toEqual(
      [0n, 1n, 2n].map((i) => slotLabel(arrayBase(header) + i)).sort()
    );
    expect(rounds).toHaveLength(2);
    expect(value?.value).toBe(text);
  });
});

describe('a speculative read never decides the outcome', () => {
  it('fetches no string data behind an out-of-bounds index, whatever the header says', async () => {
    const { chain, strings } = setup();
    // texts.length = 1, and the slot where texts[3] would be claims a 1000-byte string.
    chain.storage.set(5n, word(1)).set(arrayBase(5n) + 3n, longBytesHeader(1000));

    const { rounds, error } = await settle(chain, strings.name('texts').index(3).read());

    expect(error).toBeInstanceOf(IndexOutOfBoundsError);
    expect(rounds).toEqual([['code', slotLabel(5n), slotLabel(arrayBase(5n) + 3n)].sort()]);
  });

  it('fetches no string data from an address that fails the contract check', async () => {
    const { chain, strings } = setup();
    chain.onChain = '0x6081';
    chain.storage.set(1n, longBytesHeader(1000)); // longText header, at the wrong contract

    const { rounds, error } = await settle(chain, strings.name('longText').read());

    expect(error).toBeInstanceOf(ContractMismatchError);
    expect(rounds).toEqual([['code', slotLabel(1n)]]);
  });

  it('reports out-of-bounds even when the speculative value read itself fails', async () => {
    const { chain, arrays } = setup();
    chain.storage.set(0n, word(2));
    chain.failingSlots.set(arrayBase(0n) + 5n, new Error('value read exploded'));

    const { error } = await settle(chain, arrays.name('addresses').index(5).read());

    expect(error).toBeInstanceOf(IndexOutOfBoundsError);
  });
});

describe('error precedence', () => {
  it('reports a contract mismatch before an out-of-bounds index', async () => {
    const { chain, arrays } = setup();
    chain.onChain = '0x6081';
    chain.storage.set(0n, word(2));

    const { error } = await settle(chain, arrays.name('addresses').index(5).read());

    expect(error).toBeInstanceOf(ContractMismatchError);
  });

  it('reports a contract mismatch before a path error', async () => {
    const { chain, simple } = setup();
    chain.onChain = '0x6081';

    const { error } = await settle(chain, simple.name('count').index(0).read());

    expect(error).toBeInstanceOf(ContractMismatchError);
  });

  it('reports a path error once the contract check has passed', async () => {
    const { chain, simple } = setup();

    const { error, rounds } = await settle(chain, simple.name('count').index(0).read());

    expect(error).toBeInstanceOf(PathSegmentCountMismatchError);
    expect(rounds).toEqual([['code']]);
  });

  it('reports the OUTER index when both are out of bounds', async () => {
    const { chain, arrays } = setup();
    chain.storage.set(9n, word(2)).set(nestedInnerHeader(5n), word(0));

    const { error } = await settle(chain, arrays.name('nested').index(5).index(9).read());

    expect(error).toBeInstanceOf(IndexOutOfBoundsError);
    expect((error as Error).message).toMatch(/Index 5 is out of bounds/);
  });

  it('does not let a failed inner length read replace an outer out-of-bounds', async () => {
    const { chain, arrays } = setup();
    chain.storage.set(9n, word(2));
    chain.failingSlots.set(nestedInnerHeader(5n), new Error('inner length exploded'));

    const { error } = await settle(chain, arrays.name('nested').index(5).index(9).read());

    expect((error as Error).message).toMatch(/Index 5 is out of bounds/);
  });

  it('prefers a failure to load the artifact over a failure of eth_getCode', async () => {
    const { chain, simple } = setup();
    chain.bytecodeError = new Error('artifact unreadable');
    chain.codeError = new Error('rpc down');

    const { error } = await settle(chain, simple.name('count').read());

    expect((error as Error).message).toBe('artifact unreadable');
  });

  it('turns a synchronous throw from the context into a rejection', async () => {
    const chain = new DeferredChain();
    const context = chain.context();
    context.getCode = () => {
      throw new TypeError('block number must be a non-negative integer, got -1');
    };
    const builder = new StorageQueryBuilder(context);

    const { error } = await settle(
      chain,
      builder.contract('SimpleStorage.sol:SimpleStorage').target(TARGET).name('count').at(-1).read()
    );

    expect(error).toBeInstanceOf(TypeError);
  });

  it('leaves no rejection unhandled when several early reads fail at once', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { chain, arrays } = setup();
      chain.onChain = '0x6081';
      chain.failingSlots
        .set(9n, new Error('outer length exploded'))
        .set(nestedInnerHeader(1n), new Error('inner length exploded'))
        .set(nestedValue(1n, 2n), new Error('value exploded'));

      const { error } = await settle(chain, arrays.name('nested').index(1).index(2).read());
      expect(error).toBeInstanceOf(ContractMismatchError);

      // Give Node a full turn of the event loop to report anything left dangling.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('readMany', () => {
  it('returns results in input order across variables', async () => {
    const { chain, builder, simple, inherited } = setup();
    chain.storage
      .set(0n, word(7))
      .set(mappingSlot(addressKey(ALICE), 4n), word(111))
      .set(mappingSlot(addressKey(BOB), 4n), word(222));

    const { value } = await settle(
      chain,
      builder.readMany([
        inherited.name('childMap').key(BOB),
        simple.name('count'),
        inherited.name('childMap').key(ALICE),
      ])
    );

    expect(value?.map((result) => result.value)).toEqual([222n, 7n, 111n]);
  });

  it('reads 100 keys with 100 slot reads and one contract check, all together', async () => {
    const { chain, builder, inherited } = setup();
    const keys = Array.from({ length: 100 }, (_unused, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);

    const { rounds, value } = await settle(
      chain,
      builder.readMany(keys.map((key) => inherited.name('childMap').key(key)))
    );

    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.filter((label) => label === 'code')).toHaveLength(1);
    expect(rounds[0]?.filter((label) => label.startsWith('slot:'))).toHaveLength(100);
    expect(value).toHaveLength(100);
  });

  it('checks each address separately', async () => {
    const { chain, builder } = setup();
    const count = builder.contract('SimpleStorage.sol:SimpleStorage').name('count');

    const { rounds } = await settle(
      chain,
      builder.readMany([count.target(TARGET), count.target(OTHER_TARGET), count.target(TARGET)])
    );

    expect(rounds[0]?.filter((label) => label === 'code')).toHaveLength(2);
  });

  it('rejects with the error of the first failing query in the list', async () => {
    const { chain, builder, simple, arrays } = setup();
    chain.storage.set(0n, word(2));
    const outOfBounds = arrays.name('addresses').index(5);
    const unknown = simple.name('nope');
    const fine = simple.name('count');

    const first = await settle(chain, builder.readMany([fine, outOfBounds, unknown]));
    expect(first.error).toBeInstanceOf(IndexOutOfBoundsError);

    const second = await settle(chain, builder.readMany([fine, unknown, outOfBounds]));
    expect(second.error).toBeInstanceOf(VariableNotFoundError);
  });

  it('applies the first-failure rule to an incomplete chain too', async () => {
    const { chain, builder, simple } = setup();

    const { error } = await settle(chain, builder.readMany([simple, simple.name('nope')]));

    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toMatch(/needs \.name/);
  });

  it('resolves to an empty list for no queries', async () => {
    const { builder } = setup();
    await expect(builder.readMany([])).resolves.toEqual([]);
  });

  it('rejects something that is not a builder', async () => {
    const { builder } = setup();
    await expect(builder.readMany([{} as StorageQueryBuilder])).rejects.toThrow(/same decoder/);
    await expect(builder.readMany([null as unknown as StorageQueryBuilder])).rejects.toThrow(
      /same decoder/
    );
  });

  it('rejects a builder made by another copy of this package', async () => {
    const { chain, builder } = setup();
    vi.resetModules();
    const twin = await import('../../src/core/query/StorageQueryBuilder.js');
    expect(twin.StorageQueryBuilder).not.toBe(StorageQueryBuilder);
    const foreign = new twin.StorageQueryBuilder(chain.context())
      .contract('SimpleStorage.sol:SimpleStorage')
      .target(TARGET)
      .name('count');

    await expect(
      builder.readMany([foreign as unknown as StorageQueryBuilder])
    ).rejects.toThrow(/CommonJS\/ESM twin/);
  });
});

describe('readKeys and readIndices', () => {
  it('reads many keys of one mapping in order', async () => {
    const { chain, inherited } = setup();
    chain.storage
      .set(mappingSlot(addressKey(ALICE), 4n), word(111))
      .set(mappingSlot(addressKey(BOB), 4n), word(222));

    const { value } = await settle(chain, inherited.name('childMap').readKeys([BOB, ALICE]));

    expect(value?.map((result) => result.value)).toEqual([222n, 111n]);
  });

  it('reads the array length once for 100 indices, in the same round as the values', async () => {
    const { chain, arrays } = setup();
    chain.storage.set(3n, word(100)); // words.length
    const indices = Array.from({ length: 100 }, (_unused, i) => i);
    for (const i of indices) chain.storage.set(arrayBase(3n) + BigInt(i), word(i * 2));

    const { rounds, value } = await settle(chain, arrays.name('words').readIndices(indices));

    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.filter((label) => label === slotLabel(3n))).toHaveLength(1);
    expect(rounds[0]).toHaveLength(1 + 1 + 100); // contract check, length, values
    expect(value?.map((result) => result.value)).toEqual(indices.map((i) => BigInt(i * 2)));
  });

  it('rejects, and does not throw synchronously, for a list that is not an array', async () => {
    const { inherited, arrays } = setup();
    const notAList = 5 as unknown as string[];
    await expect(inherited.name('childMap').readKeys(notAList)).rejects.toThrow(TypeError);
    await expect(arrays.name('words').readIndices(notAList as unknown as number[])).rejects.toThrow(
      TypeError
    );
  });

  it('rejects the wrong kind of position', async () => {
    const { chain, arrays, inherited } = setup();

    const keysOnArray = await settle(chain, arrays.name('words').readKeys([ALICE]));
    expect(keysOnArray.error).toBeInstanceOf(PathSegmentKindMismatchError);

    const indicesOnMapping = await settle(chain, inherited.name('childMap').readIndices([0]));
    expect(indicesOnMapping.error).toBeInstanceOf(PathSegmentKindMismatchError);
  });
});
