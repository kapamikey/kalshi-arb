#!/usr/bin/env python3
"""Quick scan for arbitrage opportunities."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.api.client import KalshiClient
from src.strategies.arb_scanner import ArbScanner
from src.utils.logger import setup_logging

setup_logging()


def main():
    client = KalshiClient()
    scanner = ArbScanner(client, min_edge_cents=2)

    print("Scanning Kalshi markets for arbitrage opportunities...\n")
    opps = scanner.scan_all(limit=200)

    if not opps:
        print("No arbitrage opportunities found above threshold.")
        return

    print(f"Found {len(opps)} opportunities:\n")
    for i, opp in enumerate(opps, 1):
        print(f"  {i}. [{opp.edge_cents:.0f}c edge] {opp.description}")
        print(f"     Ticker: {opp.market_a_ticker} | Max contracts: {opp.max_contracts}")
        print()


if __name__ == "__main__":
    main()
