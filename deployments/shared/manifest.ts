/**
 * The deployment manifest: its schema, its atomic writes, and the pre-broadcast record that makes
 * an interrupted seed resumable. It has no dependency beyond Node, so both Hardhat projects can
 * import it.
 *
 * `deployments/manifest/deployments.json` holds public data only, and `check-manifest-public.mjs`
 * allows known fields only. Local-chain data and the pending record, which holds a signed
 * transaction, go to the ignored `deployments/manifest/local/`.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const LOCAL_CHAIN_ID = 31337;

/** `latest`, or the block a historic value was recorded at. */
export type BlockTag = 'latest' | number;
export type ManifestValue = string | boolean;

export interface ObservedValue {
  value: ManifestValue;
  block: number;
  endpointLabel: string;
}

export interface ExpectedEntry {
  value: ManifestValue;
  blockTag: BlockTag;
  /** True for a value at a past block, which a pruned node can no longer serve. */
  requiresArchive: boolean;
  /** AC 3 evidence: what the same endpoint returned for this block at seed time. */
  observed?: ObservedValue;
  /** The value holds a code position, so it is right only for the build that deployed it. */
  buildDependent?: boolean;
}

export interface ContractRecord {
  address: string;
  deployBlock: number;
  txHash: string;
  sealBlock: number | null;
  sealTxHash: string | null;
  /** Keyed by `formatEntryName`, with `@<block>` added for a historic entry. */
  expected: Record<string, ExpectedEntry>;
}

export interface StepRecord {
  id: string;
  nonce: number;
  txHash: string;
  /** The first signed hash, present only when a replacement is what got mined. */
  signedTxHash?: string;
  block: number;
  /** For a step whose block is evidence: `seal.ts` refuses if this block has since changed. */
  blockHash?: string;
}

export interface Generation {
  deployer: string;
  repoCommit: string;
  sourceHash: string;
  solcSettings: SolcSettings;
  steps: StepRecord[];
  contracts: Record<string, ContractRecord>;
}

export interface SolcSettings {
  version: string;
  optimizer: unknown;
  evmVersion: unknown;
}

export interface Manifest {
  schemaVersion: 1;
  chains: Record<string, { generations: Generation[] }>;
}

/** One signed transaction for a step. A replacement adds a second one at the same nonce. */
export interface PendingAttempt {
  hash: string;
  raw: string;
}

export interface PendingRecord {
  chainId: number;
  deployer: string;
  stepId: string;
  nonce: number;
  /** The CREATE address, for a deployment. */
  predictedAddress?: string;
  attempts: PendingAttempt[];
}

const emptyManifest = (): Manifest => ({ schemaVersion: 1, chains: {} });

// Entry names

export type PathSegment = { key: string | bigint } | { index: number } | { field: string };

export interface EntryPath {
  name: string;
  declaredIn?: string;
  segments: PathSegment[];
}

/**
 * An entry's name in the manifest, and the path to read it: `Base::name{n:1}{s:text}[2].field`.
 * Both scanners refuse a 64-hex word in a name, since a name could hold a key, and also one split
 * up to hide it. A bytes32 mapping key is the one exception they allow, under `expected` and only
 * as `{w:0x<64 hex>}`, so that is how it is written.
 */
const WORD = /^0x[0-9a-fA-F]{64}$/;
/** The scanners' own pattern, from `check-manifest-public.mjs`. */
const HEX_WORD = /(?<![0-9a-zA-Z])(?:0[xX])?[0-9a-fA-F]{64}(?![0-9a-zA-Z])/;

export function formatEntryName({ name, declaredIn, segments }: EntryPath): string {
  let text = declaredIn === undefined ? name : `${declaredIn}::${name}`;
  for (const segment of segments) {
    if ('key' in segment) {
      if (typeof segment.key === 'bigint') {
        text += `{n:${segment.key}}`;
      } else {
        if (/[{}]/.test(segment.key)) throw new Error(`mapping key holds a brace: ${segment.key}`);
        text += WORD.test(segment.key) ? `{w:${segment.key}}` : `{s:${segment.key}}`;
      }
    } else if ('index' in segment) {
      text += `[${segment.index}]`;
    } else {
      text += `.${segment.field}`;
    }
  }
  // Any other spelling of the word, such as an unprefixed string key, would fail both scanners.
  if (HEX_WORD.test(text.replace(/\{w:0x[0-9a-fA-F]{64}\}/g, ''))) {
    throw new Error('an entry name would hold a 64-hex word');
  }
  return text;
}

/** Applies an entry's path to a query already bound to its contract and address. */
export function applyPath(query: any, { name, declaredIn, segments }: EntryPath): any {
  let built = query.name(name, declaredIn === undefined ? undefined : { declaredIn });
  for (const segment of segments) {
    if ('key' in segment) built = built.key(segment.key);
    else if ('index' in segment) built = built.index(segment.index);
    else built = built.field(segment.field);
  }
  return built;
}

export function parseEntryName(text: string): EntryPath & { block?: number } {
  const match = /^(?:(\w+)::)?(\w+)((?:\{[nsw]:[^{}]*\}|\[\d+\]|\.\w+)*)(?:@(\d+))?$/.exec(text);
  if (match === null) throw new Error(`not a manifest entry name: ${text}`);
  const [, declaredIn, name, rest, block] = match;
  const segments: PathSegment[] = [];
  for (const [part] of (rest as string).matchAll(/\{[nsw]:[^{}]*\}|\[\d+\]|\.\w+/g)) {
    if (part.startsWith('{n:')) segments.push({ key: BigInt(part.slice(3, -1)) });
    else if (part.startsWith('{s:') || part.startsWith('{w:')) segments.push({ key: part.slice(3, -1) });
    else if (part.startsWith('[')) segments.push({ index: Number(part.slice(1, -1)) });
    else segments.push({ field: part.slice(1) });
  }
  return {
    name: name as string,
    segments,
    ...(declaredIn === undefined ? {} : { declaredIn }),
    ...(block === undefined ? {} : { block: Number(block) }),
  };
}

/** Bigints as strings, since JSON has none. */
export function toManifestValue(value: unknown): ManifestValue {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  throw new Error(`a manifest value must be a leaf, but got ${typeof value}`);
}

// Atomic writes

const RENAME_RETRIES = 20;
const RENAME_RETRY_MS = 100;
const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Temp file plus rename, so a reader sees the old file or the new one and never part of one.
 * Renames retry, because on Windows a scanner can briefly hold either file. `midWrite` runs with
 * half the bytes on disk.
 */
export function atomicWriteJson(path: string, value: unknown, midWrite?: () => void): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const temp = `${path}.tmp-${process.pid}`;
  const half = Math.floor(text.length / 2);

  const fd = openSync(temp, 'w');
  try {
    writeSync(fd, text, 0, half);
    fsyncSync(fd);
    midWrite?.();
    writeSync(fd, text, half, text.length - half);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temp, path);
      return;
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (!RETRYABLE_RENAME.has(code ?? '') || attempt >= RENAME_RETRIES) throw error;
      sleepSync(RENAME_RETRY_MS);
    }
  }
}

/** Remove the temp file a killed writer left beside `path`. */
export function removeOrphanTemps(path: string): void {
  const prefix = `${basename(path)}.tmp-`;
  let names: string[];
  try {
    names = readdirSync(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    if (name.startsWith(prefix)) rmSync(join(dirname(path), name), { force: true });
  }
}

function readJsonOrUndefined<T>(path: string): T | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(text) as T;
}

export function readManifest(path: string): Manifest {
  return readJsonOrUndefined<Manifest>(path) ?? emptyManifest();
}

export function readPending(path: string): PendingRecord | undefined {
  return readJsonOrUndefined<PendingRecord>(path);
}

export function clearPending(path: string): void {
  rmSync(path, { force: true });
}

// Binding

function sourceFiles(directory: string): Array<[string, Buffer]> {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sol'))
    .sort()
    .map((name) => [name, readFileSync(join(directory, name))]);
}

/**
 * A hash of the sources and compiler settings, which binds a resume or a seal to the reviewed
 * code rather than to a commit. SHA-512, because the manifest's secret scan flags any bare 64-hex
 * value outside its allowed fields.
 */
export function sourceHash(directory: string, settings: SolcSettings): string {
  const hash = createHash('sha512');
  for (const [name, content] of sourceFiles(directory)) {
    hash.update(name).update('\0').update(content).update('\0');
  }
  hash.update(JSON.stringify([settings.version, settings.optimizer, settings.evmVersion]));
  return hash.digest('hex');
}

/** Whether two folders hold the same sources: the project compiles a copy of the tracked mocks. */
export function sameSources(first: string, second: string): boolean {
  const a = sourceFiles(first);
  const b = sourceFiles(second);
  return (
    a.length === b.length &&
    a.every(([name, content], i) => name === b[i]?.[0] && content.equals(b[i]?.[1] as Buffer))
  );
}
