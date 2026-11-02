#!/usr/bin/env node
/**
 * Runnable gate for the public deployment manifest: only known fields may appear in it, so a
 * signed transaction, an endpoint URL or anything else meant for the ignored `local/` folder
 * cannot be committed by accident. Exits non-zero on any violation, and passes when the
 * manifest does not exist yet.
 *
 * Takes an optional path, which the tests use for planted manifests.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { holdsHexWord } from './hex-word.mjs';

const MANIFEST = fileURLToPath(new URL('../deployments/manifest/deployments.json', import.meta.url));

// The only fields a manifest may hold.
const KNOWN_FIELDS = new Set([
  'schemaVersion',
  'chains',
  'generations',
  'contracts',
  'address',
  'deployBlock',
  'txHash',
  'signedTxHash',
  'sealBlock',
  'sealTxHash',
  'repoCommit',
  'sourceHash',
  'solcSettings',
  'expected',
  'value',
  'blockTag',
  'requiresArchive',
  'observed',
  'block',
  'endpointLabel',
  // Resuming needs each confirmed step, and `op` holds a code position.
  'deployer',
  'steps',
  'id',
  'nonce',
  'blockHash',
  'buildDependent',
]);
// Below these the keys are names chosen by the data (chain IDs, contracts, variables).
const NAME_KEYED = new Set(['chains', 'contracts', 'expected']);
// Compiler settings are free-form and are public by nature.
const OPAQUE = new Set(['solcSettings']);
// A data-chosen name is still public text: it can hold a key as easily as a value can.
const HEX_NAME = /(?<![0-9a-zA-Z])(?:0[xX])?[0-9a-fA-F]{64}(?![0-9a-zA-Z])/;

function walk(value, path, parentField, violations) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => walk(child, [...path, String(index)], parentField, violations));
    return;
  }
  if (typeof value === 'string') {
    if (/:\/\//.test(value)) violations.push(`${path.join('.')}  holds a URL`);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    // Not printed: the name is the value here.
    if (holdsHexWord(key, parentField === 'expected', HEX_NAME)) {
      violations.push(`${path.join('.')}  has a 64-hex field name`);
      continue;
    }
    const childPath = [...path, key];
    if (NAME_KEYED.has(parentField)) {
      walk(child, childPath, undefined, violations);
    } else if (!KNOWN_FIELDS.has(key)) {
      violations.push(`${childPath.join('.')}  is not a known manifest field`);
    } else if (!OPAQUE.has(key)) {
      walk(child, childPath, key, violations);
    }
  }
}

const target = process.argv[2] ?? MANIFEST;
let source;
try {
  source = readFileSync(target, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.log('manifest check OK — no manifest yet');
  process.exit(0);
}

let manifest;
try {
  manifest = JSON.parse(source);
} catch {
  console.error(`${target} is not valid JSON`);
  process.exit(1);
}

const violations = [];
walk(manifest, [], undefined, violations);
if (violations.length > 0) {
  console.error('the public manifest may hold known fields only, but found:');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log('manifest check OK — known fields only');
