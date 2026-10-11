/**
 * Gate: prove the plugin's `outputSelection` injection actually happened.
 *
 * This file is numbered `00` so Mocha loads it first (Hardhat 2 hands Mocha the test files in
 * sorted path order). It has to run before any read-correctness assertion, because every other
 * assertion in the suite would pass just as happily if `storageLayout` were being supplied by
 * some other means.
 *
 * `hardhat.config.ts` deliberately declares no `solidity.settings.outputSelection`. The only
 * thing that can put `storageLayout` into the build-info is
 * `src/hardhat2/ensureStorageLayoutOutput.ts`. So: wipe the build-info and the solc cache,
 * recompile from scratch, and read the raw compiler output back off disk. If the injection
 * silently no-ops, this fails — which is the whole point.
 */

import { expect } from 'chai';
import hre from 'hardhat';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FQN } from './helpers';

describe('storageLayout outputSelection injection', () => {
  before(async function () {
    this.timeout(300_000);
    // Both must go: `build-info` holds the output we inspect, and the solc files-cache is what
    // would otherwise let Hardhat skip the recompile entirely.
    await rm(join(hre.config.paths.artifacts, 'build-info'), { recursive: true, force: true });
    await rm(join(hre.config.paths.cache, 'solidity-files-cache.json'), { force: true });
    await hre.run('compile', { quiet: true });
  });

  it('asks solc for storageLayout without the fixture config declaring it', () => {
    const compilers = hre.config.solidity.compilers;
    expect(compilers).to.have.lengthOf.at.least(1);
    for (const compiler of compilers) {
      const selection = compiler.settings?.outputSelection as
        | Record<string, Record<string, string[]>>
        | undefined;
      expect(selection?.['*']?.['*'], 'resolved outputSelection for every contract').to.include(
        'storageLayout'
      );
      // The AST is what recovers a user-defined value type's UNDERLYING type, which
      // `storageLayout` alone does not record. Losing it would make UDVT keys pad wrongly.
      expect(selection?.['*']?.[''], 'resolved outputSelection for every source').to.include(
        'ast'
      );
    }
  });

  it('emits a non-empty storageLayout into the build-info after a clean compile', async () => {
    const buildInfo = await hre.artifacts.getBuildInfo(FQN.arrayStorage);
    expect(buildInfo, 'build-info for ArrayStorage').to.not.equal(undefined);

    const [sourceName, contractName] = FQN.arrayStorage.split(':');
    const output = buildInfo?.output.contracts?.[sourceName as string]?.[
      contractName as string
    ] as { storageLayout?: { storage?: unknown[]; types?: unknown } } | undefined;

    expect(output, 'compiler output for ArrayStorage').to.not.equal(undefined);
    expect(output?.storageLayout, 'storageLayout in the build-info').to.not.equal(undefined);
    expect(output?.storageLayout?.storage, 'storageLayout.storage').to.be.an('array');
    expect(output?.storageLayout?.storage?.length).to.be.greaterThan(0);
    expect(output?.storageLayout?.types, 'storageLayout.types').to.not.equal(null);
  });

  it('keeps the outputs the sanity check and the UDVT resolution depend on', async () => {
    const buildInfo = await hre.artifacts.getBuildInfo(FQN.userDefined);
    const [sourceName, contractName] = FQN.userDefined.split(':');

    const output = buildInfo?.output.contracts?.[sourceName as string]?.[
      contractName as string
    ] as { evm?: { deployedBytecode?: { object?: string } } } | undefined;
    expect(output?.evm?.deployedBytecode?.object, 'evm.deployedBytecode').to.be.a('string').and
      .not.equal('');

    expect(buildInfo?.output.sources?.[sourceName as string]?.ast, 'source AST').to.not.equal(
      undefined
    );
  });
});
