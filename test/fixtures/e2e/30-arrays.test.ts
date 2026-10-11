/**
 * Array element addressing — the arithmetic with the worst failure mode, because a wrong
 * stride returns a plausible neighbouring value rather than an error.
 *
 * Every array below is filled with DISTINCT NON-ZERO values, and each assertion checks
 * index i-1, i and i+1. An off-by-one slot or offset therefore cannot pass by reading a
 * neighbour that happens to hold the same thing.
 *
 * The four structurally different branches, all present:
 *   - `address[]`  — 20 bytes, 1 per slot (32 % 20 != 0, but only one fits)
 *   - `uint128[]`  — 16 bytes, 2 per slot, NO remainder
 *   - `uint96[]`   — 12 bytes, 2 per slot with an 8-byte TRAILING GAP
 *   - `Pair[]`     — 64 bytes, 2 whole slots per element
 * plus `uint8[10]` (packed FIXED array, whose length must come from the type label, not from
 * `numberOfBytes`) and `uint256[][]` (an outer element's slot becoming an inner header slot).
 */

import { expect } from 'chai';
import type { Contract } from 'ethers';
import type { StorageQueryBuilder } from '../adapter.js';
import { ADDR, FQN, decoder, deployAt } from '../helpers.js';

const ADDRESSES = [
  '0x0000000000000000000000000000000000000011',
  '0x0000000000000000000000000000000000000022',
  '0x0000000000000000000000000000000000000033',
  '0x0000000000000000000000000000000000000044',
  '0x0000000000000000000000000000000000000055',
];
const EXACT_PACKED = [11n, 22n, 33n, 44n, 55n];
const GAP_PACKED = [101n, 202n, 303n, 404n, 505n];
const WORDS = [1_000n, 1_001n, 1_002n, 1_003n, 1_004n];
const FIXED_PACKED = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const FIXED_WORDS = [70n, 71n, 72n];
const PAIRS = [
  { left: 1n, right: 2n, who: ADDR.alice },
  { left: 3n, right: 4n, who: ADDR.bob },
  { left: 5n, right: 6n, who: ADDR.carol },
];
const NESTED_ROWS = [
  [900n, 901n, 902n],
  [910n, 911n],
];

describe('array reads', () => {
  let storageDecoder: StorageQueryBuilder;
  let address: string;

  before(async function () {
    this.timeout(300_000);
    storageDecoder = await decoder();
    const deployed = await deployAt('ArrayStorage');
    address = deployed.address;
    const contract: Contract = deployed.contract;

    await (await contract.pushAddresses(ADDRESSES)).wait();
    await (await contract.pushExactPacked(EXACT_PACKED)).wait();
    await (await contract.pushGapPacked(GAP_PACKED)).wait();
    await (await contract.pushWords(WORDS)).wait();
    for (const [index, value] of FIXED_PACKED.entries()) {
      await (await contract.setFixedPacked(index, value)).wait();
    }
    for (const [index, value] of FIXED_WORDS.entries()) {
      await (await contract.setFixedWords(index, value)).wait();
    }
    for (const pair of PAIRS) {
      await (await contract.pushPair(pair.left, pair.right, pair.who)).wait();
    }
    for (const row of NESTED_ROWS) {
      await (await contract.pushNestedRow(row)).wait();
    }
  });

  const query = () => storageDecoder.contract(FQN.arrayStorage).target(address);

  it('reads a one-element-per-slot dynamic array (address[])', async () => {
    const q = query().name('addresses');
    const previous = await q.index(1).read();
    const target = await q.index(2).read();
    const next = await q.index(3).read();

    // These literals are already EIP-55 stable (no letters), so they double as the expected
    // checksummed form the decoder must return.
    expect(previous.value).to.equal(ADDRESSES[1]);
    expect(target.value).to.equal(ADDRESSES[2]);
    expect(next.value).to.equal(ADDRESSES[3]);

    expect(target.slot).to.equal(previous.slot + 1n);
    expect(next.slot).to.equal(target.slot + 1n);
    expect(target.offset).to.equal(0);
  });

  it('reads a packed dynamic array with no remainder (uint128[], 2 per slot)', async () => {
    const q = query().name('exactPacked');
    const two = await q.index(2).read();
    const three = await q.index(3).read();
    const four = await q.index(4).read();

    expect(two.value).to.equal(EXACT_PACKED[2]);
    expect(three.value).to.equal(EXACT_PACKED[3]);
    expect(four.value).to.equal(EXACT_PACKED[4]);

    // 2 per slot, 16 bytes each, filling the word exactly.
    expect(two.offset).to.equal(0);
    expect(three.offset).to.equal(16);
    expect(three.slot).to.equal(two.slot);
    expect(four.slot).to.equal(two.slot + 1n);
    expect(four.offset).to.equal(0);
  });

  it('reads a packed dynamic array WITH a trailing gap (uint96[], 2 per slot, 8 bytes unused)', async () => {
    const q = query().name('gapPacked');
    const results = [];
    for (let index = 0; index < GAP_PACKED.length; index += 1) {
      results.push(await q.index(index).read());
    }

    for (const [index, expected] of GAP_PACKED.entries()) {
      expect(results[index]?.value, `gapPacked[${index}]`).to.equal(expected);
    }

    // The distinguishing assertion: the third element starts a NEW slot at offset 0. A naive
    // `index * 12 / 32` stride would put it at slot+0/offset 24, spilling into the gap.
    expect(results[0]?.offset).to.equal(0);
    expect(results[1]?.offset).to.equal(12);
    expect(results[2]?.offset).to.equal(0);
    expect(results[3]?.offset).to.equal(12);
    expect(results[2]?.slot).to.equal((results[0]?.slot as bigint) + 1n);
    expect(results[4]?.slot).to.equal((results[0]?.slot as bigint) + 2n);
  });

  it('reads a multi-slot element type (struct Pair[], 64 bytes each)', async () => {
    const q = query().name('pairs');
    const first = await q.index(0).field('left').read();
    const second = await q.index(1).field('left').read();
    const third = await q.index(2).field('left').read();

    expect(first.value).to.equal(PAIRS[0]?.left);
    expect(second.value).to.equal(PAIRS[1]?.left);
    expect(third.value).to.equal(PAIRS[2]?.left);

    // Each element spans two whole slots.
    expect(second.slot).to.equal(first.slot + 2n);
    expect(third.slot).to.equal(first.slot + 4n);

    // `right` packs against `left` in the element's first slot; `who` starts the second.
    const right = await q.index(1).field('right').read();
    expect(right.value).to.equal(PAIRS[1]?.right);
    expect(right.slot).to.equal(second.slot);
    expect(right.offset).to.equal(16);

    const who = await q.index(1).field('who').read();
    expect(who.value).to.equal(PAIRS[1]?.who);
    expect(who.slot).to.equal(second.slot + 1n);
    expect(who.offset).to.equal(0);
  });

  it('reads a packing-aware FIXED array whose length comes from the type label (uint8[10])', async () => {
    const q = query().name('fixedPacked');
    for (const [index, expected] of FIXED_PACKED.entries()) {
      const result = await q.index(index).read();
      expect(result.value, `fixedPacked[${index}]`).to.equal(BigInt(expected));
      // All ten bytes live in ONE slot, at ascending offsets — `numberOfBytes` for this type
      // is 32, so any length derived from a byte-count ratio would be 32, not 10.
      expect(result.offset, `fixedPacked[${index}] offset`).to.equal(index);
    }
    const first = await q.index(0).read();
    const last = await q.index(9).read();
    expect(last.slot).to.equal(first.slot);
  });

  it('rejects an out-of-range index on a fixed array using the label-parsed length', async () => {
    const failure = await query()
      .name('fixedPacked')
      .index(10)
      .read()
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(failure).to.be.instanceOf(Error);
    expect((failure as Error).name).to.equal('IndexOutOfBoundsError');
    expect((failure as Error).message).to.contain('length 10');
  });

  it('reads a one-per-slot fixed array (uint256[3])', async () => {
    const q = query().name('fixedWords');
    const zero = await q.index(0).read();
    const one = await q.index(1).read();
    const two = await q.index(2).read();
    expect(zero.value).to.equal(FIXED_WORDS[0]);
    expect(one.value).to.equal(FIXED_WORDS[1]);
    expect(two.value).to.equal(FIXED_WORDS[2]);
    expect(one.slot).to.equal(zero.slot + 1n);
    expect(two.slot).to.equal(zero.slot + 2n);
  });

  it('reads a nested dynamic array, where an outer element slot IS the inner header slot', async () => {
    const q = query().name('nested');
    for (const [row, values] of NESTED_ROWS.entries()) {
      for (const [column, expected] of values.entries()) {
        const result = await q.index(row).index(column).read();
        expect(result.value, `nested[${row}][${column}]`).to.equal(expected);
      }
    }
  });

  it('bounds-checks both levels of a nested dynamic array, outermost first', async () => {
    const inner = await query()
      .name('nested')
      .index(0)
      .index(3)
      .read()
      .then(
        () => undefined,
        (error: unknown) => error as Error
      );
    expect(inner?.name).to.equal('IndexOutOfBoundsError');
    // nested[0] has 3 elements, so the failure names 3 — not the outer array's length of 2.
    expect(inner?.message).to.contain('length 3');

    const outer = await query()
      .name('nested')
      .index(9)
      .index(0)
      .read()
      .then(
        () => undefined,
        (error: unknown) => error as Error
      );
    expect(outer?.name).to.equal('IndexOutOfBoundsError');
    // The OUTER obligation is reported, even though the inner one was derived from an index
    // that cannot exist. Reporting the inner one would be a meaningless bounds check.
    expect(outer?.message).to.contain('length 2');
  });

  it('throws IndexOutOfBoundsError past the end of a dynamic array', async () => {
    expect((await query().name('words').index(4).read()).value).to.equal(WORDS[4]);

    const failure = await query()
      .name('words')
      .index(5)
      .read()
      .then(
        () => undefined,
        (error: unknown) => error as Error
      );
    expect(failure?.name).to.equal('IndexOutOfBoundsError');
    expect(failure?.message).to.contain('length 5');
  });
});
