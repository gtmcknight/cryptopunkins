#!/bin/zsh
# Ships CryptoPunkins in one go: deploys the contracts from the cryptopunkins-deployer keystore, points the site at
# the game, deploys the site Worker (its own route, taylor.fyi/cryptopunkins*), and checks it's live.
# Run it again after any failure: once the game is on chain (deployed.txt), it skips straight to the site.
# Rehearsal on a local copy of mainnet: RPC=http://127.0.0.1:8547 DRY=1 tools/ship.sh (contracts only, nothing saved)
set -euo pipefail
ROOT=${0:A:h:h}
SITE=$ROOT/site
PW=~/.foundry/cryptopunkins-deployer.pw
RPC=${RPC:-$(grep '^ALCHEMY_URL=' $SITE/.dev.vars | cut -d= -f2-)}
DRY=${DRY:-}
DEPLOYER=$(cast wallet address --account cryptopunkins-deployer --password-file $PW)
SAVED=$ROOT/deployed.txt

has_code() { [[ $(cast code $1 --rpc-url $RPC) != 0x ]]; }

if [[ -z $DRY && -f $SAVED ]] && has_code ${$(<$SAVED)[(w)1]}; then
  GAME=${$(<$SAVED)[(w)1]}; FROM=${$(<$SAVED)[(w)2]}
  echo "Game already on chain: $GAME (from block $FROM)"
else
  # 1. enough ETH for the three transactions (about 13.4M gas) at today's price, with room for it to rise a third
  GAS=$(cast gas-price --rpc-url $RPC)
  NEED=$(( GAS * 13400000 * 4 / 3 ))
  HAVE=$(cast balance $DEPLOYER --rpc-url $RPC)
  if (( HAVE < NEED )); then
    echo "Send $(cast from-wei $(( NEED - HAVE ))) ETH more to $DEPLOYER, then run this again."
    exit 1
  fi

  # 2. the contracts, one transaction at a time: edition data, renderer (the art), game
  FROM=$(cast block-number --rpc-url $RPC)
  cd $ROOT/contracts
  forge script script/Deploy.s.sol --rpc-url $RPC --account cryptopunkins-deployer --password-file $PW --broadcast --slow | tee $ROOT/contracts/deploy.log
  GAME=$(grep -E '^  game' $ROOT/contracts/deploy.log | awk '{print $2}')
  [[ $GAME == 0x* ]] && has_code $GAME || { echo "No game contract found after the deploy. Stopping."; exit 1; }
  echo "game $GAME, deployed from block $FROM"
  if [[ -n $DRY ]]; then echo "(rehearsal: nothing saved, site untouched)"; exit 0; fi
  echo "$GAME $FROM" > $SAVED
fi

# 3. point the site at the game and deploy the Worker (it also uploads the Alchemy backup as a secret)
cd $SITE
python3 -I - $GAME $FROM <<'EOF'
import re, sys
s = open('wrangler.jsonc').read()
s = re.sub(r'"GAME": "0x[0-9a-fA-F]{40}"', f'"GAME": "{sys.argv[1]}"', s)
s = re.sub(r'"FROM_BLOCK": "\d+"', f'"FROM_BLOCK": "{sys.argv[2]}"', s)
open('wrangler.jsonc', 'w').write(s)
EOF
grep -q "\"GAME\": \"$GAME\"" wrangler.jsonc || { echo "Couldn't set GAME in wrangler.jsonc. Stopping."; exit 1; }
npm run deploy

# 4. live?
sleep 8
curl -fsS https://taylor.fyi/cryptopunkins/config.json; echo
curl -fsS -X POST https://taylor.fyi/cryptopunkins/rpc -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'; echo
echo "Live: https://taylor.fyi/cryptopunkins/"
