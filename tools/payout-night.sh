#!/bin/zsh
# Halloween night on this Mac: launchd runs this (fyi.taylor.cryptopunkins.payout, ~/Library/LaunchAgents) at 7:55 PM
# and every half hour to 11:30 PM on Oct 31, then 12:01, 12:15 and 1:00 AM on Nov 1. Each run is tools/payout.sh:
# through the night it finishes waiting faces (so OpenSea shows them) and sends the 10%; from midnight it also sends
# every Great Pumpkin its share. A second job (fyi.taylor.cryptopunkins.awake) keeps the Mac awake 7:50 PM to 2 AM.
# Log: ~/Library/Logs/cryptopunkins-payout.log. Only in 2026 (launchd would repeat it every year).
[[ $(date +%Y) == 2026 ]] || exit 0
export PATH=$HOME/.foundry/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
echo "== $(date '+%a %b %d %I:%M %p')"
${0:A:h}/payout.sh || echo "(payout.sh stopped: see above)"
