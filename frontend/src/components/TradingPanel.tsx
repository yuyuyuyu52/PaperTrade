/**
 * Trading Panel Component
 */

import { useState, useEffect, useCallback } from "react";
import { Account, Order, Trade, ClosedPosition, AccountStats } from "../types/trading";
import { Mode, Interval } from "../types";
import {
  getAccount,
  placeOrder,
  listOrders,
  cancelOrder,
  listTrades,
  listClosedPositions,
  getAccountStats,
  closePosition,
  setPositionTpSl,
} from "../services/tradingApi";
import "./TradingPanel.css";

interface TradingPanelProps {
  mode: Mode;
  symbol: string;
  interval: Interval;
  currentPrice: number;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

export function TradingPanel({
  mode,
  symbol,
  interval,
  currentPrice,
  isExpanded,
  onToggleExpand,
}: TradingPanelProps) {
  const [account, setAccount] = useState<Account | null>(null);
  const [stats, setStats] = useState<Partial<AccountStats> | null>(null);
  const [closedPositions, setClosedPositions] = useState<ClosedPosition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Order form state
  const [orderDirection, setOrderDirection] = useState<"buy" | "sell">("buy");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [orderQuantity, setOrderQuantity] = useState<string>("1");
  const [orderPrice, setOrderPrice] = useState<string>("");
  const [orderSubmitting, setOrderSubmitting] = useState(false);

  // TP/SL modal state
  const [tpslOpen, setTpslOpen] = useState(false);
  const [tpslSymbol, setTpslSymbol] = useState<string | null>(null);
  const [tpInput, setTpInput] = useState<string>("");
  const [slInput, setSlInput] = useState<string>("");

  // Refresh account data
  const refreshAccount = useCallback(async () => {
    try {
      setLoading(true);
      const tradingMode = mode === "realtime" ? "realtime" : "playback";
      const [acc, st, closed] = await Promise.all([
        getAccount(tradingMode, symbol, interval),
        getAccountStats(tradingMode, symbol, interval),
        listClosedPositions(tradingMode, symbol, interval)
      ]);
      setAccount(acc);
      setStats(st);
      setClosedPositions(closed || []);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [mode, symbol, interval]);

  // Load account on mount and when params change
  useEffect(() => {
    refreshAccount();
    const interval_id = setInterval(refreshAccount, 3000); // Auto refresh every 3s
    return () => clearInterval(interval_id);
  }, [refreshAccount]);

  // Handle order submission
  const handlePlaceOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setOrderSubmitting(true);
      setError(null);
      
      const qty = parseFloat(orderQuantity);
      if (qty <= 0) {
        setError("数量必须大于 0");
        setOrderSubmitting(false);
        return;
      }

      const tradingMode = mode === "realtime" ? "realtime" : "playback";
      const limitPrice = orderType === "limit" ? parseFloat(orderPrice) : undefined;
      
      // 调试日志
      console.log("下单请求:", {
        mode: tradingMode,
        symbol: symbol.toUpperCase(),
        interval,
        direction: orderDirection,
        type: orderType,
        quantity: qty,
        currentPrice,
        limitPrice
      });

      await placeOrder(tradingMode, symbol.toUpperCase(), interval, orderDirection, orderType, qty, currentPrice, limitPrice);

      // Reset form
      setOrderQuantity("1");
      setOrderPrice("");
      
      // Refresh data
      await refreshAccount();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("下单错误:", errorMsg);
      setError(`下单失败: ${errorMsg}`);
    } finally {
      setOrderSubmitting(false);
    }
  };

  // Handle order cancellation
  const handleCancelOrder = async (orderId: string) => {
    try {
      const tradingMode = mode === "realtime" ? "realtime" : "playback";
      await cancelOrder(orderId, tradingMode, symbol, interval);
      await refreshAccount();
    } catch (err) {
      setError(String(err));
    }
  };

  // Handle close position (market)
  const handleClosePosition = async (posQty: number) => {
    try {
      const tradingMode = mode === "realtime" ? "realtime" : "playback";
      console.log("[ClosePosition] Closing position:", {
        symbol,
        posQty,
        direction: posQty > 0 ? "sell" : "buy",
        qty: Math.abs(posQty),
        currentPrice
      });
      await closePosition(tradingMode, symbol, interval, posQty, currentPrice);
      await refreshAccount();
      console.log("[ClosePosition] Success");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[ClosePosition] Error:", errorMsg);
      setError(`平仓失败: ${errorMsg}`);
    }
  };

  // Handle TP/SL update
  const handleUpdateTpsl = async () => {
    if (!tpslSymbol) return;
    
    try {
      const tradingMode = mode === "realtime" ? "realtime" : "playback";
      const tp = tpInput ? parseFloat(tpInput) : null;
      const sl = slInput ? parseFloat(slInput) : null;
      
      // Validate inputs
      if (tpInput && isNaN(tp!)) {
        setError("止盈价格格式错误");
        return;
      }
      if (slInput && isNaN(sl!)) {
        setError("止损价格格式错误");
        return;
      }
      
      await setPositionTpSl(tradingMode, tpslSymbol, interval, tp, sl);
      
      console.log("更新止盈止损成功:", { symbol: tpslSymbol, tp, sl });
      setTpslOpen(false);
      setError(null);
      await refreshAccount();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("设置止盈止损失败:", errorMsg);
      setError(`设置失败: ${errorMsg}`);
    }
  };

  // Handle reset account
  const handleResetAccount = async () => {
    if (!confirm("确定要重置账户吗？所有持仓、订单和交易记录将被清空，账户余额将恢复到初始值。")) {
      return;
    }
    
    try {
      const tradingMode = mode === "realtime" ? "realtime" : "playback";
      const response = await fetch(
        `/api/accounts/${tradingMode}/${symbol.toUpperCase()}/${interval}/reset`,
        { method: "POST" }
      );
      
      if (!response.ok) {
        throw new Error("重置账户失败");
      }
      
      console.log("[ResetAccount] Account reset successfully");
      await refreshAccount();
      setError(null);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[ResetAccount] Error:", errorMsg);
      setError(`重置失败: ${errorMsg}`);
    }
  };

  if (!account) {
    return (
      <div className="trading-panel trading-panel-collapsed">
        <button className="trading-toggle-btn" onClick={onToggleExpand}>
          交易 {isExpanded ? "▼" : "▲"}
        </button>
      </div>
    );
  }

  const validPositions = account.positions.filter(p => Math.abs(p.quantity) > 1e-10);
  
  // 计算持仓市值
  const positionValue = validPositions.reduce((sum, p) => {
    return sum + Math.abs(p.quantity) * currentPrice;
  }, 0);
  
  // 账户余额 = 现金余额 + 持仓市值
  const accountBalance = account.balance + positionValue;
  
  // 当前盈亏 = 未平仓持仓的浮动盈亏
  const currentPnl = validPositions.reduce((sum, p) => {
    let pnl;
    if (p.quantity > 0) {
      // 多头：盈亏 = (当前价 - 建仓价) × 数量
      pnl = (currentPrice - p.entry_price) * p.quantity;
    } else {
      // 空头：盈亏 = (建仓价 - 当前价) × 数量
      pnl = (p.entry_price - currentPrice) * Math.abs(p.quantity);
    }
    return sum + pnl;
  }, 0);
  
  // 总盈亏 = 已平仓的实现盈亏累计
  const totalPnl = account.closed_positions.reduce((sum: number, cp: ClosedPosition) => {
    return sum + cp.profit_loss;
  }, 0);

  return (
    <div className={`trading-panel ${isExpanded ? "trading-panel-expanded" : "trading-panel-collapsed"}`}>
      <div className="trading-panel-header">
        <div className="header-title">
          <h3>交易面板</h3>
          <button className="trading-toggle-btn" onClick={onToggleExpand}>
            {isExpanded ? "▼ 收起" : "▲ 展开"}
          </button>
        </div>
        
        {/* Account Summary in Header */}
        <div className="header-account-info">
          <div className="account-info-item">
            <label>账户余额</label>
            <span>${accountBalance.toFixed(2)}</span>
          </div>
          <div className="account-info-item">
            <label>当前盈亏</label>
            <span className={currentPnl >= 0 ? "gain" : "loss"}>
              {currentPnl >= 0 ? '+' : ''}{currentPnl.toFixed(2)}
            </span>
          </div>
          <div className="account-info-item">
            <label>总盈亏</label>
            <span className={totalPnl >= 0 ? "gain" : "loss"}>
              {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}
            </span>
          </div>
          <button className="reset-account-btn" onClick={handleResetAccount}>
            重置账户
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="trading-panel-content">

          {/* Positions */}
          {account.positions.length > 0 && (
            <div className="trading-section">
              <h4>持仓信息</h4>
              <table className="trading-table">
                <thead>
                  <tr>
                    <th>品种</th>
                    <th>数量</th>
                    <th>建仓价</th>
                    <th>当前价</th>
                    <th>浮动盈亏</th>
                    <th>盈亏%</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {account.positions
                    .filter(pos => Math.abs(pos.quantity) > 1e-10)
                    .map((pos) => {
                    // 计算浮动盈亏
                    let pnl;
                    if (pos.quantity > 0) {
                      // 多头：盈亏 = (当前价 - 建仓价) × 数量
                      pnl = (currentPrice - pos.entry_price) * pos.quantity;
                    } else {
                      // 空头：盈亏 = (建仓价 - 当前价) × 数量（取绝对值）
                      pnl = (pos.entry_price - currentPrice) * Math.abs(pos.quantity);
                    }
                    const pnlPct = (pnl / (Math.abs(pos.quantity) * pos.entry_price)) * 100;
                    return (
                      <tr key={pos.symbol}>
                        <td>{pos.symbol}</td>
                        <td className={pos.quantity > 0 ? "long" : "short"}>
                          {pos.quantity > 0 ? "+" : ""}{pos.quantity.toFixed(4)}
                        </td>
                        <td>${pos.entry_price.toFixed(2)}</td>
                        <td>${currentPrice.toFixed(2)}</td>
                        <td className={pnl >= 0 ? "gain" : "loss"}>${pnl.toFixed(2)}</td>
                        <td className={pnlPct >= 0 ? "gain" : "loss"}>{pnlPct.toFixed(2)}%</td>
                        <td style={{ display: "flex", gap: 8 }}>
                          <button className="cancel-btn" onClick={() => handleClosePosition(pos.quantity)}>
                            平仓
                          </button>
                          <button
                            className="cancel-btn"
                            onClick={() => {
                              console.info('[TP/SL] open clicked for', pos.symbol);
                              setTpslSymbol(pos.symbol);
                              setTpInput(pos.take_profit_price != null ? String(pos.take_profit_price) : "");
                              setSlInput(pos.stop_loss_price != null ? String(pos.stop_loss_price) : "");
                              setTpslOpen(true);
                            }}
                          >
                            止盈/止损
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Order Form */}
          <div className="trading-section">
            <h4>下单</h4>
            <form onSubmit={handlePlaceOrder} className="order-form">
              <div className="form-row">
                <div className="form-group">
                  <label>方向</label>
                  <select value={orderDirection} onChange={(e) => setOrderDirection(e.target.value as any)}>
                    <option value="buy">买入 (做多)</option>
                    <option value="sell">卖出 (做空)</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>类型</label>
                  <select value={orderType} onChange={(e) => setOrderType(e.target.value as any)}>
                    <option value="market">市价单</option>
                    <option value="limit">限价单</option>
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>数量</label>
                  <input
                    type="number"
                    value={orderQuantity}
                    onChange={(e) => setOrderQuantity(e.target.value)}
                    step="0.0001"
                    min="0"
                    placeholder="1"
                  />
                </div>
                {orderType === "limit" && (
                  <div className="form-group">
                    <label>限价</label>
                    <input
                      type="number"
                      value={orderPrice}
                      onChange={(e) => setOrderPrice(e.target.value)}
                      step="0.01"
                      min="0"
                      placeholder={currentPrice.toFixed(2)}
                    />
                  </div>
                )}
              </div>

              <button type="submit" className={`order-submit-btn ${orderDirection}`} disabled={orderSubmitting}>
                {orderSubmitting ? "提交中..." : orderDirection === "buy" ? "买入" : "卖出"}
              </button>
            </form>
          </div>

          {/* Open Orders */}
          {account.orders.filter((o) => o.status === "open").length > 0 && (
            <div className="trading-section">
              <h4>未成交订单</h4>
              <table className="trading-table">
                <thead>
                  <tr>
                    <th>方向</th>
                    <th>类型</th>
                    <th>数量</th>
                    <th>价格</th>
                    <th>时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {account.orders
                    .filter((o) => o.status === "open")
                    .map((order) => (
                      <tr key={order.id}>
                        <td className={order.direction === "buy" ? "long" : "short"}>
                          {order.direction === "buy" ? "买入" : "卖出"}
                        </td>
                        <td>{order.type === "market" ? "市价" : "限价"}</td>
                        <td>{order.quantity.toFixed(4)}</td>
                        <td>${order.price?.toFixed(2) || "-"}</td>
                        <td>{new Date(order.create_time * 1000).toLocaleTimeString()}</td>
                        <td>
                          <button
                            className="cancel-btn"
                            onClick={() => handleCancelOrder(order.id)}
                          >
                            取消
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Closed Positions (Complete Trades) */}
          {closedPositions.length > 0 && (
            <div className="trading-section">
              <h4>交易历史 ({closedPositions.length})</h4>
              <div style={{ overflowX: "auto", maxHeight: "300px", overflowY: "auto" }}>
                <table className="trading-table">
                  <thead>
                    <tr>
                      <th>方向</th>
                      <th>数量</th>
                      <th>开仓价</th>
                      <th>平仓价</th>
                      <th>持仓天数</th>
                      <th>盈亏</th>
                      <th>收益率</th>
                      <th>手续费</th>
                    </tr>
                  </thead>
                  <tbody>
                    {closedPositions.map((cp) => (
                      <tr key={cp.id}>
                        <td className={cp.direction === "buy" ? "long" : "short"}>
                          {cp.direction === "buy" ? "做多" : "做空"}
                        </td>
                        <td>{cp.quantity.toFixed(4)}</td>
                        <td>${cp.entry_price.toFixed(2)}</td>
                        <td>${cp.exit_price.toFixed(2)}</td>
                        <td>{cp.days_held.toFixed(2)}</td>
                        <td className={cp.profit_loss >= 0 ? "gain" : "loss"}>
                          ${cp.profit_loss.toFixed(2)}
                        </td>
                        <td className={cp.return_pct >= 0 ? "gain" : "loss"}>
                          {cp.return_pct.toFixed(2)}%
                        </td>
                        <td>${cp.commission.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Statistics */}
          {stats && (stats.total_trades ?? 0) > 0 && (
            <div className="trading-section">
              <h4>交易统计</h4>
              <div className="trading-stats-grid">
                <div className="stat-item">
                  <label>总交易数</label>
                  <span>{stats.total_trades}</span>
                </div>
                <div className="stat-item">
                  <label>胜率</label>
                  <span>{(((stats.win_rate ?? 0) as number) * 100).toFixed(2)}%</span>
                </div>
                <div className="stat-item">
                  <label>盈利因子</label>
                  <span>{((stats.profit_factor ?? 0) as number).toFixed(2)}</span>
                </div>
                <div className="stat-item">
                  <label>期望值</label>
                  <span>${((stats.expectancy ?? 0) as number).toFixed(2)}</span>
                </div>
                <div className="stat-item">
                  <label>最大回撤</label>
                  <span>{(((stats.max_drawdown_pct ?? 0) as number) * 100).toFixed(2)}%</span>
                </div>
                <div className="stat-item">
                  <label>夏普比率</label>
                  <span>{((stats.sharpe_ratio ?? 0) as number).toFixed(2)}</span>
                </div>
                <div className="stat-item">
                  <label>CAGR</label>
                  <span>{(((stats.cagr ?? 0) as number) * 100).toFixed(2)}%</span>
                </div>
                <div className="stat-item">
                  <label>累计收益</label>
                  <span className={(stats.total_return ?? 0) >= 0 ? "gain" : "loss"}>
                    ${((stats.total_return ?? 0) as number).toFixed(2)}
                  </span>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="trading-error">
              <span>错误: {error}</span>
            </div>
          )}
        </div>
      )}

      {/* TP/SL Modal */}
      {tpslOpen && (
        <div className="modal-overlay" onClick={() => setTpslOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>设置止盈止损 - {tpslSymbol}</h3>
            <div className="modal-body">
              <div className="form-group">
                <label>止盈价格 (Take Profit)</label>
                <input
                  type="number"
                  value={tpInput}
                  onChange={(e) => setTpInput(e.target.value)}
                  step="0.01"
                  placeholder="留空表示不设置"
                />
              </div>
              <div className="form-group">
                <label>止损价格 (Stop Loss)</label>
                <input
                  type="number"
                  value={slInput}
                  onChange={(e) => setSlInput(e.target.value)}
                  step="0.01"
                  placeholder="留空表示不设置"
                />
              </div>
              <div className="modal-actions">
                <button className="cancel-btn" onClick={() => setTpslOpen(false)}>
                  取消
                </button>
                <button className="order-submit-btn buy" onClick={handleUpdateTpsl}>
                  确认
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default TradingPanel;
