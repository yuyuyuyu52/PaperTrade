from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Dict, List


@dataclass(frozen=True)
class Instrument:
    symbol: str
    name: str
    binance_symbol: str


DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)


INSTRUMENTS: List[Instrument] = [
    Instrument(symbol="ETH", name="Ethereum", binance_symbol="ETHUSDT"),
    Instrument(symbol="BTC", name="Bitcoin", binance_symbol="BTCUSDT"),
]

INTERVAL_MINUTES: Dict[str, int] = {
    "1m": 1,
    "5m": 5,
    "15m": 15,
    "1h": 60,
    "4h": 240,
    "1d": 1440,
}

INTERVAL_SECONDS: Dict[str, int] = {key: value * 60 for key, value in INTERVAL_MINUTES.items()}


def interval_to_timedelta(interval: str) -> timedelta:
    minutes = INTERVAL_MINUTES.get(interval)
    if minutes is None:
        raise ValueError(f"Unsupported interval: {interval}")
    return timedelta(minutes=minutes)


SYMBOL_TO_BINANCE: Dict[str, str] = {instrument.symbol: instrument.binance_symbol for instrument in INSTRUMENTS}


def resolve_binance_symbol(symbol: str) -> str:
    try:
        return SYMBOL_TO_BINANCE[symbol.upper()]
    except KeyError as exc:
        raise ValueError(f"Unsupported symbol: {symbol}") from exc
