/**
 * The Hardhat 2 half of the read-back, run by `scripts/readback.mjs`, which owns its settings and
 * its exit code. The logic is in `deployments/shared/readback-core.ts`.
 */

import { join } from 'node:path';
import hre from 'hardhat';
import { classifyReadFailure, createHardhatStorageDecoder } from 'hardhat-storage-decoder/hardhat2';
import { applyPath, atomicWriteJson, parseEntryName, readManifest, toManifestValue } from '../../shared/manifest';
import { fullyQualifiedName, runReadBackFromEnv, toStorageVariables } from '../../shared/readback-core';
import { readBackPlan } from '../../shared/seed-plan';
import type { StorageVariable } from '../../shared/readback-core';

async function storageVariables(contract: string): Promise<StorageVariable[]> {
  const fqn = fullyQualifiedName(contract);
  const artifact = await hre.artifacts.readArtifact(fqn);
  const buildInfo = await hre.artifacts.getBuildInfo(fqn);
  const output = buildInfo?.output.contracts[artifact.sourceName]?.[artifact.contractName] as
    | { storageLayout?: { storage?: Array<{ label: string; contract?: string }> } }
    | undefined;
  if (output?.storageLayout?.storage === undefined) throw new Error(`${fqn} has no storageLayout`);
  return toStorageVariables(output.storageLayout.storage);
}

function main(redact: (text: string) => string): Promise<void> {
  return runReadBackFromEnv(process.env, {
    helpers: { applyPath, atomicWriteJson, parseEntryName, readManifest, toManifestValue },
    plan: readBackPlan(),
    contractsDir: join(hre.config.paths.root, '..', 'contracts'),
    redact,
    makeLink(budget) {
      const provider = hre.network.provider;
      const send = (method: string, params: unknown[] = []) =>
        budget.send(() => provider.send(method, params as never[]));
      // The real provider underneath: only the budget is added, in front of it.
      const budgeted = Object.create(hre, { network: { value: { provider: { send } } } });
      const decoder = createHardhatStorageDecoder(budgeted);
      return { name: 'hh2', decoder, classifyReadFailure, rpc: send, budget, storageVariables };
    },
  });
}

// A dynamic import: this project is CommonJS, and the redactor is an ES module.
void import('../../../scripts/redact.mjs').then(async ({ makeRedactor }) => {
  const redact = makeRedactor([process.env.READBACK_RPC_URL, process.env.READBACK_SECOND_RPC_URL]);
  try {
    await main(redact);
  } catch (error) {
    console.error(`read-back failed: ${redact(String((error as Error).message ?? error))}`);
    process.exitCode = 1;
  }
});
