/**
 * Hardhat 2: the three RPC reads of `src/core/rpc/createRpcReaders.ts`, over its provider's `send`.
 *
 * Hardhat 2 exposes one provider for the whole run at `hre.network.provider`, an
 * `EthereumProvider` with a legacy `send(method, params)` helper on top of EIP-1193.
 *
 * The provider is reached through a getter rather than captured up front: touching
 * `hre.network.provider` is what makes Hardhat initialize the network, and doing that at plugin
 * registration would spin up a node for every task, including ones that never read storage.
 */

import type { EthereumProvider } from 'hardhat/types/provider';
import { LIMIT_EXCEEDED_CODE, type RpcErrorClass, classifyRpcError } from '../core/rpc/classifyRpcError.js';
import { type RpcReaders, createRpcReaders } from '../core/rpc/createRpcReaders.js';

/** Called at query time, never at registration; see the file header for why. */
type ProviderGetter = () => EthereumProvider;

/** Hardhat 2's `HardhatError` numbers for connection refused, timeout, and a non-JSON-RPC reply. */
const TRANSPORT_ERROR_NUMBERS: ReadonlySet<unknown> = new Set([108, 109, 110]);

/**
 * What the retry layer should do about a provider failure, for what only Hardhat 2 can tell.
 *
 * Its provider has already retried an HTTP 429 and gives up with its own -32005, so sending
 * again would stack a second round of retries on the first. It also discards a status other than
 * 429 and reports an unparseable body as error 110, so a 503 cannot be told from a 401 there:
 * such a failure is retried, within bounds, whatever the body says. If Hardhat's wording ever
 * changes, its 429 falls back to `retryable`, which is safe.
 *
 * @param error - What the provider's `send` rejected with.
 * @returns The class; everything not recognised here is left to the core's `classifyRpcError`.
 */
export function classifyProviderError(error: unknown): RpcErrorClass {
  const { code, message, number } = (error ?? {}) as {
    code?: unknown;
    message?: unknown;
    number?: unknown;
  };
  if (
    code === LIMIT_EXCEEDED_CODE &&
    typeof message === 'string' &&
    message.startsWith('Too Many Requests error received from')
  ) {
    return 'exhausted';
  }
  // Before the core's wording checks: these messages quote the network's name or a whole reply
  // body, which say nothing about the node's state.
  if (TRANSPORT_ERROR_NUMBERS.has(number)) return 'retryable';
  return classifyRpcError(error);
}

/**
 * The three RPC reads, on Hardhat 2's `send`.
 *
 * @param getProvider - Resolves the provider on each call, so no network starts at construction.
 * @returns The readers; see {@link createRpcReaders} for what they throw.
 */
export function createProviderReaders(getProvider: ProviderGetter): RpcReaders {
  return createRpcReaders(
    (method, params) => getProvider().send(method, params as unknown[]),
    (method, result, { address, slot }) =>
      `${method} returned ${typeof result}, expected a hex string` +
      ` (address ${address}${slot === undefined ? '' : `, slot ${slot}`})`
  );
}
