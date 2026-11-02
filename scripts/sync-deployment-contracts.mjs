#!/usr/bin/env node
/**
 * Copy the mocks from `deployments/contracts/` into each deployment project's ignored
 * `contracts/`. The projects compile the copies, so both build the same sources under their own
 * Hardhat major. Its own script because `test/fixtures/copy-fixtures.mjs` is bound to the
 * fixtures folder and stays unchanged.
 *
 * Copies, not symlinks, for the reason given in `copy-fixtures.mjs`.
 *
 *   node scripts/sync-deployment-contracts.mjs
 */
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEPLOYMENTS = fileURLToPath(new URL('../deployments/', import.meta.url));
const SOURCE = join(DEPLOYMENTS, 'contracts');
const PROJECTS = ['hh2', 'hh3'];

const names = (await readdir(SOURCE)).filter((name) => name.endsWith('.sol')).sort();
if (names.length === 0) {
  console.error(`no .sol files found in ${SOURCE}`);
  process.exit(1);
}

for (const project of PROJECTS) {
  const target = join(DEPLOYMENTS, project, 'contracts');
  // Removed first so a mock deleted upstream does not linger here and keep compiling.
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const name of names) await cp(join(SOURCE, name), join(target, name));
  console.log(`copied ${names.length} contract(s) into ${target}`);
}
