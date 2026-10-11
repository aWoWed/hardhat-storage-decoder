/**
 * Copy the fixtures both Hardhat workspaces share into the one this is run from:
 *   - the Solidity contracts, from `./contracts` into `<workspace>/contracts/`
 *   - the e2e suites, from `./e2e` into `<workspace>/test/e2e/shared/`
 *
 * Run from a workspace directory (its `pretest` does): `node ../copy-fixtures.mjs`.
 *
 * Copies, not symlinks: this repo is developed on Windows, where creating a symlink needs
 * elevated rights, and Node resolves a symlinked file from its real path — which would send
 * the suites' imports looking for `hardhat` outside the workspace.
 *
 * Both targets are generated. Edit the originals; anything changed in a copy is overwritten.
 *
 * `--strip-js-extensions`: the suites are written with `.js` import specifiers, as the ESM
 * Hardhat 3 workspace needs. The Hardhat 2 workspace runs them as CommonJS through ts-node,
 * which resolves a relative import only without the extension, so it is dropped on the way in.
 */

import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('.', import.meta.url));
const WORKSPACE = process.cwd();
const stripJsExtensions = process.argv.includes('--strip-js-extensions');

/** Empty `target`, then fill it with the files of `source` ending in `suffix`. */
async function mirror(source, target, suffix, copyOne) {
  // Removed first so a fixture deleted upstream does not linger here and keep running.
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const names = (await readdir(source)).filter((name) => name.endsWith(suffix)).sort();
  if (names.length === 0) {
    console.error(`no ${suffix} fixtures found in ${source}`);
    process.exit(1);
  }
  for (const name of names) await copyOne(join(source, name), join(target, name));
  console.log(`copied ${names.length} ${suffix} fixture(s) into ${target}`);
}

await mirror(join(FIXTURES, 'contracts'), join(WORKSPACE, 'contracts'), '.sol', (from, to) =>
  cp(from, to)
);

await mirror(
  join(FIXTURES, 'e2e'),
  join(WORKSPACE, 'test', 'e2e', 'shared'),
  '.test.ts',
  async (from, to) => {
    const source = await readFile(from, 'utf8');
    await writeFile(
      to,
      stripJsExtensions ? source.replace(/(from '\.{1,2}\/[^']+)\.js'/g, "$1'") : source,
      'utf8'
    );
  }
);
