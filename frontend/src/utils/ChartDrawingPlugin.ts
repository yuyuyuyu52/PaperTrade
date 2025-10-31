import {
  IChartApi,
  ISeriesApi,
  SeriesType,
  Time,
  UTCTimestamp,
  MouseEventParams,
  Logical,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  BusinessDay,
} from "lightweight-charts";

export interface DrawingPoint {
  time: number;
  price: number;
}

// 兼容 DrawingData 接口
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

// 将 BusinessDay 或 UTCTimestamp 转换为 Unix 时间戳
function toUnixTime(value: BusinessDay | UTCTimestamp | Time): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
  }

  // BusinessDay object
  return Math.floor(Date.UTC((value as BusinessDay).year, (value as BusinessDay).month - 1, (value as BusinessDay).day) / 1000);
}

// 将 DrawingData 转换为内部 DrawingPoint 格式
function normalizePoints(points: Array<any>): DrawingPoint[] {
  return points.map(p => ({
    time: p.time || 0,
    price: p.price || 0,
  })).filter(p => p.time && p.price);
}

// 趋势线渲染器 - 使用 LightweightCharts 原生 Primitive API
class TrendLinePaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _x1: number;
  private _y1: number;
  private _x2: number;
  private _y2: number;
  private _color: string;

  constructor(x1: number, y1: number, x2: number, y2: number, color: string) {
    this._x1 = x1;
    this._y1 = y1;
    this._x2 = x2;
    this._y2 = y2;
    this._color = color;
  }

  draw(target: any) {
    target.useBitmapCoordinateSpace((scope: any) => {
      const ctx = scope.context;
      ctx.save();
      ctx.strokeStyle = this._color;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      
      ctx.beginPath();
      ctx.moveTo(this._x1, this._y1);
      ctx.lineTo(this._x2, this._y2);
      ctx.stroke();
      
      ctx.restore();
    });
  }
}

// 趋势线视图 - 负责坐标转换
class TrendLinePaneView implements ISeriesPrimitivePaneView {
  private _p1: DrawingPoint;
  private _p2: DrawingPoint;
  private _color: string;
  private _source: TrendLinePrimitive;

  constructor(source: TrendLinePrimitive, p1: DrawingPoint, p2: DrawingPoint, color: string) {
    this._source = source;
    this._p1 = p1;
    this._p2 = p2;
    this._color = color;
  }

  renderer() {
    // 坐标转换：价格/时间 → 屏幕坐标
    const chart = this._source.chart();
    const series = this._source.series();
    
    if (!chart || !series) {
      return new TrendLinePaneRenderer(0, 0, 0, 0, this._color);
    }

    const timeScale = chart.timeScale();
    
    // 转换时间到屏幕 X 坐标
    const x1 = timeScale.timeToCoordinate(this._p1.time as Time);
    const x2 = timeScale.timeToCoordinate(this._p2.time as Time);
    
    // 转换价格到屏幕 Y 坐标
    const y1 = series.priceToCoordinate(this._p1.price);
    const y2 = series.priceToCoordinate(this._p2.price);
    
    if (x1 === null || x2 === null || y1 === null || y2 === null) {
      return new TrendLinePaneRenderer(0, 0, 0, 0, this._color);
    }
    
    return new TrendLinePaneRenderer(x1, y1, x2, y2, this._color);
  }
}

// 矩形渲染器
class RectanglePaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _x1: number;
  private _y1: number;
  private _x2: number;
  private _y2: number;
  private _color: string;

  constructor(x1: number, y1: number, x2: number, y2: number, color: string) {
    this._x1 = x1;
    this._y1 = y1;
    this._x2 = x2;
    this._y2 = y2;
    this._color = color;
  }

  draw(target: any) {
    target.useBitmapCoordinateSpace((scope: any) => {
      const ctx = scope.context;
      ctx.save();
      
      // 边框
      ctx.strokeStyle = this._color;
      ctx.lineWidth = 2;
      ctx.strokeRect(this._x1, this._y1, this._x2 - this._x1, this._y2 - this._y1);
      
      // 半透明填充
      ctx.fillStyle = this._color + '20'; // 添加透明度
      ctx.fillRect(this._x1, this._y1, this._x2 - this._x1, this._y2 - this._y1);
      
      ctx.restore();
    });
  }
}

// 矩形视图
class RectanglePaneView implements ISeriesPrimitivePaneView {
  private _p1: DrawingPoint;
  private _p2: DrawingPoint;
  private _color: string;
  private _source: RectanglePrimitive;

  constructor(source: RectanglePrimitive, p1: DrawingPoint, p2: DrawingPoint, color: string) {
    this._source = source;
    this._p1 = p1;
    this._p2 = p2;
    this._color = color;
  }

  renderer() {
    const chart = this._source.chart();
    const series = this._source.series();
    
    if (!chart || !series) {
      return new RectanglePaneRenderer(0, 0, 0, 0, this._color);
    }

    const timeScale = chart.timeScale();
    const x1 = timeScale.timeToCoordinate(this._p1.time as Time);
    const x2 = timeScale.timeToCoordinate(this._p2.time as Time);
    const y1 = series.priceToCoordinate(this._p1.price);
    const y2 = series.priceToCoordinate(this._p2.price);
    
    if (x1 === null || x2 === null || y1 === null || y2 === null) {
      return new RectanglePaneRenderer(0, 0, 0, 0, this._color);
    }
    
    return new RectanglePaneRenderer(x1, y1, x2, y2, this._color);
  }
}

// 矩形 Primitive
class RectanglePrimitive implements ISeriesPrimitive<Time> {
  private _p1: DrawingPoint;
  private _p2: DrawingPoint;
  private _color: string;
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<SeriesType> | null = null;
  private _paneViews: RectanglePaneView[] = [];

  constructor(p1: DrawingPoint, p2: DrawingPoint, color: string = "#2962FF") {
    this._p1 = p1;
    this._p2 = p2;
    this._color = color;
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart;
    this._series = param.series;
    this._paneViews = [new RectanglePaneView(this, this._p1, this._p2, this._color)];
  }

  detached(): void {
    this._chart = null;
    this._series = null;
    this._paneViews = [];
  }

  paneViews() {
    return this._paneViews;
  }

  updateAllViews() {
    // Just mark views as dirty, don't recreate them
    if (this._paneViews.length > 0) {
      this._paneViews[0] = new RectanglePaneView(this, this._p1, this._p2, this._color);
    }
  }

  chart(): IChartApi | null {
    return this._chart;
  }

  series(): ISeriesApi<SeriesType> | null {
    return this._series;
  }

  updatePoints(p1: DrawingPoint, p2: DrawingPoint): void {
    this._p1 = p1;
    this._p2 = p2;
    this.updateAllViews();
  }
}

// 斐波那契回撤渲染器
class FibonacciPaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _x1: number;
  private _y1: number;
  private _x2: number;
  private _y2: number;
  private _color: string;
  private _levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

  constructor(x1: number, y1: number, x2: number, y2: number, color: string) {
    this._x1 = x1;
    this._y1 = y1;
    this._x2 = x2;
    this._y2 = y2;
    this._color = color;
  }

  draw(target: any) {
    target.useBitmapCoordinateSpace((scope: any) => {
      const ctx = scope.context;
      ctx.save();
      ctx.strokeStyle = this._color;
      ctx.lineWidth = 1;
      ctx.font = '12px sans-serif';
      ctx.fillStyle = this._color;

      const height = this._y2 - this._y1;
      const minX = Math.min(this._x1, this._x2);
      const maxX = Math.max(this._x1, this._x2);

      // 绘制每个斐波那契水平线
      this._levels.forEach(level => {
        const y = this._y1 + height * level;
        
        // 绘制线
        ctx.beginPath();
        ctx.moveTo(minX, y);
        ctx.lineTo(maxX, y);
        ctx.stroke();
        
        // 绘制标签
        const label = `${(level * 100).toFixed(1)}%`;
        ctx.fillText(label, maxX + 5, y + 4);
      });
      
      ctx.restore();
    });
  }
}

// 斐波那契视图
class FibonacciPaneView implements ISeriesPrimitivePaneView {
  private _p1: DrawingPoint;
  private _p2: DrawingPoint;
  private _color: string;
  private _source: FibonacciPrimitive;

  constructor(source: FibonacciPrimitive, p1: DrawingPoint, p2: DrawingPoint, color: string) {
    this._source = source;
    this._p1 = p1;
    this._p2 = p2;
    this._color = color;
  }

  renderer() {
    const chart = this._source.chart();
    const series = this._source.series();
    
    if (!chart || !series) {
      return new FibonacciPaneRenderer(0, 0, 0, 0, this._color);
    }

    const timeScale = chart.timeScale();
    const x1 = timeScale.timeToCoordinate(this._p1.time as Time);
    const x2 = timeScale.timeToCoordinate(this._p2.time as Time);
    const y1 = series.priceToCoordinate(this._p1.price);
    const y2 = series.priceToCoordinate(this._p2.price);
    
    if (x1 === null || x2 === null || y1 === null || y2 === null) {
      return new FibonacciPaneRenderer(0, 0, 0, 0, this._color);
    }
    
    return new FibonacciPaneRenderer(x1, y1, x2, y2, this._color);
  }
}

// 斐波那契 Primitive
class FibonacciPrimitive implements ISeriesPrimitive<Time> {
  private _p1: DrawingPoint;
  private _p2: DrawingPoint;
  private _color: string;
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<SeriesType> | null = null;
  private _paneViews: FibonacciPaneView[] = [];

  constructor(p1: DrawingPoint, p2: DrawingPoint, color: string = "#2962FF") {
    this._p1 = p1;
    this._p2 = p2;
    this._color = color;
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart;
    this._series = param.series;
    this._paneViews = [new FibonacciPaneView(this, this._p1, this._p2, this._color)];
  }

  detached(): void {
    this._chart = null;
    this._series = null;
    this._paneViews = [];
  }

  paneViews() {
    return this._paneViews;
  }

  updateAllViews() {
    // Just mark views as dirty, don't recreate them
    if (this._paneViews.length > 0) {
      this._paneViews[0] = new FibonacciPaneView(this, this._p1, this._p2, this._color);
    }
  }

  chart(): IChartApi | null {
    return this._chart;
  }

  series(): ISeriesApi<SeriesType> | null {
    return this._series;
  }

  updatePoints(p1: DrawingPoint, p2: DrawingPoint): void {
    this._p1 = p1;
    this._p2 = p2;
    this.updateAllViews();
  }
}

// 趋势线 Primitive - LightweightCharts 原生接口
class TrendLinePrimitive implements ISeriesPrimitive<Time> {
  private _p1: DrawingPoint;
  private _p2: DrawingPoint;
  private _color: string;
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<SeriesType> | null = null;
  private _paneViews: TrendLinePaneView[] = [];

  constructor(p1: DrawingPoint, p2: DrawingPoint, color: string = "#2962FF") {
    this._p1 = p1;
    this._p2 = p2;
    this._color = color;
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart;
    this._series = param.series;
    this._paneViews = [new TrendLinePaneView(this, this._p1, this._p2, this._color)];
  }

  detached(): void {
    this._chart = null;
    this._series = null;
    this._paneViews = [];
  }

  paneViews() {
    return this._paneViews;
  }

  updateAllViews() {
    // 更新所有视图
    this._paneViews = [new TrendLinePaneView(this, this._p1, this._p2, this._color)];
  }

  // 提供访问器供 PaneView 使用
  chart(): IChartApi | null {
    return this._chart;
  }

  series(): ISeriesApi<SeriesType> | null {
    return this._series;
  }

  // 更新数据
  updatePoints(p1: DrawingPoint, p2: DrawingPoint): void {
    this._p1 = p1;
    this._p2 = p2;
    this.updateAllViews();
  }
}

// 绘图插件 - 使用 LightweightCharts 原生 API
export class ChartDrawingPlugin {
  private chart: IChartApi;
  private series: ISeriesApi<SeriesType>;
  private drawings: Map<string, Drawing> = new Map();
  private primitives: Map<string, ISeriesPrimitive<Time>> = new Map();
  private currentTool: "line" | "fib" | "rectangle" | "none" = "none";
  private isDrawing = false;
  private startPoint: DrawingPoint | null = null;
  private tempPrimitive: ISeriesPrimitive<Time> | null = null;
  private onDrawingComplete: ((drawing: Drawing) => Promise<void>) | null = null;
  private currentMousePoint: DrawingPoint | null = null;
  private clickHandler: ((param: MouseEventParams) => void) | null = null;
  private moveHandler: ((param: MouseEventParams) => void) | null = null;
  private rafId: number | null = null;

  constructor(
    chart: IChartApi,
    series: ISeriesApi<SeriesType>,
    onDrawingComplete?: (drawing: Drawing) => Promise<void>
  ) {
    this.chart = chart;
    this.series = series;
    this.onDrawingComplete = onDrawingComplete || null;

    // 使用 LightweightCharts 原生的鼠标事件系统
    this.clickHandler = this.onClick.bind(this);
    this.moveHandler = this.onMouseMove.bind(this);
    
    this.chart.subscribeClick(this.clickHandler);
    this.chart.subscribeCrosshairMove(this.moveHandler);
  }

  private onMouseMove(param: MouseEventParams): void {
    if (!this.isDrawing || !this.startPoint || this.currentTool === "none") {
      return;
    }

    // 从 LightweightCharts 事件参数获取价格和时间
    if (!param.point || !param.time) {
      return;
    }

    const price = this.series.coordinateToPrice(param.point.y);
    if (price === null) {
      return;
    }

    const currentPoint: DrawingPoint = {
      time: toUnixTime(param.time),
      price: price,
    };

    this.currentMousePoint = currentPoint;

    // Use requestAnimationFrame to throttle updates
    if (this.rafId !== null) {
      return;
    }

    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      
      const tempColor = "#888888"; // 灰色表示临时

      // 如果已有临时图形，更新它而不是重新创建
      if (this.tempPrimitive && 'updatePoints' in this.tempPrimitive && this.currentMousePoint) {
        (this.tempPrimitive as any).updatePoints(this.startPoint!, this.currentMousePoint);
        // Force chart to redraw by requesting a time scale update
        this.chart.timeScale().applyOptions({});
        return;
      }

      // 首次创建临时图形
      if (!this.currentMousePoint) return;
      
      let primitive: ISeriesPrimitive<Time>;

      switch (this.currentTool) {
        case "line":
          primitive = new TrendLinePrimitive(this.startPoint!, this.currentMousePoint, tempColor);
          break;
        case "fib":
          primitive = new FibonacciPrimitive(this.startPoint!, this.currentMousePoint, tempColor);
          break;
        case "rectangle":
          primitive = new RectanglePrimitive(this.startPoint!, this.currentMousePoint, tempColor);
          break;
        default:
          return;
      }

      this.series.attachPrimitive(primitive);
      this.tempPrimitive = primitive;
    });
  }

  private onClick(param: MouseEventParams): void {
    if (this.currentTool === "none") {
      return;
    }

    // 从 LightweightCharts 事件参数获取价格和时间
    if (!param.point || !param.time) {
      console.log('[Drawing] Click ignored - no point or time', param);
      return;
    }

    const price = this.series.coordinateToPrice(param.point.y);
    if (price === null) {
      console.log('[Drawing] Click ignored - price is null');
      return;
    }

    const point: DrawingPoint = {
      time: toUnixTime(param.time),
      price: price,
    };

    console.log('[Drawing] Click captured:', point, 'isDrawing:', this.isDrawing);

    if (!this.isDrawing) {
      // 开始绘制 - 立即创建临时图形
      this.isDrawing = true;
      this.startPoint = point;
      this.currentMousePoint = point;
      
      const tempColor = "#888888";
      let primitive: ISeriesPrimitive<Time>;

      switch (this.currentTool) {
        case "line":
          primitive = new TrendLinePrimitive(point, point, tempColor);
          break;
        case "fib":
          primitive = new FibonacciPrimitive(point, point, tempColor);
          break;
        case "rectangle":
          primitive = new RectanglePrimitive(point, point, tempColor);
          break;
        default:
          return;
      }

      this.series.attachPrimitive(primitive);
      this.tempPrimitive = primitive;
      console.log('[Drawing] Drawing started at:', point, 'with temporary primitive');
    } else if (this.startPoint) {
      // 移除临时图形
      if (this.tempPrimitive) {
        this.series.detachPrimitive(this.tempPrimitive);
        this.tempPrimitive = null;
      }

      // 完成绘制
      const drawing: Drawing = {
        id: Date.now().toString(),
        tool: this.currentTool,
        symbol: "",
        interval: "",
        points: [this.startPoint, point],
        color: this.getColorForType(this.currentTool),
      };

      this.drawDrawing(drawing);
      
      if (this.onDrawingComplete) {
        this.onDrawingComplete(drawing);
      }

      // 重置状态
      this.isDrawing = false;
      this.startPoint = null;
      this.currentTool = "none";
    }
  }

  private getColorForType(type: "line" | "fib" | "rectangle"): string {
    switch (type) {
      case "line":
        return "#2962FF";
      case "fib":
        return "#FF6D00";
      case "rectangle":
        return "#00C853";
      default:
        return "#2962FF";
    }
  }

  setTool(tool: "line" | "fib" | "rectangle" | "none"): void {
    this.currentTool = tool;
  }

  // 绘制图形 - 使用原生 Primitive API
  drawDrawing(drawing: Drawing): void {
    const id = drawing.id || Date.now().toString();
    this.drawings.set(id, drawing);

    // 标准化点数据
    const points = normalizePoints(drawing.points);
    if (points.length < 2) return;

    const [p1, p2] = points;
    let primitive: ISeriesPrimitive<Time>;

    // 获取工具类型（兼容 type 和 tool 字段）
    const toolType = drawing.type || drawing.tool;
    if (!toolType) return;

    // 根据类型创建不同的 primitive
    switch (toolType) {
      case "line":
        primitive = new TrendLinePrimitive(p1, p2, drawing.color || "#2962FF");
        break;
      case "fib":
        primitive = new FibonacciPrimitive(p1, p2, drawing.color || "#FF6D00");
        break;
      case "rectangle":
        primitive = new RectanglePrimitive(p1, p2, drawing.color || "#00C853");
        break;
      default:
        return;
    }
    
    // 将 primitive 附加到系列
    this.series.attachPrimitive(primitive);
    this.primitives.set(id, primitive);
  }

  // 删除图形
  removeDrawing(id: string): void {
    const primitive = this.primitives.get(id);
    if (primitive) {
      this.series.detachPrimitive(primitive);
      this.primitives.delete(id);
    }
    this.drawings.delete(id);
  }

  // 清空所有图形
  clearAll(): void {
    this.primitives.forEach((primitive) => {
      this.series.detachPrimitive(primitive);
    });
    this.primitives.clear();
    this.drawings.clear();
  }

  destroy(): void {
    // Cancel any pending animation frames
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    // 移除 LightweightCharts 事件监听
    if (this.clickHandler) {
      this.chart.unsubscribeClick(this.clickHandler);
    }
    if (this.moveHandler) {
      this.chart.unsubscribeCrosshairMove(this.moveHandler);
    }

    // 清理临时图形
    if (this.tempPrimitive) {
      this.series.detachPrimitive(this.tempPrimitive);
      this.tempPrimitive = null;
    }

    this.clearAll();
  }
}
