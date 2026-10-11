# Build internals

This repo has one genuinely unobvious mechanism. It exists for a reason, it was verified
empirically, and simplifying it will break the build in ways that are not obvious from the
error messages. This document is the explanation so that does not happen.

## The constraint

Hardhat 2 and Hardhat 3 cannot both resolve as the package named `hardhat` in a single
`node_modules`. That is normally a test-environment problem, but here it reaches the package's
own build: `src/hardhat2/` and `src/hardhat3/` each augment their major's runtime types
(`hre.storageDecoder` for HH2, `(await hre.network.getOrCreate()).storageDecoder` for HH3;
`connect()` also works but is `@deprecated` in hardhat@3.13.0 in favour of `create()` /
`getOrCreate()`), so the root
build has to typecheck against **both** majors' real type definitions.

## The mechanism

Two pieces:

### 1. npm alias installs

`package.json` declares both majors under aliased names:

```json
"devDependencies": {
  "hardhat-v2": "npm:hardhat@^2.29.0",
  "hardhat-v3": "npm:hardhat@^3.13.0"
}
```

Both are physically present in one `node_modules`, under distinct folder names. Neither is
named `hardhat`, so they never collide.

`hardhat` itself is a **peer** dependency, and `peerDependenciesMeta.hardhat.optional` is set.
That is not cosmetic: without it npm auto-installs a real `hardhat` at the root for peer
resolution, and a stray root-level `hardhat@3` can make the HH2 adapter silently resolve
against the wrong major.

### 2. Per-adapter `tsconfig` `paths` remapping

`tsconfig.hardhat2.json` and `tsconfig.hardhat3.json` remap the bare `hardhat` specifier onto
the corresponding alias, for **type-checking only**. The adapter sources still write
`import ... from "hardhat"`, so the *emitted* `.d.ts` also references the bare specifier —
which is what resolves correctly in a real consumer's project, where exactly one Hardhat major
is installed for real. Consumers never see the alias trick.

**The two mappings are not symmetric, and must not be made symmetric.**

```jsonc
// tsconfig.hardhat2.json
"module": "commonjs", "moduleResolution": "node",
"paths": {
  "hardhat":   ["./node_modules/hardhat-v2"],
  "hardhat/*": ["./node_modules/hardhat-v2/*"]
}
```

```jsonc
// tsconfig.hardhat3.json
"module": "nodenext", "moduleResolution": "nodenext",
"paths": {
  "hardhat":   ["./node_modules/hardhat-v3/dist/src/index.d.ts"],
  "hardhat/*": ["./node_modules/hardhat-v3/dist/src/*"]
}
```

Why they differ:

| | Hardhat 2 | Hardhat 3 |
|---|---|---|
| `exports` field | none | present, routes into `dist/src` |
| `.d.ts` location | package root | `dist/src/**` |
| module format | CommonJS | ESM (`"type": "module"`) |
| `paths` target | the package directory | the concrete `dist/src` files |
| `module`/`moduleResolution` | `commonjs` / `node` | `nodenext` / `nodenext` |

The HH3 target has to reach into `dist/src` because **TypeScript's `paths` substitution does
not consult a package's own `exports` map**. Pointing `paths` at `./node_modules/hardhat-v3`
finds nothing usable.

Both configs need a `hardhat/*` wildcard key in addition to the bare `hardhat` key. A `paths`
key without `/*` never matches a subpath import, so mapping only `hardhat` produces `TS2307` on
`hardhat/config` and `hardhat/types/runtime`.

### Known HH3 gotcha

HH3's augmentation target is the `NetworkConnection` interface in `hardhat/types/network`. Its
type-parameter list — `<ChainTypeT extends ChainType | string = DefaultChainType>` — must be
reproduced **exactly** in the `declare module` block, or TypeScript raises `TS2428`
("All declarations of 'NetworkConnection' must have identical type parameters").

## Build outputs

`npm run build` runs tsup once per entrypoint, each pinned to its own tsconfig:

| entry | tsconfig | output |
|---|---|---|
| `src/index.ts` | `tsconfig.json` | `dist/index.{cjs,mjs,d.ts,d.mts}` |
| `src/hardhat2/index.ts` | `tsconfig.hardhat2.json` | `dist/hardhat2/index.{cjs,mjs,d.ts,d.mts}` |
| `src/hardhat3/index.ts` | `tsconfig.hardhat3.json` | `dist/hardhat3/index.{cjs,mjs,d.ts,d.mts}` |

`dist/hardhat2/index.mjs` is not the bundle tsup emits. Hardhat 2 has no `exports` map, so an
ES module cannot import `hardhat/config` (Node's ES-module resolver adds no `.js`), and a
second, ES-module copy of the plugin would in any case register itself with Hardhat twice and
carry its own error classes. So the `onSuccess` step of the Hardhat 2 build in
`tsup.config.ts` overwrites that file with a wrapper that imports `./index.cjs` and re-exports
each of its names; `import` and `require` then share one plugin instance. The export list is
read from the CommonJS bundle that was just written. The `esm` format is still built because
that is what emits `index.d.mts`. The Hardhat 3 ES-module bundle is a real bundle: that adapter
imports Hardhat's types only.

The CJS declarations are `.d.ts`, not `.d.cts`: tsup 8.5.x derives the declaration extension
from the package's `"type": "commonjs"` and ignores `outExtension`'s `dts` key (see the comment
in `tsup.config.ts`).

`hardhat` and `@noble/hashes` are marked **external**. `@noble/hashes` is a declared runtime
dependency; bundling it would ship it twice.

> **Verified:** tsup's `rollup-plugin-dts` pipeline does preserve the
> `declare module "hardhat/types/runtime" { ... }` (and the HH3 `NetworkConnection`)
> augmentation blocks verbatim — confirmed by inspecting the built `dist/hardhat2/index.d.ts`
> and `dist/hardhat3/index.d.ts`, both of which contain their augmentation blocks intact. If a
> future tsup upgrade ever drops or rewrites one, that would be a regression to catch via the
> type-level augmentation gate in each fixture workspace (`test/types/augmentation.test-d.ts`),
> not a standing risk to keep re-checking by hand.

## Root entrypoint

The root `.` export points at a module that does nothing but throw. Its only job is to turn
`require("hardhat-storage-decoder")` from a cryptic `ERR_PACKAGE_PATH_NOT_EXPORTED` into a
message naming the two real subpaths. It deliberately does **not** sniff the installed Hardhat
version — the two majors register plugins differently, so auto-detection would only move the
failure somewhere less obvious.

## Fixture test workspaces

Separate from the alias mechanism above, `test/fixtures/hh2-project/` and
`test/fixtures/hh3-project/` are real, single-major Hardhat projects used by the on-chain
suites.

They install the package under test from a **packed tarball**, never `file:` or `link:`.
A `file:` dependency is symlinked, and Node resolves a symlinked package from its *realpath* —
so `require("hardhat")` from inside the linked `dist/hardhat2/index.cjs` would resolve starting
at the package root, whose `node_modules` holds only the aliases. Verified empirically to fail
with `Cannot find module 'hardhat/config'`.

Order: `npm run build` → `npm pack --ignore-scripts` →
`npm i ../../../hardhat-storage-decoder-<version>.tgz` → `hardhat compile` → run the suite.
`scripts/run-e2e.mjs` does this. (`--ignore-scripts` only skips the package's `prepack`, which
would run the same build a second time.)

Neither workspace's `hardhat.config` may declare `solidity.settings.outputSelection`. If a
config supplied the storage layout by hand, the e2e suite would pass even if the plugin's
`outputSelection` auto-injection silently did nothing — verification that cannot fail. Each
suite's first test clears the build-info cache, compiles, and asserts a non-empty
`storageLayout` is present before any read assertions run.

Solidity fixtures live once in `test/fixtures/contracts/` and are **copied** into each
workspace by a pretest script — not symlinked, because this project is developed on Windows
where symlink creation needs elevation or Developer Mode.

## Checks on the built package

`dist/` is the only code that ships, and it is not committed, so two things keep a stale or
unloadable build from being packed:

- `prepack` runs `npm run build`, so `npm pack` and `npm publish` always pack a build of
  the current sources. `npm run verify:package` also builds first, for the checks that run
  before its packing steps.
- `scripts/check-dist-entrypoints.mjs` (part of `verify:package`) loads `.`, `./hardhat2` and
  `./hardhat3` with a real `require` and a real `import`. `publint` and `attw` only read
  files, and each fixture workspace loads one module format, so this script is the only thing
  that executes the other format of each adapter. For the same realpath reason as above it
  cannot load `dist/` in place: it copies `package.json` and `dist/` into a temporary
  `node_modules/.cache/…/node_modules/hardhat-storage-decoder` — inside the Hardhat 2
  workspace for `./hardhat2`, where a real Hardhat 2 is one directory level up, and inside the
  root for the other two, which import no Hardhat at runtime. It therefore needs the Hardhat 2
  workspace to have been installed once. It also compares the Hardhat 2 wrapper's exports
  with the CommonJS build's, name by name and object by object.

## Golden unit fixtures

`test/unit/fixtures/layouts.json` is generated by `npm run fixtures:generate`, which compiles
`test/fixtures/contracts/*.sol` with the pinned solc (`0.8.26`, exact) and writes out the real
`storageLayout` blobs.

They are real compiler output rather than hand-authored JSON on purpose: a wrong assumption
about the layout shape then fails the suite instead of being written into both the code and
its expectations. For example, solc reports `numberOfBytes: "32"` for `uint8[10]`, so deriving
a fixed array's length from a byte ratio gives 32 instead of 10 — the fixture makes that
concrete.

Regenerate them whenever a fixture contract changes or solc is bumped.

## The `storageLayout` gap that forces an AST read

solc's `storageLayout` does **not** record a user-defined value type's underlying type. A
`type Id is bytes32` and a `type Id is uint256` produce identical entries:

```json
"t_userDefinedValueType(Id)3": { "encoding": "inplace", "label": "Id", "numberOfBytes": "32" }
```

The two pad in opposite directions as mapping keys, so this is not a detail that can be
guessed. The underlying type comes from the compilation AST instead
(`UserDefinedValueTypeDefinition.underlyingType`), whose node `id` matches the numeric suffix
in the layout's type identifier. `extractUserDefinedValueTypes()` builds that map; adapters
pass it to `parseStorageLayout()`.

When the map is unavailable, the type is carried as `unresolvedUserDefinedValueType` and throws
a precise `UnsupportedTypeError` at the point the rule actually matters — encoding it as a
mapping key, or decoding it — rather than silently picking a padding direction.
`extractConstantAndImmutableNames()` comes from the same AST walk and is what lets
`VariableNotFoundError` say "declared constant or immutable" instead of implying a typo.
