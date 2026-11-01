#!/usr/bin/env node
/**
 * One command for the example. It installs the package, compiles the mocks, and runs every read in
 * `docs/public-testnet.md`.
 *
 *   node run.mjs              Sepolia, from the manifest, with the package packed from this repo
 *   node run.mjs --local      a fresh Anvil seeded by this example, with the same local package
 *   node run.mjs --published  Sepolia, with the package from the npm registry
 *
 * The packed package comes from the existing `dist/`: `--ignore-scripts` skips the build in
 * `prepack`, so run `npm run build` at the repo root first if the source has changed.
 *
 * Exit codes: 0 every read passed, 1 a read was wrong, 2 usage or nothing to read, 3 could not
 * check. `EXAMPLE_RPC_URL` replaces the default Sepolia endpoint.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANVIL_NO_PERSISTED_STATES, waitForNode } from '../../scripts/local-node.mjs';
import { freePort } from '../shared/free-port.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..');
const LOCAL = join(HERE, '.local');
const SEPOLIA = 11155111;
const LOCAL_CHAIN = 31337;
const DEFAULT_SEPOLIA_URL = 'https://ethereum-sepolia-rpc.publicnode.com';

const [mode, ...rest] = process.argv.slice(2);
if (rest.length > 0 || ![undefined, '--local', '--published'].includes(mode)) {
  console.error('usage: node run.mjs [--local | --published]');
  process.exit(2);
}
const isLocal = mode === '--local';

const [major, minor] = process.versions.node.split('.').map(Number);
const node = major > 22 || (major === 22 && minor >= 13) ? ['node'] : ['npx', '-y', 'node@22.14'];

function step(command, args, cwd = HERE) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(result.stderr);
    console.error(`${command} ${args.join(' ')} failed with ${result.status}`);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

function install() {
  mkdirSync(LOCAL, { recursive: true });
  if (!existsSync(join(HERE, 'node_modules', 'hardhat'))) {
    step('npm', ['ci', '--no-audit', '--no-fund']);
  }
  let source = 'hardhat-storage-decoder';
  if (mode !== '--published') {
    if (!existsSync(join(ROOT, 'dist', 'hardhat3', 'index.mjs'))) {
      console.error('no dist/ at the repo root: run npm run build there first');
      process.exit(2);
    }
    const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    step('npm', ['pack', '--ignore-scripts', '--pack-destination', LOCAL], ROOT);
    source = join(LOCAL, `hardhat-storage-decoder-${version}.tgz`);
  }
  step('npm', ['install', '--no-save', '--no-audit', '--no-fund', source]);
  console.log(`package: ${mode === '--published' ? 'npm registry' : 'local tarball from dist/'}`);

  const contracts = join(HERE, 'contracts');
  rmSync(contracts, { recursive: true, force: true });
  mkdirSync(contracts);
  const mocks = join(ROOT, 'deployments', 'contracts');
  for (const name of readdirSync(mocks)) cpSync(join(mocks, name), join(contracts, name));
}

function hardhat(script, env) {
  const [command, ...prefix] = node;
  const cli = join('node_modules', 'hardhat', 'dist', 'src', 'cli.js');
  const result = spawnSync(command, [...prefix, cli, 'run', script, '--network', 'target'], {
    cwd: HERE,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  });
  return result.status ?? 1;
}

async function runLocal() {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const manifest = join(LOCAL, `deployments-${LOCAL_CHAIN}.json`);
  const env = {
    EXAMPLE_RPC_URL: url,
    EXAMPLE_MANIFEST: manifest,
    EXAMPLE_CHAIN: String(LOCAL_CHAIN),
  };
  const anvil = spawn('anvil', ['--port', String(port), '--chain-id', String(LOCAL_CHAIN), '--silent', ...ANVIL_NO_PERSISTED_STATES], {
    stdio: 'ignore',
  });
  try {
    if (!(await waitForNode(url, 100, 100))) throw new Error(`no node answered at ${url}`);
    console.log(`source: local Anvil on chain ${LOCAL_CHAIN}, seeded by this run`);
    const seeded = hardhat(join('scripts', 'seed-local.ts'), env);
    return seeded === 0 ? hardhat(join('scripts', 'read.ts'), env) : seeded;
  } finally {
    anvil.kill();
  }
}

function runSepolia() {
  const manifest = join(ROOT, 'deployments', 'manifest', 'deployments.json');
  const { chains } = JSON.parse(readFileSync(manifest, 'utf8'));
  if ((chains[String(SEPOLIA)]?.generations?.length ?? 0) === 0) {
    console.error(
      'The manifest has no Sepolia deployment yet, so there is nothing to read. ' +
        'Use "npm run read:local" for the same reads on a local Anvil.'
    );
    return 2;
  }
  install();
  console.log(`source: chain ${SEPOLIA}, from deployments/manifest/deployments.json`);
  return hardhat(join('scripts', 'read.ts'), {
    EXAMPLE_RPC_URL: process.env.EXAMPLE_RPC_URL ?? DEFAULT_SEPOLIA_URL,
    EXAMPLE_MANIFEST: manifest,
    EXAMPLE_CHAIN: String(SEPOLIA),
  });
}

if (isLocal) {
  install();
  process.exit(await runLocal());
}
process.exit(runSepolia());
