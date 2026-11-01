#!/usr/bin/env node
/**
 * Submits every contract of a chain's current generation to Sourcify, then runs the same check as
 * `check-sourcify.mjs`. Needs no key and no RPC URL: Sourcify fetches the chain data itself.
 *
 *   node scripts/submit-sourcify.mjs --chain N [--manifest PATH] [--server URL] [--project PATH]
 *                                    [--poll-ms N] [--job-timeout-ms N]
 *
 * It sends the standard-JSON input from Hardhat 3's build-info unchanged, because the source names
 * in it (`project/contracts/...`) are part of the metadata hash in the deployed code. Renaming them
 * could only give a partial match. The Hardhat verify plugin would add a dependency to the signing
 * project for no gain here.
 *
 * Whether Sourcify accepts this build is not proven until the real submission at gate G2: the tests
 * use a fake server.
 *
 * Exit codes are those of `check-sourcify.mjs`. A job Sourcify rejected is exit 1.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ROOT, VERIFIED, checkGeneration, parseCommon, request } from './check-sourcify.mjs';
import { CouldNotCheck } from './fetch-json.mjs';

const TOP_LEVEL_INPUT = ['language', 'sources', 'settings'];

const { values, generation, server, usage } = parseCommon(
  'node scripts/submit-sourcify.mjs --chain N [--manifest PATH] [--server URL] [--project PATH] ' +
    '[--poll-ms N] [--job-timeout-ms N]',
  {
    project: { type: 'string', default: join(ROOT, 'deployments', 'hh3') },
    'poll-ms': { type: 'string', default: '3000' },
    'job-timeout-ms': { type: 'string', default: '300000' },
  }
);
for (const name of ['poll-ms', 'job-timeout-ms']) {
  if (!/^\d+$/.test(values[name])) usage(`--${name} must be a whole number`);
}
const retryDelayMs = Number(values['retry-delay-ms']);
const chainId = values.chain;

/** The request for one contract, from the artifact and the build-info it names. */
function payloadFor(name, txHash) {
  const artifactPath = join(values.project, 'artifacts', 'contracts', `${name}.sol`, `${name}.json`);
  if (!existsSync(artifactPath)) usage(`no artifact at ${artifactPath}: compile ${values.project} first`);
  const { buildInfoId, inputSourceName } = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const buildInfoPath = join(values.project, 'artifacts', 'build-info', `${buildInfoId}.json`);
  if (!existsSync(buildInfoPath)) usage(`no build-info at ${buildInfoPath}: compile ${values.project} first`);
  const { input, solcLongVersion } = JSON.parse(readFileSync(buildInfoPath, 'utf8'));

  const recorded = generation.solcSettings;
  if (recorded?.evmVersion !== undefined && input.settings.evmVersion !== recorded.evmVersion) {
    usage(`${name}: the build uses evmVersion ${input.settings.evmVersion}, the manifest says ${recorded.evmVersion}`);
  }
  if (recorded?.version !== undefined && !solcLongVersion.startsWith(recorded.version)) {
    usage(`${name}: the build uses solc ${solcLongVersion}, the manifest says ${recorded.version}`);
  }
  return {
    stdJsonInput: Object.fromEntries(TOP_LEVEL_INPUT.map((key) => [key, input[key]])),
    compilerVersion: solcLongVersion,
    contractIdentifier: `${inputSourceName}:${name}`,
    creationTransactionHash: txHash.toLowerCase(),
  };
}

/** @returns {Promise<string | undefined>} why the job failed, if it did. */
async function waitForJob(verificationId) {
  const deadline = Date.now() + Number(values['job-timeout-ms']);
  for (;;) {
    const { status, body } = await request(`${server}/v2/verify/${verificationId}`, {}, retryDelayMs);
    if (status !== 200) throw new CouldNotCheck(`job ${verificationId}: HTTP ${status}`);
    if (body?.isJobCompleted === true) {
      if (VERIFIED.has(body.contract?.match)) return undefined;
      // Only these two fields: the rest of an error can hold whole bytecode blobs.
      return `${body.error?.customCode ?? 'no match'}: ${body.error?.message ?? 'no message'}`;
    }
    if (Date.now() > deadline) throw new CouldNotCheck(`job ${verificationId} did not finish in time`);
    await sleep(Number(values['poll-ms']));
  }
}

async function submit(name, { address, txHash }) {
  const { status, body } = await request(
    `${server}/v2/verify/${chainId}/${address}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payloadFor(name, txHash)),
    },
    retryDelayMs
  );
  if (status === 409) return 'already verified';
  if (status !== 202 || typeof body?.verificationId !== 'string') {
    return { rejected: `HTTP ${status}: ${body?.customCode ?? ''} ${body?.message ?? ''}`.trim() };
  }
  const failure = await waitForJob(body.verificationId);
  return failure === undefined ? 'submitted' : { rejected: failure };
}

let rejected = 0;
let unknown = 0;
for (const [name, record] of Object.entries(generation.contracts)) {
  try {
    const outcome = await submit(name, record);
    if (typeof outcome === 'string') {
      console.log(`${outcome} ${name} ${record.address}`);
    } else {
      rejected += 1;
      console.log(`REJECTED ${name} ${record.address}: ${outcome.rejected}`);
    }
  } catch (error) {
    if (!(error instanceof CouldNotCheck) && !(error instanceof TypeError)) throw error;
    unknown += 1;
    console.log(`could-not-submit ${name} ${record.address}: ${error.message}`);
  }
}

console.log('checking what Sourcify now holds');
const checked = await checkGeneration(server, chainId, generation, retryDelayMs);
process.exitCode = rejected > 0 || checked === 1 ? 1 : unknown > 0 ? 3 : checked;
