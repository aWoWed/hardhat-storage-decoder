# hardhat-storage-decoder

Read Solidity contract storage by **variable name and a kind-checked path** — mapping keys,
array indices, struct fields — without knowing raw slot numbers.

Storage layouts come straight from your project's Hardhat build-info (no dependency on
`hardhat-storage-layout`), and slots are derived statically with packing-aware,
encoding-first keccak256-preimage arithmetic.

> **Status: v1 complete, pre-publish.** The core and both adapters are implemented, with a
> unit suite and an on-chain e2e suite for each Hardhat major (run against Hardhat 2.29.0 and
> 3.13.0). `npm publish` itself is a manual step requiring registry credentials — see
> [Development](#development).

## Install

```bash
npm install --save-dev hardhat-storage-decoder
```

Import the subpath matching your Hardhat major. There is **no** root entrypoint — importing
the bare package name throws a message telling you which subpath to use.

```js
// Hardhat 2.x — hardhat.config.js
require('hardhat-storage-decoder/hardhat2');
```

Both subpaths can be loaded with `require` and with `import`. For Hardhat 2 the two forms
share one copy of the plugin, so an error class imported in an ES-module test is the same class
`hre.storageDecoder` throws.

```ts
// Hardhat 3.x — hardhat.config.ts
import { storageDecoderPlugin } from 'hardhat-storage-decoder/hardhat3';

export default {
  plugins: [storageDecoderPlugin],
};
```

The plugin injects `storageLayout` into solc's `outputSelection` at registration, so **run one
recompile after installing**.

## Usage

The API is a fluent, immutable chain. Every path segment states its own kind, so a mapping key,
an array index, and a struct field can never be confused for one another.

```js
// Hardhat 2
const storage = hre.storageDecoder;

// Hardhat 3 — getOrCreate() reuses an existing connection if one is open; connect() also
// works (the decoder is attached via the newConnection hook either way) but is deprecated
// as of hardhat@3.13.0.
const storage = (await hre.network.getOrCreate()).storageDecoder;
```

### Simple and packed variables

```js
const { value, slot, offset, rawSlotValue } = await storage
  .contract('contracts/Vault.sol:Vault')
  .target(vaultAddress)
  .name('totalDeposits')
  .read();
```

Every read returns the same shape: the decoded native value plus `{ slot, offset, rawSlotValue }`,
so a packed field tells you exactly where it came from.

### Nested mappings, to any depth

```js
await storage
  .contract('contracts/Vault.sol:Vault')
  .target(vaultAddress)
  .name('allowances')
  .key(owner)
  .key(spender)
  .key(tokenId)
  .read();

// `.keys(...)` is sugar for consecutive `.key()` calls
await storage./* ... */ name('allowances').keys(owner, spender, tokenId).read();
```

Key encoding follows the key type, not the JavaScript type: value types are left-padded (signed
integers sign-extended), `bytesN` keys are **right**-padded, and `string`/`bytes` keys are not
padded at all. A user-defined value type follows whatever its underlying type does. A `number`
key, index or block number beyond `Number.MAX_SAFE_INTEGER` is rejected with a `TypeError` —
pass a `bigint`.

### Array indices and struct fields

```js
// dynamic array element
await storage./* ... */ name('holders').index(3).read();

// struct in an array in a mapping
await storage./* ... */ name('records').key(user).index(2).field('amount').read();

// nested dynamic array
await storage./* ... */ name('grid').index(1).index(4).read();
```

### Reading as of a block

```js
await storage./* ... */ name('totalDeposits').at(blockNumber).read();
```

The block you pin is used for *every* read the call makes — the bounds check, a long string's
header read, and the value read all observe the same block.

### Long strings and bytes

Handled transparently. Short values (< 32 bytes) are decoded inline from the header slot; long
values are read from their `keccak256(slot)` data slots. `rawSlotValue` and `slot` refer to the
header slot in both cases.

### Reading many values in one call

```js
const vault = storage.contract('contracts/Vault.sol:Vault').target(vaultAddress);

// Any mix of finished chains; results come back in the same order.
const [alice, bob, total] = await storage.readMany([
  vault.name('balances').key(aliceAddress),
  vault.name('balances').key(bobAddress),
  vault.name('totalSupply'),
]);

// Shortcuts for "one variable, many keys / indices".
const balances = await vault.name('balances').readKeys([aliceAddress, bobAddress]);
const firstThree = await vault.name('items').readIndices([0, 1, 2]);
```

The contract/address check runs once per contract and address for the whole call, and every
read goes out together. If any query fails, the call rejects with the error of the first failing
query in the list.

### Dumping a whole variable

```js
const { value, skipped } = await vault.name('positions').readAll();
```

`readAll()` reads everything under the position it is called on: arrays become arrays, structs
become objects keyed by field name, to any depth.

A mapping cannot be enumerated — Solidity does not store its keys — so a mapping comes back as
an empty `Map` and its path is listed in `skipped`. Supply the keys you want and those entries
are read:

```js
const { value } = await vault.name('account').readAll({
  keys: {
    allowances: [spenderA, spenderB], // field `allowances` of the struct
    'allowances{}': [tokenA], // second level of that nested mapping
    'orders[].fills': [fillId], // field `fills` of every element of `orders`
  },
});
```

Patterns are relative to where `readAll()` is called: field names joined with `.`, `[]` for any
array element, `{}` for any mapping value, and `""` for the position itself. Keys for nested
levels combine as a cross-product. `Map` keys are your own values, unmodified, so look entries
up with the same value you supplied. See [`USAGE.md`](USAGE.md) for the full rules, the size cap
(`maxElements`, default 10,000) and how a dump stays on one block.

## Errors

Nothing is ever silently wrong. Each failure of the query itself has its own class:

| Error | Cause |
|---|---|
| `ContractNotFoundError` | `.contract(fqn)` names a contract with no layout in build-info |
| `ContractMismatchError` | the code at `.target(address)` does not plausibly match `.contract(fqn)` |
| `VariableNotFoundError` | unknown variable — with a distinct message when it is a `constant`/`immutable`, which never appear in `storageLayout`, and when the name exists but is not declared in the contract given as `declaredIn` |
| `AmbiguousVariableError` | the layout has more than one variable with that name (a private variable re-declared along the inheritance chain) and `.name()` was not given a `{ declaredIn }` that singles one out |
| `PathSegmentCountMismatchError` | too few or too many path segments |
| `PathSegmentKindMismatchError` | right count, wrong kind — `.index()` on a mapping, `.field()` on an array, an unknown struct field |
| `IndexOutOfBoundsError` | index is negative, not an integer, or beyond the array's length at the block being read |
| `UnsupportedTypeError` | a type encoding this version will not guess at |
| `DumpTooLargeError` | `readAll()` met an array, key list or total above `maxElements` |
| `DumpInconsistentError` | storage changed while `readAll()` was reading at a block tag that can move |
| `StorageLayoutNotAvailableError` | exported by `hardhat-storage-decoder/hardhat2` only; the build-info for the contract exists but holds no `storageLayout` (compile once after installing) |
| `MissingStorageLayoutError` | exported by `hardhat-storage-decoder/hardhat3` only; the build-info has no solc output or no `storageLayout` for the contract, or the config has no `solidity` profiles to inject the selector into |

All of these extend `StorageDecoderError`. Invalid arguments and malformed node responses are
plain `TypeError`/`RangeError`, and provider failures pass through unchanged. Importing the bare
package name instead of a subpath throws `HardhatStorageDecoderEntrypointError`, a plain
`Error` subclass that names the two subpaths.

When two contracts in an inheritance chain each declare a private variable with the same name,
say which one you mean by the name of the contract that declares it:

```js
await storage./* ... */ name('owner', { declaredIn: 'Base' }).read();
```

The full `<source path>:<ContractName>` form is needed only when two of the declaring contracts
share a bare name. Copy it from `AmbiguousVariableError.declaringContracts` (the error message
lists the same strings): the source path is the one the compiler recorded, which on Hardhat 3
carries a `project/` prefix for project files (`project/contracts/Base.sol:Base`).

## Supported encodings

Value types (including `bytesN`, enums, contract types, and user-defined value types), packed
slots, fixed and dynamic arrays with correct packing arithmetic (including trailing-gap cases
such as `uint96[]`), structs, `string`/`bytes` in both short and long form, mappings with every
key encoding, and arbitrary compositions of the above. A function-typed variable is read as the
raw `0x` hex of its 24 (external) or 8 (internal) bytes. Inheritance resolves through solc's own
per-contract layout.

## Not in v1

- **Enumerating a mapping.** `readAll()` reads only the keys you supply. Discovering keys
  automatically (by replaying transactions on a local network) is planned for v2.
- **Proxy contracts.** Reading through a proxy means the implementation's layout against the
  proxy's address; you can do it manually by passing the implementation FQN, but there is no
  automatic detection, and the `ContractMismatchError` heuristic will reject the combination.
- **Address → FQN auto-resolution.** `.contract(fqn)` is required.
- **Contracts without local source.** Layouts come from your own build-info only.
- **Empirical/runtime slot probing** (Foundry `stdstore`'s `vm.record` approach). Slots are
  computed statically.

## Development

```bash
npm run test:unit         # golden-JSON unit suite (no compile, no network)
npm run typecheck:core    # typecheck + assert src/core/** has zero hardhat imports
npm run typecheck:hh2     # typecheck the HH2 adapter against real hardhat@2 types
npm run typecheck:hh3     # typecheck the HH3 adapter against real hardhat@3 types
npm run build             # tsup, one pass per entrypoint
npm run test:e2e:hh2      # on-chain suite in the Hardhat 2 fixture workspace
npm run test:e2e:hh3      # on-chain suite in the Hardhat 3 fixture workspace
npm run verify:package    # build, then: error names + load every entrypoint + publint + attw + publish dry run
npm run bench             # timing comparison against the previous release (not part of CI)
npm run fixtures:generate # regenerate golden layouts with the pinned solc
```

The build resolves both Hardhat majors at once through an npm-alias + tsconfig `paths`
mechanism. It is deliberate and not simplifiable — read
[`docs/build-internals.md`](docs/build-internals.md) before touching it.

## License

MIT
