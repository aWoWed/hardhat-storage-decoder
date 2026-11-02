#!/usr/bin/env node
/**
 * Do the version files and the docs agree with what was built?
 *
 *   node scripts/check-release-consistency.mjs <expected version>
 *
 * Exit codes: 0 consistent, 1 something does not match, 2 usage.
 *
 * The docs may not name the package's current version, because the commit that bumps it changes
 * `package.json` and `package-lock.json` and nothing else. So one docs tree has to pass for the
 * version before the bump and the version after it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RELEASE_VERSION = '1.0.0';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LIMITER = 'src/core/query/limiter.ts';
const DOCS = ['README.md', 'USAGE.md', 'REMAINING.md', 'docs/public-testnet.md'];
const REQUIRED_DOCS = ['README.md', 'USAGE.md', 'REMAINING.md'];
const REQUIRED_TERMS = {
  'USAGE.md': ['PrunedStateError', 'classifyReadFailure', 'maxConcurrentReads'],
  'REMAINING.md': ['PrunedStateError', 'classifyReadFailure', 'maxConcurrentReads', 'isSealed', 'BENCH_BASELINE'],
};

function versionFindings(expected, read) {
  const findings = [];
  const compare = (file, label, found) => {
    if (found !== expected) findings.push({ file, found: found ?? null, message: `${label} reads ${found}, expected ${expected}` });
  };
  const parse = (file) => {
    try {
      return JSON.parse(read(file) ?? '{}');
    } catch {
      return {};
    }
  };
  const manifest = parse('package.json');
  const lock = parse('package-lock.json');
  compare('package.json', 'package.json version', manifest.version);
  compare('package-lock.json', 'package-lock.json version', lock.version);
  compare('package-lock.json', 'package-lock.json root package version', lock.packages?.['']?.version);
  return findings;
}

function docsFindings(read) {
  const findings = [];
  const present = DOCS.flatMap((file) => {
    const text = read(file);
    return text === undefined ? [] : [{ file, text }];
  });
  for (const file of REQUIRED_DOCS) {
    if (read(file) === undefined) findings.push(`${file} is missing`);
  }

  for (const [file, terms] of Object.entries(REQUIRED_TERMS)) {
    const text = read(file) ?? '';
    for (const term of terms) {
      if (!text.includes(term)) findings.push(`${file} does not mention ${term}`);
    }
  }

  const concurrency = /DEFAULT_MAX_CONCURRENT_READS\s*=\s*(\d+)/.exec(read(LIMITER) ?? '')?.[1];
  if (concurrency === undefined) {
    findings.push(`${LIMITER} no longer states the default concurrency`);
  } else {
    const near = new RegExp(
      `\\b${concurrency}\\b[^]{0,120}(?:in flight|concurren)|(?:in flight|concurren)[^]{0,120}\\b${concurrency}\\b`,
      'i'
    );
    for (const file of ['USAGE.md', 'REMAINING.md']) {
      if (!near.test(read(file) ?? '')) findings.push(`${file} does not state the default concurrency of ${concurrency}`);
    }
  }
  const scripts = JSON.parse(read('package.json') ?? '{}').scripts ?? {};

  for (const { file, text } of present) {
    for (const [, pinned] of text.matchAll(/hardhat-storage-decoder@(\d+\.\d+\.\d+)/g)) {
      findings.push(`${file} pins the package at ${pinned}; docs must not name the current version`);
    }
    for (const [, script] of text.matchAll(/npm run ([\w:.-]*[\w])/g)) {
      if (scripts[script] === undefined) findings.push(`${file} names npm run ${script}, which package.json does not have`);
    }
  }
  return [...new Set(findings)];
}

/**
 * @param {string} expected
 * @param {(file: string) => string | undefined} read - A file's text, by path from the repo root.
 * @returns {{ version: Array<{ file: string, found: string | null, message: string }>, docs: string[] }}
 */
export function checkConsistency(expected, read) {
  return { version: versionFindings(expected, read), docs: docsFindings(read) };
}

function main() {
  const expected = process.argv[2];
  if (process.argv.length !== 3 || !/^\d+\.\d+\.\d+$/.test(expected)) {
    console.error('usage: node scripts/check-release-consistency.mjs <expected version>');
    process.exit(2);
  }
  const read = (file) => {
    const path = join(ROOT, file);
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  };
  const { version, docs } = checkConsistency(expected, read);
  for (const { message } of version) {
    console.error(`outstanding: ${message}${expected === RELEASE_VERSION ? ' (the bump is Step 13b)' : ''}`);
  }
  for (const finding of docs) console.error(`docs: ${finding}`);
  if (version.length > 0 || docs.length > 0) process.exit(1);
  console.log(`consistent at ${expected}`);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) main();
