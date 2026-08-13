#!/usr/bin/env python3
"""Run the Smart Money Cross-Platform Bot."""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.api.client import KalshiClient
from src.strategies.smart_money_bot import SmartMoneyBot
from src.utils.logger import setup_logging


def main():
    parser = argparse.ArgumentParser(description="Smart Money Cross-Platform Bot")
    parser.add_argument("--interval", type=int, default=300, help="Scan interval in seconds (default: 300)")
    parser.add_argument("--min-pnl", type=float, default=100_000, help="Min trader 7d PnL to follow (default: 100000)")
    parser.add_argument("--min-edge", type=float, default=2.0, help="Min edge in cents to trade (default: 2)")
    parser.add_argument("--max-contracts", type=int, default=10, help="Max contracts per trade (default: 10)")
    parser.add_argument("--max-price", type=int, default=85, help="Max price in cents (default: 85)")
    parser.add_argument("--min-price", type=int, default=5, help="Min price in cents (default: 5)")
    parser.add_argument("--top-traders", type=int, default=10, help="Number of top traders to monitor (default: 10)")
    parser.add_argument("--profit-target-cents", type=int, default=8, help="Take-profit offset above entry in cents (default: 8)")
    parser.add_argument("--daily-loss-limit-pct", type=float, default=0.20, help="Halt live orders after this fraction of start-of-day balance is lost (default: 0.20)")
    parser.add_argument("--max-exposure-pct", type=float, default=0.50, help="Max fraction of balance in open positions (default: 0.50)")
    parser.add_argument("--per-trade-pct", type=float, default=0.10, help="Max fraction of balance spent on one trade (default: 0.10)")
    parser.add_argument("--max-trades-per-cycle", type=int, default=10, help="Max new positions opened per scan (default: 10)")
    parser.add_argument("--live", action="store_true", help="Enable live trading (default: dry run)")
    parser.add_argument("--once", action="store_true", help="Run one scan and exit")
    args = parser.parse_args()

    setup_logging()

    client = KalshiClient()
    bot = SmartMoneyBot(
        kalshi_client=client,
        min_trader_pnl=args.min_pnl,
        min_edge_cents=args.min_edge,
        max_contracts=args.max_contracts,
        max_price_cents=args.max_price,
        min_price_cents=args.min_price,
        top_n_traders=args.top_traders,
        dry_run=not args.live,
        profit_target_cents=args.profit_target_cents,
        daily_loss_limit_pct=args.daily_loss_limit_pct,
        max_exposure_pct=args.max_exposure_pct,
        per_trade_pct=args.per_trade_pct,
        max_trades_per_cycle=args.max_trades_per_cycle,
    )

    if args.once:
        bot.scan_once()
    else:
        bot.run(interval_seconds=args.interval)


if __name__ == "__main__":
    main()
