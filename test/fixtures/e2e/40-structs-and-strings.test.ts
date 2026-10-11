/**
 * Struct field addressing, and the two-phase `string`/`bytes` pipeline.
 *
 * The strings are deliberately NOT only tested at the top level: the highest-risk composition
 * is a multi-slot value reached through a recursive walk, so the same short/long pair is read
 * through `mapping(address => string)` and `string[]` as well.
 */

import { expect } from 'chai';
import type { Contract } from 'ethers';
import type { StorageQueryBuilder } from '../adapter.js';
import {
  ADDR,
  FQN,
  LONG_BLOB,
  LONG_TEXT,
  LONGER_TEXT,
  SHORT_BLOB,
  SHORT_TEXT,
  decoder,
  deployAt,
} from '../helpers.js';

const INNERS = [
  { a: 1_001n, b: 2_001n, c: ADDR.alice, d: 3_001n },
  { a: 1_002n, b: 2_002n, c: ADDR.bob, d: 3_002n },
  { a: 1_003n, b: 2_003n, c: ADDR.carol, d: 3_003n },
];

const OUTER = { id: 4_242n, inner: INNERS[1], tail: 5_555n };

describe('struct reads', () => {
  let storageDecoder: StorageQueryBuilder;
  let address: string;

  before(async () => {
    storageDecoder = await decoder();
    const deployed = await deployAt('StructStorage');
    address = deployed.address;
    const contract: Contract = deployed.contract;

    for (const inner of INNERS) {
      await (await contract.pushRecord(ADDR.alice, [inner.a, inner.b, inner.c, inner.d])).wait();
    }
    // A second key, so an ignored mapping key would read the wrong array.
    await (await contract.pushRecord(ADDR.bob, [9n, 8n, ADDR.ghost, 7n])).wait();

    const outerTuple = [
      OUTER.id,
      [OUTER.inner?.a, OUTER.inner?.b, OUTER.inner?.c, OUTER.inner?.d],
      OUTER.tail,
    ];
    await (await contract.setOuter(outerTuple)).wait();
    await (await contract.setOuters(77n, outerTuple)).wait();
    await (
      await contract.setFixedInner(0, [INNERS[0]?.a, INNERS[0]?.b, INNERS[0]?.c, INNERS[0]?.d])
    ).wait();
    await (
      await contract.setFixedInner(1, [INNERS[2]?.a, INNERS[2]?.b, INNERS[2]?.c, INNERS[2]?.d])
    ).wait();
  });

  const query = () => storageDecoder.contract(FQN.struct).target(address);

  it('reads a struct nested in an array nested in a mapping', async () => {
    for (const [index, inner] of INNERS.entries()) {
      const base = query().name('records').key(ADDR.alice).index(index);
      expect((await base.field('a').read()).value, `records[alice][${index}].a`).to.equal(inner.a);
      expect((await base.field('b').read()).value, `records[alice][${index}].b`).to.equal(inner.b);
      expect((await base.field('c').read()).value, `records[alice][${index}].c`).to.equal(inner.c);
      expect((await base.field('d').read()).value, `records[alice][${index}].d`).to.equal(inner.d);
    }
  });

  it("keeps two mapping keys' arrays apart", async () => {
    const bob = query().name('records').key(ADDR.bob).index(0);
    expect((await bob.field('a').read()).value).to.equal(9n);
    expect((await bob.field('c').read()).value).to.equal(ADDR.ghost);
  });

  it('places packed struct members at a byte offset, never at a slot delta', async () => {
    const base = query().name('records').key(ADDR.alice).index(1);
    const a = await base.field('a').read();
    const b = await base.field('b').read();
    const c = await base.field('c').read();
    const d = await base.field('d').read();

    // a and b share the element's first slot; c and d each own the next two.
    expect(a.slot).to.equal(b.slot);
    expect(a.offset).to.equal(0);
    expect(b.offset).to.equal(16);
    expect(c.slot).to.equal(a.slot + 1n);
    expect(c.offset).to.equal(0);
    expect(d.slot).to.equal(a.slot + 2n);
  });

  it('reads a struct nested directly inside another struct', async () => {
    const outer = query().name('outer');
    expect((await outer.field('id').read()).value).to.equal(OUTER.id);
    expect((await outer.field('tail').read()).value).to.equal(OUTER.tail);

    const inner = outer.field('inner');
    expect((await inner.field('a').read()).value).to.equal(OUTER.inner?.a);
    expect((await inner.field('c').read()).value).to.equal(OUTER.inner?.c);
    expect((await inner.field('d').read()).value).to.equal(OUTER.inner?.d);
  });

  it('reads a nested struct reached through a mapping key', async () => {
    const inner = query().name('outers').key(77n).field('inner');
    expect((await inner.field('b').read()).value).to.equal(OUTER.inner?.b);
    expect((await query().name('outers').key(77n).field('tail').read()).value).to.equal(OUTER.tail);
    // An unset key is all zeros, not a copy of `outer`.
    expect((await query().name('outers').key(78n).field('tail').read()).value).to.equal(0n);
  });

  it('reads a fixed-size array of structs', async () => {
    const zero = query().name('fixedInners').index(0);
    const one = query().name('fixedInners').index(1);
    expect((await zero.field('a').read()).value).to.equal(INNERS[0]?.a);
    expect((await one.field('a').read()).value).to.equal(INNERS[2]?.a);
    // Inner is three slots wide, so element 1 starts three slots after element 0.
    expect((await one.field('a').read()).slot).to.equal((await zero.field('a').read()).slot + 3n);
  });
});

describe('string and bytes reads', () => {
  let storageDecoder: StorageQueryBuilder;
  let address: string;

  before(async () => {
    storageDecoder = await decoder();
    const deployed = await deployAt('StringStorage');
    address = deployed.address;
    const contract: Contract = deployed.contract;

    await (await contract.setShortText(SHORT_TEXT)).wait();
    await (await contract.setLongText(LONG_TEXT)).wait();
    await (await contract.setShortBlob(SHORT_BLOB)).wait();
    await (await contract.setLongBlob(LONG_BLOB)).wait();

    await (await contract.setTextByAddress(ADDR.alice, LONGER_TEXT)).wait();
    await (await contract.setTextByAddress(ADDR.bob, SHORT_TEXT)).wait();

    await (await contract.pushText(SHORT_TEXT)).wait();
    await (await contract.pushText(LONG_TEXT)).wait();
    await (await contract.pushText(LONGER_TEXT)).wait();
  });

  const query = () => storageDecoder.contract(FQN.string).target(address);

  it("decodes a short string from the header slot's HIGH-order bytes", async () => {
    const result = await query().name('shortText').read();
    expect(result.value).to.equal(SHORT_TEXT);
    expect(result.offset).to.equal(0);
    // Short form: the low byte holds 2 * length, and the data sits above it.
    expect(result.rawSlotValue[31]).to.equal(SHORT_TEXT.length * 2);
  });

  it('decodes a long string from its keccak-based data slots', async () => {
    const result = await query().name('longText').read();
    expect(result.value).to.equal(LONG_TEXT);
    // Long form: the whole header word holds 2 * length + 1.
    const header = BigInt(
      `0x${Array.from(result.rawSlotValue)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')}`
    );
    expect(header).to.equal(BigInt(LONG_TEXT.length) * 2n + 1n);
  });

  it('decodes short and long bytes', async () => {
    expect((await query().name('shortBlob').read()).value).to.equal(SHORT_BLOB);
    expect((await query().name('longBlob').read()).value).to.equal(LONG_BLOB);
  });

  it('decodes a long string reached through a mapping key', async () => {
    expect((await query().name('textByAddress').key(ADDR.alice).read()).value).to.equal(
      LONGER_TEXT
    );
    expect((await query().name('textByAddress').key(ADDR.bob).read()).value).to.equal(SHORT_TEXT);
    expect((await query().name('textByAddress').key(ADDR.carol).read()).value).to.equal('');
  });

  it('decodes short and long strings reached through an array index', async () => {
    const q = query().name('texts');
    expect((await q.index(0).read()).value).to.equal(SHORT_TEXT);
    expect((await q.index(1).read()).value).to.equal(LONG_TEXT);
    expect((await q.index(2).read()).value).to.equal(LONGER_TEXT);
  });

  it('bounds-checks a string array before attempting the two-phase read', async () => {
    const failure = await query()
      .name('texts')
      .index(3)
      .read()
      .then(
        () => undefined,
        (error: unknown) => error as Error
      );
    expect(failure?.name).to.equal('IndexOutOfBoundsError');
  });
});
