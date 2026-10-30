# CryptoPunkins: deploy

Everything below has run on a local copy of mainnet. Mainnet needs your ETH, so you run both steps.

## 1. Fund the deployer, never FE35

A fresh keystore, `cryptopunkins-deployer`, is on this Mac (made 10-30; its password is in `~/.foundry/cryptopunkins-deployer.pw`, owner-only). Send it 0.015 ETH:

```
0x31297285F41B2D82129Ba6024F5d1bD2BB92Ad19
```

The deploy is three transactions, about 13.4M gas: 0.01 ETH at 0.75 gwei. The script says exactly how much more to send if gas rises.

## 2. Ship

```
tools/ship.sh
```

It deploys the contracts (one transaction at a time, through the Alchemy node), saves the game to `deployed.txt`, sets `GAME` and `FROM_BLOCK` in `site/wrangler.jsonc`, deploys the site Worker on its own route (`taylor.fyi/cryptopunkins*`, so the taylor-fyi router and the homepage aren't redeployed), uploads the Alchemy backup as a secret, and checks the live page answers. If anything fails, run it again: once the game is on chain it skips straight to the site. Rehearsed on a local copy of mainnet 10-30.

It writes the edition data, then the renderer (the art, onchain), then the game. All 1,031 pumpkins are for sale; nothing is minted at deploy. Defaults: minting closes and carving opens at 8 PM on Halloween (LAST_CALL, 4 hours before END); carving closes and the pot opens at midnight, 2026-11-01 00:00 New York (END=1793505600). Every pumpkin comes with 2 stabs; owners can stab their own any time to see its face (it then leaves the pot). An uncut pumpkin's colour (Orange, Rust, Amber, Copper, Gold) comes from its id, in the onchain art. If nothing is whole at midnight, every pumpkin sold claims an equal share. `carveMany(knives, targets)` is the one tap the site uses at 8 PM for the pumpkins a player aimed at ahead (aims live in the player's browser only). Each mint is 0.00666 ETH: 90% stays in the contract as the pot, 10% is FE35's cut (PAYOUT). FE35 is `owner()` for the OpenSea profile, with no powers in the contract (OWNER). It prints `game 0x…`.

## 3. Seed the pot (yours, optional)

Send 0.1 ETH straight to the game address from any wallet: a plain transfer joins the pot, and the site's ticker shows it as added. Your 10% pays it back at 150 mints. If nothing is ever minted, it stays in the contract.

## After midnight

- Carves sent before midnight still finish, and the site shows their faces right away. `tools/payout.sh` writes every waiting face down for good first (each must be within about a day, 8,191 blocks, or its face is rolled again), so run it once after midnight; running it during the night too keeps faces showing on OpenSea.
- Pay out: `tools/payout.sh`, any time, as often as you like. After midnight it sends every Great Pumpkin its share (300 a transaction, 40,000 gas each: about 0.01 ETH for 300 winners), then FE35's 10% so far; before midnight it sends just the 10% (0.000666 ETH a mint, 0.687 ETH if all 1,031 sell). Top up the deployer to about 0.03 ETH first: a full 14M gas limit has to be covered, though only what's used is spent. Nobody is ever paid twice, owners can still press Claim on the site, and a wallet that refuses ETH is skipped and stays owed (it can claim). Run it again after anything is fed to the pot later.
- `feed()` (or a plain ETH send) adds to the pot from outside, such as a coin's trading fees: before midnight it grows the prize, after it's split between the Great Pumpkins as it arrives, and they claim again. Send fees from a wallet, a Safe, or a contract that uses `call`: Solidity's `transfer` and `send` give too little gas and fail, and tokens (WETH included) sent to the game are stuck.
