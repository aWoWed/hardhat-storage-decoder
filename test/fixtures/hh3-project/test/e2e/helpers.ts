/**
 * Shared deployment helpers and fixture data for the Hardhat 3 on-chain suite.
 *
 * The one structural difference from the Hardhat 2 suite: in Hardhat 3 there is no global
 * provider on the HRE, so both the decoder and ethers come from a `NetworkConnection`. One
 * connection is created lazily and shared by every test file in the run — `network.create()`
 * starts a fresh in-process chain each time it is called, so connecting per file would throw
 * away the state a previous file's transactions wrote.
 *
 * `getOrCreate()` rather than `connect()`: `hardhat@3.13.0` marks `connect()` `@deprecated`
 * ("will be removed in a future version") in favour of `create()`/`getOrCreate()`, and prints
 * a runtime warning. `05-connection-surface.test.ts` checks that the plugin's
 * `network.newConnection` hook fires for all three, so the fixture is not quietly pinned to
 * the one that is going away.
 */

import hre, { network } from 'hardhat';
import { join } from 'node:path';
import { Contract } from 'ethers';
import type { StorageQueryBuilder } from 'hardhat-storage-decoder/hardhat3';

export type Connection = Awaited<ReturnType<typeof network.getOrCreate>>;

let cached: Promise<Connection> | undefined;

/** The one shared network connection. */
export function connect(): Promise<Connection> {
  cached ??= network.getOrCreate();
  return cached;
}

/**
 * `connection.storageDecoder` — the Hardhat 3 public surface, attached by the plugin's
 * `network.newConnection` hook.
 */
export async function decoder(): Promise<StorageQueryBuilder> {
  return (await connect()).storageDecoder;
}

/** Fully-qualified names, as `.contract()` wants them. */
export const FQN = {
  arrayStorage: 'contracts/ArrayStorage.sol:ArrayStorage',
  enumAndContract: 'contracts/EnumAndContractStorage.sol:EnumAndContractStorage',
  inherited: 'contracts/InheritedStorage.sol:InheritedStorage',
  mappingToArray: 'contracts/MappingToArrayStorage.sol:MappingToArrayStorage',
  nestedMapping: 'contracts/NestedMapping.sol:NestedMapping',
  packed: 'contracts/PackedStorage.sol:PackedStorage',
  simple: 'contracts/SimpleStorage.sol:SimpleStorage',
  string: 'contracts/StringStorage.sol:StringStorage',
  struct: 'contracts/StructStorage.sol:StructStorage',
  userDefined: 'contracts/UserDefinedTypes.sol:UserDefinedTypes',
} as const;

/**
 * Fixed, obviously-distinct, correctly EIP-55-checksummed addresses. Literals rather than
 * signer addresses so a failure message points at a recognisable value.
 */
export const ADDR = {
  alice: '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa',
  bob: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB',
  carol: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
  token: '0xDDdDddDdDdddDDddDDddDDDDdDdDDdDDdDDDDDDd',
  ghost: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
} as const;

/**
 * String/bytes fixtures, sized by construction rather than by counting characters by eye.
 *
 * The three sizes are the three branches of the two-phase read pipeline: 31 bytes is the
 * largest value that still lives inline in the header slot, 40 bytes is the smallest that
 * needs a second phase, and 96 bytes spans exactly three data slots (so a `ceil(length/32)`
 * off-by-one cannot hide behind a partially-read final slot).
 *
 * All ASCII, so `.length` is the byte length.
 */
export const SHORT_TEXT = 'short enough to stay inline'.padEnd(31, '!');
export const LONG_TEXT = 'past the inline cutoff'.padEnd(40, '.');
export const LONGER_TEXT = 'exactly three data slots wide'.padEnd(96, '-');

export const SHORT_BLOB = '0x0102030405060708';
export const LONG_BLOB = `0x${'ab'.repeat(70)}`;

/** Deploy one fixture contract and wait for it to be mined. */
export async function deploy(contractName: string): Promise<Contract> {
  const { ethers } = await connect();
  const factory = await ethers.getContractFactory(contractName);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  return contract as unknown as Contract;
}

/** `deploy`, plus the address the decoder's `.target()` needs. */
export async function deployAt(
  contractName: string
): Promise<{ contract: Contract; address: string }> {
  const contract = await deploy(contractName);
  return { contract, address: await contract.getAddress() };
}

/** The block the last transaction landed in — the pin for `.at(blockTag)` history tests. */
export async function currentBlock(): Promise<number> {
  const { ethers } = await connect();
  return ethers.provider.getBlockNumber();
}

/** Where the workspace's Solidity sources live. */
export const SOURCES_DIR = join(hre.config.paths.root, 'contracts');

/** Compile inside this process, as a task or a test would. */
export async function compile(): Promise<void> {
  await hre.tasks.getTask('compile').run({ quiet: true });
}

/** Overwrite one storage slot directly, without a transaction that could be decoded back. */
export async function setStorageAt(address: string, slot: bigint, value: bigint): Promise<void> {
  const { provider } = await connect();
  await provider.request({
    method: 'hardhat_setStorageAt',
    params: [address, `0x${slot.toString(16)}`, `0x${value.toString(16).padStart(64, '0')}`],
  });
}
