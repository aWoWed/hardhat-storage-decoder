import { describe, expect, it } from 'vitest';
import { getVariable } from '../../src/core/layout/parseStorageLayout.js';
import {
  ContractMismatchError,
  ContractNotFoundError,
  DumpInconsistentError,
  DumpTooLargeError,
  IndexOutOfBoundsError,
  PathSegmentCountMismatchError,
} from '../../src/core/query/errors.js';
import {
  StorageQueryBuilder,
  type StorageDecoderContext,
} from '../../src/core/query/StorageQueryBuilder.js';
import type { BlockTag } from '../../src/core/rpc/getStorageAt.js';
import { hexToBytes } from '../../src/core/util/bytes.js';
import {
  MockStorage,
  addressKey,
  arrayBase,
  bytesNKey,
  loadLayout,
  longBytesHeader,
  mappingSlot,
  packWord,
  uintKey,
  word,
} from './helpers.js';

const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
const TARGET = '0x3333333333333333333333333333333333333333';

const ARRAYS = 'ArrayStorage.sol:ArrayStorage';
const STRUCTS = 'StructStorage.sol:StructStorage';
const STRINGS = 'StringStorage.sol:StringStorage';
const MAPPINGS = 'NestedMapping.sol:NestedMapping';
const RECURSIVE = 'ZRecursiveStorage.sol:ZRecursiveStorage';
const MAPPING_TO_ARRAY = 'MappingToArrayStorage.sol:MappingToArrayStorage';

interface Options {
  /** Supply `getBlockNumber`, returning this. */
  readonly blockNumber?: bigint;
  /** Supply both sides of the contract check, with this on-chain code. */
  readonly onChain?: string;
  /** Intercept a storage read; return `undefined` to fall through to the slot map. May throw. */
  readonly intercept?: (slot: bigint, nth: number) => Uint8Array | undefined;
  /** Make every storage read take a real timer tick, so reads queue behind one another. */
  readonly slow?: boolean;
}

function harness(options: Options = {}) {
  const storage = new MockStorage();
  const calls = { layout: 0, blockNumber: 0, code: [] as BlockTag[] };
  const readsOf = new Map<bigint, number>();
  const context: StorageDecoderContext = {
    async getLayout(fqn) {
      calls.layout += 1;
      try {
        return loadLayout(fqn);
      } catch {
        throw new ContractNotFoundError(fqn);
      }
    },
    getStorageAt: async (request) => {
      const nth = (readsOf.get(request.slot) ?? 0) + 1;
      readsOf.set(request.slot, nth);
      const word = await storage.getStorageAt(request);
      if (options.slow === true) await new Promise((resolve) => setTimeout(resolve, 1));
      return options.intercept?.(request.slot, nth) ?? word;
    },
  };
  if (options.blockNumber !== undefined) {
    const { blockNumber } = options;
    context.getBlockNumber = async () => {
      calls.blockNumber += 1;
      return blockNumber;
    };
  }
  if (options.onChain !== undefined) {
    const { onChain } = options;
    context.getDeployedBytecode = async () => '0x6080';
    context.getCode = async (_address, blockTag) => {
      calls.code.push(blockTag);
      return onChain;
    };
  }
  const builder = new StorageQueryBuilder(context);
  const at = (fqn: string) => builder.contract(fqn).target(TARGET);
  return { storage, calls, readsOf, at };
}

const slotOf = (fqn: string, name: string) => getVariable(loadLayout(fqn), name).slot;

function pairWords(left: bigint, right: bigint, who: string): Uint8Array[] {
  return [
    packWord({ offset: 0, size: 16, value: left }, { offset: 16, size: 16, value: right }),
    packWord({ offset: 0, size: 20, value: hexToBytes(who) }),
  ];
}

function innerWords(a: bigint, b: bigint, c: string, d: bigint): Uint8Array[] {
  return [
    packWord({ offset: 0, size: 16, value: a }, { offset: 16, size: 16, value: b }),
    packWord({ offset: 0, size: 20, value: hexToBytes(c) }),
    word(d),
  ];
}

describe('readAll: arrays and structs', () => {
  it('returns a plain value when called on one', async () => {
    const { storage, at } = harness();
    storage.set(0n, word(5));
    const result = await at('SimpleStorage.sol:SimpleStorage').name('count').readAll();
    expect(result.value).toBe(5n);
    expect(result.skipped).toEqual([]);
    expect(result.typeLabel).toBe('uint256');
  });

  it('dumps an array of structs', async () => {
    const { storage, at } = harness();
    storage.set(8n, word(2));
    storage.setMany(arrayBase(8n), [...pairWords(1n, 2n, ALICE), ...pairWords(3n, 4n, BOB)]);

    const result = await at(ARRAYS).name('pairs').readAll();

    expect(result.value).toEqual([
      { left: 1n, right: 2n, who: ALICE },
      { left: 3n, right: 4n, who: BOB },
    ]);
    expect(result.typeLabel).toBe('struct ArrayStorage.Pair[]');
  });

  it('builds structs without a prototype', async () => {
    const { storage, at } = harness();
    storage.set(8n, word(1));
    const result = await at(ARRAYS).name('pairs').readAll();
    const [first] = result.value as object[];
    expect(Object.getPrototypeOf(first)).toBeNull();
  });

  it('dumps an array of arrays', async () => {
    const { storage, at } = harness();
    const outer = arrayBase(9n);
    storage.set(9n, word(2)).set(outer, word(2)).set(outer + 1n, word(1));
    storage.setMany(arrayBase(outer), [word(10), word(11)]);
    storage.set(arrayBase(outer + 1n), word(20));

    const result = await at(ARRAYS).name('nested').readAll();

    expect(result.value).toEqual([[10n, 11n], [20n]]);
  });

  it('dumps a fixed array of structs', async () => {
    const { storage, at } = harness();
    storage.setMany(7n, [...innerWords(1n, 2n, ALICE, 3n), ...innerWords(4n, 5n, BOB, 6n)]);

    const result = await at(STRUCTS).name('fixedInners').readAll();

    expect(result.value).toEqual([
      { a: 1n, b: 2n, c: ALICE, d: 3n },
      { a: 4n, b: 5n, c: BOB, d: 6n },
    ]);
  });

  it('dumps a struct nested in a struct', async () => {
    const { storage, at } = harness();
    storage.set(1n, word(9)).setMany(2n, innerWords(1n, 2n, ALICE, 3n)).set(5n, word(77));

    const result = await at(STRUCTS).name('outer').readAll();

    expect(result.value).toEqual({ id: 9n, inner: { a: 1n, b: 2n, c: ALICE, d: 3n }, tail: 77n });
  });

  it('dumps from a position reached through a mapping key', async () => {
    const { storage, at } = harness();
    const base = mappingSlot(uintKey(1), 6n);
    storage.set(base, word(9)).setMany(base + 1n, innerWords(1n, 2n, ALICE, 3n)).set(base + 4n, word(8));

    const result = await at(STRUCTS).name('outers').key(1).readAll();

    expect(result.value).toEqual({ id: 9n, inner: { a: 1n, b: 2n, c: ALICE, d: 3n }, tail: 8n });
  });

  it('decodes short and long strings inside an array', async () => {
    const { storage, at } = harness();
    const long = 'x'.repeat(70);
    storage.set(5n, word(2)).setString(arrayBase(5n), 'hi').setString(arrayBase(5n) + 1n, long);

    const result = await at(STRINGS).name('texts').readAll();

    expect(result.value).toEqual(['hi', long]);
  });

  it('reads a packed fixed array with a single storage read', async () => {
    const { storage, readsOf, at } = harness();
    storage.set(
      4n,
      packWord({ offset: 0, size: 1, value: 1n }, { offset: 9, size: 1, value: 10n })
    );

    const result = await at(ARRAYS).name('fixedPacked').at(5).readAll();

    expect(result.value).toEqual([1n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 10n]);
    expect([...readsOf.entries()]).toEqual([[4n, 1]]);
  });

  it('rejects an index on the chain that is out of bounds', async () => {
    const { storage, at } = harness();
    storage.set(9n, word(1));
    await expect(at(ARRAYS).name('nested').index(4).readAll()).rejects.toThrow(
      IndexOutOfBoundsError
    );
  });

  it('rejects a chain that continues past a terminal type, as read() does', async () => {
    const { at } = harness();
    await expect(
      at('SimpleStorage.sol:SimpleStorage').name('count').index(0).readAll()
    ).rejects.toThrow(PathSegmentCountMismatchError);
  });
});

describe('readAll: mappings', () => {
  it('returns an empty Map and lists the mapping when no keys are supplied', async () => {
    const { at } = harness();
    const result = await at(STRUCTS).name('records').readAll();
    expect(result.value).toEqual(new Map());
    expect(result.skipped).toEqual(['']);
  });

  it('reads exactly the supplied keys of a root mapping', async () => {
    const { storage, at } = harness();
    const list = mappingSlot(addressKey(ALICE), 0n);
    storage.set(list, word(1)).setMany(arrayBase(list), innerWords(1n, 2n, BOB, 3n));

    const result = await at(STRUCTS).name('records').readAll({ keys: { '': [ALICE, BOB] } });

    expect(result.value).toEqual(
      new Map([
        [ALICE, [{ a: 1n, b: 2n, c: BOB, d: 3n }]],
        [BOB, []],
      ])
    );
    expect(result.skipped).toEqual([]);
  });

  it('reads nested mapping keys as a cross-product', async () => {
    const { storage, at } = harness();
    const grid = slotOf(RECURSIVE, 'grid');
    const aliceRow = mappingSlot(addressKey(ALICE), grid);
    const bobRow = mappingSlot(addressKey(BOB), grid);
    storage
      .set(mappingSlot(uintKey(1), aliceRow), word(11))
      .set(mappingSlot(uintKey(2), aliceRow), word(12))
      .set(mappingSlot(uintKey(1), bobRow), word(21));

    const result = await at(RECURSIVE).name('grid').readAll({ keys: { '': [ALICE, BOB], '{}': [1, 2] } });

    expect(result.value).toEqual(
      new Map([
        [ALICE, new Map([[1, 11n], [2, 12n]])],
        [BOB, new Map([[1, 21n], [2, 0n]])],
      ])
    );
  });

  it('lists a nested level whose keys were not supplied', async () => {
    const { at } = harness();
    const result = await at(RECURSIVE).name('grid').readAll({ keys: { '': [ALICE] } });
    expect(result.value).toEqual(new Map([[ALICE, new Map()]]));
    expect(result.skipped).toEqual(['{}']);
  });

  it('keeps Map keys exactly as supplied', async () => {
    const { storage, at } = harness();
    const slot = slotOf(MAPPINGS, 'bySelector');
    storage.set(mappingSlot(bytesNKey('0x0badf00d'), slot), word(5));
    const asBytes = hexToBytes('0x0badf00d');

    const result = await at(MAPPINGS).name('bySelector').readAll({ keys: { '': [asBytes, '0x0badf00d'] } });
    const entries = result.value as Map<unknown, unknown>;

    // One storage slot, two distinct Map keys: the caller's own values, looked up as supplied.
    expect(entries.size).toBe(2);
    expect(entries.get(asBytes)).toBe(5n);
    expect(entries.get('0x0badf00d')).toBe(5n);
    expect(entries.get(hexToBytes('0x0badf00d'))).toBeUndefined();
  });

  it('collapses a repeated key into one entry', async () => {
    const { at } = harness();
    const result = await at(MAPPINGS).name('bySmallUint').readAll({ keys: { '': [1, 1, 2] } });
    expect([...(result.value as Map<unknown, unknown>).keys()]).toEqual([1, 2]);
  });

  it('dumps a struct holding a mapping, skipped and then with keys', async () => {
    const { storage, at } = harness();
    const children = arrayBase(1n);
    storage.set(0n, word(1)).set(1n, word(2)); // root.id, root.children.length
    storage.set(children, word(10)).set(children + 3n, word(20)); // children[0].id, children[1].id
    const byId7 = mappingSlot(uintKey(7), 2n);
    storage.set(byId7, word(70));

    const bare = await at(RECURSIVE).name('root').readAll();
    expect(bare.value).toEqual({
      id: 1n,
      children: [
        { id: 10n, children: [], byId: new Map() },
        { id: 20n, children: [], byId: new Map() },
      ],
      byId: new Map(),
    });
    expect([...bare.skipped].sort()).toEqual(['byId', 'children[].byId']);

    const keyed = await at(RECURSIVE).name('root').readAll({ keys: { byId: [7] } });
    expect((keyed.value as { byId: Map<number, unknown> }).byId).toEqual(
      new Map([[7, { id: 70n, children: [], byId: new Map() }]])
    );
    expect([...keyed.skipped].sort()).toEqual(['byId{}.byId', 'children[].byId']);
  });
});

describe('readAll: argument and pattern errors', () => {
  it('rejects malformed arguments before any I/O', async () => {
    const { calls, readsOf, at } = harness();
    const root = at(RECURSIVE).name('root');

    await expect(root.readAll({ maxElements: -1 })).rejects.toThrow(/maxElements/);
    await expect(root.readAll({ maxElements: 1.5 })).rejects.toThrow(/maxElements/);
    await expect(
      root.readAll({ keys: { byId: 7 as unknown as number[] } })
    ).rejects.toThrow(/must be an array/);
    await expect(root.readAll({ keys: { '.byId': [7] } })).rejects.toThrow(/not a valid key pattern/);
    await expect(root.readAll({ keys: { 'children[': [7] } })).rejects.toThrow(
      /not a valid key pattern/
    );

    expect(calls.layout).toBe(0);
    expect(readsOf.size).toBe(0);
  });

  it('requires a complete chain, like read()', async () => {
    const { at } = harness();
    await expect(at(RECURSIVE).readAll()).rejects.toThrow(/needs \.name\("variable"\) before \.readAll\(\)/);
  });

  it('rejects a pattern that does not lead to a mapping, with no storage read', async () => {
    const { readsOf, at } = harness();
    const root = at(RECURSIVE).name('root');

    await expect(root.readAll({ keys: { nope: [1] } })).rejects.toThrow(/does not match/);
    await expect(root.readAll({ keys: { id: [1] } })).rejects.toThrow(/not a mapping/);
    await expect(root.readAll({ keys: { 'children{}': [1] } })).rejects.toThrow(/does not match/);
    // A recursive type must not send validation into a loop.
    await expect(
      root.readAll({ keys: { 'children[].children[].children[].nope': [1] } })
    ).rejects.toThrow(/does not match/);

    expect(readsOf.size).toBe(0);
  });

  it('rejects keys for a nested level whose parent has none', async () => {
    const { readsOf, at } = harness();
    await expect(at(RECURSIVE).name('grid').readAll({ keys: { '{}': [1] } })).rejects.toThrow(
      /none for its parent mapping/
    );
    await expect(
      at(RECURSIVE).name('root').readAll({ keys: { 'byId{}.byId': [1] } })
    ).rejects.toThrow(/none for its parent mapping/);
    expect(readsOf.size).toBe(0);
  });

  it('reports a contract mismatch before a pattern, size or bounds error', async () => {
    const { storage, at } = harness({ onChain: '0x6081' });
    storage.set(8n, word(50));
    await expect(at(RECURSIVE).name('root').readAll({ keys: { nope: [1] } })).rejects.toThrow(
      ContractMismatchError
    );
    await expect(at(ARRAYS).name('pairs').readAll({ maxElements: 1 })).rejects.toThrow(
      ContractMismatchError
    );
  });
});

describe('readAll: size limits', () => {
  it('refuses an array longer than the limit', async () => {
    const { storage, readsOf, at } = harness();
    storage.set(8n, word(5));

    const error = await at(ARRAYS).name('pairs').readAll({ maxElements: 3 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DumpTooLargeError);
    expect(error).toMatchObject({ kind: 'array', count: 5n, limit: 3, path: 'pairs' });
    // Only the length was read; no element was fetched.
    expect([...readsOf.keys()]).toEqual([8n]);
  });

  it('refuses a fixed array longer than the limit without reading it', async () => {
    const { readsOf, at } = harness();
    await expect(at(ARRAYS).name('fixedPacked').readAll({ maxElements: 9 })).rejects.toMatchObject({
      kind: 'array',
      count: 10n,
    });
    expect(readsOf.size).toBe(0);
  });

  it('refuses a key list longer than the limit', async () => {
    const { readsOf, at } = harness();
    await expect(
      at(MAPPINGS).name('bySmallUint').readAll({ keys: { '': [1, 2, 3] }, maxElements: 2 })
    ).rejects.toMatchObject({ kind: 'keys', count: 3n, limit: 2 });
    expect(readsOf.size).toBe(0);
  });

  it('refuses a dump whose total exceeds the limit', async () => {
    const { storage, at } = harness();
    storage.set(8n, word(2)); // 2 pairs, each with 3 fields: 2 + 6 elements

    const error = await at(ARRAYS).name('pairs').readAll({ maxElements: 4 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DumpTooLargeError);
    expect(error).toMatchObject({ kind: 'total', limit: 4 });
  });

  it('dumps a 32-byte string, the shortest value stored in long form', async () => {
    const { storage, at } = harness();
    const text = 'y'.repeat(32);
    storage.setString(1n, text);

    const result = await at(STRINGS).name('longText').at(5).readAll();

    expect(result.value).toBe(text);
  });

  it.each([0, 10_000])(
    'reports a malformed long string header as such, not as a size problem (maxElements %i)',
    async (maxElements) => {
      const { storage, at } = harness();
      // Long form declaring 5 bytes: solc stores a value that short inline, never like this.
      storage.set(1n, word(2 * 5 + 1));

      const error = await at(STRINGS)
        .name('longText')
        .at(5)
        .readAll({ maxElements })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RangeError);
      expect((error as Error).message).toMatch(/not a valid long string\/bytes header/);
    }
  );
});

describe('readAll: limits at the boundary', () => {
  it('accepts a dump of exactly maxElements and refuses one more', async () => {
    const { storage, at } = harness();
    storage.set(3n, word(4)); // words.length

    await expect(at(ARRAYS).name('words').at(5).readAll({ maxElements: 4 })).resolves.toMatchObject({
      value: [0n, 0n, 0n, 0n],
    });
    await expect(at(ARRAYS).name('words').at(5).readAll({ maxElements: 3 })).rejects.toMatchObject({
      kind: 'array',
      count: 4n,
      limit: 3,
    });
  });

  it('allows only a childless value when maxElements is 0', async () => {
    const { storage, at } = harness();
    storage.set(0n, word(5));

    await expect(
      at('SimpleStorage.sol:SimpleStorage').name('count').at(5).readAll({ maxElements: 0 })
    ).resolves.toMatchObject({ value: 5n });
    await expect(at(ARRAYS).name('words').at(5).readAll({ maxElements: 0 })).resolves.toMatchObject({
      value: [],
    });
    await expect(at(STRUCTS).name('outer').at(5).readAll({ maxElements: 0 })).rejects.toMatchObject({
      kind: 'total',
    });
  });

  it('never has more than 256 storage reads in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const storage = new MockStorage().set(3n, word(2000)); // words.length
    const context: StorageDecoderContext = {
      getLayout: async (fqn) => loadLayout(fqn),
      getStorageAt: async (request) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return storage.getStorageAt(request);
      },
    };

    const result = await new StorageQueryBuilder(context)
      .contract(ARRAYS)
      .target(TARGET)
      .name('words')
      .at(5)
      .readAll();

    expect(result.value).toHaveLength(2000);
    expect(peak).toBe(256);
  });
});

describe('readAll: one block', () => {
  it('pins "latest" once and uses that number for the contract check and every read', async () => {
    const { storage, calls, at } = harness({ blockNumber: 77n, onChain: '0x6080' });
    storage.set(8n, word(1));

    const result = await at(ARRAYS).name('pairs').readAll();

    expect(calls.blockNumber).toBe(1);
    expect(calls.code).toEqual([77n]);
    expect(new Set(storage.reads.map((read) => read.blockTag))).toEqual(new Set([77n]));
    expect(result.blockTag).toBe(77n);
  });

  it.each([5, 5n, 'safe', 'pending', 'finalized', '0x10'] as BlockTag[])(
    'does not ask for the block number at %s',
    async (tag) => {
      const { storage, calls, at } = harness({ blockNumber: 77n });
      storage.set(8n, word(1));

      const result = await at(ARRAYS).name('pairs').at(tag).readAll();

      expect(calls.blockNumber).toBe(0);
      expect(new Set(storage.reads.map((read) => read.blockTag))).toEqual(new Set([tag]));
      expect(result.blockTag).toBe(tag);
    }
  );

  it('re-reads each array length once when the tag can move', async () => {
    const { storage, readsOf, at } = harness();
    storage.set(3n, word(2));

    await at(ARRAYS).name('words').readAll(); // "latest", and no getBlockNumber to pin with

    expect(readsOf.get(3n)).toBe(2);
  });

  it.each([5, '0x10', 'earliest'] as BlockTag[])('does not re-read at the fixed tag %s', async (tag) => {
    const { storage, readsOf, at } = harness();
    storage.set(3n, word(2));
    await at(ARRAYS).name('words').at(tag).readAll();
    expect(readsOf.get(3n)).toBe(1);
  });

  it('treats an unrecognised tag as one that can move', async () => {
    const { storage, readsOf, at } = harness();
    storage.set(3n, word(2));
    await at(ARRAYS).name('words').at('accepted').readAll();
    expect(readsOf.get(3n)).toBe(2);
  });

  it('throws when an array length changes during an unpinned dump', async () => {
    const { storage, at } = harness({
      // words.length reads 2 the first time and 3 on the re-read.
      intercept: (slot, nth) => (slot === 3n && nth === 2 ? word(3) : undefined),
    });
    storage.set(3n, word(2));

    const error = await at(ARRAYS).name('words').readAll().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DumpInconsistentError);
    expect(error).toMatchObject({ path: 'words', before: 2n, after: 3n });
  });

  it('throws when a long string changes length during an unpinned dump', async () => {
    const { storage, at } = harness({
      intercept: (slot, nth) => (slot === 1n && nth === 2 ? longBytesHeader(90) : undefined),
    });
    storage.setString(1n, 'y'.repeat(64));

    const error = await at(STRINGS).name('longText').readAll().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DumpInconsistentError);
    expect(error).toMatchObject({ path: 'longText', before: 64n, after: 90n });
  });
});

describe('readAll: call counts for a 10,000-element uint8[]', () => {
  const tiny = slotOf(RECURSIVE, 'tiny');
  const total = (readsOf: Map<bigint, number>) => [...readsOf.values()].reduce((a, b) => a + b, 0);

  it('issues 314 reads at a fixed block: one length plus 313 packed slots', async () => {
    const { storage, readsOf, at } = harness();
    storage.set(tiny, word(10_000));

    const result = await at(RECURSIVE).name('tiny').at(5).readAll();

    expect(result.value).toHaveLength(10_000);
    expect(total(readsOf)).toBe(314);
  });

  it('issues 314 reads when "latest" is pinned', async () => {
    const { storage, readsOf, at } = harness({ blockNumber: 9n });
    storage.set(tiny, word(10_000));
    await at(RECURSIVE).name('tiny').readAll();
    expect(total(readsOf)).toBe(314);
  });

  it('issues 315 reads when the tag can move: one more for the length re-check', async () => {
    const { storage, readsOf, at } = harness();
    storage.set(tiny, word(10_000));
    await at(RECURSIVE).name('tiny').readAll();
    expect(total(readsOf)).toBe(315);
  });
});

describe('readAll: failures part-way through', () => {
  it('leaves no rejection unhandled when a later mapping key is invalid', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { storage, at } = harness();
      // The first key is valid and its array needs a second round of reads, so a naive
      // expansion would already be running for it when the second key is rejected.
      storage.set(mappingSlot(addressKey(ALICE), 0n), word(2));

      await expect(
        at(MAPPING_TO_ARRAY).name('listByAddress').at(5).readAll({ keys: { '': [ALICE, '0x12'] } })
      ).rejects.toThrow(/20-byte address/);

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('stops sending queued reads once the dump has failed', async () => {
    const first = arrayBase(3n);
    const { storage, readsOf, at } = harness({
      slow: true,
      intercept: (slot) => {
        if (slot === first) throw new Error('element 0 unreadable');
        return undefined;
      },
    });
    storage.set(3n, word(5000)); // words.length

    await expect(at(ARRAYS).name('words').at(5).readAll()).rejects.toThrow('element 0 unreadable');
    await new Promise((resolve) => setTimeout(resolve, 50));

    // One length read and the first window of 256 concurrent reads, plus the few whose turn
    // came while the failure was still propagating — nowhere near all 5000.
    const sent = [...readsOf.values()].reduce((a, b) => a + b, 0);
    expect(sent).toBeLessThan(2 * 256 + 2);
  });

  it('counts the data slots of a long string toward the limit before fetching any', async () => {
    const { storage, readsOf, at } = harness();
    const header = arrayBase(5n);
    // texts has one element whose header claims 16 MiB: 524,288 data slots.
    storage.set(5n, word(1)).set(header, longBytesHeader(16 * 1024 * 1024));

    const error = await at(STRINGS).name('texts').at(5).readAll().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DumpTooLargeError);
    expect(error).toMatchObject({ kind: 'total', path: 'texts[0]' });
    expect([...readsOf.keys()].sort()).toEqual([5n, header].sort());
  });

  it('allows a long string whose data slots fit the limit', async () => {
    const { storage, at } = harness();
    const text = 'q'.repeat(100); // 4 data slots
    storage.setString(1n, text);

    await expect(at(STRINGS).name('longText').at(5).readAll({ maxElements: 4 })).resolves.toMatchObject({
      value: text,
    });
    await expect(at(STRINGS).name('longText').at(5).readAll({ maxElements: 3 })).rejects.toMatchObject({
      kind: 'total',
    });
  });
});

describe('readAll: remaining edges', () => {
  it('re-checks the length of an array on the path to the dump root', async () => {
    const { storage, at } = harness({
      // nested.length reads 2 at first and 1 on the re-read: the row being dumped is gone.
      intercept: (slot, nth) => (slot === 9n && nth === 2 ? word(1) : undefined),
    });
    storage.set(9n, word(2)).set(arrayBase(9n) + 1n, word(0));

    const error = await at(ARRAYS).name('nested').index(1).readAll().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DumpInconsistentError);
    expect(error).toMatchObject({ path: 'nested', before: 2n, after: 1n });
  });

  it('reads supplied keys of a mapping inside every array element', async () => {
    const { storage, at } = harness();
    const children = arrayBase(1n);
    storage.set(1n, word(2)); // root.children.length; each Node is 3 slots
    storage.set(mappingSlot(uintKey(7), children + 3n + 2n), word(77)); // children[1].byId[7].id

    const result = await at(RECURSIVE).name('root').at(5).readAll({ keys: { 'children[].byId': [7] } });
    const root = result.value as { children: { byId: Map<number, { id: bigint }> }[] };

    expect(root.children[0]?.byId.get(7)?.id).toBe(0n);
    expect(root.children[1]?.byId.get(7)?.id).toBe(77n);
    expect([...result.skipped].sort()).toEqual(['byId', 'children[].byId{}.byId']);
  });

  it('rejects options that are not an object', async () => {
    const { calls, at } = harness();
    await expect(
      at(RECURSIVE).name('root').readAll(null as unknown as undefined)
    ).rejects.toThrow(/options must be an object/);
    expect(calls.layout).toBe(0);
  });
});
