/**
 * Wiring: turn a Hardhat 3 `NetworkConnection` into one carrying `.storageDecoder`.
 *
 * This is the only place the HH3-specific pieces (layout reading, storage reads, code reads,
 * block-number reads) are joined into the core's `StorageDecoderContext`.
 */

import type { ArtifactManager } from 'hardhat/types/artifacts';
import type { EthereumProvider } from 'hardhat/types/providers';
import {
  type StorageDecoderContext,
  type StorageQueryBuilder,
  createStorageDecoder,
} from '../core/index.js';
import { createGetBlockNumber, createGetCode, createGetStorageAt } from './provider.js';
import { Hardhat3LayoutReader } from './readBuildInfo.js';

/**
 * One reader per `ArtifactManager`, so the build-info output is parsed once per project
 * rather than once per network connection. Weak so it never keeps an HRE alive.
 */
const readers = new WeakMap<ArtifactManager, Hardhat3LayoutReader>();

/** The shared reader for an artifact manager, created on first use (see `readers`). */
function readerFor(artifacts: ArtifactManager): Hardhat3LayoutReader {
  const existing = readers.get(artifacts);
  if (existing !== undefined) return existing;
  const created = new Hardhat3LayoutReader(artifacts);
  readers.set(artifacts, created);
  return created;
}

/**
 * Build the core's I/O context from an artifact manager and a connection's provider.
 *
 * @param artifacts - The project's artifact manager, used for layouts and deployed bytecode.
 * @param provider - The connection's provider, used for storage, code and block-number reads.
 * @returns A context for the core's `createStorageDecoder`.
 */
export function createStorageDecoderContext(
  artifacts: ArtifactManager,
  provider: EthereumProvider
): StorageDecoderContext {
  const reader = readerFor(artifacts);
  return {
    getLayout: (fullyQualifiedName) => reader.getLayout(fullyQualifiedName),
    getStorageAt: createGetStorageAt(provider),
    // Supplying BOTH of these is what enables the query builder's ContractMismatchError
    // heuristic; supplying only one silently disables the check.
    getDeployedBytecode: (fullyQualifiedName) => reader.getDeployedBytecode(fullyQualifiedName),
    getCode: createGetCode(provider),
    // Lets a dump of `latest` resolve the tag once and read every slot at that block.
    getBlockNumber: createGetBlockNumber(provider),
  };
}

/**
 * Attach `.storageDecoder` to a connection, in place, and return it.
 *
 * Defined as a lazy accessor rather than a plain value for two reasons: every connection
 * gets the property whether or not the plugin is used on it, and `NetworkConnection` declares
 * its members `readonly`, so a getter is the honest way to expose it.
 *
 * @typeParam ConnectionT - The connection type; only `provider` is read.
 * @param connection - The connection to decorate; mutated in place.
 * @param artifacts - The project's artifact manager.
 * @returns `connection`, now with a `storageDecoder` property (configurable and enumerable) that
 *   builds the decoder on first access and reuses it afterwards.
 */
export function attachStorageDecoder<ConnectionT extends { readonly provider: EthereumProvider }>(
  connection: ConnectionT,
  artifacts: ArtifactManager
): ConnectionT {
  let decoder: StorageQueryBuilder | undefined;
  Object.defineProperty(connection, 'storageDecoder', {
    configurable: true,
    enumerable: true,
    get(): StorageQueryBuilder {
      decoder ??= createStorageDecoder(
        createStorageDecoderContext(artifacts, connection.provider)
      );
      return decoder;
    },
  });
  return connection;
}
