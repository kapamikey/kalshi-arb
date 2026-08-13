#!/bin/bash
# Wrapper script for launchd to run the Smart Money Bot
cd /Users/michaeltirone/Desktop/1-Projects/kalshi-arb
export PATH="/Users/michaeltirone/.bullpen/bin:$PATH"
exec /Library/Frameworks/Python.framework/Versions/3.14/bin/python3 scripts/run_bot.py \
    --interval 300 \
    --min-edge 2 \
    --max-contracts 1 \
    --once
