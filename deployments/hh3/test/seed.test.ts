/**
 * AC 3-6, 8: the seed and seal scripts, as real processes against a real Anvil.
 *
 * A kill test has the script stop at a named point (`SEED_TEST_KILL`) and report it on stderr, then
 * terminates that process from here with SIGKILL. No handler runs. The re-run must end with the
 * manifest, storage, addresses and transaction count of an uninterrupted run.
 *
 * The deployer key is generated here at run time and handed over in the environment, which is what
 * lets a second process resume as the same account. No test needs a real key or a real network: the
 * Sepolia refusals run against a local Anvil, and the "key" in the environment is a dummy.
 */

import { expect } from 'chai';
import hre from 'hardhat';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { Interface, Transaction, Wallet, id } from 'ethers';
import {
  applyPath,
  atomicWriteJson,
  formatEntryName,
  parseEntryName,
  readManifest,
  removeOrphanTemps,
  sameSources,
  sourceHash,
  toManifestValue,
} from '../../shared/manifest.js';
import type { EntryPath, Generation, Manifest } from '../../shared/manifest.js';
import {
  PRUNED,
  PRUNED_CODE,
  REVISION_SLOT,
  acquireRunLock,
  connectChecked,
  ensureHistoryEvidence,
  fullyQualifiedName,
  gasLimitFor,
  isPrunedError,
  redactText,
  useEndpointForRedaction,
  walletFrom,
} from '../scripts/engine.js';
import {
  Refusal,
  dirtyPaths,
  refuseBinding,
  refuseChain,
  refuseDirtyTree,
  refuseEnvironment,
  refuseLockDrift,
  refuseNetwork,
  refuseStaleCopies,
} from '../scripts/guards.js';
import { startFakeRpc } from '../../shared/fake-rpc-server.mjs';
import type { FakeReply, FakeRequest } from '../../shared/fake-rpc-server.mjs';
import { freePort } from '../../shared/free-port.mjs';
import { lockDrift } from '../../shared/lock-drift.mjs';
import {
  MOCK_NAMES,
  assertSeedEncodings,
  extraRevisionStep,
  extraRevisionStepFromId,
  readBackPlan,
  sealSteps,
  seedSteps,
} from '../../shared/seed-plan.js';

const ROOT = hre.config.paths.root;
const REPO = join(ROOT, '..', '..');
const CLI = join(ROOT, 'node_modules', 'hardhat', 'dist', 'src', 'cli.js');
const KILLED_TX_WAIT_MS = 30_000;
const PUBLIC_MANIFEST = join(ROOT, '..', 'manifest', 'deployments.json');
const LOCAL_CHAIN = 31337;

const PLANNED_SEED = seedSteps().length;
const PLANNED_TOTAL = PLANNED_SEED + sealSteps().length;

/** The child environment: nothing Sepolia-related leaks in from the shell running the tests. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    'SEPOLIA_DEPLOYER_KEY',
    'SEPOLIA_RPC_URL',
    'SEED_LOCAL_KEY',
    'SEED_MANIFEST_DIR',
    'SEED_TEST_KILL',
    'SEED_REPLACE_FEE',
    'SEED_NEW_GENERATION',
    'SEED_RETIRE_UNSEALED',
    'SEED_CONFIRMATIONS',
    'SEED_ALLOW_NONCE_START',
  ]) {
    delete env[name];
  }
  return { ...env, ...extra };
}

const START_ATTEMPTS = 100;

class Node {
  private constructor(
    readonly port: number,
    private readonly child: ChildProcess
  ) {}

  static async start(chainId = LOCAL_CHAIN, ...flags: string[]): Promise<Node> {
    return Node.startOn(await freePort(), START_ATTEMPTS, chainId, ...flags);
  }

  /**
   * A child still running would keep this process, and so the whole test run, alive: when startup
   * fails it is stopped before the failure is raised, which carries its `pid`.
   */
  static async startOn(port: number, attempts: number, chainId: number, ...flags: string[]): Promise<Node> {
    // Nothing persisted: on Windows a killed Anvil cannot remove its state from ~/.foundry/anvil/tmp.
    // `--prune-history` already persists nothing, and Anvil refuses the two together.
    const history = flags.includes('--prune-history') ? [] : ['--max-persisted-states', '0'];
    const child = spawn(
      'anvil',
      ['--port', String(port), '--chain-id', String(chainId), '--silent', ...history, ...flags],
      { stdio: 'ignore' }
    );
    const closed = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      child.once('error', () => resolve());
    });
    const node = new Node(port, child);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await node.rpc('eth_chainId');
        return node;
      } catch (error) {
        if (attempt >= attempts) {
          child.kill('SIGKILL');
          await closed;
          throw Object.assign(error as Error, { pid: child.pid });
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  async rpc<T = any>(method: string, ...params: unknown[]): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${this.port}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await response.json()) as {
      result?: T;
      error?: { message: string; data?: string };
    };
    if (body.error !== undefined) {
      throw Object.assign(new Error(body.error.message), { data: body.error.data });
    }
    return body.result as T;
  }

  stop(): void {
    this.child.kill('SIGKILL');
  }
}

interface Outcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  script?: 'seed' | 'seal';
  network?: string;
  env: Record<string, string>;
  input?: string;
  /** Kill the process, from here, when it reports this point. */
  killAt?: string;
}

async function runScript(options: RunOptions): Promise<Outcome> {
  const script = options.script ?? 'seed';
  const child = spawn(
    process.execPath,
    [CLI, 'run', join('scripts', `${script}.ts`), '--no-compile', '--network', options.network ?? 'anvil'],
    {
      cwd: ROOT,
      env: cleanEnv({
        ...options.env,
        ...(options.killAt === undefined ? {} : { SEED_TEST_KILL: options.killAt }),
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  child.stdin.end(options.input ?? '');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += String(chunk)));
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
    if (options.killAt !== undefined && stderr.includes(`KILLPOINT ${options.killAt}`)) {
      child.kill('SIGKILL');
    }
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function sealInput(): string {
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout;
  return `${LOCAL_CHAIN}\n${commit.trim().slice(0, 8)}\n`;
}

/** One isolated local deployment: its own node, folder and runtime key. */
class Stage {
  readonly dir = mkdtempSync(join(tmpdir(), 'seed-test-'));
  readonly manifestPath = join(this.dir, `deployments-${LOCAL_CHAIN}.json`);
  readonly pendingPath = join(this.dir, `pending-${LOCAL_CHAIN}.json`);

  constructor(
    readonly node: Node,
    readonly key: string
  ) {}

  get env(): Record<string, string> {
    return {
      DEPLOYMENTS_ANVIL_PORT: String(this.node.port),
      SEED_LOCAL_KEY: this.key,
      SEED_MANIFEST_DIR: this.dir,
    };
  }

  run(options: Partial<RunOptions> = {}): Promise<Outcome> {
    return runScript({ ...options, env: { ...this.env, ...options.env } });
  }

  async mustRun(options: Partial<RunOptions> = {}): Promise<Outcome> {
    const outcome = await this.run(options);
    expect(outcome.code, `${outcome.stdout}\n${outcome.stderr}`).to.equal(0);
    return outcome;
  }

  async mustBeKilled(killAt: string, options: Partial<RunOptions> = {}): Promise<void> {
    const outcome = await this.run({ ...options, killAt });
    expect(outcome.stderr, `no kill point in: ${outcome.stderr}`).to.include(`KILLPOINT ${killAt}`);
    expect(outcome.signal ?? outcome.code, 'the process must not have exited by itself').to.not.equal(0);
    expect(outcome.stdout).to.not.include('complete');
  }

  get manifest(): Manifest {
    return readManifest(this.manifestPath);
  }

  get generation(): Generation {
    return this.manifest.chains[String(LOCAL_CHAIN)]?.generations.at(-1) as Generation;
  }

  stop(): void {
    this.node.stop();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Block hashes hold a block's timestamp, so two runs of one plan differ there and nowhere else. */
function withoutBlockHashes(manifest: Manifest): Manifest {
  const copy = structuredClone(manifest);
  for (const { generations } of Object.values(copy.chains)) {
    for (const { steps } of generations) {
      for (const step of steps) delete step.blockHash;
    }
  }
  return copy;
}

/** A local fault server in front of this stage's node, with the scripts pointed at it. */
async function withFaults<T>(
  stage: Stage,
  rule: (request: FakeRequest) => FakeReply | undefined,
  use: (env: Record<string, string>) => Promise<T>
): Promise<T> {
  const fake = await startFakeRpc({ upstream: `http://127.0.0.1:${stage.node.port}`, rule });
  try {
    return await use({ DEPLOYMENTS_ANVIL_PORT: String(fake.port) });
  } finally {
    await fake.close();
  }
}

const newKey = (): string => `0x${randomBytes(32).toString('hex')}`;
const newStage = async (key = newKey(), ...flags: string[]): Promise<Stage> =>
  new Stage(await Node.start(LOCAL_CHAIN, ...flags), key);

/** Every transaction the node mined from `address`, read block by block. */
async function minedFrom(node: Node, address: string) {
  const head = Number(await node.rpc('eth_blockNumber'));
  const mined: Array<{ hash: string; nonce: number }> = [];
  for (let number = 0; number <= head; number += 1) {
    const block = await node.rpc('eth_getBlockByNumber', `0x${number.toString(16)}`, true);
    for (const tx of block.transactions) {
      if (tx.from.toLowerCase() === address.toLowerCase()) {
        mined.push({ hash: tx.hash, nonce: Number(tx.nonce) });
      }
    }
  }
  return mined;
}

/** A mined transaction set in a form that names what differs, for comparing before with after. */
async function minedHashes(node: Node, address: string): Promise<string[]> {
  return (await minedFrom(node, address)).map(({ hash }) => hash).sort();
}

/**
 * A kill after a broadcast leaves the transaction with the node, and it can be mined some time later.
 * Waits for what the pending record names, so a later comparison cannot mistake it for a new send.
 */
async function untilPendingMined(stage: Stage): Promise<string[]> {
  const { attempts } = JSON.parse(readFileSync(stage.pendingPath, 'utf8')) as { attempts: Array<{ hash: string }> };
  const hashes = attempts.map(({ hash }) => hash);
  expect(hashes.length, 'the kill left a broadcast attempt').to.be.greaterThan(0);
  const deadline = Date.now() + KILLED_TX_WAIT_MS;
  for (;;) {
    const receipts = await Promise.all(hashes.map((hash) => stage.node.rpc('eth_getTransactionReceipt', hash)));
    if (receipts.some((receipt) => receipt !== null)) return hashes;
    if (Date.now() > deadline) throw new Error(`the killed run's ${hashes.join(', ')} was not mined in ${KILLED_TX_WAIT_MS} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function storageFingerprint(node: Node, generation: Generation): Promise<string[]> {
  const words: string[] = [];
  for (const [name, contract] of Object.entries(generation.contracts)) {
    words.push(`${name} ${await node.rpc('eth_getCode', contract.address, 'latest')}`);
    for (let slot = 0; slot < 24; slot += 1) {
      words.push(await node.rpc('eth_getStorageAt', contract.address, `0x${slot.toString(16)}`, 'latest'));
    }
  }
  return words;
}

/**
 * The environment of a shell, for a command that starts Hardhat 2. Hardhat 3's runner and the npx
 * that started it leave settings and `PATH` entries for this project, which a child would inherit.
 */
function outsideThisRunner(): NodeJS.ProcessEnv {
  const env = cleanEnv({});
  for (const name of Object.keys(env)) {
    if (/^(?:npm_|INIT_CWD$|NODE_|HH_|HARDHAT_|TS_NODE|TSX)/i.test(name)) delete env[name];
    else if (/^path$/i.test(name)) {
      env[name] = String(env[name])
        .split(delimiter)
        .filter((entry) => !/node_modules|_npx/.test(entry))
        .join(delimiter);
    }
  }
  return env;
}

/** Both scanners over a manifest, as if it were the public one. */
function scanManifest(path: string): void {
  const known = spawnSync(process.execPath, [join(REPO, 'scripts', 'check-manifest-public.mjs'), path], {
    encoding: 'utf8',
  });
  expect(known.status, known.stderr).to.equal(0);

  // The secret scan takes no path, so it runs from a throwaway repo holding this manifest at the
  // public path, with its rules unchanged.
  const repo = mkdtempSync(join(tmpdir(), 'seed-scan-'));
  try {
    mkdirSync(join(repo, 'scripts'));
    for (const file of ['check-secrets.mjs', 'hex-word.mjs', 'bip39-english.txt']) {
      copyFileSync(join(REPO, 'scripts', file), join(repo, 'scripts', file));
    }
    mkdirSync(join(repo, 'deployments', 'manifest'), { recursive: true });
    copyFileSync(path, join(repo, 'deployments', 'manifest', 'deployments.json'));
    spawnSync('git', ['init', '-q'], { cwd: repo });
    const scan = spawnSync(process.execPath, [join('scripts', 'check-secrets.mjs')], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(scan.status, scan.stderr).to.equal(0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

/** A variable's slot, from solc's layout. */
async function slotOf(contract: string, label: string): Promise<number> {
  const id = await hre.artifacts.getBuildInfoId(fullyQualifiedName(contract) as never);
  const path = await hre.artifacts.getBuildInfoOutputPath(id as string);
  const { output } = JSON.parse(readFileSync(path as string, 'utf8'));
  const found = Object.values(output.contracts as Record<string, any>).find((byName) => byName[contract]);
  const variable = found[contract].storageLayout.storage.find((item: { label: string }) => item.label === label);
  return Number(variable.slot);
}

async function expectMinedCount(stage: Stage, planned: number): Promise<void> {
  const mined = await minedFrom(stage.node, stage.generation.deployer);
  expect(mined.length, 'transactions on chain').to.equal(planned);
}

/** The planned count, no nonce twice, and every manifest hash on chain exactly once. */
async function expectPlannedTransactions(stage: Stage, planned: number): Promise<void> {
  const { generation } = stage;
  const mined = await minedFrom(stage.node, generation.deployer);
  expect(mined.length, 'transactions on chain').to.equal(planned);
  expect(new Set(mined.map(({ nonce }) => nonce)).size).to.equal(planned);
  expect(generation.steps.map(({ txHash }) => txHash)).to.have.members(mined.map(({ hash }) => hash));
  for (const { hash } of mined) {
    const receipt = await stage.node.rpc('eth_getTransactionReceipt', hash);
    expect(receipt.status, `status of ${hash}`).to.equal('0x1');
  }
  expect(existsSync(stage.pendingPath), 'pending record cleared').to.equal(false);
}

describe('seed and seal scripts', function () {
  this.timeout(600_000);

  const key = newKey();
  let baseline: Stage;
  let baselineManifest: Manifest;
  let baselineStorage: string[];
  let publicManifestBefore: string;

  before(async () => {
    await hre.tasks.getTask('compile').run({ quiet: true });
    publicManifestBefore = readFileSync(PUBLIC_MANIFEST, 'utf8');
    baseline = await newStage(key);
    await baseline.mustRun();
    baselineManifest = baseline.manifest;
    baselineStorage = await storageFingerprint(baseline.node, baseline.generation);
  });

  after(() => {
    baseline?.stop();
    expect(readFileSync(PUBLIC_MANIFEST, 'utf8'), 'local runs leave the public manifest alone').to.equal(
      publicManifestBefore
    );
  });

  describe('an uninterrupted run', () => {
    it('sends exactly the planned transactions, in nonce order', async () => {
      await expectPlannedTransactions(baseline, PLANNED_SEED);
      const nonces = baseline.generation.steps.map(({ nonce }) => nonce);
      expect(nonces).to.deep.equal(nonces.map((_, position) => position));
    });

    it('records what AC 6 asks for, on chain 31337 only', () => {
      const { manifest, generation } = baseline;
      expect(Object.keys(manifest.chains)).to.deep.equal([String(LOCAL_CHAIN)]);
      expect(generation.repoCommit).to.match(/^[0-9a-f]{40}$/);
      expect(generation.solcSettings.version).to.equal('0.8.26');
      expect(generation.solcSettings.evmVersion).to.equal('cancun');
      expect(Object.keys(generation.contracts).sort()).to.deep.equal([...MOCK_NAMES].sort());
      for (const [name, contract] of Object.entries(generation.contracts)) {
        expect(contract.address, name).to.match(/^0x[0-9a-fA-F]{40}$/);
        expect(contract.deployBlock, name).to.be.greaterThan(0);
        expect(contract.txHash, name).to.match(/^0x[0-9a-f]{64}$/);
      }
    });

    it('stores no key in the manifest', () => {
      expect(readFileSync(baseline.manifestPath, 'utf8')).to.not.include(key.slice(2));
    });

    it('leaves a manifest the public checks accept', () => {
      scanManifest(baseline.manifestPath);
    });

    it('rejects an unknown field in the manifest', () => {
      const planted = join(baseline.dir, 'planted.json');
      writeFileSync(planted, JSON.stringify({ schemaVersion: 1, chains: {}, rawTx: '0x00' }));
      const known = spawnSync(
        process.execPath,
        [join(REPO, 'scripts', 'check-manifest-public.mjs'), planted],
        { encoding: 'utf8' }
      );
      expect(known.status).to.equal(1);
    });

    it('has an expected entry for every variable in every layout', async () => {
      for (const name of MOCK_NAMES) {
        const fqn = fullyQualifiedName(name);
        const id = await hre.artifacts.getBuildInfoId(fqn as never);
        const path = await hre.artifacts.getBuildInfoOutputPath(id as string);
        const { output } = JSON.parse(readFileSync(path as string, 'utf8')) as {
          output: {
            contracts: Record<
              string,
              Record<string, { storageLayout: { storage: Array<{ label: string; contract: string }> } }>
            >;
          };
        };
        const entry = Object.entries(output.contracts).find(
          ([source, byName]) => source.endsWith(`contracts/${name}.sol`) && name in byName
        );
        const layout = entry?.[1][name]?.storageLayout.storage ?? [];
        expect(layout, name).to.not.deep.equal([]);
        const roots = Object.keys(baseline.generation.contracts[name]?.expected ?? {}).map((text) =>
          parseEntryName(text)
        );
        for (const { label, contract } of layout) {
          const declaredIn = contract.split(':').at(-1);
          const covered = roots.some(
            (root) =>
              root.name === label && (root.declaredIn === undefined || root.declaredIn === declaredIn)
          );
          expect(covered, `${name}.${label} (declared in ${declaredIn})`).to.equal(true);
        }
      }
    });

    it('reads every entry back through the decoder', async () => {
      // The configured port was fixed at load, so this connection overrides it for this node.
      const connection = await hre.network.create({
        network: 'anvil',
        override: { url: `http://127.0.0.1:${baseline.node.port}` },
      } as never);
      const { storageDecoder } = connection as unknown as { storageDecoder: any };
      let checked = 0;
      for (const [name, contract] of Object.entries(baseline.generation.contracts)) {
        for (const [entry, expected] of Object.entries(contract.expected)) {
          let query = applyPath(storageDecoder.contract(fullyQualifiedName(name)).target(contract.address), parseEntryName(entry));
          if (typeof expected.blockTag === 'number') query = query.at(expected.blockTag);
          const { value } = await query.read();
          expect(toManifestValue(value), `${name}.${entry}`).to.equal(expected.value);
          checked += 1;
        }
      }
      expect(checked).to.be.greaterThan(MOCK_NAMES.length * 3);
    });
  });

  describe('short and long encodings', () => {
    it('keep short values inline and long values in data slots, in raw storage', async () => {
      const address = baseline.generation.contracts.MockStrings?.address as string;
      const expected = baseline.generation.contracts.MockStrings?.expected ?? {};
      // Literal slots after `owner` and `isSealed`, so this does not use the decoder's derivation.
      const cases: Array<[string, number, boolean]> = [
        ['shortText', 1, true],
        ['longText', 2, false],
        ['shortBlob', 3, true],
        ['longBlob', 4, false],
      ];
      for (const [name, slot, short] of cases) {
        const header = BigInt(await baseline.node.rpc('eth_getStorageAt', address, `0x${slot}`, 'latest'));
        expect((header & 1n) === 0n, `${name} header bit`).to.equal(short);

        const text = String(expected[name]?.value);
        const bytes = text.startsWith('0x') ? (text.length - 2) / 2 : Buffer.byteLength(text);
        if (short) {
          expect(bytes, name).to.be.lessThan(32);
          expect(Number(header & 0xffn), `${name} inline length`).to.equal(bytes * 2);
        } else {
          expect(bytes, name).to.be.at.least(32);
          expect(header, `${name} data length`).to.equal(BigInt(bytes * 2 + 1));
        }
      }
    });

    it('refuses a plan that breaks the names, before any transaction', () => {
      const step = (entry: string, value: string) => ({
        id: 'x',
        contract: 'MockStrings',
        args: [],
        sets: { [entry]: value },
      });
      expect(() => assertSeedEncodings([step('shortText', 's'.repeat(32))])).to.throw('inline');
      expect(() => assertSeedEncodings([step('shortBlob', `0x${'ab'.repeat(32)}`)])).to.throw('inline');
      expect(() => assertSeedEncodings([step('longText', 'l'.repeat(31))])).to.throw('inline');
      expect(() => assertSeedEncodings([step('longBlob', `0x${'cd'.repeat(31)}`)])).to.throw('inline');
      expect(() => assertSeedEncodings(seedSteps())).to.not.throw();
    });
  });

  describe('expected values', () => {
    it('record that `op` depends on the build, and nothing else does', () => {
      const flagged: string[] = [];
      for (const [name, contract] of Object.entries(baseline.generation.contracts)) {
        for (const [entry, value] of Object.entries(contract.expected)) {
          if (value.buildDependent === true) flagged.push(`${name}.${entry}`);
        }
      }
      expect(flagged).to.deep.equal(['MockValueTypes.op']);
      expect(baseline.generation.contracts.MockValueTypes?.expected.op?.value).to.match(/^0x[0-9a-f]{16}$/);
      expect(BigInt(baseline.generation.contracts.MockValueTypes?.expected.op?.value as string)).to.not.equal(0n);
    });

    it('set requiresArchive for history and not for latest', () => {
      for (const contract of Object.values(baseline.generation.contracts)) {
        for (const [entry, value] of Object.entries(contract.expected)) {
          expect(value.requiresArchive, entry).to.equal(value.blockTag !== 'latest');
        }
      }
    });

    it('hold AC 3 evidence: a value that changed across recorded blocks, each observed', async () => {
      const contract = baseline.generation.contracts.MockValueTypes;
      const historic = Object.entries(contract?.expected ?? {}).filter(
        ([, entry]) => typeof entry.blockTag === 'number'
      );
      expect(historic.map(([, entry]) => entry.value)).to.deep.equal(['11', '22', '33']);
      expect(new Set(historic.map(([, entry]) => entry.blockTag)).size).to.equal(3);
      for (const [name, entry] of historic) {
        expect(entry.observed?.value, name).to.equal(entry.value);
        expect(entry.observed?.block, name).to.equal(entry.blockTag);
        expect(entry.observed?.endpointLabel, name).to.equal('hardhat-network:anvil');
        // And it is true: the raw word at that block.
        const word = await baseline.node.rpc(
          'eth_getStorageAt',
          contract?.address,
          `0x${REVISION_SLOT}`,
          `0x${(entry.blockTag as number).toString(16)}`
        );
        expect(BigInt(word).toString(), name).to.equal(entry.value);
      }
    });
  });

  describe('kills', () => {
    const POINTS = [
      'after-signing',
      'mid-write-pending',
      'after-broadcast',
      'after-receipt',
      'mid-write-manifest',
      'after-save',
    ];
    const DEPLOY = 'deploy:MockArrays';
    const SETTER = 'MockPacked:setSecondSlot:1';

    for (const step of [DEPLOY, SETTER]) {
      for (const point of POINTS) {
        it(`resumes after a kill at ${point} of ${step}`, async () => {
          const stage = await newStage(key);
          try {
            await stage.mustBeKilled(`${point}@${step}`);

            if (point.startsWith('mid-write')) {
              // Whatever the kill left, the real files still parse or do not exist yet.
              for (const path of [stage.manifestPath, stage.pendingPath]) {
                if (existsSync(path)) JSON.parse(readFileSync(path, 'utf8'));
              }
            }

            await stage.mustRun();

            expect(withoutBlockHashes(stage.manifest), 'manifest').to.deep.equal(withoutBlockHashes(baselineManifest));
            expect(await storageFingerprint(stage.node, stage.generation), 'storage').to.deep.equal(
              baselineStorage
            );
            await expectPlannedTransactions(stage, PLANNED_SEED);
          } finally {
            stage.stop();
          }
        });
      }
    }

    it('resumes after a kill during a seal, sealing each mock once', async () => {
      const stage = await newStage(key);
      try {
        await stage.mustRun();
        await stage.mustBeKilled('after-broadcast@seal:MockStrings', {
          script: 'seal',
          input: sealInput(),
        });
        await stage.mustRun({ script: 'seal', input: sealInput() });
        await expectPlannedTransactions(stage, PLANNED_TOTAL);
        for (const [name, contract] of Object.entries(stage.generation.contracts)) {
          expect(contract.sealBlock, name).to.be.a('number');
          expect(contract.expected.isSealed?.value, name).to.equal(true);
        }
      } finally {
        stage.stop();
      }
    });

    it('survives a second kill while resuming', async () => {
      const stage = await newStage(key);
      try {
        // In plan order: the setter comes before this deployment.
        await stage.mustBeKilled(`after-broadcast@${SETTER}`);
        await stage.mustBeKilled(`after-signing@${DEPLOY}`);
        await stage.mustRun();
        expect(withoutBlockHashes(stage.manifest)).to.deep.equal(withoutBlockHashes(baselineManifest));
        await expectPlannedTransactions(stage, PLANNED_SEED);
      } finally {
        stage.stop();
      }
    });
  });

  describe('a transaction the kill left unmined', () => {
    const STEP = 'deploy:MockPacked';

    /** Stops mining, and kills the seed with this step's transaction broadcast. */
    async function killWithUnmined(stage: Stage): Promise<{ hash: string; raw: string; nonce: number }> {
      // Up to the step before, with mining on.
      await stage.mustBeKilled(`after-signing@${STEP}`);
      await stage.node.rpc('evm_setAutomine', false);
      await stage.mustBeKilled(`after-broadcast@${STEP}`);
      const record = JSON.parse(readFileSync(stage.pendingPath, 'utf8'));
      const [attempt] = record.attempts;
      expect(await stage.node.rpc('eth_getTransactionReceipt', attempt.hash), 'unmined').to.equal(null);
      return { hash: attempt.hash, raw: attempt.raw, nonce: record.nonce };
    }

    /** Mines on a timer while `work` runs, standing in for a live network's block production. */
    async function whileMining<T>(stage: Stage, work: () => Promise<T>): Promise<T> {
      const timer = setInterval(() => void stage.node.rpc('evm_mine').catch(() => undefined), 100);
      try {
        return await work();
      } finally {
        clearInterval(timer);
      }
    }

    it('waits for it when it is still in the mempool, and sends no second one', async () => {
      const stage = await newStage(key);
      try {
        const { hash } = await killWithUnmined(stage);
        await whileMining(stage, () => stage.mustRun());
        expect(stage.generation.steps.find(({ id }) => id === STEP)?.txHash).to.equal(hash);
        await expectPlannedTransactions(stage, PLANNED_SEED);
      } finally {
        stage.stop();
      }
    });

    it('rebroadcasts the same raw transaction when the node dropped it', async () => {
      const stage = await newStage(key);
      try {
        const { hash } = await killWithUnmined(stage);
        await stage.node.rpc('anvil_dropTransaction', hash);
        expect(await stage.node.rpc('eth_getTransactionByHash', hash), 'dropped').to.equal(null);
        await whileMining(stage, () => stage.mustRun());
        expect(stage.generation.steps.find(({ id }) => id === STEP)?.txHash).to.equal(hash);
        await expectPlannedTransactions(stage, PLANNED_SEED);
      } finally {
        stage.stop();
      }
    });

    it('stops with an error when a different transaction used the nonce', async () => {
      const stage = await newStage(key);
      try {
        const { hash, nonce } = await killWithUnmined(stage);
        await stage.node.rpc('anvil_dropTransaction', hash);
        const wallet = new Wallet(key);
        const other = await wallet.signTransaction({
          type: 2,
          chainId: LOCAL_CHAIN,
          nonce,
          to: wallet.address,
          gasLimit: 21_000n,
          maxFeePerGas: 10n ** 11n,
          maxPriorityFeePerGas: 10n ** 9n,
        });
        await stage.node.rpc('eth_sendRawTransaction', other);
        await stage.node.rpc('evm_mine');
        const before = await minedHashes(stage.node, wallet.address);

        const outcome = await stage.run();
        expect(outcome.code).to.equal(1);
        expect(outcome.stderr).to.include(`nonce ${nonce} was used by a transaction other than`);
        expect(await minedHashes(stage.node, wallet.address), 'nothing sent').to.deep.equal(before);
        expect(existsSync(stage.pendingPath), 'record kept for the owner').to.equal(true);
      } finally {
        stage.stop();
      }
    });

    it('accepts a same-nonce replacement, and records the hash that got mined', async () => {
      const stage = await newStage(key);
      try {
        const { hash, nonce, raw } = await killWithUnmined(stage);
        await whileMining(stage, async () => {
          // One block's wait is not enough for the first to be mined before this replaces it, so
          // drop it, as a node would after a fee spike.
          await stage.node.rpc('anvil_dropTransaction', hash);
          await stage.mustRun({ env: { SEED_REPLACE_FEE: '1' } });
        });
        const record = stage.generation.steps.find(({ id }) => id === STEP);
        expect(record?.nonce).to.equal(nonce);
        expect(record?.signedTxHash).to.equal(hash);
        expect(record?.txHash).to.not.equal(hash);
        const replacement = await stage.node.rpc('eth_getTransactionByHash', record?.txHash);
        const original = Transaction.from(raw);
        expect(replacement.input, 'same call').to.equal(original.data);
        expect(BigInt(replacement.maxFeePerGas) > (original.maxFeePerGas as bigint)).to.equal(true);
        await expectPlannedTransactions(stage, PLANNED_SEED);
      } finally {
        stage.stop();
      }
    });
  });

  describe('resume conditions', () => {
    it('does nothing more on a re-run of a finished seed', async () => {
      const stage = await newStage(key);
      try {
        await stage.mustRun();
        await stage.mustRun();
        expect(withoutBlockHashes(stage.manifest)).to.deep.equal(withoutBlockHashes(baselineManifest));
        await expectPlannedTransactions(stage, PLANNED_SEED);
      } finally {
        stage.stop();
      }
    });

    it('refuses to resume under another key', async () => {
      const stage = await newStage(key);
      try {
        await stage.mustBeKilled('after-receipt@deploy:MockArrays');
        const outcome = await stage.run({ env: { SEED_LOCAL_KEY: newKey() } });
        expect(outcome.code).to.equal(1);
        expect(outcome.stderr).to.include('belongs to deployer');
      } finally {
        stage.stop();
      }
    });

    it('refuses a local manifest that outlived its node', async () => {
      const stage = await newStage(key);
      const fresh = await Node.start();
      try {
        await stage.mustRun();
        const outcome = await stage.run({
          env: { DEPLOYMENTS_ANVIL_PORT: String(fresh.port) },
        });
        expect(outcome.code).to.equal(1);
        expect(outcome.stderr).to.include('this node does not have');
      } finally {
        fresh.stop();
        stage.stop();
      }
    });

    it('prints no key or raw transaction, even when a run is killed', async () => {
      const stage = await newStage(key);
      try {
        const killed = await stage.run({ killAt: 'after-broadcast@deploy:MockPacked' });
        const resumed = await stage.mustRun();
        const printed = killed.stdout + killed.stderr + resumed.stdout + resumed.stderr;
        expect(printed).to.not.include(key.slice(2));
        expect(printed).to.not.match(/0x02f[0-9a-f]{100}/);
      } finally {
        stage.stop();
      }
    });

    it('makes one more change when a recorded block is already pruned', async () => {
      // This node keeps one state, so this is real pruning, with Anvil's own error.
      const stage = await newStage(key, '--prune-history', '1');
      try {
        const outcome = await stage.run();
        expect(outcome.code, outcome.stderr).to.equal(0);
        const extra = stage.generation.steps.filter(({ id }) => id.includes(':extra-'));
        expect(extra.length).to.equal(1);
        await expectPlannedTransactions(stage, PLANNED_SEED + 1);
        const contract = stage.generation.contracts.MockValueTypes;
        const evidence = Object.values(contract?.expected ?? {}).filter(
          ({ blockTag }) => blockTag === extra[0]?.block
        );
        expect(evidence.length).to.equal(1);
        expect(evidence[0]?.value).to.equal('44');
        expect(contract?.expected.revision?.value, 'latest follows the extra change').to.equal('44');
      } finally {
        stage.stop();
      }
    });
  });

  describe('seal', () => {
    it('never runs as part of the seed', () => {
      for (const contract of Object.values(baselineManifest.chains[String(LOCAL_CHAIN)]?.generations[0]?.contracts ?? {})) {
        expect(contract.sealBlock).to.equal(null);
        expect(contract.expected.isSealed?.value).to.equal(false);
      }
    });

    it('refuses a wrong confirmation, or none, and seals nothing', async () => {
      const stage = await newStage(key);
      try {
        await stage.mustRun();
        const [chain, commit] = sealInput().split('\n') as [string, string];
        for (const input of ['', `1\n${commit}\n`, `${chain}\n00000000\n`]) {
          const outcome = await stage.run({ script: 'seal', input });
          expect(outcome.code, input).to.equal(1);
          expect(outcome.stderr).to.include('did not match');
        }
        await expectPlannedTransactions(stage, PLANNED_SEED);
      } finally {
        stage.stop();
      }
    });

    it('refuses an incomplete seed', async () => {
      const stage = await newStage(key);
      try {
        await stage.mustBeKilled('after-save@deploy:MockArrays');
        const outcome = await stage.run({ script: 'seal', input: sealInput() });
        expect(outcome.code).to.equal(1);
        expect(outcome.stderr).to.include('incomplete');
      } finally {
        stage.stop();
      }
    });

    it('really stops the setters, and a second seal is a no-op', async () => {
      const stage = await newStage(key);
      try {
        await stage.mustRun();
        await stage.mustRun({ script: 'seal', input: sealInput() });
        await stage.mustRun({ script: 'seal', input: sealInput() });
        await stage.mustRun();
        await expectPlannedTransactions(stage, PLANNED_TOTAL);
        const contract = stage.generation.contracts.MockStrings;
        const artifact = (await hre.artifacts.readArtifact(fullyQualifiedName('MockStrings') as never)) as { abi: unknown };
        let failure: (Error & { data?: string }) | undefined;
        try {
          await stage.node.rpc('eth_call', {
            from: new Wallet(key).address,
            to: contract?.address,
            data: new Interface(artifact.abi as never).encodeFunctionData('setShortText', ['x']),
          });
        } catch (error) {
          failure = error as Error & { data?: string };
        }
        expect(failure?.data, 'the owner gets AlreadySealed').to.equal(id('AlreadySealed()').slice(0, 10));
      } finally {
        stage.stop();
      }
    });

    it('clears the record a kill leaves after the last seal is saved, on every finished path', async () => {
      const last = sealSteps().at(-1)?.id as string;
      const killAfterLastSeal = async (): Promise<Stage> => {
        const stage = await newStage(key);
        await stage.mustRun();
        await stage.mustBeKilled(`after-save@${last}`, { script: 'seal', input: sealInput() });
        expect(existsSync(stage.pendingPath), 'the kill left the record').to.equal(true);
        return stage;
      };

      const bySeal = await killAfterLastSeal();
      try {
        const outcome = await bySeal.mustRun({ script: 'seal', input: sealInput() });
        expect(outcome.stdout).to.include('already sealed');
        expect(existsSync(bySeal.pendingPath)).to.equal(false);
      } finally {
        bySeal.stop();
      }

      const bySeed = await killAfterLastSeal();
      try {
        const outcome = await bySeed.mustRun();
        expect(outcome.stdout).to.include('Nothing to do');
        expect(existsSync(bySeed.pendingPath)).to.equal(false);
      } finally {
        bySeed.stop();
      }

      const byNext = await killAfterLastSeal();
      try {
        await byNext.mustRun({ env: { SEED_NEW_GENERATION: '1' } });
        expect(byNext.manifest.chains[String(LOCAL_CHAIN)]?.generations.length).to.equal(2);
        expect(existsSync(byNext.pendingPath)).to.equal(false);
      } finally {
        byNext.stop();
      }
    });

    it('refuses any other record left beside a finished generation, and keeps it', async () => {
      const last = sealSteps().at(-1)?.id as string;
      const stage = await newStage(key);
      try {
        await stage.mustRun();
        await stage.mustBeKilled(`after-save@${last}`, { script: 'seal', input: sealInput() });
        const record = JSON.parse(readFileSync(stage.pendingPath, 'utf8'));
        const other = `0x${randomBytes(32).toString('hex')}`;
        record.attempts = [{ hash: other, raw: record.attempts[0].raw }];
        writeFileSync(stage.pendingPath, JSON.stringify(record));

        const cases: Array<Partial<RunOptions>> = [
          { script: 'seal', input: sealInput() },
          {},
          { env: { SEED_NEW_GENERATION: '1' } },
        ];
        for (const options of cases) {
          const outcome = await stage.run(options);
          expect(outcome.code).to.equal(1);
          expect(outcome.stderr).to.include('does not show confirmed');
          expect(existsSync(stage.pendingPath), 'kept').to.equal(true);
        }
        await expectMinedCount(stage, PLANNED_TOTAL);
      } finally {
        stage.stop();
      }
    });

    it('redeploys changed sources after a seal, keeping the old generation', async () => {
      const stage = await newStage(key);
      try {
        await stage.mustRun();
        await stage.mustRun({ script: 'seal', input: sealInput() });
        // The test's mechanism for changed sources, as in the binding tests below: the tracked mocks
        // stay as they are, and the sealed generation records other ones.
        const edited = stage.manifest;
        const old = edited.chains[String(LOCAL_CHAIN)]?.generations[0] as Generation;
        const current = old.sourceHash;
        old.sourceHash = 'sources-since-changed';
        atomicWriteJson(stage.manifestPath, edited);

        // Asked for nothing new, the changed sources are still refused.
        const refused = await stage.run();
        expect(refused.code).to.equal(1);
        expect(refused.stderr).to.include('binding mismatch');

        await stage.mustRun({ env: { SEED_NEW_GENERATION: '1' } });
        const seeded = stage.manifest.chains[String(LOCAL_CHAIN)]?.generations as Generation[];
        expect(seeded.length).to.equal(2);
        expect(seeded[0]?.sourceHash, 'the old one stays as recorded').to.equal('sources-since-changed');
        expect(seeded[1]?.sourceHash, 'the new one records its own').to.equal(current);

        await stage.mustRun({ script: 'seal', input: sealInput() });
        const [first, second] = stage.manifest.chains[String(LOCAL_CHAIN)]?.generations as [Generation, Generation];
        expect(first.contracts.MockPacked?.address).to.not.equal(second.contracts.MockPacked?.address);
        expect(first.contracts.MockPacked?.sealBlock).to.be.a('number');
        expect(second.contracts.MockPacked?.sealBlock).to.be.a('number');
        expect(second.steps.length).to.equal(PLANNED_TOTAL);

        // The shell's `node`, as an owner would run it: `readback.mjs` picks Hardhat 3's by its version.
        const readBack = spawnSync(
          'node',
          [join(REPO, 'scripts', 'readback.mjs'), '--chain', String(LOCAL_CHAIN), '--manifest', stage.manifestPath],
          {
            cwd: REPO,
            encoding: 'utf8',
            maxBuffer: 1 << 26,
            env: {
              ...outsideThisRunner(),
              READBACK_RPC_URL: `http://127.0.0.1:${stage.node.port}`,
              READBACK_SECOND_RPC_URL: '',
            },
          }
        );
        expect(readBack.status, `${readBack.stdout}\n${readBack.stderr}`).to.equal(0);
      } finally {
        stage.stop();
      }
    });

    it('refuses a new generation while the current one is unsealed, sources changed or not', async () => {
      const stage = await newStage(key);
      try {
        await stage.mustBeKilled('after-save@deploy:MockArrays');
        const blocks = await stage.node.rpc('eth_blockNumber');
        const refused = await stage.run({ env: { SEED_NEW_GENERATION: '1' } });
        expect(refused.code).to.equal(1);
        expect(refused.stderr).to.include('is not sealed');
        expect(await stage.node.rpc('eth_blockNumber'), 'nothing sent').to.equal(blocks);

        await stage.mustRun();
        expect(stage.manifest.chains[String(LOCAL_CHAIN)]?.generations.length, 'resumed').to.equal(1);

        // Partly sealed counts as unsealed, and a resume or seal keeps the strict binding.
        const edited = stage.manifest;
        (edited.chains[String(LOCAL_CHAIN)]?.generations[0] as Generation).sourceHash = 'different';
        atomicWriteJson(stage.manifestPath, edited);
        const strict = await stage.run({ env: { SEED_NEW_GENERATION: '1' } });
        expect(strict.code).to.equal(1);
        expect(strict.stderr).to.include('is not sealed');
        const resume = await stage.run();
        expect(resume.stderr).to.include('binding mismatch');
      } finally {
        stage.stop();
      }
    });

    it('starts a new generation only when asked, keeping the old one', async () => {
      const stage = await newStage(key);
      try {
        await stage.mustRun();
        await stage.mustRun({ script: 'seal', input: sealInput() });
        await stage.mustRun({ env: { SEED_NEW_GENERATION: '1' } });
        const { generations } = stage.manifest.chains[String(LOCAL_CHAIN)] as { generations: Generation[] };
        expect(generations.length).to.equal(2);
        const [first, second] = generations as [Generation, Generation];
        expect(first.contracts.MockPacked?.address).to.not.equal(second.contracts.MockPacked?.address);
        expect(first.contracts.MockPacked?.sealBlock).to.be.a('number');
        expect(second.contracts.MockPacked?.sealBlock).to.equal(null);
      } finally {
        stage.stop();
      }
    });
  });

  describe('refusals', () => {
    const DUMMY = 'not-a-real-key';

    /** The Sepolia network, pointed at a local Anvil standing in as the fake chain. */
    const asSepolia = (node: Node, extra: Record<string, string> = {}) => ({
      network: 'sepolia',
      env: { SEPOLIA_RPC_URL: `http://127.0.0.1:${node.port}`, ...extra },
    });

    it('refuses the key env var, for seed and seal, before connecting', async () => {
      for (const script of ['seed', 'seal'] as const) {
        const outcome = await runScript({
          script,
          // A dead port: a run that connected first would fail differently.
          network: 'sepolia',
          env: { SEPOLIA_RPC_URL: 'http://127.0.0.1:1', SEPOLIA_DEPLOYER_KEY: DUMMY },
        });
        expect(outcome.code, script).to.equal(1);
        expect(outcome.stderr, script).to.include('SEPOLIA_DEPLOYER_KEY is set');
        expect(outcome.stderr + outcome.stdout, script).to.not.include(DUMMY);
      }
    });

    it('refuses the key env var even when empty, which Hardhat also treats as set', async () => {
      const outcome = await runScript({
        network: 'sepolia',
        env: { SEPOLIA_RPC_URL: 'http://127.0.0.1:1', SEPOLIA_DEPLOYER_KEY: '' },
      });
      expect(outcome.code).to.equal(1);
      expect(outcome.stderr).to.include('SEPOLIA_DEPLOYER_KEY is set');
    });

    it('refuses the local-only variables on Sepolia, including the kill hook', async () => {
      for (const name of ['SEED_LOCAL_KEY', 'SEED_MANIFEST_DIR', 'SEED_TEST_KILL']) {
        const outcome = await runScript({
          network: 'sepolia',
          env: { SEPOLIA_RPC_URL: 'http://127.0.0.1:1', [name]: 'x' },
        });
        expect(outcome.code, name).to.equal(1);
        expect(outcome.stderr, name).to.include(`${name} is for the local chain only`);
      }
    });

    it('refuses a chain ID mismatch on either network, sending nothing', async () => {
      const wrongForSepolia = await Node.start(1234);
      const wrongForAnvil = await Node.start(11155111);
      try {
        // The Sepolia path as `open` walks it past a clean tree: this repo's own tree may be dirty,
        // and the tree refusal comes first, so that step uses a throwaway clean repo. Only the
        // endpoint is in the environment, so asking for the key here would fail with another error.
        const clean = mkdtempSync(join(tmpdir(), 'seed-clean-'));
        const saved = process.env.SEPOLIA_RPC_URL;
        try {
          spawnSync('git', ['init', '-q'], { cwd: clean });
          expect(() => refuseDirtyTree(clean)).to.not.throw();

          delete process.env.SEPOLIA_DEPLOYER_KEY;
          process.env.SEPOLIA_RPC_URL = `http://127.0.0.1:${wrongForSepolia.port}`;
          let failure: Error | undefined;
          await connectChecked(hre, 'sepolia').catch((error: Error) => (failure = error));
          expect(failure).to.be.instanceOf(Refusal);
          expect(failure?.message).to.equal(
            'chain ID mismatch: network "sepolia" must be chain 11155111, but its endpoint reports chain 1234'
          );
          expect(Number(await wrongForSepolia.rpc('eth_blockNumber'))).to.equal(0);
        } finally {
          if (saved === undefined) delete process.env.SEPOLIA_RPC_URL;
          else process.env.SEPOLIA_RPC_URL = saved;
          useEndpointForRedaction('http://127.0.0.1:1');
          rmSync(clean, { recursive: true, force: true });
        }

        const anvil = await runScript({
          env: { DEPLOYMENTS_ANVIL_PORT: String(wrongForAnvil.port), SEED_LOCAL_KEY: newKey() },
        });
        expect(anvil.code).to.equal(1);
        expect(anvil.stderr).to.include('chain ID mismatch');
        expect(Number(await wrongForAnvil.rpc('eth_blockNumber'))).to.equal(0);
      } finally {
        wrongForSepolia.stop();
        wrongForAnvil.stop();
      }
    });

    it('refuses any network it does not know', async () => {
      const outcome = await runScript({ network: 'default', env: {} });
      expect(outcome.code).to.equal(1);
      expect(outcome.stderr).to.include('not one these scripts run on');
    });

    it('never reads the key env var as a value in the guard', () => {
      const env = { SEPOLIA_DEPLOYER_KEY: DUMMY };
      expect(() => refuseEnvironment('anvil', env)).to.not.throw();
      expect(() => refuseEnvironment('sepolia', env)).to.throw(Refusal).with.property('message').that.does.not.include(DUMMY);
      expect(() => refuseEnvironment('sepolia', {})).to.not.throw();
      expect(() => refuseNetwork('mainnet')).to.throw(Refusal);
      expect(() => refuseChain('sepolia', 11155111)).to.not.throw();
      expect(() => refuseChain('sepolia', 1)).to.throw(Refusal);
    });

    describe('working tree', () => {
      let repo: string;
      const manifest = join('deployments', 'manifest', 'deployments.json');
      const git = (...args: string[]) =>
        spawnSync('git', ['-c', 'user.email=t@example.org', '-c', 'user.name=t', ...args], {
          cwd: repo,
          encoding: 'utf8',
        });

      beforeEach(() => {
        repo = mkdtempSync(join(tmpdir(), 'seed-tree-'));
        git('init', '-q');
        mkdirSync(join(repo, dirname(manifest)), { recursive: true });
        writeFileSync(join(repo, manifest), '{}\n');
        writeFileSync(join(repo, 'a.txt'), 'a\n');
        writeFileSync(join(repo, '.gitignore'), 'deployments/manifest/local/\n');
        git('add', '.');
        git('commit', '-qm', 'base');
      });
      afterEach(() => rmSync(repo, { recursive: true, force: true }));

      it('allows a clean tree', () => {
        expect(() => refuseDirtyTree(repo)).to.not.throw();
      });

      it('allows a tree whose only change is the manifest and the ignored pending file', () => {
        writeFileSync(join(repo, manifest), '{"changed":true}\n');
        mkdirSync(join(repo, 'deployments', 'manifest', 'local'));
        writeFileSync(join(repo, 'deployments', 'manifest', 'local', 'pending-1.json'), '{}\n');
        expect(dirtyPaths(repo)).to.deep.equal([]);
        expect(() => refuseDirtyTree(repo)).to.not.throw();
      });

      it('refuses any other change: modified, untracked, staged, deleted, renamed', () => {
        const cases: Array<[string, () => void, string]> = [
          ['modified', () => writeFileSync(join(repo, 'a.txt'), 'b\n'), 'a.txt'],
          ['untracked', () => writeFileSync(join(repo, 'new.txt'), 'n\n'), 'new.txt'],
          [
            'staged',
            () => {
              writeFileSync(join(repo, 'staged.txt'), 's\n');
              git('add', 'staged.txt');
            },
            'staged.txt',
          ],
          ['deleted', () => rmSync(join(repo, 'a.txt')), 'a.txt'],
          ['renamed', () => git('mv', 'a.txt', 'b.txt'), 'b.txt'],
          ['renamed out of the exempt path', () => git('mv', manifest, 'moved.json'), 'moved.json'],
        ];
        for (const [what, change, shown] of cases) {
          change();
          expect(() => refuseDirtyTree(repo), what).to.throw(Refusal, shown);
          git('reset', '-q', '--hard');
          git('clean', '-qfd');
        }
      });

      it('refuses a change beside the manifest, alongside an allowed one', () => {
        writeFileSync(join(repo, manifest), '{"changed":true}\n');
        writeFileSync(join(repo, dirname(manifest), 'other.json'), '{}\n');
        expect(() => refuseDirtyTree(repo)).to.throw(Refusal, 'other.json');
      });
    });

    describe('bytecode binding', () => {
      const settings = { version: '0.8.26', optimizer: { enabled: false }, evmVersion: 'cancun' };
      let folder: string;

      beforeEach(() => {
        folder = mkdtempSync(join(tmpdir(), 'seed-bind-'));
        writeFileSync(join(folder, 'A.sol'), 'contract A {}\n');
      });
      afterEach(() => rmSync(folder, { recursive: true, force: true }));

      it('passes on a first run and on the same sources', () => {
        const hash = sourceHash(folder, settings);
        expect(() => refuseBinding(undefined, hash)).to.not.throw();
        expect(() => refuseBinding(hash, sourceHash(folder, settings))).to.not.throw();
      });

      it('refuses changed sources and changed settings', () => {
        const hash = sourceHash(folder, settings);
        writeFileSync(join(folder, 'A.sol'), 'contract A { uint x; }\n');
        expect(() => refuseBinding(hash, sourceHash(folder, settings))).to.throw(Refusal, 'binding');
        writeFileSync(join(folder, 'A.sol'), 'contract A {}\n');
        const paris = { ...settings, evmVersion: 'paris' };
        expect(() => refuseBinding(hash, sourceHash(folder, paris))).to.throw(Refusal, 'binding');
      });

      it('survives a new commit: it binds to sources, not to a commit', async () => {
        // A resume with a recorded commit other than HEAD still passes the binding.
        const stage = await newStage(key);
        try {
          await stage.mustBeKilled('after-save@deploy:MockArrays');
          const edited = stage.manifest;
          (edited.chains[String(LOCAL_CHAIN)]?.generations[0] as Generation).repoCommit = '0'.repeat(40);
          atomicWriteJson(stage.manifestPath, edited);
          await stage.mustRun();
          expect(stage.generation.repoCommit).to.equal('0'.repeat(40));
        } finally {
          stage.stop();
        }
      });

      it('refuses a real seed and a real seal when the recorded binding differs', async () => {
        const stage = await newStage(key);
        try {
          await stage.mustRun();
          const edited = stage.manifest;
          (edited.chains[String(LOCAL_CHAIN)]?.generations[0] as Generation).sourceHash = 'different';
          atomicWriteJson(stage.manifestPath, edited);
          for (const script of ['seed', 'seal'] as const) {
            const outcome = await stage.run({ script, input: sealInput() });
            expect(outcome.code, script).to.equal(1);
            expect(outcome.stderr, script).to.include('binding mismatch');
          }
        } finally {
          stage.stop();
        }
      });

      it('refuses a project whose copied contracts differ from the tracked mocks', () => {
        const other = mkdtempSync(join(tmpdir(), 'seed-bind-'));
        try {
          writeFileSync(join(other, 'A.sol'), 'contract A { uint x; }\n');
          expect(sameSources(folder, other)).to.equal(false);
          expect(() => refuseStaleCopies(sameSources(folder, other))).to.throw(Refusal, 'sync-deployment');
          writeFileSync(join(other, 'A.sol'), 'contract A {}\n');
          expect(() => refuseStaleCopies(sameSources(folder, other))).to.not.throw();
        } finally {
          rmSync(other, { recursive: true, force: true });
        }
      });

      it('refuses a tree that differs from the tracked lockfile, and allows the plugin on top', () => {
        const project = mkdtempSync(join(tmpdir(), 'seed-lock-'));
        const write = (path: string, packages: Record<string, unknown>) => {
          mkdirSync(dirname(join(project, path)), { recursive: true });
          writeFileSync(join(project, path), JSON.stringify({ packages }));
        };
        const locked = { version: '1.0.0', integrity: 'sha512-a' };
        const plugin = 'node_modules/hardhat-storage-decoder';
        try {
          expect(lockDrift(project)).to.deep.equal(['nothing is installed']);
          write('package-lock.json', { '': {}, 'node_modules/a': locked });

          write('node_modules/.package-lock.json', {
            'node_modules/a': locked,
            [plugin]: { version: '9.9.9' },
            [`${plugin}/node_modules/b`]: { version: '1.0.0' },
          });
          expect(lockDrift(project)).to.deep.equal([]);
          expect(() => refuseLockDrift(lockDrift(project))).to.not.throw();

          write('node_modules/.package-lock.json', {
            'node_modules/a': { version: '1.0.0', integrity: 'sha512-tampered' },
          });
          expect(() => refuseLockDrift(lockDrift(project))).to.throw(Refusal, 'npm ci');

          write('node_modules/.package-lock.json', { 'node_modules/a': locked, 'node_modules/extra': locked });
          expect(lockDrift(project)).to.have.lengthOf(1);

          write('node_modules/.package-lock.json', {});
          expect(lockDrift(project)).to.have.lengthOf(1);
        } finally {
          rmSync(project, { recursive: true, force: true });
        }
      });
    });
  });

  describe('stuck and lagging runs', () => {
    /** Makes the mempool's setter revert for real: the contract is sealed under it, in storage. */
    async function revertAStep(stage: Stage, step: string, contract: string): Promise<string> {
      await stage.mustBeKilled(`after-signing@${step}`);
      await stage.node.rpc('evm_setAutomine', false);
      await stage.mustBeKilled(`after-broadcast@${step}`);
      const { attempts } = JSON.parse(readFileSync(stage.pendingPath, 'utf8'));
      const address = stage.generation.contracts[contract]?.address as string;
      const slot = BigInt(await stage.node.rpc('eth_getStorageAt', address, '0x0', 'latest'));
      const sealed = `0x${(slot | (1n << 160n)).toString(16).padStart(64, '0')}`;
      await stage.node.rpc('anvil_setStorageAt', address, '0x0', sealed);
      await stage.node.rpc('evm_mine');
      await stage.node.rpc('evm_setAutomine', true);
      const receipt = await stage.node.rpc('eth_getTransactionReceipt', attempts[0].hash);
      expect(receipt.status, 'a real revert').to.equal('0x0');
      return attempts[0].hash;
    }

    it('retires a generation with a reverted step, with no hand-editing', async () => {
      const stage = await newStage(key);
      const step = 'MockPacked:setSecondSlot:1';
      try {
        const reverted = await revertAStep(stage, step, 'MockPacked');

        const stuck = await stage.run();
        expect(stuck.code).to.equal(1);
        expect(stuck.stderr).to.include('SEED_RETIRE_UNSEALED=1');

        await stage.mustRun({ env: { SEED_RETIRE_UNSEALED: '1' } });

        const { generations } = stage.manifest.chains[String(LOCAL_CHAIN)] as { generations: Generation[] };
        expect(generations.length).to.equal(2);
        const [old, next] = generations as [Generation, Generation];
        expect(old.steps.at(-1)).to.include({ id: `abandoned:${step}`, txHash: reverted });
        expect(next.steps.map(({ id }) => id)).to.deep.equal(seedSteps().map(({ id }) => id));
        expect(next.steps[0]?.nonce).to.equal((old.steps.at(-1)?.nonce as number) + 1);
        expect(next.contracts.MockPacked?.address).to.not.equal(old.contracts.MockPacked?.address);
        expect(existsSync(stage.pendingPath)).to.equal(false);
      } finally {
        stage.stop();
      }
    });

    it('will not retire over a transaction that could still land, or a sealed generation', async () => {
      const stage = await newStage(key);
      try {
        await stage.mustBeKilled('after-signing@deploy:MockPacked');
        await stage.node.rpc('evm_setAutomine', false);
        await stage.mustBeKilled('after-broadcast@deploy:MockPacked');
        const refused = await stage.run({ env: { SEED_RETIRE_UNSEALED: '1' } });
        expect(refused.code).to.equal(1);
        expect(refused.stderr).to.include('could still land');
        await stage.node.rpc('evm_mine');
        await stage.node.rpc('evm_setAutomine', true);
        const mined = await stage.run({ env: { SEED_RETIRE_UNSEALED: '1' } });
        expect(mined.code).to.equal(1);
        expect(mined.stderr).to.include('only needs recording');

        await stage.mustRun();
        await stage.mustRun({ script: 'seal', input: sealInput() });
        const sealed = await stage.run({ env: { SEED_RETIRE_UNSEALED: '1' } });
        expect(sealed.code).to.equal(1);
        expect(sealed.stderr).to.include('nothing to retire');
      } finally {
        stage.stop();
      }
    });

    it('waits for code after a deployment before estimating the next step', async () => {
      const stage = await newStage(key);
      try {
        let empties = 0;
        const estimatesAtEmpty: number[] = [];
        await withFaults(
          stage,
          ({ method }) => {
            if (method === 'eth_estimateGas' && empties > 0 && empties < 4) estimatesAtEmpty.push(empties);
            if (method === 'eth_getCode' && empties < 4) {
              empties += 1;
              return { result: '0x' };
            }
            return undefined;
          },
          (env) => stage.mustRun({ env })
        );
        expect(empties, 'the lagging answers were asked for').to.equal(4);
        expect(estimatesAtEmpty, 'no estimate while the node shows no code').to.deep.equal([]);
      } finally {
        stage.stop();
      }
    });

    it('sends calls with a gas floor and a wide margin, so a low estimate cannot revert them', async () => {
      expect(gasLimitFor(21_000n, false)).to.equal(300_000n);
      expect(gasLimitFor(1_000_000n, false)).to.equal(1_500_000n);
      expect(gasLimitFor(1_000_000n, true)).to.equal(1_500_000n);
      const stage = await newStage(key);
      try {
        // Far below what these calls cost, as a node behind the last deployment would answer.
        await withFaults(
          stage,
          ({ method, params }) =>
            method === 'eth_estimateGas' && (params[0] as { to?: string }).to !== undefined
              ? { result: '0x5300' }
              : undefined,
          (env) => stage.mustRun({ env })
        );
        await expectPlannedTransactions(stage, PLANNED_SEED);
      } finally {
        stage.stop();
      }
    });

    it('resumes a kill during an extra change', async () => {
      const stage = await newStage(key, '--prune-history', '1');
      try {
        await stage.mustBeKilled('after-broadcast@MockValueTypes:setRevision:extra-1');
        await stage.mustRun();
        expect(stage.generation.steps.filter(({ id }) => id.includes(':extra-')).map(({ id }) => id)).to.deep.equal([
          'MockValueTypes:setRevision:extra-1',
        ]);
        await expectPlannedTransactions(stage, PLANNED_SEED + 1);
      } finally {
        stage.stop();
      }
    });

    it('reads `op` at the block that set it, and refuses a zero', async () => {
      const stage = await newStage(key);
      try {
        const tags: unknown[] = [];
        const opSlot = await slotOf('MockValueTypes', 'op');
        await withFaults(
          stage,
          ({ method, params }) => {
            if (method === 'eth_getStorageAt' && Number(params[1]) === opSlot) tags.push(params[2]);
            return undefined;
          },
          (env) => stage.mustRun({ env })
        );
        const step = stage.generation.steps.find(({ id }) => id.startsWith('MockValueTypes:setOp'));
        expect(tags.length).to.be.greaterThan(0);
        for (const tag of tags) expect(Number(tag), 'pinned').to.equal(step?.block);
      } finally {
        stage.stop();
      }

      const zero = await newStage(key);
      try {
        const opSlot = await slotOf('MockValueTypes', 'op');
        const outcome = await withFaults(
          zero,
          ({ method, params }) =>
            method === 'eth_getStorageAt' && Number(params[1]) === opSlot
              ? { result: `0x${'00'.repeat(32)}` }
              : undefined,
          (env) => zero.run({ env })
        );
        expect(outcome.code).to.equal(1);
        expect(outcome.stderr).to.include('reads zero');
      } finally {
        zero.stop();
      }
    });

    it('waits for confirmations on a recorded change, and records its block hash', async () => {
      const stage = await newStage(key);
      const timer = setInterval(() => void stage.node.rpc('evm_mine').catch(() => undefined), 100);
      try {
        await stage.mustRun({ env: { SEED_CONFIRMATIONS: '2' } });
      } finally {
        clearInterval(timer);
      }
      try {
        const { steps } = stage.generation;
        steps.forEach((step, position) => {
          if (!step.id.startsWith('MockValueTypes:setRevision:')) return;
          expect(step.blockHash, step.id).to.match(/^0x[0-9a-f]{64}$/);
          // Whatever was sent next went out only after two more blocks.
          expect((steps[position + 1]?.block as number) - step.block, step.id).to.be.greaterThan(2);
        });
      } finally {
        stage.stop();
      }

      const never = await newStage(key);
      try {
        const outcome = await never.run({ env: { SEED_CONFIRMATIONS: 'x' } });
        expect(outcome.code).to.equal(1);
        expect(outcome.stderr).to.include('whole number');
      } finally {
        never.stop();
      }
    });

    it('takes a brief nonce disagreement for lag, and names what a lasting one may be', async () => {
      const stage = await newStage(key);
      try {
        let brief = 0;
        const bump = (count: unknown): string => `0x${(Number(count) + 1).toString(16)}`;
        await withFaults(
          stage,
          ({ method, params }) => {
            if (method === 'eth_getTransactionCount' && params[1] === 'pending' && brief < 2) {
              brief += 1;
              return { result: bump(1) };
            }
            return undefined;
          },
          (env) => stage.mustRun({ env })
        );
        expect(brief).to.equal(2);
        await expectPlannedTransactions(stage, PLANNED_SEED);
      } finally {
        stage.stop();
      }

      const lasting = await newStage(key);
      try {
        const outcome = await withFaults(
          lasting,
          ({ method, params }) =>
            method === 'eth_getTransactionCount' && params[1] === 'pending' ? { result: '0x63' } : undefined,
          (env) => lasting.run({ env })
        );
        expect(outcome.code).to.equal(1);
        expect(outcome.stderr).to.include('or the node may be behind');
        expect(outcome.stderr).to.not.include('unmined');
      } finally {
        lasting.stop();
      }
    });

    it('refuses to start where a lost pending record could mean a duplicate deployment', async () => {
      const stage = await newStage(key);
      try {
        await stage.mustBeKilled('after-broadcast@deploy:MockValueTypes');
        const killed = await untilPendingMined(stage);
        rmSync(stage.pendingPath);
        const address = new Wallet(key).address;
        const before = await minedHashes(stage.node, address);
        expect(before, 'only the killed run has sent').to.deep.equal(killed);

        const refused = await stage.run();
        expect(refused.code).to.equal(1);
        expect(refused.stderr).to.include('could deploy twice');
        expect(await minedHashes(stage.node, address), 'nothing sent').to.deep.equal(before);

        await stage.mustRun({ env: { SEED_ALLOW_NONCE_START: '1' } });
        expect(stage.generation.steps[0]?.nonce, 'only when told to').to.equal(1);
      } finally {
        stage.stop();
      }
    });

    it('finishes a new generation killed before its first save, rather than saying nothing to do', async () => {
      const stage = await newStage(key);
      try {
        await stage.mustRun();
        await stage.mustRun({ script: 'seal', input: sealInput() });
        await stage.mustBeKilled('after-broadcast@deploy:MockValueTypes', {
          env: { SEED_NEW_GENERATION: '1' },
        });
        const resumed = await stage.mustRun();
        expect(resumed.stdout).to.not.include('Nothing to do');
        const { generations } = stage.manifest.chains[String(LOCAL_CHAIN)] as { generations: Generation[] };
        expect(generations.length).to.equal(2);
        expect(generations[1]?.steps.length).to.equal(PLANNED_SEED);
        expect(existsSync(stage.pendingPath)).to.equal(false);
        const mined = await minedFrom(stage.node, generations[0]?.deployer as string);
        expect(mined.length).to.equal(PLANNED_TOTAL + PLANNED_SEED);
        expect(new Set(mined.map(({ nonce }) => nonce)).size).to.equal(mined.length);
      } finally {
        stage.stop();
      }
    });

    it('allows one run at a time, and does not mistake a dead run for a live one', async () => {
      const stage = await newStage(key);
      const lock = join(stage.dir, `run-${LOCAL_CHAIN}.lock`);
      try {
        // This test process is alive, so it stands in for a run in progress.
        writeFileSync(lock, String(process.pid));
        const refused = await stage.run();
        expect(refused.code).to.equal(1);
        expect(refused.stderr).to.include('another seed or seal is running');
        expect(Number(await stage.node.rpc('eth_blockNumber'))).to.equal(0);

        const gone = spawnSync(process.execPath, ['-e', '0']);
        writeFileSync(lock, String(gone.pid));
        await stage.mustRun();
        expect(existsSync(lock), 'released on exit').to.equal(false);
      } finally {
        stage.stop();
      }
      expect(() => acquireRunLock(join(tmpdir(), `seed-lock-${process.pid}`, 'held.lock'))).to.not.throw();
      rmSync(join(tmpdir(), `seed-lock-${process.pid}`), { recursive: true, force: true });
    });

    it('refuses history evidence that answers with another value', async () => {
      const stage = await newStage(key);
      try {
        // Deployment is block 1, so the third change is block 4. The first read is its evidence,
        // and the second is the probe at the end of the seed.
        let reads = 0;
        const outcome = await withFaults(
          stage,
          ({ method, params }) => {
            if (method !== 'eth_getStorageAt' || Number(params[1]) !== REVISION_SLOT || params[2] !== '0x4') {
              return undefined;
            }
            reads += 1;
            return reads === 2 ? { result: `0x${'00'.repeat(31)}01` } : undefined;
          },
          (env) => stage.run({ env })
        );
        expect(outcome.code).to.equal(1);
        expect(outcome.stderr).to.include('not the recorded 33');
      } finally {
        stage.stop();
      }
    });

    it('never prints a malformed runtime key', async () => {
      const typo = randomBytes(32).toString('hex').slice(0, 63);
      const stage = await newStage(key);
      try {
        const outcome = await stage.run({ env: { SEED_LOCAL_KEY: typo } });
        expect(outcome.code).to.equal(1);
        expect(outcome.stderr).to.include('not a valid private key');
        expect(outcome.stdout + outcome.stderr).to.not.include(typo);
      } finally {
        stage.stop();
      }
    });
  });

  describe('what a seal checks on chain first', () => {
    const expectRefusedBeforePrompt = (outcome: Outcome, wording: string | RegExp) => {
      expect(outcome.code).to.equal(1);
      expect(outcome.stderr).to.match(typeof wording === 'string' ? new RegExp(wording) : wording);
      expect(outcome.stdout, 'refused before the question').to.not.include('irreversible');
    };

    it('refuses a changed owner: a value the manifest and the chain disagree on', async () => {
      const stage = await newStage(key);
      try {
        await stage.mustRun();
        const address = stage.generation.contracts.MockPacked?.address as string;
        const other = `0x${'00'.repeat(12)}${'ab'.repeat(20)}`;
        await stage.node.rpc('anvil_setStorageAt', address, '0x0', other);
        expectRefusedBeforePrompt(await stage.run({ script: 'seal', input: sealInput() }), 'read-back');
        await expectPlannedTransactions(stage, PLANNED_SEED);
      } finally {
        stage.stop();
      }
    });

    it('refuses a missing contract', async () => {
      const stage = await newStage(key);
      try {
        await stage.mustRun();
        const address = stage.generation.contracts.MockEnums?.address as string;
        await stage.node.rpc('anvil_setCode', address, '0x');
        expectRefusedBeforePrompt(await stage.run({ script: 'seal', input: sealInput() }), 'read-back');
      } finally {
        stage.stop();
      }
    });

    it('refuses a planned entry deleted from the manifest', async () => {
      const stage = await newStage(key);
      try {
        await stage.mustRun();
        const edited = stage.manifest;
        const generation = edited.chains[String(LOCAL_CHAIN)]?.generations[0] as Generation;
        delete generation.contracts.MockArrays?.expected['numbers[1]'];
        atomicWriteJson(stage.manifestPath, edited);
        expectRefusedBeforePrompt(await stage.run({ script: 'seal', input: sealInput() }), 'numbers\\[1\\]');
      } finally {
        stage.stop();
      }
    });

    it('refuses when it could not check, and loads no key', async () => {
      const stage = await newStage(key);
      try {
        await stage.mustRun();
        const balances: unknown[] = [];
        const outcome = await withFaults(
          stage,
          ({ method }) => {
            if (method === 'anvil_setBalance') balances.push(method);
            return method === 'eth_getStorageAt' ? { status: 503, body: 'down' } : undefined;
          },
          (env) => stage.run({ script: 'seal', input: sealInput(), env })
        );
        expectRefusedBeforePrompt(outcome, 'could-not-check');
        // Locally, loading the signer is what funds it.
        expect(balances, 'the signer was not loaded').to.deep.equal([]);
      } finally {
        stage.stop();
      }
    });

    it('refuses a reorg that changed a recorded block', async () => {
      const stage = await newStage(key);
      try {
        await stage.mustRun();
        const head = Number(await stage.node.rpc('eth_blockNumber'));
        const { block } = stage.generation.steps.find(({ id }) => id.startsWith('MockValueTypes:setRevision:')) as {
          block: number;
        };
        await stage.node.rpc('anvil_reorg', head - block + 1, []);
        expectRefusedBeforePrompt(await stage.run({ script: 'seal', input: sealInput() }), 'has changed on this chain');
      } finally {
        stage.stop();
      }
    });

    it('ends with a sealed manifest that both scanners accept', async () => {
      const stage = await newStage(key);
      try {
        await stage.mustRun();
        await stage.mustRun({ script: 'seal', input: sealInput() });
        const { contracts, steps } = stage.generation;
        for (const [name, contract] of Object.entries(contracts)) {
          expect(contract.sealTxHash, name).to.match(/^0x[0-9a-f]{64}$/);
        }
        expect(steps.filter(({ blockHash }) => blockHash !== undefined).length).to.equal(3);
        const names = Object.keys(contracts.MockMappings?.expected ?? {});
        expect(names.filter((name) => /\{w:0x[0-9a-f]{64}\}/.test(name)).length, 'a whole-form name').to.equal(1);
        scanManifest(stage.manifestPath);
      } finally {
        stage.stop();
      }
    });
  });

  describe('the test node itself', () => {
    it('leaves no process behind when startup fails', async () => {
      // Anvil really runs on this port, and `fetch` refuses to reach it: the failure seen in practice.
      const BLOCKED_PORT = 6666;
      let failure: { pid?: number; cause?: { message?: string } } | undefined;
      try {
        (await Node.startOn(BLOCKED_PORT, 3, LOCAL_CHAIN)).stop();
      } catch (error) {
        failure = error as typeof failure;
      }
      expect(failure?.cause?.message).to.equal('bad port');
      expect(failure?.pid).to.be.a('number');
      expect(() => process.kill(failure?.pid as number, 0)).to.throw(/ESRCH/);
    });
  });

  describe('manifest helpers', () => {
    it('round-trips entry names', () => {
      const paths: EntryPath[] = [
        { name: 'revision', segments: [] },
        { name: 'shared', declaredIn: 'MockShadowedBase', segments: [] },
        { name: 'deep', segments: [{ key: '0xabc' }, { key: 'mid dle' }, { key: -3n }] },
        { name: 'root', segments: [{ field: 'children' }, { key: 1n }, { field: 'value' }] },
        { name: 'rows', segments: [{ index: 1 }, { index: 0 }] },
        { name: 'byId', segments: [{ key: `0x${'22'.repeat(32)}` }] },
      ];
      for (const path of paths) expect(parseEntryName(formatEntryName(path))).to.deep.equal(path);
      expect(parseEntryName('revision@12').block).to.equal(12);
      expect(() => parseEntryName('not a name')).to.throw();
      expect(() => formatEntryName({ name: 'a', segments: [{ key: 'b}' }] })).to.throw();
    });

    it('cannot produce a 64-hex entry name, whatever spells the word', () => {
      const word = randomBytes(32).toString('hex');
      const name = formatEntryName({ name: 'byId', segments: [{ key: `0x${word}` }] });
      expect(name).to.equal(`byId{w:0x${word}}`);
      expect(parseEntryName(name).segments).to.deep.equal([{ key: `0x${word}` }]);
      for (const key of [word, `0X${word}`, `text ${word}`]) {
        expect(() => formatEntryName({ name: 'a', segments: [{ key }] }), key).to.throw('64-hex');
      }
      const planned = [...seedSteps(), ...sealSteps()].flatMap(({ sets }) => Object.keys(sets));
      const outside = planned.map((entry) => entry.replace(/\{w:0x[0-9a-fA-F]{64}\}/g, ''));
      expect(outside.filter((entry) => /[0-9a-fA-F]{64}/.test(entry))).to.deep.equal([]);
    });

    it('plans every entry an uninterrupted run leaves', () => {
      const plan = readBackPlan();
      expect(plan.steps).to.deep.equal(seedSteps().map(({ id }) => id));
      for (const [name, contract] of Object.entries(baseline.generation.contracts)) {
        const held = Object.keys(contract.expected).filter((entry) => !entry.includes('@'));
        expect(held.sort(), name).to.deep.equal([...(plan.entries[name] as string[])].sort());
      }
    });

    it('names every seeded variable with a parsable entry', () => {
      for (const step of [...seedSteps(), ...sealSteps(), extraRevisionStep(1)]) {
        for (const entry of Object.keys(step.sets)) expect(() => parseEntryName(entry), entry).to.not.throw();
      }
    });

    it('never leaves a partial file behind a kill, and clears an orphan', () => {
      const folder = mkdtempSync(join(tmpdir(), 'seed-atomic-'));
      try {
        const path = join(folder, 'file.json');
        atomicWriteJson(path, { first: true });
        const orphan = `${path}.tmp-12345`;
        writeFileSync(orphan, '{ "half');
        expect(JSON.parse(readFileSync(path, 'utf8'))).to.deep.equal({ first: true });
        removeOrphanTemps(path);
        expect(existsSync(orphan)).to.equal(false);
        expect(existsSync(path)).to.equal(true);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    });

    it('redacts URLs, word-sized hex, and the pieces of this run\'s endpoint', () => {
      const token = randomBytes(12).toString('hex');
      const word = randomBytes(32).toString('hex');
      useEndpointForRedaction(`https://${token}.quiknode.pro/${token}/`);
      for (const text of [
        `failed at https://host.example/v2/${token}?a=1 with 0x${word} code`,
        `getaddrinfo ENOTFOUND ${token}.quiknode.pro code`,
        `failed at other.example.net/v2/${token} code`,
      ]) {
        const clean = redactText(text);
        expect(clean, text).to.not.include(token);
        expect(clean, text).to.not.include(word);
        expect(clean, text).to.include('code');
      }
      useEndpointForRedaction('http://127.0.0.1:1');
    });

    it('never quotes a malformed key', () => {
      const typo = randomBytes(32).toString('hex').slice(0, 63);
      expect(typo.length).to.equal(63);
      let failure: Error | undefined;
      try {
        walletFrom(typo, 'SEPOLIA_DEPLOYER_KEY');
      } catch (error) {
        failure = error as Error;
      }
      expect(failure).to.be.instanceOf(Refusal);
      expect(failure?.message).to.equal('SEPOLIA_DEPLOYER_KEY in the keystore is not a valid private key');
      expect(failure?.message).to.not.include(typo);
    });

    it('holds its copy of the pruned wording equal to the source', () => {
      const source = readFileSync(join(REPO, 'src', 'core', 'rpc', 'classifyRpcError.ts'), 'utf8');
      expect(source).to.include(`const PRUNED_WORDING = /${PRUNED.source}/i;`);
      expect(source).to.include(`const PRUNED_CODE = ${PRUNED_CODE};`);
    });

    it('calls a transport failure not pruned, whatever its message quotes', () => {
      const wrapped = Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('state of host.example not available'), { code: 'ECONNRESET' }),
      });
      expect(isPrunedError(wrapped)).to.equal(false);
      expect(isPrunedError(Object.assign(new Error('x'), { code: PRUNED_CODE }))).to.equal(true);
      expect(isPrunedError(new Error('pruned history unavailable'))).to.equal(true);
      expect(isPrunedError(new Error('block height is 9 but requested was 2'))).to.equal(true);
      expect(isPrunedError(new Error('block height is 2 but requested was 9'))).to.equal(false);
    });

    it('rebuilds an extra change from its id, value included', () => {
      expect(extraRevisionStepFromId('MockValueTypes:setRevision:extra-2')).to.deep.equal(extraRevisionStep(2));
      expect(extraRevisionStep(2).args).to.deep.equal([55n]);
      expect(extraRevisionStepFromId('MockValueTypes:setRevision:0')).to.equal(undefined);
    });

    it('writes entry names as the manifest does, across the whole plan', () => {
      for (const step of [...seedSteps(), ...sealSteps()]) {
        for (const entry of Object.keys(step.sets)) {
          expect(formatEntryName(parseEntryName(entry)), entry).to.equal(entry);
        }
      }
    });

    it('forces LF on the mocks, so the source hash survives core.autocrlf', () => {
      const attributes = spawnSync('git', ['check-attr', 'eol', 'deployments/contracts/Sealable.sol'], {
        cwd: REPO,
        encoding: 'utf8',
      });
      expect(attributes.stdout).to.include('eol: lf');
    });

    it('gets one more change for each pruned look, and gives up in the end', async () => {
      let newest = 5;
      const sent: number[] = [];
      const extras = await ensureHistoryEvidence(
        () => newest,
        async (block) => (block < 7 ? 'pruned' : 'readable'),
        async (ordinal) => {
          sent.push(ordinal);
          newest += 1;
        }
      );
      expect(extras).to.equal(2);
      expect(sent).to.deep.equal([1, 2]);

      let failure: unknown;
      await ensureHistoryEvidence(
        () => 1,
        async () => 'pruned',
        async () => undefined
      ).catch((error: unknown) => (failure = error));
      expect(failure).to.be.instanceOf(Refusal);
    });

    it('checks the revision slot against solc', async () => {
      const id = await hre.artifacts.getBuildInfoId(fullyQualifiedName('MockValueTypes') as never);
      const path = await hre.artifacts.getBuildInfoOutputPath(id as string);
      const { output } = JSON.parse(readFileSync(path as string, 'utf8'));
      const entry = Object.entries(output.contracts as Record<string, any>).find(([source]) =>
        source.endsWith('contracts/MockValueTypes.sol')
      );
      const variable = entry?.[1].MockValueTypes.storageLayout.storage.find(
        ({ label }: { label: string }) => label === 'revision'
      );
      expect(Number(variable.slot)).to.equal(REVISION_SLOT);
    });
  });
});
