/**
 * Gate: this project compiles with the settings `deployments/hh3` pins, gets `storageLayout` from
 * the plugin rather than its config, and configures no key.
 */

import { expect } from 'chai';
import hre from 'hardhat';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** The mock set, so that an artifact lookup returning nothing cannot pass vacuously. */
const EXPECTED_MOCKS = 11;

describe('deployment project config (Hardhat 2)', () => {
  before(async function () {
    this.timeout(300_000);
    await rm(hre.config.paths.artifacts, { recursive: true, force: true });
    await rm(hre.config.paths.cache, { recursive: true, force: true });
    await hre.run('compile', { quiet: true });
  });

  it('pins the compiler settings', () => {
    expect(hre.config.solidity.compilers).to.have.lengthOf(1);
    const compiler = hre.config.solidity.compilers[0];
    expect(compiler?.version).to.equal('0.8.26');
    expect(compiler?.settings.optimizer.enabled).to.equal(false);
    expect(compiler?.settings.evmVersion).to.equal('cancun');
  });

  it('declares no outputSelection and no accounts in its own config', async () => {
    const source = await readFile(join(hre.config.paths.root, 'hardhat.config.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).to.not.include('outputSelection');
    expect(code).to.not.include('accounts');
  });

  it('leaves the local network keyless and bounded', () => {
    const anvil = hre.config.networks.anvil as { accounts: unknown; timeout: number };
    expect(anvil.accounts).to.equal('remote');
    expect(anvil.timeout).to.equal(30_000);
    const readback = hre.config.networks.readback as { accounts: unknown; timeout: number };
    expect(readback.accounts).to.equal('remote');
    expect(readback.timeout).to.equal(30_000);
    expect(Object.keys(hre.config.networks).sort()).to.deep.equal([
      'anvil',
      'hardhat',
      'localhost',
      'readback',
    ]);
  });

  it('emits a storageLayout and records cancun for every deployable mock', async () => {
    let checked = 0;
    for (const fqn of await hre.artifacts.getAllFullyQualifiedNames()) {
      const artifact = await hre.artifacts.readArtifact(fqn);
      if (artifact.bytecode === '0x') continue;
      const buildInfo = await hre.artifacts.getBuildInfo(fqn);
      expect(buildInfo?.input.settings.evmVersion, `evmVersion of ${fqn}`).to.equal('cancun');
      const output = buildInfo?.output.contracts[artifact.sourceName]?.[artifact.contractName] as
        | { storageLayout?: { storage?: unknown[] } }
        | undefined;
      expect(output?.storageLayout?.storage, `layout of ${fqn}`).to.be.an('array').that.is.not.empty;
      checked += 1;
    }
    expect(checked).to.be.at.least(EXPECTED_MOCKS);
  });
});
