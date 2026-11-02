/**
 * Deploys and seeds the sealed mocks, one confirmed transaction at a time. Re-running it resumes;
 * see `engine.ts`. Sealing is a separate command, `seal.ts`.
 *
 *   node_modules/hardhat/dist/src/cli.js run scripts/seed.ts --network anvil
 *
 * ## `requiresArchive`
 *
 * True for every entry pinned at a block before the final state, false for every `latest` entry.
 * Sepolia's `publicnode` keeps about 33 hours of history, and pruned a month-old read with error
 * 4444, when measured on 2026-10-31, and sealing comes later than that window can promise.
 * So a historic entry is treated as needing an archive on every chain, and AC 3's durable evidence
 * is the value observed at seed time, stored with the entry.
 *
 * ## Variables
 *
 * - `SEED_REPLACE_FEE=1`: replace a transaction stuck unmined, at the same nonce and a higher fee.
 * - `SEED_NEW_GENERATION=1`: deploy again after a sealed generation, sources changed or not. The new
 *   generation records its own source hash. Refused while the current generation is unsealed.
 * - `SEED_RETIRE_UNSEALED=1`: give up on a generation that cannot finish, such as one with a reverted
 *   step, and start a new one. The old one stays recorded, so no hand-editing is needed. Its
 *   addresses are abandoned, and sources may have changed since it was made.
 * - `SEED_CONFIRMATIONS=N`: blocks to wait after a recorded change. 0 locally, 3 otherwise.
 * - `SEED_ALLOW_NONCE_START=1`: start a generation on an account whose nonce the manifest cannot
 *   explain. A lost pending record looks exactly like this, and could mean a duplicate deployment.
 */

import hre from 'hardhat';
import { readPending } from '../../shared/manifest.js';
import {
  checkHistoryEvidence,
  clearConfirmedPending,
  currentGeneration,
  isSealedGeneration,
  openSigned,
  redactText,
  retireGeneration,
  runSteps,
  startGeneration,
} from './engine.js';
import type { Run } from './engine.js';
import { Refusal } from './guards.js';
import { assertSeedEncodings, seedSteps } from '../../shared/seed-plan.js';

async function main(): Promise<void> {
  const steps = seedSteps();
  assertSeedEncodings(steps);

  const retiring = process.env.SEED_RETIRE_UNSEALED === '1';
  const wantsNew = process.env.SEED_NEW_GENERATION === '1';
  // A kill before a new generation's first save leaves only the pending record of it.
  const startedNextOn = (run: Run): boolean => {
    const current = currentGeneration(run);
    const pending = readPending(run.pendingPath);
    return (
      isSealedGeneration(current) &&
      pending !== undefined &&
      pending.nonce > (current?.steps.at(-1)?.nonce ?? -1)
    );
  };
  const { run, wallet } = await openSigned(hre, (opened) => {
    const current = currentGeneration(opened);
    if (wantsNew && !retiring && current !== undefined && !isSealedGeneration(current) && !startedNextOn(opened)) {
      throw new Refusal(
        'the current generation is not sealed, so SEED_NEW_GENERATION does not apply. Run without ' +
          'it to resume, seal it, or retire it with SEED_RETIRE_UNSEALED=1.'
      );
    }
    return retiring || startedNextOn(opened) || (wantsNew && isSealedGeneration(current));
  });
  let generation = currentGeneration(run);
  const isFinished = isSealedGeneration(generation);
  const startedNext = startedNextOn(run);
  if (isFinished && !startedNext) clearConfirmedPending(run);

  if (retiring) {
    if (isFinished && !startedNext) {
      throw new Refusal('the current generation is sealed, so there is nothing to retire.');
    }
    if (generation === undefined || startedNext) generation = startGeneration(run, wallet.address);
    generation = await retireGeneration(run, wallet, generation);
  } else if (isFinished && !startedNext && !wantsNew) {
    console.log('seed: the current generation is sealed. Nothing to do.');
    return;
  } else if (generation === undefined || isFinished) {
    generation = startGeneration(run, wallet.address);
  }

  await runSteps(run, wallet, generation, steps);
  await checkHistoryEvidence(run, wallet, generation);

  console.log(
    `seed: complete on chain ${run.chainId}, ${generation.steps.length} transaction(s), ` +
      `deployer ${wallet.address}`
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${error instanceof Refusal ? 'refused' : 'seed failed'}: ${redactText(message)}`);
  process.exitCode = 1;
});
