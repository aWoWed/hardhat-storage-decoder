/**
 * A fake node for the concurrency tests of the core and of both adapters, and the workloads the
 * limit has to hold across.
 */
import type { StorageQueryBuilder } from '../../src/core/query/StorageQueryBuilder.js';
import { MockStorage, word } from './helpers.js';

export const TARGET = '0x3333333333333333333333333333333333333333';
export const ARRAYS = 'ArrayStorage.sol:ArrayStorage';
export const STRINGS = 'StringStorage.sol:StringStorage';
/** The array's length, and the string's data slots: far above every limit tried here. */
const ELEMENTS = 40;

/** A fake node counting the calls of every kind in flight, each taking about a millisecond. */
export function fakeNode(options: { readonly failFirstAttemptOfEachSlot?: boolean } = {}) {
  const storage = new MockStorage().set(3n, word(ELEMENTS)); // ArrayStorage.words.length
  const text = 'z'.repeat(32 * ELEMENTS);
  storage.setString(1n, text); // StringStorage.longText
  const failedOnce = new Set<bigint>();
  const counts = { inFlight: 0, peak: 0, code: 0, blockNumber: 0 };

  /** Count one call in flight for as long as `work` takes, plus the simulated latency. */
  async function during<T>(work: () => T): Promise<T> {
    counts.inFlight += 1;
    counts.peak = Math.max(counts.peak, counts.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    try {
      return work();
    } finally {
      counts.inFlight -= 1;
    }
  }

  const answer = {
    storageAt: (slot: bigint): Promise<Uint8Array> =>
      during(() => {
        if (options.failFirstAttemptOfEachSlot === true && !failedOnce.has(slot)) {
          failedOnce.add(slot);
          throw Object.assign(new Error('rate limit'), { code: -32005 });
        }
        return storage.get(slot);
      }),
    code: (): Promise<string> =>
      during(() => {
        counts.code += 1;
        return '0x6080';
      }),
    blockNumber: (): Promise<bigint> =>
      during(() => {
        counts.blockNumber += 1;
        return 9n;
      }),
  };
  return { counts, answer, text };
}

/** One provider call, as JSON-RPC would answer it. */
export function rpc(node: ReturnType<typeof fakeNode>) {
  return async (method: string, params: readonly unknown[]): Promise<unknown> => {
    if (method === 'eth_getCode') return node.answer.code();
    if (method === 'eth_blockNumber') return `0x${(await node.answer.blockNumber()).toString(16)}`;
    const raw = await node.answer.storageAt(BigInt(params[1] as string));
    return `0x${Buffer.from(raw).toString('hex')}`;
  };
}

/** Each way of running queries the limit has to hold across. */
export const WORKLOADS: readonly [string, (decoder: StorageQueryBuilder) => Promise<unknown>][] = [
  ['read', (decoder) => decoder.contract(STRINGS).target(TARGET).name('longText').read()],
  [
    'readMany',
    (decoder) => {
      const words = decoder.contract(ARRAYS).target(TARGET).name('words');
      return decoder.readMany(Array.from({ length: ELEMENTS }, (_unused, i) => words.index(i)));
    },
  ],
  ['readAll', (decoder) => decoder.contract(ARRAYS).target(TARGET).name('words').readAll()],
  [
    'overlapping reads on one context',
    (decoder) => {
      const words = decoder.contract(ARRAYS).target(TARGET).name('words');
      return Promise.all([
        ...Array.from({ length: ELEMENTS }, (_unused, i) => words.index(i).read()),
        words.readAll(),
      ]);
    },
  ],
];

