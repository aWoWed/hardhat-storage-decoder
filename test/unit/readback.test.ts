/**
 * The read-back's rules without a chain: redaction, the exit code, coverage, the run budget, and
 * that a verdict comes from each entry's own read. `scripts/readback-scenarios.mjs` runs the command
 * for real.
 */
import { describe, expect, it } from 'vitest';
import {
  type AdapterLink,
  RunBudget,
  RunBudgetSpent,
  withRetries,
  confirmOnSecond,
  floorOf,
  manifestDifferences,
  runReadBack,
  uncoveredVariables,
} from '../../deployments/shared/readback-core.js';
import { applyPath, parseEntryName, toManifestValue } from '../../deployments/shared/manifest.js';
import type { Generation } from '../../deployments/shared/manifest.js';
import { startFakeRpc } from '../../deployments/shared/fake-rpc-server.mjs';
import { randomBytes } from 'node:crypto';
import { exitCodeOf } from '../../scripts/readback-exit-code.mjs';
import { makeRedactor, redactDeep } from '../../scripts/redact.mjs';
import { ContractMismatchError, PrunedStateError, classifyReadFailure } from '../../src/core/index.js';

const PATH_TOKEN = randomBytes(16).toString('hex');
const QUERY_TOKEN = randomBytes(16).toString('hex');
const PASSWORD = randomBytes(16).toString('hex');
const UNSEEN_TOKEN = randomBytes(16).toString('hex');
const helpers = { applyPath, parseEntryName, toManifestValue };

/** A plan this generation meets exactly, for the tests about something else. */
const planOf = (generation: Generation) => ({
  entries: Object.fromEntries(
    Object.entries(generation.contracts).map(([name, { expected }]) => [name, Object.keys(expected)])
  ),
  steps: [],
  history: { contract: '', entry: '', stepPrefix: 'none:' },
});

describe('the manifest against the plan', () => {
  const plan = {
    entries: { C: ['owner', 'numbers[0]', 'numbers[1]'] },
    steps: ['deploy:C', 'C:setRevision:0'],
    history: { contract: 'C', entry: 'revision', stepPrefix: 'C:setRevision:' },
  };
  const whole = (): Generation =>
    ({
      steps: [
        { id: 'deploy:C', nonce: 0, txHash: '0x1', block: 1 },
        { id: 'C:setRevision:0', nonce: 1, txHash: '0x2', block: 2 },
      ],
      contracts: {
        C: {
          address: '0x1',
          expected: { owner: {}, 'numbers[0]': {}, 'numbers[1]': {}, 'revision@2': {} },
        },
      },
    }) as unknown as Generation;

  it('finds nothing in a whole manifest', () => {
    expect(manifestDifferences(plan, whole())).toEqual([]);
  });

  it.each(['numbers[1]', 'revision@2', 'owner'])('names %s when it is deleted', (entry) => {
    const generation = whole();
    delete generation.contracts.C?.expected[entry];
    expect(manifestDifferences(plan, generation)).toEqual([
      { contract: 'C', entry, detail: 'this planned entry is missing from the manifest' },
    ]);
  });

  it('names a confirmed step deleted, and the history it would have required goes with it', () => {
    const generation = whole();
    generation.steps.pop();
    const found = manifestDifferences(plan, generation);
    expect(found).toContainEqual({
      contract: '(steps)',
      entry: 'C:setRevision:0',
      detail: 'this planned step is missing from the manifest',
    });
  });

  it('names an entry the plan does not have', () => {
    const generation = whole();
    (generation.contracts.C as { expected: Record<string, unknown> }).expected['numbers[9]'] = {};
    expect(manifestDifferences(plan, generation)).toEqual([
      { contract: 'C', entry: 'numbers[9]', detail: 'the seed plan has no such entry' },
    ]);
  });

  it('asks for the entry of an extra change too', () => {
    const generation = whole();
    generation.steps.push({ id: 'C:setRevision:extra-1', nonce: 2, txHash: '0x3', block: 9 });
    expect(manifestDifferences(plan, generation).map(({ entry }) => entry)).toEqual(['revision@9']);
  });
});

describe('redaction', () => {
  const pathUrl = `https://rpc.example.com/v3/${PATH_TOKEN}`;
  const queryUrl = `https://user:${PASSWORD}@rpc.example.org/sepolia?apikey=${QUERY_TOKEN}&x=1`;
  const redact = makeRedactor([pathUrl, queryUrl, undefined]);

  it.each([
    ['a whole URL', `failed: ${pathUrl}`],
    ['a query URL', `failed: ${queryUrl}`],
    ['a bare path token', `invalid key ${PATH_TOKEN}.`],
    ['a bare query token', `{"error":"bad ${QUERY_TOKEN}"}`],
    ['a password', `denied for ${PASSWORD}`],
    ['a URL this run never saw', `upstream https://other.example.net/v2/${UNSEEN_TOKEN} is down`],
    ['a URL with no scheme', `upstream other.example.net/v2/${UNSEEN_TOKEN} is down`],
  ])('removes %s', (_name, text) => {
    const clean = redact(text);
    for (const leaked of [PATH_TOKEN, QUERY_TOKEN, PASSWORD, UNSEEN_TOKEN]) {
      expect(clean).not.toContain(leaked);
    }
  });

  it('removes a 64-hex word', () => {
    expect(redact(`key 0x${'ab'.repeat(32)}`)).toBe('key <hex>');
  });

  it('leaves a source path and an address alone', () => {
    const text = 'contracts/MockPacked.sol:MockPacked at 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
    expect(redact(text)).toBe(text);
  });

  it('reaches every string of a report, keys included', () => {
    const report = { reports: [{ detail: `at ${pathUrl}`, [PATH_TOKEN]: 1, n: 2 }] };
    const text = JSON.stringify(redactDeep(report, redact));
    expect(text).not.toContain(PATH_TOKEN);
    expect(text).toContain('"n":2');
  });
});

describe('the exit code', () => {
  const entry = (verdict: string, blockTag: 'latest' | number = 'latest') =>
    ({ contract: 'C', entry: 'e', blockTag, verdict }) as never;

  it.each([
    [0, [entry('pass')]],
    [0, [entry('pass'), entry('needs-archive', 5)]],
    [0, [entry('pass'), entry('could-not-check', 5)]],
    [1, [entry('wrong')]],
    [1, [entry('wrong', 5)]],
    [1, [entry('wrong', 5), entry('could-not-check'), entry('needs-archive')]],
    [3, [entry('could-not-check')]],
    [3, [entry('needs-archive')]],
  ])('is %i', (code, results) => {
    expect(exitCodeOf(results)).toBe(code);
  });

  const single = ['pass', 'wrong', 'could-not-check', 'needs-archive'].flatMap((verdict) =>
    (['latest', 5] as const).map((blockTag) => ({ blockTag, verdict }))
  );
  const tables: (typeof single)[] = [[]];
  for (const a of single) {
    tables.push([a]);
    for (const b of single) {
      tables.push([a, b]);
      for (const c of single) tables.push([a, b, c]);
    }
  }

  it(`follows the rule on all ${tables.length} combinations, and each code occurs`, () => {
    const seen = new Set<number>();
    for (const results of tables) {
      const wrong = results.some(({ verdict }) => verdict === 'wrong');
      const unread = results.some(({ blockTag, verdict }) => blockTag === 'latest' && verdict !== 'pass');
      const code = exitCodeOf(results);
      seen.add(code);
      expect(code, JSON.stringify(results)).toBe(wrong ? 1 : unread ? 3 : 0);
    }
    expect([...seen].sort()).toEqual([0, 1, 3]);
  });
});

describe('coverage', () => {
  it('finds a variable with no entry, whatever path the others use', () => {
    const variables = [{ label: 'a' }, { label: 'b' }, { label: 'c' }];
    expect(uncoveredVariables(variables, ['a', 'b{n:1}[2].x'], helpers)).toEqual([{ label: 'c' }]);
  });

  it('tells shadowed variables apart by their declaring contract', () => {
    const variables = [
      { label: 'shared', declaredIn: 'Base' },
      { label: 'shared', declaredIn: 'Derived' },
    ];
    expect(uncoveredVariables(variables, ['Base::shared'], helpers)).toEqual([variables[1]]);
  });
});

describe('the floor', () => {
  const base = { contracts: {}, steps: [{ block: 7 }, { block: 9 }] } as unknown as Generation;

  it('is the last confirmed step of an unsealed deployment', () => {
    expect(floorOf(base)).toBe(9);
  });

  it('is the seal block once there is one', () => {
    const sealed = { ...base, contracts: { C: { sealBlock: 12 } } } as unknown as Generation;
    expect(floorOf(sealed)).toBe(12);
  });
});

describe('the run budget', () => {
  it('sends nothing once spent, and its refusal counts as an RPC failure', async () => {
    const budget = new RunBudget(2);
    const fail = () => Promise.reject(new Error('down'));
    await expect(budget.send(fail)).rejects.toThrow('down');
    await expect(budget.send(fail)).rejects.toThrow('down');
    let sent = false;
    const refused = await budget
      .send(async () => {
        sent = true;
      })
      .catch((error: unknown) => error);
    expect(sent).toBe(false);
    expect(refused).toBeInstanceOf(RunBudgetSpent);
    expect(classifyReadFailure(refused)).toBe('rpc');
  });
});

describe("the run's own calls", () => {
  it('survive a failed request, up to three attempts', async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls < 3) throw new Error('blip');
      return 'ok';
    };
    expect(await withRetries(flaky, new RunBudget(32), 0)).toBe('ok');
    calls = -10;
    await expect(withRetries(flaky, new RunBudget(32), 0)).rejects.toThrow('blip');
    expect(calls).toBe(-7);
  });

  it('stop when the budget is spent', async () => {
    const budget = new RunBudget(1);
    let calls = 0;
    const failing = () =>
      budget.send(async () => {
        calls += 1;
        throw new Error('down');
      });
    await expect(withRetries(failing, budget, 0)).rejects.toThrow('down');
    expect(calls).toBe(1);
  });
});

describe('the second endpoint', () => {
  const answer = (rule: Parameters<typeof startFakeRpc>[0]) => async () => {
    const server = await startFakeRpc(rule);
    try {
      return await confirmOnSecond(server.url, 31337, '0x01', 10);
    } finally {
      await server.close();
    }
  };
  const replies = (code: string, chain = '0x7a69', head = '0x20') => ({
    rule: ({ method }: { method: string }) =>
      ({ eth_chainId: { result: chain }, eth_blockNumber: { result: head }, eth_getCode: { result: code } })[method],
  });

  it.each([
    ['has-code', replies('0x60')],
    ['no-code', replies('0x')],
    ['unavailable', replies('0x', '0x1')],
    ['unavailable', replies('0x', '0x7a69', '0x1')],
    ['unavailable', { rule: () => ({ status: 503, body: '<html>' }) }],
    ['unavailable', { rule: () => ({ error: { code: -32000, message: 'no' } }) }],
  ])('answers %s', async (expected, rule) => {
    expect(await answer(rule as never)()).toBe(expected);
  });

  it('is unavailable when there is none', async () => {
    expect(await confirmOnSecond(undefined, 31337, '0x01', 10)).toBe('unavailable');
  });
});

describe('each entry has its own verdict', () => {
  const generation = {
    steps: [{ id: 'x', block: 10 }],
    contracts: {
      Wrong: {
        address: '0xbad',
        sealBlock: null,
        expected: { a: { value: '1', blockTag: 'latest', requiresArchive: false } },
      },
      Old: {
        address: '0xold',
        sealBlock: null,
        expected: {
          a: { value: '1', blockTag: 'latest', requiresArchive: false },
          'b@5': { value: '2', blockTag: 5, requiresArchive: true },
        },
      },
    },
  } as unknown as Generation;

  /** A wrong address beside a pruned entry: what `readMany` would report for both depends on timing. */
  function link(): AdapterLink {
    const query = (address: string, block: bigint | number) => ({
      name: () => query(address, block),
      at: (next: bigint | number) => query(address, next),
      read: async () => {
        if (address === '0xbad') throw new ContractMismatchError('x', address, 'differs');
        if (block === 5) throw new PrunedStateError(5, new Error('pruned'));
        return { value: 1n };
      },
    });
    return {
      name: 'test',
      decoder: {
        contract: () => ({ target: (address: string) => query(address, 0) }),
        readMany: async () => [],
      },
      classifyReadFailure,
      rpc: async (method) => (method === 'eth_chainId' ? '0x7a69' : '0x10'),
      budget: new RunBudget(32),
      storageVariables: async () => [],
    };
  }

  it('gives exit 1 for a wrong address alongside a pruned entry', async () => {
    const { results } = await runReadBack(link(), {
      helpers,
      chainId: 31337,
      generation,
      expectedContracts: [],
      plan: planOf(generation),
      noCodeWaitMs: 0,
      redact: (text) => text,
    });
    expect(results.map(({ contract, entry, verdict }) => `${contract} ${entry} ${verdict}`)).toEqual([
      'Wrong a wrong',
      'Old a pass',
      'Old b@5 needs-archive',
    ]);
    expect(exitCodeOf(results)).toBe(1);
  });

  it('calls a mock missing from the manifest wrong', async () => {
    const { results } = await runReadBack(link(), {
      helpers,
      chainId: 31337,
      generation,
      expectedContracts: ['Gone'],
      plan: planOf(generation),
      noCodeWaitMs: 0,
      redact: (text) => text,
    });
    expect(results[0]).toMatchObject({ contract: 'Gone', verdict: 'wrong' });
  });

  it('never reads a latest entry below the floor', async () => {
    const { results } = await runReadBack(
      { ...link(), rpc: async (method) => (method === 'eth_chainId' ? '0x7a69' : '0x9') },
      { helpers, chainId: 31337, generation, expectedContracts: [], plan: planOf(generation), noCodeWaitMs: 0, redact: (text) => text }
    );
    expect(results.filter(({ blockTag }) => blockTag === 'latest').map(({ verdict }) => verdict)).toEqual([
      'could-not-check',
      'could-not-check',
    ]);
  });

  it('marks everything could-not-check on another chain', async () => {
    const { results } = await runReadBack(
      { ...link(), rpc: async () => '0x1' },
      { helpers, chainId: 31337, generation, expectedContracts: [], plan: planOf(generation), noCodeWaitMs: 0, redact: (text) => text }
    );
    expect(new Set(results.map(({ verdict }) => verdict))).toEqual(new Set(['could-not-check']));
  });
});
