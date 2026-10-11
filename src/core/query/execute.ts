/**
 * Running a storage query: the step between the builder and the pure slot/decoding code.
 *
 * {@link readOne} turns a builder's {@link QueryState} into RPC calls: it loads the layout,
 * checks the contract against the address, derives the slot with `deriveSlot`, reads the
 * array lengths and the value concurrently, and decodes through {@link readLeaf}. It also
 * fixes the order in which failures are reported, whatever order the calls settle in.
 *
 * {@link CallScope} holds what the queries of one `read()`, `readMany()` or `readAll()` call
 * share: memoised layouts, contract checks and array-length reads, and one concurrency limit.
 * `readAll()` (see `dump.ts`) builds on the same scope and on {@link readLeaf}.
 */

import type { ParsedStorageLayout } from '../layout/parseStorageLayout.js';
import type { BlockTag, SingleSlotReader } from '../rpc/getStorageAt.js';
import { awaitObligationsInOrder, decode, resolveReadPlan } from '../slots/decode.js';
import { type PathSegment, type TerminalDescriptor, deriveSlot } from '../slots/deriveSlot.js';
import { ContractMismatchError } from './errors.js';
import type { StorageDecoderContext, StorageReadResult } from './StorageQueryBuilder.js';

/** What a builder has accumulated. Everything but the path and block is optional until read. */
export interface QueryState {
  /** The contract whose layout is used, as `path/File.sol:Name`. Set by `.contract()`. */
  readonly fullyQualifiedName?: string;
  /** The address whose storage is read. Set by `.target()`. */
  readonly address?: string;
  /** The top-level storage variable the path starts at. Set by `.name()`. */
  readonly variableName?: string;
  /**
   * The contract that declares the variable, for a name the layout holds more than once. Set
   * by `.name(variable, { declaredIn })`; `undefined` when the name alone is to be looked up.
   */
  readonly declaredIn?: string;
  /** Mapping keys, array indices and struct fields applied after the variable, in order. */
  readonly segments: readonly PathSegment[];
  /** The block every RPC call of the query is sent with. */
  readonly blockTag: BlockTag;
}

/** Most storage reads one call keeps in flight at a time, across every query in it. */
const MAX_CONCURRENT_READS = 256;

/** A rejection handler that does nothing; what {@link handled} attaches. */
const ignoreRejection = (): void => {};

/**
 * Mark a promise as handled without consuming it.
 *
 * Reads are issued before it is known whether their result will be wanted (a contract
 * mismatch or an outer out-of-bounds index takes precedence). A read that is then never
 * awaited must not surface as an unhandled rejection.
 *
 * @param promise - The promise to mark.
 * @returns The same promise, not a copy: awaiting it still rejects with the original error.
 */
function handled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(ignoreRejection);
  return promise;
}

/**
 * Run `fn` so that a synchronous throw becomes a rejection, like any other failure.
 *
 * @param fn - The function to call; typically a caller-supplied context function.
 * @returns A promise for `fn`'s result, rejected with whatever `fn` throws or rejects with.
 */
async function invoke<T>(fn: () => T | Promise<T>): Promise<T> {
  return fn();
}

/**
 * A counting semaphore: at most `permits` functions passed to {@link Semaphore.run} are
 * running at any moment. Callers beyond that wait in arrival order.
 */
class Semaphore {
  /** Permits not currently held. Never negative; stays 0 while anyone is waiting. */
  #available: number;
  /** Wake-up callbacks of the callers waiting for a permit, oldest first. */
  readonly #waiting: (() => void)[] = [];

  /**
   * @param permits - How many functions may run at once.
   */
  constructor(permits: number) {
    this.#available = permits;
  }

  /**
   * Run `fn` once a permit is free, and release the permit when it settles either way.
   *
   * @param fn - The work to run under a permit. It is not called until a permit is held.
   * @returns `fn`'s result; rejects with whatever `fn` rejects with.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#available > 0) {
      this.#available -= 1;
    } else {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const next = this.#waiting.shift();
      // Hand the permit straight to the next waiter rather than returning it to the pool.
      if (next === undefined) this.#available += 1;
      else next();
    }
  }
}

/** What a {@link CallScope} remembers for one decoder context. Rejections are kept as well. */
interface ContextMemo {
  /** Layout lookups in progress or settled, by fully-qualified contract name. */
  readonly layouts: Map<string, Promise<ParsedStorageLayout>>;
  /** Contract/address checks, by {@link memoKey} of contract name, address and block tag. */
  readonly codeChecks: Map<string, Promise<void>>;
  /** Array-length slot reads, by {@link memoKey} of address, block tag and slot. */
  readonly lengths: Map<string, Promise<Uint8Array>>;
}

/**
 * A memo key that cannot collide: the parts are JSON-encoded as a list rather than joined
 * with a separator they might themselves contain. Does not throw for any primitive part.
 *
 * @param parts - The values that together identify the memoised work. Each is rendered with
 *   its `typeof`, so `1`, `1n` and `"1"` give different keys.
 * @returns The key.
 */
function memoKey(...parts: readonly unknown[]): string {
  return JSON.stringify(parts.map((part) => `${typeof part}:${String(part)}`));
}

/**
 * Work shared by every query inside ONE `read()`, `readMany()` or `readAll()` call.
 *
 * Nothing here outlives the call: in particular a contract/address match is never remembered
 * between calls, because the code at an address can change under the same block tag.
 *
 * @remarks
 * Sharing a scope does not make the queries in it a snapshot. Each query is sent with its own
 * block tag, and under a moving tag such as `"latest"` the reads of one `readMany()` can land
 * on different blocks. One consistent block needs a block number as the tag.
 */
export class CallScope {
  /** Memoised work, per decoder context, so queries from different decoders never share. */
  readonly #memos = new Map<StorageDecoderContext, ContextMemo>();
  /** Limits the storage reads in flight across every reader this scope hands out. */
  readonly #semaphore = new Semaphore(MAX_CONCURRENT_READS);
  /** Set by {@link CallScope.abort}; checked each time a read is about to be sent. */
  #aborted = false;

  /**
   * Stop issuing storage reads. Reads already sent are unaffected; reads still queued behind
   * the semaphore are rejected instead of being sent once the call has already failed.
   * Layout lookups and contract checks are not affected.
   */
  abort(): void {
    this.#aborted = true;
  }

  /** The memo for one decoder context (compared by identity), created on first use. */
  #memo(context: StorageDecoderContext): ContextMemo {
    let memo = this.#memos.get(context);
    if (memo === undefined) {
      memo = { layouts: new Map(), codeChecks: new Map(), lengths: new Map() };
      this.#memos.set(context, memo);
    }
    return memo;
  }

  /**
   * The parsed layout of a contract, looked up once per contract name in this call. A failed
   * lookup is memoised too, so every query naming that contract fails with the same error.
   *
   * @param context - The decoder context whose `getLayout` is called.
   * @param fullyQualifiedName - The contract, as `path/File.sol:Name`.
   * @returns The layout; rejects with whatever `getLayout` throws or rejects with, normally
   *   `ContractNotFoundError`.
   */
  layout(context: StorageDecoderContext, fullyQualifiedName: string): Promise<ParsedStorageLayout> {
    const { layouts } = this.#memo(context);
    let pending = layouts.get(fullyQualifiedName);
    if (pending === undefined) {
      pending = handled(invoke(() => context.getLayout(fullyQualifiedName)));
      layouts.set(fullyQualifiedName, pending);
    }
    return pending;
  }

  /**
   * The contract/address sanity check, run once per contract, address and block. The address
   * is compared case-insensitively; the block tag by type and value, so `1` and `1n` are
   * checked separately.
   *
   * The promise resolves when the check passes or cannot be made. A failed check is memoised
   * too, so every query against that contract, address and block fails with the same error.
   *
   * @param context - The decoder context whose `getCode` and `getDeployedBytecode` are used.
   * @param fullyQualifiedName - The contract the layout belongs to.
   * @param address - The address about to be read.
   * @param blockTag - The block the code is fetched at.
   * @throws {ContractMismatchError} as a rejection, when the code at the address does not
   *   look like the contract.
   * @throws Whatever the two context functions throw or reject with, as a rejection.
   */
  codeCheck(
    context: StorageDecoderContext,
    fullyQualifiedName: string,
    address: string,
    blockTag: BlockTag
  ): Promise<void> {
    const { codeChecks } = this.#memo(context);
    const key = memoKey(fullyQualifiedName, String(address).toLowerCase(), blockTag);
    let pending = codeChecks.get(key);
    if (pending === undefined) {
      pending = handled(assertContractMatchesTarget(context, fullyQualifiedName, address, blockTag));
      codeChecks.set(key, pending);
    }
    return pending;
  }

  /**
   * A slot reader bound to one address and one block tag, limited by this call's semaphore.
   *
   * Each read waits for a permit, then is sent unless the scope has been aborted in the
   * meantime. Nothing is memoised here: asking twice for a slot sends two reads.
   *
   * @param context - The decoder context whose `getStorageAt` is called.
   * @param address - The address every read goes to.
   * @param blockTag - The block every read is sent with.
   * @returns The bound reader. Its promise rejects with a plain `Error` ("storage read
   *   cancelled") when the scope was aborted before the read was sent, and otherwise with
   *   whatever `getStorageAt` throws or rejects with.
   */
  reader(context: StorageDecoderContext, address: string, blockTag: BlockTag): SingleSlotReader {
    return (slot) =>
      this.#semaphore.run(() =>
        invoke(() => {
          if (this.#aborted) throw new Error('storage read cancelled: the call already failed');
          return context.getStorageAt({ address, slot, blockTag });
        })
      );
  }

  /**
   * An array-length read, shared by every query in the call that indexes the same array.
   * Value reads are deliberately not shared this way.
   *
   * @param context - The decoder context the query belongs to; selects the memo.
   * @param address - The address being read; part of the key, compared case-insensitively.
   * @param blockTag - The block being read; part of the key.
   * @param slot - The array's length slot.
   * @param read - The reader to send the read with. Used only the first time this address,
   *   block and slot are asked for; later calls get the first call's promise.
   * @returns The raw word at the slot; rejects with whatever `read` rejects with.
   */
  length(
    context: StorageDecoderContext,
    address: string,
    blockTag: BlockTag,
    slot: bigint,
    read: SingleSlotReader
  ): Promise<Uint8Array> {
    const { lengths } = this.#memo(context);
    const key = memoKey(String(address).toLowerCase(), blockTag, slot);
    let pending = lengths.get(key);
    if (pending === undefined) {
      pending = handled(read(slot));
      lengths.set(key, pending);
    }
    return pending;
  }
}

/**
 * The three things every query needs before it can be run, checked in a fixed order:
 * contract, then address, then variable name. Only the first one missing is reported.
 *
 * @param state - What the builder accumulated.
 * @param method - The builder method being run; named in the error message.
 * @returns A new object with the same values, all three guaranteed present; `declaredIn`
 *   stays optional and is carried over unchanged.
 * @throws {TypeError} when `.contract()`, `.target()` or `.name()` was never called.
 */
export function requireComplete(
  state: QueryState,
  method: 'read' | 'readAll' = 'read'
): Required<Omit<QueryState, 'declaredIn'>> & Pick<QueryState, 'declaredIn'> {
  const { fullyQualifiedName, address, variableName, declaredIn, segments, blockTag } = state;
  if (fullyQualifiedName === undefined) {
    throw new TypeError(
      `a storage query needs .contract("path/File.sol:Name") before .${method}()`
    );
  }
  if (address === undefined) {
    throw new TypeError(`a storage query needs .target(address) before .${method}()`);
  }
  if (variableName === undefined) {
    throw new TypeError(`a storage query needs .name("variable") before .${method}()`);
  }
  return { fullyQualifiedName, address, variableName, declaredIn, segments, blockTag };
}

/**
 * Guard against decoding one contract's layout against another contract's address.
 *
 * What is compared, when the check is skipped and how a proxy address fares are described on
 * {@link ContractMismatchError}. When only the artifact's bytecode is missing or empty,
 * `getCode` has already been called, and a failure of it is still reported.
 *
 * @param context - Supplies `getCode` and `getDeployedBytecode`, both optional.
 * @param fullyQualifiedName - The contract whose artifact is the expected side.
 * @param address - The address whose code is the actual side.
 * @param blockTag - The block the code is fetched at.
 * @throws {ContractMismatchError} when there is no code at the address, the code length
 *   differs from the artifact's, or the first 32 bytes differ.
 * @throws Whatever `getDeployedBytecode` or `getCode` throws or rejects with; if both fail,
 *   the artifact's error is the one reported.
 */
async function assertContractMatchesTarget(
  context: StorageDecoderContext,
  fullyQualifiedName: string,
  address: string,
  blockTag: BlockTag
): Promise<void> {
  const { getCode, getDeployedBytecode } = context;
  if (getCode === undefined || getDeployedBytecode === undefined) return;

  // Both sides are fetched together, but awaited artifact-first: a failure to load the
  // artifact is reported in preference to a failure of the RPC call.
  const expectedPending = invoke(() => getDeployedBytecode(fullyQualifiedName));
  const actualPending = handled(invoke(() => getCode(address, blockTag)));
  const expected = normalizeCode(await expectedPending);
  const actual = normalizeCode(await actualPending);
  if (expected === undefined || expected.length === 0) return;

  if (actual === undefined || actual.length === 0) {
    throw new ContractMismatchError(
      fullyQualifiedName,
      address,
      'there is no contract code at that address'
    );
  }
  if (actual.length !== expected.length) {
    throw new ContractMismatchError(
      fullyQualifiedName,
      address,
      `the deployed code is ${actual.length / 2} bytes but the artifact's deployedBytecode is` +
        ` ${expected.length / 2} bytes`
    );
  }
  const prefixLength = Math.min(64, expected.length);
  if (actual.slice(0, prefixLength) !== expected.slice(0, prefixLength)) {
    throw new ContractMismatchError(
      fullyQualifiedName,
      address,
      "the deployed code's first 32 bytes differ from the artifact's deployedBytecode"
    );
  }
}

/**
 * Bring bytecode from either side into one comparable form: no `0x`/`0X` prefix, lower case.
 * Two hex characters of the result are one byte.
 *
 * @param code - Hex bytecode, with or without a prefix. `null` is tolerated at run time
 *   although the type does not allow it, because the value comes from an adapter.
 * @returns The bare lower-case hex, or `undefined` when there was no value.
 */
function normalizeCode(code: string | undefined): string | undefined {
  if (code === undefined || code === null) return undefined;
  const body = code.startsWith('0x') || code.startsWith('0X') ? code.slice(2) : code;
  return body.toLowerCase();
}

/**
 * Read and decode one terminal position.
 *
 * `firstRead` is the terminal's own slot (the value, or a `string`/`bytes` header) when the
 * caller has already issued it. `beforeData` is awaited before any further slot is read: the
 * data slots of a long `string`/`bytes` are located by a length taken from the header, so
 * they are never fetched until whatever makes that header trustworthy has passed.
 *
 * @remarks
 * A long `string`/`bytes` has all of its data-slot reads created at once. Nothing here
 * limits their number: it is bounded only by the 16 MiB length cap in `resolveReadPlan`, and
 * the number in flight by the concurrency limit of the reader passed in. `maxElements`
 * applies to `readAll()` alone, which counts the data slots itself before calling this.
 *
 * @param read - Reader bound to the address and block; used for every slot but a supplied
 *   `firstRead`.
 * @param terminal - Read plan and decoding details of the position, from `deriveSlot` or
 *   `terminalPlan`.
 * @param firstRead - An already-issued read of the terminal's own slot. When given it is used
 *   for the first slot that is requested, in place of a new read.
 * @param beforeData - A promise every read after the first waits for. If it rejects, that
 *   rejection is what the call fails with.
 * @returns The decoded value with its slot, byte offset, raw slot word and type label; the
 *   caller adds the block tag.
 * @throws {RangeError} Whatever {@link resolveReadPlan} throws: a `string`/`bytes` header it
 *   refuses, or a slot read that resolves to a word longer than 32 bytes.
 * @throws {UnsupportedTypeError} Whatever {@link decode} throws: the value is a user-defined
 *   value type whose underlying type is unknown.
 * @throws Whatever `read`, `firstRead` or `beforeData` rejects with.
 * @remarks A function-typed value comes back as the `0x` hex of its raw bytes.
 */
export async function readLeaf(
  read: SingleSlotReader,
  terminal: TerminalDescriptor,
  firstRead?: Promise<Uint8Array>,
  beforeData?: Promise<unknown>
): Promise<Omit<StorageReadResult, 'blockTag'>> {
  // `resolveReadPlan` always requests the terminal's own slot first, so "first call"
  // identifies it without comparing slot numbers.
  let isFirst = true;
  /** `read`, with the first call served by `firstRead` and later ones held for `beforeData`. */
  const gated: SingleSlotReader = async (slot) => {
    if (isFirst) {
      isFirst = false;
      return firstRead ?? read(slot);
    }
    if (beforeData !== undefined) await beforeData;
    return read(slot);
  };

  const resolved = await resolveReadPlan(terminal.readPlan, gated);
  return {
    value: decode(
      resolved.slotValues,
      terminal.offset,
      terminal.numberOfBytes,
      terminal.valueKind,
      resolved.dynamic
    ),
    slot: resolved.slot,
    offset: terminal.offset,
    rawSlotValue: resolved.rawSlotValue,
    typeLabel: terminal.typeLabel,
  };
}

/**
 * Run one query.
 *
 * Every RPC call the path needs up front goes out together: the contract check, each array
 * length, and the value itself. What a caller observes is still decided in a fixed order —
 * layout errors, a contract mismatch, path errors, the outermost out-of-bounds index, then
 * the value — so a read issued early can waste a call but can never change the answer.
 *
 * @remarks
 * How that order is enforced:
 *  1. An incomplete builder is rejected before any I/O.
 *  2. The layout is awaited alone. If it fails, nothing else is sent.
 *  3. The contract check is started, then the slot is derived synchronously. If derivation
 *     throws, the check is awaited first, so a mismatch (or a failure of the check itself)
 *     is reported in place of the path error.
 *  4. The array-length reads and the read of the value's own slot are sent together.
 *  5. The check is awaited, then each length in path order. The first out-of-bounds index
 *     from the outside in is reported; reads further in are not even looked at.
 *  6. Only then is the value's slot awaited and, for a long `string`/`bytes`, its data slots
 *     read.
 *
 * @param context - Layout source and RPC functions of the decoder the builder belongs to.
 * @param state - What the builder accumulated.
 * @param scope - The scope of the enclosing call; supplies the memos and the read limit.
 * @returns The decoded value with its slot, offset, raw slot word, type label and block tag.
 * @throws The errors listed on `StorageQueryBuilder.read`, which this function runs for; it
 *   raises none of its own. They come, in the order above, from {@link requireComplete},
 *   `context.getLayout`, {@link CallScope.codeCheck}, {@link deriveSlot},
 *   {@link awaitObligationsInOrder} and {@link readLeaf} (a `RangeError` for a refused
 *   `string`/`bytes` header or a word longer than 32 bytes among them), and from the context's
 *   own functions.
 */
export async function readOne(
  context: StorageDecoderContext,
  state: QueryState,
  scope: CallScope
): Promise<StorageReadResult> {
  const { fullyQualifiedName, address, variableName, declaredIn, segments, blockTag } =
    requireComplete(state);

  const layout = await scope.layout(context, fullyQualifiedName);
  const codeCheck = scope.codeCheck(context, fullyQualifiedName, address, blockTag);

  let derived;
  try {
    derived = deriveSlot(layout, variableName, segments, { declaredIn });
  } catch (error) {
    await codeCheck;
    throw error;
  }

  const read = scope.reader(context, address, blockTag);
  const lengthReads = derived.obligations.map((obligation) =>
    scope.length(context, address, blockTag, obligation.lengthSlot, read)
  );
  const { readPlan } = derived;
  const firstRead = handled(read(readPlan.kind === 'single' ? readPlan.slot : readPlan.headerSlot));

  const verified = handled(
    (async () => {
      await codeCheck;
      await awaitObligationsInOrder(derived.obligations, lengthReads);
    })()
  );
  await verified;

  const leaf = await readLeaf(read, derived, firstRead, verified);
  return { ...leaf, blockTag };
}
