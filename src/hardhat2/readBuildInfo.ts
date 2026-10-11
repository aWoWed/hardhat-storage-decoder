/**
 * The Hardhat 2 half of "fully-qualified name -> parsed storage layout".
 *
 * Hardhat 2 writes one build-info file per solc run under `artifacts/build-info/`, containing
 * that run's complete input and output, and a per-contract debug file pointing at it.
 * `hre.artifacts.getBuildInfo(fqn)` follows that link, so the layout is read from the compiler's
 * own output rather than from any rendered or post-processed form of it.
 */

import type { HardhatRuntimeEnvironment } from 'hardhat/types/runtime';
import type { BuildInfo } from 'hardhat/types/artifacts';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  type ParsedStorageLayout,
  type RawStorageLayout,
  extractConstantAndImmutableNames,
  extractDeclaringContracts,
  extractUserDefinedValueTypes,
  parseStorageLayout,
} from '../core/layout/parseStorageLayout.js';
import { ContractNotFoundError, StorageDecoderError } from '../core/query/errors.js';
import { type ArtifactStamp, sameStamp, stampOf } from '../shared/artifactStamp.js';

/**
 * The build-info was found, but the compiler was never asked for a storage layout.
 *
 * Distinct from {@link ContractNotFoundError} on purpose: the contract exists and compiled
 * fine, so "check the name" would be the wrong advice. This is a setup problem with exactly
 * one fix, and the message says what it is.
 */
export class StorageLayoutNotAvailableError extends StorageDecoderError {
  /**
   * @param fullyQualifiedName - The contract whose build-info has no `storageLayout`, e.g.
   * `contracts/Vault.sol:Vault`. Kept on the instance and quoted in the message.
   */
  constructor(readonly fullyQualifiedName: string) {
    super(
      `Compiled output for "${fullyQualifiedName}" contains no "storageLayout".` +
        ` hardhat-storage-decoder adds "storageLayout" to solc's outputSelection, but the` +
        ` artifacts on disk predate that. Run "npx hardhat compile" once (or` +
        ` "npx hardhat clean && npx hardhat compile" if it persists).` +
        ` Also confirm that hardhat.config requires/imports "hardhat-storage-decoder/hardhat2"` +
        ` at the top level, and that nothing in the config replaces` +
        ` solidity.settings.outputSelection after the plugin has extended it.`,
      'StorageLayoutNotAvailableError',
      StorageLayoutNotAvailableError
    );
  }
}

/** solc's per-contract output. Hardhat 2's `CompilerOutputContract` predates `storageLayout`. */
interface ContractOutput {
  /** The compiler's storage layout; absent when solc was not asked for it. */
  readonly storageLayout?: RawStorageLayout;
  /** EVM outputs of the contract. */
  readonly evm?: {
    readonly deployedBytecode?: {
      /** Hex bytecode without a `0x` prefix. */
      readonly object?: string
    };
  };
}

/** What one successful load yields for a contract. */
interface CachedContract {
  /** The parsed storage layout. */
  readonly layout: ParsedStorageLayout;
  /** `0x`-prefixed runtime bytecode, or `undefined` when the build-info has none. */
  readonly deployedBytecode: string | undefined;
}

/** One cached load: the promise, and the artifact stamp taken just before it started. */
interface CacheEntry {
  /** `undefined` when no stamp could be taken, i.e. there is nothing to validate against. */
  readonly stamp: ArtifactStamp | undefined;
  /** The in-flight or settled load for the contract. */
  readonly contract: Promise<CachedContract>;
}

/** What is derived from a whole build-info's ASTs, independent of the contract asked for. */
interface BuildAstDerived {
  /** User-defined value types: AST node id or type name -> underlying type identifier. */
  readonly userDefinedValueTypes: Record<string, string>;
  /** AST id of a state variable -> the contract declaring it, as `<source path>:<name>`. */
  readonly declaringContracts: Record<string, string>;
  /** Source name -> names of the constants and immutables declared in that source. */
  readonly constantAndImmutableNamesBySource: ReadonlyMap<string, readonly string[]>;
}

/** Everything the query builder needs from Hardhat 2's artifacts, sharing one cache. */
export interface BuildInfoReader {
  /**
   * The parsed storage layout of a contract.
   *
   * @param fullyQualifiedName - `"<source name>:<contract name>"`, e.g. `contracts/Vault.sol:Vault`.
   * @returns The parsed layout.
   * @throws {ContractNotFoundError} when the name is malformed, Hardhat has no artifact or
   * build-info for it, or the build-info has no such contract.
   * @throws {StorageLayoutNotAvailableError} when the build-info carries no `storageLayout`.
   * @throws {TypeError} when the stored layout is malformed.
   * @throws {UnsupportedTypeError} when the layout uses a type this package cannot decode.
   */
  getLayout(fullyQualifiedName: string): Promise<ParsedStorageLayout>;
  /**
   * The contract's runtime bytecode, used for the contract/address sanity check.
   *
   * @param fullyQualifiedName - `"<source name>:<contract name>"`, e.g. `contracts/Vault.sol:Vault`.
   * @returns `0x`-prefixed runtime bytecode, or `undefined` when the build-info has none.
   * @throws Same errors as {@link BuildInfoReader.getLayout}, since both share one load.
   */
  getDeployedBytecode(fullyQualifiedName: string): Promise<string | undefined>;
}

/**
 * Split `"contracts/Vault.sol:Vault"` into its source name and contract name.
 *
 * Split at the LAST colon: a source name may legitimately contain one (`lib:foo/A.sol:A`).
 *
 * @param fullyQualifiedName - `"<source name>:<contract name>"`.
 * @returns The two halves.
 * @throws {ContractNotFoundError} when there is no colon, nothing before it, or nothing after it.
 */
function splitFullyQualifiedName(fullyQualifiedName: string): {
  sourceName: string;
  contractName: string;
} {
  const separator = fullyQualifiedName.lastIndexOf(':');
  if (separator <= 0 || separator === fullyQualifiedName.length - 1) {
    throw new ContractNotFoundError(
      fullyQualifiedName,
      'expected a fully-qualified name of the form "contracts/Vault.sol:Vault"'
    );
  }
  return {
    sourceName: fullyQualifiedName.slice(0, separator),
    contractName: fullyQualifiedName.slice(separator + 1),
  };
}

/**
 * Build the reader for one HRE.
 *
 * Results are cached per fully-qualified name because a build-info file holds an entire solc
 * run — every source, every AST — and can run to tens of megabytes. Re-reading and re-parsing
 * it for each `.read()` would dominate the cost of a query.
 *
 * What is cached is the promise, so any number of concurrent first reads of a contract share
 * one load. A rejected promise is dropped again, so a read that failed for want of a recompile
 * succeeds on the next attempt within the same process. Every lookup is validated against the
 * artifact file's stamp, so a recompile — in this process or another — is picked up too.
 *
 * Hardhat keeps its own map from contract name to build-info path, filled by any caller in the
 * process and cleared only by saves made in this process. The reader therefore calls
 * `hre.artifacts.clearCache()` before every load it starts (never on a cached read), so that a
 * compile run elsewhere cannot make a load follow a path resolved before it.
 *
 * First reads of several contracts that are in progress together and point at the same
 * build-info file share one `hre.artifacts.getBuildInfo` call, so that file is read and parsed
 * once for all of them. The parsed build-info is referenced only while a load is in progress:
 * when the last one settles the reference is dropped.
 *
 * Known limit: a first read that starts after the earlier loads have settled reads and parses
 * the build-info file again, even for a contract of the same solc run, because nothing of the
 * parsed file is kept. Only the work done on the parsed ASTs is kept, per build id.
 *
 * @param hre - The Hardhat 2 environment whose `artifacts` are read.
 * @returns A reader whose methods share one cache. Errors are raised from those methods, not
 * from this function.
 */
export function createBuildInfoReader(hre: HardhatRuntimeEnvironment): BuildInfoReader {
  const cache = new Map<string, CacheEntry>();
  const astDerivedByBuildId = new Map<string, BuildAstDerived>();
  /** Build-info path -> the read shared by the loads in progress; emptied when none is. */
  const buildInfoReads = new Map<string, Promise<BuildInfo | undefined>>();
  /** How many loads have started and not settled; see `buildInfoReads`. */
  let loadsInProgress = 0;

  /**
   * The artifact file's current stamp, or `undefined` when it cannot be taken: a Hardhat
   * release without the path helper, a name the helper rejects, or a file that is not there.
   * None of those is an error here — the load that follows reports them — so this never rejects.
   */
  async function takeStamp(fullyQualifiedName: string): Promise<ArtifactStamp | undefined> {
    if (typeof hre.artifacts.formArtifactPathFromFullyQualifiedName !== 'function') {
      return undefined;
    }
    try {
      return await stampOf(
        hre.artifacts.formArtifactPathFromFullyQualifiedName(fullyQualifiedName)
      );
    } catch {
      return undefined;
    }
  }

  /**
   * The absolute path of the build-info file the contract's debug file points at, read from
   * disk rather than through Hardhat. `undefined` when it cannot be told: no path helper, no
   * readable debug file, or no link in it. The read that follows reports those; this never rejects.
   */
  async function buildInfoPathOf(fullyQualifiedName: string): Promise<string | undefined> {
    if (typeof hre.artifacts.formArtifactPathFromFullyQualifiedName !== 'function') {
      return undefined;
    }
    try {
      // Hardhat 2 writes `<Contract>.dbg.json` next to the artifact, holding the build-info's
      // path relative to itself.
      const debugFile = hre.artifacts
        .formArtifactPathFromFullyQualifiedName(fullyQualifiedName)
        .replace(/\.json$/, '.dbg.json');
      const debug = JSON.parse(await readFile(debugFile, 'utf8')) as { buildInfo?: unknown };
      return typeof debug.buildInfo === 'string'
        ? resolve(dirname(debugFile), debug.buildInfo)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * `hre.artifacts.getBuildInfo` for a contract, shared with every other load in progress whose
   * contract points at the same build-info file. A contract whose build-info path cannot be
   * told gets a call of its own. Rejects with whatever `getBuildInfo` throws.
   */
  async function readBuildInfo(fullyQualifiedName: string): Promise<BuildInfo | undefined> {
    const buildInfoPath = await buildInfoPathOf(fullyQualifiedName);
    if (buildInfoPath === undefined) return hre.artifacts.getBuildInfo(fullyQualifiedName);

    // Nothing awaits between this lookup and the insert, so loads arriving together start one read.
    const shared = buildInfoReads.get(buildInfoPath);
    if (shared !== undefined) return shared;
    // A build-info file is named after its id, a hash of the compiler input, so the file at one
    // path has one content: the read started for another contract serves this one as well.
    const read = hre.artifacts.getBuildInfo(fullyQualifiedName);
    buildInfoReads.set(buildInfoPath, read);
    read.catch(() => {
      // A failed read is not offered to loads that arrive later.
      if (buildInfoReads.get(buildInfoPath) === read) buildInfoReads.delete(buildInfoPath);
    });
    return read;
  }

  /**
   * Extract the user-defined value types and per-source constant/immutable names from a
   * build-info's ASTs, memoized by build id.
   */
  function deriveFromAsts(buildInfo: BuildInfo): BuildAstDerived {
    // A build-info without a usable id (not something Hardhat writes) is simply not shared.
    const buildId: unknown = buildInfo.id;
    const cached = typeof buildId === 'string' ? astDerivedByBuildId.get(buildId) : undefined;
    if (cached !== undefined) return cached;

    const sources = buildInfo.output.sources ?? {};
    // Collected per source rather than for the run as a whole, so that each contract can be
    // handed the names of its own file only — see the note where they are used.
    const constantAndImmutableNamesBySource = new Map<string, readonly string[]>();
    for (const [name, source] of Object.entries(sources)) {
      constantAndImmutableNamesBySource.set(name, extractConstantAndImmutableNames(source.ast));
    }
    const asts = Object.values(sources).map((source) => source.ast);
    const derived: BuildAstDerived = {
      userDefinedValueTypes: extractUserDefinedValueTypes(...asts),
      declaringContracts: extractDeclaringContracts(...asts),
      constantAndImmutableNamesBySource,
    };
    if (typeof buildId === 'string') astDerivedByBuildId.set(buildId, derived);
    return derived;
  }

  /**
   * Read, validate and parse one contract's layout and runtime bytecode from its build-info.
   * Does not consult or fill the cache; see `lookup` for that.
   *
   * @param fullyQualifiedName - `"<source name>:<contract name>"`.
   * @returns The parsed layout and runtime bytecode.
   * @throws {ContractNotFoundError} when the name is malformed, `getBuildInfo` throws or finds
   * nothing, or the build-info has no such contract.
   * @throws {StorageLayoutNotAvailableError} when the contract output has no `storageLayout`.
   * @throws Whatever {@link parseStorageLayout} throws for a layout it cannot interpret.
   */
  async function load(fullyQualifiedName: string): Promise<CachedContract> {
    const { sourceName, contractName } = splitFullyQualifiedName(fullyQualifiedName);

    // Hardhat throws (rather than returning undefined) when no artifact matches the name.
    let buildInfo: BuildInfo | undefined;
    try {
      buildInfo = await readBuildInfo(fullyQualifiedName);
    } catch (error) {
      throw new ContractNotFoundError(
        fullyQualifiedName,
        error instanceof Error ? error.message : String(error)
      );
    }
    if (buildInfo === undefined) {
      throw new ContractNotFoundError(
        fullyQualifiedName,
        'no build-info is associated with it — it may have been compiled by something other' +
          ' than solc, or the artifacts may be stale'
      );
    }

    const contract = buildInfo.output.contracts?.[sourceName]?.[contractName] as
      | ContractOutput
      | undefined;
    if (contract === undefined) {
      throw new ContractNotFoundError(
        fullyQualifiedName,
        `the build-info for "${sourceName}" has no contract named "${contractName}"`
      );
    }
    if (contract.storageLayout === undefined || contract.storageLayout === null) {
      throw new StorageLayoutNotAvailableError(fullyQualifiedName);
    }

    // Walking every AST of the run is the expensive part of a load and its result does not
    // depend on the contract, so a second contract of the same build reuses it.
    const astDerived = deriveFromAsts(buildInfo);

    const layout = parseStorageLayout(contract.storageLayout, {
      contractName: fullyQualifiedName,
      // Every source in the run: a user-defined value type is frequently declared in a file
      // other than the one using it, and the map is keyed by AST node id (consulted first) and
      // by name; the id is unique across the whole compilation — so widening the scope cannot
      // introduce a wrong answer.
      userDefinedValueTypes: astDerived.userDefinedValueTypes,
      // Every source in the run as well: a base contract, whose private variable may share a
      // name with one of this contract's, is often declared in another file.
      declaringContracts: astDerived.declaringContracts,
      // Only this contract's own source. These names exist to sharpen one error message
      // ("declared constant or immutable" instead of "no such variable"), and a name collected
      // from an unrelated file could make that message confidently wrong. Narrowing it means a
      // constant inherited across files falls back to the generic — still accurate — message.
      constantAndImmutableNames: astDerived.constantAndImmutableNamesBySource.get(sourceName) ?? [],
    });

    const object = contract.evm?.deployedBytecode?.object;
    return {
      layout,
      deployedBytecode:
        typeof object === 'string' && object.length > 0 ? `0x${object}` : undefined,
    };
  }

  /**
   * The one validated lookup behind both reader methods.
   *
   * @param fullyQualifiedName - `"<source name>:<contract name>"`.
   * @returns The cached load when its stamp still matches the artifact file, otherwise a fresh one.
   * @throws The errors of `load`, as a rejection.
   */
  async function lookup(fullyQualifiedName: string): Promise<CachedContract> {
    // Taken BEFORE the load and stored with it: if the artifact is rewritten while the load is
    // in flight, the stored stamp is the older one and the next lookup reloads. Taking it
    // afterwards could pair the new stamp with the old content and hide the rewrite for good.
    const stamp = await takeStamp(fullyQualifiedName);

    // Nothing below awaits before the entry is stored, so concurrent lookups that all find the
    // cache empty still start exactly one load.
    const cached = cache.get(fullyQualifiedName);
    if (cached !== undefined) {
      if (sameStamp(cached.stamp, stamp)) return cached.contract;
      // The artifact was rewritten (or removed) since it was loaded, which means a new build.
      // The per-build data is cheap to rebuild and is dropped wholesale, so a long-lived
      // process does not keep one entry per past compile.
      astDerivedByBuildId.clear();
    }

    // Hardhat keeps its own map from name to build-info path, cleared only by saves made in
    // this process. Any caller may have filled it — another plugin, a second reader, this
    // reader's own failed attempt — before a compile run elsewhere moved the contract to a new
    // build-info, so no load trusts it: without this the old layout would be stored under the
    // new stamp and served from then on.
    hre.artifacts.clearCache?.();

    loadsInProgress += 1;
    const entry: CacheEntry = {
      stamp,
      contract: load(fullyQualifiedName).finally(() => {
        loadsInProgress -= 1;
        // Nothing is waiting on a shared read any more, so the parsed build-infos are let go.
        if (loadsInProgress === 0) buildInfoReads.clear();
      }),
    };
    cache.set(fullyQualifiedName, entry);
    entry.contract.catch(() => {
      // Never keep a failure. The identity check leaves a newer entry for the same name alone.
      if (cache.get(fullyQualifiedName) === entry) cache.delete(fullyQualifiedName);
    });
    return entry.contract;
  }

  return {
    async getLayout(fullyQualifiedName) {
      return (await lookup(fullyQualifiedName)).layout;
    },
    async getDeployedBytecode(fullyQualifiedName) {
      return (await lookup(fullyQualifiedName)).deployedBytecode;
    },
  };
}
