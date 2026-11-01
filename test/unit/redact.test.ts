/**
 * What the read-back's redactor removes beyond the cases in `readback.test.ts`. Credentials are
 * generated per run, so no fixed one exists in this source.
 */

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makeRedactor, secretPieces } from '../../scripts/redact.mjs';

// Mixed case, as a host token keeps its case in an error while `new URL` lowercases it.
const TOKEN = randomBytes(16)
  .toString('hex')
  .replace(/[a-f]/g, (letter, index) => (index % 2 === 0 ? letter : letter.toUpperCase()));
const PASSWORD_END = randomBytes(8).toString('hex');
const LOGIN_URL = `https://u:p%40${PASSWORD_END}@x.io/`;

describe('redaction of URL parts', () => {
  it.each([
    ['a percent-encoded password, decoded', [LOGIN_URL], `auth p@${PASSWORD_END} failed`, `p@${PASSWORD_END}`],
    ['a percent-encoded password, raw', [LOGIN_URL], `auth p%40${PASSWORD_END} failed`, `p%40${PASSWORD_END}`],
    ['a host token in its original case', [`https://${TOKEN}.quiknode.pro/`], `down ${TOKEN}`, TOKEN],
    ['a host token lowercased', [`https://${TOKEN}.quiknode.pro/`], `down ${TOKEN.toLowerCase()}`, TOKEN.toLowerCase()],
    ['a path token in another case', [`https://x.io/v2/${TOKEN}`], `bad ${TOKEN.toUpperCase()}`, TOKEN.toUpperCase()],
    ['a fragment token', [`https://x.io/#${TOKEN}`], `bad ${TOKEN}`, TOKEN],
    ['a fragment value', [`https://x.io/#token=${TOKEN}`], `bad ${TOKEN}`, TOKEN],
    ['a short path token', ['https://x.io/abc12'], 'bad abc12', 'abc12'],
    ['a host token this run never saw', [], `ENOTFOUND ${TOKEN}.quiknode.pro`, TOKEN],
    ['a short host token in a DNS error', [], 'getaddrinfo ENOTFOUND tok3n123456.quiknode.pro', 'tok3n123456'],
    ['a long host token in free text', [], `upstream ${TOKEN}.rpc.example.org failed`, TOKEN],
    ['a token in a URL that does not parse', [`not a url ${TOKEN}`], `bad ${TOKEN}`, TOKEN],
  ])('removes %s', (_name, urls, text, secret) => {
    expect(makeRedactor(urls)(text)).not.toContain(secret);
  });

  it('does not throw on a bad percent escape', () => {
    expect(secretPieces('https://x.io/abc%zz123')).toContain('abc%zz123');
    expect(makeRedactor(['https://x.io/abc%zz123'])('bad abc%zz123')).toBe('bad <redacted>');
  });

  it('removes a key that lost a leading zero, in any prefix case', () => {
    const hex = `${'a1'.repeat(31)}b`;
    expect(makeRedactor([])(`key 0x${hex}`)).toBe('key <hex>');
    expect(makeRedactor([])(`key 0X${hex}a`)).toBe('key <hex>');
  });

  it('leaves version segments, addresses and source paths readable', () => {
    const address = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
    const redact = makeRedactor(['https://x.io/v2/']);
    expect(secretPieces('https://x.io/v2/')).not.toContain('v2');
    expect(redact(`v2 at ${address}`)).toBe(`v2 at ${address}`);
    expect(redact('StorageQueryBuilder.test.ts failed')).toBe('StorageQueryBuilder.test.ts failed');
  });
});
