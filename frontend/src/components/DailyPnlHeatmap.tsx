import React from 'react';

interface Entry { date: string; pnl: number; }
interface Props { data: Entry[]; }

const DailyPnlHeatmap: React.FC<Props> = ({ data }) => {
  // Build month calendar (assumes all data entries belong to same YYYY-MM)
  const daysByDate = new Map<string, number>();
  data.forEach(d => daysByDate.set(d.date, d.pnl));
  const monthStr = data[0]?.date?.slice(0,7) || new Date().toISOString().slice(0,7);
  const [year, month] = monthStr.split('-').map(Number);
  const firstDay = new Date(year, month - 1, 1);
  const startWeekday = firstDay.getDay(); // 0 Sun ... 6 Sat
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells: { date?: string; pnl?: number }[] = [];
  for (let i=0;i<startWeekday;i++) cells.push({}); // leading blanks
  for (let d=1; d<=daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    cells.push({ date: dateStr, pnl: daysByDate.get(dateStr) });
  }
  while (cells.length % 7 !== 0) cells.push({});
  const weekdayLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return (
    <div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(7, 1fr)', gap:4, marginBottom:4 }}>
        {weekdayLabels.map(w => <div key={w} style={{ textAlign:'center', fontSize:10, fontWeight:600 }}>{w}</div>)}
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(7, 1fr)', gap:4 }}>
        {cells.map((c, idx) => {
          if (!c.date) return <div key={idx} style={{ height:42, background:'transparent' }} />;
          const pnl = c.pnl ?? 0; // treat missing as 0
          let bg = '#334155';
          let display = '0';
          if (pnl > 0) { bg = '#16a34a'; display = `+$${Math.round(pnl)}`; }
          else if (pnl < 0) { bg = '#dc2626'; display = `-$${Math.round(Math.abs(pnl))}`; }
          return (
            <div key={c.date} style={{ background: bg, height:42, position:'relative', borderRadius:4, border:'1px solid rgba(255,255,255,0.15)', color:'#fff' }} title={`${c.date} PnL: ${pnl}`}> 
              <span style={{ position:'absolute', top:4, left:6, fontSize:10, opacity:0.85 }}>{c.date.split('-')[2]}</span>
              <span style={{ position:'absolute', bottom:4, right:6, fontSize:11, fontWeight:600 }}>{display}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default DailyPnlHeatmap;
