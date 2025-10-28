import axios from "axios";

export interface DrawingData {
  id?: string;
  symbol: string;
  interval: string;
  tool: "line" | "fib" | "rectangle";
  points: Array<{ x?: number; y?: number; time?: number; price?: number }>;
  color?: string;
  lineWidth?: number;
  properties?: Record<string, unknown>;
}

const api = axios.create({
  baseURL: `${window.location.protocol}//${window.location.host}`,
  timeout: 10000,
});

export async function saveDrawing(drawing: DrawingData): Promise<DrawingData> {
  const response = await api.post<DrawingData>("/api/drawings", drawing);
  return response.data;
}

export async function getDrawings(
  symbol: string,
  interval: string
): Promise<DrawingData[]> {
  const response = await api.get<DrawingData[]>("/api/drawings", {
    params: { symbol, interval }
  });
  return response.data;
}

export async function deleteDrawing(drawingId: string): Promise<void> {
  await api.delete(`/api/drawings/${drawingId}`);
}

export async function clearDrawings(symbol: string, interval: string): Promise<void> {
  await api.delete("/api/drawings", {
    params: { symbol, interval }
  });
}
