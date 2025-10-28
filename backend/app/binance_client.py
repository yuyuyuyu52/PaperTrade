from __future__ import annotations

from typing import Dict, List, Optional, Tuple

import httpx

from .config import resolve_binance_symbol

_BINANCE_API = "https://api.binance.com"
_MAX_LIMIT = 1000
_EARLIEST_CACHE: Dict[Tuple[str, str], int] = {}


async def _request_klines(
    symbol: str,
    interval: str,
    start_ts: Optional[int] = None,
    end_ts: Optional[int] = None,
    limit: int = _MAX_LIMIT,
) -> List[dict]:
    params: Dict[str, object] = {
        "symbol": resolve_binance_symbol(symbol),
        "interval": interval,
        "limit": min(limit, _MAX_LIMIT),
    }
    if start_ts is not None:
        params["startTime"] = int(start_ts) * 1000
    if end_ts is not None:
        params["endTime"] = int(end_ts) * 1000

    async with httpx.AsyncClient(base_url=_BINANCE_API, timeout=10.0) as client:
        response = await client.get("/api/v3/klines", params=params)
        response.raise_for_status()
        payload = response.json()

    candles: List[dict] = []
    for entry in payload:
        open_time_ms = int(entry[0])
        close_time_ms = int(entry[6])
        candles.append(
            {
                "time": open_time_ms // 1000,
                "close_time": close_time_ms // 1000,
                "open": float(entry[1]),
                "high": float(entry[2]),
                "low": float(entry[3]),
                "close": float(entry[4]),
                "volume": float(entry[5]),
            }
        )
    return candles


async def fetch_klines(
    symbol: str,
    interval: str,
    start_ts: Optional[int] = None,
    end_ts: Optional[int] = None,
    limit: int = _MAX_LIMIT,
) -> List[dict]:
    if start_ts is not None and end_ts is not None and start_ts > end_ts:
        return []

    candles = await _request_klines(symbol, interval, start_ts=start_ts, end_ts=end_ts, limit=limit)
    return candles


async def fetch_latest(symbol: str, interval: str, limit: int = 500) -> List[dict]:
    return await fetch_klines(symbol, interval, limit=limit)


async def fetch_earliest_open_time(symbol: str, interval: str) -> Optional[int]:
    key = (symbol.upper(), interval)
    if key in _EARLIEST_CACHE:
        return _EARLIEST_CACHE[key]

    candles = await fetch_klines(symbol, interval, start_ts=0, limit=1)
    if not candles:
        return None

    earliest = candles[0]["time"]
    _EARLIEST_CACHE[key] = earliest
    return earliest