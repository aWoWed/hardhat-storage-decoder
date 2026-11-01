# Example: reading the sealed mocks

Runs every read example in [`docs/public-testnet.md`](../../docs/public-testnet.md), taken from the
page itself, and checks each stated result. Needs Node 22.13 or newer, or `npx` to fetch it.

From the repo root:

| Command | Reads | Package | Status |
|---|---|---|---|
| `npm --prefix deployments/example run read:local` | A fresh Anvil seeded by this run. Needs `anvil` | Packed from the existing `dist/` | Run on 2026-10-31 |
| `npm --prefix deployments/example run read` | Sepolia, from `deployments/manifest/deployments.json` | Packed from the existing `dist/` | Not yet run against a deployment: none exists. It exits 2 and says so |
| `npm --prefix deployments/example run read:published` | Sepolia, as above | The npm registry | Not yet run: not published, and no deployment exists |

`read:local` proves the page's reads work on a local node. It says nothing about Sepolia.

The local seed sends from Anvil's own development account. There is no key in this folder, and none
is needed: the reads are `eth_getStorageAt` and `eth_getCode` only.

`EXAMPLE_RPC_URL` replaces the default Sepolia endpoint. Output from these scripts is redacted, but
read the warning about tokens in RPC URLs in the docs before you use a URL that holds one.
