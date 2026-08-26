# Kalshi Arbitrage Bot

## What This Project Does

Cross-platform prediction market arbitrage bot. It monitors top traders on **Polymarket** (via Bullpen CLI), finds matching markets on **Kalshi** (US-legal prediction market), compares prices, and executes trades on Kalshi when there's a price edge.

The user (Michael) is US-based and cannot trade on Polymarket directly, so the bot uses Polymarket as a **read-only signal source** and Kalshi as the **execution platform**.

## How It Works (Pipeline)

1. **Fetch smart money signals** — Bullpen CLI pulls the Polymarket leaderboard (top traders by PnL), then fetches each trader's open positions
2. **Match to Kalshi markets** — Keyword matching with outcome-aware filtering (e.g., "Holloway wins" only matches Kalshi markets where Holloway is the subject, not "McGregor wins")
3. **Compare prices** — Calculates edge in cents between Polymarket implied price and Kalshi ask price
4. **Execute trades** — Places orders on Kalshi when edge exceeds threshold, with balance guards to prevent overspending

## Project Structure

```
src/api/auth.py          — RSA-PSS request signing for Kalshi API
src/api/client.py        — Kalshi REST API client (Trade API v2)
src/strategies/smart_money_bot.py  — Main bot logic (signals, matching, execution)
src/strategies/arb_scanner.py      — Pure Kalshi arb scanner (Yes/No complement)
src/utils/logger.py      — Logging setup (console + file)
scripts/run_bot.py       — CLI runner (argparse: --interval, --min-edge, --live, --once, etc.)
scripts/run_bot.sh       — Shell wrapper for launchd
config/kalshi-private-key.pem  — RSA private key for API auth (DO NOT commit or share)
.env                     — API credentials (KALSHI_API_KEY_ID, KALSHI_PRIVATE_KEY_PATH, KALSHI_ENV)
data/logs/               — Bot logs (launchd_stdout.log, launchd_stderr.log, arb_bot.log)
docs/                    — Kalshi OpenAPI specs
```

## Key Technical Details

- **Kalshi Auth**: RSA-PSS signatures. Message = `{timestamp_ms}{METHOD}{/trade-api/v2/path}`. Three headers: KALSHI-ACCESS-KEY, KALSHI-ACCESS-TIMESTAMP, KALSHI-ACCESS-SIGNATURE.
- **Kalshi Orders (V2)**: POST `/portfolio/events/orders`. Side is `"bid"`/`"ask"`. Count and price are fixed-point dollar strings (e.g., `"1.00"`, `"0.3300"`).
- **Bullpen CLI**: Installed at `~/.bullpen/bin/bullpen`. Must inject this into PATH for subprocess calls. Uses `--output json` for machine-readable output.
- **Environment**: Python 3.14, production Kalshi API (`KALSHI_ENV=production`).

## Running the Bot

```bash
# One-time scan (dry run)
python scripts/run_bot.py --once

# Continuous dry run (every 5 min)
python scripts/run_bot.py --interval 300

# Live trading
python scripts/run_bot.py --live --once

# The bot is also set up as a launchd service:
launchctl load ~/Library/LaunchAgents/com.kalshi.smartmoneybot.plist    # start
launchctl unload ~/Library/LaunchAgents/com.kalshi.smartmoneybot.plist  # stop
tail -f data/logs/launchd_stdout.log                                    # monitor
```

## Important Notes

- The bot defaults to **dry run mode**. Add `--live` to place real orders.
- Michael actively trades his real Kalshi account manually (outside this bot), across
  many sports/markets, so its balance fluctuates independently and can swing widely —
  don't assume a stale balance figure; check `client.get_balance()` for the current one.
- The balance guard prevents the *bot's own* orders from exceeding available funds.
- Multivariate combo markets (tickers containing `KXMV`) are skipped — no standalone liquidity.
- Bullpen CLI must be logged in (`bullpen login`) and needs PATH set to `~/.bullpen/bin`.
