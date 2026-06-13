// 手写 SVG 图表(零依赖):Donut / AreaLine / Bars / Gauge。
// 颜色全用 CSS 变量 var(--xxx) → 随深色模式自动变色。hover 用原生 <title>。
// 交互:Bars/Donut/AreaLine 可选传 onSelect(i) → 段/柱/点可点击;配 DrillableChart 点开下钻明细列表。
import { useEffect, useState, type ReactNode } from 'react';

export interface Seg { label: string; value: number; colorVar: string }

// 键盘可达:Enter/Space 触发点击(可点击的柱/图例项 role=button)。
function keyActivate(fn: () => void) {
  return (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };
}

/* 占比环图 + 图例(传 onSelect 时:环段 + 图例项均可点击,activeIndex 高亮选中、淡出其它) */
export function Donut({ data, size = 132, thickness = 18, centerValue, centerLabel, onSelect, activeIndex }: { data: Seg[]; size?: number; thickness?: number; centerValue?: ReactNode; centerLabel?: string; onSelect?: (i: number) => void; activeIndex?: number | null }) {
  const r = (size - thickness) / 2;
  const C = 2 * Math.PI * r;
  const total = data.reduce((s, d) => s + (d.value || 0), 0);
  const clickable = !!onSelect;
  let offset = 0;
  return (
    <div className="chart-donut">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={clickable ? 'interactive' : undefined}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle r={r} cx={size / 2} cy={size / 2} fill="none" stroke="var(--surface-3)" strokeWidth={thickness} />
          {total > 0 && data.map((d, i) => {
            const len = (d.value / total) * C;
            const dim = clickable && activeIndex != null && activeIndex !== i;
            const seg = <circle key={i} r={r} cx={size / 2} cy={size / 2} fill="none" stroke={`var(${d.colorVar})`} strokeWidth={thickness}
              className={clickable ? 'donut-seg' : undefined} opacity={dim ? 0.32 : 1}
              strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset}
              onClick={onSelect ? () => onSelect(i) : undefined}><title>{d.label}:{d.value}({Math.round((d.value / total) * 100)}%)</title></circle>;
            offset += len;
            return seg;
          })}
        </g>
        {(centerValue != null || centerLabel) && (
          <text x="50%" y="50%" textAnchor="middle">
            <tspan x="50%" dy="-2" style={{ fontSize: 22, fontWeight: 700, fill: 'var(--text)', fontFamily: 'var(--mono)' }}>{centerValue}</tspan>
            {centerLabel && <tspan x="50%" dy="18" style={{ fontSize: 11, fill: 'var(--text-3)' }}>{centerLabel}</tspan>}
          </text>
        )}
      </svg>
      <div className="chart-legend">
        {data.map((d, i) => (
          <div className={'lg-item' + (clickable ? ' clickable' : '') + (activeIndex === i ? ' active' : '')} key={i}
            onClick={onSelect ? () => onSelect(i) : undefined}
            role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined} onKeyDown={clickable ? keyActivate(() => onSelect!(i)) : undefined}>
            <span className="lg-dot" style={{ background: `var(${d.colorVar})` }} />{d.label}<b>{d.value}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

/* 多序列折线 + 首序列面积(传 onSelect 时:每个 X 点可点击下钻当天明细) */
export function AreaLine({ labels, series, height = 130, onSelect, activeIndex }: { labels: string[]; series: { name: string; colorVar: string; values: number[] }[]; height?: number; onSelect?: (i: number) => void; activeIndex?: number | null }) {
  const n = labels.length;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const VB = 100; const pad = 6;
  const X = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100);
  const Y = (v: number) => pad + (1 - v / max) * (VB - pad * 2);
  const clickable = !!onSelect;
  return (
    <div className="chart-wrap">
      <svg width="100%" height={height} viewBox={`0 0 100 ${VB}`} preserveAspectRatio="none" style={{ display: 'block' }}>
        {series.map((s, si) => {
          const pts = s.values.map((v, i) => `${X(i)},${Y(v)}`).join(' ');
          return (
            <g key={si}>
              {si === 0 && <polygon points={`0,${VB} ${pts} 100,${VB}`} fill={`var(${s.colorVar})`} opacity={0.12} />}
              <polyline points={pts} fill="none" stroke={`var(${s.colorVar})`} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
            </g>
          );
        })}
        {labels.map((lb, i) => (
          <g key={i}>
            <circle cx={X(i)} cy={Y(series[0]?.values[i] || 0)} r={activeIndex === i ? 2.8 : 1.6} fill={`var(${series[0]?.colorVar || '--primary'})`} vectorEffect="non-scaling-stroke">
              <title>{lb}:{series.map((s) => `${s.name} ${s.values[i] ?? 0}`).join(' · ')}</title>
            </circle>
            {clickable && <rect x={X(i) - (50 / Math.max(1, n))} y={0} width={100 / Math.max(1, n)} height={VB} fill="transparent" className="arealine-hit" onClick={() => onSelect!(i)}><title>{lb}</title></rect>}
          </g>
        ))}
      </svg>
      <div className="chart-xaxis">{labels.map((lb, i) => <span key={i}>{lb}</span>)}</div>
      {series.length > 1 && <div className="chart-legend row">{series.map((s, i) => <div className="lg-item" key={i}><span className="lg-dot" style={{ background: `var(${s.colorVar})` }} />{s.name}</div>)}</div>}
    </div>
  );
}

/* 半圆仪表盘(0–100) */
export function Gauge({ value, colorVar, label, sub, size = 150 }: { value: number; colorVar: string; label?: string; sub?: string; size?: number }) {
  const v = Math.max(0, Math.min(100, value));
  const R = 40; const cx = 50; const cy = 50;
  const arc = `M ${cx - R},${cy} A ${R},${R} 0 0 1 ${cx + R},${cy}`;
  const len = Math.PI * R;
  const h = size * 0.62;
  return (
    <div className="chart-gauge" style={{ width: size }}>
      <svg width={size} height={h} viewBox="0 0 100 56">
        <path d={arc} fill="none" stroke="var(--surface-3)" strokeWidth={9} strokeLinecap="round" />
        <path d={arc} fill="none" stroke={`var(${colorVar})`} strokeWidth={9} strokeLinecap="round" strokeDasharray={`${(v / 100) * len} 999`} />
        <text x="50" y="44" textAnchor="middle" style={{ fontSize: 19, fontWeight: 700, fill: 'var(--text)', fontFamily: 'var(--mono)' }}>{Math.round(v)}</text>
      </svg>
      {label && <div className="gauge-label">{label}</div>}
      {sub && <div className="gauge-sub">{sub}</div>}
    </div>
  );
}

/* 竖条图(传 onSelect 时:每根柱可点击,activeIndex 高亮选中、淡出其它;hover/选中浮出数值) */
export function Bars({ data, height = 120, onSelect, activeIndex }: { data: Seg[]; height?: number; onSelect?: (i: number) => void; activeIndex?: number | null }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const clickable = !!onSelect;
  return (
    <div className="chart-bars" style={{ height }}>
      {data.map((d, i) => {
        const active = activeIndex === i;
        const dim = clickable && activeIndex != null && !active;
        return (
          <div className={'bar-col' + (clickable ? ' clickable' : '') + (active ? ' active' : '') + (dim ? ' dim' : '')} key={i} title={`${d.label}:${d.value}`}
            onClick={onSelect ? () => onSelect(i) : undefined}
            role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined} onKeyDown={clickable ? keyActivate(() => onSelect!(i)) : undefined}>
            <span className="bar-val">{d.value}</span>
            <div className="bar-fill" style={{ height: `${(d.value / max) * 100}%`, background: `var(${d.colorVar})` }} />
            <span className="bar-label">{d.label}</span>
          </div>
        );
      })}
    </div>
  );
}

/* —— 图表下钻:点击某段/柱/点 → 在图下方展开一个可关闭的明细面板 —— */
export function DrillPanel({ title, count, onClose, children }: { title: ReactNode; count?: number; onClose: () => void; children: ReactNode }) {
  return (
    <div className="drill-panel">
      <div className="drill-head">
        <span className="drill-title">{title}</span>
        {count != null && <span className="drill-count">{count}</span>}
        <span style={{ flex: 1 }} />
        <button className="drill-close" onClick={onClose} aria-label="关闭明细" title="关闭">✕</button>
      </div>
      <div className="drill-body">{children}</div>
    </div>
  );
}

export interface DrillCol<T> { label: ReactNode; render: (row: T) => ReactNode; className?: string; align?: 'left' | 'right' | 'center' }
export interface DrillResult<T> { title: ReactNode; rows: T[]; columns: DrillCol<T>[]; empty?: ReactNode }

// 通用下钻容器:接管「选中段 → 明细列表」的状态机。
// chart: 渲染图(把 onSelect/activeIndex 透传给 Bars/Donut/AreaLine);resolve(i): 该段对应的明细表(标题/列/行)。
// 再点同一段或点✕收起。复用既有 .tbl 表格样式,所见即所得。
export function DrillableChart<T>({ chart, resolve, rowKey, maxHeight = 260 }: {
  chart: (onSelect: (i: number) => void, activeIndex: number | null) => ReactNode;
  resolve: (i: number) => DrillResult<T> | null;
  rowKey: (row: T, i: number) => string | number;
  maxHeight?: number;
}) {
  const [active, setActive] = useState<number | null>(null);
  // resolve(active) 防御:轮询使图表数据收缩后,旧 active 可能越界(如 byState[i] 变 undefined)→ resolve 抛错会整页崩。
  // 包 try/catch 兜底为 null,并用 effect 把失效的 active 复位,避免高亮残留在已消失的段上。
  let sel: DrillResult<T> | null = null;
  if (active != null) { try { sel = resolve(active); } catch (_e) { sel = null; } }
  useEffect(() => { if (active != null && !sel) setActive(null); }, [active, sel]);
  return (
    <>
      {chart((i) => setActive((p) => (p === i ? null : i)), active)}
      {sel && (
        <DrillPanel title={sel.title} count={sel.rows.length} onClose={() => setActive(null)}>
          {sel.rows.length ? (
            <div className="drill-tbl-wrap" style={{ maxHeight }}>
              <table className="tbl drill-tbl">
                <thead><tr>{sel.columns.map((c, ci) => <th key={ci} style={{ textAlign: c.align }}>{c.label}</th>)}</tr></thead>
                <tbody>
                  {sel.rows.map((row, ri) => (
                    <tr key={rowKey(row, ri)}>{sel.columns.map((c, ci) => <td key={ci} className={c.className} style={{ textAlign: c.align }}>{c.render(row)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="empty-note" style={{ margin: 0 }}>{sel.empty || '无匹配记录'}</div>}
        </DrillPanel>
      )}
    </>
  );
}
