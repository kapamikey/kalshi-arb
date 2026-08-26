"""Smart Money Cross-Platform Bot.

Monitors top Polymarket traders via Bullpen CLI, finds matching
markets on Kalshi, and executes when there's a price edge.
"""

import json
import logging
import re
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from src.api.client import KalshiClient
from src.utils import ledger, portfolio_log

logger = logging.getLogger(__name__)

PAPER_LEDGER_PATH = Path("data/paper_trades.jsonl")
PAPER_PORTFOLIO_PATH = Path("data/paper_portfolio.jsonl")


@dataclass
class SmartMoneySignal:
    """A signal derived from a top Polymarket trader's position."""
    trader_address: str
    trader_name: str
    trader_pnl: float
    trader_win_rate: float
    event_name: str
    outcome: str
    side: str  # "buy" or "sell"
    shares: float
    value: float
    keywords: list[str] = field(default_factory=list)


@dataclass
class CrossPlatformOpportunity:
    """A matched opportunity between Polymarket signal and Kalshi market."""
    signal: SmartMoneySignal | None
    kalshi_ticker: str
    kalshi_title: str
    kalshi_yes_bid: float | None
    kalshi_yes_ask: float | None
    polymarket_price: float | None
    edge_cents: float
    confidence: float  # 0-1 composite score
    signal_type: str = "whale"  # "whale" (Polymarket-backed) or "internal"
    series_ticker: str = ""


def run_bullpen(args: list[str], timeout: int = 60) -> dict | None:
    """Run a Bullpen CLI command and return parsed JSON."""
    cmd = ["bullpen"] + args + ["--output", "json"]
    env = {**__import__("os").environ}
    env["PATH"] = str(Path.home() / ".bullpen" / "bin") + ":" + env.get("PATH", "")
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, env=env
        )
        if result.returncode != 0:
            logger.warning(f"Bullpen error: {result.stderr[:200]}")
            return None
        return json.loads(result.stdout)
    except (subprocess.TimeoutExpired, json.JSONDecodeError) as e:
        logger.warning(f"Bullpen command failed: {e}")
        return None


def check_bullpen_auth() -> tuple[bool, str]:
    """Is the Bullpen login usable for pulling whale signals?

    The refresh token silently expiring is what killed the whale feed for 133
    cycles — the bot just logged 'Bullpen error:' and quietly fell back to the
    internal scan. Surface it loudly instead.

    Returns (ok, detail).
    """
    env = {**__import__("os").environ}
    env["PATH"] = str(Path.home() / ".bullpen" / "bin") + ":" + env.get("PATH", "")
    try:
        result = subprocess.run(
            ["bullpen", "doctor", "auth"],
            capture_output=True, text=True, timeout=45, env=env,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return False, f"bullpen CLI unavailable: {e}"

    out = result.stdout or ""
    # Read the "Token:" line specifically. A substring search over the whole
    # report is not safe: "Keypair: Valid" is printed even when fully logged
    # out, so `"Valid" in out` reports a healthy feed for a logged-out CLI —
    # exactly the silent failure this check exists to catch.
    for line in out.splitlines():
        low = line.lower()
        if "token:" not in low:
            continue
        detail = line.split(":", 1)[1].strip() or line.strip()
        if "expired" in low:
            return False, f"token expired ({detail})"
        if "not logged in" in low:
            return False, "not logged in — run: bullpen login"
        if "valid" in low:
            return True, detail
        return False, f"unrecognized token state: {detail}"
    return False, "could not determine auth state — run: bullpen login"


def series_of(ticker: str) -> str:
    """Series ticker is the segment before the first '-' (e.g.
    'KXWNBAGAME-26JUL29GSPHX-PHX' -> 'KXWNBAGAME')."""
    return ticker.split("-", 1)[0] if ticker else ""


def extract_keywords(text: str) -> list[str]:
    """Extract searchable keywords from an event/market name."""
    stop_words = {
        "will", "the", "on", "vs", "vs.", "in", "by", "at", "to",
        "of", "a", "an", "and", "or", "for", "be", "is", "it",
        "more", "markets", "team", "advance", "win", "winner",
    }
    words = re.findall(r'[A-Za-z]+', text.lower())
    return [w for w in words if w not in stop_words and len(w) > 2]


def extract_participant_names(text: str) -> list[str]:
    """Extract likely participant/fighter/team names from a market title.

    Looks for capitalized words that aren't common verbs or prepositions.
    Returns lowercased names for comparison.
    """
    noise = {
        "will", "the", "on", "vs", "in", "by", "at", "to", "of", "a",
        "an", "and", "or", "for", "be", "is", "it", "win", "winner",
        "advance", "fight", "bout", "match", "round", "ko", "tko",
        "decision", "submission", "over", "under", "more", "total",
        "goals", "spread", "team", "game", "set", "distance", "method",
        "victory", "ufc", "moves", "move", "who", "yes", "no",
    }
    # Find capitalized words (likely proper nouns / names)
    caps = re.findall(r'\b[A-Z][a-z]{2,}\b', text)
    names = [w.lower() for w in caps if w.lower() not in noise]
    return names


def extract_market_subject(title: str) -> list[str]:
    """Extract the subject of a Kalshi market — who needs to win/advance.

    "Will Conor McGregor win the Conor McGregor vs Max Holloway fight?"
    → ["conor", "mcgregor"]

    "Will Max Holloway win the ..."
    → ["max", "holloway"]

    "Will Switzerland advance..."
    → ["switzerland"]
    """
    # Pattern: "Will [SUBJECT] win/advance/..."
    m = re.match(r'Will\s+(.+?)\s+(?:win|advance|score|have)', title, re.IGNORECASE)
    if m:
        subject_text = m.group(1)
        # Extract proper nouns from the subject
        names = extract_participant_names(subject_text)
        if names:
            return names
        # Fallback: just use lowercased words
        return [w.lower() for w in subject_text.split() if len(w) > 2]
    return []


def outcome_matches_market(signal: 'SmartMoneySignal', kalshi_title: str) -> bool:
    """Check if the signal's outcome aligns with the Kalshi market subject.

    Prevents matching "Max Holloway" signal to a "Will Conor McGregor win" market.
    The signal outcome name must match who the market is ABOUT (the subject),
    not just appear anywhere in the title.
    """
    # Get the signal's participant (who the trader is betting on)
    signal_names = extract_participant_names(signal.outcome)
    if not signal_names:
        signal_names = extract_participant_names(signal.event_name)
        if not signal_names:
            return True  # can't determine — allow

    # Get who the Kalshi market is about (the subject before "win")
    subject_names = extract_market_subject(kalshi_title)
    if not subject_names:
        return True  # can't determine subject — allow

    # The signal outcome must match the market subject
    return bool(set(signal_names) & set(subject_names))


class SmartMoneyBot:
    def __init__(
        self,
        kalshi_client: KalshiClient,
        min_trader_pnl: float = 100_000,
        min_edge_cents: float = 2.0,
        max_contracts: int = 5,
        max_price_cents: int = 85,
        min_price_cents: int = 5,
        top_n_traders: int = 10,
        dry_run: bool = True,
        take_profit_pct: float = 0.20,
        stop_loss_pct: float = 0.50,
        daily_loss_limit_pct: float = 0.20,
        max_exposure_pct: float = 0.50,
        per_trade_pct: float = 0.10,
        max_trades_per_cycle: int = 10,
        min_confidence: float = 0.2,
        max_market_pages: int = 60,
        internal_min_spread_cents: int = 4,
        internal_min_open_interest: float = 100.0,
        whale_only: bool = True,
        max_hours_to_close: float | None = 12.0,
        min_market_volume: float = 1_000_000.0,
        paper_trading: bool = False,
        paper_start_cents: int = 100_000,
    ):
        self.client = kalshi_client
        self.min_trader_pnl = min_trader_pnl
        self.min_edge_cents = min_edge_cents
        self.max_contracts = max_contracts
        self.max_price_cents = max_price_cents
        self.min_price_cents = min_price_cents
        self.top_n_traders = top_n_traders
        self.paper_trading = paper_trading
        self.paper_start_cents = paper_start_cents
        # Paper trading is always simulated — no real order ever gets placed,
        # regardless of what dry_run was passed in.
        self.dry_run = True if paper_trading else dry_run
        self.take_profit_pct = take_profit_pct
        self.stop_loss_pct = stop_loss_pct
        self.daily_loss_limit_pct = daily_loss_limit_pct
        self.max_exposure_pct = max_exposure_pct
        self.per_trade_pct = per_trade_pct
        self.max_trades_per_cycle = max_trades_per_cycle
        self.min_confidence = min_confidence
        self.max_market_pages = max_market_pages
        self.internal_min_spread_cents = internal_min_spread_cents
        self.internal_min_open_interest = internal_min_open_interest
        self.whale_only = whale_only
        self.max_hours_to_close = max_hours_to_close
        self.min_market_volume = min_market_volume
        self._kalshi_market_cache: dict[str, list[dict]] = {}
        self._kalshi_markets_by_ticker: dict[str, dict] = {}
        self._last_signals: list = []
        self._sports_series: set[str] = set()
        self._kalshi_cache_time: float = 0
        self._balance_cents: int = 0
        self._portfolio_value_cents: int = 0
        self._account_value_cents: int = 0
        self._start_of_day_balance_cents: int = 0
        self._current_day: str = ""

    def refresh_balance(self):
        """Fetch current available balance + open-position value from Kalshi.

        Paper mode never touches the real account — balance is derived purely
        from the paper ledger: starting bankroll, minus cost tied up in open
        paper positions, plus realized P/L from paper positions that have
        closed. No separate state file needed; the ledger is the only source
        of truth.
        """
        if self.paper_trading:
            rows = ledger.read_all()
            open_cost = sum(int(r.get("cost_cents", 0) or 0) for r in rows if r.get("status") == ledger.OPEN)
            realized = sum(int(r.get("realized_pnl_cents", 0) or 0) for r in rows if r.get("status") != ledger.OPEN)
            self._balance_cents = self.paper_start_cents + realized - open_cost
            self._portfolio_value_cents = open_cost
            self._account_value_cents = self._balance_cents + self._portfolio_value_cents
            logger.info(
                f"Paper balance: ${self._balance_cents / 100:.2f}  "
                f"(account value ${self._account_value_cents / 100:.2f})"
            )
            return
        try:
            resp = self.client.get_balance()
            # Kalshi returns `balance` in integer cents and `balance_dollars` as a
            # decimal string. Prefer the dollar string; fall back to cents.
            if resp.get("balance_dollars") is not None:
                self._balance_cents = int(round(float(resp["balance_dollars"]) * 100))
            else:
                self._balance_cents = int(resp.get("balance", 0))
            # portfolio_value is already in cents (current value of open positions).
            self._portfolio_value_cents = int(resp.get("portfolio_value", 0) or 0)
            self._account_value_cents = self._balance_cents + self._portfolio_value_cents
            logger.info(
                f"Kalshi balance: ${self._balance_cents / 100:.2f}  "
                f"(account value ${self._account_value_cents / 100:.2f})"
            )
        except Exception as e:
            logger.warning(f"Failed to fetch balance: {e}")
            self._balance_cents = 0
            self._portfolio_value_cents = 0
            self._account_value_cents = 0

    # ── Step 1: Get Polymarket smart money signals ──

    def get_top_traders(self) -> list[dict]:
        """Fetch top traders from Polymarket leaderboard via Bullpen."""
        logger.info("Fetching Polymarket leaderboard...")
        data = run_bullpen([
            "polymarket", "data", "leaderboard",
            "--time-period", "7d",
            "--sort", "pnl",
            "--hide-bots",
            "--hide-farmers",
            "--limit", str(self.top_n_traders),
        ], timeout=120)
        if not data:
            return []
        traders = data.get("leaderboard", [])
        logger.info(f"Got {len(traders)} traders from leaderboard")
        return traders

    def get_trader_positions(self, address: str) -> list[dict]:
        """Fetch open positions for a specific trader."""
        data = run_bullpen([
            "polymarket", "positions",
            "--address", address,
        ], timeout=30)
        if not data:
            return []
        return data.get("positions", [])

    def extract_signals(self) -> list[SmartMoneySignal]:
        """Get signals from top trader positions."""
        traders = self.get_top_traders()
        signals = []

        for trader in traders:
            pnl = trader.get("realized_pnl_7d", 0) or 0
            if pnl < self.min_trader_pnl:
                continue

            address = trader["address"]
            name = trader.get("display_name") or address[:12]
            win_rate = trader.get("win_rate_7d", 0) or 0
            open_positions = trader.get("open_position_count", 0) or 0

            if open_positions == 0:
                continue

            logger.info(f"Checking positions for {name} (PnL: ${pnl:,.0f}, WR: {win_rate:.0%})")
            positions = self.get_trader_positions(address)

            for pos in positions:
                # Once a Polymarket market settles, its price snaps to exactly
                # $1.00 (won) or $0.00 (lost) — that's history, not a live
                # signal. Feeding it into the edge calc as "the whale thinks
                # this is 100% certain" produced nonsense like a +99c edge on
                # a market that finished days ago. Only trust positions still
                # actively trading (resolution_status == "open", not yet
                # redeemable) as evidence of what the trader currently believes.
                resolution = pos.get("resolution_status")
                if resolution is not None and resolution != "open":
                    continue
                if pos.get("redeemable"):
                    continue

                value = pos.get("current_value", 0) or 0
                if value < 100:  # skip tiny positions
                    continue

                event_name = pos.get("market", pos.get("title", ""))
                outcome = pos.get("outcome", "")
                shares = pos.get("shares", pos.get("size", 0)) or 0

                signal = SmartMoneySignal(
                    trader_address=address,
                    trader_name=name,
                    trader_pnl=pnl,
                    trader_win_rate=win_rate,
                    event_name=event_name,
                    outcome=outcome,
                    side="buy",
                    shares=shares,
                    value=value,
                    keywords=extract_keywords(event_name),
                )
                signals.append(signal)
                logger.info(f"  Signal: {outcome} on '{event_name}' (${value:,.0f})")

        logger.info(f"Extracted {len(signals)} signals from {len(traders)} traders")
        return signals

    # ── Step 2: Match signals to Kalshi markets ──

    def _load_sports_series(self) -> set[str]:
        """Set of every series ticker Kalshi files under the Sports category.

        Used to keep only sports events from the (uncategorized) events feed and
        to naturally exclude KXMV multivariate combos, which aren't listed here.
        """
        if self._sports_series:
            return self._sports_series
        try:
            resp = self.client._request("GET", "/series", params={"category": "Sports"})
            self._sports_series = {s["ticker"] for s in resp.get("series", [])}
        except Exception as e:
            logger.warning(f"Could not load sports series list: {e}")
            self._sports_series = set()
        return self._sports_series

    def refresh_kalshi_markets(self, force: bool = False):
        """Cache open sports markets (refresh every 5 min).

        The /markets Sports feed is dominated by tens of thousands of KXMV
        multivariate combos, so we page /events with nested markets instead and
        keep only events whose series is in the Sports set. Nested markets carry
        bid/ask/liquidity inline — no per-market GET needed for the internal scan.
        """
        if not force and time.time() - self._kalshi_cache_time < 300:
            return

        logger.info("Refreshing Kalshi market cache...")
        sports = self._load_sports_series()
        all_markets = []

        cursor = None
        for _ in range(self.max_market_pages):
            params = {"status": "open", "limit": 200, "with_nested_markets": True}
            if cursor:
                params["cursor"] = cursor
            resp = self.client.get_events(**params)
            events = resp.get("events", [])
            for e in events:
                if e.get("series_ticker") not in sports:
                    continue
                for m in e.get("markets", []):
                    m.setdefault("event_ticker", e.get("event_ticker"))
                    all_markets.append(m)
            cursor = resp.get("cursor")
            if not cursor or not events:
                break

        # Index by keywords, and keep a flat ticker→market map for scans that
        # iterate the whole universe (internal mispricing).
        self._kalshi_market_cache = {}
        self._kalshi_markets_by_ticker = {}
        now = datetime.now(timezone.utc)
        skipped_far, skipped_thin = 0, 0
        for m in all_markets:
            ticker = m.get("ticker")
            if not ticker or "KXMV" in ticker:  # skip multivariate combos
                continue
            if self.max_hours_to_close is not None:
                close_time = m.get("close_time")
                if close_time:
                    try:
                        close_dt = datetime.fromisoformat(close_time.replace("Z", "+00:00"))
                        hours_out = (close_dt - now).total_seconds() / 3600
                        if hours_out > self.max_hours_to_close:
                            skipped_far += 1
                            continue
                    except ValueError:
                        pass
            volume = float(m.get("volume_fp", 0) or 0)
            if volume < self.min_market_volume:
                skipped_thin += 1
                continue
            self._kalshi_markets_by_ticker[ticker] = m
            title = " ".join(filter(None, [
                m.get("title", ""), m.get("subtitle", ""),
                m.get("yes_sub_title", ""),
            ]))
            for kw in extract_keywords(title):
                self._kalshi_market_cache.setdefault(kw, []).append(m)

        self._kalshi_cache_time = time.time()
        logger.info(
            f"Cached {len(self._kalshi_markets_by_ticker)} sports markets "
            f"(skipped {skipped_far} closing >{self.max_hours_to_close}h out, "
            f"{skipped_thin} under ${self.min_market_volume:,.0f} volume)"
        )

    def find_matching_kalshi_markets(self, signal: SmartMoneySignal) -> list[dict]:
        """Find Kalshi markets that match a Polymarket signal."""
        self.refresh_kalshi_markets()

        # Score markets by keyword overlap
        candidates: dict[str, int] = {}
        for kw in signal.keywords:
            for m in self._kalshi_market_cache.get(kw, []):
                ticker = m["ticker"]
                candidates[ticker] = candidates.get(ticker, 0) + 1

        # Filter: require at least 2 keyword matches, exclude multivariate combos
        # and verify outcome alignment (e.g. don't match "Holloway wins" to "McGregor wins")
        matches = []
        for ticker, score in sorted(candidates.items(), key=lambda x: -x[1]):
            if score < 2:
                break
            if "KXMV" in ticker:
                continue
            # Find the market dict
            market_dict = None
            for kw in signal.keywords:
                for m in self._kalshi_market_cache.get(kw, []):
                    if m["ticker"] == ticker:
                        market_dict = m
                        break
                if market_dict:
                    break
            if not market_dict:
                continue
            # Check outcome alignment
            market_title = market_dict.get("title", "") + " " + market_dict.get("subtitle", "")
            if not outcome_matches_market(signal, market_title):
                logger.debug(f"  Skipping {ticker}: outcome mismatch (signal='{signal.outcome}', market='{market_title[:60]}')")
                continue
            matches.append(market_dict)

        # Deduplicate
        seen = set()
        unique = []
        for m in matches:
            if m["ticker"] not in seen:
                seen.add(m["ticker"])
                unique.append(m)

        return unique[:5]  # top 5 matches

    # ── Step 3: Compare prices and find edge ──

    def evaluate_opportunity(
        self, signal: SmartMoneySignal, kalshi_market: dict
    ) -> CrossPlatformOpportunity | None:
        """Compare Polymarket signal price to Kalshi market price."""
        ticker = kalshi_market["ticker"]
        title = kalshi_market.get("title", kalshi_market.get("subtitle", ""))

        try:
            # Prices come from the cached market dict (nested-market feed already
            # carries live bid/ask); avoids a per-candidate GET across dozens of
            # matches. At a 5-min scan cadence this is fresh enough.
            m = kalshi_market
            yes_bid = self._cents(m.get("yes_bid_dollars"))
            yes_ask = self._cents(m.get("yes_ask_dollars"))

            if not yes_ask or yes_ask == 0:
                return None

            # Estimate Polymarket implied price from position
            poly_price = None
            if signal.shares > 0 and signal.value > 0:
                poly_price = signal.value / signal.shares

            keyword_overlap = len(
                set(signal.keywords) & set(extract_keywords(title))
            )
            match_quality = min(keyword_overlap / max(len(signal.keywords), 1), 1.0)

            edge = 0
            if poly_price and yes_ask:
                edge = (poly_price * 100) - yes_ask

            confidence = self._whale_confidence(signal, match_quality)

            return CrossPlatformOpportunity(
                signal=signal,
                kalshi_ticker=ticker,
                kalshi_title=title,
                kalshi_yes_bid=yes_bid,
                kalshi_yes_ask=yes_ask,
                polymarket_price=poly_price,
                edge_cents=edge,
                confidence=confidence,
                signal_type="whale",
                series_ticker=m.get("event_ticker", "") or series_of(ticker),
            )
        except Exception as e:
            logger.warning(f"Error evaluating {ticker}: {e}")
            return None

    @staticmethod
    def _whale_confidence(signal: SmartMoneySignal, match_quality: float) -> float:
        """Composite 0-1 confidence for a whale-backed opportunity.

        Blends how well the market matches the signal (keyword/outcome overlap)
        with how much we trust the trader (win rate, capital at risk).
        """
        # Trader trust: win rate centered at 0.5, plus a small bump for a large
        # position (conviction). Clamped to [0, 1].
        wr = signal.trader_win_rate or 0.0
        trust = 0.5 + (wr - 0.5)  # == wr, kept explicit for tuning
        size_bump = min(signal.value / 100_000, 0.15) if signal.value else 0.0
        trust = max(0.0, min(trust + size_bump, 1.0))
        # Weight match quality more than trader trust — a bad match is useless
        # no matter who placed it.
        conf = 0.6 * match_quality + 0.4 * trust
        return round(max(0.0, min(conf, 1.0)), 3)

    def _internal_confidence(self, spread_cents: int, open_interest: float) -> float:
        """Composite 0-1 confidence for a self-sourced (no whale) opportunity.

        Wider spread + deeper open interest = more room to capture and easier to
        exit. Internal signals are inherently weaker than whale-backed ones, so
        this is capped below 1.0.
        """
        spread_score = min(spread_cents / 20.0, 1.0)      # 20c spread == full score
        oi_score = min(open_interest / 5000.0, 1.0)       # 5k contracts OI == full
        conf = 0.6 * spread_score + 0.4 * oi_score
        return round(max(0.0, min(conf * 0.7, 1.0)), 3)   # cap internal at 0.7

    def scan_internal_mispricing(self) -> list[CrossPlatformOpportunity]:
        """Flag wide-spread, liquid sports markets with no whale behind them.

        The edge here is the bid/ask spread itself: buy at the ask, rest a sell
        above it (take-profit handles the exit). Open interest is the liquidity
        proxy (the nested feed doesn't populate liquidity_dollars). Confidence is
        lower than whale signals and scales with spread width and depth.
        """
        self.refresh_kalshi_markets()
        opps: list[CrossPlatformOpportunity] = []
        for ticker, m in self._kalshi_markets_by_ticker.items():
            try:
                yes_bid = self._cents(m.get("yes_bid_dollars"))
                yes_ask = self._cents(m.get("yes_ask_dollars"))
                if yes_bid is None or yes_ask is None or yes_ask == 0:
                    continue
                if not (self.min_price_cents <= yes_ask <= self.max_price_cents):
                    continue
                spread = yes_ask - yes_bid
                if spread < self.internal_min_spread_cents:
                    continue
                open_interest = float(m.get("open_interest_fp", 0) or 0)
                if open_interest < self.internal_min_open_interest:
                    continue
                # Need a real ask to buy against.
                if float(m.get("yes_ask_size_fp", 0) or 0) <= 0:
                    continue

                confidence = self._internal_confidence(spread, open_interest)
                title = m.get("title", "") + " " + m.get("yes_sub_title", "")
                opps.append(CrossPlatformOpportunity(
                    signal=None,
                    kalshi_ticker=ticker,
                    kalshi_title=title.strip(),
                    kalshi_yes_bid=yes_bid,
                    kalshi_yes_ask=yes_ask,
                    polymarket_price=None,
                    edge_cents=float(spread),
                    confidence=confidence,
                    signal_type="internal",
                    series_ticker=m.get("event_ticker", "") or series_of(ticker),
                ))
            except Exception as e:
                logger.debug(f"internal scan skip {ticker}: {e}")
        return opps

    @staticmethod
    def _cents(dollar_str) -> int | None:
        if dollar_str in (None, ""):
            return None
        try:
            return int(round(float(dollar_str) * 100))
        except (TypeError, ValueError):
            return None

    # ── Step 4: Execute trades ──

    def place_order(
        self,
        ticker: str,
        side: str,
        price_cents: int,
        count: int,
        client_order_id: str | None = None,
    ) -> dict | None:
        """Place an order on Kalshi. Returns the API result (or dry-run stub)."""
        price_dollars = f"{price_cents / 100:.4f}"
        client_order_id = client_order_id or str(uuid.uuid4())

        order = {
            "ticker": ticker,
            "client_order_id": client_order_id,
            "side": side,  # "bid" or "ask"
            "count": f"{count:.2f}",
            "price": price_dollars,
            "time_in_force": "good_till_canceled",
            "self_trade_prevention_type": "taker_at_cross",
        }

        if self.dry_run:
            logger.info(f"[DRY RUN] Would place: {side} {count}x {ticker} @ {price_cents}c")
            return {"dry_run": True, "order": order, "client_order_id": client_order_id}

        logger.info(f"Placing order: {side} {count}x {ticker} @ {price_cents}c")
        try:
            result = self.client._request("POST", "/portfolio/events/orders", json=order)
            logger.info(f"Order placed: {result.get('order_id', '?')}")
            result["client_order_id"] = client_order_id
            return result
        except Exception as e:
            logger.error(f"Order failed: {e}")
            return None

    # ── Sizing & guardrails ──

    def _ensure_day_state(self):
        """Snapshot balance at the start of each new UTC day for the loss limit."""
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if today != self._current_day:
            self._current_day = today
            self._start_of_day_balance_cents = self._balance_cents

    def _daily_loss_tripped(self) -> bool:
        limit = int(self._start_of_day_balance_cents * self.daily_loss_limit_pct)
        if limit <= 0:
            return False
        loss = ledger.daily_realized_loss_cents()
        if loss >= limit:
            logger.warning(
                f"Daily loss limit hit: {loss}c lost >= {limit}c "
                f"({self.daily_loss_limit_pct:.0%} of start-of-day balance) — halting live orders"
            )
            return True
        return False

    def _current_exposure_cents(self) -> int:
        """Cost basis of currently-open positions (live only)."""
        try:
            resp = self.client.get_positions()
            positions = resp.get("market_positions", [])
            total = 0
            for p in positions:
                # market_exposure_dollars is the current cost basis of the position
                exp = p.get("market_exposure_dollars") or p.get("total_traded_dollars") or 0
                total += int(round(float(exp) * 100))
            return total
        except Exception as e:
            logger.warning(f"Could not fetch positions for exposure check: {e}")
            return 0

    def _size_position(self, opp: CrossPlatformOpportunity, balance_cents: int) -> int:
        """Confidence-scaled contract count, capped by per-trade balance %.

        Uses the total (start-of-cycle) balance for the per-trade cap so the cap
        is stable across the cycle, and the passed remaining balance to avoid
        oversizing as the simulated/real balance drains.
        """
        ask = int(opp.kalshi_yes_ask)
        if ask <= 0:
            return 0
        by_confidence = max(1, round(opp.confidence * self.max_contracts))
        # Per-trade dollar cap: no single trade risks more than per_trade_pct of
        # the full balance.
        max_spend = int(self._balance_cents * self.per_trade_pct)
        by_budget = max_spend // ask
        by_remaining = balance_cents // ask
        return max(0, min(by_confidence, by_budget, by_remaining, self.max_contracts))

    def place_take_profit(self, opp: CrossPlatformOpportunity, buy_client_id: str,
                          entry_cents: int, contracts: int):
        """Rest a limit sell at entry * (1 + take_profit_pct) — a 20% gross
        return by default (live only)."""
        target = min(round(entry_cents * (1 + self.take_profit_pct)), 99)
        target = max(target, entry_cents + 1)  # always at least 1c above entry
        tp_client_id = str(uuid.uuid4())
        result = self.place_order(
            opp.kalshi_ticker, "ask", target, contracts, client_order_id=tp_client_id
        )
        if result:
            ledger.update_trade(buy_client_id, {
                "take_profit_order_id": result.get("order_id") or tp_client_id,
                "take_profit_price_cents": target,
            })
            logger.info(
                f"  Take-profit rested: ask {contracts}x {opp.kalshi_ticker} @ {target}c"
            )

    def check_exits(self) -> int:
        """Exit any open position that has hit its take-profit target or
        fallen through its stop-loss floor — checked every cycle.

        Live positions already rest a real take-profit sell order and get
        cut on the bid for stop-loss; this method's job there is just the
        stop-loss cut. Dry-run/paper positions have no resting order, so both
        the take-profit and stop-loss checks are simulated here against the
        live bid — otherwise a dry-run/paper trade could only ever lose
        (ride to settlement or stop out), never simulate the win a live
        resting take-profit would have captured.

        Runs before settlement finalizes, so this only fires on markets still
        actively trading; check_settlements handles anything already decided.

        Capped at 200 checks/cycle — a network call per open row means an
        unbounded backlog (e.g. after a long outage) would make one cycle run
        for minutes and hammer the Kalshi API. Anything past the cap is picked
        up on the next cycle; it's a bounded delay, not a dropped check.
        """
        triggered = 0
        open_rows = ledger.open_trades()
        if len(open_rows) > 200:
            logger.warning(
                f"{len(open_rows)} open positions — checking the first 200 "
                f"this cycle, rest deferred to next cycle"
            )
            open_rows = open_rows[:200]
        for r in open_rows:
            ticker = r.get("ticker")
            entry = int(r.get("entry_price_cents", 0) or 0)
            contracts = int(r.get("contracts", 0) or 0)
            if not ticker or entry <= 0 or contracts <= 0:
                continue

            try:
                resp = self.client.get_market(ticker)
                m = resp.get("market", resp)
            except Exception as e:
                logger.warning("Stop-loss check failed for %s: %s", ticker, e)
                continue

            if m.get("status") not in (None, "active", "open"):
                continue  # already finalized — check_settlements handles it

            bid = self._cents(m.get("yes_bid_dollars"))
            if bid is None:
                continue

            is_dry = r.get("dry_run", self.dry_run)

            # Take-profit simulation (dry-run/paper only — live positions rest
            # a real sell order for this instead).
            if is_dry:
                target = min(round(entry * (1 + self.take_profit_pct)), 99)
                target = max(target, entry + 1)
                if bid >= target:
                    exit_price = target
                    pnl = (exit_price - entry) * contracts
                    ledger.update_trade(r["client_order_id"], {
                        "status": ledger.CLOSED,
                        "realized_pnl_cents": pnl,
                        "settled_ts": ledger._utc_now_iso(),
                        "exit_reason": "take_profit",
                        "exit_price_cents": exit_price,
                    })
                    triggered += 1
                    logger.info(
                        f"TAKE-PROFIT: [DRY RUN] {ticker} exited @ {exit_price}c "
                        f"(entry {entry}c, +{self.take_profit_pct:.0%} target) {pnl:+d}c"
                    )
                    continue

            floor = int(entry * (1 - self.stop_loss_pct))
            if bid > floor:
                continue  # still above the stop — hold

            exit_price = max(bid, 1)
            pnl = (exit_price - entry) * contracts

            if not is_dry:
                tp_id = r.get("take_profit_order_id")
                if tp_id:
                    try:
                        self.client.cancel_order(tp_id)
                    except Exception as e:
                        logger.warning(f"Could not cancel resting take-profit {tp_id}: {e}")
                self.place_order(ticker, "ask", exit_price, contracts)

            ledger.update_trade(r["client_order_id"], {
                "status": ledger.CLOSED,
                "realized_pnl_cents": pnl,
                "settled_ts": ledger._utc_now_iso(),
                "exit_reason": "stop_loss",
                "exit_price_cents": exit_price,
            })
            triggered += 1
            logger.warning(
                f"STOP-LOSS: {'[DRY RUN] ' if is_dry else ''}{ticker} exited @ "
                f"{exit_price}c (entry {entry}c, -{self.stop_loss_pct:.0%} floor) "
                f"{pnl:+d}c"
            )
        return triggered

    # ── Main loop ──

    def collect_opportunities(self) -> list[CrossPlatformOpportunity]:
        """Whale-backed + internal mispricing opportunities, sorted by edge."""
        opportunities: list[CrossPlatformOpportunity] = []

        signals = self.extract_signals()
        self._last_signals = signals
        for signal in signals:
            for kalshi_market in self.find_matching_kalshi_markets(signal):
                opp = self.evaluate_opportunity(signal, kalshi_market)
                if opp and opp.confidence >= self.min_confidence:
                    opportunities.append(opp)

        # The internal scan treats a wide bid/ask spread as if it were edge,
        # which is backwards — a wide spread means illiquid and expensive to
        # exit, not underpriced. It produced 93% of all historical picks and a
        # 15% win rate. Off by default; --allow-internal opts back in.
        if not self.whale_only:
            for opp in self.scan_internal_mispricing():
                if opp.confidence >= self.min_confidence:
                    opportunities.append(opp)

        # Dedupe by ticker — a market can match many whale signals / keywords.
        # Keep the highest-confidence instance of each.
        best_by_ticker: dict[str, CrossPlatformOpportunity] = {}
        for opp in opportunities:
            cur = best_by_ticker.get(opp.kalshi_ticker)
            if cur is None or opp.confidence > cur.confidence:
                best_by_ticker[opp.kalshi_ticker] = opp

        deduped = list(best_by_ticker.values())
        deduped.sort(key=lambda x: (x.confidence, x.edge_cents), reverse=True)
        return deduped

    def scan_once(self) -> list[CrossPlatformOpportunity]:
        """Run one full scan cycle.

        Paper-trading runs are routed to their own ledger/portfolio files for
        the duration of the cycle so they never mix with the real account's
        history, then the paths are restored — even if the cycle raises.
        """
        if not self.paper_trading:
            return self._scan_once_impl()
        prev_ledger = ledger.set_ledger_path(PAPER_LEDGER_PATH)
        prev_portfolio = portfolio_log.set_portfolio_path(PAPER_PORTFOLIO_PATH)
        try:
            return self._scan_once_impl()
        finally:
            ledger.set_ledger_path(prev_ledger)
            portfolio_log.set_portfolio_path(prev_portfolio)

    def _scan_once_impl(self) -> list[CrossPlatformOpportunity]:
        logger.info("=" * 60)
        logger.info("Starting scan cycle")
        logger.info("=" * 60)

        # 0. Account upkeep runs EVERY cycle regardless of whale-feed health —
        # balance, settlement, stop-loss, and portfolio tracking are all
        # read-only or protective and must not depend on whether we found any
        # new signal to trade on. Only "look for a NEW trade" is gated below.
        self.refresh_balance()
        self._ensure_day_state()
        settled = ledger.check_settlements(self.client)
        if settled:
            summ = ledger.summary()
            logger.info(
                f"Ledger: {summ['won']}W/{summ['lost']}L ({summ['win_rate']:.0%} WR), "
                f"realized {summ['realized_pnl_cents']:+d}c, {summ['open']} open"
            )

        exits = self.check_exits()
        if exits:
            logger.info(f"Take-profit/stop-loss triggered on {exits} position(s) this cycle")

        # Portfolio-growth tracking — the only metric that matters: is the
        # account value going up over time. Recorded every cycle, unconditionally.
        portfolio_log.record_snapshot(self._account_value_cents / 100, paper=self.paper_trading)

        # Whale feed health — a silently-expired Bullpen token is what made the
        # bot spend 133 cycles on internal spread-traps with no big money behind
        # any of it. Fail loudly, and say exactly how to fix it. This only gates
        # looking for NEW trades — everything above already ran.
        # Auth state is advisory, not the gate. The leaderboard/positions
        # endpoints this bot reads are public — they return real whale data
        # from a logged-out CLI — so refusing to trade on a bad token would
        # halt a feed that actually works. What matters is whether signals
        # arrive; auth is reported only to explain a feed that came up empty.
        auth_ok, auth_detail = check_bullpen_auth()
        logger.info(
            f"Whale feed auth: {'OK' if auth_ok else 'NOT LOGGED IN'} ({auth_detail})"
        )

        # 1. Collect opportunities from both signal sources.
        opportunities = self.collect_opportunities()

        if not opportunities and self.whale_only:
            logger.error("=" * 60)
            logger.error("WHALE FEED PRODUCED NOTHING this cycle.")
            n_cached = len(self._kalshi_markets_by_ticker)
            if not self._last_signals:
                if not auth_ok:
                    logger.error(f"Bullpen auth is unhealthy: {auth_detail}")
                    logger.error("Fix with:  bullpen login")
                else:
                    logger.error("Auth is fine — Bullpen returned 0 whale signals this cycle.")
            elif n_cached == 0:
                logger.error(
                    f"Got {len(self._last_signals)} whale signals, but the Kalshi market cache "
                    f"is empty — --max-hours-to-close/--min-market-volume filtered out everything. "
                    "Not an auth problem."
                )
            else:
                logger.error(
                    f"Got {len(self._last_signals)} whale signals and {n_cached} cached markets, "
                    "but none matched by keyword/outcome."
                )
            logger.error("=" * 60)

        # 2. Log results.
        if opportunities:
            logger.info(f"\nFound {len(opportunities)} opportunities:")
            for i, opp in enumerate(opportunities[:15], 1):
                conf10 = max(1, round(opp.confidence * 10))
                logger.info(
                    f"  {i}. [{opp.signal_type}] [{opp.edge_cents:+.1f}c edge] "
                    f"[confidence {conf10}/10] {opp.kalshi_title[:60]}"
                )
                logger.info(
                    f"     ask {opp.kalshi_yes_ask}c / bid {opp.kalshi_yes_bid}c"
                    + (f" | Poly {opp.polymarket_price:.0%}" if opp.polymarket_price else "")
                )
        else:
            logger.info("No opportunities above threshold")

        # 3. Guardrails + execution. Balance/exposure accounting runs in BOTH
        # modes so dry-run is a faithful, bounded simulation — only the actual
        # order placement and take-profit are live-only.
        if self._daily_loss_tripped():
            return opportunities

        # Simulated balance drains as we (hypothetically) spend this cycle.
        sim_balance = self._balance_cents
        exposure_cents = self._current_exposure_cents() if not self.dry_run else 0
        max_exposure = int(self._balance_cents * self.max_exposure_pct)
        placed = 0
        already_open_tickers = {r.get("ticker") for r in ledger.open_trades()}

        for opp in opportunities:
            if placed >= self.max_trades_per_cycle:
                logger.info(
                    f"Reached per-cycle trade cap ({self.max_trades_per_cycle}); "
                    f"stopping execution for this scan"
                )
                break
            if opp.kalshi_ticker in already_open_tickers:
                continue  # already hold this position — a persisting whale
                          # signal shouldn't re-buy it every cycle
            if opp.edge_cents < self.min_edge_cents:
                continue
            if opp.kalshi_yes_ask is None:
                continue
            if not (self.min_price_cents <= opp.kalshi_yes_ask <= self.max_price_cents):
                continue

            contracts = self._size_position(opp, sim_balance)
            if contracts < 1:
                continue
            cost_cents = int(opp.kalshi_yes_ask) * contracts

            if cost_cents > sim_balance:
                continue
            if exposure_cents + cost_cents > max_exposure:
                logger.info(
                    f"  Skipping {opp.kalshi_ticker}: would exceed exposure cap "
                    f"({self.max_exposure_pct:.0%} of balance)"
                )
                continue

            buy_client_id = str(uuid.uuid4())
            result = self.place_order(
                opp.kalshi_ticker, "bid", int(opp.kalshi_yes_ask), contracts,
                client_order_id=buy_client_id,
            )
            if not result:
                continue

            ledger.record_trade({
                "client_order_id": buy_client_id,
                "order_id": result.get("order_id"),
                "ticker": opp.kalshi_ticker,
                "title": opp.kalshi_title,
                "series": opp.series_ticker,
                "signal_type": opp.signal_type,
                "confidence": opp.confidence,
                "confidence_10": max(1, round(opp.confidence * 10)),
                "edge_cents": round(opp.edge_cents, 2),
                "entry_price_cents": int(opp.kalshi_yes_ask),
                "contracts": contracts,
                "cost_cents": cost_cents,
                "dry_run": self.dry_run,
                "paper": self.paper_trading,
            })

            # Accounting (both modes).
            sim_balance -= cost_cents
            exposure_cents += cost_cents
            placed += 1

            if not self.dry_run:
                self._balance_cents -= cost_cents
                self.place_take_profit(opp, buy_client_id, int(opp.kalshi_yes_ask), contracts)

        if placed:
            logger.info(
                f"{'[DRY RUN] ' if self.dry_run else ''}Acted on {placed} "
                f"opportunit{'y' if placed == 1 else 'ies'} this cycle"
            )
        return opportunities

    def run(self, interval_seconds: int = 300):
        """Run the bot continuously."""
        logger.info(f"Starting Smart Money Bot (interval: {interval_seconds}s)")
        logger.info(f"  Min trader PnL: ${self.min_trader_pnl:,.0f}")
        logger.info(f"  Min edge: {self.min_edge_cents}c")
        logger.info(f"  Max contracts: {self.max_contracts}")
        logger.info(f"  Take-profit: +{self.take_profit_pct:.0%} gross | Stop-loss: -{self.stop_loss_pct:.0%}")
        logger.info(f"  Whale-only: {self.whale_only}")
        logger.info(f"  Dry run: {self.dry_run}")
        if self.paper_trading:
            logger.info(f"  Paper trading: ${self.paper_start_cents / 100:.2f} simulated bankroll")
        logger.info("")

        while True:
            try:
                self.scan_once()
            except KeyboardInterrupt:
                logger.info("Bot stopped by user")
                break
            except Exception as e:
                logger.error(f"Scan cycle error: {e}", exc_info=True)

            logger.info(f"\nSleeping {interval_seconds}s until next scan...")
            try:
                time.sleep(interval_seconds)
            except KeyboardInterrupt:
                logger.info("Bot stopped by user")
                break
