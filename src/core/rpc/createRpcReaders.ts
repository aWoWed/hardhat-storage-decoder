/**
 * The three RPC reads an adapter supplies, over whatever call its provider has. Only the call and
 * the wording of a bad reply differ between adapters; how a failure is classified stays with each.
 */

import { toStorageWord } from '../util/bytes.js';
import {
  type BlockTag,
  type GetStorageAt,
  formatBlockTag,
  formatSlot,
  parseBlockNumber,
} from './getStorageAt.js';

/** The adapter's wording for a reply that is not a string; `slot` is absent for `eth_getCode`. */
type NotHexMessage = (
  method: string,
  result: unknown,
  where: { address: string; slot?: string }
) => string;

export interface RpcReaders {
  getStorageAt: GetStorageAt;
  getCode(address: string, blockTag: BlockTag): Promise<string>;
  getBlockNumber(): Promise<bigint>;
}

/**
 * @param call - Sends one JSON-RPC request. Called only when a reader is, so a provider resolved
 *   inside it is resolved per call.
 * @param notHexMessage - The message of the `TypeError` for a reply that is not a string.
 * @returns The readers. Nothing here throws at construction: each failure rejects the read.
 * @throws {TypeError} from a reader, for a reply that is not a string or not valid hex, or when
 *   {@link formatSlot} or {@link formatBlockTag} rejects the slot or block tag.
 * @throws {RangeError} from `getStorageAt`, for a reply longer than 32 bytes.
 * @throws Whatever {@link parseBlockNumber} throws, from `getBlockNumber`.
 * @throws Any error `call` throws or rejects with.
 */
export function createRpcReaders(
  call: (method: string, params: unknown[]) => unknown,
  notHexMessage: NotHexMessage
): RpcReaders {
  const hexString = (method: string, result: unknown, where: { address: string; slot?: string }): string => {
    if (typeof result !== 'string') throw new TypeError(notHexMessage(method, result, where));
    return result;
  };
  return {
    // `toStorageWord` left-pads: some nodes return a short quantity such as `0x0` for an empty slot.
    getStorageAt: async ({ address, slot, blockTag }) => {
      const params = [address, formatSlot(slot), formatBlockTag(blockTag)];
      const result = await call('eth_getStorageAt', params);
      return toStorageWord(hexString('eth_getStorageAt', result, { address, slot: formatSlot(slot) }));
    },
    getCode: async (address, blockTag) =>
      hexString('eth_getCode', await call('eth_getCode', [address, formatBlockTag(blockTag)]), { address }),
    getBlockNumber: async () => parseBlockNumber(await call('eth_blockNumber', [])),
  };
}
