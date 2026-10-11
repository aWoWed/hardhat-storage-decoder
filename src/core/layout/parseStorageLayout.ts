/**
 * Turns solc's `storageLayout` compiler output into the typed model the rest of the core works
 * on, and offers the lookups and AST helpers that go with it.
 *
 * This is the first stage of the read pipeline. An adapter pulls `storageLayout` (and the
 * source ASTs) out of a build-info file and calls {@link parseStorageLayout}; the resulting
 * {@link ParsedStorageLayout} is what slot derivation (`slots/deriveSlot.ts`) walks to turn a
 * variable name and path into a slot, and its {@link ValueKind}s are what decoding
 * (`slots/decode.ts`) dispatches on. Nothing here performs I/O or depends on a build tool:
 * every function takes plain solc JSON.
 */
import {
  AmbiguousVariableError,
  UNKNOWN_DECLARING_CONTRACT,
  UnsupportedTypeError,
  VariableNotFoundError,
} from '../query/errors.js';

// ---------------------------------------------------------------------------------------
// Raw solc shapes
// ---------------------------------------------------------------------------------------

/**
 * solc's four storage encodings. Dispatching on this — not on the type label — is the rule.
 *
 * - `inplace`: the data sits contiguously in the declared slot(s) — value types, structs and
 *   fixed-size arrays.
 * - `mapping`: nothing at the declared slot; each value lives at a keccak-derived slot.
 * - `dynamic_array`: the declared slot holds the length, the elements start at `keccak256(slot)`.
 * - `bytes`: `string`/`bytes` — one slot when short, a header plus `keccak256(slot)` data
 *   slots when long.
 */
export type Encoding = 'inplace' | 'mapping' | 'dynamic_array' | 'bytes';

/**
 * One entry of solc's `storageLayout.storage` array, or of a struct type's `members` array —
 * both use this shape. Numeric fields may arrive as strings and are coerced when parsed.
 */
export interface RawStorageEntry {
  /** AST id of the variable's declaration. */
  readonly astId?: number;
  /**
   * The contract the layout was generated for, as `source/path.sol:ContractName`. solc writes
   * the same value on every entry, inherited variables included: it does not say which
   * contract declares the variable.
   */
  readonly contract?: string;
  /** Variable (or struct member) name. */
  readonly label: string;
  /** Byte offset inside the slot, counted from the least significant end of the word. */
  readonly offset: number | string;
  /**
   * Slot number. Absolute for a state variable; relative to the struct's first slot for a
   * struct member.
   */
  readonly slot: string | number;
  /** Type identifier — a key of {@link RawStorageLayout.types}. */
  readonly type: string;
}

/** One value of solc's `storageLayout.types` map, describing a single type identifier. */
export interface RawTypeEntry {
  /** One of the {@link Encoding} values; anything else is rejected when parsed. */
  readonly encoding: string;
  /** Solidity type label, e.g. `uint256` or `mapping(address => uint256)`. */
  readonly label: string;
  /** Storage footprint of the type in bytes, as solc reports it. */
  readonly numberOfBytes: string | number;
  /** Mappings only: type identifier of the key. */
  readonly key?: string;
  /** Mappings only: type identifier of the value. */
  readonly value?: string;
  /** Arrays (dynamic and fixed) only: type identifier of the element. */
  readonly base?: string;
  /** Structs only: the members, with slots relative to the struct's first slot. */
  readonly members?: readonly RawStorageEntry[];
}

/** The `storageLayout` object exactly as solc emits it. */
export interface RawStorageLayout {
  /** State variables in the order solc lists them. Absent or `null` is read as no variables. */
  readonly storage?: readonly RawStorageEntry[] | null;
  /** Every type the variables reach, keyed by type identifier. Absent or `null` is read as none. */
  readonly types?: Readonly<Record<string, RawTypeEntry>> | null;
}

// ---------------------------------------------------------------------------------------
// Parsed shapes
// ---------------------------------------------------------------------------------------

/**
 * How a leaf value type is encoded as a mapping key and decoded from a slot.
 *
 * Variants, by `family`:
 *  - `uint`: unsigned integer of `bits` bits occupying `bytes` bytes. Enums resolve to this
 *    too, with the width taken from the enum's `numberOfBytes`.
 *  - `int`: two's-complement signed integer of `bits` bits occupying `bytes` bytes.
 *  - `bool`: one byte, non-zero meaning `true`.
 *  - `address`: 20 bytes. `address payable` and contract-typed variables resolve to this.
 *  - `bytesN`: fixed-size byte array of `size` bytes (`bytes1`..`bytes32`).
 *  - `string`: dynamic UTF-8 text (solc encoding `bytes`).
 *  - `bytes`: dynamic byte array (solc encoding `bytes`).
 *  - `unresolvedUserDefinedValueType`: a user-defined value type called `name`, occupying
 *    `numberOfBytes` bytes, whose underlying type was not supplied.
 *  - `function`: a function-typed variable occupying `bytes` bytes. `kind` is `external` (24
 *    bytes: the 20-byte address followed by the 4-byte selector) or `internal` (8 bytes: a
 *    code position meaningful only to the contract's own bytecode). It decodes to the raw
 *    bytes as `0x` hex and cannot be a mapping key.
 *
 * `unresolvedUserDefinedValueType` is not a failure by itself: a UDVT's underlying type is
 * absent from `storageLayout` (the entry carries only a label and a byte count), so it can
 * only be resolved from the compilation AST. The kind is carried through the walk and only
 * throws at the point where the underlying rule actually matters: encoding it as a mapping
 * key, or decoding its value.
 */
export type ValueKind =
  | { readonly family: 'uint'; readonly bits: number; readonly bytes: number }
  | { readonly family: 'int'; readonly bits: number; readonly bytes: number }
  | { readonly family: 'bool' }
  | { readonly family: 'address' }
  | { readonly family: 'bytesN'; readonly size: number }
  | { readonly family: 'string' }
  | { readonly family: 'bytes' }
  | {
      readonly family: 'unresolvedUserDefinedValueType';
      readonly name: string;
      readonly numberOfBytes: number;
    }
  | {
      readonly family: 'function';
      readonly kind: 'external' | 'internal';
      readonly bytes: number;
    };

/**
 * Structural classification derived from `encoding` (plus the presence of `members`/`base`).
 *
 * - `value`: `inplace` with neither `members` nor `base` — a leaf that fits in one slot.
 * - `mapping`: encoding `mapping`; takes a key path segment.
 * - `dynamicArray`: encoding `dynamic_array`; takes an index, bounds-checked against the
 *   length stored on chain.
 * - `fixedArray`: `inplace` with a `base`; takes an index, bounds-checked against
 *   {@link TypeInfo.fixedLength}.
 * - `struct`: `inplace` with `members`; takes a field name.
 * - `dynamicBytes`: encoding `bytes` — `string` or `bytes`, a leaf read through its length
 *   header.
 */
export type TypeKind =
  | 'value'
  | 'mapping'
  | 'dynamicArray'
  | 'fixedArray'
  | 'struct'
  | 'dynamicBytes';

/** A parsed member of a struct type. */
export interface StructMember {
  /** Field name as declared in Solidity. */
  readonly label: string;
  /** Slot DELTA from the struct's own base slot, never an absolute slot. */
  readonly slot: bigint;
  /** Byte offset inside that slot, counted from the least significant end of the word. */
  readonly offset: number;
  /** Type identifier of the member — a key of {@link ParsedStorageLayout.types}. */
  readonly typeId: string;
}

/**
 * A parsed entry of the layout's type table. Which optional fields are present follows from
 * {@link TypeInfo.kind}.
 */
export interface TypeInfo {
  /** solc type identifier, e.g. `t_uint256`; the key this entry is stored under. */
  readonly id: string;
  /** Structural classification that slot derivation switches on. */
  readonly kind: TypeKind;
  /** The solc encoding the kind was derived from. */
  readonly encoding: Encoding;
  /**
   * Solidity type label, e.g. `uint256`. Returned to callers as `typeLabel` and quoted in
   * error messages.
   */
  readonly label: string;
  /**
   * Storage footprint in bytes as solc reports it. For a value type this is the width of the
   * packed field; for fixed arrays and structs it is rounded up to whole slots, so it need
   * not be a multiple of the element size.
   */
  readonly numberOfBytes: number;
  /** Present for `mapping`: type identifier of the key. */
  readonly keyTypeId?: string;
  /** Present for `mapping`: type identifier of the value. */
  readonly valueTypeId?: string;
  /** Present for `dynamicArray` and `fixedArray`: type identifier of the element. */
  readonly baseTypeId?: string;
  /**
   * Present for `fixedArray`, parsed from the type id/label — never from a byte-count ratio.
   * Absent when the length is beyond `Number.MAX_SAFE_INTEGER`; `oversized` then says so.
   */
  readonly fixedLength?: number;
  /**
   * Set on a struct or fixed array whose byte size or length is beyond
   * `Number.MAX_SAFE_INTEGER`, with the reason. `numberOfBytes` is then rounded and must not
   * be used for slot arithmetic. Two things are refused with this reason: indexing a fixed
   * array whose LENGTH is that large (it has no `fixedLength`), and placing the type as an
   * array element. A struct's fields stay reachable, because a field needs only its member
   * slot; so does a fixed array whose length is safe and only its byte size is not.
   */
  readonly oversized?: string;
  /** Present for `struct`: the fields, in the order solc lists them. */
  readonly members?: readonly StructMember[];
  /** Present for `value` and `dynamicBytes`. */
  readonly valueKind?: ValueKind;
}

/** A parsed top-level state variable: where it starts and what type it has. */
export interface StorageVariable {
  /**
   * Variable name as declared in Solidity; what {@link getVariable} matches on. Not unique: a
   * private variable of a base contract and a variable of a derived contract may share it.
   */
  readonly label: string;
  /** Absolute slot the variable starts at. */
  readonly slot: bigint;
  /** Byte offset inside that slot, counted from the least significant end of the word. */
  readonly offset: number;
  /** Type identifier — a key of {@link ParsedStorageLayout.types}. */
  readonly typeId: string;
  /**
   * solc's `contract` field, copied when present: the contract the layout was generated for,
   * the same on every variable. See {@link StorageVariable.declaredIn} for the declaring one.
   */
  readonly contract?: string;
  /** AST id of the declaration, copied from solc when present. */
  readonly astId?: number;
  /**
   * The contract that declares the variable, as `source/path.sol:ContractName`. Present only
   * when {@link ParseStorageLayoutOptions.declaringContracts} has an entry for
   * {@link StorageVariable.astId}; it is what `declaredIn` is matched against.
   */
  readonly declaredIn?: string;
}

/** The validated layout of one contract: the output of {@link parseStorageLayout}. */
export interface ParsedStorageLayout {
  /** Contract name given in the parse options; only used to word error messages. */
  readonly contractName?: string;
  /** State variables in the order solc lists them. */
  readonly variables: readonly StorageVariable[];
  /** Type table keyed by solc type identifier; look entries up with {@link getTypeInfo}. */
  readonly types: Readonly<Record<string, TypeInfo>>;
  /** Names known to be `constant`/`immutable`, used to give a precise "not in storage" error. */
  readonly constantAndImmutableNames: ReadonlySet<string>;
}

/** Optional inputs to {@link parseStorageLayout} that `storageLayout` itself cannot provide. */
export interface ParseStorageLayoutOptions {
  /** Contract name to carry on the result and quote in "variable not found" errors. */
  readonly contractName?: string;
  /**
   * Underlying elementary type for each user-defined value type, keyed by the AST id that
   * appears as the numeric suffix of the layout's type identifier
   * (`t_userDefinedValueType(Id)3` -> key `"3"`) and/or by the UDVT's name.
   * Values are solc type identifiers or type strings, e.g. `"t_bytes32"` or `"int128"`.
   *
   * Build this with {@link extractUserDefinedValueTypes} from the compilation AST.
   */
  readonly userDefinedValueTypes?: Readonly<Record<string, string>>;
  /** Names declared `constant`/`immutable`; see {@link extractConstantAndImmutableNames}. */
  readonly constantAndImmutableNames?: Iterable<string>;
  /**
   * The contract that declares each state variable, keyed by the AST id of the declaration
   * (the `astId` of a storage entry, as a string). `storageLayout` itself does not carry it.
   * Without it a name declared more than once in an inheritance chain cannot be told apart.
   *
   * Build this with {@link extractDeclaringContracts} from the compilation AST.
   */
  readonly declaringContracts?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------

/** The encodings this parser understands; a type entry with any other `encoding` is rejected. */
const ENCODINGS = new Set<Encoding>(['inplace', 'mapping', 'dynamic_array', 'bytes']);

/**
 * Coerce one of solc's slot numbers to a `bigint`. Slots are decimal strings in solc's output
 * and can exceed the safe-integer range, hence `bigint` rather than `number`.
 *
 * @param value - The raw slot, as a string or number.
 * @param what - Description of the field, used at the start of the error message.
 * @returns The slot as a non-negative `bigint`.
 * @throws {TypeError} when the value is negative.
 * @throws {SyntaxError} when a string is not an integer literal `BigInt` accepts.
 * @throws {RangeError} when a number is not an integer.
 */
function toBigInt(value: string | number, what: string): bigint {
  const parsed = BigInt(value);
  if (parsed < 0n) throw new TypeError(`${what} must not be negative, got ${value}`);
  return parsed;
}

/**
 * Coerce one of solc's small numeric fields (`offset`, `numberOfBytes`) to a `number`.
 *
 * @param value - The raw field, as a string or number.
 * @param what - Description of the field, used at the start of the error message.
 * @param typeLabel - Label of the type the field belongs to, for the unsafe-integer error.
 * @param typeId - Identifier of that type, for the unsafe-integer error.
 * @returns The value as a non-negative safe integer.
 * @throws {TypeError} when the value is not a non-negative integer.
 * @throws {UnsupportedTypeError} when the value is an integer above
 *   `Number.MAX_SAFE_INTEGER`, which a `number` cannot hold exactly: slot arithmetic on the
 *   rounded value would address the wrong slot.
 */
function toNumber(
  value: string | number,
  what: string,
  typeLabel: string,
  typeId: string
): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(`${what} must be a non-negative integer, got ${String(value)}`);
  }
  if (!Number.isSafeInteger(parsed)) {
    throw new UnsupportedTypeError(
      typeLabel,
      typeId,
      `${what} is ${String(value)}, which exceeds Number.MAX_SAFE_INTEGER`
    );
  }
  return parsed;
}

/**
 * Parse and validate solc's `storageLayout`, coercing its stringly-typed numbers.
 *
 * @remarks
 * Every type entry is parsed up front, so a malformed type fails here even if no variable
 * uses it. Only the types of top-level variables are checked for presence in the type table;
 * a dangling key/value/element/member type identifier surfaces later, from
 * {@link getTypeInfo}, when a path walks into it.
 *
 * @param raw - The `storageLayout` object from solc's contract output.
 * @param options - Contract name for error messages, user-defined value type resolutions,
 *   `constant`/`immutable` names and declaring contracts. Defaults to none of them.
 * @returns The typed layout.
 * @throws {TypeError} when `raw` or a type entry is not an object, when a slot is negative,
 *   when an offset or byte count is negative or not an integer, or when a variable's type is
 *   missing from `types`.
 * @throws {UnsupportedTypeError} when a type has an unknown encoding, a mapping lacks its
 *   key/value, a dynamic array lacks its base, a fixed-array length cannot be parsed, a
 *   value type identifier is not recognised, or an offset, or the byte count of anything but
 *   a struct or fixed array, exceeds `Number.MAX_SAFE_INTEGER`. A struct or fixed array that
 *   large is not refused here: it is marked `oversized` (see {@link TypeInfo.oversized}) and
 *   refused when a path walks into it, so the contract's other variables stay readable.
 * @throws {SyntaxError} when a slot is a string that is not an integer literal.
 * @throws {RangeError} when a slot is a non-integer number.
 */
export function parseStorageLayout(
  raw: RawStorageLayout,
  options: ParseStorageLayoutOptions = {}
): ParsedStorageLayout {
  if (raw === null || typeof raw !== 'object') {
    throw new TypeError('storageLayout must be an object');
  }

  const rawTypes = raw.types ?? {};
  const types: Record<string, TypeInfo> = {};
  for (const [id, entry] of Object.entries(rawTypes)) {
    types[id] = parseTypeEntry(id, entry, options.userDefinedValueTypes ?? {});
  }

  const declaringContracts = options.declaringContracts ?? {};
  const variables: StorageVariable[] = (raw.storage ?? []).map((entry) => {
    const declaredIn =
      entry.astId === undefined ? undefined : ownString(declaringContracts, String(entry.astId));
    return {
      label: entry.label,
      slot: toBigInt(entry.slot, `slot of "${entry.label}"`),
      offset: toNumber(entry.offset, `offset of "${entry.label}"`, entry.type, entry.type),
      typeId: entry.type,
      ...(entry.contract === undefined ? {} : { contract: entry.contract }),
      ...(entry.astId === undefined ? {} : { astId: entry.astId }),
      ...(declaredIn === undefined ? {} : { declaredIn }),
    };
  });

  for (const variable of variables) {
    if (types[variable.typeId] === undefined) {
      throw new TypeError(
        `storageLayout references type "${variable.typeId}" for variable "${variable.label}",` +
          ` but that type is missing from the layout's "types" map`
      );
    }
  }

  return {
    ...(options.contractName === undefined ? {} : { contractName: options.contractName }),
    variables,
    types,
    constantAndImmutableNames: new Set(options.constantAndImmutableNames ?? []),
  };
}

/**
 * Look a key up in a caller-supplied map, ignoring what the map inherits. A plain object
 * answers `toString`, `constructor` or `__proto__` from `Object.prototype`, and all three are
 * legal Solidity identifiers.
 *
 * @param map - The map to read.
 * @param key - The key to look up.
 * @returns The map's own string value for `key`, or `undefined` when it has none.
 */
function ownString(map: Readonly<Record<string, string>>, key: string): string | undefined {
  if (!Object.hasOwn(map, key)) return undefined;
  const value: unknown = map[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Parse one entry of the raw type table into a {@link TypeInfo}.
 *
 * Dispatches on `encoding`. The three `inplace` shapes are told apart by which optional field
 * is present: `members` makes a struct, otherwise `base` makes a fixed array, otherwise the
 * entry is a value type and its {@link ValueKind} is resolved from the type identifier.
 *
 * @param id - The type identifier the entry is stored under.
 * @param entry - The raw entry from solc.
 * @param udvts - Underlying types for user-defined value types, keyed by AST id and/or name.
 * @returns The parsed type.
 * @throws {TypeError} when `entry` is not an object.
 * @throws {UnsupportedTypeError} when the encoding is unknown, a mapping lacks `key` or
 *   `value`, or a dynamic array lacks `base`.
 * @throws Whatever `toBigInt`, `toNumber`, `readFixedArrayLength` and `resolveValueKind` throw
 *   for a field they are given. A struct or fixed array whose size or length is beyond
 *   `Number.MAX_SAFE_INTEGER` does not throw: it is returned with `oversized` set.
 */
function parseTypeEntry(
  id: string,
  entry: RawTypeEntry,
  udvts: Readonly<Record<string, string>>
): TypeInfo {
  if (entry === null || typeof entry !== 'object') {
    throw new TypeError(`storageLayout type "${id}" must be an object`);
  }
  if (!ENCODINGS.has(entry.encoding as Encoding)) {
    throw new UnsupportedTypeError(
      entry.label ?? id,
      id,
      `unknown solc encoding "${entry.encoding}"`
    );
  }
  const encoding = entry.encoding as Encoding;
  const sizeField = `numberOfBytes of type "${id}"`;
  // Only a struct or a fixed array can legitimately be this large (`uint256[2**64] gap;`
  // compiles). Refusing it here would make every other variable of the contract unreadable,
  // so it is marked and refused when a path walks into it.
  const isComposite =
    encoding === 'inplace' && (entry.members !== undefined || entry.base !== undefined);
  const oversizedBytes = isComposite ? oversizedReason(entry.numberOfBytes, sizeField) : undefined;
  const numberOfBytes =
    oversizedBytes === undefined
      ? toNumber(entry.numberOfBytes, sizeField, entry.label ?? id, id)
      : Number(entry.numberOfBytes);
  const base = {
    id,
    encoding,
    label: entry.label,
    numberOfBytes,
    ...(oversizedBytes === undefined ? {} : { oversized: oversizedBytes }),
  } as const;

  switch (encoding) {
    case 'mapping': {
      if (entry.key === undefined || entry.value === undefined) {
        throw new UnsupportedTypeError(entry.label, id, 'mapping type is missing key/value');
      }
      return { ...base, kind: 'mapping', keyTypeId: entry.key, valueTypeId: entry.value };
    }
    case 'dynamic_array': {
      if (entry.base === undefined) {
        throw new UnsupportedTypeError(entry.label, id, 'dynamic array type is missing base');
      }
      return { ...base, kind: 'dynamicArray', baseTypeId: entry.base };
    }
    case 'bytes': {
      // Encoding "bytes" covers `string` and `bytes`; only the label or a `t_string` id tells
      // them apart.
      const isString = entry.label === 'string' || id.startsWith('t_string');
      return {
        ...base,
        kind: 'dynamicBytes',
        valueKind: isString ? { family: 'string' } : { family: 'bytes' },
      };
    }
    case 'inplace': {
      if (entry.members !== undefined) {
        return {
          ...base,
          kind: 'struct',
          members: entry.members.map((member) => ({
            label: member.label,
            slot: toBigInt(member.slot, `slot of member "${member.label}" of type "${id}"`),
            offset: toNumber(
              member.offset,
              `offset of member "${member.label}" of type "${id}"`,
              entry.label ?? id,
              id
            ),
            typeId: member.type,
          })),
        };
      }
      if (entry.base !== undefined) {
        const length = readFixedArrayLength(id, entry.label);
        return {
          ...base,
          kind: 'fixedArray',
          baseTypeId: entry.base,
          ...(typeof length === 'number' ? { fixedLength: length } : { oversized: length.oversized }),
        };
      }
      return {
        ...base,
        kind: 'value',
        valueKind: resolveValueKind(id, entry.label, numberOfBytes, udvts),
      };
    }
  }
}

/**
 * Fixed-array length, parsed from the type identifier (`t_array(t_uint8)10_storage` -> 10)
 * with the label (`uint8[10]`) as a fallback.
 *
 * It is NOT derived from `numberOfBytes / elementNumberOfBytes`: solc reports
 * `numberOfBytes: "32"` for `uint8[10]`, so the ratio would give 32 and every bounds check on
 * a packed fixed array would be wrong.
 *
 * @param typeId - solc type identifier of the fixed array.
 * @param label - Solidity type label, consulted only when the identifier has no length.
 * @returns The declared number of elements.
 * @throws {UnsupportedTypeError} when neither the identifier nor the label ends in a length,
 *   or when the length exceeds `Number.MAX_SAFE_INTEGER` — a `number` cannot hold it exactly,
 *   so bounds checks and element slots computed from it would be wrong.
 */
export function parseFixedArrayLength(typeId: string, label?: string): number {
  const length = readFixedArrayLength(typeId, label);
  if (typeof length === 'number') return length;
  throw new UnsupportedTypeError(label ?? typeId, typeId, length.oversized);
}

/** {@link parseFixedArrayLength}, but a length too large for a `number` is returned as a reason. */
function readFixedArrayLength(typeId: string, label?: string): number | { oversized: string } {
  const fromId = /\)(\d+)_(?:storage|memory|calldata)(?:_ptr)?$/.exec(typeId);
  const fromLabel = label === undefined ? null : /\[(\d+)\]$/.exec(label);
  const digits = fromId?.[1] ?? fromLabel?.[1];
  if (digits === undefined) {
    throw new UnsupportedTypeError(
      label ?? typeId,
      typeId,
      'could not parse the fixed-array length from the type identifier or label'
    );
  }
  const length = Number(digits);
  return Number.isSafeInteger(length)
    ? length
    : { oversized: `the fixed-array length ${digits} exceeds Number.MAX_SAFE_INTEGER` };
}

/** Why a size cannot be held exactly by a `number`, or `undefined` when it can. */
function oversizedReason(value: string | number, what: string): string | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && !Number.isSafeInteger(parsed)
    ? `${what} is ${String(value)}, which exceeds Number.MAX_SAFE_INTEGER`
    : undefined;
}

/** Matches an unsigned integer type identifier (`t_uint256`); group 1 is the bit width. */
const UINT_RE = /^t_uint(\d+)$/;
/** Matches a signed integer type identifier (`t_int128`); group 1 is the bit width. */
const INT_RE = /^t_int(\d+)$/;
/**
 * Matches a fixed-size byte array type identifier (`t_bytes32`); group 1 is the byte count.
 * Dynamic `bytes` is `t_bytes_storage` and does not match.
 */
const BYTES_N_RE = /^t_bytes(\d+)$/;
/** Matches the start of a contract type identifier (`t_contract(Token)42`). */
const CONTRACT_RE = /^t_contract\(/;
/** Matches the start of an enum type identifier (`t_enum(Status)7`). */
const ENUM_RE = /^t_enum\(/;
/**
 * Matches a user-defined value type identifier (`t_userDefinedValueType(Id)3`); group 1 is the
 * type's name and group 2 the AST id of its definition.
 */
const UDVT_RE = /^t_userDefinedValueType\(([^)]*)\)(\d+)$/;
/**
 * Matches the start of a function type identifier
 * (`t_function_external_nonpayable()returns()`); group 1 is `external` or `internal`.
 */
const FUNCTION_RE = /^t_function_(external|internal)_/;

/**
 * Classify an `inplace` leaf type by its type identifier.
 *
 * Contract types collapse to `address` and enums to a `uint` as wide as the enum's storage.
 * A user-defined value type is looked up in `udvts` — by AST id first, then by name — and
 * resolved as its underlying type; when it is not listed, the result is the
 * `unresolvedUserDefinedValueType` kind rather than an error. Only the map's own entries
 * count, so a type named `toString` or `constructor` is not answered by `Object.prototype`.
 * A function type becomes the `function` kind, `numberOfBytes` wide.
 *
 * @param id - The type identifier to classify.
 * @param label - Solidity type label, used only in the error.
 * @param numberOfBytes - Storage width of the type; supplies the width of an enum and of a
 *   function type, and is recorded on an unresolved user-defined value type.
 * @param udvts - Underlying types for user-defined value types, keyed by AST id and/or name.
 * @returns The value kind.
 * @throws {UnsupportedTypeError} when the identifier (or the underlying type supplied for a
 *   user-defined value type) is none of the recognised value types.
 */
function resolveValueKind(
  id: string,
  label: string,
  numberOfBytes: number,
  udvts: Readonly<Record<string, string>>
): ValueKind {
  const uint = UINT_RE.exec(id);
  if (uint?.[1] !== undefined) {
    const bits = Number(uint[1]);
    return { family: 'uint', bits, bytes: bits / 8 };
  }

  const int = INT_RE.exec(id);
  if (int?.[1] !== undefined) {
    const bits = Number(int[1]);
    return { family: 'int', bits, bytes: bits / 8 };
  }

  const bytesN = BYTES_N_RE.exec(id);
  if (bytesN?.[1] !== undefined) return { family: 'bytesN', size: Number(bytesN[1]) };

  if (id === 't_bool') return { family: 'bool' };
  if (id === 't_address' || id === 't_address_payable') return { family: 'address' };

  if (CONTRACT_RE.test(id)) return { family: 'address' };
  if (ENUM_RE.test(id)) {
    return { family: 'uint', bits: numberOfBytes * 8, bytes: numberOfBytes };
  }

  const udvt = UDVT_RE.exec(id);
  if (udvt) {
    const name = udvt[1] as string;
    const astId = udvt[2] as string;
    const underlying = ownString(udvts, astId) ?? ownString(udvts, name);
    if (underlying !== undefined) {
      return resolveValueKind(normalizeTypeIdentifier(underlying), underlying, numberOfBytes, {});
    }
    // Unknown underlying type. Carried, not thrown: see the note on ValueKind.
    return { family: 'unresolvedUserDefinedValueType', name, numberOfBytes };
  }

  const fn = FUNCTION_RE.exec(id);
  if (fn) {
    return { family: 'function', kind: fn[1] as 'external' | 'internal', bytes: numberOfBytes };
  }

  throw new UnsupportedTypeError(label, id, 'unrecognised value type');
}

/**
 * Accept either a solc type identifier (`t_bytes32`) or a plain type string (`bytes32`).
 *
 * @param type - The underlying type as supplied in `userDefinedValueTypes`.
 * @returns The type in identifier form, with a `t_` prefix.
 */
function normalizeTypeIdentifier(type: string): string {
  return type.startsWith('t_') ? type : `t_${type}`;
}

// ---------------------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------------------

/**
 * Find a storage variable by name, and by declaring contract when the name alone is not
 * enough.
 *
 * A label can occur more than once: a `private` variable of a base contract may be declared
 * again in a derived contract, and both occupy storage. Such a name is never resolved
 * silently; `options.declaredIn` selects one declaration.
 *
 * @param layout - The parsed layout to search.
 * @param name - Exact, case-sensitive variable name.
 * @param options - Optional narrowing of the lookup.
 * @param options.declaredIn - The contract that declares the variable: either the
 *   fully-qualified `source/path.sol:ContractName` recorded in
 *   {@link StorageVariable.declaredIn}, or the bare contract name after its last `:`. A
 *   variable whose declaring contract the layout does not record never matches.
 * @returns The one variable with that label (declared by that contract, when given).
 * @throws {VariableNotFoundError} when no variable has that name, with a distinct message
 *   when the name is known to be a `constant`/`immutable` (which solc never emits into
 *   `storageLayout` at all); or when `declaredIn` is given and no variable of that name is
 *   declared by it, with a message listing the contracts that do declare the name.
 * @throws {AmbiguousVariableError} when more than one variable has that name and
 *   `declaredIn` is absent, or is a bare contract name that more than one of them matches.
 */
export function getVariable(
  layout: ParsedStorageLayout,
  name: string,
  options: { readonly declaredIn?: string } = {}
): StorageVariable {
  const { declaredIn } = options;
  const named = layout.variables.filter((variable) => variable.label === name);
  const contractName =
    layout.contractName === undefined ? {} : { contractName: layout.contractName };
  if (named.length === 0) {
    throw new VariableNotFoundError(name, {
      ...contractName,
      isConstantOrImmutable: layout.constantAndImmutableNames.has(name),
      availableNames: layout.variables.map((variable) => variable.label),
    });
  }

  const matches =
    declaredIn === undefined
      ? named
      : named.filter(
          (variable) =>
            variable.declaredIn !== undefined &&
            (variable.declaredIn === declaredIn ||
              variable.declaredIn.slice(variable.declaredIn.lastIndexOf(':') + 1) === declaredIn)
        );
  const [found] = matches;
  if (found === undefined) {
    throw new VariableNotFoundError(name, {
      ...contractName,
      isConstantOrImmutable: false,
      availableNames: layout.variables.map((variable) => variable.label),
      declaredIn,
      declaringContracts: named.flatMap((variable) =>
        variable.declaredIn === undefined ? [] : [variable.declaredIn]
      ),
    });
  }
  if (matches.length > 1) {
    throw new AmbiguousVariableError(
      name,
      matches.map((variable) => variable.declaredIn ?? UNKNOWN_DECLARING_CONTRACT),
      layout.contractName
    );
  }
  return found;
}

/**
 * Look up a type by identifier.
 *
 * @param layout - The parsed layout whose type table is searched.
 * @param typeId - solc type identifier, e.g. one taken from a variable, member or element.
 * @returns The parsed type.
 * @throws {UnsupportedTypeError} when the layout references a type it does not define.
 */
export function getTypeInfo(layout: ParsedStorageLayout, typeId: string): TypeInfo {
  const found = layout.types[typeId];
  if (found === undefined) {
    throw new UnsupportedTypeError(typeId, typeId, 'type is not present in the layout');
  }
  return found;
}

// ---------------------------------------------------------------------------------------
// AST helpers (Hardhat-free — they take plain solc output)
// ---------------------------------------------------------------------------------------

/** The minimal shape of a solc AST node this file relies on. */
interface AstNode {
  /** solc's node discriminator, e.g. `VariableDeclaration`; an object without one is not a node. */
  readonly nodeType?: string;
  /** Every other property is untyped; callers narrow each one before using it. */
  readonly [key: string]: unknown;
}

/**
 * Depth-first walk over arbitrary solc AST JSON, calling `visit` for every node.
 *
 * It does not rely on knowing which properties hold children: it descends into every array
 * element and every object property, and treats any object with a string `nodeType` as a
 * node. A parent is visited before its descendants. Non-object input is ignored.
 *
 * @param node - The AST root, or any value found inside it.
 * @param visit - Called once per node.
 */
function walkAst(node: unknown, visit: (node: AstNode) => void): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, visit);
    return;
  }
  const record = node as AstNode;
  if (typeof record.nodeType === 'string') visit(record);
  for (const key of Object.keys(record)) walkAst(record[key], visit);
}

/**
 * Build the `userDefinedValueTypes` map {@link parseStorageLayout} needs, from one or more
 * solc source ASTs (`output.sources[*].ast`).
 *
 * Required because `storageLayout` alone cannot tell `type Id is bytes32` from
 * `type Id is uint256` — same `numberOfBytes`, no underlying type recorded — yet the two
 * pad in opposite directions as mapping keys.
 *
 * @remarks
 * Each definition is recorded under its AST id and under its name. For an id seen more than
 * once the last definition wins; for a name the first one wins. {@link parseStorageLayout}
 * consults the id before the name, so the name entry only matters when the id in the layout's
 * type identifier is not among the keys.
 *
 * @param asts - Source ASTs to scan; values that are not objects are skipped.
 * @returns Underlying type identifiers (e.g. `t_bytes32`) keyed by AST id and by name. The
 *   object has no prototype, so a type named `toString` or `__proto__` is an ordinary key.
 */
export function extractUserDefinedValueTypes(...asts: readonly unknown[]): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const ast of asts) {
    walkAst(ast, (node) => {
      if (node.nodeType !== 'UserDefinedValueTypeDefinition') return;
      const underlying = node.underlyingType as
        | { readonly typeDescriptions?: { readonly typeIdentifier?: string } }
        | undefined;
      const identifier = underlying?.typeDescriptions?.typeIdentifier;
      if (typeof identifier !== 'string') return;
      if (typeof node.id === 'number') out[String(node.id)] = identifier;
      if (typeof node.name === 'string' && out[node.name] === undefined) {
        out[node.name] = identifier;
      }
    });
  }
  return out;
}

/**
 * Collect `constant`/`immutable` state-variable names from one or more solc source ASTs.
 *
 * The names are not scoped by contract: a constant declared by any contract in the given ASTs
 * is included, so pass only the ASTs relevant to the contract being read.
 *
 * @param asts - Source ASTs to scan; values that are not objects are skipped.
 * @returns The distinct names, in the order first encountered.
 */
export function extractConstantAndImmutableNames(...asts: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const ast of asts) {
    walkAst(ast, (node) => {
      if (node.nodeType !== 'VariableDeclaration') return;
      if (node.stateVariable !== true) return;
      const mutability = node.mutability;
      if (mutability !== 'constant' && mutability !== 'immutable') return;
      if (typeof node.name === 'string') out.add(node.name);
    });
  }
  return [...out];
}

/**
 * Build the `declaringContracts` map {@link parseStorageLayout} needs, from one or more solc
 * source ASTs (`output.sources[*].ast`).
 *
 * Required because `storageLayout` does not say which contract declares a variable: its
 * `contract` field names the contract the layout was generated for, on every entry. When a
 * base contract and a derived one each declare a private variable of the same name, the AST
 * id is the only thing that tells the two storage entries apart.
 *
 * @remarks
 * A contract is recorded as `<source path>:<name>`, the source path being the `absolutePath`
 * of the enclosing source unit; when a contract is not inside a source unit that has one, the
 * bare contract name is recorded. Only variables declared directly in a contract are listed —
 * not locals, parameters, struct members or file-level constants. Pass the AST of every source
 * the contract inherits from, since a base contract may live in another file.
 *
 * @param asts - Source ASTs to scan; values that are not objects are skipped.
 * @returns The declaring contract of each state variable, keyed by the declaration's AST id.
 */
export function extractDeclaringContracts(...asts: readonly unknown[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ast of asts) {
    let sourcePath: string | undefined;
    walkAst(ast, (node) => {
      // A parent is visited before its descendants, so the path is set before its contracts.
      if (node.nodeType === 'SourceUnit') {
        sourcePath = typeof node.absolutePath === 'string' ? node.absolutePath : undefined;
        return;
      }
      if (node.nodeType !== 'ContractDefinition' || typeof node.name !== 'string') return;
      const contract = sourcePath === undefined ? node.name : `${sourcePath}:${node.name}`;
      const members: readonly unknown[] = Array.isArray(node.nodes) ? node.nodes : [];
      for (const member of members) {
        if (member === null || typeof member !== 'object') continue;
        const declaration = member as AstNode;
        if (declaration.nodeType !== 'VariableDeclaration') continue;
        if (declaration.stateVariable !== true || typeof declaration.id !== 'number') continue;
        out[String(declaration.id)] = contract;
      }
    });
  }
  return out;
}
