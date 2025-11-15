/**
 * Trading Panel Component
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Account, Order, Trade, ClosedPosition, AccountStats } from "../types/trading";
import { Mode, Interval } from "../types";
import {
  getAccount,
  placeOrder,
  cancelOrder,
  listClosedPositions,
  getAccountStats,
  closePosition,
  setPositionTpSl,
  resetAccount,
  listOrders,
  listTrades,
} from "../services/tradingApi";
import "./TradingPanel.css";

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 500;

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
  const [stats, setStats] = useState<AccountStats | null>(null);

  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersTotal, setOrdersTotal] = useState(0);
  const [ordersLimit, setOrdersLimit] = useState(DEFAULT_PAGE_LIMIT);
  const [ordersHasMore, setOrdersHasMore] = useState(false);
  const [ordersLoadingMore, setOrdersLoadingMore] = useState(false);

  const [trades, setTrades] = useState<Trade[]>([]);
  const [tradesTotal, setTradesTotal] = useState(0);
  const [tradesLimit, setTradesLimit] = useState(DEFAULT_PAGE_LIMIT);
  const [tradesHasMore, setTradesHasMore] = useState(false);
  const [tradesLoadingMore, setTradesLoadingMore] = useState(false);

  const [closedPositions, setClosedPositions] = useState<ClosedPosition[]>([]);
  const [closedTotal, setClosedTotal] = useState(0);
  const [closedLimit, setClosedLimit] = useState(DEFAULT_PAGE_LIMIT);
  const [closedHasMore, setClosedHasMore] = useState(false);
  const [closedLoadingMore, setClosedLoadingMore] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeListTab, setActiveListTab] = useState<"orders" | "trades" | "history">("orders");

  const ordersLimitRef = useRef(ordersLimit);
  const tradesLimitRef = useRef(tradesLimit);
  const closedLimitRef = useRef(closedLimit);

  useEffect(() => {
    ordersLimitRef.current = ordersLimit;
  }, [ordersLimit]);

  useEffect(() => {
    tradesLimitRef.current = tradesLimit;
  }, [tradesLimit]);

  useEffect(() => {
    closedLimitRef.current = closedLimit;
  }, [closedLimit]);

  type LimitOverrides = {
    ordersLimit?: number;
    tradesLimit?: number;
    closedLimit?: number;
  };

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
  const refreshAccount = useCallback(
    async (overrides?: LimitOverrides) => {
      const effectiveOrdersLimit = overrides?.ordersLimit ?? ordersLimitRef.current;
      const effectiveTradesLimit = overrides?.tradesLimit ?? tradesLimitRef.current;
      const effectiveClosedLimit = overrides?.closedLimit ?? closedLimitRef.current;

      const isFullRefresh = !overrides;

      try {
        if (isFullRefresh) {
          setLoading(true);
        }

        const requestContext = {
          mode,
          interval,
        } as const;

        const [acc, st, ordersResponse, tradesResponse, closedResponse] = await Promise.all([
          getAccount(symbol, {
            ...requestContext,
            ordersLimit: effectiveOrdersLimit,
            tradesLimit: effectiveTradesLimit,
            closedLimit: effectiveClosedLimit,
          }),
          getAccountStats(symbol, requestContext),
          listOrders(symbol, { ...requestContext, limit: effectiveOrdersLimit }),
          listTrades(symbol, { ...requestContext, limit: effectiveTradesLimit }),
          listClosedPositions(symbol, { ...requestContext, limit: effectiveClosedLimit }),
        ]);

        setAccount(acc);
        setStats(st);

        setOrders(ordersResponse.items);
        setOrdersTotal(ordersResponse.total);
        setOrdersHasMore(ordersResponse.has_more);

        setTrades(tradesResponse.items);
        setTradesTotal(tradesResponse.total);
        setTradesHasMore(tradesResponse.has_more);

        setClosedPositions(closedResponse.items);
        setClosedTotal(closedResponse.total);
        setClosedHasMore(closedResponse.has_more);

        setError(null);

        if (overrides?.ordersLimit != null) {
          ordersLimitRef.current = overrides.ordersLimit;
          setOrdersLimit(overrides.ordersLimit);
        }
        if (overrides?.tradesLimit != null) {
          tradesLimitRef.current = overrides.tradesLimit;
          setTradesLimit(overrides.tradesLimit);
        }
        if (overrides?.closedLimit != null) {
          closedLimitRef.current = overrides.closedLimit;
          setClosedLimit(overrides.closedLimit);
        }
      } catch (err) {
        setError(String(err));
      } finally {
        if (isFullRefresh) {
          setLoading(false);
        }
      }
    },
    [symbol, mode, interval]
  );

  // Load account on mount and when params change
  useEffect(() => {
    refreshAccount();
    const interval_id = setInterval(refreshAccount, 3000); // Auto refresh every 3s
    return () => clearInterval(interval_id);
  }, [refreshAccount]);

  const handleLoadMoreOrders = async () => {
    if (!ordersHasMore) {
      return;
    }
    const nextLimit = Math.min(ordersLimitRef.current + DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    if (nextLimit === ordersLimitRef.current) {
      return;
    }
    try {
      setOrdersLoadingMore(true);
      await refreshAccount({ ordersLimit: nextLimit });
    } catch (err) {
      setError(String(err));
    } finally {
      setOrdersLoadingMore(false);
    }
  };

  const handleLoadMoreTrades = async () => {
    if (!tradesHasMore) {
      return;
    }
    const nextLimit = Math.min(tradesLimitRef.current + DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    if (nextLimit === tradesLimitRef.current) {
      return;
    }
    try {
      setTradesLoadingMore(true);
      await refreshAccount({ tradesLimit: nextLimit });
    } catch (err) {
      setError(String(err));
    } finally {
      setTradesLoadingMore(false);
    }
  };

  const handleLoadMoreClosed = async () => {
    if (!closedHasMore) {
      return;
    }
    const nextLimit = Math.min(closedLimitRef.current + DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    if (nextLimit === closedLimitRef.current) {
      return;
    }
    try {
      setClosedLoadingMore(true);
      await refreshAccount({ closedLimit: nextLimit });
    } catch (err) {
      setError(String(err));
    } finally {
      setClosedLoadingMore(false);
    }
  };

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

      let limitPrice: number | undefined;
      if (orderType === "limit") {
        const parsed = parseFloat(orderPrice);
        if (Number.isNaN(parsed) || parsed <= 0) {
          setError("请输入有效的限价");
          setOrderSubmitting(false);
          return;
        }
        limitPrice = parsed;
      }

      // 调试日志
      console.log("下单请求:", {
        symbol: symbol.toUpperCase(),
        direction: orderDirection,
        type: orderType,
        quantity: qty,
        price_source: "panel",
        limitPrice,
        currentPrice
      });

      await placeOrder(
        symbol.toUpperCase(),
        orderDirection,
        orderType,
        qty,
        {
          mode,
          interval,
          limitPrice,
          currentPrice
        }
      );

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
      await cancelOrder(orderId, symbol, { mode, interval });
      await refreshAccount();
    } catch (err) {
      setError(String(err));
    }
  };

  // Handle close position (market)
  const handleClosePosition = async (posQty: number) => {
    try {
      console.log("[ClosePosition] Closing position:", {
        symbol,
        posQty,
        direction: posQty > 0 ? "sell" : "buy",
        qty: Math.abs(posQty),
        currentPrice
      });
      await closePosition(symbol, posQty, { mode, interval, currentPrice });
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
      
      await setPositionTpSl(tpslSymbol, tp, sl, { mode, interval });
      
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
      await resetAccount(symbol, { mode, interval });
      console.log("[ResetAccount] Account reset successfully");
      await refreshAccount({
        ordersLimit: DEFAULT_PAGE_LIMIT,
        tradesLimit: DEFAULT_PAGE_LIMIT,
        closedLimit: DEFAULT_PAGE_LIMIT,
      });
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

  // 持仓市值（按当前价计算）
  const positionValue = validPositions.reduce((sum, p) => {
    return sum + Math.abs(p.quantity) * currentPrice;
  }, 0);

  // 未实现盈亏
  const unrealizedPnl = validPositions.reduce((sum, p) => {
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
  
  // 实现盈亏累积（使用统计数据）
  const realizedPnl = stats?.total_return ?? 0;

  const availableBalance = account.balance;
  const totalEquity = availableBalance + positionValue + unrealizedPnl;

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
            <label>模式</label>
            <span>{mode === "realtime" ? "实时" : "回放"}</span>
          </div>
          <div className="account-info-item">
            <label>周期</label>
            <span>{interval}</span>
          </div>
          <div className="account-info-item">
            <label>可用余额</label>
            <span>${availableBalance.toFixed(2)}</span>
          </div>
          <div className="account-info-item">
            <label>仓位市值</label>
            <span>${positionValue.toFixed(2)}</span>
          </div>
          <div className="account-info-item">
            <label>P&amp;L</label>
            <span className={unrealizedPnl >= 0 ? "gain" : "loss"}>
              {unrealizedPnl >= 0 ? '+' : ''}{unrealizedPnl.toFixed(2)}
            </span>
          </div>
          <div className="account-info-item">
            <label>总权益</label>
            <span>${totalEquity.toFixed(2)}</span>
          </div>
          <div className="account-info-item">
            <label>总盈亏</label>
            <span className={realizedPnl >= 0 ? "gain" : "loss"}>
              {realizedPnl >= 0 ? '+' : ''}{realizedPnl.toFixed(2)}
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

          {/* Orders / Trades / Closed Positions */}
          <div className="trading-section tabbed-section">
            <div className="tab-section-header">
              <h4>订单与记录</h4>
              <div className="data-tab-bar">
                <button
                  type="button"
                  className={`data-tab ${activeListTab === "orders" ? "active" : ""}`}
                  onClick={() => setActiveListTab("orders")}
                >
                  订单
                  <span className="tab-count">{orders.length}/{ordersTotal}</span>
                </button>
                <button
                  type="button"
                  className={`data-tab ${activeListTab === "trades" ? "active" : ""}`}
                  onClick={() => setActiveListTab("trades")}
                >
                  成交
                  <span className="tab-count">{trades.length}/{tradesTotal}</span>
                </button>
                <button
                  type="button"
                  className={`data-tab ${activeListTab === "history" ? "active" : ""}`}
                  onClick={() => setActiveListTab("history")}
                >
                  历史持仓
                  <span className="tab-count">{closedPositions.length}/{closedTotal}</span>
                </button>
              </div>
            </div>

            <div className="tab-content">
              {activeListTab === "orders" && (
                orders.length === 0 ? (
                  <div className="empty-state">暂无订单</div>
                ) : (
                  <table className="trading-table">
                    <thead>
                      <tr>
                        <th>方向</th>
                        <th>类型</th>
                        <th>数量</th>
                        <th>委托价</th>
                        <th>成交情况</th>
                        <th>状态</th>
                        <th>时间</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orders.map((order) => {
                        const statusLabel = order.status === "open" ? "挂单" : order.status === "filled" ? "已成交" : "已取消";
                        const filledText =
                          order.filled_quantity != null && order.filled_quantity > 0
                            ? `${order.filled_quantity.toFixed(4)} @ $${order.filled_price?.toFixed(2) ?? "-"}`
                            : "-";
                        return (
                          <tr key={order.id}>
                            <td className={order.direction === "buy" ? "long" : "short"}>
                              {order.direction === "buy" ? "买入" : "卖出"}
                            </td>
                            <td>{order.type === "market" ? "市价" : "限价"}</td>
                            <td>{order.quantity.toFixed(4)}</td>
                            <td>{order.price ? `$${order.price.toFixed(2)}` : "-"}</td>
                            <td>{filledText}</td>
                            <td>{statusLabel}</td>
                            <td>{new Date(order.create_time * 1000).toLocaleTimeString()}</td>
                            <td>
                              {order.status === "open" ? (
                                <button className="cancel-btn" onClick={() => handleCancelOrder(order.id)}>
                                  取消
                                </button>
                              ) : (
                                <span className="muted">-</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )
              )}

              {activeListTab === "trades" && (
                trades.length === 0 ? (
                  <div className="empty-state">暂无成交</div>
                ) : (
                  <table className="trading-table">
                    <thead>
                      <tr>
                        <th>方向</th>
                        <th>数量</th>
                        <th>价格</th>
                        <th>手续费</th>
                        <th>时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trades.map((trade) => (
                        <tr key={trade.id}>
                          <td className={trade.direction === "buy" ? "long" : "short"}>
                            {trade.direction === "buy" ? "买入" : "卖出"}
                          </td>
                          <td>{trade.quantity.toFixed(4)}</td>
                          <td>${trade.price.toFixed(2)}</td>
                          <td>${trade.commission.toFixed(2)}</td>
                          <td>{new Date(trade.timestamp * 1000).toLocaleTimeString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              )}

              {activeListTab === "history" && (
                closedPositions.length === 0 ? (
                  <div className="empty-state">暂无历史记录</div>
                ) : (
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
                )
              )}
            </div>

            <div className="tab-actions">
              {activeListTab === "orders" && (
                <>
                  <span className="tab-info">显示 {orders.length} / {ordersTotal}</span>
                  {ordersHasMore && (
                    <button
                      type="button"
                      className="load-more-btn"
                      onClick={handleLoadMoreOrders}
                      disabled={ordersLoadingMore}
                    >
                      {ordersLoadingMore ? "加载中..." : "加载更多订单"}
                    </button>
                  )}
                </>
              )}

              {activeListTab === "trades" && (
                <>
                  <span className="tab-info">显示 {trades.length} / {tradesTotal}</span>
                  {tradesHasMore && (
                    <button
                      type="button"
                      className="load-more-btn"
                      onClick={handleLoadMoreTrades}
                      disabled={tradesLoadingMore}
                    >
                      {tradesLoadingMore ? "加载中..." : "加载更多成交"}
                    </button>
                  )}
                </>
              )}

              {activeListTab === "history" && (
                <>
                  <span className="tab-info">显示 {closedPositions.length} / {closedTotal}</span>
                  {closedHasMore && (
                    <button
                      type="button"
                      className="load-more-btn"
                      onClick={handleLoadMoreClosed}
                      disabled={closedLoadingMore}
                    >
                      {closedLoadingMore ? "加载中..." : "加载更多历史"}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Statistics */}
          {stats && stats.total_trades > 0 && (
            <div className="trading-section">
              <h4>交易统计</h4>
              <div className="trading-stats-grid">
                <div className="stat-item">
                  <label>总交易数</label>
                  <span>{stats.total_trades}</span>
                </div>
                <div className="stat-item">
                  <label>胜率</label>
                  <span>{(stats.win_rate * 100).toFixed(2)}%</span>
                </div>
                <div className="stat-item">
                  <label>盈利因子</label>
                  <span>{stats.profit_factor.toFixed(2)}</span>
                </div>
                <div className="stat-item">
                  <label>期望值</label>
                  <span>${stats.expectancy.toFixed(2)}</span>
                </div>
                <div className="stat-item">
                  <label>最大回撤</label>
                  <span>{(stats.max_drawdown_pct * 100).toFixed(2)}%</span>
                </div>
                <div className="stat-item">
                  <label>夏普比率</label>
                  <span>{stats.sharpe_ratio.toFixed(2)}</span>
                </div>
                <div className="stat-item">
                  <label>CAGR</label>
                  <span>{(stats.cagr * 100).toFixed(2)}%</span>
                </div>
                <div className="stat-item">
                  <label>累计收益</label>
                  <span className={stats.total_return >= 0 ? "gain" : "loss"}>
                    ${stats.total_return.toFixed(2)}
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
