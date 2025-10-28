import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Candle } from "../types";

const PLAYBACK_DELAY_MS = 750;
const DEFAULT_WINDOW_SIZE = 200;

export interface PlaybackController {
  isPlaying: boolean;
  cursorIndex: number;
  visible: Candle[];
  setCursorIndex: (index: number) => void;
  togglePlay: () => void;
  play: () => void;
  pause: () => void;
  stepForward: () => void;
  stepBackward: () => void;
  jumpTo: (index: number) => void;
}

export function usePlaybackController(
  candles: Candle[],
  windowSize: number = DEFAULT_WINDOW_SIZE
): PlaybackController {
  const [cursorIndex, setCursorIndex] = useState(() =>
    candles.length > 0 ? candles.length - 1 : 0
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (candles.length === 0) {
      setCursorIndex(0);
      setIsPlaying(false);
      return;
    }
    if (cursorIndex > candles.length - 1) {
      setCursorIndex(candles.length - 1);
    }
  }, [candles, cursorIndex]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    clearTimer();
    if (!isPlaying || candles.length === 0) {
      return;
    }

    if (cursorIndex >= candles.length - 1) {
      setIsPlaying(false);
      return;
    }

    timerRef.current = window.setTimeout(() => {
      setCursorIndex((current: number) => Math.min(current + 1, candles.length - 1));
    }, PLAYBACK_DELAY_MS);

    return clearTimer;
  }, [isPlaying, candles, cursorIndex, clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  const visible = useMemo(() => {
    if (candles.length === 0) {
      return [];
    }
    const startIndex = Math.max(0, cursorIndex - windowSize + 1);
    return candles.slice(startIndex, cursorIndex + 1);
  }, [candles, cursorIndex, windowSize]);

  const togglePlay = useCallback(() => {
    setIsPlaying((state: boolean) => !state);
  }, []);

  const play = useCallback(() => setIsPlaying(true), []);
  const pause = useCallback(() => setIsPlaying(false), []);

  const stepForward = useCallback(() => {
    pause();
    setCursorIndex((index: number) => Math.min(index + 1, candles.length - 1));
  }, [pause, candles.length]);

  const stepBackward = useCallback(() => {
    pause();
    setCursorIndex((index: number) => Math.max(0, index - 1));
  }, [pause]);

  const jumpTo = useCallback(
    (index: number) => {
      pause();
      setCursorIndex(() => {
        if (candles.length === 0) {
          return 0;
        }
        return Math.min(Math.max(index, 0), candles.length - 1);
      });
    },
    [pause, candles]
  );

  return {
    isPlaying,
    cursorIndex,
    visible,
    setCursorIndex,
    togglePlay,
    play,
    pause,
    stepForward,
    stepBackward,
    jumpTo
  };
}
