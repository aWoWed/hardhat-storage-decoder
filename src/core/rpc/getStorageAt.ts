/**
 * The one I/O primitive this package needs, expressed as an interface only.
 *
 * The Hardhat-major adapters supply concrete implementations:
 *   - HH2: `hre.network.provider.send("eth_getStorageAt", [...])`
 *   - HH3: the provider of a network connection from `hre.network.getOrCreate()`
 *
 * Keeping it an interface is what lets `src/core/**` stay Hardhat-free and lets the unit
 * suite drive the whole pipeline from a plain in-memory slot map.
 */

/**
 * A block specifier for `eth_getStorageAt` and `eth_getCode`.
 *
 * The variants:
 *  - `'latest'`, `'earliest'`, `'pending'`, `'safe'`, `'finalized'`: the JSON-RPC named tags,
 *    sent as they are. All but `'earliest'` can name a different block from one call to the
 *    next.
 *  - `number` / `bigint`: a block number, sent as a `0x` hex quantity by
 *    {@link formatBlockTag}, which rejects a negative or non-integer one, and a `number`
 *    beyond `Number.MAX_SAFE_INTEGER` (pass that as a `bigint`).
 *  - any other `string`: sent to the node unchanged, with no validation. The intended use is
 *    an already-formatted hex quantity such as `"0x10"`.
 *
 * A 32-byte block hash also type-checks as the last variant, and is forwarded as that bare
 * string. Nothing in this package checks or tests that a node accepts a bare hash for these
 * methods, so treat a hash as unsupported unless your node documents it.
 */
export type BlockTag =
  | 'latest'
  | 'earliest'
  | 'pending'
  | 'safe'
  | 'finalized'
  | number
  | bigint
  // Any other string, forwarded verbatim; the intersection keeps the literals above
  // visible to editor completion instead of collapsing the union to `string`.
  | (string & Record<never, never>);

/** One storage read: which contract, which slot, as of which block. */
export interface StorageReadRequest {
  /** The contract address, exactly as it was passed to `.target()`. */
  readonly address: string;
  /** The slot number to read, not yet formatted; see {@link formatSlot}. */
  readonly slot: bigint;
  /** The block to read at, not yet formatted; see {@link formatBlockTag}. */
  readonly blockTag: BlockTag;
}

/**
 * Reads one 32-byte storage word. Implementations must return exactly 32 bytes.
 *
 * The core normalises what it is handed: a shorter array is left-padded with zeros to 32
 * bytes, and a longer one is rejected with a `RangeError`. A rejection from the
 * implementation propagates to the caller of the query unchanged.
 */
export type GetStorageAt = (request: StorageReadRequest) => Promise<Uint8Array>;

/**
 * A `GetStorageAt` with the address and block already bound.
 *
 * The binding is the point: every phase of a single `.read()` — bounds obligations, the
 * long-string header read, and the final value read — is handed the SAME bound reader, so
 * they all name the same address and the same block tag. That is one block only when the
 * tag is fixed; under a moving tag such as `"latest"` the reads may land on different blocks.
 *
 * Takes the slot number and resolves to that slot's word, under the same 32-byte contract as
 * {@link GetStorageAt}.
 */
export type SingleSlotReader = (slot: bigint) => Promise<Uint8Array>;

/**
 * Render a {@link BlockTag} into the string form JSON-RPC expects.
 *
 * @param blockTag - The block specifier to render.
 * @returns A `0x` hex quantity without leading zeros for a `number` or `bigint`; a string — a
 *   named tag or anything else — unchanged and unvalidated.
 * @throws {TypeError} when `blockTag` is a negative `bigint`, a `number` that is negative or
 *   not an integer (including `NaN` and `±Infinity`), a `number` that is an integer beyond
 *   `Number.MAX_SAFE_INTEGER` (JavaScript may already have rounded it, so it must be passed
 *   as a `bigint`), or not a string, number or bigint at all.
 */
export function formatBlockTag(blockTag: BlockTag): string {
  if (typeof blockTag === 'string') return blockTag;
  if (typeof blockTag !== 'number' && typeof blockTag !== 'bigint') {
    // Unreachable from typed code; `.at()` does not validate what plain JavaScript passes.
    const received: unknown = blockTag;
    throw new TypeError(
      `block tag must be a string, number or bigint, got ${received === null ? 'null' : typeof received}`
    );
  }
  if (blockTag < 0 || (typeof blockTag === 'number' && !Number.isInteger(blockTag))) {
    throw new TypeError(`block number must be a non-negative integer, got ${blockTag}`);
  }
  if (typeof blockTag === 'number' && !Number.isSafeInteger(blockTag)) {
    throw new TypeError(
      `block number ${blockTag} is a number beyond Number.MAX_SAFE_INTEGER and may already` +
        ` have been rounded; pass it as a bigint`
    );
  }
  return `0x${blockTag.toString(16)}`;
}

/**
 * True for `0x` followed by one or more hex digits, in either case, and nothing else.
 *
 * Only the shape is tested, not the length: leading zeros pass, and so does a 32-byte hash.
 * `readAll()` takes a string block tag of this shape to name one fixed block, and so skips
 * its after-the-fact consistency check for it.
 *
 * @param value - The string to test.
 * @returns Whether `value` has that shape. A bare `"0x"` does not.
 */
export function isHexQuantity(value: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(value);
}

/**
 * Turn an `eth_blockNumber` result into a `bigint`.
 *
 * Checked to be a hex quantity first: `BigInt` also accepts a decimal or an empty string
 * (which it reads as 0), and a silently wrong block number is worse than a failure. The value
 * is described rather than echoed, since it is whatever the node chose to send.
 *
 * @param result - The raw `result` of an `eth_blockNumber` call.
 * @returns The block number.
 * @throws {TypeError} when `result` is not a string, or is a string that is not `0x` followed
 *   by hex digits.
 */
export function parseBlockNumber(result: unknown): bigint {
  if (typeof result !== 'string') {
    throw new TypeError(
      `eth_blockNumber returned ${result === null ? 'null' : typeof result}, expected a hex string`
    );
  }
  if (!isHexQuantity(result)) {
    throw new TypeError(
      `eth_blockNumber returned a ${result.length}-character string that is not a hex quantity`
    );
  }
  return BigInt(result);
}

/**
 * Render a slot number into the `0x`-prefixed quantity `eth_getStorageAt` expects.
 *
 * @param slot - The slot number.
 * @returns The slot as lowercase hex without leading zeros (`0n` gives `"0x0"`).
 * @throws {TypeError} when `slot` is negative, or is 2^256 or more: storage has no such slot,
 *   and a node would reject the quantity.
 */
export function formatSlot(slot: bigint): string {
  if (slot < 0n) throw new TypeError(`slot must not be negative, got ${slot}`);
  if (slot >= 1n << 256n) throw new TypeError(`slot must be below 2^256, got ${slot}`);
  return `0x${slot.toString(16)}`;
}
