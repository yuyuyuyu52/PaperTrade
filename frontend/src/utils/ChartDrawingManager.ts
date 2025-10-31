import { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { DrawingData } from "../services/drawingApi";
import { Candle, Interval } from "../types";

interface ChartPoint {
  time: number;
  price: number;
}

export class ChartDrawingManager {
  private chart: IChartApi;
  private series: ISeriesApi<"Candlestick">;
  private interval: Interval;
  private candles: Candle[];
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private drawings: Map<string, DrawingData> = new Map();
  private isDrawing = false;
  private startPoint: ChartPoint | null = null;
  private currentMousePoint: ChartPoint | null = null;
  private currentTool: "line" | "fib" | "rectangle" | "none" = "none";
  private onDrawingComplete: ((drawing: DrawingData) => Promise<void>) | null = null;
  private animationFrame: number | null = null;

  // Crosshair state
  private mouseScreenX: number | null = null;
  private mouseScreenY: number | null = null;

  private intervalSecondsMap: Record<Interval, number> = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "1h": 3600,
    "4h": 14400,
    "1d": 86400,
  };

  private get intervalSeconds(): number {
    return this.intervalSecondsMap[this.interval] ?? 60;
  }

  private getBarSpacing(): number {
    const ts: any = this.chart.timeScale();
    try {
      const range = ts.getVisibleLogicalRange?.();
      if (range) {
        const to = (range.to as any);
        const c2 = ts.logicalToCoordinate?.(to);
        const c1 = ts.logicalToCoordinate?.(to - 1 as any);
        if (c2 != null && c1 != null) {
          const spacing = Math.abs((c2 as number) - (c1 as number));
          if (spacing > 0.5) return spacing;
        }
      }
    } catch {}
    return 6;
  }

  private getLastCandleTime(): number | null {
    const last = this.candles && this.candles.length > 0 ? this.candles[this.candles.length - 1] : null;
    return last ? (last.time as number) : null;
  }

  private findReferenceTimeLeft(xStart: number): { xRef: number; tRef: number } | null {
    const ts = this.chart.timeScale();
    const width = this.canvas?.getBoundingClientRect().width ?? 0;
    const begin = Math.min(Math.floor(xStart), Math.max(0, Math.floor(width) - 1));
    // scan full width to the left
    for (let x = begin; x >= 0; x--) {
      const t = ts.coordinateToTime(x as any);
      if (t !== null && t !== undefined) {
        return { xRef: x, tRef: Math.round(t as number) };
      }
    }
    // fallback: use last candle time
    const lastTime = this.getLastCandleTime();
    if (lastTime !== null) {
      const xr = ts.timeToCoordinate(lastTime as unknown as UTCTimestamp);
      if (xr !== null && xr !== undefined) {
        return { xRef: xr as number, tRef: lastTime };
      }
    }
    return null;
  }

  private timeToXWithFallback(timeSec: number): number | null {
    const ts = this.chart.timeScale();
    const x = ts.timeToCoordinate(timeSec as unknown as UTCTimestamp);
    if (x !== null && x !== undefined) return x as number;
    // try last candle reference first
    const lastTime = this.getLastCandleTime();
    if (lastTime !== null) {
      const xr = ts.timeToCoordinate(lastTime as unknown as UTCTimestamp);
      if (xr !== null && xr !== undefined) {
        const bars = (timeSec - lastTime) / this.intervalSeconds;
        return (xr as number) + bars * this.getBarSpacing();
      }
    }
    // else scan left across canvas
    const ref = this.findReferenceTimeLeft((this.canvas?.getBoundingClientRect().width ?? 1) - 1);
    if (!ref) return null;
    const bars = (timeSec - ref.tRef) / this.intervalSeconds;
    return ref.xRef + bars * this.getBarSpacing();
  }

  constructor(
    chart: IChartApi,
    series: ISeriesApi<"Candlestick">,
    interval: Interval,
    candles: Candle[]
  ) {
    this.chart = chart;
    this.series = series;
    this.interval = interval;
    this.candles = candles;
    this.setupCanvas();
    this.startRenderLoop();
  }

  private setupCanvas(): void {
    const chartElement = document.querySelector('[data-chart-container]');
    if (!chartElement) return;

    let canvas = chartElement.querySelector("canvas.drawing-canvas") as HTMLCanvasElement;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = "drawing-canvas";
      canvas.style.position = "absolute";
      canvas.style.top = "0";
      canvas.style.left = "0";
      canvas.style.zIndex = "5";
      canvas.style.pointerEvents = "none";
      chartElement.appendChild(canvas);

      canvas.addEventListener("mousedown", (e) => this.onMouseDown(e));
      canvas.addEventListener("mousemove", (e) => this.onMouseMove(e));
      canvas.addEventListener("mouseup", (e) => this.onMouseUp(e));
      canvas.addEventListener("mouseleave", () => {
        this.mouseScreenX = null;
        this.mouseScreenY = null;
      });
    }

    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.resizeCanvas();
  }

  private resizeCanvas(): void {
    if (!this.canvas) return;
    const container = this.canvas.parentElement as HTMLElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    if (this.ctx) {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.scale(dpr, dpr);
    }
  }

  private startRenderLoop(): void {
    const render = () => {
      this.redraw();
      this.animationFrame = requestAnimationFrame(render);
    };
    this.animationFrame = requestAnimationFrame(render);

    // re-resize on chart time scale updates
    this.chart.timeScale().subscribeVisibleTimeRangeChange(() => this.redraw());
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.redraw());
    new ResizeObserver(() => this.resizeCanvas()).observe(document.querySelector('[data-chart-container]') as Element);
  }

  private screenToChartPoint(screenX: number, screenY: number): ChartPoint | null {
    const timeScale = this.chart.timeScale();
    let time = timeScale.coordinateToTime(screenX);
    const price = this.series.coordinateToPrice(screenY);

    if (price === undefined || price === null) {
      return null;
    }

    if (time === undefined || time === null) {
      // prefer last candle as reference
      const lastTime = this.getLastCandleTime();
      if (lastTime !== null) {
        const xRef = timeScale.timeToCoordinate(lastTime as unknown as UTCTimestamp);
        if (xRef !== null && xRef !== undefined) {
          const dx = screenX - (xRef as number);
          const bars = dx / this.getBarSpacing();
          const extrapolated = lastTime + Math.round(bars * this.intervalSeconds);
          return { time: extrapolated, price };
        }
      }
      // fallback: scan left
      const ref = this.findReferenceTimeLeft(screenX);
      if (!ref) return null;
      const dx = screenX - ref.xRef;
      const bars = dx / this.getBarSpacing();
      const extrapolated = ref.tRef + Math.round(bars * this.intervalSeconds);
      return { time: extrapolated, price };
    }

    return { time: Math.round(time as number), price };
  }

  private chartToScreenPoint(chartPoint: ChartPoint): { x: number; y: number } | null {
    const x = this.timeToXWithFallback(chartPoint.time);
    const y = this.series.priceToCoordinate(chartPoint.price);

    if (x === null || x === undefined || y === undefined || y === null) {
      return null;
    }

    return { x: x as number, y };
  }

  setTool(tool: "line" | "fib" | "rectangle" | "none"): void {
    this.currentTool = tool;
    if (this.canvas) {
      if (tool === "none") {
        this.canvas.style.cursor = "default";
        this.canvas.style.pointerEvents = "none";
      } else {
        this.canvas.style.cursor = "crosshair";
        this.canvas.style.pointerEvents = "auto";
      }
    }
  }

  setOnDrawingComplete(callback: (drawing: DrawingData) => Promise<void>): void {
    this.onDrawingComplete = callback;
  }

  loadDrawings(drawings: DrawingData[]): void {
    this.drawings.clear();
    for (const drawing of drawings) {
      if (drawing.id) {
        this.drawings.set(drawing.id, drawing);
      }
    }
  }

  private onMouseDown(event: MouseEvent): void {
    if (this.currentTool === "none" || !this.canvas) return;

    const rect = this.canvas.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;

    const chartPoint = this.screenToChartPoint(screenX, screenY);
    if (!chartPoint) return;

    if (!this.isDrawing) {
      this.isDrawing = true;
      this.startPoint = chartPoint;
      this.currentMousePoint = chartPoint;
    } else if (this.startPoint) {
      const endChartPoint = chartPoint;

      if (
        Math.abs(endChartPoint.time - this.startPoint.time) < 1 &&
        Math.abs(endChartPoint.price - this.startPoint.price) < 0.00001
      ) {
        this.isDrawing = false;
        this.startPoint = null;
        this.currentMousePoint = null;
        return;
      }

      const drawing = this.createDrawing(this.startPoint, endChartPoint);
      if (drawing && this.onDrawingComplete) {
        this.onDrawingComplete(drawing).catch(console.error);
      }

      this.isDrawing = false;
      this.startPoint = null;
      this.currentMousePoint = null;
    }
  }

  private onMouseMove(event: MouseEvent): void {
    if (!this.canvas) return;

    const rect = this.canvas.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;

    // Always keep crosshair position when tool is active
    if (this.currentTool !== "none") {
      this.mouseScreenX = screenX;
      this.mouseScreenY = screenY;
    }

    // Update chart point for preview/drawing
    const chartPoint = this.screenToChartPoint(screenX, screenY);
    if (chartPoint) {
      // While drawing, update the end point; otherwise just keep hover point
      this.currentMousePoint = chartPoint;
    }
  }

  private onMouseUp(_event: MouseEvent): void {}

  private createDrawing(p1: ChartPoint, p2: ChartPoint): DrawingData | null {
    const tool = this.currentTool;
    if (tool === "none") return null;

    const drawing: DrawingData = {
      id: `drawing-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      symbol: "",
      interval: this.interval,
      tool: tool as "line" | "fib" | "rectangle",
      points: [
        { time: p1.time, price: p1.price },
        { time: p2.time, price: p2.price },
      ],
      color: "#22aa6a",
      lineWidth: 2,
    };

    return drawing;
  }

  private redraw(): void {
    if (!this.ctx || !this.canvas) return;

    this.resizeCanvas();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    for (const drawing of this.drawings.values()) {
      this.drawShape(drawing);
    }

    if (this.isDrawing && this.startPoint && this.currentMousePoint) {
      this.drawPreview(this.startPoint, this.currentMousePoint);
    }

    // Draw dashed crosshair when a tool is active
    if (this.currentTool !== "none" && this.mouseScreenX != null && this.mouseScreenY != null) {
      this.drawCrosshair(this.mouseScreenX, this.mouseScreenY);
    }
  }

  private drawPreview(startPoint: ChartPoint, currentPoint: ChartPoint): void {
    if (!this.ctx) return;

    const p1 = this.chartToScreenPoint(startPoint);
    const p2 = this.chartToScreenPoint(currentPoint);

    if (!p1 || !p2) return;

    const color = "#22aa6a";
    this.ctx.strokeStyle = color;
    this.ctx.fillStyle = `${color}20`;
    this.ctx.lineWidth = 2;

    if (this.currentTool === "line") {
      this.ctx.beginPath();
      this.ctx.moveTo(p1.x, p1.y);
      this.ctx.lineTo(p2.x, p2.y);
      this.ctx.stroke();
    } else if (this.currentTool === "rectangle") {
      const width = p2.x - p1.x;
      const height = p2.y - p1.y;
      this.ctx.fillRect(p1.x, p1.y, width, height);
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(p1.x, p1.y, width, height);
    } else if (this.currentTool === "fib") {
      this.drawFibonacci(p1.y, p2.y, p1.x, p2.x, color);
    }

    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.arc(p1.x, p1.y, 5, 0, 2 * Math.PI);
    this.ctx.stroke();
  }

  private drawShape(drawing: DrawingData): void {
    if (!this.ctx || drawing.points.length < 2) return;

    const [p1Data, p2Data] = drawing.points;
    if (!p1Data.time || !p1Data.price || !p2Data.time || !p2Data.price) return;

    const p1 = this.chartToScreenPoint({ time: p1Data.time, price: p1Data.price });
    const p2 = this.chartToScreenPoint({ time: p2Data.time, price: p2Data.price });

    if (!p1 || !p2) return;

    const color = drawing.color || "#22aa6a";
    this.ctx.strokeStyle = color;
    this.ctx.fillStyle = `${color}20`;
    this.ctx.lineWidth = drawing.lineWidth || 2;

    if (drawing.tool === "line") {
      this.ctx.beginPath();
      this.ctx.moveTo(p1.x, p1.y);
      this.ctx.lineTo(p2.x, p2.y);
      this.ctx.stroke();
    } else if (drawing.tool === "rectangle") {
      const width = p2.x - p1.x;
      const height = p2.y - p1.y;
      this.ctx.fillRect(p1.x, p1.y, width, height);
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = drawing.lineWidth || 2;
      this.ctx.strokeRect(p1.x, p1.y, width, height);
    } else if (drawing.tool === "fib") {
      this.drawFibonacci(p1.y, p2.y, p1.x, p2.x, color);
    }
  }

  private drawFibonacci(y1: number, y2: number, x1: number, x2: number, color: string): void {
    if (!this.ctx) return;

    const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

    this.ctx.strokeStyle = color;
    this.ctx.fillStyle = color;
    this.ctx.lineWidth = 1;
    this.ctx.font = "12px Arial";

    for (const level of levels) {
      const y = y1 + (y2 - y1) * level;
      this.ctx.beginPath();
      this.ctx.moveTo(x1, y);
      this.ctx.lineTo(x2, y);
      this.ctx.stroke();

      this.ctx.fillText(`${(level * 100).toFixed(1)}%`, x2 + 5, y + 4);
    }
  }

  private drawCrosshair(x: number, y: number): void {
    if (!this.ctx || !this.canvas) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0,0,0,0.35)";

    // Vertical line
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, this.canvas.height);
    ctx.stroke();

    // Horizontal line
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(this.canvas.width, y + 0.5);
    ctx.stroke();

    ctx.restore();
  }

  removeDrawing(drawingId: string): void {
    this.drawings.delete(drawingId);
  }

  clearAll(): void {
    this.drawings.clear();
  }

  destroy(): void {
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
    }
    if (this.canvas) {
      this.canvas.removeEventListener("mousedown", (e) => this.onMouseDown(e));
      this.canvas.removeEventListener("mousemove", (e) => this.onMouseMove(e));
      this.canvas.removeEventListener("mouseup", (e) => this.onMouseUp(e));
      this.canvas.remove();
    }
  }
}
