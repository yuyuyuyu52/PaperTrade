from __future__ import annotations

import asyncio
from asyncio import QueueEmpty
import json
import logging
from datetime import datetime, timezone
from typing import AsyncGenerator, Dict, List, Optional, Set, Tuple

from starlette.concurrency import run_in_threadpool
import websockets
from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK

from .binance_client import fetch_earliest_open_time, fetch_klines
from .config import INSTRUMENTS, INTERVAL_SECONDS, Instrument, resolve_binance_symbol
from .storage import (
    fetch_after as storage_fetch_after,
    fetch_candles as storage_fetch_candles,
    find_missing_segment,
    get_latest_open_time,
    get_time_range,
    save_candles,
)

UTC = timezone.utc
MAX_REMOTE_BATCH = 1000
BINANCE_WS_URL = "wss://stream.binance.com:9443/ws"

logger = logging.getLogger(__name__)


class _StreamState:
    __slots__ = (
        "symbol",
        "interval",
        "binance_symbol",
        "task",
        "task_lock",
        "subscribers",
        "sub_lock",
        "latest_time",
    )

    def __init__(self, symbol: str, interval: str) -> None:
        self.symbol = symbol
        self.interval = interval
        self.binance_symbol = resolve_binance_symbol(symbol)
        self.task: Optional[asyncio.Task[None]] = None
        self.task_lock = asyncio.Lock()
        self.subscribers: Set[asyncio.Queue[dict]] = set()
        self.sub_lock = asyncio.Lock()
        self.latest_time: Optional[int] = None

    async def ensure_task(self) -> None:
        async with self.task_lock:
            if self.task is None or self.task.done():
                self.task = asyncio.create_task(self._run(), name=f"binance-stream-{self.symbol}-{self.interval}")

    async def _run(self) -> None:
        backoff = 1.0
        step = INTERVAL_SECONDS[self.interval]
        while True:
            try:
                self.latest_time = await _ensure_latest(self.symbol, self.interval)
                if self.latest_time is None:
                    self.latest_time = _align_timestamp(int(datetime.now(tz=UTC).timestamp()), step)

                # Drain any stored candles after latest_time (e.g., produced while no stream running)
                pending = await run_in_threadpool(storage_fetch_after, self.symbol, self.interval, self.latest_time)
                for candle in pending:
                    self.latest_time = candle["time"]
                    await _broadcast(self, {"candle": candle, "final": True})

                stream_url = f"{BINANCE_WS_URL}/{self.binance_symbol.lower()}@kline_{self.interval}"
                async with websockets.connect(stream_url, ping_interval=20, ping_timeout=20) as ws:
                    logger.info("Connected Binance stream %s %s", self.symbol, self.interval)
                    backoff = 1.0
                    async for message in ws:
                        await self._handle_message(message)
            except asyncio.CancelledError:
                logger.info("Binance stream cancelled for %s %s", self.symbol, self.interval)
                raise
            except (ConnectionClosedError, ConnectionClosedOK):
                logger.warning("Binance stream closed for %s %s", self.symbol, self.interval)
            except Exception as exc:  # pylint: disable=broad-except
                logger.exception("Binance stream error for %s %s", self.symbol, self.interval)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2.0, 30.0)
            else:
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2.0, 30.0)

    async def _handle_message(self, message: str) -> None:
        try:
            payload = json.loads(message)
        except json.JSONDecodeError:
            logger.debug("Skipping non-JSON message from Binance stream")
            return

        kline = payload.get("k")
        if not kline:
            return

        candle = {
            "time": int(kline["t"]) // 1000,
            "close_time": int(kline["T"]) // 1000,
            "open": float(kline["o"]),
            "high": float(kline["h"]),
            "low": float(kline["l"]),
            "close": float(kline["c"]),
            "volume": float(kline["v"]),
        }

        step = INTERVAL_SECONDS[self.interval]
        open_time = candle["time"]

        is_final = bool(kline.get("x"))

        if not is_final:
            latest_time = self.latest_time
            if latest_time is None or open_time >= latest_time:
                await _broadcast(self, {"candle": candle, "final": False})
            return

        latest_time = self.latest_time
        if latest_time is not None and open_time <= latest_time:
            return

        if latest_time is not None and open_time > latest_time + step:
            await _ensure_range(self.symbol, self.interval, latest_time + step, open_time)
            missing = await run_in_threadpool(storage_fetch_after, self.symbol, self.interval, latest_time)
            for existing in missing:
                ts = existing["time"]
                if ts <= latest_time or ts >= open_time:
                    continue
                self.latest_time = ts
                await _broadcast(self, {"candle": existing, "final": True})
            latest_time = self.latest_time
            if latest_time is not None and open_time <= latest_time:
                return

        await run_in_threadpool(save_candles, self.symbol, self.interval, [candle])
        self.latest_time = open_time
        await _broadcast(self, {"candle": candle, "final": True})


_STREAMS: Dict[Tuple[str, str], _StreamState] = {}
_STREAMS_LOCK = asyncio.Lock()


async def _broadcast(state: _StreamState, candle: dict) -> None:
    async with state.sub_lock:
        if not state.subscribers:
            return
        subscribers = list(state.subscribers)

    to_remove: List[asyncio.Queue[dict]] = []
    for queue in subscribers:
        try:
            queue.put_nowait(candle)
        except asyncio.QueueFull:
            try:
                queue.get_nowait()
            except QueueEmpty:
                pass
            try:
                queue.put_nowait(candle)
            except asyncio.QueueFull:
                to_remove.append(queue)

    if to_remove:
        async with state.sub_lock:
            for queue in to_remove:
                state.subscribers.discard(queue)


async def _get_stream_state(symbol: str, interval: str) -> _StreamState:
    symbol = symbol.upper()
    async with _STREAMS_LOCK:
        state = _STREAMS.get((symbol, interval))
        if state is None:
            state = _StreamState(symbol, interval)
            _STREAMS[(symbol, interval)] = state
    await state.ensure_task()
    return state


async def _subscribe_stream(symbol: str, interval: str) -> Tuple[_StreamState, asyncio.Queue[dict]]:
    state = await _get_stream_state(symbol, interval)
    queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=512)
    async with state.sub_lock:
        state.subscribers.add(queue)
    return state, queue


async def _unsubscribe_stream(state: _StreamState, queue: asyncio.Queue[dict]) -> None:
    async with state.sub_lock:
        state.subscribers.discard(queue)


def list_instruments() -> List[Instrument]:
    return INSTRUMENTS


def _align_timestamp(ts: int, step: int) -> int:
    if ts < 0:
        return 0
    return (ts // step) * step


def _find_invalid_candle_times(candles: List[dict], step: int) -> List[int]:
    invalid: List[int] = []
    if not candles:
        return invalid

    min_span = step - 1
    last_index = len(candles) - 1

    for idx, candle in enumerate(candles):
        if idx == last_index:
            # Allow the very latest candle to be incomplete; realtime data will fill it later.
            continue

        open_time = int(candle.get("time", 0))
        close_time = int(candle.get("close_time", 0))
        open_price = float(candle.get("open", 0.0))
        high_price = float(candle.get("high", 0.0))
        low_price = float(candle.get("low", 0.0))
        close_price = float(candle.get("close", 0.0))

        if close_time < open_time + min_span:
            invalid.append(open_time)
            continue

        if high_price < low_price:
            invalid.append(open_time)
            continue

        if not (low_price <= open_price <= high_price) or not (low_price <= close_price <= high_price):
            invalid.append(open_time)
            continue

    return invalid


async def _ensure_range(symbol: str, interval: str, start_ts: int, end_ts: int) -> None:
    if start_ts > end_ts:
        return

    step = INTERVAL_SECONDS[interval]
    start_ts = _align_timestamp(start_ts, step)
    end_ts = _align_timestamp(end_ts, step)
    now_ts = _align_timestamp(int(datetime.now(tz=UTC).timestamp()), step)
    max_closed_ts = max(0, now_ts - step)
    effective_end = min(end_ts, max_closed_ts)

    if start_ts > effective_end:
        return

    current_start = start_ts

    while current_start <= effective_end:
        missing = await run_in_threadpool(find_missing_segment, symbol, interval, current_start, effective_end)
        if not missing:
            break

        missing_start, missing_end = missing
        fetch_start = missing_start

        while fetch_start <= missing_end:
            batch = await fetch_klines(
                symbol,
                interval,
                start_ts=fetch_start,
                end_ts=missing_end,
                limit=MAX_REMOTE_BATCH,
            )
            if not batch:
                return

            await run_in_threadpool(save_candles, symbol, interval, batch)

            last_time = batch[-1]["time"]
            if last_time >= missing_end:
                break

            fetch_start = last_time + step
            await asyncio.sleep(0)

        current_start = missing_end + step
        await asyncio.sleep(0)


async def _ensure_latest(symbol: str, interval: str) -> Optional[int]:
    step = INTERVAL_SECONDS[interval]
    now_ts = _align_timestamp(int(datetime.now(tz=UTC).timestamp()), step)
    latest = await run_in_threadpool(get_latest_open_time, symbol, interval)

    if latest is None:
        window_start = max(0, now_ts - step * (MAX_REMOTE_BATCH - 1))
        await _ensure_range(symbol, interval, window_start, now_ts)
        latest = await run_in_threadpool(get_latest_open_time, symbol, interval)
        return latest

    if latest < now_ts:
        await _ensure_range(symbol, interval, latest + step, now_ts)
        latest = await run_in_threadpool(get_latest_open_time, symbol, interval)

    return latest


async def fetch_candles(
    symbol: str,
    interval: str,
    start_ts: Optional[int] = None,
    end_ts: Optional[int] = None,
    limit: Optional[int] = None,
) -> List[dict]:
    step = INTERVAL_SECONDS[interval]
    now_ts = _align_timestamp(int(datetime.now(tz=UTC).timestamp()), step)
    if end_ts is None or end_ts > now_ts:
        end_ts = now_ts
    else:
        end_ts = _align_timestamp(end_ts, step)

    if start_ts is None:
        size = (limit or 500) - 1
        size = max(size, 0)
        start_ts = max(0, end_ts - step * size)
    else:
        start_ts = _align_timestamp(start_ts, step)
        if start_ts > end_ts:
            start_ts, end_ts = end_ts, start_ts

    if limit is not None:
        max_span = step * max(limit - 1, 0)
        start_ts = max(start_ts, end_ts - max_span)

    await _ensure_range(symbol, interval, start_ts, end_ts)
    candles = await run_in_threadpool(
        storage_fetch_candles, symbol, interval, start_ts, end_ts, limit
    )

    repaired = False
    invalid_times = _find_invalid_candle_times(candles, step)
    while invalid_times and not repaired:
        repaired = True
        repair_start = _align_timestamp(min(invalid_times), step)
        repair_end = _align_timestamp(max(invalid_times), step)
        await _ensure_range(symbol, interval, repair_start, repair_end)
        candles = await run_in_threadpool(
            storage_fetch_candles, symbol, interval, start_ts, end_ts, limit
        )
        invalid_times = _find_invalid_candle_times(candles, step)

    return candles


async def available_time_range(symbol: str, interval: str) -> Tuple[datetime, datetime]:
    step = INTERVAL_SECONDS[interval]
    latest = await _ensure_latest(symbol, interval)
    if latest is None:
        latest = _align_timestamp(int(datetime.now(tz=UTC).timestamp()), step)

    earliest, cached_latest = await run_in_threadpool(get_time_range, symbol, interval)
    if cached_latest is not None:
        latest = max(latest, cached_latest)

    if earliest is None:
        earliest = await fetch_earliest_open_time(symbol, interval)
    if earliest is None:
        earliest = latest

    earliest_dt = datetime.fromtimestamp(earliest, tz=UTC)
    latest_dt = datetime.fromtimestamp(latest, tz=UTC)
    return earliest_dt, latest_dt


async def iter_future_candles(symbol: str, interval: str) -> AsyncGenerator[dict, None]:
    step = INTERVAL_SECONDS[interval]
    last_time = await _ensure_latest(symbol, interval)
    if last_time is None:
        last_time = _align_timestamp(int(datetime.now(tz=UTC).timestamp()), step)

    last_final_time = last_time

    pending = await run_in_threadpool(storage_fetch_after, symbol, interval, last_final_time)
    for candle in pending:
        ts = candle["time"]
        if ts <= last_final_time:
            continue
        last_final_time = ts
        yield {"candle": candle, "final": True}

    state, queue = await _subscribe_stream(symbol, interval)
    try:
        extra = await run_in_threadpool(storage_fetch_after, symbol, interval, last_final_time)
        for candle in extra:
            ts = candle["time"]
            if ts <= last_final_time:
                continue
            last_final_time = ts
            yield {"candle": candle, "final": True}

        while True:
            try:
                payload = queue.get_nowait()
            except QueueEmpty:
                payload = await queue.get()

            candle = payload.get("candle")
            if not candle:
                continue

            final = bool(payload.get("final", True))
            ts = candle.get("time")
            if ts is None:
                continue

            if final:
                if ts <= last_final_time:
                    continue
                last_final_time = ts
            else:
                if ts < last_final_time:
                    continue

            yield {"candle": candle, "final": final}
    finally:
        await _unsubscribe_stream(state, queue)