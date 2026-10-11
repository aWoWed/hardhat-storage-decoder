/**
 * Slot derivation: turns a variable name plus an explicit path (mapping keys, array indexes,
 * struct fields) into the storage slot, byte offset and type of the value it addresses.
 *
 * This is the middle of the pipeline. It takes the {@link ParsedStorageLayout} produced by the
 * layout parser and yields a {@link ReadPlan} plus any {@link BoundsObligation}s; the query
 * layer then performs the reads and hands the words to the decoder. Everything in this file is
 * pure and synchronous: no RPC, no file access.
 */

import {
  getTypeInfo,
  getVariable,
  type ParsedStorageLayout,
  type TypeInfo,
  type ValueKind,
} from '../layout/parseStorageLayout.js';
import {
  IndexOutOfBoundsError,
  PathSegmentCountMismatchError,
  PathSegmentKindMismatchError,
  UnsupportedTypeError,
} from '../query/errors.js';
import {
  WORD_SIZE,
  bigIntToBytes,
  bytesToBigInt,
  concatBytes,
  hexToBytes,
  keccak256,
  rightPad32,
  utf8ToBytes,
} from '../util/bytes.js';

// ---------------------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------------------

/**
 * A value usable as a mapping key. Coercion is governed by the key type, not by JS type.
 *
 * See {@link encodeMappingKey} for which JS types each Solidity key type accepts.
 */
export type MappingKeyValue = string | number | bigint | boolean | Uint8Array;

/**
 * One level of the path, with the kind stated explicitly so a mapping key, an array index,
 * and a struct field can never be confused for one another.
 *
 * Variants:
 *  - `kind: 'key'` — a mapping lookup; `value` is the key, encoded according to the mapping's
 *    declared key type.
 *  - `kind: 'index'` — an element of a fixed or dynamic array; `value` is the zero-based index
 *    and must be a non-negative integer.
 *  - `kind: 'field'` — a struct member; `name` is the member's Solidity name, matched exactly.
 */
export type PathSegment =
  | { readonly kind: 'key'; readonly value: MappingKeyValue }
  | { readonly kind: 'index'; readonly value: number | bigint }
  | { readonly kind: 'field'; readonly name: string };

/** The value lives entirely in one slot (possibly packed within it). */
export interface SingleSlotPlan {
  /** Discriminant of {@link ReadPlan}. */
  readonly kind: 'single';
  /** Absolute slot number holding the value. */
  readonly slot: bigint;
}

/**
 * A `string`/`bytes` value, whose length — and therefore whether it lives in the header slot
 * at all — is only knowable by reading. Phase 1 reads `headerSlot`; phase 2 reads from
 * `dataBaseSlot` if the header says the value is long.
 */
export interface MultiSlotPlan {
  /** Discriminant of {@link ReadPlan}. */
  readonly kind: 'multi';
  /** The variable's own slot: holds the encoded length and, for a short value, the data too. */
  readonly headerSlot: bigint;
  /** `keccak256(headerSlot)` — the first data slot of a long value. Unused for a short one. */
  readonly dataBaseSlot: bigint;
}

/**
 * Which slots must be read to obtain a terminal value: one slot known up front
 * ({@link SingleSlotPlan}, every value type), or a header slot plus zero or more data slots
 * whose count depends on the header's contents ({@link MultiSlotPlan}, `string`/`bytes`).
 */
export type ReadPlan = SingleSlotPlan | MultiSlotPlan;

/**
 * A bounds check the pure walk could not perform itself, because a dynamic array's length
 * lives in storage. The driver reads `lengthSlot` and compares against `index`.
 */
export interface BoundsObligation {
  /** The dynamic array's own declared slot, which stores its length. */
  readonly lengthSlot: bigint;
  /** The requested index; valid only if strictly less than the stored length. */
  readonly index: bigint;
  /** Solidity label of the array type, used in the out-of-bounds message. */
  readonly typeLabel: string;
  /** Name of the root variable the path started from, used in the out-of-bounds message. */
  readonly variableName: string;
  /** Zero-based position in the path of the index segment that produced this obligation. */
  readonly segmentIndex: number;
}

/**
 * What {@link deriveSlot} returns: the terminal's read plan and decoding details, plus the
 * bounds checks that still have to be made against storage before the value can be trusted.
 */
export interface DeriveSlotResult extends TerminalDescriptor {
  /** In path order, outermost first — so the outermost failure is the one reported. */
  readonly obligations: readonly BoundsObligation[];
  /** The variable name the walk started from, echoed back unchanged. */
  readonly variableName: string;
}

// ---------------------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------------------

/** Where a walk currently stands: a slot, a byte offset within it, and the type found there. */
export interface PathPosition {
  /** Absolute slot number of the position. */
  readonly slot: bigint;
  /** Byte offset within `slot`, counted from the least significant end as solc reports it. */
  readonly offset: number;
  /** Layout type identifier of what is stored there, e.g. `t_uint256`. */
  readonly typeId: string;
}

/** Everything needed to read and decode a terminal (value or `string`/`bytes`) position. */
export interface TerminalDescriptor {
  /** The slots to read: single for a value type, multi for `string`/`bytes`. */
  readonly readPlan: ReadPlan;
  /** Byte offset WITHIN the resulting slot. Never folded into the slot number. */
  readonly offset: number;
  /** Layout type identifier of the terminal type, e.g. `t_address`. */
  readonly typeId: string;
  /** Solidity type label, e.g. `address`. */
  readonly typeLabel: string;
  /** Size solc reports for the type, in bytes — the width of the packed window to extract. */
  readonly numberOfBytes: number;
  /** The resolved leaf kind that selects the decoding rule. */
  readonly valueKind: ValueKind;
}

/**
 * Resolve a variable plus an ordered path to a storage read plan.
 *
 * Pure and synchronous: it performs no I/O, ever. Where a bounds check would need to read an
 * array length, it emits a {@link BoundsObligation} instead and lets the driver resolve it.
 * Structure is decided by `TypeInfo.kind` alone; nothing here pattern-matches type names.
 *
 * @param layout - The parsed storage layout of the contract being read.
 * @param variableName - Name of the top-level storage variable the path starts from.
 * @param segments - The path, outermost first. It must reach a terminal type exactly: one
 *   segment per mapping, array or struct level, and none after a value or `string`/`bytes`.
 * @param options - Optional narrowing of the variable lookup.
 * @param options.declaredIn - The contract that declares the variable, for a name declared
 *   more than once in the inheritance chain; matched as described on `getVariable`.
 * @returns The terminal's read plan and decoding details, the bounds obligations collected
 *   along the way (one per dynamic-array index, in path order) and the variable name.
 * @throws {VariableNotFoundError} when `variableName` is not a storage variable of the layout,
 *   or none of that name is declared by `options.declaredIn`.
 * @throws {AmbiguousVariableError} when more than one storage variable has that name and
 *   `options.declaredIn` does not single one out.
 * @throws {PathSegmentCountMismatchError} when the path stops on a mapping, array or struct,
 *   or continues past a terminal type.
 * @throws {PathSegmentKindMismatchError} when a segment's kind does not suit the type at its
 *   position, or a `field` segment names a member the struct does not have.
 * @throws {IndexOutOfBoundsError} when an index is negative or not an integer, or is past the
 *   end of a fixed array. Dynamic-array bounds are not checked here.
 * @throws {UnsupportedTypeError} when the layout lacks a type the walk needs or a detail of
 *   it, an array element reports a size of zero bytes, a fixed array's length or an array
 *   element's size is beyond `Number.MAX_SAFE_INTEGER`, or a mapping's key type cannot be
 *   encoded (including a user-defined value type whose underlying type is unknown, and a
 *   function type).
 * @throws {TypeError} when a mapping key value cannot be coerced to the mapping's key type,
 *   or an index is `NaN`, infinite, or not a number or bigint; or when a `number` key or
 *   index is an integer beyond `Number.MAX_SAFE_INTEGER`, which must be passed as a `bigint`.
 */
export function deriveSlot(
  layout: ParsedStorageLayout,
  variableName: string,
  segments: readonly PathSegment[],
  options: { readonly declaredIn?: string } = {}
): DeriveSlotResult {
  const variable = getVariable(layout, variableName, options);

  let position: PathPosition = {
    slot: variable.slot,
    offset: variable.offset,
    typeId: variable.typeId,
  };
  const obligations: BoundsObligation[] = [];
  let consumed = 0;

  for (;;) {
    const type = getTypeInfo(layout, position.typeId);

    if (isTerminalType(type)) {
      assertNoSegmentsPastTerminal(type, variableName, consumed, segments.length);
      return { ...terminalPlan(layout, position), obligations, variableName };
    }

    // -- Composite types need another segment -------------------------------------------
    const segment = segments[consumed];
    if (segment === undefined) {
      const expected = consumed + minimumRemainingSegments(layout, position.typeId);
      throw new PathSegmentCountMismatchError(
        variableName,
        segments.length,
        `the path stops at "${type.label}", which still needs ${describeRequirement(type)}` +
          ` — expected at least ${expected} segment(s)`,
        expected
      );
    }

    const step = stepSegment(layout, position, segment, { variableName, segmentIndex: consumed });
    if (step.obligation !== undefined) obligations.push(step.obligation);
    position = step.position;
    consumed += 1;
  }
}

/**
 * True for the types a path can end on: value types and `string`/`bytes`.
 *
 * @param type - A parsed type from the layout.
 * @returns Whether a path may end on `type`.
 */
export function isTerminalType(type: TypeInfo): boolean {
  return type.kind === 'value' || type.kind === 'dynamicBytes';
}

/**
 * Reject a path that keeps going after reaching a terminal type.
 *
 * It does not check that `type` is terminal; the caller establishes that with
 * {@link isTerminalType} first.
 *
 * @param type - The terminal type the walk has reached; only its label is used, in the message.
 * @param variableName - Name of the root variable, for the message.
 * @param consumed - Number of segments used to reach `type`.
 * @param given - Total number of segments in the path.
 * @throws {PathSegmentCountMismatchError} when `consumed` is less than `given`, with
 *   `expected` set to `consumed`.
 */
export function assertNoSegmentsPastTerminal(
  type: TypeInfo,
  variableName: string,
  consumed: number,
  given: number
): void {
  if (consumed < given) {
    throw new PathSegmentCountMismatchError(
      variableName,
      given,
      `the path reaches "${type.label}" after ${consumed} segment(s), which is a terminal` +
        ` type, but ${given - consumed} more segment(s) were given`,
      consumed
    );
  }
}

/**
 * The read plan and decoding details for a terminal position.
 *
 * A value type yields a single-slot plan at the position's own slot and offset. A
 * `string`/`bytes` yields a multi-slot plan with offset 0, whatever the stored length.
 *
 * @param layout - The parsed storage layout the position belongs to.
 * @param position - A position whose type is terminal (see {@link isTerminalType}).
 * @returns The descriptor the query layer needs to read and decode the value.
 * @throws {UnsupportedTypeError} when the position's type is missing from the layout, or has
 *   no resolved value kind — which is the case for any non-terminal type.
 */
export function terminalPlan(
  layout: ParsedStorageLayout,
  position: PathPosition
): TerminalDescriptor {
  const type = getTypeInfo(layout, position.typeId);
  const valueKind = required(
    type.valueKind,
    () => new UnsupportedTypeError(type.label, type.id, 'missing resolved value kind')
  );
  if (type.kind === 'value') {
    return {
      readPlan: { kind: 'single', slot: position.slot },
      offset: position.offset,
      typeId: type.id,
      typeLabel: type.label,
      numberOfBytes: type.numberOfBytes,
      valueKind,
    };
  }
  // `string`/`bytes`. Short vs. long is a property of the stored VALUE, not of the type,
  // so it cannot be decided here. Always emit a multi plan and let phase 1 collapse it.
  return {
    readPlan: {
      kind: 'multi',
      headerSlot: position.slot,
      dataBaseSlot: hashOfSlot(position.slot),
    },
    offset: 0,
    typeId: type.id,
    typeLabel: type.label,
    numberOfBytes: type.numberOfBytes,
    valueKind,
  };
}

/**
 * Take one step from a composite position: a mapping key, an array index, or a struct field.
 *
 * Slot arithmetic per kind:
 *  - mapping: `keccak256(encodedKey ++ slot)` with the slot as a 32-byte big-endian word, offset 0
 *  - dynamic array: elements start at `keccak256(slot)`, the slot again as a 32-byte word
 *  - fixed array: elements start at `slot` itself
 *  - struct: `slot + member.slot`, with the member's own byte offset
 *
 * Every sum is reduced modulo 2^256, as the EVM computes storage locations: an element or
 * member past the last slot continues at slot 0.
 *
 * @param layout - The parsed storage layout the position belongs to.
 * @param position - The composite position to step from. Its byte offset is not used:
 *   mappings, arrays and structs always start at offset 0 of their slot.
 * @param segment - The path segment to apply; its kind must suit the type at `position`.
 * @param where - Context used only in error messages and in the returned obligation.
 * @param where.variableName - Name of the root variable the path started from.
 * @param where.segmentIndex - Zero-based position of `segment` in the whole path.
 * @returns The position of the addressed element, key or member, plus — for a dynamic array
 *   only — the `obligation` to check the index against the array's stored length.
 * @throws {PathSegmentKindMismatchError} when the segment kind does not suit the type, or a
 *   `field` segment names a member the struct does not have.
 * @throws {IndexOutOfBoundsError} when the index is negative or not an integer, or is greater
 *   than or equal to a fixed array's length.
 * @throws {UnsupportedTypeError} when `position` is a terminal type, a type is missing from
 *   the layout or lacks its key, value, element, length or member details, an array element
 *   reports a size of zero bytes, a fixed array's length or an array element's size is
 *   beyond `Number.MAX_SAFE_INTEGER`, or the mapping's key type cannot be encoded.
 * @throws {TypeError} when a mapping key value cannot be coerced to the mapping's key type,
 *   or the index is `NaN`, infinite, or not a number or bigint; or when a `number` key or
 *   index is an integer beyond `Number.MAX_SAFE_INTEGER`.
 */
export function stepSegment(
  layout: ParsedStorageLayout,
  position: PathPosition,
  segment: PathSegment,
  where: { readonly variableName: string; readonly segmentIndex: number }
): { readonly position: PathPosition; readonly obligation?: BoundsObligation } {
  const { variableName, segmentIndex } = where;
  const { slot } = position;
  const type = getTypeInfo(layout, position.typeId);

  switch (type.kind) {
    case 'mapping': {
      if (segment.kind !== 'key') {
        throw new PathSegmentKindMismatchError(
          variableName,
          segmentIndex,
          `"${type.label}" is a mapping and needs a key (.key(...)), but ${describeSegment(segment)}` +
            ` was given`
        );
      }
      const keyTypeId = required(
        type.keyTypeId,
        () => new UnsupportedTypeError(type.label, type.id, 'mapping is missing its key type')
      );
      const keyType = getTypeInfo(layout, keyTypeId);
      const encodedKey = encodeMappingKey(keyType, segment.value);
      return {
        position: {
          slot: bytesToBigInt(keccak256(concatBytes(encodedKey, bigIntToBytes(slot, WORD_SIZE)))),
          offset: 0,
          typeId: required(
            type.valueTypeId,
            () => new UnsupportedTypeError(type.label, type.id, 'mapping is missing its value type')
          ),
        },
      };
    }

    case 'dynamicArray':
    case 'fixedArray': {
      if (segment.kind !== 'index') {
        throw new PathSegmentKindMismatchError(
          variableName,
          segmentIndex,
          `"${type.label}" is an array and needs an index (.index(n)), but` +
            ` ${describeSegment(segment)} was given`
        );
      }
      const index = normalizeIndex(segment.value, type.label, variableName);
      let elementsBase: bigint;
      let obligation: BoundsObligation | undefined;
      if (type.kind === 'dynamicArray') {
        // The length is in storage, so the bounds check is deferred as an obligation.
        obligation = {
          lengthSlot: slot,
          index,
          typeLabel: type.label,
          variableName,
          segmentIndex,
        };
        elementsBase = hashOfSlot(slot);
      } else {
        const length = BigInt(
          required(
            type.fixedLength,
            () =>
              new UnsupportedTypeError(
                type.label,
                type.id,
                type.oversized ?? 'fixed array has no parsed length'
              )
          )
        );
        // A fixed array's length is static, so this bounds check needs no obligation.
        if (index >= length) {
          throw new IndexOutOfBoundsError(index, length, type.label, variableName);
        }
        elementsBase = slot;
      }
      const baseTypeId = required(
        type.baseTypeId,
        () => new UnsupportedTypeError(type.label, type.id, 'array is missing its element type')
      );
      const placed = placeArrayElement(elementsBase, index, getTypeInfo(layout, baseTypeId));
      return {
        position: { slot: placed.slot, offset: placed.offset, typeId: baseTypeId },
        ...(obligation === undefined ? {} : { obligation }),
      };
    }

    case 'struct': {
      if (segment.kind !== 'field') {
        throw new PathSegmentKindMismatchError(
          variableName,
          segmentIndex,
          `"${type.label}" is a struct and needs a field name (.field("name")), but` +
            ` ${describeSegment(segment)} was given`
        );
      }
      const members = required(
        type.members,
        () => new UnsupportedTypeError(type.label, type.id, 'struct is missing its members')
      );
      const member = members.find((candidate) => candidate.label === segment.name);
      if (member === undefined) {
        throw new PathSegmentKindMismatchError(
          variableName,
          segmentIndex,
          `"${type.label}" has no field "${segment.name}"` +
            ` (available: ${members.map((m) => m.label).join(', ')})`
        );
      }
      return {
        position: {
          slot: wrapSlot(slot + member.slot),
          offset: member.offset,
          typeId: member.typeId,
        },
      };
    }

    default:
      throw new UnsupportedTypeError(type.label, type.id, 'a terminal type takes no path segment');
  }
}

/**
 * Packing-aware placement of element `index` of an array whose elements start at `base`.
 *
 * Two branches, and the difference matters:
 *  - `B <= 32`: `floor(32 / B)` elements share a slot. When `32 % B !== 0` (e.g. `uint96`,
 *    2 per slot with 8 bytes unused) the trailing gap must NOT be filled by the next element,
 *    which is exactly what a naive `index * B / 32` stride would do.
 *  - `B > 32`: each element occupies `ceil(B / 32)` whole slots and starts at offset 0.
 *
 * The slot is reduced modulo 2^256, so an index of any size yields a valid slot number.
 *
 * @param base - Slot of element 0: the array's own slot for a fixed array, `keccak256` of it
 *   for a dynamic one.
 * @param index - Zero-based element index, already validated as non-negative.
 * @param elementType - The array's element type; `B` above is its `numberOfBytes`.
 * @returns The element's slot and its byte offset within that slot.
 * @throws {UnsupportedTypeError} when the element type reports a size of zero bytes or less,
 *   or is marked `oversized` (its size is rounded, so no element slot can be computed).
 */
function placeArrayElement(
  base: bigint,
  index: bigint,
  elementType: TypeInfo
): { slot: bigint; offset: number } {
  if (elementType.oversized !== undefined) {
    throw new UnsupportedTypeError(elementType.label, elementType.id, elementType.oversized);
  }
  const elementBytes = elementType.numberOfBytes;
  if (elementBytes <= 0) {
    throw new UnsupportedTypeError(
      elementType.label,
      elementType.id,
      'element type reports a size of zero bytes'
    );
  }
  if (elementBytes <= WORD_SIZE) {
    const elementsPerSlot = BigInt(Math.floor(WORD_SIZE / elementBytes));
    return {
      slot: wrapSlot(base + index / elementsPerSlot),
      offset: Number((index % elementsPerSlot) * BigInt(elementBytes)),
    };
  }
  const slotsPerElement = BigInt(Math.ceil(elementBytes / WORD_SIZE));
  return { slot: wrapSlot(base + index * slotsPerElement), offset: 0 };
}

/**
 * Reduce a slot number modulo 2^256, the way the EVM computes a storage location reached by
 * addition.
 *
 * @param slot - A non-negative slot number, possibly 2^256 or more.
 * @returns The slot within `[0, 2^256)`.
 */
export function wrapSlot(slot: bigint): bigint {
  return BigInt.asUintN(WORD_SIZE * 8, slot);
}

/**
 * keccak256 of the slot number encoded as a 32-byte big-endian word — the base of a dynamic
 * array's elements or a long value's data.
 *
 * @param slot - The slot number to hash.
 * @returns The hash, read as an unsigned big-endian slot number.
 */
function hashOfSlot(slot: bigint): bigint {
  return bytesToBigInt(keccak256(bigIntToBytes(slot, WORD_SIZE)));
}

// ---------------------------------------------------------------------------------------
// Mapping key encoding
// ---------------------------------------------------------------------------------------

/**
 * Produce the key half of a mapping slot's keccak preimage.
 *
 * Three different alignments, dispatched on the RESOLVED underlying type — a user-defined
 * value type follows its underlying type's rule, not a blanket one:
 *  - value types (uint/int/bool/address/enum/contract): left-padded to 32 bytes, signed
 *    integers two's-complement sign-extended
 *  - `bytesN`: RIGHT-padded to 32 bytes
 *  - `string`/`bytes`: not padded at all
 *
 * Accepted JS values per key type:
 *  - `uint`/`int` (and enums): a bigint, an integer number, a boolean (0 or 1), a string that
 *    `BigInt()` parses (for example decimal or `0x` hex), or a `Uint8Array` read as
 *    big-endian unsigned. The result must fit the declared width. An empty or
 *    whitespace-only string is rejected, although `BigInt()` would read it as 0. A number
 *    beyond `Number.MAX_SAFE_INTEGER` is rejected too: JavaScript may already have rounded
 *    it, so it must be given as a bigint or a string.
 *  - `bool`: a boolean, or any of the integer forms above (non-zero is `true`).
 *  - `address` (and contract types): a hex string or `Uint8Array` of exactly 20 bytes.
 *  - `bytesN`: a hex string or `Uint8Array` of at most `N` bytes; a shorter one is padded.
 *  - `string`: a JS string, encoded as UTF-8.
 *  - `bytes`: a hex string or `Uint8Array`, used as is.
 *
 * @param keyType - The mapping's declared key type, as found in the parsed layout.
 * @param value - The key supplied by the caller.
 * @returns The encoded key: 32 bytes for value types, the raw bytes for `string`/`bytes`.
 * @throws {UnsupportedTypeError} when `keyType` is not a value or `string`/`bytes` type, has
 *   no resolved value kind, is a user-defined value type whose underlying type is unknown, or
 *   is a function type (which Solidity does not allow as a mapping key).
 * @throws {TypeError} when `value` has a JS type the key type does not accept, is not a valid
 *   integer or hex string, is out of range for the integer width, has the wrong byte length,
 *   or is a `number` that is an integer beyond `Number.MAX_SAFE_INTEGER`.
 */
export function encodeMappingKey(keyType: TypeInfo, value: MappingKeyValue): Uint8Array {
  const valueKind = keyType.valueKind;
  if (
    (keyType.kind !== 'value' && keyType.kind !== 'dynamicBytes') ||
    valueKind === undefined
  ) {
    throw new UnsupportedTypeError(
      keyType.label,
      keyType.id,
      'this type cannot be used as a mapping key'
    );
  }

  switch (valueKind.family) {
    case 'uint': {
      const parsed = toBigIntValue(value, keyType.label);
      if (parsed < 0n) {
        throw new TypeError(
          `mapping key of unsigned type ${keyType.label} must not be negative, got ${parsed}`
        );
      }
      const max = (1n << BigInt(valueKind.bits)) - 1n;
      if (parsed > max) {
        throw new TypeError(
          `mapping key of type ${keyType.label} must fit in ${valueKind.bits} bits` +
            ` (0..${max}), got ${parsed}`
        );
      }
      return bigIntToBytes(parsed, WORD_SIZE);
    }
    case 'int': {
      // Range-checked first: bigIntToBytes would wrap an out-of-range value into a plausible
      // wrong key. In range, its 32-byte two's complement is the sign extension the key needs.
      const parsed = toBigIntValue(value, keyType.label);
      const half = 1n << BigInt(valueKind.bits - 1);
      if (parsed < -half || parsed > half - 1n) {
        throw new TypeError(
          `mapping key of type ${keyType.label} must fit in ${valueKind.bits} bits` +
            ` (${-half}..${half - 1n}), got ${parsed}`
        );
      }
      return bigIntToBytes(parsed, WORD_SIZE);
    }
    case 'bool': {
      const flag =
        typeof value === 'boolean' ? value : toBigIntValue(value, keyType.label) !== 0n;
      return bigIntToBytes(flag ? 1n : 0n, WORD_SIZE);
    }
    case 'address': {
      const bytes = toByteArray(value, keyType.label);
      if (bytes.length !== 20) {
        throw new TypeError(
          `mapping key of type ${keyType.label} must be a 20-byte address, got ${bytes.length} byte(s)`
        );
      }
      return bigIntToBytes(bytesToBigInt(bytes), WORD_SIZE);
    }
    case 'bytesN': {
      const bytes = toByteArray(value, keyType.label);
      if (bytes.length > valueKind.size) {
        throw new TypeError(
          `mapping key of type ${keyType.label} must be at most ${valueKind.size} byte(s),` +
            ` got ${bytes.length}`
        );
      }
      // RIGHT-padded — the opposite direction from every other value type here.
      return rightPad32(bytes);
    }
    case 'string':
      if (typeof value !== 'string') {
        throw new TypeError(
          `mapping key of type ${keyType.label} must be a string, got ${describeValue(value)}`
        );
      }
      return utf8ToBytes(value);
    case 'bytes':
      return toByteArray(value, keyType.label);
    case 'unresolvedUserDefinedValueType':
      throw new UnsupportedTypeError(
        keyType.label,
        keyType.id,
        `the underlying type of user-defined value type "${valueKind.name}" is unknown, and its` +
          ` padding direction depends on it (a bytesN-backed type right-pads, an int-backed type` +
          ` sign-extends). Supply it via parseStorageLayout's "userDefinedValueTypes" option` +
          ` (see extractUserDefinedValueTypes)`
      );
    case 'function':
      throw new UnsupportedTypeError(
        keyType.label,
        keyType.id,
        `a function type (${valueKind.kind}) cannot be used as a mapping key`
      );
  }
}

/**
 * Coerce a mapping key to an integer, for the `uint`, `int` and `bool` key families.
 *
 * Accepted forms are listed on {@link encodeMappingKey}. No range check is made here.
 *
 * @param value - The key supplied by the caller.
 * @param typeLabel - Solidity label of the key type, for the error message.
 * @returns The key as a bigint.
 * @throws {TypeError} when `value` is a non-integer number, an integer number beyond
 *   `Number.MAX_SAFE_INTEGER` (every double that large is an integer, so the value that
 *   arrives need not be the one the caller wrote), a string that is blank or that `BigInt()`
 *   rejects, or not one of the accepted JS types.
 */
function toBigIntValue(value: MappingKeyValue, typeLabel: string): bigint {
  switch (typeof value) {
    case 'bigint':
      return value;
    case 'boolean':
      return value ? 1n : 0n;
    case 'number':
      if (!Number.isInteger(value)) {
        throw new TypeError(
          `mapping key of type ${typeLabel} must be an integer, got ${value}` +
            ` (use a bigint for values beyond Number.MAX_SAFE_INTEGER)`
        );
      }
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(
          `mapping key of type ${typeLabel} is the number ${value}, which is beyond` +
            ` Number.MAX_SAFE_INTEGER and may already have been rounded; pass it as a bigint`
        );
      }
      return BigInt(value);
    case 'string':
      try {
        // BigInt('') and BigInt('  ') are 0n: a blank key would silently address key 0.
        if (value.trim() !== '') return BigInt(value);
      } catch {
        // Not an integer literal; reported together with the blank case below.
      }
      throw new TypeError(`mapping key of type ${typeLabel} is not a valid integer: "${value}"`);
    default:
      if (value instanceof Uint8Array) return bytesToBigInt(value);
      throw new TypeError(
        `mapping key of type ${typeLabel} has unsupported value ${describeValue(value)}`
      );
  }
}

/**
 * Coerce a mapping key to raw bytes, for the `address`, `bytesN` and `bytes` key families.
 *
 * @param value - The key supplied by the caller: a `Uint8Array`, returned as is, or a hex
 *   string with or without a `0x` prefix.
 * @param typeLabel - Solidity label of the key type, for the error message.
 * @returns The key's bytes, unpadded.
 * @throws {TypeError} when `value` is neither a string nor a `Uint8Array`, or is a string
 *   that is not valid even-length hex.
 */
function toByteArray(value: MappingKeyValue, typeLabel: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return hexToBytes(value);
  throw new TypeError(
    `mapping key of type ${typeLabel} must be a hex string or Uint8Array, got ${describeValue(value)}`
  );
}

// ---------------------------------------------------------------------------------------
// Validation and diagnostics helpers
// ---------------------------------------------------------------------------------------

/**
 * Validate an array index and convert it to a bigint.
 *
 * Only the shape of the index is checked. Comparing it against the array's length is the
 * caller's job, because for a dynamic array that length is in storage.
 *
 * @param value - The index supplied by the caller.
 * @param typeLabel - Solidity label of the array type, for the error message.
 * @param variableName - Name of the root variable, for the error message.
 * @returns The index as a non-negative bigint.
 * @throws {IndexOutOfBoundsError} when `value` is a finite non-integer number (reported
 *   truncated toward zero) or is negative. The error's `length` is `undefined` in both cases.
 * @throws {TypeError} when `value` is `NaN` or infinite (neither converts to a bigint, so
 *   neither can be carried by `IndexOutOfBoundsError.index`), is not a number or bigint, or
 *   is an integer `number` beyond `Number.MAX_SAFE_INTEGER` (JavaScript may already have
 *   rounded it, so it must be passed as a bigint).
 */
function normalizeIndex(
  value: number | bigint,
  typeLabel: string,
  variableName: string
): bigint {
  if (typeof value !== 'number' && typeof value !== 'bigint') {
    // Unreachable from typed code. Without it `BigInt('')` would make `.index('')` element 0.
    throw new TypeError(
      `index into ${typeLabel} of "${variableName}" must be a number or bigint,` +
        ` got ${describeValue(value)}`
    );
  }
  if (typeof value === 'number' && !Number.isInteger(value)) {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `index into ${typeLabel} of "${variableName}" must be a finite integer, got ${value}`
      );
    }
    throw new IndexOutOfBoundsError(BigInt(Math.trunc(value)), undefined, typeLabel, variableName);
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new TypeError(
      `index into ${typeLabel} of "${variableName}" is the number ${value}, which is beyond` +
        ` Number.MAX_SAFE_INTEGER and may already have been rounded; pass it as a bigint`
    );
  }
  const index = BigInt(value);
  if (index < 0n) {
    throw new IndexOutOfBoundsError(index, undefined, typeLabel, variableName);
  }
  return index;
}

/**
 * Name the segment the caller supplied, for a kind-mismatch message.
 *
 * @param segment - The segment that was given.
 * @returns A noun phrase naming the segment kind and the builder call that produces it.
 */
function describeSegment(segment: PathSegment): string {
  switch (segment.kind) {
    case 'key':
      return 'a mapping key (.key(...))';
    case 'index':
      return 'an array index (.index(...))';
    case 'field':
      return `a struct field (.field("${segment.name}"))`;
  }
}

/**
 * Name the segment a composite type still needs, for a count-mismatch message.
 *
 * @param type - The type the path stopped on.
 * @returns A noun phrase naming the required segment kind and its builder call, or a generic
 *   phrase for a type that is not a mapping, array or struct.
 */
function describeRequirement(type: TypeInfo): string {
  switch (type.kind) {
    case 'mapping':
      return 'a mapping key (.key(...))';
    case 'dynamicArray':
    case 'fixedArray':
      return 'an array index (.index(n))';
    case 'struct':
      return 'a struct field (.field("name"))';
    default:
      return 'another path segment';
  }
}

/**
 * Render a rejected mapping key or index for an error message: its JS type and JSON form,
 * with `null`, `Uint8Array` (shown by length only) and `bigint` (which `JSON.stringify`
 * cannot serialize) special-cased.
 *
 * @param value - The value to describe.
 * @returns E.g. `number 1.5`, `Uint8Array(20)`, `bigint 5n` or `null`.
 */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Uint8Array) return `Uint8Array(${value.length})`;
  if (typeof value === 'bigint') return `bigint ${value}n`;
  return `${typeof value} ${JSON.stringify(value) ?? String(value)}`;
}

/**
 * Smallest number of further segments that could reach a terminal type from `typeId`.
 *
 * Structs branch, so this is a lower bound rather than an exact figure — which is why the
 * count-mismatch message says "at least".
 *
 * @param layout - The parsed storage layout to look types up in.
 * @param typeId - Identifier of the type to measure from.
 * @param visiting - Type identifiers already on the current recursion path, used to stop on a
 *   cyclic type reference.
 * @returns 0 for a terminal type or one missing from the layout; otherwise 1 plus the minimum
 *   over what the type leads to (the shallowest member, for a struct). A type that refers back
 *   to itself yields `Infinity`.
 */
function minimumRemainingSegments(
  layout: ParsedStorageLayout,
  typeId: string,
  visiting: ReadonlySet<string> = new Set()
): number {
  if (visiting.has(typeId)) return Number.POSITIVE_INFINITY;
  const type = layout.types[typeId];
  if (type === undefined) return 0;
  const seen = new Set(visiting).add(typeId);

  switch (type.kind) {
    case 'value':
    case 'dynamicBytes':
      return 0;
    case 'mapping':
      return type.valueTypeId === undefined
        ? 1
        : 1 + minimumRemainingSegments(layout, type.valueTypeId, seen);
    case 'dynamicArray':
    case 'fixedArray':
      return type.baseTypeId === undefined
        ? 1
        : 1 + minimumRemainingSegments(layout, type.baseTypeId, seen);
    case 'struct': {
      const depths = (type.members ?? []).map((member) =>
        minimumRemainingSegments(layout, member.typeId, seen)
      );
      return depths.length === 0 ? 1 : 1 + Math.min(...depths);
    }
  }
}

/** Return an optional layout detail, or throw what `makeError` builds when it is `undefined`. */
function required<T>(value: T | undefined, makeError: () => Error): T {
  if (value === undefined) throw makeError();
  return value;
}
