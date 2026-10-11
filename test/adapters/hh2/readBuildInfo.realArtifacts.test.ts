/**
 * The Hardhat 2 build-info reader over Hardhat 2's own `Artifacts` class and real files.
 *
 * The fake in `readBuildInfo.test.ts` has no cache of its own, so it cannot show what happens
 * when Hardhat's name -> build-info path cache and the files on disk disagree. These tests use
 * the real class over a temporary artifacts directory laid out the way Hardhat 2 writes it: one
 * artifact and one `.dbg.json` per contract, the latter pointing at a file under `build-info/`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Artifacts } from 'hardhat-v2/internal/artifacts';
import type { HardhatRuntimeEnvironment } from 'hardhat/types/runtime';
import {
  StorageLayoutNotAvailableError,
  createBuildInfoReader,
} from '../../../src/hardhat2/readBuildInfo.js';

const NAMES = ['C0', 'C1', 'C2', 'C3', 'C4', 'C5'] as const;

function fqn(contractName: string): string {
  return `contracts/${contractName}.sol:${contractName}`;
}

/** A one-variable layout in solc's own shape; `label` is what the tests tell builds apart by. */
function uintLayout(label: string) {
  return {
    storage: [{ astId: 1, contract: 'x', label, offset: 0, slot: '0', type: 't_uint256' }],
    types: { t_uint256: { encoding: 'inplace', label: 'uint256', numberOfBytes: '32' } },
  };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

interface Project {
  readonly hre: HardhatRuntimeEnvironment;
  readonly artifacts: Artifacts;
  readonly calls: { getBuildInfo: number; clearCache: number };
  /**
   * Write build-info `id`, whose output holds every contract of {@link NAMES} with a variable
   * named `label`, and point the artifacts of `contracts` at it. This is what a compile run by
   * another process leaves behind: files change, this process's `Artifacts` cache does not.
   */
  writeBuild(
    id: string,
    label: string,
    contracts: readonly string[],
    options?: { withoutStorageLayout?: boolean }
  ): Promise<void>;
  removeBuildInfo(id: string): Promise<void>;
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function newProject(): Promise<Project> {
  const root = path.join(await mkdtemp(path.join(tmpdir(), 'hsd-hh2-real-')), 'artifacts');
  tempDirs.push(path.dirname(root));

  const artifacts = new Artifacts(root);
  const calls = { getBuildInfo: 0, clearCache: 0 };
  const realGetBuildInfo = artifacts.getBuildInfo.bind(artifacts);
  const realClearCache = artifacts.clearCache.bind(artifacts);
  artifacts.getBuildInfo = async (fullyQualifiedName: string) => {
    calls.getBuildInfo += 1;
    return realGetBuildInfo(fullyQualifiedName);
  };
  artifacts.clearCache = () => {
    calls.clearCache += 1;
    realClearCache();
  };

  return {
    hre: { artifacts } as unknown as HardhatRuntimeEnvironment,
    artifacts,
    calls,
    async writeBuild(id, label, contracts, options = {}) {
      const output: Record<string, Record<string, unknown>> = {};
      for (const name of NAMES) {
        output[`contracts/${name}.sol`] = {
          [name]: {
            ...(options.withoutStorageLayout === true ? {} : { storageLayout: uintLayout(label) }),
            evm: { deployedBytecode: { object: '6080' } },
          },
        };
      }
      await writeJson(path.join(root, 'build-info', `${id}.json`), {
        id,
        _format: 'hh-sol-build-info-1',
        solcVersion: '0.8.26',
        solcLongVersion: '0.8.26+commit.8a97fa7a',
        input: {},
        output: { contracts: output, sources: {} },
      });
      for (const name of contracts) {
        const directory = path.join(root, 'contracts', `${name}.sol`);
        await writeJson(path.join(directory, `${name}.json`), {
          _format: 'hh-sol-artifact-1',
          contractName: name,
          sourceName: `contracts/${name}.sol`,
          abi: [],
          bytecode: '0x',
          deployedBytecode: '0x6080',
          // Changes the file's size with the label, so a rewrite is a new stamp on any clock.
          marker: label,
        });
        await writeJson(path.join(directory, `${name}.dbg.json`), {
          _format: 'hh-sol-dbg-1',
          buildInfo: `../../build-info/${id}.json`,
        });
      }
    },
    async removeBuildInfo(id) {
      await rm(path.join(root, 'build-info', `${id}.json`));
    },
  };
}

function labels(layout: { readonly variables: readonly { readonly label: string }[] }) {
  return layout.variables.map((variable) => variable.label);
}

describe('createBuildInfoReader over the real Hardhat 2 Artifacts class', () => {
  describe('a build-info path Hardhat cached for another caller', () => {
    it('returns the recompiled layout on the first read', async () => {
      const project = await newProject();
      await project.writeBuild('b1', 'before', NAMES);
      // Another plugin, or a second decoder, resolves the name: Hardhat now remembers C5 -> b1.
      await project.artifacts.getBuildInfo(fqn('C5'));
      // A compile in another process moves C5 to a new build; b1 stays for the other contracts.
      await project.writeBuild('b2', 'after', ['C5']);

      const reader = createBuildInfoReader(project.hre);

      expect(labels(await reader.getLayout(fqn('C5')))).toEqual(['after']);
      expect(labels(await reader.getLayout(fqn('C5')))).toEqual(['after']);
    });

    it('does not report the contract as missing when the old build-info is gone', async () => {
      const project = await newProject();
      await project.writeBuild('b1', 'before', ['C5']);
      await project.artifacts.getBuildInfo(fqn('C5'));
      await project.writeBuild('b2', 'after', ['C5']);
      await project.removeBuildInfo('b1');

      const reader = createBuildInfoReader(project.hre);

      expect(labels(await reader.getLayout(fqn('C5')))).toEqual(['after']);
    });

    it('clears Hardhat\'s cache once per first load and never on a cached read', async () => {
      const project = await newProject();
      await project.writeBuild('b1', 'before', NAMES);
      const reader = createBuildInfoReader(project.hre);

      await reader.getLayout(fqn('C0'));
      expect(project.calls.clearCache).toBe(1);

      await reader.getLayout(fqn('C0'));
      await reader.getDeployedBytecode(fqn('C0'));
      expect(project.calls.clearCache).toBe(1);
      expect(project.calls.getBuildInfo).toBe(1);
    });
  });

  describe('contracts of one build read together', () => {
    it('reads and parses the build-info once for concurrent first reads', async () => {
      const project = await newProject();
      await project.writeBuild('b1', 'shared', NAMES);
      const reader = createBuildInfoReader(project.hre);

      const [layouts, bytecodes] = await Promise.all([
        Promise.all(NAMES.map((name) => reader.getLayout(fqn(name)))),
        Promise.all(NAMES.map((name) => reader.getDeployedBytecode(fqn(name)))),
      ]);

      expect(project.calls.getBuildInfo).toBe(1);
      expect(layouts.map((layout) => labels(layout))).toEqual(NAMES.map(() => ['shared']));
      expect(bytecodes).toEqual(NAMES.map(() => '0x6080'));
    });

    it('keeps builds apart when concurrent first reads span two build-infos', async () => {
      const project = await newProject();
      await project.writeBuild('b1', 'one', ['C0', 'C1', 'C2']);
      await project.writeBuild('b2', 'two', ['C3', 'C4', 'C5']);
      const reader = createBuildInfoReader(project.hre);

      const layouts = await Promise.all(NAMES.map((name) => reader.getLayout(fqn(name))));

      expect(layouts.map((layout) => labels(layout)[0])).toEqual([
        'one', 'one', 'one', 'two', 'two', 'two',
      ]);
      expect(project.calls.getBuildInfo).toBe(2);
    });

    it('does not hold the parsed build-info once the loads have finished', async () => {
      const project = await newProject();
      await project.writeBuild('b1', 'shared', NAMES);
      const reader = createBuildInfoReader(project.hre);

      await Promise.all(['C0', 'C1'].map((name) => reader.getLayout(fqn(name))));
      expect(project.calls.getBuildInfo).toBe(1);

      // A first read that starts after the others settled has nothing to share: it reads again.
      await reader.getLayout(fqn('C2'));
      expect(project.calls.getBuildInfo).toBe(2);
    });

    it('does not share a failed read with a later attempt', async () => {
      const project = await newProject();
      await project.writeBuild('b1', 'shared', NAMES);
      await project.removeBuildInfo('b1');
      const reader = createBuildInfoReader(project.hre);

      const failures = await Promise.all(
        ['C0', 'C1'].map((name) => reader.getLayout(fqn(name)).catch((error: unknown) => error))
      );
      expect(failures.map((failure) => (failure as Error).name)).toEqual([
        'ContractNotFoundError',
        'ContractNotFoundError',
      ]);

      await project.writeBuild('b1', 'shared', []);
      expect(labels(await reader.getLayout(fqn('C0')))).toEqual(['shared']);
    });
  });

  describe('a build-info without storageLayout', () => {
    it('rejects with StorageLayoutNotAvailableError, and recovers after a recompile', async () => {
      const project = await newProject();
      await project.writeBuild('b1', 'none', ['C0'], { withoutStorageLayout: true });
      const reader = createBuildInfoReader(project.hre);

      const failure = await reader.getLayout(fqn('C0')).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(StorageLayoutNotAvailableError);
      const error = failure as StorageLayoutNotAvailableError;
      expect(error.name).toBe('StorageLayoutNotAvailableError');
      expect(error.fullyQualifiedName).toBe(fqn('C0'));
      expect(error.message).toContain(
        'Compiled output for "contracts/C0.sol:C0" contains no "storageLayout".'
      );
      expect(error.message).toContain('npx hardhat compile');
      // The bytecode shares the load, so it fails the same way instead of half-answering.
      await expect(reader.getDeployedBytecode(fqn('C0'))).rejects.toBeInstanceOf(
        StorageLayoutNotAvailableError
      );

      // The compile the message asks for; the failure above must not have been cached.
      await project.writeBuild('b2', 'present', ['C0']);
      expect(labels(await reader.getLayout(fqn('C0')))).toEqual(['present']);
    });
  });
});
