import { IChartApi, ISeriesApi, UTCTimestamp, MouseEventParams } from "lightweight-charts";
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
  private chartClickHandler: ((p: MouseEventParams) => void) | null = null;
  private chartMoveHandler: ((p: MouseEventParams) => void) | null = null;
  private chartDblClickHandler: ((p: MouseEventParams) => void) | null = null;
  private onToolChangeCb: ((tool: "line" | "fib" | "rectangle" | "none") => void) | null = null;

  // Color popup
  private colorPopupEl: HTMLDivElement | null = null;

  // Selection/editing
  private selectedId: string | null = null;
  private isEditing = false;
  private editingHandle: "start" | "end" | null = null;
  private onSelectionChangeCb: ((id: string | null) => void) | null = null;
  private onDrawingUpdatedCb: ((drawing: DrawingData) => void) | null = null;
  private onRemoveDrawingCb: ((id: string) => void | Promise<void>) | null = null;

  // Crosshair state
  private mouseScreenX: number | null = null;
  private mouseScreenY: number | null = null;

  // Modifier keys
  private metaDown = false;
  private shiftDown = false;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private keyupHandler: ((e: KeyboardEvent) => void) | null = null;
  private blurHandler: (() => void) | null = null;

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
      canvas.style.pointerEvents = "none"; // don't block chart interactions
      chartElement.appendChild(canvas);

      // Keep listeners off canvas to not block pan/zoom; use chart events instead
    }

    // Subscribe to chart events for positions
    this.chartClickHandler = (p: MouseEventParams) => this.onChartClick(p);
    this.chartMoveHandler = (p: MouseEventParams) => this.onChartMove(p);
    this.chart.subscribeClick(this.chartClickHandler);
    this.chart.subscribeCrosshairMove(this.chartMoveHandler);
    this.chartDblClickHandler = (p: MouseEventParams) => this.onChartDblClick(p);
    // @ts-ignore lightweight-charts has subscribeDblClick
    (this.chart as any).subscribeDblClick?.(this.chartDblClickHandler);

    // Keyboard listeners for modifiers
    this.keydownHandler = (e: KeyboardEvent) => {
      this.metaDown = !!(e.metaKey || e.ctrlKey);
      this.shiftDown = !!e.shiftKey;
      // Delete selected drawing in select mode
      if (this.currentTool === 'none' && this.selectedId && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        const id = this.selectedId;
        this.removeDrawing(id);
        if (this.onRemoveDrawingCb) {
          Promise.resolve(this.onRemoveDrawingCb(id)).catch(console.error);
        }
        this.selectedId = null;
        this.isEditing = false;
        this.editingHandle = null;
        if (this.onSelectionChangeCb) this.onSelectionChangeCb(null);
        this.hideColorPopup();
      }
    };
    this.keyupHandler = (e: KeyboardEvent) => {
      this.metaDown = !!(e.metaKey || e.ctrlKey);
      this.shiftDown = !!e.shiftKey;
    };
    this.blurHandler = () => {
      this.metaDown = false;
      this.shiftDown = false;
    };
    window.addEventListener('keydown', this.keydownHandler);
    window.addEventListener('keyup', this.keyupHandler);
    window.addEventListener('blur', this.blurHandler);

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

  private snapPointToOHLC(point: ChartPoint): ChartPoint {
    const arr = this.candles || [];
    if (!arr.length) return point;
    // find nearest by time
    let lo = 0, hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = arr[mid].time as number;
      if (t === point.time) { lo = hi = mid; break; }
      if (t < point.time) lo = mid + 1; else hi = mid - 1;
    }
    const idx = Math.max(0, Math.min(arr.length - 1, hi >= 0 ? hi : 0));
    const c = arr[idx];
    const candidates = [c.open, c.high, c.low, c.close] as number[];
    let best = candidates[0];
    let bestDiff = Math.abs(best - point.price);
    for (let i = 1; i < candidates.length; i++) {
      const d = Math.abs(candidates[i] - point.price);
      if (d < bestDiff) { bestDiff = d; best = candidates[i]; }
    }
    return { time: c.time as number, price: best };
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
      // Keep pointer events disabled so chart still receives pan/zoom/click
      this.canvas.style.pointerEvents = "none";
      this.canvas.style.cursor = tool === "none" ? "default" : "crosshair";
    }
    if (this.onToolChangeCb) {
      this.onToolChangeCb(tool);
    }
  }

  setOnToolChange(cb: (tool: "line" | "fib" | "rectangle" | "none") => void): void {
    this.onToolChangeCb = cb;
  }

  setOnDrawingComplete(callback: (drawing: DrawingData) => Promise<void>): void {
    this.onDrawingComplete = callback;
  }

  private secondsForInterval(iv: Interval): number {
    const map = this.intervalSecondsMap as any;
    return map[iv] ?? 60;
  }

  private mapTimeAcrossIntervals(timeSec: number, from: Interval, to: Interval, isEnd: boolean): number {
    if (from === to) return timeSec;
    const fromSec = this.secondsForInterval(from);
    const toSec = this.secondsForInterval(to);
    if (fromSec < toSec) {
      // small -> big: snap to containing bigger bar open
      return Math.floor(timeSec / toSec) * toSec;
    } else if (fromSec > toSec) {
      // big -> small
      const blockStart = Math.floor(timeSec / fromSec) * fromSec;
      if (!isEnd) {
        // start -> first smaller bar
        return blockStart;
      } else {
        // end -> last smaller bar open
        const lastSmallOpen = blockStart + (fromSec - toSec);
        return lastSmallOpen;
      }
    }
    return timeSec;
  }

  private snapToExistingTime(timeSec: number): number {
    const arr = this.candles || [];
    if (arr.length === 0) return timeSec;
    let lo = 0, hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = arr[mid].time as number;
      if (t === timeSec) return t;
      if (t < timeSec) lo = mid + 1; else hi = mid - 1;
    }
    const idx1 = Math.max(0, Math.min(arr.length - 1, lo));
    const idx0 = Math.max(0, Math.min(arr.length - 1, lo - 1));
    const t1 = arr[idx1].time as number;
    const t0 = arr[idx0].time as number;
    // prefer exact floor if within the same bar alignment
    return Math.abs(t1 - timeSec) < Math.abs(timeSec - t0) ? t1 : t0;
  }

  private transformDrawingForCurrentInterval(d: DrawingData): DrawingData {
    const toIv = this.interval;
    const basePoints = (d as any).properties?.basePoints ?? d.points;
    const baseInterval: Interval = (d as any).properties?.baseInterval ?? (d.interval as Interval) ?? toIv;
    const pts = basePoints ?? [];
    const p1 = pts[0] as any;
    const p2 = pts[1] as any;
    if (!p1 || !p2 || typeof p1.time !== 'number' || typeof p2.time !== 'number') return { ...d, interval: toIv } as DrawingData;

    const t1 = this.mapTimeAcrossIntervals(p1.time, baseInterval, toIv, false);
    const t2 = this.mapTimeAcrossIntervals(p2.time, baseInterval, toIv, true);

    const out: DrawingData = {
      ...d,
      interval: toIv,
      points: [
        { time: t1, price: p1.price },
        { time: t2, price: p2.price },
      ],
      properties: {
        ...(d as any).properties,
        basePoints: basePoints,
        baseInterval: baseInterval,
      }
    } as DrawingData;
    return out;
  }

  loadDrawings(drawings: DrawingData[]): void {
    this.drawings.clear();
    for (const drawing of drawings) {
      if (drawing.id) {
        const mapped = this.transformDrawingForCurrentInterval(drawing);
        this.drawings.set(drawing.id, mapped);
      }
    }
  }

  // Handle chart click using chart events (allows pan/zoom to work)
  private hitTestHandles(screenX: number, screenY: number): { id: string; handle: "start" | "end" } | null {
    const threshold = 8;
    let best: { id: string; handle: "start" | "end"; dist: number } | null = null;
    for (const d of this.drawings.values()) {
      const [p1Data, p2Data] = d.points;
      if (!p1Data || !p2Data) continue;
      const p1 = this.chartToScreenPoint({ time: p1Data.time as number, price: (p1Data as any).price as number });
      const p2 = this.chartToScreenPoint({ time: p2Data.time as number, price: (p2Data as any).price as number });
      if (!p1 || !p2) continue;
      const dx1 = p1.x - screenX; const dy1 = p1.y - screenY;
      const dx2 = p2.x - screenX; const dy2 = p2.y - screenY;
      const d1 = dx1 * dx1 + dy1 * dy1;
      const d2 = dx2 * dx2 + dy2 * dy2;
      if (d1 <= threshold * threshold) {
        if (!best || d1 < best.dist) best = { id: d.id!, handle: "start", dist: d1 };
      }
      if (d2 <= threshold * threshold) {
        if (!best || d2 < best.dist) best = { id: d.id!, handle: "end", dist: d2 };
      }
      // Fallback: near line segment
      if (d.tool === 'line') {
        const distSeg = this.distanceToSegment(screenX, screenY, p1.x, p1.y, p2.x, p2.y);
        if (distSeg <= threshold) {
          // choose closer endpoint as handle
          const choose = d1 <= d2 ? "start" : "end";
          const dist = Math.min(d1, d2);
          if (!best || dist < best.dist) best = { id: d.id!, handle: choose, dist };
        }
      }
    }
    return best ? { id: best.id, handle: best.handle } : null;
  }

  private distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
    const vx = x2 - x1, vy = y2 - y1;
    const wx = px - x1, wy = py - y1;
    const c1 = vx * wx + vy * wy;
    if (c1 <= 0) return Math.hypot(px - x1, py - y1);
    const c2 = vx * vx + vy * vy;
    if (c2 <= c1) return Math.hypot(px - x2, py - y2);
    const b = c1 / c2;
    const bx = x1 + b * vx, by = y1 + b * vy;
    return Math.hypot(px - bx, py - by);
  }

  private hitTestShape(screenX: number, screenY: number): string | null {
    const threshold = 6;
    for (const d of this.drawings.values()) {
      const [p1d, p2d] = d.points;
      if (!p1d || !p2d) continue;
      const p1 = this.chartToScreenPoint({ time: p1d.time as number, price: (p1d as any).price as number });
      const p2 = this.chartToScreenPoint({ time: p2d.time as number, price: (p2d as any).price as number });
      if (!p1 || !p2) continue;
      if (d.tool === 'line') {
        const dist = this.distanceToSegment(screenX, screenY, p1.x, p1.y, p2.x, p2.y);
        if (dist <= threshold) return d.id!;
      } else if (d.tool === 'rectangle') {
        const minX = Math.min(p1.x, p2.x) - threshold;
        const maxX = Math.max(p1.x, p2.x) + threshold;
        const minY = Math.min(p1.y, p2.y) - threshold;
        const maxY = Math.max(p1.y, p2.y) + threshold;
        if (screenX >= minX && screenX <= maxX && screenY >= minY && screenY <= maxY) return d.id!;
      }
    }
    return null;
  }

  private onChartDblClick(param: MouseEventParams): void {
    if (!param.point) return;
    if (this.currentTool !== 'none') return;
    const { x, y } = param.point;
    // Prefer handle, else body
    const hit = this.hitTestHandles(x, y);
    const id = hit?.id ?? this.hitTestShape(x, y);
    if (!id) return;
    this.selectedId = id;
    this.isEditing = false;
    this.editingHandle = hit ? hit.handle : null;
    if (this.onSelectionChangeCb) this.onSelectionChangeCb(this.selectedId);
    this.showColorPopup(x, y);
  }

  private ensureColorPopup(): HTMLDivElement | null {
    if (this.colorPopupEl && document.body.contains(this.colorPopupEl)) return this.colorPopupEl;
    const container = document.querySelector('[data-chart-container]') as HTMLElement | null;
    if (!container) return null;
    const el = document.createElement('div');
    el.style.position = 'absolute';
    el.style.zIndex = '30';
    el.style.background = 'rgba(255,255,255,0.98)';
    el.style.border = '1px solid rgba(0,0,0,0.2)';
    el.style.borderRadius = '6px';
    el.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
    el.style.padding = '8px';
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.gap = '8px';

    const label = document.createElement('span');
    label.textContent = '颜色:';
    label.style.fontSize = '12px';

    const input = document.createElement('input');
    input.type = 'color';
    input.style.width = '28px';
    input.style.height = '28px';
    input.style.border = 'none';
    input.style.background = 'transparent';
    input.addEventListener('input', () => {
      const color = (input as HTMLInputElement).value;
      this.setSelectedColor(color);
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.textContent = '删除';
    delBtn.style.fontSize = '12px';
    delBtn.style.cursor = 'pointer';
    delBtn.addEventListener('click', () => {
      if (!this.selectedId) return;
      const id = this.selectedId;
      this.removeDrawing(id);
      if (this.onRemoveDrawingCb) Promise.resolve(this.onRemoveDrawingCb(id)).catch(console.error);
      this.selectedId = null;
      this.isEditing = false;
      this.editingHandle = null;
      if (this.onSelectionChangeCb) this.onSelectionChangeCb(null);
      this.hideColorPopup();
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '关闭';
    closeBtn.style.fontSize = '12px';
    closeBtn.style.cursor = 'pointer';
    closeBtn.addEventListener('click', () => this.hideColorPopup());

    el.appendChild(label);
    el.appendChild(input);
    el.appendChild(delBtn);
    el.appendChild(closeBtn);
    container.appendChild(el);

    this.colorPopupEl = el;
    return el;
  }

  private showColorPopup(x: number, y: number): void {
    const el = this.ensureColorPopup();
    if (!el) return;
    el.style.left = `${Math.round(x + 10)}px`;
    el.style.top = `${Math.round(y + 10)}px`;
    el.style.bottom = '';
    el.style.display = 'flex';
    // sync current color to input
    const input = el.querySelector('input[type="color"]') as HTMLInputElement | null;
    const d = this.getSelectedDrawing?.() as any;
    if (input && d?.color) input.value = d.color;
  }

  private showColorPopupBottomLeft(): void {
    const el = this.ensureColorPopup();
    if (!el) return;
    el.style.left = '12px';
    el.style.bottom = '12px';
    el.style.top = '';
    el.style.display = 'flex';
    const input = el.querySelector('input[type="color"]') as HTMLInputElement | null;
    const d = this.getSelectedDrawing?.() as any;
    if (input && d?.color) input.value = d.color;
  }

  private hideColorPopup(): void {
    if (!this.colorPopupEl) return;
    this.colorPopupEl.style.display = 'none';
  }

  private onChartClick(param: MouseEventParams): void {
    if (!param.point) return;
    const { x, y } = param.point;

    // Selection/editing when tool is none
    if (this.currentTool === "none") {
      const hit = this.hitTestHandles(x, y);
      if (hit) {
        if (this.selectedId !== hit.id) {
          // First click: select shape only, expose handles
          this.selectedId = hit.id;
          this.isEditing = false;
          this.editingHandle = null;
        } else {
          // Second click on same handle toggles editing
          if (this.isEditing && this.editingHandle === hit.handle) {
            this.isEditing = false;
            this.editingHandle = null;
          } else {
            this.isEditing = true;
            this.editingHandle = hit.handle;
          }
        }
        if (this.onSelectionChangeCb) this.onSelectionChangeCb(this.selectedId);
        this.showColorPopupBottomLeft();
        return;
      }
      const bodyId = this.hitTestShape(x, y);
      if (bodyId) {
        this.selectedId = bodyId;
        this.isEditing = false;
        this.editingHandle = null;
        if (this.onSelectionChangeCb) this.onSelectionChangeCb(this.selectedId);
        this.showColorPopupBottomLeft();
        return;
      }
      // click empty area: clear selection / stop editing
      this.selectedId = null;
      this.isEditing = false;
      this.editingHandle = null;
      if (this.onSelectionChangeCb) this.onSelectionChangeCb(this.selectedId);
      this.hideColorPopup();
      return;
    }

    // Drawing flow for active tools
    let chartPoint = this.screenToChartPoint(x, y);
    if (!chartPoint) return;

    if (this.metaDown) {
      chartPoint = this.snapPointToOHLC(chartPoint);
    }

    if (!this.isDrawing) {
      this.isDrawing = true;
      this.startPoint = chartPoint;
      this.currentMousePoint = chartPoint;
    } else if (this.startPoint) {
      let endChartPoint = chartPoint;
      if (this.currentTool === 'line' && this.shiftDown) {
        endChartPoint = { time: endChartPoint.time, price: this.startPoint.price };
      }
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
      this.setTool("none");
    }
  }

  private onChartMove(param: MouseEventParams): void {
    if (!param.point) return;
    const { x, y } = param.point;
    if (this.currentTool !== "none") {
      this.mouseScreenX = x;
      this.mouseScreenY = y;
    }

    // Editing in select mode
    if (this.currentTool === "none" && this.isEditing && this.selectedId && this.editingHandle) {
      let chartPoint = this.screenToChartPoint(x, y);
      if (!chartPoint) return;
      if (this.metaDown) chartPoint = this.snapPointToOHLC(chartPoint);
      const d = this.drawings.get(this.selectedId);
      if (!d) return;
      const newPoints = [...(d.points ?? [])];
      const idx = this.editingHandle === "start" ? 0 : 1;
      // Shift in edit mode: keep line horizontal by locking price to the opposite handle
      if (this.shiftDown && d.tool === 'line') {
        const otherIdx = idx === 0 ? 1 : 0;
        chartPoint = { time: chartPoint.time, price: (newPoints[otherIdx] as any).price as number };
      }
      newPoints[idx] = { time: chartPoint.time, price: chartPoint.price } as any;
      // update basePoints to current interval to keep deterministic mapping
      const props: any = { ...(d as any).properties, baseInterval: this.interval, basePoints: newPoints.map(p => ({ time: p.time, price: p.price })) };
      const updated: DrawingData = { ...d, points: newPoints as any, properties: props } as any;
      this.drawings.set(d.id!, updated);
      if (this.onDrawingUpdatedCb) this.onDrawingUpdatedCb(updated);
      return;
    }

    // Normal preview update
    let chartPoint = this.screenToChartPoint(x, y);
    if (!chartPoint) return;
    if (this.metaDown) chartPoint = this.snapPointToOHLC(chartPoint);
    if (this.isDrawing && this.currentTool === 'line' && this.startPoint && this.shiftDown) {
      chartPoint = { time: chartPoint.time, price: this.startPoint.price };
    }
    this.currentMousePoint = chartPoint;
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
      properties: {
        baseInterval: this.interval,
        basePoints: [ { time: p1.time, price: p1.price }, { time: p2.time, price: p2.price } ]
      } as any,
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
    if (
      typeof (p1Data as any).time !== 'number' || typeof (p1Data as any).price !== 'number' ||
      typeof (p2Data as any).time !== 'number' || typeof (p2Data as any).price !== 'number'
    ) return;

    const p1 = this.chartToScreenPoint({ time: p1Data.time as number, price: p1Data.price as number });
    const p2 = this.chartToScreenPoint({ time: p2Data.time as number, price: p2Data.price as number });

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

    // Draw handles if selected
    if (this.selectedId === drawing.id) {
      const handleRadius = 5;
      this.ctx.save();
      this.ctx.fillStyle = "#111";
      this.ctx.strokeStyle = "#fff";
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.arc(p1.x, p1.y, handleRadius, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.stroke();
      this.ctx.beginPath();
      this.ctx.arc(p2.x, p2.y, handleRadius, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.stroke();
      this.ctx.restore();
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

  // Color helpers
  private getSelectedDrawing(): DrawingData | null {
    if (!this.selectedId) return null;
    return this.drawings.get(this.selectedId) ?? null;
  }

  private setSelectedColor(color: string): void {
    if (!this.selectedId) return;
    const d = this.drawings.get(this.selectedId);
    if (!d) return;
    const updated: DrawingData = { ...d, color } as any;
    this.drawings.set(d.id!, updated);
    if (this.onDrawingUpdatedCb) this.onDrawingUpdatedCb(updated);
  }

  setOnDrawingUpdated(callback: (drawing: DrawingData) => void): void {
    this.onDrawingUpdatedCb = callback;
  }

  setOnRemoveDrawing(cb: (id: string) => void | Promise<void>): void {
    this.onRemoveDrawingCb = cb;
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
    if (this.chartClickHandler) this.chart.unsubscribeClick(this.chartClickHandler);
    if (this.chartMoveHandler) this.chart.unsubscribeCrosshairMove(this.chartMoveHandler);
    if (this.chartDblClickHandler) (this.chart as any).unsubscribeDblClick?.(this.chartDblClickHandler);
    if (this.keydownHandler) window.removeEventListener('keydown', this.keydownHandler);
    if (this.keyupHandler) window.removeEventListener('keyup', this.keyupHandler);
    if (this.blurHandler) window.removeEventListener('blur', this.blurHandler);
    if (this.colorPopupEl && this.colorPopupEl.parentElement) this.colorPopupEl.parentElement.removeChild(this.colorPopupEl);
    if (this.canvas) {
      this.canvas.remove();
    }
  }
}
