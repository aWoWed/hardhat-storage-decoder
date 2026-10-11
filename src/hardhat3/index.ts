/**
 * `hardhat-storage-decoder/hardhat3` — the Hardhat 3.x adapter.
 *
 * ## Usage
 *
 * ```ts
 * // hardhat.config.ts
 * import storageDecoderPlugin from "hardhat-storage-decoder/hardhat3";
 *
 * export default {
 *   plugins: [storageDecoderPlugin],
 *   solidity: "0.8.26",
 * };
 * ```
 *
 * ```ts
 * // getOrCreate() reuses an existing connection if one is open. `connect()` also works (the
 * // decoder is attached via the `network.newConnection` hook regardless of which entrypoint
 * // was used) but is deprecated as of hardhat@3.13.0 in favour of `create()`/`getOrCreate()`.
 * const connection = await hre.network.getOrCreate();
 * const { value } = await connection.storageDecoder
 *   .contract("contracts/Vault.sol:Vault")
 *   .target(vaultAddress)
 *   .name("balances")
 *   .key(alice)
 *   .read();
 * ```
 *
 * HH3 plugins are registered by listing them in the config's `plugins` array — importing this
 * module for side effects does nothing, unlike the HH2 adapter.
 *
 * ## Two deliberate implementation choices
 *
 * 1. **Nothing here imports `hardhat` at runtime — only `import type`.** `hardhat@3` is
 *    ESM-only (`"type": "module"`, no `require` condition in its `exports` map), so a runtime
 *    import would make this package's CommonJS build throw `ERR_REQUIRE_ESM` on
 *    `require("hardhat-storage-decoder/hardhat3")`. The cost is that we do not call
 *    `definePlugin()` from `hardhat/plugins`; that helper only registers the plugin id in a
 *    process-wide set the CLI uses to warn about plugins imported but not listed in
 *    `plugins`, so skipping it loses a diagnostic, not behavior.
 *
 * 2. **`.storageDecoder` is attached via the `network.newConnection` hook**, so it is
 *    available on every connection including ones created by test runners.
 */

import type { ChainType, DefaultChainType } from 'hardhat/types/network';
import type { HardhatPlugin } from 'hardhat/types/plugins';
import type { StorageQueryBuilder } from '../core/index.js';

// Type side only; the property itself is attached by the `network.newConnection` hook in
// `./hooks/network.ts`.
declare module 'hardhat/types/network' {
  /**
   * A Hardhat 3 network connection, extended with the storage decoder.
   *
   * The type-parameter list here must stay character-for-character identical to Hardhat's own
   * declaration of `NetworkConnection` — same name, same constraint, same default. TypeScript
   * raises TS2428 ("All declarations of 'NetworkConnection' must have identical type
   * parameters") on any divergence, including a merely-equivalent one.
   *
   * @typeParam ChainTypeT - The connection's chain type; mirrors Hardhat's own parameter and is
   *   not used by the added member.
   */
  export interface NetworkConnection<ChainTypeT extends ChainType | string = DefaultChainType> {
    /**
     * Fluent, immutable storage query rooted at this connection's provider.
     *
     * Created lazily on first access and then reused for the life of the connection.
     */
    readonly storageDecoder: StorageQueryBuilder;
  }
}

/**
 * The plugin object to put in your config's `plugins` array.
 *
 * Hook handlers are declared as lazy `import()` factories, matching Hardhat's own first-party
 * plugins: each category is loaded at most once, and only if something actually triggers that
 * category's hooks.
 *
 * - `id` / `npmPackage`: the identifiers Hardhat uses to register and de-duplicate the plugin.
 * - `hookHandlers.config`: loads `./hooks/config.ts`, which injects the `storageLayout` solc
 *   output selector.
 * - `hookHandlers.network`: loads `./hooks/network.ts`, which attaches `.storageDecoder` to each
 *   new connection.
 */
export const storageDecoderPlugin: HardhatPlugin = {
  id: 'hardhat-storage-decoder',
  npmPackage: 'hardhat-storage-decoder',
  hookHandlers: {
    config: async () => ({ default: (await import('./hooks/config.js')).configHooks }),
    network: async () => ({ default: (await import('./hooks/network.js')).networkHooks }),
  },
};

export default storageDecoderPlugin;

export {
  MANUAL_OUTPUT_SELECTION_SNIPPET,
  MissingStorageLayoutError,
  STORAGE_LAYOUT_SELECTOR,
  withStorageLayoutOutputSelection,
} from './ensureStorageLayoutOutput.js';
export { Hardhat3LayoutReader } from './readBuildInfo.js';
export { createGetCode, createGetStorageAt } from './provider.js';
export { attachStorageDecoder, createStorageDecoderContext } from './storageDecoder.js';

// Re-exported so consumers can `instanceof`-check failures and type their own helpers without
// reaching for a second import specifier.
export {
  AmbiguousVariableError,
  ContractMismatchError,
  ContractNotFoundError,
  DumpInconsistentError,
  DumpTooLargeError,
  IndexOutOfBoundsError,
  PathSegmentCountMismatchError,
  PathSegmentKindMismatchError,
  StorageDecoderError,
  StorageQueryBuilder,
  UnsupportedTypeError,
  VariableNotFoundError,
  // The layout helpers the error messages and `USAGE.md` refer to, for code that parses a
  // `storageLayout` blob itself.
  extractConstantAndImmutableNames,
  extractDeclaringContracts,
  extractUserDefinedValueTypes,
  parseStorageLayout,
  type BlockTag,
  type DecodedValue,
  type DumpValue,
  type MappingKeyValue,
  type ParseStorageLayoutOptions,
  type ParsedStorageLayout,
  type PathSegment,
  type RawStorageLayout,
  type ReadAllOptions,
  type StorageDecoderContext,
  type StorageDumpResult,
  type StorageReadResult,
} from '../core/index.js';
