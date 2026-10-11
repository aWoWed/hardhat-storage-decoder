/**
 * The Hardhat-free core.
 *
 * Nothing in `src/core/**` may import `hardhat` — that invariant is enforced by
 * `npm run typecheck:core` (see `scripts/check-core-purity.mjs`) and is what lets the same
 * engine back both the Hardhat 2 and Hardhat 3 adapters.
 */

export {
  extractConstantAndImmutableNames,
  extractDeclaringContracts,
  extractUserDefinedValueTypes,
  getTypeInfo,
  getVariable,
  parseFixedArrayLength,
  parseStorageLayout,
  type Encoding,
  type ParseStorageLayoutOptions,
  type ParsedStorageLayout,
  type RawStorageEntry,
  type RawStorageLayout,
  type RawTypeEntry,
  type StorageVariable,
  type StructMember,
  type TypeInfo,
  type TypeKind,
  type ValueKind,
} from './layout/parseStorageLayout.js';

export {
  deriveSlot,
  encodeMappingKey,
  type BoundsObligation,
  type DeriveSlotResult,
  type MappingKeyValue,
  type MultiSlotPlan,
  type PathSegment,
  type ReadPlan,
  type SingleSlotPlan,
} from './slots/deriveSlot.js';

export {
  decode,
  resolveObligations,
  resolveReadPlan,
  type DecodedValue,
  type DynamicBytesInfo,
  type ResolvedRead,
} from './slots/decode.js';

export {
  AmbiguousVariableError,
  ContractMismatchError,
  ContractNotFoundError,
  DumpInconsistentError,
  DumpTooLargeError,
  IndexOutOfBoundsError,
  PathSegmentCountMismatchError,
  PathSegmentKindMismatchError,
  StorageDecoderError,
  UnsupportedTypeError,
  VariableNotFoundError,
} from './query/errors.js';

export {
  StorageQueryBuilder,
  createStorageDecoder,
  type StorageDecoderContext,
  type StorageReadResult,
} from './query/StorageQueryBuilder.js';

export type { DumpValue, ReadAllOptions, StorageDumpResult } from './query/dump.js';

export {
  formatBlockTag,
  formatSlot,
  parseBlockNumber,
  type BlockTag,
  type GetStorageAt,
  type SingleSlotReader,
  type StorageReadRequest,
} from './rpc/getStorageAt.js';

export {
  bytesToHex,
  hexToBytes,
  keccak256,
  toChecksumAddress,
  toStorageWord,
} from './util/bytes.js';
