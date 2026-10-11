/**
 * Hardhat 3: fully-qualified contract name -> parsed storage layout.
 *
 * HH3 splits a compilation into two files: the *build info* (`input`, plus the
 * `userSourceNameMap`) and the *build info output* (solc's verbatim output). Everything we
 * need — `storageLayout` and the source ASTs — lives in the output file, which we reach
 * through the public `ArtifactManager` API rather than by guessing paths under `artifacts/`.
 *
 * The one genuinely fiddly part is source-name translation. A fully-qualified name uses the
 * *user* source name (`contracts/Vault.sol:Vault`), while solc's output is keyed by the
 * *input* source name (`project/contracts/Vault.sol`). See the private
 * `#resolveContractOutput` method of {@link Hardhat3LayoutReader}.
 */

import type { ArtifactManager } from 'hardhat/types/artifacts';
import { readFile } from 'node:fs/promises';
import {
  ContractNotFoundError,
  type ParsedStorageLayout,
  type RawStorageLayout,
  extractConstantAndImmutableNames,
  extractDeclaringContracts,
  extractUserDefinedValueTypes,
  parseStorageLayout,
} from '../core/index.js';
import { type ArtifactStamp, sameStamp, stampOf } from '../shared/artifactStamp.js';
import { MissingStorageLayoutError } from './ensureStorageLayoutOutput.js';

// ---------------------------------------------------------------------------------------
// Structural shapes for the build-info-output JSON.
//
// Declared here rather than imported from `hardhat/types/solidity/...` for two reasons:
// that subpath is not in Hardhat's `exports` map (so the emitted .d.ts could not reference
// it from a consumer's project), and solc's `storageLayout` is absent from Hardhat's
// `CompilerOutputContract` type anyway — it only appears when we ask for the selector.
// ---------------------------------------------------------------------------------------

/** One contract's entry in solc's output. */
interface SolcContractOutput {
  /** Present only when the `storageLayout` output selector was requested at compile time. */
  readonly storageLayout?: RawStorageLayout;
}

/** The part of solc's standard-JSON output this reader uses. */
interface SolcOutput {
  /** Input source name -> that source's entry; `ast` is the source's parsed syntax tree. */
  readonly sources?: Record<string, { readonly ast?: unknown }>;
  /** Input source name -> contract name -> that contract's output. */
  readonly contracts?: Record<string, Record<string, SolcContractOutput>>;
}

/** The build-info output file: solc's verbatim output, wrapped. */
interface BuildInfoOutputFile {
  /** solc's output; absent in a malformed or truncated file. */
  readonly output?: SolcOutput;
}

/** The build-info (input) file: the compiler input plus source-name bookkeeping. */
interface BuildInfoFile {
  /** user source name -> solc input source name, for the build's root files. */
  readonly userSourceNameMap?: Record<string, string>;
}

/** The fields of a Hardhat 3 artifact this reader uses. */
interface ArtifactLike {
  /** Bare contract name, e.g. `Vault`. */
  readonly contractName: string;
  /** User source name, e.g. `contracts/Vault.sol`. */
  readonly sourceName: string;
  /** The key solc's output uses for this source, e.g. `project/contracts/Vault.sol`. */
  readonly inputSourceName?: string;
  /** Id of the build that produced the artifact; absent for artifacts not built by HH3. */
  readonly buildInfoId?: string;
  /** Runtime bytecode as a hex string. */
  readonly deployedBytecode: string;
}

/** Everything cached for one contract, all of it valid for one {@link ArtifactStamp}. */
interface ContractEntry {
  /** `undefined` when the installed Hardhat cannot tell us the artifact's path. */
  readonly stamp: ArtifactStamp | undefined;
  /** The artifact read, shared by concurrent lookups; the entry is dropped if it rejects. */
  readonly artifact: Promise<ArtifactLike>;
  /** Started by the first `getLayout`; reset when it rejects so a failure is never sticky. */
  layout: Promise<ParsedStorageLayout> | undefined;
  /** Set once the layout load learns it; what keeps that build's {@link BuildDerived} alive. */
  buildInfoId: string | undefined;
}

/**
 * What is kept of one build's output file once it has been read: enough to load the layout of
 * any contract of the build, and nothing else of the file (no AST, no bytecode, no ABI).
 */
interface BuildDerived {
  /**
   * Input source name -> contract name -> that contract's `storageLayout` alone. Both levels
   * have no prototype, so a name such as `constructor` finds nothing. `undefined` when the
   * file has no solc output at all.
   */
  readonly contracts: Record<string, Record<string, SolcContractOutput>> | undefined;
  /** User-defined value types of every source of the build: AST id or name -> underlying type. */
  readonly userDefinedValueTypes: Record<string, string>;
  /** AST id of a state variable -> the contract declaring it, from every source of the build. */
  readonly declaringContracts: Record<string, string>;
  /** Input source name -> the constants and immutables declared in that source. */
  readonly constantAndImmutableNamesBySource: ReadonlyMap<string, readonly string[]>;
}

/** A contract's entry in solc's output, with the `output.contracts` key it was found under. */
interface ResolvedContractOutput {
  /** The contract's solc output. */
  readonly contractOutput: SolcContractOutput;
  /** The `output.contracts` (and `output.sources`) key the contract was found under. */
  readonly inputSourceName: string;
}

/**
 * Reads storage layouts for one Hardhat 3 project.
 *
 * Caches at two levels — artifact and parsed layout per contract, and per build id what the
 * layouts of that build's contracts are made from — because a single `.read()` chain reused
 * across many keys would otherwise re-parse a multi-megabyte build-info output every time.
 *
 * The decoded output file itself is not kept. It is read once per build, reduced to the raw
 * `storageLayout` of each contract, the user-defined value types, the declaring contract of
 * each state variable and the constant and immutable names per source, and then let go; the
 * ASTs, bytecode and everything else in it become garbage as soon as that read finishes. The
 * reduced data stays for as long as a cached contract belongs to the build, so a first read
 * of another contract of the build does not open the file again. The price is that every AST
 * of the build is walked on the build's first read, not only the ones the requested contract
 * needs.
 *
 * Every lookup re-validates the contract's entry against its artifact file, so a recompile —
 * in this process or another — is picked up by the next read. Only successful loads are kept:
 * a read that fails because the project is not compiled yet must not poison later ones.
 */
export class Hardhat3LayoutReader {
  /** Hardhat's artifact manager: the only way this reader locates files. */
  readonly #artifacts: ArtifactManager;
  /** Fully-qualified name -> cached entry for that contract. */
  readonly #entries = new Map<string, ContractEntry>();
  /** Build id -> the (pending) data kept of its output file; failed loads are removed. */
  readonly #builds = new Map<string, Promise<BuildDerived>>();

  /**
   * @param artifacts - The project's Hardhat `ArtifactManager`.
   */
  constructor(artifacts: ArtifactManager) {
    this.#artifacts = artifacts;
  }

  /**
   * Parsed storage layout of a contract, loading and caching it on first use.
   *
   * @param fullyQualifiedName - `path/to/File.sol:Contract`, using the user source name.
   * @returns The contract's parsed layout.
   * @throws {ContractNotFoundError} when the artifact, its build info or its entry in solc's
   *   output cannot be found, or when the name matches several source files.
   * @throws {MissingStorageLayoutError} when the build info has no solc output or the contract
   *   was compiled without the `storageLayout` selector.
   * @throws also whatever `parseStorageLayout` throws for a layout it cannot interpret, and a
   *   `SyntaxError` for an unparseable build-info output file.
   */
  async getLayout(fullyQualifiedName: string): Promise<ParsedStorageLayout> {
    const entry = await this.#entryFor(fullyQualifiedName);
    if (entry.layout !== undefined) return entry.layout;
    // Cache the promise, not the result: two concurrent reads of the same contract must not
    // both parse the build info.
    const pending = this.#loadLayout(fullyQualifiedName, entry);
    entry.layout = pending;
    void pending
      .catch(() => {
        if (entry.layout === pending) entry.layout = undefined;
      })
      .then(() => {
        // A load that outlived its entry may have re-created the superseded build's data.
        if (this.#entries.get(fullyQualifiedName) !== entry) this.#evictUnreferencedBuilds();
      });
    return pending;
  }

  /**
   * Artifact `deployedBytecode`, for the query builder's contract/address sanity check.
   *
   * @param fullyQualifiedName - `path/to/File.sol:Contract`, using the user source name.
   * @returns The artifact's runtime bytecode as a hex string.
   * @throws {ContractNotFoundError} when the artifact cannot be found.
   */
  async getDeployedBytecode(fullyQualifiedName: string): Promise<string | undefined> {
    // Deliberately the artifact promise only: a contract whose layout cannot be loaded still
    // has bytecode, and the layout's own error is `getLayout`'s to report.
    const entry = await this.#entryFor(fullyQualifiedName);
    return (await entry.artifact).deployedBytecode;
  }

  /**
   * The live cache entry for a contract, replaced if its artifact file changed.
   *
   * Nothing is awaited between the cache lookup and the insert, so any number of concurrent
   * first reads end up sharing one entry.
   *
   * @param fullyQualifiedName - `path/to/File.sol:Contract`.
   * @returns The cached entry if its stamp still matches the artifact file, else a new one.
   * @throws {ContractNotFoundError} when the artifact path cannot be resolved (after one retry
   *   with Hardhat's artifact cache cleared).
   */
  async #entryFor(fullyQualifiedName: string): Promise<ContractEntry> {
    // Stamp BEFORE loading: if the file is rewritten in between, the entry carries the older
    // stamp and the next lookup reloads it. The other order could pin stale content forever.
    const stamp = await this.#stampArtifact(fullyQualifiedName);
    const cached = this.#entries.get(fullyQualifiedName);
    if (cached !== undefined && sameStamp(cached.stamp, stamp)) return cached;

    const entry: ContractEntry = {
      stamp,
      artifact: this.#readArtifact(fullyQualifiedName),
      layout: undefined,
      buildInfoId: undefined,
    };
    this.#entries.set(fullyQualifiedName, entry);
    entry.artifact.catch(() => {
      if (this.#entries.get(fullyQualifiedName) !== entry) return;
      this.#entries.delete(fullyQualifiedName);
      this.#evictUnreferencedBuilds();
    });
    // The replaced entry may have been the last reference to its build.
    if (cached !== undefined) this.#evictUnreferencedBuilds();
    return entry;
  }

  /**
   * `{ mtimeMs, size }` of the contract's artifact file, or `undefined` when this Hardhat has
   * no `getArtifactPath` — in which case entries are never invalidated.
   *
   * @param fullyQualifiedName - `path/to/File.sol:Contract`.
   * @returns The stamp, or `undefined` as described above.
   * @throws {ContractNotFoundError} when the path lookup or the file stat fails, even after one
   *   retry with Hardhat's artifact cache cleared.
   */
  async #stampArtifact(fullyQualifiedName: string): Promise<ArtifactStamp | undefined> {
    if (typeof this.#artifacts.getArtifactPath !== 'function') return undefined;
    return this.#retryAfterClearingCache(fullyQualifiedName, async () => {
      return stampOf(await this.#artifacts.getArtifactPath(fullyQualifiedName));
    });
  }

  /** Read the artifact; the cache-clearing retry turns a failure into `ContractNotFoundError`. */
  async #readArtifact(fullyQualifiedName: string): Promise<ArtifactLike> {
    return this.#retryAfterClearingCache(
      fullyQualifiedName,
      async (): Promise<ArtifactLike> => await this.#artifacts.readArtifact(fullyQualifiedName)
    );
  }

  /**
   * Run an artifact lookup; if it fails, clear Hardhat's artifact cache and try once more
   * before reporting the contract as not found.
   *
   * `ArtifactManager` caches its listing of the artifacts directory and nothing in Hardhat
   * clears it after a compile, so an artifact created after the first lookup would otherwise
   * stay "not found" for the life of the process. The retry is on any failure rather than on
   * Hardhat's not-found error specifically: a listing that still names a since-deleted file
   * fails with a filesystem error instead, and the cost is one directory walk on a path that
   * was about to throw anyway. A stale *stamp* never comes here — the path of a file that
   * still exists stays valid, so a recompile needs no walk.
   *
   * @typeParam ResultT - What `lookup` resolves to.
   * @param fullyQualifiedName - Contract name, used in the error.
   * @param lookup - The artifact operation to run, and to run again after clearing the cache.
   * @returns `lookup`'s result.
   * @throws {ContractNotFoundError} when `lookup` fails twice (or once, if the manager has no
   *   `clearCache`); the underlying message is carried in `detail`.
   */
  async #retryAfterClearingCache<ResultT>(
    fullyQualifiedName: string,
    lookup: () => Promise<ResultT>
  ): Promise<ResultT> {
    try {
      return await lookup();
    } catch (firstError) {
      let error: unknown = firstError;
      if (typeof this.#artifacts.clearCache === 'function') {
        try {
          await this.#artifacts.clearCache();
          return await lookup();
        } catch (retryError) {
          error = retryError;
        }
      }
      throw new ContractNotFoundError(
        fullyQualifiedName,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Drop the data kept of builds no cached contract points at.
   *
   * Without this, every recompile would leave the layouts of one more build behind.
   * A build still loading for a live entry is safe: the entry records its build id before
   * asking for the output.
   */
  #evictUnreferencedBuilds(): void {
    const referenced = new Set<string>();
    for (const entry of this.#entries.values()) {
      if (entry.buildInfoId !== undefined) referenced.add(entry.buildInfoId);
    }
    for (const buildInfoId of this.#builds.keys()) {
      if (!referenced.has(buildInfoId)) this.#builds.delete(buildInfoId);
    }
  }

  /**
   * Resolve a contract's build, find its solc output and parse the storage layout.
   *
   * Records the build id on `entry` before reading the output, so eviction never drops a build
   * that is still loading.
   *
   * @param fullyQualifiedName - `path/to/File.sol:Contract`.
   * @param entry - The cache entry to load for; its `buildInfoId` is set as a side effect.
   * @returns The parsed layout.
   * @throws {ContractNotFoundError} when the artifact has no build-info id, the output file is
   *   missing, or the contract cannot be located in solc's output.
   * @throws {MissingStorageLayoutError} when the build has no solc output or no `storageLayout`.
   */
  async #loadLayout(
    fullyQualifiedName: string,
    entry: ContractEntry
  ): Promise<ParsedStorageLayout> {
    const artifact = await entry.artifact;

    const buildInfoId =
      artifact.buildInfoId ?? (await this.#artifacts.getBuildInfoId(fullyQualifiedName));
    if (buildInfoId === undefined) {
      throw new ContractNotFoundError(
        fullyQualifiedName,
        "its artifact carries no build-info id, so it was not produced by Hardhat 3's build" +
          ' system; run `npx hardhat compile`'
      );
    }
    entry.buildInfoId = buildInfoId;

    const build = await this.#readBuildInfoOutput(fullyQualifiedName, buildInfoId);
    if (build.contracts === undefined) {
      throw new MissingStorageLayoutError(
        fullyQualifiedName,
        `build info "${buildInfoId}" has no solc output`
      );
    }

    const { contractOutput, inputSourceName } = await this.#resolveContractOutput(
      fullyQualifiedName,
      buildInfoId,
      build.contracts,
      artifact
    );

    const storageLayout = contractOutput.storageLayout;
    if (storageLayout === undefined) {
      throw new MissingStorageLayoutError(
        fullyQualifiedName,
        `build info "${buildInfoId}" was compiled without the storageLayout selector`
      );
    }

    return parseStorageLayout(storageLayout, {
      contractName: fullyQualifiedName,
      // Every source of the build: a user-defined value type may be declared in a parent
      // contract or at file level in another file, and the map is keyed by AST id / name, so a
      // superset is harmless.
      userDefinedValueTypes: build.userDefinedValueTypes,
      // Every source of the build as well: a base contract, whose private variable may share
      // a name with one of this contract's, is often declared in another file.
      declaringContracts: build.declaringContracts,
      // The contract's own source file only. These names exist to turn "variable not found"
      // into "that is a constant or immutable", and a same-named constant in an unrelated file
      // of the build would make that claim about a variable this contract never declared.
      constantAndImmutableNames: build.constantAndImmutableNamesBySource.get(inputSourceName) ?? [],
    });
  }

  /**
   * Read and parse a build's output file and reduce it to a {@link BuildDerived}, caching the
   * pending promise by build id. The decoded file is referenced only until the reduction ends.
   *
   * @param fullyQualifiedName - Contract name, used in the error.
   * @param buildInfoId - The build to read.
   * @returns What is kept of the build's output file.
   * @throws {ContractNotFoundError} when Hardhat has no output path for the build.
   * @throws {SyntaxError} when the file is not valid JSON.
   */
  async #readBuildInfoOutput(
    fullyQualifiedName: string,
    buildInfoId: string
  ): Promise<BuildDerived> {
    const cached = this.#builds.get(buildInfoId);
    if (cached !== undefined) return cached;
    const pending = (async (): Promise<BuildDerived> => {
      const path = await this.#artifacts.getBuildInfoOutputPath(buildInfoId);
      if (path === undefined) {
        throw new ContractNotFoundError(
          fullyQualifiedName,
          `build info "${buildInfoId}" exists but its solc output file does not; run` +
            ' `npx hardhat compile`'
        );
      }
      return deriveFromOutput(
        (JSON.parse(await readFile(path, 'utf8')) as BuildInfoOutputFile).output
      );
    })();
    this.#builds.set(buildInfoId, pending);
    // A missing or half-written output file must be looked for again on the next read.
    pending.catch(() => {
      if (this.#builds.get(buildInfoId) === pending) this.#builds.delete(buildInfoId);
    });
    return pending;
  }

  /**
   * Find the contract's entry in solc's output, and the input source name it is keyed by.
   *
   * Candidates, in order: the artifact's own `inputSourceName` (always present for Solidity
   * compiled by HH3), then the build info's `userSourceNameMap`, then the raw user source
   * name. Only if all of those miss do we scan — and a scan that matches more than one
   * source file is reported as ambiguous (a `ContractNotFoundError`) rather than resolved by
   * picking the first, because silently decoding a same-named contract from a different file
   * would apply the wrong layout. (`ContractMismatchError` is unrelated: it is the query
   * builder's check of on-chain code against the artifact's bytecode.)
   *
   * @param fullyQualifiedName - Contract name, used in errors.
   * @param buildInfoId - The build being searched.
   * @param contracts - The build's contracts: input source name -> contract name -> output.
   * @param artifact - The contract's artifact, supplying its names.
   * @returns The contract's output and the input source name it was found under.
   * @throws {ContractNotFoundError} when no candidate matches, or the scan matches several
   *   source files.
   */
  async #resolveContractOutput(
    fullyQualifiedName: string,
    buildInfoId: string,
    contracts: Record<string, Record<string, SolcContractOutput>>,
    artifact: ArtifactLike
  ): Promise<ResolvedContractOutput> {
    const { contractName, sourceName } = artifact;

    const candidates: string[] = [];
    // Records every key tried, so the not-found error can list them.
    const lookUp = (candidate: string): ResolvedContractOutput | undefined => {
      candidates.push(candidate);
      const contractOutput = contracts[candidate]?.[contractName];
      return contractOutput === undefined
        ? undefined
        : { contractOutput, inputSourceName: candidate };
    };

    if (artifact.inputSourceName !== undefined) {
      const found = lookUp(artifact.inputSourceName);
      if (found !== undefined) return found;
    }
    // Only now that the cheap candidate has missed: the map lives in the build-info *input*
    // file, which holds every source of the build and would otherwise be read and parsed on
    // each layout load just to be ignored.
    const mapped = await this.#mapUserSourceName(buildInfoId, sourceName);
    if (mapped !== undefined) {
      const found = lookUp(mapped);
      if (found !== undefined) return found;
    }
    const found = lookUp(sourceName);
    if (found !== undefined) return found;

    const matches = Object.keys(contracts).filter(
      (key) =>
        (key === sourceName || key.endsWith(`/${sourceName}`)) &&
        contracts[key]?.[contractName] !== undefined
    );
    if (matches.length === 1) {
      // Safe: exactly one source file in this build both matches the user source name and
      // defines a contract with this name.
      const inputSourceName = matches[0] as string;
      return {
        contractOutput: contracts[inputSourceName]?.[contractName] as SolcContractOutput,
        inputSourceName,
      };
    }
    throw new ContractNotFoundError(
      fullyQualifiedName,
      matches.length === 0
        ? `build info "${buildInfoId}" has no compiler output for that contract (looked` +
          ` under ${candidates.map((c) => `"${c}"`).join(', ')})`
        : `build info "${buildInfoId}" has ${matches.length} source files that could be it` +
          ` (${matches.join(', ')}); pass the fully-qualified name of the right one`
    );
  }

  /**
   * Translate a user source name to solc's input source name via `userSourceNameMap`, which
   * lives in the build-info file, not the output file.
   *
   * @param buildInfoId - The build whose map to consult.
   * @param sourceName - User source name, e.g. `contracts/Vault.sol`.
   * @returns The mapped input source name, or `undefined` when the file is missing, malformed or
   *   has no entry; this method never throws for those cases.
   */
  async #mapUserSourceName(
    buildInfoId: string,
    sourceName: string
  ): Promise<string | undefined> {
    const path = await this.#artifacts.getBuildInfoPath(buildInfoId);
    if (path === undefined) return undefined;
    try {
      const buildInfo = JSON.parse(await readFile(path, 'utf8')) as BuildInfoFile;
      return buildInfo.userSourceNameMap?.[sourceName];
    } catch {
      // Not fatal: this is one of several candidates, and the caller reports if all of them miss.
      return undefined;
    }
  }
}

/** True for a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reduce solc's output to the parts a layout load uses. The result shares only the
 * `storageLayout` objects with `output`; every other part of it can be collected afterwards.
 *
 * @param output - solc's output as decoded from the build's output file, or `undefined` when
 *   the file has none.
 * @returns The contracts' raw layouts, the build's user-defined value types and declaring
 *   contracts, and each source's constant and immutable names.
 */
function deriveFromOutput(output: SolcOutput | undefined): BuildDerived {
  const constantAndImmutableNamesBySource = new Map<string, readonly string[]>();
  const asts: object[] = [];
  for (const [inputSourceName, source] of Object.entries(output?.sources ?? {})) {
    const ast: unknown = isPlainObject(source) ? source.ast : undefined;
    if (typeof ast !== 'object' || ast === null) continue;
    asts.push(ast);
    constantAndImmutableNamesBySource.set(inputSourceName, extractConstantAndImmutableNames(ast));
  }

  let contracts: Record<string, Record<string, SolcContractOutput>> | undefined;
  if (output !== undefined) {
    contracts = Object.create(null) as Record<string, Record<string, SolcContractOutput>>;
    for (const [inputSourceName, ofSource] of Object.entries(output.contracts ?? {})) {
      if (!isPlainObject(ofSource)) continue;
      const kept = Object.create(null) as Record<string, SolcContractOutput>;
      for (const [contractName, contractOutput] of Object.entries(ofSource)) {
        kept[contractName] = {
          storageLayout: isPlainObject(contractOutput)
            ? (contractOutput as SolcContractOutput).storageLayout
            : undefined,
        };
      }
      contracts[inputSourceName] = kept;
    }
  }

  return {
    contracts,
    userDefinedValueTypes: extractUserDefinedValueTypes(...asts),
    declaringContracts: extractDeclaringContracts(...asts),
    constantAndImmutableNamesBySource,
  };
}
