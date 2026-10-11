/**
 * Gate: prove the plugin's `outputSelection` injection actually happened.
 *
 * Numbered `00` so Mocha loads it first. It has to run before any read-correctness assertion,
 * because every other assertion in the suite would pass just as happily if `storageLayout`
 * were being supplied by some other means.
 *
 * `hardhat.config.ts` deliberately declares no `solidity.settings.outputSelection`, so the
 * only thing that can put `storageLayout` into the build info is the plugin's
 * `config.resolveUserConfig` hook (`src/hardhat3/ensureStorageLayoutOutput.ts`). Wipe the
 * artifacts and cache, recompile from scratch, and read solc's own output back off disk. If
 * the injection silently no-ops, this fails — which is the whole point.
 *
 * It also pins down which mechanism is in play: Hardhat 3's resolved config exposes
 * `solidity.profiles[*].compilers[*].settings.outputSelection`, so a fallback to the
 * documented manual-config path would be visible here rather than passing quietly.
 */

import { expect } from 'chai';
import hre from 'hardhat';
import { readFile } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { FQN } from './helpers.js';

interface SolcBuildInfoOutput {
  output?: {
    sources?: Record<string, { ast?: unknown }>;
    contracts?: Record<
      string,
      Record<string, { storageLayout?: { storage?: unknown[]; types?: unknown } }>
    >;
  };
}

/** Read the raw solc output file Hardhat 3 wrote for a contract's build. */
async function readSolcOutput(fullyQualifiedName: string): Promise<SolcBuildInfoOutput> {
  const buildInfoId = await hre.artifacts.getBuildInfoId(fullyQualifiedName);
  expect(buildInfoId, `build-info id for ${fullyQualifiedName}`).to.be.a('string');
  const path = await hre.artifacts.getBuildInfoOutputPath(buildInfoId as string);
  expect(path, `build-info output path for ${fullyQualifiedName}`).to.be.a('string');
  return JSON.parse(await readFile(path as string, 'utf8')) as SolcBuildInfoOutput;
}

describe('storageLayout outputSelection injection', () => {
  before(async function () {
    this.timeout(300_000);
    await rm(hre.config.paths.artifacts, { recursive: true, force: true });
    await rm(hre.config.paths.cache, { recursive: true, force: true });
    await hre.tasks.getTask('compile').run({});
  });

  it('asks solc for storageLayout without the fixture config declaring it', () => {
    const profiles = hre.config.solidity.profiles;
    expect(Object.keys(profiles)).to.have.lengthOf.at.least(1);

    for (const [profileName, profile] of Object.entries(profiles)) {
      expect(profile.compilers, `${profileName} compilers`).to.have.lengthOf.at.least(1);
      for (const compiler of profile.compilers) {
        const selection = compiler.settings?.outputSelection as
          | Record<string, Record<string, string[]>>
          | undefined;
        expect(
          selection?.['*']?.['*'],
          `resolved outputSelection for profile "${profileName}"`
        ).to.include('storageLayout');
      }
    }
  });

  it('emits a non-empty storageLayout into the build info after a clean compile', async () => {
    const buildInfo = await readSolcOutput(FQN.arrayStorage);
    const contracts = buildInfo.output?.contracts ?? {};

    // Hardhat 3 keys solc output by the INPUT source name (`project/contracts/...`), not by
    // the user source name, so find the entry rather than assuming the key.
    const entries = Object.entries(contracts).filter(
      ([source, byName]) => source.endsWith('contracts/ArrayStorage.sol') && 'ArrayStorage' in byName
    );
    expect(entries, 'compiler output for ArrayStorage').to.have.lengthOf(1);

    const layout = entries[0]?.[1]?.ArrayStorage?.storageLayout;
    expect(layout, 'storageLayout in the build info').to.not.equal(undefined);
    expect(layout?.storage, 'storageLayout.storage').to.be.an('array');
    expect(layout?.storage?.length).to.be.greaterThan(0);
    expect(layout?.types, 'storageLayout.types').to.not.equal(null);
  });

  it('keeps the source ASTs that user-defined value type resolution depends on', async () => {
    // `storageLayout` records a UDVT's name and byte count but NOT its underlying type, and
    // `type Id is bytes32` vs `type Id is uint256` pad in OPPOSITE directions as mapping keys.
    // Only the AST distinguishes them, so losing it would be silently wrong rather than loud.
    const buildInfo = await readSolcOutput(FQN.userDefined);
    const sources = buildInfo.output?.sources ?? {};
    const match = Object.entries(sources).find(([source]) =>
      source.endsWith('contracts/UserDefinedTypes.sol')
    );
    expect(match, 'source entry for UserDefinedTypes.sol').to.not.equal(undefined);
    expect(match?.[1]?.ast, 'source AST').to.not.equal(undefined);
  });

  it('exposes deployedBytecode for the contract/address sanity check', async () => {
    const artifact = await hre.artifacts.readArtifact(FQN.simple);
    expect(artifact.deployedBytecode).to.be.a('string').and.not.equal('');
  });
});
