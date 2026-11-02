/**
 * The Hardhat 3 half of the read-back, run by `scripts/readback.mjs`, which owns its settings and
 * its exit code. The logic is in `deployments/shared/readback-core.ts`.
 */

import { join } from 'node:path';
import hre from 'hardhat';
import { makeRedactor } from '../../../scripts/redact.mjs';
import { applyPath, atomicWriteJson, parseEntryName, readManifest, toManifestValue } from '../../shared/manifest.js';
import { runReadBackFromEnv } from '../../shared/readback-core.js';
import { readBackPlan } from '../../shared/seed-plan.js';
import { budgetedLink } from './chain-check.js';
import type { Run } from './engine.js';

const redact = makeRedactor([process.env.READBACK_RPC_URL, process.env.READBACK_SECOND_RPC_URL]);

function main(): Promise<void> {
  return runReadBackFromEnv(process.env, {
    helpers: { applyPath, atomicWriteJson, parseEntryName, readManifest, toManifestValue },
    plan: readBackPlan(),
    contractsDir: join(hre.config.paths.root, '..', 'contracts'),
    redact,
    async makeLink(budget) {
      const connection = await hre.network.create();
      return budgetedLink('hh3', hre, connection.provider as unknown as Run['rpc'], budget);
    },
  });
}

main().catch((error: unknown) => {
  console.error(`read-back failed: ${redact(String((error as Error).message ?? error))}`);
  process.exitCode = 1;
});
