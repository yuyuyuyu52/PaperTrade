"""PostgreSQL/TimescaleDB storage for candle data."""
from __future__ import annotations

import os
from typing import Iterable, List, Optional, Tuple

import psycopg2
from psycopg2.extras import RealDictCursor, execute_values

from .config import INTERVAL_SECONDS


def _connect():
    """Create a PostgreSQL connection using DATABASE_URL or PG* env vars."""
    url = os.getenv("DATABASE_URL")
    if url:
        conn = psycopg2.connect(url)
    else:
        conn = psycopg2.connect(
            host=os.getenv("PGHOST", "127.0.0.1"),
            port=os.getenv("PGPORT", "5432"),
            user=os.getenv("PGUSER", "postgres"),
            password=os.getenv("PGPASSWORD", ""),
            dbname=os.getenv("PGDATABASE", "papertrade"),
        )
    conn.autocommit = True
    return conn


def init_db() -> None:
    """Initialize candles table and (optionally) Timescale hypertable."""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS candles (
                    symbol TEXT NOT NULL,
                    interval TEXT NOT NULL,
                    open_time BIGINT NOT NULL,
                    close_time BIGINT NOT NULL,
                    open DOUBLE PRECISION NOT NULL,
                    high DOUBLE PRECISION NOT NULL,
                    low DOUBLE PRECISION NOT NULL,
                    close DOUBLE PRECISION NOT NULL,
                    volume DOUBLE PRECISION NOT NULL,
                    PRIMARY KEY (symbol, interval, open_time)
                )
                """
            )
            # Try to enable TimescaleDB features if available; ignore on failure
            try:
                cur.execute("CREATE EXTENSION IF NOT EXISTS timescaledb")
                cur.execute("SELECT create_hypertable('candles', 'open_time', if_not_exists => TRUE)")
            except Exception:
                pass


def save_candles(symbol: str, interval: str, candles: Iterable[dict]) -> None:
    step = INTERVAL_SECONDS[interval]
    upper_symbol = symbol.upper()

    rows = []
    for candle in candles:
        open_time = int(candle["time"])  # seconds
        close_time = int(candle.get("close_time", open_time))
        # Skip in-progress candles (close_time not at least open_time+step-1)
        if close_time < open_time + step - 1:
            continue
        rows.append(
            (
                upper_symbol,
                interval,
                open_time,
                close_time,
                float(candle["open"]),
                float(candle["high"]),
                float(candle["low"]),
                float(candle["close"]),
                float(candle["volume"]),
            )
        )

    if not rows:
        return

    with _connect() as conn:
        with conn.cursor() as cur:
            execute_values(
                cur,
                """
                INSERT INTO candles (
                    symbol, interval, open_time, close_time, open, high, low, close, volume
                ) VALUES %s
                ON CONFLICT (symbol, interval, open_time) DO UPDATE SET
                    close_time = EXCLUDED.close_time,
                    open = EXCLUDED.open,
                    high = EXCLUDED.high,
                    low = EXCLUDED.low,
                    close = EXCLUDED.close,
                    volume = EXCLUDED.volume
                """,
                rows,
            )


def fetch_candles(
    symbol: str,
    interval: str,
    start_ts: Optional[int],
    end_ts: Optional[int],
    limit: Optional[int] = None,
) -> List[dict]:
    conditions: List[str] = []
    params: List[object] = [symbol.upper(), interval]
    if start_ts is not None:
        conditions.append("open_time >= %s")
        params.append(int(start_ts))
    if end_ts is not None:
        conditions.append("open_time <= %s")
        params.append(int(end_ts))

    query = (
        "SELECT open_time AS time, close_time, open, high, low, close, volume "
        "FROM candles WHERE symbol = %s AND interval = %s"
    )
    if conditions:
        query += " AND " + " AND ".join(conditions)
    query += " ORDER BY open_time ASC"
    if limit is not None:
        query += " LIMIT %s"
        params.append(int(limit))

    with _connect() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(query, params)
            rows = cur.fetchall()

    candles: List[dict] = []
    for row in rows:
        candles.append(
            {
                "time": int(row["time"]),
                "close_time": int(row["close_time"]),
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": float(row["volume"]),
            }
        )

    if not candles:
        return candles

    # Ensure only complete candles are returned, except possibly last one
    step = INTERVAL_SECONDS[interval]
    min_span = step - 1
    filtered: List[dict] = []
    for idx, c in enumerate(candles):
        complete = c["close_time"] >= c["time"] + min_span
        if complete or idx == len(candles) - 1:
            filtered.append(c)
    return filtered


def fetch_after(symbol: str, interval: str, after_ts: int) -> List[dict]:
    step = INTERVAL_SECONDS[interval]
    start_ts = int(after_ts) + step
    return fetch_candles(symbol, interval, start_ts, None, None)


def get_latest_open_time(symbol: str, interval: str) -> Optional[int]:
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT open_time FROM candles
                WHERE symbol = %s AND interval = %s
                ORDER BY open_time DESC
                LIMIT 1
                """,
                (symbol.upper(), interval),
            )
            row = cur.fetchone()
            return int(row[0]) if row else None


def get_time_range(symbol: str, interval: str) -> Tuple[Optional[int], Optional[int]]:
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT MIN(open_time) AS min_time, MAX(open_time) AS max_time
                FROM candles
                WHERE symbol = %s AND interval = %s
                """,
                (symbol.upper(), interval),
            )
            row = cur.fetchone()
            if not row:
                return None, None
            min_time, max_time = row
            return (
                int(min_time) if min_time is not None else None,
                int(max_time) if max_time is not None else None,
            )


def _fetch_open_times(symbol: str, interval: str, start_ts: int, end_ts: int) -> List[Tuple[int, int]]:
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT open_time, close_time FROM candles
                WHERE symbol = %s AND interval = %s AND open_time BETWEEN %s AND %s
                ORDER BY open_time ASC
                """,
                (symbol.upper(), interval, int(start_ts), int(end_ts)),
            )
            rows = cur.fetchall()
            return [(int(r[0]), int(r[1])) for r in rows]


def find_missing_segment(symbol: str, interval: str, start_ts: int, end_ts: int) -> Optional[Tuple[int, int]]:
    if start_ts > end_ts:
        return None

    step = INTERVAL_SECONDS[interval]
    expected = start_ts
    open_times = _fetch_open_times(symbol, interval, start_ts, end_ts)

    for open_time, close_time in open_times:
        if open_time > expected:
            missing_end = min(open_time - step, end_ts)
            if missing_end >= expected:
                return expected, missing_end
        min_required_close = open_time + step - 1
        if close_time < min_required_close and open_time < end_ts:
            return open_time, min(open_time, end_ts)
        expected = open_time + step

    if expected <= end_ts:
        return expected, end_ts
    return None


def delete_older_than(symbol: str, interval: str, keep_start_ts: int) -> None:
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM candles WHERE symbol = %s AND interval = %s AND open_time < %s",
                (symbol.upper(), interval, int(keep_start_ts)),
            )


def delete_after(symbol: str, interval: str, cutoff_ts: int) -> None:
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM candles WHERE symbol = %s AND interval = %s AND open_time >= %s",
                (symbol.upper(), interval, int(cutoff_ts)),
            )


# Initialize DB on import, matching previous behavior
init_db()
