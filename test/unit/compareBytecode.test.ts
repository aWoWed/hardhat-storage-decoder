import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareBytecode } from '../../src/core/query/compareBytecode.js';
import type { ByteRange, ExpectedBytecode } from '../../src/core/query/StorageQueryBuilder.js';

// Real solc output throughout: what these tests must pin down is what the compiler emits. No
// test here hand-writes a trailer or a reference, except the malformed-input cases at the end.
// `solc` ships no types, and is loaded here the way `scripts/generate-fixtures.mjs` loads it.
const solc = createRequire(path.join(process.cwd(), 'package.json'))('solc') as {
  compile(input: string): string;
};

const SIMPLE_STORAGE = readFileSync(
  path.join(process.cwd(), 'test/fixtures/contracts/SimpleStorage.sol'),
  'utf8'
);
const SIMPLE = 'SimpleStorage';

const CONSTANTS = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
contract Answer { function get() external pure returns (uint256) { return 1111; } }
contract Other { function get() external pure returns (uint256) { return 2222; } }
`;

const LINKED = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
library Math { function twice(uint256 x) external pure returns (uint256) { return x * 2; } }
contract Linked {
  uint256 public value;
  address public immutable deployer;
  constructor() { deployer = msg.sender; }
  function run(uint256 x) external { value = Math.twice(x); }
}
`;

const FACTORY = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
contract Child { uint256 public value = 7; }
contract Factory {
  function make() external returns (address) { return address(new Child()); }
}
`;

/** One contract's runtime output, as solc reports it. */
interface Compiled extends ExpectedBytecode {
  readonly immutableReferences: Readonly<Record<string, readonly ByteRange[]>>;
  readonly linkReferences: Readonly<Record<string, Readonly<Record<string, readonly ByteRange[]>>>>;
}

/** solc-js compile of one source under one path; `settings` extend the default output. */
function compile(
  contractName: string,
  content: string,
  { path = 'contracts/Source.sol', ...settings }: Record<string, unknown> & { path?: string } = {}
): Compiled {
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: 'Solidity',
        sources: { [path]: { content } },
        settings: {
          evmVersion: 'cancun',
          outputSelection: { '*': { '*': ['evm.deployedBytecode'] } },
          ...settings,
        },
      })
    )
  ) as {
    errors?: readonly { severity: string; formattedMessage: string }[];
    contracts: Record<string, Record<string, { evm: { deployedBytecode: Compiled } }>>;
  };
  const failures = (output.errors ?? []).filter((error) => error.severity === 'error');
  if (failures.length > 0) throw new Error(failures[0]?.formattedMessage);
  const contract = output.contracts[path]?.[contractName];
  if (contract === undefined) throw new Error(`solc did not output ${contractName}`);
  return contract.evm.deployedBytecode;
}

/** What a deployment does to the artifact's code: writes values into the given ranges. */
function deploy(code: string, ranges: readonly ByteRange[], fillByte: string): string {
  let deployed = code;
  for (const { start, length } of ranges) {
    deployed =
      deployed.slice(0, start * 2) +
      fillByte.repeat(length) +
      deployed.slice((start + length) * 2);
  }
  return deployed;
}

const immutablesOf = (compiled: Compiled): ByteRange[] =>
  Object.values(compiled.immutableReferences).flat();

const librariesOf = (compiled: Compiled): ByteRange[] =>
  Object.values(compiled.linkReferences).flatMap((file) => Object.values(file).flat());

/** Offset of the metadata trailer: the CBOR map the last two bytes give the length of. */
const trailerStart = (code: string): number =>
  code.length / 2 - 2 - Number.parseInt(code.slice(-4), 16);

/** Which bytes differ between two same-length pieces of code. */
function differingBytes(a: string, b: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < a.length / 2; i += 1) {
    if (a.slice(i * 2, i * 2 + 2) !== b.slice(i * 2, i * 2 + 2)) bytes.push(i);
  }
  return bytes;
}

describe('compareBytecode against real solc output', () => {
  it('rejects a different contract of the same length and the same first 32 bytes', () => {
    const answer = compile('Answer', CONSTANTS);
    const other = compile('Other', CONSTANTS);
    // The precondition is the whole point of the test: the old check accepted this pair.
    expect(other.object).toHaveLength(answer.object.length);
    expect(other.object.slice(0, 64)).toBe(answer.object.slice(0, 64));

    expect(compareBytecode(answer, other.object)).toMatch(/differs .* at byte \d+/);
  });

  it('accepts its own artifact', () => {
    const compiled = compile(SIMPLE, SIMPLE_STORAGE);
    expect(compareBytecode(compiled, compiled.object)).toBeUndefined();
  });

  it('accepts a real immutable, and rejects it when the references are missing', () => {
    const compiled = compile(SIMPLE, SIMPLE_STORAGE);
    const ranges = immutablesOf(compiled);
    expect(ranges).toHaveLength(1);
    const onChain = deploy(compiled.object, ranges, 'd5');

    expect(compareBytecode(compiled, onChain)).toBeUndefined();
    expect(compareBytecode({ object: compiled.object }, onChain)).toMatch(
      new RegExp(`at byte ${ranges[0]?.start}, .*no immutable references`)
    );
  });

  it('rejects a change outside the immutable next to it', () => {
    const compiled = compile(SIMPLE, SIMPLE_STORAGE);
    const [range] = immutablesOf(compiled);
    if (range === undefined) throw new Error('SimpleStorage has an immutable');
    const justAfter = range.start + range.length;
    const onChain = deploy(compiled.object, [{ start: justAfter, length: 1 }], 'fe');

    expect(compareBytecode(compiled, onChain)).toContain(`at byte ${justAfter}`);
  });

  it('accepts a real linked library and immutable together, with and without the optimizer', () => {
    for (const optimizer of [{ enabled: false }, { enabled: true, runs: 200 }]) {
      const compiled = compile('Linked', LINKED, { optimizer });
      const libraries = librariesOf(compiled);
      expect(libraries.length).toBeGreaterThan(0);
      expect(compiled.object).toContain('__$');
      const onChain = deploy(
        deploy(compiled.object, libraries, 'aa'),
        immutablesOf(compiled),
        'd5'
      );
      expect(onChain).not.toContain('__$');

      expect(compareBytecode(compiled, onChain), JSON.stringify(optimizer)).toBeUndefined();
    }
  });

  it('masks library placeholders even without link references', () => {
    const compiled = compile('Linked', LINKED);
    const onChain = deploy(compiled.object, librariesOf(compiled), 'aa');
    const withoutLinks = { object: compiled.object, immutableReferences: compiled.immutableReferences };

    expect(compareBytecode(withoutLinks, onChain)).toBeUndefined();
  });

  it('accepts a real immutable with the optimizer on', () => {
    const compiled = compile(SIMPLE, SIMPLE_STORAGE, { optimizer: { enabled: true, runs: 200 } });
    expect(compareBytecode(compiled, deploy(compiled.object, immutablesOf(compiled), 'd5')))
      .toBeUndefined();
  });

  it('rejects a build with the optimizer set differently', () => {
    const off = compile(SIMPLE, SIMPLE_STORAGE);
    const on = compile(SIMPLE, SIMPLE_STORAGE, { optimizer: { enabled: true, runs: 200 } });
    expect(compareBytecode(off, on.object)).toBeDefined();
  });

  it('rejects a build with a different evmVersion', () => {
    const cancun = compile(SIMPLE, SIMPLE_STORAGE);
    const paris = compile(SIMPLE, SIMPLE_STORAGE, { evmVersion: 'paris' });
    expect(compareBytecode(cancun, paris.object)).toMatch(/is \d+ bytes/);
    expect(compareBytecode(paris, cancun.object)).toMatch(/is \d+ bytes/);
  });

  describe('metadata trailers', () => {
    const variants = [
      ['ipfs', { bytecodeHash: 'ipfs' }, 53],
      ['bzzr1', { bytecodeHash: 'bzzr1' }, 52],
      ['no hash', { bytecodeHash: 'none' }, 12],
    ] as const;

    for (const [name, metadata, trailerSize] of variants) {
      it(`ignores a trailer-only difference with ${name}`, () => {
        const a = compile(SIMPLE, SIMPLE_STORAGE, { metadata });
        const b = compile(SIMPLE, `${SIMPLE_STORAGE}// a comment changes only the hash\n`, {
          metadata,
          path: 'project/contracts/Source.sol',
        });
        const start = trailerStart(a.object);
        expect(a.object.length / 2 - start - 2).toBe(trailerSize - 2);
        if (name !== 'no hash') {
          expect(differingBytes(a.object, b.object).every((byte) => byte >= start)).toBe(true);
          expect(a.object).not.toBe(b.object);
        }

        expect(compareBytecode(a, deploy(b.object, immutablesOf(a), 'd5'))).toBeUndefined();
      });

      it(`still sees a code difference with ${name}`, () => {
        const a = compile('Answer', CONSTANTS, { metadata });
        const b = compile('Other', CONSTANTS, { metadata });
        expect(compareBytecode(a, b.object)).toMatch(/at byte \d+/);
      });
    }

    it('passes across trailer kinds when the code is the same', () => {
      const ipfs = compile('Answer', CONSTANTS, { metadata: { bytecodeHash: 'ipfs' } });
      const bzzr1 = compile('Answer', CONSTANTS, { metadata: { bytecodeHash: 'bzzr1' } });
      expect(compareBytecode(ipfs, bzzr1.object)).toBeUndefined();
    });

    it('handles appendCBOR: false, where the code has no trailer to remove', () => {
      const bare = compile('Answer', CONSTANTS, { metadata: { appendCBOR: false } });
      const other = compile('Other', CONSTANTS, { metadata: { appendCBOR: false } });
      expect(compareBytecode(bare, bare.object)).toBeUndefined();
      expect(compareBytecode(bare, other.object)).toMatch(/at byte \d+/);
    });

    it('rejects a difference in the tail of code without a trailer', () => {
      const bare = compile('Answer', CONSTANTS, { metadata: { appendCBOR: false } });
      const lastByte = bare.object.length / 2 - 1;
      const onChain = deploy(bare.object, [{ start: lastByte, length: 1 }], 'ee');
      expect(compareBytecode(bare, onChain)).toContain(`at byte ${lastByte}`);
    });

    it('rejects a build with a trailer against the same source built without one', () => {
      // solc puts an INVALID opcode before a trailer, which stays once the trailer is removed.
      const withTrailer = compile('Answer', CONSTANTS);
      const bare = compile('Answer', CONSTANTS, { metadata: { appendCBOR: false } });
      expect(compareBytecode(withTrailer, bare.object)).toMatch(/is \d+ bytes/);
      expect(compareBytecode(bare, withTrailer.object)).toMatch(/is \d+ bytes/);
    });
  });

  describe('a deployment from the other Hardhat major', () => {
    // With `evmVersion` pinned, what differs between the majors is the source path solc sees
    // (Hardhat 3 prefixes `project/`) and who deployed. A cross-version probe measured
    // exactly that on real deployments.
    const hh2 = compile(SIMPLE, SIMPLE_STORAGE, { path: 'contracts/SimpleStorage.sol' });
    const hh3 = compile(SIMPLE, SIMPLE_STORAGE, { path: 'project/contracts/SimpleStorage.sol' });

    it('really does differ, in the trailer only, before deployment', () => {
      expect(hh2.object).not.toBe(hh3.object);
      expect(differingBytes(hh2.object, hh3.object).every((b) => b >= trailerStart(hh2.object)))
        .toBe(true);
    });

    it('passes when a Hardhat 2 project reads a Hardhat 3 deployment', () => {
      expect(compareBytecode(hh2, deploy(hh3.object, immutablesOf(hh3), '33'))).toBeUndefined();
    });

    it('passes when a Hardhat 3 project reads a Hardhat 2 deployment', () => {
      expect(compareBytecode(hh3, deploy(hh2.object, immutablesOf(hh2), '22'))).toBeUndefined();
    });

    it('is rejected on default settings, where the majors build for different EVMs', () => {
      const hh2Default = compile(SIMPLE, SIMPLE_STORAGE, {
        path: 'contracts/SimpleStorage.sol',
        evmVersion: 'paris',
      });
      expect(compareBytecode(hh3, deploy(hh2Default.object, immutablesOf(hh2Default), '22')))
        .toMatch(/is \d+ bytes/);
    });
  });

  describe('interior metadata hashes (embedded `new X` code)', () => {
    const a = compile('Factory', FACTORY, { path: 'contracts/Factory.sol' });
    const b = compile('Factory', FACTORY, { path: 'project/contracts/Factory.sol' });

    it('settles the marker rule: only two hashes differ, each right after the marker', () => {
      expect(b.object).toHaveLength(a.object.length);
      const start = trailerStart(a.object);
      const interior = differingBytes(a.object, b.object).filter((byte) => byte < start);
      expect(interior.length).toBeGreaterThan(0);

      const marker = 'a264697066735822';
      const payloadStart = a.object.indexOf(marker) / 2 + marker.length / 2;
      expect(payloadStart).toBeGreaterThan(marker.length / 2);
      expect(b.object.indexOf(marker)).toBe(a.object.indexOf(marker));
      expect(interior.every((byte) => byte >= payloadStart && byte < payloadStart + 34)).toBe(true);
    });

    it('passes across source paths, both ways', () => {
      expect(compareBytecode(a, b.object)).toBeUndefined();
      expect(compareBytecode(b, a.object)).toBeUndefined();
    });

    it('rejects a difference in the embedded code outside its hash', () => {
      const markerAt = a.object.indexOf('a264697066735822') / 2;
      const onChain = deploy(a.object, [{ start: markerAt - 1, length: 1 }], 'ee');
      expect(compareBytecode(a, onChain)).toContain(`at byte ${markerAt - 1}`);
    });

    it('rejects a hash difference when the marker is on one side only', () => {
      const markerAt = a.object.indexOf('a264697066735822') / 2;
      // Breaks the marker on the deployed side, which leaves its payload nothing to excuse it.
      const onChain = deploy(deploy(a.object, [{ start: markerAt, length: 1 }], 'ee'),
        [{ start: markerAt + 8, length: 1 }], 'ee');
      expect(compareBytecode(a, onChain)).toContain(`at byte ${markerAt}`);
    });

    it('does not excuse a hash difference at the same offset when the marker differs', () => {
      const code = `aabb${'a2'}64697066735822${'11'.repeat(34)}ccdd`;
      const other = `aabb${'a3'}64697066735822${'22'.repeat(34)}ccdd`;
      expect(compareBytecode({ object: code, immutableReferences: {} }, other)).toContain('at byte 2');
    });
  });
});

describe('compareBytecode on malformed input', () => {
  const code = `6080${'ab'.repeat(30)}`;

  it('rejects an immutable range outside the code', () => {
    const immutableReferences = { '1': [{ start: 31, length: 2 }] };
    expect(compareBytecode({ object: code, immutableReferences }, code)).toMatch(
      /immutable reference \(start 31, length 2\) falls outside its 32 bytes/
    );
  });

  it('rejects a library range outside the code', () => {
    const linkReferences = { 'a.sol': { L: [{ start: 40, length: 20 }] } };
    expect(compareBytecode({ object: code, linkReferences }, code)).toMatch(
      /library reference .* falls outside/
    );
  });

  it('rejects a range that is negative or not an integer', () => {
    for (const range of [{ start: -1, length: 2 }, { start: 1.5, length: 2 }, { start: 0, length: -1 }]) {
      expect(compareBytecode({ object: code, immutableReferences: { '1': [range] } }, code))
        .toMatch(/falls outside/);
    }
  });

  it('does not take a length suffix for a trailer unless a known key starts the map', () => {
    // Ends in a plausible length (5 bytes) over a CBOR map head, but with no metadata key.
    const fake = (body: string): string => `6080${body}a1616101ff0005`;
    expect(compareBytecode({ object: fake('aa') }, fake('bb'))).toContain('at byte 2');
  });

  it('does not take an impossible length suffix for a trailer', () => {
    expect(compareBytecode({ object: 'aaffff' }, 'bbffff')).toContain('at byte 0');
    expect(compareBytecode({ object: 'aa0000' }, 'bb0000')).toContain('at byte 0');
  });

  it('handles code too short to hold a length', () => {
    expect(compareBytecode({ object: 'aa' }, 'aa')).toBeUndefined();
    expect(compareBytecode({ object: 'aa' }, 'bb')).toContain('at byte 0');
  });
});
