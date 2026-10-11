# USAGE

How `hardhat-storage-decoder` is built internally, and how to use it from a Hardhat project.

## Architecture

For a step-by-step trace of one read through the code, see [docs/code-walkthrough.md](docs/code-walkthrough.md).

```
src/core/**        Hardhat-free engine. No import of "hardhat" anywhere in this tree
                    (enforced by `npm run typecheck:core` / scripts/check-core-purity.mjs).
src/hardhat2/**     Thin adapter wiring the core to Hardhat 2.x.
src/hardhat3/**     Thin adapter wiring the core to Hardhat 3.x.
```

The split exists because HH2 and HH3 differ in almost everything *except* the actual slot
arithmetic: registration mechanism (`extendEnvironment` side-effect import vs. a `plugins: []`
entry with lazy hook categories), provider access (`hre.network.provider` vs. a per-connection
`EthereumProvider`), build-info layout, and even module format (CJS vs. HH3's ESM-only).
Everything that is genuinely about *decoding storage* — parsing `storageLayout`, deriving slots,
the read pipeline, decoding bytes to native values — lives once in `src/core/**` and is
exercised identically by both adapters through one interface, `StorageDecoderContext`:

```ts
interface StorageDecoderContext {
  getLayout(fullyQualifiedName: string): Promise<ParsedStorageLayout>;
  getStorageAt: GetStorageAt;                                    // eth_getStorageAt for one { address, slot, blockTag }
  getDeployedBytecode?(fullyQualifiedName: string): Promise<string | undefined>;
  getCode?(address: string, blockTag: BlockTag): Promise<string>; // both optional; enable the mismatch check together
  getBlockNumber?(): Promise<bigint>;                            // optional; lets readAll() pin a "latest" dump to one block
}
```

Each adapter builds one of these (`createHardhatStorageDecoder` in HH2, `createStorageDecoderContext`
in HH3) and hands it to `createStorageDecoder()`, which returns the fluent `StorageQueryBuilder`
attached to `hre.storageDecoder` (HH2) or `connection.storageDecoder` (HH3).

### Core modules

| Module | Responsibility |
|---|---|
| `layout/parseStorageLayout.ts` | Parses/validates solc's raw `storageLayout` JSON into `ParsedStorageLayout` (coerces stringly-typed `slot`/`offset`/`numberOfBytes`, classifies every type by solc's own `encoding` field, resolves UDVTs/enums/contract types to their underlying rule). |
| `slots/deriveSlot.ts` | Pure, synchronous walk from `(variable name, path segments)` to a `ReadPlan` — the slot-derivation engine. Performs **no I/O**. |
| `slots/decode.ts` | Checks bounds obligations in path order, resolves a read plan (including the short/long string split), and decodes raw bytes to native JS values. |
| `query/errors.ts` | One typed error class per distinct failure mode. |
| `query/StorageQueryBuilder.ts` | The fluent, immutable builder: the chain methods plus `read`, `readMany`, `readKeys`, `readIndices` and `readAll`. |
| `query/execute.ts` | Runs one query: issues the contract check, array lengths and value together, then applies the fixed error precedence. Holds the per-call memos and the concurrency limit. |
| `query/dump.ts` | `readAll`: expands arrays, structs and supplied mapping keys level by level, with the size cap and the one-block rules. |
| `rpc/getStorageAt.ts` | The `GetStorageAt`/`SingleSlotReader` interfaces plus `blockTag`/slot formatting helpers — the one seam the adapters fill in. |
| `util/bytes.ts` | Byte-level primitives: big-endian encode/decode, left/right padding, packed-field extraction, EIP-55 checksumming, and `keccak256` (via `@noble/hashes`, the package's one runtime dependency). |

### The slot-derivation algorithm, conceptually

`deriveSlot(layout, variableName, segments)` starts at the variable's declared `(slot, offset,
typeId)` and consumes one `PathSegment` per loop iteration, dispatching on **solc's own
`encoding` field** (`inplace` / `mapping` / `dynamic_array` / `bytes`) rather than pattern-matching
the type label:

- **mapping** — the segment must be a `.key(...)`. The key is encoded according to the *resolved*
  key type (see "Mapping key encoding" below), and the new slot is
  `keccak256(encodedKey ++ pad32(currentSlot))`, where `pad32(x)` is `x` as a 32-byte
  big-endian word.
- **dynamic array** — the segment must be an `.index(n)`. Elements start at
  `keccak256(pad32(currentSlot))`; a *bounds obligation* is recorded (the array's length is
  only knowable by reading its declared slot, and the walk never does I/O), then the element's
  slot/offset is computed by packing-aware placement (see below).
- **fixed-size array** — same packing placement, but directly against `currentSlot` (no keccak —
  elements live in place). The length is parsed from the type identifier/label
  (`t_array(t_uint8)10_storage` → `10`), never inferred from `numberOfBytes / elementSize` — solc
  reports `numberOfBytes: "32"` for `uint8[10]`, so that ratio would silently give the wrong
  bound. Bounds are checked immediately (no obligation needed — the length is static).
- **struct** — the segment must be a `.field(name)`. The slot advances by the member's *delta*
  (`slot += member.slot`), and `offset` is replaced by the member's own offset — offsets are
  never carried across a struct-field step, only slot deltas are.
- every slot reached by addition (an array element, a struct member, a data slot of a long
  `string`/`bytes`) is reduced modulo 2^256, as the EVM computes it: an element past the last
  slot continues at slot 0.
- **terminal** (a value type, or `string`/`bytes`) — returns the `ReadPlan`. A value type is
  always `{ kind: 'single', slot }`. `string`/`bytes` is always `{ kind: 'multi', headerSlot,
  dataBaseSlot }`, because whether the value is short or long is a property of the *stored data*,
  not of the type — that can only be resolved by reading.

**Packing-aware array placement** (`placeArrayElement`) has two branches on the element's byte
size `B`:
- `B <= 32`: `elementsPerSlot = floor(32 / B)` elements share a slot,
  `slot = base + index / elementsPerSlot`, `offset = (index % elementsPerSlot) * B`. This is
  deliberately not a single `index * B / 32` stride — when `32 % B != 0` (e.g. `uint96`, 2 per
  slot with 8 bytes unused per slot) a naive stride would let the next element bleed into the
  trailing gap.
- `B > 32`: each element occupies `ceil(B / 32)` whole slots at offset 0.

> **Reviewed and empirically verified**: an external review flagged a
> concern that this two-branch split, keyed purely on byte size `B`, might mis-pack array
> elements that are themselves structs or fixed-size arrays under 32 bytes. This was checked
> against real solc output: solc reports a struct or fixed-array *type's* `numberOfBytes` as
> already rounded up to a whole number of slots (a multiple of 32) whenever that type is used as
> a composite (as opposed to a scalar field within another struct), so `B` is never `< 32` for
> such element types in practice, and the `B <= 32` branch's `elementsPerSlot = floor(32/B)`
> correctly evaluates to `1` rather than incorrectly packing several small structs into one slot.

**Mapping key encoding** (`encodeMappingKey`) depends on the *resolved* key type, not the caller's
JS type:
- value types (`uint`/`int`/`bool`/`address`/enum/contract) — left-padded to 32 bytes; signed
  integers are two's-complement sign-extended across the full width.
- `bytesN` — **right**-padded to 32 bytes (the one case that inverts the usual direction).
- `string`/`bytes` — not padded at all; the raw UTF-8/byte value is hashed as-is.
- a user-defined value type follows whatever its *underlying* type does, resolved from the
  compilation AST (`storageLayout` alone cannot distinguish `type Id is bytes32` from
  `type Id is uint256` — see `extractUserDefinedValueTypes`).

### The read pipeline

`deriveSlot` never touches the network. `StorageQueryBuilder.read()` then issues everything the
path needs in **one concurrent round**. The storage reads go through one reader bound to one
`(address, blockTag)` pair and the code check is sent with the same tag, so every part of a
read names the same block tag. That is one block when the tag is
fixed (use `.at(blockNumber)`); under a moving tag such as `"latest"` the calls of one read
are not guaranteed to land on the same block:

- the contract/address check (`eth_getCode`, compared against the artifact's bytecode),
- every `BoundsObligation`'s array-length slot, and
- the value's own slot (or, for `string`/`bytes`, its header slot).

What the caller observes is still decided in a fixed order, so issuing a read early can waste a
call but can never change the answer:

1. a layout error (`ContractNotFoundError`, …),
2. a `ContractMismatchError`,
3. a path error from `deriveSlot`,
4. the **outermost** out-of-bounds index (`arr[999][3]` reports the outer failure; the inner
   length, read from a slot derived from an index that does not exist, is never looked at),
5. the value.

If an index is out of bounds, the value that was read alongside it is discarded and
`IndexOutOfBoundsError` is thrown. A value from an unverified index is never returned.

A long `string`/`bytes` needs a second round. The low bit of the header's low-order byte selects
the form:

- **even → short.** The low byte holds `2 × length` (`length ≤ 31`); the value itself sits in the
  slot's **high-order** bytes — the one place solc inverts its usual low-order alignment.
- **odd → long.** The whole word holds `2 × length + 1`; the data occupies `ceil(length / 32)`
  slots starting at `keccak256(headerSlot)`.

The data slots are located by a length taken from the header, so they are fetched only after
the contract check and every index have passed: a garbage header behind a bad index, or at the
wrong contract, cannot trigger a large fetch.

`decode` then extracts the `(offset, numberOfBytes)` byte window from the resolved word(s) and
converts it to a native value per the leaf `ValueKind` (`uint`/`int` → `bigint`, `bool` →
`boolean`, `address` → EIP-55 checksummed string, `bytesN`/`bytes` → hex string, `string` →
UTF-8 string, a function type → hex string of its raw bytes).

At most 256 storage reads are in flight at once within a call.

## Installation

```bash
npm install --save-dev hardhat-storage-decoder
```

There is **no root entrypoint** — `require("hardhat-storage-decoder")` / `import
"hardhat-storage-decoder"` resolves to a module that only throws, naming the two real subpaths.
This turns the most likely first mistake into an actionable message instead of a raw
`ERR_PACKAGE_PATH_NOT_EXPORTED`.

The plugin injects `storageLayout` into solc's `outputSelection` at registration. **Run one
recompile after installing** (`npx hardhat compile`) — artifacts built before installation have
no layout in their build-info until then.

### Registering for Hardhat 2.x

Side-effect import, like every HH2 plugin, from the top of `hardhat.config`:

```js
// hardhat.config.js
require('hardhat-storage-decoder/hardhat2');
```

```ts
// hardhat.config.ts
import 'hardhat-storage-decoder/hardhat2';
```

This must run after Hardhat's own config module has initialized (or at least be imported from
`hardhat.config` itself) — `extendConfig`/`subtask` are registered at import time and need the
Hardhat context to exist. It attaches a lazy `hre.storageDecoder` getter (no network is started
until a query actually runs):

```ts
const { value } = await hre.storageDecoder
  .contract('contracts/Vault.sol:Vault')
  .target(vaultAddress)
  .name('balances')
  .key(alice)
  .read();
```

### Registering for Hardhat 3.x

Listed in the config's `plugins` array — importing the module for side effects does nothing in
HH3, unlike HH2:

```ts
// hardhat.config.ts
import storageDecoderPlugin from 'hardhat-storage-decoder/hardhat3';

export default {
  plugins: [storageDecoderPlugin],
  solidity: '0.8.26',
};
```

`.storageDecoder` is attached to every `NetworkConnection` via the `network.newConnection` hook,
so it is available on connections made by test runners too, not just ones you open by hand:

```ts
const connection = await hre.network.getOrCreate();
const { value } = await connection.storageDecoder
  .contract('contracts/Vault.sol:Vault')
  .target(vaultAddress)
  .name('balances')
  .key(alice)
  .read();
```

(`getOrCreate()` reuses an open connection; `connect()` also works but is deprecated as of
`hardhat@3.13.0`.)

## The fluent query API

Every chain method returns a **new** builder — a partial chain is reusable:

```ts
const base = storage.contract('contracts/Vault.sol:Vault').target(vaultAddress);
const a = await base.name('balances').key(alice).read();
const b = await base.name('balances').key(bob).read();
```

`.name(variableName)` selects a state variable by the name solc records in the layout.
`.name(variableName, { declaredIn })` is for the one case where a name is not unique: private
variables may be declared again in a derived contract, so a layout can hold two variables called
`owner`, each with its own slot. Without `declaredIn` such a name is rejected with
`AmbiguousVariableError`, whose `declaringContracts` (and message) lists the contracts that
declare it, each as `<source path>:<ContractName>`, base contracts first. `declaredIn` takes the
name of the contract that declares the variable. Normally pass the bare contract name
(`'Base'`); it works the same on both Hardhat majors. The full form is needed only when two of
the declaring contracts share a bare name, and the strings to pass are exactly the ones
`declaringContracts` lists. Its source path is the compiler's own path for the source unit (the
AST's `absolutePath`), which is not always the path given to `.contract()`: on Hardhat 2 it is
the project-relative source name (`contracts/Base.sol:Base`), on Hardhat 3 it is the compiler
input source name, which for a project file carries a `project/` prefix
(`project/contracts/Base.sol:Base`).

- when no variable of that name is declared by it, the read rejects with
  `VariableNotFoundError`, whose message lists the contracts that do declare the name;
- a bare name that two of the declaring contracts share (same contract name, different files)
  is still `AmbiguousVariableError` — pass one of the full strings it lists;
- a name that is unique needs no option;
- `read()`, its batch forms and `readAll()` all use this lookup, and it is applied when the
  read runs, not when `.name()` is called.

solc's `storageLayout` does not say which contract declares a variable, so the Hardhat adapters
take that from the build's ASTs (`extractDeclaringContracts`). A layout parsed without that
information still rejects a duplicated name with `AmbiguousVariableError`, but lists each
declaring contract as `(unknown)` and has nothing for `declaredIn` to match, so the name
cannot be read until the map is supplied.

```ts
// contract Base { address private owner; }   contract Vault is Base { address private owner; }
const base = await storage.contract(fqn).target(addr).name('owner', { declaredIn: 'Base' }).read();
const vault = await storage.contract(fqn).target(addr).name('owner', { declaredIn: 'Vault' }).read();
```

A `.read()` call always returns the same shape:

```ts
interface StorageReadResult {
  value: bigint | boolean | string;   // decoded native value
  slot: bigint;                        // the slot actually read (header slot for multi-slot values)
  offset: number;                      // byte offset within `slot`; 0 unless packed
  rawSlotValue: Uint8Array;            // raw 32 bytes of `slot`
  typeLabel: string;                   // e.g. "uint128"
  blockTag: BlockTag;                  // the block tag the query was sent with, unchanged
}
```

### Simple variable

```ts
const { value } = await storage
  .contract('contracts/Vault.sol:Vault')
  .target(vaultAddress)
  .name('totalDeposits')
  .read();
```

### Packed field

Multiple small variables sharing one slot are transparent — `offset`/`rawSlotValue` tell you
exactly where the value came from:

```ts
const { value, slot, offset, rawSlotValue } = await storage
  .contract('contracts/Vault.sol:Vault')
  .target(vaultAddress)
  .name('feeBps') // e.g. a uint16 packed alongside other fields in slot 2
  .read();
```

### Nested mappings, to any depth

```ts
await storage
  .contract('contracts/Vault.sol:Vault')
  .target(vaultAddress)
  .name('allowances') // mapping(address => mapping(address => mapping(uint256 => uint256)))
  .key(owner)
  .key(spender)
  .key(tokenId)
  .read();

// .keys(...) is sugar for consecutive .key() calls, for the common all-mapping-keys case
await storage.contract(fqn).target(addr).name('allowances').keys(owner, spender, tokenId).read();
```

Key encoding follows the *key type*, not the JS type used to express it: value-type keys are
left-padded (signed integers sign-extended), `bytesN` keys are right-padded, `string`/`bytes`
keys are unpadded, and a user-defined value type follows its underlying type's rule.

A JavaScript `number` is exact only up to `Number.MAX_SAFE_INTEGER`. A `number` beyond it —
as a mapping key, an `.index()` or a block number given to `.at()` — is rejected with a
`TypeError` when the read runs, because it may already have been rounded; pass a `bigint`.

### Arrays

```ts
// dynamic array element
await storage.contract(fqn).target(addr).name('holders').index(3).read();

// fixed-size array element
await storage.contract(fqn).target(addr).name('fixedWords').index(2).read();

// nested dynamic array — an outer element's slot becomes the inner array's own header slot
await storage.contract(fqn).target(addr).name('grid').index(1).index(4).read();
```

An out-of-bounds `.index()` throws `IndexOutOfBoundsError` — checked against the array's real
on-chain length, never silently returning a zero. The value read is issued concurrently with
that check and discarded if the index turns out to be out of bounds.

### Structs, including nested inside arrays/mappings

```ts
// struct field
await storage.contract(fqn).target(addr).name('outer').field('inner').field('a').read();

// struct in an array in a mapping
await storage
  .contract(fqn)
  .target(addr)
  .name('records') // mapping(address => Inner[])
  .key(user)
  .index(2)
  .field('amount')
  .read();
```

### Reading as of a block

```ts
await storage.contract(fqn).target(addr).name('totalDeposits').at(blockNumber).read();
```

`.at(blockTag)` defaults to `"latest"`. The tag you give is passed, unchanged, to **every** call
that one `.read()` makes — the contract check, the bounds check, a long string's header read,
and the value read — so a query never mixes a historical block with the current one.

### Long strings and bytes

Handled transparently — no API difference from any other variable:

```ts
const { value } = await storage.contract(fqn).target(addr).name('description').read();
```

Short values (≤ 31 bytes) decode inline from the header slot; long values are read from their
`keccak256(headerSlot)` data slots. `slot`/`rawSlotValue` refer to the header slot in both cases.
A stored `string` that begins with a UTF-8 byte-order mark keeps it: the value starts with
U+FEFF.

### Reading many values in one call

```ts
const vault = storage.contract('contracts/Vault.sol:Vault').target(vaultAddress);

const [alice, bob, total] = await storage.readMany([
  vault.name('balances').key(aliceAddress),
  vault.name('balances').key(bobAddress),
  vault.name('totalSupply'),
]);

const balances = await vault.name('balances').readKeys([aliceAddress, bobAddress]);
const firstThree = await vault.name('items').readIndices([0, 1, 2]);
```

- `readMany(queries)` takes finished chains (everything but the `.read()`) and returns one
  `StorageReadResult` per query, in input order. The chains may mix variables, contracts,
  addresses and block tags.
- `readKeys(keys)` / `readIndices(indices)` are shorthand for `readMany` over `.key(k)` /
  `.index(i)` on the chain they are called on. Called at the wrong kind of position they fail
  with `PathSegmentKindMismatchError`, exactly as `.key()`/`.index()` would.
- Within one call the contract/address check runs once per contract, address and block, and an
  array's length is read once however many of its indices are requested. Nothing is remembered
  between calls: the code at an address can change under the same block tag (a snapshot revert,
  `hardhat_setCode`, a redeploy), so every call checks again.
- If any query fails, the whole call rejects with the error of the **first failing query in the
  list**. All queries are allowed to finish first, so the result is deterministic.
- `readMany` does not pin a block. With the default `"latest"`, a block mined mid-call can
  split the results across two blocks; pass `.at(blockNumber)` on the chains when you need one
  consistent snapshot.
- The builders must come from the same decoder. A builder from the other Hardhat adapter, or
  from the CommonJS/ESM twin of this package, is a different class and is rejected.

### Dumping a whole variable

```ts
const { value, skipped, typeLabel, blockTag } = await vault.name('positions').readAll();
```

`readAll()` reads everything under the position it is called on, to any depth:

| Solidity | Returned as |
|---|---|
| value types, `string`, `bytes` | the same native value `.read()` returns |
| fixed and dynamic arrays | an array |
| structs | an object keyed by field name, created without a prototype |
| mappings | a `Map` holding exactly the keys you supplied (duplicates collapsed), in first-supplied order |

**Mappings.** Solidity does not store a mapping's keys, so there is nothing to enumerate. A
mapping with no keys supplied comes back as an **empty `Map`** — it is never omitted — and its
path pattern is listed in `skipped`. Each entry of `skipped` can be used directly as a key of
`options.keys`:

```ts
const first = await vault.name('account').readAll();
// first.skipped -> ['allowances', 'orders[].fills']

const second = await vault.name('account').readAll({
  keys: { allowances: [spenderA, spenderB], 'allowances{}': [tokenA] },
});
```

**Key patterns** are relative to the position `readAll()` is called on and never include the
variable name:

| `readAll()` called on | Pattern | Means |
|---|---|---|
| a mapping | `""` | keys for that mapping |
| a mapping of mappings | `"{}"` | keys for the second level |
| an array of structs | `"[].owners"` | the `owners` mapping in every element |
| a struct | `"m"` | its field `m` |
| a struct | `"m{}"` | the second level of nested mapping `m` |
| a struct | `"items[].owners"` | `owners` in every element of field `items` |

- Keys for nested levels are a **cross-product**: `{ m: [a, b], 'm{}': [1, 2] }` reads four
  entries. A different key list per parent cannot be expressed; use `readMany` for that.
- `Map` keys are your supplied values, unmodified. Look an entry up with the same value (for a
  `Uint8Array`, the same reference). `1`, `1n` and `"1"` are three distinct `Map` keys even
  though they address one slot, and a key repeated in the list yields one entry.
- A pattern that does not lead to a mapping, and a pattern for a nested level whose parent has no
  keys, are rejected with a `TypeError` before any storage is read.

**Size cap.** `options.maxElements` (default 10,000) limits any single array's length, any
supplied key list, and the total the dump expands: every array element, struct field and
mapping entry, plus every data slot of a long `string`/`bytes` (so a corrupt or hostile length
cannot trigger an unbounded fetch). Exceeding it throws
`DumpTooLargeError` (`kind` is `'array'`, `'keys'` or `'total'`) before the offending reads are
issued. Packed elements that share a slot cost one read: a 10,000-element `uint8[]` is 314
storage reads (the length slot plus 313 packed data slots).

**One block.** A dump takes several rounds (a length must be known before its elements can be
read), so it needs all of them to see the same state:

- With the default `"latest"`, the dump asks for the current block number once and reads
  everything — including the contract check — at that number. `blockTag` in the result is that
  number. Behind a load-balanced RPC endpoint a node that has not yet seen that block may answer
  "header not found"; retry, or pass an explicit `.at(blockNumber)`.
- An explicit block number, a hex quantity, and `"earliest"` are used as given. A bare block
  hash is also passed through to the node as given, and nothing in this package verifies that
  a node accepts it for these calls.
- Any other tag (`"pending"`, `"safe"`, `"finalized"`, a chain-specific tag, or `"latest"` on an
  adapter that cannot supply a block number) can move while the dump runs. Afterwards every
  array length and long-string length the dump relied on is read once more, and
  `DumpInconsistentError` is thrown if any changed. This is a check, not a snapshot: unchanged
  lengths do not prove unchanged elements. Use `.at(blockNumber)` when you need a guarantee.

### Errors

Each failure of the query itself is a distinct class extending `StorageDecoderError`. Invalid
arguments (a malformed mapping key, a bad `readAll()` option) and malformed node responses are
plain `TypeError`/`RangeError`, and provider failures pass through unchanged:

| Error | Cause |
|---|---|
| `ContractNotFoundError` | `.contract(fqn)` names a contract with no layout in build-info |
| `ContractMismatchError` | the code at `.target(address)` does not plausibly match `.contract(fqn)` (a `deployedBytecode` length + first-32-bytes heuristic, not a proof — skipped entirely when the adapter can't supply both `getCode`/`getDeployedBytecode`) |
| `VariableNotFoundError` | unknown variable — with a distinct message when it is a `constant`/`immutable` (which solc never puts in `storageLayout`; read it via its getter instead), and when the name exists but is not declared in the contract given as `declaredIn` |
| `AmbiguousVariableError` | the layout has more than one variable with that name (a private variable re-declared along the inheritance chain) and `.name()` was not given a `{ declaredIn }` that singles one out |
| `PathSegmentCountMismatchError` | too few path segments (stopped on a mapping/array/struct still needing one) or too many (kept going past a terminal type) |
| `PathSegmentKindMismatchError` | right count, wrong kind at some position — `.index()` on a mapping, `.field()` on an array, an unknown struct field name |
| `IndexOutOfBoundsError` | a negative or non-integer index, or an index ≥ the array's length at the block being read |
| `UnsupportedTypeError` | a solc encoding/type this version won't guess a slot for (includes an unresolved user-defined value type — see [Parsing a layout yourself](#parsing-a-layout-yourself)) |
| `DumpTooLargeError` | `readAll()` met an array, a supplied key list, or a running total above `maxElements` |
| `DumpInconsistentError` | a length `readAll()` relied on changed while it was reading at a block tag that can move |
| `StorageLayoutNotAvailableError` | exported by `hardhat-storage-decoder/hardhat2` only; thrown when the contract's build-info exists but holds no `storageLayout` (artifacts predate the plugin — run `npx hardhat compile`) |
| `MissingStorageLayoutError` | exported by `hardhat-storage-decoder/hardhat3` only; thrown when the build-info has no solc output or no `storageLayout` for the contract, or when the config has no `solidity` profiles to inject the selector into |

Each error's `.name` is its class name in every published bundle, including for errors thrown
from the CommonJS build.

Adapters re-export all of these plus `StorageQueryBuilder`, `StorageDecoderContext`,
`StorageReadResult`, `StorageDumpResult`, `ReadAllOptions`, `DumpValue`, `BlockTag`,
`DecodedValue`, `MappingKeyValue`, and `PathSegment` from their
own subpath, so `instanceof` checks and typing never need a second import specifier.

Both subpaths load under `require` and under `import`. For Hardhat 2 the ES-module form is a
thin wrapper that re-exports the CommonJS build, so the two forms share one copy of the plugin
and of every error class. Importing the bare package name throws
`HardhatStorageDecoderEntrypointError` (a plain `Error` subclass, not a
`StorageDecoderError`), whose message names the two subpaths.

### Parsing a layout yourself

The adapters do this for you; these four functions are exported from both subpaths for code
that holds a solc `storageLayout` blob of its own (and are what the "unresolved user-defined
value type" and "does not record which contract declares" messages refer to):

```ts
import {
  extractConstantAndImmutableNames,
  extractDeclaringContracts,
  extractUserDefinedValueTypes,
  parseStorageLayout,
} from 'hardhat-storage-decoder/hardhat3'; // or '.../hardhat2', from inside a Hardhat 2 run

// `output` is solc's standard-JSON output, compiled with the `storageLayout` and `ast` outputs.
// Pass the AST of every source: a base contract may live in another file.
const asts = Object.values(output.sources).map((source) => source.ast);
const layout = parseStorageLayout(output.contracts['contracts/Vault.sol'].Vault.storageLayout, {
  contractName: 'Vault',
  userDefinedValueTypes: extractUserDefinedValueTypes(...asts),
  constantAndImmutableNames: extractConstantAndImmutableNames(...asts),
  declaringContracts: extractDeclaringContracts(...asts),
});
```

`storageLayout` does not record what a user-defined value type wraps, so without
`userDefinedValueTypes` such a type stays unresolved and using it as a mapping key, or decoding
it, throws `UnsupportedTypeError`. Through `hre.storageDecoder` / `connection.storageDecoder`
the same error means the build-info has no AST for the contract's sources: recompile with the
plugin registered, so that the `ast` output is written.

`declaringContracts` maps each state variable's AST id to the contract that declares it, as
`<source path>:<ContractName>`, the source path being the `absolutePath` of the source unit in
the AST; it is what `.name(variableName, { declaredIn })` matches against, in full or by the
bare contract name. Without it a name that occurs twice in the layout cannot be disambiguated.

The types `RawStorageLayout`, `ParseStorageLayoutOptions` and `ParsedStorageLayout` are exported
alongside.

### Lower-level exports

Each subpath also exports the pieces its plugin is assembled from. Ordinary use never needs
them; they are listed because they are part of the published surface.

`hardhat-storage-decoder/hardhat2`:

| Export | What it is |
|---|---|
| `createHardhatStorageDecoder(hre)` | builds a query builder for a Hardhat 2 environment — the same thing `hre.storageDecoder` returns |
| `ensureStorageLayoutOutput()` | registers the two points at which the outputs the plugin needs are added to the compiler's `outputSelection`; already called when the subpath is loaded |
| `BuildInfoReader` (type) | the `getLayout` / `getDeployedBytecode` pair the adapter reads build-info through |

`hardhat-storage-decoder/hardhat3`:

| Export | What it is |
|---|---|
| `storageDecoderPlugin` (also the default export) | the object to list in `plugins` |
| `attachStorageDecoder(connection, artifacts)` | adds the lazy `storageDecoder` property to a connection; the `network.newConnection` hook calls it |
| `createStorageDecoderContext(artifacts, provider)` | the I/O context the query builder runs on, built from an artifact manager and a provider |
| `Hardhat3LayoutReader` | reads and caches parsed layouts and deployed bytecode from a project's artifacts and build-info |
| `createGetStorageAt(provider)`, `createGetCode(provider)` | `eth_getStorageAt` / `eth_getCode` readers bound to an EIP-1193 provider |
| `withStorageLayoutOutputSelection(config)` | returns a copy of a resolved config in which every compiler, including per-file overrides, requests the outputs the plugin needs; the config hook calls it |
| `STORAGE_LAYOUT_SELECTOR` | the string `'storageLayout'` |
| `MANUAL_OUTPUT_SELECTION_SNIPPET` | a config snippet that sets `outputSelection` by hand, quoted in the plugin's "no storage layout" messages |

## Supported encodings

Value types (including `bytesN`, enums, contract types, and user-defined value types), packed
slots, fixed and dynamic arrays with packing-aware arithmetic (including trailing-gap cases such
as `uint96[]`), structs, `string`/`bytes` in both short and long form, mappings with every key
encoding, and arbitrary compositions of the above. Inheritance resolves through solc's own
per-contract layout.

A function-typed state variable is read as the `0x` hex of its raw bytes — 24 for an external
function (the 20-byte address followed by the 4-byte selector), 8 for an internal one — and
cannot be a mapping key (`UnsupportedTypeError`).

A fixed array longer than `Number.MAX_SAFE_INTEGER` elements (`uint256[2**64] gap;` compiles)
cannot be indexed, and neither can an array whose elements are that large: the read is
refused with `UnsupportedTypeError`. Everything else in the contract reads normally,
including the variables after such an array and the other fields of a struct that contains
one. `readAll()` on a struct, or on a mapping with supplied keys, that reaches such an array is
refused as a whole.
