/**
 * The release gate's rules without running anything real: every command, git answer and file is a
 * fake, and each blocking condition is shown to block on its own.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { RELEASE_VERSION, checkConsistency } from '../../scripts/check-release-consistency.mjs';
import {
  BURST_SIZE,
  type GateDeps,
  RELEASE_BASELINE,
  SEPOLIA,
  evaluateCiRuns,
  evaluateMainnetReport,
  evaluateManifest,
  evaluateReadback,
  gateEnv,
  gateSteps,
  runGate,
  scanText,
} from '../../scripts/release-gate.mjs';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const ADDRESS = `0x${'c'.repeat(40)}`;
const PINNED_BLOCK = 26_000_000;
const CANDIDATES = JSON.stringify({ chainId: 1, pinnedBlock: PINNED_BLOCK });
// Assembled only so the gate's scan does not match its own rule text here; no credential is involved.
const FOCUSED = ['it', 'on' + 'ly'].join('.');
const SKIPPED = ['test', 'sk' + 'ip'].join('.');
const NOTE = 'TO' + 'DO';
const T1 = '2026-10-31T10:00:00Z';
const T2 = '2026-10-31T11:00:00Z';

const USAGE = 'At most 16 RPC calls are in flight. PrunedStateError, classifyReadFailure, maxConcurrentReads.';

const entries = [{ contract: 'C', entry: 'e', blockTag: 'latest', verdict: 'pass' }];
const burst = { size: BURST_SIZE, ok: true, elapsedMs: 1 };
const goodReadback = () => ({
  chainId: SEPOLIA,
  exitCode: 0,
  reports: [
    { adapter: 'hh2', results: entries, burst },
    { adapter: 'hh3', results: entries, burst },
  ],
});
const goodMainnet = () => ({
  kind: 'mainnet-check',
  commit: HEAD,
  treeClean: true,
  chainId: 1,
  block: PINNED_BLOCK,
  corruptExpected: false,
  builtHere: true,
  outcome: 'pass',
  exitCode: 0,
  results: [
    { candidate: 'uni', verdict: 'pass', trivial: false },
    { candidate: 'pair', verdict: 'pass', trivial: false },
    { candidate: 'pair', verdict: 'pass', trivial: true },
  ],
});
const sealedManifest = () => ({
  chains: { [SEPOLIA]: { generations: [{ contracts: { MockA: { address: ADDRESS, sealBlock: 5 } } }] } },
});
const NO_DEPLOYMENT = '{"chains":{}}';

const REMAINING = `The default concurrency is 16. PrunedStateError, classifyReadFailure, maxConcurrentReads, isSealed, BENCH_BASELINE.
`;
const versions = (pkg: string, lock: string) => ({
  pkg: JSON.stringify({ version: pkg, scripts: SCRIPTS }),
  lock: JSON.stringify({ version: lock, packages: { '': { version: lock } } }),
});

const SCRIPTS = Object.fromEntries(
  [
    'check:secrets',
    'check:workflows',
    'deployments:coverage',
    'test:unit',
    'typecheck:core',
    'typecheck:hh2',
    'typecheck:hh3',
    'test:e2e:hh2',
    'verify:package',
    'deployments:test',
    'deployments:e2e:local',
    'readback:negative-control',
    'readback:scenarios',
    'deployments:cross-version',
    'oracle:layout',
    'oracle:values',
    'clients',
    'mainnet:check',
  ].map((name) => [name, 'x'])
);

/** A world where the gate passes. Each test then breaks exactly one thing. */
function world() {
  const files = new Map<string, string>([
    ['package.json', JSON.stringify({ version: '0.2.0', scripts: SCRIPTS })],
    ['package-lock.json', JSON.stringify({ version: '0.2.0', packages: { '': { version: '0.2.0' } } })],
    ['README.md', 'readme'],
    ['USAGE.md', USAGE],
    ['REMAINING.md', REMAINING],
    ['src/core/query/limiter.ts', 'const DEFAULT_MAX_CONCURRENT_READS = 16;'],
    ['deployments/manifest/deployments.json', JSON.stringify(sealedManifest())],
    ['deployments/mainnet/candidates.json', CANDIDATES],
    [`.release-evidence/mainnet-${HEAD}.json`, JSON.stringify(goodMainnet())],
    ['src/changed.ts', 'clean'],
  ]);
  const state = {
    files,
    calls: [] as string[],
    status: '',
    head: [HEAD],
    diff: {} as Record<string, string>,
    readback: (): { status: number | null; json?: string } => ({ status: 0, json: JSON.stringify(goodReadback()) }),
    exitOf: {} as Record<string, number | null>,
    gh: { status: 1, stdout: '' } as { status: number | null; stdout: string },
  };
  const deps: GateDeps = {
    git(args) {
      if (args[0] === 'rev-parse') return { status: 0, stdout: `${state.head[0]}\n` };
      if (args[0] === 'status') return { status: 0, stdout: state.status };
      const key = args.includes('--') ? 'fixtures' : 'changed';
      if (args.includes('ls-files')) return { status: 0, stdout: key === 'changed' ? '' : '' };
      const ref = args.includes('--') ? args[args.indexOf('--') - 1]! : args.at(-1)!;
      if (state.diff[`missing:${ref}`] !== undefined) return { status: 128, stdout: '' };
      return { status: 0, stdout: state.diff[key] ?? (key === 'changed' ? 'src/changed.ts\n' : '') };
    },
    async exec(command, args) {
      const line = [command, ...args].join(' ');
      state.calls.push(line);
      if (command === 'gh') return state.gh;
      if (line.includes('readback.mjs')) {
        const { status, json } = state.readback();
        const out = args[args.indexOf('--json') + 1]!;
        if (json !== undefined) files.set(out, json);
        return { status, stdout: '' };
      }
      // As npm does for a script that does not exist.
      const script = command === 'npm' && args[0] === 'run' ? args[1]! : undefined;
      if (script !== undefined && JSON.parse(files.get('package.json')!).scripts[script] === undefined) {
        return { status: 1, stdout: '' };
      }
      const hit = Object.keys(state.exitOf).find((name) => line.includes(name));
      return { status: hit === undefined ? 0 : state.exitOf[hit]!, stdout: '' };
    },
    readText: (file) => files.get(file),
    writeText: (file, text) => void files.set(file, text),
    clear: (file) => void files.delete(file),
    log() {},
    now: () => '2026-10-31T00:00:00.000Z',
  };
  return { state, deps };
}

const stepOf = (report: Awaited<ReturnType<typeof runGate>>, name: string) =>
  report.steps.find((step) => step.name.includes(name));
/** The one non-pass step a stopped run ended on. */
const stoppedAt = (report: Awaited<ReturnType<typeof runGate>>) =>
  report.steps.find((step) => step.status !== 'pass');

describe('a full run', () => {
  it('passes, in the plan order, with the bump outstanding, and writes bound evidence', async () => {
    const { state, deps } = world();
    const report = await runGate(deps);
    expect(report).toMatchObject({ outcome: 'pass', exitCode: 0, head: HEAD });
    expect(report.steps.every((step) => step.status === 'pass')).toBe(true);
    expect(stepOf(report, 'consistency')?.detail).toContain('bump outstanding');

    const order = ['test:unit', 'typecheck:core', 'test:e2e:hh2', 'run-e2e.mjs hh3', 'verify:package', 'oracle:layout', 'clients', 'readback.mjs'];
    const seen = order.map((name) => state.calls.findIndex((call) => call.includes(name)));
    expect(seen.every((at) => at >= 0)).toBe(true);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));

    const evidence = JSON.parse(state.files.get(`.release-evidence/release-gate-${HEAD}.json`)!);
    expect(evidence).toMatchObject({ commit: HEAD, result: 'pass', exitCode: 0 });
  });

  it('stops at the first non-pass and runs nothing after it', async () => {
    const { state, deps } = world();
    state.exitOf['typecheck:hh2'] = 2;
    const report = await runGate(deps);
    expect(report).toMatchObject({ outcome: 'fail', exitCode: 1 });
    expect(state.calls.some((call) => call.includes('verify:package'))).toBe(false);
    expect(stepOf(report, 'verify:package')?.status).toBe('not-run');
    const evidence = JSON.parse(state.files.get(`.release-evidence/release-gate-${HEAD}.json`)!);
    expect(evidence.result).toBe('fail');
  });
});

describe('each condition blocks on its own', () => {
  type World = ReturnType<typeof world>;
  const remove = (script: string) => ({ state }: World) => {
    const manifest = JSON.parse(state.files.get('package.json')!);
    delete manifest.scripts[script];
    state.files.set('package.json', JSON.stringify(manifest));
  };
  const forbiddenChange = (text: string) => ({ state }: World) => void state.files.set('src/changed.ts', text);
  // Clients have to be out of the way for the CI cases, since a local pass settles AC 19.
  const clientsOut = ({ state }: World) => void (state.exitOf['clients -- all'] = 3);

  it.each<[string, (w: World) => void, 'fail' | 'could-not-check', string]>([
    ['a dirty tree', ({ state }) => void (state.status = ' M src/x.ts\n'), 'could-not-check', 'tree clean'],
    ['a focused test', forbiddenChange(`${FOCUSED}('x')`), 'fail', 'no focused'],
    ['a skipped test', forbiddenChange(`${SKIPPED}('x')`), 'fail', 'no focused'],
    ['a placeholder note', forbiddenChange(`// ${NOTE} later`), 'fail', 'no focused'],
    ['a changed fixture', ({ state }) => void (state.diff.fixtures = 'test/fixtures/contracts/A.sol\n'), 'fail', 'fixtures'],
    ['no main branch to compare with', ({ state }) => void (state.diff['missing:main'] = 'x'), 'could-not-check', 'no focused'],
    ['docs that disagree', ({ state }) => void state.files.set('USAGE.md', 'nothing'), 'fail', 'consistency'],
    ['a partial version bump', ({ state }) => void state.files.set('package-lock.json', JSON.stringify({ version: RELEASE_VERSION, packages: { '': { version: RELEASE_VERSION } } })), 'fail', 'consistency'],
    ['failing unit tests', ({ state }) => void (state.exitOf['test:unit'] = 1), 'fail', 'test:unit'],
    ['failing e2e', ({ state }) => void (state.exitOf['run-e2e.mjs hh3'] = 1), 'fail', 'test:e2e:hh3'],
    ['failing verify:package', ({ state }) => void (state.exitOf['verify:package'] = 1), 'fail', 'verify:package'],
    ['a timed-out command', ({ state }) => void (state.exitOf['test:unit'] = null), 'could-not-check', 'test:unit'],
    ['a missing oracle command', remove('oracle:layout'), 'fail', 'oracle:layout'],
    ['a missing workflow lint', remove('check:workflows'), 'fail', 'check:workflows'],
    ['a docs check that cannot catch drift', ({ state }) => void (state.exitOf['check-docs-manifest.mjs --self-test'] = 1), 'fail', 'docs check self-test'],
    ['docs that disagree with the manifest', ({ state }) => void (state.exitOf['check-docs-manifest.mjs'] = 1), 'fail', 'docs check self-test'],
    ['an oracle that disagrees', ({ state }) => void (state.exitOf['oracle:values'] = 1), 'fail', 'oracle:values'],
    ['a client that disagrees', ({ state }) => void ((state.exitOf['clients -- all'] = 1), (state.gh = { status: 0, stdout: JSON.stringify([{ headSha: HEAD, event: 'push', status: 'completed', conclusion: 'success', createdAt: T1 }]) })), 'fail', 'clients'],
    ['failing fault scenarios', ({ state }) => void (state.exitOf['readback:scenarios'] = 1), 'fail', 'readback:scenarios'],
    ['failing cross-version reads', ({ state }) => void (state.exitOf['deployments:cross-version'] = 1), 'fail', 'deployments:cross-version'],
    ['a failing local example', ({ state }) => void (state.exitOf['read:local'] = 1), 'fail', 'example reads'],
    ['mainnet candidates that no longer qualify', ({ state }) => void (state.exitOf['--candidates'] = 1), 'fail', 'mainnet candidates'],
    ['a failing mainnet self-test', ({ state }) => void (state.exitOf['mainnet:check -- --self-test'] = 1), 'fail', 'mainnet check self-test'],
    ['Sourcify could not be asked', ({ state }) => void (state.exitOf['check-sourcify.mjs --chain 11155111'] = 3), 'could-not-check', 'Sourcify'],
    ['a Sourcify mismatch', ({ state }) => void (state.exitOf['check-sourcify.mjs --chain 11155111'] = 1), 'fail', 'Sourcify'],
    ['a wrong version in all three fields', ({ state }) => { const { pkg, lock } = versions('1.0.1', '1.0.1'); state.files.set('package.json', pkg); state.files.set('package-lock.json', lock); }, 'fail', 'consistency'],
    ['a wrong version in the lock alone', ({ state }) => void state.files.set('package-lock.json', versions('0.2.0', '0.0.9').lock), 'fail', 'consistency'],
    ['no Geth or Reth and no gh', clientsOut, 'could-not-check', 'clients'],
    ['no clients command', remove('clients'), 'fail', 'clients'],
    ['no mainnet report', ({ state }) => void state.files.delete(`.release-evidence/mainnet-${HEAD}.json`), 'could-not-check', 'mainnet'],
    ['a stale mainnet report', ({ state }) => void state.files.set(`.release-evidence/mainnet-${HEAD}.json`, JSON.stringify({ ...goodMainnet(), commit: OTHER })), 'could-not-check', 'mainnet'],
    ['a mainnet check that could not check', ({ state }) => void state.files.set(`.release-evidence/mainnet-${HEAD}.json`, JSON.stringify({ ...goodMainnet(), exitCode: 3 })), 'could-not-check', 'mainnet'],
    ['no Sepolia deployment', ({ state }) => void state.files.set('deployments/manifest/deployments.json', NO_DEPLOYMENT), 'could-not-check', 'Sepolia read-back'],
    ['read-back exit 3', ({ state }) => void (state.readback = () => ({ status: 3 })), 'could-not-check', 'Sepolia'],
    ['read-back exit 1', ({ state }) => void (state.readback = () => ({ status: 1 })), 'fail', 'Sepolia'],
    ['a rejected burst with exit 0', ({ state }) => void (state.readback = () => ({ status: 0, json: JSON.stringify({ ...goodReadback(), reports: [{ adapter: 'hh2', results: entries, burst }, { adapter: 'hh3', results: entries, burst: { ...burst, ok: false, detail: 'Error: 429' } }] }) })), 'fail', 'Sepolia'],
    ['HEAD moving during the run', ({ state, deps }) => { const exec = deps.exec; deps.exec = async (c, a, o) => { state.head[0] = OTHER; return exec(c, a, o); }; }, 'fail', 'HEAD unmoved'],
  ])('%s', async (_name, breakIt, outcome, stepName) => {
    const scene = world();
    breakIt(scene);
    const report = await runGate(scene.deps);
    expect(report.outcome).toBe(outcome);
    expect(report.exitCode).toBe(outcome === 'fail' ? 1 : 3);
    expect(stoppedAt(report)?.name).toContain(stepName);
    expect(stoppedAt(report)?.status).toBe(outcome);
  });

  it('accepts a commit-bound CI run for AC 19 when local clients could not run', async () => {
    const scene = world();
    clientsOut(scene);
    scene.state.gh = { status: 0, stdout: JSON.stringify([{ headSha: HEAD, event: 'push', status: 'completed', conclusion: 'success', createdAt: T1 }]) };
    const report = await runGate(scene.deps);
    expect(report.outcome).toBe('pass');
    expect(stepOf(report, 'clients')?.detail).toContain(HEAD);
  });

  it('does not take an earlier run\'s read-back file for this run', async () => {
    const scene = world();
    scene.state.files.set(`.release-evidence/readback-${HEAD}.json`, JSON.stringify(goodReadback()));
    scene.state.readback = () => ({ status: 0 });
    const report = await runGate(scene.deps);
    expect(report.outcome).toBe('could-not-check');
    expect(stoppedAt(report)?.detail).toContain('no readable JSON');
  });
});

describe('a step that timed out and could not be killed', () => {
  // A zero status too, to show that the failed kill alone decides.
  const withFailedKill = (scene: ReturnType<typeof world>, match: string, status: number | null) => {
    const exec = scene.deps.exec;
    scene.deps.exec = async (command, args, options) => {
      const line = [command, ...args].join(' ');
      return line.includes(match) ? { status, stdout: '', killFailed: true } : exec(command, args, options);
    };
  };

  it.each<[string, string, string]>([
    ['an ordinary step', 'test:unit', 'test:unit'],
    ['the local clients, even with CI evidence', 'clients -- all', 'clients'],
    ['the read-back', 'readback.mjs', 'Sepolia read-back'],
  ])('blocks %s as could-not-check', async (_name, match, stepName) => {
    for (const status of [null, 0]) {
      const scene = world();
      scene.state.gh = { status: 0, stdout: JSON.stringify([{ headSha: HEAD, event: 'push', status: 'completed', conclusion: 'success', createdAt: T1 }]) };
      withFailedKill(scene, match, status);
      const report = await runGate(scene.deps);
      expect(report).toMatchObject({ outcome: 'could-not-check', exitCode: 3 });
      expect(stoppedAt(report)?.name).toContain(stepName);
      expect(stoppedAt(report)?.detail).toContain('could not be killed');
    }
  });
});

describe('evaluateReadback', () => {
  const adapters = (hh3: object) => JSON.stringify({ ...goodReadback(), reports: [{ adapter: 'hh2', results: entries, burst }, { adapter: 'hh3', results: entries, ...hh3 }] });

  it('passes only with both adapters and a real burst', () => {
    expect(evaluateReadback(0, JSON.stringify(goodReadback())).status).toBe('pass');
  });

  it.each<[string, number | null, string | undefined, string]>([
    ['exit 3', 3, JSON.stringify(goodReadback()), 'could-not-check'],
    ['exit 1', 1, JSON.stringify(goodReadback()), 'fail'],
    ['exit 2, as for no manifest', 2, undefined, 'could-not-check'],
    ['no exit code', null, undefined, 'could-not-check'],
    ['exit 0 with no file', 0, undefined, 'could-not-check'],
    ['exit 0 with bad JSON', 0, '{', 'could-not-check'],
    ['another chain', 0, JSON.stringify({ ...goodReadback(), chainId: 31337 }), 'could-not-check'],
    ['one adapter only', 0, JSON.stringify({ ...goodReadback(), reports: goodReadback().reports.slice(0, 1) }), 'could-not-check'],
    ['no entries', 0, JSON.stringify({ ...goodReadback(), reports: [goodReadback().reports[0], { adapter: 'hh3', results: [], burst }] }), 'could-not-check'],
    ['no burst', 0, adapters({}), 'could-not-check'],
    ['a rejected burst', 0, adapters({ burst: { ...burst, ok: false, detail: 'ProviderError 429' } }), 'fail'],
    ['a burst that did not run', 0, adapters({ burst: { ...burst, ok: false, detail: 'not run: no head, or no budget left, or no MockMappings entry' } }), 'could-not-check'],
    ['a short burst', 0, adapters({ burst: { ...burst, size: 299 } }), 'fail'],
    ['a latest entry unread beside exit 0', 0, JSON.stringify({ ...goodReadback(), reports: [goodReadback().reports[0], { adapter: 'hh3', results: [{ blockTag: 'latest', verdict: 'needs-archive' }], burst }] }), 'could-not-check'],
    ['a wrong entry beside exit 0', 0, JSON.stringify({ ...goodReadback(), reports: [goodReadback().reports[0], { adapter: 'hh3', results: [{ blockTag: 5, verdict: 'wrong' }], burst }] }), 'fail'],
  ])('%s', (_name, status, text, expected) => {
    expect(evaluateReadback(status, text).status).toBe(expected);
  });

  it('allows a historic entry a node could not serve', () => {
    const results = [...entries, { blockTag: 5, verdict: 'needs-archive' }];
    const text = JSON.stringify({ ...goodReadback(), reports: [goodReadback().reports[0], { adapter: 'hh3', results, burst }] });
    expect(evaluateReadback(0, text).status).toBe('pass');
  });
});

describe('evaluateMainnetReport', () => {
  const text = (changes: object) => JSON.stringify({ ...goodMainnet(), ...changes });

  it.each<[string, string | undefined, string]>([
    ['good', text({}), 'pass'],
    ['missing', undefined, 'could-not-check'],
    ['not JSON', '{', 'could-not-check'],
    ['another commit', text({ commit: OTHER }), 'could-not-check'],
    ['a short commit', text({ commit: HEAD.slice(0, 8) }), 'could-not-check'],
    ['a dirty tree', text({ treeClean: false }), 'could-not-check'],
    ['no clean flag', text({ treeClean: undefined }), 'could-not-check'],
    ['exit 3', text({ exitCode: 3 }), 'could-not-check'],
    ['no exit code', text({ exitCode: undefined }), 'could-not-check'],
    ['exit 1', text({ exitCode: 1 }), 'fail'],
    ['a wrong value beside exit 0', text({ results: [{ verdict: 'wrong' }] }), 'fail'],
    ['an unchecked value beside exit 0', text({ results: [{ verdict: 'could-not-check' }] }), 'could-not-check'],
    ['no values', text({ results: [] }), 'could-not-check'],
    ['all values zero', text({ results: [{ candidate: 'uni', verdict: 'pass', trivial: true }, { candidate: 'pair', verdict: 'pass', trivial: true }] }), 'could-not-check'],
    ['one contract all zero', text({ results: [{ candidate: 'uni', verdict: 'pass', trivial: false }, { candidate: 'pair', verdict: 'pass', trivial: true }] }), 'could-not-check'],
    ['no trivial flag', text({ results: [{ candidate: 'uni', verdict: 'pass' }] }), 'could-not-check'],
    ['a negative-control run', text({ corruptExpected: true }), 'could-not-check'],
    ['a negative-control run that failed as it should', text({ corruptExpected: true, outcome: 'wrong', exitCode: 1 }), 'could-not-check'],
    ['no corruptExpected field', text({ corruptExpected: undefined }), 'could-not-check'],
    ['a packed existing dist/', text({ builtHere: false }), 'could-not-check'],
    ['no builtHere field', text({ builtHere: undefined }), 'could-not-check'],
    ['outcome could-not-check beside exit 0', text({ outcome: 'could-not-check' }), 'could-not-check'],
    ['no outcome field', text({ outcome: undefined }), 'could-not-check'],
    ['outcome wrong beside exit 0', text({ outcome: 'wrong' }), 'fail'],
    ['an outcome of wrong with its exit code', text({ outcome: 'wrong', exitCode: 1 }), 'fail'],
    ['a block that is not the pinned one, as a recent run would have', text({ block: PINNED_BLOCK + 1 }), 'could-not-check'],
    ['another chain', text({ chainId: 11155111 }), 'could-not-check'],
    ['some other JSON file', text({ kind: 'other' }), 'could-not-check'],
    ['no block', text({ block: undefined }), 'could-not-check'],
    ['a URL left in it', text({ endpoint: 'https://archive.example.com/v2/abcdef' }), 'fail'],
  ])('%s', (_name, report, expected) => {
    expect(evaluateMainnetReport(report, HEAD, CANDIDATES).status).toBe(expected);
  });

  it('does not quote a URL it rejects', () => {
    const { detail } = evaluateMainnetReport(text({ endpoint: 'https://archive.example.com/v2/abcdef' }), HEAD, CANDIDATES);
    expect(detail).not.toContain('example.com');
  });

  it('cannot pass without a pinned block to compare with', () => {
    expect(evaluateMainnetReport(text({}), HEAD, undefined).status).toBe('could-not-check');
  });

  it('accepts the fields scripts/mainnet-check.mjs writes, at the block candidates.json pins', () => {
    const candidates = readFileSync('deployments/mainnet/candidates.json', 'utf8');
    const { pinnedBlock } = JSON.parse(candidates) as { pinnedBlock: number };
    expect(evaluateMainnetReport(text({ block: pinnedBlock }), HEAD, candidates).status).toBe('pass');
    const source = readFileSync('scripts/mainnet-check.mjs', 'utf8');
    for (const field of ['commit', 'treeClean', 'chainId', 'block', 'corruptExpected', 'builtHere', 'outcome', 'exitCode', 'kind']) {
      expect(source).toMatch(new RegExp(`\\b${field}\\b`));
    }
    // The per-value field and its values, which the gate reads and this script could rename.
    expect(source).toContain("verdict: actual === expected ? 'pass' : 'wrong'");
    expect(source).toContain("code === FAILED ? 'wrong' : 'could-not-check'");
  });
});

describe('evaluateCiRuns', () => {
  const run = (headSha: string, conclusion: string, status = 'completed', createdAt: string | undefined = T1) => ({ headSha, event: 'push', status, conclusion, createdAt });

  it.each<[string, unknown, string]>([
    ['success at HEAD', [run(HEAD, 'success')], 'pass'],
    ['a later success after a failure', [run(HEAD, 'failure'), run(HEAD, 'success', 'completed', T2)], 'pass'],
    ['a later failure after a success', [run(HEAD, 'success'), run(HEAD, 'failure', 'completed', T2)], 'fail'],
    ['the same, listed newest first', [run(HEAD, 'failure', 'completed', T2), run(HEAD, 'success')], 'fail'],
    ['a later run still going after a success', [run(HEAD, 'success'), run(HEAD, '', 'in_progress', T2)], 'could-not-check'],
    ['a later cancelled run after a success', [run(HEAD, 'success'), run(HEAD, 'cancelled', 'completed', T2)], 'could-not-check'],
    ['a newer failure at another commit does not count', [run(HEAD, 'success'), run(OTHER, 'failure', 'completed', T2)], 'pass'],
    ['a run with no creation time', [{ headSha: HEAD, event: 'push', status: 'completed', conclusion: 'success' }], 'could-not-check'],
    ['a successful pull_request run alone', [{ ...run(HEAD, 'success'), event: 'pull_request' }], 'could-not-check'],
    ['a failed pull_request run alone', [{ ...run(HEAD, 'failure'), event: 'pull_request' }], 'could-not-check'],
    ['a newer failed pull_request run does not mask a push success', [run(HEAD, 'success'), { ...run(HEAD, 'failure', 'completed', T2), event: 'pull_request' }], 'pass'],
    ['a newer successful pull_request run does not mask a push failure', [run(HEAD, 'failure'), { ...run(HEAD, 'success', 'completed', T2), event: 'pull_request' }], 'fail'],
    ['a run that does not say what started it', [{ headSha: HEAD, status: 'completed', conclusion: 'success', createdAt: T1 }], 'could-not-check'],
    ['a scheduled run', [{ ...run(HEAD, 'success'), event: 'schedule' }], 'pass'],
    ['success at another commit', [run(OTHER, 'success')], 'could-not-check'],
    ['no runs', [], 'could-not-check'],
    ['still running', [run(HEAD, '', 'in_progress')], 'could-not-check'],
    ['skipped', [run(HEAD, 'skipped')], 'could-not-check'],
    ['cancelled', [run(HEAD, 'cancelled')], 'could-not-check'],
    ['failure at HEAD', [run(HEAD, 'failure')], 'fail'],
  ])('%s', (_name, runs, expected) => {
    expect(evaluateCiRuns(JSON.stringify(runs), HEAD).status).toBe(expected);
  });

  it('does not crash on output that is not JSON', () => {
    expect(evaluateCiRuns('gh: not logged in', HEAD).status).toBe('could-not-check');
  });
});

describe('evaluateManifest', () => {
  it.each<[string, string | undefined, string]>([
    ['sealed', JSON.stringify(sealedManifest()), 'pass'],
    ['missing', undefined, 'could-not-check'],
    ['no Sepolia', '{"chains":{}}', 'could-not-check'],
    ['deployed, not sealed', JSON.stringify({ chains: { [SEPOLIA]: { generations: [{ contracts: { MockA: { sealBlock: null } } }] } } }), 'could-not-check'],
  ])('%s', (_name, text, expected) => {
    expect(evaluateManifest(text).status).toBe(expected);
  });
});

describe('preflight', () => {
  it('runs no command but gh, writes nothing, and lists everything outstanding', async () => {
    const { state, deps } = world();
    state.status = ' M src/x.ts\n';
    state.files.delete(`.release-evidence/mainnet-${HEAD}.json`);
    state.files.set('deployments/manifest/deployments.json', '{"chains":{}}');
    const before = new Set(state.files.keys());
    const report = await runGate(deps, { preflight: true });
    expect(report).toMatchObject({ outcome: 'could-not-check', exitCode: 3 });
    expect(state.calls.every((call) => call.startsWith('gh '))).toBe(true);
    expect([...state.files.keys()].every((file) => before.has(file))).toBe(true);
    for (const name of ['tree clean', 'clients', 'mainnet report', 'Sepolia']) {
      expect(stepOf(report, name)?.status).toBe('could-not-check');
    }
    expect(stepOf(report, 'test:unit')?.status).toBe('not-run');
  });
});

describe('what the gate must not do', () => {
  it('names no publish, push or tag, and no bare publish in the scripts it runs', () => {
    const commands = gateSteps().flatMap((step) => step.command ?? []);
    expect(commands.length).toBeGreaterThan(15);
    for (const command of commands) expect(command).not.toMatch(/\b(publish|push|tag)\b/);
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(scripts['verify:package']).toContain('npm publish --dry-run');
    expect(scripts['verify:package']!.match(/npm publish(?! --dry-run)/)).toBeNull();
  });

  it('counts the real starting versions as a bump still to come', async () => {
    const { state, deps } = world();
    state.files.set('package-lock.json', versions('0.2.0', '0.1.0').lock);
    const report = await runGate(deps);
    expect(report.outcome).toBe('pass');
    expect(stepOf(report, 'consistency')?.detail).toContain('bump outstanding');
  });

  it('accepts a full bump to the release version', async () => {
    const { state, deps } = world();
    const { pkg, lock } = versions(RELEASE_VERSION, RELEASE_VERSION);
    state.files.set('package.json', pkg);
    state.files.set('package-lock.json', lock);
    expect((await runGate(deps)).outcome).toBe('pass');
  });

  it('keeps the settings the read-back needs, so it falls to its keyless defaults', () => {
    const kept = gateEnv({ READBACK_BURST: '1', READBACK_CHAIN: '1', READBACK_RPC_URL: 'x', READBACK_SECOND_RPC_URL: 'x' });
    expect(Object.keys(kept).sort()).toEqual(['READBACK_BURST', 'READBACK_CHAIN']);
  });

  it('drops keys and private URLs from what children see, by name', () => {
    const env = {
      PATH: 'p',
      HOME: 'h',
      ETHERSCAN_KEY: 'x',
      my_custom_key_file: 'x',
      SOME_Token: 'x',
      A_SECRET_THING: 'x',
      WALLET_MNEMONIC: 'x',
      DB_PASSWORD: 'x',
      OWN_RPC_URL_2: 'x',
      SEPOLIA_RPC_URL: 'x',
      READBACK_RPC_URL: 'x',
      READBACK_SECOND_RPC_URL: 'x',
      MAINNET_ARCHIVE_RPC_URL: 'x',
      FORK_URL: 'x',
      SEPOLIA_DEPLOYER_KEY: 'x',
      HARDHAT_VAR_SEPOLIA_KEY: 'x',
      ETHERSCAN_API_KEY: 'x',
      NPM_TOKEN: 'x',
      GH_TOKEN: 'x',
    };
    expect(Object.keys(gateEnv(env)).sort()).toEqual(['HOME', 'PATH']);
    expect(Object.keys(gateEnv(env, ['GH_TOKEN'])).sort()).toEqual(['GH_TOKEN', 'HOME', 'PATH']);
  });

  it('compares with a baseline that survives the merge into main', () => {
    expect(RELEASE_BASELINE).toMatch(/^[0-9a-f]{40}$/);
  });

  it('rejects an unknown flag with a usage error', () => {
    const { status } = spawnSync(process.execPath, ['scripts/release-gate.mjs', '--force']);
    expect(status).toBe(2);
  });
});

describe('a missing script', () => {
  it('fails under the real npm, which is what the gate reads as a failure', () => {
    const { status } = spawnSync('npm', ['run', 'no-such-script'], { shell: process.platform === 'win32' });
    expect(status).toBe(1);
  });
});

describe('scanText', () => {
  it.each([
    [`${FOCUSED}('x', f)`, 1],
    [`describe.${'on' + 'ly'}('x', f)`, 1],
    [`${SKIPPED}('x', f)`, 1],
    [`// ${NOTE}: later`, 1],
    [`it.each([])`, 0],
    ['the only way to skip it', 0],
    [`todo in lower case`, 0],
  ])('%s', (text, count) => {
    expect(scanText(text)).toHaveLength(count);
  });
});

describe('checkConsistency', () => {
  const read = (overrides: Record<string, string | undefined> = {}) => {
    const { state } = world();
    return (file: string) => (file in overrides ? overrides[file] : state.files.get(file));
  };
  const lock = (version: string) => JSON.stringify({ version, packages: { '': { version } } });
  const pkg = (version: string) => JSON.stringify({ version, scripts: { bench: 'x' } });

  it('passes for the version the files read, and reports each file for another', () => {
    expect(checkConsistency('0.2.0', read())).toEqual({ version: [], docs: [] });
    const { version, docs } = checkConsistency(RELEASE_VERSION, read());
    expect(docs).toEqual([]);
    expect(version.map(({ file }) => file)).toEqual(['package.json', 'package-lock.json', 'package-lock.json']);
  });

  it('passes the same docs after the bump, since the bump changes nothing else', () => {
    const bumped = read({ 'package.json': pkg(RELEASE_VERSION), 'package-lock.json': lock(RELEASE_VERSION) });
    expect(checkConsistency(RELEASE_VERSION, bumped)).toEqual({ version: [], docs: [] });
  });

  it.each<[string, Record<string, string | undefined>, RegExp]>([
    ['a missing doc', { 'README.md': undefined }, /README\.md is missing/],
    ['a pinned version', { 'README.md': 'npm i hardhat-storage-decoder@0.2.0' }, /pins the package/],
    ['no stated default', { 'USAGE.md': 'PrunedStateError classifyReadFailure maxConcurrentReads' }, /default concurrency/],
    ['a missing term', { 'REMAINING.md': REMAINING.replace('isSealed', 'x') }, /isSealed/],
    ['an npm script that does not exist', { 'README.md': 'npm run nope' }, /npm run nope/],
    ['a limiter with no default', { 'src/core/query/limiter.ts': '' }, /default concurrency/],
  ])('reports %s', (_name, overrides, expected) => {
    expect(checkConsistency('0.2.0', read(overrides)).docs.join('\n')).toMatch(expected);
  });

  it('reports a script the docs name that package.json does not have', () => {
    const withDoc = read({ 'docs/public-testnet.md': 'npm run nope' });
    expect(checkConsistency('0.2.0', withDoc).docs.join('\n')).toMatch(/docs\/public-testnet\.md names npm run nope/);
  });

  it('accepts the testnet doc when all its scripts exist', () => {
    expect(checkConsistency('0.2.0', read({ 'docs/public-testnet.md': 'npm run clients' })).docs).toEqual([]);
  });
});
