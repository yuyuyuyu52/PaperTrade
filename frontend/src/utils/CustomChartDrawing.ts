import { IChartApi, ISeriesApi, SeriesType, MouseEventParams, Time, Logical } from "lightweight-charts";

export interface DrawingPoint {
  time: number;
  price: number;
}

export interface Drawing {
  id?: string;
  type?: "line" | "fib" | "rectangle";
  tool: "line" | "fib" | "rectangle";
  symbol: string;
  interval: string;
  points: Array<DrawingPoint | { x?: number; y?: number; time?: number; price?: number }>;
  color?: string;
  lineWidth?: number;
  properties?: Record<string, unknown>;
}

function toUnixTime(value: any): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
  }
  return Math.floor(Date.UTC(value.year, value.month - 1, value.day) / 1000);
}

function normalizePoints(points: Array<any>): DrawingPoint[] {
  return points.map(p => ({
    time: p.time || 0,
    price: p.price || 0,
  })).filter(p => p.time && p.price);
}

export class CustomChartDrawing {
  private chart: IChartApi;
  private series: ISeriesApi<SeriesType>;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private drawings: Map<string, Drawing> = new Map();
  private currentTool: "line" | "fib" | "rectangle" | "none" = "none";
  private isDrawing = false;
  private startPoint: DrawingPoint | null = null;
  private currentPoint: DrawingPoint | null = null;
  private onDrawingComplete: ((drawing: Drawing) => Promise<void>) | null = null;
  private clickHandler: ((param: MouseEventParams) => void) | null = null;
  private moveHandler: ((param: MouseEventParams) => void) | null = null;
  private nativeClickHandler: ((e: MouseEvent) => void) | null = null;
  private nativeMoveHandler: ((e: MouseEvent) => void) | null = null;
  private rafId: number | null = null;
  private container: HTMLElement;
  private resizeObserver: ResizeObserver;
  private intervalSeconds: number = 60; // Default 1 minute

  constructor(
    chart: IChartApi,
    series: ISeriesApi<SeriesType>,
    container: HTMLElement,
    onDrawingComplete?: (drawing: Drawing) => Promise<void>,
    intervalSeconds?: number
  ) {
    this.chart = chart;
    this.series = series;
    this.container = container;
    this.onDrawingComplete = onDrawingComplete || null;
    this.intervalSeconds = intervalSeconds || 60;

    // Create overlay canvas
    this.canvas = document.createElement("canvas");
    this.canvas.style.position = "absolute";
    this.canvas.style.top = "0";
    this.canvas.style.left = "0";
    this.canvas.style.pointerEvents = "none"; // Initially let events pass through
    this.canvas.style.zIndex = "10"; // Higher z-index to be above chart
    this.canvas.style.cursor = "default";
    
    const ctx = this.canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to get 2D context");
    }
    this.ctx = ctx;

    container.appendChild(this.canvas);
    this.resizeCanvas();

    // Setup native DOM event listeners on canvas
    this.nativeClickHandler = this.onNativeClick.bind(this);
    this.nativeMoveHandler = this.onNativeMouseMove.bind(this);
    this.canvas.addEventListener("click", this.nativeClickHandler);
    this.canvas.addEventListener("mousemove", this.nativeMoveHandler);

    // Redraw on chart updates
    this.chart.timeScale().subscribeVisibleTimeRangeChange(() => this.render());
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.render());

    // Watch for container resize
    this.resizeObserver = new ResizeObserver(() => {
      this.resizeCanvas();
    });
    this.resizeObserver.observe(container);
  }

  private resizeCanvas(): void {
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    // Reset and scale for HiDPI to avoid blurriness/ghosting
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
    this.render();
  }

  private coordinateToPoint(x: number, y: number): DrawingPoint | null {
    const timeScale = this.chart.timeScale();
    const time = timeScale.coordinateToTime(x);
    const price = this.series.coordinateToPrice(y);
    
    if (time === null || price === null) {
      return null;
    }
    
    return {
      time: toUnixTime(time),
      price: price
    };
  }

  private pointToCoordinate(point: DrawingPoint): { x: number; y: number } | null {
    const timeScale = this.chart.timeScale();
    let x = timeScale.timeToCoordinate(point.time as Time);
    const y = this.series.priceToCoordinate(point.price);

    // Fallback: if time is outside known scale (e.g., right margin), map via logical index
    if (x === null) {
      const range = timeScale.getVisibleLogicalRange();
      if (!range) return null;
      const rightLogical = (range.to as unknown as number);
      const rightCoord = timeScale.logicalToCoordinate(range.to as unknown as Logical);
      if (rightCoord === null) return null;
      const rightTime = timeScale.coordinateToTime(rightCoord);
      if (rightTime === null) return null;

      const secondsDiff = point.time - toUnixTime(rightTime);
      const logicalDelta = secondsDiff / this.intervalSeconds; // bars delta
      const targetLogical = (rightLogical + logicalDelta) as unknown as Logical;
      x = timeScale.logicalToCoordinate(targetLogical);
    }

    if (x === null || y === null) {
      return null;
    }

    return { x, y };
  }

  private onNativeMouseMove(e: MouseEvent): void {
    if (!this.isDrawing || !this.startPoint || this.currentTool === "none") {
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const timeScale = this.chart.timeScale();
    const price = this.series.coordinateToPrice(y);

    if (price === null) {
      return;
    }

    // Get time - for right margin area, coordinateToTime may return null
    let timeValue = timeScale.coordinateToTime(x);
    
    if (timeValue === null) {
      // Right margin area - find the rightmost valid time by scanning left
      let foundTime: Time | null = null;
      let foundX = x;
      
      // Scan left from current position to find last valid bar
      for (let testX = Math.floor(x) - 1; testX >= 0 && foundTime === null; testX--) {
        foundTime = timeScale.coordinateToTime(testX);
        if (foundTime !== null) {
          foundX = testX;
          break;
        }
      }
      
      // If still no time found, use the visible range to get the last bar
      if (foundTime === null) {
        const visibleRange = timeScale.getVisibleLogicalRange();
        if (visibleRange) {
          const lastLogical = Math.floor(visibleRange.to);
          // Scan backwards from the last logical index
          for (let logical = lastLogical; logical >= 0 && foundTime === null; logical--) {
            const coord = timeScale.logicalToCoordinate(logical as any);
            if (coord !== null) {
              foundTime = timeScale.coordinateToTime(coord);
              if (foundTime !== null) {
                foundX = coord;
                break;
              }
            }
          }
        }
      }
      
      // Last resort: if still no time, keep the previous currentPoint
      if (foundTime === null) {
        if (this.currentPoint) {
          // Keep drawing with last known point, just update price
          this.currentPoint = {
            time: this.currentPoint.time,
            price: price,
          };
        } else {
          // No valid reference point at all, cannot continue
          return;
        }
      } else {
        const pixelDiff = x - foundX;
        const barSpacing = timeScale.options().barSpacing || 6;
        const barCount = pixelDiff / barSpacing;
        const timeOffset = Math.round(barCount * this.intervalSeconds);
        const extrapolatedTime = toUnixTime(foundTime) + timeOffset;
        
        this.currentPoint = {
          time: extrapolatedTime,
          price: price,
        };
      }
    } else {
      this.currentPoint = {
        time: toUnixTime(timeValue),
        price: price,
      };
    }

    if (this.rafId !== null) {
      return;
    }

    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.render();
    });
  }

  private onNativeClick(e: MouseEvent): void {
    if (this.currentTool === "none") {
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const timeScale = this.chart.timeScale();
    const price = this.series.coordinateToPrice(y);

    if (price === null) {
      console.log('[Drawing] Click ignored - price is null');
      return;
    }

    // Get time - for right margin area, coordinateToTime may return null
    let timeValue = timeScale.coordinateToTime(x);
    
    if (timeValue === null) {
      // Right margin area - find the rightmost valid time
      let foundTime: Time | null = null;
      let foundX = x;
      
      // Scan left from current position
      for (let testX = Math.floor(x) - 1; testX >= 0 && foundTime === null; testX--) {
        foundTime = timeScale.coordinateToTime(testX);
        if (foundTime !== null) {
          foundX = testX;
          break;
        }
      }
      
      // If still no time, use visible range
      if (foundTime === null) {
        const visibleRange = timeScale.getVisibleLogicalRange();
        if (visibleRange) {
          const lastLogical = Math.floor(visibleRange.to);
          for (let logical = lastLogical; logical >= 0 && foundTime === null; logical--) {
            const coord = timeScale.logicalToCoordinate(logical as any);
            if (coord !== null) {
              foundTime = timeScale.coordinateToTime(coord);
              if (foundTime !== null) {
                foundX = coord;
                break;
              }
            }
          }
        }
      }
      
      if (foundTime === null) {
        console.log('[Drawing] Click ignored - cannot find reference time');
        return;
      }
      
      // Calculate pixel distance and extrapolate time
      const pixelDiff = x - foundX;
      const barSpacing = timeScale.options().barSpacing || 6;
      const barCount = pixelDiff / barSpacing;
      const timeOffset = Math.round(barCount * this.intervalSeconds);
      const extrapolatedTime = toUnixTime(foundTime) + timeOffset;
      
      console.log('[Drawing] Extrapolated time for right margin:', {
        x,
        foundX,
        pixelDiff,
        barSpacing,
        barCount,
        timeOffset,
        foundTime: toUnixTime(foundTime),
        extrapolatedTime
      });
      
      const point: DrawingPoint = {
        time: extrapolatedTime,
        price: price,
      };

      this.handleDrawingClick(point);
      return;
    }

    const point: DrawingPoint = {
      time: toUnixTime(timeValue),
      price: price,
    };

    this.handleDrawingClick(point);
  }

  private handleDrawingClick(point: DrawingPoint): void {
    if (!this.isDrawing) {
      this.isDrawing = true;
      this.startPoint = point;
      this.currentPoint = point;
      this.render();
    } else if (this.startPoint) {
      // Type guard to ensure currentTool is not "none"
      const tool = this.currentTool;
      if (tool === "none") return;
      
      const drawing: Drawing = {
        id: Date.now().toString(),
        tool: tool,
        symbol: "",
        interval: "",
        points: [this.startPoint, point],
        color: this.getColorForType(tool),
      };

      this.drawDrawing(drawing);
      
      if (this.onDrawingComplete) {
        this.onDrawingComplete(drawing);
      }

      this.isDrawing = false;
      this.startPoint = null;
      this.currentPoint = null;
      this.currentTool = "none";
      this.render();
    }
  }



  private getColorForType(type: "line" | "fib" | "rectangle"): string {
    switch (type) {
      case "line": return "#2962FF";
      case "fib": return "#FF6D00";
      case "rectangle": return "#00C853";
      default: return "#2962FF";
    }
  }

  setTool(tool: "line" | "fib" | "rectangle" | "none"): void {
    this.currentTool = tool;
    this.isDrawing = false;
    this.startPoint = null;
    this.currentPoint = null;
    
    // Only capture pointer events when a drawing tool is active
    if (tool === "none") {
      this.canvas.style.pointerEvents = "none";
      this.canvas.style.cursor = "default";
    } else {
      this.canvas.style.pointerEvents = "auto";
      this.canvas.style.cursor = "crosshair";
    }
  }

  drawDrawing(drawing: Drawing): void {
    const id = drawing.id || Date.now().toString();
    this.drawings.set(id, drawing);
    this.render();
  }

  removeDrawing(id: string): void {
    this.drawings.delete(id);
    this.render();
  }

  clearAll(): void {
    this.drawings.clear();
    this.render();
  }

  private render(): void {
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    // Ensure clean canvas in device pixels to avoid ghosting
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // Restore CSS pixel space
    this.ctx.scale(dpr, dpr);

    // Draw all saved drawings
    this.drawings.forEach(drawing => {
      const points = normalizePoints(drawing.points);
      if (points.length < 2) return;

      const toolType = drawing.type || drawing.tool;
      const color = drawing.color || this.getColorForType(toolType);

      switch (toolType) {
        case "line":
          this.drawLine(points[0], points[1], color);
          break;
        case "fib":
          this.drawFibonacci(points[0], points[1], color);
          break;
        case "rectangle":
          this.drawRectangle(points[0], points[1], color);
          break;
      }
    });

    // Draw temporary drawing while dragging
    if (this.isDrawing && this.startPoint && this.currentPoint) {
      const tempColor = "#888888";
      
      switch (this.currentTool) {
        case "line":
          this.drawLine(this.startPoint, this.currentPoint, tempColor);
          break;
        case "fib":
          this.drawFibonacci(this.startPoint, this.currentPoint, tempColor);
          break;
        case "rectangle":
          this.drawRectangle(this.startPoint, this.currentPoint, tempColor);
          break;
      }
    }
  }

  private drawLine(p1: DrawingPoint, p2: DrawingPoint, color: string): void {
    const coord1 = this.pointToCoordinate(p1);
    const coord2 = this.pointToCoordinate(p2);
    
    if (!coord1 || !coord2) return;

    this.ctx.save();
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 2;
    this.ctx.lineCap = 'round';
    
    const x1 = Math.round(coord1.x) + 0.5;
    const y1 = Math.round(coord1.y) + 0.5;
    const x2 = Math.round(coord2.x) + 0.5;
    const y2 = Math.round(coord2.y) + 0.5;

    this.ctx.beginPath();
    this.ctx.moveTo(x1, y1);
    this.ctx.lineTo(x2, y2);
    this.ctx.stroke();
    
    this.ctx.restore();
  }

  private drawRectangle(p1: DrawingPoint, p2: DrawingPoint, color: string): void {
    const coord1 = this.pointToCoordinate(p1);
    const coord2 = this.pointToCoordinate(p2);
    
    if (!coord1 || !coord2) return;

    const x = Math.min(coord1.x, coord2.x);
    const y = Math.min(coord1.y, coord2.y);
    const width = Math.abs(coord2.x - coord1.x);
    const height = Math.abs(coord2.y - coord1.y);

    this.ctx.save();
    
    // Fill with transparency
    this.ctx.fillStyle = color + '20';
    this.ctx.fillRect(x, y, width, height);
    
    // Border - align to pixel grid for crisp edges
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 1; // use 1px with 0.5 offset for crispness
    this.ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(width) - 1, Math.round(height) - 1);
    this.ctx.lineWidth = 2;
    
    this.ctx.restore();
  }

  private drawFibonacci(p1: DrawingPoint, p2: DrawingPoint, color: string): void {
    const coord1 = this.pointToCoordinate(p1);
    const coord2 = this.pointToCoordinate(p2);
    
    if (!coord1 || !coord2) return;

    const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
    const minX = Math.min(coord1.x, coord2.x);
    const maxX = Math.max(coord1.x, coord2.x);
    const height = coord2.y - coord1.y;

    this.ctx.save();
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 1;
    this.ctx.font = '12px sans-serif';
    this.ctx.fillStyle = color;

    levels.forEach(level => {
      const y = coord1.y + height * level;
      
      // Draw line
      this.ctx.beginPath();
      this.ctx.moveTo(minX, y);
      this.ctx.lineTo(maxX, y);
      this.ctx.stroke();
      
      // Draw label
      const label = `${(level * 100).toFixed(1)}%`;
      this.ctx.fillText(label, maxX + 5, y + 4);
    });
    
    this.ctx.restore();
  }

  destroy(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (this.nativeClickHandler) {
      this.canvas.removeEventListener("click", this.nativeClickHandler);
    }
    if (this.nativeMoveHandler) {
      this.canvas.removeEventListener("mousemove", this.nativeMoveHandler);
    }

    this.resizeObserver.disconnect();
    this.clearAll();
    if (this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
  }
}
