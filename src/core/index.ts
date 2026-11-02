/**
 * The Hardhat-free core.
 *
 * Nothing in `src/core/**` may import `hardhat` — that invariant is enforced by
 * `npm run typecheck:core` (see `scripts/check-core-purity.mjs`) and is what lets the same
 * engine back both the Hardhat 2 and Hardhat 3 adapters.
 *
 * The adapters import by path. These names are for the unit tests, and for
 * `scripts/oracle-common.mjs` and `scripts/clients/run-client.mjs`, which bundle this file and
 * call them at runtime, where `tsc` cannot see the use: run the oracles after removing one.
 */

export {
  extractConstantAndImmutableNames,
  extractDeclaringContracts,
  extractUserDefinedValueTypes,
  parseStorageLayout,
} from './layout/parseStorageLayout.js';

export {
  AmbiguousVariableError,
  ContractMismatchError,
  ContractNotFoundError,
  DumpInconsistentError,
  DumpTooLargeError,
  IndexOutOfBoundsError,
  PathSegmentCountMismatchError,
  PathSegmentKindMismatchError,
  PrunedStateError,
  StorageDecoderError,
  UnsupportedTypeError,
  VariableNotFoundError,
  classifyReadFailure,
} from './query/errors.js';

export { createStorageDecoder } from './query/StorageQueryBuilder.js';

export { classifyRpcError } from './rpc/classifyRpcError.js';

export { formatBlockTag, formatSlot } from './rpc/getStorageAt.js';

export { hexToBytes } from './util/bytes.js';
