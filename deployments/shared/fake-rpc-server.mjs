/**
 * A local JSON-RPC server that misbehaves on request, for testing failure handling through the real
 * Hardhat providers. It answers from a rule, and forwards anything the rule leaves alone to a real
 * upstream node, so a fault can apply to one method while every other value stays true. It counts
 * every request it receives, which is what lets a test assert what was not sent.
 */
import { createServer } from 'node:http';
import { FETCH_BLOCKED_PORTS } from './free-port.mjs';

/** A reply of `{ error }` or `{ result }` is wrapped as JSON-RPC, `{ status, body }` is sent raw. */
function send(response, id, reply) {
  const status = reply.status ?? 200;
  const headers = { 'content-type': 'application/json', ...reply.headers };
  if (reply.body !== undefined) {
    const body = typeof reply.body === 'function' ? reply.body(id) : reply.body;
    response.writeHead(status, headers).end(body);
    return;
  }
  const payload =
    reply.error !== undefined ? { jsonrpc: '2.0', id, error: reply.error } : { jsonrpc: '2.0', id, result: reply.result };
  response.writeHead(status, headers).end(JSON.stringify(payload));
}

/**
 * @param {{ upstream?: string, rule?: (request: object) => object | undefined, path?: string }} options
 *   `path` is added to the URL, such as a fake token.
 */
export async function startFakeRpc({ upstream, rule, path = '' } = {}) {
  const requests = [];

  const server = createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => {
      text += chunk;
    });
    request.on('end', async () => {
      try {
        const { id, method, params } = JSON.parse(text);
        const seen = { id, method, params: params ?? [], url: request.url };
        requests.push(seen);
        const reply = rule?.(seen);
        if (reply !== undefined) return send(response, id, reply);
        if (upstream === undefined) {
          return send(response, id, { error: { code: -32601, message: `no rule for ${method}` } });
        }
        const forwarded = await fetch(upstream, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: text,
        });
        response.writeHead(forwarded.status, { 'content-type': 'application/json' });
        response.end(await forwarded.text());
      } catch (error) {
        response.writeHead(500).end(String(error));
      }
    });
  });

  // This server has to hold its port, so it re-listens rather than taking one from `freePort`.
  for (;;) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    if (!FETCH_BLOCKED_PORTS.has(server.address().port)) break;
    await new Promise((resolve) => server.close(resolve));
  }
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}${path}`,
    port,
    requests,
    count: (...methods) =>
      methods.length === 0
        ? requests.length
        : requests.filter(({ method }) => methods.includes(method)).length,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

const HTML_401 = '<html><head><title>401 Authorization Required</title></head><body>denied</body></html>';
const HTML_503 = '<html><body><h1>503 Service Unavailable</h1></body></html>';
const JSON_ERROR = (code, message) => (id) => JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });

/** Hardhat's own 429 retries, with no waiting: seven more after the first. */
const HARDHAT_429_REQUESTS = 8;
const RETRY_ATTEMPTS = 3;

/**
 * The failures real endpoints produced when probed on 2026-10-31. `hh2` and `hh3` are the
 * class each adapter is expected to give it, what `classifyProviderError` returns, and `hh2Shape`
 * and `hh3Shape` pin the error fields that class rests on.
 */
export const SHAPE_CASES = [
  {
    name: 'HTTP 429',
    reply: {
      status: 429,
      headers: { 'retry-after': '0' },
      body: JSON_ERROR(-32029, 'Too Many Requests'),
    },
    hh2: 'exhausted',
    hh3: 'exhausted',
    hh2Shape: { code: -32005 },
    hh3Shape: { code: -32005, cause: { statusCode: 429 } },
    requests: HARDHAT_429_REQUESTS,
  },
  {
    name: 'HTTP 400 with a JSON-RPC body',
    reply: {
      status: 400,
      body: JSON_ERROR(35, 'chain is not available on free plan, please upgrade to paid plan'),
    },
    hh2: 'exhausted',
    hh3: 'exhausted',
    hh2Shape: { code: 35 },
    hh3Shape: { code: -1, cause: { statusCode: 400 } },
  },
  {
    name: 'HTTP 401 with a JSON-RPC body',
    reply: { status: 401, body: JSON_ERROR(-32000, 'invalid project id') },
    hh2: 'fatal',
    hh3: 'exhausted',
    hh2Shape: { code: -32000 },
    hh3Shape: { code: -1, cause: { statusCode: 401 } },
  },
  {
    name: 'HTTP 401 with an HTML body',
    reply: { status: 401, headers: { 'content-type': 'text/html' }, body: HTML_401 },
    hh2: 'retryable',
    hh3: 'exhausted',
    hh2Shape: { number: 110 },
    hh3Shape: { code: -1, cause: { statusCode: 401 } },
  },
  {
    name: 'HTTP 503 with an HTML body',
    reply: { status: 503, headers: { 'content-type': 'text/html' }, body: HTML_503 },
    hh2: 'retryable',
    hh3: 'retryable',
    hh2Shape: { number: 110 },
    hh3Shape: { code: -1, cause: { statusCode: 503 } },
  },
  {
    name: '4444 pruned over 200',
    reply: {
      error: { code: 4444, message: 'pruned history unavailable: requested 11814928, earliest available 12020851' },
    },
    hh2: 'pruned',
    hh3: 'pruned',
    hh2Shape: { code: 4444 },
    hh3Shape: { code: 4444 },
  },
  {
    name: '-32001 block not found over 200',
    reply: { error: { code: -32001, message: 'block not found: 0xb797b8' } },
    hh2: 'retryable',
    hh3: 'retryable',
    hh2Shape: { code: -32001 },
    hh3Shape: { code: -32001 },
  },
  {
    name: '-32001 usage limit over 200',
    reply: {
      error: { code: -32001, message: "You've reached the usage limit for your current plan. Please upgrade." },
    },
    hh2: 'exhausted',
    hh3: 'exhausted',
    hh2Shape: { code: -32001 },
    hh3Shape: { code: -32001 },
  },
  {
    name: 'a non-JSON-RPC body over 200',
    reply: {
      body: '{"timestamp":1793500000,"status":429,"error":"cu limit exceeded; Request too fast per second"}',
    },
    hh2: 'retryable',
    hh3: 'retryable',
    hh2Shape: { number: 110 },
    hh3Shape: { number: 702 },
  },
];

/** How many requests a class leaves at the server, from one read with the default settings. */
export function requestsFor(shape, kind) {
  if (shape.requests !== undefined) return shape.requests;
  return kind === 'retryable' ? RETRY_ATTEMPTS : 1;
}
