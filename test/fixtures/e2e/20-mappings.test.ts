/**
 * Mapping-key encoding, which is where the three padding directions live:
 *   - value types left-padded (signed integers sign-extended)
 *   - `bytesN` RIGHT-padded
 *   - `string`/`bytes` not padded at all
 * plus user-defined value types, which must follow their UNDERLYING type's rule rather than
 * any blanket one, and a mapping whose derived slot becomes an array's own header slot.
 */

import { expect } from 'chai';
import type { Contract } from 'ethers';
import type { StorageQueryBuilder } from '../adapter.js';
import { ADDR, FQN, decoder, deployAt } from '../helpers.js';

describe('mapping reads', () => {
  let storageDecoder: StorageQueryBuilder;

  before(async () => {
    storageDecoder = await decoder();
  });

  describe('NestedMapping', () => {
    let address: string;

    const NAME = 'hello, storage';
    const BLOB = '0x0badc0de';
    const SIGNED_KEY = -987_654_321n;
    const SELECTOR_KEY = '0x12345678';

    before(async () => {
      const deployed = await deployAt('NestedMapping');
      address = deployed.address;
      const contract: Contract = deployed.contract;
      await (await contract.setTriple(ADDR.alice, ADDR.bob, 7n, 1_000n)).wait();
      // A second entry under the same first two keys: proves the innermost key is really part
      // of the preimage rather than being ignored.
      await (await contract.setTriple(ADDR.alice, ADDR.bob, 8n, 2_000n)).wait();
      await (await contract.setTriple(ADDR.bob, ADDR.alice, 7n, 3_000n)).wait();
      await (await contract.setByName(NAME, 11n)).wait();
      await (await contract.setByBlob(BLOB, 22n)).wait();
      await (await contract.setBySigned(SIGNED_KEY, 33n)).wait();
      await (await contract.setBySelector(SELECTOR_KEY, 44n)).wait();
      await (await contract.setByFlag(true, 55n)).wait();
      await (await contract.setBySmallUint(9, 66n)).wait();
    });

    const query = () => storageDecoder.contract(FQN.nestedMapping).target(address);

    it('walks three levels of mapping with the explicit .key() API', async () => {
      const result = await query().name('triple').key(ADDR.alice).key(ADDR.bob).key(7n).read();
      expect(result.value).to.equal(1_000n);
      expect(result.offset).to.equal(0);
    });

    it('distinguishes neighbouring keys at every level', async () => {
      const q = query().name('triple');
      expect((await q.key(ADDR.alice).key(ADDR.bob).key(8n).read()).value).to.equal(2_000n);
      expect((await q.key(ADDR.bob).key(ADDR.alice).key(7n).read()).value).to.equal(3_000n);
      // An unset key reads as zero rather than as one of the values above.
      expect((await q.key(ADDR.carol).key(ADDR.bob).key(7n).read()).value).to.equal(0n);
    });

    it('accepts the .keys() sugar for an all-mapping path', async () => {
      const sugared = await query().name('triple').keys(ADDR.alice, ADDR.bob, 7n).read();
      const explicit = await query().name('triple').key(ADDR.alice).key(ADDR.bob).key(7n).read();
      expect(sugared.value).to.equal(1_000n);
      expect(sugared.slot).to.equal(explicit.slot);
    });

    it('leaves a string key unpadded', async () => {
      expect((await query().name('byName').key(NAME).read()).value).to.equal(11n);
      expect((await query().name('byName').key('hello, storag').read()).value).to.equal(0n);
    });

    it('leaves a bytes key unpadded', async () => {
      expect((await query().name('byBlob').key(BLOB).read()).value).to.equal(22n);
    });

    it('sign-extends a negative int256 key', async () => {
      expect((await query().name('bySigned').key(SIGNED_KEY).read()).value).to.equal(33n);
      // The positive twin hashes to a completely different slot.
      expect((await query().name('bySigned').key(-SIGNED_KEY).read()).value).to.equal(0n);
    });

    it('RIGHT-pads a bytes4 key', async () => {
      expect((await query().name('bySelector').key(SELECTOR_KEY).read()).value).to.equal(44n);
    });

    it('encodes bool and small-uint keys as full left-padded words', async () => {
      expect((await query().name('byFlag').key(true).read()).value).to.equal(55n);
      expect((await query().name('byFlag').key(false).read()).value).to.equal(0n);
      expect((await query().name('bySmallUint').key(9).read()).value).to.equal(66n);
    });
  });

  describe('enum- and contract-typed mapping keys', () => {
    let address: string;

    before(async () => {
      const deployed = await deployAt('EnumAndContractStorage');
      address = deployed.address;
      await (await deployed.contract.setByToken(ADDR.token, 500n)).wait();
      await (await deployed.contract.setByStatus(2, 600n)).wait(); // Status.Closed
    });

    const query = () => storageDecoder.contract(FQN.enumAndContract).target(address);

    it('encodes a contract-typed key as an address', async () => {
      expect((await query().name('byToken').key(ADDR.token).read()).value).to.equal(500n);
      expect((await query().name('byToken').key(ADDR.ghost).read()).value).to.equal(0n);
    });

    it('encodes an enum-typed key as its underlying uint8', async () => {
      expect((await query().name('byStatus').key(2).read()).value).to.equal(600n);
      expect((await query().name('byStatus').key(1).read()).value).to.equal(0n);
    });
  });

  describe('user-defined value type keys', () => {
    let address: string;

    const ID_KEY = '0xabcdef0000000000000000000000000000000000000000000000000000000000';
    const SIGNED_KEY = -42n;
    const AMOUNT_KEY = 123_456_789n;

    before(async () => {
      const deployed = await deployAt('UserDefinedTypes');
      address = deployed.address;
      const contract: Contract = deployed.contract;
      await (await contract.setById(ID_KEY, 7_001n)).wait();
      await (await contract.setBySigned(SIGNED_KEY, 7_002n)).wait();
      await (await contract.setByAmount(AMOUNT_KEY, 7_003n)).wait();
    });

    const query = () => storageDecoder.contract(FQN.userDefined).target(address);

    it('reads a mapping keyed by a bytes32-backed UDVT', async () => {
      // At 32 bytes left- and right-padding coincide, so this cannot tell the two apart; the
      // bytes4-backed `Tag` below is the test of the padding direction.
      expect((await query().name('byId').key(ID_KEY).read()).value).to.equal(7_001n);
    });

    it('sign-extends an int128-backed UDVT key', async () => {
      expect((await query().name('bySigned').key(SIGNED_KEY).read()).value).to.equal(7_002n);
      expect((await query().name('bySigned').key(42n).read()).value).to.equal(0n);
    });

    it('zero-extends a uint96-backed UDVT key', async () => {
      expect((await query().name('byAmount').key(AMOUNT_KEY).read()).value).to.equal(7_003n);
    });
  });

  describe('a user-defined value type key narrower than a word', () => {
    let address: string;
    let contract: Contract;

    // `type Tag is bytes4`. Resolved as bytes4 the key is RIGHT-padded; resolved as any
    // integer type the same four bytes would be left-padded and hash to another slot.
    const TAG_KEY = '0x12345678';
    const SHORT_TAG = '0xab';
    const TAGS = 'contracts/ZZFunctionStorage.sol:ZZFunctionStorage';

    before(async () => {
      const deployed = await deployAt('ZZFunctionStorage');
      address = deployed.address;
      contract = deployed.contract;
      await (await contract.setByTag(TAG_KEY, 8_001n)).wait();
      // bytes4(bytes1(0xab)): the key a shorter-than-N value stands for.
      await (await contract.setByTag('0xab000000', 8_002n)).wait();
    });

    const query = () => storageDecoder.contract(TAGS).target(address);

    it('RIGHT-pads a bytes4-backed UDVT key', async () => {
      expect(await contract.byTag(TAG_KEY)).to.equal(8_001n);
      expect((await query().name('byTag').key(TAG_KEY).read()).value).to.equal(8_001n);
      // A neighbouring key is a different slot, not the same one.
      expect((await query().name('byTag').key('0x12345679').read()).value).to.equal(0n);
    });

    it('RIGHT-pads a key shorter than the type, as Solidity widens bytes1 to bytes4', async () => {
      expect((await query().name('byTag').key(SHORT_TAG).read()).value).to.equal(8_002n);
      expect((await query().name('byTag').key('0xab000000').read()).value).to.equal(8_002n);
      // Left-padded, the same byte would be key 0x000000ab — which was never written.
      expect((await query().name('byTag').key('0x000000ab').read()).value).to.equal(0n);
    });

    it('rejects a number for a bytes4-backed key instead of left-padding it', async () => {
      const failure = await query()
        .name('byTag')
        .key(0x12345678)
        .read()
        .then(
          () => undefined,
          (error: unknown) => error
        );
      expect(failure).to.be.instanceOf(TypeError);
    });
  });

  describe("MappingToArrayStorage — a mapping's derived slot as an array header", () => {
    let address: string;

    before(async () => {
      const deployed = await deployAt('MappingToArrayStorage');
      address = deployed.address;
      const contract: Contract = deployed.contract;
      // Distinct values either side of the index under test, in every list.
      await (await contract.pushList(ADDR.alice, [10n, 20n, 30n, 40n])).wait();
      await (await contract.pushList(ADDR.bob, [90n])).wait();
      await (await contract.pushPackedList(ADDR.alice, [101n, 202n, 303n, 404n, 505n])).wait();
      await (await contract.pushNestedList(ADDR.alice, 5n, [1n, 2n, 3n])).wait();
    });

    const query = () => storageDecoder.contract(FQN.mappingToArray).target(address);

    it('indexes an array reached through a mapping key', async () => {
      const q = query().name('listByAddress').key(ADDR.alice);
      expect((await q.index(1).read()).value).to.equal(20n);
      expect((await q.index(2).read()).value).to.equal(30n);
      expect((await q.index(3).read()).value).to.equal(40n);
      // A different key is a different array, not an offset into the same one.
      expect((await query().name('listByAddress').key(ADDR.bob).index(0).read()).value).to.equal(
        90n
      );
    });

    it('applies packing arithmetic inside a mapping-reached uint96 array', async () => {
      const q = query().name('packedListByAddress').key(ADDR.alice);
      const second = await q.index(1).read();
      const third = await q.index(2).read();
      expect(second.value).to.equal(202n);
      expect(third.value).to.equal(303n);
      // 2 per slot with an 8-byte trailing gap: index 1 shares index 0's slot at offset 12,
      // index 2 starts the next slot at offset 0.
      expect(second.offset).to.equal(12);
      expect(third.offset).to.equal(0);
      expect(third.slot).to.equal(second.slot + 1n);
    });

    it('bounds-checks an array reached through a mapping key', async () => {
      const failure = await query()
        .name('listByAddress')
        .key(ADDR.alice)
        .index(4)
        .read()
        .then(
          () => undefined,
          (error: unknown) => error
        );
      expect(failure).to.be.instanceOf(Error);
      expect((failure as Error).name).to.equal('IndexOutOfBoundsError');
    });

    it('indexes an array under two mapping levels', async () => {
      const q = query().name('nestedListByAddress').key(ADDR.alice).key(5n);
      expect((await q.index(0).read()).value).to.equal(1n);
      expect((await q.index(1).read()).value).to.equal(2n);
      expect((await q.index(2).read()).value).to.equal(3n);
    });
  });
});
