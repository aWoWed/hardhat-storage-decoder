/**
 * The transaction engine behind `seed.ts` and `seal.ts`.
 *
 * Per transaction: build with an explicit nonce and sign locally; persist the signed transaction
 * to the pending record; broadcast; wait for the receipt; write the confirmation to the manifest;
 * clear the pending record. A crash at any point therefore resumes from what is on disk and on
 * chain, and never signs a second transaction for a nonce that might already be spent.
 *
 * ## Keys
 *
 * On Sepolia the key comes only from `configVariable`, through the Hardhat 3 keystore, and only
 * after every refusal has passed. Locally it is generated at run time and funded with
 * `anvil_setBalance`, so no key text exists in the repo. `SEED_LOCAL_KEY` hands a runtime key to a
 * resuming process and is refused on any other chain.
 */

import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Interface, Transaction, Wallet, getCreateAddress, id, randomBytes, hexlify } from 'ethers';
import type { InterfaceAbi } from 'ethers';
import type { HardhatRuntimeEnvironment } from 'hardhat/types/hre';
import {
  atomicWriteJson,
  clearPending,
  readManifest,
  readPending,
  removeOrphanTemps,
  sameSources,
  sourceHash,
  toManifestValue,
  parseEntryName,
  applyPath,
} from '../../shared/manifest.js';
import type {
  ContractRecord,
  ExpectedEntry,
  Generation,
  Manifest,
  PendingRecord,
  SolcSettings,
  StepRecord,
} from '../../shared/manifest.js';
import {
  KEY_ENV_VAR,
  Refusal,
  refuseBinding,
  refuseChain,
  refuseDirtyTree,
  refuseEnvironment,
  refuseLockDrift,
  refuseNetwork,
  refuseStaleCopies,
} from './guards.js';
import { fullyQualifiedName } from '../../shared/readback-core.js';
import { lockDrift } from '../../shared/lock-drift.mjs';
import { makeRedactor } from '../../../scripts/redact.mjs';
import { extraRevisionStep, extraRevisionStepFromId } from '../../shared/seed-plan.js';
import type { SeedStep } from '../../shared/seed-plan.js';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const HH3 = join(SCRIPTS, '..');
const DEPLOYMENTS = join(HH3, '..');
const REPO_ROOT = join(DEPLOYMENTS, '..');
const PUBLIC_MANIFEST = join(DEPLOYMENTS, 'manifest', 'deployments.json');
const LOCAL_FOLDER = join(DEPLOYMENTS, 'manifest', 'local');

/** `revision`, after `owner` and `isSealed` in slot 0. `seed.test.ts` checks this against solc. */
export const REVISION_SLOT = 1;

const LOCAL_BALANCE = `0x${(10n ** 21n).toString(16)}`;
const TIP_WEI = 1_000_000_000n;
/**
 * A lagging node can estimate against state from before the last step, so the limit does not trust
 * its estimate alone. Unused gas is refunded, so this asks for a higher balance, not a higher cost.
 */
const GAS_MARGIN_PERCENT = 150n;
const CALL_GAS_FLOOR = 300_000n;
const REPLACEMENT_FEE_PERCENT = 125n;
const MAX_EXTRA_CHANGES = 3;
const REMOTE_CONFIRMATIONS = 3;
const NONCE_CHECKS = 6;
const NONCE_CHECK_MS = { local: 100, remote: 5_000 };

/** Wording of a broadcast the node already has, which is not a failure of a rebroadcast. */
const ALREADY_SENT = /already known|known transaction|already imported|nonce too low|underpriced/i;
/**
 * The wordings of `classifyRpcError` (`src/core/rpc/classifyRpcError.ts`), which the package does
 * not export. `seed.test.ts` holds the copy equal to the source.
 */
export const PRUNED = /pruned history|missing trie node|historical state|\bstate\b.*\bnot available/i;
export const PRUNED_CODE = 4444;
/** Anvil's own wording, for a block below its head only: above it, a node is merely behind. */
const OUT_OF_RANGE = /block height is (\d+) but requested was (\d+)/;

export type KillPoint =
  | 'after-signing'
  | 'mid-write-pending'
  | 'after-broadcast'
  | 'after-receipt'
  | 'mid-write-manifest'
  | 'after-save';

interface Rpc {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface Run {
  hre: HardhatRuntimeEnvironment;
  rpc: Rpc;
  decoder: { contract(fqn: string): any };
  networkName: string;
  chainId: number;
  isLocal: boolean;
  manifestPath: string;
  pendingPath: string;
  manifest: Manifest;
  sourceHash: string;
  solcSettings: SolcSettings;
  killSpec: string | undefined;
  pollMs: number;
  waitMs: number;
  confirmations: number;
}

const toHex = (value: bigint | number): string => `0x${BigInt(value).toString(16)}`;

export { fullyQualifiedName };

let redactor = makeRedactor([]);

/** Knows the endpoint once it is resolved, so a bare token in a DNS error goes too. */
export function useEndpointForRedaction(url: string): void {
  redactor = makeRedactor([url]);
}

/** Everything these scripts print about a failure goes through this. */
export function redactText(text: string): string {
  return redactor(text);
}

/** Never quotes the value: a mistyped key is still most of a key. */
export function walletFrom(key: string, name: string): Wallet {
  try {
    return new Wallet(key);
  } catch {
    throw new Refusal(`${name} in the keystore is not a valid private key`);
  }
}

/**
 * One run at a time per chain and folder. Another would delete this one's temp files and race it for
 * the nonce. A killed run leaves its lock behind, so a lock whose process is gone does not count.
 */
export function acquireRunLock(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      process.once('exit', () => rmSync(path, { force: true }));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = Number(readFileSync(path, 'utf8'));
    if (holder === process.pid) return;
    if (isRunning(holder)) {
      throw new Refusal(
        `another seed or seal is running as process ${holder}. If it is not, delete ${path}.`
      );
    }
    rmSync(path, { force: true });
  }
  throw new Refusal(`could not take the run lock at ${path}`);
}

function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Stops at a named point of a named step and waits to be killed from outside, so the kill tests
 * terminate a real process at an exact place. Inert unless `SEED_TEST_KILL` names it, which the
 * guards refuse on any chain but the local one.
 */
function killPoint(run: Run, point: KillPoint, stepId: string): void {
  if (!run.isLocal || run.killSpec !== `${point}@${stepId}`) return;
  writeSync(2, `KILLPOINT ${run.killSpec}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000);
  process.exit(99);
}

export function currentGeneration(run: Run): Generation | undefined {
  return run.manifest.chains[String(run.chainId)]?.generations.at(-1);
}

function saveManifest(run: Run, stepId: string): void {
  atomicWriteJson(run.manifestPath, run.manifest, () =>
    killPoint(run, 'mid-write-manifest', stepId)
  );
}

function commitOf(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Refusal('cannot read the current commit');
  return result.stdout.trim();
}

export const repoCommit = commitOf;

/**
 * Resolves the endpoint, connects, and refuses the wrong chain, without resolving the key. `remote`
 * keeps the configured key out of this connection, which would otherwise resolve it on the first
 * request, ahead of this refusal. Transactions are signed by `loadSigner`'s wallet and sent raw, so
 * the connection never needs it.
 */
export async function connectChecked(hre: HardhatRuntimeEnvironment, networkName: string) {
  const { url } = hre.config.networks[networkName] as unknown as {
    url: { getUrl(): Promise<string> };
  };
  useEndpointForRedaction(await url.getUrl());
  const connection = await hre.network.create({
    network: networkName,
    override: { accounts: 'remote' },
  } as never);
  const chainId = Number(await connection.provider.request({ method: 'eth_chainId' }));
  refuseChain(networkName, chainId);
  return { connection, chainId };
}

/**
 * For a run about to treat the generation as finished. A kill between saving the last confirmation
 * and clearing the record leaves one behind, which is safe to clear only if the manifest shows that
 * very transaction confirmed. Anything else may still be in flight.
 */
export function clearConfirmedPending(run: Run): void {
  const pending = readPending(run.pendingPath);
  if (pending === undefined) return;
  const step = currentGeneration(run)?.steps.find(({ id }) => id === pending.stepId);
  const confirmed =
    step !== undefined &&
    step.nonce === pending.nonce &&
    pending.attempts.some(({ hash }) => hash === step.txHash);
  if (!confirmed) {
    throw new Refusal(
      `${run.pendingPath} holds step ${pending.stepId} at nonce ${pending.nonce}, which this ` +
        'finished generation does not show confirmed. Nothing was sent or cleared. Check that ' +
        'transaction before going on.'
    );
  }
  clearPending(run.pendingPath);
}

/** Whether every mock of a generation has been sealed. */
export function isSealedGeneration(generation: Generation | undefined): boolean {
  return (
    generation !== undefined &&
    Object.keys(generation.contracts).length > 0 &&
    Object.values(generation.contracts).every((contract) => contract.sealBlock !== null)
  );
}

/** Everything that must hold before a key is touched. Exits through `Refusal` otherwise. */
export async function open(hre: HardhatRuntimeEnvironment): Promise<Run> {
  const networkName = hre.globalOptions.network ?? 'default';
  refuseNetwork(networkName);
  refuseEnvironment(networkName, process.env);
  const isLocal = networkName === 'anvil';

  const folder = isLocal ? (process.env.SEED_MANIFEST_DIR ?? LOCAL_FOLDER) : LOCAL_FOLDER;
  const compiler = hre.config.solidity.profiles.default?.compilers[0];
  if (compiler === undefined) throw new Refusal('no compiler is configured');
  const solcSettings: SolcSettings = {
    version: compiler.version,
    optimizer: compiler.settings.optimizer,
    evmVersion: compiler.settings.evmVersion,
  };

  const sources = join(DEPLOYMENTS, 'contracts');
  refuseStaleCopies(sameSources(sources, join(HH3, 'contracts')));
  if (!isLocal) {
    // Before the endpoint is resolved, which is the first thing that can prompt for a password.
    refuseDirtyTree(REPO_ROOT);
    refuseLockDrift(lockDrift(HH3));
  }

  const { connection, chainId } = await connectChecked(hre, networkName);

  const manifestPath = isLocal ? join(folder, `deployments-${chainId}.json`) : PUBLIC_MANIFEST;
  const pendingPath = join(folder, `pending-${chainId}.json`);
  acquireRunLock(join(folder, `run-${chainId}.lock`));
  removeOrphanTemps(manifestPath);
  removeOrphanTemps(pendingPath);

  return {
    hre,
    rpc: connection.provider as unknown as Rpc,
    decoder: (connection as unknown as { storageDecoder: Run['decoder'] }).storageDecoder,
    networkName,
    chainId,
    isLocal,
    manifestPath,
    pendingPath,
    manifest: readManifest(manifestPath),
    sourceHash: sourceHash(sources, solcSettings),
    solcSettings,
    killSpec: process.env.SEED_TEST_KILL,
    pollMs: isLocal ? 25 : 4_000,
    waitMs: isLocal ? 15_000 : 900_000,
    confirmations: confirmationsFrom(process.env.SEED_CONFIRMATIONS, isLocal),
  };
}

function confirmationsFrom(text: string | undefined, isLocal: boolean): number {
  if (text === undefined) return isLocal ? 0 : REMOTE_CONFIRMATIONS;
  if (!/^\d+$/.test(text)) throw new Refusal('SEED_CONFIRMATIONS must be a whole number');
  return Number(text);
}

/** The signer. Runs last, so no refusal can fire with a key in memory. */
async function loadSigner(run: Run): Promise<Wallet> {
  if (run.isLocal) {
    const key = process.env.SEED_LOCAL_KEY ?? hexlify(randomBytes(32));
    const wallet = walletFrom(key, 'SEED_LOCAL_KEY');
    await run.rpc.request({ method: 'anvil_setBalance', params: [wallet.address, LOCAL_BALANCE] });
    return wallet;
  }
  const network = run.hre.config.networks[run.networkName] as unknown as {
    accounts: Array<{ getHexString(): Promise<string> }>;
  };
  const [variable] = network.accounts;
  if (variable === undefined) throw new Refusal(`network ${run.networkName} configures no key`);
  return walletFrom(await variable.getHexString(), KEY_ENV_VAR);
}

/** Binds this run to what the manifest recorded. Runs before the signer is loaded. */
export function checkBinding(run: Run): void {
  refuseBinding(currentGeneration(run)?.sourceHash, run.sourceHash);
}

/** A local manifest outliving its node would resume against contracts that are not there. */
async function refuseStaleLocal(run: Run, generation: Generation | undefined): Promise<void> {
  if (!run.isLocal || generation === undefined) return;
  const [first] = Object.values(generation.contracts);
  if (first === undefined) return;
  const code = await run.rpc.request({ method: 'eth_getCode', params: [first.address, 'latest'] });
  if (code === '0x') {
    throw new Refusal(
      `${run.manifestPath} records contracts this node does not have, so the node was probably ` +
        'restarted. Delete that file and the pending file beside it, and run again.'
    );
  }
}

export function startGeneration(run: Run, deployer: string): Generation {
  const generation: Generation = {
    deployer,
    repoCommit: commitOf(),
    sourceHash: run.sourceHash,
    solcSettings: run.solcSettings,
    steps: [],
    contracts: {},
  };
  const chain = (run.manifest.chains[String(run.chainId)] ??= { generations: [] });
  chain.generations.push(generation);
  return generation;
}

async function readArtifact(run: Run, contract: string) {
  return run.hre.artifacts.readArtifact(fullyQualifiedName(contract) as never) as Promise<{
    abi: unknown;
    bytecode: string;
  }>;
}

async function encodeStep(run: Run, step: SeedStep, generation: Generation) {
  const artifact = await readArtifact(run, step.contract);
  const abi = new Interface(artifact.abi as InterfaceAbi);
  if (step.fn === undefined) {
    return { to: undefined, data: artifact.bytecode + abi.encodeDeploy(step.args as never[]).slice(2) };
  }
  const contract = generation.contracts[step.contract];
  if (contract === undefined) throw new Error(`${step.id} runs before its deployment`);
  return { to: contract.address, data: abi.encodeFunctionData(step.fn, step.args as never[]) };
}

/** The limit a step is sent with. A deployment has no floor: its estimate is far above any. */
export function gasLimitFor(estimate: bigint, isDeployment: boolean): bigint {
  const margin = (estimate * GAS_MARGIN_PERCENT) / 100n;
  return isDeployment || margin > CALL_GAS_FLOOR ? margin : CALL_GAS_FLOOR;
}

async function nextFees(run: Run): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const block = (await run.rpc.request({
    method: 'eth_getBlockByNumber',
    params: ['latest', false],
  })) as { baseFeePerGas?: string };
  const base = BigInt(block.baseFeePerGas ?? 0);
  return { maxFeePerGas: base * 2n + TIP_WEI, maxPriorityFeePerGas: TIP_WEI };
}

async function nonces(run: Run, address: string): Promise<{ latest: number; pending: number }> {
  const count = async (tag: string) =>
    Number(
      await run.rpc.request({ method: 'eth_getTransactionCount', params: [address, tag] })
    );
  return { latest: await count('latest'), pending: await count('pending') };
}

interface Receipt {
  status: string;
  blockNumber: string;
  blockHash: string;
  contractAddress: string | null;
  transactionHash: string;
}

export async function findReceipt(run: Run, hashes: readonly string[]): Promise<Receipt | undefined> {
  for (const hash of hashes) {
    const receipt = (await run.rpc.request({
      method: 'eth_getTransactionReceipt',
      params: [hash],
    })) as Receipt | null;
    if (receipt !== null) return receipt;
  }
  return undefined;
}

async function waitForReceipt(run: Run, record: PendingRecord): Promise<Receipt> {
  const hashes = record.attempts.map((attempt) => attempt.hash);
  const deadline = Date.now() + run.waitMs;
  for (;;) {
    const receipt = await findReceipt(run, hashes);
    if (receipt !== undefined) return receipt;
    if (Date.now() > deadline) {
      throw new Refusal(
        `step ${record.stepId} is still unmined at nonce ${record.nonce}. Run the same command ` +
          'again to keep waiting, or with SEED_REPLACE_FEE=1 to replace it at a higher fee.'
      );
    }
    await sleep(run.pollMs);
  }
}

/** Holds a step until its block is N deep, following the receipt if a reorg moves it. */
async function waitForConfirmations(run: Run, record: PendingRecord, stepId: string): Promise<Receipt> {
  const hashes = record.attempts.map((attempt) => attempt.hash);
  const deadline = Date.now() + run.waitMs;
  for (;;) {
    const receipt = await findReceipt(run, hashes);
    if (receipt !== undefined) {
      const head = Number(await run.rpc.request({ method: 'eth_blockNumber', params: [] }));
      if (head >= Number(receipt.blockNumber) + run.confirmations) return receipt;
    }
    if (Date.now() > deadline) {
      throw new Refusal(
        `step ${stepId} did not reach ${run.confirmations} confirmation(s) in time. Run the same ` +
          'command again to keep waiting.'
      );
    }
    await sleep(run.pollMs);
  }
}

/**
 * Holds the next step until the node shows the new code, at the receipt's block and at its head. A
 * node behind the receipt would estimate the next call against an empty account, far too low.
 */
async function waitForCode(run: Run, stepId: string, address: string, block: number): Promise<void> {
  const deadline = Date.now() + run.waitMs;
  for (;;) {
    let failure: unknown;
    try {
      const [atBlock, atHead] = await Promise.all(
        [toHex(block), 'latest'].map((tag) =>
          run.rpc.request({ method: 'eth_getCode', params: [address, tag] })
        )
      );
      if (atBlock !== '0x' && atHead !== '0x') return;
    } catch (error) {
      failure = error;
    }
    if (Date.now() > deadline) {
      if (failure !== undefined) throw failure;
      throw new Refusal(
        `step ${stepId} has a receipt, but this node shows no code at ${address}. Run the same ` +
          'command again once it has caught up.'
      );
    }
    await sleep(run.pollMs);
  }
}

async function broadcast(run: Run, raw: string, isRebroadcast: boolean): Promise<void> {
  try {
    await run.rpc.request({ method: 'eth_sendRawTransaction', params: [raw] });
  } catch (error) {
    if (!isRebroadcast || !ALREADY_SENT.test(String((error as Error).message))) throw error;
  }
}

/** Writes the step's confirmation and what it left in storage, then clears the pending record. */
async function confirm(
  run: Run,
  generation: Generation,
  step: SeedStep,
  record: PendingRecord,
  mined: Receipt
): Promise<void> {
  const receipt =
    step.recordsRevision === true && run.confirmations > 0
      ? await waitForConfirmations(run, record, step.id)
      : mined;
  if (receipt.status !== '0x1') {
    throw new Refusal(
      `step ${step.id} reverted in transaction ${receipt.transactionHash}. Nothing more was sent. ` +
        'This generation cannot finish: run with SEED_RETIRE_UNSEALED=1 to retire it and start a new one.'
    );
  }
  const block = Number(receipt.blockNumber);
  const first = record.attempts[0]?.hash;

  if (step.fn === undefined) {
    const address = receipt.contractAddress;
    if (address === null || address.toLowerCase() !== record.predictedAddress?.toLowerCase()) {
      throw new Refusal(`step ${step.id} did not create the predicted address`);
    }
    await waitForCode(run, step.id, address, block);
    const contract: ContractRecord = {
      address: record.predictedAddress,
      deployBlock: block,
      txHash: receipt.transactionHash,
      sealBlock: null,
      sealTxHash: null,
      expected: {
        owner: { value: generation.deployer, blockTag: 'latest', requiresArchive: false },
        isSealed: { value: false, blockTag: 'latest', requiresArchive: false },
      },
    };
    generation.contracts[step.contract] = contract;
  } else {
    const contract = generation.contracts[step.contract] as ContractRecord;
    if (step.fn === 'seal') {
      contract.sealBlock = block;
      contract.sealTxHash = receipt.transactionHash;
    }
    for (const [entry, value] of Object.entries(step.sets)) {
      contract.expected[entry] = { value, blockTag: 'latest', requiresArchive: false };
    }
    for (const [entry, kind] of Object.entries(step.dynamic ?? {})) {
      contract.expected[entry] =
        kind === 'callback'
          ? {
              value: `${contract.address.toLowerCase()}${id('seal()').slice(2, 10)}`,
              blockTag: 'latest',
              requiresArchive: false,
            }
          : {
              value: await readCodePosition(run, step.contract, contract, entry, block),
              blockTag: 'latest',
              requiresArchive: false,
              buildDependent: true,
            };
    }
    if (step.recordsRevision === true) {
      await recordRevision(run, step, contract, block);
    }
  }

  const stepRecord: StepRecord = {
    id: step.id,
    nonce: record.nonce,
    txHash: receipt.transactionHash,
    block,
  };
  if (first !== undefined && first !== receipt.transactionHash) stepRecord.signedTxHash = first;
  if (step.recordsRevision === true) stepRecord.blockHash = receipt.blockHash;
  generation.steps.push(stepRecord);

  saveManifest(run, step.id);
  killPoint(run, 'after-save', step.id);
  clearPending(run.pendingPath);
}

/**
 * The value of `op`, at the block that set it. It is only known by reading it, so a zero here means
 * the node answered for a state from before the step, and recording that would bind the manifest to
 * a wrong value.
 */
async function readCodePosition(
  run: Run,
  contractName: string,
  contract: ContractRecord,
  entry: string,
  block: number
): Promise<string> {
  const value = toManifestValue((await readDecoded(run, contractName, contract, entry, block)).value);
  if (/^0x0*$/.test(String(value))) {
    throw new Refusal(`${contractName}.${entry} reads zero at block ${block}, just after being set`);
  }
  return String(value);
}

async function readDecoded(
  run: Run,
  contractName: string,
  contract: ContractRecord,
  entry: string,
  block: number
) {
  const bound = run.decoder.contract(fullyQualifiedName(contractName)).target(contract.address);
  return applyPath(bound, parseEntryName(entry)).at(block).read();
}

/** Reads `revision` at `block`. Raw and at a literal slot, so this is not the decoder's own word. */
async function readRevisionAt(run: Run, address: string, block: number): Promise<bigint> {
  const word = await run.rpc.request({
    method: 'eth_getStorageAt',
    params: [address, toHex(REVISION_SLOT), toHex(block)],
  });
  return BigInt(word as string);
}

export function isPrunedError(error: unknown): boolean {
  const chain: Array<{ code?: unknown; message?: unknown; cause?: unknown; parent?: unknown }> = [];
  for (let node = error as (typeof chain)[number] | undefined; node instanceof Object; ) {
    if (chain.includes(node)) break;
    chain.push(node);
    node = (node.cause ?? node.parent) as (typeof chain)[number] | undefined;
  }
  // Transport first, as in `classifyRpcError`: such a message quotes a host and says nothing about
  // state. RPC codes are numbers, and system ones such as ECONNRESET are strings.
  if (chain.some(({ code }) => typeof code === 'string')) return false;
  const wording = chain.map(({ message }) => String(message ?? '')).join('\n');
  const range = OUT_OF_RANGE.exec(wording);
  if (range !== null) return Number(range[2]) < Number(range[1]);
  return PRUNED.test(wording) || chain.some(({ code }) => code === PRUNED_CODE);
}

/**
 * AC 3 evidence: reads the change straight back at its block, through the endpoint that took it. If
 * that is already out of reach the entry stays, without `observed`, since the read-back requires one
 * for every change; `ensureHistoryEvidence` then makes another.
 */
async function recordRevision(
  run: Run,
  step: SeedStep,
  contract: ContractRecord,
  block: number
): Promise<void> {
  const value = String(step.args[0]);
  // Historic whatever the node: this is the rule for `requiresArchive`, see `seed.ts`.
  const entry: ExpectedEntry = { value, blockTag: block, requiresArchive: true };
  contract.expected[`revision@${block}`] = entry;
  let observed: bigint;
  try {
    observed = await readRevisionAt(run, contract.address, block);
  } catch (error) {
    if (isPrunedError(error)) return;
    throw error;
  }
  if (observed.toString() !== value) {
    throw new Refusal(`revision at block ${block} reads ${observed}, not the ${value} just set`);
  }
  entry.observed = { value, block, endpointLabel: `hardhat-network:${run.networkName}` };
}

/** Sends the steps in order, resuming first from any pending record. */
export async function runSteps(
  run: Run,
  wallet: Wallet,
  generation: Generation,
  steps: readonly SeedStep[]
): Promise<void> {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const done = (id_: string): boolean => generation.steps.some((step) => step.id === id_);

  const pending = readPending(run.pendingPath);
  if (pending !== undefined) {
    if (pending.deployer !== wallet.address || pending.chainId !== run.chainId) {
      throw new Refusal(
        `${run.pendingPath} belongs to a different deployer or chain, so it cannot be resumed`
      );
    }
    if (done(pending.stepId)) {
      // Killed between saving the confirmation and clearing this record.
      clearPending(run.pendingPath);
    } else {
      const step = byId.get(pending.stepId) ?? extraRevisionStepFromId(pending.stepId);
      if (step === undefined) {
        throw new Refusal(`pending step ${pending.stepId} is not part of this command`);
      }
      await resume(run, wallet, generation, step, pending);
    }
  }

  for (const step of steps) {
    if (done(step.id)) continue;
    await send(run, wallet, generation, step);
  }
}

/** Mined: complete it. Nonce spent otherwise: stop. Neither: the same raw transaction again. */
async function resume(
  run: Run,
  wallet: Wallet,
  generation: Generation,
  step: SeedStep,
  pending: PendingRecord
): Promise<void> {
  const hashes = pending.attempts.map((attempt) => attempt.hash);
  // Twice, since a node behind its load balancer can report the nonce before the receipt.
  for (let check = 0; check < 2; check += 1) {
    const mined = await findReceipt(run, hashes);
    if (mined !== undefined) return confirm(run, generation, step, pending, mined);
    if (check === 0) await sleep(run.pollMs * 20);
  }

  const { latest } = await nonces(run, wallet.address);
  if (latest > pending.nonce) {
    throw new Refusal(
      `nonce ${pending.nonce} was used by a transaction other than the signed ${step.id}. ` +
        'Nothing was sent. Check the deployer on an explorer before going on.'
    );
  }

  if (process.env.SEED_REPLACE_FEE === '1') {
    const replaced = Transaction.from(pending.attempts.at(-1)?.raw as string);
    const signed = await wallet.signTransaction({
      type: 2,
      chainId: run.chainId,
      nonce: pending.nonce,
      to: replaced.to,
      data: replaced.data,
      gasLimit: replaced.gasLimit,
      maxFeePerGas: ((replaced.maxFeePerGas as bigint) * REPLACEMENT_FEE_PERCENT) / 100n,
      maxPriorityFeePerGas:
        ((replaced.maxPriorityFeePerGas as bigint) * REPLACEMENT_FEE_PERCENT) / 100n,
    });
    pending.attempts.push({ hash: Transaction.from(signed).hash as string, raw: signed });
    // Recorded before the broadcast, so resuming treats either hash as this step's.
    atomicWriteJson(run.pendingPath, pending);
    await broadcast(run, signed, false);
  } else {
    await broadcast(run, pending.attempts.at(-1)?.raw as string, true);
  }

  await confirm(run, generation, step, pending, await waitForReceipt(run, pending));
}

/** Where this account's next generation should start, from what the manifest knows of it. */
function expectedStartNonce(run: Run, address: string): number {
  const generations = run.manifest.chains[String(run.chainId)]?.generations ?? [];
  const used = generations
    .filter(({ deployer }) => deployer === address)
    .flatMap(({ steps }) => steps.map(({ nonce }) => nonce + 1));
  return used.length === 0 ? 0 : Math.max(...used);
}

/**
 * The nonce for the next step. A load-balanced node can answer one count from a backend behind the
 * other, so a disagreement must last before it counts for anything.
 */
async function settledNonce(run: Run, address: string, generation: Generation): Promise<number> {
  const last = generation.steps.at(-1);
  const allowAnyStart = last === undefined && process.env.SEED_ALLOW_NONCE_START === '1';
  const expected = last === undefined ? expectedStartNonce(run, address) : last.nonce + 1;
  const waitMs = run.isLocal ? NONCE_CHECK_MS.local : NONCE_CHECK_MS.remote;
  for (let check = 1; ; check += 1) {
    const { latest, pending } = await nonces(run, address);
    if (latest === pending && (latest === expected || allowAnyStart)) return latest;
    if (check >= NONCE_CHECKS) {
      if (latest !== pending) {
        throw new Refusal(
          `this node reports the deployer's nonce as ${latest} mined and ${pending} pending, over ` +
            `${check} checks. A transaction this run does not know of may be in flight, or the node ` +
            'may be behind. Nothing was sent.'
        );
      }
      throw new Refusal(
        `the deployer's nonce is ${latest}, but the manifest expects ${expected}. Something else ` +
          'used this account, or a pending record was lost, and sending now could deploy twice. ' +
          (last === undefined
            ? 'If this account really has unrelated history, set SEED_ALLOW_NONCE_START=1. '
            : '') +
          'Nothing was sent.'
      );
    }
    await sleep(waitMs);
  }
}

/**
 * Gives up on a generation that cannot finish, and starts the next. The old one stays recorded, and
 * being no longer last is what retires it. Refuses while its last transaction could still land.
 */
export async function retireGeneration(
  run: Run,
  wallet: Wallet,
  generation: Generation
): Promise<Generation> {
  const pending = readPending(run.pendingPath);
  if (pending !== undefined) {
    if (pending.deployer !== wallet.address || pending.chainId !== run.chainId) {
      throw new Refusal(`${run.pendingPath} belongs to a different deployer or chain`);
    }
    const receipt = await findReceipt(run, pending.attempts.map(({ hash }) => hash));
    if (receipt?.status === '0x1') {
      throw new Refusal(
        `step ${pending.stepId} succeeded and only needs recording. Run without SEED_RETIRE_UNSEALED.`
      );
    }
    if (receipt === undefined) {
      const { latest } = await nonces(run, wallet.address);
      if (latest <= pending.nonce) {
        throw new Refusal(
          `step ${pending.stepId} is unmined and could still land. Run without ` +
            'SEED_RETIRE_UNSEALED until it is mined, or replace it with SEED_REPLACE_FEE=1.'
        );
      }
    }
    // Kept in the old generation: it is why that nonce is spent.
    generation.steps.push({
      id: `abandoned:${pending.stepId}`,
      nonce: pending.nonce,
      txHash: receipt?.transactionHash ?? (pending.attempts[0]?.hash as string),
      block: receipt === undefined ? 0 : Number(receipt.blockNumber),
    });
  }
  const next = startGeneration(run, wallet.address);
  atomicWriteJson(run.manifestPath, run.manifest);
  clearPending(run.pendingPath);
  return next;
}

/** Refuses if a block recorded as evidence is no longer on this chain. */
export async function refuseChangedBlocks(run: Run, generation: Generation): Promise<void> {
  for (const { id: stepId, block, blockHash } of generation.steps) {
    if (blockHash === undefined) continue;
    const found = (await run.rpc.request({
      method: 'eth_getBlockByNumber',
      params: [toHex(block), false],
    })) as { hash?: string } | null;
    if (found?.hash !== blockHash) {
      throw new Refusal(
        `block ${block}, recorded for step ${stepId}, has changed on this chain, so a reorg undid ` +
          'evidence in the manifest. Nothing was sealed. Check the deployment, and retire it with ' +
          'SEED_RETIRE_UNSEALED=1 if it no longer holds.'
      );
    }
  }
}

async function send(
  run: Run,
  wallet: Wallet,
  generation: Generation,
  step: SeedStep
): Promise<void> {
  const nonce = await settledNonce(run, wallet.address, generation);

  const { to, data } = await encodeStep(run, step, generation);
  const estimate = BigInt(
    (await run.rpc.request({
      method: 'eth_estimateGas',
      params: [{ from: wallet.address, ...(to === undefined ? {} : { to }), data }],
    })) as string
  );
  const signed = await wallet.signTransaction({
    type: 2,
    chainId: run.chainId,
    nonce,
    ...(to === undefined ? {} : { to }),
    data,
    gasLimit: gasLimitFor(estimate, to === undefined),
    ...(await nextFees(run)),
  });
  killPoint(run, 'after-signing', step.id);

  const record: PendingRecord = {
    chainId: run.chainId,
    deployer: wallet.address,
    stepId: step.id,
    nonce,
    attempts: [{ hash: Transaction.from(signed).hash as string, raw: signed }],
  };
  if (to === undefined) {
    record.predictedAddress = getCreateAddress({ from: wallet.address, nonce });
  }
  atomicWriteJson(run.pendingPath, record, () => killPoint(run, 'mid-write-pending', step.id));

  await broadcast(run, signed, false);
  killPoint(run, 'after-broadcast', step.id);

  const receipt = await waitForReceipt(run, record);
  killPoint(run, 'after-receipt', step.id);

  await confirm(run, generation, step, record, receipt);
}

/** Whether the newest recorded change can still be read at its block. */
export type HistoryProbe = (block: number) => Promise<'readable' | 'pruned'>;

/**
 * The plan's fallback for AC 3: a history read already pruned before sealing gets one more change
 * in its place, which is possible until `seal()`. Returns once the newest evidence is readable.
 */
export async function ensureHistoryEvidence(
  newestBlock: () => number | undefined,
  probe: HistoryProbe,
  sendChange: (ordinal: number) => Promise<void>
): Promise<number> {
  let extras = 0;
  for (;;) {
    const block = newestBlock();
    if (block !== undefined && (await probe(block)) === 'readable') return extras;
    if (extras >= MAX_EXTRA_CHANGES) {
      throw new Refusal(
        `history reads stayed pruned after ${extras} extra change(s). ` +
          'Use an endpoint that keeps recent state.'
      );
    }
    extras += 1;
    await sendChange(extras);
  }
}

function newestRevisionBlock(contract: ContractRecord | undefined): number | undefined {
  const blocks = Object.values(contract?.expected ?? {}).flatMap((entry) =>
    typeof entry.blockTag === 'number' ? [entry.blockTag] : []
  );
  return blocks.length === 0 ? undefined : Math.max(...blocks);
}

/** Runs `ensureHistoryEvidence` against the chain. */
export async function checkHistoryEvidence(
  run: Run,
  wallet: Wallet,
  generation: Generation
): Promise<void> {
  const contract = (): ContractRecord | undefined => generation.contracts.MockValueTypes;
  await ensureHistoryEvidence(
    () => newestRevisionBlock(contract()),
    async (block) => {
      const record = contract() as ContractRecord;
      let word: bigint;
      try {
        word = await readRevisionAt(run, record.address, block);
      } catch (error) {
        if (isPrunedError(error)) return 'pruned';
        throw error;
      }
      const expected = record.expected[`revision@${block}`]?.value;
      if (word.toString() !== expected) {
        throw new Refusal(`revision at block ${block} reads ${word}, not the recorded ${expected}`);
      }
      return 'readable';
    },
    async () => {
      const previous = generation.steps.filter((step) => step.id.includes(':extra-')).length;
      await runSteps(run, wallet, generation, [extraRevisionStep(previous + 1)]);
    }
  );
}

/** Applies every check up to the signer, and returns the signer. */
export async function openSigned(
  hre: HardhatRuntimeEnvironment,
  /** Runs before the key loads, may refuse, and says whether this run makes a new generation. */
  startsNewGeneration: (run: Run) => boolean = () => false
): Promise<{ run: Run; wallet: Wallet }> {
  const run = await open(hre);
  // The binding is between a generation and its sources. A new one records its own.
  if (!startsNewGeneration(run)) checkBinding(run);
  await refuseStaleLocal(run, currentGeneration(run));
  const wallet = await loadSigner(run);
  const generation = currentGeneration(run);
  if (generation !== undefined && generation.deployer !== wallet.address) {
    const sealed = Object.values(generation.contracts).every((item) => item.sealBlock !== null);
    if (!sealed || process.env.SEED_NEW_GENERATION !== '1') {
      throw new Refusal(
        `this deployment belongs to deployer ${generation.deployer}, not ${wallet.address}. ` +
          (run.isLocal ? 'Pass its runtime key, or delete the local manifest.' : 'Use its key.')
      );
    }
  }
  return { run, wallet };
}
