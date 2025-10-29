/**
 * Trading system types
 */

export interface Position {
  symbol: string;
  quantity: number;
  entry_price: number;
  entry_time: number;
}

export interface ClosedPosition {
  id: string;
  symbol: string;
  direction: "buy" | "sell";
  quantity: number;
  entry_price: number;
  entry_time: number;
  exit_price: number;
  exit_time: number;
  profit_loss: number;
  commission: number;
  days_held: number;
  return_pct: number;
}

export interface Order {
  id: string;
  symbol: string;
  direction: "buy" | "sell";
  type: "market" | "limit";
  quantity: number;
  price?: number;
  create_time: number;
  filled_quantity?: number;
  filled_price?: number;
  status: "open" | "filled" | "cancelled";
}

export interface Trade {
  id: string;
  symbol: string;
  direction: "buy" | "sell";
  quantity: number;
  price: number;
  timestamp: number;
  commission: number;
}

export interface AccountStats {
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  win_rate: number;
  total_profit: number;
  total_loss: number;
  profit_factor: number;
  expectancy: number;
  max_drawdown: number;
  max_drawdown_pct: number;
  sharpe_ratio: number;
  cagr: number;
  cumulative_return: number;
  total_return: number;
}

export interface Account {
  account_id: number;
  mode: "realtime" | "playback";
  symbol: string;
  interval: string;
  initial_balance: number;
  balance: number;
  positions: Position[];
  orders: Order[];
  stats: Partial<AccountStats>;
}
