/**
 * Gate: this project compiles with the settings `deployments/hh2` pins, gets `storageLayout` from
 * the plugin rather than its config, and configures no key.
 */

import { expect } from 'chai';
import hre from 'hardhat';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** The mock set, so that an artifact lookup returning nothing cannot pass vacuously. */
const EXPECTED_MOCKS = 11;

interface SolcOutput {
  output?: {
    contracts?: Record<string, Record<string, { storageLayout?: { storage?: unknown[] } }>>;
  };
}

describe('deployment project config (Hardhat 3)', () => {
  before(async function () {
    this.timeout(300_000);
    await rm(hre.config.paths.artifacts, { recursive: true, force: true });
    await rm(hre.config.paths.cache, { recursive: true, force: true });
    await hre.tasks.getTask('compile').run({ quiet: true });
  });

  it('pins the compiler settings in the default profile', () => {
    const profile = hre.config.solidity.profiles.default;
    expect(profile?.compilers).to.have.lengthOf(1);
    const compiler = profile?.compilers[0];
    expect(compiler?.version).to.equal('0.8.26');
    expect((compiler?.settings.optimizer as { enabled?: boolean }).enabled).to.equal(false);
    expect(compiler?.settings.evmVersion).to.equal('cancun');
  });

  it('declares no outputSelection, and accounts only through configVariable', async () => {
    const source = await readFile(join(hre.config.paths.root, 'hardhat.config.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).to.not.include('outputSelection');
    expect(code.match(/accounts:.*/g)).to.deep.equal([
      "accounts: [configVariable('SEPOLIA_DEPLOYER_KEY')],",
    ]);
    expect(code.match(/url:.*/g)).to.deep.equal([
      'url: `http://127.0.0.1:${anvilPort}`,',
      "url: configVariable('READBACK_RPC_URL'),",
      "url: configVariable('SEPOLIA_RPC_URL'),",
    ]);
  });

  it('gives Sepolia no URL or key without its configuration variables', () => {
    const sepolia = hre.config.networks.sepolia as unknown as {
      chainId: number;
      timeout: number;
      url: { name: string };
      accounts: Array<{ name: string }>;
    };
    expect(sepolia.chainId).to.equal(11155111);
    expect(sepolia.timeout).to.equal(30_000);
    expect(sepolia.url.name).to.equal('SEPOLIA_RPC_URL');
    expect(sepolia.accounts.map(({ name }) => name)).to.deep.equal(['SEPOLIA_DEPLOYER_KEY']);
  });

  it('leaves the local network keyless and bounded', () => {
    const anvil = hre.config.networks.anvil as { type: string; accounts: unknown; timeout: number };
    expect(anvil.type).to.equal('http');
    expect(anvil.accounts).to.equal('remote');
    expect(anvil.timeout).to.equal(30_000);
    const readback = hre.config.networks.readback as { accounts: unknown; timeout: number };
    expect(readback.accounts).to.equal('remote');
    expect(readback.timeout).to.equal(30_000);
  });

  it('emits a storageLayout for every deployable mock', async () => {
    let checked = 0;
    for (const fqn of await hre.artifacts.getAllFullyQualifiedNames()) {
      const artifact = await hre.artifacts.readArtifact(fqn);
      if (artifact.bytecode === '0x') continue;
      const id = await hre.artifacts.getBuildInfoId(fqn);
      const path = await hre.artifacts.getBuildInfoOutputPath(id as string);
      const { output } = JSON.parse(await readFile(path as string, 'utf8')) as SolcOutput;
      // Hardhat 3 keys solc output by the INPUT source name, so find the entry.
      const name = artifact.contractName;
      const entry = Object.entries(output?.contracts ?? {}).find(
        ([source, byName]) => source.endsWith(`contracts/${name}.sol`) && name in byName
      );
      expect(entry?.[1][name]?.storageLayout?.storage, `layout of ${fqn}`).to.be.an('array').that.is
        .not.empty;
      checked += 1;
    }
    expect(checked).to.be.at.least(EXPECTED_MOCKS);
  });
});
