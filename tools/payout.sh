#!/bin/zsh
# Pays out, from the cryptopunkins-deployer wallet (it pays the gas). Run it right at midnight on Halloween (until a
# pumpkin's share is sent, a seller could send it to themselves in the block a sale lands), and again any time after:
# - first it finishes every carve still waiting on its face, 200 a transaction (about 7M gas): one left unsettled for
#   a day (8,191 blocks) would have its face rolled again;
# - after midnight, every Great Pumpkin is sent its share, 100 pumpkins a transaction (under 9M gas even if every
#   wallet is new or burns all 50,000 gas it's given), pass after pass while anything more goes out; a pumpkin is only
#   ever sent what it's still owed, and what's left at the end is owed to wallets that refuse ETH (they can claim);
# - then FE35's 10% so far (the game's `payout`, the only place it can go).
# Gas limits are set, not estimated: sendShares stops early (without failing) when gas runs low, so an estimate (the
# least gas that doesn't fail) would pay only a few.
# Rehearsal on the local night chain: RPC=http://127.0.0.1:8548 GAME=0x… tools/payout.sh
set -euo pipefail
ROOT=${0:A:h:h}
PW=~/.foundry/cryptopunkins-deployer.pw
RPC=${RPC:-$(grep '^ALCHEMY_URL=' $ROOT/site/.dev.vars | cut -d= -f2-)}
GAME=${GAME:-${$(<$ROOT/deployed.txt)[(w)1]}}
FROM_WALLET=$(cast wallet address --account cryptopunkins-deployer --password-file $PW)
LIMIT=10000000

num() { cast call $GAME "$1" --rpc-url $RPC | awk '{print $1}'; }
lt() { python3 -I -c 'import sys; sys.exit(int(sys.argv[1]) >= int(sys.argv[2]))' $1 $2; } # (wei can pass what the shell can count)
pending() { cast call $GAME 'stats()(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)' --rpc-url $RPC | sed -n 4p | awk '{print $1}'; }
# every send reserves its whole gas limit at up to twice today's price (it only spends what's used)
send() {
  local need=$(( $(cast gas-price --rpc-url $RPC) * LIMIT * 2 )) have=$(cast balance $FROM_WALLET --rpc-url $RPC)
  if (( have < need )); then
    echo "Send $(cast from-wei $(( need - have ))) ETH more to $FROM_WALLET, then run this again."
    exit 1
  fi
  cast send $GAME "$@" --gas-limit $LIMIT --account cryptopunkins-deployer --password-file $PW --rpc-url $RPC \
    | grep -E "^(status|gasUsed|transactionHash)"
}
SOLD=$(num 'sold()(uint256)')
END=$(num 'end()(uint256)')

# 1. the faces
P=$(pending)
while (( P > 0 )); do
  echo "finishing $P carves:"
  send 'settle(uint256)' 200
  NOW_P=$(pending)
  (( NOW_P < P )) || break # (the rest landed this block: they finish on the next run)
  P=$NOW_P
done

# 2. the winnings
NOW=$(cast block latest -f timestamp --rpc-url $RPC)
if (( NOW < END )); then
  echo "Winnings go out after midnight ($(( (END - NOW) / 60 )) minutes to go). Sending just the 10% now."
elif (( SOLD > 0 )); then
  ALL="[$(seq -s, 1 $SOLD)]"
  owed() { cast call $GAME 'owed(uint256[])(uint256)' $ALL --rpc-url $RPC | awk '{print $1}'; }
  OWED=$(owed)
  echo "Owed: $(cast from-wei $OWED) ETH to $(num 'whole()(uint256)') Great Pumpkins"
  while [[ $OWED != 0 ]]; do
    for (( from = 1; from <= SOLD; from += 100 )); do
      echo "pumpkins $from-$(( from + 99 )):"
      send 'sendShares(uint256,uint256)' $from $(( from + 99 ))
    done
    LEFT=$(owed)
    lt $LEFT $OWED || break # (nothing more went out: what's left is owed to wallets that refuse ETH)
    OWED=$LEFT
  done
  echo "Still owed: $(cast from-wei $OWED) ETH (only wallets that refuse ETH; they can claim on the site)"
fi

# 3. the 10%
TO=$(cast call $GAME 'payout()(address)' --rpc-url $RPC)
BEFORE=$(cast balance $TO --rpc-url $RPC)
send 'withdraw()'
python3 -I -c "import sys; print(f'10%: sent {(int(sys.argv[2]) - int(sys.argv[1])) / 1e18:.6f} ETH to {sys.argv[3]}')" $BEFORE $(cast balance $TO --rpc-url $RPC) $TO
