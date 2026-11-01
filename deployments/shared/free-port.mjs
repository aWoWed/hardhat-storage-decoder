/**
 * A free local port that `fetch` will talk to. The system can hand out a port on the Fetch
 * standard's blocked list, and `fetch` then fails at once with `bad port`, whatever is listening.
 */
import { createServer } from 'node:net';

/** The Fetch standard's list. `test/unit/freePort.test.ts` compares it with Node's own. */
export const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109,
  110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530,
  531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190,
  5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

const MAX_ATTEMPTS = 20;

const askTheSystem = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

/**
 * @param pick - Where a candidate port comes from; the system unless a test forces one.
 * @returns A port that was free a moment ago and is not on the blocked list.
 */
export async function freePort(pick = askTheSystem) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const port = await pick();
    if (!FETCH_BLOCKED_PORTS.has(port)) return port;
  }
  throw new Error(`no port outside fetch's blocked list in ${MAX_ATTEMPTS} attempts`);
}
