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
        await saveDrawing({
          ...drawing,
          symbol,
          interval,
        });
        const updated = [...drawings, drawing];
        setDrawings(updated);
        drawingsRef.current = updated;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to save drawing";
        setError(message);
        console.error("Error saving drawing:", err);
        throw err;
      }
    },
    [drawings, symbol, interval]
  );

  const removeDrawing = useCallback(
    async (drawingId: string) => {
      try {
        await deleteDrawing(drawingId);
        const updated = drawings.filter((d) => d.id !== drawingId);
        setDrawings(updated);
        drawingsRef.current = updated;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to delete drawing";
        setError(message);
        console.error("Error deleting drawing:", err);
        throw err;
      }
    },
    [drawings]
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
