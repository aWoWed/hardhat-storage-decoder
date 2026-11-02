/**
 * What the independent checks share. The rule that makes them independent: an expected slot comes
 * only from `forge inspect`'s layout, `cast index` and `cast keccak`, and an expected value only
 * from a word the node returns and what was written in a transaction. Nothing below `oracleLocate` and
 * `oracleValue` calls the decoder.
 *
 * The decoder under test is the current `src/core`, bundled into `independent/.build/`, so `dist/`
 * plays no part. It is given the output of the repository's `solc` package, as an adapter would.
 */
import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import { freePort } from '../deployments/shared/free-port.mjs';
import { ANVIL_NO_PERSISTED_STATES, jsonRpc as rpc, sendFromNode, startProcess } from './local-node.mjs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const INDEPENDENT = join(ROOT, 'independent');
const BUILD = join(INDEPENDENT, '.build');
const SOURCES = { mocks: join(ROOT, 'deployments', 'contracts'), fixtures: join(ROOT, 'test', 'fixtures', 'contracts') };
const PARALLEL = 16;

/** The oracle's own table of what a user-defined type stands for; layouts only give its name. */
const USER_TYPES = {
  MockId: 'bytes32',
  MockSigned: 'int128',
  MockAmount: 'uint96',
  Id: 'bytes32',
  Signed: 'int128',
  Amount: 'uint96',
  Tag: 'bytes4',
};

/** Fresh copies of the sources, then the Foundry build. */
export function buildIndependent() {
  rmSync(join(INDEPENDENT, 'src'), { recursive: true, force: true });
  for (const [name, from] of Object.entries(SOURCES)) {
    cpSync(from, join(INDEPENDENT, 'src', name), { recursive: true });
  }
  // Forced: an artifact cached after a source edit can lack the layout `forge inspect` wants.
  const forge = spawnSync('forge', ['build', '--force', '--root', INDEPENDENT], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (forge.status !== 0) throw new Error(`forge build failed:\n${forge.stdout}\n${forge.stderr}`);
}

/** The storage layout `forge inspect` reports, for a contract in `independent/src`. */
export function forgeLayout(source, contract) {
  const run = spawnSync(
    'forge',
    ['inspect', '--root', INDEPENDENT, `src/${source}:${contract}`, 'storage-layout', '--json'],
    { encoding: 'utf8', maxBuffer: 1 << 26 }
  );
  if (run.status !== 0) throw new Error(`forge inspect ${source}:${contract} failed:\n${run.stderr}`);
  const layout = JSON.parse(run.stdout);
  return { storage: layout.storage ?? [], types: layout.types ?? {} };
}

/** Every contract Forge built, by name, from its output folder. */
export function forgeContracts() {
  const out = join(INDEPENDENT, 'out');
  return readdirSync(out)
    .filter((name) => name.endsWith('.sol'))
    .flatMap((file) => readdirSync(join(out, file)).map((artifact) => artifact.replace(/\.json$/, '')));
}

export async function loadDecoderCore() {
  mkdirSync(BUILD, { recursive: true });
  const bundle = (entry, name) => {
    const outfile = join(BUILD, name);
    buildSync({ entryPoints: [join(ROOT, entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error' });
    return import(pathToFileURL(outfile).href);
  };
  const [core, plan, manifest] = await Promise.all([
    bundle(join('src', 'core', 'index.ts'), 'decoder-core.mjs'),
    bundle(join('deployments', 'shared', 'seed-plan.ts'), 'seed-plan.mjs'),
    bundle(join('deployments', 'shared', 'manifest.ts'), 'manifest.mjs'),
  ]);
  return { core, plan, manifest };
}

/** The whole tree through the `solc` package, with what an adapter would ask for. */
export function compileWithSolcJs(core) {
  const solc = createRequire(import.meta.url)('solc');
  const sources = {};
  for (const [name, from] of Object.entries(SOURCES)) {
    for (const file of readdirSync(from).filter((entry) => entry.endsWith('.sol'))) {
      sources[`${name}/${file}`] = { content: readFileSync(join(from, file), 'utf8') };
    }
  }
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: 'Solidity',
        sources,
        settings: {
          optimizer: { enabled: false },
          evmVersion: 'cancun',
          outputSelection: {
            '*': {
              '': ['ast'],
              '*': [
                'abi',
                'storageLayout',
                'evm.bytecode.object',
                'evm.deployedBytecode.object',
                'evm.deployedBytecode.immutableReferences',
                'evm.deployedBytecode.linkReferences',
              ],
            },
          },
        },
      })
    )
  );
  const fatal = (output.errors ?? []).filter(({ severity }) => severity === 'error');
  if (fatal.length > 0) throw new Error(fatal.map(({ formattedMessage }) => formattedMessage).join('\n'));

  const asts = Object.values(output.sources).map(({ ast }) => ast);
  const userDefinedValueTypes = core.extractUserDefinedValueTypes(...asts);
  const declaringContracts = core.extractDeclaringContracts(...asts);
  const contracts = [];
  for (const [source, inSource] of Object.entries(output.contracts)) {
    for (const [name, contract] of Object.entries(inSource)) contracts.push({ source, name, ...contract });
  }
  const find = (fqn) => contracts.find(({ source, name }) => `${source}:${name}` === fqn);
  const parsed = new Map();
  return {
    contracts,
    find,
    parsedLayout(fqn) {
      if (!parsed.has(fqn)) {
        parsed.set(
          fqn,
          core.parseStorageLayout(find(fqn).storageLayout, {
            contractName: fqn,
            userDefinedValueTypes,
            declaringContracts,
            constantAndImmutableNames: core.extractConstantAndImmutableNames(output.sources[fqn.split(':')[0]].ast),
          })
        );
      }
      return parsed.get(fqn);
    },
  };
}

// Processes and RPC

/** A local Anvil on a free port; `stop` ends it and waits for that. */
export async function startAnvil(historyArgs = ANVIL_NO_PERSISTED_STATES) {
  const port = await freePort();
  const node = await startProcess(
    'anvil',
    ['--port', String(port), '--silent', ...historyArgs],
    `http://127.0.0.1:${port}`
  );
  if (node === undefined) throw new Error('anvil did not start');
  return node;
}

const cast = (...args) =>
  new Promise((resolve, reject) => {
    execFile('cast', args, { cwd: ROOT, maxBuffer: 1 << 24 }, (error, stdout, stderr) =>
      error === null ? resolve(stdout.trim()) : reject(new Error(`cast ${args.join(' ')}: ${stderr || error.message}`))
    );
  });

async function inPool(items, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
      while (next < items.length) {
        const at = next;
        next += 1;
        results[at] = await work(items[at], at);
      }
    })
  );
  return results;
}

// The oracle

const pad32 = (value) => `0x${value.toString(16).padStart(64, '0')}`;

/** One array's data slot or one key's slot serves many reads, and each `cast` is a process. */
const derivedSlots = new Map();
function derivedSlot(...args) {
  const id = args.join(' ');
  if (!derivedSlots.has(id)) derivedSlots.set(id, cast(...args).then(BigInt));
  return derivedSlots.get(id);
}

/** A key's type for `cast index`. */
function abiTypeOf(label) {
  if (label.startsWith('enum ')) return 'uint8';
  if (label.startsWith('contract ')) return 'address';
  return USER_TYPES[label] ?? label;
}

/**
 * Where a path lives, by Solidity's storage rules applied to Forge's layout. `shift` is the
 * deliberately wrong slot that shows the comparison can fail.
 */
export async function oracleLocate(layout, { name, declaredIn, segments }, shift = 0n) {
  const named = layout.storage.filter(({ label }) => label === name);
  if (named.length === 0) throw new Error(`forge's layout has no ${name}`);
  // A base's variables come first in storage, so of two declarations the deployed contract's is last.
  const entry = declaredIn !== undefined && !declaredIn.endsWith('Base') ? named.at(-1) : named[0];
  let slot = BigInt(entry.slot);
  let offset = entry.offset;
  let typeId = entry.type;
  for (const segment of segments) {
    const type = layout.types[typeId];
    if ('key' in segment) {
      const keyType = abiTypeOf(layout.types[type.key].label);
      slot = await derivedSlot('index', keyType, '--', String(segment.key), slot.toString());
      offset = 0;
      typeId = type.value;
    } else if ('index' in segment) {
      const base = type.encoding === 'dynamic_array' ? await derivedSlot('keccak', pad32(slot)) : slot;
      const size = Number(layout.types[type.base].numberOfBytes);
      const position = BigInt(segment.index);
      if (size >= 32) {
        slot = base + position * BigInt(size / 32);
        offset = 0;
      } else {
        const perSlot = BigInt(Math.floor(32 / size));
        slot = base + position / perSlot;
        offset = Number(position % perSlot) * size;
      }
      typeId = type.base;
    } else {
      const member = type.members.find(({ label }) => label === segment.field);
      slot += BigInt(member.slot);
      offset = member.offset;
      typeId = member.type;
    }
  }
  return { slot: slot + shift, offset, type: layout.types[typeId] };
}

/**
 * One word by `cast storage`. The random reads, thousands of them, ask the node directly instead,
 * which AC 18 allows and which costs no process; their slots still come from `cast`.
 */
async function readWord(url, address, slot, block, viaCast) {
  if (!viaCast) {
    const tag = block === undefined ? 'latest' : `0x${block.toString(16)}`;
    return BigInt(await rpc(url, 'eth_getStorageAt', [address, `0x${slot.toString(16)}`, tag]));
  }
  const args = ['storage', address, slot.toString(), '--rpc-url', url];
  return BigInt(await cast(...(block === undefined ? args : [...args, '--block', String(block)])));
}

function leafValue(word, offset, type) {
  const size = Number(type.numberOfBytes);
  const raw = (word >> BigInt(offset * 8)) & ((1n << BigInt(size * 8)) - 1n);
  const label = abiTypeOf(type.label);
  const hex = () => `0x${raw.toString(16).padStart(size * 2, '0')}`;
  if (label === 'bool') return raw !== 0n;
  if (/^uint/.test(label)) return raw.toString();
  if (/^int/.test(label)) return BigInt.asIntN(size * 8, raw).toString();
  if (label === 'address' || /^bytes\d+$/.test(label) || label.startsWith('function')) return hex();
  throw new Error(`the oracle has no rule for ${type.label}`);
}

/** The value at a location, from raw storage words only. */
export async function oracleValue(url, address, { slot, offset, type }, block, viaCast = true) {
  const word = await readWord(url, address, slot, block, viaCast);
  if (type.encoding !== 'bytes') return leafValue(word, offset, type);
  let bytes;
  if ((word & 1n) === 0n) {
    const length = Number((word & 0xffn) / 2n);
    bytes = Buffer.from(word.toString(16).padStart(64, '0'), 'hex').subarray(0, length);
  } else {
    const length = Number((word - 1n) / 2n);
    const data = await derivedSlot('keccak', pad32(slot));
    const words = await Promise.all(
      Array.from({ length: Math.ceil(length / 32) }, (_, at) => readWord(url, address, data + BigInt(at), block, viaCast))
    );
    bytes = Buffer.from(words.map((part) => part.toString(16).padStart(64, '0')).join(''), 'hex').subarray(0, length);
  }
  return type.label === 'string' ? bytes.toString('utf8') : `0x${bytes.toString('hex')}`;
}

// Comparison

const normal = (value) => {
  if (typeof value === 'bigint') return value.toString();
  return typeof value === 'string' && value.startsWith('0x') ? value.toLowerCase() : value;
};

/** Everything two independent answers must agree on. An empty list means they agree. */
export function differences(expected, oracle, decoded) {
  const found = [];
  if (decoded.slot !== oracle.slot) found.push(`slot: decoder ${decoded.slot}, oracle ${oracle.slot}`);
  if (decoded.offset !== oracle.offset) found.push(`offset: decoder ${decoded.offset}, oracle ${oracle.offset}`);
  if (decoded.typeLabel !== oracle.type.label) found.push(`type: decoder ${decoded.typeLabel}, oracle ${oracle.type.label}`);
  if (normal(decoded.value) !== normal(oracle.value)) {
    found.push(`value: decoder ${normal(decoded.value)}, oracle ${normal(oracle.value)}`);
  }
  if (expected !== undefined && normal(expected) !== normal(oracle.value)) {
    found.push(`written ${normal(expected)}, oracle ${normal(oracle.value)}`);
  }
  return found;
}

// The seeded generator

/** mulberry32, which is short enough to read and needs no dependency. */
function makeRandom(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return (mixed ^ (mixed >>> 14)) >>> 0;
  };
  const bits = (count) => {
    let value = 0n;
    for (let done = 0; done < count; done += 32) value = (value << 32n) | BigInt(next());
    return value & ((1n << BigInt(count)) - 1n);
  };
  const hex = (size) => (size === 0 ? '0x' : `0x${bits(size * 8).toString(16).padStart(size * 2, '0')}`);
  const below = (limit) => next() % limit;
  // Multi-byte letters too, because a string key is hashed as its UTF-8 bytes.
  const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789é日本';
  const text = (length) => Array.from({ length }, () => LETTERS[below(LETTERS.length)]).join('');
  return { bits, hex, below, text, signed: (width) => BigInt.asIntN(width, bits(width)), address: () => hex(20) };
}

export const newSeed = () => randomBytes(4).readUInt32BE(0);

const key = (value) => ({ key: value });
const index = (value) => ({ index: value });
const field = (value) => ({ field: value });

/**
 * One family per way a path reaches a slot. `batch` is how many writes run before reading back,
 * and is the domain size where a domain is small: within a batch no write may overwrite another,
 * or the read would see the later one.
 */
function propertyFamilies(random) {
  const pushed = () => {
    let count = 0;
    return () => count++;
  };
  const mapping = (contract, name, fn, makeKey, makeValue = () => random.bits(256), declaredIn) => {
    // Short string and bytes keys repeat, the empty one often, and a repeat overwrites the earlier
    // write before it is read. Enum keys are bigints: they repeat on purpose, one batch apart.
    const used = new Set();
    const freshKey = () => {
      let k = makeKey();
      while (typeof k === 'string' && used.has(k)) k = makeKey();
      used.add(k);
      return k;
    };
    return {
      contract,
      fn,
      make() {
        const k = freshKey();
        const value = makeValue();
        return {
          args: [k, value],
          reads: [{ path: { name, ...(declaredIn === undefined ? {} : { declaredIn }), segments: [key(k)] }, expected: value }],
        };
      },
    };
  };
  const pushing = (contract, name, fn, makeValue) => {
    const position = pushed();
    return {
      contract,
      fn,
      make() {
        const value = makeValue();
        return { args: [value], reads: [{ path: { name, segments: [index(position())] }, expected: value }] };
      },
    };
  };
  const list = (() => {
    const lengths = new Map();
    return {
      contract: 'MockMappings',
      fn: 'pushToList',
      make() {
        const k = BigInt(random.below(8));
        const position = lengths.get(k) ?? 0;
        lengths.set(k, position + 1);
        const value = random.bits(256);
        return { args: [k, value], reads: [{ path: { name: 'lists', segments: [key(k), index(position)] }, expected: value }] };
      },
    };
  })();
  const allOf = (size, positionAt) => {
    let turn = 0;
    return () => positionAt(turn++ % size);
  };
  const fixedNumber = allOf(3, (at) => at);
  const fixedSmall = allOf(5, (at) => at);
  const matrixCell = allOf(6, (at) => [Math.floor(at / 2), at % 2]);
  const status = allOf(3, (at) => BigInt(at));
  const rowsPushed = pushed();
  const pointsPushed = pushed();

  return {
    'mapping, address key': mapping('MockMappings', 'byAddress', 'setByAddress', random.address),
    'mapping, uint key': mapping('MockMappings', 'byUint', 'setByUint', () => random.bits(256)),
    'mapping, narrow signed key': mapping('MockMappings', 'byInt', 'setByInt', () => random.signed(64)),
    'mapping, bytes32 key': mapping('MockMappings', 'byBytes32', 'setByBytes32', () => random.hex(32)),
    'mapping, string key': mapping('MockMappings', 'byString', 'setByString', () => random.text(random.below(70))),
    'mapping, bytes key': mapping('MockMappings', 'byBytes', 'setByBytes', () => random.hex(random.below(70))),
    'mapping, bytes32-backed user type key': mapping('MockUserTypes', 'byId', 'setById', () => random.hex(32)),
    'mapping, int128-backed user type key': mapping('MockUserTypes', 'bySigned', 'setBySigned', () => random.signed(128)),
    'mapping, uint96-backed user type key': mapping('MockUserTypes', 'byAmount', 'setByAmount', () => random.bits(96)),
    'mapping, enum key': {
      batch: 3,
      ...mapping('MockEnums', 'countByStatus', 'setCountByStatus', status),
    },
    'mapping in a base, shadowed name': mapping('MockShadowed', 'table', 'setBaseTable', () => random.bits(256), undefined, 'MockShadowedBase'),
    'mapping in a derived contract, shadowed name': mapping('MockShadowed', 'table', 'setDerivedTable', () => random.bits(256), undefined, 'MockShadowed'),
    'two-level mapping': {
      contract: 'MockMappings',
      fn: 'setNested',
      make() {
        const [outer, inner, value] = [random.address(), random.bits(256), random.bits(256)];
        return { args: [outer, inner, value], reads: [{ path: { name: 'nested', segments: [key(outer), key(inner)] }, expected: value }] };
      },
    },
    'three-level mapping, string in the middle': {
      contract: 'MockMappings',
      fn: 'setDeep',
      make() {
        const [outer, middle, inner] = [random.address(), random.text(1 + random.below(40)), random.bits(256)];
        const value = random.below(2) === 0;
        return { args: [outer, middle, inner, value], reads: [{ path: { name: 'deep', segments: [key(outer), key(middle), key(inner)] }, expected: value }] };
      },
    },
    'mapping to a dynamic array': list,
    'dynamic array, full-slot elements': pushing('MockArrays', 'numbers', 'pushNumber', () => random.bits(256)),
    'dynamic array, packed elements': pushing('MockArrays', 'smallNumbers', 'pushSmallNumber', () => random.bits(8)),
    'dynamic array, enum elements': pushing('MockEnums', 'history', 'pushHistory', () => BigInt(random.below(3))),
    'fixed array, full-slot elements': {
      contract: 'MockArrays',
      fn: 'setFixedNumber',
      batch: 3,
      make() {
        const [at, value] = [fixedNumber(), random.bits(256)];
        return { args: [BigInt(at), value], reads: [{ path: { name: 'fixedNumbers', segments: [index(at)] }, expected: value }] };
      },
    },
    'fixed array, packed elements': {
      contract: 'MockArrays',
      fn: 'setFixedSmall',
      batch: 5,
      make() {
        const [at, value] = [fixedSmall(), random.bits(16)];
        return { args: [BigInt(at), value], reads: [{ path: { name: 'fixedSmall', segments: [index(at)] }, expected: value }] };
      },
    },
    'fixed array of fixed arrays': {
      contract: 'MockArrays',
      fn: 'setMatrix',
      batch: 6,
      make() {
        const [[row, column], value] = [matrixCell(), random.bits(256)];
        return {
          args: [BigInt(row), BigInt(column), value],
          reads: [{ path: { name: 'matrix', segments: [index(row), index(column)] }, expected: value }],
        };
      },
    },
    'dynamic array of dynamic arrays': {
      contract: 'MockArrays',
      fn: 'pushRow',
      make() {
        const row = Array.from({ length: 1 + random.below(4) }, () => random.bits(256));
        const column = random.below(row.length);
        return { args: [row], reads: [{ path: { name: 'rows', segments: [index(rowsPushed()), index(column)] }, expected: row[column] }] };
      },
    },
    'dynamic array of packed structs': {
      contract: 'MockStructs',
      fn: 'pushPoint',
      make() {
        const [x, y, at] = [random.bits(128), random.signed(128), pointsPushed()];
        return {
          args: [[x, y]],
          reads: [
            { path: { name: 'points', segments: [index(at), field('x')] }, expected: x },
            { path: { name: 'points', segments: [index(at), field('y')] }, expected: y },
          ],
        };
      },
    },
    'struct in a mapping, string field of any length': {
      contract: 'MockStructs',
      fn: 'setPositionsEntry',
      make() {
        const [k, id, label] = [random.address(), random.bits(256), random.text(random.below(100))];
        return {
          args: [k, id, label],
          reads: [
            { path: { name: 'positions', segments: [key(k), field('id')] }, expected: id },
            { path: { name: 'positions', segments: [key(k), field('label')] }, expected: label },
          ],
        };
      },
    },
    'recursive struct': {
      contract: 'MockStructs',
      fn: 'setGrandchildValue',
      make() {
        const [first, second, value] = [random.bits(64), random.bits(64), random.bits(256)];
        return {
          args: [first, second, value],
          reads: [
            {
              path: { name: 'root', segments: [field('children'), key(first), field('children'), key(second), field('value')] },
              expected: value,
            },
          ],
        };
      },
    },
  };
}

// The suite

function signatureOf(abi, name) {
  const render = ({ type, components }) =>
    type.startsWith('tuple') ? `(${components.map(render).join(',')})${type.slice(5)}` : type;
  const entry = abi.find((item) => item.type === 'function' && item.name === name);
  return { signature: `${name}(${entry.inputs.map(render).join(',')})`, inputs: entry.inputs };
}

/**
 * ABI encoding of what the mocks' setters take. It only writes test data: if it were wrong, the
 * written value and the oracle's would differ, so it needs no authority, and it saves a process
 * per transaction.
 */
function abiEncode(inputs, values) {
  const isDynamic = ({ type }) => type === 'string' || type === 'bytes' || type.endsWith('[]');
  const word = (value) => BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, '0');
  const tail = (input, value) => {
    if (input.type === 'string' || input.type === 'bytes') {
      const bytes = input.type === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value.slice(2), 'hex');
      return word(bytes.length) + bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64, '0');
    }
    const element = { ...input, type: input.type.slice(0, -2) };
    return word(value.length) + abiEncode(value.map(() => element), value);
  };
  const inline = (input, value) => {
    if (input.type.startsWith('tuple')) return abiEncode(input.components, value);
    if (input.type === 'bool') return word(value ? 1 : 0);
    if (input.type.startsWith('bytes')) return value.slice(2).toLowerCase().padEnd(64, '0');
    return word(value);
  };
  let offset = inputs.length * 32;
  let tails = '';
  let heads = '';
  inputs.forEach((input, at) => {
    if (isDynamic(input)) {
      heads += word(offset);
      const encoded = tail(input, values[at]);
      tails += encoded;
      offset += encoded.length / 2;
    } else {
      heads += inline(input, values[at]);
    }
  });
  return heads + tails;
}

/** A decoder talking plain JSON-RPC. The random reads leave out the address check, which they do not test. */
export function makeDecoder(core, compiled, url, { addressCheck = true } = {}) {
  const check = {
    getDeployedBytecode: async (fqn) => {
      const { object, immutableReferences, linkReferences } = compiled.find(fqn).evm.deployedBytecode;
      return { object: `0x${object}`, immutableReferences, linkReferences };
    },
    getCode: (address, blockTag) => rpc(url, 'eth_getCode', [address, core.formatBlockTag(blockTag)]),
  };
  return core.createStorageDecoder({
    getLayout: async (fqn) => compiled.parsedLayout(fqn),
    getStorageAt: async ({ address, slot, blockTag }) =>
      core.hexToBytes(await rpc(url, 'eth_getStorageAt', [address, core.formatSlot(slot), core.formatBlockTag(blockTag)])),
    getBlockNumber: async () => BigInt(await rpc(url, 'eth_blockNumber')),
    ...(addressCheck ? check : {}),
  });
}

const fqnOf = (contract) => `mocks/${contract}.sol:${contract}`;
const showPath = (path) => JSON.stringify(path, (_, value) => (typeof value === 'bigint' ? value.toString() : value));

/**
 * Seed every mock, seal it, and compare each planned value; then random keys and indices on fresh
 * deployments, written by real transactions. Every read is compared three ways: what was written,
 * what the oracle finds at its own slot, and what the decoder returns. The node's account sends
 * everything, unless `makeSender` turns that account into another sender.
 */
export async function runValueSuite({ url, tools, perFamily, seed, shift = 0n, makeSender }) {
  const { core, plan, compiled } = tools;
  const [account] = await rpc(url, 'eth_accounts');
  if (account === undefined) throw Object.assign(new Error('the node holds no account to send from'), { unusable: true });
  const { from, send } =
    makeSender === undefined ? { from: account, send: (fields) => sendFromNode(url, account, fields) } : await makeSender(account);

  const layouts = new Map();
  const layoutOf = (contract) => {
    if (!layouts.has(contract)) layouts.set(contract, forgeLayout(`mocks/${contract}.sol`, contract));
    return layouts.get(contract);
  };
  const decoder = makeDecoder(core, compiled, url);
  const fastDecoder = makeDecoder(core, compiled, url, { addressCheck: false });
  const artifactOf = (contract) => compiled.find(fqnOf(contract));

  let firstDeploymentBlock;
  const deploy = async (contract, args = []) => {
    const constructor = artifactOf(contract).abi.find(({ type }) => type === 'constructor');
    const encoded = args.length === 0 ? '' : abiEncode(constructor.inputs, args);
    const receipt = await send({ data: `0x${artifactOf(contract).evm.bytecode.object}${encoded}` });
    firstDeploymentBlock ??= Number(receipt.blockNumber);
    return receipt.contractAddress;
  };
  const selectors = new Map();
  const calldata = async (contract, fn, args) => {
    const { signature, inputs } = signatureOf(artifactOf(contract).abi, fn);
    if (!selectors.has(signature)) selectors.set(signature, await cast('sig', signature));
    return `${selectors.get(signature)}${abiEncode(inputs, args)}`;
  };

  const mismatches = [];
  const check = async (contract, address, { path, expected, block }, viaCast = true) => {
    const oracle = await oracleLocate(layoutOf(contract), path, shift);
    oracle.value = await oracleValue(url, address, oracle, block, viaCast);
    let query = tools.manifest.applyPath((viaCast ? decoder : fastDecoder).contract(fqnOf(contract)).target(address), path);
    if (block !== undefined) query = query.at(block);
    const decoded = await query.read();
    const found = differences(expected, oracle, decoded);
    if (found.length > 0) {
      mismatches.push({ name: `${contract}${block === undefined ? '' : `@${block}`}`, path: showPath(path), found });
    }
    return { oracle, decoded };
  };

  // The planned seed, sealed.
  const addresses = {};
  const reads = [];
  const history = [];
  const seenNames = new Map();
  const parse = tools.manifest.parseEntryName;
  for (const step of [...plan.seedSteps(), ...plan.sealSteps()]) {
    const entries = Object.entries(step.sets);
    if (step.fn === undefined) {
      addresses[step.contract] = await deploy(step.contract, step.args);
      reads.push({ contract: step.contract, path: { name: 'owner', segments: [] }, expected: from });
    } else {
      const receipt = await send({ to: addresses[step.contract], data: await calldata(step.contract, step.fn, step.args) });
      if (step.recordsRevision === true) {
        history.push({ contract: step.contract, path: { name: 'revision', segments: [] }, expected: String(step.args[0]), block: Number(receipt.blockNumber) });
      }
    }
    for (const [entry, expected] of entries) {
      reads.push({ contract: step.contract, path: parse(entry), expected });
    }
    for (const [entry, kind] of Object.entries(step.dynamic ?? {})) {
      reads.push({ contract: step.contract, path: parse(entry), dynamic: kind });
    }
  }
  // The latest write of each entry is the one a sealed contract holds.
  const latest = new Map(reads.map((read) => [`${read.contract}|${showPath(read.path)}`, read]));
  const selector = await cast('sig', 'seal()');
  const planned = [...latest.values()];
  await inPool(planned, async (read) => {
    if (read.dynamic === 'callback') {
      read.expected = `${addresses[read.contract].toLowerCase()}${selector.slice(2)}`;
    }
    const { oracle, decoded } = await check(read.contract, addresses[read.contract], read);
    // `op` holds a code position, which depends on the build: only agreement can be asked of it.
    if (read.dynamic === 'op' && shift === 0n && BigInt(oracle.value) === 0n) {
      mismatches.push({ name: `${read.contract}.op`, found: [`build-dependent value is zero: decoder ${decoded.value}`] });
    }
    if (!seenNames.has(read.contract)) seenNames.set(read.contract, new Set());
    seenNames.get(read.contract).add(read.path.name);
  });
  await inPool(history, (read) => check(read.contract, addresses[read.contract], read));

  // Before the contract existed, the address check has to say so, and no client may make it a value.
  let beforeDeployment = 'a read at block 0, before the deployment, succeeded';
  try {
    await decoder.contract(fqnOf('MockValueTypes')).target(addresses.MockValueTypes).name('revision').at(0).read();
  } catch (error) {
    beforeDeployment = error.name;
  }

  // Every declared variable must have been checked, or the table above says less than it seems to.
  const unchecked = Object.keys(addresses).flatMap((contract) =>
    layoutOf(contract)
      .storage.filter(({ label }) => !seenNames.get(contract)?.has(label))
      .map(({ label }) => `${contract}.${label}`)
  );
  console.log(`planned values: ${planned.length} entries, ${history.length} at recorded blocks, on ${Object.keys(addresses).length} sealed mocks`);

  // Random keys and indices.
  const random = makeRandom(seed);
  const fresh = {};
  const freshAddress = async (contract) => {
    if (fresh[contract] === undefined) fresh[contract] = await deploy(contract, plan.seedSteps().find(({ id }) => id === `deploy:${contract}`).args);
    return fresh[contract];
  };
  const counts = {};
  for (const [family, { contract, fn, make, batch }] of Object.entries(propertyFamilies(random))) {
    const address = await freshAddress(contract);
    const group = batch ?? perFamily;
    counts[family] = 0;
    for (let done = 0; done < perFamily; done += group) {
      const writes = Array.from({ length: Math.min(group, perFamily - done) }, () => make());
      for (const { args } of writes) await send({ to: address, data: await calldata(contract, fn, args) });
      const toRead = writes.flatMap(({ reads: of }) => of);
      await inPool(toRead, (read) => check(contract, address, read, false));
      counts[family] += writes.length;
    }
    console.log(`  ${family}: ${counts[family]} writes`);
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  console.log(`random keys and indices: seed 0x${seed.toString(16).padStart(8, '0')}, ${Object.keys(counts).length} families, ${total} writes, at least ${Math.min(...Object.values(counts))} per family`);

  return { mismatches, unchecked, beforeDeployment, families: counts, addresses, decoder, from, send, firstDeploymentBlock };
}
