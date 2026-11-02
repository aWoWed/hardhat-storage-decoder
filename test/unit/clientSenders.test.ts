/**
 * How the client suite sends: what a real client answered, recorded by
 * `scripts/clients/run-client.mjs`, and what happens to the key used on Reth.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keySender, type Exec } from '../../scripts/clients/key-sender.mjs';
import { sendFromNode, waitForReceipt } from '../../scripts/local-node.mjs';

const URL = 'http://node.invalid';
const HASH = `0x${'ab'.repeat(32)}`;
const RECEIPT = { status: '0x1', blockNumber: '0x1', contractAddress: null };
const KEY = `0x${'12'.repeat(32)}`;
const ADDRESS = `0x${'34'.repeat(20)}`;
const INDEXING = { code: -32000, message: 'transaction indexing is in progress' };

type Answer = { result: unknown } | { error: { code: number; message: string } };

/** A node that answers each call from `answer`, recording what it was asked. */
function fakeNode(answer: (method: string, params: unknown[]) => Answer) {
  const calls: { method: string; params: unknown[] }[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body);
    calls.push({ method, params });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...answer(method, params) }));
  });
  return calls;
}

/** A sequence of answers to receipt queries, the last repeated. */
const receiptsThen = (...answers: Answer[]) => {
  let next = 0;
  return (method: string): Answer => {
    if (method === 'eth_sendTransaction' || method === 'eth_sendRawTransaction') return { result: HASH };
    return answers[Math.min(next++, answers.length - 1)] as Answer;
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the wait for a receipt', () => {
  it("treats Geth's indexing answer as a transaction not mined yet", async () => {
    const calls = fakeNode(receiptsThen({ error: INDEXING }, { result: null }, { error: INDEXING }, { result: RECEIPT }));
    await expect(sendFromNode(URL, ADDRESS, { to: ADDRESS })).resolves.toEqual(RECEIPT);
    expect(calls.filter(({ method }) => method === 'eth_getTransactionReceipt')).toHaveLength(4);
  });

  it('still gives up at the deadline when indexing never ends', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const answer = receiptsThen({ error: INDEXING });
    fakeNode((method) => {
      now += 30_000;
      return answer(method);
    });
    await expect(waitForReceipt(URL, HASH)).rejects.toThrow(`no receipt for ${HASH}`);
  });

  it.each([
    ['another message with that code', { code: -32000, message: 'header not found' }],
    ['that message with another code', { code: -32602, message: INDEXING.message }],
  ])('does not retry %s', async (_case, error) => {
    const calls = fakeNode(receiptsThen({ error }));
    await expect(waitForReceipt(URL, HASH)).rejects.toThrow(error.message);
    expect(calls).toHaveLength(1);
  });

  it('still refuses a reverted transaction', async () => {
    fakeNode(receiptsThen({ result: { ...RECEIPT, status: '0x0' } }));
    await expect(waitForReceipt(URL, HASH)).rejects.toThrow(`transaction ${HASH} reverted`);
  });
});

describe('keySender', () => {
  /** `cast` as far as this sender needs it: `mktx` answers from `mktx`, or fails as execFile does. */
  function fakeCast(mktx: (args: string[]) => string | { fails: string } = () => '0xsigned') {
    const runs: string[][] = [];
    const exec: Exec = (_command, args, callback) => {
      runs.push(args);
      if (args[0] === 'wallet') {
        callback(null, JSON.stringify([{ address: ADDRESS, private_key: KEY }]), '');
        return;
      }
      const outcome = mktx(args);
      if (typeof outcome === 'string') callback(null, `${outcome}\n`, '');
      else callback(new Error(`Command failed: cast ${args.join(' ')}`), '', outcome.fails);
    };
    return { exec, mktxRuns: () => runs.filter(([first]) => first === 'mktx') };
  }

  it("funds the generated account from the node's account", async () => {
    const calls = fakeNode(receiptsThen({ result: RECEIPT }));
    const { from } = await keySender(URL, '0xnode', fakeCast().exec);
    expect(from).toBe(ADDRESS);
    const funding = calls.find(({ method }) => method === 'eth_sendTransaction');
    expect(funding?.params).toEqual([{ from: '0xnode', to: ADDRESS, value: `0x${(10n ** 20n).toString(16)}` }]);
  });

  it('sends a creation, a call and a transfer as raw transactions, counting the nonce', async () => {
    const calls = fakeNode(receiptsThen({ result: RECEIPT }));
    const cast = fakeCast();
    const { send } = await keySender(URL, '0xnode', cast.exec);
    await send({ data: '0xc0de' });
    await send({ to: '0xaaaa', data: '0xda7a' });
    await send({ to: '0xbbbb', value: '0x10' });

    // `--create` is a subcommand: `cast mktx` 1.5.1 refuses any option placed after it.
    const common = (nonce: number) => ['mktx', '--nonce', String(nonce), '--rpc-url', URL, '--private-key', KEY];
    expect(cast.mktxRuns()).toEqual([
      [...common(0), '--create', '0xc0de'],
      [...common(1), '0xaaaa', '0xda7a'],
      [...common(2), '--value', '16', '0xbbbb'],
    ]);
    expect(calls.filter(({ method }) => method === 'eth_sendRawTransaction').map(({ params }) => params)).toEqual([
      ['0xsigned'],
      ['0xsigned'],
      ['0xsigned'],
    ]);
  });

  it('keeps the nonce when a node refuses the transaction', async () => {
    let refuse = true;
    const receipts = receiptsThen({ result: RECEIPT });
    fakeNode((method) => {
      if (method === 'eth_sendRawTransaction' && refuse) {
        refuse = false;
        return { error: { code: -32000, message: 'refused' } };
      }
      return receipts(method);
    });
    const cast = fakeCast();
    const { send } = await keySender(URL, '0xnode', cast.exec);
    await expect(send({ data: '0xc0de' })).rejects.toThrow('refused');
    await send({ data: '0xc0de' });
    expect(cast.mktxRuns().map((args) => args[args.indexOf('--nonce') + 1])).toEqual(['0', '0']);
  });

  it('names the cause when a failing cast wrote nothing, still without the command line', async () => {
    fakeNode(receiptsThen({ result: RECEIPT }));
    const exec: Exec = (_command, args, callback) => {
      if (args[0] === 'wallet') callback(null, JSON.stringify([{ address: ADDRESS, private_key: KEY }]), '');
      else callback(Object.assign(new Error(`Command failed: cast ${args.join(' ')}`), { code: 'ENOENT' }), '', '');
    };
    const { send } = await keySender(URL, '0xnode', exec);
    await expect(send({ data: '0xc0de' })).rejects.toThrow(/^cast mktx failed: ENOENT$/);
  });

  it.each([
    ['with its prefix', KEY],
    ['without its prefix', KEY.slice(2)],
  ])('reports a cast failure without the key, %s in stderr', async (_case, shown) => {
    fakeNode(receiptsThen({ result: RECEIPT }));
    const { send } = await keySender(URL, '0xnode', fakeCast(() => ({ fails: `bad signer ${shown}\n` })).exec);
    const failure: Error = await send({ data: '0xc0de' }).then(
      () => {
        throw new Error('expected a failure');
      },
      (error: Error) => error
    );
    expect(failure.message).toBe('cast mktx failed: bad signer [key]');
    expect(JSON.stringify([failure.message, failure.stack, failure.cause])).not.toContain(KEY.slice(2));
  });
});
