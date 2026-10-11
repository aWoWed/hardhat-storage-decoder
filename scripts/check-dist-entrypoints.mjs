#!/usr/bin/env node
/**
 * Load every built entrypoint — `.`, `./hardhat2`, `./hardhat3` — with a real `require` and a
 * real `import`, in child Node processes, through the package's own `exports` map.
 *
 * `publint` and `attw` only read files, and each e2e workspace loads one module format, so
 * without this nothing executes the other format of each adapter.
 *
 * Where the child processes run, and why:
 *   The freshly built `dist/` cannot be loaded in place. The Hardhat 2 adapter needs a package
 *   named `hardhat` (major 2) on its resolution path, and the project root holds only the
 *   `hardhat-v2`/`hardhat-v3` aliases (see `docs/build-internals.md`). The copy installed in
 *   `test/fixtures/hh2-project/node_modules` has the right neighbours but is whatever tarball
 *   the last e2e run installed, which may be older than `dist/`.
 *   So the current `package.json` and `dist/` are COPIED into a throw-away
 *   `node_modules/.cache/hardhat-storage-decoder-entrypoints/node_modules/hardhat-storage-decoder`
 *   and the child scripts are written next to it. From there the bare specifier
 *   `hardhat-storage-decoder/...` resolves to the fresh copy first (nearest `node_modules`), and
 *   the copy's own `hardhat/...` and `@noble/hashes` imports resolve one level further up:
 *     - `./hardhat2` is staged inside `test/fixtures/hh2-project/node_modules`, next to a real
 *       Hardhat 2. That workspace must have been installed (`npm install` in it, or one
 *       `npm run test:e2e:hh2`); the script says so and fails when it has not.
 *     - `.` and `./hardhat3` are staged inside the project root's `node_modules`. Neither
 *       imports Hardhat at runtime (the Hardhat 3 adapter uses `import type` only), so they need
 *       nothing but `@noble/hashes`. Whether the plugin works inside Hardhat 3 is the job of
 *       `npm run test:e2e:hh3`, not of this script.
 *   Both staging directories are removed when the script ends.
 *
 * What is asserted:
 *   - `.` throws `HardhatStorageDecoderEntrypointError` under `require` and under `import`.
 *   - `./hardhat2` without a Hardhat context fails with Hardhat's own HH5 in both formats (a
 *     Hardhat 2 plugin registers itself at load; HH5 means the module and Hardhat were found).
 *   - `./hardhat2` with a context (a `hardhat.config.cjs` that requires the plugin, then
 *     `hardhat` loaded first) loads in both formats, `hre.storageDecoder` is present, the ES
 *     module exposes exactly the named exports of the CommonJS build, and every exported
 *     function or class is the IDENTICAL object in both (one copy of the plugin).
 *   - `./hardhat3` loads in both formats with the same set of export names.
 *   - Both adapters export every name in `REQUIRED_EXPORTS` in both formats.
 *
 * Usage: node scripts/check-dist-entrypoints.mjs   (after `npm run build`)
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGE = 'hardhat-storage-decoder';
const HH2_WORKSPACE = join(ROOT, 'test', 'fixtures', 'hh2-project');

/** Names both adapters must export in both module formats. */
const REQUIRED_EXPORTS = [
  'AmbiguousVariableError',
  'StorageDecoderError',
  'StorageQueryBuilder',
  'extractConstantAndImmutableNames',
  'extractDeclaringContracts',
  'extractUserDefinedValueTypes',
  'parseStorageLayout',
];
const REQUIRED_HH2_EXPORTS = [...REQUIRED_EXPORTS, 'StorageLayoutNotAvailableError', 'createHardhatStorageDecoder'];
const REQUIRED_HH3_EXPORTS = [...REQUIRED_EXPORTS, 'MissingStorageLayoutError', 'default', 'storageDecoderPlugin'];

/** Shared by every child script: print one JSON line describing the outcome. */
const REPORT = `
function describe(error) {
  return {
    ok: false,
    name: error && error.name,
    code: error && error.code,
    number: error && error.number,
    message: String((error && error.message) || error).split('\\n')[0],
  };
}
function report(outcome) {
  console.log('RESULT ' + JSON.stringify(outcome));
}
`;

/** Child scripts, by file name. Each takes the specifier to load as its first argument. */
const CHILD_SCRIPTS = {
  'require.cjs': `${REPORT}
try {
  report({ ok: true, keys: Object.keys(require(process.argv[2])).sort() });
} catch (error) {
  report(describe(error));
}
`,
  'import.mjs': `${REPORT}
try {
  report({ ok: true, keys: Object.keys(await import(process.argv[2])).sort() });
} catch (error) {
  report(describe(error));
}
`,
  'require-with-context.cjs': `${REPORT}
try {
  const hre = require('hardhat');
  const loaded = require(process.argv[2]);
  report({
    ok: true,
    keys: Object.keys(loaded).sort(),
    decoder: typeof hre.storageDecoder.contract,
  });
} catch (error) {
  report(describe(error));
}
`,
  'import-with-context.mjs': `import { createRequire } from 'node:module';
${REPORT}
try {
  const { default: hre } = await import('hardhat');
  const imported = await import(process.argv[2]);
  const required = createRequire(import.meta.url)(process.argv[2]);
  report({
    ok: true,
    keys: Object.keys(imported).sort(),
    requiredKeys: Object.keys(required).sort(),
    notIdentical: Object.keys(required).filter((key) => imported[key] !== required[key]).sort(),
    decoder: typeof hre.storageDecoder.contract,
  });
} catch (error) {
  report(describe(error));
}
`,
};

/** The Hardhat 2 project the context checks run in: it registers the plugin the documented way. */
const HH2_CONFIG = `require('${PACKAGE}/hardhat2');
module.exports = { solidity: '0.8.26' };
`;

/**
 * Copy the current package into `<base>/node_modules/.cache/...` and write the child scripts.
 * Returns the staging directory.
 */
function stage(base) {
  const stageDir = join(base, 'node_modules', '.cache', `${PACKAGE}-entrypoints`);
  const packageDir = join(stageDir, 'node_modules', PACKAGE);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(packageDir, { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(packageDir, 'package.json'));
  cpSync(join(ROOT, 'dist'), join(packageDir, 'dist'), { recursive: true });
  for (const [name, source] of Object.entries(CHILD_SCRIPTS)) {
    writeFileSync(join(stageDir, name), source);
  }
  return stageDir;
}

/**
 * Run one child script against one specifier and return the outcome it printed.
 * `hardhatConfig`, when given, is the config file the child's Hardhat must load.
 */
function load(stageDir, script, specifier, hardhatConfig) {
  // The caller's own `HARDHAT_CONFIG` must never leak into a child.
  const { HARDHAT_CONFIG: _ignored, ...env } = process.env;
  if (hardhatConfig !== undefined) env.HARDHAT_CONFIG = hardhatConfig;
  const child = spawnSync(process.execPath, [join(stageDir, script), specifier], {
    cwd: stageDir,
    encoding: 'utf8',
    env,
  });
  const line = child.stdout.split('\n').find((text) => text.startsWith('RESULT '));
  if (line === undefined) {
    return { ok: false, name: 'NoResult', message: (child.stderr || child.stdout).trim().split('\n').pop() };
  }
  return JSON.parse(line.slice('RESULT '.length));
}

/** One line for a failed load, for the problem list. */
function failure(outcome) {
  return `threw [${outcome.name}/${outcome.code ?? outcome.number ?? '-'}] ${outcome.message}`;
}

function expectEntrypointError(outcome) {
  if (outcome.ok) return ['loaded, but the root entry must throw'];
  if (outcome.name !== 'HardhatStorageDecoderEntrypointError') return [failure(outcome)];
  return [];
}

function expectHH5(outcome) {
  if (outcome.ok) return ['loaded without a Hardhat context; expected HH5'];
  if (outcome.number !== 5) return [`expected Hardhat's HH5, but it ${failure(outcome)}`];
  return [];
}

function expectExports(outcome, required) {
  if (!outcome.ok) return [failure(outcome)];
  const problems = required
    .filter((name) => !outcome.keys.includes(name))
    .map((name) => `${name} is not exported`);
  if (outcome.decoder !== undefined && outcome.decoder !== 'function') {
    problems.push(`hre.storageDecoder.contract is ${outcome.decoder}, expected function`);
  }
  return problems;
}

/** Names present in one list and not the other, as problems. */
function expectSameKeys(importKeys, requireKeys) {
  const problems = [];
  for (const name of requireKeys) {
    if (!importKeys.includes(name)) problems.push(`${name} is exported by require but not by import`);
  }
  for (const name of importKeys) {
    if (!requireKeys.includes(name)) problems.push(`${name} is exported by import but not by require`);
  }
  return problems;
}

if (!existsSync(join(ROOT, 'dist', 'hardhat2', 'index.cjs'))) {
  console.error('dist/ is missing or incomplete. Run `npm run build` first.');
  process.exit(1);
}
if (!existsSync(join(HH2_WORKSPACE, 'node_modules', 'hardhat', 'package.json'))) {
  console.error(
    `Hardhat 2 is not installed in ${HH2_WORKSPACE}.\n` +
      'The ./hardhat2 entrypoint can only be loaded next to a real Hardhat 2: run `npm install` ' +
      'in that directory (or `npm run test:e2e:hh2` once) and try again.'
  );
  process.exit(1);
}

const results = [];
const check = (label, problems) => results.push({ label, problems });
const stages = [];

try {
  const rootStage = stage(ROOT);
  stages.push(rootStage);
  const hh2Stage = stage(HH2_WORKSPACE);
  stages.push(hh2Stage);
  // Named explicitly through `HARDHAT_CONFIG`: Hardhat 2 looks for a `hardhat.config.ts` in
  // every parent directory before it considers a `.cjs` one, so from the staging directory it
  // would otherwise load the workspace's own config and, with it, the stale installed plugin.
  const hh2Config = join(hh2Stage, 'hardhat.config.cjs');
  writeFileSync(hh2Config, HH2_CONFIG);

  check('. (require)', expectEntrypointError(load(rootStage, 'require.cjs', PACKAGE)));
  check('. (import)', expectEntrypointError(load(rootStage, 'import.mjs', PACKAGE)));

  const hh3 = `${PACKAGE}/hardhat3`;
  const hh3Required = load(rootStage, 'require.cjs', hh3);
  const hh3Imported = load(rootStage, 'import.mjs', hh3);
  check('./hardhat3 (require)', expectExports(hh3Required, REQUIRED_HH3_EXPORTS));
  check('./hardhat3 (import)', expectExports(hh3Imported, REQUIRED_HH3_EXPORTS));
  if (hh3Required.ok && hh3Imported.ok) {
    check('./hardhat3 (same exports in both)', expectSameKeys(hh3Imported.keys, hh3Required.keys));
  }

  const hh2 = `${PACKAGE}/hardhat2`;
  // Nothing in these two children loads `hardhat` first, so no context exists when the plugin
  // registers.
  check('./hardhat2 (require, no Hardhat context)', expectHH5(load(hh2Stage, 'require.cjs', hh2)));
  check('./hardhat2 (import, no Hardhat context)', expectHH5(load(hh2Stage, 'import.mjs', hh2)));

  const hh2Required = load(hh2Stage, 'require-with-context.cjs', hh2, hh2Config);
  const hh2Imported = load(hh2Stage, 'import-with-context.mjs', hh2, hh2Config);
  check('./hardhat2 (require, Hardhat context)', expectExports(hh2Required, REQUIRED_HH2_EXPORTS));
  check('./hardhat2 (import, Hardhat context)', expectExports(hh2Imported, REQUIRED_HH2_EXPORTS));
  if (hh2Imported.ok) {
    check(
      './hardhat2 (same exports in both)',
      expectSameKeys(hh2Imported.keys, hh2Imported.requiredKeys)
    );
    check(
      './hardhat2 (one plugin copy)',
      hh2Imported.notIdentical.map((name) => `${name} is a different object under import and require`)
    );
  }
} finally {
  for (const stageDir of stages) rmSync(stageDir, { recursive: true, force: true });
}

let failed = false;
for (const { label, problems } of results) {
  if (problems.length === 0) {
    console.log(`ok    ${label}`);
  } else {
    failed = true;
    console.log(`FAIL  ${label}`);
    for (const problem of problems) console.log(`        ${problem}`);
  }
}
console.log(failed ? '\nentrypoints do NOT all load' : '\nentrypoints OK');
process.exit(failed ? 1 : 0);
