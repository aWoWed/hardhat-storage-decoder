/**
 * Whether a tool's version output names exactly this version: `1.5.1` is not found in `1.5.10` or
 * `11.5.1`, and a suffix such as `1.5.1-stable` still counts.
 *
 * @param {string} text
 * @param {string} version
 */
export function namesExactVersion(text, version) {
  const escaped = version.replace(/\./g, '\\.');
  return new RegExp(`(?:^|[^0-9.])${escaped}(?:$|[^0-9.])`, 'm').test(text);
}
