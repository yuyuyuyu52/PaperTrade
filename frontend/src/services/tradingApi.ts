/**
 * Trading API client
 */

import axios from "axios";
import { Account, Order, Trade, ClosedPosition, AccountStats, Paginated } from "../types/trading";
import { Mode } from "../types";

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

interface AccountRequestOptions {
  mode?: Mode;
  interval?: string;
  ordersLimit?: number;
  tradesLimit?: number;
  closedLimit?: number;
}

export async function getAccount(
  symbol: string,
  options: AccountRequestOptions = {}
): Promise<Account> {
  const params: Record<string, string> = { symbol };
  if (options.mode) params.mode = options.mode;
  if (options.interval) params.interval = options.interval;
  if (options.ordersLimit != null) params.orders_limit = String(options.ordersLimit);
  if (options.tradesLimit != null) params.trades_limit = String(options.tradesLimit);
  if (options.closedLimit != null) params.closed_positions_limit = String(options.closedLimit);
  const { data } = await apiClient.get<Account>(`/api/account`, {
    params
  });
  return data;
}

interface PlaceOrderOptions {
  mode?: Mode;
  interval?: string;
  limitPrice?: number;
  currentPrice?: number;
}

export async function placeOrder(
  symbol: string,
  direction: "buy" | "sell",
  type: "market" | "limit",
  quantity: number,
  options: PlaceOrderOptions = {}
): Promise<Order> {
  const { mode = "realtime", interval = "1m", limitPrice } = options;

  if (type === "limit" && (limitPrice === undefined || Number(limitPrice) <= 0)) {
    throw new Error("限价单需要提供有效的价格");
  }

  try {
    const body: Record<string, unknown> = {
      symbol: symbol.toUpperCase(),
      direction,
      type,
      quantity: Number(quantity)
    };

    if (type === "limit" && limitPrice !== undefined) {
      body.price = Number(limitPrice);
    }

    if (type === "market" && options.currentPrice != null && Number(options.currentPrice) > 0) {
      body.current_price = Number(options.currentPrice);
    }

    const params: Record<string, string> = {};
    if (mode !== "realtime") {
      params.mode = mode;
    }
    if (interval !== "1m") {
      params.interval = interval;
    }

    console.log("[placeOrder] 发送下单请求:", {
      url: `/api/orders`,
      params,
      body
    });

    const { data } = await apiClient.post<Order>(`/api/orders`, body, {
      params: Object.keys(params).length ? params : undefined
    });
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

interface PaginatedRequestOptions {
  mode?: Mode;
  interval?: string;
  limit?: number;
  offset?: number;
}

export async function listOrders(
  symbol: string,
  options: PaginatedRequestOptions = {}
): Promise<Paginated<Order>> {
  const params: Record<string, string> = { symbol };
  if (options.mode) params.mode = options.mode;
  if (options.interval) params.interval = options.interval;
  if (options.limit != null) params.limit = String(options.limit);
  if (options.offset != null) params.offset = String(options.offset);
  const { data } = await apiClient.get<Paginated<Order>>(`/api/orders`, {
    params
  });
  return data;
}

export async function cancelOrder(
  orderId: string,
  symbol: string,
  options: { mode?: Mode; interval?: string } = {}
): Promise<{ success: boolean; id: string }> {
  const params: Record<string, string> = { symbol };
  if (options.mode) params.mode = options.mode;
  if (options.interval) params.interval = options.interval;
  const { data } = await apiClient.delete(`/api/orders/${orderId}`, {
    params
  });
  return data;
}

export async function listTrades(
  symbol: string,
  options: PaginatedRequestOptions = {}
): Promise<Paginated<Trade>> {
  const params: Record<string, string> = { symbol };
  if (options.mode) params.mode = options.mode;
  if (options.interval) params.interval = options.interval;
  if (options.limit != null) params.limit = String(options.limit);
  if (options.offset != null) params.offset = String(options.offset);
  const { data } = await apiClient.get<Paginated<Trade>>(`/api/trades`, {
    params
  });
  return data;
}

export async function listClosedPositions(
  symbol: string,
  options: PaginatedRequestOptions = {}
): Promise<Paginated<ClosedPosition>> {
  const params: Record<string, string> = { symbol };
  if (options.mode) params.mode = options.mode;
  if (options.interval) params.interval = options.interval;
  if (options.limit != null) params.limit = String(options.limit);
  if (options.offset != null) params.offset = String(options.offset);
  const { data } = await apiClient.get<Paginated<ClosedPosition>>(`/api/closed-positions`, {
    params
  });
  return data;
}

export async function getAccountStats(
  symbol: string,
  options: { mode?: Mode; interval?: string } = {}
): Promise<AccountStats> {
  const params: Record<string, string> = { symbol };
  if (options.mode) params.mode = options.mode;
  if (options.interval) params.interval = options.interval;
  const { data } = await apiClient.get<AccountStats>(`/api/account-stats`, {
    params
  });
  return data;
}

export async function closePosition(
  symbol: string,
  quantity: number,
  options: { mode?: Mode; interval?: string; currentPrice?: number } = {}
): Promise<Order> {
  const direction: "buy" | "sell" = quantity > 0 ? "sell" : "buy";
  const qty = Math.abs(quantity);
  return placeOrder(symbol.toUpperCase(), direction, "market", qty, options);
}

export async function setPositionTpSl(
  symbol: string,
  takeProfitPrice?: number | null,
  stopLossPrice?: number | null,
  options: { mode?: Mode; interval?: string } = {}
) {
  const params: Record<string, any> = { symbol };
  if (options.mode) params.mode = options.mode;
  if (options.interval) params.interval = options.interval;
  if (typeof takeProfitPrice === "number") params.take_profit_price = takeProfitPrice;
  if (typeof stopLossPrice === "number") params.stop_loss_price = stopLossPrice;
  const { data } = await apiClient.post(`/api/positions/tpsl`, {}, { params });
  return data;
}

export async function getDailyPnl(
  symbol: string,
  month: string,
  options: { mode?: Mode; interval?: string } = {}
): Promise<{ month: string; days: { date: string; pnl: number }[] }> {
  const params: Record<string, string> = { symbol, month };
  if (options.mode) params.mode = options.mode;
  if (options.interval) params.interval = options.interval;
  const { data } = await apiClient.get(`/api/daily-pnl`, {
    params
  });
  return data;
}

export async function resetAccount(
  symbol: string,
  options: { mode?: Mode; interval?: string } = {}
): Promise<{ success: boolean; balance: number }> {
  const params: Record<string, string> = { symbol };
  if (options.mode) params.mode = options.mode;
  if (options.interval) params.interval = options.interval;
  const { data } = await apiClient.post(`/api/account/reset`, {}, { params });
  return data;
}
