/**
 * Quick Trade Bar Component
 * 左上角显示：品种价格 | 买按钮 | 数量输入 | 卖按钮
 */

import { useEffect, useState, useRef } from "react";
import { placeOrder } from "../services/tradingApi";
import "./QuickTradeBar.css";

interface QuickTradeBarProps {
  symbol: string;
  interval: string;
  currentPrice: number;
  mode: "realtime" | "playback";
}

const STORAGE_KEY = "quickTrade_quantity";

export function QuickTradeBar({
  symbol,
  interval,
  currentPrice,
  mode,
}: QuickTradeBarProps) {
  const [quantity, setQuantity] = useState<string>("1");
  const [loading, setLoading] = useState(false);
  const [priceColor, setPriceColor] = useState<string>("#22aa6a"); // 默认绿色
  const previousPriceRef = useRef<number>(currentPrice);
  const ref = useRef<HTMLDivElement>(null);

  // 记忆数量输入
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      setQuantity(saved);
    }
  }, []);

  // 追踪价格变化，更新颜色
  useEffect(() => {
    const prev = previousPriceRef.current;
    if (prev && prev !== currentPrice) {
      const change = currentPrice - prev;
      // 如果价格上涨，显示绿色；下跌显示红色
      setPriceColor(change >= 0 ? "#22aa6a" : "#ff4444");
      previousPriceRef.current = currentPrice;
    }
  }, [currentPrice]);

  const handleQuantityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuantity(e.target.value);
    localStorage.setItem(STORAGE_KEY, e.target.value);
  };

  const handleBuy = async () => {
    await handleOrder("buy");
  };

  const handleSell = async () => {
    await handleOrder("sell");
  };

  const handleOrder = async (direction: "buy" | "sell") => {
    if (mode === "playback") {
      alert("回放模式不支持交易");
      return;
    }

    try {
      setLoading(true);
      const qty = parseFloat(quantity);
      if (qty <= 0) {
        alert("请输入正确的数量");
        return;
      }

      await placeOrder(
        symbol.toUpperCase(),
        direction,
        "market",
        qty,
        {
          mode,
          interval,
          currentPrice
        }
      );

      alert(
        `${direction === "buy" ? "买入" : "卖出"} ${qty} ${symbol} 成功`
      );
    } catch (error) {
      alert(`${direction === "buy" ? "买入" : "卖出"}失败: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  // 获取价格颜色（绿涨红跌）
  const getPriceColor = () => {
    return priceColor;
  };

  return (
    <div ref={ref} className="quick-trade-bar">
      {/* 品种和价格 */}
      <div className="price-display">
        <span className="symbol">{symbol}</span>
        <span className="price" style={{ color: getPriceColor() }}>
          ${currentPrice.toFixed(2)}
        </span>
      </div>

      {/* 买按钮 */}
      <button
        className="trade-btn buy-btn"
        onClick={handleBuy}
        disabled={loading || mode === "playback"}
        title="买入"
      >
        买
      </button>

      {/* 数量输入框 */}
      <input
        type="number"
        className="quantity-input"
        value={quantity}
        onChange={handleQuantityChange}
        placeholder="数量"
        min="0"
        step="0.0001"
        disabled={loading}
      />

      {/* 卖按钮 */}
      <button
        className="trade-btn sell-btn"
        onClick={handleSell}
        disabled={loading || mode === "playback"}
        title="卖出"
      >
        卖
      </button>
    </div>
  );
}

export default QuickTradeBar;
