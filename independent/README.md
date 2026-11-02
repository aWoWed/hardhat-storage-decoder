# Independent checks

Foundry's view of the same sources the decoder reads, compiled here and not through Hardhat.
`src/` is copied from `deployments/contracts/` and `test/fixtures/contracts/` at each run.

| Command | Checks |
|---|---|
| `npm run oracle:layout` | Slot, offset and type of every variable and struct member, against `forge inspect`, for all mocks and fixture files. |
| `npm run oracle:values` | Values on a local Anvil: the seed plan, then at least 200 random keys and indices per family. Slots come from `cast index` and `cast keccak`. Planned values are read by `cast storage`; random ones by a raw `eth_getStorageAt`. |
| `npm run clients -- <anvil\|geth\|reth\|all>` | The same read suite on a real client at a pinned version, with fewer random writes. Exit 3 means it could not run, which is never a pass. |

Both oracles show on every run that their comparison can fail, and `oracle:values -- --wrong-slot`
runs with deliberately wrong slots, which must exit 1. The seed is printed; `--seed <n>` repeats a run.

## What this does and does not show

- The layout check tests the decoder against solc through a different tool, not solc itself: both
  sides rest on solc 0.8.26's own report.
- Values are written by real transactions, so a wrong slot derivation on either side shows up as a
  read of the wrong word.
- Fixtures are checked for layout only. Their values are covered by the e2e suites.
- A user-defined type's underlying type comes from a table in `scripts/oracle-common.mjs`, since a
  layout gives only its name.

## Client notes

Anvil runs with `--max-persisted-states 0` here. A killed Anvil on Windows cannot remove its state
from `~/.foundry/anvil/tmp`, and a run of thousands of blocks otherwise leaves over a gigabyte there.

Anvil 1.5.1 answers `-32602 BlockOutOfRangeError: block height is N but requested was M` both for a
block above its head and for one `--prune-history` has dropped, checked by running it. The wording
cannot tell them apart, so the classifier leaves it `fatal`, and `npm run clients -- anvil` fails if
either answer changes.

Geth comes from `GETH_BIN`, or from a `.tools/geth.exe` matching a pinned SHA-512 (Windows only, and
not downloaded for you). Reth comes from `RETH_BIN`; its release publishes no Windows binary, so
none is pinned for `.tools/`. Without one of these the client does not run and the exit code is 3.

Both dev modes offer an unlocked funded account through `eth_accounts`. Geth 1.17.10 can answer a
receipt query just after it starts with `-32000 transaction indexing is in progress`, which counts
as not mined yet. Reth 2.9.0 refuses every contract creation from such an account with `-32602
invalid transaction request`, so on Reth the suite sends from a key generated at run time and funded
by that account: see `scripts/clients/key-sender.mjs`.
