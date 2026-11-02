/**
 * Sorting a failed RPC call into what the retry layer should do with it.
 *
 * This is the shared default and works from the shape of an error only: `code`, `message`,
 * `statusCode` and the `cause`/`parent` chain. Each Hardhat adapter supplies its own classifier
 * through `StorageDecoderContext.classifyRpcError`, handles what only Hardhat can tell (its
 * error numbers, and that its own 429 retries have run out), and falls back to this one.
 *
 * The wordings are what nodes send, not what Hardhat adds, and the ones below without a
 * standard behind them were taken from a read-only Sepolia probe. Anything unrecognised is
 * `fatal`: it propagates unchanged and is never re-sent.
 */

/**
 * What to do about a failed call:
 *  - `retryable`: re-send after a backoff, while attempts and the call's budget last;
 *  - `exhausted`: never re-send, since waiting a moment cannot help, but consume budget, so
 *    that a large `readMany` stops asking an endpoint that has already refused;
 *  - `pruned`: the node no longer holds this block's state; raised as `PrunedStateError`;
 *  - `fatal`: propagate unchanged, no budget consumed.
 *
 * Whichever the class, a failure that ends a call for good means the terminal method will reject,
 * so `pruned` and `fatal` stop its queued calls at once, and `exhausted` once the budget is passed.
 */
export type RpcErrorClass = 'retryable' | 'exhausted' | 'pruned' | 'fatal';

/**
 * The node no longer holds the state. "pruned history unavailable" is the wording of error 4444;
 * the others are the geth-family forms. Not a bare "pruned", which a host name can contain.
 */
const PRUNED_WORDING = /pruned history|missing trie node|historical state|\bstate\b.*\bnot available/i;
/** EIP-4444's "pruned history unavailable". */
const PRUNED_CODE = 4444;

/**
 * A plan or quota refusal. Its reset was not seen within minutes, or it never resets, so the
 * short backoff here cannot help; it is `exhausted` and not `fatal` so that it stops the call.
 */
const QUOTA_WORDING = /usage limit|free plan/i;

/** A limit on the request rate, which a short wait does help. */
const RATE_WORDING = /\brate.?limit|too many requests|too fast|\bcu limit\b/i;
/** EIP-1474's "limit exceeded". */
export const LIMIT_EXCEEDED_CODE = -32005;

/**
 * Worth re-sending: a block the same node had just reported was seen to be briefly unknown to
 * it, which suggests lag between the backends behind one URL. A block above the head gets the
 * same message, so it costs a few bounded attempts and then fails with the node's own error.
 */
const LAG_WORDING = /\b(?:block|header) not found\b/i;

/** Connection and timeout failures, by the `code` Node and undici give them. */
const TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** Enough for any real wrapping; only guards against an absurdly long chain. */
const MAX_CHAIN_LENGTH = 16;

/** The fields of an error, or of anything it wraps, that classifying looks at. */
interface ErrorShape {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly statusCode?: unknown;
  readonly cause?: unknown;
  readonly parent?: unknown;
}

/**
 * An error and everything it wraps, outermost first. A cycle is followed once.
 *
 * @param error - The failure; a value that is not an object has no fields, and gives no nodes.
 * @returns The objects on its `cause` and `parent` chains, itself included.
 */
function errorChain(error: unknown): ErrorShape[] {
  const chain: ErrorShape[] = [];
  const pending = [error];
  while (pending.length > 0 && chain.length < MAX_CHAIN_LENGTH) {
    const next = pending.shift();
    if (typeof next !== 'object' || next === null || chain.includes(next)) continue;
    chain.push(next);
    pending.push((next as ErrorShape).cause, (next as ErrorShape).parent);
  }
  return chain;
}

/**
 * Whether a connection or timeout failure is at the bottom of an error, whatever wraps it. Node's
 * `fetch` reports one as `TypeError('fetch failed', { cause })`.
 *
 * @param error - The failure.
 * @returns `true` when it or anything on its `cause` and `parent` chains has a transport `code`.
 */
export function isTransportFailure(error: unknown): boolean {
  return errorChain(error).some(
    (node) => typeof node.code === 'string' && TRANSPORT_CODES.has(node.code)
  );
}

/**
 * Whether an HTTP status says the same request may succeed shortly.
 *
 * @param status - The `statusCode` of an error, if it has one.
 * @returns `true` for 408, 425, 429 and 5xx.
 */
function isRetryableStatus(status: unknown): boolean {
  if (typeof status !== 'number') return false;
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

/**
 * Whether an HTTP status is a refusal a re-send cannot change, such as a bad key or a plan limit.
 *
 * @param status - The `statusCode` of an error, if it has one.
 * @returns `true` for a 4xx that {@link isRetryableStatus} does not take.
 */
function isRefusalStatus(status: unknown): boolean {
  return typeof status === 'number' && status >= 400 && status < 500 && !isRetryableStatus(status);
}

/**
 * The default classification of a failed RPC call.
 *
 * Transport codes come first, because the message of such a failure quotes the host name and
 * says nothing about the node's state. Then wording, before the other codes, because one code
 * can mean several things: endpoints use -32001 both for "block not found" and for "usage limit".
 *
 * @param error - What the context's function threw or rejected with.
 * @returns Its class; `fatal` for anything not recognised, including -32601 and -32602.
 */
export function classifyRpcError(error: unknown): RpcErrorClass {
  if (isTransportFailure(error)) return 'retryable';
  const chain = errorChain(error);
  const wording = chain
    .map((node) => (typeof node.message === 'string' ? node.message : ''))
    .join('\n');

  if (PRUNED_WORDING.test(wording) || chain.some((node) => node.code === PRUNED_CODE)) {
    return 'pruned';
  }
  if (QUOTA_WORDING.test(wording)) return 'exhausted';
  if (RATE_WORDING.test(wording) || LAG_WORDING.test(wording)) return 'retryable';

  if (chain.some((node) => node.code === LIMIT_EXCEEDED_CODE || isRetryableStatus(node.statusCode))) {
    return 'retryable';
  }
  return chain.some((node) => isRefusalStatus(node.statusCode)) ? 'exhausted' : 'fatal';
}
