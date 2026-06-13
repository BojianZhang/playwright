// 通用数据表:点表头排序、搜索、下拉筛选、列显隐(localStorage 记忆)、空态。
// 只负责"展示/排序/过滤/列显隐";数据获取/刷新/导出由各页经 toolbarLeft/toolbarRight 传入。
// 复用 .tbl/.tbl-wrap/.tbl-empty 等既有样式。
import { useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { Icon } from '../lib/icons';
import { downloadCsv } from '../lib/export';

export interface Column<T> {
  key: string;
  label: ReactNode;
  render?: (row: T, idx: number) => ReactNode;
  sortAccessor?: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  className?: string;          // td 额外类(如 mono)
  cellStyle?: CSSProperties;   // td 内联样式
  defaultHidden?: boolean;
  alwaysVisible?: boolean;     // 不可隐藏(如操作列)
  // 导出 CSV 用:取该列的纯文本值。缺省时回退 sortAccessor → row[key] 原始值;
  // 既无取值器、值又非原始类型(如纯 JSX/操作列)→ 该列自动不进导出。
  exportValue?: (row: T, idx: number) => string | number | null | undefined;
  exportLabel?: string;        // 导出表头文字(label 非字符串时用,缺省回退 key)
  noExport?: boolean;          // 强制该列不进导出
}
export interface FilterDef<T> {
  key: string; label: string;
  options: { value: string; label: string }[];
  accessor: (row: T) => string;
}
export interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T, idx: number) => string | number;
  getRowClass?: (row: T) => string | undefined;
  onRowClick?: (row: T) => void;
  selectable?: boolean;        // 开启行多选(复选框列 + 批量栏)
  batchActions?: (selectedRows: T[], clear: () => void) => ReactNode;  // 选中≥1时批量栏里的按钮(各页传)
  search?: { keys: ((row: T) => string)[]; placeholder?: string };
  filters?: FilterDef<T>[];
  columnSettings?: { tableId: string };
  toolbarLeft?: ReactNode;
  toolbarRight?: ReactNode;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  maxHeight?: number;
  emptyText?: ReactNode;
  footer?: ReactNode;
  exportName?: string;         // 传了就显示「导出」按钮:把当前(筛选/排序后)视图导出为 CSV
  loading?: boolean;           // 首次加载中(尚无行)→ 显示「加载中…」而非空态,区分"在拉"与"真没有"
  error?: string | null;       // 加载失败 → 显示红色错误行,区分"后端挂了"与"真没有"
}

const isPrim = (v: unknown): v is string | number | boolean => v != null && typeof v !== 'object' && typeof v !== 'function';

type SortState = { key: string; dir: 'asc' | 'desc' } | null;

function loadHidden<T>(tableId: string | undefined, columns: Column<T>[]): Set<string> {
  // 有保存的列偏好 → 原样尊重(含用户把 defaultHidden 列改成显示的选择,不再被 defaultHidden 覆盖回去)。
  if (tableId) {
    try { const raw = localStorage.getItem('or_cols_' + tableId); if (raw != null) return new Set(JSON.parse(raw)); } catch { /* ignore */ }
  }
  // 无保存(首次):应用列的 defaultHidden 默认。
  const h = new Set<string>();
  columns.forEach((c) => { if (c.defaultHidden && !c.alwaysVisible) h.add(c.key); });
  return h;
}

export function DataTable<T>({ rows, columns, rowKey, getRowClass, onRowClick, selectable, batchActions, search, filters, columnSettings, toolbarLeft, toolbarRight, initialSort, maxHeight = 560, emptyText = '暂无数据', footer, exportName, loading, error }: DataTableProps<T>) {
  const [sort, setSort] = useState<SortState>(initialSort || null);
  const [q, setQ] = useState('');
  const [fvals, setFvals] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState<Set<string>>(() => loadHidden(columnSettings?.tableId, columns));
  const [colOpen, setColOpen] = useState(false);
  const colRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<string | number>>(() => new Set());

  useEffect(() => {
    if (!colOpen) return;
    const onDown = (e: MouseEvent) => { if (colRef.current && !colRef.current.contains(e.target as Node)) setColOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [colOpen]);

  function toggleHidden(key: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      if (columnSettings?.tableId) { try { localStorage.setItem('or_cols_' + columnSettings.tableId, JSON.stringify([...next])); } catch { /* ignore */ } }
      // 隐藏的若是当前排序列 → 清掉排序,否则表头指示器消失、view 仍按隐藏列排且无法再清除。
      if (next.has(key)) setSort((s) => (s && s.key === key ? null : s));
      return next;
    });
  }
  function clickSort(c: Column<T>) {
    if (!c.sortAccessor) return;
    setSort((s) => (!s || s.key !== c.key) ? { key: c.key, dir: 'asc' } : s.dir === 'asc' ? { key: c.key, dir: 'desc' } : null);
  }

  const visCols = columns.filter((c) => !hidden.has(c.key));

  const view = useMemo(() => {
    let out = rows;
    const k = q.trim().toLowerCase();
    if (search && k) out = out.filter((r) => search.keys.some((fn) => String(fn(r) || '').toLowerCase().includes(k)));
    if (filters) for (const f of filters) { const v = fvals[f.key]; if (v) out = out.filter((r) => f.accessor(r) === v); }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col?.sortAccessor) {
        const acc = col.sortAccessor; const dir = sort.dir === 'asc' ? 1 : -1;
        out = [...out].sort((a, b) => {
          const va = acc(a), vb = acc(b);
          if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1;
          if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
          return String(va).localeCompare(String(vb), 'zh') * dir;
        });
      }
    }
    return out;
  }, [rows, q, fvals, sort, columns, search, filters]);

  // —— 多选(selectable 时) ——
  const viewSel = selectable ? view.filter((r, i) => selected.has(rowKey(r, i))) : [];
  const allSel = view.length > 0 && viewSel.length === view.length;
  const someSel = viewSel.length > 0 && !allSel;
  const selectedRows = selectable ? rows.filter((r, i) => selected.has(rowKey(r, i))) : [];
  const clearSel = () => setSelected(new Set());
  const toggleRow = (k: string | number) => setSelected((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const toggleAll = () => setSelected((p) => { const n = new Set(p); if (allSel) view.forEach((r, i) => n.delete(rowKey(r, i))); else view.forEach((r, i) => n.add(rowKey(r, i))); return n; });
  // 行数据变化(删除/刷新)→ 剔除已不存在的选中项,避免幽灵选中
  useEffect(() => {
    setSelected((prev) => {
      if (!prev.size) return prev;
      const ks = new Set(rows.map((r, i) => rowKey(r, i)));
      let changed = false; const next = new Set<string | number>();
      prev.forEach((k) => { if (ks.has(k)) next.add(k); else changed = true; });
      return changed ? next : prev;
    });
  }, [rows, rowKey]);

  // 导出当前视图为 CSV:只取"可见列 × 当前(搜索/筛选/排序后)的 view",所见即所导。
  // 每列取值优先级:exportValue → sortAccessor → row[key](原始值);纯 JSX/操作列(无取值器且值非原始)自动跳过。
  function doExport() {
    if (!exportName || !view.length) return;
    const cols = visCols.filter((c) => !c.noExport && (c.exportValue || c.sortAccessor || view.some((r) => isPrim((r as Record<string, unknown>)[c.key]))));
    if (!cols.length) return;
    const headers = cols.map((c) => c.exportLabel ?? (typeof c.label === 'string' ? c.label : c.key));
    const data = view.map((row, i) => cols.map((c) => {
      try {
        if (c.exportValue) return c.exportValue(row, i);
        if (c.sortAccessor) return c.sortAccessor(row);
        const v = (row as Record<string, unknown>)[c.key];
        if (typeof v === 'string' || typeof v === 'number') return v;
        return typeof v === 'boolean' ? String(v) : '';  // 布尔转字符串(CSV 不接受 boolean 单元格)
      } catch { return ''; }   // 单元格取值抛错不连累整表导出(fe-10):坏行该格留空即可
    }));
    downloadCsv(exportName, headers, data);
  }

  const hasToolbar = toolbarLeft || toolbarRight || search || (filters && filters.length) || columnSettings || exportName;

  return (
    <>
      {selectable && selected.size > 0 && (
        <div className="dt-batchbar">
          <span className="bb-count">已选 <b>{selected.size}</b> 项</span>
          <span style={{ flex: 1 }} />
          {batchActions?.(selectedRows, clearSel)}
          <button className="btn btn-ghost btn-sm" onClick={clearSel}>清除选择</button>
        </div>
      )}
      {hasToolbar && (
        <div className="dt-toolbar">
          {toolbarLeft}
          {filters?.map((f) => (
            <select key={f.key} className="dt-filter" value={fvals[f.key] || ''} onChange={(e) => setFvals((s) => ({ ...s, [f.key]: e.target.value }))}>
              <option value="">{f.label}:全部</option>
              {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ))}
          {search && <div className="search-box dt-search"><Icon name="search" size={14} /><input placeholder={search.placeholder || '搜索…'} value={q} onChange={(e) => setQ(e.target.value)} /></div>}
          <span style={{ flex: 1 }} />
          {toolbarRight}
          {exportName && (
            <button className="btn btn-ghost btn-sm" disabled={!view.length} onClick={doExport} title="导出当前(筛选/排序后)的全部列为 CSV"><Icon name="download" size={13} />导出</button>
          )}
          {columnSettings && (
            <div className="col-pop-wrap" ref={colRef}>
              <button className="btn btn-ghost btn-sm" onClick={() => setColOpen((o) => !o)} title="显示哪些列"><Icon name="columns" size={13} />列</button>
              {colOpen && (
                <div className="col-pop">
                  <div className="col-pop-head">显示列</div>
                  {columns.filter((c) => !c.alwaysVisible).map((c) => (
                    <label className="check" key={c.key}>
                      <input type="checkbox" checked={!hidden.has(c.key)} onChange={() => toggleHidden(c.key)} />
                      <span className="box"><Icon name="check" size={11} /></span>{c.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <div className="tbl-wrap" style={{ maxHeight }}>
        <table className="tbl">
          <thead>
            <tr>
              {selectable && (
                <th className="dt-check-col">
                  <label className="check" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={allSel} ref={(el) => { if (el) el.indeterminate = someSel; }} onChange={toggleAll} aria-label="全选" />
                    <span className="box"><Icon name="check" size={11} /></span>
                  </label>
                </th>
              )}
              {visCols.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th key={c.key} style={{ textAlign: c.align, width: c.width }} className={c.sortAccessor ? 'sortable' : undefined} onClick={() => clickSort(c)}>
                    <span className="th-in">{c.label}{c.sortAccessor && (
                      active ? <Icon name="chevron" size={12} className="sort-ic on" style={{ transform: sort!.dir === 'asc' ? 'rotate(-90deg)' : 'rotate(90deg)' }} />
                        : <Icon name="sort" size={12} className="sort-ic" />
                    )}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {error ? (
              <tr><td colSpan={visCols.length + (selectable ? 1 : 0)} className="tbl-empty" style={{ color: 'var(--danger)' }}>加载失败:{error}</td></tr>
            ) : loading && !rows.length ? (
              <tr><td colSpan={visCols.length + (selectable ? 1 : 0)} className="tbl-empty">加载中…</td></tr>
            ) : view.length ? view.map((row, i) => (
              <tr key={rowKey(row, i)} className={[getRowClass?.(row), onRowClick ? 'clickable' : '', selectable && selected.has(rowKey(row, i)) ? 'is-selected' : ''].filter(Boolean).join(' ') || undefined} onClick={onRowClick ? () => onRowClick(row) : undefined}>
                {selectable && (
                  <td className="dt-check-col" onClick={(e) => e.stopPropagation()}>
                    <label className="check">
                      <input type="checkbox" checked={selected.has(rowKey(row, i))} onChange={() => toggleRow(rowKey(row, i))} aria-label="选择该行" />
                      <span className="box"><Icon name="check" size={11} /></span>
                    </label>
                  </td>
                )}
                {visCols.map((c) => (
                  <td key={c.key} className={c.className} style={{ textAlign: c.align, ...c.cellStyle }}>
                    {c.render ? c.render(row, i) : String((row as Record<string, unknown>)[c.key] ?? '')}
                  </td>
                ))}
              </tr>
            )) : <tr><td colSpan={visCols.length + (selectable ? 1 : 0)} className="tbl-empty">{emptyText}</td></tr>}
          </tbody>
        </table>
        {footer}
      </div>
    </>
  );
}
