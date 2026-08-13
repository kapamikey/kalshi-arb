#!/usr/bin/env python3
"""Verify Kalshi API connection and credentials."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.api.client import KalshiClient
from src.utils.logger import setup_logging

setup_logging()


def main():
    print("Checking Kalshi API connection...\n")

    client = KalshiClient()

    # 1. Exchange status (no auth needed)
    status = client.get_exchange_status()
    print(f"Exchange active: {status.get('exchange_active')}")
    print(f"Trading active:  {status.get('trading_active')}")
    print()

    # 2. Balance (auth required)
    try:
        balance = client.get_balance()
        cents = balance.get("balance", 0)
        print(f"Account balance: ${cents / 100:.2f}")
    except Exception as e:
        print(f"Auth check failed: {e}")
        return

    # 3. Sample markets
    markets = client.get_markets(status="open", limit=5)
    print(f"\nSample open markets:")
    for m in markets.get("markets", []):
        print(f"  {m['ticker']}: {m.get('title', m.get('subtitle', ''))}")

    print("\nConnection verified!")


if __name__ == "__main__":
    main()
