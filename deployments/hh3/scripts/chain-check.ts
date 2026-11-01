/**
 * What `seal.ts` asks of the chain before it asks anything of the owner. Sealing cannot be undone,
 * so this manifest must hold on chain right now, on the read-back's own terms, and a result that
 * could not be checked refuses as a wrong one does.
 */

import { readFile } from 'node:fs/promises';
import type { HardhatRuntimeEnvironment } from 'hardhat/types/hre';
import {
  classifyReadFailure,
  createStorageDecoder,
  createStorageDecoderContext,
} from 'hardhat-storage-decoder/hardhat3';
import { applyPath, parseEntryName, readPending, toManifestValue } from '../../shared/manifest.js';
import type { Generation } from '../../shared/manifest.js';
import {
  DEFAULT_RUN_BUDGET,
  RunBudget,
  fullyQualifiedName,
  runReadBack,
  toStorageVariables,
} from '../../shared/readback-core.js';
import type { AdapterLink, EntryResult, StorageVariable } from '../../shared/readback-core.js';
import { MOCK_NAMES, readBackPlan } from '../../shared/seed-plan.js';
import { findReceipt, redactText } from './engine.js';
import type { Run } from './engine.js';
import { Refusal } from './guards.js';

const SHOWN_RESULTS = 5;
const NO_CODE_WAIT_MS = { local: 100, remote: 5_000 };

type StorageOutput = Record<
  string,
  Record<string, { storageLayout?: { storage?: Array<{ label: string; contract?: string }> } }>
>;

async function storageVariablesOf(
  hre: HardhatRuntimeEnvironment,
  contract: string
): Promise<StorageVariable[]> {
  const fqn = fullyQualifiedName(contract);
  const id = await hre.artifacts.getBuildInfoId(fqn as never);
  const path = await hre.artifacts.getBuildInfoOutputPath(id as string);
  const { output } = JSON.parse(await readFile(path as string, 'utf8')) as {
    output: { contracts: StorageOutput };
  };
  // Hardhat 3 keys solc output by the input source name, so find the entry.
  const found = Object.values(output.contracts).find((byName) => byName[contract] !== undefined);
  const storage = found?.[contract]?.storageLayout?.storage;
  if (storage === undefined) throw new Error(`${fqn} has no storageLayout`);
  return toStorageVariables(storage);
}

/** A pruned `historic` read is the one result a healthy public node gives, and it says nothing. */
export function blocksSealing({ verdict, blockTag }: EntryResult): boolean {
  return verdict !== 'pass' && !(verdict === 'needs-archive' && blockTag !== 'latest');
}

/**
 * A kill can leave a seal mined with the manifest not yet told, and the chain is then ahead of it,
 * which is what a resume is there to finish.
 */
async function withMinedSeal(run: Run, generation: Generation): Promise<Generation> {
  const pending = readPending(run.pendingPath);
  if (pending === undefined || !pending.stepId.startsWith('seal:')) return generation;
  const receipt = await findReceipt(run, pending.attempts.map(({ hash }) => hash));
  const entry = generation.contracts[pending.stepId.slice('seal:'.length)]?.expected.isSealed;
  if (receipt?.status !== '0x1' || entry === undefined) return generation;
  const copy = structuredClone(generation);
  (copy.contracts[pending.stepId.slice('seal:'.length)]?.expected.isSealed as typeof entry).value = true;
  return copy;
}

/** A read-back link on `provider`: the real provider underneath, with only the budget in front of it. */
export function budgetedLink(
  name: string,
  hre: HardhatRuntimeEnvironment,
  provider: Run['rpc'],
  budget: RunBudget
): AdapterLink {
  const request = ({ method, params }: { method: string; params?: unknown[] }) =>
    budget.send(() => provider.request({ method, params: params ?? [] }));
  const decoder = createStorageDecoder(createStorageDecoderContext(hre.artifacts, { request }));
  return {
    name,
    decoder,
    classifyReadFailure,
    rpc: (method, params) => request({ method, params: params ?? [] }),
    budget,
    storageVariables: (contract) => storageVariablesOf(hre, contract),
  };
}

export async function refuseUnverifiedChain(run: Run, generation: Generation): Promise<void> {
  const budget = new RunBudget(DEFAULT_RUN_BUDGET);
  const report = await runReadBack(
    budgetedLink('seal-check', run.hre, run.rpc, budget),
    {
      helpers: { applyPath, parseEntryName, toManifestValue },
      chainId: run.chainId,
      generation: await withMinedSeal(run, generation),
      expectedContracts: MOCK_NAMES,
      plan: readBackPlan(),
      noCodeWaitMs: run.isLocal ? NO_CODE_WAIT_MS.local : NO_CODE_WAIT_MS.remote,
      redact: redactText,
    }
  );
  const blocking = report.results.filter(blocksSealing);
  if (blocking.length > 0) {
    const shown = blocking
      .slice(0, SHOWN_RESULTS)
      .map(({ contract, entry, verdict, detail }) => `  ${contract} ${entry}: ${verdict}${detail ? `, ${detail}` : ''}`);
    throw new Refusal(
      `the read-back at head ${report.head} did not pass (${blocking.length} result(s)), so nothing ` +
        `was sealed:\n${shown.join('\n')}`
    );
  }
}
