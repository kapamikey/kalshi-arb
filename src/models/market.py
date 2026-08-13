"""Market and orderbook data models."""

from dataclasses import dataclass


@dataclass
class OrderbookLevel:
    price: int  # cents
    quantity: int


@dataclass
class Orderbook:
    ticker: str
    yes_bids: list[OrderbookLevel]
    yes_asks: list[OrderbookLevel]
    no_bids: list[OrderbookLevel]
    no_asks: list[OrderbookLevel]

    @classmethod
    def from_api(cls, ticker: str, data: dict) -> "Orderbook":
        return cls(
            ticker=ticker,
            yes_bids=[OrderbookLevel(p, q) for p, q in (data.get("yes", {}).get("bids") or [])],
            yes_asks=[OrderbookLevel(p, q) for p, q in (data.get("yes", {}).get("asks") or [])],
            no_bids=[OrderbookLevel(p, q) for p, q in (data.get("no", {}).get("bids") or [])],
            no_asks=[OrderbookLevel(p, q) for p, q in (data.get("no", {}).get("asks") or [])],
        )

    @property
    def best_yes_bid(self) -> int | None:
        return self.yes_bids[0].price if self.yes_bids else None

    @property
    def best_yes_ask(self) -> int | None:
        return self.yes_asks[0].price if self.yes_asks else None

    @property
    def best_no_bid(self) -> int | None:
        return self.no_bids[0].price if self.no_bids else None

    @property
    def best_no_ask(self) -> int | None:
        return self.no_asks[0].price if self.no_asks else None

    @property
    def midpoint_yes(self) -> float | None:
        if self.best_yes_bid is not None and self.best_yes_ask is not None:
            return (self.best_yes_bid + self.best_yes_ask) / 2
        return None


@dataclass
class ArbOpportunity:
    """An arbitrage opportunity between related markets."""
    market_a_ticker: str
    market_b_ticker: str
    description: str
    edge_cents: float
    side_a: str  # "yes" or "no"
    side_b: str
    price_a: int
    price_b: int
    max_contracts: int
