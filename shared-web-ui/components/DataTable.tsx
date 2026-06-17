// ⟦共享规范实现⟧ 改这里;各项目 web/src/{components,lib}/ 下同名文件是 export* 的 re-export shim,勿改。见 shared-web-ui/README.md
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
  onSelectionChange?: (selectedRows: T[]) => void;  // 选中变化时上报给父:上报【当前筛选下可见的选中行】(所见即所选,不含被筛选隐藏的)
  onViewChange?: (view: T[]) => void;  // 当前(搜索/筛选/排序后)视图变化时上报给父 → masthead「未勾选则导全部」用筛选后视图而非原始全量
  search?: { keys: ((row: T) => string)[]; placeholder?: string };
  filters?: FilterDef<T>[];
  columnSettings?: { tableId: string };
  toolbarLeft?: ReactNode;
  toolbarRight?: ReactNode;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  maxHeight?: number;
  // fillViewport:让滚动容器长到「填满视口剩余高度」(而非固定 maxHeight)。仅适合页面唯一/主导的大表
  // (代理/账号/卡池/结果等底部主表)。绝不低于 maxHeight(地板),所以矮屏不变、高屏才长。默认 false → 行为逐字节不变。
  fillViewport?: boolean;
  fillGutter?: number;         // fillViewport 时表底到视口底保留的余量(默认 64,对齐 .page 的 60px 底部留白,避免双滚动条)
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

export function DataTable<T>({ rows, columns, rowKey, getRowClass, onRowClick, selectable, batchActions, onSelectionChange, onViewChange, search, filters, columnSettings, toolbarLeft, toolbarRight, initialSort, maxHeight = 560, fillViewport, fillGutter = 64, emptyText = '暂无数据', footer, exportName, loading, error }: DataTableProps<T>) {
  const [sort, setSort] = useState<SortState>(initialSort || null);
  const [q, setQ] = useState('');
  const [fvals, setFvals] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState<Set<string>>(() => loadHidden(columnSettings?.tableId, columns));
  const [colOpen, setColOpen] = useState(false);
  const colRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<string | number>>(() => new Set());
  // —— 行虚拟化状态(仅大表生效)——
  const wrapRef = useRef<HTMLDivElement>(null);   // 滚动容器(.tbl-wrap)
  const [scrollTop, setScrollTop] = useState(0);  // 当前滚动位置
  const [vpH, setVpH] = useState(maxHeight);       // 可视区高度
  const [rowH, setRowH] = useState(36);            // 实测行高(首行测量后校准)
  const [fillH, setFillH] = useState<number | undefined>(undefined);  // fillViewport 时实测的「填满视口剩余高度」(否则恒为 undefined,不参与计算)

  useEffect(() => {
    if (!colOpen) return;
    const onDown = (e: MouseEvent) => { if (colRef.current && !colRef.current.contains(e.target as Node)) setColOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [colOpen]);

  // 虚拟化:监听滚动容器,rAF 节流更新 scrollTop / 可视区高度。scrollTop 不参与 onSelectionChange 依赖,故滚动不会误触发父刷新。
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; setScrollTop(el.scrollTop); }); };
    el.addEventListener('scroll', onScroll, { passive: true });
    setVpH(el.clientHeight || maxHeight);
    // 容器变高(窗口最大化/旋转/兄弟折叠)而 maxHeight 没变时,只测一次的 vpH 会偏小 → 底部留白到重挂载才补。
    // 用 ResizeObserver 在容器尺寸变化时重测,彻底闭掉这个"长大后留白"。
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => setVpH(el.clientHeight || maxHeight));
      ro.observe(el);
    }
    return () => { el.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); if (ro) ro.disconnect(); };
  }, [maxHeight]);

  // fillViewport:把滚动容器长到「视口底 − 容器顶 − fillGutter」,但取与 maxHeight 的较大者(只增不减,矮屏保持地板)。
  // 只在【窗口缩放】和【容器上方内容回流(工具栏/批量栏/KPI/图表 出现或塌陷会推动 top)】时重算;★不监听滚动 ——
  // 否则页面下滑时 top 变小会反复把表撑高造成抖动。容器向下长高时 top 不变 → avail 不变 → fillH 不变 → 不自激、ResizeObserver 稳定。
  // 容器长高后,上面那个挂在 .tbl-wrap 上的 ResizeObserver 会因 clientHeight 变化自动重测 vpH → 虚拟化窗口随之跟上,无需在此另动 vpH。
  useEffect(() => {
    if (!fillViewport) { setFillH(undefined); return; }
    const el = wrapRef.current;
    if (!el || typeof window === 'undefined') return;
    const recompute = () => {
      const top = el.getBoundingClientRect().top;                 // 容器顶到视口顶的距离(视口相对)
      const avail = window.innerHeight - top - fillGutter;        // 到视口底留 fillGutter 的可用高
      setFillH(Math.max(maxHeight, Math.floor(avail)));           // 取「填满」与「页面地板」较大者 → 只在高屏才长
    };
    recompute();
    window.addEventListener('resize', recompute);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(recompute);
      ro.observe(document.body);   // 上方内容高度变化 → body 尺寸变 → 重算(兜「内容回流后留白」)
    }
    return () => { window.removeEventListener('resize', recompute); if (ro) ro.disconnect(); };
  }, [fillViewport, fillGutter, maxHeight]);

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

  // 虚拟化:搜索/筛选使 view 变短时把滚动复位到顶 —— 否则 startIdx 仍按旧的大 scrollTop 算,会有 ~1 帧显示底部窗口
  // (浏览器随后自纠,但主动复位更干净,也符合「筛选后看最前匹配」的直觉)。
  const prevViewLen = useRef(view.length);
  useEffect(() => {
    if (view.length < prevViewLen.current) {
      if (wrapRef.current) wrapRef.current.scrollTop = 0;
      setScrollTop(0);
    }
    prevViewLen.current = view.length;
  }, [view.length]);

  // —— 多选(selectable 时) ——
  // 行身份键:按【行对象】缓存「用原始 rows 下标算出的 key」。排序/筛选只改 view 顺序,同一行 key 不变。
  // 关键:页面 rowKey 若含位置下标(…|${i}),view 下标≠rows 下标 —— 勾选(走 view 下标)存的 key 与
  // 「清理幽灵选中」/ selectedRows(走 rows 下标)算的 key 对不上 → 排序后一勾就被当幽灵清掉(表现"勾不上"),
  // 批量操作也选错行。统一改用按行对象缓存的 key,消除两套下标的分歧。
  const keyByRow = useMemo(() => {
    const m = new Map<T, string | number>();
    rows.forEach((r, i) => m.set(r, rowKey(r, i)));
    return m;
  }, [rows, rowKey]);
  const keyOf = (r: T, fallbackIdx: number) => { const k = keyByRow.get(r); return k !== undefined ? k : rowKey(r, fallbackIdx); };
  const viewSel = selectable ? view.filter((r, i) => selected.has(keyOf(r, i))) : [];
  const allSel = view.length > 0 && viewSel.length === view.length;
  const someSel = viewSel.length > 0 && !allSel;
  const clearSel = () => setSelected(new Set());
  const toggleRow = (k: string | number) => setSelected((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const toggleAll = () => setSelected((p) => { const n = new Set(p); if (allSel) view.forEach((r, i) => n.delete(keyOf(r, i))); else view.forEach((r, i) => n.add(keyOf(r, i))); return n; });
  // 行数据变化(删除/刷新)→ 剔除已不存在的选中项,避免幽灵选中
  useEffect(() => {
    setSelected((prev) => {
      if (!prev.size) return prev;
      const ks = new Set(keyByRow.values());   // 与勾选用的 keyOf 同源(按行对象缓存的 key),排序后不会误删
      let changed = false; const next = new Set<string | number>();
      prev.forEach((k) => { if (ks.has(k)) next.add(k); else changed = true; });
      return changed ? next : prev;
    });
  }, [rows, rowKey]);
  // 上报给父:① 当前筛选下【可见的选中行】viewSel(所见即所选 —— 不含被当前筛选/搜索隐藏的选中行,
  //   避免父的 masthead 复制/批量改密误把看不见的行算进去);② 当前(搜索/筛选/排序后)视图 view
  //   (父的「未勾选则导全部」据此用筛选后视图,而非原始全量)。
  // deps 只放【真正会变的状态】selected/rows/q/fvals/sort —— 它们在普通重渲染之间引用稳定,只有用户
  //   真的改选择/数据刷新/搜索/筛选/排序时才变;★绝不放 view/viewSel/search/filters(每渲染新建引用),
  //   否则父在回调里 setState→重渲染→新引用→再触发 死循环(原注释的血教训)。onSelectionChange 的唯一
  //   消费方(ResultsPage)rows 传的是稳定的 state(all),故 rows 入依赖不致循环;其它页没传这两个回调则空操作。
  useEffect(() => { onSelectionChange?.(viewSel); onViewChange?.(view); }, [selected, rows, q, fvals, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  // 导出当前视图为 CSV:只取"可见列 × 当前(搜索/筛选/排序后)的 view",所见即所导。
  // 每列取值优先级:exportValue → sortAccessor → row[key](原始值);纯 JSX/操作列(无取值器且值非原始)自动跳过。
  // 有勾选 → 只导选中的(所选即所导);否则导当前筛选/排序后的全部视图(所见即所导)。
  const exportRows = (selectable && viewSel.length) ? viewSel : view;
  function doExport() {
    if (!exportName || !exportRows.length) return;
    const cols = visCols.filter((c) => !c.noExport && (c.exportValue || c.sortAccessor || exportRows.some((r) => isPrim((r as Record<string, unknown>)[c.key]))));
    if (!cols.length) return;
    const headers = cols.map((c) => c.exportLabel ?? (typeof c.label === 'string' ? c.label : c.key));
    const data = exportRows.map((row, i) => cols.map((c) => {
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

  // —— 行虚拟化(零依赖窗口化)——
  // 只把滚动可视区附近的行渲进 DOM,其余用上下占位 <tr> 撑出滚动高度。排序/筛选/搜索/选中/导出全在 view/rows
  // 数组上做,与 DOM 无关 → 窗口化对它们完全透明。行高统一(.tbl 单行)→ 定高窗口化安全,首行测量校准真实行高。
  // 小表(≤VIRT_MIN)不虚拟化 → 渲染与改动前【逐字节一致】,零回归面;真正受益的是数千~数万行的聚合/账号表。
  const VIRT_MIN = 80;
  const OVERSCAN = 10;
  const colCount = visCols.length + (selectable ? 1 : 0);
  const virtualize = view.length > VIRT_MIN;
  const measureRow = (el: HTMLTableRowElement | null) => { if (el) { const h = el.offsetHeight; if (h > 0 && Math.abs(h - rowH) > 1) setRowH(h); } };
  let startIdx = 0, endIdx = view.length;
  if (virtualize) {
    const per = rowH || 36;
    const vis = Math.ceil(vpH / per) + OVERSCAN * 2;
    const maxStart = Math.max(0, view.length - vis);
    startIdx = Math.min(maxStart, Math.max(0, Math.floor(scrollTop / per) - OVERSCAN));
    endIdx = Math.min(view.length, startIdx + vis);
  }
  const padTop = startIdx * (rowH || 36);
  const padBottom = Math.max(0, (view.length - endIdx) * (rowH || 36));
  const windowRows = virtualize ? view.slice(startIdx, endIdx) : view;
  // fillViewport 模式用实测的填满高度,否则用页面传入的固定 maxHeight(默认行为)。
  const effMaxHeight = (fillViewport && fillH != null) ? fillH : maxHeight;

  return (
    <>
      {selectable && selected.size > 0 && (
        <div className="dt-batchbar">
          {/* 计数与批量操作都只针对【当前筛选下可见的选中行】viewSel(所见即所操作);被筛选隐藏的选中行
              不计数、不参与批量操作,并明确提示 —— 避免「删/改了看不见的行」。 */}
          <span className="bb-count">已选 <b>{viewSel.length}</b> 项{selected.size > viewSel.length ? <span className="dim" style={{ marginLeft: 6 }}>(另有 {selected.size - viewSel.length} 项被当前筛选隐藏,不会被操作)</span> : null}</span>
          <span style={{ flex: 1 }} />
          {batchActions?.(viewSel, clearSel)}
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
            <button className="btn btn-ghost btn-sm" disabled={!exportRows.length} onClick={doExport} title={(selectable && viewSel.length) ? `只导出选中的 ${viewSel.length} 行为 CSV` : '导出当前(筛选/排序后)的全部列为 CSV'}><Icon name="download" size={13} />{(selectable && viewSel.length) ? `导出选中 ${viewSel.length}` : '导出'}</button>
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
      <div className="tbl-wrap" style={{ maxHeight: effMaxHeight }} ref={wrapRef}>
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
            ) : view.length ? (
              <>
                {padTop > 0 && <tr aria-hidden="true"><td colSpan={colCount} style={{ height: padTop, padding: 0, border: 0 }} /></tr>}
                {windowRows.map((row, wi) => {
                  const i = startIdx + wi;   // 真实 view 下标:keyOf/render/选中都用它,绝不能用切片下标 wi
                  return (
                    <tr key={keyOf(row, i)} ref={wi === 0 ? measureRow : undefined} className={[getRowClass?.(row), onRowClick ? 'clickable' : '', selectable && selected.has(keyOf(row, i)) ? 'is-selected' : ''].filter(Boolean).join(' ') || undefined} onClick={onRowClick ? () => onRowClick(row) : undefined}>
                      {selectable && (
                        <td className="dt-check-col" onClick={(e) => e.stopPropagation()}>
                          <label className="check">
                            <input type="checkbox" checked={selected.has(keyOf(row, i))} onChange={() => toggleRow(keyOf(row, i))} aria-label="选择该行" />
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
                  );
                })}
                {padBottom > 0 && <tr aria-hidden="true"><td colSpan={colCount} style={{ height: padBottom, padding: 0, border: 0 }} /></tr>}
              </>
            ) : <tr><td colSpan={colCount} className="tbl-empty">{emptyText}</td></tr>}
          </tbody>
        </table>
        {footer}
      </div>
    </>
  );
}
