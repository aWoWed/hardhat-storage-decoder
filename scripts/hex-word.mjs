/**
 * The field-name rule of the two gates that read the manifest, `check-secrets.mjs` and
 * `check-manifest-public.mjs`. Each keeps its own pattern for a whole word.
 */

/** A bytes32 mapping key in an entry name: the one form a name may hold, and only under `expected`. */
const NAME_WORD = /\{w:0x[0-9a-fA-F]{64}\}/g;
/** Hex runs joined by one separator, so `aa:bb` cannot spread a word across a name. */
const HEX_RUNS = /(?:0[xX])?[0-9a-fA-F]+(?:[^0-9a-zA-Z](?:0[xX])?[0-9a-fA-F]+)+/g;

/**
 * Whether a field name holds a 64-hex word, whole or spread across separators.
 *
 * @param {string} name - The field name.
 * @param {boolean} isEntryName - Whether it sits under `expected`, where {@link NAME_WORD} is allowed.
 * @param {RegExp} wholeWord - The gate's pattern for a whole word. Not global.
 * @returns {boolean}
 */
export function holdsHexWord(name, isEntryName, wholeWord) {
  const rest = isEntryName ? name.replace(NAME_WORD, '') : name;
  if (wholeWord.test(rest)) return true;
  return [...rest.matchAll(HEX_RUNS)].some(
    ([run]) => run.replace(/0[xX]|[^0-9a-fA-F]/g, '').length >= 64
  );
}
