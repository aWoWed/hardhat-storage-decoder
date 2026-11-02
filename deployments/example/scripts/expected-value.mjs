/**
 * What a read line in `docs/public-testnet.md` claims. The page gives one value, but `revision` can
 * legitimately move on a deployed chain, because the seed adds a change when a history read was
 * pruned. Such a line names its manifest entry, and there the manifest decides:
 *
 *   await chain.read(); // value: 33n; deployed: manifest MockValueTypes.revision
 *
 * A local run compares with the page, so the page's value is still tested.
 */

export const LOCAL_CHAIN = '31337';

const VALUE_LINE = /^await (.+\.read\(\)); \/\/ value: (.+?)(?:; deployed: manifest (\w+)\.(\S+))?$/;

export function parseValueLine(line) {
  const match = VALUE_LINE.exec(line);
  if (match === null) return undefined;
  const [, expression, pageValue, contract, entry] = match;
  return { expression, pageValue, ...(contract === undefined ? {} : { contract, entry }) };
}

/** A manifest value as `read.ts` prints a decoded one. Numbers are strings in the manifest. */
function showManifestValue(value) {
  if (typeof value === 'boolean') return String(value);
  return /^-?\d+$/.test(value) ? `${value}n` : `'${value}'`;
}

/** The value a parsed line must read on `chainId`. Throws if the manifest lacks a named entry. */
export function expectedValue({ pageValue, contract, entry }, chainId, manifest) {
  if (contract === undefined || String(chainId) === LOCAL_CHAIN) return pageValue;
  const recorded =
    manifest.chains?.[String(chainId)]?.generations?.at(-1)?.contracts?.[contract]?.expected?.[entry];
  if (recorded === undefined) throw new Error(`the manifest has no expected ${contract}.${entry}`);
  return showManifestValue(recorded.value);
}
