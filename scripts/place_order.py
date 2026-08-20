#!/usr/bin/env python3
"""Place ONE deliberate order on Kalshi — you choose the market, side, price, size.

This is separate from the autonomous bot: it does exactly one thing you specify,
so a first live trade is intentional rather than whatever the scanner picked.

Dry-run by default. Nothing is sent unless you pass --live.

Examples
--------
    # See the current book + what the order would be (no order sent):
    python3 scripts/place_order.py --ticker KXWTA-26USO-PEG --price 55 --count 1

    # Actually place it (buy 1 YES contract at 55c):
    python3 scripts/place_order.py --ticker KXWTA-26USO-PEG --price 55 --count 1 --live
"""

import argparse
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.api.client import KalshiClient


def main():
    p = argparse.ArgumentParser(description="Place one order on Kalshi (buy YES)")
    p.add_argument("--ticker", required=True, help="Market ticker, e.g. KXWTA-26USO-PEG")
    p.add_argument("--side", default="yes", choices=["yes"],
                   help="Only 'yes' is supported (default). To bet against an "
                        "outcome, find that outcome's own Kalshi ticker and buy "
                        "YES on it instead — each side of a matchup is its own market.")
    p.add_argument("--price", type=float, required=True,
                   help="Limit price in cents (e.g. 55) or dollars (e.g. 0.55) — both accepted")
    p.add_argument("--count", type=int, default=1, help="Contracts (default: 1)")
    p.add_argument("--live", action="store_true", help="Actually send the order")
    args = p.parse_args()

    # This helper only BUYS YES (side=bid). To bet on the other outcome, buy YES
    # on that outcome's own market ticker — each side of a game is its own market.

    # Accept either cents (55) or dollars (0.55) for --price.
    args.price = round(args.price * 100) if args.price < 1 else round(args.price)

    if not (1 <= args.price <= 99):
        p.error("--price must be between 1 and 99 cents")
    if args.count < 1:
        p.error("--count must be >= 1")

    client = KalshiClient()

    # Show balance and the live book so you can sanity-check before sending.
    bal = client.get_balance()
    print(f"Balance: ${bal['balance_dollars']}")
    try:
        mkt = client.get_market(args.ticker)
        m = mkt.get("market", mkt)
        print(f"Market : {m.get('title','')} — {m.get('yes_sub_title','')}")
        print(f"Book   : yes_bid {m.get('yes_bid_dollars')} / yes_ask {m.get('yes_ask_dollars')}"
              f"  |  no_bid {m.get('no_bid_dollars')} / no_ask {m.get('no_ask_dollars')}")
        print(f"Status : {m.get('status')}  close_time {m.get('close_time')}")
    except Exception as e:
        print(f"(could not fetch market: {e})")

    cost = args.price * args.count
    # Kalshi Trade API v2 create-order shape (CreateOrderV2Request):
    #   side=bid  -> buy YES ;  price/count are fixed-point strings.
    order = {
        "ticker": args.ticker,
        "client_order_id": str(uuid.uuid4()),
        "side": "bid",                       # buy YES
        "count": f"{args.count}",
        "price": f"{args.price / 100:.4f}",  # e.g. 55c -> "0.5500"
        "time_in_force": "good_till_canceled",
        "self_trade_prevention_type": "taker_at_cross",
    }

    print()
    print(f"ORDER  : buy YES {args.count}x {args.ticker} @ {args.price}c "
          f"(max cost ${cost/100:.2f})")

    cost_dollars = cost / 100
    bal_dollars = float(bal["balance_dollars"])
    if cost_dollars > bal_dollars:
        print(f"ABORT  : cost ${cost_dollars:.2f} exceeds balance ${bal_dollars:.2f}")
        sys.exit(1)

    if not args.live:
        print("DRY RUN: not sent. Re-run with --live to place it.")
        return

    print("SENDING…")
    result = client.create_order(order)
    print(f"PLACED : order_id {result.get('order_id', '?')}  status {result.get('status', '?')}")


if __name__ == "__main__":
    main()
