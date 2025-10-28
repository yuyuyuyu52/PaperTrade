#!/usr/bin/env python3
"""Purge cached candles after a cutoff and re-fetch from Binance."""
from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.config import INSTRUMENTS, INTERVAL_SECONDS  # noqa: E402
from app.data_provider import _ensure_range  # noqa: E402
from app.storage import delete_after  # noqa: E402


def iter_symbols() -> Iterable[str]:
    for instrument in INSTRUMENTS:
        symbol = instrument.get("symbol") if isinstance(instrument, dict) else getattr(instrument, "symbol", None)
        if symbol:
            yield symbol


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Refresh candle cache after a cutoff timestamp (UTC).")
    parser.add_argument(
        "cutoff",
        help="Cutoff time in ISO format (e.g. 2025-10-29T03:30:00Z)",
    )
    return parser.parse_args()


def to_timestamp(value: str) -> int:
    normalized = value.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(normalized)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return int(dt.timestamp())


def delete_cached(symbol: str, cutoff_ts: int) -> None:
    for interval in INTERVAL_SECONDS.keys():
        delete_after(symbol, interval, cutoff_ts)


async def refetch(symbol: str, cutoff_ts: int) -> None:
    now_ts = int(datetime.now(tz=timezone.utc).timestamp())
    for interval, step in INTERVAL_SECONDS.items():
        await _ensure_range(symbol, interval, cutoff_ts, now_ts)


async def main() -> None:
    args = parse_args()
    cutoff_ts = to_timestamp(args.cutoff)

    for symbol in iter_symbols():
        delete_cached(symbol, cutoff_ts)

    await asyncio.gather(*(refetch(symbol, cutoff_ts) for symbol in iter_symbols()))


if __name__ == "__main__":
    asyncio.run(main())
