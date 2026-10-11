/**
 * The Hardhat 2 half of `src/core/rpc/getStorageAt.ts`.
 *
 * Hardhat 2 exposes one provider for the whole run at `hre.network.provider`, an
 * `EthereumProvider` with a legacy `send(method, params)` helper on top of EIP-1193.
 *
 * The provider is reached through a getter rather than captured up front: touching
 * `hre.network.provider` is what makes Hardhat initialize the network, and doing that at plugin
 * registration would spin up a node for every task, including ones that never read storage.
 */

import type { EthereumProvider } from 'hardhat/types/provider';
import {
  type BlockTag,
  type GetStorageAt,
  formatBlockTag,
  formatSlot,
  parseBlockNumber,
} from '../core/rpc/getStorageAt.js';
import { toStorageWord } from '../core/util/bytes.js';

/** Called at query time, never at registration; see the file header for why. */
export type ProviderGetter = () => EthereumProvider;

/**
 * `eth_getStorageAt`, normalized to exactly 32 bytes.
 *
 * Nodes are inconsistent about short-form results (`0x0` and `0x00...00` both occur for an
 * empty slot), so every response goes through `toStorageWord`, which left-pads to a full word
 * and rejects anything longer than one.
 *
 * @param getProvider - Resolves the provider on each call.
 * @returns The reader; it resolves to the slot's 32-byte word.
 * @throws {TypeError} from the returned function (never from this factory), when the node's
 * response is not a string or not valid hex, or when {@link formatSlot} or
 * {@link formatBlockTag} rejects the slot or block tag.
 * @throws {RangeError} when the response is longer than 32 bytes.
 * @throws Any error the provider's `send` rejects with.
 */
export function createGetStorageAt(getProvider: ProviderGetter): GetStorageAt {
  return async ({ address, slot, blockTag }) => {
    const result: unknown = await getProvider().send('eth_getStorageAt', [
      address,
      formatSlot(slot),
      formatBlockTag(blockTag),
    ]);
    if (typeof result !== 'string') {
      throw new TypeError(
        `eth_getStorageAt returned ${typeof result}, expected a hex string` +
          ` (address ${address}, slot ${formatSlot(slot)})`
      );
    }
    return toStorageWord(result);
  };
}

/**
 * `eth_getCode`, used only by the contract/address sanity check in the query builder.
 *
 * Returns `"0x"` for an address with no code; the builder turns that into a
 * `ContractMismatchError` rather than decoding a layout against an empty account.
 *
 * @param getProvider - Resolves the provider on each call.
 * @returns A reader resolving to the account's code as a hex string.
 * @throws {TypeError} from the returned function (never from this factory), when the node's
 * response is not a string.
 * @throws Whatever {@link formatBlockTag} throws for an invalid block tag.
 * @throws Any error the provider's `send` rejects with.
 */
export function createGetCode(
  getProvider: ProviderGetter
): (address: string, blockTag: BlockTag) => Promise<string> {
  return async (address, blockTag) => {
    const result: unknown = await getProvider().send('eth_getCode', [
      address,
      formatBlockTag(blockTag),
    ]);
    if (typeof result !== 'string') {
      throw new TypeError(
        `eth_getCode returned ${typeof result}, expected a hex string (address ${address})`
      );
    }
    return result;
  };
}

/**
 * `eth_blockNumber`, used by a dump to turn `latest` into one fixed block for all of its reads.
 *
 * @param getProvider - Resolves the provider on each call.
 * @returns A function resolving to the current block number.
 * @throws Whatever {@link parseBlockNumber} throws for a response that is not a block number
 * (raised from the returned function).
 * @throws Any error the provider's `send` rejects with.
 */
export function createGetBlockNumber(getProvider: ProviderGetter): () => Promise<bigint> {
  return async () => {
    return parseBlockNumber(await getProvider().send('eth_blockNumber', []));
  };
}
