/**
 * Starting a local node and asking it things, and which chain and port it uses. This must stay light:
 * `oracle-common.mjs` imports esbuild at load, which the deployment scripts have no need of.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Nothing persisted: on Windows `kill` gives Anvil no chance to remove its state from
 * `~/.foundry/anvil/tmp`, where each run of thousands of blocks would leave over a gigabyte. Only
 * recent states stay in memory, so reads at old blocks belong before the random writes.
 */
export const ANVIL_NO_PERSISTED_STATES = ['--max-persisted-states', '0'];

/** The local Anvil's chain, and the port the local flow uses unless told otherwise. */
export const LOCAL_CHAIN_ID = 31337;
export const LOCAL_ANVIL_PORT = process.env.DEPLOYMENTS_ANVIL_PORT ?? '8545';

const RPC_TIMEOUT_MS = 30_000;
const RECEIPT_WAIT_MS = 60_000;

export async function jsonRpc(url, method, params = []) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  const body = await response.json();
  if (body.error !== undefined) throw Object.assign(new Error(body.error.message), { code: body.error.code });
  return body.result;
}

export async function waitForNode(url, attempts = 100, delayMs = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await jsonRpc(url, 'eth_chainId');
      return true;
    } catch {
      await sleep(delayMs);
    }
  }
  return false;
}

/** A transaction from an account the node holds: no key exists on this side. */
export async function sendFromNode(url, from, fields) {
  const hash = await jsonRpc(url, 'eth_sendTransaction', [{ from, ...fields }]);
  const deadline = Date.now() + RECEIPT_WAIT_MS;
  // Anvil mines within milliseconds, and a run sends thousands of these.
  for (let wait = 1; Date.now() < deadline; wait = Math.min(wait * 2, 200)) {
    const receipt = await jsonRpc(url, 'eth_getTransactionReceipt', [hash]);
    if (receipt !== null) {
      if (receipt.status !== '0x1') throw new Error(`transaction ${hash} reverted`);
      return receipt;
    }
    await sleep(wait);
  }
  throw new Error(`no receipt for ${hash} within ${RECEIPT_WAIT_MS} ms`);
}

/**
 * A process that serves JSON-RPC at `url`; `stop` ends it and waits for that, then runs `cleanup`.
 *
 * @returns {Promise<{ url: string, stop: () => Promise<void> } | undefined>} `undefined`, with the
 *   process stopped, when it never answered, so that each caller can say what that means.
 */
export async function startProcess(command, args, url, { attempts, cleanup = () => {} } = {}) {
  const child = spawn(command, args, { stdio: 'ignore' });
  let gone = false;
  // A process that could not be spawned emits only 'error', never 'exit'.
  const exited = new Promise((resolve) => {
    child.on('exit', () => {
      gone = true;
      resolve();
    });
    child.on('error', () => {
      gone = true;
      resolve();
    });
  });
  const stop = async () => {
    if (!gone) child.kill();
    await exited;
    cleanup();
  };
  // A killed run must not leave its node behind.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      child.kill();
      cleanup();
      process.exit(1);
    });
  }
  if (!(await waitForNode(url, attempts))) {
    await stop();
    return undefined;
  }
  return { url, stop };
}
