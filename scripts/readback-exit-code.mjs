/**
 * The read-back's exit code. Its own file because importing `readback.mjs` runs the read-back.
 *
 * @param {readonly { blockTag: 'latest' | number, verdict: string }[]} results
 * @returns {0 | 1 | 3} 1 for any `wrong`. 3 for a `latest` entry that could not be read, with none
 *   wrong. A `historic` entry that could not be read is reported and does not change the result.
 */
export function exitCodeOf(results) {
  if (results.some(({ verdict }) => verdict === 'wrong')) return 1;
  return results.some(({ blockTag, verdict }) => blockTag === 'latest' && verdict !== 'pass') ? 3 : 0;
}
