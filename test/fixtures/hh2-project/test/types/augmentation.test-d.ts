/**
 * Type-level gate, from a REAL consumer's position.
 *
 * The root repo has an equivalent gate (`test/types/hardhat2-augmentation.test-d.ts`), but that
 * one compiles against `src/` through the `tsconfig.hardhat2.json` alias machinery. This one
 * compiles against the PUBLISHED artifact — the installed tarball, resolved through the
 * package's `exports` map under the `require` condition — so it additionally proves that:
 *
 *   - the `./hardhat2` subpath resolves at all for a TypeScript consumer,
 *   - the emitted `.d.ts` still references the bare `hardhat` specifier (not a `hardhat-v2`
 *     alias path leaked from the build), and
 *   - tsup's dts bundler preserved the `declare module "hardhat/types/runtime"` augmentation.
 *
 * Neither `publint` nor `@arethetypeswrong/cli` checks `declare module` reachability, and a
 * failed augmentation is silent: TypeScript treats an unresolvable `declare module` target as
 * a brand-new ambient module and compiles the package cleanly while consumers get an untyped
 * `hre.storageDecoder`.
 *
 * Never executed. `npm run typecheck` (which `pretest` runs) is the gate.
 */

import type { HardhatRuntimeEnvironment } from 'hardhat/types/runtime';
import type {
  BlockTag,
  DecodedValue,
  StorageQueryBuilder,
  StorageReadResult,
} from 'hardhat-storage-decoder/hardhat2';
import 'hardhat-storage-decoder/hardhat2';

// The augmentation applies, and `hre.storageDecoder` is the builder's real public type.
export function exposesBuilder(hre: HardhatRuntimeEnvironment): StorageQueryBuilder {
  return hre.storageDecoder;
}

// A full mixed-kind chain type-checks, and `.read()` resolves to the public result type.
export async function readsThroughMixedPath(
  hre: HardhatRuntimeEnvironment,
  target: string,
  holder: string,
  block: BlockTag
): Promise<StorageReadResult> {
  return hre.storageDecoder
    .contract('contracts/StructStorage.sol:StructStorage')
    .target(target)
    .name('records')
    .key(holder)
    .index(0)
    .field('a')
    .at(block)
    .read();
}

// A partial chain is reusable, which is only true if every chain method returns a builder.
export function partialChainIsReusable(hre: HardhatRuntimeEnvironment): StorageQueryBuilder {
  return hre.storageDecoder.contract('contracts/SimpleStorage.sol:SimpleStorage').name('count');
}

// The result's `value` is the package's own union, not `any` — an `any` here would make every
// assertion in the e2e suite type-check even against a broken build.
export function decodedValueIsTyped(result: StorageReadResult): DecodedValue {
  return result.value;
}

// `.keys()` sugar is part of the public type surface too.
export function sugaredKeys(hre: HardhatRuntimeEnvironment): StorageQueryBuilder {
  return hre.storageDecoder
    .contract('contracts/NestedMapping.sol:NestedMapping')
    .name('triple')
    .keys('0x0000000000000000000000000000000000000001', 2n, 3);
}

// The bulk methods and the dump are part of the public type surface.
export async function bulkReadsAreTyped(
  hre: HardhatRuntimeEnvironment,
  target: string,
  holders: string[]
): Promise<[StorageReadResult[], StorageReadResult[], StorageReadResult[]]> {
  const base = hre.storageDecoder.contract('contracts/StructStorage.sol:StructStorage').target(target);
  return [
    await hre.storageDecoder.readMany([base.name('outer').field('id'), base.name('outer').field('tail')]),
    await base.name('outers').readKeys([1, 2n]),
    await base.name('records').key(holders[0] as string).readIndices([0, 1]),
  ];
}

export async function dumpIsTyped(
  hre: HardhatRuntimeEnvironment,
  target: string,
  holders: string[]
): Promise<import('hardhat-storage-decoder/hardhat2').StorageDumpResult> {
  const options: import('hardhat-storage-decoder/hardhat2').ReadAllOptions = {
    keys: { '': holders },
    maxElements: 100,
  };
  return hre.storageDecoder
    .contract('contracts/StructStorage.sol:StructStorage')
    .target(target)
    .name('records')
    .readAll(options);
}
