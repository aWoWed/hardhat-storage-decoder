/** When the scheduled read-back may skip: exactly no chains, and nothing else. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const folder = mkdtempSync(join(tmpdir(), 'readback-guard-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

function guard(text: string | undefined) {
  const path = join(folder, 'manifest.json');
  if (text !== undefined) writeFileSync(path, text);
  const target = text === undefined ? join(folder, 'none.json') : path;
  return spawnSync(process.execPath, ['scripts/readback-guard.mjs', target], { encoding: 'utf8' });
}

describe('readback-guard', () => {
  it('skips only for an empty chains object', () => {
    const { status, stdout } = guard('{"schemaVersion":1,"chains":{}}');
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('no_chains=true');
  });

  it.each([
    ['another chain, with Sepolia missing', '{"chains":{"1":{"generations":[]}}}'],
    ['a chain with no generation', '{"chains":{"11155111":{"generations":[]}}}'],
    ['no chains field', '{"schemaVersion":1}'],
    ['chains of null', '{"chains":null}'],
    ['chains as a list', '{"chains":[]}'],
  ])('goes on to the read-back for %s', (_name, text) => {
    const { status, stdout } = guard(text);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('no_chains=false');
  });

  it.each([
    ['a missing manifest', undefined],
    ['a manifest that is not JSON', '{'],
  ])('fails for %s', (_name, text) => {
    const { status, stdout } = guard(text);
    expect(status).not.toBe(0);
    expect(stdout).toBe('');
  });
});
