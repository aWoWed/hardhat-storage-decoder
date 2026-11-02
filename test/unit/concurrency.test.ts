/**
 * The concurrency limit: one per decoder context, across every terminal method and every kind of
 * RPC call, with retries running or not. `test/adapters/hh{2,3}/limitAndRetry.test.ts` run the same
 * workloads through each adapter's entry point.
 */
import { describe, expect, it } from 'vitest';
import { createStorageDecoder as createCoreDecoder } from '../../src/core/index.js';
import type { StorageDecoderContext } from '../../src/core/query/StorageQueryBuilder.js';
import { StorageQueryBuilder } from '../../src/core/query/StorageQueryBuilder.js';
import { ARRAYS, TARGET, WORKLOADS, fakeNode } from './fakeNode.js';
import { loadLayout } from './helpers.js';

/** A context for the core, on a fake node. */
function coreContext(node: ReturnType<typeof fakeNode>): StorageDecoderContext {
  return {
    getLayout: async (fqn) => loadLayout(fqn),
    getStorageAt: ({ slot }) => node.answer.storageAt(slot),
    getDeployedBytecode: async () => '0x6080',
    getCode: () => node.answer.code(),
    getBlockNumber: () => node.answer.blockNumber(),
  };
}

const RETRY_FAST = { baseDelayMs: 1, maxDelayMs: 1, budget: 100_000 };

describe.each([1, 2, 16])('a limit of %i', (limit) => {
  it.each(WORKLOADS)('is reached and never passed by %s', async (_name, run) => {
    const node = fakeNode();
    await run(createCoreDecoder(coreContext(node), { maxConcurrentReads: limit }));
    expect(node.counts.peak).toBe(limit);
    expect(node.counts.inFlight).toBe(0);
  });

  it.each(WORKLOADS)('holds during retries in %s', async (_name, run) => {
    const node = fakeNode({ failFirstAttemptOfEachSlot: true });
    await run(createCoreDecoder(coreContext(node), { maxConcurrentReads: limit, retry: RETRY_FAST }));
    expect(node.counts.peak).toBeLessThanOrEqual(limit);
  });

  it('counts getCode and getBlockNumber with the storage reads', async () => {
    const node = fakeNode();
    const decoder = createCoreDecoder(coreContext(node), { maxConcurrentReads: limit });
    const words = decoder.contract(ARRAYS).target(TARGET).name('words');
    // At different block tags, so each query makes its own contract check.
    await Promise.all([
      ...Array.from({ length: 10 }, (_unused, i) => words.at(i).index(0).read()),
      ...Array.from({ length: 3 }, () => words.readAll()),
    ]);
    expect(node.counts.code).toBe(13);
    expect(node.counts.blockNumber).toBe(3);
    expect(node.counts.peak).toBeLessThanOrEqual(limit);
  });

});

describe('the limiter', () => {
  it('defaults to 16 on a directly constructed builder', async () => {
    const node = fakeNode();
    await new StorageQueryBuilder(coreContext(node)).contract(ARRAYS).target(TARGET).name('words').readAll();
    expect(node.counts.peak).toBe(16);
  });

  it('is shared by every builder on one context', async () => {
    const node = fakeNode();
    const context = coreContext(node);
    createCoreDecoder(context, { maxConcurrentReads: 3 });
    const words = new StorageQueryBuilder(context).contract(ARRAYS).target(TARGET).name('words');
    await Promise.all([words.readAll(), new StorageQueryBuilder(context).contract(ARRAYS).target(TARGET).name('words').readAll()]);
    expect(node.counts.peak).toBe(3);
  });

  it('keeps earlier options when a later createStorageDecoder gives none', async () => {
    const node = fakeNode();
    const context = coreContext(node);
    createCoreDecoder(context, { maxConcurrentReads: 3 });
    await createCoreDecoder(context).contract(ARRAYS).target(TARGET).name('words').readAll();
    expect(node.counts.peak).toBe(3);
  });

  it('is not shared between two contexts on one endpoint', async () => {
    const node = fakeNode();
    const decoders = [coreContext(node), coreContext(node)].map((context) =>
      createCoreDecoder(context, { maxConcurrentReads: 2 })
    );
    await Promise.all(
      decoders.map((decoder) => decoder.contract(ARRAYS).target(TARGET).name('words').readAll())
    );
    expect(node.counts.peak).toBe(4);
  });

  it('limits each context on its own in one readMany that mixes them', async () => {
    const node = fakeNode();
    const queries = [coreContext(node), coreContext(node)].flatMap((context) => {
      const words = createCoreDecoder(context, { maxConcurrentReads: 1 })
        .contract(ARRAYS)
        .target(TARGET)
        .name('words');
      return Array.from({ length: 20 }, (_unused, i) => words.index(i));
    });
    await (queries[0] as StorageQueryBuilder).readMany(queries);
    expect(node.counts.peak).toBe(2);
  });

  it.each([
    ['maxConcurrentReads', { maxConcurrentReads: 0 }],
    ['maxConcurrentReads', { maxConcurrentReads: -1 }],
    ['maxConcurrentReads', { maxConcurrentReads: 1.5 }],
    ['maxConcurrentReads', { maxConcurrentReads: Number.POSITIVE_INFINITY }],
    ['maxConcurrentReads', { maxConcurrentReads: '4' }],
    ['retry.maxAttempts', { retry: { maxAttempts: 0 } }],
    ['retry.baseDelayMs', { retry: { baseDelayMs: 0.5 } }],
    ['retry.maxDelayMs', { retry: { maxDelayMs: -5 } }],
    ['retry.budget', { retry: { budget: Number.NaN } }],
  ])('rejects a bad %s', (name, options) => {
    const context = coreContext(fakeNode());
    expect(() => createCoreDecoder(context, options as never)).toThrow(TypeError);
    expect(() => createCoreDecoder(context, options as never)).toThrow(name);
  });

  it.each([null, 3, 'x'])('rejects options of %s', (options) => {
    expect(() => createCoreDecoder(coreContext(fakeNode()), options as never)).toThrow(TypeError);
  });

  it('rejects a retry setting that is not an object', () => {
    expect(() => createCoreDecoder(coreContext(fakeNode()), { retry: 3 } as never)).toThrow(TypeError);
  });

  it('treats a retry setting of null as omitted', () => {
    expect(() => createCoreDecoder(coreContext(fakeNode()), { retry: null } as never)).not.toThrow();
  });
});
