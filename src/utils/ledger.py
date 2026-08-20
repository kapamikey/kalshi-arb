"""Append-only trade ledger + settlement checking.

Every trading decision the bot acts on is written as one JSON line to
``data/trades.jsonl``. Later cycles reconcile ``open`` rows against Kalshi
settlement to record wins/losses, and the daily realized-loss total feeds the
loss-limit guardrail. This file is the source of truth a future analysis pass
reads to tune confidence scoring.
"""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from src.utils import supabase_sync

logger = logging.getLogger(__name__)

LEDGER_PATH = Path("data/trades.jsonl")


def set_ledger_path(path: Path) -> Path:
    """Swap the active ledger file (used to route paper-trading runs to their
    own file). Returns the previous path so callers can restore it."""
    global LEDGER_PATH
    prev = LEDGER_PATH
    LEDGER_PATH = path
    return prev

# status values a row can hold
OPEN = "open"          # buy placed / filled, market not yet settled
WON = "won"            # market settled in our favor
LOST = "lost"          # market settled against us
CLOSED = "closed"      # exited early via take-profit sell before settlement


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _utc_today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def record_trade(row: dict) -> dict:
    """Append one decision to the ledger and return the stored row.

    ``client_order_id`` is the stable key used to update the row later.
    """
    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    row = {
        "ts": _utc_now_iso(),
        "date": _utc_today(),
        "status": OPEN,
        "realized_pnl_cents": 0,
        "take_profit_order_id": None,
        **row,
    }
    with LEDGER_PATH.open("a") as f:
        f.write(json.dumps(row) + "\n")
    supabase_sync.upsert_trade(row)
    return row


def read_all() -> list[dict]:
    """Read every ledger row (skips blank/corrupt lines)."""
    if not LEDGER_PATH.exists():
        return []
    rows = []
    for line in LEDGER_PATH.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            logger.warning("Skipping corrupt ledger line: %.80s", line)
    return rows


def _rewrite(rows: list[dict]) -> None:
    """Rewrite the whole ledger (small scale — a few trades/day)."""
    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = LEDGER_PATH.with_suffix(".jsonl.tmp")
    with tmp.open("w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    tmp.replace(LEDGER_PATH)


def update_trade(client_order_id: str, updates: dict) -> bool:
    """Patch the row identified by ``client_order_id``. Returns True if found."""
    rows = read_all()
    found = False
    updated_row = None
    for r in rows:
        if r.get("client_order_id") == client_order_id:
            r.update(updates)
            found = True
            updated_row = r
    if found:
        _rewrite(rows)
        supabase_sync.upsert_trade(updated_row)
    return found


def open_trades() -> list[dict]:
    return [r for r in read_all() if r.get("status") == OPEN]


def daily_realized_loss_cents(date: str | None = None) -> int:
    """Sum of losses (positive number) realized on the given UTC date.

    Only negative realized PnL counts toward the loss limit; wins don't offset
    the daily circuit-breaker.
    """
    date = date or _utc_today()
    loss = 0
    for r in read_all():
        if r.get("date") != date:
            continue
        pnl = r.get("realized_pnl_cents", 0) or 0
        if pnl < 0:
            loss += -pnl
    return loss


def check_settlements(client) -> int:
    """Reconcile every open row against Kalshi settlement.

    For each open trade, fetch its market; if finalized, compute realized PnL
    (payout is $1.00/contract on a win, $0 on a loss, minus what we paid) and
    flip the row to won/lost. Returns the number of rows updated.
    """
    updated = 0
    for r in open_trades():
        ticker = r.get("ticker")
        if not ticker:
            continue
        try:
            resp = client.get_market(ticker)
            m = resp.get("market", resp)
        except Exception as e:
            logger.warning("Settlement check failed for %s: %s", ticker, e)
            continue

        status = m.get("status")
        result = m.get("result")
        if status not in ("finalized", "settled") or result in (None, "", "void"):
            continue

        entry_cents = int(r.get("entry_price_cents", 0) or 0)
        contracts = int(r.get("contracts", 0) or 0)
        # We always buy the YES side (bid). Win => each contract pays 100c.
        won = result == "yes"
        if won:
            pnl = (100 - entry_cents) * contracts
            new_status = WON
        else:
            pnl = -entry_cents * contracts
            new_status = LOST

        update_trade(r["client_order_id"], {
            "status": new_status,
            "realized_pnl_cents": pnl,
            "settled_ts": _utc_now_iso(),
            "settle_result": result,
        })
        updated += 1
        logger.info(
            "Settled %s: %s (%+dc realized)", ticker, new_status.upper(), pnl
        )
    return updated


def summary() -> dict:
    """Aggregate win/loss stats for logging."""
    rows = read_all()
    wins = [r for r in rows if r.get("status") == WON]
    losses = [r for r in rows if r.get("status") == LOST]
    total_pnl = sum(r.get("realized_pnl_cents", 0) or 0 for r in rows)
    settled = len(wins) + len(losses)
    return {
        "total": len(rows),
        "open": len([r for r in rows if r.get("status") == OPEN]),
        "won": len(wins),
        "lost": len(losses),
        "win_rate": (len(wins) / settled) if settled else 0.0,
        "realized_pnl_cents": total_pnl,
    }
