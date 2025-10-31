import { useCallback, useEffect, useRef, useState } from "react";
import { DrawingData, saveDrawing, getDrawings, deleteDrawing, clearDrawings } from "../services/drawingApi";

interface DrawingManagerOptions {
  symbol: string;
  interval: string;
}

export function useDrawingManager({ symbol, interval }: DrawingManagerOptions) {
  const [drawings, setDrawings] = useState<DrawingData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drawingsRef = useRef<DrawingData[]>([]);

  // Load drawings when symbol/interval changes
  useEffect(() => {
    const loadDrawings = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await getDrawings(symbol, interval);
        setDrawings(data);
        drawingsRef.current = data;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load drawings";
        setError(message);
        console.error("Error loading drawings:", err);
      } finally {
        setLoading(false);
      }
    };

    loadDrawings();
  }, [symbol, interval]);

  const addDrawing = useCallback(
    async (drawing: DrawingData) => {
      try {
        const saved = await saveDrawing({
          ...drawing,
          symbol,
          interval,
        });
        setDrawings((prev) => {
          const idx = prev.findIndex((d) => d.id === saved.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = saved;
            drawingsRef.current = next;
            return next;
          }
          const next = [...prev, saved];
          drawingsRef.current = next;
          return next;
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to save drawing";
        setError(message);
        console.error("Error saving drawing:", err);
        throw err;
      }
    },
    [symbol, interval]
  );

  const removeDrawing = useCallback(
    async (drawingId: string) => {
      try {
        await deleteDrawing(drawingId);
        setDrawings((prev) => {
          const next = prev.filter((d) => d.id !== drawingId);
          drawingsRef.current = next;
          return next;
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to delete drawing";
        setError(message);
        console.error("Error deleting drawing:", err);
        throw err;
      }
    },
    []
  );

  const clearAllDrawings = useCallback(async () => {
    try {
      await clearDrawings(symbol, interval);
      setDrawings([]);
      drawingsRef.current = [];
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to clear drawings";
      setError(message);
      console.error("Error clearing drawings:", err);
      throw err;
    }
  }, [symbol, interval]);

  return {
    drawings,
    drawingsRef,
    loading,
    error,
    addDrawing,
    removeDrawing,
    clearAllDrawings,
  };
}
