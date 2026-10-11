/**
 * `config` hook-handler category for the Hardhat 3 plugin.
 *
 * Kept in its own module because HH3 loads hook-handler categories lazily, via the
 * `import()` factories declared in `../index.ts`.
 */

import type { HookHandlerCategoryFactory } from 'hardhat/types/plugins';
import { withStorageLayoutOutputSelection } from '../ensureStorageLayoutOutput.js';

/**
 * A named export, not a default one: this package's root `"type"` is `commonjs`, so
 * `import("./hooks/config.js")` is typed with CommonJS interop, under which the namespace's
 * `default` is the whole module object rather than the default export. A named export
 * sidesteps that and is correct in both the CJS and ESM builds.
 */
export const configHooks: HookHandlerCategoryFactory<'config'> = async () => ({
  /**
   * `next` is called FIRST so that Hardhat's own solidity plugin has already turned the
   * user's polymorphic `solidity` config (a string, an array, a single/multi-version object,
   * or build profiles) into the one resolved shape — `solidity.profiles[*].compilers[*]` —
   * that we can extend uniformly.
   *
   * @returns The resolved config with `storageLayout` requested for every compiler.
   * @throws {MissingStorageLayoutError} when the resolved config has no Solidity configuration.
   */
  resolveUserConfig: async (userConfig, resolveConfigurationVariable, next) => {
    const resolvedConfig = await next(userConfig, resolveConfigurationVariable);
    return withStorageLayoutOutputSelection(resolvedConfig);
  },
});
