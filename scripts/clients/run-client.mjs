#!/usr/bin/env node
/**
 * AC 19: the read suite on a real client, version pinned.
 *
 *   node scripts/clients/run-client.mjs <anvil|geth|reth|all> [--seed <n>] [--per-family <n>]
 *
 * Exit codes: 0 every client asked for ran and agreed; 1 a difference; 3 a client could not run,
 * which never counts as a pass. With `all`, 1 outranks 3.
 *
 * A runtime is looked for in this order, and is refused unless it is the pinned version:
 *   geth: GETH_BIN, then `.tools/geth.exe` matching a pinned SHA-512 (Windows only)
 *   reth: RETH_BIN (the release publishes no Windows binary, so none is pinned for `.tools/`)
 *
 * What a client answers for a block above its head and for one it no longer holds is printed, and
 * those wordings feed `src/core/rpc/classifyRpcError.ts`. The node's own accounts send every
 * transaction; there is no key here.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from '../../deployments/shared/free-port.mjs';
import {
  ROOT,
  buildIndependent,
  compileWithSolcJs,
  loadDecoderCore,
  makeDecoder,
  newSeed,
  runValueSuite,
  startAnvil,
} from '../oracle-common.mjs';
import { option } from '../cli-option.mjs';
import { jsonRpc as rpc, sendFromNode, startProcess } from '../local-node.mjs';
import { namesExactVersion } from './exact-version.mjs';

const ANVIL_VERSION = '1.5.1';
const GETH_VERSION = '1.17.10';
const RETH_VERSION = '2.9.0';
const GETH_SHA512 = {
  win32: 'a41a93305c476a113a1229bc70bc6ff14bfc9a6e5d80f508c38e9d7979d13c4bc35f093c86ed78e9cc5fc076679b519341257e5a3f6618491faa35dc695b3689',
};

const DEFAULT_PER_FAMILY = 20;
const START_ATTEMPTS = 300;
/** Past the 128 states a geth-family node keeps by default in memory. */
const BLOCKS_BEFORE_OLD_READ = 200;
const PRUNE_KEEP = '5';

class Unavailable extends Error {}

const seed = option('--seed') === undefined ? newSeed() : Number(option('--seed'));
const perFamily = Number(option('--per-family') ?? DEFAULT_PER_FAMILY);

function requireVersion(name, bin, args, pinned) {
  const run = spawnSync(bin, args, { encoding: 'utf8', timeout: 30_000 });
  if (run.status !== 0) throw new Unavailable(`${bin} ${args.join(' ')} did not run`);
  const text = run.stdout;
  if (!namesExactVersion(text, pinned)) {
    throw new Unavailable(`${bin} is not the pinned ${name} ${pinned}: ${text.trim().split('\n')[0]}`);
  }
}

const gethArgs = (port, authPort, datadir) => [
  '--dev',
  '--http',
  '--http.addr',
  '127.0.0.1',
  '--http.port',
  String(port),
  '--http.api',
  'eth,web3,net',
  '--authrpc.port',
  String(authPort),
  '--port',
  '0',
  '--ipcdisable',
  '--datadir',
  datadir,
];

const rethArgs = (port, authPort, datadir) => [
  'node',
  '--dev',
  '--http',
  '--http.addr',
  '127.0.0.1',
  '--http.port',
  String(port),
  '--http.api',
  'eth,web3,net',
  '--authrpc.port',
  String(authPort),
  '--port',
  '0',
  '--disable-discovery',
  '--ipcdisable',
  '--datadir',
  datadir,
];

/** How to start a client from a binary on this machine. */
function pickRuntime(name) {
  const fromBinary = (bin, makeArgs) => async () => {
    const port = await freePort();
    const datadir = mkdtempSync(join(tmpdir(), `client-${name}-`));
    const url = `http://127.0.0.1:${port}`;
    const node = await startProcess(bin, makeArgs(port, await freePort(), datadir), url, {
      attempts: START_ATTEMPTS,
      cleanup: () => rmSync(datadir, { recursive: true, force: true }),
    });
    if (node === undefined) throw new Unavailable(`${bin} did not answer on ${url}`);
    return node;
  };

  if (name === 'geth') {
    if (process.env.GETH_BIN) {
      requireVersion('geth', process.env.GETH_BIN, ['version'], GETH_VERSION);
      return { describe: `GETH_BIN (${GETH_VERSION})`, start: fromBinary(process.env.GETH_BIN, gethArgs) };
    }
    const tool = join(ROOT, '.tools', process.platform === 'win32' ? 'geth.exe' : 'geth');
    if (existsSync(tool)) {
      const digest = createHash('sha512').update(readFileSync(tool)).digest('hex');
      if (digest !== GETH_SHA512[process.platform]) {
        throw new Unavailable(`${tool} does not match the pinned SHA-512 for ${process.platform}`);
      }
      return { describe: `.tools binary (${GETH_VERSION})`, start: fromBinary(tool, gethArgs) };
    }
    throw new Unavailable('no GETH_BIN and no pinned binary in .tools/');
  }
  if (process.env.RETH_BIN) {
    requireVersion('reth', process.env.RETH_BIN, ['--version'], RETH_VERSION);
    return { describe: `RETH_BIN (${RETH_VERSION})`, start: fromBinary(process.env.RETH_BIN, rethArgs) };
  }
  throw new Unavailable('no RETH_BIN');
}

/** What the client says, and what the decoder's classifier and the decoder itself make of it. */
async function failureOf(core, url, decoderQuery, address, block) {
  const tag = `0x${block.toString(16)}`;
  let raw;
  try {
    raw = { result: await rpc(url, 'eth_getStorageAt', [address, '0x0', tag]) };
  } catch (error) {
    raw = { code: error.code, message: error.message, classifiedAs: core.classifyRpcError(error) };
  }
  let decoder;
  try {
    await decoderQuery.at(block).read();
    decoder = 'read succeeded';
  } catch (error) {
    decoder = `${error.name}: ${error.message.split('\n')[0]}`;
  }
  return { raw, decoder };
}

async function runSuiteOn(name, node, tools) {
  const failures = [];
  const version = await rpc(node.url, 'web3_clientVersion');
  console.log(`client version: ${version}`);
  const result = await runValueSuite({ url: node.url, tools, perFamily, seed });
  for (const { name: where, path, found } of result.mismatches) {
    failures.push(`${where} ${path ?? ''}: ${found.join('; ')}`);
  }
  for (const variable of result.unchecked) failures.push(`no value was checked for ${variable}`);

  const address = result.addresses.MockValueTypes;
  const query = result.decoder.contract('mocks/MockValueTypes.sol:MockValueTypes').target(address).name('revision');
  const head = Number(await rpc(node.url, 'eth_blockNumber'));

  const above = await failureOf(tools.core, node.url, query, address, head + 1000);
  console.log(`block above the head: ${JSON.stringify(above)}`);

  console.log(`block before the deployment: ${result.beforeDeployment}`);
  if (result.beforeDeployment !== 'ContractMismatchError') failures.push(`before the deployment: ${result.beforeDeployment}`);

  if (name === 'anvil') {
    // Anvil words these two cases alike: see the test in test/unit/clientVectors.test.ts.
    if (above.raw.code !== -32602 || !/block height is \d+ but requested was \d+/.test(above.raw.message)) {
      failures.push(`Anvil's wording above the head changed: ${JSON.stringify(above.raw)}`);
    }
    if (above.raw.classifiedAs !== 'fatal') failures.push(`above the head is classified ${above.raw.classifiedAs}`);
    const pruned = await startAnvil(['--prune-history', PRUNE_KEEP]);
    try {
      for (let block = 0; block < 30; block += 1) await rpc(pruned.url, 'evm_mine');
      const decoder = makeDecoder(tools.core, tools.compiled, pruned.url, { addressCheck: false });
      const old = await failureOf(
        tools.core,
        pruned.url,
        decoder.contract('mocks/MockValueTypes.sol:MockValueTypes').target(address).name('revision'),
        address,
        1
      );
      console.log(`block no longer held (--prune-history ${PRUNE_KEEP}): ${JSON.stringify(old)}`);
      if (old.raw.code !== above.raw.code || !/block height is \d+ but requested was \d+/.test(old.raw.message ?? '')) {
        failures.push(`Anvil's pruned wording changed: ${JSON.stringify(old.raw)}`);
      }
      if (old.raw.classifiedAs !== 'fatal') failures.push(`pruned is classified ${old.raw.classifiedAs}`);
    } finally {
      await pruned.stop();
    }
  } else {
    // Whatever the client does here is recorded, not judged: what it keeps is its own setting.
    let blocks = Number(await rpc(node.url, 'eth_blockNumber'));
    while (blocks < BLOCKS_BEFORE_OLD_READ) {
      await sendFromNode(node.url, result.from, { to: result.from, value: '0x1' });
      blocks = Number(await rpc(node.url, 'eth_blockNumber'));
    }
    console.log(`old block after ${blocks} blocks: ${JSON.stringify(await failureOf(tools.core, node.url, query, address, 1))}`);
  }
  return failures;
}

const asked = process.argv[2];
if (!['anvil', 'geth', 'reth', 'all'].includes(asked)) {
  console.error('usage: node scripts/clients/run-client.mjs <anvil|geth|reth|all> [--seed <n>] [--per-family <n>]');
  process.exit(2);
}

const { core, plan, manifest } = await loadDecoderCore();
buildIndependent();
const tools = { core, plan, manifest, compiled: compileWithSolcJs(core) };

const outcomes = {};
for (const name of asked === 'all' ? ['anvil', 'geth', 'reth'] : [asked]) {
  console.log(`\n== ${name}`);
  let node;
  try {
    if (name === 'anvil') {
      requireVersion('anvil', 'anvil', ['--version'], ANVIL_VERSION);
      node = await startAnvil();
    } else {
      const runtime = pickRuntime(name);
      console.log(`runtime: ${runtime.describe}`);
      node = await runtime.start();
    }
    const failures = await runSuiteOn(name, node, tools);
    outcomes[name] = failures.length === 0 ? 'pass' : 'DIFFERENCE';
    for (const failure of failures.slice(0, 20)) console.error(`  ${failure}`);
    if (failures.length > 20) console.error(`  and ${failures.length - 20} more`);
  } catch (error) {
    // A node with no account to send from cannot run the suite; that says nothing about reads.
    if (error instanceof Unavailable || error.unusable === true) {
      outcomes[name] = 'not run';
      console.log(`NOT RUN: ${error.message}`);
    } else {
      outcomes[name] = 'DIFFERENCE';
      console.error(`  ${name} failed: ${error.stack}`);
    }
  } finally {
    await node?.stop();
  }
}

console.log('\nresults:');
for (const [name, outcome] of Object.entries(outcomes)) console.log(`  ${name}: ${outcome}`);
const all = Object.values(outcomes);
process.exit(all.includes('DIFFERENCE') ? 1 : all.includes('not run') ? 3 : 0);
