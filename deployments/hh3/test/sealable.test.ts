/**
 * AC 2 and AC 3: the write guards of the sealed mocks.
 *
 * The table is built from the compiled ABIs, not written by hand, so a setter added to any mock
 * is under test without anyone listing it, and an unguarded one fails. Every state-changing
 * function except `seal` counts as a setter. Each is called with arguments generated from its
 * ABI and must:
 *   - revert with `NotOwner` for an outsider, before and after sealing;
 *   - succeed for the owner before sealing, which shows the reverts come from the guards and not
 *     from the generated arguments;
 *   - revert with `AlreadySealed` for the owner after sealing.
 */

import { expect } from 'chai';
import hre, { network } from 'hardhat';
import { id } from 'ethers';
import type { Contract } from 'ethers';

type Connection = Awaited<ReturnType<typeof network.create>>;

/** The mock set, so that an artifact lookup returning nothing cannot pass vacuously. */
const EXPECTED_MOCKS = 11;
const SOME_ADDRESS = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';

interface AbiParameter {
  type: string;
  components?: AbiParameter[];
}
interface AbiEntry {
  type: string;
  name?: string;
  stateMutability?: string;
  inputs?: AbiParameter[];
}
interface Mock {
  name: string;
  fqn: string;
  abi: AbiEntry[];
}

/** An argument of the given ABI type. 1 is in range for every array index and enum here. */
function argumentFor(parameter: AbiParameter): unknown {
  const array = /^(.*)\[(\d*)\]$/.exec(parameter.type);
  if (array !== null) {
    const element = { ...parameter, type: array[1] as string };
    return Array.from({ length: Number(array[2] || 1) }, () => argumentFor(element));
  }
  if (parameter.type === 'tuple') return (parameter.components ?? []).map(argumentFor);
  if (parameter.type === 'bool') return true;
  if (parameter.type === 'address') return SOME_ADDRESS;
  if (parameter.type === 'string') return 'x';
  if (parameter.type === 'bytes') return '0x01';
  if (/^u?int\d*$/.test(parameter.type)) return 1n;
  const fixed = /^bytes(\d+)$/.exec(parameter.type);
  if (fixed !== null) return `0x${'11'.repeat(Number(fixed[1]))}`;
  throw new Error(`no generated argument for ABI type ${parameter.type}`);
}

function signature(entry: AbiEntry): string {
  const render = (parameter: AbiParameter): string =>
    parameter.type.startsWith('tuple')
      ? `(${(parameter.components ?? []).map(render).join(',')})${parameter.type.slice(5)}`
      : parameter.type;
  return `${entry.name}(${(entry.inputs ?? []).map(render).join(',')})`;
}

const isMutating = (entry: AbiEntry): boolean =>
  entry.type === 'function' && entry.stateMutability !== 'view' && entry.stateMutability !== 'pure';

/** The revert data of a failed call, wherever the provider stack put it. */
function revertData(error: unknown): unknown {
  const { data, info } = error as { data?: unknown; info?: { error?: { data?: unknown } } };
  const found = data ?? info?.error?.data;
  return typeof found === 'object' && found !== null ? (found as { data?: unknown }).data : found;
}

/** Send `call`, and require that it reverts with the custom error `expected`. */
async function expectRevert(call: () => Promise<unknown>, expected: string, what: string) {
  let failure: unknown;
  try {
    await call();
  } catch (error) {
    failure = error;
  }
  expect(failure, `${what} should revert`).to.not.equal(undefined);
  expect(revertData(failure), `${what} should revert with ${expected}`).to.equal(
    id(`${expected}()`).slice(0, 10)
  );
}

/** A send of `setter` with generated arguments. */
function sender(target: Contract, setter: AbiEntry): () => Promise<unknown> {
  const args = (setter.inputs ?? []).map(argumentFor);
  return () => target.getFunction(signature(setter))(...(args as []));
}

describe('sealed mocks', () => {
  let connection: Connection;
  let mocks: Mock[];

  const findMock = (name: string): Mock => {
    const mock = mocks.find((candidate) => candidate.name === name);
    if (mock === undefined) throw new Error(`no artifact for ${name}`);
    return mock;
  };

  const deploy = async (mock: Mock): Promise<Contract> => {
    const factory = await connection.ethers.getContractFactory(mock.name);
    const constructorEntry = mock.abi.find((entry) => entry.type === 'constructor');
    const contract = await factory.deploy(...(constructorEntry?.inputs ?? []).map(argumentFor));
    await contract.waitForDeployment();
    return contract as unknown as Contract;
  };

  const asOutsider = async (contract: Contract): Promise<Contract> => {
    const [, outsider] = await connection.ethers.getSigners();
    return contract.connect(outsider as never) as Contract;
  };

  before(async () => {
    connection = await network.create();
    mocks = [];
    // Every deployable contract in the project. Abstract ones have no bytecode.
    for (const fqn of await hre.artifacts.getAllFullyQualifiedNames()) {
      const artifact = await hre.artifacts.readArtifact(fqn);
      if (artifact.bytecode !== '0x') {
        mocks.push({ name: artifact.contractName, fqn, abi: artifact.abi as AbiEntry[] });
      }
    }
  });

  it('finds every mock, each with a seal and at least one setter', () => {
    expect(mocks.length).to.be.at.least(EXPECTED_MOCKS);
    for (const mock of mocks) {
      const mutating = mock.abi.filter(isMutating).map(signature);
      expect(mutating, `${mock.name} functions`).to.include('seal()');
      expect(mutating.length, `${mock.name} setters`).to.be.greaterThan(1);
    }
  });

  it('accepts no ether and no unknown call', () => {
    for (const mock of mocks) {
      const open = mock.abi.filter(
        (entry) =>
          entry.type === 'receive' ||
          entry.type === 'fallback' ||
          entry.stateMutability === 'payable'
      );
      expect(open, `${mock.name} payable surface`).to.deep.equal([]);
    }
  });

  it('guards every setter of every mock, before and after sealing', async () => {
    let checked = 0;
    for (const mock of mocks) {
      const contract = await deploy(mock);
      const outsider = await asOutsider(contract);
      const setters = mock.abi.filter(isMutating).filter((entry) => entry.name !== 'seal');

      for (const setter of setters) {
        const what = `${mock.name}.${signature(setter)}`;
        await expectRevert(sender(outsider, setter), 'NotOwner', `${what} from an outsider`);
        await sender(contract, setter)();
      }

      await contract.getFunction('seal')();

      for (const setter of setters) {
        const what = `${mock.name}.${signature(setter)} after seal`;
        await expectRevert(sender(contract, setter), 'AlreadySealed', `${what} from the owner`);
        await expectRevert(sender(outsider, setter), 'NotOwner', `${what} from an outsider`);
        checked += 1;
      }
    }
    console.log(`        ${checked} setters checked across ${mocks.length} mocks`);
    expect(checked).to.be.greaterThan(mocks.length);
  });

  it('lets only the owner seal, once', async () => {
    for (const mock of mocks) {
      const contract = await deploy(mock);
      const outsider = await asOutsider(contract);
      const seal = (target: Contract) => () => target.getFunction('seal')();
      const isSealed = () => contract.getFunction('isSealed').staticCall();

      await expectRevert(seal(outsider), 'NotOwner', `${mock.name}.seal() from an outsider`);
      expect(await isSealed(), `${mock.name} after an outsider's seal`).to.equal(false);

      await seal(contract)();
      expect(await isSealed(), `${mock.name} after seal`).to.equal(true);
      await expectRevert(seal(contract), 'AlreadySealed', `second ${mock.name}.seal()`);
      expect(await isSealed(), `${mock.name} after a second seal`).to.equal(true);
    }
  });

  it('lets a value change across blocks before sealing, readable with .at(block)', async () => {
    const { ethers, storageDecoder } = connection;
    const mock = findMock('MockValueTypes');
    const contract = await deploy(mock);
    const query = storageDecoder
      .contract(mock.fqn)
      .target(await contract.getAddress())
      .name('revision');

    const recorded: Array<[number, bigint]> = [];
    for (const value of [11n, 22n, 33n]) {
      await contract.getFunction('setRevision')(value);
      recorded.push([await ethers.provider.getBlockNumber(), value]);
    }
    await contract.getFunction('seal')();

    expect(new Set(recorded.map(([block]) => block)).size).to.equal(recorded.length);
    for (const [block, value] of recorded) {
      expect((await query.at(block).read()).value, `revision at ${block}`).to.equal(value);
    }
    expect((await query.read()).value).to.equal(33n);
  });

  it('stores what the short and long names say', async () => {
    const { ethers, storageDecoder } = connection;
    const mock = findMock('MockStrings');
    const contract = await deploy(mock);
    const address = await contract.getAddress();

    // Slot 0 is `owner` and `isSealed`; the four variables follow in order. Literal slots, so
    // this does not rely on the decoder's own derivation.
    const cases = [
      { name: 'shortText', slot: 1, setter: 'setShortText', value: 's'.repeat(31), short: true },
      { name: 'longText', slot: 2, setter: 'setLongText', value: 'l'.repeat(40), short: false },
      { name: 'shortBlob', slot: 3, setter: 'setShortBlob', value: `0x${'ab'.repeat(8)}`, short: true },
      { name: 'longBlob', slot: 4, setter: 'setLongBlob', value: `0x${'cd'.repeat(70)}`, short: false },
    ];
    for (const { name, slot, setter, value, short } of cases) {
      await contract.getFunction(setter)(value);
      const header = BigInt(await ethers.provider.getStorage(address, slot));
      // Solidity's encoding: the header's lowest bit is clear inline and set for data slots.
      expect((header & 1n) === 0n, `${name} header encoding`).to.equal(short);

      const read = await storageDecoder.contract(mock.fqn).target(address).name(name).read();
      expect(read.value, `${name} through the decoder`).to.equal(value);
    }
  });

  it('reads through the address check with immutables set by the constructor', async () => {
    const { storageDecoder } = connection;
    const mock = findMock('MockImmutable');
    const contract = await deploy(mock);
    await contract.getFunction('setStored')(7n);

    expect(await contract.getFunction('launchValue').staticCall()).to.equal(1n);
    const read = await storageDecoder
      .contract(mock.fqn)
      .target(await contract.getAddress())
      .name('stored')
      .read();
    expect(read.value).to.equal(7n);
  });
});
