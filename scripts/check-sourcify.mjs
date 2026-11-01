#!/usr/bin/env node
/**
 * Read-only: is every contract of a chain's current generation verified on Sourcify, as the
 * contract and with the compiler the manifest records? Needs no key and no RPC URL.
 *
 *   node scripts/check-sourcify.mjs --chain N [--manifest PATH] [--server URL]
 *
 * Exit codes:
 *   0  every contract is verified.
 *   1  a contract is not verified, or what is verified at its address differs from the manifest.
 *      This wins over exit 3.
 *   2  usage, or the manifest has nothing for that chain.
 *   3  could not check: the network or Sourcify failed, and nothing was found wrong.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CouldNotCheck, fetchJson } from './fetch-json.mjs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_SERVER = 'https://sourcify.dev/server';
const ATTEMPTS = 3;
export const VERIFIED = new Set(['match', 'exact_match']);

/** A request with a timeout and retries for what can pass, so one 429 does not end a check. */
export const request = (url, init = {}, retryDelayMs = 1000) => fetchJson(url, init, { attempts: ATTEMPTS, retryDelayMs });

/** @returns {{ pass: boolean, detail: string }} what Sourcify holds for one contract. */
async function checkContract(server, chainId, name, address, solcSettings, retryDelayMs) {
  const { status, body } = await request(
    `${server}/v2/contract/${chainId}/${address}?fields=compilation`,
    {},
    retryDelayMs
  );
  if (status === 404) return { pass: false, detail: 'not verified' };
  if (status !== 200 || body === undefined) throw new CouldNotCheck(`HTTP ${status}`);
  if (typeof body.match !== 'string' && body.match !== null) {
    throw new CouldNotCheck('the answer has no "match" field');
  }
  if (!VERIFIED.has(body.match)) return { pass: false, detail: `match is ${body.match}` };

  const problems = [];
  if (String(body.address).toLowerCase() !== address.toLowerCase()) {
    problems.push(`the answer is for ${body.address}`);
  }
  const { name: compiledName, compilerVersion, compilerSettings } = body.compilation ?? {};
  if (compiledName !== name) problems.push(`verified as ${compiledName}`);
  if (solcSettings?.version !== undefined && !String(compilerVersion).startsWith(solcSettings.version)) {
    problems.push(`compiled with ${compilerVersion}, the manifest says ${solcSettings.version}`);
  }
  // Absent for a build that left it to solc's default, so only a stated difference counts.
  if (
    solcSettings?.evmVersion !== undefined &&
    compilerSettings?.evmVersion !== undefined &&
    compilerSettings.evmVersion !== solcSettings.evmVersion
  ) {
    problems.push(`evmVersion ${compilerSettings.evmVersion}, the manifest says ${solcSettings.evmVersion}`);
  }
  if (problems.length > 0) return { pass: false, detail: problems.join('; ') };
  return {
    pass: true,
    detail: `${body.match} (creation ${body.creationMatch}, runtime ${body.runtimeMatch})`,
  };
}

/** The current generation of a chain, or a usage message. */
function loadGeneration(manifestPath, chainId) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { problem: `cannot read ${manifestPath}: ${error.message}` };
  }
  const generation = manifest.chains?.[String(chainId)]?.generations?.at(-1);
  if (generation === undefined || Object.keys(generation.contracts ?? {}).length === 0) {
    return { problem: `the manifest has nothing for chain ${chainId}, so there is nothing to check` };
  }
  return { generation };
}

/** Prints one line per contract and returns the exit code. */
export async function checkGeneration(server, chainId, generation, retryDelayMs) {
  let wrong = 0;
  let unknown = 0;
  for (const [name, { address }] of Object.entries(generation.contracts)) {
    try {
      const { pass, detail } = await checkContract(
        server, chainId, name, address, generation.solcSettings, retryDelayMs
      );
      console.log(`${pass ? 'verified' : 'WRONG'} ${name} ${address}: ${detail}`);
      if (!pass) wrong += 1;
    } catch (error) {
      if (!(error instanceof CouldNotCheck) && !(error instanceof TypeError)) throw error;
      console.log(`could-not-check ${name} ${address}: ${error.message}`);
      unknown += 1;
    }
  }
  const total = Object.keys(generation.contracts).length;
  const code = wrong > 0 ? 1 : unknown > 0 ? 3 : 0;
  console.log(
    `result: exit ${code}, ${total - wrong - unknown} of ${total} verified, ` +
      `${wrong} wrong, ${unknown} could not be checked`
  );
  return code;
}

/** A positive chain ID and the options both scripts share, or exit 2. */
export function parseCommon(usageText, extra = {}) {
  const usage = (message) => {
    console.error(`${message}\nusage: ${usageText}`);
    process.exit(2);
  };
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        chain: { type: 'string' },
        manifest: { type: 'string', default: join(ROOT, 'deployments', 'manifest', 'deployments.json') },
        server: { type: 'string', default: DEFAULT_SERVER },
        'retry-delay-ms': { type: 'string', default: '1000' },
        ...extra,
      },
    }));
  } catch (error) {
    usage(error.message);
  }
  if (values.chain === undefined || !/^[1-9]\d*$/.test(values.chain)) usage('--chain must be a chain ID');
  if (!/^\d+$/.test(values['retry-delay-ms'])) usage('--retry-delay-ms must be a whole number');
  const { generation, problem } = loadGeneration(values.manifest, values.chain);
  if (problem !== undefined) usage(problem);
  return { values, generation, server: values.server.replace(/\/$/, ''), usage };
}

async function main() {
  const { values, generation, server } = parseCommon(
    'node scripts/check-sourcify.mjs --chain N [--manifest PATH] [--server URL]'
  );
  process.exitCode = await checkGeneration(server, values.chain, generation, Number(values['retry-delay-ms']));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
