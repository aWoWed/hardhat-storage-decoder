/**
 * Compares a project's installed tree with its tracked lockfile, by version and integrity. The
 * plugin is the one allowed exception: it is built locally and installed on top, see
 * `scripts/prepare-deployment-projects.mjs`. What it brings under its own folder goes with it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PLUGIN = 'node_modules/hardhat-storage-decoder';

/**
 * @param {string} project - The folder holding `package-lock.json` and `node_modules`.
 * @returns {string[]} One line per difference; empty when the tree is what the lock says.
 */
export function lockDrift(project) {
  const installedPath = join(project, 'node_modules', '.package-lock.json');
  if (!existsSync(installedPath)) return ['nothing is installed'];
  const { packages: locked } = JSON.parse(readFileSync(join(project, 'package-lock.json'), 'utf8'));
  const { packages: installed } = JSON.parse(readFileSync(installedPath, 'utf8'));

  const drift = [];
  for (const [path, entry] of Object.entries(installed)) {
    if (path === PLUGIN || path.startsWith(`${PLUGIN}/`)) continue;
    const wanted = locked[path];
    if (wanted === undefined) drift.push(`${path} is installed, but not in the lockfile`);
    else if (wanted.version !== entry.version || wanted.integrity !== entry.integrity) {
      drift.push(`${path} is ${entry.version}, but the lockfile says ${wanted.version}`);
    }
  }
  for (const [path, entry] of Object.entries(locked)) {
    // Only this platform's optional packages are installed.
    if (path !== '' && entry.optional !== true && installed[path] === undefined) {
      drift.push(`${path} is in the lockfile, but not installed`);
    }
  }
  return drift;
}
