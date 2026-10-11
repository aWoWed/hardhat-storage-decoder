/**
 * The public face of the engine: the fluent builder a caller chains to say WHAT to read, and
 * the context interface an adapter implements to say HOW to reach a project and a node.
 *
 * The builder only accumulates an immutable query description. Nothing is validated and no
 * I/O happens until a terminal method runs; that work lives in `execute.ts` (`read()` and its
 * batch forms) and `dump.ts` (`readAll()`), which in turn drive the pure slot derivation in
 * `slots/deriveSlot.ts` and the decoding in `slots/decode.ts`.
 */

import type { ParsedStorageLayout } from '../layout/parseStorageLayout.js';
import type { BlockTag, GetStorageAt } from '../rpc/getStorageAt.js';
import type { DecodedValue } from '../slots/decode.js';
import type { MappingKeyValue, PathSegment } from '../slots/deriveSlot.js';
import { type ReadAllOptions, type StorageDumpResult, readAllAt } from './dump.js';
import { CallScope, type QueryState, readOne } from './execute.js';

/** What one {@link StorageQueryBuilder.read} resolves to: the decoded value and where it was. */
export interface StorageReadResult {
  /**
   * The decoded value: a `bigint` for integers and enums, a `boolean` for `bool`, a
   * checksummed address string for `address` and contract types, a `0x` hex string for
   * `bytesN`, `bytes` and function-typed variables (their raw 24 or 8 bytes), and a JS
   * string for `string`.
   */
  readonly value: DecodedValue;
  /** The slot actually read. For a multi-slot value this is the header/base slot. */
  readonly slot: bigint;
  /** Byte offset of the value within `slot`. Zero for anything that owns a whole slot. */
  readonly offset: number;
  /** Raw bytes of `slot`. For a multi-slot value these are the header slot's bytes. */
  readonly rawSlotValue: Uint8Array;
  /** Solidity label of the type the path ended on, e.g. `uint256`. */
  readonly typeLabel: string;
  /** The block tag the query carried, exactly as given to `.at()`, or `"latest"`. */
  readonly blockTag: BlockTag;
}

/**
 * Everything the builder needs from the outside world. Each Hardhat-major adapter supplies
 * its own implementation; the unit suite supplies an in-memory one.
 *
 * A function here may throw synchronously or reject; either way the failure rejects the
 * terminal method that needed it, unchanged.
 */
export interface StorageDecoderContext {
  /**
   * Resolve a fully-qualified name to a parsed layout, or throw `ContractNotFoundError`.
   *
   * Called once per contract name within one terminal call, however many queries share it.
   *
   * @param fullyQualifiedName - The name passed to `.contract()`, unchanged.
   * @returns The contract's parsed storage layout.
   */
  getLayout(fullyQualifiedName: string): Promise<ParsedStorageLayout>;
  /** Reads one 32-byte storage word. The only way the engine reads storage. */
  getStorageAt: GetStorageAt;
  /**
   * Artifact `deployedBytecode`, when available. Enables the contract/address sanity check.
   *
   * The check runs only when this and `getCode` are both supplied.
   *
   * @param fullyQualifiedName - The name passed to `.contract()`, unchanged.
   * @returns The bytecode as a hex string, with or without a `0x` prefix. `undefined` or an
   *   empty string skips the check for that contract.
   */
  getDeployedBytecode?(fullyQualifiedName: string): Promise<string | undefined>;
  /**
   * On-chain code at an address. Enables the contract/address sanity check.
   *
   * @param address - The address passed to `.target()`, unchanged.
   * @param blockTag - The block the query reads at, so code and storage are compared at the
   *   same block.
   * @returns The code as a hex string; `0x` or an empty string means no code.
   */
  getCode?(address: string, blockTag: BlockTag): Promise<string>;
  /**
   * The latest block number. Lets `readAll()` pin a `"latest"` dump to one block.
   *
   * Only `readAll()` calls it, and only when the query's block tag is `"latest"`. Without
   * it such a dump reads at the moving tag and relies on the after-the-fact length re-check
   * (`DumpInconsistentError`) instead.
   *
   * @returns The block number to pin the dump to.
   */
  getBlockNumber?(): Promise<bigint>;
}

/** State of a freshly created builder: no contract, target or variable, an empty path. */
const INITIAL_STATE: QueryState = { segments: [], blockTag: 'latest' };

/**
 * Fluent, immutable storage query.
 *
 * Every chain method returns a NEW builder, so a partial chain can be reused:
 *
 * ```ts
 * const base = decoder.contract('contracts/Vault.sol:Vault').target(addr);
 * const a = await base.name('balances').key(alice).read();
 * const b = await base.name('balances').key(bob).read();
 * ```
 *
 * The chain methods (`contract`, `target`, `name`, `key`, `keys`, `index`, `field`, `at`)
 * only record their argument: they perform no I/O and never throw. Every check — that the
 * three required parts are present, that the path fits the variable's type, that the address
 * holds the contract — runs in the terminal methods (`read`, `readMany`, `readKeys`,
 * `readIndices`, `readAll`), which report failures by rejecting.
 *
 * @example
 * ```ts
 * // mapping(address => Position[]) positions;  struct Position { uint128 amount; ... }
 * const { value, slot } = await decoder
 *   .contract('contracts/Vault.sol:Vault')
 *   .target(vaultAddress)
 *   .name('positions')
 *   .key(alice)
 *   .index(0)
 *   .field('amount')
 *   .read();
 * ```
 */
export class StorageQueryBuilder {
  /** Where layouts, storage words and code come from. Shared by every builder in a chain. */
  readonly #context: StorageDecoderContext;
  /** The query described so far. Frozen, along with its `segments` array. */
  readonly #state: QueryState;

  /**
   * Prefer {@link createStorageDecoder}, which starts an empty chain.
   *
   * @param context - The adapter's implementation of the outside world.
   * @param state - The query described so far. It is copied and frozen, so later changes to
   *   the object passed in do not reach this builder. Defaults to an empty query at
   *   `"latest"`.
   */
  constructor(context: StorageDecoderContext, state: QueryState = INITIAL_STATE) {
    this.#context = context;
    this.#state = Object.freeze({ ...state, segments: Object.freeze([...state.segments]) });
  }

  /** A new builder on the same context with `patch` applied to the state; this one is untouched. */
  #with(patch: Partial<QueryState>): StorageQueryBuilder {
    return new StorageQueryBuilder(this.#context, { ...this.#state, ...patch });
  }

  /** A new builder whose path has `segment` appended; this one is untouched. */
  #withSegment(segment: PathSegment): StorageQueryBuilder {
    return this.#with({ segments: [...this.#state.segments, segment] });
  }

  /**
   * Fully-qualified contract name, e.g. `"contracts/Vault.sol:Vault"`. Required.
   *
   * @param fullyQualifiedName - `source/path.sol:ContractName`. Its layout decides how the
   *   variable and path are resolved. Not looked up until a terminal method runs.
   * @returns A new builder with the contract set, replacing any earlier one.
   */
  contract(fullyQualifiedName: string): StorageQueryBuilder {
    return this.#with({ fullyQualifiedName });
  }

  /**
   * Address whose storage is read. Required.
   *
   * @param address - The address to read. It is passed to the context unchanged; this class
   *   does not validate or checksum it.
   * @returns A new builder with the address set, replacing any earlier one.
   */
  target(address: string): StorageQueryBuilder {
    return this.#with({ address });
  }

  /**
   * Storage variable name. Required.
   *
   * A name the contract's layout holds more than once — a `private` variable of a base
   * contract declared again in a derived one — is never resolved silently: without
   * `options.declaredIn` the terminal method rejects with `AmbiguousVariableError`, which
   * lists the declaring contracts to choose from.
   *
   * @param variableName - The variable's name exactly as declared (case-sensitive). The path
   *   segments already on the chain are kept, so set it before adding segments for it.
   * @param options - Optional narrowing of the lookup.
   * @param options.declaredIn - The contract that declares the variable. Normally its bare
   *   name (`"Base"`). The full `<source path>:<ContractName>` form is needed only when two
   *   declaring contracts share a bare name; pass it exactly as
   *   `AmbiguousVariableError.declaringContracts` lists it, because the source path is the one
   *   the compiler recorded for the source unit and may carry a prefix that the name given to
   *   `.contract()` does not have. When no variable of that name is declared by it, the
   *   terminal method rejects with `VariableNotFoundError`, which lists the contracts that do
   *   declare the name.
   * @returns A new builder with the variable set, replacing any earlier one together with
   *   any earlier `declaredIn`.
   */
  name(variableName: string, options?: { readonly declaredIn?: string }): StorageQueryBuilder {
    return this.#with({ variableName, declaredIn: options?.declaredIn });
  }

  /**
   * One mapping key. Rejected at `.read()` if the position is not a mapping.
   *
   * @param value - The key. How it is encoded is decided by the mapping's declared key type,
   *   not by its JS type: an integer key accepts a `bigint`, an integer `number` or a numeric
   *   string; an `address` or `bytesN` key a hex string or `Uint8Array`; a `string` key a
   *   string. A value that does not fit the key type rejects the terminal method with a
   *   `TypeError`; so does a `number` beyond `Number.MAX_SAFE_INTEGER`, which JavaScript
   *   may already have rounded — pass such a key as a `bigint`.
   * @returns A new builder with the key appended to the path.
   */
  key(value: MappingKeyValue): StorageQueryBuilder {
    return this.#withSegment({ kind: 'key', value });
  }

  /**
   * Sugar for consecutive `.key()` calls, for nested mappings. Each value becomes its own
   * path segment and is kind-checked on its own.
   *
   * @param values - The keys, outermost mapping first. With none, the path is unchanged.
   * @returns A new builder with one key segment appended per value.
   */
  keys(...values: readonly MappingKeyValue[]): StorageQueryBuilder {
    return values.reduce<StorageQueryBuilder>((builder, value) => builder.key(value), this);
  }

  /**
   * One array index. Rejected at `.read()` if the position is not an array.
   *
   * @param value - Zero-based element index. A negative or fractional value, or one not
   *   below the array's length, rejects the terminal method with `IndexOutOfBoundsError`;
   *   `NaN`, `±Infinity`, a value that is not a number or bigint, or a `number` beyond
   *   `Number.MAX_SAFE_INTEGER` (pass that as a `bigint`) rejects it with a `TypeError`
   *   instead.
   * @returns A new builder with the index appended to the path.
   */
  index(value: number | bigint): StorageQueryBuilder {
    return this.#withSegment({ kind: 'index', value });
  }

  /**
   * One struct field. Rejected at `.read()` if the position is not a struct.
   *
   * @param fieldName - The field's name exactly as declared. An unknown name rejects the
   *   terminal method with `PathSegmentKindMismatchError`, whose message lists the fields.
   * @returns A new builder with the field appended to the path.
   */
  field(fieldName: string): StorageQueryBuilder {
    return this.#withSegment({ kind: 'field', name: fieldName });
  }

  /**
   * Block to read as of. Defaults to `"latest"`.
   *
   * @param blockTag - A block number, or a tag such as `"finalized"`. The contract/address
   *   check and every storage read of the query use this same tag. It is handed to the
   *   context unchanged, except that `readAll()` replaces `"latest"` with a block number
   *   when the context has `getBlockNumber`. A context that renders it with
   *   `formatBlockTag`, as both Hardhat adapters do, rejects the terminal method with a
   *   `TypeError` for a value that is not a string, number or bigint, a negative or
   *   non-integer number, a number beyond `Number.MAX_SAFE_INTEGER` (pass that as a
   *   `bigint`), or a negative bigint; a string is sent as it is.
   * @returns A new builder reading at that block, replacing any earlier `.at()`.
   */
  at(blockTag: BlockTag): StorageQueryBuilder {
    return this.#with({ blockTag });
  }

  /**
   * The path built so far, for inspection/debugging.
   *
   * @returns The segments in the order they were added. The array is frozen.
   */
  get path(): readonly PathSegment[] {
    return this.#state.segments;
  }

  /**
   * Run the query: one concurrent round of RPC calls, plus one more for a long string.
   *
   * The path must end on a value type or a `string`/`bytes`; use
   * {@link StorageQueryBuilder.readAll} for an array, struct or mapping as a whole.
   *
   * When several things are wrong at once, the error reported is decided in a fixed order:
   * a missing `.contract()`/`.target()`/`.name()`, a layout that cannot be loaded, a contract
   * mismatch, a path that does not fit the type, the outermost out-of-bounds index, and only
   * then a failure to read or decode the value.
   *
   * Not a snapshot: every call carries the query's block tag, so under a moving tag such as
   * `"latest"` the contract check, a length read and the value read can land on different
   * blocks; use `.at(blockNumber)` when that matters.
   *
   * @returns The decoded value with the slot, offset and raw word it came from.
   * @throws {TypeError} when `.contract()`, `.target()` or `.name()` was never called; when
   *   a mapping key does not fit the mapping's key type; when an index is `NaN`, infinite or
   *   not a number or bigint; when a `number` key or index is beyond
   *   `Number.MAX_SAFE_INTEGER`; or, from a context that renders the block tag with
   *   `formatBlockTag`, when `.at()` was given a value that is not a string, number or bigint,
   *   a negative or non-integer number, a number beyond `Number.MAX_SAFE_INTEGER`, or a
   *   negative bigint.
   * @throws {ContractNotFoundError} when the context cannot resolve the contract name.
   * @throws {ContractMismatchError} when the code at the address does not look like the
   *   contract.
   * @throws {VariableNotFoundError} when the contract has no storage variable of that name,
   *   or none of that name declared by the contract given as `declaredIn`.
   * @throws {AmbiguousVariableError} when the contract has more than one storage variable of
   *   that name and `.name()` was not given a `declaredIn` that singles one out.
   * @throws {PathSegmentCountMismatchError} when the path stops on an array, struct or
   *   mapping, or continues past a value.
   * @throws {PathSegmentKindMismatchError} when a segment is the wrong kind for the type at
   *   its position, or names a struct field that does not exist.
   * @throws {IndexOutOfBoundsError} when an index is negative, fractional, or not below the
   *   array's length at the block being read.
   * @throws {UnsupportedTypeError} when the layout holds a type that cannot be addressed or
   *   decoded, including a user-defined value type whose underlying type is unknown and a
   *   mapping keyed by a function type.
   * @throws {RangeError} when the slot read for a `string`/`bytes` is not a valid header (a
   *   short form above 31 bytes, or a long form below 32 bytes) or declares more than 16 MiB,
   *   or when the context returns a word longer than 32 bytes.
   * @remarks Anything the context's own functions throw or reject with — a provider failure,
   *   an adapter's layout error — propagates unchanged.
   */
  async read(): Promise<StorageReadResult> {
    return readOne(this.#context, this.#state, new CallScope());
  }

  /**
   * Run several finished chains in one call, returning their results in the same order.
   *
   * The chains may mix variables, contracts and addresses. The contract/address check runs
   * once per contract and address, and all reads go out together. If any query fails, the
   * call rejects with the error of the first failing query in the list.
   *
   * The builder this is called on contributes nothing: each query runs with its own
   * context, contract, target, path and block. Every query is run to completion or failure
   * before the call settles, and no partial results are returned.
   *
   * Not a snapshot: under a moving tag such as `"latest"` the queries can land on different
   * blocks; give each chain `.at(blockNumber)`.
   *
   * @param queries - Complete chains, each one something `.read()` could be called on.
   * @returns One result per query, in the order given. An empty list gives an empty array.
   * @throws {TypeError} when an element is not a builder of this exact class (for example one
   *   created by the other adapter, or by the other module-format build of this package).
   * @throws Whatever {@link StorageQueryBuilder.read} would throw for the first failing query
   *   in the list.
   */
  async readMany(queries: readonly StorageQueryBuilder[]): Promise<StorageReadResult[]> {
    const scope = new CallScope();
    const settled = await Promise.allSettled(
      queries.map(async (query) => {
        if (typeof query !== 'object' || query === null || !(#state in query)) {
          throw new TypeError(
            'readMany() takes storage query builders from this same decoder. A builder from' +
              ' the other Hardhat adapter, or from the CommonJS/ESM twin of this package, is' +
              ' a different class and cannot be mixed in'
          );
        }
        return readOne(query.#context, query.#state, scope);
      })
    );
    return settled.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
  }

  /**
   * Read one mapping at many keys. Sugar for `readMany` over `.key(k)` for each key.
   *
   * Call it on a chain that stops at the mapping; each key must lead to a value, so a mapping
   * of structs or a nested mapping needs `readMany` with the rest of each path spelled out.
   *
   * Not a snapshot: under a moving tag such as `"latest"` the keys can be read at different
   * blocks; call `.at(blockNumber)` on the chain first.
   *
   * @param keys - The keys to read, each appended to this chain's path as one `.key()`.
   * @returns One result per key, in the order given.
   * @throws Whatever {@link StorageQueryBuilder.read} would throw for the first failing key
   *   in the list.
   */
  async readKeys(keys: readonly MappingKeyValue[]): Promise<StorageReadResult[]> {
    return this.readMany(keys.map((key) => this.key(key)));
  }

  /**
   * Read one array at many indices. Sugar for `readMany` over `.index(i)` for each index.
   *
   * Call it on a chain that stops at the array; each element must be a value, so an array of
   * structs needs `readMany` with the rest of each path spelled out. The array's length is
   * read once for the whole call, not once per index.
   *
   * Not a snapshot: under a moving tag such as `"latest"` the elements, and the length they
   * are checked against, can be read at different blocks; call `.at(blockNumber)` on the
   * chain first.
   *
   * @param indices - The zero-based indices to read, each appended as one `.index()`.
   * @returns One result per index, in the order given.
   * @throws Whatever {@link StorageQueryBuilder.read} would throw for the first failing index
   *   in the list. One out-of-range index rejects the whole call; the in-range elements are
   *   not returned.
   */
  async readIndices(indices: readonly (number | bigint)[]): Promise<StorageReadResult[]> {
    return this.readMany(indices.map((index) => this.index(index)));
  }

  /**
   * Dump everything under this position: arrays and structs to any depth.
   *
   * A mapping's keys are not stored on chain, so a mapping comes back as an empty `Map` and
   * is listed in `skipped` unless `options.keys` supplies keys for it.
   *
   * Unlike `read()`, the path may stop on an array, struct or mapping — that is the point —
   * and may equally end on a single value. A `"latest"` query is pinned to one block number
   * when the context has `getBlockNumber`; the result's `blockTag` is the block actually
   * read. A dump that could not be pinned and is not at a fixed block is instead re-checked
   * once it finishes: every array and `string`/`bytes` length it relied on must be unchanged.
   *
   * @param options - Keys for the mappings to enter, and the size limit. Omit for no keys and
   *   the default limit of 10000.
   * @returns The dumped value, the patterns of the mappings left empty, the type label of the
   *   position dumped, and the block read.
   * @throws {TypeError} when `.contract()`, `.target()` or `.name()` was never called; when
   *   `options`, `maxElements` or `keys` has the wrong shape; when a key pattern is malformed,
   *   does not lead to a mapping within the type being dumped, or lies inside a mapping no
   *   keys were given for; when a mapping key (in the path or in `options.keys`) does not fit
   *   the mapping's key type; when an index is `NaN`, infinite or not a number or bigint;
   *   when a `number` key or index is beyond `Number.MAX_SAFE_INTEGER`; or, from a context
   *   that renders the block tag with `formatBlockTag`, when `.at()` was given a value that
   *   is not a string, number or bigint, a negative or non-integer number, a number beyond
   *   `Number.MAX_SAFE_INTEGER`, or a negative bigint.
   * @throws {ContractNotFoundError} when the context cannot resolve the contract name.
   * @throws {ContractMismatchError} when the code at the address does not look like the
   *   contract.
   * @throws {VariableNotFoundError} when the contract has no storage variable of that name,
   *   or none of that name declared by the contract given as `declaredIn`.
   * @throws {AmbiguousVariableError} when the contract has more than one storage variable of
   *   that name and `.name()` was not given a `declaredIn` that singles one out.
   * @throws {PathSegmentCountMismatchError} when the path continues past a value.
   * @throws {PathSegmentKindMismatchError} when a segment is the wrong kind for the type at
   *   its position, or names a struct field that does not exist.
   * @throws {IndexOutOfBoundsError} when an index on the path to the dumped position is
   *   negative, fractional, or not below the array's length.
   * @throws {UnsupportedTypeError} when the dump meets a type that cannot be addressed or
   *   decoded.
   * @throws {DumpTooLargeError} when an array, a supplied key list, or the dump as a whole
   *   exceeds `maxElements`.
   * @throws {DumpInconsistentError} when the dump ran at a moving block tag and a length it
   *   relied on had changed by the time it finished.
   * @throws {RangeError} when a `string`/`bytes` header is invalid (a short form above 31
   *   bytes, or a long form below 32 bytes) or declares more than 16 MiB, or when the context
   *   returns a word longer than 32 bytes.
   * @remarks Anything the context's own functions throw or reject with propagates unchanged.
   */
  async readAll(options?: ReadAllOptions): Promise<StorageDumpResult> {
    return readAllAt(this.#context, this.#state, options);
  }
}

/**
 * Entry point an adapter exposes as `hre.storageDecoder` / `connection.storageDecoder`.
 *
 * @param context - The adapter's implementation of the outside world.
 * @returns An empty builder: no contract, target or variable yet, reading at `"latest"`.
 */
export function createStorageDecoder(context: StorageDecoderContext): StorageQueryBuilder {
  return new StorageQueryBuilder(context);
}
