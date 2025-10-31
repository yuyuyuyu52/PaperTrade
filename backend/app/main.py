from datetime import datetime, timezone
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import logging

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


@app.post("/api/accounts/{mode}/{symbol}/{interval}/reset")
def reset_account(mode: str, symbol: str, interval: str) -> dict:
    """Reset account to initial state."""
    try:
        uppercase_symbol = _validate_symbol(symbol)
    except HTTPException as exc:
        raise exc
    
    if mode not in ["realtime", "playback"]:
        raise HTTPException(status_code=400, detail="Invalid mode")
    
    interval = interval.lower()
    if interval not in INTERVAL_MINUTES:
        raise HTTPException(status_code=400, detail="Unsupported interval")
    
    # Get account
    account_id, account = get_or_create_account(mode, uppercase_symbol, interval)
    
    # Reset to initial balance
    initial_balance = account.initial_balance
    account.balance = initial_balance
    account.positions = []
    account.orders = []
    account.trades = []
    account.closed_positions = []

    # Clear orders/trades and reset stats, then persist positions/closed positions (empty)
    clear_orders(account_id)
    clear_trades(account_id)
    reset_account_stats(account_id)

    # Save reset account
    save_account(account_id, account)
    
    logger.info(f"[ResetAccount] Account reset: {mode}/{uppercase_symbol}/{interval}")
    return {"success": True, "balance": account.balance}


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

class OrderRequest:
    def __init__(self, direction: str, type: str, quantity: float, price: Optional[float] = None):
        self.direction = direction
        self.type = type
        self.quantity = quantity
        self.price = price


@app.get("/api/accounts/{mode}")
def get_account(
    mode: str,
    symbol: str = Query(..., description="Symbol"),
    interval: str = Query(..., description="Interval"),
):
    """Get account information."""
    try:
        # Validate and uppercase symbol
        uppercase_symbol = _validate_symbol(symbol)
        
        account_id, account = get_or_create_account(mode, uppercase_symbol, interval)
        stats = get_account_stats(account_id)
        
        return {
            "account_id": account_id,
            "mode": account.mode,
            "symbol": account.symbol,
            "interval": account.interval,
            "initial_balance": account.initial_balance,
            "balance": account.balance,
            "positions": [
                {
                    "symbol": p.symbol,
                    "quantity": p.quantity,
                    "entry_price": p.entry_price,
                    "entry_time": p.entry_time,
                    "take_profit_price": p.take_profit_price,
                    "stop_loss_price": p.stop_loss_price,
                }
                for p in account.positions
            ],
            "orders": [
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
                for o in account.orders
            ],
            "trades": [
                {
                    "id": t.id,
                    "symbol": t.symbol,
                    "direction": t.direction,
                    "quantity": t.quantity,
                    "price": t.price,
                    "timestamp": t.timestamp,
                    "commission": t.commission,
                }
                for t in account.trades
            ],
            "closed_positions": [
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
                for cp in account.closed_positions
            ],
            "stats": {
                "total_trades": stats.total_trades if stats else 0,
                "winning_trades": stats.winning_trades if stats else 0,
                "losing_trades": stats.losing_trades if stats else 0,
                "win_rate": stats.win_rate if stats else 0,
                "profit_factor": stats.profit_factor if stats else 0,
                "max_drawdown": stats.max_drawdown if stats else 0,
                "sharpe_ratio": stats.sharpe_ratio if stats else 0,
                "cagr": stats.cagr if stats else 0,
                "cumulative_return": stats.cumulative_return if stats else 0,
            } if stats else {},
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/orders")
def place_order(
    mode: str = Query(...),
    symbol: str = Query(...),
    interval: str = Query(...),
    direction: str = Query(..., description="buy or sell"),
    order_type: str = Query(..., description="market or limit", alias="type"),
    quantity: float = Query(...),
    price: Optional[float] = Query(None),
    current_price: float = Query(...),
):
    """Place an order."""
    try:
        print(f"[DEBUG] POST /api/orders received: mode={mode}, symbol={symbol}, interval={interval}, direction={direction}, type={order_type}, quantity={quantity}, price={price}, current_price={current_price}")
        # Validate and uppercase symbol
        uppercase_symbol = _validate_symbol(symbol)
        
        account_id, account = get_or_create_account(mode, uppercase_symbol, interval)
        engine = get_trading_engine(account_id, account)
        
        if order_type == "market":
            order = engine.place_market_order(uppercase_symbol, direction, quantity, current_price)
        elif order_type == "limit":
            if price is None:
                raise ValueError("Price required for limit orders")
            order = engine.place_limit_order(uppercase_symbol, direction, quantity, price)
        else:
            raise ValueError("Invalid order type")
        
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
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/orders")
def list_orders(
    mode: str = Query(...),
    symbol: str = Query(...),
    interval: str = Query(...),
):
    """List orders."""
    try:
        # Validate and uppercase symbol
        uppercase_symbol = _validate_symbol(symbol)
        
        account_id, account = get_or_create_account(mode, uppercase_symbol, interval)
        
        return [
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
            for o in account.orders
        ]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/orders/{order_id}")
def cancel_order(
    order_id: str,
    mode: str = Query(...),
    symbol: str = Query(...),
    interval: str = Query(...),
):
    """Cancel an order."""
    try:
        # Validate and uppercase symbol
        uppercase_symbol = _validate_symbol(symbol)
        
        account_id, account = get_or_create_account(mode, uppercase_symbol, interval)
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
    mode: str = Query(...),
    symbol: str = Query(...),
    interval: str = Query(...),
):
    """List trades."""
    try:
        # Validate and uppercase symbol
        uppercase_symbol = _validate_symbol(symbol)
        
        account_id, account = get_or_create_account(mode, uppercase_symbol, interval)
        
        return [
            {
                "id": t.id,
                "symbol": t.symbol,
                "direction": t.direction,
                "quantity": t.quantity,
                "price": t.price,
                "timestamp": t.timestamp,
                "commission": t.commission,
            }
            for t in account.trades
        ]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/closed-positions")
def list_closed_positions(
    mode: str = Query(...),
    symbol: str = Query(...),
    interval: str = Query(...),
):
    """List closed positions (completed trades from entry to exit)."""
    try:
        # Validate and uppercase symbol
        uppercase_symbol = _validate_symbol(symbol)
        
        account_id, account = get_or_create_account(mode, uppercase_symbol, interval)
        
        return [
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
            for cp in account.closed_positions
        ]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/account-stats/{mode}")
def get_stats(
    mode: str,
    symbol: str = Query(...),
    interval: str = Query(...),
):
    """Get account statistics."""
    try:
        # Validate and uppercase symbol
        uppercase_symbol = _validate_symbol(symbol)
        
        account_id, account = get_or_create_account(mode, uppercase_symbol, interval)
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


@app.post("/api/positions/tpsl")
def set_position_tpsl(
    mode: str = Query(...),
    symbol: str = Query(...),
    interval: str = Query(...),
    take_profit_price: Optional[float] = Query(None),
    stop_loss_price: Optional[float] = Query(None),
):
    """Set take profit and stop loss for a position."""
    try:
        # Validate and uppercase symbol
        uppercase_symbol = _validate_symbol(symbol)
        
        account_id, account = get_or_create_account(mode, uppercase_symbol, interval)
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