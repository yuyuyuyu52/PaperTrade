import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChartContainer from "./components/ChartContainer";
import ControlsPanel from "./components/ControlsPanel";
import { usePlaybackController } from "./hooks/usePlaybackController";
import { fetchCandles, fetchInstruments, fetchTimeRange } from "./services/api";
import { subscribeToRealtime } from "./services/websocketClient";
import { Candle, Instrument, Interval, Mode } from "./types";
import "./App.css";

const DEFAULT_INTERVAL: Interval = "1m";
const DEFAULT_SYMBOL = "ETH";
const REALTIME_INITIAL_LIMIT = 500;
const REALTIME_HISTORY_CHUNK = 1000;
const REALTIME_MAX_POINTS = 6000;

const INTERVAL_SECONDS: Record<Interval, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400
};

function App() {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState(DEFAULT_SYMBOL);
  const [interval, setInterval] = useState<Interval>(DEFAULT_INTERVAL);
  const [mode, setMode] = useState<Mode>("realtime");
  const [realtimeCandles, setRealtimeCandles] = useState<Candle[]>([]);
  const [playbackCandles, setPlaybackCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const unsubscribeRef = useRef<(() => void) | null>(null);
  const realtimeHistoryLoadingRef = useRef(false);
  const realtimeHistoryRequestedRef = useRef<Set<number>>(new Set());

  const playbackController = usePlaybackController(playbackCandles);

  useEffect(() => {
    fetchInstruments()
      .then((list) => {
        setInstruments(list);
        if (list.length > 0) {
          const symbols = list.map((item) => item.symbol);
          if (!symbols.includes(selectedSymbol)) {
            setSelectedSymbol(list[0].symbol);
          }
        }
      })
      .catch(() => setError("无法加载品种列表"));
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadData() {
      setLoading(true);
      setError(null);
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
      realtimeHistoryRequestedRef.current.clear();
      realtimeHistoryLoadingRef.current = false;

      try {
        if (mode === "realtime") {
          const result = await fetchCandles({ symbol: selectedSymbol, interval, limit: REALTIME_INITIAL_LIMIT });
          if (cancelled) return;
          const sorted = [...result.candles].sort((a, b) => a.time - b.time);
          setRealtimeCandles(sorted);

              unsubscribeRef.current = subscribeToRealtime({
                symbol: selectedSymbol,
                interval,
                onCandle: (candle, _final) => {
              setRealtimeCandles((previous: Candle[]) => {
                    void _final;
                if (previous.length === 0) {
                  return [candle];
                }

                const next = [...previous];
                const index = next.findIndex((item) => item.time === candle.time);
                if (index >= 0) {
                  next[index] = { ...next[index], ...candle };
                  return next;
                }

                next.push(candle);
                next.sort((a, b) => a.time - b.time);
                    if (next.length > REALTIME_MAX_POINTS) {
                     return next.slice(next.length - REALTIME_MAX_POINTS);
                   }
                   return next;
              });
            }
          });
        } else {
          const range = await fetchTimeRange(selectedSymbol, interval);
          if (cancelled) return;
          const earliest = Math.floor(new Date(range.earliest).getTime() / 1000);
          const latest = Math.floor(new Date(range.latest).getTime() / 1000);
          const result = await fetchCandles({ symbol: selectedSymbol, interval, start: earliest, end: latest, limit: 5000 });
          if (cancelled) return;
          setPlaybackCandles(result.candles);
        }
      } catch (loadError) {
        console.error(loadError);
        if (!cancelled) {
          setError("加载数据失败");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadData();

    return () => {
      cancelled = true;
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, [selectedSymbol, interval, mode]);

  useEffect(() => {
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, []);

  const activeCandles = useMemo(() => {
    if (mode === "realtime") {
      return realtimeCandles;
    }
    return playbackController.visible;
  }, [mode, realtimeCandles, playbackController.visible]);

  const loadMoreRealtimeHistory = useCallback(async (earliestTime: number) => {
    if (mode !== "realtime") {
      return;
    }

    const intervalSeconds = INTERVAL_SECONDS[interval];
    if (!intervalSeconds) {
      return;
    }

    if (realtimeHistoryLoadingRef.current) {
      return;
    }

    if (realtimeHistoryRequestedRef.current.has(earliestTime)) {
      return;
    }

    const before = earliestTime - intervalSeconds;
    if (before <= 0) {
      realtimeHistoryRequestedRef.current.add(earliestTime);
      return;
    }

    realtimeHistoryLoadingRef.current = true;
    realtimeHistoryRequestedRef.current.add(earliestTime);

    try {
      const result = await fetchCandles({
        symbol: selectedSymbol,
        interval,
        end: before,
        limit: REALTIME_HISTORY_CHUNK
      });

      if (result.candles.length === 0) {
        return;
      }

      setRealtimeCandles((previous) => {
        const merged = new Map<number, Candle>();
        for (const candle of result.candles) {
          merged.set(candle.time, candle);
        }
        for (const candle of previous) {
          merged.set(candle.time, candle);
        }
        const next = Array.from(merged.values());
        next.sort((a, b) => a.time - b.time);
        return next;
      });
    } catch (historyError) {
      console.error(historyError);
      setError((prev) => prev ?? "加载历史数据失败");
    } finally {
      realtimeHistoryLoadingRef.current = false;
    }
  }, [interval, mode, selectedSymbol, setError]);

  const playbackControls = useMemo(() => ({
    isPlaying: playbackController.isPlaying,
    cursorIndex: playbackController.cursorIndex,
    onToggle: playbackController.togglePlay,
    onStepForward: playbackController.stepForward,
    onStepBackward: playbackController.stepBackward,
    onSeek: playbackController.jumpTo
  }), [
    playbackController.isPlaying,
    playbackController.cursorIndex,
    playbackController.togglePlay,
    playbackController.stepForward,
    playbackController.stepBackward,
    playbackController.jumpTo
  ]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>TradingView 图表</h1>
      </header>
      <ControlsPanel
        instruments={instruments}
        selectedSymbol={selectedSymbol}
        onSymbolChange={setSelectedSymbol}
        interval={interval}
        onIntervalChange={setInterval}
        mode={mode}
        onModeChange={setMode}
        playbackControls={playbackControls}
        playbackTimeline={playbackCandles}
      />
      <main className="chart-area">
        {loading && <div className="loading">加载中...</div>}
        {error && <div className="error">{error}</div>}
        {!loading && !error && activeCandles.length > 0 && (
          <ChartContainer
            candles={activeCandles}
            mode={mode}
            interval={interval}
            onRequestHistory={mode === "realtime" ? loadMoreRealtimeHistory : undefined}
          />
        )}
        {!loading && !error && activeCandles.length === 0 && (
          <div className="placeholder">暂无数据</div>
        )}
      </main>
    </div>
  );
}

export default App;
