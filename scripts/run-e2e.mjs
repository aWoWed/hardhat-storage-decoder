#!/usr/bin/env node
/**
 * Drive one of the on-disk Hardhat fixture workspaces.
 *
 * Install order matters and is not negotiable (see `docs/build-internals.md`):
 *   build -> npm pack --ignore-scripts -> install the TARBALL into the workspace -> hardhat compile -> test
 *
 * A `file:`/`link:` install would be symlinked, and Node resolves a symlinked package from
 * its realpath — landing back in the package root's `node_modules`, which deliberately holds
 * only the `hardhat-v2`/`hardhat-v3` aliases and no plain `hardhat`.
 */
import { join } from 'node:path';
import { ROOT, packBuild, run } from './prepare-deployment-projects.mjs';

const major = process.argv[2];

const WORKSPACES = {
  hh2: join(ROOT, 'test', 'fixtures', 'hh2-project'),
  hh3: join(ROOT, 'test', 'fixtures', 'hh3-project'),
};

const workspace = WORKSPACES[major];
if (workspace === undefined) {
  console.error(`usage: node scripts/run-e2e.mjs <${Object.keys(WORKSPACES).join('|')}>`);
  process.exit(2);
}

const tarball = packBuild();
run('npm', ['install', '--no-save', tarball], workspace);
run('npx', ['hardhat', 'compile'], workspace);
run('npm', ['test'], workspace);
