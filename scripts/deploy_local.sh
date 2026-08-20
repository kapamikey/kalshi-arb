#!/bin/bash
# Sync source (~/Documents/GitHub/kalshi-arb) -> runtime (~/kalshi-arb-run).
#
# Why two folders: macOS blocks background/launchd processes from working
# inside ~/Documents (a "Files and Folders" privacy restriction) — the bot
# crashes instantly (exit 78) if launchd tries to run it there. The runtime
# copy lives in a plain folder under $HOME that launchd CAN access.
#
# Run this after any code change so the background service picks it up.
# Preserves the runtime copy's own data/ (ledger, portfolio history, logs) —
# only code and config are overwritten.

set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$HOME/kalshi-arb-run"

rsync -a \
  --exclude '.git/' --exclude '__pycache__/' --exclude '*.pyc' \
  --exclude '.DS_Store' --exclude '.venv/' \
  --exclude 'data/' \
  "$SRC"/ "$RUN"/

echo "Synced $SRC -> $RUN (data/ preserved)"
