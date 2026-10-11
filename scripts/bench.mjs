#!/usr/bin/env node
/**
 * Time storage reads with the previous release and with the current build, side by side.
 *
 * Reported, never enforced: nothing in CI runs this. The enforced measure of "faster" is the
 * number of RPC round trips, which the unit suite asserts on a mock.
 *
 * How it runs: two throwaway copies of the Hardhat 2 fixture workspace are created, the
 * baseline tarball is installed into one and a freshly packed build into the other, and the
 * same scenario is run in each with `hardhat run`.
 *
 * Modes:
 *   - simulated latency (default): Hardhat's in-process network answers in well under a
 *     millisecond, so a fixed delay is added to each `eth_getStorageAt`, `eth_getCode` and
 *     `eth_blockNumber`. The delay actually achieved is measured and printed, because timer
 *     granularity (about 15 ms on Windows) usually makes it longer than requested.
 *   - fork: only when FORK_URL, FORK_ADDRESS, FORK_FQN and FORK_VARIABLE are all set. They
 *     must name a contract that ALREADY EXISTS on the forked chain and is compiled in the
 *     workspace: storage of a contract deployed locally on a fork never touches the remote.
 *
 * Environment: BENCH_N (reads, default 1000), BENCH_DELAY_MS (default 5),
 * BENCH_BASELINE (tarball, default .omc/artifacts/baseline-0.1.0.tgz).
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(ROOT, 'test', 'fixtures', 'hh2-project');
const CONTRACTS = join(ROOT, 'test', 'fixtures', 'contracts');
const BASELINE = process.env.BENCH_BASELINE ?? join(ROOT, '.omc', 'artifacts', 'baseline-0.1.0.tgz');
const SKIP = new Set(['node_modules', 'artifacts', 'cache', 'typechain-types', 'contracts']);

const FORK_VARS = ['FORK_URL', 'FORK_ADDRESS', 'FORK_FQN', 'FORK_VARIABLE'];
const forkSet = FORK_VARS.filter((name) => process.env[name]);
const forkMode = forkSet.length === FORK_VARS.length;

/** On Windows the command runs through cmd.exe, which needs paths with spaces or `&` quoted. */
const quote = (arg) =>
  process.platform === 'win32' && /[\s&^|<>()]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg;

function run(command, args, cwd, { capture = false, env } = {}) {
  const result = spawnSync(command, args.map(quote), {
    cwd,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    shell: process.platform === 'win32',
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    console.error(`\n${command} ${args.join(' ')} failed in ${cwd}`);
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? '';
}

/** The scenario, run inside each workspace's own Hardhat process. Plain CommonJS on purpose. */
const SCENARIO = String.raw`
const hre = require('hardhat');

const N = Number(process.env.BENCH_N || 1000);
const DELAY = Number(process.env.BENCH_DELAY_MS || 5);
const FORK = process.env.BENCH_FORK === '1';
const SLOW = new Set(['eth_getStorageAt', 'eth_getCode', 'eth_blockNumber']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6;

async function main() {
  let address, fqn, base;
  if (FORK) {
    await hre.network.provider.request({
      method: 'hardhat_reset',
      params: [{ forking: { jsonRpcUrl: process.env.FORK_URL } }],
    });
    address = process.env.FORK_ADDRESS;
    fqn = process.env.FORK_FQN;
  } else {
    const factory = await hre.ethers.getContractFactory('InheritedStorage');
    const contract = await factory.deploy();
    await contract.waitForDeployment();
    address = await contract.getAddress();
    fqn = 'contracts/InheritedStorage.sol:InheritedStorage';
  }

  // Count, and in simulated mode delay, the calls the decoder makes.
  const counts = {};
  let delayed = 0;
  let delayTotal = 0;
  const original = hre.network.provider;
  const intercept = async (method, call) => {
    if (SLOW.has(method)) {
      counts[method] = (counts[method] || 0) + 1;
      if (!FORK) {
        const start = process.hrtime.bigint();
        await sleep(DELAY);
        delayTotal += ms(start);
        delayed += 1;
      }
    }
    return call();
  };
  hre.network.provider = new Proxy(original, {
    get(target, property) {
      if (property === 'send') {
        return (method, params) => intercept(method, () => target.send(method, params));
      }
      if (property === 'request') {
        return (args) => intercept(args.method, () => target.request(args));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const decoder = hre.storageDecoder.contract(fqn).target(address);
  let queries;
  if (FORK) {
    const variable = decoder.name(process.env.FORK_VARIABLE);
    const keys = (process.env.FORK_KEYS || '').split(',').filter(Boolean);
    queries = Array.from({ length: N }, (_unused, i) =>
      keys.length === 0 ? variable : variable.key(keys[i % keys.length])
    );
  } else {
    const map = decoder.name('childMap');
    queries = Array.from({ length: N }, (_unused, i) =>
      map.key('0x' + (i + 1).toString(16).padStart(40, '0'))
    );
  }

  const snapshot = () => ({ ...counts });
  const since = (before) =>
    Object.fromEntries(Object.keys(counts).map((k) => [k, counts[k] - (before[k] || 0)]));

  let before = snapshot();
  let start = process.hrtime.bigint();
  for (const query of queries) await query.read();
  const single = { ms: ms(start), calls: since(before) };

  let bulk = null;
  if (typeof hre.storageDecoder.readMany === 'function') {
    before = snapshot();
    start = process.hrtime.bigint();
    await hre.storageDecoder.readMany(queries);
    bulk = { ms: ms(start), calls: since(before) };
  }

  console.log(
    'BENCH_RESULT ' +
      JSON.stringify({ n: N, single, bulk, meanDelayMs: delayed === 0 ? 0 : delayTotal / delayed })
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

function prepare(label, tarball) {
  const dir = mkdtempSync(join(tmpdir(), `hsd-bench-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true, filter: (source) => !SKIP.has(source.split(/[\\/]/).pop()) });
  cpSync(CONTRACTS, join(dir, 'contracts'), { recursive: true });
  writeFileSync(join(dir, 'bench-scenario.cjs'), SCENARIO, 'utf8');
  console.log(`\n== ${label}: installing into ${dir}`);
  run('npm', [existsSync(join(dir, 'package-lock.json')) ? 'ci' : 'install', '--no-audit', '--no-fund'], dir);
  run('npm', ['install', '--no-save', '--no-audit', '--no-fund', tarball], dir);
  run('npx', ['hardhat', 'compile', '--quiet'], dir);
  return dir;
}

function measure(dir) {
  const output = run('npx', ['hardhat', 'run', 'bench-scenario.cjs'], dir, {
    capture: true,
    env: { BENCH_FORK: forkMode ? '1' : '0' },
  });
  const line = output.split(/\r?\n/).find((text) => text.startsWith('BENCH_RESULT '));
  if (line === undefined) {
    console.error(`no result line in output:\n${output}`);
    process.exit(1);
  }
  return JSON.parse(line.slice('BENCH_RESULT '.length));
}

if (!existsSync(BASELINE)) {
  console.error(`baseline tarball not found: ${BASELINE}\nSet BENCH_BASELINE to a packed earlier release.`);
  process.exit(1);
}
if (forkSet.length > 0 && !forkMode) {
  console.log(
    `fork mode skipped: it needs all of ${FORK_VARS.join(', ')}, and only ${forkSet.join(', ')} is set.`
  );
}

run('npm', ['run', 'build'], ROOT);
run('npm', ['pack'], ROOT);
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const current = join(ROOT, `hardhat-storage-decoder-${version}.tgz`);

const workspaces = [];
try {
  const baselineDir = prepare('baseline', BASELINE);
  workspaces.push(baselineDir);
  const currentDir = prepare('current', current);
  workspaces.push(currentDir);

  const before = measure(baselineDir);
  const after = measure(currentDir);

  const perRead = (result) => (result === null ? 'n/a' : `${(result.ms / before.n).toFixed(2)} ms`);
  const total = (result) => (result === null ? 'n/a' : `${result.ms.toFixed(0)} ms`);
  const calls = (result) =>
    result === null
      ? 'n/a'
      : Object.entries(result.calls)
          .map(([method, count]) => `${method.replace('eth_', '')}=${count}`)
          .join(' ');

  console.log(`\n=== hardhat-storage-decoder benchmark: ${before.n} reads of one mapping ===`);
  console.log(
    forkMode
      ? // Host only: provider URLs usually carry an API key in the path.
        `mode: fork of ${new URL(process.env.FORK_URL).host} (Hardhat caches forked storage, so repeated slots are only slow once)`
      : `mode: simulated latency, ${process.env.BENCH_DELAY_MS ?? 5} ms requested per RPC call,` +
          ` ${after.meanDelayMs.toFixed(1)} ms achieved on this machine`
  );
  console.log('');
  console.log('scenario                         | baseline 0.1.0        | current');
  console.log('---------------------------------+-----------------------+----------------------');
  console.log(`${before.n} x .read(), one at a time`.padEnd(33) + `| ${total(before.single).padEnd(22)}| ${total(after.single)}`);
  console.log('  per read'.padEnd(33) + `| ${perRead(before.single).padEnd(22)}| ${perRead(after.single)}`);
  console.log('  RPC calls'.padEnd(33) + `| ${calls(before.single).padEnd(22)}| ${calls(after.single)}`);
  console.log(`one readMany of ${before.n}`.padEnd(33) + `| ${total(before.bulk).padEnd(22)}| ${total(after.bulk)}`);
  console.log('  RPC calls'.padEnd(33) + `| ${calls(before.bulk).padEnd(22)}| ${calls(after.bulk)}`);
} finally {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
