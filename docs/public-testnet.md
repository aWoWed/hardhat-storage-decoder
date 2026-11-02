# Public testnet mocks

Eleven sealed contracts, covering the families of storage encoding, meant for trying the decoder against a
real network. Each has known values, and `seal()` has stopped all writes to it, so a value read today
should still be there next month.

This page holds public data only: addresses, blocks and values. No key, and no RPC URL with a token.

## Addresses

The table below is generated from `deployments/manifest/deployments.json`, and
`node scripts/check-docs-manifest.mjs` fails if it differs. Addresses appear after deployment. Do not
take an address for these mocks from anywhere else.

<!-- deployments-table:start -->

### Sepolia (chain ID 11155111), generation 1

| Contract | Address | Deploy block | Seal block, from which values hold |
|---|---|---|---|
| MockValueTypes | [`0xb40E72994fFC3c71450d55C27598c5a54edDA762`](https://sepolia.etherscan.io/address/0xb40E72994fFC3c71450d55C27598c5a54edDA762) | 12045102 | 12045523 |
| MockPacked | [`0xF9591D2c69c06E876cAd58bA774F73AC1b48254F`](https://sepolia.etherscan.io/address/0xF9591D2c69c06E876cAd58bA774F73AC1b48254F) | 12045119 | 12045524 |
| MockMappings | [`0x08dC97e14FcD82137Eb9f47a282842d72f78b585`](https://sepolia.etherscan.io/address/0x08dC97e14FcD82137Eb9f47a282842d72f78b585) | 12045122 | 12045525 |
| MockArrays | [`0x1Cd5b3C3bD27f912098e6aa7b872c010646B2297`](https://sepolia.etherscan.io/address/0x1Cd5b3C3bD27f912098e6aa7b872c010646B2297) | 12045133 | 12045526 |
| MockEnums | [`0x7C4A0fBA09082F1062b4435426c5d1632a2fBE21`](https://sepolia.etherscan.io/address/0x7C4A0fBA09082F1062b4435426c5d1632a2fBE21) | 12045144 | 12045527 |
| MockStructs | [`0xF445cFc79A62E826429B0B76F1C0C26aFfd95279`](https://sepolia.etherscan.io/address/0xF445cFc79A62E826429B0B76F1C0C26aFfd95279) | 12045149 | 12045528 |
| MockStrings | [`0xc8467490C4349556a0e3830a5A1505c7e0199cc6`](https://sepolia.etherscan.io/address/0xc8467490C4349556a0e3830a5A1505c7e0199cc6) | 12045157 | 12045529 |
| MockUserTypes | [`0x8c3a7D0732cC7b2828Ce89A684301A1F95A1bafc`](https://sepolia.etherscan.io/address/0x8c3a7D0732cC7b2828Ce89A684301A1F95A1bafc) | 12045162 | 12045530 |
| MockInheritance | [`0x9Df507873C62e9318684F492C0c3FE09Bb0BFCdA`](https://sepolia.etherscan.io/address/0x9Df507873C62e9318684F492C0c3FE09Bb0BFCdA) | 12045167 | 12045531 |
| MockShadowed | [`0x0d1CcD84d0A7b128eb0C422879F2fD9BB7C3C070`](https://sepolia.etherscan.io/address/0x0d1CcD84d0A7b128eb0C422879F2fD9BB7C3C070) | 12045171 | 12045532 |
| MockImmutable | [`0x77EbEd8Af6EC5d0DB10Bf8EaBc69773296c03962`](https://sepolia.etherscan.io/address/0x77EbEd8Af6EC5d0DB10Bf8EaBc69773296c03962) | 12045177 | 12045533 |

Past values:

| Contract | Variable | Value | At block | Needs an archive node |
|---|---|---|---|---|
| MockValueTypes | `revision` | `11` | 12045103 | yes |
| MockValueTypes | `revision` | `22` | 12045107 | yes |
| MockValueTypes | `revision` | `33` | 12045111 | yes |

<!-- deployments-table:end -->

A value read at `latest`, or at any block from a contract's seal block on, is the value given in the
read examples. A row in the table of past values holds at that one block, and later values replace
it. Sources are in `deployments/contracts/`. Each contract also has a getter, except for what the
source marks `internal` or `private`, so you can compare a decoded value with a contract call.

## What each check proves

| Check | Command | What it proves | What it does not prove |
|---|---|---|---|
| Sepolia read-back | `npm run readback` | The decoder and both Hardhat adapters work over a public endpoint against real client responses. This is a demo and a transport check | That decoding is correct. Its expected values come from the seed, written by the same project |
| Sourcify | `node scripts/check-sourcify.mjs --chain 11155111` | The source and settings on record compile to the code at each address, so anyone can read the contracts | That the values are right, or anything about the decoder |
| Example | `npm --prefix deployments/example run read:local` | The reads on this page run and give the stated values on a local Anvil | Anything about a public network |
| Independent oracles | `npm run oracle:layout`, `npm run oracle:values` | Layouts match `forge inspect` and values match slots derived by `cast`, so an independent tool agrees with the decoder | That solc is right: this compares the decoder with solc through another tool |
| Client runs | `npm run clients` | The same reads agree on Anvil, Geth and Reth | Behaviour of clients not run |
| Mainnet check | `npm run mainnet:check` | At a pinned block, values from verified contracts someone else wrote equal what those contracts return. With the oracles, this is the evidence for correctness | Anything without an archive endpoint, where it exits 3 |

So Sepolia passing means the plumbing works. Correctness rests on the independent oracles and the
mainnet check.

The read-back exits 0 when every `latest` entry passes, 1 when a value, an address or the manifest is
wrong, 2 on a usage error, and 3 when an RPC problem kept a `latest` entry from being read and nothing
was wrong. Exit 3 is not a pass. `needs-archive` means the node no longer holds that block: it says
nothing about the value. Past-block entries with that result are listed and do not change the exit
code.

The scheduled read-back workflow only runs from the default branch, and GitHub disables scheduled
workflows in a public repository after 60 days with no repository activity. Re-enable it in the
Actions tab, and a manual dispatch checks in the meantime.

## How to read each mock

Each block below is executed from this page by `npm --prefix deployments/example run read:local`,
which checks the `value:` and `rejects:` comments. To copy one, keep the part before the comment. They
were run on Hardhat 3 against a local Anvil and on Sepolia. The chains are the same on Hardhat 2,
where `storage` is `hre.storageDecoder`; `npm run readback` is what exercises that adapter.

The contract name, the compiler settings and the address must all belong to one build: solc 0.8.26,
optimizer off, `evmVersion: 'cancun'`, with the sources from `deployments/contracts/`. See
[`evmVersion` must match](#evmversion-must-match).

Setup. `manifest` is the parsed `deployments/manifest/deployments.json` and `chainId` is the chain's ID
as a string. The addresses and words here are test values the seed stores. No one is known to hold a
key for them.

<!-- read-example: setup -->
```js
const { storageDecoder: storage } = await hre.network.create();
const { contracts } = manifest.chains[chainId].generations.at(-1);
const addresses = Object.fromEntries(Object.entries(contracts).map(([name, { address }]) => [name, address]));
const firstRevision = Object.keys(contracts.MockValueTypes.expected).find((entry) => entry.startsWith('revision@'));
const firstRevisionBlock = Number(firstRevision.split('@')[1]);
const A = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
const B = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
const C = '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC';
const WORD_B = `0x${'22'.repeat(32)}`;
```

### MockValueTypes

Elementary types, and a value that changed across recorded blocks. The `.at()` read needs a node
holding that block, so on a pruning node it reports `needs-archive`. The current `revision` is 33 from
the plan, or higher on a deployed chain if the seed had to make an extra change, so there the manifest
gives the expected value.

<!-- read-example: MockValueTypes -->
```js
const valueTypes = storage.contract('contracts/MockValueTypes.sol:MockValueTypes').target(addresses.MockValueTypes);
await valueTypes.name('isSealed').read(); // value: true
await valueTypes.name('revision').read(); // value: 33n; deployed: manifest MockValueTypes.revision
await valueTypes.name('revision').at(firstRevisionBlock).read(); // value: 11n
await valueTypes.name('unsignedValue').read(); // value: 1606938044258990275541962092341162602522202993782792835301377n
await valueTypes.name('signedValue').read(); // value: -42n
await valueTypes.name('flag').read(); // value: true
await valueTypes.name('account').read(); // value: '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa'
await valueTypes.name('selectorValue').read(); // value: '0xdeadbeef'
await valueTypes.name('token').read(); // value: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB'
```

### MockPacked

Variables sharing a slot. `isSealed` is packed with `owner` in slot 0, in every mock.

<!-- read-example: MockPacked -->
```js
const packed = storage.contract('contracts/MockPacked.sol:MockPacked').target(addresses.MockPacked);
await packed.name('isSealed').read(); // value: true
await packed.name('small').read(); // value: 200n
await packed.name('medium').read(); // value: 60000n
await packed.name('signedSmall').read(); // value: -7n
await packed.name('enabled').read(); // value: true
await packed.name('holder').read(); // value: '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa'
await packed.name('wide').read(); // value: 1267650600228229401496703205379n
await packed.name('tailA').read(); // value: 1152921504606846981n
await packed.name('tailB').read(); // value: '0x0102030405060708'
```

### MockMappings

Each key encoding, and nested mappings.

<!-- read-example: MockMappings -->
```js
const mappings = storage.contract('contracts/MockMappings.sol:MockMappings').target(addresses.MockMappings);
await mappings.name('isSealed').read(); // value: true
await mappings.name('byAddress').key(A).read(); // value: 1n
await mappings.name('byUint').key(7n).read(); // value: 2n
await mappings.name('byInt').key(-5n).read(); // value: 3n
await mappings.name('byBytes32').key(WORD_B).read(); // value: 4n
await mappings.name('byString').key('alpha').read(); // value: 5n
await mappings.name('byBytes').key('0xbeef').read(); // value: 6n
await mappings.name('nested').key(A).key(9n).read(); // value: 7n
await mappings.name('deep').keys(B, 'mid', 3n).read(); // value: true
await mappings.name('lists').key(4n).index(1).read(); // value: 9n
```

### MockArrays

Dynamic, fixed, packed and nested arrays.

<!-- read-example: MockArrays -->
```js
const arrays = storage.contract('contracts/MockArrays.sol:MockArrays').target(addresses.MockArrays);
await arrays.name('isSealed').read(); // value: true
await arrays.name('numbers').index(1).read(); // value: 102n
await arrays.name('smallNumbers').index(1).read(); // value: 2n
await arrays.name('accounts').index(0).read(); // value: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC'
await arrays.name('fixedNumbers').index(1).read(); // value: 103n
await arrays.name('fixedSmall').index(2).read(); // value: 104n
await arrays.name('matrix').index(1).index(1).read(); // value: 105n
await arrays.name('rows').index(0).index(1).read(); // value: 107n
await arrays.name('numbers').index(2).read(); // rejects: IndexOutOfBoundsError
```

### MockEnums

An enum as a variable, as a mapping key, and as array elements. Enums read as their number.

<!-- read-example: MockEnums -->
```js
const enums = storage.contract('contracts/MockEnums.sol:MockEnums').target(addresses.MockEnums);
await enums.name('isSealed').read(); // value: true
await enums.name('status').read(); // value: 2n
await enums.name('countByStatus').key(1n).read(); // value: 5n
await enums.name('history').index(1).read(); // value: 2n
```

### MockStructs

Struct fields: nested, in a mapping, in an array, and in a recursive struct.

<!-- read-example: MockStructs -->
```js
const structs = storage.contract('contracts/MockStructs.sol:MockStructs').target(addresses.MockStructs);
await structs.name('isSealed').read(); // value: true
await structs.name('position').field('id').read(); // value: 21n
await structs.name('position').field('holder').read(); // value: '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa'
await structs.name('position').field('active').read(); // value: true
await structs.name('position').field('point').field('y').read(); // value: -23n
await structs.name('position').field('label').read(); // value: 'position label'
await structs.name('position').field('history').index(0).read(); // value: 24n
await structs.name('positions').key(B).field('label').read(); // value: 'entry label'
await structs.name('points').index(0).field('x').read(); // value: 26n
await structs.name('root').field('children').key(1n).field('children').key(2n).field('value').read(); // value: 29n
```

### MockStrings

Strings and bytes on each side of the 31-byte boundary.

<!-- read-example: MockStrings -->
```js
const strings = storage.contract('contracts/MockStrings.sol:MockStrings').target(addresses.MockStrings);
await strings.name('isSealed').read(); // value: true
await strings.name('shortText').read(); // value: 'sssssssssssssssssssssssssssssss'
await strings.name('longText').read(); // value: 'llllllllllllllllllllllllllllllll'
await strings.name('shortBlob').read(); // value: '0xababababababababababababababababababababababababababababababab'
await strings.name('longBlob').read(); // value: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd'
```

### MockUserTypes

User-defined value types, as variables and as mapping keys.

<!-- read-example: MockUserTypes -->
```js
const userTypes = storage.contract('contracts/MockUserTypes.sol:MockUserTypes').target(addresses.MockUserTypes);
await userTypes.name('isSealed').read(); // value: true
await userTypes.name('signedValue').read(); // value: -31n
await userTypes.name('amountValue').read(); // value: 32n
await userTypes.name('byId').key(WORD_B).read(); // value: 33n
await userTypes.name('bySigned').key(-3n).read(); // value: 34n
await userTypes.name('byAmount').key(12n).read(); // value: 35n
```

### MockInheritance

Variables declared along an inheritance chain.

<!-- read-example: MockInheritance -->
```js
const inheritance = storage.contract('contracts/MockInheritance.sol:MockInheritance').target(addresses.MockInheritance);
await inheritance.name('isSealed').read(); // value: true
await inheritance.name('rootValue').read(); // value: 41n
await inheritance.name('middleBalances').key(A).read(); // value: 42n
await inheritance.name('ownLabel').read(); // value: 'own label'
```

### MockShadowed

Private names declared twice. `declaredIn` says which one you mean, and leaving it out is an error.

<!-- read-example: MockShadowed -->
```js
const shadowed = storage.contract('contracts/MockShadowed.sol:MockShadowed').target(addresses.MockShadowed);
await shadowed.name('isSealed').read(); // value: true
await shadowed.name('shared', { declaredIn: 'MockShadowedBase' }).read(); // value: 51n
await shadowed.name('shared', { declaredIn: 'MockShadowed' }).read(); // value: 54n
await shadowed.name('between').read(); // value: 52n
await shadowed.name('table', { declaredIn: 'MockShadowedBase' }).key(3n).read(); // value: 53n
await shadowed.name('table', { declaredIn: 'MockShadowed' }).key(6n).read(); // value: 55n
await shadowed.name('shared').read(); // rejects: AmbiguousVariableError
```

### MockImmutable

An immutable lives in the code and not in storage, so it has no slot to read. The address check still
passes, because it masks those bytes. Read an immutable through its getter.

<!-- read-example: MockImmutable -->
```js
const immutables = storage.contract('contracts/MockImmutable.sol:MockImmutable').target(addresses.MockImmutable);
await immutables.name('isSealed').read(); // value: true
await immutables.name('stored').read(); // value: 99n
await immutables.name('launchValue').read(); // rejects: VariableNotFoundError
```

## Running the example

From the repo root, on Node 22.13 or newer, or with `npx` available to fetch it:

```bash
npm --prefix deployments/example run read:local      # run: a fresh local Anvil seed
npm --prefix deployments/example run read            # the sealed mocks on Sepolia
npm --prefix deployments/example run read:published  # the same, with the package from npm
```

`read:local` packs the package from the existing `dist/` and seeds its own Anvil, using Anvil's
development account. `read` takes its addresses from the manifest.

## Decoder options

| Option | Default | Meaning |
|---|---|---|
| `maxConcurrentReads` | 16 | Most RPC calls in flight on one decoder. Two decoders on one endpoint do not share the limit |
| `retry.maxAttempts` | 3 | Most times one call is sent. 1 disables retries |
| `retry.baseDelayMs` | 250 | Backoff before the first retry is at most this, doubling after |
| `retry.maxDelayMs` | 5000 | No backoff is longer than this |
| `retry.budget` | 32 | Failures one `read()`, `readMany()` or `readAll()` tolerates before it rejects what it has queued |

The default of 16 is not a measured limit of a healthy endpoint. One keyless endpoint took 64 without
a failure, and there was no usable second measurement, so the rule for choosing the default fell back
to 16. Pass the options to `createHardhatStorageDecoder(hre, options)` on Hardhat 2, or to
`createStorageDecoder(createStorageDecoderContext(hre.artifacts, connection.provider), options)` on
Hardhat 3.

## Time bounds

T is the HTTP timeout. These are worst cases by design, with the default options.

| Case | Bound |
|---|---|
| One read, all timeouts | 3T plus about 10 s of backoff. At T = 30 s, about 100 s. At Hardhat 3's default T = 300 s, about 900 s |
| One read, HTTP 429 | 27 s of Hardhat's own retries, then the failure, with no re-send |
| One `readMany` or `readAll`, everything failing | At most 33 + limit provider calls. Time is about (calls / limit) x T. At limit 16, about 4T: 120 s at T = 30 s, and about 1200 s at Hardhat 3's default |

**On Hardhat 3, set a network `timeout`.** Its default is 300 s, and Hardhat 2's is 20 s. This project
uses 30 s:

```ts
networks: { sepolia: { type: 'http', url: configVariable('SEPOLIA_RPC_URL'), timeout: 30_000 } }
```

`maxElements` bounds the nodes a dump expands, not how long the dump takes.

## Do not log raw provider errors if the URL has a token

**Hardhat 3 status errors quote the URL's origin**: scheme, host and port. A token in the host therefore
reaches the error message, and the plugin passes provider errors through unchanged. Hardhat 2's
rate-limit message includes the hostname too.

A token in the path did not appear in what we measured, on Hardhat 3.21.2 on 2026-10-31: with HTTP
400, 401, 404, 429 and 503 from a local server, it was absent from the message and from the whole
inspected error, `cause` chain included. Hardhat's source reduces the URL to its origin in these
messages, which would drop a query string too; that part was read, not run. Do not rely on any of
this. It is one version, a node's own response text can quote anything, and Hardhat's invalid-URL
error quotes the value it was given.

If your URL holds a token, do not log, print, or send to an error tracker a raw provider error. Log a
fixed message or redact it first.

## `evmVersion` must match

The address check compares every byte of the deployed code except the metadata trailer, immutables
and library addresses. This is a behaviour change from comparing length and the first 32 bytes, and
it means **`evmVersion` must match the deployed build**, as must the optimizer settings. A mismatch
rejects with `ContractMismatchError`, with `reason: 'code-differs'`.

Do not rely on defaults: Hardhat 2 and Hardhat 3 defaulted to different ones in our builds, `paris`
and `cancun`. Set it explicitly, as `deployments/hh2` and `deployments/hh3` do.

## Known limitations

- **Sepolia is a demo, and its end date is unsettled.** The Ethereum Foundation's 2025 post gave
  2026-09-30. An October 2026 proposal moves Sepolia's long-term support into 2027, and a forum thread
  proposes a full sunset in Q2 or Q3 2027. No final decision or named successor was confirmed when this
  was written. Expect these addresses to stop working at some point, and see the redeploy steps.
- **History on a keyless endpoint is short.** `publicnode` kept about 33 hours of history when
  measured on 2026-10-31, and a month-old read was pruned, with an explicit error. This is one
  measurement, of one endpoint, and it may move. No keyless archive endpoint was found.
- **A stopped batch does not clear the others.** `pruned` or `rpc` from a batch does not rule out a
  wrong address or a bad index in another of its queries. Only a successful result does, so judge each
  query by its own `.read()`.
- **Public endpoints change.** Limits and backends differ from call to call. One endpoint measured
  that day answered with usage-limit errors under light load, so a failure there says little about
  the decoder.
- **Immutables and constants have no slot.** Read them through a getter.
- **A sealed mock cannot be corrected.** There is no unseal and no way to change the owner. A wrong
  value in a sealed generation means a new generation.
- **`.read()` proves the address and layout agree.** It does not prove the layout is what the deployer
  intended: expected values here come from the seed itself.

## Owner runbook

This is for the owner, who holds the deployer key. It was first used with a real key for the Sepolia
deployment of 2026-11-02, where Sourcify accepted the Hardhat 3 build as an exact match for all 11
contracts. A rejection blocks sealing.

G1 to G6 are the release gates. Do each only when its turn comes, in this order.

### Terminal rules

Every command that touches a key or a token runs under these rules:

- Use a **separate terminal**: a standalone Windows Terminal or PowerShell window. Not an IDE terminal,
  not Git Bash or mintty, whose prompts may not mask, and not the `!` prefix in an AI session.
- Never paste a key into an AI session, or an error that contains one. Never run `keystore get` near a
  session, because it prints the value.
- Commands marked `powershell` are for that window. Run them with the official Node install.

First, once, before the rehearsal: install the official Node 22.13 or newer from nodejs.org, and open a
new window so it is on the path. Check it with `node -v`. An older version cannot run these commands.

Before any signing command, in that window, from the repo root:

```powershell
node -v    # must be 22.13 or newer, from the official installer
$env:Path += ";$HOME\.foundry\bin"    # for anvil and cast
Remove-Item Env:SEPOLIA_DEPLOYER_KEY -ErrorAction SilentlyContinue
[Environment]::GetEnvironmentVariable('SEPOLIA_DEPLOYER_KEY', 'User')    # must print nothing
$env:HARDHAT_DISABLE_TELEMETRY = 'true'
Set-Location deployments\hh3
```

Signing uses `node node_modules/hardhat/dist/src/cli.js`, never `npx -y node@22.14`, which fetches and
runs a package at the moment a key is in use. `npx` stays only for tests that hold no key. The seed
refuses to run while `SEPOLIA_DEPLOYER_KEY` is set, because Hardhat 3 reads the environment before the
keystore.

Install the projects once with `npm run deployments:test`, before any of this.

### G1: rehearse, then create the key

Rehearse after the G1 commit and before funding anything. The guards need a clean tree, so it cannot
run earlier. It proves the keystore prompt, the seal prompt and the commit scan with nothing at stake.
It uses `--network sepolia` against a local Anvil with Sepolia's chain ID, and a throwaway key.

1. In a second window, start the node and leave it running:

   ```powershell
   $env:Path += ";$HOME\.foundry\bin"
   anvil --chain-id 11155111 --port 8545 --block-time 1
   ```

   `--block-time 1` matters. The seed waits for 3 blocks after each recorded change off the local network,
   and without new blocks it refuses after 15 minutes.

2. Make the throwaway key. Its output may stay on screen, since this key guards nothing:

   ```powershell
   cast wallet new
   ```

3. In the signing window, with the setup above done, store the local URL and the throwaway key. Each
   prompts, and the first asks you to choose a keystore password:

   ```powershell
   node node_modules/hardhat/dist/src/cli.js keystore set SEPOLIA_RPC_URL
   node node_modules/hardhat/dist/src/cli.js keystore set SEPOLIA_DEPLOYER_KEY
   ```

   Answer the first with `http://127.0.0.1:8545`.

4. Fund the throwaway address on Anvil, then run the full seed. It sends about 70 transactions:

   ```powershell
   cast rpc anvil_setBalance <throwaway address> 0x56BC75E2D63100000 --rpc-url http://127.0.0.1:8545
   node node_modules/hardhat/dist/src/cli.js run scripts/seed.ts --network sepolia
   ```

5. Skip Sourcify, which cannot see a local node. Seal, typing the chain ID and the first 8 characters of
   the commit when asked. Then stage the manifest and scan it, from the repo root:

   ```powershell
   node node_modules/hardhat/dist/src/cli.js run scripts/seal.ts --network sepolia
   Set-Location ..\..
   git add deployments/manifest/deployments.json
   node scripts/check-secrets.mjs --staged
   node scripts/check-manifest-public.mjs
   ```

6. Discard all of it. On `--network sepolia` the seed always writes the real public manifest, so it now
   holds local addresses. **This manifest must never be committed**, and if it is left behind, the real
   seed resumes against it. The keystore file goes too, so the real key starts with a new password:

   ```powershell
   git restore --staged deployments/manifest/deployments.json
   git restore deployments/manifest/deployments.json
   Remove-Item deployments\manifest\local\pending-11155111.json -ErrorAction SilentlyContinue
   Set-Location deployments\hh3
   node node_modules/hardhat/dist/src/cli.js keystore list
   node node_modules/hardhat/dist/src/cli.js keystore path
   Remove-Item "<the path it printed>"
   Set-Location ..\..
   git status --short
   ```

   `keystore list` must show only the two names above, and `git status` must show nothing. Stop Anvil
   and close both windows.

Create the real key in a new window, with the setup above done. Use a dedicated testnet-only deployer
holding nothing else.

1. Test the prompt first. Use a dummy name, and choose a unique password, used nowhere else, when asked.
   Check that typed text is masked:

   ```powershell
   node node_modules/hardhat/dist/src/cli.js keystore set DUMMY_PROMPT_TEST
   node node_modules/hardhat/dist/src/cli.js keystore delete DUMMY_PROMPT_TEST
   ```

   If what you typed appears on screen, stop. Delete the keystore file and use another terminal.

2. Generate the key, with no redirect. In PowerShell 5.1 `>` writes UTF-16 to a file that could then get
   committed. Note the address:

   ```powershell
   cast wallet new
   ```

3. Store it and the endpoint, with no `--dev`, which would use the keystore that has no password:

   ```powershell
   node node_modules/hardhat/dist/src/cli.js keystore set SEPOLIA_DEPLOYER_KEY
   node node_modules/hardhat/dist/src/cli.js keystore set SEPOLIA_RPC_URL
   ```

4. Clear the clipboard history with Win+V, then "Clear all". Close the window, which removes the key
   from its scrollback.

Fund the address with at least twice the measured deploy gas at the current Sepolia gas price. A local
run measured 12,578,962 gas for all 79 transactions, so that is 25,157,924 gas. Gas limits are 150% of the estimate, with a 300,000 floor
on calls. Gas used does not change, but each send needs that higher worst case available in the balance.

### G2: deploy and verify

Review the commit first (`git log -1`, `git diff`). The tree must be clean. In a new window, with the
setup above done:

```powershell
node node_modules/hardhat/dist/src/cli.js run scripts/seed.ts --network sepolia
```

It waits 3 blocks after each recorded `revision` change (`SEED_CONFIRMATIONS` changes this), so it takes
a little longer than the transaction count suggests. A dirty tree or lockfile drift is refused before
the keystore prompt. The chain ID and source checks come after the prompt, so getting a prompt does not
mean they passed.

If it stops, run the same command again. It resumes from the record on disk without redeploying. Then
from the repo root, verify. Neither command needs a key or a secret URL:

```powershell
Set-Location ..\..
node scripts/submit-sourcify.mjs --chain 11155111
node scripts/check-sourcify.mjs --chain 11155111
```

Both exit 0 when all are verified, 1 for an unverified contract or a mismatch, 2 on a usage error, and
3 when they could not check because of the network. Exit 3 is not a pass: run them again. Verification
would still work after sealing, but do it now, because a rejection is cheaper to deal with before an
irreversible step.

**Run the read-back soon after seeding, and keep its report.** `publicnode` kept about 33 hours of
history when measured, so that is the only window for seeing the decoder's `.at(block)` work on Sepolia
through public nodes:

```powershell
New-Item -ItemType Directory -Force .release-evidence | Out-Null
node scripts/readback.mjs --chain 11155111 --json .release-evidence/readback-g2.json
node -e "const r=JSON.parse(require('fs').readFileSync('.release-evidence/readback-g2.json','utf8'));const a=r.reports.flatMap(x=>x.results);const h=a.filter(x=>x.blockTag!=='latest');console.log('exit',r.exitCode,'wrong',a.filter(x=>x.verdict==='wrong').length,'historic',h.length,'historic pass',h.filter(x=>x.verdict==='pass').length)"
```

For G3, the kept report must show exit 0, no entry `wrong`, and at least one historic entry `pass`, which
is the decoder's `.at(block)` seen working on Sepolia. Older historic entries may read `needs-archive`;
`seal.ts` allows that, and it says nothing about the value.

If the window was missed and no historic entry passes, make a new value change before sealing and read
that one in time. In a signing window, run the seed command again. When the newest recorded change can no
longer be read through `SEPOLIA_RPC_URL`, the seed makes one new change, and up to three if reads stay
pruned. Then run the read-back at once. If that endpoint still holds the block, the seed changes nothing:
set `READBACK_RPC_URL` to it, as shown under G5, and run the read-back there. The manifest records any
new `revision` value and the example reads it from there, so this page needs no edit.

`npm run readback` uses keyless defaults. `READBACK_RPC_URL` and `READBACK_SECOND_RPC_URL` replace the
main endpoint and the one that confirms an address has no code. Set them as shown under G5 if either
URL holds a token.

### G3: seal

**Sealing is irreversible.** Do it only with `check-sourcify` exit 0, coverage passing
(`npm run deployments:coverage`), and a kept G2 report with exit 0, so every latest value passes, no entry
`wrong`, and at least one historic entry `pass`.

Before its prompt and before loading the key, `seal.ts` itself refuses unless the recorded block hashes
are unchanged and a read-back passes at the head. A could-not-check result refuses too. There is no
override: if the endpoint is flaky, run it again.

Stage `deployments/manifest/deployments.json` and run both scanners before committing it:

```powershell
git add deployments/manifest/deployments.json
node scripts/check-secrets.mjs --staged
node scripts/check-manifest-public.mjs
git commit -m "Record the Sepolia deployment"
```

The pre-commit hook runs only `check-secrets`, so `check-manifest-public` is yours to run. Then in a new
window, with the setup above done:

```powershell
node node_modules/hardhat/dist/src/cli.js run scripts/seal.ts --network sepolia
```

Afterwards, from the repo root:

```powershell
node scripts/readback.mjs --chain 11155111
node scripts/check-sourcify.mjs --chain 11155111
node scripts/check-docs-manifest.mjs --write
npm --prefix deployments/example run read
```

Run both scanners again, then commit the manifest and this page.

### G4: push the branch

Install `gh` before G4 and before the release gate, and sign in:

```powershell
winget install --id GitHub.cli
gh auth login
```

Review what will be pushed, and run the checks. Push this branch only:

```powershell
git log --stat main..HEAD
git diff main...HEAD
node scripts/check-workflows.mjs
npm run check:secrets
git push -u origin feat/contract-mocks
```

The push starts the secret scan. Check it for the exact commit:

```powershell
gh run list --commit (git rev-parse HEAD)
```

`independent-checks.yml` does not run on this push. It is set to run on pushes to `main` and on pull
requests into `main`, and as far as is known GitHub only allows a manual start once the file is on `main`.
So the first look at Geth and Reth for a new commit comes from its pull request in G5.

Reth publishes no Windows binary, so `clients all` cannot pass on this machine. The gate needs the CI
evidence instead: a successful `independent-checks.yml` run for the exact commit, which it reads with
`gh`. Without `gh` it reports that requirement unmet. That run comes from the push to `main` in G5.

### G5: merge, then the mainnet check

Open the pull request and watch its checks. With them green, merge to `main`. This is what enables the
scheduled and manual read-back workflows. A pull request's `independent-checks.yml` run is only an early
signal: it is expected to test the merge of the branch into `main`, so the gate ignores it whichever way it
ended. Then update your copy, and call the merged commit C:

```powershell
gh pr create --fill --base main --head feat/contract-mocks
gh pr checks --watch
gh pr merge --merge
git switch main
git pull
git rev-parse HEAD
```

**A changed commit voids the evidence.** The mainnet report and the CI run are both bound to one commit.
If C changes for any reason, run the mainnet check again and wait for a new CI run on the new commit.
Pushing to `main` starts that CI run for C. Check that it passed before G6, and that the read-back
workflow runs:

```powershell
gh run list --workflow independent-checks.yml --commit (git rev-parse HEAD)
gh workflow run readback.yml --ref main
gh run watch
```

`npm run mainnet:check` reads `MAINNET_ARCHIVE_RPC_URL`, which usually holds a token. Do not write the
URL on a command line, where PowerShell history would keep it. On commit C, in a new window, read it with
a masked prompt into this process only, and clear it afterwards. The report goes to
`.release-evidence/mainnet-<commit>.json`:

```powershell
$secure = Read-Host 'Archive URL' -AsSecureString
$env:MAINNET_ARCHIVE_RPC_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
npm run mainnet:check
Remove-Item Env:MAINNET_ARCHIVE_RPC_URL
```

`READBACK_RPC_URL` and `READBACK_SECOND_RPC_URL` can be set the same way. Do not use `setx`, which saves
the value in your profile.

### G6: gate, bump, publish

Do these in order, and stop at the first failure. First run the gate on commit C, with a clean tree. Exit
3 is not a pass. It writes `.release-evidence/release-gate-<commit>.json`:

```powershell
npm run release:gate
```

Only then make the bump, as a commit that changes the two version files and nothing else, where `<C>` is
the commit the gate passed on:

```powershell
git switch -c release/1.0.0
npm version 1.0.0 --no-git-tag-version
git add package.json package-lock.json
git commit -m "Release 1.0.0"
git diff --name-only <C>..HEAD
npm run verify:package
node scripts/check-release-consistency.mjs 1.0.0
```

`git diff --name-only` must list exactly `package.json` and `package-lock.json`. Push that branch, merge
it, and update your copy:

```powershell
git push -u origin release/1.0.0
gh pr create --fill --base main --head release/1.0.0
gh pr merge --merge
git switch main
git pull
```

Only the owner publishes. Use `npm login`, with 2FA, then `npm publish`. **Do not leave an npm
token in a project `.npmrc`**, where it could be committed or end up in a tarball. After publishing, run
`npm --prefix deployments/example run read:published`.

### Reviewing the scheduled read-back

**A green GitHub run can still be "could not check".** Exit 3 only raises a warning, so read the run's
summary rather than its colour. A review rule applies: **three consecutive exit-3 scheduled runs mean
change the RPC**, by changing the default in `scripts/readback.mjs` after trying the new endpoint. The
workflow cannot do this for you.

**`SKIPPED` after G3 counts as a failure.** The weekly read-back skips, and stays green, when the manifest
has no chains at all, which is only right before the first deployment. Once G3 is done, a `SKIPPED` summary
means the manifest was reset, so treat it as a failed run.

## Redeploying

Use this when Sepolia ends, or when a sealed generation has a wrong value. These steps have not been
run on Sepolia yet. Follow the rules of the [owner runbook](#owner-runbook), in a separate terminal.

1. Have a clean tree and the deployer's key in the keystore. A new deployer needs a new key, created as
   in G1, and funds.
2. Start a new generation, which records its own source hash, so this works if
   `deployments/contracts` changed. On an unsealed or partly sealed generation the variable refuses: run
   without it to resume, seal that generation, or retire it as below. If a run is killed after its first
   save, drop the variable to resume; before that save, the same command resumes with or without it:

   ```powershell
   $env:SEED_NEW_GENERATION = '1'
   node node_modules/hardhat/dist/src/cli.js run scripts/seed.ts --network sepolia
   Remove-Item Env:SEED_NEW_GENERATION
   ```

3. Verify it with `node scripts/submit-sourcify.mjs --chain 11155111` and
   `node scripts/check-sourcify.mjs --chain 11155111`, and keep the read-back report, as in G2.
4. Seal it, commit, and regenerate the table, as in G3. Read-back takes the last generation, and old
   addresses stay recorded in the manifest.

**To retire a stuck generation**, one that cannot finish, for example after a reverted step, set
`SEED_RETIRE_UNSEALED=1` with that generation's key. Do not edit the manifest by hand:

```powershell
$env:SEED_RETIRE_UNSEALED = '1'
node node_modules/hardhat/dist/src/cli.js run scripts/seed.ts --network sepolia
Remove-Item Env:SEED_RETIRE_UNSEALED
```

It retires the generation and seeds a new one in the same run, to new addresses, so it spends gas. The
old addresses stay recorded and abandoned. It skips the source-binding check on purpose; all other
refusals still apply. It also refuses in these cases:

- The last transaction is unmined and its nonce unused: wait, or unset `SEED_RETIRE_UNSEALED` and run the
  normal seed command with `SEED_REPLACE_FEE=1`.
- That transaction succeeded and only needs recording: run the normal seed command.
- The generation is sealed: use `SEED_NEW_GENERATION=1`.

The seed still refuses another deployer's key on an unsealed generation, so this does not help if the
key is lost.

Two other variables apply only in rare cases. `SEED_REPLACE_FEE=1` replaces a transaction stuck unmined,
at the same nonce and a higher fee. `SEED_ALLOW_NONCE_START=1` starts a generation on an account whose
history the manifest cannot explain. Use it only if you are sure, because a lost pending record looks
the same and could cause a duplicate deployment.

For a chain other than Sepolia, the seed needs an entry in `NETWORK_CHAINS` in
`deployments/hh3/scripts/guards.ts` and a network in `deployments/hh3/hardhat.config.ts`. The docs
table needs only the manifest, and gets an explorer link once the chain is added to
`scripts/check-docs-manifest.mjs`.
