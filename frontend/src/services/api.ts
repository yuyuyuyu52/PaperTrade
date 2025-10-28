import axios from "axios";
import { CandleResponse, Instrument, Interval, TimeRangeResponse } from "../types";

const client = axios.create({
  baseURL: "/api",
  timeout: 10000
});

export async function fetchInstruments(): Promise<Instrument[]> {
  const response = await client.get<Instrument[]>("/instruments");
  return response.data;
}

export interface FetchCandlesOptions {
  symbol: string;
  interval: Interval;
  limit?: number;
  start?: number;
  end?: number;
}

export async function fetchCandles(options: FetchCandlesOptions): Promise<CandleResponse> {
  const response = await client.get<CandleResponse>("/candles", {
    params: options
  });
  return response.data;
}

export async function fetchTimeRange(symbol: string, interval: Interval): Promise<TimeRangeResponse> {
  const response = await client.get<TimeRangeResponse>("/candles/range", {
    params: { symbol, interval }
  });
  return response.data;
}
