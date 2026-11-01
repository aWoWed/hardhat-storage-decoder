/**
 * Seals every mock of the current generation. **Irreversible**, and only ever its own command:
 * `seed.ts` never seals. It asks for the chain ID and the first 8 characters of the commit, and it
 * has no flag or variable that skips the question.
 *
 * Before the question, and before any key loads, the recorded blocks must be unchanged and a
 * read-back of this manifest must pass at the current head. A result that could not be checked
 * refuses too.
 *
 *   node_modules/hardhat/dist/src/cli.js run scripts/seal.ts --network anvil
 */

import { createInterface } from 'node:readline';
import hre from 'hardhat';
import {
  clearConfirmedPending,
  currentGeneration,
  open,
  checkBinding,
  openSigned,
  redactText,
  refuseChangedBlocks,
  repoCommit,
  runSteps,
} from './engine.js';
import { refuseUnverifiedChain } from './chain-check.js';
import { Refusal } from './guards.js';
import { sealSteps, seedSteps } from '../../shared/seed-plan.js';

async function askConfirmation(chainId: number, commit: string): Promise<void> {
  const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const ask = async (question: string): Promise<string> => {
    process.stdout.write(`${question}: `);
    const { value, done } = await lines.next();
    return done === true ? '' : String(value).trim();
  };
  console.log('seal() is irreversible: no setter of these contracts will ever work again.');
  const typedChain = await ask('Type the chain ID');
  const typedCommit = await ask('Type the first 8 characters of the current commit');
  await lines.return?.();
  process.stdin.pause();
  if (typedChain !== String(chainId) || typedCommit !== commit.slice(0, 8)) {
    throw new Refusal('the confirmation did not match, so nothing was sealed');
  }
}

async function main(): Promise<void> {
  // The checks run before the question, and again with the key, on the state after the answer.
  const preview = await open(hre);
  checkBinding(preview);
  const planned = currentGeneration(preview);
  if (planned === undefined) throw new Refusal('nothing is deployed on this chain yet');
  const missing = seedSteps().filter((step) => !planned.steps.some((done) => done.id === step.id));
  if (missing.length > 0) {
    throw new Refusal(`the seed is incomplete (${missing.length} step(s) left). Finish it first.`);
  }
  const contract = planned.contracts.MockValueTypes;
  const hasEvidence = Object.values(contract?.expected ?? {}).some(
    (entry) => entry.observed !== undefined
  );
  if (!hasEvidence) throw new Refusal('no seed-time history evidence is recorded (AC 3)');

  if (Object.values(planned.contracts).every((item) => item.sealBlock !== null)) {
    clearConfirmedPending(preview);
    console.log('seal: already sealed. Nothing to do.');
    return;
  }

  await refuseChangedBlocks(preview, planned);
  await refuseUnverifiedChain(preview, planned);

  await askConfirmation(preview.chainId, repoCommit());

  const { run, wallet } = await openSigned(hre);
  const generation = currentGeneration(run);
  if (generation === undefined) throw new Refusal('the manifest changed during the confirmation');
  await runSteps(run, wallet, generation, sealSteps());
  console.log(`seal: complete on chain ${run.chainId}, ${generation.steps.length} transaction(s) in all`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${error instanceof Refusal ? 'refused' : 'seal failed'}: ${redactText(message)}`);
  process.exitCode = 1;
});
