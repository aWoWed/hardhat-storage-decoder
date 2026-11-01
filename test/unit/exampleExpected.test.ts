/** Which value the example holds a read to: the page locally, the manifest for a moved value. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectedValue, parseValueLine } from '../../deployments/example/scripts/expected-value.mjs';

const SEPOLIA = '11155111';

const page = readFileSync('docs/public-testnet.md', 'utf8');
const line = page.split(/\r?\n/).find((text) => text.startsWith("await valueTypes.name('revision').read();"));
const parsed = parseValueLine(line as string);

const manifestWith = (revision: string) => ({
  chains: {
    [SEPOLIA]: {
      generations: [
        { contracts: { MockValueTypes: { expected: { revision: { value: '1' } } } } },
        { contracts: { MockValueTypes: { expected: { revision: { value: revision } } } } },
      ],
    },
  },
});

describe('the revision line on the page', () => {
  it('names its manifest entry', () => {
    expect(parsed).toMatchObject({ pageValue: '33n', contract: 'MockValueTypes', entry: 'revision' });
  });

  it('is held to the page on a local chain, whatever the manifest says', () => {
    expect(expectedValue(parsed as never, '31337', manifestWith('44'))).toBe('33n');
  });

  it('is held to the current generation of the manifest on a deployed chain', () => {
    expect(expectedValue(parsed as never, SEPOLIA, manifestWith('33'))).toBe('33n');
    expect(expectedValue(parsed as never, SEPOLIA, manifestWith('44'))).toBe('44n');
  });

  it('refuses a manifest without that entry rather than passing', () => {
    expect(() => expectedValue(parsed as never, SEPOLIA, { chains: {} })).toThrow('no expected');
  });
});

describe('other lines', () => {
  it('stay held to the page on a deployed chain', () => {
    const plain = parseValueLine("await a.name('flag').read(); // value: true");
    expect(plain).toEqual({ expression: "a.name('flag').read()", pageValue: 'true' });
    expect(expectedValue(plain as never, SEPOLIA, manifestWith('44'))).toBe('true');
  });

  it('are not value lines without the claim', () => {
    expect(parseValueLine("await a.name('x').read(); // rejects: SomeError")).toBeUndefined();
  });
});
