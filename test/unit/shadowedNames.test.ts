import { describe, expect, it } from 'vitest';
import {
  type ParsedStorageLayout,
  extractDeclaringContracts,
  getVariable,
} from '../../src/core/layout/parseStorageLayout.js';
import {
  AmbiguousVariableError,
  ContractNotFoundError,
  StorageDecoderError,
  VariableNotFoundError,
} from '../../src/core/query/errors.js';
import {
  StorageQueryBuilder,
  type StorageDecoderContext,
} from '../../src/core/query/StorageQueryBuilder.js';
import { deriveSlot } from '../../src/core/slots/deriveSlot.js';
import {
  MockStorage,
  arrayBase,
  loadBareLayout,
  loadLayout,
  mappingSlot,
  uintKey,
  word,
} from './helpers.js';

const FQN = 'ZZShadowedNames.sol:ZZShadowedNames';
const BASE = 'ZZShadowedNames.sol:ZZShadowedBase';
const TARGET = '0x3333333333333333333333333333333333333333';

// Slots solc 0.8.26 assigns (test/unit/fixtures/layouts.json): the base contract's variables
// first, then the derived contract's.
const SLOT = {
  baseX: 0n,
  between: 1n,
  basePacked: 2n,
  baseTable: 3n,
  baseList: 4n,
  derivedX: 5n,
  derivedPacked: 6n,
  derivedTable: 7n,
  derivedList: 8n,
} as const;

function harness(layoutFor: (fqn: string) => ParsedStorageLayout = loadLayout) {
  const storage = new MockStorage();
  const context: StorageDecoderContext = {
    async getLayout(fqn) {
      try {
        return layoutFor(fqn);
      } catch {
        throw new ContractNotFoundError(fqn);
      }
    },
    getStorageAt: storage.getStorageAt,
  };
  const builder = new StorageQueryBuilder(context).contract(FQN).target(TARGET);
  return { builder, storage };
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('a layout in which two variables share a name', () => {
  it('records which contract declares each of them', () => {
    const layout = loadLayout(FQN);
    expect(layout.variables.map((v) => [v.label, v.slot, v.declaredIn])).toEqual([
      ['x', SLOT.baseX, BASE],
      ['between', SLOT.between, BASE],
      ['packed', SLOT.basePacked, BASE],
      ['table', SLOT.baseTable, BASE],
      ['list', SLOT.baseList, BASE],
      ['x', SLOT.derivedX, FQN],
      ['packed', SLOT.derivedPacked, FQN],
      ['table', SLOT.derivedTable, FQN],
      ['list', SLOT.derivedList, FQN],
    ]);
  });
});

describe('getVariable with a duplicated name', () => {
  const layout = loadLayout(FQN);

  it('refuses to pick one, and lists the declaring contracts', () => {
    expect(() => getVariable(layout, 'x')).toThrow(AmbiguousVariableError);
    try {
      getVariable(layout, 'x');
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(StorageDecoderError);
      const ambiguous = error as AmbiguousVariableError;
      expect(ambiguous.name).toBe('AmbiguousVariableError');
      expect(ambiguous.variableName).toBe('x');
      expect(ambiguous.declaringContracts).toEqual([BASE, FQN]);
      expect(ambiguous.message).toContain(BASE);
      expect(ambiguous.message).toContain(FQN);
      expect(ambiguous.message).toContain('declaredIn');
    }
  });

  it.each([
    ['the fully-qualified derived contract', FQN, SLOT.derivedX],
    ['the bare derived contract name', 'ZZShadowedNames', SLOT.derivedX],
    ['the fully-qualified base contract', BASE, SLOT.baseX],
    ['the bare base contract name', 'ZZShadowedBase', SLOT.baseX],
  ])('selects by %s', (_what, declaredIn, slot) => {
    expect(getVariable(layout, 'x', { declaredIn }).slot).toBe(slot);
  });

  it('rejects a declaredIn that matches no declaration, naming the ones that exist', () => {
    const read = (): unknown => getVariable(layout, 'x', { declaredIn: 'Nope' });
    expect(read).toThrow(VariableNotFoundError);
    expect(read).toThrow(/declared in "Nope"/);
    try {
      read();
    } catch (error) {
      expect((error as Error).message).toContain(BASE);
      expect((error as Error).message).toContain(FQN);
      expect((error as VariableNotFoundError).options.declaringContracts).toEqual([BASE, FQN]);
    }
  });

  it('rejects a declaredIn that names the wrong contract for an unambiguous variable', () => {
    expect(getVariable(layout, 'between', { declaredIn: 'ZZShadowedBase' }).slot).toBe(1n);
    expect(() => getVariable(layout, 'between', { declaredIn: 'ZZShadowedNames' })).toThrow(
      VariableNotFoundError
    );
  });

  it('leaves an unambiguous name exactly as it was', () => {
    expect(getVariable(layout, 'between').slot).toBe(SLOT.between);
    expect(() => getVariable(layout, 'nope')).toThrow(VariableNotFoundError);
    expect(() => getVariable(layout, 'nope')).toThrow(
      'No storage variable named "nope" in "ZZShadowedNames.sol:ZZShadowedNames".' +
        ' Available: x, between, packed, table, list, x, packed, table, list.' +
        ' Note that constant and immutable variables never appear in storageLayout.'
    );
  });

  it('still refuses when the declaring contracts are unknown', () => {
    // solc's own `contract` field names the compiled contract on every entry, so without the
    // AST-derived map there is nothing to tell the two apart by.
    const bare = loadBareLayout(FQN);
    expect(() => getVariable(bare, 'x')).toThrow(AmbiguousVariableError);
    expect(() => getVariable(bare, 'x')).toThrow(/declaringContracts/);
    expect(() => getVariable(bare, 'x', { declaredIn: 'ZZShadowedNames' })).toThrow(
      VariableNotFoundError
    );
    expect(getVariable(bare, 'between').slot).toBe(SLOT.between);
  });
});

describe('deriveSlot with a duplicated name', () => {
  const layout = loadLayout(FQN);

  it('throws rather than deriving the base contract\'s slot', () => {
    expect(() => deriveSlot(layout, 'x', [])).toThrow(AmbiguousVariableError);
  });

  it('derives each declaration\'s own slot', () => {
    expect(deriveSlot(layout, 'x', [], { declaredIn: 'ZZShadowedNames' }).readPlan).toEqual({
      kind: 'single',
      slot: SLOT.derivedX,
    });
    expect(deriveSlot(layout, 'x', [], { declaredIn: 'ZZShadowedBase' }).readPlan).toEqual({
      kind: 'single',
      slot: SLOT.baseX,
    });
  });
});

describe('.name(variable, { declaredIn })', () => {
  function seeded() {
    const h = harness();
    h.storage
      .set(SLOT.baseX, word(100))
      .set(SLOT.between, word(150))
      .set(SLOT.basePacked, word(111))
      .set(SLOT.derivedX, word(200))
      .set(SLOT.derivedPacked, word(222))
      .set(mappingSlot(uintKey(7), SLOT.baseTable), word(1_007))
      .set(mappingSlot(uintKey(7), SLOT.derivedTable), word(2_007))
      .set(mappingSlot(uintKey(8), SLOT.derivedTable), word(2_008))
      .set(SLOT.baseList, word(1))
      .set(arrayBase(SLOT.baseList), word(1_000))
      .set(SLOT.derivedList, word(2))
      .setMany(arrayBase(SLOT.derivedList), [word(2_000), word(2_001)]);
    return h;
  }

  it('read() rejects the bare name with AmbiguousVariableError and reads nothing', async () => {
    const { builder, storage } = seeded();
    const error = await failure(() => builder.name('x').read());
    expect(error).toBeInstanceOf(AmbiguousVariableError);
    expect((error as AmbiguousVariableError).declaringContracts).toEqual([BASE, FQN]);
    expect(storage.reads).toHaveLength(0);
  });

  it('read() reads the declaration that was asked for', async () => {
    const { builder } = seeded();
    const derived = await builder.name('x', { declaredIn: 'ZZShadowedNames' }).read();
    expect(derived.value).toBe(200n);
    expect(derived.slot).toBe(SLOT.derivedX);
    const base = await builder.name('x', { declaredIn: BASE }).read();
    expect(base.value).toBe(100n);
    expect(base.slot).toBe(SLOT.baseX);
  });

  it('read() rejects an unknown declaredIn', async () => {
    const { builder } = seeded();
    const error = await failure(() => builder.name('x', { declaredIn: 'Elsewhere' }).read());
    expect(error).toBeInstanceOf(VariableNotFoundError);
    expect((error as Error).message).toContain(BASE);
  });

  it('a later .name() without the option drops an earlier declaredIn', async () => {
    const { builder } = seeded();
    const first = builder.name('x', { declaredIn: 'ZZShadowedNames' });
    expect((await first.name('between').read()).value).toBe(150n);
    expect(await failure(() => first.name('x').read())).toBeInstanceOf(AmbiguousVariableError);
  });

  it('readMany() honours it per query', async () => {
    const { builder } = seeded();
    const results = await builder.readMany([
      builder.name('x', { declaredIn: 'ZZShadowedNames' }),
      builder.name('packed', { declaredIn: 'ZZShadowedBase' }),
      builder.name('packed', { declaredIn: 'ZZShadowedNames' }),
      builder.name('between'),
    ]);
    expect(results.map((r) => r.value)).toEqual([200n, 111n, 222n, 150n]);
    expect(
      await failure(() => builder.readMany([builder.name('between'), builder.name('packed')]))
    ).toBeInstanceOf(AmbiguousVariableError);
  });

  it('readKeys() honours it', async () => {
    const { builder } = seeded();
    const derived = await builder.name('table', { declaredIn: 'ZZShadowedNames' }).readKeys([7, 8]);
    expect(derived.map((r) => r.value)).toEqual([2_007n, 2_008n]);
    const base = await builder.name('table', { declaredIn: 'ZZShadowedBase' }).readKeys([7, 8]);
    expect(base.map((r) => r.value)).toEqual([1_007n, 0n]);
    expect(await failure(() => builder.name('table').readKeys([7]))).toBeInstanceOf(
      AmbiguousVariableError
    );
  });

  it('readIndices() honours it', async () => {
    const { builder } = seeded();
    const derived = await builder
      .name('list', { declaredIn: 'ZZShadowedNames' })
      .readIndices([0, 1]);
    expect(derived.map((r) => r.value)).toEqual([2_000n, 2_001n]);
    const base = await builder.name('list', { declaredIn: 'ZZShadowedBase' }).readIndices([0]);
    expect(base.map((r) => r.value)).toEqual([1_000n]);
    expect(await failure(() => builder.name('list').readIndices([0]))).toBeInstanceOf(
      AmbiguousVariableError
    );
  });

  it('readAll() rejects the bare name and dumps the declaration that was asked for', async () => {
    const { builder, storage } = seeded();
    const error = await failure(() => builder.name('list').readAll());
    expect(error).toBeInstanceOf(AmbiguousVariableError);
    expect(storage.reads).toHaveLength(0);

    const derived = await builder.name('list', { declaredIn: 'ZZShadowedNames' }).readAll();
    expect(derived.value).toEqual([2_000n, 2_001n]);
    const base = await builder.name('list', { declaredIn: 'ZZShadowedBase' }).readAll();
    expect(base.value).toEqual([1_000n]);
    const table = await builder
      .name('table', { declaredIn: 'ZZShadowedNames' })
      .readAll({ keys: { '': [7] } });
    expect(table.value).toEqual(new Map([[7, 2_007n]]));
    expect(
      await failure(() => builder.name('x', { declaredIn: 'Elsewhere' }).readAll())
    ).toBeInstanceOf(VariableNotFoundError);
  });
});

describe('extractDeclaringContracts', () => {
  const ast = {
    nodeType: 'SourceUnit',
    absolutePath: 'contracts/P.sol',
    nodes: [
      { nodeType: 'PragmaDirective' },
      // A file-level constant is not a state variable of any contract.
      { nodeType: 'VariableDeclaration', id: 1, name: 'FREE', stateVariable: false },
      {
        nodeType: 'ContractDefinition',
        name: 'PA',
        nodes: [
          { nodeType: 'VariableDeclaration', id: 24, name: 'x', stateVariable: true },
          { nodeType: 'VariableDeclaration', id: 26, name: 'y', stateVariable: true },
          {
            nodeType: 'FunctionDefinition',
            name: 'f',
            body: {
              nodeType: 'Block',
              statements: [
                {
                  nodeType: 'VariableDeclarationStatement',
                  declarations: [
                    { nodeType: 'VariableDeclaration', id: 30, name: 'x', stateVariable: false },
                  ],
                },
              ],
            },
          },
        ],
      },
      {
        nodeType: 'ContractDefinition',
        name: 'PB',
        nodes: [{ nodeType: 'VariableDeclaration', id: 41, name: 'x', stateVariable: true }],
      },
    ],
  };

  it('maps each state variable\'s AST id to its declaring contract', () => {
    expect(extractDeclaringContracts(ast)).toEqual({
      '24': 'contracts/P.sol:PA',
      '26': 'contracts/P.sol:PA',
      '41': 'contracts/P.sol:PB',
    });
  });

  it('merges several sources and falls back to the bare name without a source path', () => {
    const other = {
      nodeType: 'SourceUnit',
      nodes: [
        {
          nodeType: 'ContractDefinition',
          name: 'Q',
          nodes: [{ nodeType: 'VariableDeclaration', id: 77, name: 'z', stateVariable: true }],
        },
      ],
    };
    expect(extractDeclaringContracts(ast, other, null, undefined, 'junk')).toEqual({
      '24': 'contracts/P.sol:PA',
      '26': 'contracts/P.sol:PA',
      '41': 'contracts/P.sol:PB',
      '77': 'Q',
    });
  });

  it('returns an empty map for no input', () => {
    expect(extractDeclaringContracts()).toEqual({});
  });
});
