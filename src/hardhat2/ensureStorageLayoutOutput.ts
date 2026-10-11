/**
 * Make solc emit `storageLayout` for a Hardhat 2 project.
 *
 * solc only emits what `settings.outputSelection` asks for, and Hardhat 2's defaults
 * (`internal/core/config/default-config.ts`) ask for `abi`, `evm.bytecode`,
 * `evm.deployedBytecode`, `evm.methodIdentifiers`, `metadata` and `ast` — but never
 * `storageLayout`. Without it, build-info carries no layout and nothing here can work.
 *
 * Two injection points are used, deliberately:
 *
 *  1. `extendConfig` — adds `storageLayout` to every resolved compiler's (and every override's)
 *     `settings.outputSelection`. This is the one that matters for CACHE INVALIDATION:
 *     `SolidityFilesCache.hasFileChanged()` compares the stored `solcConfig` with the current
 *     one by deep equality, so a project that was already compiled BEFORE this plugin was
 *     installed would otherwise stay cached and never re-emit a layout. Changing the resolved
 *     solc settings is what makes `npx hardhat compile` actually recompile.
 *
 *  2. An override of the `TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT` subtask, which
 *     builds the compiler input. It guarantees the input handed to solc carries the selection
 *     even if some other plugin rebuilds the compiler input from something other than the
 *     resolved compiler settings.
 *
 * Both are strictly ADDITIVE. Existing selections are copied, never replaced: dropping a
 * user's own `outputSelection`, or the defaults, would break unrelated tooling. In particular
 * `evm.deployedBytecode` (needed for the contract/address sanity check) and `ast` (needed to
 * recover user-defined value types, which `storageLayout` alone does not record) are asserted
 * present rather than assumed.
 *
 * Consumers need ONE recompile after installing the plugin.
 */

import { extendConfig, subtask } from 'hardhat/config';
import { TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT } from 'hardhat/builtin-tasks/task-names';
import type { CompilerInput } from 'hardhat/types/artifacts';

/** solc's `settings.outputSelection`: source glob -> contract glob -> requested outputs. */
type OutputSelection = Record<string, Record<string, string[]>>;

/** Per-contract outputs this package cannot work without. */
const REQUIRED_CONTRACT_OUTPUTS = ['storageLayout', 'evm.deployedBytecode'] as const;

/**
 * Per-source outputs this package cannot work without.
 *
 * `ast` is not optional: solc's `storageLayout` records a user-defined value type's name and
 * byte count but NOT its underlying type, and `type Id is bytes32` vs. `type Id is uint256`
 * pad in opposite directions as mapping keys. Only the AST can tell them apart.
 */
const REQUIRED_SOURCE_OUTPUTS = ['ast'] as const;

/** solc's wildcard for "every source" and "every contract". */
const ANY = '*';
/** solc's contract key for outputs of the source file as a whole, such as `ast`. */
const WHOLE_SOURCE = '';

/** True for a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Copy `existing` and union the outputs this package requires into the `*`/`*` and `*`/``
 * buckets.
 *
 * The copy is deep enough to matter: the object reached through the compiler input is the very
 * object stored on the resolved config, shared across every compilation job in the run, so
 * mutating it in place would leak edits between jobs.
 *
 * Anything that is not shaped like an `outputSelection` is treated as absent rather than
 * coerced — solc would reject it anyway, and silently rewriting a malformed user config would
 * hide the real problem.
 *
 * @param existing - The current `outputSelection`, or anything else when none is set.
 * @returns A new selection holding the well-formed entries of `existing` plus the required
 * outputs. `existing` is not modified.
 */
export function withRequiredOutputs(existing: unknown): OutputSelection {
  const out: OutputSelection = {};

  if (isPlainObject(existing)) {
    for (const [sourceGlob, contractSelection] of Object.entries(existing)) {
      if (!isPlainObject(contractSelection)) continue;
      const copied: Record<string, string[]> = {};
      for (const [contractGlob, outputs] of Object.entries(contractSelection)) {
        if (!Array.isArray(outputs)) continue;
        copied[contractGlob] = outputs.filter((o): o is string => typeof o === 'string');
      }
      out[sourceGlob] = copied;
    }
  }

  const anySource = (out[ANY] ??= {});
  addAll((anySource[ANY] ??= []), REQUIRED_CONTRACT_OUTPUTS);
  addAll((anySource[WHOLE_SOURCE] ??= []), REQUIRED_SOURCE_OUTPUTS);

  return out;
}

/** Append each output to `target` unless it is already there. Mutates `target`. */
function addAll(target: string[], outputs: readonly string[]): void {
  for (const output of outputs) {
    if (!target.includes(output)) target.push(output);
  }
}

/**
 * Register both injection points. Called once, at plugin load.
 *
 * Safe to call more than once: a second extender finds every output already present and adds
 * nothing, and re-registering the subtask override wraps it again with the same idempotent edit.
 *
 * Must run while the Hardhat context exists; `extendConfig` and `subtask` throw otherwise.
 */
export function ensureStorageLayoutOutput(): void {
  // Injection point 1 (see the file header): every compiler and every override.
  extendConfig((config) => {
    const solcConfigs = [
      ...config.solidity.compilers,
      ...Object.values(config.solidity.overrides ?? {}),
    ];
    for (const solcConfig of solcConfigs) {
      const settings = (solcConfig.settings ??= {});
      settings.outputSelection = withRequiredOutputs(settings.outputSelection);
    }
  });

  // Injection point 2 (see the file header): patch the input the original subtask returns.
  subtask(
    TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT,
    async (taskArgs, _hre, runSuper): Promise<CompilerInput> => {
      const input = (await runSuper(taskArgs)) as CompilerInput;
      return {
        ...input,
        settings: {
          ...input.settings,
          outputSelection: withRequiredOutputs(input.settings?.outputSelection),
        },
      };
    }
  );
}
