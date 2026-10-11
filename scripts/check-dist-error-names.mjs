#!/usr/bin/env node
/**
 * Check that every error class in the BUILT bundles reports its own class name.
 *
 * This guards a failure the source-level tests cannot see: a bundler may emit
 * `exports.X = class extends Base {}`, an anonymous class whose `name` is empty, so an error
 * that derives its name from the class would report `""` only in the published package.
 *
 * Every bundle that DEFINES the classes is checked, in one of two ways:
 *   - Hardhat 3 bundles (CommonJS and ES module) are loaded and each error is constructed and
 *     inspected.
 *   - The Hardhat 2 CommonJS bundle requires `hardhat/config` at load and cannot run outside a
 *     Hardhat process, so it is checked as text: each name must appear as a quoted string
 *     literal. (It is also asserted at runtime by the Hardhat 2 e2e suite.)
 *   `dist/hardhat2/index.mjs` is not checked here: it defines no class. It is a wrapper that
 *   re-exports the CommonJS bundle, and `scripts/check-dist-entrypoints.mjs` asserts that every
 *   export it has is the identical object.
 *
 * Both ways also fail when a bundle exports an error class that the tables below do not list,
 * so a class added to the package cannot go unchecked.
 *
 * Usage: node scripts/check-dist-error-names.mjs [--dist <dir>]
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const distFlag = args.indexOf('--dist');
const DIST = resolve(distFlag === -1 ? 'dist' : (args[distFlag + 1] ?? 'dist'));

/** Class name -> constructor arguments that are valid for it. */
const CORE_ERRORS = {
  StorageDecoderError: ['x'],
  ContractNotFoundError: ['a.sol:A'],
  ContractMismatchError: ['a.sol:A', '0x00', 'detail'],
  VariableNotFoundError: ['v'],
  AmbiguousVariableError: ['v', ['A', 'B']],
  PathSegmentCountMismatchError: ['v', 1, 'detail'],
  PathSegmentKindMismatchError: ['v', 0, 'detail'],
  IndexOutOfBoundsError: [1n, 0n, 'uint256[]'],
  UnsupportedTypeError: ['label', 't_id'],
  DumpTooLargeError: ['array', 2n, 1, 'path'],
  DumpInconsistentError: ['path', 1n, 2n],
};
const HH2_ERRORS = { ...CORE_ERRORS, StorageLayoutNotAvailableError: ['a.sol:A'] };
const HH3_ERRORS = { ...CORE_ERRORS, MissingStorageLayoutError: ['a.sol:A', 'detail'] };

function checkRuntime(label, moduleExports) {
  const problems = [];
  for (const [name, ctorArgs] of Object.entries(HH3_ERRORS)) {
    const ErrorClass = moduleExports[name];
    if (typeof ErrorClass !== 'function') {
      problems.push(`${name} is not exported`);
      continue;
    }
    const actual = new ErrorClass(...ctorArgs).name;
    if (actual !== name) problems.push(`${name} reports name ${JSON.stringify(actual)}`);
  }
  for (const [name, exported] of Object.entries(moduleExports)) {
    if (typeof exported !== 'function' || !(exported.prototype instanceof Error)) continue;
    if (!(name in HH3_ERRORS)) problems.push(`${name} is an exported error class this check does not list`);
  }
  return { label, problems };
}

function checkText(label, file) {
  const text = readFileSync(file, 'utf8');
  const problems = [];
  for (const name of Object.keys(HH2_ERRORS)) {
    if (!new RegExp(`["']${name}["']`).test(text)) {
      problems.push(`${name} does not appear as a string literal`);
    }
  }
  // Every error class in this package is named `...Error`; the export lines give the full list.
  for (const [, name] of text.matchAll(/^exports\.([A-Za-z_$][\w$]*Error) = /gm)) {
    if (!(name in HH2_ERRORS)) problems.push(`${name} is an exported error class this check does not list`);
  }
  return { label, problems };
}

const require = createRequire(import.meta.url);
const results = [
  checkRuntime('hardhat3/index.cjs (runtime)', require(join(DIST, 'hardhat3', 'index.cjs'))),
  checkRuntime(
    'hardhat3/index.mjs (runtime)',
    await import(pathToFileURL(join(DIST, 'hardhat3', 'index.mjs')).href)
  ),
  checkText('hardhat2/index.cjs (text)', join(DIST, 'hardhat2', 'index.cjs')),
];

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
console.log(failed ? `\nerror names are wrong in ${DIST}` : `\nerror names OK in ${DIST}`);
process.exit(failed ? 1 : 0);
