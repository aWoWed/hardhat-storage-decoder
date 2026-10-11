# REMAINING

What is not done, and what has and has not been verified, as of version 0.2.0 (2026-10-07).
The checks in section 2 were last re-run on 2026-10-11, after the fixes that followed the
independent review of that day (listed at the end of that section and in section 8).

## 1. `npm publish`

Not done. It needs registry credentials and 2FA.

- `npm run verify:package` passes end to end: the dist error-name check, `publint`,
  `@arethetypeswrong/cli` ("No problems found") and `npm publish --dry-run` (23 files, about 459 kB
  packed; `USAGE.md` and `docs/` now ship).
- `attw` used to fail, on 0.1.0 as well: the `./hardhat2` and `./hardhat3` subpaths did not
  resolve under `node10` module resolution, which is what a TypeScript project gets from
  Hardhat 2's default `"module": "commonjs"` tsconfig. `package.json` now carries a
  `typesVersions` map for the two subpaths. This is verified by `attw`, not by compiling a real
  `node10`-resolution consumer project.
- `publint` passes, with one suggestion: declare `"sideEffects"`. The Hardhat 2 entry has
  import-time side effects, so `false` would be wrong for it.
- Confirm the package name is still free immediately before publishing.

## 2. Verification status

| Check | Status |
|---|---|
| `npx vitest run` (unit + adapter tests) | 528 passing (20 files) |
| `npm run typecheck:core` | clean; core purity check passes (10 files, zero hardhat imports) |
| `npm run typecheck:hh2`, `typecheck:hh3` | clean |
| `npm run build` | clean, all three entrypoints |
| `node scripts/check-dist-error-names.mjs` | passes on this build; fails on the 0.1.0 build in all four bundles (negative control) |
| `node scripts/check-dist-entrypoints.mjs` | passes: every built entrypoint is loaded with a real `require` and a real `import`; it failed on the `./hardhat2` import before the ESM wrapper existed |
| `npm run test:e2e:hh2` | 119 passing on Hardhat 2 |
| Hardhat 3 e2e | 125 passing, run as `npx -y node@22.14 scripts/run-e2e.mjs hh3` |
| `npm run verify:package` | passes: build, dist error names, entrypoint loads, `publint`, `attw`, publish dry run |

The Hardhat 3 suite needs Node ≥ 22.13. `npm run test:e2e:hh3` on an older default Node will
not work; use the `npx node@22.14` form above.

The e2e suites that are the same for both Hardhat majors (`10-values` through `80-shadowed-names-and-function-types`) live
once, in `test/fixtures/e2e/`. `test/fixtures/copy-fixtures.mjs`, run from each workspace, copies them into
its own `test/e2e/shared/` before a run, next to the contracts it already copied; the suites
reach the package through that workspace's `test/e2e/adapter.ts` and `helpers.ts`. Edit the
originals: the copies are overwritten on every run. `00-layout-injection` (and Hardhat 3's
`05-connection-surface`) stay per workspace because they test what differs.

One existing unit test was changed on purpose in 0.2.0: "throws before issuing the value read"
in `test/unit/storageQueryBuilder.test.ts` asserted the old call pattern. It is now "reports
out-of-bounds; the speculative value read is discarded".

A second unit test assertion changed on 2026-10-10: `test/unit/parseStorageLayout.test.ts` now
finds `Pair`'s type id by label instead of hard-coding it, because adding NatSpec to the
fixture contracts shifts solc AST ids.

Seven input-validation fixes followed on 2026-10-10 and 2026-10-11, with 33 new unit tests
(255 → 288). They are not yet released and change what a caller sees for malformed input:

- `.index(NaN)` and `.index(±Infinity)` reject with a `TypeError` naming the index. They used to
  surface the engine's `RangeError` from a failed `BigInt` conversion.
- A blank string given as an integer mapping key is rejected. `BigInt("")` is `0n`, so it used
  to read key 0.
- A bigint given as a `string`, `address`, `bytesN` or `bytes` mapping key gets the intended
  message; it used to fail inside `JSON.stringify` while that message was being built.
- A negative `bigint` block number is rejected with a `TypeError`, as a negative `number`
  already was. It used to be sent to the node as `0x-1`.
- A `string`/`bytes` slot holding a long-form header that declares fewer than 32 bytes is
  refused with a `RangeError`. solc stores such values inline, so the header is not one it
  wrote; a declared length of 0 used to fail later with an unrelated `TypeError`, and 1–31
  used to be decoded.
- `.index()` given something that is neither a number nor a bigint is rejected with a
  `TypeError`. Only plain JavaScript can pass one; `.index("")` used to read element 0.
- `.at()` given something that is not a string, number or bigint is rejected with a
  `TypeError`. Only plain JavaScript can pass one; 0.2.0 as first built forwarded it to the
  node as given.

The independent review of 2026-10-11 led to the fixes below, each with a test that failed
first (unit and adapter tests 288 → 528; e2e 104 → 119 and 110 → 125). They are not yet
released. What a caller sees differently:

- **A variable name declared more than once** along an inheritance chain (a private variable
  re-declared in a derived contract) no longer resolves silently to the base's slot. `.name('x')`
  rejects with `AmbiguousVariableError`, which lists the declaring contracts;
  `.name('x', { declaredIn: 'Derived' })` selects one, by bare contract name or by the
  `path/File.sol:Name` form the error lists. An unknown `declaredIn` is a
  `VariableNotFoundError`. solc's layout does not record the declaring contract, so it is
  taken from the build's ASTs: both adapters do this; a caller of `parseStorageLayout` must
  pass `declaringContracts` (from `extractDeclaringContracts`) or the name stays ambiguous.
- **A `number` beyond `Number.MAX_SAFE_INTEGER`** as a mapping key, array index or block
  number is rejected with a `TypeError` asking for a `bigint`. It used to be accepted after
  JavaScript had already rounded it, so a different key or element was read.
- **A contract with a function-typed state variable** can be read. It used to fail at parse for
  every variable. The function value itself is returned as raw hex (24 bytes external, 8
  internal). This adds a `function` member to the exported `ValueKind` union, the one type
  change here that is not purely additive: consumer code that switches exhaustively over
  `ValueKind.family` must handle it.
- **A fixed array longer than 2^53 elements, or an array of elements that large,** is refused
  with `UnsupportedTypeError` when a path indexes into it. It used to derive wrong slots. The
  layout itself still parses, so a contract with `uint256[2**64] gap;` keeps its other
  variables readable, and a struct's fields stay reachable past an oversized member. A
  malformed layout (an offset or a value type's size beyond 2^53) is refused at parse.
- **Derived slots wrap modulo 2^256**, as the EVM does, and `formatSlot` rejects a slot outside
  that range with a `TypeError`.
- **A stored string that begins with a byte-order mark** is returned with it.
- **A user-defined value type named `toString`, `valueOf` or `constructor`** no longer
  crashes the parser.
- **Hardhat 2: `import` of the `/hardhat2` subpath works.** The ES-module entry is now a
  generated wrapper over the CommonJS build, so one copy of the plugin is loaded.
- **Hardhat 2: no stale layout after a recompile from another process.** The reader clears
  Hardhat's artifact cache before every first load of a contract; other plugins in the same
  process lose their cached artifact paths once per contract per decoder.
- **Hardhat 2: first reads that overlap share one build-info parse.** To group them the reader
  reads each contract's `.dbg.json` for its build-info path; if that file cannot be read it
  falls back to an unshared load.
- **Hardhat 3: the parsed compiler output is no longer kept in memory**; only the layouts, the
  user-defined-type map, the declaring contracts and the constant names are.
- **New exports from both adapter entrypoints:** `parseStorageLayout`,
  `extractUserDefinedValueTypes`, `extractConstantAndImmutableNames`,
  `extractDeclaringContracts` and `AmbiguousVariableError`.
- **Packaging:** `USAGE.md` and `docs/` ship; `verify:package` builds first; `prepack` builds.

Six assertions in `test/adapters/hh2/readBuildInfo.test.ts` that counted `clearCache` calls
were raised by one each, because they encoded the old "clear only after a change or failure"
rule. `test/unit/errors.test.ts` gained the new error class in its table. No other existing
test changed.

## 3. Benchmark

`npm run bench`, 1,000 reads of one mapping, simulated latency (5 ms requested per RPC call,
13.3 ms achieved on the Windows machine it ran on, because of timer granularity):

| Scenario | 0.1.0 | 0.2.0 |
|---|---|---|
| 1,000 × `.read()`, one at a time | 31.4 s (31.35 ms each) | 15.6 s (15.63 ms each) |
| RPC calls for those | 1,000 `getCode` + 1,000 `getStorageAt` | the same, issued in pairs |
| one `readMany` of 1,000 | not available | 66 ms |
| RPC calls for that | — | 1 `getCode` + 1,000 `getStorageAt` |

Not measured: a real remote or forked network. Fork mode exists in the script but needs
`FORK_URL`, `FORK_ADDRESS`, `FORK_FQN` and `FORK_VARIABLE` naming a contract that already
exists on the forked chain.

## 4. Known limitations

- **Mappings cannot be enumerated.** `readAll()` reads only the keys the caller supplies.
- **Proxy contracts** — no detection; the contract/address check will reject a proxy address
  read with the implementation's name.
- **Address → contract name resolution** — `.contract(fqn)` is always required.
- **Contracts without local source** — layouts come from the project's own build-info only.
- **`readMany` is not a snapshot** under a moving tag such as `"latest"`; pass
  `.at(blockNumber)` when one consistent block matters. `readAll()` pins `"latest"` itself.
- **An unpinned `readAll()` is checked, not guaranteed.** At `"pending"`, `"safe"`,
  `"finalized"` or an unrecognised tag, array and string lengths are re-read afterwards and a
  change raises `DumpInconsistentError`; unchanged lengths do not prove unchanged elements.
- **Hardhat 2 re-parses the build-info once per contract, unless the first reads overlap.**
  Hardhat exposes no lookup by build id. Reads in flight at the same time share one parse; a
  first read that starts after they finish parses again.
- **`declaredIn` needs the build's ASTs.** Through the adapters it always has them. The full
  `path/File.sol:Name` form uses the path the compiler records, which is not always the form
  passed to `.contract()`; the bare contract name works in both adapters.
- **Hardhat 3: a failed artifact lookup clears Hardhat's artifact cache and retries once.**
  This is what lets the decoder find a contract compiled after the process started (Hardhat
  3.13 never refreshes its own listing), but it costs a directory walk per failed lookup.
- **Hardhat 3: an inherited `constant`/`immutable` declared in another file** now gets the plain
  "no storage variable named" message instead of the "declared constant or immutable" one, to
  match Hardhat 2 and to stop a same-named constant in an unrelated file from producing a
  wrong message.
- **Older Hardhat releases.** The recompile detection uses
  `formArtifactPathFromFullyQualifiedName` (Hardhat 2) and `getArtifactPath`/`clearCache`
  (Hardhat 3). Each is feature-detected; where one is missing the adapter caches for the life
  of the process, as 0.1.0 did. Only Hardhat 2.29.0 and 3.13.0 have been run.

## 5. Planned for v2

- **Automatic mapping-key discovery by transaction replay.** Trace every transaction
  (`debug_traceTransaction`), observe the keccak preimages the EVM computes, and recover the
  keys written to a mapping, so `readAll()` can include whole mappings without supplied keys.
  It can only work where full history is traceable — Hardhat's local in-process network — and
  not for state written before a fork point or on a remote network; the API must say so rather
  than return a partial mapping as if it were complete. It reverses the v1 decision not to do
  runtime slot probing and needs its own design.
- **Whole-contract dump**: every storage variable in one call.
- **Per-parent key lists** for nested mappings in `readAll()` (today nested keys are a
  cross-product).
- Event-log key sources were considered and rejected, because they can silently miss entries;
  revisit only as an explicitly best-effort mode.

## 6. Review record

The change was reviewed by three separate passes (architecture, code quality, security), each
"approve with fixes"; every fix they asked for was applied and the full verification in section
2 was re-run afterwards. Not reviewed again after those fixes: the fixes themselves were
verified by tests, not by a second review pass.

Known and left as is:
- A single `.read()` of a long `string`/`bytes` still creates all of its data-slot reads up
  front (up to the existing 16 MiB cap), as 0.1.0 did. Only `readAll()` counts data slots
  against `maxElements`.
- `scripts/bench.mjs` leaves its temp folders behind if one of its steps fails.
- The Hardhat 2 adapter `stat`s a path derived from the contract name before loading, with the
  same lack of traversal checking Hardhat's own `getBuildInfo` has for that name.

## 7. Housekeeping

- The git history starts at the 0.2.0 state described here. The 0.1.0 sources and tarball, and
  the review reports and probe scripts this file cites under `.omc/`, are kept in the
  maintainer's working copy and are not part of the repository (`.omc/` is ignored).
  `npm run bench` needs the 0.1.0 tarball; pass its path in `BENCH_BASELINE`.
- `docs/build-internals.md` records the `declare module` augmentation blocks as verified; both
  adapter `.d.ts` files in `dist/` contain them.

## 8. Findings of the 2026-10-11 independent review that were not fixed

All CRITICAL and HIGH findings are fixed. The items below are recorded, not fixed. The lane
reports with evidence are in `.omc/state/deep-dive3-lane{1-core,2-engine,3-verification}.md`.

Medium, left with a reason:

- Three test titles promise more than their assertions check: "never performs I/O" in
  `deriveSlot.test.ts` (true by construction), "covers each family" in
  `storageQueryBuilder.test.ts` (one slot is written and never read), and a `readAll` test
  titled "pattern, size or bounds" with no bounds case. Test hygiene; no behaviour is wrong.
- The Hardhat 3 module augmentation has no type-level test at the root; its only type gate runs
  inside the e2e workspace, which needs Node ≥ 22.13.
- Several lower-level exports of both adapters are documented only in the "Lower-level exports"
  tables in `USAGE.md`, not individually.

Low, core:

- Blank or out-of-range numeric layout fields other than those above are coerced, not rejected.
- `PathSegmentCountMismatchError.expected` can be `Infinity` for a struct with no finite leaf.
- A segment of an unknown kind from plain JavaScript is reported as "but undefined was given".
- `extractPackedBytes` does not reject a negative offset or a fractional size.
- `toStorageWord` rejects some compact quantities and accepts `"0x"` as zero.
- Lenient key coercions: lone surrogates in a string key, an address with a wrong EIP-55
  checksum, and a `bytesN` key shorter than N (padded) are all accepted.
- A `transient` state variable gets the constant-or-immutable hint in its not-found message.
- An unknown struct field is reported as `PathSegmentKindMismatchError`.

Low, engine and adapters:

- `readAll({ keys: new Map(...) })` is silently ignored; `keys` must be a plain object.
- For `grid[999][5]` on `uint256[3][]`, the inner fixed-array index is reported, with no
  storage read, although the docs say the outermost out-of-bounds index is reported.
- `readAll()` reports whichever branch fails first in time, and `skipped` follows read timing,
  not document order.
- Hardhat 3: a bare contract name keeps resolving after a later compile makes it ambiguous.
- The artifact stamp (mtime and size) could miss a rewrite of the same size within one clock
  tick. Not reproduced.
- `memoKey` throws an opaque error for an object block tag without `toString`.
- Hardhat 2 provider messages say "object" for a `null` reply.
- The output-selection helpers assume a well-formed user `outputSelection`.

Low, packaging and process:

- `package-lock.json` still records version 0.1.0.
- `scripts/check-core-purity.mjs` misses a few import forms (template-literal `import()`, the
  `hardhat-v2`/`hardhat-v3` aliases, relative imports into the adapters) and does not scan
  `src/shared/`; `tsc` covers most of them.
- No `.nvmrc`; `engines: >=18` is not exercised on Node 18 or 20 by any check.
- `verify:package` builds three times (explicitly, and once each inside `attw --pack` and the
  publish dry run).

Low, found by the re-check of the fixes themselves (`.omc/state/review-fix-recheck.md`):

- **Elements of an oversized fixed array cannot be read.** `gap[i]` on `uint256[2**64] gap;`
  is refused, because the array's length does not fit a `number`. (The re-check found that
  such a type made the whole contract unreadable; that part is fixed, see section 2.)
- `.index(-(2**53))` given as a `number` is now a `TypeError` (unsafe integer); it was an
  `IndexOutOfBoundsError` (negative). Every other ordering of the index errors is unchanged.
- `AmbiguousVariableError`'s message says the declarations cannot be told apart when only some
  of them have a known declaring contract, although `declaredIn` does select the known ones.
- A `declaredIn` that is not a non-empty string (from plain JavaScript) is reported as a
  `VariableNotFoundError`, not a `TypeError`.
- Hardhat 2: shared build-info reads are released only when no load is in progress, so under a
  steady stream of overlapping first reads they stay offered to later loads until a quiet moment.
- Both adapters walk every AST three times on a build's first read.
- No test triggers a non-string RPC reply in either provider, or `readAll`'s
  `"keys" must be an object` error.
- `scripts/check-dist-entrypoints.mjs` can leave an empty staging directory behind if staging
  throws midway, and its child processes have no timeout.
- `parseStorageLayout`'s `types` lookup is a plain object; a hand-built layout with a type id
  such as `toString` passes the presence check. solc does not produce such ids.
- One unwrapped 150-column comment line and one spacing slip in `src/hardhat3/readBuildInfo.ts`.
