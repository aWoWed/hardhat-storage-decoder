#!/usr/bin/env node
/**
 * Runnable gate against committing a key, a mnemonic or an authenticated RPC URL.
 *
 *   node scripts/check-secrets.mjs              tracked and untracked-but-not-ignored files
 *   node scripts/check-secrets.mjs --staged     the staged content (the pre-commit hook)
 *   node scripts/check-secrets.mjs --self-test  planted fakes must be caught
 *
 * A finding names the file, line and rule, and never prints the matched value. Exits non-zero
 * on any finding. CI runs gitleaks as well; this is the local fallback, with no dependencies.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { holdsHexWord } from './hex-word.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Files whose bare 64-hex values are test vectors. The key rules still apply to them. */
const BARE_HEX_PATHS = new Set([
  'test/unit/bytes.test.ts',
  'test/unit/deriveSlot.test.ts',
  'test/fixtures/e2e/10-values.test.ts',
  'test/fixtures/e2e/20-mappings.test.ts',
]);
const MANIFEST_PATH = 'deployments/manifest/deployments.json';

const BARE_HEX = /(?:(?<=\\[nrt])|(?<![0-9a-zA-Z]))(?:0[xX])?[0-9a-fA-F]{64}(?![0-9a-zA-Z])/;
/** A 32-byte word cut in two. Nothing legitimate is written this way. */
const SPLIT_HEX = /(?<![0-9a-zA-Z])(?:0[xX])?[0-9a-fA-F]{32}:(?:0[xX])?[0-9a-fA-F]{32}(?![0-9a-zA-Z])/;
/** `'abc' + 'def'`, so a key split across a quoted join is still one value. */
const QUOTED_JOIN = /(['"`])\s*\+\s*\1/g;

// `:` covers object fields and `const X: string =` covers annotated declarations.
const ASSIGN = String.raw`["']?\s*(?::\s*\w+\s*=|:|=)\s*`;
const SECRET_NAME = String.raw`[\w-]*(?:(?:private|secret|api|deployer|signer|owner|wallet)[ _-]?key|_token)[\w-]*`;

const SECRET_NAMED_VALUE = new RegExp(
  String.raw`(?<![\w-])${SECRET_NAME}${ASSIGN}(["'\x60]?)(?:0x)?([A-Za-z0-9_+/=-]{20,})(?![A-Za-z0-9_+/=.-])`,
  'gi'
);
/** Hardhat's `etherscan: { apiKey: { sepolia: '...' } }`. */
const NESTED_API_KEY = /\bapi[_-]?key["']?\s*:\s*\{[^}]*["'`][A-Za-z0-9_-]{20,}["'`]/i;
const ENV_NAME = /^[A-Z]+(?:_[A-Z0-9]+)+$/;
const DOTENV_LINE = /^\s*(?:export\s+)?[\w-]+=/;
const ANY_KEY_HEX = new RegExp(
  String.raw`\b[A-Z0-9_]*_KEY(?:_[A-Z0-9_]+)?${ASSIGN}["'\x60]?(?:0[xX])?([0-9a-fA-F]{32,})(?![0-9a-zA-Z_-])`,
  'g'
);
// A generated key has no such run: `ID_KEY = '0xabcdef000...'` in the mapping suite is a padded
// bytes32 mapping key. This is a test of the value, not of where it lives.
const PADDING = /0{16}/;
const MNEMONIC = new RegExp(
  String.raw`\b[\w-]*(?:mnemonic|seed[_-]?phrase|recovery[_-]?phrase|phrase)${ASSIGN}["'\x60]?(?:[a-z]+\s+){11,}[a-z]+`,
  'i'
);

const CREDENTIAL_RULES = [
  [/\bnpm_[A-Za-z0-9]{30,}/, 'npm token'],
  [/\/\/[^\s"'`]+\/:_(?:authToken|auth|password)\s*=\s*[^\s"'`$<{]/, 'npm registry credential'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'GitHub token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY/, 'PEM private key'],
  [/\bAuthorization["']?\s*:\s*["'`]?(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/i, 'authorization header'],
];

const URL_RULES = [
  // Credentials in the authority. `${user}:${pass}@` is code, and is left alone.
  /\b(?:https?|wss?):\/\/[^/\s:@$<{]+:[^/\s@$<{]+@/i,
  /\b(?:https?|wss?):\/\/[^/\s:@$<{'"`]+@/i,
  /\.infura\.io\/(?:v3|ws\/v3)\/[0-9a-zA-Z]{16,}/i,
  /\.alchemy(?:api)?\.(?:com|io)\/v2\/[0-9a-zA-Z_-]{16,}/i,
  /\.quiknode\.pro\/[0-9a-zA-Z_-]{16,}/i,
  /rpc\.ankr\.com\/[\w-]+\/[0-9a-zA-Z]{16,}/i,
  /\.drpc\.org\/[^\s"'`]*dkey=[0-9a-zA-Z_-]{16,}/i,
  /\.drpc\.(?:live|org)\/[\w-]+\/[0-9a-zA-Z_-]{16,}/i,
  /\.blastapi\.io\/[0-9a-zA-Z-]{16,}/i,
  /\.chainstack\.com\/[0-9a-zA-Z_-]{16,}/i,
  /\.getblock\.io\/[0-9a-zA-Z_-]{16,}/i,
  /\.gateway\.tenderly\.co\/[0-9a-zA-Z_-]{16,}/i,
  /\.nodereal\.io\/v\d+\/[0-9a-zA-Z_-]{16,}/i,
  /\.lavanet\.xyz(?::\d+)?\/[^\s"'`]*[0-9a-zA-Z]{16,}/i,
  /\.thirdweb\.com\/[0-9a-zA-Z_-]{16,}/i,
  // A token as the first host label: long, unbroken, and with both letters and digits.
  /\b(?:https?|wss?):\/\/(?=[a-z]*\d)(?=\d*[a-z])[0-9a-z]{16,}\.[^/\s"'`]+/i,
  // Any URL carrying a token in the query string or the fragment.
  /\b(?:https?|wss?):\/\/[^\s"'`]*[?&#][\w-]*(?:key|token|auth)[\w-]*=[0-9a-zA-Z_-]{16,}/i,
];

const RPC_URL_VALUE = /\b[\w-]*rpc[_-]?url["']?\s*(?::\s*\w+\s*=|:|=)\s*["'`]?([^\s"'`,;)]*)/gi;
const KEYLESS_HOSTS = new Set([
  'ethereum-rpc.publicnode.com',
  'ethereum-sepolia-rpc.publicnode.com',
  'sepolia.drpc.org',
  '1rpc.io',
]);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);
/** Reserved names, as in documentation. A long path segment on one is still a token. */
const PLACEHOLDER_HOST = /(?:^|\.)(?:example\.(?:com|org|net)|example|invalid|test)$/i;

/** Whether a literal `*_RPC_URL` value is empty, code, a placeholder or a known keyless URL. */
function isAcceptableRpcUrl(value) {
  if (value === '' || /[$<{]/.test(value)) return true;
  if (!value.includes('://') && !/^[\w-]+(?:\.[\w-]+)+(?::\d+)?\//.test(value)) return true;
  let url;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return false;
  if (LOCAL_HOSTS.has(url.hostname)) return true;
  const shortPath = url.pathname.split('/').every((part) => part.length < 16);
  return shortPath && (KEYLESS_HOSTS.has(url.hostname) || PLACEHOLDER_HOST.test(url.hostname));
}

const FORBIDDEN_PATH =
  /(?:^|\/)(?:\.env(?:\.(?!example$)[^/]*)?|\.envrc|\.npmrc|key\.txt|secrets\.json|keystore\.json|[^/]*\.(?:keystore|pem|key))$/i;

/** Binary files allowed in the tree. A new one is refused until it is listed here. */
const BINARY_ALLOWLIST = new Set([]);

const WORDLIST_PATH = 'scripts/bip39-english.txt';
// Pins the published BIP-39 English list.
const WORDLIST_SHA512 =
  '416c71ba30018ea292bb36cdc23c9329673485a8d8933266a9d9a7cc72153b8baed3d430f52eab4f5d3addf6583611b3777a50454599f1e42716f5f879621123';
const sha512 = (text) => createHash('sha512').update(text).digest('hex');
const WORDLIST_SOURCE = readFileSync(join(ROOT, WORDLIST_PATH), 'utf8').replace(/\r/g, '');
if (sha512(WORDLIST_SOURCE) !== WORDLIST_SHA512) {
  console.error(`${WORDLIST_PATH} is not the BIP-39 English list, so mnemonics cannot be checked.`);
  process.exit(2);
}
const WORDS = new Set(WORDLIST_SOURCE.trim().split('\n'));
const MNEMONIC_MIN_WORDS = 12;
/** Between words of a phrase: spaces, quotes and commas of an array, `1.` of a numbered list. */
const WORD_GAP = /^(?:[\s"'`,[\]]|\d+[.):]?)+$/;

/** The line of each run of 12 or more BIP-39 words. Ordinary prose breaks on `the` or `of`. */
function findWordRuns(source) {
  const lines = [];
  let run = 0;
  let previousEnd = -1;
  for (const match of source.matchAll(/[a-z]+/g)) {
    const contiguous = previousEnd >= 0 && WORD_GAP.test(source.slice(previousEnd, match.index));
    if (!WORDS.has(match[0])) {
      run = 0;
      previousEnd = -1;
      continue;
    }
    run = contiguous ? run + 1 : 1;
    previousEnd = match.index + match[0].length;
    if (run === MNEMONIC_MIN_WORDS) lines.push(source.slice(0, match.index).split('\n').length);
  }
  return lines;
}

/** @returns {{ line: number, rule: string }[]} */
function scanLine(text, line, checkBareHex) {
  const findings = [];
  const add = (rule) => findings.push({ line, rule });
  for (const match of text.matchAll(SECRET_NAMED_VALUE)) {
    const [, quote, value] = match;
    if (ENV_NAME.test(value)) continue;
    if (quote !== '' || DOTENV_LINE.test(text) || /\d/.test(value)) add('secret-named assignment');
  }
  if (NESTED_API_KEY.test(text)) add('secret-named assignment');
  for (const match of text.matchAll(ANY_KEY_HEX)) {
    if (!PADDING.test(match[1])) add('*_KEY assigned a hex value');
  }
  if (MNEMONIC.test(text)) add('mnemonic assignment');
  for (const [pattern, rule] of CREDENTIAL_RULES) if (pattern.test(text)) add(rule);
  if (URL_RULES.some((rule) => rule.test(text))) add('authenticated RPC URL');
  for (const match of text.matchAll(RPC_URL_VALUE)) {
    if (!isAcceptableRpcUrl(match[1])) add('RPC URL that is not a known keyless one');
  }
  if (checkBareHex && BARE_HEX.test(text.replace(QUOTED_JOIN, ''))) add('bare 64-hex value');
  if (SPLIT_HEX.test(text)) add('64-hex value split in two');
  return findings;
}

/** Whether `path` (a field path in the manifest) may hold a 64-hex value. */
function isAllowedManifestField(path) {
  const last = path[path.length - 1];
  if (last === 'txHash' || last === 'signedTxHash' || last === 'sealTxHash') return true;
  // Exact, unlike the fields above: seal re-checks this one, and nothing else may carry the name.
  if (last === 'blockHash') {
    return path.length === 7 && path[0] === 'chains' && path[2] === 'generations' && path[4] === 'steps';
  }
  return last === 'value' && path.length >= 3 && path[path.length - 3] === 'expected';
}

function scanManifestFields(source) {
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    return [{ line: 1, rule: 'manifest is not valid JSON, so its fields cannot be checked' }];
  }
  const findings = [];
  const walk = (value, path) => {
    if (typeof value === 'string') {
      if (BARE_HEX.test(value) && !isAllowedManifestField(path)) {
        findings.push({ line: 1, rule: `bare 64-hex value in field ${path.join('.')}` });
      }
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        // Not printed: the name is the value here.
        if (holdsHexWord(key, path[path.length - 1] === 'expected', BARE_HEX)) {
          findings.push({ line: 1, rule: `64-hex field name under ${path.join('.')}` });
          continue;
        }
        walk(child, [...path, key]);
      }
    }
  };
  walk(manifest, []);
  return findings;
}

/** Scan one file's content. `path` is repo-relative with forward slashes. */
function scanText(path, source) {
  const findings = [];
  const isManifest = path === MANIFEST_PATH;
  const checkBareHex = !BARE_HEX_PATHS.has(path) && !isManifest;
  source.split(/\r?\n/).forEach((text, index) => {
    findings.push(...scanLine(text, index + 1, checkBareHex));
  });
  // Only the exact published list is exempt, so a phrase cannot be hidden by adding it to this file.
  const isWordlist = path === WORDLIST_PATH && sha512(source.replace(/\r/g, '')) === WORDLIST_SHA512;
  if (!isWordlist) {
    for (const line of findWordRuns(source)) findings.push({ line, rule: 'BIP-39 word run' });
  }
  if (isManifest) findings.push(...scanManifestFields(source));
  return findings;
}

/**
 * Text by its byte order mark: PowerShell 5.1's `>` writes UTF-16, which holds a NUL in every other
 * byte and would otherwise look binary.
 *
 * @returns {string | undefined} undefined when the bytes are not text.
 */
function decodeText(content) {
  let text;
  if (content[0] === 0xff && content[1] === 0xfe) text = content.subarray(2).toString('utf16le');
  else if (content[0] === 0xfe && content[1] === 0xff) {
    const even = content.length - (content.length % 2);
    text = Buffer.from(content.subarray(2, even)).swap16().toString('utf16le');
  } else text = content.toString('utf8');
  return text.includes('\0') ? undefined : text;
}

/** A file that must never be tracked, whatever it holds. */
function isForbiddenPath(path) {
  return FORBIDDEN_PATH.test(path);
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'buffer', maxBuffer: 1 << 30 });
  if (result.status !== 0) {
    console.error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
    process.exit(2);
  }
  return result.stdout;
}

function listFiles(staged) {
  const args = staged
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
    : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
  return git(args).toString('utf8').split('\0').filter(Boolean);
}

function readForScan(path, staged) {
  if (staged) return git(['show', `:${path}`]);
  try {
    return readFileSync(join(ROOT, path));
  } catch (error) {
    // Tracked, but deleted in the working tree and not yet staged.
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function runScan(staged) {
  const violations = [];
  const files = listFiles(staged);
  for (const path of files) {
    if (isForbiddenPath(path)) violations.push(`${path}  must not be tracked`);
    const content = readForScan(path, staged);
    if (content === undefined) continue;
    const text = decodeText(content);
    if (text === undefined) {
      if (!BINARY_ALLOWLIST.has(path)) violations.push(`${path}  is binary and not on the allowlist`);
      continue;
    }
    for (const { line, rule } of scanText(path, text)) {
      violations.push(`${path}:${line}  ${rule}`);
    }
  }
  if (violations.length > 0) {
    console.error('possible secrets found (values are not printed):');
    for (const violation of violations) console.error(`  ${violation}`);
    console.error('\nRemove the value. If it was ever committed or pushed, treat it as leaked.');
    process.exit(1);
  }
  console.log(`secret scan OK — ${files.length} file(s), ${staged ? 'staged' : 'working tree'}`);
}

function selfTest() {
  // Random per run, so no fixed value exists in this source.
  const randomHex = (bytes) => randomBytes(bytes).toString('hex');
  const hex = randomHex(32);
  const token = randomHex(12);
  const halves = [hex.slice(0, 32), hex.slice(32)];
  const longToken = randomHex(18);
  const privateHost = `node-${randomHex(4)}.net`;
  const padded = `${randomHex(2)}${'0'.repeat(60)}`;
  const wordlist = [...WORDS];
  const phrase = Array.from({ length: 12 }, () => wordlist[randomInt(wordlist.length)]).join(' ');
  const prose12 = 'this is a sentence of ordinary prose with twelve lower case words'.split(' ').slice(0, 12).join(' ');
  const allowlisted = 'test/unit/bytes.test.ts';
  const mustCatch = [
    ['a.ts', `PRIVATE_KEY=${hex}`],
    ['a.ts', `PRIVATE_KEY=0x${hex}`],
    ['.env.example', `DEPLOYER_KEY=0x${hex}`],
    ['a.ts', `const SEPOLIA_DEPLOYER_KEY = '0x${hex}';`],
    ['a.ts', `const OWNER_KEY: string = '0x${hex}';`],
    ['a.ts', `{ "privateKey": "0x${hex}" }`],
    ['a.ts', `privateKey: '${hex}'`],
    ['a.ts', `ETHERSCAN_API_KEY=${token}`],
    ['a.ts', `MNEMONIC="${phrase}"`],
    ['a.ts', `mnemonic: '${phrase}'`],
    // The padding test belongs to the wildcard rule only: a named private key gets no exemption.
    ['a.ts', `PRIVATE_KEY=0x${'0'.repeat(63)}1`],
    ['a.ts', `https://sepolia.infura.io/v3/${hex.slice(0, 32)}`],
    ['a.ts', `https://eth-sepolia.g.alchemy.com/v2/${token}`],
    ['a.ts', `https://user:${token}@rpc.example.org`],
    ['a.ts', `https://rpc.example.org/?apikey=${token}`],
    ['a.ts', `const x = '0x${hex}';`],
    ['a.ts', hex],
    // Key rules ignore the path allowlist.
    [allowlisted, `PRIVATE_KEY=0x${hex}`],
    [allowlisted, `const DEPLOYER_KEY = '0x${hex}';`],
    [allowlisted, `https://sepolia.infura.io/v3/${hex.slice(0, 32)}`],
    [MANIFEST_PATH, JSON.stringify({ PRIVATE_KEY: `0x${hex}` })],
    [MANIFEST_PATH, JSON.stringify({ address: `0x${hex}` })],
    [MANIFEST_PATH, JSON.stringify({ blockHash: `0x${hex}` })],
    // The whole-word name form: only directly under `expected`, and only exactly.
    [MANIFEST_PATH, JSON.stringify({ contracts: { [`m{w:0x${hex}}`]: { value: '1' } } })],
    [MANIFEST_PATH, JSON.stringify({ [`m{w:0x${hex}}`]: 1 })],
    [MANIFEST_PATH, JSON.stringify({ expected: { x: { [`m{w:0x${hex}}`]: 1 } } })],
    [MANIFEST_PATH, JSON.stringify({ expected: { [`m{w:${hex}}`]: { value: '1' } } })],
    [MANIFEST_PATH, JSON.stringify({ expected: { [`m{s:0x${hex}}`]: { value: '1' } } })],
    // A word cut in two, in a name, in a value, and in any other file.
    [MANIFEST_PATH, JSON.stringify({ expected: { [`m{w:0x${halves[0]}:${halves[1]}}`]: { value: '1' } } })],
    [MANIFEST_PATH, JSON.stringify({ expected: { [`m{w:0x${halves[0]}.${halves[1]}}`]: { value: '1' } } })],
    [MANIFEST_PATH, JSON.stringify({ txHash: `0x${halves[0]}:${halves[1]}` })],
    ['a.ts', `const x = '${halves[0]}:${halves[1]}';`],
    ['a.ts', `const x = '0x${halves[0]}:0x${halves[1]}';`],
    [allowlisted, `const x = '${halves[0]}:${halves[1]}';`],
    [MANIFEST_PATH, JSON.stringify({ expected: { x: { blockHash: `0x${hex}` } } })],
    [
      MANIFEST_PATH,
      JSON.stringify({ chains: { 1: { generations: [{ contracts: { M: { blockHash: `0x${hex}` } } }] } } }),
    ],
    [MANIFEST_PATH, JSON.stringify({ chains: { 1: { generations: [{ steps: [{ extra: { blockHash: `0x${hex}` } }] }] } } })],
    [MANIFEST_PATH, JSON.stringify({ expected: { value: `0x${hex}` } })],
    [MANIFEST_PATH, '{ not json'],
    [MANIFEST_PATH, JSON.stringify({ expected: { [`0x${hex}`]: { value: '1' } } })],
    [MANIFEST_PATH, JSON.stringify({ expected: { [hex]: { value: '1' } } })],
    // Non-Ethereum credentials.
    ['a.ts', `npm_${longToken}`],
    ['.npmrc', `//registry.npmjs.org/:_authToken=${token}`],
    ['a.ts', `ghp_${longToken}`],
    ['a.ts', `gho_${longToken}`],
    ['a.ts', `github_pat_${longToken}`],
    // Assembled only so this scanner does not match its own rule text; no credential is involved.
    ['a.ts', `-----BEGIN ${'EC '}PRIVATE KEY-----`],
    ['a.ts', `-----BEGIN ${''}PRIVATE KEY-----`],
    ['a.ts', `Authorization: Bearer ${token}`],
    // Mnemonics, by name and by wordlist.
    ['a.txt', phrase],
    ['a.ts', JSON.stringify({ mnemonic: { phrase } })],
    ['a.ts', `RECOVERY_PHRASE="${phrase}"`],
    ['a.ts', `const words = '${phrase}';`],
    ['a.ts', `const m = ${JSON.stringify(phrase.split(' '))};`],
    ['a.json', JSON.stringify(phrase.split(' '), null, 2)],
    ['a.md', phrase.split(' ').map((word, index) => `${index + 1}. ${word}`).join('\n')],
    ['a.ts', `phrase: '${prose12}'`],
    // RPC tokens.
    ['a.ts', `https://lb.drpc.live/sepolia/${token}`],
    ['a.ts', `https://eth-sepolia.nodereal.io/v1/${hex.slice(0, 32)}`],
    ['a.ts', `https://g.w.lavanet.xyz:443/gateway/sep1/rpc-http/${hex.slice(0, 32)}`],
    ['a.ts', `https://11155111.rpc.thirdweb.com/${hex.slice(0, 32)}`],
    ['a.ts', `https://${token}@rpc.example.org/`],
    ['a.ts', `https://${token}.rpc.example.org/`],
    ['a.ts', `https://rpc.example.org/?x-api-key=${token}`],
    ['a.ts', `https://rpc.example.org/#token=${token}`],
    ['a.ts', `SEPOLIA_RPC_URL=https://rpc.example.org/${token}`],
    ['a.ts', `READBACK_RPC_URL=https://${privateHost}`],
    ['a.ts', `MAINNET_ARCHIVE_RPC_URL=${privateHost}/abc`],
    ['a.ts', `const rpcUrl = 'https://${privateHost}/abc';`],
    // Named keys.
    ['a.ts', `ETHERSCAN_API_KEY_SEPOLIA=${token}`],
    ['a.ts', `etherscan: { apiKey: { sepolia: '${token}' } }`],
    ['a.ts', `apiKey: '${token}'`],
    ['a.ts', `deployerKey: '${token}'`],
    ['a.ts', `PRIVATE_KEY=${randomHex(8)}+${randomHex(8)}/${randomHex(8)}=`],
    ['a.ts', `PRIVATE_KEY=0X${hex}`],
    ['a.ts', `Private key: 0x${hex}`],
    ['a.ts', `Private key: ${hex.slice(0, 32)}`],
    ['a.ts', `GITHUB_TOKEN=${token}`],
    ['a.ts', `x = 0X${hex}`],
    ['a.json', `{"log":"line\\n${hex}"}`],
    ['a.ts', `k='${hex.slice(0, 32)}'+'${hex.slice(32)}'`],
    // Every match on a line counts, not only the first.
    ['a.ts', `A_KEY='0x${padded}', B_KEY='0x${hex}'`],
  ];
  const mustPass = [
    [allowlisted, `const x = '0x${hex}';`],
    [
      MANIFEST_PATH,
      JSON.stringify({ txHash: `0x${hex}`, signedTxHash: `0x${hex}`, sealTxHash: `0x${hex}` }),
    ],
    [MANIFEST_PATH, JSON.stringify({ expected: { count: { value: `0x${hex}` } } })],
    [MANIFEST_PATH, JSON.stringify({ expected: { [`m{w:0x${hex}}`]: { value: '1' } } })],
    [MANIFEST_PATH, JSON.stringify({ expected: { [`Base::m{n:5}{w:0x${hex}}[2].f@7`]: { value: '1' } } })],
    [MANIFEST_PATH, JSON.stringify({ expected: { 'Base::m{n:5}[2].f@7': { value: '1' } } })],
    [MANIFEST_PATH, JSON.stringify({ chains: { 1: { generations: [{ steps: [{ blockHash: `0x${hex}` }] }] } } })],
    ['.env.example', 'SEPOLIA_DEPLOYER_KEY='],
    ['a.ts', 'const PRIVATE_KEY = process.env.PRIVATE_KEY;'],
    ['a.ts', "const SELECTOR_KEY = '0x12345678';"],
    [allowlisted, `const ID_KEY = '0xabcdef${'0'.repeat(58)}';`],
    ['a.ts', 'https://ethereum-sepolia-rpc.publicnode.com'],
    ['a.ts', 'https://${user}:${pass}@rpc.example.org'],
    ['a.ts', `const bytecode = '0x${hex}${hex}${hex}';`],
    ['a.ts', 'const KEY_VAR = "SEPOLIA_DEPLOYER_KEY_NAME";'],
    ['a.ts', 'const deployerKey = readDeployerKeyFromKeystore;'],
    ['.env.example', 'READBACK_RPC_URL='],
    ['a.ts', 'SEPOLIA_RPC_URL: url,'],
    ['a.ts', 'READBACK_RPC_URL: process.env.READBACK_RPC_URL,'],
    ['a.ts', "SEPOLIA_RPC_URL: 'http://127.0.0.1:1',"],
    ['a.ts', "const PUBLIC_RPC_URL = 'https://ethereum-rpc.publicnode.com';"],
    ['a.ts', 'SEPOLIA_RPC_URL=https://rpc.example.org/sepolia'],
    ['a.md', `Twelve words of prose: ${prose12}`],
    ['a.md', phrase.split(' ').slice(0, 11).join(' ')],
    ['a.md', 'git clone https://github.com/owner/repo.git'],
    [WORDLIST_PATH, WORDLIST_SOURCE],
  ];
  const pathsForbidden = [
    '.env',
    '.ENV',
    '.env.local',
    'deployments/.env',
    'x/my.keystore',
    '.npmrc',
    'x/server.pem',
    'key.txt',
    'deployer.key',
    'secrets.json',
    '.envrc',
    'x/keystore.json',
  ];
  const pathsAllowed = ['.env.example', 'deployments/.env.example', 'envelope.ts'];

  const failures = [];
  const keyLine = `PRIVATE_KEY=0x${hex}`;
  const encoded = [
    ['UTF-16 LE', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(keyLine, 'utf16le')])],
    ['UTF-16 BE', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(keyLine, 'utf16le').swap16()])],
  ];
  for (const [name, content] of encoded) {
    const text = decodeText(content);
    if (text === undefined || scanText('a.txt', text).length === 0) failures.push(`missed ${name}`);
  }
  for (const content of [Buffer.from(`\0${keyLine}`), Buffer.from([0xff, 0xfe, 0, 0, 0x41, 0])]) {
    if (decodeText(content) !== undefined) failures.push('NUL bytes were taken for text');
  }
  if (scanText(WORDLIST_PATH, `${WORDLIST_SOURCE}${phrase}\n`).length === 0) {
    failures.push('a phrase added to the wordlist file was missed');
  }
  mustCatch.forEach(([path, source], index) => {
    if (scanText(path, source).length === 0) failures.push(`missed plant #${index} in ${path}`);
  });
  mustPass.forEach(([path, source], index) => {
    if (scanText(path, source).length > 0) failures.push(`false alarm #${index} in ${path}`);
  });
  for (const path of pathsForbidden) {
    if (!isForbiddenPath(path)) failures.push(`path not refused: ${path}`);
  }
  for (const path of pathsAllowed) {
    if (isForbiddenPath(path)) failures.push(`path wrongly refused: ${path}`);
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  const total =
    mustCatch.length + mustPass.length + pathsForbidden.length + pathsAllowed.length + encoded.length + 3;
  console.log(`secret scan self-test OK — ${total} case(s)`);
}

if (process.argv.includes('--self-test')) selfTest();
else runScan(process.argv.includes('--staged'));
