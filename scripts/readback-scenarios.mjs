#!/usr/bin/env node
/**
 * The read-back as a real command, against a real seeded Anvil, with a fault server in front of it
 * where one is needed. Only local processes are involved, and the only chain is 31337.
 *
 *   node scripts/readback-scenarios.mjs e2e        seed, seal, then read back: exit 0 (AC 8)
 *   node scripts/readback-scenarios.mjs negative   altered and deleted copies: exit 1 (AC 12)
 *   node scripts/readback-scenarios.mjs faults     what each failure of an endpoint leads to
 *
 * The tokens below are made up, and what they prove is that a token given in a URL never comes back
 * out, whatever a provider's error quotes.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeRpc } from '../deployments/shared/fake-rpc-server.mjs';
import { freePort } from '../deployments/shared/free-port.mjs';
import { LOCAL_CHAIN_ID } from './local-node.mjs';
import { ROOT, prepareDeploymentProjects } from './prepare-deployment-projects.mjs';

const LOCAL_MANIFEST = join(ROOT, 'deployments', 'manifest', 'local', `deployments-${LOCAL_CHAIN_ID}.json`);
const mode = process.argv[2];
if (!['e2e', 'negative', 'faults'].includes(mode)) {
  console.error('usage: node scripts/readback-scenarios.mjs <e2e|negative|faults>');
  process.exit(2);
}

const RUN_TIMEOUT_MS = 10 * 60_000;
const failures = [];
function check(name, condition, detail = '') {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : `  [${detail}]`}`);
  if (!condition) failures.push(name);
}

let runId = 0;
/**
 * Asynchronous on purpose: the fault servers live in this process, and a `spawnSync` here would
 * block the event loop they answer from, so every request would simply time out.
 */
async function readback(rpcUrl, { args = [], second = '', manifest = LOCAL_MANIFEST } = {}) {
  runId += 1;
  const json = join(SCRATCH, `report-${runId}.json`);
  const child = spawn(
    'node',
    [join('scripts', 'readback.mjs'), '--chain', String(LOCAL_CHAIN_ID), '--manifest', manifest, '--no-code-wait-ms', '100', '--json', json, ...args],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, READBACK_RPC_URL: rpcUrl, READBACK_SECOND_RPC_URL: second },
    }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const limit = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
  const status = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(limit);
  let report;
  let raw = '';
  try {
    raw = readFileSync(json, 'utf8');
    report = JSON.parse(raw);
  } catch {
    report = { reports: [] };
  }
  // A check on the exit code alone could otherwise pass with no report behind it. Later scenarios still run.
  if (raw === '') check(`read-back ${runId} wrote its report`, false, `exit ${status}`);
  return { code: status, output: `${stdout}\n${stderr}`, report, raw };
}

const summary = (run) => run.output.split('\n').filter((line) => /^(hh[23]:|result:)/.test(line)).join(' / ');
const entries = (run, verdict) =>
  run.report.reports.flatMap((report) => report.results).filter((result) => result.verdict === verdict);

function copyManifest(name, change) {
  const manifest = JSON.parse(readFileSync(LOCAL_MANIFEST, 'utf8'));
  change(manifest.chains[LOCAL_CHAIN_ID].generations.at(-1));
  const path = join(SCRATCH, `${name}.json`);
  writeFileSync(path, JSON.stringify(manifest));
  return path;
}

const HTML = { 'content-type': 'text/html' };
const READS = new Set(['eth_getStorageAt', 'eth_getCode']);
const tagOf = ({ method, params }) => (method === 'eth_getStorageAt' ? params[2] : params[1]);

async function withFake(options, use) {
  const fake = await startFakeRpc(options);
  try {
    return await use(fake);
  } finally {
    await fake.close();
  }
}

async function runE2e(url) {
  console.log('\nthe whole local flow');
  const run = await readback(url);
  console.log(run.output);
  check('a sealed local deployment reads back with exit 0 on both adapters', run.code === 0 && run.report.reports.length === 2, summary(run));
  const all = run.report.reports.flatMap((report) => report.results);
  check('every entry passes', all.length > 0 && entries(run, 'pass').length === all.length, `${entries(run, 'pass').length} of ${all.length}`);
  check(
    'every mock was read',
    new Set(all.map(({ contract }) => contract)).size === readdirSync(join(ROOT, 'deployments', 'contracts')).filter((name) => name.startsWith('Mock')).length
  );
}

async function runNegative(url) {
  console.log('\nnegative control');
  const baseline = await readback(url);
  check('the untouched manifest gives exit 0', baseline.code === 0, summary(baseline));

  const altered = await readback(url, {
    manifest: copyManifest('altered', (generation) => {
      generation.contracts.MockValueTypes.expected.revision.value = '999';
    }),
  });
  console.log(altered.output);
  check('an altered value gives exit 1', altered.code === 1, summary(altered));
  check(
    'the altered entry is named, on both adapters',
    entries(altered, 'wrong').filter(({ entry }) => entry === 'revision').length === 2,
    entries(altered, 'wrong').map(({ detail }) => detail).join('; ')
  );

  const deleted = await readback(url, {
    manifest: copyManifest('deleted', (generation) => {
      delete generation.contracts.MockPacked.expected.small;
    }),
  });
  console.log(deleted.output);
  check('a deleted value gives exit 1', deleted.code === 1, summary(deleted));
  check(
    'the deleted variable is named, on both adapters',
    entries(deleted, 'wrong').filter(({ entry }) => entry === 'MockPacked::small').length === 2
  );

  // The variable keeps other entries in each of these, so only the seed plan can notice.
  const revisionEntry = Object.keys(
    JSON.parse(readFileSync(LOCAL_MANIFEST, 'utf8')).chains[LOCAL_CHAIN_ID].generations.at(-1).contracts.MockValueTypes.expected
  ).find((entry) => entry.startsWith('revision@'));
  for (const [contract, entry] of [
    ['MockArrays', 'numbers[1]'],
    ['MockMappings', 'lists{n:4}[1]'],
    ['MockValueTypes', revisionEntry],
  ]) {
    const partial = await readback(url, {
      manifest: copyManifest(`partial-${contract}`, (generation) => {
        delete generation.contracts[contract].expected[entry];
      }),
    });
    check(`deleting only ${entry} gives exit 1`, partial.code === 1, summary(partial));
    check(
      `the deleted ${entry} is named, on both adapters`,
      entries(partial, 'wrong').filter((result) => result.entry === entry).length === 2
    );
  }

  const noStep = await readback(url, {
    manifest: copyManifest('no-step', (generation) => {
      generation.steps = generation.steps.filter(({ id }) => id !== 'MockPacked:setFirstSlot:0');
    }),
  });
  check('deleting a confirmed step gives exit 1', noStep.code === 1, summary(noStep));

  const removed = await readback(url, {
    manifest: copyManifest('removed', (generation) => {
      delete generation.contracts.MockStrings;
    }),
  });
  check('a deleted contract gives exit 1', removed.code === 1, summary(removed));
}

async function runFaults(url) {
  const generation = JSON.parse(readFileSync(LOCAL_MANIFEST, 'utf8')).chains[LOCAL_CHAIN_ID].generations.at(-1);
  const floor = Math.max(...generation.steps.map(({ block }) => block));
  const allFail = (reply) => (request) => (READS.has(request.method) ? reply : undefined);

  console.log('\nHTTP failures after retries');
  for (const [name, reply] of [
    ['503 HTML', { status: 503, headers: HTML, body: '<html>503</html>' }],
    ['401 HTML', { status: 401, headers: HTML, body: '<html>401 Authorization Required</html>' }],
    ['429', { status: 429, headers: { 'retry-after': '0' }, body: '{"error":"slow down"}' }],
    ['a non-JSON-RPC body over 200', { body: '{"status":429,"error":"cu limit exceeded"}' }],
  ]) {
    await withFake({ upstream: url, rule: allFail(reply) }, async (fake) => {
      const run = await readback(fake.url);
      check(`${name} gives exit 3 on both adapters`, run.code === 3 && run.report.reports.length === 2, summary(run));
      check(`${name} reports nothing wrong`, entries(run, 'wrong').length === 0);
      check(
        `${name} came from the fault itself`,
        fake.count(...READS) > 1 && run.report.reports.every(({ head }) => head !== null),
        `${fake.count(...READS)} read requests`
      );
    });
  }

  console.log('\nthe run-level trip');
  const total = Object.values(generation.contracts).reduce(
    (sum, contract) => sum + Object.keys(contract.expected).length,
    0
  );
  const BUDGET = 5;
  for (const major of ['hh2', 'hh3']) {
    await withFake(
      { upstream: url, rule: allFail({ status: 503, headers: HTML, body: '<html>503</html>' }) },
      async (fake) => {
        const run = await readback(fake.url, { args: ['--major', major, '--retry-budget', String(BUDGET)] });
        const sent = fake.count('eth_getStorageAt', 'eth_getCode');
        check(`${major}: exit 3`, run.code === 3, summary(run));
        // One read issues its code check and first storage read together, so one more can be in flight.
        check(
          `${major}: sends stop once the budget of ${BUDGET} is spent`,
          sent <= BUDGET + 1,
          `${sent} read requests at the server, with ${total} entries`
        );
        check(
          `${major}: the rest are could-not-check without being sent`,
          entries(run, 'could-not-check').filter(({ detail }) => /budget is spent/.test(detail)).length >= total - BUDGET
        );
      }
    );
  }

  console.log('\npruned state');
  const prunedReply = {
    error: { code: 4444, message: 'pruned history unavailable: requested 1, earliest available 2' },
  };
  const isHistoricRead = (request) =>
    READS.has(request.method) && Number(tagOf(request)) < floor;
  await withFake(
    { upstream: url, rule: (request) => (isHistoricRead(request) ? prunedReply : undefined) },
    async (fake) => {
      const run = await readback(fake.url);
      console.log(run.output);
      check('pruned historic gives exit 0', run.code === 0, summary(run));
      const listed = entries(run, 'needs-archive');
      check('and lists them as needs-archive', listed.length === 6 && /needs-archive, not counted/.test(run.output), `${listed.length} listed`);
    }
  );
  await withFake({ upstream: url, rule: allFail(prunedReply) }, async (fake) => {
    const run = await readback(fake.url);
    check('pruned latest gives exit 3', run.code === 3, summary(run));
  });

  console.log('\na head below the floor');
  await withFake(
    {
      upstream: url,
      rule: ({ method }) =>
        method === 'eth_blockNumber' ? { result: `0x${(floor - 1).toString(16)}` } : undefined,
    },
    async (fake) => {
      const run = await readback(fake.url);
      check('gives exit 3', run.code === 3, summary(run));
      const atHead = fake.requests.filter(
        (request) => READS.has(request.method) && Number(tagOf(request)) === floor - 1
      ).length;
      const revisionBlocks = Object.values(generation.contracts.MockValueTypes.expected).map(({ blockTag }) => blockTag);
      check(
        'and sends no read for a latest entry',
        atHead === 0 || revisionBlocks.includes(floor - 1),
        `${atHead} reads at the stale head`
      );
      check('and names the floor', entries(run, 'could-not-check').some(({ detail }) => /below the floor/.test(detail)));
    }
  );

  console.log('\nthe 0x flow');
  const noCode = ({ method }) => (method === 'eth_getCode' ? { result: '0x' } : undefined);
  await withFake({ upstream: url, rule: noCode }, async (first) => {
    await withFake({ upstream: url }, async (secondWithCode) => {
      const run = await readback(first.url, { second: secondWithCode.url });
      check('the second endpoint has code: exit 3', run.code === 3, summary(run));
      check('nothing is called wrong', entries(run, 'wrong').length === 0);
      check(
        'each address is asked about once per adapter',
        secondWithCode.count('eth_getCode') === Object.keys(generation.contracts).length * 2,
        `${secondWithCode.count('eth_getCode')} getCode at the second endpoint`
      );
    });
    await withFake({ upstream: url, rule: noCode }, async (secondEmpty) => {
      const run = await readback(first.url, { second: secondEmpty.url });
      check('both report no code: exit 1', run.code === 1, summary(run));
    });
    const none = await readback(first.url);
    check('no second endpoint: exit 3, never 1', none.code === 3, summary(none));
    await withFake(
      { rule: ({ method }) => (method === 'eth_chainId' ? { result: '0x1' } : { result: '0x' }) },
      async (otherChain) => {
        const run = await readback(first.url, { second: otherChain.url });
        check('a second endpoint on another chain: exit 3', run.code === 3, summary(run));
      }
    );
    await withFake(
      { rule: () => ({ status: 503, headers: HTML, body: '<html>503</html>' }) },
      async (broken) => {
        const run = await readback(first.url, { second: broken.url });
        check('a failing second endpoint: exit 3', run.code === 3, summary(run));
      }
    );
  });

  console.log('\nverdicts come from each entry');
  await withFake(
    { upstream: url, rule: (request) => (isHistoricRead(request) ? prunedReply : undefined) },
    async (fake) => {
      const run = await readback(fake.url, {
        manifest: copyManifest('wrong-address', (copy) => {
          copy.contracts.MockPacked.address = copy.contracts.MockEnums.address;
        }),
      });
      check('a wrong address alongside a pruned entry gives exit 1', run.code === 1, summary(run));
      check(
        'the pruned entries stay needs-archive',
        entries(run, 'needs-archive').length === 6,
        `${entries(run, 'needs-archive').length} needs-archive`
      );
    }
  );

  await withFake({ upstream: url }, async (fake) => {
    const run = await readback(fake.url, { args: ['--burst', '300'] });
    const bursts = run.report.reports.map(({ burst }) => burst);
    check('a burst of 300 succeeds, with exit 0', run.code === 0 && bursts.every(({ ok }) => ok), bursts.map(({ elapsedMs }) => `${elapsedMs} ms`).join(', '));
  });
  for (const major of ['hh2', 'hh3']) {
    const baseline = await withFake({ upstream: url }, async (fake) => {
      await readback(fake.url, { args: ['--major', major] });
      return fake.count('eth_getStorageAt');
    });
    let reads = 0;
    await withFake(
      {
        upstream: url,
        rule: ({ method }) => {
          if (method !== 'eth_getStorageAt') return undefined;
          reads += 1;
          return reads > baseline ? prunedReply : undefined;
        },
      },
      async (fake) => {
        const run = await readback(fake.url, { args: ['--major', major, '--burst', '300'] });
        const burst = run.report.reports[0]?.burst;
        check(`${major}: a rejected burst is reported as failed`, burst?.ok === false, burst?.detail);
        check(
          `${major}: and assigns no entry a verdict`,
          run.code === 0 && entries(run, 'needs-archive').length === 0 && entries(run, 'wrong').length === 0,
          summary(run)
        );
      }
    );
  }

  console.log('\ntokens never appear');
  const PATH_TOKEN = randomBytes(16).toString('hex');
  const QUERY_TOKEN = randomBytes(16).toString('hex');
  const SECOND_TOKEN = randomBytes(16).toString('hex');
  const assertClean = (name, run) => {
    const seen = [PATH_TOKEN, QUERY_TOKEN, SECOND_TOKEN].filter(
      (token) => run.output.includes(token) || run.raw.includes(token)
    );
    check(`${name}: no token in the output or the JSON`, seen.length === 0, `exit ${run.code}`);
  };
  // Only a token this run was given can be recognised bare; a URL of any kind is recognised by shape.
  const quoting = (token) => `upstream https://rpc.example.com/v3/${token}?key=${token} failed for ${token}`;
  const paths = { path: [`/v3/${PATH_TOKEN}`, quoting(PATH_TOKEN)], query: [`/?apikey=${QUERY_TOKEN}`, quoting(QUERY_TOKEN)] };
  for (const [kind, [path, quote]] of Object.entries(paths)) {
    for (const [name, reply] of [
      ['quoted by a JSON-RPC error', { error: { code: -32000, message: quote } }],
      ['quoted by an HTML 401', { status: 401, headers: HTML, body: `<html>${quote}</html>` }],
      ['quoted by a non-JSON-RPC body', { body: `{"error":"${quote}"}` }],
      ['in a Hardhat status error', { status: 403, body: 'no' }],
    ]) {
      await withFake({ upstream: url, path, rule: allFail(reply) }, async (fake) => {
        assertClean(`${kind} token, ${name}`, await readback(fake.url));
      });
    }
  }
  assertClean(
    'a refused connection',
    await readback(`http://127.0.0.1:${await freePort()}/v3/${PATH_TOKEN}?apikey=${QUERY_TOKEN}`)
  );
  await withFake({ upstream: url, path: `/v3/${PATH_TOKEN}`, rule: noCode }, async (first) => {
    await withFake({ upstream: url, path: `/${SECOND_TOKEN}` }, async (secondWithToken) => {
      assertClean('tokens on both endpoints, in the 0x flow', await readback(first.url, { second: secondWithToken.url }));
    });
  });

  console.log('\nusage');
  const bad = spawnSync('node', [join('scripts', 'readback.mjs'), '--major', 'nope'], { cwd: ROOT, encoding: 'utf8' });
  check('an unknown major gives exit 2', bad.status === 2);
  const missing = spawnSync('node', [join('scripts', 'readback.mjs'), '--manifest', join(SCRATCH, 'none.json')], { cwd: ROOT, encoding: 'utf8' });
  check('a missing manifest gives exit 2', missing.status === 2);
  const empty = spawnSync('node', [join('scripts', 'readback.mjs'), '--chain', '11155111'], { cwd: ROOT, encoding: 'utf8' });
  check('a chain with no deployment gives exit 2, and sends nothing', empty.status === 2);
}

prepareDeploymentProjects();

const port = String(await freePort());
const env = { ...process.env, DEPLOYMENTS_ANVIL_PORT: port };
const seed = spawnSync('node', [join('scripts', 'run-deployment-local.mjs'), '--keep'], {
  cwd: ROOT,
  encoding: 'utf8',
  env,
  maxBuffer: 1 << 26,
});
const pid = /pid (\d+)/.exec(seed.stdout ?? '')?.[1];
if (seed.status !== 0 || pid === undefined) {
  console.error(seed.stdout, seed.stderr);
  console.error('the local seed failed');
  process.exit(1);
}
console.log((seed.stdout ?? '').split('\n').filter((line) => /^(seed|seal):/.test(line)).join('\n'));

// Only now, so that no way out above can leave it behind.
const SCRATCH = mkdtempSync(join(tmpdir(), 'readback-scenarios-'));
try {
  const url = `http://127.0.0.1:${port}`;
  if (mode === 'e2e') await runE2e(url);
  if (mode === 'negative') await runNegative(url);
  if (mode === 'faults') await runFaults(url);
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
  process.kill(Number(pid));
}

// So that later commands find no manifest for a node that is gone.
rmSync(LOCAL_MANIFEST, { force: true });
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nall checks passed');
