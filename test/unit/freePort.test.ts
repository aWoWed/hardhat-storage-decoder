/**
 * `freePort` against the blocked list `fetch` really applies, not a copy of it.
 */
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { startFakeRpc } from '../../deployments/shared/fake-rpc-server.mjs';
import { FETCH_BLOCKED_PORTS, freePort } from '../../deployments/shared/free-port.mjs';

/** Why `fetch` failed for a port, without connecting: a blocked port fails before that. */
const fetchFailure = (port: number): Promise<unknown> =>
  fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2_000) }).then(
    () => undefined,
    (error: { cause?: { message?: string } }) => error.cause?.message
  );

describe('freePort', () => {
  it('knows exactly the list in the undici this Node runs', () => {
    const natives = (process as unknown as { binding(name: string): Record<string, string> }).binding('natives');
    // Newer bundles write `badPorts = ( /** @type {const} */ [ ... ] )`.
    const list = /badPorts\s*=\s*(?:\(\s*\/\*\*[\s\S]*?\*\/\s*)?\[([\s\S]*?)\]/.exec(
      natives['internal/deps/undici/undici'] ?? ''
    )?.[1];
    expect(list, "undici's source no longer has the list in this form").toBeDefined();
    const ports = [...(list as string).matchAll(/\d+/g)].map(([port]) => Number(port));
    expect(ports.length).toBeGreaterThan(0);
    expect(new Set(ports)).toEqual(FETCH_BLOCKED_PORTS);
  });

  it('every listed port really is refused by fetch', async () => {
    const reasons = await Promise.all([...FETCH_BLOCKED_PORTS].map(fetchFailure));
    expect(new Set(reasons)).toEqual(new Set(['bad port']));
  });

  it('skips forced blocked ports and takes the first allowed one', async () => {
    const offered = [6000, 6666, 10080, 51234];
    let asked = 0;
    const port = await freePort(async () => offered[asked++] as number);
    expect(port).toBe(51234);
    expect(asked).toBe(4);
  });

  it('gives up rather than returning a blocked port', async () => {
    let asked = 0;
    await expect(
      freePort(async () => {
        asked += 1;
        return 6000;
      })
    ).rejects.toThrow(/blocked list/);
    expect(asked).toBe(20);
  });

  it('returns a port fetch can really use', async () => {
    const port = await freePort();
    expect(FETCH_BLOCKED_PORTS.has(port)).toBe(false);
    const server = createServer((_request, response) => response.end('ok'));
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    try {
      expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('ok');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('the fake RPC server never serves on a blocked port', async () => {
    const fake = await startFakeRpc({ rule: () => ({ result: '0x1' }) });
    try {
      expect(FETCH_BLOCKED_PORTS.has(Number(new URL(fake.url).port))).toBe(false);
    } finally {
      await fake.close();
    }
  });
});
