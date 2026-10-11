/**
 * Bulk reads against real transactions: `readMany`, `readKeys`, `readIndices` and `readAll`.
 *
 * Also the one place a contract is recompiled and redeployed INSIDE the test process, which is
 * what proves the layout cache notices a recompile instead of serving the old layout.
 */

import { expect } from 'chai';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ContractMismatchError,
  ContractNotFoundError,
  DumpTooLargeError,
  IndexOutOfBoundsError,
  StorageDecoderError,
  type StorageQueryBuilder,
} from '../adapter.js';
import {
  ADDR,
  FQN,
  SOURCES_DIR,
  compile,
  currentBlock,
  decoder,
  deployAt,
  setStorageAt,
} from '../helpers.js';

const RECURSIVE = 'contracts/ZRecursiveStorage.sol:ZRecursiveStorage';
const WORDS = [1_000n, 1_001n, 1_002n, 1_003n, 1_004n];
const PAIRS = [
  { left: 1n, right: 2n, who: ADDR.alice },
  { left: 3n, right: 4n, who: ADDR.bob },
];
const NESTED_ROWS = [
  [900n, 901n, 902n],
  [910n, 911n],
];
const TINY = Array.from({ length: 40 }, (_unused, i) => BigInt(i + 1)); // spans two slots

/** Dumped structs have no prototype; rebuild them as plain objects so chai can compare them. */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, plain(v)]));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the query to throw, but it resolved');
}

describe('bulk reads', () => {
  let storageDecoder: StorageQueryBuilder;
  let arrays: string;
  let inherited: string;
  let recursive: string;

  before(async function () {
    this.timeout(300_000);
    storageDecoder = await decoder();
    const a = await deployAt('ArrayStorage');
    arrays = a.address;
    await (await a.contract.pushWords(WORDS)).wait();
    for (const pair of PAIRS) {
      await (await a.contract.pushPair(pair.left, pair.right, pair.who)).wait();
    }
    for (const row of NESTED_ROWS) await (await a.contract.pushNestedRow(row)).wait();

    const i = await deployAt('InheritedStorage');
    inherited = i.address;
    await (await i.contract.setChild(5n)).wait();
    await (await i.contract.setChildMap(ADDR.alice, 111n)).wait();
    await (await i.contract.setChildMap(ADDR.bob, 222n)).wait();

    const r = await deployAt('ZRecursiveStorage');
    recursive = r.address;
    await (await r.contract.setRootId(1n)).wait();
    await (await r.contract.addChild(10n)).wait();
    await (await r.contract.addChild(20n)).wait();
    await (await r.contract.addGrandchild(0n, 100n)).wait();
    await (await r.contract.setById(7n, 70n)).wait();
    await (await r.contract.setGrid(ADDR.alice, 1n, 11n)).wait();
    await (await r.contract.setGrid(ADDR.alice, 2n, 12n)).wait();
    await (await r.contract.setGrid(ADDR.bob, 1n, 21n)).wait();
    for (const value of TINY) await (await r.contract.pushTiny(value)).wait();
  });

  const d = () => storageDecoder;

  describe('readMany', () => {
    it('reads different variables of different contracts, in order', async () => {
      const results = await d().readMany([
        d().contract(FQN.inherited).target(inherited).name('childMap').key(ADDR.bob),
        d().contract(FQN.arrayStorage).target(arrays).name('words').index(1),
        d().contract(FQN.inherited).target(inherited).name('childValue'),
      ]);
      expect(results.map((result) => result.value)).to.deep.equal([222n, 1_001n, 5n]);
    });

    it('agrees with the same queries read one at a time', async () => {
      const queries = WORDS.map((_value, index) =>
        d().contract(FQN.arrayStorage).target(arrays).name('words').index(index)
      );
      const together = await d().readMany(queries);
      const apart = await Promise.all(queries.map((query) => query.read()));
      expect(together.map((r) => r.value)).to.deep.equal(apart.map((r) => r.value));
      expect(together.map((r) => r.value)).to.deep.equal(WORDS);
    });
  });

  describe('readKeys / readIndices', () => {
    it('reads many keys of one mapping, including one never written', async () => {
      const results = await d()
        .contract(FQN.inherited)
        .target(inherited)
        .name('childMap')
        .readKeys([ADDR.alice, ADDR.bob, ADDR.carol]);
      expect(results.map((result) => result.value)).to.deep.equal([111n, 222n, 0n]);
    });

    it('reads many indices of one array', async () => {
      const results = await d()
        .contract(FQN.arrayStorage)
        .target(arrays)
        .name('words')
        .readIndices([0, 2, 4]);
      expect(results.map((result) => result.value)).to.deep.equal([1_000n, 1_002n, 1_004n]);
    });

    it('rejects the whole call when one index is out of bounds', async () => {
      const error = await failure(() =>
        d().contract(FQN.arrayStorage).target(arrays).name('words').readIndices([0, 5])
      );
      expect(error).to.be.instanceOf(IndexOutOfBoundsError);
    });
  });

  describe('readAll', () => {
    it('dumps an array of structs', async () => {
      const result = await d().contract(FQN.arrayStorage).target(arrays).name('pairs').readAll();
      expect(plain(result.value)).to.deep.equal(PAIRS);
      expect(result.skipped).to.deep.equal([]);
    });

    it('dumps an array of arrays', async () => {
      const result = await d().contract(FQN.arrayStorage).target(arrays).name('nested').readAll();
      expect(result.value).to.deep.equal(NESTED_ROWS);
    });

    it('dumps a packed array that spans more than one slot', async () => {
      const result = await d().contract(RECURSIVE).target(recursive).name('tiny').readAll();
      expect(result.value).to.deep.equal(TINY);
    });

    it('returns mappings empty and lists them when no keys are supplied', async () => {
      const result = await d().contract(RECURSIVE).target(recursive).name('root').readAll();
      const root = result.value as {
        id: bigint;
        children: { id: bigint; children: { id: bigint }[]; byId: Map<unknown, unknown> }[];
        byId: Map<unknown, unknown>;
      };

      expect(root.id).to.equal(1n);
      expect(root.children.map((child) => child.id)).to.deep.equal([10n, 20n]);
      expect(root.children[0]?.children.map((child) => child.id)).to.deep.equal([100n]);
      expect(root.byId.size).to.equal(0);
      expect([...result.skipped].sort()).to.deep.equal([
        'byId',
        'children[].byId',
        'children[].children[].byId',
      ]);
    });

    it('reads the mapping entries whose keys are supplied', async () => {
      const result = await d()
        .contract(RECURSIVE)
        .target(recursive)
        .name('root')
        .readAll({ keys: { byId: [7] } });
      const root = result.value as { byId: Map<number, { id: bigint }> };
      expect(root.byId.get(7)?.id).to.equal(70n);
    });

    it('reads nested mapping keys as a cross-product', async () => {
      const result = await d()
        .contract(RECURSIVE)
        .target(recursive)
        .name('grid')
        .readAll({ keys: { '': [ADDR.alice, ADDR.bob], '{}': [1, 2] } });
      const grid = result.value as Map<string, Map<number, bigint>>;
      expect([...(grid.get(ADDR.alice) ?? [])]).to.deep.equal([[1, 11n], [2, 12n]]);
      expect([...(grid.get(ADDR.bob) ?? [])]).to.deep.equal([[1, 21n], [2, 0n]]);
    });

    it('refuses an array above maxElements', async () => {
      const error = await failure(() =>
        d().contract(RECURSIVE).target(recursive).name('tiny').readAll({ maxElements: 10 })
      );
      expect(error).to.be.instanceOf(DumpTooLargeError);
      expect((error as DumpTooLargeError).kind).to.equal('array');
    });

    it('pins "latest" to a block number and sees storage as of that block', async () => {
      const { address } = await deployAt('ZRecursiveStorage');
      await setStorageAt(address, 0n, 99n);

      const result = await d().contract(RECURSIVE).target(address).name('root').readAll();

      expect((result.value as { id: bigint }).id).to.equal(99n);
      expect(result.blockTag).to.equal(BigInt(await currentBlock()));
    });
  });
});

describe('error names in the published bundle', () => {
  it('reports the class name, and not an empty string', async () => {
    const storageDecoder = await decoder();
    const error = await failure(() =>
      storageDecoder
        .contract('contracts/Nope.sol:Nope')
        .target(ADDR.ghost)
        .name('x')
        .read()
    );
    expect(error).to.be.instanceOf(ContractNotFoundError);
    expect((error as Error).name).to.equal('ContractNotFoundError');
    expect(new StorageDecoderError('x').name).to.equal('StorageDecoderError');
    expect(new DumpTooLargeError('array', 2n, 1, 'p').name).to.equal('DumpTooLargeError');
  });
});

describe('recompiling inside one process', () => {
  const PROBE = 'contracts/RecompileProbe.sol:RecompileProbe';
  const file = join(SOURCES_DIR, 'RecompileProbe.sol');

  const source = (extraVariable: string) => `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract RecompileProbe {
    uint256 public a;
${extraVariable}    uint256 public b;

    function setB(uint256 value) external {
        b = value;
    }
}
`;

  after(async () => {
    await rm(file, { force: true });
  });

  it('does not remember that a contract was missing', async function () {
    this.timeout(300_000);
    await rm(file, { force: true });
    await compile();

    const storageDecoder = await decoder();
    const missing = await failure(() =>
      storageDecoder.contract(PROBE).target(ADDR.ghost).name('b').read()
    );
    expect(missing).to.be.instanceOf(ContractNotFoundError);

    await writeFile(file, source(''), 'utf8');
    await compile();

    // Asked again BEFORE anything else touches the artifacts: the earlier miss must not be
    // remembered, by this package or by Hardhat's own artifact listing. Getting as far as the
    // contract check (there is no code at this address) proves the new artifact was found.
    const found = await failure(() =>
      storageDecoder.contract(PROBE).target(ADDR.ghost).name('b').read()
    );
    expect(found).to.be.instanceOf(ContractMismatchError);

    const { contract, address } = await deployAt('RecompileProbe');
    await (await contract.setB(42n)).wait();

    const result = await storageDecoder.contract(PROBE).target(address).name('b').read();
    expect(result.value).to.equal(42n);
    expect(result.slot).to.equal(1n);
  });

  it('uses the new layout after the contract changes and is recompiled', async function () {
    this.timeout(300_000);
    // A variable inserted BEFORE `b` moves it from slot 1 to slot 2.
    await writeFile(file, source('    uint256 public inserted;\n'), 'utf8');
    await compile();
    const { contract, address } = await deployAt('RecompileProbe');
    await (await contract.setB(43n)).wait();

    const storageDecoder = await decoder();
    const result = await storageDecoder.contract(PROBE).target(address).name('b').read();
    expect(result.value).to.equal(43n);
    expect(result.slot).to.equal(2n);
  });
});
