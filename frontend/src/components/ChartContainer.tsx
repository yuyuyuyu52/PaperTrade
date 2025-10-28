import { useCallback, useEffect, useRef, useState } from "react";
import {
  BusinessDay,
  CandlestickData,
  IChartApi,
  ISeriesApi,
  LogicalRange,
  MouseEventParams,
  UTCTimestamp,
  createChart
} from "lightweight-charts";
import { Candle, Interval, Mode } from "../types";

interface ChartContainerProps {
  candles: Candle[];
  mode: Mode;
  interval: Interval;
  onRequestHistory?: (earliestTime: number) => Promise<void> | void;
}

const CHART_BG = "#f5f5f5";
const GRID_COLOR = "#e0e0e0";
const UP_COLOR = "#22aa6a";
const DOWN_COLOR = "#000000";
const DEFAULT_RIGHT_OFFSET = 3;
const DEFAULT_VISIBLE_BARS = 240;
const INITIAL_BAR_SPACING = 4.5;
const TIME_SCALE_SETTINGS: Record<Interval, { timeVisible: boolean; secondsVisible: boolean }> = {
  "1m": { timeVisible: true, secondsVisible: true },
  "5m": { timeVisible: true, secondsVisible: false },
  "15m": { timeVisible: true, secondsVisible: false },
  "1h": { timeVisible: true, secondsVisible: false },
  "4h": { timeVisible: true, secondsVisible: false },
  "1d": { timeVisible: false, secondsVisible: false }
};

const INTERVAL_STEP_SECONDS: Record<Interval, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400
};

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatTimestampForInterval(value: BusinessDay | UTCTimestamp, interval: Interval): string {
  const date = typeof value === "number"
    ? new Date(value * 1000)
    : new Date(Date.UTC(value.year, value.month - 1, value.day));

  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());

  switch (interval) {
    case "1m":
      return `${month}-${day} ${hours}:${minutes}:${seconds}`;
    case "5m":
    case "15m":
      return `${month}-${day} ${hours}:${minutes}`;
    case "1h":
    case "4h":
      return `${month}-${day} ${hours}:${minutes}`;
    case "1d":
    default:
      return `${year}-${month}-${day}`;
  }
}

const PRICE_FORMATTER = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 0,
  maximumFractionDigits: 8
});

function toUnixTime(value: BusinessDay | UTCTimestamp | string): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
  }

  return Math.floor(Date.UTC(value.year, value.month - 1, value.day) / 1000);
}

export function ChartContainer({ candles, mode, interval, onRequestHistory }: ChartContainerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const historyLoadingRef = useRef(false);
  const requestedEarliestRef = useRef<Set<number>>(new Set());
  const stayAtRightRef = useRef(true);
  const previousLengthRef = useRef(0);
  const firstTimeRef = useRef<number | null>(null);
  const lastUserInteractionRef = useRef<number>(Date.now());
  const intervalRef = useRef<Interval>(interval);
  const candlesRef = useRef<Candle[]>([]);
  const autoFollowRef = useRef(true);
  const [hoveredCandle, setHoveredCandle] = useState<Candle | null>(null);
  const [isAutoFollow, setIsAutoFollow] = useState(true);
  const suppressRangeEventRef = useRef(false);

  const scheduleReleaseSuppression = useCallback(() => {
    window.setTimeout(() => {
      suppressRangeEventRef.current = false;
    }, 0);
  }, []);

  const applyVisibleRange = useCallback((range: LogicalRange | null) => {
    if (!chartRef.current || !range) {
      return;
    }
    suppressRangeEventRef.current = true;
    chartRef.current.timeScale().setVisibleLogicalRange(range);
    scheduleReleaseSuppression();
  }, [scheduleReleaseSuppression]);

  const scrollToLatest = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) {
      return;
    }
    suppressRangeEventRef.current = true;
    chart.timeScale().scrollToRealTime();
    chart.timeScale().applyOptions({ rightOffset: DEFAULT_RIGHT_OFFSET });
    scheduleReleaseSuppression();
  }, [scheduleReleaseSuppression]);

  const disableAutoFollow = useCallback(() => {
    if (!autoFollowRef.current) {
      return;
    }
    autoFollowRef.current = false;
    setIsAutoFollow(false);
  }, []);

  const enableAutoFollow = useCallback(() => {
    autoFollowRef.current = true;
    stayAtRightRef.current = true;
    setIsAutoFollow(true);
    const chart = chartRef.current;
    if (chart) {
      scrollToLatest();
    }
    lastUserInteractionRef.current = Date.now();
  }, [scrollToLatest]);

  useEffect(() => {
    intervalRef.current = interval;
  }, [interval]);

  useEffect(() => {
    if (!autoFollowRef.current) {
      return;
    }
    if (candles.length === 0) {
      return;
    }

    const prevLength = previousLengthRef.current;
    if (candles.length < prevLength) {
      return;
    }

    if (prevLength > 0 && candles[0].time < (candlesRef.current[0]?.time ?? candles[0].time)) {
      return;
    }

  }, [candles, applyVisibleRange]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: CHART_BG },
        textColor: "#111"
      },
      grid: {
        vertLines: { color: GRID_COLOR },
        horzLines: { color: GRID_COLOR }
      },
      rightPriceScale: {
        borderVisible: false
      },
      timeScale: {
        fixLeftEdge: false,
        rightOffset: 0,
        borderVisible: false
      },
      crosshair: {
        mode: 0
      },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight || 520
    });

    const series = chart.addCandlestickSeries({
      upColor: UP_COLOR,
      borderUpColor: "#000000",
      wickUpColor: "#000000",
      downColor: DOWN_COLOR,
      borderDownColor: DOWN_COLOR,
      wickDownColor: DOWN_COLOR
    });

  chartRef.current = chart;
  seriesRef.current = series;

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight || 520 });
      }
    };

  const timeScale = chart.timeScale();
  window.addEventListener("resize", handleResize);
  timeScale.fitContent();
  timeScale.applyOptions({ rightOffset: DEFAULT_RIGHT_OFFSET, barSpacing: INITIAL_BAR_SPACING });

    const container = containerRef.current;
    const markPointerInteraction = () => {
      lastUserInteractionRef.current = Date.now();
      disableAutoFollow();
    };

    container?.addEventListener("pointerdown", markPointerInteraction);
    container?.addEventListener("wheel", markPointerInteraction, { passive: true });

    const handleCrosshairMove = (param: MouseEventParams) => {
      const latestCandles = candlesRef.current;
      if (latestCandles.length === 0) {
        setHoveredCandle(null);
        return;
      }

      const step = INTERVAL_STEP_SECONDS[intervalRef.current];
      let target: Candle | null = null;

      if (param.time) {
        const resolvedTime = toUnixTime(param.time);

        const data = series && param.seriesData.get(series);
        if (data && typeof (data as Partial<CandlestickData>).open === "number") {
          const bar = data as CandlestickData;
          const existing = latestCandles.find((item) => item.time === resolvedTime);
          target = existing
            ? existing
            : {
                time: resolvedTime,
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: 0
              };
        } else if (step) {
          let low = 0;
          let high = latestCandles.length - 1;
          let candidateIndex = -1;

          while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const midTime = latestCandles[mid].time;
            if (resolvedTime < midTime) {
              high = mid - 1;
            } else {
              candidateIndex = mid;
              low = mid + 1;
            }
          }

          if (candidateIndex >= 0) {
            const candidate = latestCandles[candidateIndex];
            if (!step || resolvedTime < candidate.time + step) {
              target = candidate;
            }
          }
        }
      }

      if (!target && typeof param.logical === "number") {
        const index = Math.round(param.logical);
        const clampedIndex = Math.min(Math.max(index, 0), latestCandles.length - 1);
        target = latestCandles[clampedIndex] ?? null;
      }

      setHoveredCandle(target ? { ...target } : null);
    };

    chart.subscribeCrosshairMove(handleCrosshairMove);

    return () => {
      window.removeEventListener("resize", handleResize);
      container?.removeEventListener("pointerdown", markPointerInteraction);
      container?.removeEventListener("wheel", markPointerInteraction);
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.remove();
    };
  }, []);

  useEffect(() => {
    candlesRef.current = candles;

    if (!seriesRef.current || !chartRef.current) {
      return;
    }

    const chart = chartRef.current;
    const timeScale = chart.timeScale();
    const currentRange = timeScale.getVisibleLogicalRange();
    if (candles.length === 0) {
      seriesRef.current.setData([]);
      previousLengthRef.current = 0;
      firstTimeRef.current = null;
      return;
    }

    const firstTime = candles[0].time;
    const prevFirstTime = firstTimeRef.current;
    const prevLength = previousLengthRef.current;
    const lastCandle = candles[candles.length - 1];
    const stepSeconds = INTERVAL_STEP_SECONDS[intervalRef.current] ?? (candles[1] ? Math.max(1, candles[1].time - candles[0].time) : 0);
    const formattedLast: CandlestickData = {
      time: lastCandle.time as UTCTimestamp,
      open: lastCandle.open,
      high: lastCandle.high,
      low: lastCandle.low,
      close: lastCandle.close
    };

    const needsFullSeries =
      prevLength === 0 ||
      prevFirstTime === null ||
      firstTime !== prevFirstTime ||
      candles.length < prevLength ||
      candles.length - prevLength > 1;

  const appended = candles.length > prevLength && !needsFullSeries;
    const now = Date.now();
    const RECENT_INTERACTION_MS = 4_000;
    const scrollPosition = timeScale.scrollPosition();
    const isPinnedToRight = typeof scrollPosition === "number" ? scrollPosition <= 0.5 : stayAtRightRef.current;
    const userActiveRecently = now - lastUserInteractionRef.current <= RECENT_INTERACTION_MS;
  const shouldPreserveRange = mode === "realtime" && appended && (!autoFollowRef.current || !isPinnedToRight || userActiveRecently);
    const previousRange = shouldPreserveRange ? currentRange : null;
    const lastLogicalIndex = candles.length > 0 ? candles.length - 1 : 0;

    const buildPinnedRange = (baseRange: LogicalRange | null) => {
      const span = baseRange ? Math.max(baseRange.to - baseRange.from, 10) : DEFAULT_VISIBLE_BARS;
      const to = lastLogicalIndex + DEFAULT_RIGHT_OFFSET;
      const from = Math.max(0, to - span);
      return { from, to } as LogicalRange;
    };

    if (needsFullSeries) {
      if (prevLength === 0) {
        autoFollowRef.current = true;
        stayAtRightRef.current = true;
        setIsAutoFollow(true);
      }

      const formattedAll: CandlestickData[] = candles.map((candle) => ({
        time: candle.time as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close
      }));
      seriesRef.current.setData(formattedAll);
      
      // 仅在初次加载时滚动到最新
      if (prevLength === 0 && mode === "realtime") {
        suppressRangeEventRef.current = true;
        timeScale.applyOptions({ rightOffset: DEFAULT_RIGHT_OFFSET });
        timeScale.scrollToRealTime();
        scheduleReleaseSuppression();
      } else if (currentRange && mode !== "realtime") {
        const addedBars = prevFirstTime !== null && stepSeconds > 0 ? Math.round((prevFirstTime - firstTime) / stepSeconds) : 0;
        if (addedBars !== 0) {
          const shiftedRange = {
            from: currentRange.from + addedBars,
            to: currentRange.to + addedBars
          } as LogicalRange;
          applyVisibleRange(shiftedRange);
        } else {
          applyVisibleRange(currentRange);
        }
      }
      previousLengthRef.current = candles.length;
      firstTimeRef.current = firstTime;
      return;
    } else {
      seriesRef.current.update(formattedLast);
    }

    // realtime 模式下只在自动跟随启用时调整视图
    if (mode === "realtime" && appended && autoFollowRef.current && isPinnedToRight && !userActiveRecently) {
      const targetRange = buildPinnedRange(currentRange ?? timeScale.getVisibleLogicalRange());
      suppressRangeEventRef.current = true;
      applyVisibleRange(targetRange);
      stayAtRightRef.current = true;
      timeScale.applyOptions({ rightOffset: DEFAULT_RIGHT_OFFSET });
      scheduleReleaseSuppression();
    }

    previousLengthRef.current = candles.length;
    firstTimeRef.current = firstTime;
  }, [candles, mode]);

  useEffect(() => {
    if (chartRef.current) {
      chartRef.current.applyOptions({ watermark: { visible: mode === "playback", text: "Playback", color: "rgba(17,17,17,0.2)", fontSize: 48 } });
    }
  }, [mode]);

  useEffect(() => {
    if (!chartRef.current) {
      return;
    }

    const chart = chartRef.current;
    const timeScale = chart.timeScale();
    const settings = TIME_SCALE_SETTINGS[interval];
    timeScale.applyOptions({ timeVisible: settings.timeVisible, secondsVisible: settings.secondsVisible });
    chart.applyOptions({
      localization: {
        timeFormatter: (value: BusinessDay | UTCTimestamp) => formatTimestampForInterval(value, interval)
      }
    });
  }, [interval]);

  useEffect(() => {
    if (mode === "realtime") {
      stayAtRightRef.current = true;
    }
  }, [mode]);

  useEffect(() => {
    if (!chartRef.current || !onRequestHistory || candles.length === 0) {
      return;
    }

    const timeScale = chartRef.current.timeScale();

    const handleRangeChange = (range: LogicalRange | null) => {
      if (suppressRangeEventRef.current) {
        return;
      }

      if (!range || candles.length === 0) {
        return;
      }

      if (mode === "realtime") {
        const wasAtRight = stayAtRightRef.current;
        const scrollPosition = timeScale.scrollPosition();
        if (typeof scrollPosition === "number") {
          stayAtRightRef.current = scrollPosition <= 0.5;
        }
        if (!stayAtRightRef.current && wasAtRight) {
          lastUserInteractionRef.current = Date.now();
          disableAutoFollow();
        }
      }

      if (historyLoadingRef.current) {
        return;
      }

      if (range.from > 5) {
        return;
      }

      const earliest = candles[0].time;
      if (requestedEarliestRef.current.has(earliest)) {
        return;
      }

      requestedEarliestRef.current.add(earliest);
      historyLoadingRef.current = true;
      Promise.resolve(onRequestHistory(earliest)).finally(() => {
        historyLoadingRef.current = false;
      });
    };

    timeScale.subscribeVisibleLogicalRangeChange(handleRangeChange);

    return () => {
      timeScale.unsubscribeVisibleLogicalRangeChange(handleRangeChange);
    };
  }, [candles, mode, onRequestHistory]);

  const hoverInfo = hoveredCandle;
  let hoverOverlay: JSX.Element | null = null;
  if (hoverInfo) {
    const info = hoverInfo!;
    hoverOverlay = (
      <div
        style={{
          position: "absolute",
          top: 8,
          left: 12,
          padding: "6px 10px",
          borderRadius: 4,
          border: "1px solid rgba(0,0,0,0.15)",
          backgroundColor: "rgba(245,245,245,0.92)",
          color: "#111",
          fontSize: 12,
          pointerEvents: "none",
          boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
          zIndex: 10
        }}
      >
        <div>{formatTimestampForInterval(info.time as UTCTimestamp, interval)}</div>
        <div>
          O: {PRICE_FORMATTER.format(info.open)} H: {PRICE_FORMATTER.format(info.high)} L: {PRICE_FORMATTER.format(info.low)} C: {PRICE_FORMATTER.format(info.close)}
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      {hoverOverlay}
      {!isAutoFollow && (
        <button
          type="button"
          onClick={enableAutoFollow}
          style={{
            position: "absolute",
            right: 16,
            bottom: 16,
            padding: "0.5rem 0.75rem",
            borderRadius: 6,
            border: "1px solid rgba(0,0,0,0.2)",
            background: "rgba(17,17,17,0.85)",
            color: "#fff",
            fontSize: 12,
            cursor: "pointer",
            zIndex: 20
          }}
        >
          回到最新
        </button>
      )}
    </div>
  );
}

export default ChartContainer;
