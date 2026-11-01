/**
 * The mainnet check's pure rules: what its oracle call sends, how its answer reads, and what counts
 * as weak evidence. Their own file because importing `mainnet-check.mjs` runs the check.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export const bare = (hex) => hex.replace(/^0x/, '').toLowerCase();

/**
 * @param {string} version - A compiler version, such as `0.8.26+commit.8a97fa7a`.
 * @param {number[]} minimum - As major, minor, patch.
 * @returns {boolean}
 */
export function solcAtLeast(version, minimum) {
  const parts = version.split('+')[0].split('.').map(Number);
  for (let i = 0; i < minimum.length; i += 1) {
    if (parts[i] !== minimum[i]) return parts[i] > minimum[i];
  }
  return true;
}

export function encodeCall({ signature, args = [] }) {
  const selector = bytesToHex(keccak_256(utf8ToBytes(signature))).slice(0, 8);
  const words = args.map((arg) =>
    (typeof arg === 'number' ? arg.toString(16) : bare(arg)).padStart(64, '0')
  );
  return `0x${selector}${words.join('')}`;
}

/** Decodes what `eth_call` returned, to the form {@link normalize} gives the decoder's value. */
export function decodeOracle(result, { output = 0, type }) {
  const data = bare(result);
  const word = (index) => data.slice(index * 64, (index + 1) * 64);
  if (type === 'string') {
    const offset = Number(BigInt(`0x${word(output)}`)) * 2;
    const length = Number(BigInt(`0x${data.slice(offset, offset + 64)}`));
    return Buffer.from(data.slice(offset + 64, offset + 64 + length * 2), 'hex').toString('utf8');
  }
  return normalize(`0x${word(output)}`, type);
}

export function normalize(value, type) {
  if (type === 'string') return String(value);
  if (type === 'bool') return String(value === true || (value !== false && BigInt(value) !== 0n));
  const number = BigInt(value);
  return type === 'address' ? `0x${number.toString(16).padStart(40, '0')}` : number.toString();
}

/**
 * Whether a decoded mainnet value is zero, and so weak evidence: a broken decoder reading an empty
 * slot would match it too.
 *
 * @param {string} value - The value, as {@link normalize} leaves it.
 * @param {string} type - Its oracle type. Text is only empty or not: "0x00" in a string is content.
 * @returns {boolean}
 */
export function isZeroValue(value, type) {
  if (type === 'string') return value === '';
  return value === '' || value === 'false' || /^(?:0|0x0*)$/i.test(value);
}
