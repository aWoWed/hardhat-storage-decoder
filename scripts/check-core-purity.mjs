#!/usr/bin/env node
/**
 * Runnable gate for the core invariant: `src/core/**` must not import `hardhat`.
 *
 * This is the whole reason the same derivation engine can back two mutually-incompatible
 * Hardhat majors, so it is a check rather than a comment. Exits non-zero on any violation.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORE_DIR = join(ROOT, 'src', 'core');

// Matches `import ... from "hardhat..."`, `import "hardhat..."`, `require("hardhat...")`,
// and dynamic `import("hardhat...")`.
const FORBIDDEN =
  /(?:^|[^\w$])(?:import\s*\(|require\s*\(|from\s+|import\s+)\s*['"](hardhat(?:\/[^'"]*)?)['"]/gm;

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) yield full;
  }
}

const violations = [];
let scanned = 0;

for await (const file of walk(CORE_DIR)) {
  scanned += 1;
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(FORBIDDEN)) {
    const line = source.slice(0, match.index).split('\n').length;
    violations.push(`${relative(ROOT, file)}:${line}  imports "${match[1]}"`);
  }
}

if (violations.length > 0) {
  console.error('src/core/** must stay Hardhat-free, but found:');
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(
    '\nMove anything that needs Hardhat into src/hardhat2/ or src/hardhat3/ and inject it' +
      ' through StorageDecoderContext instead.'
  );
  process.exit(1);
}

console.log(`core purity OK — ${scanned} file(s) in src/core/, zero hardhat imports`);
