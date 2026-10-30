# CryptoPunkins

A Halloween game on Ethereum, at [taylor.fyi/cryptopunkins](https://taylor.fyi/cryptopunkins/). The art and the game are fully onchain.

- Mint a pumpkin for 0.00666 ETH, up to 10 at a time. Each comes with two stabs. 90% of every mint goes in the pot, 10% to taylor.fyi.
- Before 8 PM New York time on Halloween you can only stab your own pumpkin, to see its face. From 8 PM to midnight you can stab anyone's. A pumpkin carved before it uses its stabs loses them.
- A carved pumpkin shows one of 1,031 faces from the 2021 CryptoPunkins, picked by the hash of the block it was carved in.
- Every pumpkin still uncut at midnight becomes a Great Pumpkin, and the Great Pumpkins split the pot. After midnight anyone can send every share out (`sendShares`), and any share not sent can be claimed. If nothing survives, every pumpkin sold splits it.

## What's here

| Path | What |
| --- | --- |
| `contracts/` | The game (`src/CryptoPunkins.sol`), the onchain art (`src/Renderer.sol`), tests and the deploy script, in Foundry |
| `data/` | The art packed for the renderer (`art.bin`, `traits.bin`, `editions.bin`) and the layers it's packed from (`grid.json`) |
| `site/` | The page (Vite and TypeScript) and its Cloudflare Worker: a read-only RPC for the game, and link previews |
| `tools/` | Packing and checking the art (Python), `ship.sh` to deploy, `payout.sh` to pay out |
| `DEPLOY.md` | The runbook |

## Run it

```
cd contracts && forge test
python3 -I tools/check-render.py data/grid.json contracts/render
cd site && npm install && npm run dev
```

The tests include a fuzz test that plays whole nights at random. The render check compares every SVG the contract draws (the tests write them to `contracts/render`) with the packed layers. The dev page reads a local chain: see `site/vite.config.ts`.

Experimental software, not financial advice. MIT license.
