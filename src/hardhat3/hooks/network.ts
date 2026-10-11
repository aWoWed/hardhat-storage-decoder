/**
 * `network` hook-handler category for the Hardhat 3 plugin.
 *
 * `newConnection` is HH3's seam for decorating a connection — the same one Hardhat's own
 * network plugins use — and is why `.storageDecoder` hangs off the connection rather than
 * off the HRE: in HH3 the provider itself only exists per connection.
 */

import type { HookContext } from 'hardhat/types/hooks';
import type { ChainType, NetworkConnection } from 'hardhat/types/network';
import type { HookHandlerCategoryFactory } from 'hardhat/types/plugins';
import { attachStorageDecoder } from '../storageDecoder.js';

/** A named export, not a default one; see the note in `./config.ts`. */
export const networkHooks: HookHandlerCategoryFactory<'network'> = async () => ({
  /** Decorate each new connection with `.storageDecoder`. */
  async newConnection<ChainTypeT extends ChainType | string>(
    context: HookContext,
    next: (nextContext: HookContext) => Promise<NetworkConnection<ChainTypeT>>
  ): Promise<NetworkConnection<ChainTypeT>> {
    // `next` first: the connection (and its provider) must exist before it can be decorated.
    return attachStorageDecoder(await next(context), context.artifacts);
  },
});
