import React, { useEffect, useRef, useState, useCallback } from 'react';
import './TradingPage.css';
import { subscribeToRealtime, subscribeAccount } from '../services/websocketClient';
import { placeOrder, getAccount, setPositionTpSl, listOrders, listTrades, listClosedPositions, getAccountStats, getDailyPnl } from '../services/tradingApi';
import { Account, Order, Trade, ClosedPosition, AccountStats } from '../types/trading';
import DailyPnlHeatmap from '../components/DailyPnlHeatmap';

interface Props {}

const normalizeItems = <T,>(value: unknown): T[] => {
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (value && typeof value === "object" && Array.isArray((value as any).items)) {
    return ((value as any).items) as T[];
  }
  return [];
};

const TradingPage: React.FC<Props> = () => {
  const [symbol, setSymbol] = useState('ETH');
  const [interval, setInterval] = useState('1m');
  const [mode, setMode] = useState<'realtime' | 'playback'>('realtime');
  const [price, setPrice] = useState<number>(0);
  const [account, setAccount] = useState<Account | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [closedPositions, setClosedPositions] = useState<ClosedPosition[]>([]);
  const [stats, setStats] = useState<AccountStats | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market');
  const [limitPrice, setLimitPrice] = useState<number | undefined>();
  const [tp, setTp] = useState<number | undefined>();
  const [sl, setSl] = useState<number | undefined>();
  const [month, setMonth] = useState<string>(() => {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
  });
  const [dailyPnl, setDailyPnl] = useState<{date:string;pnl:number}[]>([]);
  const wsUnsubRef = useRef<null | (()=>void)>(null);
  const accWsRef = useRef<null | (()=>void)>(null);


  const refreshAll = useCallback(async () => {
    try {
      const context = { mode, interval } as const;
      const acc = await getAccount(symbol, context);
      setAccount(acc);
      const [ordersRes, tradesRes, closedRes] = await Promise.all([
        listOrders(symbol, context),
        listTrades(symbol, context),
        listClosedPositions(symbol, context)
      ]);
      setOrders(normalizeItems<Order>(ordersRes));
      setTrades(normalizeItems<Trade>(tradesRes));
      setClosedPositions(normalizeItems<ClosedPosition>(closedRes));

      try {
        const statsData = await getAccountStats(symbol, context);
        setStats(statsData);
      } catch (statsError) {
        console.error('[TradingPage] Failed to fetch stats', statsError);
        setStats(null);
      }

      try {
        const pnlData = await getDailyPnl(symbol, month, context);
        setDailyPnl(Array.isArray(pnlData?.days) ? pnlData.days : []);
      } catch (pnlError) {
        console.error('[TradingPage] Failed to fetch daily PnL', pnlError);
        setDailyPnl([]);
      }
    } catch (e) {
      console.error(e);
    }
  }, [mode, interval, symbol, month]);

  useEffect(() => {
    if (wsUnsubRef.current) { wsUnsubRef.current(); wsUnsubRef.current = null; }
    wsUnsubRef.current = subscribeToRealtime({
      symbol,
      interval: interval as any,
      onCandle: (candle) => {
        setPrice(candle.close);
      }
    });

    if (accWsRef.current) { accWsRef.current(); accWsRef.current = null; }
    accWsRef.current = subscribeAccount({ symbol, mode, interval, onEvent: (ev) => {
      if (ev.type === 'snapshot' || ev.type === 'order' || ev.type === 'trade' || ev.type === 'closed_position' || ev.type === 'position') {
        refreshAll();
      } else if (ev.type === 'account') {
        setAccount(a => a ? { ...a, balance: ev.balance ?? a.balance, positions_value: ev.positions_value ?? a.positions_value } : a);
      }
    }});

    return () => {
      if (wsUnsubRef.current) wsUnsubRef.current();
      if (accWsRef.current) accWsRef.current();
    };
  }, [symbol, interval, mode, refreshAll]);

  useEffect(() => { refreshAll(); }, [refreshAll]);

  async function handlePlaceOrder() {
    try {
      await placeOrder(
        symbol.toUpperCase(),
        'buy',
        orderType,
        quantity,
        {
          mode,
          interval,
          limitPrice: orderType === 'limit' ? limitPrice : undefined,
          currentPrice: price
        }
      );
      await refreshAll();
    } catch (e) { console.error(e); }
  }

  async function handleSell() {
    try {
      await placeOrder(
        symbol.toUpperCase(),
        'sell',
        orderType,
        quantity,
        {
          mode,
          interval,
          limitPrice: orderType === 'limit' ? limitPrice : undefined,
          currentPrice: price
        }
      );
      await refreshAll();
    } catch (e) { console.error(e); }
  }

  async function applyTpSl() {
    try {
      await setPositionTpSl(symbol, tp ?? null, sl ?? null, { mode, interval });
      await refreshAll();
    } catch (e){ console.error(e); }
  }

  return (
    <div className="trading-page" style={{ padding: 16, boxSizing:'border-box' }}>
      <h2>Trading Page</h2>
      <div className="flex-row">
        <div className="panel">
          <label>Symbol: <input value={symbol} onChange={e=>setSymbol(e.target.value.toUpperCase())} /></label><br />
          <label>Interval: <select value={interval} onChange={e=>setInterval(e.target.value)}>{['1m','5m','15m','1h','4h','1d'].map(i=> <option key={i}>{i}</option>)}</select></label><br />
          <label>
            模式:
            <span className="mode-badge" style={{ marginLeft: 8 }}>{mode === 'realtime' ? '实时' : '回放'}</span>
            <select value={mode} onChange={e => setMode(e.target.value as 'realtime' | 'playback')} style={{ marginLeft: 8 }}>
              <option value="realtime">实时</option>
              <option value="playback">回放</option>
            </select>
          </label><br />
          <div>Current Price: <strong>{price.toFixed(2)}</strong></div>
        </div>
        <div className="panel" style={{ minWidth:250 }}>
          <h4>Order</h4>
          <label>Qty <input type='number' value={quantity} onChange={e=>setQuantity(Number(e.target.value))} style={{ width:80 }}/></label><br />
          <label>Type <select value={orderType} onChange={e=>setOrderType(e.target.value as any)}><option value='market'>market</option><option value='limit'>limit</option></select></label><br />
          {orderType==='limit' && <label>Limit <input type='number' value={limitPrice ?? ''} onChange={e=>setLimitPrice(e.target.value?Number(e.target.value):undefined)} style={{ width:100 }}/></label>}
          <div style={{ marginTop:8 }}>
            <button onClick={handlePlaceOrder}>做多</button>
            <button onClick={handleSell} style={{ marginLeft:8 }}>做空</button>
          </div>
          <div style={{ marginTop:12 }}>
            <h5>TP / SL</h5>
            <label>TP <input type='number' value={tp ?? ''} onChange={e=>setTp(e.target.value?Number(e.target.value):undefined)} style={{ width:100 }}/></label><br />
            <label>SL <input type='number' value={sl ?? ''} onChange={e=>setSl(e.target.value?Number(e.target.value):undefined)} style={{ width:100 }}/></label><br />
            <button onClick={applyTpSl}>Apply TP/SL</button>
          </div>
        </div>
        <div className="panel" style={{ minWidth:250 }}>
          <h4>Account</h4>
          {(() => {
            const available = account?.balance ?? 0;
            const rawPositions = account?.positions ?? [];
            const marketValue = rawPositions.reduce((sum, p) => sum + Math.abs(p.quantity) * price, 0);
            const unrealizedPnl = rawPositions.reduce((sum, p) => {
              const diff = p.quantity >= 0 ? (price - p.entry_price) * p.quantity : (p.entry_price - price) * Math.abs(p.quantity);
              return sum + diff;
            }, 0);
            const totalEquity = available + marketValue + unrealizedPnl;
            return (
              <>
                <div>总权益(USD): {totalEquity.toFixed(2)}</div>
                <div>可用余额(USD): {available.toFixed(2)}</div>
                <div>持仓市值(USD): {marketValue.toFixed(2)}</div>
                <div>P&amp;L(USD): {unrealizedPnl >= 0 ? `+${unrealizedPnl.toFixed(2)}` : unrealizedPnl.toFixed(2)}</div>
              </>
            );
          })()}
          <div>Positions: {account?.positions?.length}</div>
          <div>Open Orders: {orders.length}</div>
          <div>Trades: {trades.length}</div>
          <div>Closed: {closedPositions.length}</div>
          <div>Win Rate: {((stats?.win_rate ?? 0) * 100).toFixed(2)}%</div>
        </div>
        <div className="panel" style={{ flex:1, minWidth:300 }}>
          <h4>Daily PnL Heatmap</h4>
          <label>Month <input value={month} onChange={e=>setMonth(e.target.value)} style={{ width:100 }}/></label>
          <div className='daily-heatmap-wrapper'>
            <DailyPnlHeatmap data={dailyPnl} />
          </div>
        </div>
      </div>
      <hr />
      <div className="flex-row" style={{ gap:24 }}>
        <div className="panel" style={{ flex:1, minWidth:300 }}>
          <h4>Positions</h4>
          <table style={{ width:'100%', fontSize:12 }}>
            <thead><tr><th>Symbol</th><th>Qty</th><th>Entry</th><th>TP</th><th>SL</th></tr></thead>
            <tbody>{account?.positions?.map(p=> <tr key={p.symbol}><td>{p.symbol}</td><td>{p.quantity}</td><td>{p.entry_price}</td><td>{p.take_profit_price ?? '-'}</td><td>{p.stop_loss_price ?? '-'}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="panel" style={{ flex:1, minWidth:300 }}>
          <h4>Orders</h4>
          <table style={{ width:'100%', fontSize:12 }}>
            <thead><tr><th>ID</th><th>Dir</th><th>Type</th><th>Qty</th><th>Price</th><th>Status</th></tr></thead>
            <tbody>{orders.map(o=> <tr key={o.id}><td title={o.id}>{o.id.slice(0,6)}</td><td>{o.direction}</td><td>{o.type}</td><td>{o.quantity}</td><td>{o.price ?? '-'}</td><td>{o.status}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="panel" style={{ flex:1, minWidth:300 }}>
          <h4>Trades</h4>
          <table style={{ width:'100%', fontSize:12 }}>
            <thead><tr><th>ID</th><th>Dir</th><th>Qty</th><th>Price</th><th>Time</th></tr></thead>
            <tbody>{trades.map(t=> <tr key={t.id}><td title={t.id}>{t.id.slice(0,6)}</td><td>{t.direction}</td><td>{t.quantity}</td><td>{t.price}</td><td>{new Date(t.timestamp*1000).toLocaleTimeString()}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="panel" style={{ flex:1, minWidth:300 }}>
          <h4>Closed Positions</h4>
          <table style={{ width:'100%', fontSize:12 }}>
            <thead><tr><th>ID</th><th>Dir</th><th>Qty</th><th>Entry</th><th>Exit</th><th>PNL</th></tr></thead>
            <tbody>{closedPositions.map(c=> <tr key={c.id}><td title={c.id}>{c.id.slice(0,6)}</td><td>{c.direction}</td><td>{c.quantity}</td><td>{c.entry_price}</td><td>{c.exit_price}</td><td>{c.profit_loss - c.commission}</td></tr>)}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default TradingPage;
