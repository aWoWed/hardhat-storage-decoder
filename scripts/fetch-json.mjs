/**
 * A JSON request that tells a wrong answer from no answer. Its own file because importing
 * `mainnet-check.mjs` runs the check.
 */
import { setTimeout as sleep } from 'node:timers/promises';

/** An answer that says nothing about what was asked: the network, a rate limit, a server fault. */
export class CouldNotCheck extends Error {}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{ attempts?: number, retryDelayMs?: number }} [options] - With more
 *   than one attempt, a failed request, a 429 or a 5xx is tried again, and a 429 or 5xx on the last
 *   attempt throws. With one attempt, those statuses come back like any other, since a JSON-RPC
 *   error can arrive under them.
 * @returns {Promise<{ status: number, body: unknown }>} `body` is `undefined` for an empty reply.
 * @throws {CouldNotCheck} when no attempt gave an answer, or a reply is not JSON.
 */
export async function fetchJson(url, init = {}, { attempts = 1, retryDelayMs = 1000 } = {}) {
  let problem;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(retryDelayMs * attempt);
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (attempts === 1 || (response.status !== 429 && response.status < 500)) {
        const text = await response.text();
        try {
          return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
        } catch {
          throw new CouldNotCheck(`HTTP ${response.status} with a body that is not JSON`);
        }
      }
      problem = `HTTP ${response.status}`;
    } catch (error) {
      if (error instanceof CouldNotCheck) throw error;
      problem = error.name === 'TimeoutError' ? 'timed out' : `network failure: ${error.cause?.code ?? error.cause?.message ?? error.message}`;
    }
  }
  throw new CouldNotCheck(problem);
}
