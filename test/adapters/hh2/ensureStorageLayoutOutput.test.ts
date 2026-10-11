/**
 * The Hardhat 2 `outputSelection` injection: the pure merge, and the two places it is applied.
 *
 * The root install carries Hardhat 2 as `hardhat-v2`, so the module's `hardhat/...` imports are
 * pointed there. Registration then runs against a real `HardhatContext`: the extender it leaves
 * behind is applied to a config resolved by Hardhat itself, and the subtask override is run
 * through a real `Environment`. No project is compiled; that part is the e2e suite's.
 */

import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HardhatContext } from 'hardhat-v2/internal/context';
import { resolveConfig } from 'hardhat-v2/internal/core/config/config-resolution';
import { Environment } from 'hardhat-v2/internal/core/runtime-environment';
import { TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT } from 'hardhat-v2/builtin-tasks/task-names';
import type { HardhatConfig, HardhatUserConfig, SolcConfig } from 'hardhat/types/config';
import type { HardhatArguments } from 'hardhat/types/runtime';
import {
  ensureStorageLayoutOutput,
  withRequiredOutputs,
} from '../../../src/hardhat2/ensureStorageLayoutOutput.js';

vi.mock('hardhat/config', async () => await import('hardhat-v2/config'));
vi.mock(
  'hardhat/builtin-tasks/task-names',
  async () => await import('hardhat-v2/builtin-tasks/task-names')
);

type OutputSelection = Record<string, Record<string, string[]>>;

/**
 * Hardhat derives the project root from the config file's location and insists the file
 * exists; it never reads it here, so any file of this repository's root serves.
 */
const CONFIG_PATH = path.join(process.cwd(), 'package.json');

/** What Hardhat 2 puts in a compiler's `outputSelection` when the user sets none. */
const HARDHAT_DEFAULT: OutputSelection = {
  '*': {
    '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'evm.methodIdentifiers', 'metadata'],
    '': ['ast'],
  },
};

function selectionOf(solcConfig: SolcConfig | undefined): OutputSelection {
  return (solcConfig?.settings as { outputSelection: OutputSelection }).outputSelection;
}

function expectRequiredOutputs(selection: OutputSelection): void {
  expect(selection['*']?.['*']).toEqual(
    expect.arrayContaining(['storageLayout', 'evm.deployedBytecode'])
  );
  expect(selection['*']?.['']).toContain('ast');
}

afterEach(() => {
  if (HardhatContext.isCreated()) HardhatContext.deleteHardhatContext();
});

describe('withRequiredOutputs (Hardhat 2)', () => {
  it('builds the whole selection when there is none', () => {
    const expected = { '*': { '*': ['storageLayout', 'evm.deployedBytecode'], '': ['ast'] } };

    expect(withRequiredOutputs(undefined)).toEqual(expected);
    expect(withRequiredOutputs(null)).toEqual(expected);
    expect(withRequiredOutputs('storageLayout')).toEqual(expected);
    expect(withRequiredOutputs(['storageLayout'])).toEqual(expected);
  });

  it("adds storageLayout to Hardhat's default selection and keeps the rest in order", () => {
    const before = structuredClone(HARDHAT_DEFAULT);

    const merged = withRequiredOutputs(HARDHAT_DEFAULT);

    expect(merged).toEqual({
      '*': {
        '*': [
          'abi',
          'evm.bytecode',
          'evm.deployedBytecode',
          'evm.methodIdentifiers',
          'metadata',
          'storageLayout',
        ],
        '': ['ast'],
      },
    });
    // The argument is the object stored on the resolved config: it must be left as it was.
    expect(HARDHAT_DEFAULT).toEqual(before);
    expect(merged).not.toBe(HARDHAT_DEFAULT);
    expect(merged['*']).not.toBe(HARDHAT_DEFAULT['*']);
    expect(merged['*']?.['*']).not.toBe(HARDHAT_DEFAULT['*']?.['*']);
  });

  it('keeps a user selection for specific files and contracts', () => {
    const user: OutputSelection = {
      'contracts/Vault.sol': { Vault: ['devdoc', 'userdoc'], '': ['legacyAST'] },
      'contracts/Token.sol': { '*': ['evm.gasEstimates'] },
    };
    const before = structuredClone(user);

    const merged = withRequiredOutputs(user);

    expect(merged).toEqual({
      ...before,
      '*': { '*': ['storageLayout', 'evm.deployedBytecode'], '': ['ast'] },
    });
    expect(user).toEqual(before);
    expect(merged['contracts/Vault.sol']?.['Vault']).not.toBe(user['contracts/Vault.sol']?.['Vault']);
  });

  it('extends a user selection that already uses the wildcards', () => {
    const user: OutputSelection = {
      '*': { '*': ['abi', 'devdoc'], Vault: ['metadata'] },
      'contracts/Vault.sol': { '*': ['userdoc'] },
    };
    const before = structuredClone(user);

    const merged = withRequiredOutputs(user);

    expect(merged).toEqual({
      '*': {
        '*': ['abi', 'devdoc', 'storageLayout', 'evm.deployedBytecode'],
        Vault: ['metadata'],
        '': ['ast'],
      },
      'contracts/Vault.sol': { '*': ['userdoc'] },
    });
    expect(user).toEqual(before);
  });

  it('adds nothing twice when every output is already selected', () => {
    const user: OutputSelection = {
      '*': { '*': ['storageLayout', 'abi', 'evm.deployedBytecode'], '': ['ast', 'legacyAST'] },
    };

    const merged = withRequiredOutputs(user);

    expect(merged).toEqual(user);
    expect(withRequiredOutputs(merged)).toEqual(user);
  });
});

describe('ensureStorageLayoutOutput (Hardhat 2)', () => {
  const USER_SELECTION: OutputSelection = {
    'contracts/Vault.sol': { Vault: ['devdoc'] },
    '*': { '*': ['abi', 'evm.gasEstimates'] },
  };

  /** A config resolved by Hardhat, with the extenders registered so far applied as Hardhat does. */
  function resolveWithExtenders(userConfig: HardhatUserConfig): HardhatConfig {
    const resolved = resolveConfig(CONFIG_PATH, userConfig);
    for (const extender of HardhatContext.getHardhatContext().configExtenders) {
      extender(resolved, userConfig);
    }
    return resolved;
  }

  it('registers one config extender and overrides the compiler-input subtask', () => {
    const context = HardhatContext.createHardhatContext();

    ensureStorageLayoutOutput();

    expect(context.configExtenders).toHaveLength(1);
    expect(Object.keys(context.tasksDSL.getTaskDefinitions())).toEqual([
      TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT,
    ]);
  });

  it('extends the default config', () => {
    HardhatContext.createHardhatContext();
    ensureStorageLayoutOutput();

    const config = resolveWithExtenders({ solidity: '0.8.26' });

    expect(config.solidity.compilers).toHaveLength(1);
    expect(selectionOf(config.solidity.compilers[0])).toEqual({
      '*': { '*': [...(HARDHAT_DEFAULT['*']?.['*'] ?? []), 'storageLayout'], '': ['ast'] },
    });
  });

  it('extends every compiler and every override, keeping what the user selected', () => {
    HardhatContext.createHardhatContext();
    ensureStorageLayoutOutput();

    const config = resolveWithExtenders({
      solidity: {
        compilers: [
          { version: '0.8.26', settings: { outputSelection: structuredClone(USER_SELECTION) } },
          { version: '0.7.6' },
        ],
        overrides: {
          'contracts/Legacy.sol': {
            version: '0.6.12',
            settings: { outputSelection: { '*': { '*': ['storageLayout'] } } },
          },
          'contracts/Plain.sol': { version: '0.5.17' },
        },
      },
    });

    const [first, second] = config.solidity.compilers;
    const legacy = config.solidity.overrides['contracts/Legacy.sol'];
    const plain = config.solidity.overrides['contracts/Plain.sol'];
    for (const solcConfig of [first, second, legacy, plain]) {
      expectRequiredOutputs(selectionOf(solcConfig));
    }

    // The user's own entries survive next to the injected ones (Hardhat adds its defaults too).
    const customised = selectionOf(first);
    expect(customised['contracts/Vault.sol']).toEqual({ Vault: ['devdoc'] });
    expect(customised['*']?.['*']).toEqual(expect.arrayContaining(['abi', 'evm.gasEstimates']));
    // Already selected by the user: present once.
    expect(selectionOf(legacy)['*']?.['*']?.filter((o) => o === 'storageLayout')).toHaveLength(1);
    // The second compiler and the bare override start from Hardhat's defaults.
    expect(selectionOf(second)['*']?.['*']).toEqual(expect.arrayContaining(['abi', 'metadata']));
    expect(selectionOf(plain)['*']?.['*']).toEqual(expect.arrayContaining(['abi', 'metadata']));
  });

  it('adds nothing when it is registered a second time', () => {
    HardhatContext.createHardhatContext();
    ensureStorageLayoutOutput();
    const once = resolveWithExtenders({ solidity: '0.8.26' });

    ensureStorageLayoutOutput();
    const twice = resolveWithExtenders({ solidity: '0.8.26' });

    expect(HardhatContext.getHardhatContext().configExtenders).toHaveLength(2);
    expect(twice.solidity).toEqual(once.solidity);
  });

  describe('the compiler-input subtask override', () => {
    /**
     * Stand in for Hardhat's own subtask (which needs a compilation job) with one returning
     * `input`, register the override on top of it, and run the task through an `Environment`.
     */
    async function runCompilerInputSubtask(input: unknown): Promise<{
      settings: { optimizer?: unknown; outputSelection: OutputSelection };
      sources?: unknown;
      language?: unknown;
    }> {
      const context = HardhatContext.createHardhatContext();
      context.tasksDSL.subtask(TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT, async () => input);
      ensureStorageLayoutOutput();
      const environment = new Environment(
        resolveConfig(CONFIG_PATH, {}),
        {} as HardhatArguments,
        context.tasksDSL.getTaskDefinitions(),
        context.tasksDSL.getScopesDefinitions(),
        context.environmentExtenders
      );
      return environment.run(TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT);
    }

    it('adds the outputs to an input built without them', async () => {
      // What a plugin that rebuilds the input from something other than the resolved compiler
      // settings would hand to solc.
      const input = {
        language: 'Solidity',
        sources: { 'contracts/Vault.sol': { content: 'contract Vault {}' } },
        settings: {
          optimizer: { enabled: true, runs: 200 },
          outputSelection: { 'contracts/Vault.sol': { Vault: ['abi'] } },
        },
      };
      const before = structuredClone(input);

      const patched = await runCompilerInputSubtask(input);

      expect(patched.settings.outputSelection).toEqual({
        'contracts/Vault.sol': { Vault: ['abi'] },
        '*': { '*': ['storageLayout', 'evm.deployedBytecode'], '': ['ast'] },
      });
      expect(patched.settings.optimizer).toEqual({ enabled: true, runs: 200 });
      expect(patched.sources).toEqual(before.sources);
      expect(patched.language).toBe('Solidity');
      // The original subtask's result is shared with the resolved config; it stays as it was.
      expect(input).toEqual(before);
    });

    it('adds the outputs to an input with no outputSelection at all', async () => {
      const patched = await runCompilerInputSubtask({ language: 'Solidity', sources: {}, settings: {} });

      expect(patched.settings.outputSelection).toEqual({
        '*': { '*': ['storageLayout', 'evm.deployedBytecode'], '': ['ast'] },
      });
    });

    it('leaves an input that already has them equal to what it was', async () => {
      const selection = withRequiredOutputs(HARDHAT_DEFAULT);

      const patched = await runCompilerInputSubtask({
        language: 'Solidity',
        sources: {},
        settings: { outputSelection: selection },
      });

      expect(patched.settings.outputSelection).toEqual(selection);
    });
  });
});
