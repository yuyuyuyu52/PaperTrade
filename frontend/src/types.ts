export type Interval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export type Mode = "realtime" | "playback";

export interface Instrument {
  symbol: string;
  name: string;
}

export interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleResponse {
  candles: Candle[];
  start: string;
  end: string;
}

export interface TimeRangeResponse {
  earliest: string;
  latest: string;
}
