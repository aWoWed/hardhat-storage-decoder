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
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
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

if (!existsSync(join(workspace, 'package.json'))) {
  console.error(
    `The ${major} fixture workspace does not exist yet (expected ${workspace}).\n` +
      'It is created by implementation step 12 — the on-chain suites cannot run without it.'
  );
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const tarball = join(ROOT, `hardhat-storage-decoder-${version}.tgz`);

function run(command, args, cwd) {
  console.log(`\n> ${command} ${args.join(' ')}   (${cwd})`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('npm', ['run', 'build'], ROOT);
// `--ignore-scripts`: the package's `prepack` would run the build a second time.
run('npm', ['pack', '--ignore-scripts'], ROOT);
run('npm', ['install', '--no-save', tarball], workspace);
run('npx', ['hardhat', 'compile'], workspace);
run('npm', ['test'], workspace);
