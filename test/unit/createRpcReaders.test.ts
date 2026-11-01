/** The shared RPC readers: what they send, and that each adapter keeps its own wording. */
import { describe, expect, it } from 'vitest';
import { createRpcReaders } from '../../src/core/rpc/createRpcReaders.js';

const ADDRESS = '0x3333333333333333333333333333333333333333';
const message = (method: string, result: unknown) => `${method} gave ${String(result)}`;

function readers(reply: unknown) {
  const calls: Array<[string, unknown[]]> = [];
  return {
    calls,
    ...createRpcReaders((method, params) => {
      calls.push([method, params]);
      return reply;
    }, message),
  };
}

describe('createRpcReaders', () => {
  it('sends each read in the form its method takes', async () => {
    const storage = readers('0x01');
    await storage.getStorageAt({ address: ADDRESS, slot: 16n, blockTag: 5n });
    expect(storage.calls).toEqual([['eth_getStorageAt', [ADDRESS, '0x10', '0x5']]]);

    const code = readers('0x60');
    await expect(code.getCode(ADDRESS, 'latest')).resolves.toBe('0x60');
    expect(code.calls).toEqual([['eth_getCode', [ADDRESS, 'latest']]]);

    const block = readers('0x2a');
    await expect(block.getBlockNumber()).resolves.toBe(42n);
    expect(block.calls).toEqual([['eth_blockNumber', []]]);
  });

  it('pads a short storage word to 32 bytes', async () => {
    const word = await readers('0x01').getStorageAt({ address: ADDRESS, slot: 0n, blockTag: 'latest' });
    expect(word).toHaveLength(32);
    expect(word[31]).toBe(1);
  });

  it('rejects, and sends nothing, for a slot it cannot format', async () => {
    const { calls, getStorageAt } = readers('0x01');
    await expect(getStorageAt({ address: ADDRESS, slot: -1n, blockTag: 'latest' })).rejects.toThrow(TypeError);
    expect(calls).toEqual([]);
  });

  it('uses the wording it was given for a reply that is not a string', async () => {
    const { getCode, getStorageAt } = readers(null);
    await expect(getCode(ADDRESS, 'latest')).rejects.toThrow(new TypeError('eth_getCode gave null'));
    await expect(getStorageAt({ address: ADDRESS, slot: 0n, blockTag: 'latest' })).rejects.toThrow(
      new TypeError('eth_getStorageAt gave null')
    );
  });

  it('gives where a bad reply came from to the wording', async () => {
    const seen: unknown[] = [];
    const { getStorageAt } = createRpcReaders(
      () => 7,
      (_method, _result, where) => {
        seen.push(where);
        return 'bad';
      }
    );
    await expect(getStorageAt({ address: ADDRESS, slot: 1n, blockTag: 'latest' })).rejects.toThrow('bad');
    expect(seen).toEqual([{ address: ADDRESS, slot: '0x1' }]);
  });

  it('reaches the provider only when a read runs', () => {
    let calls = 0;
    createRpcReaders(() => (calls += 1), message);
    expect(calls).toBe(0);
  });
});
