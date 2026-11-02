#!/usr/bin/env node
/**
 * AC 26's third case, for real: code built by one Hardhat major, deployed to a local Anvil, read
 * through the built plugin of the other major, under the strict address check. Both directions.
 *
 * Deployed with Anvil's unlocked dev account, so this script handles no key. Only chain 31337.
 * The two builds should differ in their metadata trailer, and this reports whether they do, since a
 * pass over byte-identical code would prove nothing about the check.
 */
import { spawn, spawnSync } from 'node:child_process';
import { freePort } from '../deployments/shared/free-port.mjs';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HARDHAT3_CLI,
  HH2,
  HH3,
  hardhatRun,
  ROOT,
  prepareDeploymentProjects,
  run,
} from './prepare-deployment-projects.mjs';
import { ANVIL_NO_PERSISTED_STATES, LOCAL_CHAIN_ID, jsonRpc, sendFromNode, waitForNode } from './local-node.mjs';

const NODE_START_ATTEMPTS = 102;
const NODE_START_DELAY_MS = 100;
const CONSTRUCTOR_WORDS = { MockImmutable: (1234).toString(16).padStart(64, '0') };
const MOCKS = readdirSync(join(ROOT, 'deployments', 'contracts'))
  .filter((name) => name.startsWith('Mock'))
  .map((name) => name.replace('.sol', ''));

prepareDeploymentProjects();
run('npx', ['hardhat', 'compile', '--quiet'], HH2);
run(HARDHAT3_CLI[0], [...HARDHAT3_CLI.slice(1), 'build', '--quiet'], HH3);

const port = await freePort();
const url = `http://127.0.0.1:${port}`;
const anvil = spawn('anvil', ['--port', String(port), '--chain-id', String(LOCAL_CHAIN_ID), '--silent', ...ANVIL_NO_PERSISTED_STATES], {
  stdio: 'ignore',
});
const scratch = mkdtempSync(join(tmpdir(), 'cross-version-'));

const artifactOf = (project, mock) =>
  JSON.parse(readFileSync(join(project, 'artifacts', 'contracts', `${mock}.sol`, `${mock}.json`), 'utf8'));

async function deploy(from, project, mock) {
  const { bytecode } = artifactOf(project, mock);
  const data = bytecode + (CONSTRUCTOR_WORDS[mock] ?? '');
  return (await sendFromNode(url, from, { data, gas: '0x1c9c380' })).contractAddress;
}

function readWith(reader, targets, label) {
  const targetsPath = join(scratch, `${label}-targets.json`);
  const outPath = join(scratch, `${label}-out.json`);
  writeFileSync(targetsPath, JSON.stringify(targets));
  const [command, ...args] = hardhatRun(reader, join('scripts', 'crossversion.ts'));
  const result = spawnSync(command, args, {
    cwd: reader === 'hh2' ? HH2 : HH3,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
    shell: process.platform === 'win32',
    env: { ...process.env, READBACK_RPC_URL: url, CROSS_TARGETS: targetsPath, CROSS_OUT: outPath },
  });
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    throw new Error(`${label}: the reader exited with ${result.status}`);
  }
  return JSON.parse(readFileSync(outPath, 'utf8'));
}

let failed = 0;
try {
  if (!(await waitForNode(url, NODE_START_ATTEMPTS, NODE_START_DELAY_MS))) throw new Error('anvil did not start');
  const [from] = await jsonRpc(url, 'eth_accounts');

  let differing = 0;
  for (const mock of MOCKS) {
    if (artifactOf(HH2, mock).deployedBytecode !== artifactOf(HH3, mock).deployedBytecode) differing += 1;
  }
  console.log(`\n${differing} of ${MOCKS.length} mocks have different runtime code in the two builds`);
  if (differing === 0) {
    console.error('the two builds are identical, so this run would prove nothing');
    failed += 1;
  }

  for (const [builder, project, reader] of [
    ['hh3', HH3, 'hh2'],
    ['hh2', HH2, 'hh3'],
  ]) {
    const targets = [];
    for (const contract of MOCKS) {
      targets.push({ contract, address: await deploy(from, project, contract) });
    }
    const results = readWith(reader, targets, `${builder}-to-${reader}`);
    console.log(`\nbuilt by ${builder}, read through the ${reader} plugin:`);
    for (const { contract, read, rejectedOther } of results) {
      const passed =
        read.toLowerCase() === from.toLowerCase() && rejectedOther === 'ContractMismatchError/code-differs';
      if (!passed) failed += 1;
      console.log(`  ${passed ? 'ok  ' : 'FAIL'} ${contract}: owner ${read}; another mock's address: ${rejectedOther}`);
    }
    if (results.length !== MOCKS.length) {
      console.error(`  read ${results.length} of ${MOCKS.length}`);
      failed += 1;
    }
  }
} catch (error) {
  console.error(error.message);
  failed += 1;
} finally {
  anvil.kill();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failed === 0 ? '\ncross-version reads passed in both directions' : `\n${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
