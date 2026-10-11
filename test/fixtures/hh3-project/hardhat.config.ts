/**
 * Hardhat 3 fixture project for `hardhat-storage-decoder/hardhat3`.
 *
 * ## Node.js requirement
 *
 * Hardhat 3 refuses to start on Node older than 22.13.0 (a hard check in its CLI, with no
 * environment-variable escape hatch), so `npm run test:e2e:hh3` needs a Node that new even
 * though the package under test itself supports Node 18. Recorded in this workspace's
 * `engines` field.
 *
 * ## Registration
 *
 * Hardhat 3 does NOT register plugins by side-effect import — a plugin only takes effect if it
 * is listed in the `plugins` array, which is what this config does. Importing the module and
 * leaving it out of the array would silently do nothing, which is exactly the mistake the e2e
 * suite has to be able to catch.
 *
 * `@nomicfoundation/hardhat-mocha` is listed explicitly because Hardhat 3 defaults to
 * `node:test`, not Mocha.
 *
 * ## Why there is no `outputSelection` here
 *
 * Deliberate, and load-bearing — the same reason as in the Hardhat 2 fixture. If this config
 * declared `solidity.settings.outputSelection` by hand, the entire suite would keep passing
 * even if the plugin's `config.resolveUserConfig` injection silently did nothing.
 * `test/e2e/00-layout-injection.test.ts` proves the injection really happened; do not add an
 * `outputSelection` key here.
 *
 * The solc version matches the golden-JSON unit fixtures (`test/unit/fixtures/layouts.json`,
 * solc 0.8.26) so the two verification layers cannot drift onto different layout encodings.
 */

import type { HardhatUserConfig } from 'hardhat/config';
import hardhatEthers from '@nomicfoundation/hardhat-ethers';
import hardhatMocha from '@nomicfoundation/hardhat-mocha';
import storageDecoderPlugin from 'hardhat-storage-decoder/hardhat3';

const config: HardhatUserConfig = {
  plugins: [storageDecoderPlugin, hardhatEthers, hardhatMocha],
  solidity: {
    version: '0.8.26',
    settings: {
      optimizer: { enabled: false },
    },
  },
  paths: {
    // Scoped to `e2e` so the type-only gate under `test/types/` is never loaded by Mocha.
    tests: { mocha: 'test/e2e' },
  },
  test: {
    mocha: { timeout: 120_000 },
  },
};

export default config;
