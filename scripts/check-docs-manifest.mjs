#!/usr/bin/env node
/**
 * Keeps `docs/public-testnet.md` true to the manifest, with its safety statements in place.
 * It does not run the read examples; `npm --prefix deployments/example run read:local` does that.
 *
 *   node scripts/check-docs-manifest.mjs [--manifest PATH]
 *   node scripts/check-docs-manifest.mjs --write      regenerate the table in the page
 *   node scripts/check-docs-manifest.mjs --self-test  each kind of drift must be caught
 *
 * Fails when the generated table differs, a required heading or statement is gone, a mock has no
 * read example, or the page holds an address that is neither in the manifest nor a seed test value.
 * Exits 1 on a finding and 2 on a usage error.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const START = '<!-- deployments-table:start -->';
const END = '<!-- deployments-table:end -->';
const DOC = join(ROOT, 'docs', 'public-testnet.md');

const EXPLORERS = { 11155111: { name: 'Sepolia', url: 'https://sepolia.etherscan.io/address/' } };

/** The seed's stored test addresses, from `deployments/shared/seed-plan.ts`. */
const SEED_TEST_ADDRESSES = [
  '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa',
  '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB',
  '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
];

/** The sections that hold the rules below. */
const REQUIRED_HEADINGS = [
  '## Do not log raw provider errors if the URL has a token',
  '## Owner runbook',
  '## Redeploying',
];

/** Safety statements only: keys, tokens and what cannot be undone. Other wording is free to change. */
const REQUIRED_PHRASES = [
  'quote the URL',
  'testnet-only deployer',
  'keystore',
  'Never paste a key into an AI session',
  'separate terminal',
  'cast wallet new',
  'Sealing is irreversible',
  'MAINNET_ARCHIVE_RPC_URL',
  'READBACK_RPC_URL',
  'READBACK_SECOND_RPC_URL',
  'HARDHAT_DISABLE_TELEMETRY',
  'token in a project `.npmrc`',
];

const REQUIRED_READ_KINDS = ['.index(', '.key(', '.field('];

function renderTable(manifest) {
  const lines = [];
  const chains = Object.entries(manifest.chains ?? {}).filter(
    ([, { generations }]) => generations.length > 0
  );
  if (chains.length === 0) {
    return 'No deployment exists yet, so there are no addresses. They appear here after deployment.';
  }
  for (const [chainId, { generations }] of chains) {
    const explorer = EXPLORERS[chainId];
    const generation = generations.at(-1);
    lines.push(
      `### ${explorer?.name ?? 'Chain'} (chain ID ${chainId}), generation ${generations.length}`,
      '',
      '| Contract | Address | Deploy block | Seal block, from which values hold |',
      '|---|---|---|---|'
    );
    const past = [];
    for (const [name, record] of Object.entries(generation.contracts)) {
      const address =
        explorer === undefined
          ? `\`${record.address}\``
          : `[\`${record.address}\`](${explorer.url}${record.address})`;
      lines.push(`| ${name} | ${address} | ${record.deployBlock} | ${record.sealBlock ?? 'not sealed yet'} |`);
      for (const [entry, expected] of Object.entries(record.expected)) {
        if (expected.blockTag !== 'latest') {
          const needs = expected.requiresArchive ? 'yes' : 'no';
          past.push(`| ${name} | \`${entry.split('@')[0]}\` | \`${expected.value}\` | ${expected.blockTag} | ${needs} |`);
        }
      }
    }
    if (past.length > 0) {
      lines.push(
        '',
        'Past values:',
        '',
        '| Contract | Variable | Value | At block | Needs an archive node |',
        '|---|---|---|---|---|',
        ...past
      );
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function tableBounds(page) {
  const start = page.indexOf(START);
  const end = page.indexOf(END);
  return start === -1 || end === -1 || end < start ? undefined : { start: start + START.length, end };
}

const withTable = (page, table) => {
  const { start, end } = tableBounds(page);
  return `${page.slice(0, start)}\n\n${table}\n\n${page.slice(end)}`;
};

function findings(page, manifest, mocks) {
  const found = [];
  const eol = page.replace(/\r\n/g, '\n');
  if (tableBounds(eol) === undefined) {
    found.push('the table markers are missing');
  } else if (withTable(eol, renderTable(manifest)) !== eol) {
    found.push('the table differs from the manifest: run with --write');
  }
  for (const heading of REQUIRED_HEADINGS) {
    if (!eol.split('\n').includes(heading)) found.push(`missing heading: ${heading}`);
  }
  for (const phrase of REQUIRED_PHRASES) {
    if (!eol.includes(phrase)) found.push(`missing statement: ${phrase}`);
  }

  const blocks = new Map(
    [...eol.matchAll(/<!-- read-example: (\w+) -->\n```js\n([\s\S]*?)```/g)].map(([, name, code]) => [name, code])
  );
  for (const mock of mocks) {
    const code = blocks.get(mock);
    if (code === undefined) found.push(`no read example for ${mock}`);
    else if (!code.includes(`.target(addresses.${mock})`)) found.push(`${mock}'s example reads another address`);
  }
  const reads = [...blocks.values()].join('\n');
  for (const kind of REQUIRED_READ_KINDS) {
    if (!reads.includes(kind)) found.push(`no read example uses ${kind}`);
  }

  const known = new Set(SEED_TEST_ADDRESSES.map((address) => address.toLowerCase()));
  for (const { generations } of Object.values(manifest.chains ?? {})) {
    for (const { contracts } of generations) {
      for (const { address } of Object.values(contracts)) known.add(address.toLowerCase());
    }
  }
  for (const [address] of eol.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)) {
    if (!known.has(address.toLowerCase())) found.push(`an address not in the manifest: ${address}`);
  }
  return found;
}

function deployedMocks() {
  return readdirSync(join(ROOT, 'deployments', 'contracts'))
    .filter((name) => /^Mock.*\.sol$/.test(name))
    .map((name) => name.slice(0, -'.sol'.length));
}

function selfTest(page, mocks) {
  const address = `0x${'12'.repeat(20)}`;
  const contract = { address, deployBlock: 1, sealBlock: 2, expected: {} };
  const deployed = {
    chains: { 11155111: { generations: [{ contracts: { MockPacked: contract } }] } },
  };
  const empty = { chains: {} };
  const clean = withTable(page.replace(/\r\n/g, '\n'), renderTable(empty));
  const deployedPage = withTable(clean, renderTable(deployed));
  const cases = [
    ['a clean page', clean, empty, false],
    ['a page regenerated from a deployment', deployedPage, deployed, false],
    ['a manifest the table does not show', clean, deployed, true],
    ['a table with a changed address', deployedPage.replaceAll(address, `0x${'34'.repeat(20)}`), deployed, true],
    ['an address the manifest does not hold', `${clean}\n0x${'56'.repeat(20)}\n`, empty, true],
    ['a removed heading', clean.replace('## Redeploying', '## Elsewhere'), empty, true],
    ['a removed statement', clean.replace('quote the URL', 'mention the URL'), empty, true],
    ['a removed read example', clean.replace('<!-- read-example: MockArrays -->', ''), empty, true],
  ];
  let failed = false;
  for (const [name, text, manifest, shouldFind] of cases) {
    const got = findings(text, manifest, mocks).length > 0;
    if (got !== shouldFind) {
      console.error(`self-test failed: ${name}: expected ${shouldFind ? 'a finding' : 'none'}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log(`docs check self-test OK: ${cases.length} cases`);
}

function main() {
  let options;
  try {
    ({ values: options } = parseArgs({
      options: {
        manifest: { type: 'string', default: join(ROOT, 'deployments', 'manifest', 'deployments.json') },
        write: { type: 'boolean', default: false },
        'self-test': { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const page = readFileSync(DOC, 'utf8');
  const mocks = deployedMocks();
  if (options['self-test']) {
    selfTest(page, mocks);
    return;
  }
  const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));
  if (options.write) {
    if (tableBounds(page) === undefined) {
      console.error('the table markers are missing');
      process.exit(1);
    }
    writeFileSync(DOC, withTable(page.replace(/\r\n/g, '\n'), renderTable(manifest)));
    console.log(`wrote the table to ${DOC}`);
  }
  const found = findings(readFileSync(DOC, 'utf8'), manifest, mocks);
  if (found.length > 0) {
    console.error('docs check failed:');
    for (const finding of found) console.error(`  ${finding}`);
    process.exit(1);
  }
  console.log(`docs check OK: ${mocks.length} mocks`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
