/**
 * Hardhat 3: the three RPC reads of `src/core/rpc/createRpcReaders.ts`, over an EIP-1193 provider.
 *
 * In HH3 the provider comes from a `NetworkConnection` (created by `hre.network.create()` or
 * `getOrCreate()`; `connect()` is deprecated), not from a global `hre.network.provider` as in
 * HH2 — which is why the decoder is exposed on the connection rather than on the HRE.
 *
 * `request()` is used rather than the legacy `send()`: `send` is marked `@deprecated` on
 * `EthereumProvider` in `hardhat@3.13.0`.
 */

import type { EthereumProvider } from 'hardhat/types/providers';
import { LIMIT_EXCEEDED_CODE, type RpcErrorClass, classifyRpcError } from '../core/rpc/classifyRpcError.js';
import { type RpcReaders, createRpcReaders } from '../core/rpc/createRpcReaders.js';

/** Hardhat 3's `HardhatError` numbers for a non-JSON-RPC reply, connection refused, and timeout. */
const TRANSPORT_ERROR_NUMBERS: ReadonlySet<unknown> = new Set([702, 703, 704]);

/**
 * What the retry layer should do about a provider failure, for what only Hardhat 3 can tell.
 *
 * Its provider has already retried an HTTP 429 and gives up with a -32005 whose cause has that
 * status, so sending again would stack a second round of retries on the first. If that shape
 * ever changes, it falls back to `retryable`, which is safe.
 *
 * @param error - What the provider's `request` rejected with.
 * @returns The class; everything not recognised here is left to the core's `classifyRpcError`.
 */
export function classifyProviderError(error: unknown): RpcErrorClass {
  const { code, cause, number } = (error ?? {}) as {
    code?: unknown;
    cause?: { statusCode?: unknown } | null;
    number?: unknown;
  };
  if (code === LIMIT_EXCEEDED_CODE && cause?.statusCode === 429) return 'exhausted';
  // Before the core's wording checks: these messages quote the network's name or a whole reply
  // body, which say nothing about the node's state.
  if (TRANSPORT_ERROR_NUMBERS.has(number)) return 'retryable';
  return classifyRpcError(error);
}

/**
 * The three RPC reads, on one connection's EIP-1193 provider.
 *
 * @param provider - The connection's provider.
 * @returns The readers; see {@link createRpcReaders} for what they throw.
 */
export function createProviderReaders(provider: Pick<EthereumProvider, 'request'>): RpcReaders {
  return createRpcReaders(
    (method, params) => provider.request({ method, params }),
    (method, result) => `${method} returned ${result === null ? 'null' : typeof result}, expected a hex string`
  );
}
