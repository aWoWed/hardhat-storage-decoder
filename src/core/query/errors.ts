/**
 * Typed, descriptive errors for every way a storage query can be wrong.
 *
 * The rule: fail loud, never silently wrong. Every failure mode that could otherwise produce
 * a plausible-but-incorrect slot has its own class here so callers can distinguish "you gave
 * the wrong number of path segments" from "you gave the wrong KIND of path segment" from
 * "that index does not exist".
 *
 * The constructor parameters of each class are also its public `readonly` fields: they are
 * what a caller reads after an `instanceof` check.
 */

/**
 * Base class of every typed error in this file, and of the layout errors the Hardhat adapters
 * define themselves. `catch (e) { if (e instanceof StorageDecoderError) ... }` matches all of
 * them.
 *
 * It does not cover everything the package can raise: malformed arguments (an incomplete
 * chain, a mapping key that does not fit its type, an invalid `readAll()` option) and
 * malformed node responses are reported as plain `TypeError`/`RangeError`, and failures of the
 * provider itself propagate unchanged.
 */
export class StorageDecoderError extends Error {
  /**
   * `ownName`/`ownClass` let each shipped class state its name as a literal: bundlers may emit
   * these classes anonymously, which leaves `new.target.name` empty. A consumer's own subclass
   * still gets its own class name.
   *
   * @param message - The full, human-readable error message.
   * @param ownName - Name to report as `error.name` when the instance is constructed as
   *   exactly `ownClass`; also the fallback when a subclass has an empty class name.
   * @param ownClass - The shipped class that `ownName` belongs to. Compared against
   *   `new.target` to tell that class from a consumer's subclass of it.
   */
  constructor(
    message: string,
    ownName = 'StorageDecoderError',
    ownClass: abstract new (...args: never[]) => unknown = StorageDecoderError
  ) {
    super(message);
    this.name = new.target === ownClass ? ownName : new.target.name || ownName;
  }
}

/**
 * `.contract(fqn)` named something that could not be resolved to a compiled contract in the
 * project's build-info.
 *
 * Nothing under `src/core` throws it: it comes from an adapter's
 * `StorageDecoderContext.getLayout`, so it surfaces when a query is run, not when
 * `.contract()` is called. The adapters raise it when:
 *  - the name is not of the form `source/path.sol:ContractName` (Hardhat 2 adapter);
 *  - Hardhat's artifact lookup for the name fails — `detail` is then Hardhat's own message,
 *    or the filesystem error for a missing artifact file;
 *  - the artifact has no build-info, or no build-info id, associated with it;
 *  - the build-info exists but its solc output file does not (Hardhat 3 adapter);
 *  - the build-info's compiler output has no contract of that name, or (Hardhat 3 adapter)
 *    more than one source file in it could be the one meant.
 *
 * A contract that IS found but was compiled without `storageLayout` output is reported by the
 * adapter's own error class, not this one.
 */
export class ContractNotFoundError extends StorageDecoderError {
  /**
   * @param fullyQualifiedName - The name that was passed to `.contract()`, unchanged.
   * @param detail - Which of the lookups failed, appended to the message in parentheses.
   *   Optional in the signature; every throw site in this package supplies it.
   */
  constructor(
    readonly fullyQualifiedName: string,
    readonly detail?: string
  ) {
    super(
      `Contract "${fullyQualifiedName}" was not found in this project's build-info.` +
        ` Check the fully-qualified name ("contracts/Foo.sol:Foo") and make sure the contract` +
        ` has been compiled.${detail ? ` (${detail})` : ''}`,
      'ContractNotFoundError',
      ContractNotFoundError
    );
  }
}

/**
 * The code deployed at `.target(address)` does not plausibly correspond to `.contract(fqn)`.
 *
 * The check is a heuristic, not a proof: immutables and the trailing metadata hash legitimately
 * differ between the artifact's `deployedBytecode` and what is on chain, so only byte-length and
 * the first 32 bytes are compared.
 *
 * Thrown by `read()`, `readMany()`, `readKeys()`, `readIndices()` and `readAll()` in exactly
 * three cases, checked in this order:
 *  - there is no code at the address at the block being read;
 *  - the deployed code's byte length differs from the artifact's `deployedBytecode`;
 *  - the lengths match but the first 32 bytes differ (all of it, when shorter than 32 bytes).
 *
 * The check only runs when the context supplies both `getCode` and `getDeployedBytecode`, and
 * is skipped when the artifact's `deployedBytecode` is missing or empty (`getCode` is still
 * called then, and a failure of it is still reported).
 *
 * A proxy address read with the implementation's name fails this check; there is no proxy
 * detection.
 */
export class ContractMismatchError extends StorageDecoderError {
  /**
   * @param fullyQualifiedName - The contract whose layout was about to be applied.
   * @param address - The address passed to `.target()`, unchanged.
   * @param detail - Which of the three comparisons failed, with the byte counts for a length
   *   difference.
   */
  constructor(
    readonly fullyQualifiedName: string,
    readonly address: string,
    readonly detail: string
  ) {
    super(
      `The code deployed at ${address} does not look like "${fullyQualifiedName}": ${detail}.` +
        ` Decoding would apply the wrong storage layout to this address. Pass the contract` +
        ` actually deployed there, or the correct address for this contract.`,
      'ContractMismatchError',
      ContractMismatchError
    );
  }
}

/**
 * `.name(varName)` named something that is not a storage variable of the contract.
 *
 * `constant` and `immutable` variables are a distinct case: solc never emits them in
 * `storageLayout` because they live in code, not storage. When the caller supplies enough
 * information for us to detect that (see `parseStorageLayout`'s
 * `constantAndImmutableNames` option), the message says so explicitly instead of implying
 * a typo.
 *
 * Thrown by `getVariable`, which every query calls on the parsed layout — so by `read()` and
 * its batch forms, by `readAll()`, and by a direct `deriveSlot` call. The lookup is an exact,
 * case-sensitive match on the variable's label. Two causes:
 *  - no storage variable has that label;
 *  - the query named a declaring contract (`.name(variable, { declaredIn })`) and none of the
 *    variables with that label is declared by it. `options.declaredIn` and
 *    `options.declaringContracts` are set, and the message lists the contracts that do
 *    declare the name.
 *
 * A label shared by several variables, looked up with no declaring contract, is reported as
 * {@link AmbiguousVariableError} instead.
 */
export class VariableNotFoundError extends StorageDecoderError {
  /**
   * @param variableName - The name that was looked up, unchanged.
   * @param options - Context used to word the message; `getVariable` always sets
   *   `isConstantOrImmutable` and `availableNames`, and sets `declaredIn` and
   *   `declaringContracts` for the second cause above.
   */
  constructor(
    readonly variableName: string,
    readonly options: {
      /** Contract the layout belongs to, when the layout records it. */
      readonly contractName?: string;
      /**
       * True when the name is a known `constant` or `immutable` of the contract. Selects the
       * "occupies no storage slot" message.
       */
      readonly isConstantOrImmutable?: boolean;
      /**
       * Labels of every storage variable in the layout, in layout order. Listed in the message
       * unless empty or `isConstantOrImmutable` is true.
       */
      readonly availableNames?: readonly string[];
      /**
       * The declaring contract the query asked for, when the name exists but no variable of
       * that name is declared by it. Selects the "declared in" message.
       */
      readonly declaredIn?: string;
      /**
       * With `declaredIn`: the contracts that do declare a variable of that name, in layout
       * order. Empty when the layout does not record declaring contracts.
       */
      readonly declaringContracts?: readonly string[];
    } = {}
  ) {
    const where = options.contractName ? ` in "${options.contractName}"` : '';
    let message: string;
    if (options.declaredIn !== undefined) {
      const declaring = options.declaringContracts ?? [];
      message =
        `No storage variable named "${variableName}" is declared in "${options.declaredIn}"` +
        `${where}.` +
        (declaring.length > 0
          ? ` It is declared in: ${declaring.join(', ')}.`
          : ` The layout does not record which contract declares "${variableName}"; supply` +
            ` parseStorageLayout's "declaringContracts" option (see extractDeclaringContracts).`);
    } else if (options.isConstantOrImmutable) {
      message =
        `"${variableName}"${where} is declared constant or immutable, so it occupies no storage` +
        ` slot and never appears in solc's storageLayout. Read it by calling its getter instead.`;
    } else {
      message =
        `No storage variable named "${variableName}"${where}.` +
        (options.availableNames && options.availableNames.length > 0
          ? ` Available: ${options.availableNames.join(', ')}.`
          : '') +
        ` Note that constant and immutable variables never appear in storageLayout.`;
    }
    super(message, 'VariableNotFoundError', VariableNotFoundError);
  }
}

/**
 * What {@link AmbiguousVariableError.declaringContracts} holds for a variable whose declaring
 * contract the layout does not record.
 */
export const UNKNOWN_DECLARING_CONTRACT = '(unknown)';

/**
 * `.name(varName)` named a label that more than one storage variable of the contract carries,
 * without saying which one is meant.
 *
 * Solidity forbids shadowing only a visible state variable, so a `private` variable in a base
 * contract and a variable of the same name in a derived contract both occupy storage, and
 * solc lists both under the same label. Picking either silently would read the wrong slot
 * for the other.
 *
 * Thrown by `getVariable` — so by `read()` and its batch forms, by `readAll()`, and by a
 * direct `deriveSlot` call — in two cases:
 *  - the name was looked up with no declaring contract and matches more than one variable;
 *  - a declaring contract was given as a bare contract name, and more than one of the
 *    variables is declared by a contract of that name (in different source files).
 *
 * Resolve it with `.name(variable, { declaredIn })`, passing one of `declaringContracts`.
 */
export class AmbiguousVariableError extends StorageDecoderError {
  /**
   * @param variableName - The name that was looked up, unchanged.
   * @param declaringContracts - The contract declaring each matching variable, in layout order
   *   (base contracts first), as `source/path.sol:ContractName`. An entry is `"(unknown)"`
   *   for a variable whose declaring contract the layout does not record; such a layout was
   *   parsed without the `declaringContracts` option and cannot be disambiguated.
   * @param contractName - Contract the layout belongs to, when the layout records it; quoted
   *   in the message.
   */
  constructor(
    readonly variableName: string,
    readonly declaringContracts: readonly string[],
    readonly contractName?: string
  ) {
    const where = contractName ? ` in "${contractName}"` : '';
    const known = declaringContracts.every((declaring) => declaring !== UNKNOWN_DECLARING_CONTRACT);
    super(
      `"${variableName}"${where} names ${declaringContracts.length} storage variables, declared` +
        ` in: ${declaringContracts.join(', ')}.` +
        (known
          ? ` Say which one with .name("${variableName}", { declaredIn: "<contract>" }).`
          : ` The layout does not record which contract declares each one, so they cannot be` +
            ` told apart (declaredIn has nothing to match); supply parseStorageLayout's` +
            ` "declaringContracts" option (see extractDeclaringContracts).`),
      'AmbiguousVariableError',
      AmbiguousVariableError
    );
  }
}

/**
 * The path had the wrong number of segments — too few (it stopped on a mapping, array, or
 * struct that still needs addressing) or too many (it kept going past a terminal type).
 *
 * The two cases:
 *  - too few: the segments ran out on a composite type. Thrown by `deriveSlot`, so by
 *    `read()` and its batch forms. `readAll()` never throws this case — a path that stops on
 *    a composite is exactly what it dumps.
 *  - too many: a value type or `string`/`bytes` was reached with segments left over. Thrown
 *    by `read()` and by `readAll()` alike.
 *
 * Segments are checked left to right, so an earlier segment of the wrong kind is reported as
 * {@link PathSegmentKindMismatchError} before the count is ever looked at.
 */
export class PathSegmentCountMismatchError extends StorageDecoderError {
  /**
   * @param variableName - The root variable the path started from.
   * @param given - How many path segments the query supplied.
   * @param detail - The type the path stopped on or ran past, and what was expected there.
   * @param expected - For "too few", the smallest total segment count that reaches a terminal
   *   type from where the path stopped. For "too many", the number of segments that were
   *   consumed to reach the terminal type, i.e. the exact count this path should have had.
   */
  constructor(
    readonly variableName: string,
    readonly given: number,
    readonly detail: string,
    readonly expected?: number
  ) {
    super(
      `Wrong number of path segments for "${variableName}": ${detail} (given ${given}).`,
      'PathSegmentCountMismatchError',
      PathSegmentCountMismatchError
    );
  }
}

/**
 * The path had the right shape but the wrong KIND of segment at some position — an
 * `.index()` against a mapping, a `.key()` against an array, a `.field()` against either.
 *
 * Thrown by `stepSegment` (reached from `read()`, its batch forms and `readAll()`) when the
 * segment at a position does not fit the type found there, or is a `.field()` naming a field
 * the struct does not have; `detail` then lists the available field names.
 */
export class PathSegmentKindMismatchError extends StorageDecoderError {
  /**
   * @param variableName - The root variable the path started from.
   * @param segmentIndex - Zero-based position of the offending segment within the path.
   * @param detail - The type at that position, what it needs, and what was given instead.
   */
  constructor(
    readonly variableName: string,
    readonly segmentIndex: number,
    readonly detail: string
  ) {
    super(
      `Wrong path segment kind at position ${segmentIndex} of "${variableName}": ${detail}.`,
      'PathSegmentKindMismatchError',
      PathSegmentKindMismatchError
    );
  }
}

/**
 * An `.index()` segment does not name an existing element of the array it is applied to.
 *
 * Four causes. The first three are found while the path is walked, with no I/O:
 *  - the index is a finite `number` that is not an integer (`1.5`); `length` is `undefined`;
 *  - the index is negative; `length` is `undefined`;
 *  - the array is fixed-size and the index is >= its declared length.
 *
 * The fourth needs a read:
 *  - the array is dynamic and the index is >= the length stored on chain at the block being
 *    read. When several indices on one path are out of bounds, the outermost is reported.
 *
 * `NaN` and `±Infinity` are not reported through this class: neither converts to the `bigint`
 * that `index` holds, so they are rejected with a `TypeError`. So is an index that is not a
 * `number` or `bigint` at all.
 */
export class IndexOutOfBoundsError extends StorageDecoderError {
  /**
   * @param index - The rejected index. For a non-integer `number` this is the value truncated
   *   toward zero, not the value the caller passed.
   * @param length - The array length the index was compared against, or `undefined` when the
   *   index was rejected before any length was consulted (non-integer or negative).
   * @param typeLabel - Solidity label of the array type, e.g. `uint256[]`.
   * @param variableName - The root variable the path started from. Optional in the
   *   signature; every throw site in this package supplies it.
   */
  constructor(
    readonly index: bigint,
    readonly length: bigint | undefined,
    readonly typeLabel: string,
    readonly variableName?: string
  ) {
    const where = variableName ? ` of "${variableName}"` : '';
    super(
      length === undefined
        ? `Index ${index} is not a valid index into ${typeLabel}${where}.`
        : `Index ${index} is out of bounds for ${typeLabel}${where}, which has length ${length}.`,
      'IndexOutOfBoundsError',
      IndexOutOfBoundsError
    );
  }
}

/**
 * A type this package cannot address or decode, or a layout too incomplete to do so safely.
 * `detail` says which case applies.
 *
 * While the layout is parsed (`parseStorageLayout`, `parseFixedArrayLength`):
 *  - a type entry has a solc `encoding` other than the known ones;
 *  - a mapping entry is missing `key` or `value`, or a dynamic-array entry is missing `base`;
 *  - a fixed array's length can be parsed from neither its type identifier nor its label;
 *  - an `inplace` entry that is neither a struct nor a fixed array has a type identifier
 *    that matches no recognised value type;
 *  - a byte offset, or the `numberOfBytes` of anything but a struct or fixed array, exceeds
 *    `Number.MAX_SAFE_INTEGER`, so a `number` cannot hold it exactly.
 *
 * While a path is walked (`deriveSlot`, `stepSegment`, `terminalPlan`, and `readAll()`):
 *  - the path indexes a fixed array whose length exceeds `Number.MAX_SAFE_INTEGER`, or an
 *    array whose element type is a struct or fixed array that large (`uint256[2**64]`
 *    compiles). The layout itself parses, so the contract's other variables stay readable;
 *  - the layout references a type identifier it does not define (`getTypeInfo`);
 *  - a parsed type lacks a part the walk needs: a mapping's key or value type, an array's
 *    element type, a fixed array's length, a struct's members, a terminal type's value kind;
 *  - an array's element type reports a size of zero bytes;
 *  - a path segment is applied to a terminal type through a direct `stepSegment` call
 *    (`deriveSlot` reports that as {@link PathSegmentCountMismatchError} instead);
 *  - a mapping's key type is not a value type or `string`/`bytes`;
 *  - a mapping's key type is a user-defined value type whose underlying type is unknown, so
 *    the padding direction of the key cannot be determined;
 *  - a mapping's key type is a function type.
 *
 * While a value is decoded (`decode`):
 *  - the value is a user-defined value type whose underlying type is unknown.
 *
 * Both user-defined-value-type cases are avoided by passing `parseStorageLayout` the
 * `userDefinedValueTypes` option.
 */
export class UnsupportedTypeError extends StorageDecoderError {
  /**
   * @param typeLabel - Solidity label of the type, e.g. `mapping(address => uint256)`. Falls
   *   back to the type identifier where the layout supplies no label; for the decode-time
   *   case it is the bare name of the user-defined value type.
   * @param typeId - solc type identifier, e.g. `t_mapping(t_address,t_uint256)`. For the
   *   decode-time case it is synthesised as `t_userDefinedValueType(<name>)` and need not
   *   equal the identifier used in the layout.
   * @param detail - Which of the cases above applies. Optional in the signature; every throw
   *   site in this package supplies it.
   */
  constructor(
    readonly typeLabel: string,
    readonly typeId: string,
    readonly detail?: string
  ) {
    super(
      `Unsupported storage type "${typeLabel}" (${typeId})` +
        `${detail ? `: ${detail}` : ''}. Refusing to guess a slot for it.`,
      'UnsupportedTypeError',
      UnsupportedTypeError
    );
  }
}

/**
 * A `readAll()` dump would expand more than `maxElements` allows. No partial result is
 * returned.
 *
 * Thrown in three situations, told apart by `kind`:
 *  - `'keys'`: a key list in `options.keys` is longer than the limit. Checked before any
 *    storage slot is read.
 *  - `'array'`: one array is longer than the limit. A fixed array is rejected from its
 *    declared length; a dynamic array's length slot is read first, then none of its elements.
 *  - `'total'`: the running count of expanded nodes — array elements, struct fields, mapping
 *    entries and the data slots of long `string`/`bytes` values — passed the limit. The count
 *    is raised before the node's children are expanded, and before a long value's data slots
 *    are fetched.
 *
 * What is and is not guaranteed about reads: the node that hit the limit is not expanded any
 * further. The dump's other branches run concurrently, though, so for `'array'` and `'total'`
 * reads elsewhere in the dump may already have been sent or completed. Once the error is
 * raised, reads that have not been sent yet are cancelled instead of being sent.
 */
export class DumpTooLargeError extends StorageDecoderError {
  /**
   * @param kind - Which limit was hit: one array's length, one supplied key list, or the
   *   whole dump.
   * @param count - The number that exceeded the limit: the array's length, the key list's
   *   length, or for `'total'` the running node count including the children that pushed it
   *   over.
   * @param limit - The `maxElements` in effect (the caller's value, or the default).
   * @param path - Where the limit was hit, written from the variable down (`items[3].tags`).
   *   For `'keys'` it is the key pattern the list was supplied under, or `(root)`.
   */
  constructor(
    readonly kind: 'array' | 'keys' | 'total',
    readonly count: bigint,
    readonly limit: number,
    readonly path: string
  ) {
    const what =
      kind === 'array'
        ? `the array at "${path}" has ${count} element(s)`
        : kind === 'keys'
          ? `${count} key(s) were supplied for the mapping at "${path}"`
          : `the dump reached ${count} node(s) at "${path}"`;
    super(
      `Refusing to dump: ${what}, above the limit of ${limit}.` +
        ` Raise "maxElements", or read a narrower path.`,
      'DumpTooLargeError',
      DumpTooLargeError
    );
  }
}

/**
 * Storage changed while a dump was being read at a block tag that can move.
 *
 * Thrown only by `readAll()`, and only when the block it reads at is not fixed: `"latest"`
 * with a context that has no `getBlockNumber`, `"pending"`, `"safe"`, `"finalized"`, or any
 * other string except `"earliest"` and a `0x` hex value. After the dump, every length it
 * relied on — each dynamic array's, each long `string`/`bytes` value's, and those of dynamic
 * arrays indexed on the way to the dump's root — is read once more; the first difference
 * found is reported.
 *
 * Its absence is not a snapshot guarantee: equal lengths do not prove equal elements.
 */
export class DumpInconsistentError extends StorageDecoderError {
  /**
   * @param path - The array or `string`/`bytes` value whose length changed, written from the
   *   variable down (`items[3].tags`).
   * @param before - The length the dump read and relied on: an array's element count, or a
   *   `string`/`bytes` value's byte length.
   * @param after - The same length as found when it was read again after the dump.
   */
  constructor(
    readonly path: string,
    readonly before: bigint,
    readonly after: bigint
  ) {
    super(
      `Storage changed during the dump: the length at "${path}" went from ${before} to ${after}.` +
        ` Retry, or read a fixed block with .at(blockNumber).`,
      'DumpInconsistentError',
      DumpInconsistentError
    );
  }
}
