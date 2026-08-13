"""Arbitrage scanner for Kalshi markets.

Looks for mispricings in:
1. Yes/No complement: yes_ask + no_ask < 100 (free money) or yes_bid + no_bid > 100
2. Multi-outcome events: sum of cheapest "yes" across all outcomes < 100
3. Correlated markets: same underlying event priced differently across tickers
"""

import logging
from dataclasses import dataclass

from src.api.client import KalshiClient
from src.models.market import ArbOpportunity, Orderbook

logger = logging.getLogger(__name__)


class ArbScanner:
    def __init__(self, client: KalshiClient, min_edge_cents: int = 3):
        self.client = client
        self.min_edge_cents = min_edge_cents

    def scan_yes_no_complement(self, tickers: list[str]) -> list[ArbOpportunity]:
        """Find markets where buying both Yes and No costs less than $1.

        In a binary market, Yes + No must equal 100 cents at settlement.
        If best_yes_ask + best_no_ask < 100, you can buy both sides and
        lock in a guaranteed profit of (100 - total_cost) cents per contract.
        """
        opportunities = []
        for ticker in tickers:
            try:
                raw = self.client.get_market_orderbook(ticker)
                book = Orderbook.from_api(ticker, raw.get("orderbook", raw))
                if book.best_yes_ask is None or book.best_no_ask is None:
                    continue

                total_cost = book.best_yes_ask + book.best_no_ask
                if total_cost < 100:
                    edge = 100 - total_cost
                    if edge >= self.min_edge_cents:
                        max_qty = min(
                            book.yes_asks[0].quantity,
                            book.no_asks[0].quantity,
                        )
                        opportunities.append(ArbOpportunity(
                            market_a_ticker=ticker,
                            market_b_ticker=ticker,
                            description=f"Yes/No complement arb: buy Yes@{book.best_yes_ask} + No@{book.best_no_ask} = {total_cost} < 100",
                            edge_cents=edge,
                            side_a="yes",
                            side_b="no",
                            price_a=book.best_yes_ask,
                            price_b=book.best_no_ask,
                            max_contracts=max_qty,
                        ))
            except Exception as e:
                logger.warning(f"Error scanning {ticker}: {e}")
        return opportunities

    def scan_multi_outcome_event(self, event_ticker: str) -> list[ArbOpportunity]:
        """Find events where the sum of all outcome Yes prices < 100.

        In a multi-outcome event (e.g., "Who wins the election?"), exactly
        one outcome settles Yes. If the sum of the cheapest Yes across all
        outcomes is < 100, buying Yes on every outcome guarantees profit.
        """
        opportunities = []
        try:
            event = self.client.get_event(event_ticker)
            markets = event.get("event", {}).get("markets", [])
            if len(markets) < 2:
                return []

            tickers = [m["ticker"] for m in markets]
            books = {}
            total_ask = 0
            min_qty = float("inf")

            for ticker in tickers:
                raw = self.client.get_market_orderbook(ticker)
                book = Orderbook.from_api(ticker, raw.get("orderbook", raw))
                if book.best_yes_ask is None:
                    return []  # can't complete the arb
                books[ticker] = book
                total_ask += book.best_yes_ask
                min_qty = min(min_qty, book.yes_asks[0].quantity)

            if total_ask < 100:
                edge = 100 - total_ask
                if edge >= self.min_edge_cents:
                    opportunities.append(ArbOpportunity(
                        market_a_ticker=event_ticker,
                        market_b_ticker=",".join(tickers),
                        description=f"Multi-outcome arb: sum of Yes asks = {total_ask} < 100 across {len(tickers)} outcomes",
                        edge_cents=edge,
                        side_a="yes",
                        side_b="yes",
                        price_a=total_ask,
                        price_b=100,
                        max_contracts=int(min_qty),
                    ))
        except Exception as e:
            logger.warning(f"Error scanning event {event_ticker}: {e}")
        return opportunities

    def scan_all(self, limit: int = 200) -> list[ArbOpportunity]:
        """Scan active markets for all arbitrage types."""
        opportunities = []

        # Get active markets
        markets_resp = self.client.get_markets(status="open", limit=limit)
        markets = markets_resp.get("markets", [])
        tickers = [m["ticker"] for m in markets]

        logger.info(f"Scanning {len(tickers)} markets for Yes/No complement arbs...")
        opportunities.extend(self.scan_yes_no_complement(tickers))

        # Get events for multi-outcome scanning
        seen_events = set()
        for m in markets:
            et = m.get("event_ticker")
            if et and et not in seen_events:
                seen_events.add(et)

        logger.info(f"Scanning {len(seen_events)} events for multi-outcome arbs...")
        for et in seen_events:
            opportunities.extend(self.scan_multi_outcome_event(et))

        opportunities.sort(key=lambda x: x.edge_cents, reverse=True)
        return opportunities
