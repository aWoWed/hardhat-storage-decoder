/**
 * Type-level gate for the Hardhat 2 HRE augmentation. Compiled (never run) by
 * `npm run typecheck:hh2`.
 *
 * This is not a redundant assertion. `declare module "hardhat/types/runtime"` only augments the
 * real interface if the specifier resolves to the real module; if it does not, TypeScript
 * quietly treats the block as a NEW ambient module declaration and the adapter still compiles
 * clean — while consumers get an untyped `hre.storageDecoder`. Neither `publint` nor
 * `@arethetypeswrong/cli` checks `declare module` reachability, so nothing else in the pipeline
 * would notice.
 *
 * The gate is genuinely failable: if the augmentation stops applying, every `hre.storageDecoder`
 * below becomes TS2339, and if the `paths` remapping breaks, the import becomes TS2307.
 *
 * Verified once, empirically, with a negative control (`hre.someNameThatDoesNotExist`), which
 * did report TS2339 at the same time these lines type-checked clean — so a passing run here
 * means the interface is the real one, not a permissive stand-in.
 */

import type { HardhatRuntimeEnvironment } from 'hardhat/types/runtime';
import type { StorageDumpResult } from '../../src/core/query/dump.js';
import type { StorageQueryBuilder, StorageReadResult } from '../../src/core/query/StorageQueryBuilder.js';
import '../../src/hardhat2/index.js';

// `hre.storageDecoder` exists and is the builder's public type.
export function exposesBuilder(hre: HardhatRuntimeEnvironment): StorageQueryBuilder {
  return hre.storageDecoder;
}

// A full mixed-kind chain type-checks and `.read()` resolves to the public result type.
export async function readsThroughMixedPath(
  hre: HardhatRuntimeEnvironment,
  vault: string,
  holder: string
): Promise<StorageReadResult> {
  return hre.storageDecoder
    .contract('contracts/Vault.sol:Vault')
    .target(vault)
    .name('positions')
    .key(holder)
    .index(0)
    .field('amount')
    .at('latest')
    .read();
}

// A partial chain is reusable, which is only true if the methods return a builder.
export function partialChainIsReusable(hre: HardhatRuntimeEnvironment): StorageQueryBuilder {
  return hre.storageDecoder.contract('contracts/Vault.sol:Vault').name('totalSupply');
}

// The bulk methods are reachable from the HRE and resolve to the public result types.
export async function readsInBulk(
  hre: HardhatRuntimeEnvironment,
  vault: string,
  holders: string[]
): Promise<[StorageReadResult[], StorageReadResult[], StorageReadResult[], StorageDumpResult]> {
  const base = hre.storageDecoder.contract('contracts/Vault.sol:Vault').target(vault);
  return [
    await hre.storageDecoder.readMany([base.name('totalSupply'), base.name('balances').key(vault)]),
    await base.name('balances').readKeys(holders),
    await base.name('positions').key(vault).readIndices([0, 1n]),
    await base.name('positions').key(vault).readAll({ keys: { '[].owners': holders }, maxElements: 100 }),
  ];
}
