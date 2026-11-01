/**
 * The read-back's logic, shared by the Hardhat 2 and Hardhat 3 scripts: it compares every manifest
 * entry with what the chain holds, and says what a failure means. Adapter differences stay behind
 * {@link AdapterLink}.
 *
 * ## Verdicts come from each entry's own read
 *
 * A stop inside `readMany` can make a wrong address reject as pruned or as an RPC failure,
 * depending on timing, so every verdict here comes from that entry's own `.read()`. `--burst` is a
 * separate measurement and never assigns one.
 *
 * ## What an empty account means
 *
 * `0x` is the honest answer for a wrong address, and it may also come from a lagging node. So a
 * `no-code` mismatch waits and reads once more, then asks a second endpoint. Only a confirmed
 * answer is `wrong`.
 */

import { readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ContractRecord, EntryPath, ExpectedEntry, Generation, Manifest, ManifestValue } from './manifest';

export type Verdict = 'pass' | 'wrong' | 'could-not-check' | 'needs-archive';

export interface EntryResult {
  contract: string;
  entry: string;
  /** `latest` entries are read at the run's pinned number, shown in the report's `head`. */
  blockTag: 'latest' | number;
  verdict: Verdict;
  detail?: string;
}

export interface BurstResult {
  size: number;
  ok: boolean;
  elapsedMs: number;
  detail?: string;
}

export interface AdapterReport {
  adapter: string;
  chainId: number;
  head: string | null;
  floor: number;
  failedRequests: number;
  results: EntryResult[];
  burst?: BurstResult;
}

/** One storage variable of a compiled contract. */
export interface StorageVariable {
  label: string;
  declaredIn?: string;
}

export interface AdapterLink {
  name: string;
  decoder: { contract(fqn: string): any; readMany(queries: any[]): Promise<unknown> };
  classifyReadFailure(error: unknown): 'pruned' | 'wrong-data' | 'rpc';
  /** Goes through the run's {@link RunBudget}. */
  rpc(method: string, params?: unknown[]): Promise<unknown>;
  budget: RunBudget;
  storageVariables(contract: string): Promise<StorageVariable[]>;
}

/**
 * `manifest.ts`'s helpers, passed in. This folder is CommonJS by the root `package.json`, Hardhat 2
 * and Hardhat 3 load TypeScript differently, and no one relative import from here works in both.
 */
export interface ManifestHelpers {
  parseEntryName(text: string): EntryPath & { block?: number };
  toManifestValue(value: unknown): ManifestValue;
  applyPath(query: unknown, path: EntryPath): any;
}

/** What {@link runReadBackFromEnv} also needs from `manifest.ts`, for the same reason. */
export interface ManifestFiles {
  readManifest(path: string): Manifest;
  atomicWriteJson(path: string, value: unknown): void;
}

/** What a complete manifest holds, from the seed plan. See `seed-plan.ts`. */
export interface ReadBackPlan {
  /** The entries of each contract at `latest`, by contract. */
  entries: Readonly<Record<string, readonly string[]>>;
  /** The steps every generation must have confirmed. Seals are not among them. */
  steps: readonly string[];
  /** Each confirmed step of this kind must have left an entry at its block. */
  history: { contract: string; entry: string; stepPrefix: string };
}

export interface ReadBackConfig {
  helpers: ManifestHelpers;
  chainId: number;
  generation: Generation;
  /** The mocks that must be in the manifest, so that deleting a whole contract fails too. */
  expectedContracts: readonly string[];
  plan: ReadBackPlan;
  secondRpcUrl?: string;
  noCodeWaitMs: number;
  burst?: number;
  redact(text: string): string;
}

/** A request not sent because the run's budget is gone. `classifyReadFailure` calls it `rpc`. */
export class RunBudgetSpent extends Error {
  constructor() {
    super("not sent: this run's retry budget is spent");
    this.name = 'RunBudgetSpent';
  }
}

/**
 * One budget for a whole run on one adapter. Each decoder call has its own, and a run of many small
 * calls would never trip that. Every failed request counts, whatever its class, and once spent
 * nothing more is sent.
 */
export class RunBudget {
  failures = 0;

  constructor(readonly limit: number) {}

  get spent(): boolean {
    return this.failures >= this.limit;
  }

  async send<T>(request: () => Promise<T>): Promise<T> {
    if (this.spent) throw new RunBudgetSpent();
    try {
      return await request();
    } catch (error) {
      this.failures += 1;
      throw error;
    }
  }
}

export const DEFAULT_RUN_BUDGET = 32;
/** Requests to a second endpoint have their own short limit: it only confirms one fact. */
const SECOND_ENDPOINT_TIMEOUT_MS = 15_000;
const DISPLAY_LIMIT = 42;
const HEAD_ATTEMPTS = 3;
const HEAD_RETRY_WAIT_MS = 500;

/**
 * For the run's own two calls, which do not go through the decoder's retries: one failed request
 * here would otherwise mark every entry could-not-check.
 */
export async function withRetries<T>(
  request: () => Promise<T>,
  budget: RunBudget,
  waitMs = HEAD_RETRY_WAIT_MS
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (attempt >= HEAD_ATTEMPTS || budget.spent) throw error;
      await sleep(waitMs);
    }
  }
}

/** Keeps a report readable, and keeps whole 32-byte words out of it. */
function display(value: unknown): string {
  const text = typeof value === 'bigint' ? value.toString() : String(value);
  return text.length <= DISPLAY_LIMIT ? text : `${text.slice(0, 12)}...${text.slice(-8)}`;
}

function describeFailure(error: unknown, redact: (text: string) => string): string {
  const { name, code, message } = (error ?? {}) as { name?: unknown; code?: unknown; message?: unknown };
  const label = typeof name === 'string' ? name : 'Error';
  const number = code === undefined ? '' : ` ${String(code)}`;
  return redact(`${label}${number}: ${String(message ?? error)}`);
}

export function fullyQualifiedName(contract: string): string {
  return `contracts/${contract}.sol:${contract}`;
}

/** The block every `latest` entry must be at or above: the seal, or the last confirmed seed step. */
export function floorOf(generation: Generation): number {
  const blocks = [
    ...generation.steps.map((step) => step.block),
    ...Object.values(generation.contracts).flatMap((contract) => contract.sealBlock ?? []),
  ];
  return blocks.length === 0 ? 0 : Math.max(...blocks);
}

/** A build's `storageLayout.storage`, as the read-back compares it. */
export function toStorageVariables(storage: ReadonlyArray<{ label: string; contract?: string }>): StorageVariable[] {
  return storage.map(({ label, contract }) => ({
    label,
    ...(contract === undefined ? {} : { declaredIn: contract.split(':').at(-1) as string }),
  }));
}

/** Variables no manifest entry covers, by label and, for a shadowed name, declaring contract. */
export function uncoveredVariables(
  variables: readonly StorageVariable[],
  entries: readonly string[],
  { parseEntryName }: Pick<ManifestHelpers, 'parseEntryName'>
): StorageVariable[] {
  const parsed = entries.map((entry) => parseEntryName(entry));
  return variables.filter(
    ({ label, declaredIn }) =>
      !parsed.some(
        (entry) =>
          entry.name === label &&
          (entry.declaredIn === undefined || declaredIn === undefined || entry.declaredIn === declaredIn)
      )
  );
}

/**
 * How the manifest differs from what the seed plan and its confirmed steps say it must hold. Looking
 * only at whether a variable has some entry would let `numbers[1]` or `revision@<block>` go missing
 * while `numbers[0]` stays.
 */
export function manifestDifferences(
  plan: ReadBackPlan,
  generation: Generation
): Array<{ contract: string; entry: string; detail: string }> {
  const differences: Array<{ contract: string; entry: string; detail: string }> = [];
  const confirmed = new Set(generation.steps.map(({ id }) => id));
  for (const step of plan.steps) {
    if (!confirmed.has(step)) {
      differences.push({ contract: '(steps)', entry: step, detail: 'this planned step is missing from the manifest' });
    }
  }

  const { contract: historic, entry: variable, stepPrefix } = plan.history;
  const wanted = new Map(Object.entries(plan.entries).map(([name, list]) => [name, new Set(list)]));
  for (const { id, block } of generation.steps) {
    if (id.startsWith(stepPrefix)) wanted.get(historic)?.add(`${variable}@${block}`);
  }

  for (const [name, record] of Object.entries(generation.contracts)) {
    const planned = wanted.get(name);
    const held = Object.keys(record.expected);
    for (const entry of planned ?? []) {
      if (!held.includes(entry)) {
        differences.push({ contract: name, entry, detail: 'this planned entry is missing from the manifest' });
      }
    }
    for (const entry of held) {
      if (planned?.has(entry) !== true) {
        differences.push({ contract: name, entry, detail: 'the seed plan has no such entry' });
      }
    }
  }
  return differences;
}

type SecondAnswer = 'has-code' | 'no-code' | 'unavailable';

async function askSecond(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(SECOND_ENDPOINT_TIMEOUT_MS),
  });
  const body = (await response.json()) as { result?: unknown };
  return body.result;
}

/**
 * What a second endpoint says about an address. Any doubt about the endpoint itself (another chain,
 * behind the floor, a failure) is `unavailable`, so it can never turn into `wrong`.
 */
export async function confirmOnSecond(
  url: string | undefined,
  chainId: number,
  address: string,
  floor: number
): Promise<SecondAnswer> {
  if (url === undefined || url === '') return 'unavailable';
  try {
    if (Number(await askSecond(url, 'eth_chainId', [])) !== chainId) return 'unavailable';
    if (Number(await askSecond(url, 'eth_blockNumber', [])) < floor) return 'unavailable';
    const code = await askSecond(url, 'eth_getCode', [address, 'latest']);
    if (typeof code !== 'string') return 'unavailable';
    return code === '0x' ? 'no-code' : 'has-code';
  } catch {
    return 'unavailable';
  }
}

function isNoCode(error: unknown): boolean {
  const { name, reason } = (error ?? {}) as { name?: unknown; reason?: unknown };
  return name === 'ContractMismatchError' && reason === 'no-code';
}

function buildQuery(
  link: AdapterLink,
  { parseEntryName, applyPath }: ManifestHelpers,
  contract: string,
  address: string,
  entry: string,
  block: bigint | number
): { read(): Promise<{ value: unknown }> } {
  const bound = link.decoder.contract(fullyQualifiedName(contract)).target(address);
  return applyPath(bound, parseEntryName(entry)).at(block);
}

class Run {
  private readonly confirmations = new Map<string, Promise<SecondAnswer>>();
  head: bigint | undefined;
  readonly floor: number;

  constructor(
    private readonly link: AdapterLink,
    private readonly config: ReadBackConfig
  ) {
    this.floor = floorOf(config.generation);
  }

  private confirm(address: string): Promise<SecondAnswer> {
    const known = this.confirmations.get(address);
    if (known !== undefined) return known;
    const asked = confirmOnSecond(this.config.secondRpcUrl, this.config.chainId, address, this.floor);
    this.confirmations.set(address, asked);
    return asked;
  }

  private verdictOfFailure(error: unknown): { verdict: Verdict; detail: string } {
    const detail = describeFailure(error, this.config.redact);
    const kind = this.link.classifyReadFailure(error);
    if (kind === 'pruned') return { verdict: 'needs-archive', detail };
    return { verdict: kind === 'wrong-data' ? 'wrong' : 'could-not-check', detail };
  }

  async readEntry(
    contract: string,
    record: ContractRecord,
    entry: string,
    expected: ExpectedEntry
  ): Promise<EntryResult> {
    const base = { contract, entry, blockTag: expected.blockTag };
    if (this.link.budget.spent) {
      return { ...base, verdict: 'could-not-check', detail: new RunBudgetSpent().message };
    }

    const isLatest = expected.blockTag === 'latest';
    if (isLatest && this.head === undefined) {
      return { ...base, verdict: 'could-not-check', detail: 'the head could not be read' };
    }
    if (isLatest && (this.head as bigint) < BigInt(this.floor)) {
      return {
        ...base,
        verdict: 'could-not-check',
        detail: `the node is at block ${this.head}, below the floor ${this.floor}`,
      };
    }
    const block = isLatest ? (this.head as bigint) : (expected.blockTag as number);

    let query: { read(): Promise<{ value: unknown }> };
    try {
      query = buildQuery(this.link, this.config.helpers, contract, record.address, entry, block);
    } catch (error) {
      return { ...base, verdict: 'wrong', detail: describeFailure(error, this.config.redact) };
    }

    const compare = ({ value }: { value: unknown }): EntryResult => {
      const actual = this.config.helpers.toManifestValue(value);
      if (actual === expected.value) return { ...base, verdict: 'pass' };
      return {
        ...base,
        verdict: 'wrong',
        detail: this.config.redact(
          `expected ${display(expected.value)}, the chain holds ${display(actual)}`
        ),
      };
    };

    try {
      return compare(await query.read());
    } catch (first) {
      if (!isNoCode(first)) return { ...base, ...this.verdictOfFailure(first) };
      await sleep(this.config.noCodeWaitMs);
      try {
        return compare(await query.read());
      } catch (second) {
        if (!isNoCode(second)) return { ...base, ...this.verdictOfFailure(second) };
      }
      const answer = await this.confirm(record.address);
      if (answer === 'no-code') {
        return {
          ...base,
          verdict: 'wrong',
          detail: `no code at ${record.address}, confirmed on a second endpoint`,
        };
      }
      return {
        ...base,
        verdict: 'could-not-check',
        detail:
          answer === 'has-code'
            ? `this node reports no code at ${record.address}, but a second endpoint has code there`
            : `this node reports no code at ${record.address}, and no second endpoint could confirm it`,
      };
    }
  }

  /** One `readMany` over distinct slots, reported and never turned into verdicts. */
  async burst(size: number, record: ContractRecord | undefined): Promise<BurstResult> {
    const started = Date.now();
    const done = (ok: boolean, detail?: string): BurstResult => ({
      size,
      ok,
      elapsedMs: Date.now() - started,
      ...(detail === undefined ? {} : { detail }),
    });
    if (record === undefined || this.head === undefined || this.link.budget.spent) {
      return done(false, 'not run: no head, or no budget left, or no MockMappings entry');
    }
    const byUint = this.link.decoder
      .contract(fullyQualifiedName('MockMappings'))
      .target(record.address)
      .name('byUint')
      .at(this.head);
    const keys = Array.from({ length: size }, (_unused, key) => BigInt(key));
    try {
      await this.link.decoder.readMany(keys.map((key) => byUint.key(key)));
      return done(true);
    } catch (error) {
      return done(false, describeFailure(error, this.config.redact));
    }
  }
}

/** Runs the read-back on one adapter. Never rejects because of the chain or the provider. */
export async function runReadBack(link: AdapterLink, config: ReadBackConfig): Promise<AdapterReport> {
  const run = new Run(link, config);
  const { generation, chainId, redact } = config;
  const results: EntryResult[] = [];
  const contracts = Object.entries(generation.contracts);

  for (const name of config.expectedContracts) {
    if (generation.contracts[name] === undefined) {
      results.push({
        contract: name,
        entry: '(contract)',
        blockTag: 'latest',
        verdict: 'wrong',
        detail: 'this mock is missing from the manifest',
      });
    }
  }

  for (const difference of manifestDifferences(config.plan, generation)) {
    results.push({ ...difference, blockTag: 'latest', verdict: 'wrong' });
  }

  for (const [name, record] of contracts) {
    try {
      const entries = Object.keys(record.expected);
      for (const { label, declaredIn } of uncoveredVariables(await link.storageVariables(name), entries, config.helpers)) {
        results.push({
          contract: name,
          entry: declaredIn === undefined ? label : `${declaredIn}::${label}`,
          blockTag: 'latest',
          verdict: 'wrong',
          detail: 'this storage variable has no expected entry',
        });
      }
    } catch (error) {
      results.push({
        contract: name,
        entry: '(layout)',
        blockTag: 'latest',
        verdict: 'wrong',
        detail: describeFailure(error, redact),
      });
    }
  }

  let unusable: string | undefined;
  try {
    const reported = Number(await withRetries(() => link.rpc('eth_chainId'), link.budget));
    if (reported !== chainId) unusable = `the endpoint is on chain ${reported}, not ${chainId}`;
    else run.head = BigInt((await withRetries(() => link.rpc('eth_blockNumber'), link.budget)) as string);
  } catch (error) {
    unusable = describeFailure(error, redact);
  }

  // `latest` first: those decide the exit code, so history must not spend their budget.
  for (const wanted of [true, false]) {
    for (const [name, record] of contracts) {
      for (const [entry, expected] of Object.entries(record.expected)) {
        if ((expected.blockTag === 'latest') !== wanted) continue;
        if (unusable !== undefined) {
          results.push({
            contract: name,
            entry,
            blockTag: expected.blockTag,
            verdict: 'could-not-check',
            detail: unusable,
          });
        } else {
          results.push(await run.readEntry(name, record, entry, expected));
        }
      }
    }
  }

  const report: AdapterReport = {
    adapter: link.name,
    chainId,
    head: run.head === undefined ? null : run.head.toString(),
    floor: run.floor,
    failedRequests: link.budget.failures,
    results,
  };
  if (config.burst !== undefined) {
    report.burst = await run.burst(config.burst, generation.contracts.MockMappings);
  }
  return report;
}

/**
 * One adapter's whole read-back, from the settings `scripts/readback.mjs` puts in the environment,
 * to the report it reads back.
 */
export async function runReadBackFromEnv(
  env: Record<string, string | undefined>,
  {
    helpers,
    plan,
    contractsDir,
    makeLink,
    redact,
  }: {
    helpers: ManifestHelpers & ManifestFiles;
    plan: ReadBackPlan;
    contractsDir: string;
    makeLink(budget: RunBudget): AdapterLink | Promise<AdapterLink>;
    redact(text: string): string;
  }
): Promise<void> {
  const chainId = Number(env.READBACK_CHAIN);
  const generation = helpers.readManifest(env.READBACK_MANIFEST as string).chains[String(chainId)]?.generations.at(-1);
  if (generation === undefined) throw new Error(`the manifest has no generation for chain ${chainId}`);

  const link = await makeLink(new RunBudget(Number(env.READBACK_RETRY_BUDGET)));
  const report = await runReadBack(link, {
    helpers,
    chainId,
    generation,
    expectedContracts: readdirSync(contractsDir)
      .filter((name) => name.startsWith('Mock'))
      .map((name) => name.replace('.sol', '')),
    plan,
    noCodeWaitMs: Number(env.READBACK_NO_CODE_WAIT_MS),
    redact,
    ...(env.READBACK_SECOND_RPC_URL ? { secondRpcUrl: env.READBACK_SECOND_RPC_URL } : {}),
    ...(env.READBACK_BURST ? { burst: Number(env.READBACK_BURST) } : {}),
  });
  helpers.atomicWriteJson(env.READBACK_OUT as string, report);
}

export interface CrossTarget {
  contract: string;
  address: string;
}

export interface CrossResult {
  contract: string;
  /** The real read, through the strict address check. */
  read: string;
  /** Another contract's code read under this name: must be rejected, proving the check is live. */
  rejectedOther: string;
}

/**
 * AC 26's third case: reads contracts this project did not build, through its own plugin. `owner`
 * sits in every mock, so a read proves the deployed code passed the strict check.
 */
export async function readAcrossBuilds(
  decoder: { contract(fqn: string): any },
  targets: readonly CrossTarget[]
): Promise<CrossResult[]> {
  const results: CrossResult[] = [];
  for (const [position, { contract, address }] of targets.entries()) {
    const other = targets[(position + 1) % targets.length] as CrossTarget;
    const { value } = await decoder
      .contract(fullyQualifiedName(contract))
      .target(address)
      .name('owner')
      .read();
    let rejectedOther = 'NOT REJECTED';
    try {
      await decoder.contract(fullyQualifiedName(contract)).target(other.address).name('owner').read();
    } catch (error) {
      const { name, reason } = error as { name?: string; reason?: string };
      rejectedOther = `${name}/${reason}`;
    }
    results.push({ contract, read: String(value), rejectedOther });
  }
  return results;
}
