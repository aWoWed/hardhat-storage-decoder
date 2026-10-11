# Code walkthrough: one read, start to finish

This document follows a single real query — `records[who][1].b` on the `StructStorage` fixture — through every file it touches, from the user's call to the returned value. The general design (module split, slot rules, read pipeline) is in [USAGE.md § Architecture](../USAGE.md#architecture) and is not repeated here.

## The query

The contract is `test/fixtures/contracts/StructStorage.sol` (comments omitted):

```solidity
struct Inner {
    uint128 a;
    uint128 b;
    address c;
    uint256 d;
}
mapping(address => Inner[]) public records;
```

The call being traced, on Hardhat 2:

```ts
const result = await hre.storageDecoder
  .contract("contracts/StructStorage.sol:StructStorage")
  .target(address)          // where it is deployed
  .name("records")
  .key(who)                 // mapping(address => ...)
  .index(1)                 // Inner[]
  .field("b")               // Inner.b
  .read();
```

The fully-qualified name has the same form on Hardhat 2 and Hardhat 3: the source path relative to the project root, a colon, and the contract name.

Everything below uses these symbols:

| Symbol | Meaning | Known without hashing? |
|---|---|---|
| `p` | declared slot of `records` | yes: `0` |
| `m` | slot of `records[who]` (also the array's length slot) | no: `keccak256(pad32(who) ‖ pad32(p))` |
| `base` | slot of the first array element | no: `keccak256(pad32(m))` |
| `e` | slot holding `records[who][1].b` | `base + 3` |

`pad32(x)` means `x` as 32 big-endian bytes, zero-filled on the left. `‖` is concatenation.

## 1. Getting a decoder and building the query

**Hardhat 2** — `src/hardhat2/index.ts`. Importing the module calls `ensureStorageLayoutOutput()` (step 2) and registers an `extendEnvironment` callback that defines `hre.storageDecoder` as a getter. The getter calls `createHardhatStorageDecoder(hre)` on first access and keeps the result. That function builds a `StorageDecoderContext` from five pieces and passes it to `createStorageDecoder`:

| Context member | Supplied by |
|---|---|
| `getLayout`, `getDeployedBytecode` | `createBuildInfoReader(hre)` in `src/hardhat2/readBuildInfo.ts` |
| `getStorageAt` | `createGetStorageAt` in `src/hardhat2/provider.ts` |
| `getCode` | `createGetCode` in `src/hardhat2/provider.ts` |
| `getBlockNumber` | `createGetBlockNumber` in `src/hardhat2/provider.ts` |

The provider is passed as a function (`() => hre.network.provider`), so no network is touched until a query runs.

**Hardhat 3** — `src/hardhat3/index.ts` exports the plugin object `storageDecoderPlugin`, which declares two lazily imported hook categories. The `network` one (`networkHooks` in `src/hardhat3/hooks/network.ts`) handles `newConnection`: it lets Hardhat create the connection, then calls `attachStorageDecoder(connection, context.artifacts)` from `src/hardhat3/storageDecoder.ts`. That defines the same kind of lazy getter, on the connection instead of the HRE, and builds the context with `createStorageDecoderContext`. The members are the same five; the layout side comes from a `Hardhat3LayoutReader`, one per `ArtifactManager` (held in a `WeakMap` by `readerFor`).

From here on both adapters run identical code.

**The builder** — `src/core/query/StorageQueryBuilder.ts`. `createStorageDecoder(context)` returns a `StorageQueryBuilder` whose state is `{ segments: [], blockTag: 'latest' }`. Each chain method returns a new builder with a patched, frozen `QueryState`; nothing is validated and nothing is read yet. The three path methods append one `PathSegment` each:

```ts
  key(value: MappingKeyValue): StorageQueryBuilder {
    return this.#withSegment({ kind: 'key', value });
  }
```

After the chain above, the state is:

| Field | Value |
|---|---|
| `fullyQualifiedName` | `"contracts/StructStorage.sol:StructStorage"` |
| `address` | `address` |
| `variableName` | `"records"` |
| `segments` | `[{kind:'key', value: who}, {kind:'index', value: 1}, {kind:'field', name:'b'}]` |
| `blockTag` | `'latest'` (no `.at(...)` was called) |

`read()` is one line: it hands the context, the state and a fresh `CallScope` to `readOne` in `src/core/query/execute.ts`.

```ts
  async read(): Promise<StorageReadResult> {
    return readOne(this.#context, this.#state, new CallScope());
  }
```

## 2. Where the layout comes from

`readOne` first calls `requireComplete(state)`, which throws a `TypeError` if `.contract()`, `.target()` or `.name()` is missing (checked in that order). It then awaits `scope.layout(context, fullyQualifiedName)`, which calls `context.getLayout` and memoises the promise for the rest of this one call.

### Why `storageLayout` is in the compiler output at all

solc emits only what `settings.outputSelection` asks for, and the plugin adds the selector when it is registered.

| | File | What it does |
|---|---|---|
| HH2 | `src/hardhat2/ensureStorageLayoutOutput.ts`, `ensureStorageLayoutOutput` | An `extendConfig` extender rewrites every compiler's and override's `outputSelection` through `withRequiredOutputs`; a `TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT` subtask override does the same to the final solc input. Adds `storageLayout` and `evm.deployedBytecode` per contract, `ast` per source. |
| HH3 | `src/hardhat3/hooks/config.ts`, `configHooks` → `src/hardhat3/ensureStorageLayoutOutput.ts`, `withStorageLayoutOutputSelection` | The `resolveUserConfig` hook runs Hardhat's own resolution first, then returns a copy of the config in which every build profile's compilers and overrides request `storageLayout`, `evm.deployedBytecode.object` and `ast`. |

Both only add to an existing selection. Artifacts compiled before the plugin was installed have no layout until the project is recompiled once.

### Build-info → `storageLayout`

**HH2** — `createBuildInfoReader` in `src/hardhat2/readBuildInfo.ts`. Both reader methods go through the inner function `lookup`, which stamps the artifact and consults the cache. On a miss it calls `hre.artifacts.clearCache()` — before every load it starts, never on a cached read, so that the load does not follow a build-info path Hardhat resolved before a recompile — and then `load`:

1. `splitFullyQualifiedName` splits at the last colon into `sourceName` and `contractName`.
2. `readBuildInfo` gets the whole solc run. `buildInfoPathOf` reads the build-info file's path from the contract's `.dbg.json`, and the loads in progress whose contracts point at the same file share one `hre.artifacts.getBuildInfo(fullyQualifiedName)` call (the `buildInfoReads` map); a contract whose path cannot be told gets a call of its own. A throw or `undefined` becomes `ContractNotFoundError`.
3. The contract's entry is `buildInfo.output.contracts[sourceName][contractName]`. Missing → `ContractNotFoundError`. Present but with no `storageLayout` → `StorageLayoutNotAvailableError`.
4. `deriveFromAsts` walks the run's ASTs once per build id to collect user-defined value types, the declaring contract of each state variable and, per source file, constant/immutable names.
5. `parseStorageLayout(contract.storageLayout, {...})` produces the layout (step 3).
6. `evm.deployedBytecode.object` is kept alongside, `0x`-prefixed, for the contract check in step 5.

**HH3** — `Hardhat3LayoutReader` in `src/hardhat3/readBuildInfo.ts`. `getLayout` gets the contract's cache entry from `#entryFor` and starts `#loadLayout` unless the entry already holds a layout promise:

1. The artifact (read with `readArtifact`) gives a build-info id; `getBuildInfoId` is the fallback.
2. `#readBuildInfoOutput` asks Hardhat for the output file's path (`getBuildInfoOutputPath`), reads it, `JSON.parse`s it and hands solc's output to `deriveFromOutput`, which reduces it to a `BuildDerived`: each contract's raw `storageLayout`, the user-defined value types, the declaring contract of each state variable and the constant/immutable names per source. That reduced data is what is cached per build id; the parsed file itself (ASTs, bytecode, ABI) is not kept.
3. `#resolveContractOutput` finds the contract inside the build's `contracts`. solc keys that object by *input* source name, not the user source name in the FQN, so it tries the artifact's `inputSourceName`, then the build-info's `userSourceNameMap`, then the raw source name, then a scan that must match exactly one file.
4. No solc output, or no `storageLayout` for the contract → `MissingStorageLayoutError`. Otherwise `parseStorageLayout`.

### Cache validity

Both readers cache per fully-qualified name and validate every lookup against an `ArtifactStamp` — the artifact file's `{ mtimeMs, size }`, taken by `stampOf` in `src/shared/artifactStamp.ts` and compared by `sameStamp`. The stamp is taken *before* the load it is stored with, so a rewrite during the load leaves an older stamp behind and the next lookup reloads.

```ts
export function sameStamp(a: ArtifactStamp | undefined, b: ArtifactStamp | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}
```

Known limits, as the code stands:

- The stamp needs a path. HH2 uses `formArtifactPathFromFullyQualifiedName`, HH3 uses `getArtifactPath`; each is feature-detected. Where the method is missing the stamp is `undefined`, two `undefined` stamps compare equal, and a cached layout is then kept for the life of the process.
- HH2: the parsed build-info is referenced only while a load is in progress. First reads that overlap share one read of the file, but a first read that starts after the earlier loads have settled reads and parses it again, even for a contract of the same solc run. Only the AST-derived data is kept (keyed by build id, and dropped when a lookup finds a changed stamp).
- HH3: every AST of a build is walked on the build's first read, not only the ones the requested contract needs. The reduced data stays for as long as a cached contract belongs to the build (`#evictUnreferencedBuilds` drops it after that).
- HH3: any failed artifact lookup clears Hardhat's artifact cache and retries once (`#retryAfterClearingCache`) before reporting `ContractNotFoundError`. That costs a directory walk per failed lookup.
- Failures are never cached in either reader, so a read that failed for want of a compile works on the next attempt.

## 3. What the raw JSON becomes

`parseStorageLayout` in `src/core/layout/parseStorageLayout.ts` turns solc's `{ storage, types }` into a `ParsedStorageLayout`: `variables` (a `StorageVariable[]`) and `types` (a record of `TypeInfo` by type id). String numbers are coerced — `slot` to `bigint`, `offset` and `numberOfBytes` to `number`. An offset, or a value type's byte count, beyond `Number.MAX_SAFE_INTEGER` is refused with `UnsupportedTypeError`. A struct or fixed array that large (`uint256[2**64]` compiles) still parses: it is marked `oversized`, and what is refused is indexing a fixed array whose length is that large, or any array whose elements are, so the contract's other variables stay readable. `parseTypeEntry` assigns each type a `kind` from solc's `encoding` field, plus the presence of `members` or `base` for `inplace` types. Each variable also gets `declaredIn`, the contract that declares it as `<source path>:<ContractName>`, looked up by its AST id in the `declaringContracts` option (the adapters build that map with `extractDeclaringContracts`).

The committed layout for this contract is in `test/unit/fixtures/layouts.json` under `StructStorage.sol:StructStorage`. The variable entry for `records` is `slot: "0"`, `offset: 0`. The types on our path become:

| Type (label) | solc `encoding` | `TypeInfo.kind` | `numberOfBytes` | Links |
|---|---|---|---|---|
| `mapping(address => struct StructStorage.Inner[])` | `mapping` | `mapping` | 32 | `keyTypeId: t_address`, `valueTypeId:` the array below |
| `struct StructStorage.Inner[]` | `dynamic_array` | `dynamicArray` | 32 | `baseTypeId: t_struct(Inner)…_storage` |
| `struct StructStorage.Inner` | `inplace` + `members` | `struct` | 96 | four `StructMember`s |
| `address` (`t_address`) | `inplace` | `value` | 20 | `valueKind: { family: 'address' }` |
| `uint128` (`t_uint128`) | `inplace` | `value` | 16 | `valueKind: { family: 'uint', bits: 128, bytes: 16 }` |

The numeric part of the struct's type id is an AST id and changes between compilations, so it is elided here.

The struct's members, as parsed (`StructMember.slot` is a delta from the struct's base slot):

| Member | `slot` (delta) | `offset` | Type |
|---|---|---|---|
| `a` | 0 | 0 | `t_uint128` |
| `b` | 0 | 16 | `t_uint128` |
| `c` | 1 | 0 | `t_address` |
| `d` | 2 | 0 | `t_uint256` |

`ValueKind` is resolved by `resolveValueKind` from the type *id* (`t_uint128` matches `/^t_uint(\d+)$/`). It exists only on `value` and `dynamicBytes` types, the same two kinds `isTerminalType` accepts as the end of a path. A function type (`t_function_external_…`, `t_function_internal_…`) resolves to the `function` family.

## 4. The walk: `deriveSlot`

Back in `readOne`, the contract check is started but not yet awaited (step 5), and then the path is resolved:

```ts
    derived = deriveSlot(layout, variableName, segments, { declaredIn });
```

`deriveSlot` in `src/core/slots/deriveSlot.ts` is synchronous and does no I/O. `getVariable(layout, "records", { declaredIn })` supplies the starting `PathPosition`; an unknown name throws `VariableNotFoundError` here. A name the layout holds more than once (a private variable declared again in a derived contract) throws `AmbiguousVariableError` unless `declaredIn` — set by `.name(variable, { declaredIn })`, absent in this query — matches exactly one of the declaring contracts, by its full recorded form or by bare contract name; a `declaredIn` that matches none throws `VariableNotFoundError`. The loop then looks up the type at the current position, returns if it is terminal (`isTerminalType`), and otherwise consumes one segment with `stepSegment`.

Start: `{ slot: p = 0, offset: 0, typeId: <the mapping> }`.

### 4.1 Mapping step — `.key(who)`

The type's `kind` is `mapping` and the segment's `kind` is `key`, so the kinds agree (otherwise `PathSegmentKindMismatchError`). The key is encoded by `encodeMappingKey` according to the *key type's* `valueKind`, here `address`:

```ts
    case 'address': {
      const bytes = toByteArray(value, keyType.label);
      if (bytes.length !== 20) {
        throw new TypeError(
          `mapping key of type ${keyType.label} must be a 20-byte address, got ${bytes.length} byte(s)`
        );
      }
      return bigIntToBytes(bytesToBigInt(bytes), WORD_SIZE);
    }
```

`toByteArray` accepts a hex string or a `Uint8Array`. Anything that is not exactly 20 bytes is a `TypeError`. The result is `pad32(who)`. Hex case does not matter: the string is parsed to bytes, so a checksummed and a lowercase address give the same key.

The new slot is the keccak of key then slot, each 32 bytes:

```ts
          slot: bytesToBigInt(keccak256(concatBytes(encodedKey, bigIntToBytes(slot, WORD_SIZE)))),
          offset: 0,
```

So `m = keccak256(pad32(who) ‖ pad32(0))`, a 64-byte preimage. Position: `{ slot: m, offset: 0, typeId: <Inner[]> }`.

### 4.2 Dynamic-array step — `.index(1)`

`normalizeIndex` turns `1` into `1n` (a negative or non-integer index throws `IndexOutOfBoundsError` immediately; `NaN`, `±Infinity`, a value that is not a number or bigint, or an integer `number` beyond `Number.MAX_SAFE_INTEGER` throws a `TypeError` — such an index must be a `bigint`). The array's length lives in its own slot, `m`, which the walk cannot read. It records a `BoundsObligation` instead and carries on as if the index were valid:

| Obligation field | Value |
|---|---|
| `lengthSlot` | `m` |
| `index` | `1n` |
| `typeLabel` | `"struct StructStorage.Inner[]"` |
| `variableName` | `"records"` |
| `segmentIndex` | `1` |

The elements start at `hashOfSlot(m)`, i.e. `base = keccak256(pad32(m))`. `placeArrayElement` then places element 1. `Inner` reports `numberOfBytes = 96`, which is over one word, so the second branch applies:

```ts
  const slotsPerElement = BigInt(Math.ceil(elementBytes / WORD_SIZE));
  return { slot: wrapSlot(base + index * slotsPerElement), offset: 0 };
```

`slotsPerElement = ceil(96 / 32) = 3`, so the element starts at `base + 1 × 3 = base + 3`. `wrapSlot` reduces the sum modulo 2^256, as the EVM does when it adds to a storage location; every slot sum in this document is meant that way. Position: `{ slot: base + 3, offset: 0, typeId: t_struct(Inner)…_storage }`.

### 4.3 Struct-field step — `.field("b")`

The member is found by label (an unknown name throws `PathSegmentKindMismatchError` listing the available fields). The slot advances by the member's delta and the offset is *replaced* by the member's offset:

```ts
      return {
        position: {
          slot: wrapSlot(slot + member.slot),
          offset: member.offset,
          typeId: member.typeId,
        },
      };
```

For `b`: delta `0`, offset `16`. Position: `{ slot: base + 3 + 0, offset: 16, typeId: t_uint128 }`. For comparison, `.field("c")` would give `base + 4` at offset 0 and `.field("d")` `base + 5`.

### 4.4 Terminal

On the fourth loop iteration the type is `uint128`, a `value` kind. `assertNoSegmentsPastTerminal` confirms all three segments were consumed (extra ones throw `PathSegmentCountMismatchError`; stopping early at a composite type throws the same error from the loop). `terminalPlan` builds the `TerminalDescriptor`, and `deriveSlot` returns it with the obligations:

| `DeriveSlotResult` field | Value |
|---|---|
| `readPlan` | `{ kind: 'single', slot: e }` where `e = base + 3` |
| `offset` | `16` |
| `numberOfBytes` | `16` |
| `valueKind` | `{ family: 'uint', bits: 128, bytes: 16 }` |
| `typeLabel` | `"uint128"` |
| `obligations` | the one obligation from 4.2 |
| `variableName` | `"records"` |

The offset stays a separate field. It is never folded into the slot number.

## 5. Running the plan: `readOne`

`src/core/query/execute.ts`. The whole function, in order:

1. `requireComplete(state)`.
2. `await scope.layout(...)` — a layout error (`ContractNotFoundError`, `StorageLayoutNotAvailableError`, `MissingStorageLayoutError`) surfaces here, before anything else.
3. `scope.codeCheck(...)` — started, **not** awaited.
4. `deriveSlot(...)`. If it throws, the code check is awaited first and only then is the path error rethrown, so a contract mismatch wins over a path error.
5. The length read and the value read are issued together:

```ts
  const read = scope.reader(context, address, blockTag);
  const lengthReads = derived.obligations.map((obligation) =>
    scope.length(context, address, blockTag, obligation.lengthSlot, read)
  );
  const { readPlan } = derived;
  const firstRead = handled(read(readPlan.kind === 'single' ? readPlan.slot : readPlan.headerSlot));
```

6. The checks are awaited in a fixed order, then the value is decoded:

```ts
  const verified = handled(
    (async () => {
      await codeCheck;
      await awaitObligationsInOrder(derived.obligations, lengthReads);
    })()
  );
  await verified;
```

7. `readLeaf(read, derived, firstRead, verified)` decodes (step 7), and `blockTag` is added to the result.

For our query that is three RPC calls in flight at once: `eth_getCode(address)`, `eth_getStorageAt(address, m)` and `eth_getStorageAt(address, e)`.

**The contract check** — `assertContractMatchesTarget`. It fetches the artifact's deployed bytecode (`getDeployedBytecode`) and the on-chain code (`getCode`) together and throws `ContractMismatchError` if there is no code at the address, if the two differ in length, or if their first 32 bytes differ. It is a heuristic, not a proof: only total length and the first 32 bytes are compared. It is skipped when the context lacks either function, or when the artifact has no deployed bytecode. A proxy address read with the implementation's contract name fails this check; there is no proxy detection.

**The memos** — `CallScope` holds three maps per context: `layouts`, `codeChecks` (keyed by contract name, lower-cased address and block tag) and `lengths` (keyed by lower-cased address, block tag and slot). A plain `read()` creates its own `CallScope`, so the memos only pay off in `readMany` (and its sugar `readKeys`/`readIndices`), where many queries share one scope. Nothing is remembered between calls. Value reads are not shared.

**The concurrency limit** — `scope.reader` wraps `context.getStorageAt` in a `Semaphore` with `MAX_CONCURRENT_READS = 256` permits. Only storage reads go through it; `eth_getCode` does not. The limit is irrelevant to this two-read query and matters for `readMany`, long strings and `readAll`.

**Error precedence** — `awaitObligationsInOrder` (in `src/core/slots/decode.ts`) awaits the length reads strictly in path order and does not look at read `i + 1` until obligation `i` has passed:

```ts
  for (const [i, obligation] of obligations.entries()) {
    const length = bytesToBigInt(toStorageWord(await (lengthReads[i] as Promise<Uint8Array>)));
    if (obligation.index >= length) {
      throw new IndexOutOfBoundsError(
```

Reads are wrapped in `handled(...)`, which attaches a no-op `catch` so that a read which is issued and then never awaited cannot become an unhandled rejection.

**If index 1 is out of bounds** — say `records[who]` has length 1, or `who` has no entry and slot `m` is zero. The value read at `e` has already been sent and comes back (as zeros, or as whatever happens to be stored there). `awaitObligationsInOrder` sees `1 >= length` and throws `IndexOutOfBoundsError(1n, length, "struct StructStorage.Inner[]", "records")`. `await verified` rethrows it, `readLeaf` is never reached, and the value is discarded. The cost of the early read is one wasted RPC call.

## 6. The RPC call

`src/core/rpc/getStorageAt.ts` defines the seam, not the transport: `GetStorageAt` takes a `StorageReadRequest` (`{ address, slot, blockTag }`) and must resolve to exactly 32 bytes; `SingleSlotReader` is the same thing with address and block already bound (what `scope.reader` returns). The file also holds the formatting helpers both adapters use.

The HH2 implementation, `createGetStorageAt` in `src/hardhat2/provider.ts`:

```ts
    const result: unknown = await getProvider().send('eth_getStorageAt', [
      address,
      formatSlot(slot),
      formatBlockTag(blockTag),
    ]);
```

The HH3 one (`src/hardhat3/provider.ts`) sends the same three parameters through `provider.request({ method, params })`. Both reject a non-string result with a `TypeError` and pass the string through `toStorageWord`, which left-pads short results such as `"0x0"` to 32 bytes and rejects anything longer.

| Helper | Behaviour |
|---|---|
| `formatSlot` | `bigint` → `0x`-prefixed hex, no leading zeros; a negative slot, or one of 2^256 or more, throws `TypeError`. |
| `formatBlockTag` | `bigint` or non-negative integer `number` → hex quantity; a negative `bigint`, a `number` that is negative or not an integer (including `NaN` and `±Infinity`), a `number` beyond `Number.MAX_SAFE_INTEGER` (pass a `bigint`), or a value of any other type throws `TypeError`; any string (`"latest"`, `"safe"`, a hash, a preformatted quantity) is passed through unchanged. |

Block handling in a plain `read()` is exactly that and no more. The tag set by `.at(...)` (default `'latest'`) is passed unchanged to the code check and to every storage read. `read()` does not resolve `'latest'` to a number, so under a moving tag the three calls of this query are not guaranteed to land on the same block. Pass `.at(blockNumber)` when that matters. Only `readAll` pins `'latest'` itself.

## 7. Decoding

`readLeaf` (in `execute.ts`) wraps the reader so that the first slot asked for is answered by the already-issued `firstRead`, then calls `resolveReadPlan` and `decode` from `src/core/slots/decode.ts`.

`resolveReadPlan` with a `single` plan is one read and no logic:

```ts
  if (plan.kind === 'single') {
    const word = toStorageWord(await read(plan.slot));
    return { slotValues: [word], rawSlotValue: word, slot: plan.slot };
  }
```

`decode(slotValues, 16, 16, valueKind)` then cuts the value out of the word with `extractPackedBytes` (`src/core/util/bytes.ts`):

```ts
  const end = WORD_SIZE - offset;
  const start = end - size;
```

The word is held big-endian, as the RPC returned it: array index 0 is the most significant byte. solc's `offset` counts from the *least* significant end, so offset 0 is the last bytes of the array. For `b`, `end = 32 − 16 = 16` and `start = 16 − 16 = 0`, giving `word.slice(0, 16)`:

```
array index   0 ............... 15 | 16 .............. 31
contents      b  (offset 16)       | a  (offset 0)
              high-order half      | low-order half
```

`valueKind.family` is `'uint'`, so the 16 bytes go through `bytesToBigInt` and the value is a `bigint` — for every `uint` width, including small ones. A function-typed variable takes the same route and comes back as the `0x` hex of its raw bytes (24 for an external function, 8 for an internal one), like a `bytesN`.

The `StorageReadResult` the user gets:

| Field | Value for this query |
|---|---|
| `value` | `b` as a `bigint` |
| `slot` | `e` (`bigint`) — the slot actually read |
| `offset` | `16` |
| `rawSlotValue` | the full 32-byte word at `e` as a `Uint8Array`; it also contains `a` |
| `typeLabel` | `"uint128"` |
| `blockTag` | `'latest'`, exactly as held in the query state |

## Contrast: a `string` value

Take `longText` in `test/fixtures/contracts/StringStorage.sol` (declared slot 1; `shortText` is slot 0). The walk has no segments: the first loop iteration finds a `dynamicBytes` type and `terminalPlan` returns a `MultiSlotPlan`, `{ kind: 'multi', headerSlot: 1n, dataBaseSlot: keccak256(pad32(1)) }`, with `offset: 0`. It is always a multi plan, because short versus long depends on the stored data. `readOne` issues the header slot as `firstRead`. `resolveReadPlan` looks at the header's last byte: if its low bit is 0 the value is short, the length is that byte shifted right by one (more than 31 is a `RangeError`), and the data is the header's leading bytes; if the bit is 1 the length is `(header − 1) / 2` (less than 32 is a `RangeError`, since solc stores such values inline) and the data is `ceil(length / 32)` slots from `dataBaseSlot`, each slot number passed through `wrapSlot`. Those data reads go through the gated reader in `readLeaf`, which awaits `verified` first, so they are never sent before the contract check and all bounds checks have passed. `decode` takes `first.slice(0, length)` (short) or the concatenated data slots truncated to `length` (long) and returns a JS string via `bytesToUtf8` (`bytes` returns a hex string instead); a leading byte-order mark in the stored bytes is kept, as U+FEFF. In the result, `slot` and `rawSlotValue` are the header's in both forms. Two limits to know: a length over `MAX_DYNAMIC_BYTE_LENGTH` (16 MiB) is refused with a `RangeError`, and below that a single `read()` creates all of the long value's data-slot reads at once — the semaphore limits how many are in flight, not how many are created.

## Contrast: `readAll`

`readAll` goes to `readAllAt` in `src/core/query/dump.ts` instead of `readOne`, and it is not built on `deriveSlot`: it reuses the lower-level pieces (`stepSegment`, `terminalPlan`, `readLeaf`) directly. It differs in four ways. First, block handling: if the tag is `'latest'` and the context has `getBlockNumber`, it resolves the number once and reads everything at that block; the contract check is awaited *before* any storage read rather than alongside. Second, shape: after walking the builder's segments to a root position, the inner function `expand` recurses by `TypeInfo.kind` — every member of a struct, every element of an array (dynamic lengths read from storage), and for a mapping only the keys supplied in `options.keys` by path pattern; a mapping with no keys comes back as an empty `Map` and its pattern is listed in `skipped`. Third, limits: each expansion is counted against `maxElements` (default 10000) and exceeding it throws `DumpTooLargeError`, and slot reads are cached per slot so packed neighbours such as `a` and `b` cost one read. Fourth, consistency: when the effective tag does not name a fixed block (`isFixedBlockTag`), every array and string length the dump relied on is read again at the end and a change throws `DumpInconsistentError`. That is a check, not a snapshot — unchanged lengths do not prove unchanged elements. The result is a `StorageDumpResult` (`value`, `skipped`, `typeLabel`, `blockTag`), with nested arrays, prototype-less objects and `Map`s in place of a single decoded value.

## Where to look when…

| Question | File | Function / type |
|---|---|---|
| A mapping key encodes wrong (padding, sign, width) | `src/core/slots/deriveSlot.ts` | `encodeMappingKey` |
| An array element lands on the wrong slot or offset | `src/core/slots/deriveSlot.ts` | `placeArrayElement` |
| A struct field resolves to the wrong slot | `src/core/slots/deriveSlot.ts` | `stepSegment`, `case 'struct'`; check `StructMember` in the parsed layout |
| A packed value decodes as its neighbour | `src/core/util/bytes.ts` | `extractPackedBytes` |
| A type is classified wrongly, or `UnsupportedTypeError: unrecognised value type` | `src/core/layout/parseStorageLayout.ts` | `parseTypeEntry`, `resolveValueKind` |
| A name is reported as ambiguous, or `declaredIn` matches nothing | `src/core/layout/parseStorageLayout.ts` | `getVariable`, `extractDeclaringContracts`; the strings to pass are in `AmbiguousVariableError.declaringContracts` |
| A user-defined value type will not decode or hash | `src/core/layout/parseStorageLayout.ts` | `extractUserDefinedValueTypes`, and the `userDefinedValueTypes` option of `parseStorageLayout` |
| `ContractMismatchError` on an address you believe is right | `src/core/query/execute.ts` | `assertContractMatchesTarget` |
| Errors surface in an unexpected order, or an out-of-bounds read returns something | `src/core/query/execute.ts`, `src/core/slots/decode.ts` | `readOne`, `awaitObligationsInOrder` |
| A string decodes truncated, empty or as garbage | `src/core/slots/decode.ts` | `resolveReadPlan`, `decode` |
| "no storageLayout" after installing | `src/hardhat2/ensureStorageLayoutOutput.ts`, `src/hardhat3/ensureStorageLayoutOutput.ts` | `ensureStorageLayoutOutput`, `withStorageLayoutOutputSelection` |
| A stale layout after recompiling, or a contract not found | `src/hardhat2/readBuildInfo.ts`, `src/hardhat3/readBuildInfo.ts`, `src/shared/artifactStamp.ts` | `createBuildInfoReader`, `Hardhat3LayoutReader`, `sameStamp` |
| A read hits the wrong block, or a block tag is rejected | `src/core/rpc/getStorageAt.ts`, `src/hardhat2/provider.ts`, `src/hardhat3/provider.ts` | `formatBlockTag`, `createGetStorageAt` |
| A dump is too large, skips a mapping or reports inconsistency | `src/core/query/dump.ts` | `readAllAt`, `validatePatterns`, `isFixedBlockTag` |
