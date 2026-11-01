/**
 * `check-sourcify.mjs` and `submit-sourcify.mjs`, each run as a command against a fake server. This
 * proves their handling of Sourcify's documented answers. It does not prove Sourcify accepts a
 * Hardhat 3 build, which only the real submission at gate G2 can show.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FETCH_BLOCKED_PORTS } from '../../deployments/shared/free-port.mjs';

const CHAIN = '11155111';
const ADDRESS_A = `0x${'a1'.repeat(20)}`;
const ADDRESS_B = `0x${'b2'.repeat(20)}`;
const TX_HASH = `0x${'AB'.repeat(32)}`;
const JOB = '550e8400-e29b-41d4-a716-446655440000';
const SOLC = { version: '0.8.26', optimizer: { enabled: false }, evmVersion: 'cancun' };

const contract = (address: string) => ({
  address,
  deployBlock: 1,
  txHash: TX_HASH,
  sealBlock: null,
  sealTxHash: null,
  expected: {},
});

const verified = (name: string, address: string) => ({
  match: 'exact_match',
  creationMatch: 'exact_match',
  runtimeMatch: 'exact_match',
  chainId: CHAIN,
  address,
  compilation: { name, compilerVersion: '0.8.26+commit.8a97fa7a', compilerSettings: { evmVersion: 'cancun' } },
});

type Reply = { status: number; body?: unknown; raw?: string };
type Handler = (method: string, path: string, body: string) => Reply;

let folder: string;
let server: Server | undefined;
let manifest: string;
let project: string;
const posts: Array<{ path: string; body: Record<string, any> }> = [];

async function serve(handler: Handler): Promise<string> {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.method === 'POST') posts.push({ path: req.url as string, body: JSON.parse(body) });
      const reply = handler(req.method as string, req.url as string, body);
      res.statusCode = reply.status;
      res.end(reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body)));
    });
  });
  // This server has to hold its port, so it re-listens rather than taking one from `freePort`.
  for (;;) {
    await new Promise<void>((resolve) => (server as Server).listen(0, '127.0.0.1', () => resolve()));
    if (!FETCH_BLOCKED_PORTS.has(((server as Server).address() as AddressInfo).port)) break;
    await new Promise((resolve) => (server as Server).close(resolve));
  }
  return `http://127.0.0.1:${((server as Server).address() as AddressInfo).port}`;
}

/** Runs asynchronously, because the fake server lives in this process. */
function command(script: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join('scripts', script), ...args], { stdio: 'pipe' });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('close', (code) => resolve({ code, out }));
  });
}

const common = (url: string): string[] => [
  '--chain', CHAIN, '--manifest', manifest, '--server', url, '--retry-delay-ms', '0',
];
const check = (url: string) => command('check-sourcify.mjs', common(url));
const submit = (url: string) =>
  command('submit-sourcify.mjs', [...common(url), '--project', project, '--poll-ms', '1', '--job-timeout-ms', '200']);

/** Answers lookups from a table of contract replies, keyed by address. */
const lookups = (replies: Record<string, Reply>, path: string): Reply | undefined => {
  const match = /^\/v2\/contract\/\d+\/(0x[0-9a-f]+)\?fields=compilation$/.exec(path);
  return match === null ? undefined : replies[match[1] as string];
};

beforeEach(() => {
  posts.length = 0;
  folder = mkdtempSync(join(tmpdir(), 'sourcify-'));
  manifest = join(folder, 'deployments.json');
  writeFileSync(
    manifest,
    JSON.stringify({
      schemaVersion: 1,
      chains: {
        [CHAIN]: {
          generations: [
            { solcSettings: SOLC, contracts: { Stale: contract(`0x${'cc'.repeat(20)}`) } },
            { solcSettings: SOLC, contracts: { MockA: contract(ADDRESS_A), MockB: contract(ADDRESS_B) } },
          ],
        },
      },
    })
  );
  project = join(folder, 'project');
  mkdirSync(join(project, 'artifacts', 'build-info'), { recursive: true });
  writeFileSync(
    join(project, 'artifacts', 'build-info', 'build.json'),
    JSON.stringify({
      solcLongVersion: '0.8.26+commit.8a97fa7a',
      input: {
        language: 'Solidity',
        sources: { 'project/contracts/MockA.sol': { content: 'a' } },
        settings: { evmVersion: 'cancun', outputSelection: {} },
        notAccepted: true,
      },
    })
  );
  for (const name of ['MockA', 'MockB']) {
    mkdirSync(join(project, 'artifacts', 'contracts', `${name}.sol`), { recursive: true });
    writeFileSync(
      join(project, 'artifacts', 'contracts', `${name}.sol`, `${name}.json`),
      JSON.stringify({ buildInfoId: 'build', inputSourceName: `project/contracts/${name}.sol` })
    );
  }
});

afterEach(async () => {
  await new Promise((resolve) => (server === undefined ? resolve(undefined) : server.close(resolve)));
  server = undefined;
  rmSync(folder, { recursive: true, force: true });
});

const allVerified: Record<string, Reply> = {
  [ADDRESS_A]: { status: 200, body: verified('MockA', ADDRESS_A) },
  [ADDRESS_B]: { status: 200, body: verified('MockB', ADDRESS_B) },
};

describe('check-sourcify', () => {
  it('exits 0 when each contract of the current generation is verified', async () => {
    const seen: string[] = [];
    const url = await serve((_, path) => {
      seen.push(path);
      return lookups(allVerified, path) ?? { status: 500 };
    });
    const { code, out } = await check(url);
    expect(out).toContain('2 of 2 verified');
    expect(code).toBe(0);
    expect(seen.some((path) => path.includes('cccc'))).toBe(false);
  });

  it.each<[string, Reply]>([
    ['not verified', { status: 404, body: { customCode: 'not_found' } }],
    ['a null match', { status: 200, body: { ...verified('MockB', ADDRESS_B), match: null } }],
    ['another contract at the address', { status: 200, body: verified('Other', ADDRESS_B) }],
    ['an answer for another address', { status: 200, body: verified('MockB', ADDRESS_A) }],
    [
      'another evmVersion',
      {
        status: 200,
        body: {
          ...verified('MockB', ADDRESS_B),
          compilation: { name: 'MockB', compilerVersion: '0.8.26+commit.8a97fa7a', compilerSettings: { evmVersion: 'paris' } },
        },
      },
    ],
    [
      'another compiler',
      {
        status: 200,
        body: {
          ...verified('MockB', ADDRESS_B),
          compilation: { name: 'MockB', compilerVersion: '0.8.25+commit.b61c2a91', compilerSettings: { evmVersion: 'cancun' } },
        },
      },
    ],
  ])('exits 1 on %s', async (_, reply) => {
    const url = await serve((__, path) => lookups({ ...allVerified, [ADDRESS_B]: reply }, path) ?? { status: 500 });
    const { code, out } = await check(url);
    expect(out).toContain('WRONG MockB');
    expect(code).toBe(1);
  });

  it.each<[string, Reply]>([
    ['HTTP 503', { status: 503 }],
    ['HTTP 429', { status: 429 }],
    ['HTML from a proxy', { status: 200, raw: '<html>' }],
    ['a body with no match field', { status: 200, body: {} }],
  ])('exits 3 on %s, after retries', async (_, reply) => {
    let calls = 0;
    const url = await serve((__, path) => {
      if (path.includes(ADDRESS_B)) calls += 1;
      return lookups({ ...allVerified, [ADDRESS_B]: reply }, path) ?? { status: 500 };
    });
    const { code, out } = await check(url);
    expect(out).toContain('could-not-check MockB');
    expect(code).toBe(3);
    if (reply.status !== 200) expect(calls).toBe(3);
  });

  it('exits 3 when nothing answers', async () => {
    const url = await serve(() => ({ status: 500 }));
    await new Promise((resolve) => (server as Server).close(resolve));
    server = undefined;
    expect((await check(url)).code).toBe(3);
  });

  it('lets exit 1 win over exit 3', async () => {
    const url = await serve((_, path) =>
      lookups({ [ADDRESS_A]: { status: 503 }, [ADDRESS_B]: { status: 404 } }, path) ?? { status: 500 }
    );
    expect((await check(url)).code).toBe(1);
  });

  it.each<[string, string[]]>([
    ['no chain', ['--manifest', 'x']],
    ['a bad chain', ['--chain', 'abc']],
    ['an unknown option', ['--chain', CHAIN, '--nope']],
    ['a chain the manifest does not hold', ['--chain', '5']],
  ])('exits 2 on %s', async (_, args) => {
    const needsManifest = args.includes('5');
    const { code } = await command('check-sourcify.mjs', needsManifest ? [...args, '--manifest', manifest] : args);
    expect(code).toBe(2);
  });
});

describe('submit-sourcify', () => {
  /** A server that verifies a contract once its job has been asked about twice. */
  async function working(): Promise<string> {
    const lookedUp: Record<string, Reply> = {};
    let polls = 0;
    return serve((method, path) => {
      if (method === 'POST') {
        const address = path.split('/').at(-1) as string;
        lookedUp[address] = allVerified[address] as Reply;
        return { status: 202, body: { verificationId: JOB } };
      }
      if (path === `/v2/verify/${JOB}`) {
        polls += 1;
        return { status: 200, body: { isJobCompleted: polls % 2 === 0, contract: { match: 'exact_match' } } };
      }
      return lookups(lookedUp, path) ?? { status: 404 };
    });
  }

  it('sends the build-info input with only accepted fields, and exits 0', async () => {
    const { code, out } = await submit(await working());
    expect(out).toContain('2 of 2 verified');
    expect(code).toBe(0);
    expect(posts.map(({ path }) => path)).toEqual([
      `/v2/verify/${CHAIN}/${ADDRESS_A}`,
      `/v2/verify/${CHAIN}/${ADDRESS_B}`,
    ]);
    const { body } = posts[0] as { body: Record<string, any> };
    expect(body.contractIdentifier).toBe('project/contracts/MockA.sol:MockA');
    expect(body.compilerVersion).toBe('0.8.26+commit.8a97fa7a');
    expect(body.creationTransactionHash).toBe(TX_HASH.toLowerCase());
    expect(Object.keys(body.stdJsonInput).sort()).toEqual(['language', 'settings', 'sources']);
  });

  it('treats an already verified contract as fine, and exits 0', async () => {
    const url = await serve((method, path) =>
      method === 'POST' ? { status: 409, body: {} } : (lookups(allVerified, path) ?? { status: 500 })
    );
    const { code, out } = await submit(url);
    expect(out).toContain('already verified MockA');
    expect(code).toBe(0);
  });

  it('exits 1 when a job finishes without a match, and leaves out bytecode', async () => {
    const url = await serve((method, path) => {
      if (method === 'POST') return { status: 202, body: { verificationId: JOB } };
      if (path === `/v2/verify/${JOB}`) {
        return {
          status: 200,
          body: {
            isJobCompleted: true,
            error: { customCode: 'no_match', message: 'bytecode differs', recompiledRuntimeCode: '0xfeedfeed' },
          },
        };
      }
      return { status: 404 };
    });
    const { code, out } = await submit(url);
    expect(out).toContain('REJECTED MockA');
    expect(out).toContain('no_match: bytecode differs');
    expect(out).not.toContain('feedfeed');
    expect(code).toBe(1);
  });

  it('exits 1 on a request Sourcify refuses', async () => {
    const url = await serve((method) =>
      method === 'POST' ? { status: 400, body: { customCode: 'bad', message: 'no' } } : { status: 404 }
    );
    expect((await submit(url)).code).toBe(1);
  });

  it('exits 3 when a job never finishes', async () => {
    const url = await serve((method, path) => {
      if (method === 'POST') return { status: 202, body: { verificationId: JOB } };
      if (path === `/v2/verify/${JOB}`) return { status: 200, body: { isJobCompleted: false } };
      return lookups(allVerified, path) ?? { status: 500 };
    });
    const { code, out } = await submit(url);
    expect(out).toContain('did not finish in time');
    expect(code).toBe(3);
  });

  it('exits 3 when Sourcify is down', async () => {
    expect((await submit(await serve(() => ({ status: 503 })))).code).toBe(3);
  });

  it('exits 2 when the build differs from the manifest, before sending anything', async () => {
    writeFileSync(
      join(project, 'artifacts', 'build-info', 'build.json'),
      JSON.stringify({
        solcLongVersion: '0.8.26+commit.8a97fa7a',
        input: { language: 'Solidity', sources: {}, settings: { evmVersion: 'paris' } },
      })
    );
    const { code, out } = await submit(await working());
    expect(out).toContain('evmVersion paris');
    expect(code).toBe(2);
    expect(posts).toHaveLength(0);
  });

  it('exits 2 when the project is not compiled', async () => {
    rmSync(join(project, 'artifacts'), { recursive: true, force: true });
    expect((await submit(await working())).code).toBe(2);
    expect(posts).toHaveLength(0);
  });
});
