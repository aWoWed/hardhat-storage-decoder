/**
 * Hardhat 2 project that compiles the verified mainnet sources `scripts/mainnet-check.mjs` fetches
 * into the ignored `contracts/`, and reads those contracts. It deploys and signs nothing, and
 * configures no key. Compiler settings come from `candidates.json`, per file, and are the ones the
 * contract was verified with: there is no other way to reproduce its code.
 *
 * `mainnetCheck` takes its URL from the environment, set only by the check for the one command
 * that reads. The URL can hold a token, so nothing here prints it.
 */
require('hardhat-storage-decoder/hardhat2');

const { candidates } = require('./candidates.json');

const compilerOf = ({ solc, settings }) => ({ version: solc, settings });

module.exports = {
  solidity: {
    compilers: [compilerOf(candidates[0])],
    overrides: Object.fromEntries(
      candidates.map((candidate) => [
        `contracts/${candidate.id}/${candidate.file}`,
        compilerOf(candidate),
      ])
    ),
  },
  networks: {
    mainnetCheck: {
      url: process.env.MAINNET_CHECK_RPC_URL ?? 'http://127.0.0.1:8545',
      timeout: 30_000,
    },
  },
};
