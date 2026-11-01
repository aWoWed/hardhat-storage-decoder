/**
 * The refusals of `seed.ts` and `seal.ts`, which apply to every network but the local one.
 *
 * All of them run before the deployer key is read. They do not all run before a keystore prompt:
 * if the endpoint is in the keystore, resolving it prompts. The network, environment, source copy,
 * working tree and lockfile refusals come first; the chain ID and binding need the endpoint or
 * come after it, so they follow that prompt.
 *
 * These prevent accidents. They do not stop someone who edits this file, which is why the owner
 * reviews the commit and signs from their own terminal.
 */

import { spawnSync } from 'node:child_process';
import { LOCAL_CHAIN_ID } from '../../shared/manifest.js';

/** The networks these scripts run on, and the chain each must be. */
const NETWORK_CHAINS: Readonly<Record<string, number>> = {
  anvil: LOCAL_CHAIN_ID,
  sepolia: 11155111,
};

export const KEY_ENV_VAR = 'SEPOLIA_DEPLOYER_KEY';

/** Only for the local chain: the runtime key across a kill, the test's folder, and kill points. */
const LOCAL_ONLY_ENV_VARS = ['SEED_LOCAL_KEY', 'SEED_MANIFEST_DIR', 'SEED_TEST_KILL'];

/** The one tracked file a partial seed changes. The pending file is ignored, so never listed. */
const MANIFEST_PATH = 'deployments/manifest/deployments.json';

export class Refusal extends Error {}

export function refuseNetwork(networkName: string): void {
  if (NETWORK_CHAINS[networkName] === undefined) {
    throw new Refusal(
      `network "${networkName}" is not one these scripts run on: use --network ` +
        Object.keys(NETWORK_CHAINS).join(' or --network ')
    );
  }
}

/**
 * Hardhat 3 reads an environment variable before the keystore, and it treats an empty one as set,
 * so a password prompt would say nothing about who holds the key. Checks presence, never reads
 * the value.
 */
export function refuseEnvironment(networkName: string, env: NodeJS.ProcessEnv): void {
  if (networkName === 'anvil') return;
  if (env[KEY_ENV_VAR] !== undefined) {
    throw new Refusal(
      `${KEY_ENV_VAR} is set in the environment, and Hardhat 3 would use it instead of the ` +
        `keystore. Unset it and run again. The key belongs in the keystore.`
    );
  }
  for (const name of LOCAL_ONLY_ENV_VARS) {
    if (env[name] !== undefined) {
      throw new Refusal(`${name} is for the local chain only. Unset it and run again.`);
    }
  }
}

export function refuseChain(networkName: string, chainId: number): void {
  const expected = NETWORK_CHAINS[networkName];
  if (chainId !== expected) {
    throw new Refusal(
      `chain ID mismatch: network "${networkName}" must be chain ${expected}, but its endpoint ` +
        `reports chain ${chainId}`
    );
  }
}

/** Paths that block a run, from `git status --porcelain -z`, which ignored files never enter. */
export function dirtyPaths(repoRoot: string): string[] {
  const result = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  if (result.status !== 0) throw new Refusal(`cannot read the working tree: ${result.stderr}`);

  const paths: string[] = [];
  const fields = result.stdout.split('\0').filter(Boolean);
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i] as string;
    paths.push(field.slice(3));
    // A rename or a copy is followed by its original path, as a field of its own.
    if (/^[RC]|^.[RC]/.test(field)) {
      i += 1;
      paths.push(fields[i] as string);
    }
  }
  return paths.filter((path) => path !== MANIFEST_PATH);
}

export function refuseDirtyTree(repoRoot: string): void {
  const dirty = dirtyPaths(repoRoot);
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 10).map((path) => `  ${path}`);
    throw new Refusal(
      `the working tree has changes other than the manifest (${dirty.length}):\n` +
        shown.join('\n')
    );
  }
}

/** A resume or a seal must run the sources the deployment was made from. */
export function refuseBinding(recorded: string | undefined, current: string): void {
  if (recorded !== undefined && recorded !== current) {
    throw new Refusal(
      'bytecode binding mismatch: deployments/contracts or the solc settings changed since this ' +
        'deployment was made, so its code is not what is here now'
    );
  }
}

/** A signing run must use the dependencies the tracked lockfile fixes. */
export function refuseLockDrift(drift: readonly string[]): void {
  if (drift.length > 0) {
    throw new Refusal(
      'the installed packages differ from deployments/hh3/package-lock.json:\n' +
        drift.slice(0, 10).map((line) => `  ${line}`).join('\n') +
        '\nRun npm ci there, then install the plugin tarball with --no-save.'
    );
  }
}

export function refuseStaleCopies(inSync: boolean): void {
  if (!inSync) {
    throw new Refusal(
      'deployments/hh3/contracts differs from deployments/contracts. ' +
        'Run: node scripts/sync-deployment-contracts.mjs'
    );
  }
}
