"""Logging setup."""

import logging
import sys
from pathlib import Path


def setup_logging(log_dir: str = "data/logs", level: int = logging.INFO):
    Path(log_dir).mkdir(parents=True, exist_ok=True)

    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(fmt)

    file_handler = logging.FileHandler(f"{log_dir}/arb_bot.log")
    file_handler.setFormatter(fmt)

    root = logging.getLogger()
    root.setLevel(level)
    root.addHandler(console)
    root.addHandler(file_handler)

    # Quiet the per-request HTTP noise — it was the bulk of the log volume.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
