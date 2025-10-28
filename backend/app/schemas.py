from datetime import datetime
from typing import List

from pydantic import BaseModel, Field


class InstrumentResponse(BaseModel):
    symbol: str = Field(..., description="Ticker symbol")
    name: str = Field(..., description="Human readable name")


class Candle(BaseModel):
    time: int = Field(..., description="Unix timestamp in seconds")
    open: float
    high: float
    low: float
    close: float
    volume: float


class CandleResponse(BaseModel):
    candles: List[Candle]
    start: datetime
    end: datetime


class TimeRangeResponse(BaseModel):
    earliest: datetime
    latest: datetime
