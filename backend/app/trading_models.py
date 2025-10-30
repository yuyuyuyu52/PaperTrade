"""Trading system data models."""

from dataclasses import dataclass, field
from typing import Optional, List
from datetime import datetime


@dataclass
class Position:
    """持仓信息"""
    symbol: str
    quantity: float  # 正数表示做多，负数表示做空
    entry_price: float  # 平均成本
    entry_time: int  # 建仓时间戳
    take_profit_price: Optional[float] = None
    stop_loss_price: Optional[float] = None
    
    def is_long(self) -> bool:
        return self.quantity > 0
    
    def is_short(self) -> bool:
        return self.quantity < 0
    
    def is_empty(self) -> bool:
        return self.quantity == 0


@dataclass
class Order:
    """订单"""
    id: str
    symbol: str
    direction: str  # "buy" 或 "sell"
    type: str  # "market" 或 "limit"
    quantity: float
    price: Optional[float]  # limit 订单时有效
    create_time: int
    filled_time: Optional[int] = None
    filled_quantity: float = 0.0
    filled_price: Optional[float] = None
    status: str = "open"  # "open", "filled", "cancelled"
    
    def is_open(self) -> bool:
        return self.status == "open"
    
    def is_filled(self) -> bool:
        return self.status == "filled"


@dataclass
class Trade:
    """成交记录"""
    id: str
    symbol: str
    direction: str  # "buy" 或 "sell"
    quantity: float
    price: float
    timestamp: int
    commission: float = 0.0


@dataclass
class ClosedPosition:
    """已平仓的完整持仓交易 - 从建仓到平仓的完整周期"""
    id: str
    symbol: str
    direction: str  # "buy" (做多) 或 "sell" (做空)
    quantity: float
    entry_price: float
    entry_time: int
    exit_price: float
    exit_time: int
    profit_loss: float  # 平仓的盈亏（包括手续费）
    commission: float = 0.0
    
    def days_held(self) -> float:
        """持仓天数"""
        return (self.exit_time - self.entry_time) / 86400.0
    
    def is_profitable(self) -> bool:
        """是否盈利"""
        return self.profit_loss > 0
    
    def return_pct(self) -> float:
        """收益率百分比"""
        cost = self.quantity * self.entry_price
        if cost == 0:
            return 0
        return (self.profit_loss / cost) * 100


@dataclass
class Account:
    """账户"""
    mode: str  # "realtime" 或 "playback"
    symbol: str
    interval: str
    initial_balance: float = 10000.0
    balance: float = field(default_factory=lambda: 10000.0)
    positions: List[Position] = field(default_factory=list)
    orders: List[Order] = field(default_factory=list)
    trades: List[Trade] = field(default_factory=list)
    closed_positions: List[ClosedPosition] = field(default_factory=list)
    created_time: int = field(default_factory=lambda: int(datetime.utcnow().timestamp()))
    last_update_time: int = field(default_factory=lambda: int(datetime.utcnow().timestamp()))
    
    def get_position(self, symbol: str) -> Optional[Position]:
        """获取指定品种的仓位"""
        for pos in self.positions:
            if pos.symbol == symbol:
                return pos
        return None
    
    def get_total_position_value(self, current_price: float) -> float:
        """获取当前仓位总价值"""
        total = 0.0
        for pos in self.positions:
            total += abs(pos.quantity) * current_price
        return total
    
    def get_margin_used(self, current_price: float) -> float:
        """获取已用保证金（现货为仓位总价值）"""
        return self.get_total_position_value(current_price)
    
    def get_margin_available(self, current_price: float) -> float:
        """获取可用保证金"""
        margin_used = self.get_margin_used(current_price)
        # 简化：可用保证金 = 账户余额
        return max(0, self.balance)


@dataclass
class AccountStats:
    """账户统计数据"""
    total_trades: int = 0  # 总成交数
    winning_trades: int = 0  # 盈利成交数
    losing_trades: int = 0  # 亏损成交数
    win_rate: float = 0.0  # 胜率
    
    total_profit: float = 0.0  # 总盈利
    total_loss: float = 0.0  # 总亏损
    profit_factor: float = 0.0  # 盈利因子 = 总盈利 / 总亏损
    expectancy: float = 0.0  # 期望值 = (胜率 * 平均盈利) - ((1 - 胜率) * 平均亏损)
    
    max_drawdown: float = 0.0  # 最大回撤
    max_drawdown_pct: float = 0.0  # 最大回撤百分比
    
    sharpe_ratio: float = 0.0  # 夏普比率
    cagr: float = 0.0  # 年化收益率
    
    cumulative_return: float = 0.0  # 累计收益率
    total_return: float = 0.0  # 总收益
