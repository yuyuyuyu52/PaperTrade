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
  const socketUrl = `${protocol}://${window.location.host}/ws/candles?symbol=${symbol}&interval=${interval}`;
  const socket = new WebSocket(socketUrl);

  socket.onopen = () => onOpen?.();
  socket.onerror = (event) => onError?.(event);
  socket.onclose = (event) => onClose?.(event);
  socket.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data) as {
        type: string;
        candle?: Candle;
        final?: boolean;
      };
      if (payload.type === "update" && payload.candle) {
        onCandle(payload.candle, payload.final ?? true);
      }
    } catch (error) {
      console.error("Failed to parse websocket payload", error);
    }
  };

  return () => {
    socket.close(1000, "client disconnect");
  };
}
