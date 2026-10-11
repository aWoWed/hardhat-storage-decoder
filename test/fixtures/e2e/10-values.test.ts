/**
 * Value-typed reads: plain variables, packed slots, inheritance, and the three type families
 * that solc reports under a name other than their storage representation (enum, contract,
 * user-defined value type).
 */

import { expect } from 'chai';
import type { Contract } from 'ethers';
import type { StorageQueryBuilder } from '../adapter.js';
import { ADDR, FQN, decoder, deployAt } from '../helpers.js';

const DIGEST = '0x1122334455667788990011223344556677889900112233445566778899001122';
const SELECTOR = '0xdeadbeef';

describe('value-typed reads', () => {
  let storageDecoder: StorageQueryBuilder;

  before(async () => {
    storageDecoder = await decoder();
  });

  describe('SimpleStorage', () => {
    let address: string;

    before(async () => {
      const deployed = await deployAt('SimpleStorage');
      address = deployed.address;
      await (
        await deployed.contract.setAll(42n, -12_345n, true, ADDR.alice, DIGEST, SELECTOR)
      ).wait();
    });

    const read = (name: string) =>
      storageDecoder.contract(FQN.simple).target(address).name(name).read();

    it('reads a uint256 set by a real transaction', async () => {
      const result = await read('count');
      expect(result.value).to.equal(42n);
      expect(result.slot).to.equal(0n);
      expect(result.offset).to.equal(0);
      expect(result.rawSlotValue).to.be.instanceOf(Uint8Array).with.lengthOf(32);
      expect(result.typeLabel).to.equal('uint256');
      expect(result.blockTag).to.equal('latest');
    });

    it('sign-extends a negative int256', async () => {
      expect((await read('signedCount')).value).to.equal(-12_345n);
    });

    it('reads a bool', async () => {
      expect((await read('flag')).value).to.equal(true);
    });

    it('reads a checksummed address', async () => {
      expect((await read('owner')).value).to.equal(ADDR.alice);
    });

    it('reads bytes32 and bytes4', async () => {
      expect((await read('digest')).value).to.equal(DIGEST);
      expect((await read('selector')).value).to.equal(SELECTOR);
    });
  });

  describe('PackedStorage', () => {
    let address: string;

    // Slot 0 is fully populated, so every field has non-zero NEIGHBOURS inside its own word:
    // an offset error cannot be masked by reading zero-filled padding.
    const A = (1n << 127n) - 1n; // uint128 max
    const B = 0xfedcba9876543210n; // uint64
    const C = 0xffff_fffen; // uint32
    const E = 200; // uint8
    const F = -(2n ** 100n); // int128, negative: exercises sign extension inside a packed slot
    const G = '0xcafebabe'; // bytes4
    const I = (1n << 96n) - 1n; // uint96 max, fills slot 2 exactly

    before(async () => {
      const deployed = await deployAt('PackedStorage');
      address = deployed.address;
      const contract: Contract = deployed.contract;
      await (await contract.setSlot0(A, B, C, true, E)).wait();
      await (await contract.setSlot1(F, G)).wait();
      await (await contract.setSlot2(ADDR.bob, I)).wait();
    });

    const read = (name: string) =>
      storageDecoder.contract(FQN.packed).target(address).name(name).read();

    it('reads every field of a fully-packed slot at its own offset', async () => {
      const a = await read('a');
      expect(a.value).to.equal(A);
      expect(a.slot).to.equal(0n);
      expect(a.offset).to.equal(0);

      const b = await read('b');
      expect(b.value).to.equal(B);
      expect(b.slot).to.equal(0n);
      expect(b.offset).to.equal(16);

      const c = await read('c');
      expect(c.value).to.equal(C);
      expect(c.offset).to.equal(24);

      const d = await read('d');
      expect(d.value).to.equal(true);
      expect(d.offset).to.equal(28);

      const e = await read('e');
      expect(e.value).to.equal(BigInt(E));
      expect(e.offset).to.equal(29);
    });

    it('sign-extends a negative int128 that shares its slot with a bytes4', async () => {
      const f = await read('f');
      expect(f.value).to.equal(F);
      expect(f.slot).to.equal(1n);
      expect(f.offset).to.equal(0);

      const g = await read('g');
      expect(g.value).to.equal(G);
      expect(g.offset).to.equal(16);
    });

    it('reads an address packed against a uint96 that fills the slot', async () => {
      const h = await read('h');
      expect(h.value).to.equal(ADDR.bob);
      expect(h.slot).to.equal(2n);
      expect(h.offset).to.equal(0);

      const i = await read('i');
      expect(i.value).to.equal(I);
      expect(i.offset).to.equal(20);
    });

    it('returns the whole 32-byte word as rawSlotValue for a packed field', async () => {
      const { rawSlotValue } = await read('e');
      expect(rawSlotValue).to.have.lengthOf(32);
      // Byte 29 counted from the low end is index 31 - 29 = 2 counted from the high end.
      expect(rawSlotValue[31 - 29]).to.equal(E);
    });
  });

  describe('InheritedStorage', () => {
    let address: string;

    before(async () => {
      const deployed = await deployAt('InheritedStorage');
      address = deployed.address;
      const contract: Contract = deployed.contract;
      await (await contract.setBase(777n, 111n)).wait();
      await (await contract.setMid(222n, ADDR.carol)).wait();
      await (await contract.setChild(999n)).wait();
      await (await contract.setChildMap(ADDR.alice, 314n)).wait();
    });

    const query = () => storageDecoder.contract(FQN.inherited).target(address);

    it('resolves variables declared in a grandparent contract', async () => {
      const baseValue = await query().name('baseValue').read();
      expect(baseValue.value).to.equal(777n);
      expect(baseValue.slot).to.equal(0n);
    });

    it("packs a child's variable into the parent's trailing slot space", async () => {
      const basePacked = await query().name('basePacked').read();
      expect(basePacked.value).to.equal(111n);
      expect(basePacked.slot).to.equal(1n);
      expect(basePacked.offset).to.equal(0);

      const midPacked = await query().name('midPacked').read();
      expect(midPacked.value).to.equal(222n);
      expect(midPacked.slot).to.equal(1n);
      expect(midPacked.offset).to.equal(16);
    });

    it("reads the child contract's own variables and mappings", async () => {
      expect((await query().name('midAddress').read()).value).to.equal(ADDR.carol);
      expect((await query().name('childValue').read()).value).to.equal(999n);
      expect((await query().name('childMap').key(ADDR.alice).read()).value).to.equal(314n);
    });
  });

  describe('enum, contract, and user-defined value types', () => {
    let enumAddress: string;
    let udvtAddress: string;

    const ID = '0x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff';
    const SIGNED = -1234n;
    const AMOUNT = 79_228_162_514_264_337_593_543_950_335n; // uint96 max

    before(async () => {
      const enumDeployed = await deployAt('EnumAndContractStorage');
      enumAddress = enumDeployed.address;
      await (await enumDeployed.contract.setStatus(1)).wait(); // Status.Active
      await (await enumDeployed.contract.setToken(ADDR.token)).wait();

      const udvtDeployed = await deployAt('UserDefinedTypes');
      udvtAddress = udvtDeployed.address;
      await (await udvtDeployed.contract.setVars(ID, SIGNED, AMOUNT)).wait();
    });

    it('decodes an enum as its underlying small uint, packed with a contract-typed field', async () => {
      const query = storageDecoder.contract(FQN.enumAndContract).target(enumAddress);

      const status = await query.name('status').read();
      expect(status.value).to.equal(1n);
      expect(status.slot).to.equal(0n);
      expect(status.offset).to.equal(0);

      const token = await query.name('token').read();
      expect(token.value).to.equal(ADDR.token);
      expect(token.slot).to.equal(0n);
      expect(token.offset).to.equal(1);
    });

    it('decodes user-defined value types through their underlying type', async () => {
      const query = storageDecoder.contract(FQN.userDefined).target(udvtAddress);

      // bytes32-backed -> hex, not a number.
      expect((await query.name('idVar').read()).value).to.equal(ID);
      // int128-backed -> negative, i.e. sign-extended rather than read as a huge uint.
      expect((await query.name('signedVar').read()).value).to.equal(SIGNED);
      // uint96-backed -> zero-extended.
      expect((await query.name('amountVar').read()).value).to.equal(AMOUNT);
    });
  });
});
