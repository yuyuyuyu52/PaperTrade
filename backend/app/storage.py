import sqlite3
from typing import Iterable, List, Optional, Tuple

from .config import DATA_DIR, INTERVAL_SECONDS

DB_PATH = DATA_DIR / "candles.db"

def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS candles (
                symbol TEXT NOT NULL,
                interval TEXT NOT NULL,
                open_time INTEGER NOT NULL,
                close_time INTEGER NOT NULL,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                volume REAL NOT NULL,
                PRIMARY KEY (symbol, interval, open_time)
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_candles_symbol_interval_time
            ON candles(symbol, interval, open_time)
            """
        )


def save_candles(symbol: str, interval: str, candles: Iterable[dict]) -> None:
    step = INTERVAL_SECONDS[interval]
    filtered_rows = []
    upper_symbol = symbol.upper()

    for candle in candles:
        open_time = int(candle["time"])
        close_time = int(candle.get("close_time", open_time))
        # Binance sends in-progress candles with close_time < open_time + step - 1.
        if close_time < open_time + step - 1:
            continue

        filtered_rows.append(
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

    if not filtered_rows:
        return

    with _connect() as conn:
        conn.executemany(
            """
            INSERT INTO candles (
                symbol, interval, open_time, close_time, open, high, low, close, volume
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol, interval, open_time) DO UPDATE SET
                close_time = excluded.close_time,
                open = excluded.open,
                high = excluded.high,
                low = excluded.low,
                close = excluded.close,
                volume = excluded.volume
            """,
            filtered_rows,
        )
        conn.commit()


def fetch_candles(
    symbol: str,
    interval: str,
    start_ts: Optional[int],
    end_ts: Optional[int],
    limit: Optional[int] = None,
) -> List[dict]:
    conditions = []
    params: List[object] = [symbol.upper(), interval]
    if start_ts is not None:
        conditions.append("open_time >= ?")
        params.append(start_ts)
    if end_ts is not None:
        conditions.append("open_time <= ?")
        params.append(end_ts)

    query = (
        "SELECT open_time, close_time, open, high, low, close, volume\n"
        "FROM candles\n"
        "WHERE symbol = ? AND interval = ?"
    )
    if conditions:
        query += " AND " + " AND ".join(conditions)

    query += " ORDER BY open_time ASC"
    if limit is not None:
        query += " LIMIT ?"
        params.append(limit)

    with _connect() as conn:
        rows = conn.execute(query, params).fetchall()

    candles: List[dict] = []
    for row in rows:
        candles.append(
            {
                "time": int(row["open_time"]),
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

    step = INTERVAL_SECONDS[interval]
    min_span = step - 1
    filtered: List[dict] = []
    for idx, candle in enumerate(candles):
        complete = candle["close_time"] >= candle["time"] + min_span
        if complete or idx == len(candles) - 1:
            filtered.append(candle)
    return filtered


def fetch_after(symbol: str, interval: str, after_ts: int) -> List[dict]:
    step = INTERVAL_SECONDS[interval]
    start_ts = after_ts + step
    return fetch_candles(symbol, interval, start_ts, None, None)


def get_latest_open_time(symbol: str, interval: str) -> Optional[int]:
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT open_time FROM candles
            WHERE symbol = ? AND interval = ?
            ORDER BY open_time DESC
            LIMIT 1
            """,
            (symbol.upper(), interval),
        ).fetchone()
    return int(row["open_time"]) if row else None


def get_time_range(symbol: str, interval: str) -> Tuple[Optional[int], Optional[int]]:
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT MIN(open_time) AS min_time, MAX(open_time) AS max_time
            FROM candles
            WHERE symbol = ? AND interval = ?
            """,
            (symbol.upper(), interval),
        ).fetchone()
    if row is None:
        return None, None
    min_time = row["min_time"]
    max_time = row["max_time"]
    return (int(min_time) if min_time is not None else None, int(max_time) if max_time is not None else None)


def _fetch_open_times(symbol: str, interval: str, start_ts: int, end_ts: int) -> List[Tuple[int, int]]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT open_time, close_time FROM candles
            WHERE symbol = ? AND interval = ? AND open_time BETWEEN ? AND ?
            ORDER BY open_time ASC
            """,
            (symbol.upper(), interval, start_ts, end_ts),
        ).fetchall()
    return [(int(row["open_time"]), int(row["close_time"])) for row in rows]


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
        conn.execute(
            "DELETE FROM candles WHERE symbol = ? AND interval = ? AND open_time < ?",
            (symbol.upper(), interval, keep_start_ts),
        )
        conn.commit()


def delete_after(symbol: str, interval: str, cutoff_ts: int) -> None:
    with _connect() as conn:
        conn.execute(
            "DELETE FROM candles WHERE symbol = ? AND interval = ? AND open_time >= ?",
            (symbol.upper(), interval, cutoff_ts),
        )
        conn.commit()


# Initialize database when module is imported.
init_db()
