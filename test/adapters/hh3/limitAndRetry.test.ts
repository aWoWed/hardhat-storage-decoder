/**
 * The limit and the retry layer through `createStorageDecoder` and
 * `createStorageDecoderContext`, and the Hardhat 3 failure shapes, as read from
 * `node_modules/hardhat-v3/src/internal/builtin-plugins/network-manager/http-provider.ts`.
 *
 * Only the layout reader is replaced: the RPC wiring, the classifier and the option handling are
 * the real ones.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PrunedStateError,
  type StorageDecoderOptions,
  createStorageDecoder,
  createStorageDecoderContext,
} from '../../../src/hardhat3/index.js';
import { classifyProviderError } from '../../../src/hardhat3/provider.js';
import { ARRAYS, TARGET, WORKLOADS, fakeNode, rpc } from '../../unit/fakeNode.js';

vi.mock('../../../src/hardhat3/readBuildInfo.js', async () => {
  const { loadLayout } = await import('../../unit/helpers.js');
  return {
    Hardhat3LayoutReader: class {
      getLayout = async (fqn: string) => loadLayout(fqn);
      getDeployedBytecode = async () => '0x6080';
    },
  };
});

function rpcError(message: string, fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), fields);
}

/** A decoder on a fake node, or on a bare RPC function. */
function decoderOn(
  node: ReturnType<typeof fakeNode> | { rpc: (method: string, params: readonly unknown[]) => Promise<unknown> },
  options?: StorageDecoderOptions
) {
  const send = 'rpc' in node ? node.rpc : rpc(node);
  const provider = {
    request: ({ method, params }: { method: string; params: readonly unknown[] }) => send(method, params),
  };
  return createStorageDecoder(createStorageDecoderContext({} as never, provider as never), options);
}

const TIMES = [1, 2, 16];

describe.each(TIMES)('a limit of %i through the Hardhat 3 entry point', (limit) => {
  it.each(WORKLOADS)('is reached and never passed by %s', async (_name, run) => {
    const node = fakeNode();
    await run(decoderOn(node, { maxConcurrentReads: limit }));
    expect(node.counts.peak).toBe(limit);
  });
});

describe('the Hardhat 3 entry point', () => {
  it('defaults to a limit of 16', async () => {
    const node = fakeNode();
    await decoderOn(node).contract(ARRAYS).target(TARGET).name('words').readAll();
    expect(node.counts.peak).toBe(16);
  });

  it('retries with the settings given', async () => {
    const node = fakeNode({ failFirstAttemptOfEachSlot: true });
    const { value } = await decoderOn(node, { retry: { baseDelayMs: 1, maxDelayMs: 1 } })
      .contract(ARRAYS)
      .target(TARGET)
      .name('words')
      .at(5)
      .index(0)
      .read();
    expect(value).toBe(0n);
  });

  it('raises PrunedStateError for the pruned wording, naming the block', async () => {
    const pruned = rpcError('pruned history unavailable: requested 11814928, earliest available 12020851', {
      code: 4444,
    });
    const decoder = decoderOn({ rpc: async () => { throw pruned; } });
    const error = await decoder.contract(ARRAYS).target(TARGET).name('words').at(11814928).readAll().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrunedStateError);
    expect(error).toMatchObject({ blockTag: 11814928, cause: pruned });
  });

  it("sends an HTTP 429 Hardhat's own retries gave up on exactly once", async () => {
    const giveUp = rpcError('Limit exceeded', { code: -32005, cause: rpcError('x', { statusCode: 429 }) });
    let storageCalls = 0;
    const decoder = decoderOn({
      rpc: async (method) => {
        if (method === 'eth_getCode') return '0x6080';
        storageCalls += 1;
        throw giveUp;
      },
    });
    await expect(decoder.contract(ARRAYS).target(TARGET).name('words').at(5).readAll()).rejects.toBe(giveUp);
    expect(storageCalls).toBe(1);
  });
});

describe('classifying the wordings the Sepolia probe saw, on Hardhat 3', () => {
  it.each([
    ['pruned', rpcError('pruned history unavailable: requested 11814928, earliest available 12020851', { code: 4444 })],
    ['retryable', rpcError('block not found: 0xb797b8', { code: -32001 })],
    // Neither is helped by a short wait; see classifyRpcError.ts for why not `fatal`.
    ['exhausted', rpcError("You've reached the usage limit for your current plan.", { code: -32001 })],
    ['exhausted', rpcError('chain is not available on free plan, please upgrade to paid plan', { code: 35 })],
    ['retryable', rpcError('Rate limit exceeded on Nodies public endpoints', { code: -32005 })],
    ['fatal', rpcError('the method does not exist', { code: -32601 })],
    ['fatal', rpcError('invalid argument', { code: -32602 })],
    ['fatal', undefined],
  ])('%s: %s', (expected, error) => {
    expect(classifyProviderError(error)).toBe(expected);
  });

  it("treats Hardhat's own give-up after a 429 as exhausted, and a node's -32005 as retryable", () => {
    const limit = rpcError('Limit exceeded', { code: -32005, cause: rpcError('x', { statusCode: 429 }) });
    expect(classifyProviderError(limit)).toBe('exhausted');
    expect(classifyProviderError(rpcError('limit exceeded', { code: -32005 }))).toBe('retryable');
  });

  it.each([702, 703, 704])('retries error %i', (number) => {
    expect(classifyProviderError(rpcError('x', { number }))).toBe('retryable');
  });

  it('does not take a Hardhat 2 error number for its own', () => {
    expect(classifyProviderError(rpcError('x', { number: 109 }))).toBe('fatal');
  });

  it('sorts a status by its value', () => {
    const withStatus = (statusCode: number) => rpcError('x', { code: -1, cause: rpcError('y', { statusCode }) });
    expect(classifyProviderError(withStatus(503))).toBe('retryable');
    for (const status of [400, 401, 402, 403]) expect(classifyProviderError(withStatus(status))).toBe('exhausted');
  });

  it('lets the number decide over a network name that reads like another class', () => {
    expect(
      classifyProviderError(rpcError('HHE703: Cannot connect to the network pruned-node.', { number: 703 }))
    ).toBe('retryable');
    expect(
      classifyProviderError(
        rpcError('HHE702: Invalid JSON-RPC response received: <html>state is not available</html>', { number: 702 })
      )
    ).toBe('retryable');
  });

  it.each([
    ['the bare HTTP 400', rpcError('Received an unexpected status code', { code: -1, cause: rpcError('y', { statusCode: 400 }) })],
    ['4444', rpcError('pruned history unavailable: requested 1, earliest available 2', { code: 4444 })],
  ])('holds budget + 1 + limit in a readMany of 1000 for %s', async (_name, failure) => {
    let storageCalls = 0;
    const decoder = decoderOn({
      rpc: async (method) => {
        if (method === 'eth_getCode') return '0x6080';
        storageCalls += 1;
        throw failure;
      },
    });
    const words = decoder.contract(ARRAYS).target(TARGET).name('words').at(5);
    await expect(
      decoder.readMany(Array.from({ length: 1000 }, (_unused, i) => words.index(i)))
    ).rejects.toBeDefined();
    expect(storageCalls).toBeLessThanOrEqual(32 + 1 + 16);
  });

  // Not seen in the probe, which met this wording only on Hardhat 2. Hardhat 3 reports a 400 as a
  // status with its own message, so the status decides.
  it('treats the free-plan refusal as exhausted when it arrives as a bare HTTP 400', () => {
    const bare = rpcError('Received an unexpected status code', {
      code: -1,
      cause: rpcError('y', { statusCode: 400 }),
    });
    expect(classifyProviderError(bare)).toBe('exhausted');
  });
});
