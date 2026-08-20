#!/usr/bin/env python3
"""Daily P/L report — only the figures we can trust.

IMPORTANT: Kalshi's own P/L page is the source of truth for realized/all-time P/L.
We do NOT reconstruct historical realized P/L from /portfolio/settlements — those
cost fields report *gross traded volume* (every contract bought and later sold
back), so summing them massively overstates losses on any market you day-traded.

What this reports instead, all authoritative:
  - Account value now:   cash + open-position value   (from /portfolio/balance)
  - Open positions:      current exposure at risk      (from /portfolio/positions)
  - Bot ledger:          realized P/L on trades THIS BOT placed and held to
                         settlement (from data/trades.jsonl) — reliable because
                         the bot records entry price and doesn't close early.

For all-time realized P/L across your manual trading, open the Kalshi app's P/L
page. Don't trust a number this script invents for that.

Usage:
    python3 scripts/pnl.py            # human-readable
    python3 scripts/pnl.py --json     # machine-readable
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.api.client import KalshiClient
from src.utils import ledger, portfolio_log


def _f(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def build_report(client) -> dict:
    bal = client.get_balance()
    cash = _f(bal.get("balance_dollars"))
    port_value = _f(bal.get("portfolio_value")) / 100.0  # cents -> dollars

    pos = client.get_positions().get("market_positions", [])
    open_positions = [
        {
            "ticker": p.get("ticker"),
            "contracts": _f(p.get("position_fp")),
            "exposure": _f(p.get("market_exposure_dollars")),
        }
        for p in pos if _f(p.get("position_fp")) != 0
    ]

    # Count how many ledger rows are REAL (live) vs pretend (dry-run). The bot
    # logs every dry-run cycle, so the raw ledger is almost all pretend — showing
    # its P/L as if real is misleading.
    live_rows = 0
    ledger_path = Path(__file__).resolve().parent.parent / "data" / "trades.jsonl"
    if ledger_path.exists():
        for line in ledger_path.read_text().splitlines():
            try:
                if json.loads(line).get("dry_run") is False:
                    live_rows += 1
            except (ValueError, TypeError):
                pass

    led = ledger.summary() if live_rows else None
    growth = portfolio_log.growth_summary()

    return {
        "as_of": datetime.now(timezone.utc).isoformat(),
        "cash": cash,
        "portfolio_value": port_value,
        "account_value": cash + port_value,
        "open_exposure": sum(p["exposure"] for p in open_positions),
        "open_positions": open_positions,
        "live_bot_trades": live_rows,
        "bot_ledger": led,  # None until the bot has placed at least one real trade
        "growth": growth,  # None until at least one scan cycle has run
    }


def print_report(r: dict):
    def money(x):
        return f"+${x:,.2f}" if x >= 0 else f"-${abs(x):,.2f}"

    print("=" * 54)
    print(f"  KALSHI ACCOUNT  ·  {r['as_of'][:16].replace('T', ' ')} UTC")
    print("=" * 54)
    print(f"  Account value : ${r['account_value']:,.2f}  "
          f"(cash ${r['cash']:,.2f} + positions ${r['portfolio_value']:,.2f})")
    growth = r.get("growth")
    if growth:
        arrow = "up" if growth["delta"] >= 0 else "down"
        since = growth["first_ts"][:10]
        print(f"  Growth        : {money(growth['delta'])} ({growth['pct']:+.1f}%) "
              f"{arrow} since {since}  [{growth['n_snapshots']} snapshots]")
    print(f"  Open exposure : ${r['open_exposure']:,.2f} across "
          f"{len(r['open_positions'])} position(s)")
    if r["open_positions"]:
        for p in r["open_positions"]:
            print(f"    {p['ticker'][:42]:42s} {p['contracts']:.0f}x  "
                  f"${p['exposure']:.2f} at risk")
    print("-" * 54)
    led = r["bot_ledger"]
    if led is None:
        print("  Bot: running in PRETEND mode — 0 real trades placed.")
        print("  (No bot P/L yet. It only logs what it *would* bet.)")
    else:
        bot_pnl = led.get("realized_pnl_cents", 0) / 100.0
        print(f"  Bot (real trades only): {led.get('won',0)}W / {led.get('lost',0)}L "
              f"({led.get('win_rate',0):.0%}), realized {money(bot_pnl)}")
    print("-" * 54)
    print("  All-time realized P/L: see Kalshi's own P/L page.")
    print("  (Not reconstructed here — settlement cost fields report gross")
    print("   traded volume and overstate losses on day-traded markets.)")
    print("=" * 54)


def main():
    ap = argparse.ArgumentParser(description="Kalshi account + bot-ledger report")
    ap.add_argument("--json", action="store_true", help="Output JSON instead of a table")
    args = ap.parse_args()

    report = build_report(KalshiClient())
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print_report(report)


if __name__ == "__main__":
    main()
