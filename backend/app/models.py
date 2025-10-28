"""Data models for the application."""
from dataclasses import dataclass, asdict
from typing import Optional, List, Dict, Any


@dataclass
class Drawing:
    """Represents a drawing on the chart."""
    id: str
    symbol: str
    interval: str
    tool: str  # "line", "fib", "rectangle"
    points: List[Dict[str, Any]]  # List of {x, y} or {time, price}
    color: Optional[str] = None
    lineWidth: Optional[int] = None
    properties: Optional[Dict[str, Any]] = None  # Extra properties

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @staticmethod
    def from_dict(data: Dict[str, Any]) -> "Drawing":
        return Drawing(**data)
