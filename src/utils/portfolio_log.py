"""Portfolio-growth tracking — the one metric that matters.

Every scan appends {timestamp, account_value_dollars} to data/portfolio.jsonl.
account_value is cash + open-position value, straight from Kalshi's own
/portfolio/balance — the same authoritative number pnl.py reports. This file
answers exactly one question: is the account growing over time.
"""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from src.utils import supabase_sync

logger = logging.getLogger(__name__)

PORTFOLIO_LOG = Path("data/portfolio.jsonl")


def set_portfolio_path(path: Path) -> Path:
    """Swap the active portfolio-log file (used to route paper-trading runs to
    their own file). Returns the previous path so callers can restore it."""
    global PORTFOLIO_LOG
    prev = PORTFOLIO_LOG
    PORTFOLIO_LOG = path
    return prev


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def record_snapshot(account_value_dollars: float, paper: bool = False) -> None:
    """Append one {ts, account_value} row. Cheap — call every scan cycle."""
    PORTFOLIO_LOG.parent.mkdir(parents=True, exist_ok=True)
    ts = _utc_now_iso()
    value = round(account_value_dollars, 4)
    with PORTFOLIO_LOG.open("a") as f:
        f.write(json.dumps({"ts": ts, "account_value": value}) + "\n")
    supabase_sync.insert_portfolio_snapshot(ts, value, paper=paper)


def read_all() -> list[dict]:
    if not PORTFOLIO_LOG.exists():
        return []
    rows = []
    for line in PORTFOLIO_LOG.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            logger.warning("Skipping corrupt portfolio-log line: %.80s", line)
    return rows


def growth_summary() -> dict | None:
    """First-ever snapshot vs the latest one. None if no history yet."""
    rows = read_all()
    if not rows:
        return None
    first, last = rows[0], rows[-1]
    delta = last["account_value"] - first["account_value"]
    pct = (delta / first["account_value"] * 100) if first["account_value"] else 0.0
    return {
        "first_ts": first["ts"],
        "first_value": first["account_value"],
        "last_ts": last["ts"],
        "last_value": last["account_value"],
        "delta": delta,
        "pct": pct,
        "n_snapshots": len(rows),
    }
