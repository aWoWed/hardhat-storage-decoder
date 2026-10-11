import { describe, expect, it } from 'vitest';
import {
  type ParsedStorageLayout,
  type TypeInfo,
  getTypeInfo,
  getVariable,
} from '../../src/core/layout/parseStorageLayout.js';
import { ContractNotFoundError, UnsupportedTypeError } from '../../src/core/query/errors.js';
import {
  StorageQueryBuilder,
  type StorageDecoderContext,
} from '../../src/core/query/StorageQueryBuilder.js';
import { decode } from '../../src/core/slots/decode.js';
import { deriveSlot, encodeMappingKey } from '../../src/core/slots/deriveSlot.js';
import { hexToBytes } from '../../src/core/util/bytes.js';
import { MockStorage, loadBareLayout, loadLayout, packWord, word } from './helpers.js';

const FQN = 'ZZFunctionStorage.sol:ZZFunctionStorage';
const TARGET = '0x3333333333333333333333333333333333333333';

// address (20 bytes) followed by selector (4 bytes), as an external function value is stored.
const CALLBACK = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed5c36b186';
const OP = '0x00000000000001a4';

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
  storage
    .set(0n, word(42))
    .set(
      1n,
      packWord(
        { offset: 0, size: 24, value: hexToBytes(CALLBACK) },
        { offset: 24, size: 8, value: hexToBytes(OP) }
      )
    )
    .set(2n, word(7));
  return { builder: new StorageQueryBuilder(context).contract(FQN).target(TARGET), storage };
}

describe('a contract with function-typed state variables', () => {
  it('parses, with and without the AST-derived extras', () => {
    expect(() => loadLayout(FQN)).not.toThrow();
    expect(() => loadBareLayout(FQN)).not.toThrow();
  });

  it('classifies both function types by kind and width', () => {
    const layout = loadLayout(FQN);
    const callback = getTypeInfo(layout, getVariable(layout, 'callback').typeId);
    expect(callback.kind).toBe('value');
    expect(callback.numberOfBytes).toBe(24);
    expect(callback.valueKind).toEqual({ family: 'function', kind: 'external', bytes: 24 });

    const op = getTypeInfo(layout, getVariable(layout, 'op').typeId);
    expect(op.kind).toBe('value');
    expect(op.numberOfBytes).toBe(8);
    expect(op.valueKind).toEqual({ family: 'function', kind: 'internal', bytes: 8 });
  });

  it('places the two function values in one slot, as solc packs them', () => {
    const layout = loadLayout(FQN);
    expect(deriveSlot(layout, 'callback', [])).toMatchObject({
      readPlan: { kind: 'single', slot: 1n },
      offset: 0,
      numberOfBytes: 24,
    });
    expect(deriveSlot(layout, 'op', [])).toMatchObject({
      readPlan: { kind: 'single', slot: 1n },
      offset: 24,
      numberOfBytes: 8,
    });
  });

  it('still reads the ordinary variables next to them', async () => {
    const { builder } = harness();
    expect((await builder.name('head').read()).value).toBe(42n);
    expect((await builder.name('tail').read()).value).toBe(7n);
  });

  it('reads a function-typed variable as raw hex of its own width', async () => {
    const { builder } = harness();
    const callback = await builder.name('callback').read();
    expect(callback.value).toBe(CALLBACK);
    expect(callback.typeLabel).toBe('function () external');
    const op = await builder.name('op').read();
    expect(op.value).toBe(OP);
    expect(op.offset).toBe(24);
  });

  it('dumps function-typed values through decode', () => {
    const slot = packWord(
      { offset: 0, size: 24, value: hexToBytes(CALLBACK) },
      { offset: 24, size: 8, value: hexToBytes(OP) }
    );
    expect(decode([slot], 0, 24, { family: 'function', kind: 'external', bytes: 24 })).toBe(
      CALLBACK
    );
    expect(decode([slot], 24, 8, { family: 'function', kind: 'internal', bytes: 8 })).toBe(OP);
  });

  it('refuses a function type as a mapping key', () => {
    const layout = loadLayout(FQN);
    for (const name of ['callback', 'op']) {
      const keyType = getTypeInfo(layout, getVariable(layout, name).typeId);
      expect(() => encodeMappingKey(keyType, '0x00')).toThrow(UnsupportedTypeError);
      expect(() => encodeMappingKey(keyType, '0x00')).toThrow(/function type/);
    }
  });

  it('refuses a mapping keyed by a function type when a path walks into it', () => {
    // solc rejects such a mapping, so the layout is hand-built.
    const callback: TypeInfo = getTypeInfo(
      loadLayout(FQN),
      't_function_external_nonpayable()returns()'
    );
    const layout: ParsedStorageLayout = {
      variables: [{ label: 'm', slot: 0n, offset: 0, typeId: 't_mapping' }],
      types: {
        [callback.id]: callback,
        t_uint256: {
          id: 't_uint256',
          kind: 'value',
          encoding: 'inplace',
          label: 'uint256',
          numberOfBytes: 32,
          valueKind: { family: 'uint', bits: 256, bytes: 32 },
        },
        t_mapping: {
          id: 't_mapping',
          kind: 'mapping',
          encoding: 'mapping',
          label: 'mapping(function () external => uint256)',
          numberOfBytes: 32,
          keyTypeId: callback.id,
          valueTypeId: 't_uint256',
        },
      },
      constantAndImmutableNames: new Set(),
    };
    expect(() => deriveSlot(layout, 'm', [{ kind: 'key', value: CALLBACK }])).toThrow(
      UnsupportedTypeError
    );
  });
});

describe('a mapping keyed by a bytes4-backed user-defined value type', () => {
  it('resolves the key type to bytes4 from the AST-derived map', () => {
    const layout = loadLayout(FQN);
    const tag = Object.values(layout.types).find((type) => type.label === 'Tag');
    expect(tag?.numberOfBytes).toBe(4);
    expect(tag?.valueKind).toEqual({ family: 'bytesN', size: 4 });
  });
});
