/**
 * Every way a query is allowed to fail, and the specific error class it must fail with.
 *
 * These use `instanceof` against the classes re-exported from the package's own subpath, so
 * they simultaneously check that a consumer can catch and discriminate failures without
 * reaching for a second import specifier.
 */

import { expect } from 'chai';
import {
  ContractMismatchError,
  ContractNotFoundError,
  IndexOutOfBoundsError,
  PathSegmentCountMismatchError,
  PathSegmentKindMismatchError,
  StorageDecoderError,
  type StorageQueryBuilder,
  VariableNotFoundError,
} from '../adapter.js';
import { ADDR, FQN, decoder, deployAt } from '../helpers.js';

/** Run a query that must fail, and hand back whatever it threw. */
async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the query to throw, but it resolved');
}

describe('error paths', () => {
  let storageDecoder: StorageQueryBuilder;
  let simple: string;
  let arrays: string;
  let nested: string;
  let structs: string;

  before(async () => {
    storageDecoder = await decoder();
    simple = (await deployAt('SimpleStorage')).address;
    arrays = (await deployAt('ArrayStorage')).address;
    nested = (await deployAt('NestedMapping')).address;
    structs = (await deployAt('StructStorage')).address;
  });

  describe('unknown contract and variable', () => {
    it('throws ContractNotFoundError for an unknown fully-qualified name', async () => {
      const error = await failure(() =>
        storageDecoder
          .contract('contracts/NoSuchFile.sol:NoSuchContract')
          .target(simple)
          .name('count')
          .read()
      );
      expect(error).to.be.instanceOf(ContractNotFoundError);
      expect(error).to.be.instanceOf(StorageDecoderError);
    });

    it('throws VariableNotFoundError for an unknown variable, listing the real ones', async () => {
      const error = await failure(() =>
        storageDecoder.contract(FQN.simple).target(simple).name('nope').read()
      );
      expect(error).to.be.instanceOf(VariableNotFoundError);
      expect((error as Error).message).to.contain('count');
    });

    it('says so explicitly when the name is a constant', async () => {
      const error = await failure(() =>
        storageDecoder.contract(FQN.simple).target(simple).name('MAX_COUNT').read()
      );
      expect(error).to.be.instanceOf(VariableNotFoundError);
      expect((error as Error).message).to.contain('constant or immutable');
    });

    it('says so explicitly when the name is immutable', async () => {
      const error = await failure(() =>
        storageDecoder.contract(FQN.simple).target(simple).name('deployer').read()
      );
      expect(error).to.be.instanceOf(VariableNotFoundError);
      expect((error as Error).message).to.contain('constant or immutable');
    });
  });

  describe('path segment COUNT mismatches', () => {
    it('rejects a path that stops on a mapping', async () => {
      const error = await failure(() =>
        storageDecoder.contract(FQN.nestedMapping).target(nested).name('triple').read()
      );
      expect(error).to.be.instanceOf(PathSegmentCountMismatchError);
      expect(error).to.not.be.instanceOf(PathSegmentKindMismatchError);
    });

    it('rejects a path that stops partway through a nested mapping', async () => {
      const error = await failure(() =>
        storageDecoder
          .contract(FQN.nestedMapping)
          .target(nested)
          .name('triple')
          .key(ADDR.alice)
          .key(ADDR.bob)
          .read()
      );
      expect(error).to.be.instanceOf(PathSegmentCountMismatchError);
    });

    it('rejects a path that stops on an array', async () => {
      const error = await failure(() =>
        storageDecoder.contract(FQN.arrayStorage).target(arrays).name('words').read()
      );
      expect(error).to.be.instanceOf(PathSegmentCountMismatchError);
    });

    it('rejects a path that stops on a struct', async () => {
      const error = await failure(() =>
        storageDecoder.contract(FQN.struct).target(structs).name('outer').read()
      );
      expect(error).to.be.instanceOf(PathSegmentCountMismatchError);
    });

    it('rejects extra segments past a terminal type', async () => {
      const error = await failure(() =>
        storageDecoder.contract(FQN.simple).target(simple).name('count').index(0).read()
      );
      expect(error).to.be.instanceOf(PathSegmentCountMismatchError);
    });
  });

  describe('path segment KIND mismatches', () => {
    it('rejects .index() against a mapping', async () => {
      const error = await failure(() =>
        storageDecoder.contract(FQN.nestedMapping).target(nested).name('triple').index(0).read()
      );
      expect(error).to.be.instanceOf(PathSegmentKindMismatchError);
      expect(error).to.not.be.instanceOf(PathSegmentCountMismatchError);
    });

    it('rejects .key() against an array', async () => {
      const error = await failure(() =>
        storageDecoder
          .contract(FQN.arrayStorage)
          .target(arrays)
          .name('words')
          .key(ADDR.alice)
          .read()
      );
      expect(error).to.be.instanceOf(PathSegmentKindMismatchError);
    });

    it('rejects .field() against a mapping', async () => {
      const error = await failure(() =>
        storageDecoder
          .contract(FQN.nestedMapping)
          .target(nested)
          .name('triple')
          .field('anything')
          .read()
      );
      expect(error).to.be.instanceOf(PathSegmentKindMismatchError);
    });

    it('rejects .index() against a struct', async () => {
      const error = await failure(() =>
        storageDecoder.contract(FQN.struct).target(structs).name('outer').index(0).read()
      );
      expect(error).to.be.instanceOf(PathSegmentKindMismatchError);
    });

    it('rejects an unknown struct field, naming the fields that do exist', async () => {
      const error = await failure(() =>
        storageDecoder.contract(FQN.struct).target(structs).name('outer').field('nope').read()
      );
      expect(error).to.be.instanceOf(PathSegmentKindMismatchError);
      expect((error as Error).message).to.contain('inner');
    });

    it('is reachable through the .keys() sugar on a mixed-kind path', async () => {
      // `records` is mapping(address => Inner[]): the SECOND sugared key lands on an array,
      // which needs .index(), so the sugar must be kind-checked exactly like .key().
      const error = await failure(() =>
        storageDecoder
          .contract(FQN.struct)
          .target(structs)
          .name('records')
          .keys(ADDR.alice, 0)
          .field('a')
          .read()
      );
      expect(error).to.be.instanceOf(PathSegmentKindMismatchError);
    });
  });

  describe('contract/address sanity check', () => {
    it('throws ContractMismatchError when the FQN names a different contract', async () => {
      const error = await failure(() =>
        storageDecoder.contract(FQN.simple).target(arrays).name('count').read()
      );
      expect(error).to.be.instanceOf(ContractMismatchError);
      expect((error as Error).message).to.contain(arrays);
    });

    it('throws ContractMismatchError when there is no code at the address', async () => {
      const error = await failure(() =>
        storageDecoder.contract(FQN.simple).target(ADDR.ghost).name('count').read()
      );
      expect(error).to.be.instanceOf(ContractMismatchError);
      expect((error as Error).message).to.contain('no contract code');
    });
  });

  describe('incomplete chains', () => {
    it('requires .contract()', async () => {
      const error = await failure(() => storageDecoder.target(simple).name('count').read());
      expect(error).to.be.instanceOf(TypeError);
      expect((error as Error).message).to.contain('.contract(');
    });

    it('requires .target()', async () => {
      const error = await failure(() => storageDecoder.contract(FQN.simple).name('count').read());
      expect(error).to.be.instanceOf(TypeError);
      expect((error as Error).message).to.contain('.target(');
    });

    it('requires .name()', async () => {
      const error = await failure(() =>
        storageDecoder.contract(FQN.simple).target(simple).read()
      );
      expect(error).to.be.instanceOf(TypeError);
      expect((error as Error).message).to.contain('.name(');
    });
  });

  describe('out-of-bounds', () => {
    it('throws IndexOutOfBoundsError on an empty dynamic array', async () => {
      const error = await failure(() =>
        storageDecoder.contract(FQN.arrayStorage).target(arrays).name('words').index(0).read()
      );
      expect(error).to.be.instanceOf(IndexOutOfBoundsError);
      expect((error as Error).message).to.contain('length 0');
    });
  });
});
