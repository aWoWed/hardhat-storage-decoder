/**
 * Shared deployment helpers and fixture data for the Hardhat 2 on-chain suite.
 *
 * Every value written here is written by a REAL transaction against Hardhat Network, and every
 * assertion compares the decoder's answer against the value the transaction wrote. Nothing in
 * the suite reads a slot number the decoder itself computed and calls that agreement.
 */

import hre from 'hardhat';
import { Contract } from 'ethers';
import type { StorageQueryBuilder } from 'hardhat-storage-decoder/hardhat2';

/**
 * `hre.storageDecoder` — the Hardhat 2 public surface. Async only so the suites shared with
 * the Hardhat 3 workspace, where the decoder hangs off a connection, can call it the same way.
 */
export async function decoder(): Promise<StorageQueryBuilder> {
  return hre.storageDecoder;
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
 * Fixed, obviously-distinct addresses. Literals rather than signer addresses so a failure
 * message points at a recognisable value instead of a random account.
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
  const factory = await hre.ethers.getContractFactory(contractName);
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
  return hre.ethers.provider.getBlockNumber();
}

/** Where the workspace's Solidity sources live. */
export const SOURCES_DIR = hre.config.paths.sources;

/** Compile inside this process, as a task or a test would. */
export async function compile(): Promise<void> {
  await hre.run('compile', { quiet: true });
}

/** Overwrite one storage slot directly, without a transaction that could be decoded back. */
export async function setStorageAt(address: string, slot: bigint, value: bigint): Promise<void> {
  await hre.network.provider.send('hardhat_setStorageAt', [
    address,
    `0x${slot.toString(16)}`,
    `0x${value.toString(16).padStart(64, '0')}`,
  ]);
}
