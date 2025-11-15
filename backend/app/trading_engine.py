"""Trading engine core logic."""

import uuid
from datetime import datetime
from typing import Optional, Tuple, List
import math

from .trading_models import Account, Order, Position, Trade, ClosedPosition, AccountStats
from .events_bus import dispatch as dispatch_event
from .trading_storage import (
    save_account, save_order, save_trade, save_account_stats, 
    get_account_stats
)


COMMISSION_RATE = 0.001  # 0.1% commission
QUANTITY_EPSILON = 1e-10  # 用于处理浮点数精度问题的最小数量阈值


class TradingEngine:
    """交易引擎"""
    
    def __init__(self, account_id: int, account: Account):
        self.account_id = account_id
        self.account = account
    
    def place_market_order(self, symbol: str, direction: str, quantity: float, current_price: float) -> Order:
        """
        下达市价单
        
        Args:
            symbol: 品种代码
            direction: "buy" 或 "sell"
            quantity: 数量
            current_price: 当前价格
        
        Returns:
            Order: 成交的订单
        """
        if quantity <= 0:
            raise ValueError("Quantity must be positive")
        if current_price <= 0:
            raise ValueError("Price must be positive")
        
        # 检查单向持仓限制和余额
        pos = self.account.get_position(symbol)
        is_closing = False
        
        if pos is not None and abs(pos.quantity) > QUANTITY_EPSILON:
            # 已有持仓，检查是否是反向操作（平仓或反向开仓）
            if (pos.quantity > 0 and direction == "sell") or \
               (pos.quantity < 0 and direction == "buy"):
                # 反向操作：判断是平仓还是反向开仓
                if quantity > abs(pos.quantity):
                    # 超量，试图反向开仓
                    raise ValueError(f"不能反向开仓！当前持仓{'多头' if pos.quantity > 0 else '空头'} {abs(pos.quantity)}，只能平仓或减仓")
                else:
                    # 平仓或减仓
                    is_closing = True
        
        # 检查账户余额（仅对开仓或加仓检查，平仓不需要）
        if not is_closing:
            required_balance = quantity * current_price * (1 + COMMISSION_RATE)
            if self.account.balance < required_balance:
                raise ValueError(f"余额不足。需要: ${required_balance:.2f}, 可用: ${self.account.balance:.2f}")
        
        # 创建订单
        order = Order(
            id=str(uuid.uuid4()),
            symbol=symbol,
            direction=direction,
            type="market",
            quantity=quantity,
            price=current_price,
            create_time=int(datetime.utcnow().timestamp())
        )
        
        # 市价单立即成交
        self._fill_order(order, current_price)
        # Broadcast market order fill
        dispatch_event(self.account_id, {"type": "order", "order_id": order.id, "status": "filled"})
        return order
    
    def place_limit_order(self, symbol: str, direction: str, quantity: float, limit_price: float) -> Order:
        """
        下达限价单
        
        Args:
            symbol: 品种代码
            direction: "buy" 或 "sell"
            quantity: 数量
            limit_price: 限价
        
        Returns:
            Order: 创建的订单
        """
        if quantity <= 0:
            raise ValueError("Quantity must be positive")
        if limit_price <= 0:
            raise ValueError("Limit price must be positive")
        
        # 检查单向持仓限制
        pos = self.account.get_position(symbol)
        is_closing = False
        
        if pos is not None and abs(pos.quantity) > QUANTITY_EPSILON:
            # 已有持仓，检查是否是反向操作（平仓或反向开仓）
            if (pos.quantity > 0 and direction == "sell") or \
               (pos.quantity < 0 and direction == "buy"):
                # 反向操作：判断是平仓还是反向开仓
                if quantity > abs(pos.quantity):
                    # 超量，试图反向开仓
                    raise ValueError(f"不能反向开仓！当前持仓{'多头' if pos.quantity > 0 else '空头'} {abs(pos.quantity)}，只能平仓或减仓")
                else:
                    # 平仓或减仓
                    is_closing = True
        
        # 创建订单
        order = Order(
            id=str(uuid.uuid4()),
            symbol=symbol,
            direction=direction,
            type="limit",
            quantity=quantity,
            price=limit_price,
            create_time=int(datetime.utcnow().timestamp())
        )
        
        # 添加到订单列表
        self.account.orders.append(order)
        save_order(self.account_id, order)
        
        return order
    
    def try_fill_limit_orders(self, symbol: str, current_price: float, high: Optional[float] = None, low: Optional[float] = None) -> List[Order]:
        """
        尝试成交限价单
        
        Args:
            symbol: 品种代码
            current_price: 当前价格（收盘价）
            high: K线最高价（可选，用于更精确的成交判断）
            low: K线最低价（可选，用于更精确的成交判断）
        
        Returns:
            List[Order]: 成交的订单列表
        """
        filled_orders = []
        
        for order in self.account.orders[:]:
            if order.status != "open" or order.symbol != symbol:
                continue
            
            should_fill = False
            fill_price = current_price
            
            # 买入限价单：如果有最低价，检查最低价是否触及限价；否则用当前价
            if order.direction == "buy":
                if low is not None and low <= order.price:
                    should_fill = True
                    # 成交价为限价和最低价中的较高者（更接近真实情况）
                    fill_price = min(order.price, current_price)
                elif low is None and current_price <= order.price:
                    should_fill = True
                    fill_price = current_price
            
            # 卖出限价单：如果有最高价，检查最高价是否触及限价；否则用当前价
            elif order.direction == "sell":
                if high is not None and high >= order.price:
                    should_fill = True
                    # 成交价为限价和最高价中的较低者（更接近真实情况）
                    fill_price = max(order.price, current_price)
                elif high is None and current_price >= order.price:
                    should_fill = True
                    fill_price = current_price
            
            if should_fill:
                self._fill_order(order, fill_price)
                filled_orders.append(order)
                dispatch_event(self.account_id, {"type": "order", "order_id": order.id, "status": order.status})
        
        return filled_orders
    
    def _fill_order(self, order: Order, fill_price: float) -> None:
        """
        成交订单的内部方法
        
        Args:
            order: 订单对象
            fill_price: 成交价格
        """
        if order.filled_quantity >= order.quantity:
            return
        
        fill_qty = order.quantity - order.filled_quantity
        commission = fill_qty * fill_price * COMMISSION_RATE
        
        # 更新订单状态
        order.filled_quantity = order.quantity
        order.filled_price = fill_price
        order.filled_time = int(datetime.utcnow().timestamp())
        order.status = "filled"
        
        # 创建成交记录
        trade = Trade(
            id=str(uuid.uuid4()),
            symbol=order.symbol,
            direction=order.direction,
            quantity=fill_qty,
            price=fill_price,
            timestamp=order.filled_time,
            commission=commission
        )
        self.account.trades.append(trade)
        save_trade(self.account_id, trade)
        dispatch_event(self.account_id, {"type": "trade", "trade_id": trade.id, "symbol": trade.symbol, "price": trade.price, "qty": trade.quantity})
        
        # 更新仓位（会返回平仓盈亏）
        cash_flow = self._update_position(order.symbol, order.direction, fill_qty, fill_price)
        
        # 更新账户余额
        if cash_flow is not None:
            # 平仓：入账本次平仓成交额，扣除本次手续费
            self.account.balance += cash_flow - commission
        else:
            # 开/加仓：扣除本次成交成本与手续费
            self.account.balance -= fill_qty * fill_price + commission
        
        # 保存订单和账户
        save_order(self.account_id, order)
        save_account(self.account_id, self.account)
        positions_value = sum(abs(pos.quantity) * pos.entry_price for pos in self.account.positions)
        dispatch_event(self.account_id, {"type": "account", "balance": self.account.balance, "positions_value": positions_value})
    
    def _update_position(self, symbol: str, direction: str, quantity: float, price: float) -> Optional[float]:
        """
        更新仓位，并在平仓时记录已平仓持仓
        
        Args:
            symbol: 品种代码
            direction: "buy" 或 "sell"
            quantity: 数量
            price: 价格
        
        Returns:
            Optional[float]: 如果是平仓，返回本次平仓成交额（现金流入）；否则返回 None
        """
        pos = self.account.get_position(symbol)
        
        if pos is None:
            # 创建新仓位（开仓）
            qty = quantity if direction == "buy" else -quantity
            pos = Position(
                symbol=symbol,
                quantity=qty,
                entry_price=price,
                entry_time=int(datetime.utcnow().timestamp())
            )
            self.account.positions.append(pos)
            return None  # 开仓，没有盈亏
        else:
            # 更新现有仓位
            sign = 1 if direction == "buy" else -1
            qty_change = quantity * sign
            
            # 如果反向操作，可能平仓
            if (pos.quantity > 0 and qty_change < 0) or (pos.quantity < 0 and qty_change > 0):
                # 部分或全部平仓
                old_quantity = pos.quantity
                old_entry_price = pos.entry_price
                old_entry_time = pos.entry_time
                
                pos.quantity += qty_change
                
                # 检查是否完全平仓（使用容差值处理浮点数精度问题）
                if abs(pos.quantity) < QUANTITY_EPSILON:
                    # 完全平仓 - 记录已平仓持仓交易
                    closed_qty = abs(old_quantity)
                    profit_loss = 0
                    
                    if old_quantity > 0:  # 原来是多头
                        # 多头平仓收益 = 卖出价 - 买入价
                        profit_loss = (price - old_entry_price) * closed_qty
                    else:  # 原来是空头
                        # 空头平仓收益 = 建仓价 - 平仓价
                        profit_loss = (old_entry_price - price) * closed_qty
                    
                    # 计算手续费（仅用于记录）
                    commission = closed_qty * price * COMMISSION_RATE
                    
                    # 创建已平仓持仓记录（profit_loss 不扣除手续费，手续费单独记录）
                    closed_pos = ClosedPosition(
                        id=str(uuid.uuid4()),
                        symbol=symbol,
                        direction="buy" if old_quantity > 0 else "sell",
                        quantity=closed_qty,
                        entry_price=old_entry_price,
                        entry_time=old_entry_time,
                        exit_price=price,
                        exit_time=int(datetime.utcnow().timestamp()),
                        profit_loss=profit_loss,  # 纯价差盈亏
                        commission=commission
                    )
                    self.account.closed_positions.append(closed_pos)
                    dispatch_event(self.account_id, {"type": "closed_position", "id": closed_pos.id, "pnl": closed_pos.profit_loss, "symbol": closed_pos.symbol})
                    
                    # 从仓位列表中移除
                    self.account.positions.remove(pos)
                    
                    # 平仓现金流入 = 本次成交金额（已在开仓时扣除成本）
                    return closed_qty * price
                else:
                    # 部分平仓：入账本次平仓成交额
                    return quantity * price
            else:
                # 加仓
                old_qty = pos.quantity
                pos.quantity += qty_change
                # 更新平均成本
                if old_qty * qty_change >= 0:  # 同向加仓
                    total_cost = abs(old_qty) * pos.entry_price + quantity * price
                    pos.entry_price = total_cost / abs(pos.quantity)
                return None  # 加仓，没有平仓盈亏
    
    def cancel_order(self, order_id: str) -> bool:
        """
        取消订单
        
        Args:
            order_id: 订单ID
        
        Returns:
            bool: 是否成功取消
        """
        for order in self.account.orders:
            if order.id == order_id and order.status == "open":
                order.status = "cancelled"
                save_order(self.account_id, order)
                dispatch_event(self.account_id, {"type": "order", "order_id": order.id, "status": order.status})
                return True
        return False
    
    def set_position_tpsl(self, symbol: str, take_profit_price: Optional[float], stop_loss_price: Optional[float]) -> bool:
        """
        设置仓位的止盈止损价格
        
        Args:
            symbol: 品种代码
            take_profit_price: 止盈价格，None表示不设置
            stop_loss_price: 止损价格，None表示不设置
        
        Returns:
            bool: 是否成功设置
        """
        pos = self.account.get_position(symbol)
        if pos is None:
            raise ValueError(f"No position found for {symbol}")
        
        # 验证止盈止损价格的合理性
        if take_profit_price is not None and take_profit_price <= 0:
            raise ValueError("Take profit price must be positive")
        if stop_loss_price is not None and stop_loss_price <= 0:
            raise ValueError("Stop loss price must be positive")
        
        # 验证止盈止损方向
        if pos.quantity > 0:  # 多头
            if take_profit_price is not None and take_profit_price <= pos.entry_price:
                raise ValueError("Take profit price must be higher than entry price for long positions")
            if stop_loss_price is not None and stop_loss_price >= pos.entry_price:
                raise ValueError("Stop loss price must be lower than entry price for long positions")
        elif pos.quantity < 0:  # 空头
            if take_profit_price is not None and take_profit_price >= pos.entry_price:
                raise ValueError("Take profit price must be lower than entry price for short positions")
            if stop_loss_price is not None and stop_loss_price <= pos.entry_price:
                raise ValueError("Stop loss price must be higher than entry price for short positions")
        
        pos.take_profit_price = take_profit_price
        pos.stop_loss_price = stop_loss_price
        save_account(self.account_id, self.account)
        dispatch_event(self.account_id, {"type": "position", "symbol": symbol, "tp": take_profit_price, "sl": stop_loss_price})
        return True
    
    def check_tpsl_triggers(self, symbol: str, current_price: float, high: Optional[float] = None, low: Optional[float] = None) -> List[Order]:
        """
        检查并触发止盈止损
        
        Args:
            symbol: 品种代码
            current_price: 当前价格（收盘价）
            high: K线最高价（可选）
            low: K线最低价（可选）
        
        Returns:
            List[Order]: 触发的平仓订单列表
        """
        triggered_orders = []
        
        pos = self.account.get_position(symbol)
        if pos is None or abs(pos.quantity) < QUANTITY_EPSILON:
            return triggered_orders
        
        should_close = False
        reason = ""
        close_price = current_price
        
        if pos.quantity > 0:  # 多头
            if pos.take_profit_price is not None and ((high is not None and high >= pos.take_profit_price) or (high is None and current_price >= pos.take_profit_price)):
                should_close = True
                reason = "止盈"
                close_price = pos.take_profit_price
            if not should_close and pos.stop_loss_price is not None and ((low is not None and low <= pos.stop_loss_price) or (low is None and current_price <= pos.stop_loss_price)):
                should_close = True
                reason = "止损"
                close_price = pos.stop_loss_price
        elif pos.quantity < 0:  # 空头
            if pos.take_profit_price is not None and ((low is not None and low <= pos.take_profit_price) or (low is None and current_price <= pos.take_profit_price)):
                should_close = True
                reason = "止盈"
                close_price = pos.take_profit_price
            if not should_close and pos.stop_loss_price is not None and ((high is not None and high >= pos.stop_loss_price) or (high is None and current_price >= pos.stop_loss_price)):
                should_close = True
                reason = "止损"
                close_price = pos.stop_loss_price
        
        if should_close:
            # 触发平仓
            direction = "sell" if pos.quantity > 0 else "buy"
            quantity = abs(pos.quantity)
            order = self.place_market_order(symbol, direction, quantity, close_price)
            triggered_orders.append(order)
            print(f"[TradingEngine] {reason}触发: {symbol} @ {close_price}, 平仓数量: {quantity}")
        
        return triggered_orders
    
    def calculate_stats(self) -> AccountStats:
        """
        计算账户统计数据，基于已平仓的完整交易
        
        Returns:
            AccountStats: 统计数据
        """
        stats = AccountStats()
        
        # 如果没有已平仓的交易，返回默认统计
        if not self.account.closed_positions:
            save_account_stats(self.account_id, stats)
            return stats
        
        closed_pos = self.account.closed_positions
        
        # 基本统计
        stats.total_trades = len(closed_pos)
        stats.winning_trades = len([p for p in closed_pos if p.profit_loss > 0])
        stats.losing_trades = len([p for p in closed_pos if p.profit_loss < 0])
        
        if stats.total_trades > 0:
            stats.win_rate = stats.winning_trades / stats.total_trades
        
        # 计算盈利因子
        profits = sum(p.profit_loss for p in closed_pos if p.profit_loss > 0)
        losses = abs(sum(p.profit_loss for p in closed_pos if p.profit_loss < 0))
        
        stats.total_profit = profits
        stats.total_loss = losses
        
        if losses > 0:
            stats.profit_factor = profits / losses
        
        # 计算期望值
        if stats.total_trades > 0:
            avg_profit = profits / stats.winning_trades if stats.winning_trades > 0 else 0
            avg_loss = losses / stats.losing_trades if stats.losing_trades > 0 else 0
            stats.expectancy = (stats.win_rate * avg_profit) - ((1 - stats.win_rate) * avg_loss)
        
        # 计算累计收益和总回报
        total_pnl = sum(p.profit_loss for p in closed_pos)
        stats.total_return = total_pnl
        stats.cumulative_return = total_pnl / self.account.initial_balance if self.account.initial_balance > 0 else 0
        
        # 计算最大回撤
        stats.max_drawdown, stats.max_drawdown_pct = self._calculate_max_drawdown_from_closed_positions()
        
        # 计算夏普比率和CAGR
        stats.sharpe_ratio = self._calculate_sharpe_ratio_from_closed_positions()
        stats.cagr = self._calculate_cagr_from_closed_positions()
        
        save_account_stats(self.account_id, stats)
        return stats
    
    def _calculate_max_drawdown_from_closed_positions(self) -> Tuple[float, float]:
        """
        从已平仓持仓计算最大回撤
        
        Returns:
            Tuple[float, float]: (最大回撤额, 最大回撤%)
        """
        if not self.account.closed_positions:
            return 0.0, 0.0
        
        cumulative = 0
        peak = 0
        max_drawdown = 0
        
        for pos in sorted(self.account.closed_positions, key=lambda p: p.exit_time):
            cumulative += pos.profit_loss
            peak = max(peak, cumulative)
            drawdown = peak - cumulative
            max_drawdown = max(max_drawdown, drawdown)
        
        max_drawdown_pct = (max_drawdown / self.account.initial_balance * 100) if self.account.initial_balance > 0 else 0
        
        return max_drawdown, max_drawdown_pct
    
    def _calculate_sharpe_ratio_from_closed_positions(self) -> float:
        """
        从已平仓持仓计算夏普比率
        
        Returns:
            float: 夏普比率
        """
        if len(self.account.closed_positions) < 2:
            return 0.0
        
        returns = [p.profit_loss / self.account.initial_balance for p in self.account.closed_positions]
        
        mean_return = sum(returns) / len(returns)
        variance = sum((r - mean_return) ** 2 for r in returns) / len(returns)
        std_dev = math.sqrt(variance) if variance > 0 else 0
        
        # Prevent division by zero and extreme values
        if std_dev < 1e-10:
            return 0.0
        
        # 假设无风险利率为 0
        risk_free_rate = 0
        sharpe_ratio = (mean_return - risk_free_rate) / std_dev
        
        # Clamp to reasonable range
        if abs(sharpe_ratio) > 100:
            return 100.0 if sharpe_ratio > 0 else -100.0
        
        return sharpe_ratio
    
    def _calculate_cagr_from_closed_positions(self) -> float:
        """
        从已平仓持仓计算年化收益率 (CAGR)
        
        Returns:
            float: CAGR
        """
        if not self.account.closed_positions:
            return 0.0
        
        first_exit = min(p.exit_time for p in self.account.closed_positions)
        last_exit = max(p.exit_time for p in self.account.closed_positions)
        
        years = (last_exit - first_exit) / (365.25 * 86400)
        if years <= 0:
            return 0.0
        
        total_return = sum(p.profit_loss for p in self.account.closed_positions)
        end_value = self.account.initial_balance + total_return
        
        if self.account.initial_balance <= 0 or end_value <= 0:
            return 0.0
        
        # Prevent overflow for very small time periods
        if years < 0.00273973:  # Less than 1 hour
            return 0.0
        
        try:
            cagr = (end_value / self.account.initial_balance) ** (1 / years) - 1
            # Clamp to reasonable range to prevent NaN/Inf
            if not (-10 < cagr < 10):
                return 0.0
            return cagr
        except (OverflowError, ValueError):
            return 0.0


def get_trading_engine(account_id: int, account: Account) -> TradingEngine:
    """Get a trading engine instance."""
    return TradingEngine(account_id, account)
