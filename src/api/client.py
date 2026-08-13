"""Kalshi REST API client."""

import os
from typing import Any

import httpx
from dotenv import load_dotenv

from .auth import auth_headers, load_private_key

load_dotenv()

BASE_URLS = {
    "production": "https://external-api.kalshi.com/trade-api/v2",
    "demo": "https://external-api.demo.kalshi.co/trade-api/v2",
}


class KalshiClient:
    def __init__(
        self,
        api_key_id: str | None = None,
        private_key_path: str | None = None,
        env: str | None = None,
    ):
        self.api_key_id = api_key_id or os.environ["KALSHI_API_KEY_ID"]
        key_path = private_key_path or os.environ["KALSHI_PRIVATE_KEY_PATH"]
        self.private_key = load_private_key(key_path)
        env = env or os.environ.get("KALSHI_ENV", "demo")
        self.base_url = BASE_URLS[env]
        self.http = httpx.Client(timeout=30)

    def _request(self, method: str, path: str, **kwargs) -> Any:
        url = f"{self.base_url}{path}"
        # Signature must cover the full URL path (including /trade-api/v2 prefix)
        sign_path = f"/trade-api/v2{path}"
        headers = auth_headers(self.private_key, self.api_key_id, method.upper(), sign_path)
        resp = self.http.request(method.upper(), url, headers=headers, **kwargs)
        resp.raise_for_status()
        return resp.json()

    # -- Exchange --
    def get_exchange_status(self) -> dict:
        return self._request("GET", "/exchange/status")

    # -- Markets --
    def get_markets(self, **params) -> dict:
        return self._request("GET", "/markets", params=params)

    def get_market(self, ticker: str) -> dict:
        return self._request("GET", f"/markets/{ticker}")

    def get_market_orderbook(self, ticker: str) -> dict:
        return self._request("GET", f"/markets/{ticker}/orderbook")

    def get_market_orderbooks(self, tickers: list[str]) -> dict:
        return self._request("GET", "/markets/orderbooks", params={"tickers": ",".join(tickers)})

    def get_market_candlesticks(self, ticker: str, **params) -> dict:
        return self._request("GET", f"/markets/{ticker}/candlesticks", params=params)

    def get_trades(self, **params) -> dict:
        return self._request("GET", "/markets/trades", params=params)

    # -- Events --
    def get_events(self, **params) -> dict:
        return self._request("GET", "/events", params=params)

    def get_event(self, event_ticker: str) -> dict:
        return self._request("GET", f"/events/{event_ticker}")

    # -- Orders (V2) --
    def create_order(self, order: dict) -> dict:
        return self._request("POST", "/portfolio/events/orders", json=order)

    def cancel_order(self, order_id: str) -> dict:
        return self._request("DELETE", f"/portfolio/events/orders/{order_id}")

    def get_orders(self, **params) -> dict:
        return self._request("GET", "/portfolio/events/orders", params=params)

    def get_order(self, order_id: str) -> dict:
        return self._request("GET", f"/portfolio/events/orders/{order_id}")

    # -- Portfolio --
    def get_balance(self) -> dict:
        return self._request("GET", "/portfolio/balance")

    def get_positions(self, **params) -> dict:
        return self._request("GET", "/portfolio/positions", params=params)

    def get_fills(self, **params) -> dict:
        return self._request("GET", "/portfolio/fills", params=params)

    def get_settlements(self, **params) -> dict:
        return self._request("GET", "/portfolio/settlements", params=params)

    # -- Series --
    def get_series(self, series_ticker: str) -> dict:
        return self._request("GET", f"/series/{series_ticker}")
