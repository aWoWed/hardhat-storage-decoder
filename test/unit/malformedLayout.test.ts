import { describe, expect, it } from 'vitest';
import {
  type RawStorageLayout,
  type RawTypeEntry,
  extractConstantAndImmutableNames,
  extractUserDefinedValueTypes,
  getTypeInfo,
  getVariable,
  parseFixedArrayLength,
  parseStorageLayout,
} from '../../src/core/layout/parseStorageLayout.js';
import { UnsupportedTypeError } from '../../src/core/query/errors.js';
import { deriveSlot } from '../../src/core/slots/deriveSlot.js';
import { mappingSlot, uintKey } from './helpers.js';

const UINT256: RawTypeEntry = { encoding: 'inplace', label: 'uint256', numberOfBytes: '32' };

/** A one-variable layout, with any part of it overridden by the case under test. */
function layoutWith(
  types: Record<string, unknown>,
  variable: Record<string, unknown> = {}
): RawStorageLayout {
  return {
    storage: [{ label: 'v', offset: 0, slot: '0', type: 't_uint256', ...variable }],
    types: { t_uint256: UINT256, ...types },
  } as unknown as RawStorageLayout;
}

describe('parseStorageLayout on a malformed layout', () => {
  it.each([null, undefined, 'layout', 5])('rejects %j as the layout itself', (raw) => {
    expect(() => parseStorageLayout(raw as never)).toThrow(TypeError);
    expect(() => parseStorageLayout(raw as never)).toThrow('storageLayout must be an object');
  });

  it('reads an absent or null storage/types as empty', () => {
    expect(parseStorageLayout({}).variables).toEqual([]);
    expect(parseStorageLayout({ storage: null, types: null }).types).toEqual({});
  });

  it('rejects a negative slot', () => {
    const parse = (): unknown => parseStorageLayout(layoutWith({}, { slot: '-1' }));
    expect(parse).toThrow(TypeError);
    expect(parse).toThrow('slot of "v" must not be negative, got -1');
  });

  it('rejects a slot that is not an integer literal', () => {
    expect(() => parseStorageLayout(layoutWith({}, { slot: 'abc' }))).toThrow(SyntaxError);
    expect(() => parseStorageLayout(layoutWith({}, { slot: 1.5 }))).toThrow(RangeError);
  });

  it.each(['-1', 1.5, 'x', Number.NaN])('rejects the offset %j', (offset) => {
    const parse = (): unknown => parseStorageLayout(layoutWith({}, { offset }));
    expect(parse).toThrow(TypeError);
    expect(parse).toThrow(/offset of "v" must be a non-negative integer/);
  });

  it.each(['-32', 0.5, 'many'])('rejects the numberOfBytes %j', (numberOfBytes) => {
    const parse = (): unknown =>
      parseStorageLayout(layoutWith({ t_uint256: { ...UINT256, numberOfBytes } }));
    expect(parse).toThrow(TypeError);
    expect(parse).toThrow(/numberOfBytes of type "t_uint256" must be a non-negative integer/);
  });

  it('rejects a variable whose type is missing from the type table', () => {
    const parse = (): unknown => parseStorageLayout(layoutWith({}, { type: 't_gone' }));
    expect(parse).toThrow(TypeError);
    expect(parse).toThrow(
      'storageLayout references type "t_gone" for variable "v", but that type is missing from' +
        ' the layout\'s "types" map'
    );
  });

  it.each([null, 'inplace', 7])('rejects the type entry %j', (entry) => {
    const parse = (): unknown => parseStorageLayout(layoutWith({ t_broken: entry }));
    expect(parse).toThrow(TypeError);
    expect(parse).toThrow('storageLayout type "t_broken" must be an object');
  });

  it('rejects an unknown encoding', () => {
    const parse = (): unknown =>
      parseStorageLayout(
        layoutWith({ t_odd: { encoding: 'weird', label: 'odd', numberOfBytes: '32' } })
      );
    expect(parse).toThrow(UnsupportedTypeError);
    expect(parse).toThrow(/unknown solc encoding "weird"/);
  });

  it.each([
    ['key', { value: 't_uint256' }],
    ['value', { key: 't_uint256' }],
  ])('rejects a mapping without its %s', (_missing, rest) => {
    const parse = (): unknown =>
      parseStorageLayout(
        layoutWith({ t_map: { encoding: 'mapping', label: 'mapping', numberOfBytes: '32', ...rest } })
      );
    expect(parse).toThrow(UnsupportedTypeError);
    expect(parse).toThrow(/mapping type is missing key\/value/);
  });

  it('rejects a dynamic array without its base', () => {
    const parse = (): unknown =>
      parseStorageLayout(
        layoutWith({ t_arr: { encoding: 'dynamic_array', label: 'uint256[]', numberOfBytes: '32' } })
      );
    expect(parse).toThrow(UnsupportedTypeError);
    expect(parse).toThrow(/dynamic array type is missing base/);
  });

  it('rejects a fixed array whose length is in neither the identifier nor the label', () => {
    const parse = (): unknown =>
      parseStorageLayout(
        layoutWith({
          t_arr: { encoding: 'inplace', label: 'odd', numberOfBytes: '64', base: 't_uint256' },
        })
      );
    expect(parse).toThrow(UnsupportedTypeError);
    expect(parse).toThrow(/could not parse the fixed-array length/);
  });

  it('rejects an inplace leaf that is no recognised value type', () => {
    const parse = (): unknown =>
      parseStorageLayout(
        layoutWith({
          t_fixed128x18: { encoding: 'inplace', label: 'fixed128x18', numberOfBytes: '16' },
        })
      );
    expect(parse).toThrow(UnsupportedTypeError);
    expect(parse).toThrow(/unrecognised value type/);
  });

  it('rejects a struct member with a negative slot or a bad offset', () => {
    const struct = (member: Record<string, unknown>): RawStorageLayout =>
      layoutWith({
        't_struct(S)1_storage': {
          encoding: 'inplace',
          label: 'struct S',
          numberOfBytes: '32',
          members: [{ label: 'a', offset: 0, slot: '0', type: 't_uint256', ...member }],
        },
      });
    expect(() => parseStorageLayout(struct({ slot: '-2' }))).toThrow(
      'slot of member "a" of type "t_struct(S)1_storage" must not be negative, got -2'
    );
    expect(() => parseStorageLayout(struct({ offset: 2.5 }))).toThrow(
      /offset of member "a" of type "t_struct\(S\)1_storage" must be a non-negative integer/
    );
  });
});

describe('numbers beyond Number.MAX_SAFE_INTEGER', () => {
  // The compiled original: `uint256[2**60+1][3] big;` — solc 0.8.26 accepts it without a warning.
  const HUGE_INNER = 't_array(t_uint256)1152921504606846977_storage';
  const hugeArray = (id: string, numberOfBytes: string): RawStorageLayout =>
    layoutWith(
      { [id]: { encoding: 'inplace', label: 'uint256[huge]', numberOfBytes, base: 't_uint256' } },
      { type: id }
    );

  it('refuses to index a fixed array whose length a number cannot hold exactly', () => {
    // The layout itself parses, so the contract's other variables stay readable
    // (see oversizedTypes.test.ts); the refusal comes when a path walks into the array.
    const layout = parseStorageLayout(hugeArray(HUGE_INNER, '64'));
    const walk = (): unknown => deriveSlot(layout, 'v', [{ kind: 'index', value: 0 }]);
    expect(walk).toThrow(UnsupportedTypeError);
    expect(walk).toThrow(/1152921504606846977/);
    expect(walk).toThrow(/MAX_SAFE_INTEGER/);
  });

  it('refuses the same length through parseFixedArrayLength, from the id or the label', () => {
    expect(() => parseFixedArrayLength(HUGE_INNER)).toThrow(UnsupportedTypeError);
    expect(() => parseFixedArrayLength('mystery', 'uint256[9007199254740993]')).toThrow(
      UnsupportedTypeError
    );
  });

  it('marks a composite type whose byte size a number cannot hold exactly', () => {
    const id = 't_array(t_uint256)5_storage';
    const layout = parseStorageLayout(hugeArray(id, '36893488147419103264'));
    expect(getTypeInfo(layout, id).oversized).toMatch(/numberOfBytes/);
    expect(getTypeInfo(layout, id).oversized).toMatch(/MAX_SAFE_INTEGER/);
  });

  it('still refuses, at parse, a value type that claims such a size', () => {
    // No real value type is wider than 32 bytes, so this is a malformed layout, not a large one.
    const parse = (): unknown =>
      parseStorageLayout(
        layoutWith({
          t_uint256: { encoding: 'inplace', label: 'uint256', numberOfBytes: '36893488147419103264' },
        })
      );
    expect(parse).toThrow(UnsupportedTypeError);
    expect(parse).toThrow(/MAX_SAFE_INTEGER/);
  });

  it('refuses an offset a number cannot hold exactly', () => {
    expect(() => parseStorageLayout(layoutWith({}, { offset: '9007199254740993' }))).toThrow(
      UnsupportedTypeError
    );
  });

  it('parses a length and a size exactly at the safe boundary', () => {
    const id = 't_array(t_uint256)9007199254740991_storage';
    const layout = parseStorageLayout(hugeArray(id, '9007199254740991'));
    const type = getTypeInfo(layout, id);
    expect(type.fixedLength).toBe(Number.MAX_SAFE_INTEGER);
    expect(type.numberOfBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseFixedArrayLength(id)).toBe(9007199254740991);
    // The last valid element is addressable, and its slot is exact.
    expect(
      deriveSlot(layout, 'v', [{ kind: 'index', value: 9007199254740990n }]).readPlan
    ).toEqual({ kind: 'single', slot: 9007199254740990n });
  });

  it('keeps a slot beyond the safe range exact, as a bigint', () => {
    const layout = parseStorageLayout(layoutWith({}, { slot: '21905508587530092548' }));
    expect(getVariable(layout, 'v').slot).toBe(21905508587530092548n);
  });
});

describe('a user-defined value type named after an Object.prototype member', () => {
  // `type toString is uint256;` is valid Solidity; solc 0.8.26 emits these shapes for it.
  const layoutFor = (name: string): RawStorageLayout => ({
    storage: [
      { astId: 9, contract: 'U.sol:U', label: 'plain', offset: 0, slot: '0', type: `t_userDefinedValueType(${name})3` },
      {
        astId: 14,
        contract: 'U.sol:U',
        label: 'byIt',
        offset: 0,
        slot: '1',
        type: `t_mapping(t_userDefinedValueType(${name})3,t_uint256)`,
      },
    ],
    types: {
      t_uint256: UINT256,
      [`t_userDefinedValueType(${name})3`]: { encoding: 'inplace', label: name, numberOfBytes: '32' },
      [`t_mapping(t_userDefinedValueType(${name})3,t_uint256)`]: {
        encoding: 'mapping',
        key: `t_userDefinedValueType(${name})3`,
        label: `mapping(${name} => uint256)`,
        numberOfBytes: '32',
        value: 't_uint256',
      },
    },
  });
  const astFor = (name: string): unknown => ({
    nodeType: 'SourceUnit',
    nodes: [
      {
        nodeType: 'UserDefinedValueTypeDefinition',
        id: 3,
        name,
        underlyingType: { typeDescriptions: { typeIdentifier: 't_uint256' } },
      },
    ],
  });

  describe.each(['toString', 'valueOf', 'constructor', 'hasOwnProperty', '__proto__'])(
    'type %s is uint256',
    (name) => {
      it('parses as unresolved without the AST-derived map', () => {
        const layout = parseStorageLayout(layoutFor(name));
        expect(getTypeInfo(layout, getVariable(layout, 'plain').typeId).valueKind).toEqual({
          family: 'unresolvedUserDefinedValueType',
          name,
          numberOfBytes: 32,
        });
      });

      it('is recorded by the extractor under its id and its name', () => {
        const map = extractUserDefinedValueTypes(astFor(name));
        expect(Object.keys(map).sort()).toEqual(['3', name].sort());
        expect(map['3']).toBe('t_uint256');
        expect(map[name]).toBe('t_uint256');
      });

      it('resolves with the AST-derived map, and by name alone', () => {
        const expected = { family: 'uint', bits: 256, bytes: 32 };
        const byId = parseStorageLayout(layoutFor(name), {
          userDefinedValueTypes: extractUserDefinedValueTypes(astFor(name)),
        });
        expect(getTypeInfo(byId, getVariable(byId, 'plain').typeId).valueKind).toEqual(expected);
        expect(deriveSlot(byId, 'byIt', [{ kind: 'key', value: 5 }]).readPlan).toEqual({
          kind: 'single',
          slot: mappingSlot(uintKey(5), 1n),
        });

        const byName = parseStorageLayout(layoutFor(name), {
          userDefinedValueTypes: Object.assign(Object.create(null), { [name]: 'uint256' }),
        });
        expect(getTypeInfo(byName, getVariable(byName, 'plain').typeId).valueKind).toEqual(
          expected
        );
      });
    }
  );
});

describe('extractUserDefinedValueTypes', () => {
  const definition = (id: number, name: string, typeIdentifier?: string): unknown => ({
    nodeType: 'UserDefinedValueTypeDefinition',
    id,
    name,
    underlyingType:
      typeIdentifier === undefined ? {} : { typeDescriptions: { typeIdentifier } },
  });

  it('records each definition under its AST id and its name, at any depth', () => {
    const ast = {
      nodeType: 'SourceUnit',
      nodes: [
        definition(3, 'Id', 't_bytes32'),
        { nodeType: 'ContractDefinition', name: 'C', nodes: [definition(8, 'Price', 't_int64')] },
      ],
    };
    expect(extractUserDefinedValueTypes(ast)).toEqual({
      '3': 't_bytes32',
      Id: 't_bytes32',
      '8': 't_int64',
      Price: 't_int64',
    });
  });

  it('keeps the first definition of a name and every id, across several ASTs', () => {
    const first = { nodeType: 'SourceUnit', nodes: [definition(3, 'Id', 't_bytes32')] };
    const second = { nodeType: 'SourceUnit', nodes: [definition(40, 'Id', 't_uint256')] };
    expect(extractUserDefinedValueTypes(first, second)).toEqual({
      '3': 't_bytes32',
      '40': 't_uint256',
      Id: 't_bytes32',
    });
  });

  it('skips a definition without an underlying type identifier, and non-object input', () => {
    const ast = { nodeType: 'SourceUnit', nodes: [definition(3, 'Id'), 'text', null, 7] };
    expect(extractUserDefinedValueTypes(ast, null, undefined, 'junk')).toEqual({});
    expect(extractUserDefinedValueTypes()).toEqual({});
  });
});

describe('extractConstantAndImmutableNames', () => {
  const variable = (name: string, mutability: string, stateVariable = true): unknown => ({
    nodeType: 'VariableDeclaration',
    name,
    mutability,
    stateVariable,
  });

  it('collects constant and immutable state variables only', () => {
    const ast = {
      nodeType: 'SourceUnit',
      nodes: [
        {
          nodeType: 'ContractDefinition',
          name: 'C',
          nodes: [
            variable('MAX', 'constant'),
            variable('owner', 'immutable'),
            variable('count', 'mutable'),
            {
              nodeType: 'FunctionDefinition',
              body: { nodeType: 'Block', statements: [variable('local', 'constant', false)] },
            },
          ],
        },
      ],
    };
    expect(extractConstantAndImmutableNames(ast)).toEqual(['MAX', 'owner']);
  });

  it('lists each name once, in first-seen order, across several ASTs', () => {
    const first = { nodeType: 'SourceUnit', nodes: [variable('B', 'constant'), variable('A', 'immutable')] };
    const second = { nodeType: 'SourceUnit', nodes: [variable('A', 'constant'), variable('C', 'constant')] };
    expect(extractConstantAndImmutableNames(first, second, null, 'junk')).toEqual(['B', 'A', 'C']);
    expect(extractConstantAndImmutableNames()).toEqual([]);
  });
});
