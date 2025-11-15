import { Candle, Interval } from "../types";

export interface RealtimeSubscriptionOptions {
  symbol: string;
  interval: Interval;
  onOpen?: () => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
  onCandle: (candle: Candle, final: boolean) => void;
}

export function subscribeToRealtime(options: RealtimeSubscriptionOptions): () => void {
  const { symbol, interval, onOpen, onClose, onError, onCandle } = options;



  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const host = import.meta.env.DEV ? "localhost:8000" : window.location.host;
  const localUrl = `${protocol}://${host}/ws/candles?symbol=${symbol}&interval=${interval}`;

  let primarySocket: WebSocket | null = null;


  const cleanup = () => {
    try {
      primarySocket?.close(1000, "client disconnect");
    } catch (err) {
      console.warn('[subscribeToRealtime] Failed to close primary socket', err);
    }

  };

  const parseAndEmit = (data: MessageEvent['data']) => {
    try {
      const payload = JSON.parse(data as string);

      if (payload && payload.k) {
        const k = payload.k;
        const candle: Candle = {
          time: Math.floor(Number(k.t) / 1000),
          open: parseFloat(k.o),
          high: parseFloat(k.h),
          low: parseFloat(k.l),
          close: parseFloat(k.c),
          volume: parseFloat(k.v),
        };
        onCandle(candle, Boolean(k.x));
        return;
      }

      const candlePayload = payload?.candle ?? payload;
      if (candlePayload) {
        const candle: Candle = {
          time: Number(candlePayload.time),
          open: Number(candlePayload.open),
          high: Number(candlePayload.high),
          low: Number(candlePayload.low),
          close: Number(candlePayload.close),
          volume: Number(candlePayload.volume),
        };
        const isFinal = typeof payload?.final === "boolean" ? Boolean(payload.final) : true;
        onCandle(candle, isFinal);
      }
    } catch (error) {
      console.error('[subscribeToRealtime] Failed to parse websocket payload', error);
    }
  };



  const connectToBackend = () => {
    let opened = false;

    primarySocket = new WebSocket(localUrl);



    primarySocket.onopen = () => {
      opened = true;
      onOpen?.();

    };

    primarySocket.onerror = (event) => {
      onError?.(event);
    };

    primarySocket.onclose = (event) => {

      onClose?.(event);
    };

    primarySocket.onmessage = (event) => parseAndEmit(event.data);
  };

  connectToBackend();

  return cleanup;
}

export interface AccountWsOptions {
  symbol: string;
  mode?: string;
  interval?: string;
  onEvent: (ev: any) => void;
}

export function subscribeAccount(options: AccountWsOptions): () => void {
  const { mode, symbol, interval, onEvent } = options;
  const isDev = import.meta.env.DEV;
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const host = isDev ? 'localhost:8000' : window.location.host;
  const params = new URLSearchParams({ symbol });
  if (mode) params.set('mode', mode);
  if (interval) params.set('interval', interval);
  const url = `${protocol}://${host}/ws/account?${params.toString()}`;
  const ws = new WebSocket(url);
  ws.onmessage = (e) => {
    try { onEvent(JSON.parse(e.data)); } catch(err){ console.error(err); }
  };
  return () => ws.close(1000, 'client');
}
