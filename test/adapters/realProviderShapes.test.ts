/**
 * The failures real endpoints produced when probed, through the real Hardhat 2 and 3 HTTP providers,
 * over real HTTP, into the real classifiers. `limitAndRetry.test.ts` builds its errors by hand from
 * reading those providers, and this is what checks that reading.
 *
 * `deployments/hh{2,3}/test/provider-shapes.test.ts` repeat the table on the Hardhat versions the
 * deployment projects pin.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { SHAPE_CASES, startFakeRpc } from '../../deployments/shared/fake-rpc-server.mjs';
import { classifyProviderError as classifyHh2 } from '../../src/hardhat2/provider.js';
import { classifyProviderError as classifyHh3 } from '../../src/hardhat3/provider.js';

const require = createRequire(import.meta.url);

/** What a provider rejected with, for one reply repeated on every request. */
async function failureOf(
  reply: (typeof SHAPE_CASES)[number]['reply'],
  request: (url: string) => Promise<unknown>
): Promise<unknown> {
  const server = await startFakeRpc({ rule: () => reply });
  try {
    return await request(server.url).then(
      () => undefined,
      (failure: unknown) => failure
    );
  } finally {
    await server.close();
  }
}

describe('Hardhat 2 HttpProvider', () => {
  const { HttpProvider } = require('hardhat-v2/internal/core/providers/http');

  it.each(SHAPE_CASES)('$name is $hh2', async ({ reply, hh2, hh2Shape }) => {
    const error = await failureOf(reply, (url) =>
      new HttpProvider(url, 'fake', {}, 5000).request({ method: 'eth_chainId', params: [] })
    );
    expect(error).toMatchObject(hh2Shape);
    expect(classifyHh2(error)).toBe(hh2);
  }, 30_000);
});

describe('Hardhat 3 HttpProvider', () => {
  it.each(SHAPE_CASES)('$name is $hh3', async ({ reply, hh3, hh3Shape }) => {
    const { HttpProvider } = await import(
      '../../node_modules/hardhat-v3/dist/src/internal/builtin-plugins/network-manager/http-provider.js' as string
    );
    const error = await failureOf(reply, async (url) => {
      const provider = await HttpProvider.create({
        url,
        networkName: 'fake',
        extraHeaders: {},
        timeout: 5000,
      });
      try {
        return await provider.request({ method: 'eth_chainId', params: [] });
      } finally {
        await provider.close();
      }
    });
    expect(error).toMatchObject(hh3Shape);
    expect(classifyHh3(error)).toBe(hh3);
  }, 30_000);
});
