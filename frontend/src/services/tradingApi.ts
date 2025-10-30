/**
 * Trading API client
 */

import axios from "axios";
import { Account, Order, Trade, ClosedPosition, AccountStats } from "../types/trading";

// 根据环境确定 API 基 URL
const isDev = import.meta.env.DEV;
const baseURL = isDev ? "http://localhost:8000" : undefined;

// 创建 Axios 实例，配置用于开发环境的特殊处理
const apiClient = axios.create({
  baseURL,
  headers: {
    "Content-Type": "application/json"
  }
});

console.log("[TradingAPI] Initialized:", {
  isDev,
  baseURL: apiClient.defaults.baseURL
});

export async function getAccount(mode: "realtime" | "playback", symbol: string, interval: string): Promise<Account> {
  const { data } = await apiClient.get<Account>(`/api/accounts/${mode}`, {
    params: { symbol, interval }
  });
  return data;
}

export async function placeOrder(
  mode: "realtime" | "playback",
  symbol: string,
  interval: string,
  direction: "buy" | "sell",
  type: "market" | "limit",
  quantity: number,
  currentPrice: number,
  limitPrice?: number
): Promise<Order> {
  try {
    const params = {
      mode,
      symbol: symbol.toUpperCase(),
      interval,
      direction,
      type,
      quantity: parseFloat(quantity.toString()),
      current_price: parseFloat(currentPrice.toString()),
      ...(limitPrice && { price: parseFloat(limitPrice.toString()) })
    };
    
    console.log("[placeOrder] 发送下单请求:", {
      url: `/api/orders`,
      params
    });

    const { data } = await apiClient.post<Order>(`/api/orders`, {}, { params });
    console.log("[placeOrder] 订单响应成功:", data);
    return data;
  } catch (error) {
    console.error("[placeOrder] 订单请求失败:", error);
    if (axios.isAxiosError(error)) {
      console.error("[placeOrder] 错误详情:", {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message
      });
      throw new Error(`API 错误: ${error.response?.data?.detail || error.message}`);
    }
    throw error;
  }
}

export async function listOrders(mode: "realtime" | "playback", symbol: string, interval: string): Promise<Order[]> {
  const { data } = await apiClient.get<Order[]>(`/api/orders`, {
    params: { mode, symbol, interval }
  });
  return data;
}

export async function cancelOrder(orderId: string, mode: "realtime" | "playback", symbol: string, interval: string): Promise<{ success: boolean; id: string }> {
  const { data } = await apiClient.delete(`/api/orders/${orderId}`, {
    params: { mode, symbol, interval }
  });
  return data;
}

export async function listTrades(mode: "realtime" | "playback", symbol: string, interval: string): Promise<Trade[]> {
  const { data } = await apiClient.get<Trade[]>(`/api/trades`, {
    params: { mode, symbol, interval }
  });
  return data;
}

export async function listClosedPositions(mode: "realtime" | "playback", symbol: string, interval: string): Promise<ClosedPosition[]> {
  const { data } = await apiClient.get<ClosedPosition[]>(`/api/closed-positions`, {
    params: { mode, symbol, interval }
  });
  return data;
}

export async function getAccountStats(mode: "realtime" | "playback", symbol: string, interval: string): Promise<AccountStats> {
  const { data } = await apiClient.get<AccountStats>(`/api/account-stats/${mode}`, {
    params: { symbol, interval }
  });
  return data;
}

export async function closePosition(
  mode: "realtime" | "playback",
  symbol: string,
  interval: string,
  quantity: number,
  currentPrice: number
): Promise<Order> {
  const direction: "buy" | "sell" = quantity > 0 ? "sell" : "buy";
  const qty = Math.abs(quantity);
  return placeOrder(mode, symbol.toUpperCase(), interval, direction, "market", qty, currentPrice);
}

export async function setPositionTpSl(
  mode: "realtime" | "playback",
  symbol: string,
  interval: string,
  takeProfitPrice?: number | null,
  stopLossPrice?: number | null
) {
  const params: Record<string, any> = { mode, symbol, interval };
  if (typeof takeProfitPrice === "number") params.take_profit_price = takeProfitPrice;
  if (typeof stopLossPrice === "number") params.stop_loss_price = stopLossPrice;
  const { data } = await apiClient.post(`/api/positions/tpsl`, {}, { params });
  return data;
}
