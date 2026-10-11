/**
 * Hardhat 2 fixture project for `hardhat-storage-decoder/hardhat2`.
 *
 * ## Registration
 *
 * Hardhat 2 registers plugins by side-effect import from the config. The `import` below is
 * exactly the `require("hardhat-storage-decoder/hardhat2")` the adapter documents — this file
 * is compiled to CommonJS (the package is `"type": "commonjs"`), so it emits that very call.
 * Written as an `import` rather than a bare `require` so the `declare module` augmentation of
 * `HardhatRuntimeEnvironment` is in scope, which is what `test/types/augmentation.test-d.ts`
 * gates on.
 *
 * ## Why there is no `outputSelection` here
 *
 * Deliberate, and load-bearing. If this config declared
 * `solidity.settings.outputSelection = { "*": { "*": ["storageLayout"] } }` by hand, the whole
 * e2e suite would still pass even if the plugin's automatic injection silently did nothing —
 * a verification that cannot fail. `test/e2e/00-layout-injection.test.ts` asserts the
 * injection really happened; do not add an `outputSelection` key here.
 *
 * The solc version is pinned to the same 0.8.26 the golden-JSON unit fixtures were generated
 * with (`test/unit/fixtures/layouts.json`), so the two verification layers cannot drift onto
 * different layout encodings.
 */

import 'hardhat-storage-decoder/hardhat2';
import '@nomicfoundation/hardhat-ethers';
import type { HardhatUserConfig } from 'hardhat/config';

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.26',
    settings: {
      optimizer: { enabled: false },
    },
  },
  paths: {
    // Scoped to `e2e` so the type-only gate under `test/types/` is never loaded by Mocha.
    tests: 'test/e2e',
  },
  mocha: {
    timeout: 120_000,
  },
};

export default config;
