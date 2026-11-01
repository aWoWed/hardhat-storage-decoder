/** Telling a wrong answer from no answer, with and without retries. */
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeRpc } from '../../deployments/shared/fake-rpc-server.mjs';
import type { FakeReply, FakeRpc } from '../../deployments/shared/fake-rpc-server.mjs';
import { freePort } from '../../deployments/shared/free-port.mjs';
import { CouldNotCheck, fetchJson } from '../../scripts/fetch-json.mjs';

const POST = { method: 'POST', body: '{"method":"x"}' };
let server: FakeRpc | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function serving(...replies: FakeReply[]) {
  let at = 0;
  server = await startFakeRpc({ rule: () => replies[Math.min(at++, replies.length - 1)] });
  return server;
}

describe('fetchJson', () => {
  it('returns the status and the parsed body', async () => {
    const { url } = await serving({ status: 404, body: '{"a":1}' });
    await expect(fetchJson(url, POST)).resolves.toEqual({ status: 404, body: { a: 1 } });
  });

  it('gives no body for an empty reply', async () => {
    const { url } = await serving({ status: 200, body: '' });
    await expect(fetchJson(url, POST)).resolves.toEqual({ status: 200, body: undefined });
  });

  it('with one attempt, hands back a 429 or 5xx, since a JSON-RPC error can arrive under one', async () => {
    const fake = await serving({ status: 503, body: '{"error":{"message":"busy"}}' });
    await expect(fetchJson(fake.url, POST)).resolves.toEqual({ status: 503, body: { error: { message: 'busy' } } });
    expect(fake.count()).toBe(1);
  });

  it('with more attempts, tries a 429 or 5xx again', async () => {
    const fake = await serving({ status: 429, body: '{}' }, { status: 503, body: '{}' }, { status: 200, body: '{"ok":true}' });
    const answer = await fetchJson(fake.url, POST, { attempts: 3, retryDelayMs: 0 });
    expect(answer).toEqual({ status: 200, body: { ok: true } });
    expect(fake.count()).toBe(3);
  });

  it('with more attempts, gives up saying which status it last saw', async () => {
    const fake = await serving({ status: 503, body: '{}' });
    const failure = fetchJson(fake.url, POST, { attempts: 2, retryDelayMs: 0 });
    await expect(failure).rejects.toBeInstanceOf(CouldNotCheck);
    await expect(failure).rejects.toThrow('HTTP 503');
    expect(fake.count()).toBe(2);
  });

  it('does not retry a body that is not JSON', async () => {
    const fake = await serving({ status: 200, body: '<html>' });
    const failure = fetchJson(fake.url, POST, { attempts: 3, retryDelayMs: 0 });
    await expect(failure).rejects.toThrow('HTTP 200 with a body that is not JSON');
    expect(fake.count()).toBe(1);
  });

  it('names the refused connection, which is what the mainnet self-test looks for', async () => {
    const failure = fetchJson(`http://127.0.0.1:${await freePort()}`, POST);
    await expect(failure).rejects.toBeInstanceOf(CouldNotCheck);
    await expect(failure).rejects.toThrow('network failure: ECONNREFUSED');
  });

  it('says why when the failure under it has a message and no code, as a blocked port has', async () => {
    await expect(fetchJson('http://127.0.0.1:6000', POST)).rejects.toThrow('network failure: bad port');
  });
});
