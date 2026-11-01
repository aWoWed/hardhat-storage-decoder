/**
 * Reads only, with no key. `run.mjs` gives the endpoint in the environment.
 *
 * The compiler settings must match the build that deployed the mocks, or the decoder's address
 * check rejects the code at the address. `timeout` replaces Hardhat 3's default of 300 s.
 */

import { configVariable } from 'hardhat/config';
import type { HardhatUserConfig } from 'hardhat/config';
import storageDecoderPlugin from 'hardhat-storage-decoder/hardhat3';

const config: HardhatUserConfig = {
  plugins: [storageDecoderPlugin],
  solidity: {
    version: '0.8.26',
    settings: {
      optimizer: { enabled: false },
      evmVersion: 'cancun',
    },
  },
  networks: {
    target: {
      type: 'http',
      url: configVariable('EXAMPLE_RPC_URL'),
      timeout: 30_000,
    },
  },
};

export default config;
