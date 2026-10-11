/**
 * `.at(blockTag)` and builder immutability.
 *
 * The `.at()` cases are chosen so that a block tag which failed to reach EVERY phase of one
 * `.read()` produces a wrong answer rather than an error:
 *
 *  - a dynamic array that SHRINKS after the pinned block. The bounds obligation is a separate
 *    storage read; if it drifted to `latest` the historical read of a still-valid index would
 *    fail with IndexOutOfBoundsError.
 *  - a long string that becomes SHORT after the pinned block. Long-vs-short is decided by the
 *    header read; if that drifted to `latest` the decoder would take the short branch and
 *    return the new value while claiming to read the old block.
 */

import { expect } from 'chai';
import type { Contract } from 'ethers';
import {
  IndexOutOfBoundsError,
  type StorageQueryBuilder,
} from '../adapter.js';
import { ADDR, FQN, LONGER_TEXT, SHORT_TEXT, currentBlock, decoder, deployAt } from '../helpers.js';

const WORDS = [1_000n, 1_001n, 1_002n, 1_003n, 1_004n];

describe('.at(blockTag)', () => {
  let storageDecoder: StorageQueryBuilder;

  before(async () => {
    storageDecoder = await decoder();
  });

  describe('a dynamic array that shrinks after the pinned block', () => {
    let address: string;
    let pinned: number;

    before(async () => {
      const deployed = await deployAt('ArrayStorage');
      address = deployed.address;
      const contract: Contract = deployed.contract;
      await (await contract.pushWords(WORDS)).wait();
      pinned = await currentBlock();
      await (await contract.popWords(3n)).wait();
      expect(await contract.wordsLength()).to.equal(2n);
    });

    const query = () => storageDecoder.contract(FQN.arrayStorage).target(address);

    it('reads the historical value at an index that no longer exists', async () => {
      const result = await query().name('words').index(4).at(pinned).read();
      expect(result.value).to.equal(WORDS[4]);
      expect(result.blockTag).to.equal(pinned);
    });

    it('still rejects that index at latest', async () => {
      let thrown: unknown;
      try {
        await query().name('words').index(4).read();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).to.be.instanceOf(IndexOutOfBoundsError);
      expect((thrown as Error).message).to.contain('length 2');
    });

    it('agrees with latest for an index that survived', async () => {
      expect((await query().name('words').index(1).at(pinned).read()).value).to.equal(WORDS[1]);
      expect((await query().name('words').index(1).read()).value).to.equal(WORDS[1]);
    });

    it('accepts a hex-quantity block tag as well as a number', async () => {
      const hex = `0x${pinned.toString(16)}`;
      expect((await query().name('words').index(4).at(hex).read()).value).to.equal(WORDS[4]);
    });

    it('defaults to latest', async () => {
      expect((await query().name('words').index(0).read()).blockTag).to.equal('latest');
    });
  });

  describe('a long string that becomes short after the pinned block', () => {
    let address: string;
    let pinned: number;

    before(async () => {
      const deployed = await deployAt('StringStorage');
      address = deployed.address;
      const contract: Contract = deployed.contract;
      await (await contract.setLongText(LONGER_TEXT)).wait();
      await (await contract.setTextByAddress(ADDR.alice, LONGER_TEXT)).wait();
      pinned = await currentBlock();
      await (await contract.setLongText(SHORT_TEXT)).wait();
      await (await contract.setTextByAddress(ADDR.alice, SHORT_TEXT)).wait();
    });

    const query = () => storageDecoder.contract(FQN.string).target(address);

    it('takes the long branch for the historical read and the short branch for latest', async () => {
      expect((await query().name('longText').at(pinned).read()).value).to.equal(LONGER_TEXT);
      expect((await query().name('longText').read()).value).to.equal(SHORT_TEXT);
    });

    it('does the same for a string reached through a mapping key', async () => {
      const historical = await query().name('textByAddress').key(ADDR.alice).at(pinned).read();
      expect(historical.value).to.equal(LONGER_TEXT);
      expect(historical.blockTag).to.equal(pinned);
      expect((await query().name('textByAddress').key(ADDR.alice).read()).value).to.equal(
        SHORT_TEXT
      );
    });
  });
});

describe('builder immutability', () => {
  let storageDecoder: StorageQueryBuilder;
  let address: string;

  before(async () => {
    storageDecoder = await decoder();
    const deployed = await deployAt('SimpleStorage');
    address = deployed.address;
    await (
      await deployed.contract.setAll(
        7n,
        -1n,
        true,
        ADDR.alice,
        `0x${'11'.repeat(32)}`,
        '0x00000001'
      )
    ).wait();
  });

  it('completes one partial chain two different ways', async () => {
    const base = storageDecoder.contract(FQN.simple).target(address);

    const count = await base.name('count').read();
    const owner = await base.name('owner').read();

    expect(count.value).to.equal(7n);
    expect(owner.value).to.equal(ADDR.alice);
    // Reusing `base` a third time still works, so neither call mutated it.
    expect((await base.name('flag').read()).value).to.equal(true);
  });

  it('never mutates the receiver when a segment is appended', async () => {
    const nested = (await deployAt('NestedMapping')).address;
    const contract = storageDecoder.contract(FQN.nestedMapping).target(nested);

    const oneLevel = contract.name('triple').key(ADDR.alice);
    expect(oneLevel.path).to.have.lengthOf(1);

    const branchA = oneLevel.key(ADDR.bob).key(1n);
    const branchB = oneLevel.key(ADDR.carol).key(2n);

    expect(oneLevel.path, 'the shared prefix must be unchanged').to.have.lengthOf(1);
    expect(branchA.path).to.have.lengthOf(3);
    expect(branchB.path).to.have.lengthOf(3);
    expect(branchA.path).to.not.equal(branchB.path);

    // Both branches resolve to distinct slots, i.e. they really carry different keys.
    const a = await branchA.read();
    const b = await branchB.read();
    expect(a.slot).to.not.equal(b.slot);
  });

  it('does not let .at() on one branch affect another', async () => {
    const base = storageDecoder.contract(FQN.simple).target(address).name('count');
    const pinned = await currentBlock();

    const historical = base.at(pinned);
    expect((await historical.read()).blockTag).to.equal(pinned);
    expect((await base.read()).blockTag).to.equal('latest');
  });

  it('exposes the accumulated path without letting a caller mutate it', () => {
    const built = storageDecoder
      .contract(FQN.struct)
      .name('records')
      .key(ADDR.alice)
      .index(2)
      .field('a');

    expect(built.path.map((segment) => segment.kind)).to.deep.equal(['key', 'index', 'field']);
    expect(() => {
      (built.path as unknown as unknown[]).push({ kind: 'key', value: 1 });
    }).to.throw();
  });
});
