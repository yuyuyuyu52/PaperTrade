import asyncio
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Literal

from calendar import monthrange

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import logging
from pydantic import BaseModel, Field, model_validator

from .config import INTERVAL_MINUTES
from .data_provider import (
    available_time_range,
    fetch_candles,
    iter_future_candles,
    list_instruments,
)
from .schemas import Candle, CandleResponse, InstrumentResponse, TimeRangeResponse
from .models import Drawing
from .drawings_storage import (
    init_drawings_db,
    save_drawing,
    get_drawings,
    delete_drawing,
    delete_all_drawings,
)
from .trading_storage import (
    init_trading_db,
    get_or_create_account,
    get_account_stats,
    get_account_id,
    save_account,
    clear_orders,
    clear_trades,
    reset_account_stats,
)
from .trading_engine import get_trading_engine
from .data_provider import get_live_price_ws, get_latest_price
from .events_bus import (
    subscribe as events_subscribe,
    unsubscribe as events_unsubscribe,
    set_event_loop as events_set_event_loop,
)

app = FastAPI(title="TradingView Clone API", version="0.1.0")
logger = logging.getLogger("ws")

# Initialize databases
init_drawings_db()
init_trading_db()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"]
    ,
    allow_headers=["*"],
)


@app.on_event("startup")
async def _register_events_loop() -> None:
    events_set_event_loop(asyncio.get_running_loop())


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


DEFAULT_MODE = "realtime"
VALID_MODES = {"realtime", "playback"}
DEFAULT_INTERVAL = "1m"
DEFAULT_LIST_LIMIT = 50
MAX_LIST_LIMIT = 500


def _normalize_mode(mode: Optional[str]) -> str:
    value = (mode or DEFAULT_MODE).lower()
    if value not in VALID_MODES:
        raise HTTPException(status_code=400, detail=f"Unsupported mode: {mode}")
    return value


def _normalize_interval(interval: Optional[str]) -> str:
    value = (interval or DEFAULT_INTERVAL).lower()
    if value not in INTERVAL_MINUTES:
        raise HTTPException(status_code=400, detail=f"Unsupported interval: {value}")
    return value


def _normalize_limit(limit: Optional[int], default: int = DEFAULT_LIST_LIMIT) -> int:
    if limit is None:
        return default
    if limit < 1 or limit > MAX_LIST_LIMIT:
        raise HTTPException(status_code=400, detail=f"limit must be between 1 and {MAX_LIST_LIMIT}")
    return limit


def _paginate_items(items, sort_key, limit: int):
    ordered = sorted(items, key=sort_key, reverse=True)
    total = len(ordered)
    if limit is not None:
        ordered = ordered[:limit]
    return ordered, total


def _resolve_account(symbol: str, mode: Optional[str], interval: Optional[str]):
    uppercase_symbol = _validate_symbol(symbol)
    normalized_mode = _normalize_mode(mode)
    interval_value = _normalize_interval(interval)
    account_id, account = get_or_create_account(normalized_mode, uppercase_symbol, interval_value)
    return account_id, account, normalized_mode, interval_value, uppercase_symbol


def _account_payload(
    symbol: str,
    mode: Optional[str],
    interval: Optional[str],
    orders_limit: Optional[int] = None,
    trades_limit: Optional[int] = None,
    closed_positions_limit: Optional[int] = None,
) -> Dict[str, Any]:
    orders_limit_value = _normalize_limit(orders_limit)
    trades_limit_value = _normalize_limit(trades_limit)
    closed_limit_value = _normalize_limit(closed_positions_limit)

    account_id, account, _, _, _ = _resolve_account(symbol, mode, interval)
    stats = get_account_stats(account_id)
    return _serialize_account(
        account,
        stats,
        account_id,
        orders_limit=orders_limit_value,
        trades_limit=trades_limit_value,
        closed_positions_limit=closed_limit_value,
    )


def _reset_account_state(symbol: str, mode: Optional[str], interval: Optional[str]) -> Dict[str, Any]:
    account_id, account, normalized_mode, interval_value, uppercase_symbol = _resolve_account(symbol, mode, interval)

    initial_balance = account.initial_balance
    account.balance = initial_balance
    account.positions = []
    account.orders = []
    account.trades = []
    account.closed_positions = []

    clear_orders(account_id)
    clear_trades(account_id)
    reset_account_stats(account_id)

    save_account(account_id, account)

    logger.info(f"[ResetAccount] Account reset: {normalized_mode}/{uppercase_symbol}/{interval_value}")
    return {"success": True, "balance": account.balance}


def _serialize_account(
    account,
    stats: Optional[Any] = None,
    account_id: Optional[int] = None,
    *,
    orders_limit: int = DEFAULT_LIST_LIMIT,
    trades_limit: int = DEFAULT_LIST_LIMIT,
    closed_positions_limit: int = DEFAULT_LIST_LIMIT,
) -> Dict[str, Any]:
    """Convert account dataclass into a serializable structure."""
    positions_payload = []
    total_position_value = 0.0
    for p in account.positions:
        positions_payload.append(
            {
                "symbol": p.symbol,
                "quantity": p.quantity,
                "entry_price": p.entry_price,
                "entry_time": p.entry_time,
                "take_profit_price": p.take_profit_price,
                "stop_loss_price": p.stop_loss_price,
            }
        )
        total_position_value += abs(p.quantity) * p.entry_price

    orders_sorted, orders_total = _paginate_items(
        account.orders,
        sort_key=lambda o: getattr(o, "create_time", 0),
        limit=orders_limit,
    )

    orders_payload = [
        {
            "id": o.id,
            "symbol": o.symbol,
            "direction": o.direction,
            "type": o.type,
            "quantity": o.quantity,
            "price": o.price,
            "create_time": o.create_time,
            "filled_quantity": o.filled_quantity,
            "filled_price": o.filled_price,
            "status": o.status,
        }
        for o in orders_sorted
    ]

    trades_sorted, trades_total = _paginate_items(
        account.trades,
        sort_key=lambda t: getattr(t, "timestamp", 0),
        limit=trades_limit,
    )

    trades_payload = [
        {
            "id": t.id,
            "symbol": t.symbol,
            "direction": t.direction,
            "quantity": t.quantity,
            "price": t.price,
            "timestamp": t.timestamp,
            "commission": t.commission,
        }
        for t in trades_sorted
    ]

    closed_sorted, closed_total = _paginate_items(
        account.closed_positions,
        sort_key=lambda cp: getattr(cp, "exit_time", 0),
        limit=closed_positions_limit,
    )

    closed_positions_payload = [
        {
            "id": cp.id,
            "symbol": cp.symbol,
            "direction": cp.direction,
            "quantity": cp.quantity,
            "entry_price": cp.entry_price,
            "entry_time": cp.entry_time,
            "exit_price": cp.exit_price,
            "exit_time": cp.exit_time,
            "profit_loss": cp.profit_loss,
            "commission": cp.commission,
            "days_held": cp.days_held(),
            "return_pct": cp.return_pct(),
        }
        for cp in closed_sorted
    ]

    stats_payload: Dict[str, Any] = {}
    if stats:
        stats_payload = {
            "total_trades": stats.total_trades,
            "winning_trades": stats.winning_trades,
            "losing_trades": stats.losing_trades,
            "win_rate": stats.win_rate,
            "profit_factor": stats.profit_factor,
            "max_drawdown": stats.max_drawdown,
            "max_drawdown_pct": stats.max_drawdown_pct,
            "sharpe_ratio": stats.sharpe_ratio,
            "cagr": stats.cagr,
            "cumulative_return": stats.cumulative_return,
            "total_return": stats.total_return,
        }

    # Unrealized PnL is not tracked server-side without market data; keep zero for now.
    unrealized_pnl = 0.0
    equity = account.balance + total_position_value + unrealized_pnl

    return {
        "account_id": account_id,
        "mode": account.mode,
        "symbol": account.symbol,
        "interval": account.interval,
        "initial_balance": account.initial_balance,
        "balance": account.balance,
        "positions": positions_payload,
        "orders": orders_payload,
        "trades": trades_payload,
        "closed_positions": closed_positions_payload,
        "orders_total": orders_total,
        "orders_limit": orders_limit,
        "trades_total": trades_total,
        "trades_limit": trades_limit,
        "closed_positions_total": closed_total,
        "closed_positions_limit": closed_positions_limit,
        "stats": stats_payload,
        "positions_value": total_position_value,
        "unrealized_pnl": unrealized_pnl,
        "equity": equity,
    }


@app.post("/api/drawings")
def create_drawing(drawing: Drawing) -> Drawing:
    """Save a new drawing."""
    if not drawing.id:
        import uuid
        drawing.id = str(uuid.uuid4())
    
    uppercase_symbol = _validate_symbol(drawing.symbol)
    drawing.symbol = uppercase_symbol
    
    save_drawing(drawing)
    return drawing


@app.get("/api/drawings")
def list_drawings(symbol: str = Query(..., min_length=1), interval: str = Query(..., min_length=1)) -> List[Drawing]:
    """Get all drawings for a symbol and interval."""
    uppercase_symbol = _validate_symbol(symbol)
    return get_drawings(uppercase_symbol, interval)


@app.delete("/api/drawings/{drawing_id}")
def remove_drawing(drawing_id: str) -> dict:
    """Delete a drawing by ID."""
    success = delete_drawing(drawing_id)
    if not success:
        raise HTTPException(status_code=404, detail="Drawing not found")
    return {"success": True, "id": drawing_id}


@app.delete("/api/drawings")
def clear_drawings(symbol: str = Query(..., min_length=1), interval: str = Query(..., min_length=1)) -> dict:
    """Delete all drawings for a symbol and interval."""
    uppercase_symbol = _validate_symbol(symbol)
    count = delete_all_drawings(uppercase_symbol, interval)
    return {"success": True, "deleted": count}


@app.post("/api/account/reset")
def reset_account(
    symbol: str = Query(..., description="Symbol"),
    mode: Optional[str] = Query(None, description="Trading mode"),
    interval: Optional[str] = Query(None, description="Interval context"),
) -> Dict[str, Any]:
    try:
        return _reset_account_state(symbol, mode, interval)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/accounts/{mode}/{symbol}/{interval}/reset")
def reset_account_legacy(mode: str, symbol: str, interval: str) -> Dict[str, Any]:
    return reset_account(symbol=symbol, mode=mode, interval=interval)


def _check_and_trigger_tpsl(mode: str, symbol: str, interval: str, candle: dict) -> None:
    """检查并触发止盈止损和限价单"""
    try:
        account_id, account = get_or_create_account(mode, symbol, interval)
        engine = get_trading_engine(account_id, account)
        
        current_price = candle["close"]
        high = candle.get("high")
        low = candle.get("low")
        
        # 检查限价单（使用K线高低价）
        filled_orders = engine.try_fill_limit_orders(symbol, current_price, high, low)
        if filled_orders:
            logger.info(f"[LimitOrder] Filled {len(filled_orders)} orders for {symbol}")
        
        # 检查止盈止损（使用K线高低价）
        triggered_orders = engine.check_tpsl_triggers(symbol, current_price, high, low)
        if triggered_orders:
            logger.info(f"[TPSL] Triggered {len(triggered_orders)} orders for {symbol} @ {current_price}")
    except Exception as e:
        logger.error(f"[TPSL] Error checking TP/SL: {e}")


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
            candle = update["candle"]
            
            # 实时检查止盈止损和限价单（每次更新都检查，包括未完成的K线）
            _check_and_trigger_tpsl("realtime", uppercase_symbol, interval, candle)
            
            await websocket.send_json({
                "type": "update",
                "symbol": uppercase_symbol,
                "interval": interval,
                "candle": candle,
                "final": update.get("final", True),
            })
    except WebSocketDisconnect:
        return
    except Exception:
        await websocket.close(code=1011, reason="Internal server error")


# ============ Trading API Endpoints ============


class OrderPayload(BaseModel):
    symbol: str = Field(..., min_length=1, description="Trading symbol")
    direction: Literal["buy", "sell"]
    type: Literal["market", "limit"]
    quantity: float = Field(..., gt=0)
    price: Optional[float] = Field(default=None, gt=0)
    current_price: Optional[float] = Field(default=None, gt=0)

    @model_validator(mode="after")
    def validate_price(self) -> "OrderPayload":
        if self.type == "limit" and self.price is None:
            raise ValueError("price is required for limit orders")
        if self.type == "market" and self.price is not None:
            raise ValueError("price is only allowed for limit orders")
        return self


@app.get("/api/account")
def get_account(
    symbol: str = Query(..., description="Symbol"),
    mode: Optional[str] = Query(None, description="Trading mode"),
    interval: Optional[str] = Query(None, description="Interval context"),
    orders_limit: int = Query(DEFAULT_LIST_LIMIT, ge=1, le=MAX_LIST_LIMIT, description="Maximum orders to include"),
    trades_limit: int = Query(DEFAULT_LIST_LIMIT, ge=1, le=MAX_LIST_LIMIT, description="Maximum trades to include"),
    closed_positions_limit: int = Query(DEFAULT_LIST_LIMIT, ge=1, le=MAX_LIST_LIMIT, description="Maximum closed positions to include"),
):
    """Get account information. Defaults to realtime mode and 1m interval if not provided."""
    try:
        return _account_payload(
            symbol,
            mode,
            interval,
            orders_limit=orders_limit,
            trades_limit=trades_limit,
            closed_positions_limit=closed_positions_limit,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/accounts/{mode}")
def get_account_by_mode(
    mode: str,
    symbol: str = Query(..., description="Symbol"),
    interval: str = Query(..., description="Interval"),
):
    return get_account(symbol=symbol, mode=mode, interval=interval)


@app.websocket("/ws/account")
async def account_events(
    websocket: WebSocket,
    symbol: str,
    mode: Optional[str] = None,
    interval: Optional[str] = None,
    orders_limit: Optional[int] = None,
    trades_limit: Optional[int] = None,
    closed_positions_limit: Optional[int] = None,
) -> None:
    try:
        account_id, account, _, _, _ = _resolve_account(symbol, mode, interval)
    except HTTPException as exc:
        await websocket.close(code=4400, reason=exc.detail)
        return

    await websocket.accept()

    try:
        orders_limit_value = _normalize_limit(orders_limit)
        trades_limit_value = _normalize_limit(trades_limit)
        closed_limit_value = _normalize_limit(closed_positions_limit)
        stats = get_account_stats(account_id)
        snapshot = _serialize_account(
            account,
            stats,
            account_id,
            orders_limit=orders_limit_value,
            trades_limit=trades_limit_value,
            closed_positions_limit=closed_limit_value,
        )
        await websocket.send_json({"type": "snapshot", "account": snapshot})

        queue = await events_subscribe(account_id)
        try:
            while True:
                payload = await queue.get()
                await websocket.send_json(payload)
        finally:
            await events_unsubscribe(account_id, queue)
    except WebSocketDisconnect:
        return
    except Exception as exc:
        await websocket.close(code=1011, reason=str(exc))


@app.post("/api/orders")
async def place_order(
    payload: OrderPayload,
    mode: Optional[str] = Query(None, description="Trading mode"),
    interval: Optional[str] = Query(None, description="Interval used for pricing"),
):
    """Place an order using the latest backend price for market orders."""
    try:
        uppercase_symbol = _validate_symbol(payload.symbol)
    except HTTPException as exc:
        raise exc

    normalized_mode = _normalize_mode(mode)
    interval_value = _normalize_interval(interval)

    try:
        account_id, account = get_or_create_account(normalized_mode, uppercase_symbol, interval_value)
        engine = get_trading_engine(account_id, account)

        logger.debug(
            "[Orders] request body=%s mode=%s interval=%s",
            payload.model_dump(),
            normalized_mode,
            interval_value,
        )

        if payload.type == "market":
            latest_price: Optional[float] = None
            try:
                latest_price = await get_live_price_ws(uppercase_symbol, interval_value, timeout=2.0)
            except Exception:
                # Fallback: use client-provided current_price -> cached WS price -> latest stored candle
                fallback = payload.current_price if payload.current_price and payload.current_price > 0 else None
                if fallback is None:
                    cached = get_latest_price(uppercase_symbol, interval_value)
                    if cached is not None:
                        fallback = cached
                if fallback is None:
                    try:
                        candles_latest = await fetch_candles(symbol=uppercase_symbol, interval=interval_value, limit=1)
                        if candles_latest:
                            fallback = float(candles_latest[-1]["close"])
                    except Exception:
                        pass
                if fallback is None:
                    raise HTTPException(status_code=503, detail="Live price unavailable")
                latest_price = float(fallback)
            order = engine.place_market_order(
                uppercase_symbol,
                payload.direction,
                payload.quantity,
                float(latest_price),
            )
        else:
            assert payload.price is not None  # validator guarantees
            order = engine.place_limit_order(
                uppercase_symbol,
                payload.direction,
                payload.quantity,
                payload.price,
            )

        return {
            "id": order.id,
            "symbol": order.symbol,
            "direction": order.direction,
            "type": order.type,
            "quantity": order.quantity,
            "price": order.price,
            "create_time": order.create_time,
            "filled_quantity": order.filled_quantity,
            "filled_price": order.filled_price,
            "status": order.status,
        }
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/orders")
def list_orders(
    symbol: str = Query(...),
    mode: Optional[str] = Query(None),
    interval: Optional[str] = Query(None),
    limit: int = Query(DEFAULT_LIST_LIMIT, ge=1, le=MAX_LIST_LIMIT),
    offset: int = Query(0, ge=0),
):
    """List orders."""
    try:
        _, account, _, _, _ = _resolve_account(symbol, mode, interval)
        ordered = sorted(account.orders, key=lambda o: getattr(o, "create_time", 0), reverse=True)
        total = len(ordered)
        paged = ordered[offset:offset + limit]

        items = [
            {
                "id": o.id,
                "symbol": o.symbol,
                "direction": o.direction,
                "type": o.type,
                "quantity": o.quantity,
                "price": o.price,
                "create_time": o.create_time,
                "filled_quantity": o.filled_quantity,
                "filled_price": o.filled_price,
                "status": o.status,
            }
            for o in paged
        ]

        return {
            "items": items,
            "total": total,
            "limit": limit,
            "offset": offset,
            "has_more": offset + len(items) < total,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/orders/{order_id}")
async def cancel_order(
    order_id: str,
    symbol: str = Query(...),
    mode: Optional[str] = Query(None),
    interval: Optional[str] = Query(None),
):
    """Cancel an order."""
    try:
        account_id, account, _, _, _ = _resolve_account(symbol, mode, interval)
        engine = get_trading_engine(account_id, account)
        
        if engine.cancel_order(order_id):
            return {"success": True, "id": order_id}
        else:
            raise HTTPException(status_code=404, detail="Order not found or already filled")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/trades")
def list_trades(
    symbol: str = Query(...),
    mode: Optional[str] = Query(None),
    interval: Optional[str] = Query(None),
    limit: int = Query(DEFAULT_LIST_LIMIT, ge=1, le=MAX_LIST_LIMIT),
    offset: int = Query(0, ge=0),
):
    """List trades."""
    try:
        _, account, _, _, _ = _resolve_account(symbol, mode, interval)
        ordered = sorted(account.trades, key=lambda t: getattr(t, "timestamp", 0), reverse=True)
        total = len(ordered)
        paged = ordered[offset:offset + limit]

        items = [
            {
                "id": t.id,
                "symbol": t.symbol,
                "direction": t.direction,
                "quantity": t.quantity,
                "price": t.price,
                "timestamp": t.timestamp,
                "commission": t.commission,
            }
            for t in paged
        ]

        return {
            "items": items,
            "total": total,
            "limit": limit,
            "offset": offset,
            "has_more": offset + len(items) < total,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/closed-positions")
def list_closed_positions(
    symbol: str = Query(...),
    mode: Optional[str] = Query(None),
    interval: Optional[str] = Query(None),
    limit: int = Query(DEFAULT_LIST_LIMIT, ge=1, le=MAX_LIST_LIMIT),
    offset: int = Query(0, ge=0),
):
    """List closed positions (completed trades from entry to exit)."""
    try:
        _, account, _, _, _ = _resolve_account(symbol, mode, interval)
        ordered = sorted(account.closed_positions, key=lambda cp: getattr(cp, "exit_time", 0), reverse=True)
        total = len(ordered)
        paged = ordered[offset:offset + limit]

        items = [
            {
                "id": cp.id,
                "symbol": cp.symbol,
                "direction": cp.direction,
                "quantity": cp.quantity,
                "entry_price": cp.entry_price,
                "entry_time": cp.entry_time,
                "exit_price": cp.exit_price,
                "exit_time": cp.exit_time,
                "profit_loss": cp.profit_loss,
                "commission": cp.commission,
                "days_held": cp.days_held(),
                "return_pct": cp.return_pct(),
            }
            for cp in paged
        ]

        return {
            "items": items,
            "total": total,
            "limit": limit,
            "offset": offset,
            "has_more": offset + len(items) < total,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/account-stats")
def get_stats(
    symbol: str = Query(...),
    mode: Optional[str] = Query(None),
    interval: Optional[str] = Query(None),
):
    """Get account statistics."""
    try:
        account_id, account, _, _, _ = _resolve_account(symbol, mode, interval)
        engine = get_trading_engine(account_id, account)
        stats = engine.calculate_stats()

        return {
            "total_trades": stats.total_trades,
            "winning_trades": stats.winning_trades,
            "losing_trades": stats.losing_trades,
            "win_rate": stats.win_rate,
            "total_profit": stats.total_profit,
            "total_loss": stats.total_loss,
            "profit_factor": stats.profit_factor,
            "expectancy": stats.expectancy,
            "max_drawdown": stats.max_drawdown,
            "max_drawdown_pct": stats.max_drawdown_pct,
            "sharpe_ratio": stats.sharpe_ratio,
            "cagr": stats.cagr,
            "cumulative_return": stats.cumulative_return,
            "total_return": stats.total_return,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/account-stats/{mode}")
def get_stats_by_mode(
    mode: str,
    symbol: str = Query(...),
    interval: str = Query(...),
):
    return get_stats(symbol=symbol, mode=mode, interval=interval)


@app.post("/api/positions/tpsl")
async def set_position_tpsl(
    symbol: str = Query(...),
    mode: Optional[str] = Query(None),
    interval: Optional[str] = Query(None),
    take_profit_price: Optional[float] = Query(None),
    stop_loss_price: Optional[float] = Query(None),
):
    """Set take profit and stop loss for a position."""
    try:
        account_id, account, _, _, uppercase_symbol = _resolve_account(symbol, mode, interval)
        engine = get_trading_engine(account_id, account)
        
        success = engine.set_position_tpsl(uppercase_symbol, take_profit_price, stop_loss_price)
        
        return {
            "success": success,
            "symbol": uppercase_symbol,
            "take_profit_price": take_profit_price,
            "stop_loss_price": stop_loss_price,
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/daily-pnl")
def daily_pnl(
    symbol: str = Query(...),
    month: str = Query(..., description="Month in YYYY-MM format (UTC)"),
    mode: Optional[str] = Query(None),
    interval: Optional[str] = Query(None),
):
    """Aggregate realized PnL by day for the specified month (UTC)."""
    try:
        account_id, account, _, _, _ = _resolve_account(symbol, mode, interval)
    except HTTPException as exc:
        raise exc

    try:
        start_dt = datetime.strptime(month, "%Y-%m").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid month format, expected YYYY-MM") from exc

    # Determine month boundaries in UTC
    days_in_month = monthrange(start_dt.year, start_dt.month)[1]
    end_dt = start_dt + timedelta(days=days_in_month)

    daily: Dict[str, float] = {}
    for cp in account.closed_positions:
        exit_dt = datetime.fromtimestamp(cp.exit_time, tz=timezone.utc)
        if not (start_dt <= exit_dt < end_dt):
            continue
        date_key = exit_dt.strftime("%Y-%m-%d")
        net_pnl = cp.profit_loss - cp.commission
        daily[date_key] = daily.get(date_key, 0.0) + net_pnl

    days_payload = [
        {"date": day, "pnl": value}
        for day, value in sorted(daily.items())
    ]

    return {"month": month, "days": days_payload}


@app.get("/api/daily-pnl/{mode}")
def daily_pnl_by_mode(
    mode: str,
    symbol: str = Query(...),
    interval: str = Query(...),
    month: str = Query(..., description="Month in YYYY-MM format (UTC)"),
):
    return daily_pnl(symbol=symbol, month=month, mode=mode, interval=interval)