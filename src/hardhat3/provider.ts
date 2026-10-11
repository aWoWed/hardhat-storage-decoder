/**
 * Hardhat 3: the `GetStorageAt` implementation, over an EIP-1193 provider.
 *
 * In HH3 the provider comes from a `NetworkConnection` (created by `hre.network.create()` or
 * `getOrCreate()`; `connect()` is deprecated), not from a global `hre.network.provider` as in
 * HH2 — which is why the decoder is exposed on the connection rather than on the HRE.
 *
 * `request()` is used rather than the legacy `send()`: `send` is marked `@deprecated` on
 * `EthereumProvider` in `hardhat@3.13.0`.
 */

import type { EthereumProvider } from 'hardhat/types/providers';
import {
  type BlockTag,
  type GetStorageAt,
  formatBlockTag,
  formatSlot,
  parseBlockNumber,
  toStorageWord,
} from '../core/index.js';

/**
 * Narrow a JSON-RPC result to a string.
 *
 * @param result - The value returned by `provider.request`.
 * @param method - RPC method name, used in the error message.
 * @returns `result`, unchanged.
 * @throws {TypeError} when `result` is not a string (the message names `method` and the actual type).
 */
function expectHexString(result: unknown, method: string): string {
  if (typeof result !== 'string') {
    throw new TypeError(
      `${method} returned ${result === null ? 'null' : typeof result}, expected a hex string`
    );
  }
  return result;
}

/**
 * Bind an `eth_getStorageAt` reader to one connection's provider.
 *
 * `toStorageWord` left-pads: some nodes return a shortened quantity (e.g. `"0x0"`) rather
 * than a full 32-byte word, and every decoder in the core assumes exactly 32 bytes.
 *
 * @param provider - The connection's EIP-1193 provider.
 * @returns A `GetStorageAt` that resolves to the slot's 32-byte word.
 * @throws {TypeError} from the returned function (never from this factory), when the node's
 *   reply is not a string or not valid hex, or when {@link formatSlot} or
 *   {@link formatBlockTag} rejects the slot or block tag.
 * @throws {RangeError} when the reply is longer than 32 bytes.
 * @throws Any error the provider's `request` rejects with.
 */
export function createGetStorageAt(provider: EthereumProvider): GetStorageAt {
  return async ({ address, slot, blockTag }) => {
    const result = await provider.request({
      method: 'eth_getStorageAt',
      params: [address, formatSlot(slot), formatBlockTag(blockTag)],
    });
    return toStorageWord(expectHexString(result, 'eth_getStorageAt'));
  };
}

/**
 * Bind an `eth_getCode` reader, used for the contract/address sanity check.
 *
 * @param provider - The connection's EIP-1193 provider.
 * @returns A function resolving to the hex bytecode at `address` for `blockTag`.
 * @throws {TypeError} from the returned function (never from this factory), when the node's
 *   reply is not a string.
 * @throws Whatever {@link formatBlockTag} throws for an invalid block tag.
 * @throws Any error the provider's `request` rejects with.
 */
export function createGetCode(
  provider: EthereumProvider
): (address: string, blockTag: BlockTag) => Promise<string> {
  return async (address, blockTag) => {
    const result = await provider.request({
      method: 'eth_getCode',
      params: [address, formatBlockTag(blockTag)],
    });
    return expectHexString(result, 'eth_getCode');
  };
}

/**
 * Bind an `eth_blockNumber` reader, used to pin a `latest` dump to one block.
 *
 * Returned as a `bigint` so it can be passed straight back as a numeric block tag.
 *
 * @param provider - The connection's EIP-1193 provider.
 * @returns A function resolving to the current block number.
 * @throws Whatever {@link parseBlockNumber} throws for a reply that is not a block number
 *   (raised from the returned function).
 * @throws Any error the provider's `request` rejects with.
 */
export function createGetBlockNumber(provider: EthereumProvider): () => Promise<bigint> {
  return async () => {
    return parseBlockNumber(await provider.request({ method: 'eth_blockNumber', params: [] }));
  };
}
