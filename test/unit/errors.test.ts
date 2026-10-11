import { describe, expect, it } from 'vitest';
import * as core from '../../src/core/index.js';
import {
  ContractNotFoundError,
  DumpInconsistentError,
  DumpTooLargeError,
  StorageDecoderError,
} from '../../src/core/index.js';

/** One instance of every error class the core exports, keyed by the name it must report. */
const INSTANCES: Record<string, Error> = {
  StorageDecoderError: new core.StorageDecoderError('x'),
  ContractNotFoundError: new core.ContractNotFoundError('a.sol:A'),
  ContractMismatchError: new core.ContractMismatchError('a.sol:A', '0x00', 'detail'),
  VariableNotFoundError: new core.VariableNotFoundError('v'),
  AmbiguousVariableError: new core.AmbiguousVariableError('v', ['a.sol:A', 'a.sol:B']),
  PathSegmentCountMismatchError: new core.PathSegmentCountMismatchError('v', 1, 'detail'),
  PathSegmentKindMismatchError: new core.PathSegmentKindMismatchError('v', 0, 'detail'),
  IndexOutOfBoundsError: new core.IndexOutOfBoundsError(1n, 0n, 'uint256[]'),
  UnsupportedTypeError: new core.UnsupportedTypeError('label', 't_id'),
  DumpTooLargeError: new core.DumpTooLargeError('array', 11n, 10, 'items'),
  DumpInconsistentError: new core.DumpInconsistentError('items', 2n, 3n),
};

describe('error names', () => {
  it('covers every error class the core exports', () => {
    const exported = Object.entries(core)
      .filter(
        ([, value]) =>
          typeof value === 'function' &&
          (value === StorageDecoderError || value.prototype instanceof StorageDecoderError)
      )
      .map(([name]) => name)
      .sort();
    expect(exported).toEqual(Object.keys(INSTANCES).sort());
  });

  it.each(Object.entries(INSTANCES))('%s reports its own class name', (name, error) => {
    expect(error.name).toBe(name);
    expect(error).toBeInstanceOf(StorageDecoderError);
    expect(error).toBeInstanceOf(Error);
  });

  it('keeps the name when the class itself is anonymous, as a bundler may emit it', () => {
    // What `exports.X = class extends Base {}` produces: a class with an empty `name`.
    const Anonymous = (() => class extends StorageDecoderError {})();
    Object.defineProperty(ContractNotFoundError, 'name', { value: '', configurable: true });
    try {
      expect(new ContractNotFoundError('a.sol:A').name).toBe('ContractNotFoundError');
    } finally {
      Object.defineProperty(ContractNotFoundError, 'name', {
        value: 'ContractNotFoundError',
        configurable: true,
      });
    }
    // An anonymous consumer subclass has no name of its own to report, so it falls back.
    expect(new Anonymous('x').name).toBe('StorageDecoderError');
  });

  it("gives a consumer's subclass its own name", () => {
    class FromLeaf extends ContractNotFoundError {}
    class FromBase extends StorageDecoderError {
      constructor(message: string) {
        super(message);
      }
    }
    expect(new FromLeaf('a.sol:A').name).toBe('FromLeaf');
    expect(new FromBase('x').name).toBe('FromBase');
    expect(new FromBase('x')).toBeInstanceOf(StorageDecoderError);
  });

  it('words an ambiguous name by whether the declaring contracts are known', () => {
    const known = new core.AmbiguousVariableError('x', ['a.sol:A', 'a.sol:B'], 'a.sol:B');
    expect(known.message).toBe(
      '"x" in "a.sol:B" names 2 storage variables, declared in: a.sol:A, a.sol:B.' +
        ' Say which one with .name("x", { declaredIn: "<contract>" }).'
    );
    expect(known.variableName).toBe('x');
    expect(known.declaringContracts).toEqual(['a.sol:A', 'a.sol:B']);
    expect(known.contractName).toBe('a.sol:B');

    const unknown = new core.AmbiguousVariableError('x', ['(unknown)', '(unknown)']);
    expect(unknown.message).toContain('"x" names 2 storage variables');
    expect(unknown.message).toContain('extractDeclaringContracts');
    expect(unknown.message).not.toContain('Say which one');
  });

  it('words a declaredIn that matches nothing, with and without known declaring contracts', () => {
    expect(
      new core.VariableNotFoundError('x', {
        contractName: 'a.sol:B',
        declaredIn: 'C',
        declaringContracts: ['a.sol:A', 'a.sol:B'],
      }).message
    ).toBe(
      'No storage variable named "x" is declared in "C" in "a.sol:B".' +
        ' It is declared in: a.sol:A, a.sol:B.'
    );
    expect(
      new core.VariableNotFoundError('x', { declaredIn: 'C', declaringContracts: [] }).message
    ).toContain('extractDeclaringContracts');
  });

  it('describes each dump limit', () => {
    expect(new DumpTooLargeError('array', 11n, 10, 'items').message).toMatch(
      /array at "items" has 11 element/
    );
    expect(new DumpTooLargeError('keys', 11n, 10, 'm').message).toMatch(/11 key\(s\) were supplied/);
    expect(new DumpTooLargeError('total', 11n, 10, 'items[3]').message).toMatch(/reached 11 node/);
    expect(new DumpInconsistentError('items', 2n, 3n).message).toMatch(/went from 2 to 3/);
  });
});
