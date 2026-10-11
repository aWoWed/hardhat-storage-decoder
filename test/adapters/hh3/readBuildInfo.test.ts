import type { ArtifactManager } from 'hardhat/types/artifacts';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { MissingStorageLayoutError } from '../../../src/hardhat3/ensureStorageLayoutOutput.js';
import { AmbiguousVariableError, getVariable } from '../../../src/core/index.js';
import { Hardhat3LayoutReader } from '../../../src/hardhat3/readBuildInfo.js';

// ---------------------------------------------------------------------------------------
// A fake Hardhat 3 project: real files in a temp directory, behind a fake `ArtifactManager`
// that counts its calls and — like the real one — caches its listing of the artifacts
// directory until `clearCache()` is called.
// ---------------------------------------------------------------------------------------

const USER_SOURCE = 'contracts/Vault.sol';
const INPUT_SOURCE = 'project/contracts/Vault.sol';
const VAULT = `${USER_SOURCE}:Vault`;
const BYTECODE = '0x6080604052';

/** A minimal but real-shaped solc `storageLayout`: one `uint256` at slot 0. */
function layoutWith(label: string) {
  return {
    storage: [
      { astId: 3, contract: VAULT, label, offset: 0, slot: '0', type: 't_uint256' },
    ],
    types: {
      t_uint256: { encoding: 'inplace', label: 'uint256', numberOfBytes: '32' },
    },
  };
}

/** A source AST declaring one contract with the given `constant` state variables. */
function astWithConstants(contractName: string, ...constants: string[]) {
  return {
    nodeType: 'SourceUnit',
    nodes: [
      {
        nodeType: 'ContractDefinition',
        name: contractName,
        nodes: constants.map((name) => ({
          nodeType: 'VariableDeclaration',
          name,
          stateVariable: true,
          mutability: 'constant',
        })),
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

interface ArtifactSpec {
  readonly sourceName?: string;
  readonly contractName?: string;
  /** `null` writes an artifact with no `inputSourceName` at all. */
  readonly inputSourceName?: string | null;
  readonly buildInfoId: string;
}

interface ManagerOptions {
  /** Model a Hardhat release without `getArtifactPath` / `clearCache`. */
  readonly withoutPathApi?: boolean;
}

class FakeProject {
  readonly calls = {
    readArtifact: 0,
    getArtifactPath: 0,
    getBuildInfoPath: 0,
    clearCache: 0,
    outputPath: new Map<string, number>(),
  };
  readonly #root: string;
  #listing: Map<string, string> | undefined;

  private constructor(root: string) {
    this.#root = root;
  }

  static async create(): Promise<FakeProject> {
    return new FakeProject(await mkdtemp(join(tmpdir(), 'hh3-layout-reader-')));
  }

  async remove(): Promise<void> {
    await rm(this.#root, { recursive: true, force: true });
  }

  outputReads(buildInfoId: string): number {
    return this.calls.outputPath.get(buildInfoId) ?? 0;
  }

  #artifactPath(fullyQualifiedName: string): string {
    const [sourceName, contractName] = fullyQualifiedName.split(':') as [string, string];
    return join(this.#root, 'artifacts', sourceName, `${contractName}.json`);
  }

  #buildInfoPath(buildInfoId: string, suffix: '.json' | '.output.json'): string {
    return join(this.#root, 'artifacts', 'build-info', `${buildInfoId}${suffix}`);
  }

  async #writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value));
  }

  /**
   * Write (or rewrite) an artifact. `mtimeSeconds` is set explicitly so a rewrite is visible
   * as a new stamp without depending on the filesystem clock's granularity.
   */
  async writeArtifact(spec: ArtifactSpec, mtimeSeconds: number): Promise<void> {
    const sourceName = spec.sourceName ?? USER_SOURCE;
    const contractName = spec.contractName ?? 'Vault';
    const path = this.#artifactPath(`${sourceName}:${contractName}`);
    await this.#writeJson(path, {
      contractName,
      sourceName,
      ...(spec.inputSourceName === null
        ? {}
        : { inputSourceName: spec.inputSourceName ?? `project/${sourceName}` }),
      buildInfoId: spec.buildInfoId,
      deployedBytecode: BYTECODE,
    });
    await utimes(path, mtimeSeconds, mtimeSeconds);
  }

  async writeBuildInfo(buildInfoId: string, userSourceNameMap: Record<string, string>) {
    await this.#writeJson(this.#buildInfoPath(buildInfoId, '.json'), { userSourceNameMap });
  }

  async writeOutput(buildInfoId: string, output: unknown): Promise<void> {
    await this.#writeJson(this.#buildInfoPath(buildInfoId, '.output.json'), { output });
  }

  /** One build holding `Vault` (with the given variable) and nothing else. */
  async writeVaultBuild(buildInfoId: string, label: string, mtimeSeconds: number) {
    await this.writeBuildInfo(buildInfoId, { [USER_SOURCE]: INPUT_SOURCE });
    await this.writeOutput(buildInfoId, {
      sources: { [INPUT_SOURCE]: { ast: astWithConstants('Vault') } },
      contracts: { [INPUT_SOURCE]: { Vault: { storageLayout: layoutWith(label) } } },
    });
    await this.writeArtifact({ buildInfoId }, mtimeSeconds);
  }

  manager(options: ManagerOptions = {}): ArtifactManager {
    const locate = async (fullyQualifiedName: string): Promise<string> => {
      // Like `ArtifactManagerImplementation`: the directory is listed once and remembered.
      this.#listing ??= new Map(
        [...this.#known].filter(([, path]) => existsSync(path))
      );
      const path = this.#listing.get(fullyQualifiedName);
      if (path === undefined) {
        throw new Error(`Artifact for contract "${fullyQualifiedName}" not found. `);
      }
      return path;
    };
    const readArtifact = async (fullyQualifiedName: string): Promise<unknown> => {
      this.calls.readArtifact += 1;
      return JSON.parse(await readFile(await locate(fullyQualifiedName), 'utf8'));
    };

    const fake = {
      readArtifact,
      getBuildInfoId: async (fullyQualifiedName: string) =>
        ((await readArtifact(fullyQualifiedName)) as { buildInfoId?: string }).buildInfoId,
      getBuildInfoPath: async (buildInfoId: string) => {
        this.calls.getBuildInfoPath += 1;
        const path = this.#buildInfoPath(buildInfoId, '.json');
        return existsSync(path) ? path : undefined;
      },
      getBuildInfoOutputPath: async (buildInfoId: string) => {
        this.calls.outputPath.set(buildInfoId, this.outputReads(buildInfoId) + 1);
        const path = this.#buildInfoPath(buildInfoId, '.output.json');
        return existsSync(path) ? path : undefined;
      },
      ...(options.withoutPathApi === true
        ? {}
        : {
            getArtifactPath: async (fullyQualifiedName: string) => {
              this.calls.getArtifactPath += 1;
              return locate(fullyQualifiedName);
            },
            clearCache: async () => {
              this.calls.clearCache += 1;
              this.#listing = undefined;
            },
          }),
    };
    return fake as unknown as ArtifactManager;
  }

  /** Every artifact this project could have on disk; `locate` filters by what exists. */
  get #known(): Map<string, string> {
    return new Map(
      this.#names.map((fullyQualifiedName) => [
        fullyQualifiedName,
        this.#artifactPath(fullyQualifiedName),
      ])
    );
  }

  readonly #names = [VAULT, 'contracts/Other.sol:Other'];
}

const projects: FakeProject[] = [];

async function newProject(): Promise<FakeProject> {
  const project = await FakeProject.create();
  projects.push(project);
  return project;
}

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.remove()));
});

function labels(layout: { readonly variables: readonly { readonly label: string }[] }) {
  return layout.variables.map((variable) => variable.label);
}

const OTHER = 'contracts/Other.sol:Other';
const OTHER_INPUT_SOURCE = 'project/contracts/Other.sol';

/** One build holding `Vault` and `Other`, each with its own layout and its own constant. */
async function writeTwoContractBuild(project: FakeProject, buildInfoId: string): Promise<void> {
  await project.writeOutput(buildInfoId, {
    sources: {
      [INPUT_SOURCE]: { ast: astWithConstants('Vault', 'VAULT_LIMIT') },
      [OTHER_INPUT_SOURCE]: { ast: astWithConstants('Other', 'OTHER_LIMIT') },
    },
    contracts: {
      [INPUT_SOURCE]: { Vault: { storageLayout: layoutWith('total') } },
      [OTHER_INPUT_SOURCE]: { Other: { storageLayout: layoutWith('other') } },
    },
  });
  await project.writeArtifact({ buildInfoId }, 1_000);
  await project.writeArtifact(
    { buildInfoId, sourceName: 'contracts/Other.sol', contractName: 'Other' },
    1_000
  );
}

// V8 exposes a collector on request; asking at run time keeps the test independent of how the
// runner was started.
setFlagsFromString('--expose-gc');
const collectGarbage = runInNewContext('gc') as () => void;

/**
 * Run `body` while holding a weak reference to every build-info output file `JSON.parse`
 * decodes (the objects with an `output` property), and return those references.
 */
async function trackingParsedOutputs(body: () => Promise<void>): Promise<WeakRef<object>[]> {
  const parsed: WeakRef<object>[] = [];
  const realParse = JSON.parse;
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]): unknown => {
    const value: unknown = realParse(text, reviver);
    if (typeof value === 'object' && value !== null && 'output' in value) {
      parsed.push(new WeakRef(value));
    }
    return value;
  }) as typeof JSON.parse;
  try {
    await body();
  } finally {
    JSON.parse = realParse;
  }
  return parsed;
}

/** Let settled promises unwind, then collect; twice, since one pass may only clear the way. */
async function settleAndCollect(): Promise<void> {
  for (let pass = 0; pass < 2; pass += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    collectGarbage();
  }
}

describe('Hardhat3LayoutReader', () => {
  describe('what a read costs (AC 12)', () => {
    it('reads the artifact once across repeated bytecode and layout lookups', async () => {
      const project = await newProject();
      await project.writeVaultBuild('build-1', 'total', 1_000);
      const reader = new Hardhat3LayoutReader(project.manager());

      for (let i = 0; i < 5; i += 1) {
        expect(await reader.getDeployedBytecode(VAULT)).toBe(BYTECODE);
        expect(labels(await reader.getLayout(VAULT))).toEqual(['total']);
      }

      expect(project.calls.readArtifact).toBe(1);
      expect(project.outputReads('build-1')).toBe(1);
    });

    it('does not read the build-info input file when inputSourceName resolves', async () => {
      const project = await newProject();
      await project.writeVaultBuild('build-1', 'total', 1_000);
      const reader = new Hardhat3LayoutReader(project.manager());

      await reader.getLayout(VAULT);

      expect(project.calls.getBuildInfoPath).toBe(0);
    });

    it('falls back to userSourceNameMap when inputSourceName misses', async () => {
      const project = await newProject();
      await project.writeVaultBuild('build-1', 'total', 1_000);
      await project.writeArtifact({ buildInfoId: 'build-1', inputSourceName: 'wrong.sol' }, 1_000);
      const reader = new Hardhat3LayoutReader(project.manager());

      expect(labels(await reader.getLayout(VAULT))).toEqual(['total']);
      expect(project.calls.getBuildInfoPath).toBe(1);
    });

    it('falls back to userSourceNameMap when the artifact has no inputSourceName', async () => {
      const project = await newProject();
      await project.writeVaultBuild('build-1', 'total', 1_000);
      await project.writeArtifact({ buildInfoId: 'build-1', inputSourceName: null }, 1_000);
      const reader = new Hardhat3LayoutReader(project.manager());

      expect(labels(await reader.getLayout(VAULT))).toEqual(['total']);
      expect(project.calls.getBuildInfoPath).toBe(1);
    });

    it('lists every candidate, in order, when none of them has the contract', async () => {
      const project = await newProject();
      await project.writeBuildInfo('build-1', { [USER_SOURCE]: INPUT_SOURCE });
      await project.writeOutput('build-1', { sources: {}, contracts: {} });
      await project.writeArtifact({ buildInfoId: 'build-1', inputSourceName: 'wrong.sol' }, 1_000);
      const reader = new Hardhat3LayoutReader(project.manager());

      await expect(reader.getLayout(VAULT)).rejects.toMatchObject({
        name: 'ContractNotFoundError',
        detail:
          'build info "build-1" has no compiler output for that contract (looked under' +
          ` "wrong.sol", "${INPUT_SOURCE}", "${USER_SOURCE}")`,
      });
    });

    it('parses the output once for 50 concurrent first reads', async () => {
      const project = await newProject();
      await project.writeVaultBuild('build-1', 'total', 1_000);
      const reader = new Hardhat3LayoutReader(project.manager());

      const layouts = await Promise.all(
        Array.from({ length: 50 }, () => reader.getLayout(VAULT))
      );

      expect(new Set(layouts).size).toBe(1);
      expect(project.outputReads('build-1')).toBe(1);
      expect(project.calls.readArtifact).toBe(1);
    });
  });

  describe('failed loads are not cached (AC 13)', () => {
    it('finds an artifact that appears after a failed read, via clearCache', async () => {
      const project = await newProject();
      const reader = new Hardhat3LayoutReader(project.manager());

      await expect(reader.getLayout(VAULT)).rejects.toMatchObject({
        name: 'ContractNotFoundError',
        fullyQualifiedName: VAULT,
        detail: `Artifact for contract "${VAULT}" not found. `,
      });
      await expect(reader.getDeployedBytecode(VAULT)).rejects.toMatchObject({
        name: 'ContractNotFoundError',
      });
      const clearsWhileMissing = project.calls.clearCache;
      expect(clearsWhileMissing).toBeGreaterThan(0);

      // The fake's listing was taken while the directory was empty, so only a clearCache()
      // can make this visible — exactly the real ArtifactManager's behaviour.
      await project.writeVaultBuild('build-1', 'total', 1_000);

      expect(labels(await reader.getLayout(VAULT))).toEqual(['total']);
      expect(await reader.getDeployedBytecode(VAULT)).toBe(BYTECODE);
      expect(project.calls.clearCache).toBe(clearsWhileMissing + 1);
    });

    it('retries a layout load whose output file was missing', async () => {
      const project = await newProject();
      await project.writeArtifact({ buildInfoId: 'build-1' }, 1_000);
      const reader = new Hardhat3LayoutReader(project.manager());

      await expect(reader.getLayout(VAULT)).rejects.toMatchObject({
        name: 'ContractNotFoundError',
        detail:
          'build info "build-1" exists but its solc output file does not; run' +
          ' `npx hardhat compile`',
      });

      await project.writeOutput('build-1', {
        contracts: { [INPUT_SOURCE]: { Vault: { storageLayout: layoutWith('total') } } },
      });

      expect(labels(await reader.getLayout(VAULT))).toEqual(['total']);
      // The artifact file never changed, so it was not read again and nothing was cleared.
      expect(project.calls.readArtifact).toBe(1);
      expect(project.calls.clearCache).toBe(0);
    });

    it('still returns bytecode when the layout cannot be loaded', async () => {
      const project = await newProject();
      await project.writeOutput('build-1', { contracts: { [INPUT_SOURCE]: { Vault: {} } } });
      await project.writeArtifact({ buildInfoId: 'build-1' }, 1_000);
      const reader = new Hardhat3LayoutReader(project.manager());

      await expect(reader.getLayout(VAULT)).rejects.toMatchObject({
        name: 'MissingStorageLayoutError',
      });
      expect(await reader.getDeployedBytecode(VAULT)).toBe(BYTECODE);
      await expect(reader.getLayout(VAULT)).rejects.toMatchObject({
        name: 'MissingStorageLayoutError',
      });
      expect(project.calls.readArtifact).toBe(1);
    });
  });

  describe('recompiles (AC 14)', () => {
    it('returns the new layout once the artifact file changes, without clearCache', async () => {
      const project = await newProject();
      await project.writeVaultBuild('build-1', 'total', 1_000);
      const reader = new Hardhat3LayoutReader(project.manager());
      expect(labels(await reader.getLayout(VAULT))).toEqual(['total']);

      await project.writeVaultBuild('build-2', 'renamed', 2_000);

      expect(labels(await reader.getLayout(VAULT))).toEqual(['renamed']);
      expect(await reader.getDeployedBytecode(VAULT)).toBe(BYTECODE);
      expect(project.calls.readArtifact).toBe(2);
      expect(project.outputReads('build-2')).toBe(1);
      expect(project.calls.clearCache).toBe(0);
    });

    it('re-reads nothing while the artifact file is unchanged', async () => {
      const project = await newProject();
      await project.writeVaultBuild('build-1', 'total', 1_000);
      const reader = new Hardhat3LayoutReader(project.manager());
      const first = await reader.getLayout(VAULT);

      // Same bytes, same mtime: rewriting the build output alone is not a recompile.
      await project.writeOutput('build-1', {
        contracts: { [INPUT_SOURCE]: { Vault: { storageLayout: layoutWith('ignored') } } },
      });

      expect(await reader.getLayout(VAULT)).toBe(first);
      expect(project.calls.readArtifact).toBe(1);
      expect(project.outputReads('build-1')).toBe(1);
      expect(project.calls.clearCache).toBe(0);
    });

    it('drops the parsed output of a build no contract references any more', async () => {
      const project = await newProject();
      await project.writeVaultBuild('build-1', 'total', 1_000);
      const reader = new Hardhat3LayoutReader(project.manager());
      await reader.getLayout(VAULT);

      await project.writeVaultBuild('build-2', 'renamed', 2_000);
      await reader.getLayout(VAULT);
      expect(project.outputReads('build-1')).toBe(1);

      // Back to build-1: had its parsed output been retained, it would not be read again.
      await project.writeArtifact({ buildInfoId: 'build-1' }, 3_000);
      expect(labels(await reader.getLayout(VAULT))).toEqual(['total']);
      expect(project.outputReads('build-1')).toBe(2);
    });

    it('keeps the parsed output of a build another contract still references', async () => {
      const project = await newProject();
      const other = 'contracts/Other.sol:Other';
      await project.writeOutput('build-1', {
        contracts: {
          [INPUT_SOURCE]: { Vault: { storageLayout: layoutWith('total') } },
          'project/contracts/Other.sol': { Other: { storageLayout: layoutWith('other') } },
        },
      });
      await project.writeArtifact({ buildInfoId: 'build-1' }, 1_000);
      await project.writeArtifact(
        { buildInfoId: 'build-1', sourceName: 'contracts/Other.sol', contractName: 'Other' },
        1_000
      );
      const reader = new Hardhat3LayoutReader(project.manager());
      await reader.getLayout(VAULT);
      await reader.getLayout(other);
      expect(project.outputReads('build-1')).toBe(1);

      await project.writeVaultBuild('build-2', 'renamed', 2_000);
      await reader.getLayout(VAULT);
      await project.writeArtifact({ buildInfoId: 'build-1' }, 3_000);

      expect(labels(await reader.getLayout(VAULT))).toEqual(['total']);
      expect(project.outputReads('build-1')).toBe(1);
    });
  });

  describe('constant and immutable names (AC 16)', () => {
    it("collects them from the contract's own source only", async () => {
      const project = await newProject();
      await project.writeOutput('build-1', {
        sources: {
          [INPUT_SOURCE]: { ast: astWithConstants('Vault', 'OWN_LIMIT') },
          'project/contracts/Unrelated.sol': { ast: astWithConstants('Unrelated', 'total') },
        },
        contracts: { [INPUT_SOURCE]: { Vault: { storageLayout: layoutWith('total') } } },
      });
      await project.writeArtifact({ buildInfoId: 'build-1' }, 1_000);
      const reader = new Hardhat3LayoutReader(project.manager());

      const layout = await reader.getLayout(VAULT);

      expect([...layout.constantAndImmutableNames]).toEqual(['OWN_LIMIT']);
    });

    it('uses the source the contract was actually found under', async () => {
      const project = await newProject();
      await project.writeBuildInfo('build-1', { [USER_SOURCE]: INPUT_SOURCE });
      await project.writeOutput('build-1', {
        sources: {
          [INPUT_SOURCE]: { ast: astWithConstants('Vault', 'OWN_LIMIT') },
          'wrong.sol': { ast: astWithConstants('Unrelated', 'ELSEWHERE') },
        },
        contracts: { [INPUT_SOURCE]: { Vault: { storageLayout: layoutWith('total') } } },
      });
      await project.writeArtifact({ buildInfoId: 'build-1', inputSourceName: 'wrong.sol' }, 1_000);
      const reader = new Hardhat3LayoutReader(project.manager());

      const layout = await reader.getLayout(VAULT);

      expect([...layout.constantAndImmutableNames]).toEqual(['OWN_LIMIT']);
    });
  });

  describe('what stays in memory after a load', () => {
    it('lets go of the parsed compiler output once the layout is loaded', async () => {
      const project = await newProject();
      await writeTwoContractBuild(project, 'build-1');
      const reader = new Hardhat3LayoutReader(project.manager());

      const parsedOutputs = await trackingParsedOutputs(async () => {
        expect(labels(await reader.getLayout(VAULT))).toEqual(['total']);
      });
      expect(parsedOutputs).toHaveLength(1);

      await settleAndCollect();

      expect(parsedOutputs[0]?.deref()).toBeUndefined();
      // The reader is still in use afterwards, so it was not collected along with its caches.
      expect(labels(await reader.getLayout(VAULT))).toEqual(['total']);
    });

    it('lets go of it after concurrent first reads of several contracts too', async () => {
      const project = await newProject();
      await writeTwoContractBuild(project, 'build-1');
      const reader = new Hardhat3LayoutReader(project.manager());

      const parsedOutputs = await trackingParsedOutputs(async () => {
        await Promise.all([reader.getLayout(VAULT), reader.getLayout(OTHER)]);
      });
      expect(parsedOutputs).toHaveLength(1);

      await settleAndCollect();

      expect(parsedOutputs[0]?.deref()).toBeUndefined();
      expect(project.outputReads('build-1')).toBe(1);
      expect(labels(await reader.getLayout(OTHER))).toEqual(['other']);
    });

    it('serves a later first read of another contract of the build without the file', async () => {
      const project = await newProject();
      await writeTwoContractBuild(project, 'build-1');
      const reader = new Hardhat3LayoutReader(project.manager());
      await reader.getLayout(VAULT);
      await settleAndCollect();

      const other = await reader.getLayout(OTHER);

      expect(labels(other)).toEqual(['other']);
      // Its own source's names, taken from what was kept of the build rather than from the file.
      expect([...other.constantAndImmutableNames]).toEqual(['OTHER_LIMIT']);
      expect(project.outputReads('build-1')).toBe(1);
    });

    it('reports a contract the kept data does not have, without the file', async () => {
      const project = await newProject();
      await project.writeVaultBuild('build-1', 'total', 1_000);
      await project.writeArtifact(
        { buildInfoId: 'build-1', sourceName: 'contracts/Other.sol', contractName: 'Other' },
        1_000
      );
      const reader = new Hardhat3LayoutReader(project.manager());
      await reader.getLayout(VAULT);

      await expect(reader.getLayout(OTHER)).rejects.toMatchObject({
        name: 'ContractNotFoundError',
        fullyQualifiedName: OTHER,
      });
      expect(project.outputReads('build-1')).toBe(1);
    });
  });

  describe('a build without a storage layout', () => {
    it('rejects with MissingStorageLayoutError when the contract has no storageLayout', async () => {
      const project = await newProject();
      await project.writeOutput('build-1', {
        contracts: { [INPUT_SOURCE]: { Vault: { evm: {} } } },
      });
      await project.writeArtifact({ buildInfoId: 'build-1' }, 1_000);
      const reader = new Hardhat3LayoutReader(project.manager());

      const failure = await reader.getLayout(VAULT).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(MissingStorageLayoutError);
      const error = failure as MissingStorageLayoutError;
      expect(error.name).toBe('MissingStorageLayoutError');
      expect(error.fullyQualifiedName).toBe(VAULT);
      expect(error.message).toContain(
        `The build-info for "${VAULT}" has no solc "storageLayout" output: build info "build-1"` +
          ' was compiled without the storageLayout selector.'
      );
      expect(error.message).toContain('"*": { "*": ["storageLayout"] }');
    });

    it('rejects with MissingStorageLayoutError when the output file has no solc output', async () => {
      const project = await newProject();
      await project.writeOutput('build-1', undefined);
      await project.writeArtifact({ buildInfoId: 'build-1' }, 1_000);
      const reader = new Hardhat3LayoutReader(project.manager());

      const failure = await reader.getLayout(VAULT).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(MissingStorageLayoutError);
      const error = failure as MissingStorageLayoutError;
      expect(error.fullyQualifiedName).toBe(VAULT);
      expect(error.message).toContain(
        `The build-info for "${VAULT}" has no solc "storageLayout" output: build info "build-1"` +
          ' has no solc output.'
      );
    });

    it('loads the layout once a recompile has produced it', async () => {
      const project = await newProject();
      await project.writeOutput('build-1', {
        contracts: { [INPUT_SOURCE]: { Vault: {} } },
      });
      await project.writeArtifact({ buildInfoId: 'build-1' }, 1_000);
      const reader = new Hardhat3LayoutReader(project.manager());
      await expect(reader.getLayout(VAULT)).rejects.toBeInstanceOf(MissingStorageLayoutError);

      await project.writeVaultBuild('build-2', 'total', 2_000);

      expect(labels(await reader.getLayout(VAULT))).toEqual(['total']);
    });
  });

  describe('a name declared by both a base contract and the derived one', () => {
    /** Write a build of `Vault is Base`, with `Base` in the input source `baseSource`. */
    async function writeShadowedBuild(project: FakeProject, baseSource: string): Promise<void> {
      const vaultAst = astDeclaringX(INPUT_SOURCE, 'Vault', 9);
      const sources: Record<string, { ast: unknown }> = { [INPUT_SOURCE]: { ast: vaultAst } };
      if (baseSource === INPUT_SOURCE) {
        vaultAst.nodes.unshift(...astDeclaringX(baseSource, 'Base', 5).nodes);
      } else {
        sources[baseSource] = { ast: astDeclaringX(baseSource, 'Base', 5) };
      }
      await project.writeOutput('build-1', {
        sources,
        contracts: { [INPUT_SOURCE]: { Vault: { storageLayout: shadowedLayout(VAULT, 5, 9) } } },
      });
      await project.writeArtifact({ buildInfoId: 'build-1' }, 1_000);
    }

    it.each([INPUT_SOURCE, 'project/contracts/lib/Base.sol'])(
      'reaches each declaration through declaredIn when the base is in %s',
      async (baseSource) => {
        const project = await newProject();
        await writeShadowedBuild(project, baseSource);
        const reader = new Hardhat3LayoutReader(project.manager());

        const layout = await reader.getLayout(VAULT);

        expect(layout.variables.map((variable) => variable.declaredIn)).toEqual([
          `${baseSource}:Base`,
          `${INPUT_SOURCE}:Vault`,
        ]);
        expect(getVariable(layout, 'x', { declaredIn: 'Base' }).slot).toBe(0n);
        expect(getVariable(layout, 'x', { declaredIn: `${baseSource}:Base` }).slot).toBe(0n);
        expect(getVariable(layout, 'x', { declaredIn: 'Vault' }).slot).toBe(1n);
        expect(getVariable(layout, 'x', { declaredIn: `${INPUT_SOURCE}:Vault` }).slot).toBe(1n);
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
          `${INPUT_SOURCE}:Vault`,
        ]);
      }
    );

    it('still knows the declaring contracts for a later first read of the build', async () => {
      const project = await newProject();
      const baseSource = 'project/contracts/lib/Base.sol';
      // `Vault is Base` and `Other is Base` in one build, each declaring its own `x`.
      await project.writeOutput('build-1', {
        sources: {
          [INPUT_SOURCE]: { ast: astDeclaringX(INPUT_SOURCE, 'Vault', 9) },
          [OTHER_INPUT_SOURCE]: { ast: astDeclaringX(OTHER_INPUT_SOURCE, 'Other', 12) },
          [baseSource]: { ast: astDeclaringX(baseSource, 'Base', 5) },
        },
        contracts: {
          [INPUT_SOURCE]: { Vault: { storageLayout: shadowedLayout(VAULT, 5, 9) } },
          [OTHER_INPUT_SOURCE]: { Other: { storageLayout: shadowedLayout(OTHER, 5, 12) } },
        },
      });
      await project.writeArtifact({ buildInfoId: 'build-1' }, 1_000);
      await project.writeArtifact(
        { buildInfoId: 'build-1', sourceName: 'contracts/Other.sol', contractName: 'Other' },
        1_000
      );
      const reader = new Hardhat3LayoutReader(project.manager());
      await reader.getLayout(VAULT);
      await settleAndCollect();

      // Parsed from what was kept of the build: the output file is not opened again.
      const layout = await reader.getLayout(OTHER);

      expect(getVariable(layout, 'x', { declaredIn: 'Base' }).slot).toBe(0n);
      expect(getVariable(layout, 'x', { declaredIn: 'Other' }).slot).toBe(1n);
      expect(project.outputReads('build-1')).toBe(1);
    });
  });

  describe('without getArtifactPath / clearCache', () => {
    it('still reads, and caches as before', async () => {
      const project = await newProject();
      await project.writeVaultBuild('build-1', 'total', 1_000);
      const reader = new Hardhat3LayoutReader(project.manager({ withoutPathApi: true }));

      for (let i = 0; i < 3; i += 1) {
        expect(labels(await reader.getLayout(VAULT))).toEqual(['total']);
        expect(await reader.getDeployedBytecode(VAULT)).toBe(BYTECODE);
      }

      expect(project.calls.readArtifact).toBe(1);
      expect(project.outputReads('build-1')).toBe(1);
    });

    it('reports a missing contract, and does not cache the failure', async () => {
      const project = await newProject();
      const reader = new Hardhat3LayoutReader(project.manager({ withoutPathApi: true }));

      await expect(reader.getLayout(VAULT)).rejects.toMatchObject({
        name: 'ContractNotFoundError',
        detail: `Artifact for contract "${VAULT}" not found. `,
      });
      // Nothing can refresh the fake's listing here, so the artifact stays invisible; what
      // matters is that the reader asked again rather than replaying a cached rejection.
      await expect(reader.getLayout(VAULT)).rejects.toMatchObject({
        name: 'ContractNotFoundError',
      });
      expect(project.calls.readArtifact).toBe(2);
    });
  });
});
