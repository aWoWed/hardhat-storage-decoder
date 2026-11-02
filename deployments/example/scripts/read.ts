/**
 * Runs the read examples of `docs/public-testnet.md`, taken from the page itself, so a snippet that
 * stops working fails here. Each `<!-- read-example: Name -->` block is plain JavaScript, and they
 * run in page order in one scope. A line can end in a claim that this script checks:
 *
 *   await chain.read(); // value: 102n
 *   await chain.read(); // value: 33n; deployed: manifest MockValueTypes.revision
 *   await chain.read(); // rejects: VariableNotFoundError
 *
 * The middle form is explained in `expected-value.mjs`.
 *
 * Exit codes are described in `run.mjs`. A pruned read of a past block does not fail the run,
 * since a keyless node may not hold it; it is reported as `needs-archive`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import hre from 'hardhat';
import { classifyReadFailure } from 'hardhat-storage-decoder/hardhat3';
import { makeRedactor } from '../../../scripts/redact.mjs';
import { expectedValue, parseValueLine } from './expected-value.mjs';

const redact = makeRedactor([process.env.EXAMPLE_RPC_URL]);

const PAGE = join(hre.config.paths.root, '..', '..', 'docs', 'public-testnet.md');
const BLOCK = /<!-- read-example: (\w+) -->\r?\n```js\r?\n([\s\S]*?)```/g;
const REJECT_LINE = /^await (.+\.read\(\)); \/\/ rejects: (\w+)$/;

interface Tally {
  pass: number;
  wrong: number;
  couldNotCheck: number;
  needsArchive: number;
}

const tally: Tally = { pass: 0, wrong: 0, couldNotCheck: 0, needsArchive: 0 };

function show(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return `'${value}'`;
  return String(value);
}

function failure(label: string, error: unknown, historic: boolean): void {
  const message = redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  const kind = classifyReadFailure(error);
  if (kind === 'wrong-data') {
    tally.wrong += 1;
    console.log(`  WRONG ${label}: ${message}`);
  } else if (kind === 'pruned' && historic) {
    tally.needsArchive += 1;
    console.log(`  needs-archive ${label}`);
  } else {
    tally.couldNotCheck += 1;
    console.log(`  could-not-check ${label}: ${message}`);
  }
}

type Read = () => Promise<{ value: unknown }>;

async function checkValue(label: string, read: Read, expected: string): Promise<void> {
  try {
    const shown = show((await read()).value);
    if (shown === expected) {
      tally.pass += 1;
      console.log(`  ok ${label} = ${shown.length > 60 ? `${shown.slice(0, 57)}...` : shown}`);
    } else {
      tally.wrong += 1;
      console.log(`  WRONG ${label}: got ${shown}, the page says ${expected}`);
    }
  } catch (error) {
    failure(label, error, label.includes('.at('));
  }
}

async function checkRejects(label: string, read: Read, name: string): Promise<void> {
  try {
    await read();
    tally.wrong += 1;
    console.log(`  WRONG ${label}: read succeeded, the page says it rejects with ${name}`);
  } catch (error) {
    if ((error as Error).name === name) {
      tally.pass += 1;
      console.log(`  ok ${label} rejects with ${name}`);
    } else {
      failure(label, error, false);
    }
  }
}

/** Turn a page block into code, with each `.read()` going through a check. */
function compile(name: string, source: string, chainId: string, manifest: unknown): string {
  const out = [`console.log(${JSON.stringify(name)});`];
  for (const line of source.split(/\r?\n/)) {
    const value = parseValueLine(line);
    const rejected = REJECT_LINE.exec(line);
    if (value !== undefined) {
      const { expression } = value;
      const expected = expectedValue(value, chainId, manifest);
      out.push(`await checkValue(${JSON.stringify(expression)}, () => ${expression}, ${JSON.stringify(expected)});`);
    } else if (rejected !== null) {
      const [, expression, error] = rejected as unknown as [string, string, string];
      out.push(`await checkRejects(${JSON.stringify(expression)}, () => ${expression}, ${JSON.stringify(error)});`);
    } else if (line.includes('.read()')) {
      throw new Error(`${name}: this line reads without stating a result: ${line}`);
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

async function main(): Promise<void> {
  const chainId = process.env.EXAMPLE_CHAIN as string;
  const manifest = JSON.parse(readFileSync(process.env.EXAMPLE_MANIFEST as string, 'utf8')) as unknown;
  const page = readFileSync(PAGE, 'utf8');
  const blocks = [...page.matchAll(BLOCK)];
  if (blocks.length === 0) throw new Error('no read examples found in docs/public-testnet.md');

  const AsyncFunction = (async () => {}).constructor as new (...text: string[]) => (...args: unknown[]) => Promise<void>;
  const body = blocks
    .map(([, name, source]) => compile(name as string, source as string, chainId, manifest))
    .join('\n');
  // The page is this repository's own file, and it is what these reads exist to test.
  await new AsyncFunction('hre', 'manifest', 'chainId', 'checkValue', 'checkRejects', body)(
    hre,
    manifest,
    chainId,
    checkValue,
    checkRejects
  );

  console.log(
    `result on chain ${chainId}: ${blocks.length} blocks, pass ${tally.pass}, wrong ${tally.wrong}, ` +
      `could-not-check ${tally.couldNotCheck}, needs-archive ${tally.needsArchive}`
  );
  if (tally.wrong > 0) process.exitCode = 1;
  else if (tally.couldNotCheck > 0) process.exitCode = 3;
}

main().catch((error: unknown) => {
  console.error(`read failed: ${redact(error instanceof Error ? error.message : String(error))}`);
  process.exitCode = 1;
});
