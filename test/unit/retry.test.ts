/**
 * Classifying failed RPC calls, retrying the ones that qualify, and the pruned-state error.
 *
 * The wordings in the classifier tables are the real ones seen when probing public endpoints,
 * with the digits that were normalised there filled in, in the shape each provider surfaced them.
 * Everything else here runs against a fake provider with its time and randomness replaced.
 */
import { describe, expect, it } from 'vitest';
import {
  ContractMismatchError,
  ContractNotFoundError,
  PrunedStateError,
  StorageDecoderError,
  classifyReadFailure,
  classifyRpcError,
} from '../../src/core/index.js';
import { type RetrySources, type StorageDecoderOptions, configureLimiter } from '../../src/core/query/limiter.js';
import {
  type StorageDecoderContext,
  StorageQueryBuilder,
} from '../../src/core/query/StorageQueryBuilder.js';
import { quiescent } from './deferred.js';
import { MockStorage, arrayBase, loadLayout, word } from './helpers.js';

const TARGET = '0x3333333333333333333333333333333333333333';
const ARRAYS = 'ArrayStorage.sol:ArrayStorage';
const STRINGS = 'StringStorage.sol:StringStorage';

/** An error with the fields a provider sets. */
function rpcError(message: string, fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), fields);
}

const USAGE_LIMIT = rpcError("You've reached the usage limit for your current plan. Upgrade to continue.", {
  code: -32001,
});
const FREE_PLAN = rpcError('chain is not available on free plan, please upgrade to paid plan', { code: 35 });
const PRUNED = rpcError('pruned history unavailable: requested 11814928, earliest available 12020851', {
  code: 4444,
});
const BLOCK_NOT_FOUND = rpcError('block not found: 0xb797b8', { code: -32001 });
const CU_LIMIT_BODY =
  '{"timestamp":1793500000,"status":429,"error":"cu limit exceeded; Request too fast per second"}';

describe('classifying the wordings the Sepolia probe saw', () => {
  it.each(
    [
      ['pruned', PRUNED],
      // -32001 alone means two things, so the wording decides each of these two.
      ['exhausted', USAGE_LIMIT],
      ['retryable', BLOCK_NOT_FOUND],
      ['exhausted', FREE_PLAN],
    ] as const
  )('%s: %s', (expected, error) => {
    expect(classifyRpcError(error)).toBe(expected);
  });

  it('retries the two 429 bodies Hardhat would surface if its own retries ended differently', () => {
    expect(
      classifyRpcError(rpcError('Too Many Requests, Please apply an OnFinality API key', { code: -32029 }))
    ).toBe('retryable');
    expect(
      classifyRpcError(rpcError('Rate limit exceeded on Nodies public endpoints', { code: -32005 }))
    ).toBe('retryable');
  });

  it('retries "cu limit exceeded" by its own words, wherever a provider puts them in its message', () => {
    // The node's words decide, so the core needs no Hardhat number to get this right.
    expect(classifyRpcError(rpcError(`Invalid JSON-RPC response received: ${CU_LIMIT_BODY}`))).toBe('retryable');
  });
});

describe('classifyRpcError', () => {
  it.each([
    ['missing trie node', rpcError('missing trie node abc (path )', { code: -32000 })],
    ['historical state', rpcError('required historical state unavailable', { code: -32000 })],
    ['state not available', rpcError('state 0xabc is not available', { code: -32000 })],
    ['code 4444 with no recognised words', rpcError('nope', { code: 4444 })],
    ['a wrapped node error', rpcError('wrapper', { cause: PRUNED })],
  ])('pruned: %s', (_name, error) => {
    expect(classifyRpcError(error)).toBe('pruned');
  });

  it.each([
    ['-32005 over HTTP 200', rpcError('limit', { code: -32005 })],
    ['rate-limit wording under another code', rpcError('rate limited', { code: -32000 })],
    ['"header not found" from a lagging backend', rpcError('header not found', { code: -32000 })],
    ['a socket hang-up', rpcError('other side closed', { code: 'UND_ERR_SOCKET' })],
    ['a headers timeout', rpcError('Headers Timeout', { code: 'UND_ERR_HEADERS_TIMEOUT' })],
    ['a reset', rpcError('read ECONNRESET', { code: 'ECONNRESET' })],
    ['a DNS failure', rpcError('getaddrinfo', { code: 'EAI_AGAIN' })],
    ['a refused connection in a parent', rpcError('wrapper', { parent: rpcError('x', { code: 'ECONNREFUSED' }) })],
    ['status 408', rpcError('x', { statusCode: 408 })],
    ['status 425', rpcError('x', { statusCode: 425 })],
    ['status 429', rpcError('x', { statusCode: 429 })],
    ['status 503 in a cause', rpcError('x', { code: -1, cause: rpcError('y', { statusCode: 503 }) })],
    // Transport codes win: a host name in the message says nothing about the node's state.
    ['a DNS failure naming a "pruned" host', rpcError('getaddrinfo ENOTFOUND pruned.rpc.example.com', { code: 'ENOTFOUND' })],
    ['a reset whose message reads like state', rpcError('state is not available', { code: 'ECONNRESET' })],
  ])('retryable: %s', (_name, error) => {
    expect(classifyRpcError(error)).toBe('retryable');
  });

  it.each([
    ['-32601', rpcError('the method does not exist', { code: -32601 })],
    ['-32602', rpcError('invalid argument', { code: -32602 })],
    ['-32000 with an unknown message', rpcError('execution reverted', { code: -32000 })],
    ['-32001 with an unknown message', rpcError('something else', { code: -32001 })],
    ['"pruned" alone, which is not the node\'s phrase', rpcError('host pruned-node said no', { code: -32000 })],
    ['"rate limit" only as the end of another word', rpcError('corporate limit reached', { code: -32000 })],
    ['a plain error', new Error('element 0 unreadable')],
    ['an undici argument error', rpcError('bad', { code: 'UND_ERR_INVALID_ARG' })],
    ['a string', 'boom'],
    ['undefined', undefined],
    ['null', null],
  ])('fatal: %s', (_name, error) => {
    expect(classifyRpcError(error)).toBe('fatal');
  });

  it.each([400, 401, 402, 403, 404])('exhausted: status %i, a refusal a re-send cannot change', (statusCode) => {
    expect(classifyRpcError(rpcError('x', { statusCode }))).toBe('exhausted');
    expect(classifyRpcError(rpcError('x', { code: -1, cause: rpcError('y', { statusCode }) }))).toBe('exhausted');
  });

  it('survives a cycle of causes', () => {
    const a = rpcError('a');
    const b = rpcError('b', { cause: a });
    Object.assign(a, { cause: b });
    expect(classifyRpcError(a)).toBe('fatal');
  });
});

describe('PrunedStateError and classifyReadFailure', () => {
  it.each([
    [5, '5'],
    [12n, '12'],
    ['0x10', '0x10'],
  ] as const)('names block %s and says an archive node is needed', (tag, shown) => {
    const error = new PrunedStateError(tag, PRUNED);
    expect(error.message).toContain(`block ${shown}`);
    expect(error.message).toContain('archive node');
    expect(error.blockTag).toBe(tag);
    expect(error.cause).toBe(PRUNED);
    expect(error).toBeInstanceOf(StorageDecoderError);
  });

  it.each(['latest', 'finalized', 'earliest'])(
    'reports what the node said for the tag %s, without claiming an old block or an archive node',
    (tag) => {
      const error = new PrunedStateError(tag, PRUNED);
      expect(error.message).toContain(`"${tag}"`);
      expect(error.message).not.toContain('state of block');
      expect(error.message).not.toContain('archive');
      expect(error.blockTag).toBe(tag);
      expect(error.cause).toBe(PRUNED);
    }
  );

  it('sorts a fetch failure as rpc, and a TypeError with no transport cause as wrong-data', () => {
    const socket = rpcError('other side closed', { code: 'UND_ERR_SOCKET' });
    expect(classifyReadFailure(new TypeError('fetch failed', { cause: socket }))).toBe('rpc');
    expect(classifyReadFailure(new TypeError('fetch failed', { cause: new Error('x') }))).toBe('wrong-data');
  });

  it.each([
    ['pruned', new PrunedStateError(5)],
    ['wrong-data', new ContractMismatchError('a.sol:A', '0x00', 'detail')],
    ['wrong-data', new ContractNotFoundError('a.sol:A')],
    ['wrong-data', new StorageDecoderError('x')],
    ['wrong-data', new TypeError('x')],
    ['wrong-data', new RangeError('x')],
    ['wrong-data', new ReferenceError('x')],
    ['wrong-data', new SyntaxError('x')],
    ['rpc', PRUNED],
    ['rpc', USAGE_LIMIT],
    ['rpc', new Error('x')],
    ['rpc', 'a string'],
    ['rpc', undefined],
    ['rpc', null],
  ])('%s: %s', (expected, error) => {
    expect(classifyReadFailure(error)).toBe(expected);
  });

  it('recognises an error of a separately defined copy of the classes, by its brands', () => {
    const fromOtherBuild = Object.create(Error.prototype, {
      [Symbol.for('hardhat-storage-decoder.StorageDecoderError')]: { value: true },
      [Symbol.for('hardhat-storage-decoder.PrunedStateError')]: { value: true },
    });
    expect(fromOtherBuild).not.toBeInstanceOf(PrunedStateError);
    expect(classifyReadFailure(fromOtherBuild)).toBe('pruned');
  });

  it("keeps a consumer's subclass classified", () => {
    class MyPruned extends PrunedStateError {}
    class MyError extends StorageDecoderError {}
    expect(classifyReadFailure(new MyPruned(1))).toBe('pruned');
    expect(classifyReadFailure(new MyError('x'))).toBe('wrong-data');
  });
});

// ---------------------------------------------------------------------------------------
// The retry loop
// ---------------------------------------------------------------------------------------

/** What a {@link harness} slot read does: fail with the error it returns, or give a word. */
type Behaviour = (slot: bigint, attempt: number) => Error | undefined;

function harness(
  behaviour: Behaviour,
  options: StorageDecoderOptions = {},
  sourcesOverride: Partial<RetrySources> = {}
) {
  const calls = { storage: [] as bigint[], code: 0, blockNumber: 0 };
  const delays: number[] = [];
  const attempts = new Map<bigint, number>();
  const context: StorageDecoderContext = {
    getLayout: async (fqn) => loadLayout(fqn),
    getStorageAt: async ({ slot }) => {
      calls.storage.push(slot);
      const attempt = (attempts.get(slot) ?? 0) + 1;
      attempts.set(slot, attempt);
      // Let other reads get going, so that failures can overlap as they do in reality.
      await Promise.resolve();
      const failure = behaviour(slot, attempt);
      if (failure !== undefined) throw failure;
      return slot === 3n ? word(5000) : word(1);
    },
  };
  configureLimiter(context, options, {
    sleep: (ms) => {
      delays.push(ms);
      return { elapsed: Promise.resolve(), cancel: () => {} };
    },
    random: () => 0.5,
    ...sourcesOverride,
  });
  const words = new StorageQueryBuilder(context).contract(ARRAYS).target(TARGET).name('words');
  return { context, calls, delays, words };
}

const failOn = (error: Error): Behaviour => () => error;
const RATE_LIMITED = rpcError('rate limit', { code: -32005 });

describe('retrying', () => {
  it('re-sends a retryable failure and returns the value', async () => {
    const { calls, delays, words } = harness((_slot, attempt) => (attempt < 3 ? RATE_LIMITED : undefined));
    const { value } = await words.at(5).index(0).read();
    expect(value).toBe(1n);
    // Three of each: the array length and the element.
    expect(calls.storage).toHaveLength(6);
    expect(delays).toHaveLength(4);
  });

  it('gives up after maxAttempts with the provider error unchanged', async () => {
    const { calls, words } = harness(failOn(RATE_LIMITED), { retry: { maxAttempts: 3 } });
    await expect(words.at(5).readAll()).rejects.toBe(RATE_LIMITED);
    expect(calls.storage).toEqual([3n, 3n, 3n]);
  });

  it('sends once when maxAttempts is 1', async () => {
    const { calls, delays, words } = harness(failOn(RATE_LIMITED), { retry: { maxAttempts: 1 } });
    await expect(words.at(5).readAll()).rejects.toBe(RATE_LIMITED);
    expect(calls.storage).toEqual([3n]);
    expect(delays).toEqual([]);
  });

  it('backs off with full jitter, doubling up to the cap', async () => {
    const { delays, words } = harness(failOn(RATE_LIMITED), {
      retry: { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 300 },
    });
    await expect(words.at(5).readAll()).rejects.toBe(RATE_LIMITED);
    // random() is 0.5; the ceilings are 100, 200, 300 and 300.
    expect(delays).toEqual([50, 100, 150, 150]);
  });

  it('can wait any time from none up to the ceiling', async () => {
    const low = harness(failOn(RATE_LIMITED), { retry: { maxAttempts: 2, baseDelayMs: 100 } }, { random: () => 0 });
    await expect(low.words.at(5).readAll()).rejects.toBe(RATE_LIMITED);
    expect(low.delays).toEqual([0]);
    const high = harness(failOn(RATE_LIMITED), { retry: { maxAttempts: 2, baseDelayMs: 100 } }, { random: () => 0.999 });
    await expect(high.words.at(5).readAll()).rejects.toBe(RATE_LIMITED);
    expect(high.delays).toEqual([99]);
  });

  it.each([
    ['an unknown error', new Error('nope')],
    ['-32601', rpcError('no such method', { code: -32601 })],
    ['-32602', rpcError('bad params', { code: -32602 })],
    // Deterministic for this package's purposes even though the words would look retryable.
    ['a TypeError', new TypeError('rate limit')],
    ['a RangeError', new RangeError('rate limit')],
    ['a StorageDecoderError', new StorageDecoderError('rate limit')],
  ])('never re-sends %s, and does not change it', async (_name, error) => {
    const { calls, delays, words } = harness(failOn(error));
    await expect(words.at(5).readAll()).rejects.toBe(error);
    expect(calls.storage).toEqual([3n]);
    expect(delays).toEqual([]);
  });

  // Neither is pruned, and neither is helped by a short wait. They are `exhausted` rather than
  // `fatal` for what follows them: being fatal would let a large call go on asking an endpoint
  // that has refused it, once per queued read. See the test below for that bound.
  it.each([
    ['the usage limit', USAGE_LIMIT],
    ['the free-plan refusal', FREE_PLAN],
  ])('does not re-send %s', async (_name, error) => {
    const { calls, delays, words } = harness(failOn(error));
    await expect(words.at(5).readAll()).rejects.toBe(error);
    expect(calls.storage).toEqual([3n]);
    expect(delays).toEqual([]);
  });

  it('sends a failure the adapter classifies as exhausted exactly once', async () => {
    const giveUp = rpcError('the provider gave up', { code: -32005 });
    const { context, calls, words } = harness(failOn(giveUp));
    context.classifyRpcError = () => 'exhausted';
    await expect(words.at(5).readAll()).rejects.toBe(giveUp);
    expect(calls.storage).toEqual([3n]);
  });

  it("uses the context's classifier in place of the default", async () => {
    const error = new Error('the adapter knows this one');
    const { context, calls, words } = harness(failOn(error));
    context.classifyRpcError = () => 'retryable';
    await expect(words.at(5).readAll()).rejects.toBe(error);
    expect(calls.storage).toHaveLength(3);
  });

  it('never asks the classifier about an error of this package or a TypeError', async () => {
    const asked: unknown[] = [];
    const { context, words } = harness(failOn(new TypeError('x')));
    context.classifyRpcError = (error) => {
      asked.push(error);
      return 'retryable';
    };
    await expect(words.at(5).readAll()).rejects.toThrow(TypeError);
    expect(asked).toEqual([]);
  });

  it.each([
    ['an error of this package', new ContractNotFoundError('C.sol:C')],
    ['a RangeError', new RangeError('x')],
  ])('never asks the classifier about %s, and does not re-send it', async (_name, error) => {
    const asked: unknown[] = [];
    const { context, calls, words } = harness(failOn(error));
    context.classifyRpcError = (failure) => {
      asked.push(failure);
      return 'retryable';
    };
    await expect(words.at(5).readAll()).rejects.toBe(error);
    expect(asked).toEqual([]);
    expect(calls.storage).toEqual([3n]);
  });

  it('asks the classifier about a TypeError with a transport failure under it', async () => {
    const error = new TypeError('fetch failed', { cause: rpcError('x', { code: 'ECONNRESET' }) });
    const asked: unknown[] = [];
    const { context, calls, words } = harness(failOn(error));
    context.classifyRpcError = (failure) => {
      asked.push(failure);
      return 'fatal';
    };
    await expect(words.at(5).readAll()).rejects.toBe(error);
    expect(asked).toEqual([error]);
    expect(calls.storage).toEqual([3n]);
  });

  it('calls getCode on the context, so a class-based one keeps its fields', async () => {
    const { context, words } = harness(() => undefined);
    const seen: unknown[] = [];
    context.getDeployedBytecode = async () => '0x6080';
    context.getCode = async function (this: unknown) {
      seen.push(this);
      return '0x6080';
    };
    await words.at(5).readAll();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((self) => self === context)).toBe(true);
  });

  it('re-sends a fetch failure, and reports it unchanged', async () => {
    const error = new TypeError('fetch failed', { cause: rpcError('x', { code: 'ECONNRESET' }) });
    const { calls, words } = harness(failOn(error));
    await expect(words.at(5).readAll()).rejects.toBe(error);
    expect(calls.storage).toEqual([3n, 3n, 3n]);
  });

  it('does not re-send a TypeError whose cause is not a transport failure', async () => {
    const error = new TypeError('fetch failed', { cause: new Error('bad header') });
    const { calls, words } = harness(failOn(error));
    await expect(words.at(5).readAll()).rejects.toBe(error);
    expect(calls.storage).toEqual([3n]);
  });

  it('treats an answer from the classifier that is not a class as fatal', async () => {
    const error = new Error('nope');
    const { context, calls, words } = harness(failOn(error));
    context.classifyRpcError = () => 'retry-later' as never;
    await expect(words.at(5).readAll()).rejects.toBe(error);
    expect(calls.storage).toEqual([3n]);
  });

  it('reports the original failure when the classifier throws', async () => {
    const error = new Error('nope');
    const { context, calls, words } = harness(failOn(error));
    context.classifyRpcError = () => {
      throw new Error('classifier bug');
    };
    await expect(words.at(5).readAll()).rejects.toBe(error);
    expect(calls.storage).toEqual([3n]);
  });

  it('retries getCode and getBlockNumber too', async () => {
    const { context, words } = harness(() => undefined);
    let code = 0;
    let blockNumber = 0;
    context.getDeployedBytecode = async () => '0x6080';
    context.getCode = async () => {
      code += 1;
      if (code < 3) throw RATE_LIMITED;
      return '0x6080';
    };
    context.getBlockNumber = async () => {
      blockNumber += 1;
      if (blockNumber < 3) throw RATE_LIMITED;
      return 9n;
    };
    const { blockTag } = await words.readAll({ maxElements: 10_000 });
    expect(blockTag).toBe(9n);
    expect(code).toBe(3);
    expect(blockNumber).toBe(3);
  });

  it('memoises only the final result of a call that was retried', async () => {
    const { calls, words } = harness((slot, attempt) => (slot === 3n && attempt === 1 ? RATE_LIMITED : undefined));
    const results = await words.at(5).readMany([words.at(5).index(0), words.at(5).index(1)]);
    expect(results).toHaveLength(2);
    // The shared length read failed once and was re-sent once; it was not repeated per query.
    expect(calls.storage.filter((slot) => slot === 3n)).toHaveLength(2);
  });
});

describe('pruned reads', () => {
  it('raises PrunedStateError naming the block of a storage read', async () => {
    const { calls, words } = harness(failOn(PRUNED));
    const error = await words.at(11814928).index(0).read().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrunedStateError);
    expect(error).toMatchObject({ blockTag: 11814928, cause: PRUNED });
    expect((error as Error).message).toContain('block 11814928');
    // Not re-sent: the two reads of this one query each went out once.
    expect(calls.storage).toHaveLength(2);
  });

  it('raises it for getCode, with the block of the contract check', async () => {
    const { context, words } = harness(() => undefined);
    context.getDeployedBytecode = async () => '0x6080';
    context.getCode = async () => {
      throw PRUNED;
    };
    await expect(words.at(5n).index(0).read()).rejects.toMatchObject({
      name: 'PrunedStateError',
      blockTag: 5n,
    });
  });

  it('stops the queue of a readMany, which still rejects with PrunedStateError', async () => {
    const element = arrayBase(3n);
    const { calls, words } = harness((slot) => (slot === element ? PRUNED : undefined));
    const queries = Array.from({ length: 1000 }, (_unused, i) => words.at(5).index(i));
    const error = await words.at(5).readMany(queries).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrunedStateError);
    expect(error).toMatchObject({ blockTag: 5, cause: PRUNED });
    // What was in flight, plus the one that took the permit of the length read as it finished.
    expect(calls.storage.length).toBeLessThanOrEqual(16 + 1);
  });

  it('leaves a pruned-looking eth_blockNumber failure unchanged: it names no block', async () => {
    const { context, words } = harness(() => undefined);
    context.getBlockNumber = async () => {
      throw PRUNED;
    };
    await expect(words.readAll()).rejects.toBe(PRUNED);
  });
});

describe('the budget', () => {
  const manyIndices = (words: StorageQueryBuilder, count: number) =>
    Array.from({ length: count }, (_unused, i) => words.at(5).index(i));

  it.each([
    ['defaults', 32, 16, {}],
    ['a limit of 1', 32, 1, { maxConcurrentReads: 1 }],
    ['a budget of 1', 1, 16, { retry: { budget: 1 } }],
    ['a limit of 4 and a budget of 8', 8, 4, { maxConcurrentReads: 4, retry: { budget: 8 } }],
  ])('bounds calls by budget + 1 + limit when everything fails, with %s', async (_name, budget, limit, options) => {
    const { calls, words } = harness(failOn(RATE_LIMITED), options);
    const error = await words
      .at(5)
      .readMany(manyIndices(words, 1000))
      .catch((e: unknown) => e);
    expect(error).toBe(RATE_LIMITED);
    expect(calls.storage.length).toBeLessThanOrEqual(budget + 1 + limit);
  });

  it('holds the same bound in readAll', async () => {
    const { calls, words } = harness((slot) => (slot === 3n ? undefined : RATE_LIMITED));
    await expect(words.at(5).readAll()).rejects.toBe(RATE_LIMITED);
    expect(calls.storage.length).toBeLessThanOrEqual(1 + 32 + 1 + 16);
  });

  it('stops a large call on an endpoint out of quota, which is why that class is not fatal', async () => {
    const { calls, words } = harness(failOn(USAGE_LIMIT));
    await expect(words.at(5).readMany(manyIndices(words, 1000))).rejects.toBe(USAGE_LIMIT);
    expect(calls.storage.length).toBeLessThanOrEqual(32 + 1 + 16);
  });

  it.each([
    ['retryable', RATE_LIMITED],
    ['exhausted', USAGE_LIMIT],
    ['exhausted, by status', rpcError('x', { statusCode: 403 })],
    ['fatal', new Error('nope')],
    ['a package error', new StorageDecoderError('nope')],
    ['a TypeError', new TypeError('nope')],
    ['a fetch failure', new TypeError('fetch failed', { cause: rpcError('x', { code: 'ETIMEDOUT' }) })],
  ])('holds budget + 1 + limit for %s, and rejects with that same error', async (_name, failure) => {
    const { calls, words } = harness(failOn(failure));
    await expect(words.at(5).readMany(manyIndices(words, 1000))).rejects.toBe(failure);
    expect(calls.storage.length).toBeLessThanOrEqual(32 + 1 + 16);
  });

  it('stops at a fatal failure straight away, once what is in flight has landed', async () => {
    const error = new Error('nope');
    const { calls, words } = harness((slot) => (slot === 3n ? undefined : error));
    await expect(words.at(5).readMany(manyIndices(words, 100))).rejects.toBe(error);
    expect(calls.storage.length).toBeLessThanOrEqual(16);
  });

  it('is per call: a later call starts afresh', async () => {
    const { calls, words } = harness(failOn(RATE_LIMITED), { retry: { budget: 1 } });
    await expect(words.at(5).readAll()).rejects.toBe(RATE_LIMITED);
    const first = calls.storage.length;
    await expect(words.at(5).readAll()).rejects.toBe(RATE_LIMITED);
    expect(calls.storage.length).toBe(first * 2);
  });

  it('allows that many failures before tripping, not one fewer', async () => {
    const { calls, words } = harness(failOn(RATE_LIMITED), {
      maxConcurrentReads: 1,
      retry: { budget: 2, maxAttempts: 10 },
    });
    await expect(words.at(5).readAll()).rejects.toBe(RATE_LIMITED);
    // Two failures are within the budget and retried; the third trips it.
    expect(calls.storage).toHaveLength(3);
  });

  it('reports a value when failures stay under it', async () => {
    const { words } = harness((slot, attempt) => (slot !== 3n && attempt === 1 && slot % 2n === 0n ? RATE_LIMITED : undefined));
    const results = await words.at(5).readMany(manyIndices(words, 20));
    expect(results).toHaveLength(20);
  });
});

describe('settling stops what is left', () => {
  it('read() rejects reads still queued behind the shared limit, unsent', async () => {
    const { calls, context, words } = harness(() => undefined, { maxConcurrentReads: 1 });
    let releaseCode = (_code: string): void => {};
    let codeCalls = 0;
    context.getCode = () => {
      codeCalls += 1;
      return new Promise<string>((resolve) => {
        releaseCode = resolve;
      });
    };
    const unloadable = new Error('artifact unreadable');
    context.getDeployedBytecode = async (fqn) => {
      if (fqn === STRINGS) throw unloadable;
      return '0x6080';
    };

    // The first read's contract check holds the only permit, so the second has nothing sent yet.
    const first = words.at(5).index(0).read();
    await new Promise((resolve) => setTimeout(resolve, 1));
    const second = new StorageQueryBuilder(context).contract(STRINGS).target(TARGET).name('longText').at(5).read();
    await expect(second).rejects.toBe(unloadable);

    releaseCode('0x6080');
    await expect(first).resolves.toMatchObject({ value: 1n });
    expect(codeCalls).toBe(1);
    expect(calls.storage).toEqual([3n, arrayBase(3n)]);
  });

  it('read() ends a backoff in progress, which frees its permit', async () => {
    const cancelled: number[] = [];
    let failing = true;
    let releaseArtifact = (_code: string): void => {};
    const element = arrayBase(3n);
    const { calls, context, words } = harness(
      (slot) => (failing && slot === element ? RATE_LIMITED : undefined),
      { maxConcurrentReads: 1 },
      {
        // Only ever ends by being cancelled, to catch a backoff that outlives its call.
        sleep: (ms) => {
          let cancel = (): void => {};
          const elapsed = new Promise<void>((resolve) => {
            cancel = () => {
              cancelled.push(ms);
              resolve();
            };
          });
          return { elapsed, cancel };
        },
      }
    );
    context.getCode = async () => '0x6080';
    context.getDeployedBytecode = () =>
      new Promise((resolve) => {
        releaseArtifact = resolve;
      });

    const pending = words.at(5).index(0).read();
    await quiescent();
    expect(calls.storage).toEqual([3n, element]);
    expect(cancelled).toEqual([]);

    releaseArtifact('0x6081');
    await expect(pending).rejects.toBeInstanceOf(ContractMismatchError);
    expect(cancelled).toHaveLength(1);

    failing = false;
    context.getDeployedBytecode = async () => '0x6080';
    await expect(words.at(5).index(0).read()).resolves.toMatchObject({ value: 1n });
    expect(calls.storage.filter((slot) => slot === element)).toHaveLength(2);
  });

  it('readMany stops at a failure, and sends none of the later queries', async () => {
    const error = new Error('element 0 unreadable');
    const element = arrayBase(3n);
    const { calls, words } = harness((slot) => (slot === element ? error : undefined), {
      maxConcurrentReads: 1,
    });
    const queries = Array.from({ length: 20 }, (_unused, i) => words.at(5).index(i));
    await expect(words.at(5).readMany(queries)).rejects.toBe(error);
    expect(calls.storage).toEqual([3n, element]);
  });

  it('readMany still reports the first failing query in the list, not the first in time', async () => {
    const first = new Error('query 0, which fails last');
    const second = new Error('query 1, which fails first');
    const { context, words } = harness(() => undefined);
    const base = arrayBase(3n);
    context.getStorageAt = async ({ slot }) => {
      if (slot === base) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw first;
      }
      if (slot === base + 1n) throw second;
      return word(5000);
    };
    await expect(words.at(5).readMany([words.at(5).index(0), words.at(5).index(1)])).rejects.toBe(first);
  });

  it('rejects a stopped batch whole, with no value from a query left unfinished', async () => {
    const refused = new Error('refused');
    const text = 'z'.repeat(320);
    const storage = new MockStorage().setString(1n, text);
    const refusedSlot = 5n; // texts.length
    const sent: bigint[] = [];
    const { context } = harness(() => undefined, { maxConcurrentReads: 1 });
    context.getStorageAt = async ({ slot }) => {
      sent.push(slot);
      if (slot === refusedSlot) throw refused;
      return storage.get(slot);
    };
    const decoder = new StorageQueryBuilder(context);
    const longText = decoder.contract(STRINGS).target(TARGET).at(5).name('longText');
    // The string's header goes first, so its data slots queue up behind the refused read.
    const other = decoder.contract(STRINGS).target(TARGET).at(5).name('texts');

    await expect(decoder.readMany([longText, other.index(0)])).rejects.toBe(refused);
    expect(sent).toContain(1n);
    expect(sent).not.toContain(arrayBase(1n));

    // The same string on its own does come back, so it was the stop that held it back.
    context.getStorageAt = async ({ slot }) => storage.get(slot);
    await expect(longText.read()).resolves.toMatchObject({ value: text });
  });

  describe('a failure can mask a wrong address in another query of the batch', () => {
    const refused = new Error('refused');

    /** A wrong address on ARRAYS, and a query on STRINGS whose read is refused. */
    function batch(layoutHeldBy?: Promise<void>) {
      const { context } = harness((slot) => (slot === 1n ? refused : undefined));
      context.getLayout = async (fqn) => {
        if (fqn === ARRAYS) await layoutHeldBy;
        return loadLayout(fqn);
      };
      context.getCode = async () => '0x6080';
      context.getDeployedBytecode = async (fqn) => (fqn === ARRAYS ? '0x6081' : '0x6080');
      const decoder = new StorageQueryBuilder(context);
      return decoder.readMany([
        decoder.contract(ARRAYS).target(TARGET).name('words').at(5).index(0),
        decoder.contract(STRINGS).target(TARGET).name('longText').at(5),
      ]);
    }

    it('reports the mismatch when its contract check went out first', async () => {
      await expect(batch()).rejects.toBeInstanceOf(ContractMismatchError);
    });

    it('reports the stopping failure when its layout loads too late to send the check', async () => {
      let releaseLayout = (): void => {};
      const layoutHeldBy = new Promise<void>((resolve) => {
        releaseLayout = resolve;
      });
      const outcome = expect(batch(layoutHeldBy)).rejects.toBe(refused);
      await quiescent();
      releaseLayout();
      await outcome;
    });
  });

  it('leaves nothing unhandled when a trip rejects queued reads no one awaits', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { words } = harness(failOn(RATE_LIMITED), { retry: { budget: 1 } });
      const queries = Array.from({ length: 50 }, (_unused, i) => words.at(5).index(i));
      await expect(words.at(5).readMany(queries)).rejects.toBe(RATE_LIMITED);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
