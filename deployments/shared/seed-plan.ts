/**
 * What gets deployed and seeded: one step per transaction, in order, with the values each one
 * leaves in storage. The transaction count of a seed is `seedSteps().length`, so the resume tests
 * can tell a duplicate from a planned transaction.
 */

import type { EntryPath, ManifestValue, PathSegment } from './manifest';

/**
 * `manifest.ts`'s `formatEntryName`, for the plan's own paths. A copy, and `seed.test.ts` holds the
 * two equal: this file is loaded by both Hardhat projects, and no one relative import works in both
 * (see `readback-core.ts`). It has no runtime import for that reason.
 */
function formatEntryName({ name, declaredIn, segments }: EntryPath): string {
  let text = declaredIn === undefined ? name : `${declaredIn}::${name}`;
  for (const segment of segments) {
    if ('key' in segment) {
      if (typeof segment.key === 'bigint') text += `{n:${segment.key}}`;
      else text += /^0x[0-9a-fA-F]{64}$/.test(segment.key) ? `{w:${segment.key}}` : `{s:${segment.key}}`;
    } else if ('index' in segment) {
      text += `[${segment.index}]`;
    } else {
      text += `.${segment.field}`;
    }
  }
  return text;
}

/** Public test values: these addresses have no known key and are only stored. */
const A = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
const B = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
const C = '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC';
const WORD_A = `0x${'11'.repeat(32)}`;
const WORD_B = `0x${'22'.repeat(32)}`;

/** 2^200 + 1 and friends: too wide for a JS number, so a lost bigint cannot pass. */
const BIG = (1n << 200n) + 1n;
const WIDE = (1n << 100n) + 3n;
const TAIL = (1n << 60n) + 5n;

const REVISION_VALUES = [11n, 22n, 33n];

/** Solidity keeps 31 bytes or fewer inline, and anything longer in data slots. */
const SHORT_MAX_BYTES = 31;

/** A step's value that exists only once the chain has run it. */
export type DynamicValue = 'callback' | 'op';

export interface SeedStep {
  id: string;
  contract: string;
  /** Absent for a deployment. */
  fn?: string;
  args: readonly unknown[];
  /** The entries this step leaves in storage, by `formatEntryName`. */
  sets: Record<string, ManifestValue>;
  dynamic?: Record<string, DynamicValue>;
  /** This step changes `revision`: its block is recorded and read back (AC 3). */
  recordsRevision?: boolean;
}

const path = (name: string, ...segments: PathSegment[]): string =>
  formatEntryName({ name, segments });
const inBase = (declaredIn: string, name: string, ...segments: PathSegment[]): string =>
  formatEntryName({ name, declaredIn, segments } satisfies EntryPath);
const key = (value: string | bigint): PathSegment => ({ key: value });
const index = (value: number): PathSegment => ({ index: value });
const field = (value: string): PathSegment => ({ field: value });

type Calls = Array<
  [fn: string, args: readonly unknown[], sets: SeedStep['sets'], extra?: Partial<SeedStep>]
>;

const CONSTRUCTOR_ARGS: Record<string, readonly unknown[]> = { MockImmutable: [1234n] };

const PLAN: Record<string, Calls> = {
  MockValueTypes: [
    ...REVISION_VALUES.map(
      (value): Calls[number] => [
        'setRevision',
        [value],
        { [path('revision')]: value.toString() },
        { recordsRevision: true },
      ]
    ),
    [
      'setNumbers',
      [BIG, -42n, true],
      {
        [path('unsignedValue')]: BIG.toString(),
        [path('signedValue')]: '-42',
        [path('flag')]: true,
      },
    ],
    [
      'setReferences',
      [A, WORD_A, '0xdeadbeef', B],
      {
        [path('account')]: A,
        [path('digest')]: WORD_A,
        [path('selectorValue')]: '0xdeadbeef',
        [path('token')]: B,
      },
    ],
    ['setCallback', [], {}, { dynamic: { [path('callback')]: 'callback' } }],
    ['setOp', [true], {}, { dynamic: { [path('op')]: 'op' } }],
  ],
  MockPacked: [
    [
      'setFirstSlot',
      [200n, 60000n, -7n, true, A],
      {
        [path('small')]: '200',
        [path('medium')]: '60000',
        [path('signedSmall')]: '-7',
        [path('enabled')]: true,
        [path('holder')]: A,
      },
    ],
    [
      'setSecondSlot',
      [WIDE, TAIL, '0x0102030405060708'],
      {
        [path('wide')]: WIDE.toString(),
        [path('tailA')]: TAIL.toString(),
        [path('tailB')]: '0x0102030405060708',
      },
    ],
  ],
  MockMappings: [
    ['setByAddress', [A, 1n], { [path('byAddress', key(A))]: '1' }],
    ['setByUint', [7n, 2n], { [path('byUint', key(7n))]: '2' }],
    ['setByInt', [-5n, 3n], { [path('byInt', key(-5n))]: '3' }],
    ['setByBytes32', [WORD_B, 4n], { [path('byBytes32', key(WORD_B))]: '4' }],
    ['setByString', ['alpha', 5n], { [path('byString', key('alpha'))]: '5' }],
    ['setByBytes', ['0xbeef', 6n], { [path('byBytes', key('0xbeef'))]: '6' }],
    ['setNested', [A, 9n, 7n], { [path('nested', key(A), key(9n))]: '7' }],
    ['setDeep', [B, 'mid', 3n, true], { [path('deep', key(B), key('mid'), key(3n))]: true }],
    ['pushToList', [4n, 8n], { [path('lists', key(4n), index(0))]: '8' }],
    ['pushToList', [4n, 9n], { [path('lists', key(4n), index(1))]: '9' }],
  ],
  MockArrays: [
    ['pushNumber', [101n], { [path('numbers', index(0))]: '101' }],
    ['pushNumber', [102n], { [path('numbers', index(1))]: '102' }],
    ['pushSmallNumber', [1n], { [path('smallNumbers', index(0))]: '1' }],
    ['pushSmallNumber', [2n], { [path('smallNumbers', index(1))]: '2' }],
    ['pushAccount', [C], { [path('accounts', index(0))]: C }],
    ['setFixedNumber', [1n, 103n], { [path('fixedNumbers', index(1))]: '103' }],
    ['setFixedSmall', [2n, 104n], { [path('fixedSmall', index(2))]: '104' }],
    ['setMatrix', [1n, 1n, 105n], { [path('matrix', index(1), index(1))]: '105' }],
    [
      'pushRow',
      [[106n, 107n]],
      {
        [path('rows', index(0), index(0))]: '106',
        [path('rows', index(0), index(1))]: '107',
      },
    ],
    ['pushRow', [[108n]], { [path('rows', index(1), index(0))]: '108' }],
  ],
  MockEnums: [
    ['setStatus', [2n], { [path('status')]: '2' }],
    ['setCountByStatus', [1n, 5n], { [path('countByStatus', key(1n))]: '5' }],
    ['pushHistory', [1n], { [path('history', index(0))]: '1' }],
    ['pushHistory', [2n], { [path('history', index(1))]: '2' }],
  ],
  MockStructs: [
    [
      'setPosition',
      [21n, A, true, [22n, -23n]],
      {
        [path('position', field('id'))]: '21',
        [path('position', field('holder'))]: A,
        [path('position', field('active'))]: true,
        [path('position', field('point'), field('x'))]: '22',
        [path('position', field('point'), field('y'))]: '-23',
      },
    ],
    ['setPositionLabel', ['position label'], { [path('position', field('label'))]: 'position label' }],
    ['pushPositionHistory', [24n], { [path('position', field('history'), index(0))]: '24' }],
    [
      'setPositionsEntry',
      [B, 25n, 'entry label'],
      {
        [path('positions', key(B), field('id'))]: '25',
        [path('positions', key(B), field('label'))]: 'entry label',
      },
    ],
    [
      'pushPoint',
      [[26n, -27n]],
      {
        [path('points', index(0), field('x'))]: '26',
        [path('points', index(0), field('y'))]: '-27',
      },
    ],
    ['setRootValue', [28n], { [path('root', field('value'))]: '28' }],
    [
      'setGrandchildValue',
      [1n, 2n, 29n],
      {
        [path(
          'root',
          field('children'),
          key(1n),
          field('children'),
          key(2n),
          field('value')
        )]: '29',
      },
    ],
  ],
  MockStrings: [
    // On each side of the boundary, so the encoding under test is the one the name states.
    ['setShortText', ['s'.repeat(31)], { [path('shortText')]: 's'.repeat(31) }],
    ['setLongText', ['l'.repeat(32)], { [path('longText')]: 'l'.repeat(32) }],
    ['setShortBlob', [`0x${'ab'.repeat(31)}`], { [path('shortBlob')]: `0x${'ab'.repeat(31)}` }],
    ['setLongBlob', [`0x${'cd'.repeat(70)}`], { [path('longBlob')]: `0x${'cd'.repeat(70)}` }],
  ],
  MockUserTypes: [
    [
      'setValues',
      [WORD_A, -31n, 32n],
      {
        [path('idValue')]: WORD_A,
        [path('signedValue')]: '-31',
        [path('amountValue')]: '32',
      },
    ],
    ['setById', [WORD_B, 33n], { [path('byId', key(WORD_B))]: '33' }],
    ['setBySigned', [-3n, 34n], { [path('bySigned', key(-3n))]: '34' }],
    ['setByAmount', [12n, 35n], { [path('byAmount', key(12n))]: '35' }],
  ],
  MockInheritance: [
    ['setRootValue', [41n], { [path('rootValue')]: '41' }],
    ['setMiddleBalance', [A, 42n], { [path('middleBalances', key(A))]: '42' }],
    ['setOwnLabel', ['own label'], { [path('ownLabel')]: 'own label' }],
  ],
  MockShadowed: [
    ['setBaseShared', [51n], { [inBase('MockShadowedBase', 'shared')]: '51' }],
    ['setBetween', [52n], { [path('between')]: '52' }],
    ['setBaseTable', [3n, 53n], { [inBase('MockShadowedBase', 'table', key(3n))]: '53' }],
    ['setDerivedShared', [54n], { [inBase('MockShadowed', 'shared')]: '54' }],
    ['setDerivedTable', [6n, 55n], { [inBase('MockShadowed', 'table', key(6n))]: '55' }],
  ],
  MockImmutable: [['setStored', [99n], { [path('stored')]: '99' }]],
};

export const MOCK_NAMES = Object.keys(PLAN);

export function seedSteps(): SeedStep[] {
  const steps: SeedStep[] = [];
  for (const [contract, calls] of Object.entries(PLAN)) {
    steps.push({
      id: `deploy:${contract}`,
      contract,
      args: CONSTRUCTOR_ARGS[contract] ?? [],
      sets: {},
    });
    calls.forEach(([fn, args, sets, extra], position) => {
      steps.push({ id: `${contract}:${fn}:${position}`, contract, fn, args, sets, ...extra });
    });
  }
  return steps;
}

export const sealSteps = (): SeedStep[] =>
  MOCK_NAMES.map((contract) => ({
    id: `seal:${contract}`,
    contract,
    fn: 'seal',
    args: [],
    sets: { [path('isSealed')]: true },
  }));

const EXTRA_REVISION_ID = /^MockValueTypes:setRevision:extra-(\d+)$/;

/** The step for the extra change that replaces a history read already pruned. */
export function extraRevisionStep(ordinal: number): SeedStep {
  const value = (REVISION_VALUES.at(-1) as bigint) + 11n * BigInt(ordinal);
  return {
    id: `MockValueTypes:setRevision:extra-${ordinal}`,
    contract: 'MockValueTypes',
    fn: 'setRevision',
    args: [value],
    sets: { [path('revision')]: value.toString() },
    recordsRevision: true,
  };
}

/** The extra change a pending record names, so that a kill during one can resume. */
export function extraRevisionStepFromId(id: string): SeedStep | undefined {
  const match = EXTRA_REVISION_ID.exec(id);
  return match === null ? undefined : extraRevisionStep(Number(match[1]));
}

/** What the read-back holds a manifest to. See `manifestDifferences` in `readback-core.ts`. */
export function readBackPlan(): {
  entries: Record<string, string[]>;
  steps: string[];
  history: { contract: string; entry: string; stepPrefix: string };
} {
  const steps = seedSteps();
  const entries: Record<string, string[]> = {};
  for (const name of MOCK_NAMES) entries[name] = ['owner', 'isSealed'];
  for (const step of steps) {
    const list = entries[step.contract] as string[];
    for (const entry of [...Object.keys(step.sets), ...Object.keys(step.dynamic ?? {})]) {
      if (!list.includes(entry)) list.push(entry);
    }
  }
  return {
    entries,
    steps: steps.map(({ id }) => id),
    history: { contract: 'MockValueTypes', entry: 'revision', stepPrefix: 'MockValueTypes:setRevision:' },
  };
}

function byteLength(value: ManifestValue): number {
  const text = String(value);
  return text.startsWith('0x') ? (text.length - 2) / 2 : Buffer.byteLength(text, 'utf8');
}

/**
 * The setters take any length, so the `short*` and `long*` names hold only if the plan keeps
 * them. Runs before any transaction.
 */
export function assertSeedEncodings(steps: readonly SeedStep[]): void {
  for (const step of steps) {
    for (const [entry, value] of Object.entries(step.sets)) {
      const length = byteLength(value);
      if (/^short[A-Z]/.test(entry) && length > SHORT_MAX_BYTES) {
        throw new Error(`${step.id}: ${entry} is ${length} bytes, so it would not be stored inline`);
      }
      if (/^long[A-Z]/.test(entry) && length <= SHORT_MAX_BYTES) {
        throw new Error(`${step.id}: ${entry} is ${length} bytes, so it would be stored inline`);
      }
    }
  }
}
