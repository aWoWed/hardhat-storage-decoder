/**
 * Hardhat 3: make solc emit `storageLayout`.
 *
 * ## The mechanism, and why this one
 *
 * HH2 has a single obvious seam (overriding the `TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT`
 * subtask). HH3 has two candidates, and they are not equally good:
 *
 *   1. `solidity.preprocessSolcInputBeforeBuilding` — a chained hook over the already-built
 *      solc standard-JSON input. It is real and is exercised by Hardhat's own first-party
 *      coverage plugin, BUT `hardhat@3.13.0` marks it `@deprecated This hook will soon be
 *      removed`. Building on it would make this plugin break on a minor Hardhat bump.
 *
 *   2. `config.resolveUserConfig` — the config-resolution hook. Not deprecated, and it lands
 *      upstream of the solc input: `SolidityBuildProfileConfig.compilers[].settings` is what
 *      `CompilationJobImplementation.#buildSolcInput()` reads, and it explicitly merges
 *      `settings.outputSelection` with Hardhat's own defaults rather than replacing it
 *      (verified against `hardhat@3.13.0`'s
 *      `internal/builtin-plugins/solidity/build-system/compilation-job.js`).
 *
 * We use (2). It runs while the compile configuration is resolved, it is stable API, and
 * because Hardhat merges rather than overwrites, injecting here composes with whatever
 * `outputSelection` the user already declared.
 *
 * ## Fail-loud fallback
 *
 * The injection must never silently do nothing. Two guards implement that:
 *   - {@link withStorageLayoutOutputSelection} throws if there is no resolved `solidity`
 *     config to extend (i.e. the hook ran but had nothing to act on).
 *   - {@link MissingStorageLayoutError} is thrown at read time by `readBuildInfo.ts` if a
 *     contract's build-info still has no `storageLayout`. Both messages print the exact
 *     `hardhat.config` snippet to add by hand.
 *
 * Consumers need one recompile after installing the plugin: injection changes the solc input,
 * which changes the build id, so Hardhat recompiles on its own the first time — but artifacts
 * produced *before* installation keep their layout-less build-info until that happens.
 */

import type { HardhatConfig } from 'hardhat/types/config';
import { StorageDecoderError } from '../core/index.js';

/** The solc output selector that carries the storage layout. */
export const STORAGE_LAYOUT_SELECTOR = 'storageLayout';

/**
 * Per-contract outputs this package cannot work without, beyond `storageLayout` itself.
 *
 * `evm.deployedBytecode.object` backs the `.contract(fqn)`/`.target(address)` sanity check.
 * `ast` (a per-source rather than per-contract selector, requested separately below) is what
 * lets a user-defined value type's underlying type be resolved at all.
 *
 * Hardhat 3's own `DEFAULT_OUTPUT_SELECTION` already requests both today (verified against
 * `hardhat@3.13.0`), so this mirrors HH2's defensive injection (see
 * `../hardhat2/ensureStorageLayoutOutput.ts`) rather than fixing a live gap: it exists so this
 * plugin keeps working if a future Hardhat 3 release ever trims its own defaults, instead of
 * silently degrading to worse error messages and unresolved UDVTs.
 */
const REQUIRED_CONTRACT_OUTPUTS = ['evm.deployedBytecode.object'] as const;
/** Per-source selectors injected under the `""` key; see {@link REQUIRED_CONTRACT_OUTPUTS}. */
const REQUIRED_SOURCE_OUTPUTS = ['ast'] as const;

/** Copy-pasteable config the user can add by hand if automatic injection ever fails. */
export const MANUAL_OUTPUT_SELECTION_SNIPPET = `  solidity: {
    version: "0.8.26",
    settings: {
      outputSelection: {
        "*": { "*": ["storageLayout"] },
      },
    },
  },`;

/**
 * The layout was not in the build-info, or could not be injected.
 *
 * Deliberately actionable: it names the recompile step and prints the manual config, because
 * "storageLayout is undefined" with no further guidance is the single most likely first-run
 * failure for this plugin.
 */
export class MissingStorageLayoutError extends StorageDecoderError {
  /**
   * @param fullyQualifiedName - The contract whose build-info lacks the layout, or `undefined`
   *   when the failure is project-wide (no resolved Solidity config). Exposed as a property.
   * @param detail - What specifically was missing; interpolated into the message.
   */
  constructor(
    readonly fullyQualifiedName: string | undefined,
    detail: string
  ) {
    const subject =
      fullyQualifiedName === undefined
        ? 'This project'
        : `The build-info for "${fullyQualifiedName}"`;
    super(
      `${subject} has no solc "storageLayout" output: ${detail}.\n` +
        `hardhat-storage-decoder normally injects that selector automatically, so first run` +
        ` \`npx hardhat compile\` once after installing the plugin, and check the plugin is in` +
        ` your config's \`plugins\` array.\n` +
        `If it still does not appear, add this to your hardhat.config yourself:\n\n` +
        `${MANUAL_OUTPUT_SELECTION_SNIPPET}\n`,
      'MissingStorageLayoutError',
      MissingStorageLayoutError
    );
  }
}

/** solc's `settings.outputSelection`: source name -> contract name -> selectors. */
type OutputSelection = Record<string, Record<string, string[]>>;

/** The slice of a Hardhat compiler config this module touches. */
interface CompilerLike {
  /** solc settings; `outputSelection` is merged with Hardhat's defaults at compile time. */
  settings?: { outputSelection?: OutputSelection } & Record<string, unknown>;
}

/**
 * Add `storageLayout` plus the defensive extras (see {@link REQUIRED_CONTRACT_OUTPUTS} /
 * {@link REQUIRED_SOURCE_OUTPUTS}) to one compiler config's `outputSelection`, under the
 * `"*" -> "*"` (per-contract) and `"*" -> ""` (per-source) wildcards so they apply everywhere.
 *
 * Returns the config unchanged when nothing needed adding, so a user who declared these by hand
 * does not get a duplicate (Hardhat dedupes anyway, but an unchanged object also keeps the
 * build id stable, which matters for cache invalidation the same way it does in the HH2
 * adapter).
 *
 * @typeParam T - The compiler config type; read through {@link CompilerLike}, spread unchanged.
 * @param compiler - One compiler config (or per-file override) from a build profile.
 * @returns `compiler` itself if nothing was missing, else a copy with the selectors added.
 */
function withStorageLayoutSelector<T>(compiler: T): T {
  const { settings } = compiler as CompilerLike;
  const outputSelection: OutputSelection = settings?.outputSelection ?? {};
  const forAllSources = outputSelection['*'] ?? {};
  const forAllContracts = forAllSources['*'] ?? [];
  const forWholeSource = forAllSources[''] ?? [];

  const nextContracts = union(forAllContracts, [STORAGE_LAYOUT_SELECTOR, ...REQUIRED_CONTRACT_OUTPUTS]);
  const nextSource = union(forWholeSource, REQUIRED_SOURCE_OUTPUTS);
  if (nextContracts === forAllContracts && nextSource === forWholeSource) return compiler;

  return {
    ...compiler,
    settings: {
      ...settings,
      outputSelection: {
        ...outputSelection,
        '*': { ...forAllSources, '*': nextContracts, '': nextSource },
      },
    },
  };
}

/** Union `additions` into `existing`; returns `existing` itself when nothing was missing. */
function union(existing: readonly string[], additions: readonly string[]): string[] {
  const missing = additions.filter((item) => !existing.includes(item));
  return missing.length === 0 ? (existing as string[]) : [...existing, ...missing];
}

/**
 * Return a copy of the resolved config in which every build profile's compilers — including
 * per-file `overrides` — request `storageLayout`.
 *
 * Purely functional: it never mutates Hardhat's config object, which matters because other
 * `resolveUserConfig` handlers in the chain may hold references to it.
 *
 * @param config - The resolved Hardhat config, as returned by the rest of the
 *   `resolveUserConfig` chain.
 * @returns A new config with the selectors injected.
 * @throws {MissingStorageLayoutError} when there is no resolved `solidity` config at all,
 *   which would mean this hook silently did nothing.
 */
export function withStorageLayoutOutputSelection(config: HardhatConfig): HardhatConfig {
  const solidity = config.solidity;
  const profiles = solidity?.profiles;
  if (solidity === undefined || profiles === undefined) {
    throw new MissingStorageLayoutError(
      undefined,
      'this project has no resolved Solidity configuration, so the storageLayout output' +
        ' selector could not be injected automatically'
    );
  }

  return {
    ...config,
    solidity: {
      ...solidity,
      profiles: Object.fromEntries(
        Object.entries(profiles).map(([profileName, profile]) => [
          profileName,
          {
            ...profile,
            compilers: profile.compilers.map(withStorageLayoutSelector),
            overrides: Object.fromEntries(
              Object.entries(profile.overrides ?? {}).map(([sourceName, override]) => [
                sourceName,
                withStorageLayoutSelector(override),
              ])
            ),
          },
        ])
      ),
    },
  };
}
