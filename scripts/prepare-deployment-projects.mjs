/**
 * Builds the package and installs it into both deployment projects, in the same order as
 * `run-e2e.mjs` and for the same reason: a `file:` install would resolve the package back to the
 * root `node_modules`, which holds no plain `hardhat`.
 *
 * ## Lockfiles
 *
 * Each project's `package-lock.json` is tracked, and `npm ci` installs exactly that. The plugin is
 * not a dependency in `package.json`, so it never enters a lockfile, and a rebuilt tarball, whose
 * hash changes every time, leaves the lockfile alone. It goes on top with `--no-save`, and after
 * that `lockDrift` must report nothing: the tarball must not have moved anything else.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockDrift } from '../deployments/shared/lock-drift.mjs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const HH2 = join(ROOT, 'deployments', 'hh2');
export const HH3 = join(ROOT, 'deployments', 'hh3');

const [major, minor] = process.versions.node.split('.').map(Number);
export const NODE_FOR_HARDHAT3 =
  major > 22 || (major === 22 && minor >= 13) ? ['node'] : ['npx', '-y', 'node@22.14'];
/** The argv that starts Hardhat 3, from inside its project. */
export const HARDHAT3_CLI = [...NODE_FOR_HARDHAT3, join('node_modules', 'hardhat', 'dist', 'src', 'cli.js')];

/** The argv of `hardhat run`, from inside that major's project. */
export function hardhatRun(major, script, network = 'readback') {
  const cli = major === 'hh2' ? ['npx', 'hardhat'] : HARDHAT3_CLI;
  return [...cli, 'run', script, '--network', network];
}

export function run(command, args, cwd) {
  console.log(`\n> ${command} ${args.join(' ')}   (${cwd})`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/** @returns {string} The path of a tarball freshly built from this tree. */
export function packBuild() {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  run('npm', ['run', 'build'], ROOT);
  // `--ignore-scripts`: the package's `prepack` would run the build a second time.
  run('npm', ['pack', '--ignore-scripts'], ROOT);
  return join(ROOT, `hardhat-storage-decoder-${version}.tgz`);
}

export function prepareDeploymentProjects() {
  const tarball = packBuild();
  run('node', [join('scripts', 'sync-deployment-contracts.mjs')], ROOT);

  for (const project of [HH2, HH3]) {
    // `npm ci` empties `node_modules`, so it runs only when the tree is not what the lock says.
    if (lockDrift(project).length > 0) run('npm', ['ci', '--no-audit', '--no-fund'], project);
    run('npm', ['install', '--no-save', '--no-audit', '--no-fund', tarball], project);
    const drift = lockDrift(project);
    if (drift.length > 0) {
      console.error(`${project} no longer matches its lockfile:\n  ${drift.join('\n  ')}`);
      process.exit(1);
    }
  }
}
