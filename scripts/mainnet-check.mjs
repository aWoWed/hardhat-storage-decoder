#!/usr/bin/env node
/**
 * Proves decoding on real contracts: fetches verified sources, compiles them, and compares what the
 * decoder reads from storage with what the contracts themselves return from `eth_call`.
 *
 *   node scripts/mainnet-check.mjs                the G5 check, at the pinned block
 *   node scripts/mainnet-check.mjs --candidates   confirms candidates, public keyless reads only
 *   node scripts/mainnet-check.mjs --recent       the same comparison at a recent block through a
 *                                                 public node; never evidence, writes no report
 *   node scripts/mainnet-check.mjs --self-test    failure paths, against a local fake node
 *
 * Other flags: `--no-build` packs the existing `dist/`; `--corrupt-expected` changes one expected
 * value in memory, so a run that still passes proves nothing; `--report PATH` replaces the default
 * report path; `--record` rewrites the on-chain code fixture, with `--candidates`.
 *
 * Exit codes:
 *   0  everything compared equal, and the strict address check accepted every build.
 *   1  a value differs, the strict check rejected a build, or a candidate no longer qualifies.
 *   2  usage.
 *   3  could not check: no endpoint, one that cannot serve the block, or a network problem.
 *
 * The G5 endpoint comes from `MAINNET_ARCHIVE_RPC_URL`, in the environment and not on the command
 * line, since a URL can hold a token. Everything printed or written passes the redactor. Values are
 * compared before redaction, so a stored URL or 64-hex string shows as `<url>` or `<hex>` while its
 * comparison stays exact.
 *
 * Fetched sources are untrusted data. Only one flat `.sol` file per candidate is accepted, written
 * under the ignored `deployments/mainnet/contracts/<id>/`, and solc is the only thing that reads it.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { startFakeRpc } from '../deployments/shared/fake-rpc-server.mjs';
import { freePort } from '../deployments/shared/free-port.mjs';
import { lockDrift } from '../deployments/shared/lock-drift.mjs';
import { VERIFIED, request } from './check-sourcify.mjs';
import { CouldNotCheck, fetchJson } from './fetch-json.mjs';
import { bare, decodeOracle, encodeCall, isZeroValue, normalize, solcAtLeast } from './mainnet-values.mjs';
import { makeRedactor, redactDeep } from './redact.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PROJECT = join(ROOT, 'deployments', 'mainnet');
const FIXTURE = join(PROJECT, 'fixtures', 'onchain-code.json');
/** This project is on Hardhat 2, whose CLI is not at `HARDHAT3_CLI`'s path. */
const HARDHAT_CLI = join(PROJECT, 'node_modules', 'hardhat', 'internal', 'cli', 'cli.js');
const SOURCIFY = 'https://sourcify.dev/server/v2/contract';
const PUBLIC_RPC_URL = 'https://ethereum-rpc.publicnode.com';
const ENDPOINT_VARIABLE = 'MAINNET_ARCHIVE_RPC_URL';
/** Public nodes serve only recent state, so `--recent` stays well inside that window. */
const RECENT_DEPTH = 16;
const CHILD_TIMEOUT_MS = 15 * 60_000;
const MIN_SOLC = [0, 5, 13];
const EXPECTED_REJECTION = /differs/;

const OK = 0;
const FAILED = 1;
const COULD_NOT_CHECK = 3;

function usage(message) {
  console.error(
    `${message}\nusage: node scripts/mainnet-check.mjs [--candidates [--record] | --recent | --self-test] [--no-build] [--corrupt-expected] [--report PATH]`
  );
  process.exit(2);
}

let options;
try {
  ({ values: options } = parseArgs({
    options: {
      candidates: { type: 'boolean', default: false },
      recent: { type: 'boolean', default: false },
      'self-test': { type: 'boolean', default: false },
      record: { type: 'boolean', default: false },
      'no-build': { type: 'boolean', default: false },
      'corrupt-expected': { type: 'boolean', default: false },
      report: { type: 'string' },
    },
  }));
} catch (error) {
  usage(error.message);
}
if ([options.candidates, options.recent, options['self-test']].filter(Boolean).length > 1) {
  usage('--candidates, --recent and --self-test exclude each other');
}
if (options.record && !options.candidates) usage('--record needs --candidates');

const config = JSON.parse(readFileSync(join(PROJECT, 'candidates.json'), 'utf8'));

let redact = makeRedactor([process.env[ENDPOINT_VARIABLE]]);
const say = (text) => console.log(redact(text));

/** The child sees an endpoint only when `extra` hands it one. */
function childEnv(extra = {}) {
  const env = { ...process.env, HARDHAT_DISABLE_TELEMETRY_PROMPT: 'true', ...extra };
  delete env[ENDPOINT_VARIABLE];
  return env;
}

function runChild(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: childEnv(),
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    shell: command === 'npm' && process.platform === 'win32',
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function npm(args, cwd) {
  const { status, output } = runChild('npm', args, cwd);
  if (status !== 0) {
    const message = `npm ${args[0]} failed in ${basename(cwd)}:\n${output.slice(-2000)}`;
    // A failed build is this commit's own fault. An install or a pack can be the network's.
    throw args[0] === 'run' ? new Error(message) : new CouldNotCheck(message);
  }
}

/**
 * Like {@link runChild}, without blocking: the fake node a read may talk to lives in this process,
 * and `spawnSync` would stop it from ever answering.
 */
function runChildAsync(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, timeout: CHILD_TIMEOUT_MS });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, output }));
  });
}

/** The plugin goes on top of the locked tree, as in `prepare-deployment-projects.mjs`. */
function installProject() {
  if (lockDrift(PROJECT).length > 0) npm(['ci', '--no-audit', '--no-fund', '--ignore-scripts'], PROJECT);
  const packed = join(PROJECT, 'cache', 'plugin');
  rmSync(packed, { recursive: true, force: true });
  mkdirSync(packed, { recursive: true });
  // `--ignore-scripts`: `prepack` would rebuild `dist/`, and this must pack what is there.
  npm(['pack', '--ignore-scripts', '--pack-destination', packed], ROOT);
  const tarball = join(packed, readdirSync(packed)[0]);
  npm(['install', '--no-save', '--no-audit', '--no-fund', '--ignore-scripts', tarball], PROJECT);
  const drift = lockDrift(PROJECT);
  if (drift.length > 0) throw new Error(`the project no longer matches its lockfile:\n  ${drift.join('\n  ')}`);
}

function makeRpc(url) {
  let id = 0;
  return async (method, params) => {
    id += 1;
    const { status, body } = await fetchJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (body?.error !== undefined) throw new CouldNotCheck(`${method}: ${body.error.message}`);
    if (body?.result === undefined) throw new CouldNotCheck(`${method}: HTTP ${status} with no result`);
    return body.result;
  };
}

/**
 * Confirms a candidate against Sourcify and writes its one source file.
 *
 * @returns {string[]} What disqualifies it; empty when it qualifies.
 */
async function fetchCandidate(candidate) {
  const fields = 'compilation,proxyResolution,sources';
  const { status, body } = await request(`${SOURCIFY}/${config.chainId}/${candidate.address}?fields=${fields}`);
  if (status === 404) return ['not verified on Sourcify'];
  if (status !== 200 || body === undefined) throw new CouldNotCheck(`Sourcify answered HTTP ${status} for ${candidate.id}`);

  const problems = [];
  const { compilation, proxyResolution, sources } = body;
  const settings = compilation.compilerSettings;
  if (!VERIFIED.has(body.runtimeMatch)) {
    problems.push(`runtime match is ${body.runtimeMatch}`);
  }
  if (proxyResolution.isProxy !== false) problems.push('it is a proxy');
  if (compilation.compilerVersion !== candidate.solcLong) {
    problems.push(`compiler is ${compilation.compilerVersion}, expected ${candidate.solcLong}`);
  }
  if (!solcAtLeast(compilation.compilerVersion, MIN_SOLC)) problems.push('solc is older than 0.5.13');
  if (settings.optimizer.enabled !== candidate.settings.optimizer.enabled ||
      settings.optimizer.runs !== candidate.settings.optimizer.runs) {
    problems.push(`optimizer is ${JSON.stringify(settings.optimizer)}`);
  }
  if (settings.evmVersion !== candidate.settings.evmVersion) problems.push(`EVM is ${settings.evmVersion}`);
  if (Object.keys(settings.libraries ?? {}).length > 0) problems.push('it links libraries');

  const paths = Object.keys(sources ?? {});
  if (paths.length !== 1 || paths[0] !== candidate.file) {
    problems.push(`expected the one file ${candidate.file}, Sourcify lists ${paths.length}`);
    return problems;
  }
  const folder = join(PROJECT, 'contracts', candidate.id);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  // The name is ours, from `candidates.json`, and was only compared with the fetched one.
  writeFileSync(join(folder, candidate.file), sources[paths[0]].content);
  return problems;
}

function compile() {
  const { status, output } = runChild(process.execPath, [HARDHAT_CLI, 'compile'], PROJECT);
  if (status !== 0) throw new Error(`compiling failed:\n${output.slice(-4000)}`);
}

/** @returns {Map<string, object>} Candidate id to solc's output for that contract. */
function compiledContracts() {
  const folder = join(PROJECT, 'artifacts', 'build-info');
  const found = new Map();
  for (const file of readdirSync(folder)) {
    const { output } = JSON.parse(readFileSync(join(folder, file), 'utf8'));
    for (const candidate of config.candidates) {
      const contract = output.contracts?.[`contracts/${candidate.id}/${candidate.file}`]?.[candidate.contract];
      if (contract !== undefined) found.set(candidate.id, contract);
    }
  }
  return found;
}

function storageLayoutProblems(candidate, contract) {
  if (contract === undefined) return ['it was not compiled'];
  const declared = new Set((contract.storageLayout?.storage ?? []).map(({ label }) => label));
  if (declared.size === 0) return ['solc emitted no storageLayout'];
  return candidate.values
    .filter(({ name }) => !declared.has(name))
    .map(({ name }) => `storageLayout has no ${name}`);
}

/** Runs the plugin in the Hardhat project, with `url` visible to that one process. */
async function readThroughPlugin(url, block, firstOnly = false) {
  const folder = mkdtempSync(join(tmpdir(), 'mainnet-check-'));
  const out = join(folder, 'values.json');
  try {
    const { status, output } = await runChildAsync(
      process.execPath,
      [HARDHAT_CLI, 'run', '--no-compile', '--network', 'mainnetCheck', join('scripts', 'read-values.js')],
      PROJECT,
      childEnv({
        MAINNET_CHECK_RPC_URL: url,
        MAINNET_CHECK_BLOCK: String(block),
        MAINNET_CHECK_OUT: out,
        MAINNET_CHECK_FIRST_ONLY: firstOnly ? '1' : '0',
      })
    );
    if (status !== 0 || !existsSync(out)) {
      throw new CouldNotCheck(`the Hardhat read did not finish:\n${output.slice(-2000)}`);
    }
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** Each outcome carries `verdict`: `pass`, `wrong` or `could-not-check`. */
async function compareValues(rpc, read, block, corrupt) {
  const tag = `0x${block.toString(16)}`;
  const results = [];
  let toCorrupt = corrupt;
  for (const candidate of config.candidates) {
    const decoded = read.find((item) => item.candidate === candidate.id).values;
    for (const value of candidate.values) {
      const entry = { candidate: candidate.id, value: value.id };
      const got = decoded.find((item) => item.id === value.id);
      if (got.error !== undefined) {
        const wrong = got.error.class === 'wrong-data';
        results.push({
          ...entry,
          verdict: wrong ? 'wrong' : 'could-not-check',
          error: `${got.error.name}: ${got.error.message}`,
        });
        continue;
      }
      let expected;
      try {
        const call = { to: candidate.address, data: encodeCall(value.oracle) };
        expected = decodeOracle(await rpc('eth_call', [call, tag]), value.oracle);
      } catch (error) {
        if (!(error instanceof CouldNotCheck)) throw error;
        results.push({ ...entry, verdict: 'could-not-check', error: error.message });
        continue;
      }
      if (toCorrupt) {
        expected = `${expected}0`;
        toCorrupt = false;
      }
      const actual = normalize(got.value, value.oracle.type);
      results.push({
        ...entry,
        verdict: actual === expected ? 'pass' : 'wrong',
        decoded: actual,
        oracle: expected,
        trivial: isZeroValue(actual, value.oracle.type),
      });
    }
  }
  return results;
}

function exitCodeOf(results) {
  if (results.some(({ verdict }) => verdict === 'wrong')) return FAILED;
  return results.some(({ verdict }) => verdict === 'could-not-check') ? COULD_NOT_CHECK : OK;
}

function printResults(results) {
  for (const result of results) {
    const shown = result.error ?? `${result.decoded}${result.verdict === 'wrong' ? ` != ${result.oracle}` : ''}`;
    say(`  ${result.verdict.padEnd(15)} ${result.candidate} ${result.value}: ${shown}${result.trivial ? '  (zero, weak evidence)' : ''}`);
  }
}

/**
 * Says where two builds part, for a rejection report: the first byte that differs and the bytes
 * around it, with each side's length. The artifact's comparison in `src/` stays the verdict.
 */
function describeDifference(expected, actual) {
  const size = Math.min(expected.length, actual.length) / 2;
  let at = 0;
  while (at < size && expected.slice(at * 2, at * 2 + 2) === actual.slice(at * 2, at * 2 + 2)) at += 1;
  const around = (code) => code.slice(Math.max(0, at - 16) * 2, (at + 16) * 2);
  return [
    `artifact ${expected.length / 2} bytes, on-chain ${actual.length / 2} bytes`,
    `first byte that differs: ${at} (${size - at} from the end of the shorter)`,
    `artifact around it: ${around(expected)}`,
    `on-chain around it: ${around(actual)}`,
  ].join('\n    ');
}

function trailerOf(code) {
  const length = Number.parseInt(code.slice(-4), 16);
  return code.slice(-(length * 2 + 4));
}

/** One byte flipped at the middle of the code, far from any trailer. */
function corruptCode(code) {
  const at = Math.floor(code.length / 4) * 2;
  const flipped = (Number.parseInt(code.slice(at, at + 2), 16) ^ 0xff).toString(16).padStart(2, '0');
  return `${code.slice(0, at)}${flipped}${code.slice(at + 2)}`;
}

/** A node knowing only each candidate's code, so a read proves the check and no storage. */
function codeNode(codes, transform = (code) => code, arrayLengths = new Set()) {
  return startFakeRpc({
    rule: ({ method, params }) => {
      if (method === 'eth_chainId') return { result: '0x1' };
      if (method === 'eth_blockNumber') return { result: `0x${config.pinnedBlock.toString(16)}` };
      if (method === 'eth_getCode') return { result: `0x${transform(codes[params[0].toLowerCase()])}` };
      if (method === 'eth_getStorageAt') {
        return { result: `0x${(arrayLengths.has(`${params[0].toLowerCase()}:${BigInt(params[1])}`) ? '2' : '0').padStart(64, '0')}` };
      }
      // Agrees with the empty storage above, whatever the value's type. Three outputs, as getReserves().
      if (method === 'eth_call') return { result: `0x${'0'.repeat(64 * 3)}` };
      return { error: { code: -32601, message: `no rule for ${method}` } };
    },
  });
}

/**
 * Where the candidates' arrays keep their lengths, so that an index in a path is in bounds on
 * {@link codeNode}. Each of these arrays is the first field of its structs, at the variable's slot.
 */
function candidateArrayLengths() {
  const contracts = compiledContracts();
  const word = (value) => BigInt(value).toString(16).padStart(64, '0');
  const lengths = new Set();
  for (const { id, address, values } of config.candidates) {
    const { storage } = contracts.get(id).storageLayout;
    for (const { name, path = [] } of values) {
      if (!path.some(([kind]) => kind === 'index')) continue;
      let slot = BigInt(storage.find(({ label }) => label === name).slot);
      for (const [kind, segment] of path) {
        if (kind === 'index') break;
        if (kind === 'key') slot = BigInt(`0x${bytesToHex(keccak_256(hexToBytes(word(segment) + word(slot))))}`);
      }
      lengths.add(`${address.toLowerCase()}:${slot}`);
    }
  }
  return lengths;
}

async function strictCheckOffline(fixture) {
  const codes = Object.fromEntries(
    config.candidates.map(({ id, address }) => [address.toLowerCase(), fixture[id].code])
  );
  const verdicts = new Map();
  for (const [label, transform] of [['genuine', undefined], ['corrupted', corruptCode]]) {
    const node = await codeNode(codes, transform);
    try {
      for (const { candidate, values } of await readThroughPlugin(node.url, config.pinnedBlock, true)) {
        verdicts.set(`${candidate}:${label}`, values[0].error);
      }
    } finally {
      await node.close();
    }
  }
  return verdicts;
}

async function runCandidates() {
  let code = OK;
  const problemsOf = new Map();
  for (const candidate of config.candidates) {
    problemsOf.set(candidate.id, await fetchCandidate(candidate));
  }
  installProject();
  compile();
  const contracts = compiledContracts();

  const rpc = makeRpc(PUBLIC_RPC_URL);
  const live = {};
  for (const { id, address } of config.candidates) {
    live[id] = bare(await rpc('eth_getCode', [address, 'latest']));
  }
  if (options.record) {
    const recorded = Object.fromEntries(
      Object.entries(live).map(([id, liveCode]) => [id, { code: liveCode }])
    );
    mkdirSync(join(PROJECT, 'fixtures'), { recursive: true });
    writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`);
  }
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const verdicts = await strictCheckOffline(fixture);

  for (const candidate of config.candidates) {
    const problems = [...problemsOf.get(candidate.id)];
    const contract = contracts.get(candidate.id);
    problems.push(...storageLayoutProblems(candidate, contract));
    if (live[candidate.id] !== fixture[candidate.id].code) {
      problems.push('the live code is not the recorded fixture');
    }
    const genuine = verdicts.get(`${candidate.id}:genuine`);
    const corrupted = verdicts.get(`${candidate.id}:corrupted`);
    const artifact = contract?.evm?.deployedBytecode?.object ?? '';
    if (genuine !== undefined) {
      problems.push(`the strict check rejected the genuine build: ${genuine.message}`);
      problems.push(describeDifference(artifact, fixture[candidate.id].code));
    }
    if (corrupted === undefined || !EXPECTED_REJECTION.test(corrupted.message)) {
      problems.push('the strict check accepted code with one byte changed');
    }

    const trailerSame = trailerOf(artifact) === trailerOf(fixture[candidate.id].code);
    say(`${candidate.id} ${candidate.address}`);
    say(`  Sourcify: verified, not a proxy, solc ${candidate.solcLong}, optimizer ${JSON.stringify(candidate.settings.optimizer)}, EVM ${candidate.settings.evmVersion}`);
    say(`  storageLayout: ${contract?.storageLayout?.storage?.length ?? 0} variables emitted`);
    say(`  strict check: genuine ${genuine === undefined ? 'accepted' : 'REJECTED'}, one byte changed ${corrupted === undefined ? 'ACCEPTED' : 'rejected'}`);
    say(`  metadata trailer: ${trailerOf(artifact).length / 2} bytes, ${trailerSame ? 'identical to' : 'differs from'} on-chain`);
    for (const problem of problems) say(`  PROBLEM: ${problem}`);
    if (problems.length > 0) code = FAILED;
  }
  return code;
}

/** Every candidate confirmed and written, then the project installed and compiled. */
async function prepareCheckedProject() {
  for (const candidate of config.candidates) {
    const problems = await fetchCandidate(candidate);
    if (problems.length > 0) throw new Error(`${candidate.id}: ${problems.join('; ')}`);
  }
  installProject();
  compile();
}

async function checkAtBlock(url, block, corrupt) {
  const rpc = makeRpc(url);
  const chainId = Number(await rpc('eth_chainId', []));
  if (chainId !== config.chainId) throw new CouldNotCheck(`the endpoint is on chain ${chainId}`);
  const tag = `0x${block.toString(16)}`;
  for (const { id, address } of config.candidates) {
    // A pruned node may error here, or answer as if nothing were deployed.
    const code = await rpc('eth_getCode', [address, tag]);
    await rpc('eth_getStorageAt', [address, '0x0', tag]);
    if (bare(code).length === 0) throw new CouldNotCheck(`the endpoint has no code for ${id} at block ${block}`);
  }
  return compareValues(rpc, await readThroughPlugin(url, block), block, corrupt);
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function writeReport(report) {
  const commit = report.commit ?? 'unknown';
  const path = options.report ?? join(ROOT, '.release-evidence', `mainnet-${commit}.json`);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(redactDeep(report, redact), null, 2)}\n`);
  say(`report: ${path.replace(ROOT, '')}`);
}

/** The G5 path. Without an endpoint it stops before touching anything. */
async function runPinned() {
  const url = process.env[ENDPOINT_VARIABLE];
  if (url === undefined || url.trim() === '') {
    say(`could not check: ${ENDPOINT_VARIABLE} is not set, and block ${config.pinnedBlock} needs an archive endpoint`);
    return COULD_NOT_CHECK;
  }
  // Before the build, which is what this run is judged on.
  const treeClean = git(['status', '--porcelain']) === '';
  const report = {
    kind: 'mainnet-check',
    commit: git(['rev-parse', 'HEAD']),
    treeClean,
    chainId: config.chainId,
    block: config.pinnedBlock,
    corruptExpected: options['corrupt-expected'],
    // A pass from an old `dist/` says nothing about this commit, so a gate must see this.
    builtHere: !options['no-build'],
  };
  let results = [];
  let code;
  let note;
  try {
    if (!options['no-build']) npm(['run', 'build'], ROOT);
    await prepareCheckedProject();
    results = await checkAtBlock(url, config.pinnedBlock, options['corrupt-expected']);
    code = exitCodeOf(results);
  } catch (error) {
    if (!(error instanceof CouldNotCheck)) throw error;
    code = COULD_NOT_CHECK;
    note = error.message;
  }
  printResults(results);
  if (note !== undefined) say(`could not check: ${note}`);
  writeReport({
    ...report,
    outcome: code === OK ? 'pass' : code === FAILED ? 'wrong' : 'could-not-check',
    exitCode: code,
    note,
    results,
  });
  return code;
}

async function runRecent() {
  say(`NOT G5 EVIDENCE: a recent block through a public node, and no report is written.`);
  const rpc = makeRpc(PUBLIC_RPC_URL);
  const block = Number(await rpc('eth_blockNumber', [])) - RECENT_DEPTH;
  await prepareCheckedProject();
  const results = await checkAtBlock(PUBLIC_RPC_URL, block, options['corrupt-expected']);
  say(`block ${block}`);
  printResults(results);
  const passed = results.filter(({ verdict }) => verdict === 'pass').length;
  say(`${passed} of ${results.length} equal`);
  return exitCodeOf(results);
}

/** Runs this script's G5 path against `url`, in a process of its own, and returns what it did. */
async function runSelf(url, report, extra = []) {
  const env = { ...process.env, [ENDPOINT_VARIABLE]: url };
  const args = [fileURLToPath(import.meta.url), '--no-build', ...extra, '--report', report];
  return runChildAsync(process.execPath, args, ROOT, env);
}

/** Needs the project installed and compiled, which `--candidates` leaves it. */
async function runSelfTest() {
  // Every G5 run asks Sourcify first. If it is down, each case below would exit 3 for that reason,
  // so this run says it could not check instead of counting those as proof. Each exit-3 case also
  // names its own reason.
  for (const candidate of config.candidates) await fetchCandidate(candidate);
  const folder = mkdtempSync(join(tmpdir(), 'mainnet-self-test-'));
  const token = 'abcdef0123456789selftesttoken';
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const codes = Object.fromEntries(
    config.candidates.map(({ id, address }) => [address.toLowerCase(), fixture[id].code])
  );
  const failures = [];
  const expect = (label, condition) => {
    say(`  ${condition ? 'ok  ' : 'FAIL'} ${label}`);
    if (!condition) failures.push(label);
  };

  const pruned = await startFakeRpc({
    path: `/v2/${token}`,
    rule: ({ method }) =>
      method === 'eth_chainId'
        ? { result: '0x1' }
        : { error: { code: -32000, message: `missing trie node, see https://node.example/v2/${token}` } },
  });
  const reportPath = join(folder, 'pruned.json');
  const prunedRun = await runSelf(pruned.url, reportPath);
  await pruned.close();
  const report = readFileSync(reportPath, 'utf8');
  expect('a pruned node gives exit 3', prunedRun.status === COULD_NOT_CHECK);
  expect('for the pruned state', String(JSON.parse(report).note).includes('missing trie node'));
  expect('the token is in neither output nor report',
    !prunedRun.output.includes(token) && !report.includes(token));
  expect('the report holds no URL', !/[a-z]+:\/\//i.test(report) && !report.includes('127.0.0.1'));
  expect('the report says could-not-check', JSON.parse(report).outcome === 'could-not-check');

  const closedPort = await freePort();
  const dead = await runSelf(`http://127.0.0.1:${closedPort}/v2/${token}`, join(folder, 'dead.json'));
  expect('a dead endpoint gives exit 3', dead.status === COULD_NOT_CHECK);
  expect('for the refused connection', dead.output.includes('ECONNREFUSED'));
  expect('its token is not printed', !dead.output.includes(token));

  const wrongChain = await startFakeRpc({ rule: () => ({ result: '0x5' }) });
  const other = await runSelf(wrongChain.url, join(folder, 'chain.json'));
  await wrongChain.close();
  expect('another chain gives exit 3', other.status === COULD_NOT_CHECK);
  expect('for the chain', other.output.includes('on chain 5'));

  const tampered = await codeNode(codes, corruptCode);
  const rejected = await runSelf(tampered.url, join(folder, 'tampered.json'));
  await tampered.close();
  expect('code with one byte changed gives exit 1', rejected.status === FAILED);

  // The genuine code, so the strict check passes and the run reaches the value comparison.
  const genuine = await codeNode(codes, undefined, candidateArrayLengths());
  const controlPath = join(folder, 'control.json');
  const control = await runSelf(genuine.url, controlPath);
  const corruptPath = join(folder, 'corrupt.json');
  const corrupted = await runSelf(genuine.url, corruptPath, ['--corrupt-expected']);
  await genuine.close();
  const compared = JSON.parse(readFileSync(controlPath, 'utf8'));
  expect('the same node with nothing altered gives exit 0', control.status === OK && compared.outcome === 'pass');
  expect('and compares every value', compared.results.length > 0 && compared.results.every(({ verdict }) => verdict === 'pass'));
  const altered = JSON.parse(readFileSync(corruptPath, 'utf8'));
  const wrong = altered.results.filter(({ verdict }) => verdict === 'wrong');
  expect('an altered expected value gives exit 1', corrupted.status === FAILED && altered.outcome === 'wrong');
  expect(
    'for that one value, from the comparison',
    altered.corruptExpected === true && wrong.length === 1 && wrong[0].oracle === `${wrong[0].decoded}0`
  );

  const unset = { ...process.env };
  delete unset[ENDPOINT_VARIABLE];
  const none = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: ROOT,
    env: unset,
    encoding: 'utf8',
  });
  expect('no endpoint gives exit 3', none.status === COULD_NOT_CHECK);

  rmSync(folder, { recursive: true, force: true });
  say(failures.length === 0 ? 'self-test passed' : `self-test failed: ${failures.length}`);
  return failures.length === 0 ? OK : FAILED;
}

async function main() {
  if (options['self-test']) return runSelfTest();
  if (options.candidates) return runCandidates();
  if (options.recent) {
    redact = makeRedactor([process.env[ENDPOINT_VARIABLE], PUBLIC_RPC_URL]);
    return runRecent();
  }
  return runPinned();
}

main().then(
  (code) => process.exit(code),
  (error) => {
    say(error instanceof CouldNotCheck ? `could not check: ${error.message}` : `failed: ${error.message}`);
    process.exit(error instanceof CouldNotCheck ? COULD_NOT_CHECK : FAILED);
  }
);
