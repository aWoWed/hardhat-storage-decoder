/**
 * Real child processes, because what these pin is what Windows and POSIX do with a process tree: a
 * grandchild holding the output pipes keeps `close` from firing, and killing the child leaves it up.
 * Also the small checks of other scripts that need a process or a file: an exact version match, and
 * a failed build in the mainnet check.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { namesExactVersion } from '../../scripts/clients/exact-version.mjs';
import { killProcessTree, runBounded } from '../../scripts/run-bounded.mjs';

const GRACE_MS = 200;
/** Starts a long-lived grandchild that inherits the pipes, and prints its pid. */
const PARENT = `
  const { spawn } = require('node:child_process');
  const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });
  console.log(grandchild.pid);
`;

/** A process being ended still answers signal 0 for a moment, and only ESRCH means it is gone. */
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

const started: number[] = [];
afterEach(async () => {
  for (const pid of started.splice(0)) {
    expect(killProcessTree(pid)).toBe(true);
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 10_000 });
  }
});

describe('runBounded', () => {
  it('reports a normal exit and its output', async () => {
    const result = await runBounded(process.execPath, ['-e', 'console.log("out"); process.exitCode = 7'], { timeoutMs: 20_000 });
    expect(result).toMatchObject({ status: 7, timedOut: false });
    expect(result.stdout).toContain('out');
  });

  it('kills the whole tree at the timeout and reports no status', async () => {
    const begun = Date.now();
    const result = await runBounded(process.execPath, ['-e', `${PARENT} setTimeout(() => {}, 60000);`], {
      timeoutMs: 1_500,
      graceMs: GRACE_MS,
    });
    const pid = Number(result.stdout.trim());
    started.push(pid);
    expect(result).toMatchObject({ status: null, timedOut: true });
    expect(Date.now() - begun).toBeLessThan(10_000);
    expect(pid).toBeGreaterThan(0);
    expect(result.killFailed).toBe(false);
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 10_000 });
  }, 20_000);

  it.each<[string, () => boolean]>([
    ['reports failure', () => false],
    ['throws EPERM', () => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    }],
  ])('reports a kill that %s as no status and a failed kill, without crashing', async (_name, killTree) => {
    const result = await runBounded(process.execPath, ['-e', 'console.log(process.pid); setTimeout(() => {}, 60000);'], {
      timeoutMs: 1_000,
      graceMs: GRACE_MS,
      killTree,
    });
    // The fake kill left it running, so this cleans up for real.
    started.push(Number(result.stdout.trim()));
    expect(result).toMatchObject({ status: null, timedOut: true, killFailed: true });
  }, 20_000);

  it('counts a kill of a tree that is already gone as success', async () => {
    const { pid } = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await vi.waitFor(() => expect(isAlive(pid!)).toBe(false), { timeout: 10_000 });
    expect(killProcessTree(pid!)).toBe(true);
  }, 20_000);

  it('reports the exit, not a timeout, when the limit passes while only output is awaited', async () => {
    const result = await runBounded(process.execPath, ['-e', `${PARENT} grandchild.unref(); setTimeout(() => process.exit(0), 100);`], {
      timeoutMs: 1_000,
      graceMs: 2_000,
    });
    started.push(Number(result.stdout.trim()));
    expect(result).toMatchObject({ status: 0, timedOut: false, killFailed: false });
  }, 20_000);

  it('does not wait for a grandchild that keeps the pipes open after the child exits', async () => {
    const begun = Date.now();
    const result = await runBounded(process.execPath, ['-e', `${PARENT} grandchild.unref(); setTimeout(() => process.exit(4), 100);`], {
      timeoutMs: 15_000,
      graceMs: GRACE_MS,
    });
    started.push(Number(result.stdout.trim()));
    expect(result).toMatchObject({ status: 4, timedOut: false });
    expect(Date.now() - begun).toBeLessThan(10_000);
  }, 20_000);

  it('reports a command that cannot start, without throwing', async () => {
    const result = await runBounded('no-such-command-here', [], { timeoutMs: 5_000 });
    expect(result).toMatchObject({ status: null, timedOut: false });
  });
});

describe('scripts/readback.mjs', () => {
  it('runs adapters under the bounded runner, ignoring a report from a timed-out run', () => {
    const source = readFileSync('scripts/readback.mjs', 'utf8');
    expect(source).toContain('await runBounded(command, args');
    expect(source).not.toContain('spawnSync');
    expect(source).toContain('!result.timedOut && existsSync(outPath)');
  });
});

describe('namesExactVersion', () => {
  it.each<[string, string, boolean]>([
    ['anvil Version: 1.5.1-stable', '1.5.1', true],
    ['forge v1.5.1', '1.5.1', true],
    ['Geth\nVersion: 1.17.10-stable\nGit', '1.17.10', true],
    ['reth Version: 2.9.0', '2.9.0', true],
    ['anvil Version: 1.5.10', '1.5.1', false],
    ['anvil Version: 11.5.1', '1.5.1', false],
    ['anvil Version: 1.5.1.2', '1.5.1', false],
    ['anvil Version: 1x5x1', '1.5.1', false],
  ])('%s against %s', (text, version, expected) => {
    expect(namesExactVersion(text, version)).toBe(expected);
  });
});

describe('.github/workflows/independent-checks.yml', () => {
  it('matches pinned versions exactly', () => {
    const workflow = readFileSync('.github/workflows/independent-checks.yml', 'utf8');
    expect(workflow).not.toMatch(/grep -q "(?:1\.5\.1|\$GETH_VERSION|\$RETH_VERSION)"/);
    expect(workflow).toContain('exact 1.5.1');
  });
});

describe('scripts/mainnet-check.mjs', () => {
  it('exits 1, not 3, when the build fails, with a fake npm and no real build', () => {
    const folder = mkdtempSync(join(tmpdir(), 'fake-npm-'));
    try {
      writeFileSync(join(folder, 'npm.cmd'), '@exit /b 1\r\n');
      writeFileSync(join(folder, 'npm'), '#!/bin/sh\nexit 1\n');
      chmodSync(join(folder, 'npm'), 0o755);
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH'));
      const run = spawnSync(process.execPath, ['scripts/mainnet-check.mjs'], {
        encoding: 'utf8',
        env: { ...env, PATH: `${folder}${delimiter}${process.env.PATH ?? process.env.Path}`, MAINNET_ARCHIVE_RPC_URL: 'http://127.0.0.1:1/x' },
      });
      expect(run.status, `${run.stdout}${run.stderr}`).toBe(1);
      expect(run.stdout).toContain('npm run failed');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }, 20_000);

  it('gives each exit-3 self-test case its own reason, and a closed port rather than a blocked one', () => {
    const source = readFileSync('scripts/mainnet-check.mjs', 'utf8');
    expect(source).not.toContain('127.0.0.1:9/');
    expect(source).toContain('await freePort()');
    for (const reason of ["includes('missing trie node')", "includes('ECONNREFUSED')", "includes('on chain 5')"]) {
      expect(source).toContain(reason);
    }
    expect(source).toMatch(/runSelfTest\(\) \{[^]*?await fetchCandidate\(candidate\)/);
  });
});
