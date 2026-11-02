/**
 * The limit and the retry layer through `createHardhatStorageDecoder`, and the Hardhat 2 failure
 * shapes, as read from `node_modules/hardhat-v2/src/internal/core/providers/http.ts`.
 *
 * Only what needs a real project or Hardhat is replaced: the RPC wiring, the classifier and the
 * option handling are the real ones.
 */
import { describe, expect, it, vi } from 'vitest';
import { PrunedStateError, type StorageDecoderOptions } from '../../../src/hardhat2/index.js';
import { createHardhatStorageDecoder } from '../../../src/hardhat2/index.js';
import { classifyProviderError } from '../../../src/hardhat2/provider.js';
import { ARRAYS, TARGET, WORKLOADS, fakeNode, rpc } from '../../unit/fakeNode.js';

vi.mock('hardhat/config', () => ({
  extendConfig: () => {},
  extendEnvironment: () => {},
  subtask: () => {},
}));
vi.mock('hardhat/builtin-tasks/task-names', () => ({
  TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT: 'unused',
}));
vi.mock('../../../src/hardhat2/readBuildInfo.js', async () => {
  const { loadLayout } = await import('../../unit/helpers.js');
  return {
    StorageLayoutNotAvailableError: class extends Error {},
    createBuildInfoReader: () => ({
      getLayout: async (fqn: string) => loadLayout(fqn),
      getDeployedBytecode: async () => '0x6080',
    }),
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
  return createHardhatStorageDecoder({ network: { provider: { send } } } as never, options);
}

const TIMES = [1, 2, 16];

describe.each(TIMES)('a limit of %i through the Hardhat 2 entry point', (limit) => {
  it.each(WORKLOADS)('is reached and never passed by %s', async (_name, run) => {
    const node = fakeNode();
    await run(decoderOn(node, { maxConcurrentReads: limit }));
    expect(node.counts.peak).toBe(limit);
  });
});

describe('the Hardhat 2 entry point', () => {
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
    const giveUp = rpcError('Too Many Requests error received from rpc.example', { code: -32005 });
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

describe('classifying the wordings the Sepolia probe saw, on Hardhat 2', () => {
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
    expect(classifyProviderError(rpcError('Too Many Requests error received from rpc.example', { code: -32005 }))).toBe(
      'exhausted'
    );
    expect(classifyProviderError(rpcError('limit exceeded', { code: -32005 }))).toBe('retryable');
  });

  it.each([108, 109, 110])('retries error %i, which carries no status', (number) => {
    expect(classifyProviderError(rpcError('x', { number }))).toBe('retryable');
  });

  it('does not take a Hardhat 3 error number for its own', () => {
    expect(classifyProviderError(rpcError('x', { number: 704 }))).toBe('fatal');
  });

  it('retries "cu limit exceeded", which reaches Hardhat 2 as error 110 over HTTP 200', () => {
    const body = '{"timestamp":1793500000,"status":429,"error":"cu limit exceeded; Request too fast per second"}';
    const error = rpcError(`HH110: Invalid JSON-RPC response received: ${body}`, { number: 110 });
    expect(classifyProviderError(error)).toBe('retryable');
  });

  it('lets the number decide over a body or name that reads like another class', () => {
    expect(
      classifyProviderError(rpcError('HH108: Cannot connect to the network archive-pruned.', { number: 108 }))
    ).toBe('retryable');
    expect(
      classifyProviderError(
        rpcError('HH110: Invalid JSON-RPC response received: <html>state is not available</html>', { number: 110 })
      )
    ).toBe('retryable');
    expect(
      classifyProviderError(rpcError('HH110: Invalid JSON-RPC response received: {"error":"usage limit reached"}', { number: 110 }))
    ).toBe('retryable');
  });
});
