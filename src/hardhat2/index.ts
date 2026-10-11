/**
 * hardhat-storage-decoder — Hardhat 2.x entrypoint.
 *
 * Register it the way Hardhat 2 registers every plugin, with a side-effect import at the top of
 * `hardhat.config`:
 *
 * ```js
 * require("hardhat-storage-decoder/hardhat2");
 * ```
 * ```ts
 * import "hardhat-storage-decoder/hardhat2";
 * ```
 *
 * That gives every task an `hre.storageDecoder`:
 *
 * ```ts
 * const { value } = await hre.storageDecoder
 *   .contract("contracts/Vault.sol:Vault")
 *   .target(vaultAddress)
 *   .name("balances")
 *   .key(alice)
 *   .read();
 * ```
 *
 * One recompile is needed after installing, so solc is asked for `storageLayout` — see
 * `ensureStorageLayoutOutput.ts`.
 */

import { extendEnvironment } from 'hardhat/config';
import type { HardhatRuntimeEnvironment } from 'hardhat/types/runtime';
import {
  type StorageDecoderContext,
  type StorageQueryBuilder,
  createStorageDecoder,
} from '../core/query/StorageQueryBuilder.js';
import { ensureStorageLayoutOutput } from './ensureStorageLayoutOutput.js';
import { createBuildInfoReader } from './readBuildInfo.js';
import { createGetBlockNumber, createGetCode, createGetStorageAt } from './provider.js';

// Registered at import time: `extendConfig` and `subtask` must both run before Hardhat resolves
// the config and builds its task graph.
ensureStorageLayoutOutput();

/**
 * Wire the Hardhat-free core to one Hardhat 2 environment.
 *
 * Exported for code that already holds an HRE and wants its own decoder rather than the one on
 * `hre.storageDecoder` — both are built the same way.
 *
 * Like every Hardhat 2 plugin, this module must be loaded from `hardhat.config` (or at least
 * after `require("hardhat")` has created the Hardhat context): `subtask` and `extendConfig`
 * above run at import time and throw HH5 ("HardhatContext is not created") without one.
 * Registering it any later than the config also means the compiler-input override never takes
 * effect for that run.
 *
 * @param hre - The Hardhat 2 runtime environment to read artifacts and the network provider from.
 * The provider is only touched when a query runs, not when this is called.
 * @returns A new query builder bound to `hre`. Its chain methods never throw; the terminal
 * methods (`.read()` and the others) reject with the core query errors, which are re-exported
 * from this module.
 */
export function createHardhatStorageDecoder(hre: HardhatRuntimeEnvironment): StorageQueryBuilder {
  const buildInfo = createBuildInfoReader(hre);
  /** Reads `hre.network.provider` only when called, so no network starts at construction. */
  const getProvider = () => hre.network.provider;

  const context: StorageDecoderContext = {
    getLayout: buildInfo.getLayout,
    getStorageAt: createGetStorageAt(getProvider),
    // Supplying both of these is what enables the contract/address sanity check in the query
    // builder; the check is skipped entirely when either is absent.
    getDeployedBytecode: buildInfo.getDeployedBytecode,
    getCode: createGetCode(getProvider),
    // Lets a dump of `latest` resolve the block once and read everything at that number.
    getBlockNumber: createGetBlockNumber(getProvider),
  };

  return createStorageDecoder(context);
}

extendEnvironment((hre) => {
  /** Built on first access and reused afterwards. */
  let decoder: StorageQueryBuilder | undefined;

  // A getter, not Hardhat's `lazyObject`: `lazyObject` returns a Proxy, and the builder is a
  // class instance with `#private` fields, whose brand checks throw when reached through one.
  // The laziness still matters for a different reason — `createHardhatStorageDecoder` closes
  // over `hre.network.provider` without reading it, so no network is started until a query is
  // actually run.
  Object.defineProperty(hre, 'storageDecoder', {
    configurable: true,
    enumerable: true,
    get(): StorageQueryBuilder {
      decoder ??= createHardhatStorageDecoder(hre);
      return decoder;
    },
  });
});

declare module 'hardhat/types/runtime' {
  /** Hardhat 2's runtime environment, extended with `storageDecoder`. */
  interface HardhatRuntimeEnvironment {
    /**
     * Read a contract's storage by variable name and a kind-checked path.
     *
     * Each chain method returns a new builder, so a partial chain is reusable:
     *
     * ```ts
     * const vault = hre.storageDecoder.contract("contracts/Vault.sol:Vault").target(address);
     * const alice = await vault.name("balances").key(aliceAddress).read();
     * const bob = await vault.name("balances").key(bobAddress).read();
     * ```
     */
    readonly storageDecoder: StorageQueryBuilder;
  }
}

export { StorageLayoutNotAvailableError } from './readBuildInfo.js';
export type { BuildInfoReader } from './readBuildInfo.js';
export { ensureStorageLayoutOutput } from './ensureStorageLayoutOutput.js';

// Re-exported so a consumer can `instanceof`-check failures and annotate results without
// reaching past the subpath they installed.
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
  UnsupportedTypeError,
  VariableNotFoundError,
} from '../core/query/errors.js';
export { StorageQueryBuilder } from '../core/query/StorageQueryBuilder.js';
export type { StorageDecoderContext, StorageReadResult } from '../core/query/StorageQueryBuilder.js';
export type { DumpValue, ReadAllOptions, StorageDumpResult } from '../core/query/dump.js';
export type { BlockTag } from '../core/rpc/getStorageAt.js';
export type { DecodedValue } from '../core/slots/decode.js';
export type { MappingKeyValue, PathSegment } from '../core/slots/deriveSlot.js';
// The layout helpers the error messages and `USAGE.md` refer to, for code that parses a
// `storageLayout` blob itself.
export {
  extractConstantAndImmutableNames,
  extractDeclaringContracts,
  extractUserDefinedValueTypes,
  parseStorageLayout,
} from '../core/layout/parseStorageLayout.js';
export type {
  ParseStorageLayoutOptions,
  ParsedStorageLayout,
  RawStorageLayout,
} from '../core/layout/parseStorageLayout.js';
