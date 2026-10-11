/**
 * Two storage shapes a contract may legally have that a name-and-path reader gets wrong unless
 * it handles them on purpose:
 *   - a private variable of a base contract declared again, under the same name, by a derived
 *     contract — two storage entries with one label;
 *   - function-typed state variables, which are ordinary 24- and 8-byte storage values.
 *
 * As everywhere in this suite, the expected values are what real transactions wrote.
 */

import { expect } from 'chai';
import type { Contract } from 'ethers';
import {
  AmbiguousVariableError,
  type StorageQueryBuilder,
  VariableNotFoundError,
} from '../adapter.js';
import { decoder, deployAt } from '../helpers.js';

const SHADOWED = 'contracts/ZZShadowedNames.sol:ZZShadowedNames';
const FUNCTIONS = 'contracts/ZZFunctionStorage.sol:ZZFunctionStorage';

/** Run a query that must fail, and hand back whatever it threw. */
async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the query to throw, but it resolved');
}

describe('shadowed names and function-typed variables', () => {
  let storageDecoder: StorageQueryBuilder;

  before(async () => {
    storageDecoder = await decoder();
  });

  describe('ZZShadowedNames — one name, two declarations', () => {
    let address: string;
    let contract: Contract;

    const BASE_X = 1_111n;
    const DERIVED_X = 2_222n;
    const BETWEEN = 1_500n;
    const BASE_PACKED = 31n;
    const DERIVED_PACKED = 32n;

    before(async () => {
      const deployed = await deployAt('ZZShadowedNames');
      address = deployed.address;
      contract = deployed.contract;
      await (await contract.setBaseX(BASE_X)).wait();
      await (await contract.setDerivedX(DERIVED_X)).wait();
      await (await contract.setBetween(BETWEEN)).wait();
      await (await contract.setBasePacked(BASE_PACKED)).wait();
      await (await contract.setDerivedPacked(DERIVED_PACKED)).wait();
      await (await contract.setBaseTable(7n, 1_007n)).wait();
      await (await contract.setDerivedTable(7n, 2_007n)).wait();
      await (await contract.setDerivedTable(8n, 2_008n)).wait();
      await (await contract.pushBaseList(1_000n)).wait();
      await (await contract.pushDerivedList(2_000n)).wait();
      await (await contract.pushDerivedList(2_001n)).wait();
    });

    const query = () => storageDecoder.contract(SHADOWED).target(address);

    it('wrote two different values, which the contract itself tells apart', async () => {
      expect(await contract.baseX()).to.equal(BASE_X);
      expect(await contract.derivedX()).to.equal(DERIVED_X);
    });

    it('rejects the bare name instead of reading the base contract\'s slot', async () => {
      const error = await failure(() => query().name('x').read());
      expect(error).to.be.instanceOf(AmbiguousVariableError);
      const { declaringContracts, variableName } = error as AmbiguousVariableError;
      expect(variableName).to.equal('x');
      expect(declaringContracts).to.have.lengthOf(2);
      expect(declaringContracts[0]).to.match(/:ZZShadowedBase$/);
      expect(declaringContracts[1]).to.match(/:ZZShadowedNames$/);
    });

    it('reads each declaration when told which contract declares it', async () => {
      const derived = await query().name('x', { declaredIn: 'ZZShadowedNames' }).read();
      const base = await query().name('x', { declaredIn: 'ZZShadowedBase' }).read();
      expect(derived.value).to.equal(DERIVED_X);
      expect(base.value).to.equal(BASE_X);
      expect(derived.slot).to.not.equal(base.slot);
    });

    it('accepts the fully-qualified names the ambiguity error lists', async () => {
      const error = (await failure(() => query().name('packed').read())) as AmbiguousVariableError;
      expect(error).to.be.instanceOf(AmbiguousVariableError);
      const [baseName, derivedName] = error.declaringContracts;
      const base = await query().name('packed', { declaredIn: baseName }).read();
      const derived = await query().name('packed', { declaredIn: derivedName }).read();
      expect(base.value).to.equal(BASE_PACKED);
      expect(derived.value).to.equal(DERIVED_PACKED);
    });

    it('rejects a declaredIn that declares no such variable, naming the ones that do', async () => {
      const error = await failure(() => query().name('x', { declaredIn: 'NoSuchContract' }).read());
      expect(error).to.be.instanceOf(VariableNotFoundError);
      expect((error as Error).message).to.contain('ZZShadowedBase');
      expect((error as Error).message).to.contain('ZZShadowedNames');
    });

    it('reads a name declared once exactly as before, with or without declaredIn', async () => {
      expect((await query().name('between').read()).value).to.equal(BETWEEN);
      expect(
        (await query().name('between', { declaredIn: 'ZZShadowedBase' }).read()).value
      ).to.equal(BETWEEN);
      expect(
        await failure(() => query().name('between', { declaredIn: 'ZZShadowedNames' }).read())
      ).to.be.instanceOf(VariableNotFoundError);
    });

    it('honours declaredIn in readMany, readKeys and readIndices', async () => {
      const many = await storageDecoder.readMany([
        query().name('x', { declaredIn: 'ZZShadowedNames' }),
        query().name('x', { declaredIn: 'ZZShadowedBase' }),
        query().name('between'),
      ]);
      expect(many.map((result) => result.value)).to.deep.equal([DERIVED_X, BASE_X, BETWEEN]);

      const derivedKeys = await query()
        .name('table', { declaredIn: 'ZZShadowedNames' })
        .readKeys([7n, 8n]);
      expect(derivedKeys.map((result) => result.value)).to.deep.equal([2_007n, 2_008n]);
      const baseKeys = await query()
        .name('table', { declaredIn: 'ZZShadowedBase' })
        .readKeys([7n, 8n]);
      expect(baseKeys.map((result) => result.value)).to.deep.equal([1_007n, 0n]);

      const derivedList = await query()
        .name('list', { declaredIn: 'ZZShadowedNames' })
        .readIndices([0, 1]);
      expect(derivedList.map((result) => result.value)).to.deep.equal([2_000n, 2_001n]);

      expect(await failure(() => query().name('table').readKeys([7n]))).to.be.instanceOf(
        AmbiguousVariableError
      );
      expect(await failure(() => query().name('list').readIndices([0]))).to.be.instanceOf(
        AmbiguousVariableError
      );
    });

    it('honours declaredIn in readAll', async () => {
      expect(await failure(() => query().name('list').readAll())).to.be.instanceOf(
        AmbiguousVariableError
      );
      const derived = await query().name('list', { declaredIn: 'ZZShadowedNames' }).readAll();
      const base = await query().name('list', { declaredIn: 'ZZShadowedBase' }).readAll();
      expect(derived.value).to.deep.equal([2_000n, 2_001n]);
      expect(base.value).to.deep.equal([1_000n]);
    });
  });

  describe('ZZFunctionStorage — function-typed state variables', () => {
    let address: string;
    let contract: Contract;

    const HEAD = 123_456_789n;
    const TAIL = 250n;

    before(async () => {
      const deployed = await deployAt('ZZFunctionStorage');
      address = deployed.address;
      contract = deployed.contract;
      await (await contract.setPlain(HEAD, TAIL)).wait();
      await (await contract.setCallback()).wait();
      await (await contract.setOp(true)).wait();
    });

    const query = () => storageDecoder.contract(FUNCTIONS).target(address);

    it('still reads the ordinary variables declared around them', async () => {
      expect((await query().name('head').read()).value).to.equal(HEAD);
      expect((await query().name('tail').read()).value).to.equal(TAIL);
    });

    it('reads an external function value as 24 raw bytes: address, then selector', async () => {
      const [target, selector] = (await contract.callbackParts()) as [string, string];
      expect(target).to.equal(address);
      const result = await query().name('callback').read();
      expect(result.value).to.equal(`${target.toLowerCase()}${selector.slice(2).toLowerCase()}`);
      expect(result.value).to.have.lengthOf(2 + 24 * 2);
      expect(result.offset).to.equal(0);
    });

    it('reads an internal function value as the 8 raw bytes in storage', async () => {
      expect(await contract.applyOp(5n)).to.equal(15n);
      const tripled = await query().name('op').read();
      expect(tripled.value).to.equal(await contract.opRaw());
      expect(tripled.value).to.have.lengthOf(2 + 8 * 2);
      expect(tripled.value).to.not.equal(`0x${'00'.repeat(8)}`);
      // It shares the callback's slot, in the 8 bytes above it.
      expect(tripled.offset).to.equal(24);
      expect(tripled.slot).to.equal((await query().name('callback').read()).slot);

      await (await contract.setOp(false)).wait();
      expect(await contract.applyOp(5n)).to.equal(10n);
      const doubled = await query().name('op').read();
      expect(doubled.value).to.equal(await contract.opRaw());
      expect(doubled.value).to.not.equal(tripled.value);
    });

    it('dumps a function-typed variable through readAll', async () => {
      const result = await query().name('callback').readAll();
      expect(result.value).to.equal((await query().name('callback').read()).value);
    });
  });
});
