/**
 * `readAll()`: dump everything reachable from one storage position.
 *
 * {@link readAllAt} walks the type graph from the position a builder points at, expanding
 * arrays and structs to any depth and mappings at the keys the caller supplies through
 * {@link ReadAllOptions.keys}. It reuses the single-read pipeline: positions are stepped with
 * `stepSegment`, leaves are read and decoded with `readLeaf`, and the layout lookup, the
 * contract/address check and the concurrency limit come from one {@link CallScope}.
 *
 * What it adds on top is the key-pattern grammar, the `maxElements` budget, pinning a
 * `"latest"` dump to one block, and the length re-check for tags that cannot be pinned.
 */

import {
  type ParsedStorageLayout,
  type TypeInfo,
  getTypeInfo,
  getVariable,
} from '../layout/parseStorageLayout.js';
import { type BlockTag, type SingleSlotReader, isHexQuantity } from '../rpc/getStorageAt.js';
import {
  type DecodedValue,
  awaitObligationsInOrder,
  dynamicBytesLength,
} from '../slots/decode.js';
import {
  type BoundsObligation,
  type MappingKeyValue,
  type PathPosition,
  type PathSegment,
  assertNoSegmentsPastTerminal,
  isTerminalType,
  stepSegment,
  terminalPlan,
} from '../slots/deriveSlot.js';
import { WORD_SIZE, bytesToBigInt, toStorageWord } from '../util/bytes.js';
import { DumpInconsistentError, DumpTooLargeError, UnsupportedTypeError } from './errors.js';
import { CallScope, type QueryState, readLeaf, requireComplete } from './execute.js';
import type { StorageDecoderContext } from './StorageQueryBuilder.js';

/** Options of `readAll()`. Both are optional; an omitted options object behaves like `{}`. */
export interface ReadAllOptions {
  /**
   * Keys to read for mappings met during the dump, by path pattern relative to the position
   * `readAll()` is called on. A mapping's keys are not stored on chain, so a mapping with no
   * entry here comes back as an empty `Map` and is listed in `skipped`.
   *
   * Pattern steps: a struct field by name (`.name` after the first step), `[]` for any
   * element of an array, `{}` for any value of a mapping; `""` is the root itself.
   */
  readonly keys?: Readonly<Record<string, readonly MappingKeyValue[]>>;
  /**
   * Cap on any array length, any supplied key list, and the total the dump expands: every
   * array element, struct field and mapping entry, plus every data slot of a long
   * `string`/`bytes`. Default 10000. Must be a non-negative integer.
   */
  readonly maxElements?: number;
}

/**
 * A dumped value. One of:
 *  - a decoded leaf (a value type, `string` or `bytes`);
 *  - an array of dumped values, for a fixed or dynamic array;
 *  - a struct: a prototype-less object keyed by field name;
 *  - a mapping: a `Map` keyed by the supplied key values themselves, unmodified, in the order
 *    they were first supplied. A key supplied twice is expanded twice and counted twice toward
 *    `maxElements` but appears once, because `Map` collapses equal keys. `Uint8Array` keys are
 *    compared by identity, so two distinct arrays with equal bytes stay separate entries. A
 *    mapping with no supplied keys is an empty `Map`.
 */
export type DumpValue =
  | DecodedValue
  | DumpValue[]
  | { [field: string]: DumpValue }
  | Map<MappingKeyValue, DumpValue>;

/** What `readAll()` resolves to. */
export interface StorageDumpResult {
  /** The dumped value at the position `readAll()` was called on. */
  readonly value: DumpValue;
  /** Patterns of mappings read with no keys; each can be used as a key of `options.keys`. */
  readonly skipped: readonly string[];
  /** Solidity type label of the dumped position, e.g. `struct Vault.Item[]`. */
  readonly typeLabel: string;
  /**
   * The block tag every read was sent with. For `"latest"` this is the block number the dump
   * was pinned to, but only when the context supplies `getBlockNumber`; without it, and for
   * every other tag, it is the caller's tag unchanged.
   */
  readonly blockTag: BlockTag;
}

/** `maxElements` when the caller gives none. */
const DEFAULT_MAX_ELEMENTS = 10_000;

/**
 * One step of a parsed key pattern:
 *  - `field`: a struct field, by name;
 *  - `array`: `[]`, any element of a fixed or dynamic array;
 *  - `mapping`: `{}`, any value of a mapping.
 */
type PatternStep =
  | { readonly kind: 'field'; readonly name: string }
  | { readonly kind: 'array' }
  | { readonly kind: 'mapping' };

/**
 * Matches a Solidity identifier at the start of a string: a letter, `_` or `$`, then letters,
 * digits, `_` or `$`. Not anchored at the end, so it takes the longest field name a pattern
 * starts with and leaves the rest for the next step.
 */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/;

/**
 * Parse a key pattern into its steps. The empty string is the root and parses to no steps.
 *
 * @param pattern - A key of {@link ReadAllOptions.keys}, e.g. `items[].owners`.
 * @returns The steps, in order.
 * @throws {TypeError} when the pattern does not follow the grammar: a field name with a
 *   leading dot at the start, without one anywhere else, or anything that is not a field
 *   name, `[]` or `{}`.
 */
function parsePattern(pattern: string): PatternStep[] {
  const steps: PatternStep[] = [];
  let at = 0;
  while (at < pattern.length) {
    if (pattern.startsWith('[]', at)) {
      steps.push({ kind: 'array' });
      at += 2;
      continue;
    }
    if (pattern.startsWith('{}', at)) {
      steps.push({ kind: 'mapping' });
      at += 2;
      continue;
    }
    // A field is written bare as the first step and with a leading dot anywhere else.
    const dotted = pattern[at] === '.';
    if (dotted === (at === 0)) throw invalidPattern(pattern);
    const name = IDENTIFIER_RE.exec(pattern.slice(dotted ? at + 1 : at))?.[0];
    if (name === undefined) throw invalidPattern(pattern);
    steps.push({ kind: 'field', name });
    at += name.length + (dotted ? 1 : 0);
  }
  return steps;
}

/**
 * Build the error for a pattern that does not parse. It is returned, not thrown, so the call
 * sites can `throw` it and keep control-flow narrowing.
 *
 * @param pattern - The whole offending pattern, quoted in the message.
 * @returns A `TypeError` that restates the grammar.
 */
function invalidPattern(pattern: string): TypeError {
  return new TypeError(
    `readAll: "${pattern}" is not a valid key pattern. Use struct field names joined with ".",` +
      ` "[]" for any array element and "{}" for any mapping value, e.g. "items[].owners"`
  );
}

/** Append a struct field to a pattern or concrete path: bare when it is `""`, else after a dot. */
function appendField(path: string, name: string): string {
  return path === '' ? name : `${path}.${name}`;
}

/**
 * Render steps back into the canonical pattern string. Parsing then formatting a valid
 * pattern returns it unchanged; the result is the key used to look keys up during the walk.
 *
 * @param steps - Parsed steps, possibly none.
 * @returns The canonical pattern; `""` for no steps.
 */
function formatPattern(steps: readonly PatternStep[]): string {
  let out = '';
  for (const step of steps) {
    if (step.kind === 'field') out = appendField(out, step.name);
    else out += step.kind === 'array' ? '[]' : '{}';
  }
  return out;
}

/** {@link ReadAllOptions} after validation, in the form the walk uses. */
interface DumpArguments {
  /** The effective limit: the caller's `maxElements`, or {@link DEFAULT_MAX_ELEMENTS}. */
  readonly maxElements: number;
  /** Canonical pattern -> supplied keys. */
  readonly keys: ReadonlyMap<string, readonly MappingKeyValue[]>;
  /** Every supplied pattern, parsed, in the order the caller's object lists them. */
  readonly patterns: readonly (readonly PatternStep[])[];
}

/**
 * Everything about the arguments that can be checked without a layout or any I/O.
 *
 * @param options - The caller's options; `{}` when none were given.
 * @returns The validated limit, the key lists by canonical pattern, and the parsed patterns.
 * @throws {TypeError} when `options` or `options.keys` is not an object, `maxElements` is not
 *   a non-negative integer, a key list is not an array, or a pattern does not parse.
 */
function parseArguments(options: ReadAllOptions): DumpArguments {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('readAll: options must be an object when given');
  }
  const maxElements = options.maxElements ?? DEFAULT_MAX_ELEMENTS;
  if (!Number.isInteger(maxElements) || maxElements < 0) {
    throw new TypeError(
      `readAll: "maxElements" must be a non-negative integer, got ${String(maxElements)}`
    );
  }
  const keys = new Map<string, readonly MappingKeyValue[]>();
  const patterns: PatternStep[][] = [];
  const supplied = options.keys ?? {};
  if (supplied === null || typeof supplied !== 'object') {
    throw new TypeError('readAll: "keys" must be an object mapping a path pattern to a key list');
  }
  for (const [pattern, list] of Object.entries(supplied)) {
    if (!Array.isArray(list)) {
      throw new TypeError(`readAll: the keys for "${pattern}" must be an array`);
    }
    const steps = parsePattern(pattern);
    patterns.push(steps);
    keys.set(formatPattern(steps), list);
  }
  return { maxElements, keys, patterns };
}

/**
 * Check each supplied pattern against the type graph, following only the pattern's own steps.
 * It never enumerates the types reachable from the root, so recursive structs terminate.
 *
 * @param layout - The parsed layout the type ids resolve in.
 * @param rootTypeId - Type of the position being dumped; patterns are relative to it.
 * @param args - The validated arguments from {@link parseArguments}.
 * @throws {TypeError} when a pattern step does not fit the type it is applied to (including
 *   an unknown field name), a pattern enters a mapping's values (`{}`) without keys supplied
 *   for that mapping, or a pattern ends on something that is not a mapping.
 * @throws {DumpTooLargeError} with limit `keys` when a key list is longer than `maxElements`.
 * @throws {UnsupportedTypeError} when a type id on the way is missing from the layout.
 */
function validatePatterns(
  layout: ParsedStorageLayout,
  rootTypeId: string,
  args: DumpArguments
): void {
  for (const steps of args.patterns) {
    const pattern = formatPattern(steps);
    let type = getTypeInfo(layout, rootTypeId);
    for (const [i, step] of steps.entries()) {
      let nextTypeId: string | undefined;
      if (step.kind === 'field' && type.kind === 'struct') {
        nextTypeId = type.members?.find((member) => member.label === step.name)?.typeId;
      } else if (
        step.kind === 'array' &&
        (type.kind === 'dynamicArray' || type.kind === 'fixedArray')
      ) {
        nextTypeId = type.baseTypeId;
      } else if (step.kind === 'mapping' && type.kind === 'mapping') {
        // Entering a mapping's values is only possible through keys supplied for it.
        const parent = formatPattern(steps.slice(0, i));
        if (!args.keys.has(parent)) {
          throw new TypeError(
            `readAll: keys were given for "${pattern}", but none for its parent mapping` +
              ` "${parent}", so no entry of it would ever be read`
          );
        }
        nextTypeId = type.valueTypeId;
      }
      if (nextTypeId === undefined) {
        throw new TypeError(
          `readAll: key pattern "${pattern}" does not match the storage type: at` +
            ` "${formatPattern(steps.slice(0, i))}" the type is "${type.label}"`
        );
      }
      type = getTypeInfo(layout, nextTypeId);
    }
    if (type.kind !== 'mapping') {
      throw new TypeError(
        `readAll: key pattern "${pattern}" leads to "${type.label}", which is not a mapping`
      );
    }
    const list = args.keys.get(pattern) as readonly MappingKeyValue[];
    if (list.length > args.maxElements) {
      throw new DumpTooLargeError(
        'keys',
        BigInt(list.length),
        args.maxElements,
        pattern === '' ? '(root)' : pattern
      );
    }
  }
}

/**
 * A tag that always names the same block. Anything unrecognised is assumed to move.
 *
 * @param blockTag - The tag the reads are sent with.
 * @returns `true` for a block number (`number` or `bigint`), `"earliest"`, or a `0x` hex
 *   string; `false` for `"latest"`, `"pending"`, `"safe"`, `"finalized"` and any other string.
 */
function isFixedBlockTag(blockTag: BlockTag): boolean {
  return (
    typeof blockTag === 'number' ||
    typeof blockTag === 'bigint' ||
    blockTag === 'earliest' ||
    isHexQuantity(blockTag)
  );
}

/** A length the dump relied on, kept so it can be compared again afterwards. */
interface Witness {
  /** Concrete path of the array or string, e.g. `items[3].tags`; named in the error. */
  readonly path: string;
  /** The slot the length was read from: an array's length slot or a `string`/`bytes` header. */
  readonly slot: bigint;
  /** The length the dump saw: an element count for `array`, a byte length for `bytes`. */
  readonly length: bigint;
  /**
   * How to turn the slot's word back into a length: `array` reads the whole word as the
   * element count, `bytes` decodes it as a `string`/`bytes` header.
   */
  readonly kind: 'array' | 'bytes';
}

/**
 * Dump everything reachable from one position: arrays and structs to any depth, and mapping
 * entries for the keys the caller supplies.
 *
 * @remarks
 * Order of work, which is also the order failures are reported in:
 *  1. The builder state and the options are validated, with no I/O.
 *  2. The layout is loaded.
 *  3. The block is settled: `"latest"` becomes a block number when the context supplies
 *     `getBlockNumber`; every other tag is used as given.
 *  4. The contract/address check is awaited.
 *  5. The path is stepped to the root position and the key patterns are checked against the
 *     root's type. No storage slot has been read up to here.
 *  6. The lengths of dynamic arrays the path indexes are read and checked, outermost first.
 *  7. The root is expanded. Sibling branches (struct fields, array elements, mapping entries)
 *     run concurrently, limited by the scope's semaphore.
 *  8. If the tag can move, every length relied on is read once more and compared.
 *
 * Limits and the cancellation of unsent reads are described on {@link DumpTooLargeError}; a
 * `string`/`bytes` header, like a dynamic array's length slot, is necessarily read before the
 * limit it feeds can be checked. Reads under a tag that can move are described on
 * {@link DumpInconsistentError}: step 8 is a check, not a snapshot.
 *
 * @param context - Layout source and RPC functions of the decoder the builder belongs to.
 * @param state - What the builder accumulated; must name a contract, an address and a variable.
 * @param options - The caller's options, or `undefined` for the defaults.
 * @returns The dumped value, the patterns of mappings left empty for lack of keys, the root's
 *   type label and the block tag the reads were sent with.
 * @throws {DumpTooLargeError} when a key list (`keys`), one array's length (`array`) or the
 *   running total (`total`) exceeds `maxElements`.
 * @throws {DumpInconsistentError} when the tag can move and an array or string length differs
 *   between the dump and the re-check.
 * @throws {UnsupportedTypeError} when a fixed array has no parsed length. Its other causes
 *   come from the functions named below.
 * @throws {RangeError} when the context returns a word longer than 32 bytes for a length slot
 *   or a `string`/`bytes` header. A header `resolveReadPlan` refuses comes through
 *   {@link readLeaf}; its 16 MiB cap is only reached when `maxElements` is large enough to
 *   let such a value through.
 * @throws Everything else listed on `StorageQueryBuilder.readAll`, which this function runs
 *   for. Those errors come, in the order above, from {@link requireComplete},
 *   `parseArguments`, `context.getLayout`, {@link CallScope.codeCheck}, `getVariable`,
 *   `getTypeInfo`, `stepSegment`, `terminalPlan`, `assertNoSegmentsPastTerminal`,
 *   `validatePatterns`,
 *   {@link awaitObligationsInOrder} and {@link readLeaf}, and from the context's own
 *   functions (a failed RPC call, for example).
 */
export async function readAllAt(
  context: StorageDecoderContext,
  state: QueryState,
  options: ReadAllOptions | undefined
): Promise<StorageDumpResult> {
  const { fullyQualifiedName, address, variableName, declaredIn, segments, blockTag } =
    requireComplete(state, 'readAll');
  const args = parseArguments(options === undefined ? {} : options);

  const scope = new CallScope();
  const layout = await scope.layout(context, fullyQualifiedName);

  // The block is settled before anything is read, so the contract check and every storage
  // read land on the same one. Only "latest" can be pinned: eth_blockNumber says nothing
  // about "safe", "finalized" or "pending".
  let effectiveTag = blockTag;
  if (blockTag === 'latest' && context.getBlockNumber !== undefined) {
    effectiveTag = await context.getBlockNumber();
  }

  // Awaited before any length is acted on: against the wrong contract every length is garbage.
  await scope.codeCheck(context, fullyQualifiedName, address, effectiveTag);

  const variable = getVariable(layout, variableName, { declaredIn });
  let root: PathPosition = { slot: variable.slot, offset: variable.offset, typeId: variable.typeId };
  const rootObligations: BoundsObligation[] = [];
  const rootObligationPaths: string[] = [];
  // Concrete paths in errors are written from the variable down, e.g. `items[3].tags`.
  let rootPath = variableName;
  for (const [i, segment] of segments.entries()) {
    const type = getTypeInfo(layout, root.typeId);
    if (isTerminalType(type)) assertNoSegmentsPastTerminal(type, variableName, i, segments.length);
    const step = stepSegment(layout, root, segment, { variableName, segmentIndex: i });
    if (step.obligation !== undefined) {
      rootObligations.push(step.obligation);
      rootObligationPaths.push(rootPath);
    }
    root = step.position;
    rootPath = describeStep(rootPath, segment);
  }
  validatePatterns(layout, root.typeId, args);

  const read = scope.reader(context, address, effectiveTag);
  const cache = new Map<bigint, Promise<Uint8Array>>();
  /**
   * `read`, memoised by slot for the length of this dump. Packed leaves share a slot, and a
   * slot is read once however many leaves live in it. A rejected read stays cached, so every
   * leaf in that slot fails the same way.
   */
  const cachedRead: SingleSlotReader = (slot) => {
    let pending = cache.get(slot);
    if (pending === undefined) {
      pending = read(slot);
      // Marked handled: once a sibling branch has failed the dump, nobody awaits this one.
      pending.catch(() => {});
      cache.set(slot, pending);
    }
    return pending;
  };

  // Filled as lengths are read, by the path below and by concurrent branches of the walk; the
  // order is irrelevant, each entry is re-checked on its own.
  const witnesses: Witness[] = [];
  if (rootObligations.length > 0) {
    const lengthReads = rootObligations.map((obligation) => cachedRead(obligation.lengthSlot));
    await awaitObligationsInOrder(rootObligations, lengthReads);
    for (const [i, obligation] of rootObligations.entries()) {
      witnesses.push({
        path: rootObligationPaths[i] as string,
        slot: obligation.lengthSlot,
        length: bytesToBigInt(toStorageWord(await (lengthReads[i] as Promise<Uint8Array>))),
        kind: 'array',
      });
    }
  }

  // A set: one keyless mapping pattern is met once per array element or mapping entry above it.
  const skipped = new Set<string>();
  // Running total of children counted so far, shared by every branch of the walk.
  let expanded = 0;
  /**
   * Add a node's children to the running total, before any of them is expanded.
   *
   * Synchronous, so the add and the check cannot interleave with another branch. A throw
   * here stops this node's children from being read; it does not recall reads that
   * concurrent branches have already sent.
   *
   * @param count - Number of children about to be expanded (or data slots of a long string).
   * @param path - Concrete path of the node, named in the error.
   * @throws {DumpTooLargeError} with limit `total` when the total passes `maxElements`.
   */
  const countChildren = (count: number, path: string): void => {
    expanded += count;
    if (expanded > args.maxElements) {
      throw new DumpTooLargeError('total', BigInt(expanded), args.maxElements, path);
    }
  };

  /**
   * Dump one position, recursing into its children concurrently.
   *
   * @param position - Slot, byte offset and type of the position.
   * @param pattern - Its pattern relative to the root (`items[].owners`); looks up mapping keys.
   * @param path - Its concrete path from the variable (`vault.items[3].owners`); for errors.
   * @param depth - Number of path segments from the variable to this position; reported as
   *   the segment index if stepping to a child fails.
   * @returns The dumped value for this position.
   * @throws {DumpTooLargeError} with limit `total` when one long `string`/`bytes` has more
   *   data slots than `maxElements`.
   * @throws {RangeError} when the context returns a word longer than 32 bytes for a
   *   `string`/`bytes` header.
   * @throws Whatever `getTypeInfo`, `stepSegment`, `terminalPlan`, `countChildren`,
   *   `arrayLength` and {@link readLeaf} throw.
   */
  async function expand(
    position: PathPosition,
    pattern: string,
    path: string,
    depth: number
  ): Promise<DumpValue> {
    const type = getTypeInfo(layout, position.typeId);
    const where = { variableName, segmentIndex: depth };
    /** Position of one child. Pure slot arithmetic: no read, and no bounds obligation kept. */
    const child = (segment: PathSegment): PathPosition =>
      stepSegment(layout, position, segment, where).position;

    switch (type.kind) {
      case 'value':
        return (await readLeaf(cachedRead, terminalPlan(layout, position))).value;

      case 'dynamicBytes': {
        // The header is looked at first: a long value's data slots are located by a length
        // the node supplies, and each of them counts toward the limit before any is fetched.
        const header = toStorageWord(await cachedRead(position.slot));
        const length = dynamicBytesLength(header);
        // A long form below 32 bytes is malformed: `resolveReadPlan` in `slots/decode.ts`
        // enforces the 32-byte minimum and this branch mirrors it, leaving such a header
        // uncounted so that `readLeaf` refuses it instead of this reporting a size problem.
        if (isLongForm(header) && length >= BigInt(WORD_SIZE)) {
          const dataSlots = (length + BigInt(WORD_SIZE - 1)) / BigInt(WORD_SIZE);
          if (dataSlots > BigInt(args.maxElements)) {
            throw new DumpTooLargeError(
              'total',
              BigInt(expanded) + dataSlots,
              args.maxElements,
              path
            );
          }
          countChildren(Number(dataSlots), path);
          witnesses.push({ path, slot: position.slot, length, kind: 'bytes' });
        }
        return (await readLeaf(cachedRead, terminalPlan(layout, position))).value;
      }

      case 'struct': {
        const members = type.members ?? [];
        countChildren(members.length, path);
        // Every child position is derived before any child is expanded (here and below): a
        // step that throws must not leave already-started siblings running with no one
        // awaiting them.
        const positions = members.map((member) => child({ kind: 'field', name: member.label }));
        const values = await Promise.all(
          members.map((member, i) =>
            expand(
              positions[i] as PathPosition,
              appendField(pattern, member.label),
              appendField(path, member.label),
              depth + 1
            )
          )
        );
        // No prototype: `__proto__` and `constructor` are legal Solidity field names.
        const out: { [field: string]: DumpValue } = Object.create(null);
        members.forEach((member, i) => {
          out[member.label] = values[i] as DumpValue;
        });
        return out;
      }

      case 'fixedArray':
      case 'dynamicArray': {
        const length = await arrayLength(type, position, path);
        countChildren(length, path);
        const positions = Array.from({ length }, (_unused, i) => child({ kind: 'index', value: i }));
        return Promise.all(
          positions.map((element, i) => expand(element, `${pattern}[]`, `${path}[${i}]`, depth + 1))
        );
      }

      case 'mapping': {
        const out = new Map<MappingKeyValue, DumpValue>();
        const keys = args.keys.get(pattern);
        if (keys === undefined) {
          skipped.add(pattern);
          return out;
        }
        countChildren(keys.length, path);
        const positions = keys.map((key) => child({ kind: 'key', value: key }));
        const values = await Promise.all(
          keys.map((key, i) =>
            expand(
              positions[i] as PathPosition,
              `${pattern}{}`,
              `${path}{${describeKey(key)}}`,
              depth + 1
            )
          )
        );
        keys.forEach((key, i) => out.set(key, values[i] as DumpValue));
        return out;
      }
    }
  }

  /**
   * Element count of an array, checked against `maxElements` on its own before it is added to
   * the running total. A fixed array's length comes from the layout. A dynamic array's is read
   * from its slot, so that one read has happened by the time the limit is checked, and the
   * length is recorded as a witness.
   *
   * @param type - The array's type; `fixedArray` or `dynamicArray`.
   * @param position - The array's position; its slot holds a dynamic array's length.
   * @param path - Concrete path of the array, for the witness and the error.
   * @returns The length as a number, at most `maxElements`.
   * @throws {UnsupportedTypeError} when a fixed array has no parsed length.
   * @throws {DumpTooLargeError} with limit `array` when the length exceeds `maxElements`.
   */
  async function arrayLength(type: TypeInfo, position: PathPosition, path: string): Promise<number> {
    let length: bigint;
    if (type.kind === 'fixedArray') {
      if (type.fixedLength === undefined) {
        throw new UnsupportedTypeError(
          type.label,
          type.id,
          type.oversized ?? 'fixed array has no parsed length'
        );
      }
      length = BigInt(type.fixedLength);
    } else {
      length = bytesToBigInt(toStorageWord(await cachedRead(position.slot)));
      witnesses.push({ path, slot: position.slot, length, kind: 'array' });
    }
    if (length > BigInt(args.maxElements)) {
      throw new DumpTooLargeError('array', length, args.maxElements, path);
    }
    return Number(length);
  }

  let value: DumpValue;
  try {
    value = await expand(root, '', rootPath, segments.length);
  } catch (error) {
    // Sibling branches may still be running: this rejects every read they have not yet sent;
    // those already sent complete unobserved.
    scope.abort();
    throw error;
  }

  // Step 8: under a tag that can move, every length relied on must read the same again.
  if (!isFixedBlockTag(effectiveTag)) {
    const again = await Promise.all(witnesses.map((witness) => read(witness.slot)));
    for (const [i, witness] of witnesses.entries()) {
      const word = toStorageWord(again[i] as Uint8Array);
      const now = witness.kind === 'array' ? bytesToBigInt(word) : dynamicBytesLength(word);
      if (now !== witness.length) {
        throw new DumpInconsistentError(witness.path, witness.length, now);
      }
    }
  }

  return {
    value,
    skipped: [...skipped],
    typeLabel: getTypeInfo(layout, root.typeId).label,
    blockTag: effectiveTag,
  };
}

/**
 * Whether a `string`/`bytes` header word is in the long form, where the data lives in
 * separate slots. The lowest bit of the last byte is set for long, clear for short.
 *
 * @param header - The 32-byte header word.
 * @returns `true` for the long form.
 */
function isLongForm(header: Uint8Array): boolean {
  return ((header[WORD_SIZE - 1] as number) & 1) === 1;
}

/**
 * Render a mapping key for a concrete path in an error message.
 *
 * @param key - The key as the caller supplied it.
 * @returns `Uint8Array(n)` for a byte array of length `n`, so raw bytes are not printed;
 *   `String(key)` for anything else.
 */
function describeKey(key: MappingKeyValue): string {
  return key instanceof Uint8Array ? `Uint8Array(${key.length})` : String(key);
}

/**
 * Extend a concrete path by one path segment: `.name` for a field, `[i]` for an index,
 * `{key}` for a mapping key.
 *
 * @param path - The path so far, starting at the variable name.
 * @param segment - The segment being stepped through.
 * @returns The extended path.
 */
function describeStep(path: string, segment: PathSegment): string {
  switch (segment.kind) {
    case 'field':
      return appendField(path, segment.name);
    case 'index':
      return `${path}[${segment.value}]`;
    case 'key':
      return `${path}{${describeKey(segment.value)}}`;
  }
}
