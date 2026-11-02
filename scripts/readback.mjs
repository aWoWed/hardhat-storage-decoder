#!/usr/bin/env node
/**
 * Reads every manifest entry through both Hardhat adapters and compares it with the expected value.
 *
 *   node scripts/readback.mjs [--chain N] [--manifest PATH] [--major hh2|hh3] [--burst N]
 *                             [--json PATH] [--retry-budget N] [--no-code-wait-ms N]
 *
 * Exit codes:
 *   0  every `latest` entry passes. `historic` entries a node cannot serve are listed, not counted.
 *   1  a value is wrong, the code at an address is wrong, or an entry was altered or deleted.
 *   2  usage.
 *   3  could not check: an RPC or network problem kept a `latest` entry from being read, with
 *      nothing wrong.
 *
 * Endpoints come from `READBACK_RPC_URL` and `READBACK_SECOND_RPC_URL`, in the environment and not
 * on the command line, since a URL can hold a token. An empty second URL means none. Sepolia has
 * keyless defaults below, chosen by probing public endpoints; the second one only confirms
 * that an address has no code.
 *
 * Nothing leaves this process without passing the redactor, including what the adapter scripts
 * print and the `--json` file. Assumes `deployments:test` has installed the projects.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { LOCAL_ANVIL_PORT, LOCAL_CHAIN_ID as LOCAL } from './local-node.mjs';
import { HH2, HH3, ROOT, hardhatRun } from './prepare-deployment-projects.mjs';
import { exitCodeOf } from './readback-exit-code.mjs';
import { makeRedactor, redactDeep } from './redact.mjs';
import { runBounded } from './run-bounded.mjs';

const SEPOLIA = 11155111;
const DEFAULT_ENDPOINTS = {
  [SEPOLIA]: {
    primary: 'https://ethereum-sepolia-rpc.publicnode.com',
    second: 'https://sepolia.gateway.tenderly.co',
  },
  [LOCAL]: { primary: `http://127.0.0.1:${LOCAL_ANVIL_PORT}`, second: '' },
};
const ADAPTER_TIMEOUT_MS = 30 * 60_000;
const SHOWN_LINES = 20;

function usage(message) {
  console.error(`${message}\nusage: node scripts/readback.mjs [--chain N] [--manifest PATH] [--major hh2|hh3] [--burst N] [--json PATH] [--retry-budget N] [--no-code-wait-ms N]`);
  process.exit(2);
}

let options;
try {
  ({ values: options } = parseArgs({
    options: {
      chain: { type: 'string', default: String(SEPOLIA) },
      manifest: { type: 'string' },
      major: { type: 'string' },
      burst: { type: 'string' },
      json: { type: 'string' },
      'retry-budget': { type: 'string', default: '32' },
      'no-code-wait-ms': { type: 'string', default: '5000' },
    },
  }));
} catch (error) {
  usage(error.message);
}

const chainId = Number(options.chain);
if (!Number.isInteger(chainId) || chainId <= 0) usage(`--chain must be a chain ID`);
for (const name of ['burst', 'retry-budget', 'no-code-wait-ms']) {
  if (options[name] !== undefined && !/^\d+$/.test(options[name])) usage(`--${name} must be a whole number`);
}
const majors = options.major === undefined ? ['hh2', 'hh3'] : [options.major];
if (!majors.every((major) => major === 'hh2' || major === 'hh3')) usage('--major must be hh2 or hh3');

const manifestPath =
  options.manifest ??
  (chainId === LOCAL
    ? join(ROOT, 'deployments', 'manifest', 'local', `deployments-${LOCAL}.json`)
    : join(ROOT, 'deployments', 'manifest', 'deployments.json'));
if (!existsSync(manifestPath)) usage(`no manifest at ${manifestPath}`);
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch {
  usage(`${manifestPath} is not valid JSON`);
}
if (manifest.chains?.[String(chainId)]?.generations?.length === undefined ||
    manifest.chains[String(chainId)].generations.length === 0) {
  usage(`the manifest has nothing for chain ${chainId}, so there is nothing to check`);
}

const primary = process.env.READBACK_RPC_URL ?? DEFAULT_ENDPOINTS[chainId]?.primary;
if (primary === undefined || primary === '') usage(`set READBACK_RPC_URL for chain ${chainId}`);
const second = process.env.READBACK_SECOND_RPC_URL ?? DEFAULT_ENDPOINTS[chainId]?.second ?? '';

const redact = makeRedactor([primary, second]);
const say = (text) => console.log(redact(text));

async function runAdapter(major, outPath) {
  const project = major === 'hh2' ? HH2 : HH3;
  if (!existsSync(join(project, 'node_modules', 'hardhat-storage-decoder'))) {
    usage(`${project} is not installed: run npm run deployments:test first`);
  }
  const [command, ...args] = hardhatRun(major, join('scripts', 'readback.ts'));
  const result = await runBounded(command, args, {
    cwd: project,
    timeoutMs: ADAPTER_TIMEOUT_MS,
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      READBACK_RPC_URL: primary,
      READBACK_SECOND_RPC_URL: second,
      READBACK_CHAIN: String(chainId),
      READBACK_MANIFEST: manifestPath,
      READBACK_OUT: outPath,
      READBACK_RETRY_BUDGET: options['retry-budget'],
      READBACK_NO_CODE_WAIT_MS: options['no-code-wait-ms'],
      READBACK_BURST: options.burst ?? '',
    },
  });
  if (!result.timedOut && existsSync(outPath)) return JSON.parse(readFileSync(outPath, 'utf8'));
  // No report means no verdict, so this is never a pass and never a wrong value.
  const tail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim().split('\n').slice(-5).join(' | ');
  return {
    adapter: major,
    chainId,
    head: null,
    floor: 0,
    failedRequests: 0,
    results: [
      {
        contract: '(all)',
        entry: '(adapter did not finish)',
        blockTag: 'latest',
        verdict: 'could-not-check',
        detail: redact(`${result.timedOut ? `timed out${result.killFailed ? ' and could not be killed' : ''}` : `exit ${result.status}`}: ${tail}`),
      },
    ],
  };
}

function printLines(label, results) {
  if (results.length === 0) return;
  say(`  ${label} (${results.length}):`);
  for (const { contract, entry, detail } of results.slice(0, SHOWN_LINES)) {
    say(`    ${contract} ${entry}${detail === undefined ? '' : `: ${detail}`}`);
  }
  if (results.length > SHOWN_LINES) say(`    and ${results.length - SHOWN_LINES} more`);
}

const scratch = mkdtempSync(join(tmpdir(), 'readback-'));
const reports = [];
try {
  for (const major of majors) reports.push(await runAdapter(major, join(scratch, `${major}.json`)));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

say(`read-back on chain ${chainId}`);
for (const report of reports) {
  const count = (verdict) => report.results.filter((result) => result.verdict === verdict).length;
  say(
    `${report.adapter}: head ${report.head}, floor ${report.floor}, ${report.results.length} entries: ` +
      `pass ${count('pass')}, wrong ${count('wrong')}, could-not-check ${count('could-not-check')}, ` +
      `needs-archive ${count('needs-archive')}; failed requests ${report.failedRequests}`
  );
  const isHistoric = ({ blockTag }) => blockTag !== 'latest';
  printLines('wrong', report.results.filter(({ verdict }) => verdict === 'wrong'));
  printLines(
    'could-not-check',
    report.results.filter((result) => result.verdict === 'could-not-check' && !isHistoric(result))
  );
  printLines(
    'needs-archive',
    report.results.filter((result) => result.verdict === 'needs-archive' && !isHistoric(result))
  );
  printLines(
    'historic, needs-archive, not counted',
    report.results.filter((result) => result.verdict === 'needs-archive' && isHistoric(result))
  );
  printLines(
    'historic, could-not-check, not counted',
    report.results.filter((result) => result.verdict === 'could-not-check' && isHistoric(result))
  );
  if (report.burst !== undefined) {
    const { size, ok, elapsedMs, detail } = report.burst;
    say(`  burst of ${size}: ${ok ? 'ok' : 'failed'} in ${elapsedMs} ms${detail ? `: ${detail}` : ''}`);
  }
}

const code = exitCodeOf(reports.flatMap((report) => report.results));
const MEANING = {
  0: 'every latest entry passes',
  1: 'wrong: a value, an address or the manifest does not hold',
  3: 'could not check: nothing was wrong, but not everything could be read',
};
say(`result: exit ${code}, ${MEANING[code]}`);

if (options.json !== undefined) {
  writeFileSync(
    options.json,
    `${JSON.stringify(redactDeep({ chainId, exitCode: code, reports }, redact), null, 2)}\n`
  );
}
process.exit(code);
