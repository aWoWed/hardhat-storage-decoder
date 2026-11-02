/**
 * A sender for a client whose node-held accounts cannot create a contract.
 *
 * Reth 2.9.0 signs a call or a transfer for such an account, but answers every creation with -32602
 * "invalid transaction request", through `eth_sendTransaction` and `eth_signTransaction`, with every
 * field given and with `to: null`. A factory would not do: the mocks' owner would be the factory.
 *
 * So the key is generated here at run time and funded by the node's account. It stays in memory, and
 * the chain that knows it ends with the run. `cast` takes it as an argument, so a failure reports
 * only cast's stderr with the key removed: never the command line, which `execFile`'s error repeats.
 */
import { execFile } from 'node:child_process';
import { jsonRpc, sendFromNode, waitForReceipt } from '../local-node.mjs';

const FUNDING_WEI = 10n ** 20n;

/**
 * @returns {Promise<{ from: string, send: (fields: object) => Promise<object> }>} `send` waits for
 *   the receipt and takes one transaction at a time, since it counts the nonce itself.
 */
export async function keySender(url, nodeAccount, exec = execFile) {
  let key;
  const scrub = (text) => (key === undefined ? text : text.replaceAll(key, '[key]').replaceAll(key.replace(/^0x/, ''), '[key]'));
  const cast = (args) =>
    new Promise((resolve, reject) => {
      exec('cast', args, (error, stdout, stderr) => {
        if (error === null || error === undefined) resolve(stdout.trim());
        else reject(new Error(`cast ${args[0]} failed: ${scrub(String(stderr)).trim() || (error.code ?? error.signal ?? 'no output')}`));
      });
    });

  const [wallet] = JSON.parse(await cast(['wallet', 'new', '--json']));
  key = wallet.private_key;
  await sendFromNode(url, nodeAccount, { to: wallet.address, value: `0x${FUNDING_WEI.toString(16)}` });

  let nonce = 0;
  const send = async ({ to, data, value }) => {
    const amount = value === undefined ? [] : ['--value', BigInt(value).toString()];
    // Last, because `--create` is a subcommand of `mktx` and would take the options after it as its own.
    const target = to === undefined ? ['--create', data] : data === undefined ? [to] : [to, data];
    const raw = await cast(['mktx', '--nonce', String(nonce), '--rpc-url', url, '--private-key', key, ...amount, ...target]);
    const hash = await jsonRpc(url, 'eth_sendRawTransaction', [raw]);
    nonce += 1;
    return waitForReceipt(url, hash);
  };
  return { from: wallet.address, send };
}
