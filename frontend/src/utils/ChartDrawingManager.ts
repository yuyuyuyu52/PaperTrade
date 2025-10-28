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
    }

    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.resizeCanvas();
  }

  private resizeCanvas(): void {
    if (!this.canvas) return;
    const container = this.canvas.parentElement;
    if (!container) return;
    this.canvas.width = container.clientWidth;
    this.canvas.height = container.clientHeight;
  }

  private startRenderLoop(): void {
    const render = () => {
      this.redraw();
      this.animationFrame = requestAnimationFrame(render);
    };
    this.animationFrame = requestAnimationFrame(render);
  }

  private screenToChartPoint(screenX: number, screenY: number): ChartPoint | null {
    const timeScale = this.chart.timeScale();
    const time = timeScale.coordinateToTime(screenX);
    const price = this.series.coordinateToPrice(screenY);

    if (time === undefined || price === undefined || price === null) {
      return null;
    }

    return { time: Math.round(time as number), price };
  }

  private chartToScreenPoint(chartPoint: ChartPoint): { x: number; y: number } | null {
    const timeCoord = this.chart.timeScale().timeToCoordinate(chartPoint.time as UTCTimestamp);
    const priceCoord = this.series.priceToCoordinate(chartPoint.price);

    if (timeCoord === undefined || timeCoord === null || priceCoord === undefined || priceCoord === null) {
      return null;
    }

    return { x: timeCoord, y: priceCoord };
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
      // 第一次点击：开始绘制
      this.isDrawing = true;
      this.startPoint = chartPoint;
      this.currentMousePoint = chartPoint;
    } else if (this.startPoint) {
      // 第二次点击：完成绘制
      const endChartPoint = chartPoint;

      // 检查移动距离
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
    if (!this.isDrawing || !this.canvas) return;

    const rect = this.canvas.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;

    const chartPoint = this.screenToChartPoint(screenX, screenY);
    if (chartPoint) {
      this.currentMousePoint = chartPoint;
    }
  }

  private onMouseUp(event: MouseEvent): void {
    // 不需要鼠标抬起逻辑
  }

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

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // 绘制已保存的图形
    for (const drawing of this.drawings.values()) {
      this.drawShape(drawing);
    }

    // 绘制实时预览
    if (this.isDrawing && this.startPoint && this.currentMousePoint) {
      this.drawPreview(this.startPoint, this.currentMousePoint);
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

    // 绘制起点圆圈
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
