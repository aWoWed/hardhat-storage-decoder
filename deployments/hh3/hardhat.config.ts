/**
 * Hardhat 3 project that deploys and reads the sealed public mocks.
 *
 * Hardhat 3 refuses to start on Node older than 22.13, so run it through
 * `npm run deployments:test`, which uses `npx -y node@22.14` when the local Node is older.
 *
 * ## Compiler settings
 *
 * `evmVersion` is explicit and matches `deployments/hh2`. Hardhat 2 would otherwise force `paris`
 * for this solc, and the two builds of one source would produce different code, which the
 * decoder's address check rejects. There is no `outputSelection`, for the reason given in
 * `test/fixtures/hh3-project/hardhat.config.ts`: `test/config.test.ts` asserts that the plugin's
 * injection really happened.
 *
 * ## Networks
 *
 * The in-process default and a local Anvil configure no key. Anvil's address is always loopback;
 * only its port can change, which is how the seed tests run on a port of their own.
 *
 * `readback` reads only, with no key. `scripts/readback.mjs` gives it each run's endpoint in the
 * environment.
 *
 * `sepolia` holds no URL and no key in this file. Both come through `configVariable` when the
 * network is actually used, from the owner's keystore (`hardhat keystore set`), so without that
 * keystore the network cannot run. `seed.ts` and `seal.ts` refuse to run while the key is in the
 * environment, because Hardhat 3 reads an environment variable first.
 */

import { configVariable } from 'hardhat/config';
import type { HardhatUserConfig } from 'hardhat/config';
import hardhatEthers from '@nomicfoundation/hardhat-ethers';
import hardhatKeystore from '@nomicfoundation/hardhat-keystore';
import hardhatMocha from '@nomicfoundation/hardhat-mocha';
import storageDecoderPlugin from 'hardhat-storage-decoder/hardhat3';

const anvilPort = process.env.DEPLOYMENTS_ANVIL_PORT ?? '8545';
if (!/^\d+$/.test(anvilPort)) throw new Error('DEPLOYMENTS_ANVIL_PORT must be a port number');

const config: HardhatUserConfig = {
  plugins: [storageDecoderPlugin, hardhatEthers, hardhatKeystore, hardhatMocha],
  solidity: {
    version: '0.8.26',
    settings: {
      optimizer: { enabled: false },
      evmVersion: 'cancun',
    },
  },
  networks: {
    anvil: {
      type: 'http',
      url: `http://127.0.0.1:${anvilPort}`,
      timeout: 30_000,
    },
    readback: {
      type: 'http',
      url: configVariable('READBACK_RPC_URL'),
      timeout: 30_000,
    },
    sepolia: {
      type: 'http',
      chainId: 11155111,
      url: configVariable('SEPOLIA_RPC_URL'),
      accounts: [configVariable('SEPOLIA_DEPLOYER_KEY')],
      timeout: 30_000,
    },
  },
  paths: {
    tests: { mocha: 'test' },
  },
  test: {
    mocha: { timeout: 120_000 },
  },
};

export default config;
