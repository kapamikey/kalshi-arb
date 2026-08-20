"""Best-effort mirror of the local JSONL ledger into Supabase.

JSONL (data/trades.jsonl, data/portfolio.jsonl) stays the source of truth the
bot reads from at runtime — this module only pushes copies to Supabase so the
data is queryable (dashboards, SQL) without touching flat files over SSH.
Every call is wrapped so a Supabase outage never breaks a scan cycle.
"""

import logging
import os

logger = logging.getLogger(__name__)

_client = None
_tried_init = False


def _get_client():
    global _client, _tried_init
    if _tried_init:
        return _client
    _tried_init = True

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SECRET_KEY")
    if not url or not key:
        logger.debug("Supabase sync disabled: SUPABASE_URL/SUPABASE_SECRET_KEY not set")
        return None
    try:
        from supabase import create_client
        _client = create_client(url, key)
    except Exception as e:
        logger.warning("Supabase client init failed, sync disabled: %s", e)
        _client = None
    return _client


def upsert_trade(row: dict) -> None:
    client = _get_client()
    if client is None:
        return
    try:
        client.table("trades").upsert(row, on_conflict="client_order_id").execute()
    except Exception as e:
        logger.warning("Supabase trade sync failed for %s: %s", row.get("client_order_id"), e)


def insert_portfolio_snapshot(ts: str, account_value: float) -> None:
    client = _get_client()
    if client is None:
        return
    try:
        client.table("portfolio_snapshots").insert({
            "ts": ts,
            "account_value": account_value,
        }).execute()
    except Exception as e:
        logger.warning("Supabase portfolio snapshot sync failed: %s", e)
