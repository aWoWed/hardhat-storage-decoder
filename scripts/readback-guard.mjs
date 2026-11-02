#!/usr/bin/env node
/**
 * Whether the public manifest holds no chain at all, which is the one state in which the scheduled
 * read-back has nothing to do: nothing has been deployed yet. Anything else goes on to
 * `readback.mjs`, so a chain gone missing from a manifest that has others still fails there.
 *
 *   node scripts/readback-guard.mjs [PATH]
 *
 * Prints `no_chains=true` or `no_chains=false`. A missing or unreadable manifest exits non-zero.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MANIFEST = fileURLToPath(new URL('../deployments/manifest/deployments.json', import.meta.url));

const { chains } = JSON.parse(readFileSync(process.argv[2] ?? MANIFEST, 'utf8'));
const empty = chains !== null && typeof chains === 'object' && !Array.isArray(chains) && Object.keys(chains).length === 0;
console.log(`no_chains=${empty}`);
