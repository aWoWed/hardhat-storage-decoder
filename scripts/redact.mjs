/**
 * Everything the read-back prints or writes goes through here first, because an RPC URL can hold a
 * token, and a provider's error can quote the URL or the token alone.
 *
 * Two layers: the pieces of the URLs this run was given, which catches a bare token in an error,
 * then the shape of any URL, which catches one this run never saw.
 */

const ANY_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/gi;
/** `rpc.example.com/v3/abc`, as some errors quote it without the scheme. */
const BARE_HOST_PATH = /\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?::\d+)?\/[^\s"'`<>]+/gi;
/** A DNS failure quotes the host alone, and a token can be its first label. */
const DNS_FAILURE = /\b(ENOTFOUND|EAI_AGAIN)\s+[^\s"'`<>]+/g;
const TOKEN_LABEL = /^(?=[a-z]*\d)(?=\d*[a-z])[0-9a-z]{16,}$/i;
const TOKEN_HOST = /\b(?=[a-z]*\d)(?=\d*[a-z])[0-9a-z]{16,}(?:\.[\w-]+)*\.[a-z]{2,}\b/gi;
/** Longer than an address, which stays readable. Covers a key that lost a leading zero. */
const WORD_HEX = /\b(?:0[xX])?[0-9a-fA-F]{41,}\b/g;

/** A longer path part can be a token whatever it holds. */
const MIN_PATH_SECRET = 6;
/** A shorter one needs a digit as well: `v3` and `rpc` are words, `abc12` may not be. */
const MIN_MIXED_PATH_SECRET = 4;
const MIN_QUERY_SECRET = 4;
const MIN_MALFORMED_SECRET = 8;
const VERSION_SEGMENT = /^v\d+$/i;

function decoded(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function isPathSecret(segment) {
  if (segment.length >= MIN_PATH_SECRET) return true;
  return segment.length >= MIN_MIXED_PATH_SECRET && /\d/.test(segment) && !VERSION_SEGMENT.test(segment);
}

/**
 * The parts of a URL that can be a secret: credentials, host, path segments, query and fragment
 * values.
 *
 * @param {string} url
 * @returns {string[]} Each in its raw and decoded forms.
 */
export function secretPieces(url) {
  const pieces = [url];
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    pieces.push(...url.split(/\s+/).filter((part) => part.length >= MIN_MALFORMED_SECRET));
    return pieces;
  }
  pieces.push(parsed.host, parsed.hostname, parsed.username, parsed.password);
  pieces.push(decoded(parsed.username), decoded(parsed.password));
  for (const label of parsed.hostname.split('.')) {
    if (TOKEN_LABEL.test(label)) pieces.push(label);
  }
  for (const segment of parsed.pathname.split('/')) {
    if (isPathSecret(segment)) pieces.push(segment, decoded(segment));
  }
  for (const [name, value] of parsed.searchParams) {
    if (value.length >= MIN_QUERY_SECRET) pieces.push(value, encodeURIComponent(value));
    if (name.length >= MIN_PATH_SECRET && value === '') pieces.push(name);
  }
  const fragment = parsed.hash.slice(1);
  if (fragment.length >= MIN_QUERY_SECRET) {
    pieces.push(fragment, decoded(fragment));
    for (const part of fragment.split(/[&=]/)) {
      if (part.length >= MIN_PATH_SECRET) pieces.push(part, decoded(part));
    }
  }
  return pieces.filter((piece) => piece.length > 0);
}

/**
 * @param {Array<string | undefined>} urls - The URLs of this run; undefined entries are skipped.
 * @returns {(text: string) => string}
 */
export function makeRedactor(urls) {
  const pieces = [...new Set(urls.flatMap((url) => (url ? secretPieces(url) : [])))].sort(
    (a, b) => b.length - a.length
  );
  // Case-insensitive, because `new URL` lowercases a host and an error may quote either form.
  const known = pieces.map((piece) => new RegExp(piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
  return (text) => {
    let result = String(text);
    for (const piece of known) result = result.replace(piece, '<redacted>');
    return result
      .replace(ANY_URL, '<url>')
      .replace(BARE_HOST_PATH, '<url>')
      .replace(DNS_FAILURE, '$1 <url>')
      .replace(TOKEN_HOST, '<url>')
      .replace(WORD_HEX, '<hex>');
  };
}

/**
 * Applies a redactor to every string inside a JSON-shaped value, keys included.
 *
 * @template T
 * @param {T} value
 * @param {(text: string) => string} redact
 * @returns {T}
 */
export function redactDeep(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [redact(key), redactDeep(item, redact)])
  );
}
