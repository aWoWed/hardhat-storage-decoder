#!/usr/bin/env node
/**
 * The whole local flow on a fresh Anvil: seed, then seal, into the ignored
 * `deployments/manifest/local/`. Runs against chain 31337 only. The deployer's key is generated at
 * run time here, passed to the two child processes, and gone when this exits. `--keep` leaves
 * Anvil running and prints that it did, for a read-back to follow. Assumes `deployments:test` has
 * installed the projects.
 *
 *   node scripts/run-deployment-local.mjs [--keep]
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ANVIL_NO_PERSISTED_STATES, LOCAL_ANVIL_PORT as PORT, LOCAL_CHAIN_ID, waitForNode } from './local-node.mjs';
import { HH3, ROOT, hardhatRun } from './prepare-deployment-projects.mjs';

const LOCAL = join(ROOT, 'deployments', 'manifest', 'local');
const CHAIN_ID = String(LOCAL_CHAIN_ID);
const keep = process.argv.includes('--keep');

const anvil = spawn('anvil', ['--port', PORT, '--chain-id', CHAIN_ID, '--silent', ...ANVIL_NO_PERSISTED_STATES], {
  stdio: 'ignore',
  detached: keep,
});

function hardhat(script, input) {
  const [command, ...args] = hardhatRun('hh3', script, 'anvil');
  const result = spawnSync(command, args, {
    cwd: HH3,
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'],
    shell: process.platform === 'win32',
    env: { ...process.env, DEPLOYMENTS_ANVIL_PORT: PORT, SEED_LOCAL_KEY: key },
  });
  if (result.status !== 0) throw new Error(`${script} exited with ${result.status}`);
}

// A local manifest cannot outlive the node it describes.
rmSync(join(LOCAL, `deployments-${CHAIN_ID}.json`), { force: true });
rmSync(join(LOCAL, `pending-${CHAIN_ID}.json`), { force: true });

const key = `0x${randomBytes(32).toString('hex')}`;
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();

let failed = false;
try {
  if (!(await waitForNode(`http://127.0.0.1:${PORT}`, 100, 100))) throw new Error(`anvil did not start on port ${PORT}`);
  hardhat(join('scripts', 'seed.ts'));
  hardhat(join('scripts', 'seal.ts'), `${CHAIN_ID}\n${commit.slice(0, 8)}\n`);
} catch (error) {
  console.error(error.message);
  failed = true;
}

if (keep && !failed) {
  anvil.unref();
  console.log(`anvil left running on port ${PORT}, pid ${anvil.pid}`);
} else {
  anvil.kill();
}
process.exit(failed ? 1 : 0);
