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
  getAccountStats
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
  const totalValue = account.balance + validPositions.reduce((sum, p) => sum + Math.abs(p.quantity) * currentPrice, 0);
  const floatingPnl = validPositions.reduce((sum, p) => {
    const pnl = p.quantity > 0
      ? p.quantity * (currentPrice - p.entry_price)
      : p.quantity * (p.entry_price - currentPrice);
    return sum + pnl;
  }, 0);

  return (
    <div className={`trading-panel ${isExpanded ? "trading-panel-expanded" : "trading-panel-collapsed"}`}>
      <div className="trading-panel-header">
        <h3>交易面板</h3>
        <button className="trading-toggle-btn" onClick={onToggleExpand}>
          {isExpanded ? "▼ 收起" : "▲ 展开"}
        </button>
      </div>

      {isExpanded && (
        <div className="trading-panel-content">
          {/* Account Summary */}
          <div className="trading-section">
            <h4>账户信息</h4>
            <div className="trading-info-grid">
              <div className="info-item">
                <label>初始本金</label>
                <span>${account.initial_balance.toFixed(2)}</span>
              </div>
              <div className="info-item">
                <label>当前余额</label>
                <span>${account.balance.toFixed(2)}</span>
              </div>
              <div className="info-item">
                <label>总账户价值</label>
                <span>${totalValue.toFixed(2)}</span>
              </div>
              <div className="info-item">
                <label>浮动盈亏</label>
                <span className={floatingPnl >= 0 ? "gain" : "loss"}>${floatingPnl.toFixed(2)}</span>
              </div>
            </div>
          </div>

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
                  </tr>
                </thead>
                <tbody>
                  {account.positions
                    .filter(pos => Math.abs(pos.quantity) > 1e-10)
                    .map((pos) => {
                    const pnl = pos.quantity > 0
                      ? pos.quantity * (currentPrice - pos.entry_price)
                      : pos.quantity * (pos.entry_price - currentPrice);
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
    </div>
  );
}

export default TradingPanel;
