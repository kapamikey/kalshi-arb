"""
Polymarket data client.

UNVERIFIED AGAINST THE LIVE API. Every Polymarket host is blocked by the agent
container's egress proxy (gamma-api, data-api, clob, goldsky all returned
HTTP 000), so the endpoint paths and field names below are written from the
documented API shape and have never been exercised against a real response.

Expect to fix field names on first run. The parts most likely to be wrong are
marked FIELD. The study itself (`edge.py`) is independent of this file and is
validated against synthetic data, so a break here is a parsing fix, not a
methodology problem.

Cache to disk on the first successful pull — these endpoints paginate slowly and
you do not want to re-fetch while iterating on the analysis.
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

DATA_API = "https://data-api.polymarket.com"
GAMMA_API = "https://gamma-api.polymarket.com"

USER_AGENT = "kalshi-arb-research/1.0"


class EgressBlocked(RuntimeError):
    """The network policy refused the host. Retrying will never help."""


def _get(url, params, retries=3):
    q = f"{url}?{urllib.parse.urlencode(params)}"
    host = urllib.parse.urlparse(url).netloc

    for attempt in range(retries):
        try:
            req = urllib.request.Request(q, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.URLError as e:
            # A proxy 403/407 is a policy denial, not a transient failure.
            # Retrying it burns the backoff budget and buries the real cause
            # under a urllib traceback, so surface it immediately and plainly.
            detail = str(getattr(e, "reason", e))
            if "403" in detail or "407" in detail or "Tunnel connection failed" in detail:
                raise EgressBlocked(
                    f"{host} is blocked by the network egress policy ({detail}). "
                    "Run this where the host is reachable, or fetch the data "
                    "elsewhere and load the JSON dump instead."
                ) from None
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)


def fetch_trades(limit=500, max_pages=200, cache="analysis/cache/trades.json"):
    """
    Paginated trade history.

    FIELD: response is expected to be a list of objects carrying
    proxyWallet, conditionId, outcome, side, price, size, timestamp.
    """
    if cache and os.path.exists(cache):
        with open(cache) as f:
            return json.load(f)

    out, offset = [], 0
    for _ in range(max_pages):
        batch = _get(f"{DATA_API}/trades", {"limit": limit, "offset": offset})
        if not batch:
            break
        out.extend(batch)
        offset += limit

    if cache:
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        with open(cache, "w") as f:
            json.dump(out, f)
    return out


def fetch_resolved_markets(limit=500, max_pages=200, cache="analysis/cache/markets.json"):
    """
    Closed markets and their outcomes.

    FIELD: `outcomes` and `outcomePrices` come back as JSON-encoded STRINGS on
    this endpoint, not arrays. A resolved market has outcomePrices of "1"/"0".
    """
    if cache and os.path.exists(cache):
        with open(cache) as f:
            return json.load(f)

    out, offset = [], 0
    for _ in range(max_pages):
        batch = _get(
            f"{GAMMA_API}/markets",
            {"closed": "true", "limit": limit, "offset": offset},
        )
        if not batch:
            break
        out.extend(batch)
        offset += limit

    if cache:
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        with open(cache, "w") as f:
            json.dump(out, f)
    return out


def _maybe_json(v):
    """outcomes/outcomePrices arrive as JSON strings on some endpoints."""
    if isinstance(v, str):
        try:
            return json.loads(v)
        except json.JSONDecodeError:
            return [v]
    return v or []


def to_trades(raw):
    """Map API trades into edge.py's tuple format."""
    out = []
    for t in raw:
        try:
            out.append((
                t["proxyWallet"],
                t["conditionId"],
                str(t["outcome"]),
                str(t["side"]).upper(),
                float(t["price"]),
                float(t["size"]),
                int(t["timestamp"]),
            ))
        except (KeyError, TypeError, ValueError):
            continue  # skip malformed rows rather than abort a long pull
    return out


def to_resolutions(raw_markets):
    """
    {(conditionId, outcome): 1.0 | 0.0} for resolved markets only.

    A market whose prices aren't a clean 1/0 is not settled — excluded, since
    counting an unsettled market as a loss would fabricate P&L.
    """
    res = {}
    for m in raw_markets:
        cid = m.get("conditionId")
        outcomes = _maybe_json(m.get("outcomes"))
        prices = _maybe_json(m.get("outcomePrices"))
        if not cid or len(outcomes) != len(prices):
            continue
        vals = []
        for p in prices:
            try:
                vals.append(float(p))
            except (TypeError, ValueError):
                vals.append(None)
        if any(v is None for v in vals) or not any(v == 1.0 for v in vals):
            continue
        for outcome, v in zip(outcomes, vals):
            res[(cid, str(outcome))] = v
    return res
