/**
 * The Hardhat 2 build-info reader, driven through a fake `hre.artifacts` and real files.
 *
 * Only `readBuildInfo.ts` is imported: its Hardhat imports are type-only, whereas the adapter's
 * entrypoint registers tasks at import time and cannot be loaded outside a Hardhat context.
 */

import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HardhatRuntimeEnvironment } from 'hardhat/types/runtime';
import { getVariable } from '../../../src/core/layout/parseStorageLayout.js';
import { AmbiguousVariableError, ContractNotFoundError } from '../../../src/core/query/errors.js';
import { createBuildInfoReader } from '../../../src/hardhat2/readBuildInfo.js';

const VAULT = 'contracts/Vault.sol:Vault';
const TOKEN = 'contracts/Token.sol:Token';

/** A one-variable layout in solc's own shape; `label` is what the tests tell layouts apart by. */
function uintLayout(label: string) {
  return {
    storage: [
      { astId: 3, contract: VAULT, label, offset: 0, slot: '0', type: 't_uint256' },
    ],
    types: {
      t_uint256: { encoding: 'inplace', label: 'uint256', numberOfBytes: '32' },
    },
  };
}

/** A source unit declaring one contract with one `constant` state variable. */
function astWithConstant(constantName: string) {
  return {
    nodeType: 'SourceUnit',
    nodes: [
      {
        nodeType: 'ContractDefinition',
        nodes: [
          {
            nodeType: 'VariableDeclaration',
            stateVariable: true,
            mutability: 'constant',
            name: constantName,
          },
        ],
      },
    ],
  };
}

/** A source unit at `absolutePath` declaring `contractName` with one state variable `x`. */
function astDeclaringX(absolutePath: string, contractName: string, variableId: number) {
  return {
    nodeType: 'SourceUnit',
    absolutePath,
    nodes: [
      {
        nodeType: 'ContractDefinition',
        name: contractName,
        nodes: [
          {
            nodeType: 'VariableDeclaration',
            id: variableId,
            name: 'x',
            stateVariable: true,
            mutability: 'mutable',
            visibility: 'private',
          },
        ],
      },
    ],
  };
}

/**
 * The layout solc emits for a contract whose base and itself each declare a private `x`: two
 * entries with the same label and the same `contract` (the one compiled), told apart by AST id.
 */
function shadowedLayout(compiled: string, baseVariableId: number, ownVariableId: number) {
  return {
    storage: [
      { astId: baseVariableId, contract: compiled, label: 'x', offset: 0, slot: '0', type: 't_uint256' },
      { astId: ownVariableId, contract: compiled, label: 'x', offset: 0, slot: '1', type: 't_uint256' },
    ],
    types: { t_uint256: { encoding: 'inplace', label: 'uint256', numberOfBytes: '32' } },
  };
}

interface FakeBuild {
  readonly buildInfo: unknown;
  /** How many times `output.sources` has been read, i.e. how often the ASTs were reached for. */
  sourcesReads(): number;
}

function fakeBuild(id: string, vaultLabel: string): FakeBuild {
  let reads = 0;
  const sources = {
    'contracts/Vault.sol': { id: 0, ast: astWithConstant('VAULT_LIMIT') },
    'contracts/Token.sol': { id: 1, ast: astWithConstant('TOKEN_LIMIT') },
  };
  const buildInfo = {
    id,
    _format: 'hh-sol-build-info-1',
    solcVersion: '0.8.26',
    solcLongVersion: '0.8.26+commit.8a97fa7a',
    input: {},
    output: {
      contracts: {
        'contracts/Vault.sol': {
          Vault: {
            storageLayout: uintLayout(vaultLabel),
            evm: { deployedBytecode: { object: '6001' } },
          },
        },
        'contracts/Token.sol': {
          Token: { storageLayout: uintLayout('supply') },
        },
      },
      get sources() {
        reads += 1;
        return sources;
      },
    },
  };
  return { buildInfo, sourcesReads: () => reads };
}

interface FakeHre {
  readonly hre: HardhatRuntimeEnvironment;
  readonly calls: { getBuildInfo: number; clearCache: number };
  /** What `getBuildInfo` resolves to; an `Error` makes it reject, as Hardhat does for a miss. */
  current: unknown;
  artifactPath(fullyQualifiedName: string): string;
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fakeHre(options: { withArtifactPaths?: boolean } = {}): Promise<FakeHre> {
  const root = await mkdtemp(path.join(tmpdir(), 'hsd-hh2-'));
  tempDirs.push(root);

  const artifactPath = (fullyQualifiedName: string): string => {
    const separator = fullyQualifiedName.lastIndexOf(':');
    if (separator < 0) throw new Error(`not a fully qualified name: ${fullyQualifiedName}`);
    return path.join(
      root,
      fullyQualifiedName.slice(0, separator),
      `${fullyQualifiedName.slice(separator + 1)}.json`
    );
  };

  const fake: FakeHre = {
    hre: undefined as unknown as HardhatRuntimeEnvironment,
    calls: { getBuildInfo: 0, clearCache: 0 },
    current: undefined,
    artifactPath,
  };
  const artifacts = {
    async getBuildInfo(): Promise<unknown> {
      fake.calls.getBuildInfo += 1;
      // A real read is asynchronous; yielding here is what lets concurrent callers overlap.
      await new Promise((resolve) => setImmediate(resolve));
      if (fake.current instanceof Error) throw fake.current;
      return fake.current;
    },
    clearCache(): void {
      fake.calls.clearCache += 1;
    },
    ...(options.withArtifactPaths === false
      ? {}
      : { formArtifactPathFromFullyQualifiedName: artifactPath }),
  };
  return Object.assign(fake, { hre: { artifacts } as unknown as HardhatRuntimeEnvironment });
}

/** Write the artifact file and pin its mtime, so no test depends on the clock's granularity. */
async function writeArtifact(file: string, content: string, mtimeSeconds: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  await utimes(file, mtimeSeconds, mtimeSeconds);
}

describe('createBuildInfoReader (Hardhat 2)', () => {
  it('shares one load between 100 concurrent first reads', async () => {
    const fake = await fakeHre();
    await writeArtifact(fake.artifactPath(VAULT), '{"v":1}', 1_700_000_000);
    fake.current = fakeBuild('build-1', 'total').buildInfo;
    const reader = createBuildInfoReader(fake.hre);

    const layouts = await Promise.all(
      Array.from({ length: 100 }, () => reader.getLayout(VAULT))
    );

    expect(fake.calls.getBuildInfo).toBe(1);
    expect(new Set(layouts).size).toBe(1);
    expect(layouts[0]?.variables.map((variable) => variable.label)).toEqual(['total']);
  });

  it('does not reach for the ASTs again for a second contract of the same build', async () => {
    const fake = await fakeHre();
    await writeArtifact(fake.artifactPath(VAULT), '{"v":1}', 1_700_000_000);
    await writeArtifact(fake.artifactPath(TOKEN), '{"t":1}', 1_700_000_000);
    const build = fakeBuild('build-1', 'total');
    fake.current = build.buildInfo;
    const reader = createBuildInfoReader(fake.hre);

    await reader.getLayout(VAULT);
    const readsAfterFirst = build.sourcesReads();
    expect(readsAfterFirst).toBeGreaterThan(0);

    const token = await reader.getLayout(TOKEN);

    expect(build.sourcesReads()).toBe(readsAfterFirst);
    expect(token.variables.map((variable) => variable.label)).toEqual(['supply']);
    // Hardhat has no lookup by build id, so the build-info itself is fetched once per contract.
    expect(fake.calls.getBuildInfo).toBe(2);
  });

  it('does not cache a failed load', async () => {
    const fake = await fakeHre();
    fake.current = new Error('HH700: Artifact for contract "Vault" not found.');
    const reader = createBuildInfoReader(fake.hre);

    const failure = await reader.getLayout(VAULT).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ContractNotFoundError);
    expect((failure as Error).message).toContain('HH700');

    // The compile that was missing has now happened.
    await writeArtifact(fake.artifactPath(VAULT), '{"v":1}', 1_700_000_000);
    fake.current = fakeBuild('build-1', 'total').buildInfo;

    const layout = await reader.getLayout(VAULT);
    expect(layout.variables.map((variable) => variable.label)).toEqual(['total']);
    expect(fake.calls.getBuildInfo).toBe(2);
    // Hardhat remembers the build-info path it resolved for the failed attempt, so the retry
    // has to drop that first. Every load does: one clear per attempt.
    expect(fake.calls.clearCache).toBe(2);
  });

  it('does not cache a failed load when the artifact file never changes', async () => {
    const fake = await fakeHre();
    await writeArtifact(fake.artifactPath(VAULT), '{"v":1}', 1_700_000_000);
    const reader = createBuildInfoReader(fake.hre);

    // `undefined` is what Hardhat returns for an artifact with no build-info behind it.
    await expect(reader.getLayout(VAULT)).rejects.toBeInstanceOf(ContractNotFoundError);
    await expect(reader.getDeployedBytecode(VAULT)).rejects.toBeInstanceOf(ContractNotFoundError);

    fake.current = fakeBuild('build-1', 'total').buildInfo;
    await expect(reader.getDeployedBytecode(VAULT)).resolves.toBe('0x6001');
    expect(fake.calls.getBuildInfo).toBe(3);
  });

  it('keeps using the cached layout while the artifact file is unchanged', async () => {
    const fake = await fakeHre();
    await writeArtifact(fake.artifactPath(VAULT), '{"v":1}', 1_700_000_000);
    fake.current = fakeBuild('build-1', 'total').buildInfo;
    const reader = createBuildInfoReader(fake.hre);

    const first = await reader.getLayout(VAULT);
    // Even if Hardhat would now answer differently, an unchanged artifact means no reload.
    fake.current = fakeBuild('build-2', 'renamed').buildInfo;
    const second = await reader.getLayout(VAULT);

    expect(second).toBe(first);
    expect(fake.calls.getBuildInfo).toBe(1);
    // The one clear belongs to the first load; the cached read adds none.
    expect(fake.calls.clearCache).toBe(1);
  });

  it('reloads after a recompile rewrites the artifact', async () => {
    const fake = await fakeHre();
    const file = fake.artifactPath(VAULT);
    await writeArtifact(file, '{"v":1}', 1_700_000_000);
    fake.current = fakeBuild('build-1', 'total').buildInfo;
    const reader = createBuildInfoReader(fake.hre);

    const before = await reader.getLayout(VAULT);
    expect(before.variables.map((variable) => variable.label)).toEqual(['total']);

    // Same byte length on purpose: the modification time alone must be enough.
    await writeArtifact(file, '{"v":2}', 1_700_000_100);
    fake.current = fakeBuild('build-2', 'renamed').buildInfo;

    const after = await reader.getLayout(VAULT);
    expect(after.variables.map((variable) => variable.label)).toEqual(['renamed']);
    // One clear per load: the first read and the reload.
    expect(fake.calls.clearCache).toBe(2);
    expect(fake.calls.getBuildInfo).toBe(2);

    // The reloaded entry is itself cached against the new stamp.
    expect(await reader.getLayout(VAULT)).toBe(after);
    expect(fake.calls.getBuildInfo).toBe(2);
    expect(fake.calls.clearCache).toBe(2);
  });

  it('reloads when only the size of the artifact changed', async () => {
    const fake = await fakeHre();
    const file = fake.artifactPath(VAULT);
    await writeArtifact(file, '{"v":1}', 1_700_000_000);
    fake.current = fakeBuild('build-1', 'total').buildInfo;
    const reader = createBuildInfoReader(fake.hre);
    await reader.getLayout(VAULT);

    await writeArtifact(file, '{"v":1,"more":true}', 1_700_000_000);
    expect((await stat(file)).mtimeMs).toBe(1_700_000_000_000);
    fake.current = fakeBuild('build-2', 'renamed').buildInfo;

    const after = await reader.getLayout(VAULT);
    expect(after.variables.map((variable) => variable.label)).toEqual(['renamed']);
    expect(fake.calls.clearCache).toBe(2);
  });

  it('reports a removed artifact through the existing not-found error', async () => {
    const fake = await fakeHre();
    const file = fake.artifactPath(VAULT);
    await writeArtifact(file, '{"v":1}', 1_700_000_000);
    fake.current = fakeBuild('build-1', 'total').buildInfo;
    const reader = createBuildInfoReader(fake.hre);
    await reader.getLayout(VAULT);

    await rm(file);
    fake.current = new Error('HH700: Artifact for contract "Vault" not found.');

    await expect(reader.getLayout(VAULT)).rejects.toBeInstanceOf(ContractNotFoundError);
    expect(fake.calls.clearCache).toBe(2);
  });

  it('serves the layout and the deployed bytecode from one load', async () => {
    const fake = await fakeHre();
    await writeArtifact(fake.artifactPath(VAULT), '{"v":1}', 1_700_000_000);
    fake.current = fakeBuild('build-1', 'total').buildInfo;
    const reader = createBuildInfoReader(fake.hre);

    const [layout, bytecode] = await Promise.all([
      reader.getLayout(VAULT),
      reader.getDeployedBytecode(VAULT),
    ]);

    expect(layout.variables.map((variable) => variable.label)).toEqual(['total']);
    expect(bytecode).toBe('0x6001');
    expect(fake.calls.getBuildInfo).toBe(1);

    // And sequentially, in the other order, on a contract that has no bytecode in its output.
    expect(await reader.getDeployedBytecode(TOKEN)).toBeUndefined();
    await reader.getLayout(TOKEN);
    expect(fake.calls.getBuildInfo).toBe(2);
  });

  it('still reads when Hardhat has no formArtifactPathFromFullyQualifiedName', async () => {
    const fake = await fakeHre({ withArtifactPaths: false });
    fake.current = fakeBuild('build-1', 'total').buildInfo;
    const reader = createBuildInfoReader(fake.hre);

    const layouts = await Promise.all([reader.getLayout(VAULT), reader.getLayout(VAULT)]);
    expect(layouts[0]?.variables.map((variable) => variable.label)).toEqual(['total']);
    expect(await reader.getLayout(VAULT)).toBe(layouts[0]);
    expect(await reader.getDeployedBytecode(VAULT)).toBe('0x6001');

    // Without a way to validate, the entry is kept for the life of the reader: one load, and
    // the one clear that precedes it.
    expect(fake.calls.getBuildInfo).toBe(1);
    expect(fake.calls.clearCache).toBe(1);
  });

  it('still reads when the artifact path lookup throws', async () => {
    const fake = await fakeHre();
    (fake.hre.artifacts as { formArtifactPathFromFullyQualifiedName: unknown })
      .formArtifactPathFromFullyQualifiedName = () => {
      throw new Error('HH: unexpected');
    };
    fake.current = fakeBuild('build-1', 'total').buildInfo;
    const reader = createBuildInfoReader(fake.hre);

    const layout = await reader.getLayout(VAULT);
    expect(layout.variables.map((variable) => variable.label)).toEqual(['total']);
    expect(await reader.getLayout(VAULT)).toBe(layout);
    expect(fake.calls.getBuildInfo).toBe(1);
  });

  it('keeps the existing error for a name that is not fully qualified', async () => {
    const fake = await fakeHre();
    fake.current = fakeBuild('build-1', 'total').buildInfo;
    const reader = createBuildInfoReader(fake.hre);

    const failure = await reader.getLayout('Vault').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ContractNotFoundError);
    expect((failure as Error).message).toContain(
      'expected a fully-qualified name of the form "contracts/Vault.sol:Vault"'
    );
    expect(fake.calls.getBuildInfo).toBe(0);
  });

  describe('a name declared by both a base contract and the derived one', () => {
    const DERIVED = 'contracts/Derived.sol:Derived';

    /** A build of `Derived is Base`, with `Base` in `baseSource`. */
    function shadowedBuild(baseSource: string) {
      const derivedAst = astDeclaringX('contracts/Derived.sol', 'Derived', 9);
      const sources: Record<string, { id: number; ast: unknown }> = {
        'contracts/Derived.sol': { id: 0, ast: derivedAst },
      };
      if (baseSource === 'contracts/Derived.sol') {
        derivedAst.nodes.unshift(...astDeclaringX(baseSource, 'Base', 5).nodes);
      } else {
        sources[baseSource] = { id: 1, ast: astDeclaringX(baseSource, 'Base', 5) };
      }
      return {
        id: 'build-shadow',
        _format: 'hh-sol-build-info-1',
        solcVersion: '0.8.26',
        solcLongVersion: '0.8.26+commit.8a97fa7a',
        input: {},
        output: {
          contracts: {
            'contracts/Derived.sol': { Derived: { storageLayout: shadowedLayout(DERIVED, 5, 9) } },
          },
          sources,
        },
      };
    }

    it.each(['contracts/Derived.sol', 'contracts/lib/Base.sol'])(
      'reaches each declaration through declaredIn when the base is in %s',
      async (baseSource) => {
        const fake = await fakeHre();
        await writeArtifact(fake.artifactPath(DERIVED), '{"v":1}', 1_700_000_000);
        fake.current = shadowedBuild(baseSource);
        const reader = createBuildInfoReader(fake.hre);

        const layout = await reader.getLayout(DERIVED);

        expect(layout.variables.map((variable) => variable.declaredIn)).toEqual([
          `${baseSource}:Base`,
          'contracts/Derived.sol:Derived',
        ]);
        expect(getVariable(layout, 'x', { declaredIn: 'Base' }).slot).toBe(0n);
        expect(getVariable(layout, 'x', { declaredIn: `${baseSource}:Base` }).slot).toBe(0n);
        expect(getVariable(layout, 'x', { declaredIn: 'Derived' }).slot).toBe(1n);
        expect(getVariable(layout, 'x', { declaredIn: DERIVED }).slot).toBe(1n);
        const ambiguous = (() => {
          try {
            return getVariable(layout, 'x');
          } catch (error) {
            return error;
          }
        })();
        expect(ambiguous).toBeInstanceOf(AmbiguousVariableError);
        expect((ambiguous as AmbiguousVariableError).declaringContracts).toEqual([
          `${baseSource}:Base`,
          DERIVED,
        ]);
      }
    );
  });

  it("collects constant and immutable names from the contract's own source only", async () => {
    const fake = await fakeHre();
    await writeArtifact(fake.artifactPath(VAULT), '{"v":1}', 1_700_000_000);
    await writeArtifact(fake.artifactPath(TOKEN), '{"t":1}', 1_700_000_000);
    fake.current = fakeBuild('build-1', 'total').buildInfo;
    const reader = createBuildInfoReader(fake.hre);

    // TOKEN_LIMIT is a constant of the same build, declared in a file Vault has nothing to do
    // with. Reporting it as "declared constant or immutable" on Vault would be wrong.
    const vault = await reader.getLayout(VAULT);
    expect([...vault.constantAndImmutableNames]).toEqual(['VAULT_LIMIT']);

    // The second contract is served from the shared per-build result and is narrowed as well.
    const token = await reader.getLayout(TOKEN);
    expect([...token.constantAndImmutableNames]).toEqual(['TOKEN_LIMIT']);
  });
});
