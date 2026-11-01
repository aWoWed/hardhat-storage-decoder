/**
 * Hardhat 2 project that reads the sealed public mocks. It never deploys or signs, and it
 * configures no key: Hardhat 2's `vars` store is not encrypted, so a key has no place here.
 *
 * ## Compiler settings
 *
 * `evmVersion` is explicit and matches `deployments/hh3`. Without it, Hardhat 2 forces `paris`
 * for this solc, and code built here would differ from what Hardhat 3 deployed. There is no
 * `outputSelection`, for the reason given in `test/fixtures/hh2-project/hardhat.config.ts`:
 * `test/config.test.ts` asserts that the plugin's injection really happened.
 *
 * ## Networks
 *
 * The in-process default, a local Anvil, and `readback`, which reads only, with no key.
 * `scripts/readback.mjs` gives it each run's endpoint in the environment.
 */

import 'hardhat-storage-decoder/hardhat2';
import type { HardhatUserConfig } from 'hardhat/config';

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.26',
    settings: {
      optimizer: { enabled: false },
      evmVersion: 'cancun',
    },
  },
  networks: {
    anvil: {
      url: 'http://127.0.0.1:8545',
      timeout: 30_000,
    },
    readback: {
      url: process.env.READBACK_RPC_URL ?? 'http://127.0.0.1:8545',
      timeout: 30_000,
    },
  },
  paths: {
    tests: 'test',
  },
  mocha: {
    timeout: 120_000,
  },
};

export default config;
