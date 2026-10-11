import { describe, expect, it } from 'vitest';
import {
  formatBlockTag,
  formatSlot,
  isHexQuantity,
  parseBlockNumber,
} from '../../src/core/rpc/getStorageAt.js';

describe('formatBlockTag', () => {
  it('renders numbers and bigints as hex quantities and passes strings through', () => {
    expect(formatBlockTag(16)).toBe('0x10');
    expect(formatBlockTag(16n)).toBe('0x10');
    expect(formatBlockTag(0n)).toBe('0x0');
    expect(formatBlockTag('latest')).toBe('latest');
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1n])(
    'rejects the block number %s',
    (value) => {
      expect(() => formatBlockTag(value)).toThrow(TypeError);
      expect(() => formatBlockTag(value)).toThrow(/non-negative integer/);
    }
  );

  it.each([undefined, null, true, {}])(
    'rejects %j, which is not a block tag at all, instead of rendering it',
    (value) => {
      // Reachable from plain JavaScript only: `.at()` does not validate its argument.
      expect(() => formatBlockTag(value as never)).toThrow(TypeError);
      expect(() => formatBlockTag(value as never)).toThrow(/must be a string, number or bigint/);
    }
  );
});

describe('formatBlockTag with a number beyond Number.MAX_SAFE_INTEGER', () => {
  it.each([2 ** 53, 2 ** 53 + 2, 1e21, 1e30])(
    'rejects the block number %s, which JavaScript may already have rounded',
    (value) => {
      expect(() => formatBlockTag(value)).toThrow(TypeError);
      expect(() => formatBlockTag(value)).toThrow(/bigint/);
    }
  );

  it('accepts the largest safe number, and the same magnitudes as a bigint', () => {
    expect(formatBlockTag(Number.MAX_SAFE_INTEGER)).toBe('0x1fffffffffffff');
    expect(formatBlockTag(2n ** 53n + 1n)).toBe('0x20000000000001');
    expect(formatBlockTag(10n ** 30n)).toBe('0xc9f2c9cd04674edea40000000');
  });
});

describe('formatSlot', () => {
  it('renders a slot as a hex quantity without leading zeros', () => {
    expect(formatSlot(0n)).toBe('0x0');
    expect(formatSlot(1n)).toBe('0x1');
    expect(formatSlot(255n)).toBe('0xff');
    expect(formatSlot(2n ** 64n)).toBe('0x10000000000000000');
  });

  it('renders the largest slot as 64 hex digits', () => {
    expect(formatSlot(2n ** 256n - 1n)).toBe(`0x${'f'.repeat(64)}`);
  });

  it.each([-1n, -(2n ** 256n)])('rejects the negative slot %s', (slot) => {
    expect(() => formatSlot(slot)).toThrow(TypeError);
    expect(() => formatSlot(slot)).toThrow(/slot must not be negative/);
  });

  it.each([2n ** 256n, 2n ** 256n + 5n, 2n ** 300n])(
    'rejects the slot %s, which is past the last storage slot',
    (slot) => {
      expect(() => formatSlot(slot)).toThrow(TypeError);
      expect(() => formatSlot(slot)).toThrow('slot must be below 2^256');
    }
  );
});

describe('parseBlockNumber', () => {
  it('reads a hex quantity', () => {
    expect(parseBlockNumber('0x10')).toBe(16n);
    expect(parseBlockNumber('0x0')).toBe(0n);
  });

  it.each(['', '12', '-1', '0x', '0xzz', ' 0x10'])(
    'rejects %j, which BigInt alone would accept or misread',
    (value) => {
      expect(() => parseBlockNumber(value)).toThrow(/not a hex quantity/);
    }
  );

  it.each([null, undefined, 16, {}])('rejects the non-string %j', (value) => {
    expect(() => parseBlockNumber(value)).toThrow(/expected a hex string/);
  });

  it('describes a bad value instead of echoing it', () => {
    const hostile = `\u001b[31m${'x'.repeat(500)}`;
    const message = (() => {
      try {
        parseBlockNumber(hostile);
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message).toContain('505-character string');
    expect(message).not.toContain('\u001b');
  });
});

describe('isHexQuantity', () => {
  it('accepts quantities and hashes, and nothing else', () => {
    expect(isHexQuantity('0x10')).toBe(true);
    expect(isHexQuantity(`0x${'ab'.repeat(32)}`)).toBe(true);
    expect(isHexQuantity('latest')).toBe(false);
    expect(isHexQuantity('0x')).toBe(false);
    expect(isHexQuantity('10')).toBe(false);
  });
});
