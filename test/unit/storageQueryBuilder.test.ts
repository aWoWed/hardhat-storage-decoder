import { describe, expect, it } from 'vitest';
import type { ParsedStorageLayout } from '../../src/core/layout/parseStorageLayout.js';
import {
  ContractMismatchError,
  ContractNotFoundError,
  IndexOutOfBoundsError,
  PathSegmentCountMismatchError,
  PathSegmentKindMismatchError,
} from '../../src/core/query/errors.js';
import {
  StorageQueryBuilder,
  type StorageDecoderContext,
} from '../../src/core/query/StorageQueryBuilder.js';
import type { BlockTag } from '../../src/core/rpc/getStorageAt.js';
import { hexToBytes, utf8ToBytes } from '../../src/core/util/bytes.js';
import {
  MockStorage,
  addressKey,
  arrayBase,
  loadLayout,
  mappingSlot,
  packWord,
  uintKey,
  word,
} from './helpers.js';

const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
const TARGET = '0x3333333333333333333333333333333333333333';

interface Harness {
  readonly builder: StorageQueryBuilder;
  readonly storage: MockStorage;
}

function harness(
  extra: Partial<StorageDecoderContext> = {},
  layoutFor: (fqn: string) => ParsedStorageLayout = loadLayout
): Harness {
  const storage = new MockStorage();
  const context: StorageDecoderContext = {
    async getLayout(fqn) {
      try {
        return layoutFor(fqn);
      } catch {
        throw new ContractNotFoundError(fqn);
      }
    },
    getStorageAt: storage.getStorageAt,
    ...extra,
  };
  return { builder: new StorageQueryBuilder(context), storage };
}

describe('immutability', () => {
  it('lets one partial chain be completed two different ways', async () => {
    const { builder, storage } = harness();
    storage
      .set(mappingSlot(addressKey(ALICE), 4n), word(111))
      .set(mappingSlot(addressKey(BOB), 4n), word(222));

    const base = builder
      .contract('InheritedStorage.sol:InheritedStorage')
      .target(TARGET)
      .name('childMap');

    const alice = await base.key(ALICE).read();
    const bob = await base.key(BOB).read();

    expect(alice.value).toBe(111n);
    expect(bob.value).toBe(222n);
    // The shared prefix was not mutated by either completion.
    expect(base.path).toHaveLength(0);
  });

  it('does not mutate the receiver when appending segments', () => {
    const { builder } = harness();
    const one = builder.contract('X').target(TARGET).name('y').index(1);
    const two = one.index(2);
    expect(one.path).toHaveLength(1);
    expect(two.path).toHaveLength(2);
  });
});

describe('required chain elements', () => {
  it('names what is missing', async () => {
    const { builder } = harness();
    await expect(builder.read()).rejects.toThrow(/\.contract\(/);
    await expect(builder.contract('A').read()).rejects.toThrow(/\.target\(/);
    await expect(builder.contract('A').target(TARGET).read()).rejects.toThrow(/\.name\(/);
  });

  it('surfaces an unknown contract', async () => {
    const { builder } = harness();
    await expect(
      builder.contract('Nope.sol:Nope').target(TARGET).name('x').read()
    ).rejects.toThrow(ContractNotFoundError);
  });
});

describe('reading values end to end', () => {
  it('reads a packed variable and reports slot, offset and raw bytes', async () => {
    const { builder, storage } = harness();
    const packed = packWord(
      { offset: 0, size: 16, value: 5n },
      { offset: 16, size: 8, value: 6n },
      { offset: 24, size: 4, value: 7n }
    );
    storage.set(0n, packed);

    const result = await builder
      .contract('PackedStorage.sol:PackedStorage')
      .target(TARGET)
      .name('c')
      .read();

    expect(result.value).toBe(7n);
    expect(result.slot).toBe(0n);
    expect(result.offset).toBe(24);
    expect(result.rawSlotValue).toEqual(packed);
    expect(result.typeLabel).toBe('uint32');
  });

  it('reads through three mapping levels', async () => {
    const { builder, storage } = harness();
    const slot = mappingSlot(uintKey(7), mappingSlot(addressKey(BOB), mappingSlot(addressKey(ALICE), 0n)));
    storage.set(slot, word(4242));

    const result = await builder
      .contract('NestedMapping.sol:NestedMapping')
      .target(TARGET)
      .name('triple')
      .key(ALICE)
      .key(BOB)
      .key(7)
      .read();

    expect(result.value).toBe(4242n);
    expect(result.slot).toBe(slot);
  });

  it('accepts the .keys() sugar for an all-mapping path', async () => {
    const { builder, storage } = harness();
    const slot = mappingSlot(uintKey(7), mappingSlot(addressKey(BOB), mappingSlot(addressKey(ALICE), 0n)));
    storage.set(slot, word(4242));

    const result = await builder
      .contract('NestedMapping.sol:NestedMapping')
      .target(TARGET)
      .name('triple')
      .keys(ALICE, BOB, 7)
      .read();

    expect(result.value).toBe(4242n);
  });

  it('rejects the .keys() sugar against a mixed-kind path', async () => {
    const { builder } = harness();
    await expect(
      builder
        .contract('MappingToArrayStorage.sol:MappingToArrayStorage')
        .target(TARGET)
        .name('listByAddress')
        .keys(ALICE, 3)
        .read()
    ).rejects.toThrow(PathSegmentKindMismatchError);
  });

  it('reads a packed dynamic-array element with a trailing gap', async () => {
    const { builder, storage } = harness();
    const base = arrayBase(2n);
    storage.set(2n, word(5)); // length
    // Distinct neighbours, so an off-by-one cannot pass by reading a plausible value.
    storage.set(base, packWord({ offset: 0, size: 12, value: 100n }, { offset: 12, size: 12, value: 200n }));
    storage.set(base + 1n, packWord({ offset: 0, size: 12, value: 300n }, { offset: 12, size: 12, value: 400n }));

    const read = (index: number) =>
      builder
        .contract('ArrayStorage.sol:ArrayStorage')
        .target(TARGET)
        .name('gapPacked')
        .index(index)
        .read();

    expect((await read(0)).value).toBe(100n);
    expect((await read(1)).value).toBe(200n);
    expect((await read(2)).value).toBe(300n);
    expect((await read(3)).value).toBe(400n);
    expect((await read(2)).offset).toBe(0);
  });

  it('reads a struct field through an array through a mapping', async () => {
    const { builder, storage } = harness();
    const header = mappingSlot(addressKey(ALICE), 0n);
    const elementBase = arrayBase(header);
    storage.set(header, word(3)); // array length
    storage.set(elementBase + 3n, packWord({ offset: 0, size: 16, value: 11n }, { offset: 16, size: 16, value: 22n }));

    const result = await builder
      .contract('StructStorage.sol:StructStorage')
      .target(TARGET)
      .name('records')
      .key(ALICE)
      .index(1)
      .field('b')
      .read();

    expect(result.value).toBe(22n);
    expect(result.offset).toBe(16);
  });

  it('reads a long string reached through a mapping', async () => {
    const { builder, storage } = harness();
    const text = 'a long enough string to spill across more than one storage slot, definitely.';
    const header = mappingSlot(addressKey(ALICE), 4n);
    storage.setString(header, text);

    const result = await builder
      .contract('StringStorage.sol:StringStorage')
      .target(TARGET)
      .name('textByAddress')
      .key(ALICE)
      .read();

    expect(result.value).toBe(text);
    // rawSlotValue/slot are the HEADER slot for a multi-slot read.
    expect(result.slot).toBe(header);
    expect(result.rawSlotValue).toEqual(storage.get(header));
  });

  it('reads a long string reached through an array', async () => {
    const { builder, storage } = harness();
    const text = 'y'.repeat(70);
    storage.set(5n, word(2)); // texts.length
    storage.setString(arrayBase(5n) + 1n, text);

    const result = await builder
      .contract('StringStorage.sol:StringStorage')
      .target(TARGET)
      .name('texts')
      .index(1)
      .read();

    expect(result.value).toBe(text);
  });

  it('reads bytes as hex', async () => {
    const { builder, storage } = harness();
    storage.setDynamicBytes(2n, hexToBytes('0xc0ffee'));
    const result = await builder
      .contract('StringStorage.sol:StringStorage')
      .target(TARGET)
      .name('shortBlob')
      .read();
    expect(result.value).toBe('0xc0ffee');
  });
});

describe('bounds checking', () => {
  it('reports out-of-bounds; the speculative value read is discarded', async () => {
    const { builder, storage } = harness();
    storage.set(0n, word(2)); // addresses.length = 2

    await expect(
      builder
        .contract('ArrayStorage.sol:ArrayStorage')
        .target(TARGET)
        .name('addresses')
        .index(2)
        .read()
    ).rejects.toThrow(IndexOutOfBoundsError);

    // The length slot and the element slot go out together; nothing else is read, and the
    // element's value is never returned.
    expect(new Set(storage.reads.map((r) => r.slot))).toEqual(new Set([0n, arrayBase(0n) + 2n]));
    expect(storage.reads).toHaveLength(2);
  });
});

describe('path validation reaches the builder', () => {
  it('rejects a path that terminates on a composite type', async () => {
    const { builder } = harness();
    await expect(
      builder.contract('StructStorage.sol:StructStorage').target(TARGET).name('outer').read()
    ).rejects.toThrow(PathSegmentCountMismatchError);
  });

  it('rejects the wrong segment kind', async () => {
    const { builder } = harness();
    await expect(
      builder
        .contract('InheritedStorage.sol:InheritedStorage')
        .target(TARGET)
        .name('childMap')
        .index(0)
        .read()
    ).rejects.toThrow(PathSegmentKindMismatchError);
  });
});

describe('blockTag propagation', () => {
  it('threads ONE resolved block through obligations, header read and value read', async () => {
    const { builder, storage } = harness();
    const text = 'z'.repeat(80); // long: forces a header read plus three data reads
    storage.set(5n, word(3));
    storage.setString(arrayBase(5n) + 2n, text);

    const result = await builder
      .contract('StringStorage.sol:StringStorage')
      .target(TARGET)
      .name('texts')
      .index(2)
      .at(1234)
      .read();

    expect(result.value).toBe(text);
    expect(result.blockTag).toBe(1234);

    // Multiple distinct phases actually ran...
    expect(storage.reads.length).toBeGreaterThanOrEqual(5);
    // ...and every single one observed the same pinned block and address.
    const tags = new Set(storage.reads.map((r) => r.blockTag));
    expect([...tags]).toEqual([1234]);
    expect([...new Set(storage.reads.map((r) => r.address))]).toEqual([TARGET]);
  });

  it('defaults to "latest"', async () => {
    const { builder, storage } = harness();
    storage.set(0n, word(1));
    const result = await builder
      .contract('SimpleStorage.sol:SimpleStorage')
      .target(TARGET)
      .name('count')
      .read();
    expect(result.blockTag).toBe('latest');
    expect(storage.reads.every((r) => r.blockTag === 'latest')).toBe(true);
  });

  it('passes the same block to the contract-identity check', async () => {
    const seen: BlockTag[] = [];
    const { builder, storage } = harness({
      async getDeployedBytecode() {
        return '0x6080';
      },
      async getCode(_address, blockTag) {
        seen.push(blockTag);
        return '0x6080';
      },
    });
    storage.set(0n, word(1));

    await builder
      .contract('SimpleStorage.sol:SimpleStorage')
      .target(TARGET)
      .name('count')
      .at('0x10')
      .read();

    expect(seen).toEqual(['0x10']);
  });
});

describe('contract/address sanity check', () => {
  const deployed = `0x6080${'ab'.repeat(64)}`;

  function withCode(onChain: string) {
    return harness({
      async getDeployedBytecode() {
        return deployed;
      },
      async getCode() {
        return onChain;
      },
    });
  }

  it('accepts code that matches in length and first 32 bytes', async () => {
    // Tail bytes differ (immutables/metadata), which must be tolerated.
    const { builder, storage } = withCode(`${deployed.slice(0, -8)}deadbeef`);
    storage.set(0n, word(9));
    await expect(
      builder.contract('SimpleStorage.sol:SimpleStorage').target(TARGET).name('count').read()
    ).resolves.toMatchObject({ value: 9n });
  });

  it('rejects an address with no code', async () => {
    const { builder } = withCode('0x');
    await expect(
      builder.contract('SimpleStorage.sol:SimpleStorage').target(TARGET).name('count').read()
    ).rejects.toThrow(/no contract code/);
  });

  it('rejects a length mismatch', async () => {
    const { builder } = withCode(`${deployed}ff`);
    await expect(
      builder.contract('SimpleStorage.sol:SimpleStorage').target(TARGET).name('count').read()
    ).rejects.toThrow(ContractMismatchError);
  });

  it('rejects a first-32-bytes mismatch', async () => {
    const { builder } = withCode(`0x6081${'ab'.repeat(64)}`);
    await expect(
      builder.contract('SimpleStorage.sol:SimpleStorage').target(TARGET).name('count').read()
    ).rejects.toThrow(/first 32 bytes/);
  });

  it('is skipped entirely when the adapter cannot supply both sides', async () => {
    const { builder, storage } = harness();
    storage.set(0n, word(1));
    await expect(
      builder.contract('SimpleStorage.sol:SimpleStorage').target(TARGET).name('count').read()
    ).resolves.toMatchObject({ value: 1n });
  });
});

describe('decoded native types', () => {
  it('covers each family', async () => {
    const { builder, storage } = harness();
    const base = builder.contract('SimpleStorage.sol:SimpleStorage').target(TARGET);

    storage.set(0n, word(2n ** 200n));
    storage.set(1n, hexToBytes(`0x${'ff'.repeat(32)}`));
    storage.set(2n, packWord({ offset: 0, size: 1, value: 1n }, { offset: 1, size: 20, value: hexToBytes(ALICE) }));
    storage.set(3n, utf8ToBytes('0123456789abcdef0123456789abcdef'));
    storage.set(4n, packWord({ offset: 0, size: 4, value: hexToBytes('0x0badf00d') }));

    expect((await base.name('count').read()).value).toBe(2n ** 200n);
    expect((await base.name('signedCount').read()).value).toBe(-1n);
    expect((await base.name('flag').read()).value).toBe(true);
    expect((await base.name('owner').read()).value).toBe(
      '0x1111111111111111111111111111111111111111'
    );
    expect((await base.name('selector').read()).value).toBe('0x0badf00d');
  });
});
