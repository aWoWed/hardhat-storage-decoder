/**
 * Errors as real clients send them, recorded by `scripts/clients/run-client.mjs`.
 */
import { describe, expect, it } from 'vitest';
import { classifyRpcError } from '../../src/core/rpc/classifyRpcError.js';

const rpcError = (code: number, message: string): Error => Object.assign(new Error(message), { code });

describe('classifyRpcError on recorded client errors', () => {
  // Anvil 1.5.1 sends this one form for a block above its head and for one `--prune-history` has
  // dropped. The wording cannot tell them apart, so it is not treated as pruned: it stays fatal and
  // reaches the caller unchanged. Unlike geth's "header not found", it is not re-sent either.
  it.each([
    ['above the head', 'BlockOutOfRangeError: block height is 30 but requested was 1030'],
    ['no longer held', 'BlockOutOfRangeError: block height is 30 but requested was 1'],
  ])('Anvil, %s: fatal', (_case, message) => {
    expect(classifyRpcError(rpcError(-32602, message))).toBe('fatal');
  });
});
