from datetime import datetime, timezone
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .config import INTERVAL_MINUTES
from .data_provider import (
    available_time_range,
    fetch_candles,
    iter_future_candles,
    list_instruments,
)
from .schemas import Candle, CandleResponse, InstrumentResponse, TimeRangeResponse

app = FastAPI(title="TradingView Clone API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"]
    ,
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "timestamp": datetime.utcnow().isoformat()}


@app.get("/api/instruments", response_model=List[InstrumentResponse])
def get_instruments() -> List[InstrumentResponse]:
    instruments = list_instruments()
    return [InstrumentResponse(symbol=i.symbol, name=i.name) for i in instruments]


@app.get("/api/candles", response_model=CandleResponse)
async def get_candles(
    symbol: str = Query(..., description="Instrument symbol", min_length=1),
    interval: str = Query(..., description="Candle interval e.g. 1m"),
    start: Optional[int] = Query(None, description="Start timestamp in seconds"),
    end: Optional[int] = Query(None, description="End timestamp in seconds"),
    limit: Optional[int] = Query(500, ge=1, le=5000, description="Maximum number of candles"),
) -> CandleResponse:
    interval = interval.lower()
    if interval not in INTERVAL_MINUTES:
        raise HTTPException(status_code=400, detail=f"Unsupported interval: {interval}")

    candles_raw = await fetch_candles(
        symbol=symbol,
        interval=interval,
        start_ts=start,
        end_ts=end,
        limit=limit,
    )
    if not candles_raw:
        raise HTTPException(status_code=404, detail="No candles found")

    candles = [Candle(**candle) for candle in candles_raw]
    start_time = datetime.fromtimestamp(candles_raw[0]["time"], tz=timezone.utc)
    end_time = datetime.fromtimestamp(candles_raw[-1]["time"], tz=timezone.utc)

    return CandleResponse(candles=candles, start=start_time, end=end_time)


@app.get("/api/candles/range", response_model=TimeRangeResponse)
async def get_candles_range(
    symbol: str = Query(..., min_length=1),
    interval: str = Query(..., description="Candle interval e.g. 1m"),
) -> TimeRangeResponse:
    interval = interval.lower()
    if interval not in INTERVAL_MINUTES:
        raise HTTPException(status_code=400, detail=f"Unsupported interval: {interval}")

    earliest, latest = await available_time_range(symbol, interval)
    return TimeRangeResponse(earliest=earliest, latest=latest)


def _validate_symbol(symbol: str) -> str:
    uppercase = symbol.upper()
    symbols = {instrument.symbol for instrument in list_instruments()}
    if uppercase not in symbols:
        raise HTTPException(status_code=400, detail=f"Unsupported symbol: {symbol}")
    return uppercase


@app.websocket("/ws/candles")
async def stream_candles(websocket: WebSocket, symbol: str, interval: str) -> None:
    try:
        uppercase_symbol = _validate_symbol(symbol)
    except HTTPException as exc:
        await websocket.close(code=4400, reason=exc.detail)
        return

    interval = interval.lower()
    if interval not in INTERVAL_MINUTES:
        await websocket.close(code=4400, reason="Unsupported interval")
        return

    await websocket.accept()

    try:
        async for update in iter_future_candles(uppercase_symbol, interval):
            await websocket.send_json({
                "type": "update",
                "symbol": uppercase_symbol,
                "interval": interval,
                "candle": update["candle"],
                "final": update.get("final", True),
            })
    except WebSocketDisconnect:
        return
    except Exception:
        await websocket.close(code=1011, reason="Internal server error")