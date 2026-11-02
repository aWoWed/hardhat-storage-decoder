#!/usr/bin/env node
/**
 * The checks a commit must pass before the version bump (AC 28).
 *
 *   npm run release:gate                  runs everything, in order, and stops at the first non-pass
 *   npm run release:gate -- --preflight   runs nothing long and lists everything still outstanding
 *
 * Exit codes:
 *   0  everything passed at this commit. `--preflight`: nothing is outstanding.
 *   1  a real failure.
 *   2  usage.
 *   3  could not check: a tool, a command or evidence is missing, or a node could not answer. This
 *      is never a pass, and is reported apart from a failure.
 *
 * A full run writes `.release-evidence/release-gate-<sha>.json`, whatever the result. It passes with the
 * bump still outstanding, because the bump comes after it (Step 13b); `check-release-consistency.mjs
 * 1.0.0` is what holds the bumped commit to both version files.
 *
 * It never publishes, pushes or tags. It needs no key or private URL: children get an environment
 * with those names removed, so the Sepolia read-back goes through the keyless defaults, and their
 * output is printed through the redactor. The owner's mainnet report is read as a file; the archive
 * URL behind it stays with the owner.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RELEASE_VERSION, checkConsistency } from './check-release-consistency.mjs';
import { NODE_FOR_HARDHAT3, ROOT } from './prepare-deployment-projects.mjs';
import { makeRedactor, redactDeep } from './redact.mjs';
import { runBounded } from './run-bounded.mjs';

export const SEPOLIA = 11155111;
export const BURST_SIZE = 300;
/** The commit this branch started from. Once merged, `main` equals HEAD and shows no change. */
export const RELEASE_BASELINE = '691cfb73979d8b28c83f4d5868ceb5bdc4970184';
const FIXTURE_PATHS = [
  'test/fixtures/contracts',
  'test/fixtures/hh2-project/hardhat.config.ts',
  'test/fixtures/hh3-project/hardhat.config.ts',
  'test/fixtures/copy-fixtures.mjs',
];
const BASE_REFS = ['main', RELEASE_BASELINE];
const MANIFEST = 'deployments/manifest/deployments.json';
const CI_WORKFLOW = 'independent-checks.yml';
const STEP_TIMEOUT_MS = 90 * 60_000;
const SHOWN_LINES = 15;
/** What each version file may read while the bump is still to come. The lock has lagged since 0.1.0. */
const BEFORE_BUMP = { 'package.json': ['0.2.0'], 'package-lock.json': ['0.1.0', '0.2.0'] };

// Assembled only so this file does not match its own scan's rule text; no credential is involved.
const PLACEHOLDERS = [
  ['a focused test', new RegExp(`\\b(?:describe|it|test)(?:\\.\\w+)*\\.${'on'}${'ly'}\\b`)],
  ['a skipped test', new RegExp(`\\b(?:describe|it|test)(?:\\.\\w+)*\\.${'sk'}${'ip'}\\b`)],
  ['a placeholder note', new RegExp(`\\b${'TO'}${'DO'}\\b`)],
];

const SECRET_NAME = /KEY|TOKEN|SECRET|MNEMONIC|RPC_URL|PASSWORD|_URL$|^HARDHAT_VAR_/i;
const GH_LOGIN = ['GH_TOKEN', 'GITHUB_TOKEN'];

const redact = makeRedactor([]);

const pass = (detail) => ({ status: 'pass', ...(detail === undefined ? {} : { detail }) });
const fail = (detail) => ({ status: 'fail', detail });
const couldNotCheck = (detail) => ({ status: 'could-not-check', detail });
const notRun = (detail = 'ready, not run by --preflight') => ({ status: 'not-run', detail });

/** Drops every variable that could hold a key or a private URL, by name, without reading a value. */
export function gateEnv(env, keep = []) {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => keep.includes(name) || !SECRET_NAME.test(name))
  );
}

/** @returns {string[]} What the text contains that a release must not. */
export function scanText(text) {
  return PLACEHOLDERS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The verdict on a Sepolia read-back with a burst. Exit 0 alone proves nothing about the burst,
 * since a rejected burst assigns no verdicts and leaves the exit code at 0.
 *
 * @param {number | null} status - The command's exit code.
 * @param {string | undefined} text - The `--json` file it wrote.
 */
export function evaluateReadback(status, text) {
  if (status === 1) return fail('read-back exit 1: a value, an address or the manifest does not hold');
  if (status === 3) return couldNotCheck('read-back exit 3: an RPC problem kept entries from being read');
  if (status !== 0) return couldNotCheck(`read-back did not finish (exit ${status})`);
  const report = text === undefined ? undefined : parseJson(text);
  if (report === undefined) return couldNotCheck('read-back exit 0 but no readable JSON result');
  if (report.chainId !== SEPOLIA) return couldNotCheck(`read-back reports chain ${report.chainId}, not Sepolia`);
  if (report.exitCode !== 0) return couldNotCheck(`read-back JSON says exit ${report.exitCode}`);

  for (const major of ['hh2', 'hh3']) {
    const adapter = report.reports?.find((entry) => entry.adapter === major);
    if (adapter === undefined) return couldNotCheck(`read-back has no result for ${major}`);
    if (!Array.isArray(adapter.results) || adapter.results.length === 0) {
      return couldNotCheck(`read-back checked no entries on ${major}`);
    }
    if (adapter.results.some(({ verdict }) => verdict === 'wrong')) {
      return fail(`read-back has a wrong entry on ${major}`);
    }
    if (adapter.results.some(({ blockTag, verdict }) => blockTag === 'latest' && verdict !== 'pass')) {
      return couldNotCheck(`read-back left a latest entry unread on ${major}`);
    }
    const { burst } = adapter;
    if (burst === undefined) return couldNotCheck(`read-back has no burst result on ${major}`);
    const detail = burst.detail === undefined ? '' : `: ${burst.detail}`;
    if (burst.ok !== true && String(burst.detail).startsWith('not run')) {
      return couldNotCheck(`burst did not run on ${major}${detail}`);
    }
    if (burst.ok !== true) return fail(`burst of ${burst.size} was rejected on ${major} (AC 27)${detail}`);
    if (!(burst.size >= BURST_SIZE)) return fail(`burst on ${major} was ${burst.size} entries, not ${BURST_SIZE} (AC 27)`);
  }
  return pass(`both adapters, burst of ${BURST_SIZE} succeeded`);
}

/** Sepolia must be deployed and sealed before its read-back counts for a release. */
export function evaluateManifest(text) {
  const manifest = text === undefined ? undefined : parseJson(text);
  if (manifest === undefined) return couldNotCheck(`${MANIFEST} is missing or not JSON`);
  const generations = manifest.chains?.[String(SEPOLIA)]?.generations ?? [];
  if (generations.length === 0) return couldNotCheck('the mocks are not deployed to Sepolia (gate G2)');
  const contracts = Object.entries(generations.at(-1).contracts ?? {});
  if (contracts.length === 0) return couldNotCheck('the Sepolia generation has no contracts (gate G2)');
  const unsealed = contracts.filter(([, record]) => typeof record.sealBlock !== 'number').map(([name]) => name);
  if (unsealed.length > 0) return couldNotCheck(`not sealed on Sepolia (gate G3): ${unsealed.join(', ')}`);
  return pass();
}

/**
 * The owner's mainnet report for AC 22, accepted only if it was made at this commit on a clean tree.
 *
 * A `--recent` run writes no report, and the pinned block in `candidates.json` is what keeps any
 * other block from counting.
 *
 * @param {string | undefined} text
 * @param {string} head
 * @param {string | undefined} candidatesText - `deployments/mainnet/candidates.json` at this commit.
 */
export function evaluateMainnetReport(text, head, candidatesText) {
  if (text === undefined) return couldNotCheck(`no mainnet report for ${head}: the owner runs mainnet:check at gate G5`);
  const report = parseJson(text);
  if (report === undefined) return couldNotCheck('the mainnet report is not valid JSON');
  if (redact(text) !== text) return fail('the mainnet report holds a URL or a key-sized word, so it was not redacted');
  if (report.kind !== 'mainnet-check') return couldNotCheck('the file is not a mainnet-check report');
  if (report.corruptExpected !== false) return couldNotCheck('the mainnet report is from a negative-control run, or does not say it is not');
  if (report.commit !== head) return couldNotCheck(`stale mainnet report: made at ${report.commit}, HEAD is ${head}`);
  if (report.treeClean !== true) return couldNotCheck('the mainnet report was made on a dirty tree');
  if (report.builtHere !== true) return couldNotCheck('the mainnet report tested an existing dist/, not a build of this commit');
  const candidates = candidatesText === undefined ? undefined : parseJson(candidatesText);
  if (typeof candidates?.pinnedBlock !== 'number') return couldNotCheck('deployments/mainnet/candidates.json names no pinned block');
  if (report.block !== candidates.pinnedBlock) {
    return couldNotCheck(`the mainnet report is at block ${report.block}, not the pinned ${candidates.pinnedBlock}`);
  }
  if (report.chainId !== candidates.chainId) return couldNotCheck(`the mainnet report is on chain ${report.chainId}, not ${candidates.chainId}`);
  const results = Array.isArray(report.results) ? report.results : [];
  if (report.outcome === 'wrong' || report.exitCode === 1 || results.some(({ verdict }) => verdict === 'wrong')) {
    return fail('the mainnet report has a wrong value');
  }
  if (report.outcome !== 'pass' || report.exitCode !== 0) {
    return couldNotCheck(`the mainnet check could not check (outcome ${report.outcome}, exit ${report.exitCode})`);
  }
  if (results.length === 0) return couldNotCheck('the mainnet report has no values');
  if (results.some(({ verdict }) => verdict !== 'pass')) return couldNotCheck('the mainnet report has an unchecked value');
  // A zero says little, since an unset slot reads zero too, so each contract needs one value that is not.
  const onlyZeros = [...new Set(results.map(({ candidate }) => candidate))].filter(
    (candidate) => !results.some((result) => result.candidate === candidate && result.trivial === false)
  );
  if (onlyZeros.length > 0) return couldNotCheck(`the mainnet report has only zero or empty values for ${onlyZeros.join(', ')}`);
  return pass(`${results.length} values at block ${report.block}`);
}

/**
 * Commit-bound CI evidence for AC 19, from `gh run list --json headSha,status,conclusion,createdAt,event`.
 * A `pull_request` run tested a merge rather than the commit, so it counts neither way, and a row that
 * does not say what started it is left out too.
 * The head SHA of each row is checked here too, rather than trusting the query's own filter. Only
 * the newest run counts, so an earlier success does not outweigh a later failure at the same commit.
 *
 * @param {string} stdout
 * @param {string} head
 */
export function evaluateCiRuns(stdout, head) {
  const runs = parseJson(stdout);
  if (!Array.isArray(runs)) return couldNotCheck('could not read the gh query result; Geth and Reth evidence is missing');
  const own = runs.filter((run) => run.headSha === head && typeof run.event === 'string' && run.event !== 'pull_request');
  if (own.some((run) => Number.isNaN(Date.parse(run.createdAt)))) {
    return couldNotCheck(`a ${CI_WORKFLOW} run has no creation time, so the newest cannot be told`);
  }
  const newest = own.reduce(
    (latest, run) => (latest === undefined || Date.parse(run.createdAt) > Date.parse(latest.createdAt) ? run : latest),
    undefined
  );
  if (newest?.status === 'completed' && newest.conclusion === 'success') return pass(`${CI_WORKFLOW} succeeded at ${head}`);
  if (newest?.status === 'completed' && newest.conclusion === 'failure') return fail(`the newest ${CI_WORKFLOW} run failed at ${head}`);
  return couldNotCheck(`no successful ${CI_WORKFLOW} run at ${head}; Geth and Reth evidence is missing`);
}

const leftRunning = 'it timed out and could not be killed, so its processes may still be running';

function fromExit(status, label, killFailed) {
  if (killFailed) return couldNotCheck(`${label}: ${leftRunning}`);
  if (status === 0) return pass();
  if (status === null || status === 3) return couldNotCheck(`${label}: could not check (exit ${status})`);
  return fail(`${label} failed (exit ${status})`);
}

/** A step that runs one command. A script or file that is missing makes the command fail. */
function commandStep(name, command, args) {
  return {
    name,
    command: [command, ...args].join(' '),
    preflight: () => notRun(),
    async run(context) {
      const { status, killFailed } = await context.deps.exec(command, args);
      return fromExit(status, name, killFailed);
    },
  };
}

const npmStep = (script, name = script) => commandStep(name, 'npm', ['run', script]);

function treeClean({ deps, head }) {
  const { status, stdout } = deps.git(['status', '--porcelain']);
  if (status !== 0) return couldNotCheck('git status failed');
  const lines = stdout.split('\n').filter(Boolean);
  if (lines.length > 0) return couldNotCheck(`the tree is not clean (${lines.length} paths), so no evidence can bind to ${head}`);
  return pass();
}

function changedFiles({ deps }) {
  const files = new Set();
  for (const ref of BASE_REFS) {
    const diff = deps.git(['-c', 'core.quotepath=off', 'diff', '--name-only', ref]);
    if (diff.status !== 0) return undefined;
    for (const file of diff.stdout.split('\n').filter(Boolean)) files.add(file);
  }
  const untracked = deps.git(['-c', 'core.quotepath=off', 'ls-files', '--others', '--exclude-standard']);
  if (untracked.status !== 0) return undefined;
  for (const file of untracked.stdout.split('\n').filter(Boolean)) files.add(file);
  return [...files];
}

function placeholders(context) {
  const files = changedFiles(context);
  if (files === undefined) return couldNotCheck(`cannot diff against ${BASE_REFS.join(' and ')}`);
  const hits = files
    .filter((file) => !file.endsWith('package-lock.json'))
    .flatMap((file) => {
      const text = context.deps.readText(file);
      if (text === undefined || text.includes('\0')) return [];
      return scanText(text).map((label) => `${file}: ${label}`);
    });
  return hits.length === 0 ? pass(`${files.length} changed files`) : fail(hits.join('; '));
}

function fixturesUnchanged({ deps }) {
  for (const ref of BASE_REFS) {
    const diff = deps.git(['diff', '--name-only', ref, '--', ...FIXTURE_PATHS]);
    if (diff.status !== 0) return couldNotCheck(`cannot diff the fixtures against ${ref}`);
    if (diff.stdout.trim() !== '') return fail(`fixtures differ from ${ref}: ${diff.stdout.trim().split('\n').join(', ')}`);
  }
  const added = deps.git(['ls-files', '--others', '--exclude-standard', '--', ...FIXTURE_PATHS]);
  if (added.status !== 0) return couldNotCheck('cannot list untracked fixtures');
  if (added.stdout.trim() !== '') return fail(`new files among the fixtures: ${added.stdout.trim().split('\n').join(', ')}`);
  return pass();
}

function consistency({ deps }) {
  const { version, docs } = checkConsistency(RELEASE_VERSION, deps.readText);
  if (docs.length > 0) return fail(docs.join('; '));
  if (version.length === 0) return pass(`both version files read ${RELEASE_VERSION}`);
  // Three fields are compared. All of them behind is a bump not made yet; some is half of one.
  if (version.length < 3) return fail(`a partial version bump: ${version.map(({ message }) => message).join('; ')}`);
  const unexpected = version.filter(({ file, found }) => !BEFORE_BUMP[file].includes(found));
  if (unexpected.length > 0) return fail(`a wrong version: ${unexpected.map(({ message }) => message).join('; ')}`);
  return pass(`docs agree; version bump outstanding (Step 13b): ${version.map(({ message }) => message).join('; ')}`);
}

async function ciEvidence({ deps, head }) {
  const { status, stdout } = await deps.exec(
    'gh',
    ['run', 'list', '--workflow', CI_WORKFLOW, '--commit', head, '--limit', '100', '--json', 'headSha,status,conclusion,createdAt,event'],
    { quiet: true, keep: GH_LOGIN }
  );
  if (status !== 0) return couldNotCheck(`gh is unavailable or its query failed, so there is no commit-bound ${CI_WORKFLOW} run; Geth and Reth evidence is missing`);
  return evaluateCiRuns(stdout, head);
}

const clientsStep = {
  name: 'clients (AC 19)',
  command: 'npm run clients -- all',
  preflight: (context) => ciEvidence(context),
  async run(context) {
    const { status, killFailed } = await context.deps.exec('npm', ['run', 'clients', '--', 'all']);
    if (killFailed) return couldNotCheck(`clients all: ${leftRunning}`);
    if (status === 0) return pass('clients all passed locally');
    // Exit 1 is a difference or a suite error, such as a client crashing mid-suite; only the log
    // tells which, so a CI run does not overrule it. Exit 3 is only a runtime that was missing
    // or never started, which the commit-bound run can stand in for.
    if (status !== 3 && status !== null) return fail(`clients all failed (exit ${status}): a client difference or a suite error, see the log above`);
    return ciEvidence(context);
  },
};

const mainnetReport = ({ deps, head }) =>
  evaluateMainnetReport(deps.readText(`.release-evidence/mainnet-${head}.json`), head, deps.readText('deployments/mainnet/candidates.json'));

const readbackStep = {
  name: 'Sepolia read-back with burst (AC 27)',
  command: `node scripts/readback.mjs --chain ${SEPOLIA} --burst ${BURST_SIZE} --json .release-evidence/readback-<sha>.json`,
  preflight({ deps }) {
    const manifest = evaluateManifest(deps.readText(MANIFEST));
    return manifest.status === 'pass' ? notRun() : manifest;
  },
  async run({ deps, head }) {
    const manifest = evaluateManifest(deps.readText(MANIFEST));
    if (manifest.status !== 'pass') return manifest;
    const out = `.release-evidence/readback-${head}.json`;
    // An earlier run's file must not stand in for this one if this one dies before writing.
    deps.clear(out);
    const { status, killFailed } = await deps.exec('node', [
      'scripts/readback.mjs',
      '--chain',
      String(SEPOLIA),
      '--burst',
      String(BURST_SIZE),
      '--json',
      out,
    ]);
    if (killFailed) return couldNotCheck(`read-back: ${leftRunning}`);
    return evaluateReadback(status, deps.readText(out));
  },
};

const instantStep = (name, check) => ({ name, preflight: check, run: check });

/** The whole gate, in order. Cheap and evidence checks first within each stage of the plan. */
export function gateSteps() {
  return [
    instantStep('tree clean', treeClean),
    instantStep('no focused tests, skipped tests or placeholders in changed files', placeholders),
    instantStep('fixtures unchanged', fixturesUnchanged),
    instantStep('release consistency', consistency),
    npmStep('check:secrets'),
    npmStep('deployments:coverage'),
    npmStep('check:workflows'),
    npmStep('test:unit'),
    npmStep('typecheck:core'),
    npmStep('typecheck:hh2'),
    npmStep('typecheck:hh3'),
    npmStep('test:e2e:hh2'),
    commandStep('test:e2e:hh3', NODE_FOR_HARDHAT3[0], [
      ...NODE_FOR_HARDHAT3.slice(1),
      'scripts/run-e2e.mjs',
      'hh3',
    ]),
    npmStep('verify:package'),
    npmStep('deployments:test'),
    npmStep('deployments:e2e:local'),
    npmStep('readback:negative-control'),
    npmStep('readback:scenarios'),
    npmStep('deployments:cross-version'),
    commandStep('example reads on a local node', 'npm', ['--prefix', 'deployments/example', 'run', 'read:local']),
    commandStep('docs check self-test', 'node', ['scripts/check-docs-manifest.mjs', '--self-test']),
    commandStep('docs match the manifest', 'node', ['scripts/check-docs-manifest.mjs']),
    npmStep('oracle:layout'),
    npmStep('oracle:values'),
    clientsStep,
    // `--self-test` needs the project `--candidates` installs and compiles, which is AC 20 as well.
    commandStep('mainnet candidates (AC 20)', 'npm', ['run', 'mainnet:check', '--', '--candidates']),
    commandStep('mainnet check self-test', 'npm', ['run', 'mainnet:check', '--', '--self-test']),
    instantStep('mainnet report (AC 22)', mainnetReport),
    commandStep('Sourcify verification (AC 7)', 'node', ['scripts/check-sourcify.mjs', '--chain', String(SEPOLIA)]),
    readbackStep,
    {
      name: 'tree still clean and HEAD unmoved',
      preflight: () => notRun('only means something after a full run'),
      run(context) {
        const head = context.deps.git(['rev-parse', 'HEAD']).stdout.trim();
        if (head !== context.head) return fail(`HEAD moved from ${context.head} to ${head} during the gate`);
        const clean = treeClean(context);
        return clean.status === 'pass' ? clean : fail('the tree changed during the gate');
      },
    },
  ];
}

/**
 * @param {object} deps - Everything the gate touches outside itself; see `realDeps`.
 * @param {{ preflight?: boolean }} [options]
 * @returns {Promise<{ outcome: 'pass' | 'fail' | 'could-not-check', exitCode: 0 | 1 | 3, head: string | null, steps: Array<{ name: string, status: string, detail?: string }> }>}
 */
export async function runGate(deps, { preflight = false } = {}) {
  const rev = deps.git(['rev-parse', 'HEAD']);
  const head = rev.status === 0 ? rev.stdout.trim() : null;
  const steps = [];
  if (head === null) {
    steps.push({ name: 'commit', ...couldNotCheck('git rev-parse HEAD failed') });
    return { outcome: 'could-not-check', exitCode: 3, head, steps };
  }
  const context = { deps, head };
  let stopped = false;
  for (const step of gateSteps()) {
    if (stopped) {
      steps.push({ name: step.name, status: 'not-run', detail: 'stopped at an earlier step' });
      continue;
    }
    if (!preflight) deps.log(`== ${step.name}`);
    const result = await (preflight ? step.preflight(context) : step.run(context));
    steps.push({ name: step.name, ...result });
    if (!preflight && result.status !== 'pass') stopped = true;
  }

  const failed = steps.some(({ status }) => status === 'fail');
  const blocked = steps.some(({ status }) => status === 'could-not-check');
  const outcome = failed ? 'fail' : blocked ? 'could-not-check' : 'pass';
  const exitCode = failed ? 1 : blocked ? 3 : 0;
  const summary = { outcome, exitCode, head, steps };
  if (!preflight) {
    const evidence = { commit: head, result: outcome, exitCode, at: deps.now(), steps };
    deps.writeText(`.release-evidence/release-gate-${head}.json`, `${JSON.stringify(redactDeep(evidence, redact), null, 2)}\n`);
  }
  return summary;
}

function realDeps() {
  const path = (file) => join(ROOT, file);
  return {
    git(args) {
      const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
      return { status: result.status, stdout: result.stdout ?? '' };
    },
    exec(command, args, { quiet = false, keep = [] } = {}) {
      const relay = (chunk) => {
        if (!quiet) process.stdout.write(redact(chunk));
      };
      return runBounded(command, args, {
        cwd: ROOT,
        env: gateEnv(process.env, keep),
        // npm and npx are .cmd files on Windows. Every argument here is a fixed string or a SHA.
        shell: process.platform === 'win32' && command !== 'gh' && command !== 'node',
        timeoutMs: STEP_TIMEOUT_MS,
        onStdout: relay,
        onStderr: relay,
      });
    },
    readText(file) {
      return existsSync(path(file)) ? readFileSync(path(file), 'utf8') : undefined;
    },
    writeText(file, text) {
      mkdirSync(dirname(path(file)), { recursive: true });
      writeFileSync(path(file), text);
    },
    clear(file) {
      mkdirSync(dirname(path(file)), { recursive: true });
      rmSync(path(file), { force: true });
    },
    log: (line) => console.log(redact(line)),
    now: () => new Date().toISOString(),
  };
}

function printReport({ outcome, exitCode, head, steps }, preflight) {
  const say = (line) => console.log(redact(line));
  const group = (label, status) => {
    const matching = steps.filter((step) => step.status === status);
    if (matching.length === 0) return;
    say(`${label} (${matching.length}):`);
    for (const { name, detail } of matching.slice(0, status === 'pass' ? steps.length : SHOWN_LINES)) {
      say(`  ${name}${detail === undefined ? '' : `: ${detail}`}`);
    }
    if (status !== 'pass' && matching.length > SHOWN_LINES) say(`  and ${matching.length - SHOWN_LINES} more`);
  };
  say(`release gate at ${head}${preflight ? ' (preflight: nothing long was run)' : ''}`);
  group('passed', 'pass');
  group('FAILED', 'fail');
  group('COULD NOT CHECK, not a pass', 'could-not-check');
  group('not run', 'not-run');
  say(`result: ${outcome}, exit ${exitCode}`);
}

async function main() {
  const flags = process.argv.slice(2);
  if (flags.some((flag) => flag !== '--preflight')) {
    console.error('usage: node scripts/release-gate.mjs [--preflight]');
    process.exit(2);
  }
  const preflight = flags.includes('--preflight');
  const report = await runGate(realDeps(), { preflight });
  printReport(report, preflight);
  process.exit(report.exitCode);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
