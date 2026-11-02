/**
 * The mainnet check's pure rules: what it counts as zero, which the release gate will not take as
 * evidence alone, and how it talks to its oracle.
 */
import { describe, expect, it } from 'vitest';
import { decodeOracle, encodeCall, isZeroValue, normalize, solcAtLeast } from '../../scripts/mainnet-values.mjs';

describe('isZeroValue', () => {
  it.each([
    ['0', 'uint256'],
    ['false', 'bool'],
    ['', 'string'],
    [`0x${'0'.repeat(40)}`, 'address'],
    [`0x${'0'.repeat(64)}`, 'bytes32'],
    ['0x', 'bytes'],
    ['0x0000', 'bytes'],
  ])('counts %s of type %s as zero', (value, type) => {
    expect(isZeroValue(value, type)).toBe(true);
  });

  it.each([
    ['1', 'uint256'],
    ['10', 'uint256'],
    ['true', 'bool'],
    [`0x${'0'.repeat(39)}1`, 'address'],
    ['0x0001', 'bytes'],
    ['0x00', 'string'],
    ['0', 'string'],
  ])('does not count %s of type %s as zero', (value, type) => {
    expect(isZeroValue(value, type)).toBe(false);
  });
});

describe('solcAtLeast', () => {
  it.each([
    ['0.5.13+commit.5b0b510c', true],
    ['0.5.14+commit.01f1aaa4', true],
    ['0.6.0', true],
    ['0.8.26+commit.8a97fa7a', true],
    ['0.10.0', true],
    ['1.0.0', true],
    ['0.5.12+commit.7709ece9', false],
    ['0.4.26+commit.4563c3fc', false],
  ])('%s against 0.5.13 is %s', (version, expected) => {
    expect(solcAtLeast(version, [0, 5, 13])).toBe(expected);
  });
});

describe('encodeCall', () => {
  const ADDRESS = '0x00000000219AB540356cBB839Cbe05303d7705Fa';
  const padded = `${'0'.repeat(24)}00000000219ab540356cbb839cbe05303d7705fa`;

  it('gives the known selector, with no arguments', () => {
    expect(encodeCall({ signature: 'totalSupply()' })).toBe('0x18160ddd');
  });

  it('pads an address to a word, in lower case', () => {
    expect(encodeCall({ signature: 'balanceOf(address)', args: [ADDRESS] })).toBe(`0x70a08231${padded}`);
  });

  it('writes a number in hex and keeps the order of the arguments', () => {
    const data = encodeCall({ signature: 'f(uint256,address)', args: [255, ADDRESS] });
    expect(data.slice(10)).toBe(`${'ff'.padStart(64, '0')}${padded}`);
  });

  it('gives another selector for another signature', () => {
    expect(encodeCall({ signature: 'totalSupply(uint256)' })).not.toBe('0x18160ddd');
  });
});

describe('decodeOracle', () => {
  const word = (hex: string) => hex.padStart(64, '0');
  const stringAt = (offset: number, text: string) => {
    const bytes = Buffer.from(text, 'utf8');
    return word(offset.toString(16)) + word(bytes.length.toString(16)) + bytes.toString('hex').padEnd(64, '0');
  };

  it('reads a number, an address and a bool', () => {
    expect(decodeOracle(`0x${word('ff')}`, { type: 'uint256' })).toBe('255');
    expect(decodeOracle(`0x${word('AB')}`, { type: 'address' })).toBe(`0x${'ab'.padStart(40, '0')}`);
    expect(decodeOracle(`0x${word('1')}`, { type: 'bool' })).toBe('true');
    expect(decodeOracle(`0x${word('0')}`, { type: 'bool' })).toBe('false');
  });

  it('reads the output it is told to', () => {
    expect(decodeOracle(`0x${word('1')}${word('2')}`, { output: 1, type: 'uint256' })).toBe('2');
  });

  it('reads a string, multi-byte letters included', () => {
    expect(decodeOracle(`0x${stringAt(32, 'Wrapped Ether é')}`, { type: 'string' })).toBe('Wrapped Ether é');
    expect(decodeOracle(`0x${stringAt(32, '')}`, { type: 'string' })).toBe('');
  });

  it('follows the offset of a string that is not the first output', () => {
    const result = `0x${word('7')}${stringAt(64, 'abc')}`;
    expect(decodeOracle(result, { output: 1, type: 'string' })).toBe('abc');
  });

  it('does not make a value out of an empty answer', () => {
    expect(() => decodeOracle('0x', { type: 'uint256' })).toThrow(SyntaxError);
    expect(() => decodeOracle('0x', { type: 'bool' })).toThrow(SyntaxError);
    expect(() => decodeOracle('0x', { type: 'string' })).toThrow(SyntaxError);
  });

  it('gives a shorter string for a truncated answer, which then compares unequal', () => {
    const whole = stringAt(32, 'abcdef');
    expect(decodeOracle(`0x${whole.slice(0, 128 + 6)}`, { type: 'string' })).toBe('abc');
  });
});

describe('normalize', () => {
  it.each([
    [255n, 'uint256', '255'],
    ['0xff', 'uint256', '255'],
    ['255', 'uint256', '255'],
    ['0xAB', 'address', `0x${'ab'.padStart(40, '0')}`],
    [true, 'bool', 'true'],
    [false, 'bool', 'false'],
    ['0x1', 'bool', 'true'],
    ['0x0', 'bool', 'false'],
    [0n, 'bool', 'false'],
    ['0x00', 'string', '0x00'],
    ['text', 'string', 'text'],
  ])('%s as %s is %s', (value, type, expected) => {
    expect(normalize(value, type)).toBe(expected);
  });

  it('refuses what is not a number', () => {
    expect(() => normalize('abc', 'uint256')).toThrow(SyntaxError);
    expect(() => normalize('abc', 'address')).toThrow(SyntaxError);
    expect(() => normalize('abc', 'bool')).toThrow(SyntaxError);
  });

  it('gives the two sides of a comparison the same form', () => {
    const word = 'ab'.padStart(64, '0');
    expect(decodeOracle(`0x${word}`, { type: 'address' })).toBe(normalize('0x00000000000000000000000000000000000000AB', 'address'));
  });
});
