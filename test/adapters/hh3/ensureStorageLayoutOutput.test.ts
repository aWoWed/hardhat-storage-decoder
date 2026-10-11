/**
 * The Hardhat 3 `outputSelection` injection: the merge over a resolved config, and the
 * `resolveUserConfig` hook the plugin object registers to apply it.
 *
 * `withStorageLayoutSelector` and `union` are module-private; every branch of them is reached
 * here through `withStorageLayoutOutputSelection`, which maps them over each compiler.
 */

import type { HardhatConfig, HardhatUserConfig } from 'hardhat/types/config';
import { describe, expect, it } from 'vitest';
import {
  MANUAL_OUTPUT_SELECTION_SNIPPET,
  MissingStorageLayoutError,
  withStorageLayoutOutputSelection,
} from '../../../src/hardhat3/ensureStorageLayoutOutput.js';
import { configHooks } from '../../../src/hardhat3/hooks/config.js';
import storageDecoderPlugin from '../../../src/hardhat3/index.js';

type OutputSelection = Record<string, Record<string, string[]>>;

interface Compiler {
  version: string;
  settings?: Record<string, unknown> & { outputSelection?: OutputSelection };
}

interface Profile {
  compilers: Compiler[];
  overrides: Record<string, Compiler>;
}

/** The selectors injected into a compiler that selects nothing itself. */
const INJECTED: OutputSelection = {
  '*': { '*': ['storageLayout', 'evm.deployedBytecode.object'], '': ['ast'] },
};

/** Freeze a value and everything reachable from it, so an in-place edit throws. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** A resolved config with the given build profiles, frozen throughout. */
function configWith(profiles: Record<string, Profile>, rest: object = {}): HardhatConfig {
  return deepFreeze({ ...rest, solidity: { profiles } }) as unknown as HardhatConfig;
}

function profilesOf(config: HardhatConfig): Record<string, Profile> {
  return (config.solidity as unknown as { profiles: Record<string, Profile> }).profiles;
}

function selectionOf(compiler: Compiler | undefined): OutputSelection | undefined {
  return compiler?.settings?.outputSelection;
}

describe('withStorageLayoutOutputSelection (Hardhat 3)', () => {
  it('injects the selectors into a default config', () => {
    const config = configWith({
      default: { compilers: [{ version: '0.8.26', settings: {} }], overrides: {} },
    });

    const result = withStorageLayoutOutputSelection(config);

    expect(profilesOf(result)).toEqual({
      default: {
        compilers: [{ version: '0.8.26', settings: { outputSelection: INJECTED } }],
        overrides: {},
      },
    });
    expect(result).not.toBe(config);
  });

  it('injects them into a compiler that has no settings at all', () => {
    const config = configWith({ default: { compilers: [{ version: '0.8.26' }], overrides: {} } });

    const result = withStorageLayoutOutputSelection(config);

    expect(profilesOf(result)['default']?.compilers).toEqual([
      { version: '0.8.26', settings: { outputSelection: INJECTED } },
    ]);
  });

  it('keeps a user selection for specific files and contracts, and the other settings', () => {
    const optimizer = { enabled: true, runs: 200 };
    const config = configWith({
      default: {
        compilers: [
          {
            version: '0.8.26',
            settings: {
              optimizer,
              outputSelection: {
                'contracts/Vault.sol': { Vault: ['devdoc', 'userdoc'], '': ['legacyAST'] },
                'contracts/Token.sol': { '*': ['evm.gasEstimates'] },
              },
            },
          },
        ],
        overrides: {},
      },
    });
    const before = structuredClone(profilesOf(config));

    const result = withStorageLayoutOutputSelection(config);

    const [compiler] = profilesOf(result)['default']?.compilers ?? [];
    expect(selectionOf(compiler)).toEqual({
      'contracts/Vault.sol': { Vault: ['devdoc', 'userdoc'], '': ['legacyAST'] },
      'contracts/Token.sol': { '*': ['evm.gasEstimates'] },
      ...INJECTED,
    });
    expect(compiler?.settings?.['optimizer']).toBe(optimizer);
    // Every level of the input is frozen, so reaching here already shows nothing was edited in
    // place; the comparison shows nothing was replaced either.
    expect(profilesOf(config)).toEqual(before);
  });

  it('extends a user selection that already uses the wildcards', () => {
    const config = configWith({
      default: {
        compilers: [
          {
            version: '0.8.26',
            settings: {
              outputSelection: {
                '*': { '*': ['abi', 'devdoc'], '': ['legacyAST'], Vault: ['metadata'] },
                'contracts/Vault.sol': { '*': ['userdoc'] },
              },
            },
          },
        ],
        overrides: {},
      },
    });

    const result = withStorageLayoutOutputSelection(config);

    expect(selectionOf(profilesOf(result)['default']?.compilers[0])).toEqual({
      '*': {
        '*': ['abi', 'devdoc', 'storageLayout', 'evm.deployedBytecode.object'],
        '': ['legacyAST', 'ast'],
        Vault: ['metadata'],
      },
      'contracts/Vault.sol': { '*': ['userdoc'] },
    });
  });

  it('adds only what is missing when some selectors are already there', () => {
    const config = configWith({
      default: {
        compilers: [
          {
            version: '0.8.26',
            settings: { outputSelection: { '*': { '*': ['storageLayout'], '': ['ast'] } } },
          },
        ],
        overrides: {},
      },
    });

    const result = withStorageLayoutOutputSelection(config);

    const selection = selectionOf(profilesOf(result)['default']?.compilers[0]);
    expect(selection).toEqual(INJECTED);
    // The per-source list needed nothing, so it is the user's own array.
    expect(selection?.['*']?.['']).toBe(
      selectionOf(profilesOf(config)['default']?.compilers[0])?.['*']?.['']
    );
  });

  it('covers every build profile, every compiler and every override', () => {
    const config = configWith({
      default: {
        compilers: [
          { version: '0.8.26', settings: {} },
          { version: '0.7.6', settings: { outputSelection: { '*': { '*': ['abi'] } } } },
        ],
        overrides: {
          'contracts/Legacy.sol': { version: '0.6.12', settings: {} },
          'contracts/Tuned.sol': {
            version: '0.8.26',
            settings: { outputSelection: { 'contracts/Tuned.sol': { Tuned: ['devdoc'] } } },
          },
        },
      },
      production: {
        compilers: [{ version: '0.8.26', settings: { optimizer: { enabled: true } } }],
        overrides: {},
      },
    });

    const result = withStorageLayoutOutputSelection(config);

    const profiles = profilesOf(result);
    expect(Object.keys(profiles)).toEqual(['default', 'production']);
    const compilers = [
      ...(profiles['default']?.compilers ?? []),
      ...Object.values(profiles['default']?.overrides ?? {}),
      ...(profiles['production']?.compilers ?? []),
    ];
    expect(compilers.map((compiler) => compiler.version)).toEqual([
      '0.8.26', '0.7.6', '0.6.12', '0.8.26', '0.8.26',
    ]);
    for (const compiler of compilers) {
      const selection = selectionOf(compiler);
      expect(selection?.['*']?.['*']).toEqual(
        expect.arrayContaining(['storageLayout', 'evm.deployedBytecode.object'])
      );
      expect(selection?.['*']?.['']).toEqual(['ast']);
    }
    expect(selectionOf(profiles['default']?.compilers[1])?.['*']?.['*']?.[0]).toBe('abi');
    expect(
      selectionOf(profiles['default']?.overrides['contracts/Tuned.sol'])?.['contracts/Tuned.sol']
    ).toEqual({ Tuned: ['devdoc'] });
    expect(profiles['production']?.compilers[0]?.settings?.['optimizer']).toEqual({ enabled: true });
  });

  it('returns the same compiler objects when everything is already selected', () => {
    const config = configWith({
      default: {
        compilers: [
          { version: '0.8.26', settings: { outputSelection: structuredClone(INJECTED) } },
        ],
        overrides: {
          'contracts/Legacy.sol': {
            version: '0.6.12',
            settings: {
              outputSelection: {
                '*': { '*': ['abi', 'evm.deployedBytecode.object', 'storageLayout'], '': ['ast'] },
              },
            },
          },
        },
      },
    });

    const result = withStorageLayoutOutputSelection(config);

    // An unchanged compiler is not copied: no duplicate selector, and the same object.
    expect(profilesOf(result)['default']?.compilers[0]).toBe(
      profilesOf(config)['default']?.compilers[0]
    );
    expect(profilesOf(result)['default']?.overrides['contracts/Legacy.sol']).toBe(
      profilesOf(config)['default']?.overrides['contracts/Legacy.sol']
    );
    expect(profilesOf(result)).toEqual(profilesOf(config));
  });

  it('is stable when applied to its own result', () => {
    const config = configWith({
      default: {
        compilers: [{ version: '0.8.26', settings: { outputSelection: { '*': { '*': ['abi'] } } } }],
        overrides: {},
      },
    });

    const once = withStorageLayoutOutputSelection(config);
    const twice = withStorageLayoutOutputSelection(once);

    expect(profilesOf(twice)).toEqual(profilesOf(once));
    expect(profilesOf(twice)['default']?.compilers[0]).toBe(profilesOf(once)['default']?.compilers[0]);
  });

  it('treats a profile without overrides as having none', () => {
    const config = deepFreeze({
      solidity: { profiles: { default: { compilers: [{ version: '0.8.26', settings: {} }] } } },
    }) as unknown as HardhatConfig;

    const result = withStorageLayoutOutputSelection(config);

    expect(profilesOf(result)['default']?.overrides).toEqual({});
    expect(selectionOf(profilesOf(result)['default']?.compilers[0])).toEqual(INJECTED);
  });

  it('leaves the rest of the config and of the solidity config as it was', () => {
    const paths = { root: '/project' };
    const config = deepFreeze({
      paths,
      solidity: {
        npmFilesToBuild: ['dep/Thing.sol'],
        profiles: { default: { compilers: [{ version: '0.8.26', settings: {} }], overrides: {} } },
      },
    }) as unknown as HardhatConfig;

    const result = withStorageLayoutOutputSelection(config) as unknown as {
      paths: unknown;
      solidity: { npmFilesToBuild: unknown };
    };

    expect(result.paths).toBe(paths);
    expect(result.solidity.npmFilesToBuild).toEqual(['dep/Thing.sol']);
  });

  it.each([
    ['no solidity config', {}],
    ['a solidity config without build profiles', { solidity: {} }],
  ])('throws MissingStorageLayoutError for %s', (_case, config) => {
    let failure: unknown;
    try {
      withStorageLayoutOutputSelection(config as unknown as HardhatConfig);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MissingStorageLayoutError);
    const error = failure as MissingStorageLayoutError;
    expect(error.name).toBe('MissingStorageLayoutError');
    expect(error.fullyQualifiedName).toBeUndefined();
    expect(error.message).toContain(
      'This project has no solc "storageLayout" output: this project has no resolved Solidity' +
        ' configuration, so the storageLayout output selector could not be injected automatically.'
    );
    expect(error.message).toContain(MANUAL_OUTPUT_SELECTION_SNIPPET);
  });
});

describe('the resolveUserConfig hook (Hardhat 3)', () => {
  const USER_CONFIG = { solidity: '0.8.26' } as HardhatUserConfig;

  /** What the rest of the hook chain would resolve {@link USER_CONFIG} to. */
  function resolvedByNext(): HardhatConfig {
    return configWith({
      default: {
        compilers: [{ version: '0.8.26', settings: { outputSelection: { '*': { '*': ['abi'] } } } }],
        overrides: {},
      },
    });
  }

  it('extends what the rest of the chain resolved', async () => {
    const handlers = await configHooks();
    const resolver = (() => undefined) as never;
    const seen: unknown[][] = [];

    const result = await handlers.resolveUserConfig?.(USER_CONFIG, resolver, async (...args) => {
      seen.push(args);
      return resolvedByNext();
    });

    expect(seen).toEqual([[USER_CONFIG, resolver]]);
    expect(selectionOf(profilesOf(result as HardhatConfig)['default']?.compilers[0])).toEqual({
      '*': { '*': ['abi', 'storageLayout', 'evm.deployedBytecode.object'], '': ['ast'] },
    });
  });

  it('fails loudly when the chain resolved no Solidity config', async () => {
    const handlers = await configHooks();

    await expect(
      handlers.resolveUserConfig?.(USER_CONFIG, (() => undefined) as never, async () => {
        return {} as HardhatConfig;
      })
    ).rejects.toBeInstanceOf(MissingStorageLayoutError);
  });

  it('is the config hook the plugin object registers', async () => {
    const loaded = await storageDecoderPlugin.hookHandlers?.config?.();
    const factory = (loaded as { default: typeof configHooks }).default;
    const handlers = await factory();

    const result = await handlers.resolveUserConfig?.(
      USER_CONFIG,
      (() => undefined) as never,
      async () => resolvedByNext()
    );

    expect(
      selectionOf(profilesOf(result as HardhatConfig)['default']?.compilers[0])?.['*']?.['*']
    ).toContain('storageLayout');
  });
});
