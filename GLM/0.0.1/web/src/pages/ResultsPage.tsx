// 结果聚合页(移植自旧 results.html + results.js):多节点聚合 + 去重 + 搜索 + 导出 + 卡池只读。
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { Icon } from '../lib/icons';
import { useToast } from '../lib/toast';
import { trunc } from '../lib/parse';
import { downloadCsv } from '../lib/export';
import type { AccountRow, AggregateResp, CardsResp } from '../lib/types';
import { pwView } from '../lib/pwView';
import { DataTable, type Column } from '../components/DataTable';
import { ResultsExportModal } from '../features/ResultsExportModal';

const CARD_STATUS: Record<string, string> = { active: '可用', exhausted: '已用尽', declined: '被拒', disabled: '已禁用', dispatched: '已下发' };

const ACC_COLUMNS: Column<AccountRow>[] = [
  { key: 'idx', label: '#', className: 'mono', cellStyle: { color: 'var(--text-3)' }, render: (_r, i) => i + 1 },
  { key: 'email', label: '邮箱', className: 'mono', sortAccessor: (a) => a.email || '', render: (a) => a.email },
  { key: 'mbOrig', label: '邮箱原密码', className: 'mono', cellStyle: { color: 'var(--text-3)' }, exportValue: (a) => pwView(a).mbOrig, render: (a) => pwView(a).mbOrig || '—' },
  { key: 'mbCur', label: '邮箱现密码', className: 'mono', cellStyle: { color: 'var(--text-2)' }, exportValue: (a) => pwView(a).mbCur, render: (a) => pwView(a).mbCur || '—' },
  { key: 'zaiOrig', label: 'z.ai原密码', className: 'mono', cellStyle: { color: 'var(--text-3)' }, defaultHidden: true, exportValue: (a) => pwView(a).orOrig, render: (a) => pwView(a).orOrig || '—' },
  { key: 'zaiCur', label: 'z.ai现密码', className: 'mono', cellStyle: { color: 'var(--text-2)' }, exportValue: (a) => pwView(a).orCur, render: (a) => pwView(a).orCur || '—' },
  { key: 'apiKey', label: 'API Key', className: 'mono', cellStyle: { color: 'var(--primary-text)' }, exportValue: (a) => a.apiKey || '', render: (a) => <span title={a.apiKey}>{trunc(a.apiKey, 24)}</span> },
  { key: 'billingStatus', label: '账单', sortAccessor: (a) => a.billingStatus || '', render: (a) => a.billingStatus === 'success' ? <span className="kbadge ok">success</span> : a.billingStatus ? <span className="kbadge warn">{a.billingStatus}</span> : <span className="kbadge neutral">—</span> },
  { key: 'charged', label: '充值', className: 'mono', align: 'right', sortAccessor: (a) => a.charged ?? a.topUpAmount ?? 0, exportValue: (a) => a.charged != null ? a.charged : (a.topUpAmount != null ? a.topUpAmount : ''), render: (a) => a.charged != null ? '$' + a.charged : (a.topUpAmount != null ? '$' + a.topUpAmount : '—') },
  { key: 'cardLast4', label: '卡末4', className: 'mono', exportValue: (a) => a.cardLast4 || '', render: (a) => a.cardLast4 ? '•••• ' + a.cardLast4 : '—' },
  { key: 'passwordChanged', label: '改密', exportValue: (a) => a.passwordChanged ? '已改' : '未改', render: (a) => a.passwordChanged ? <span className="kbadge ok">已改</span> : <span className="kbadge neutral">未改</span> },
  { key: 'exitIp', label: '出口IP', className: 'mono', cellStyle: { color: 'var(--text-2)' }, render: (a) => a.exitIp || '—' },
  { key: 'nodeId', label: '节点', className: 'mono', cellStyle: { color: 'var(--text-3)' }, sortAccessor: (a) => a.nodeId || '', render: (a) => a.nodeId || '' },
  { key: 'createdAt', label: '时间', className: 'mono', cellStyle: { color: 'var(--text-3)' }, sortAccessor: (a) => a.createdAt || '', render: (a) => (a.createdAt || '').replace('T', ' ').slice(0, 19) },
];

export default function ResultsPage() {
  const toast = useToast();
  const [all, setAll] = useState<AccountRow[]>([]);
  const [sources, setSources] = useState<AggregateResp['sources']>([]);
  const [updatedAt, setUpdatedAt] = useState('');
  const [dedupe, setDedupe] = useState('email+apiKey');
  const [includeLocal, setIncludeLocal] = useState(true);
  const [hosts, setHosts] = useState('');
  const [auto, setAuto] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [selRows, setSelRows] = useState<AccountRow[]>([]);   // 表格里【当前筛选下可见的】勾选行 → 复制/导出"选中优先"(DataTable 已按筛选上报)
  const [filteredView, setFilteredView] = useState<AccountRow[] | null>(null);   // 表格当前(搜索/筛选/排序后)的视图 → 未勾选时复制/导出按【筛选后】而非原始全量
  const [busy, setBusy] = useState(false);                    // 删除/清空在飞 → 禁按钮防双击重复提交(后端幂等,纯防重复 toast/请求)
  const loadingRef = useRef(false);

  const { data: cards } = useQuery({ queryKey: ['cards'], queryFn: () => apiGet<CardsResp>('/api/cards', true), refetchInterval: auto ? 20000 : false });

  async function loadData(silent: boolean) {
    if (loadingRef.current) return; loadingRef.current = true;
    try {
      const data = await apiPost<AggregateResp>('/api/aggregate', { hosts: hosts.split(/\r?\n/).map((s) => s.trim()).filter(Boolean), includeLocal, dedupe }, silent);
      setAll(data.accounts || []); setSources(data.sources || []);
      setUpdatedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    } catch (e) { if (!silent) toast.push('聚合失败:' + (e as Error).message, 'err'); }
    finally { loadingRef.current = false; }
  }

  useEffect(() => { loadData(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 自动刷新会【整集群重聚合 + 全量重渲染】,代价高 → 从 5s 放宽到 20s(默认仍关;跑批时实时进度看控制台 SSE)。
  useEffect(() => { if (!auto) return; const t = setInterval(() => loadData(true), 20000); return () => clearInterval(t); }, [auto, hosts, includeLocal, dedupe]); // eslint-disable-line react-hooks/exhaustive-deps

  function download(name: string, content: string, type: string) {
    const blob = new Blob([content], { type });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const copy = (txt: string) => { navigator.clipboard.writeText(txt).then(() => toast.push('已复制', 'ok'), () => toast.push('复制失败', 'err')); };

  // 删除选中结果行:按 (nodeId,jobId,email,apiKey) 定位;非本机记录后端尝试转发源节点删。
  async function deleteRows(rows: AccountRow[], clearSel: () => void) {
    if (busy) return;
    if (!window.confirm(`删除选中的 ${rows.length} 条结果?\n\n结果含 API Key / 已绑卡,删除后不可恢复(建议先导出备份)。\n非本机的记录会尝试到源节点一并删除。`)) return;
    setBusy(true);
    try {
      const items = rows.map((r) => ({ nodeId: r.nodeId, jobId: r.jobId, email: r.email, apiKey: r.apiKey }));
      const resp = await apiPost<{ localDeleted: number; pushedDeleted: number; remote: { nodeId: string; ok: boolean; deleted?: number; error?: string }[] }>('/api/results/delete', { items });
      const localN = (resp.localDeleted || 0) + (resp.pushedDeleted || 0);
      const remoteN = (resp.remote || []).filter((x) => x.ok).reduce((n, x) => n + (x.deleted || 0), 0);
      const remoteErr = (resp.remote || []).filter((x) => !x.ok);
      const msg = `已删除 本机 ${localN} 条` + (remoteN ? ` · 远端 ${remoteN} 条` : '') + (remoteErr.length ? ` · ${remoteErr.length} 个远端节点未删(${remoteErr.map((e) => e.nodeId).join(', ')})` : '');
      toast.push(msg, remoteErr.length ? 'info' : 'ok');
      clearSel();
      loadData(false);
    } catch (e) { toast.push('删除失败:' + (e as Error).message, 'err'); }
    finally { setBusy(false); }
  }
  async function clearLocal() {
    if (busy) return;
    if (!window.confirm('清空本机所有成功结果?\n\n含 API Key / 已绑卡,删除后不可恢复(建议先点 .json 导出备份)。\n只清本机(含子机推送缓存),不影响其它节点自身的结果。')) return;
    setBusy(true);
    try {
      const r = await apiPost<{ files: number; records: number; pushedFiles: number }>('/api/results/clear', {});
      toast.push(`已清空本机 ${r.records} 条结果(${r.files} 个文件${r.pushedFiles ? ` + ${r.pushedFiles} 个推送缓存` : ''})`, 'ok');
      loadData(false);
    } catch (e) { toast.push('清空失败:' + (e as Error).message, 'err'); }
    finally { setBusy(false); }
  }

  const poolCards = cards?.cards || [];
  // 有勾选 → 复制/导出只针对【可见的】选中行;否则导【当前筛选后的视图】(filteredView,未筛选时即全量)——
  // 而非原始 all,避免「筛到 10 条、未勾选,却复制了全部」。filteredView 为 null(首帧未上报)时回退 all。
  const baseRows = filteredView ?? all;
  const exportRows = selRows.length ? selRows : baseRows;
  const selSuffix = selRows.length ? `选中 ${selRows.length}` : (baseRows.length === all.length ? `全部 ${all.length}` : `筛选后 ${baseRows.length}`);

  return (
    <main className="page">
      <section className="card masthead">
        <div className="mh-strip">
          <div className="mh-cluster">
            <span className="mh-ic"><Icon name="grid" size={16} /></span>
            <span className="mh-title">结果聚合</span>
          </div>
          <span className="mh-meta">节点 <b>{sources.length || 1}</b> · 账号 <b>{all.length}</b></span>
          <span className="mh-spacer" />
          <span className="mh-updated">更新于 <b>{updatedAt || '—'}</b></span>
          <label className="check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /><span className="box"><Icon name="check" size={11} /></span>自动刷新 <span className="sub">20s</span></label>
          <button className="btn btn-primary btn-sm" onClick={() => loadData(false)}><Icon name="refresh" size={12} />立即聚合</button>
        </div>
        <div className="mh-strip mh-tools">
          <div className="mh-field-inline"><span className="mh-label">去重</span>
            <select className="mh-select" value={dedupe} onChange={(e) => setDedupe(e.target.value)}>
              <option value="email+apiKey">每组 邮箱+Key 一行(去完全重复)</option>
              <option value="email">每邮箱一行(同邮箱保留最新 Key)</option>
              <option value="none">全部保留(不去重)</option>
            </select>
          </div>
          <label className="check"><input type="checkbox" checked={includeLocal} onChange={(e) => setIncludeLocal(e.target.checked)} /><span className="box"><Icon name="check" size={11} /></span>含本机</label>
        </div>
        <div className="mh-strip">
          <div className="mh-field-inline" style={{ flex: 1, alignItems: 'flex-start' }}>
            <span className="mh-label" style={{ paddingTop: 7 }}>其它节点</span>
            <textarea rows={1} style={{ minHeight: 34 }} placeholder="可留空(自动用配置 cluster.hosts + 在线子机)。手动加远程节点:http://机器:4317,一行一个"
              value={hosts} onChange={(e) => setHosts(e.target.value)} />
          </div>
        </div>
        <div className="mh-strip">
          {(sources.length ? sources : [{ source: '本机', count: 0, ok: true }]).map((s, i) => {
            const name = String(s.source).replace(/^local\(/, '本机(').replace(/^push\(/, '推送(');
            return <span className="node-chip" key={i}><span className={'dot' + (s.ok ? '' : ' bad')} />{name} <em>{s.ok ? s.count + ' 条' : s.error}</em></span>;
          })}
          <span className="mh-spacer" />
          <button className="btn btn-ghost btn-sm" disabled={!exportRows.length} title="复制选中的;未勾选则复制全部" onClick={() => copy(exportRows.map((r) => `${r.email || ''}:${r.apiKey || ''}`).join('\n'))}>复制 邮箱:Key <span className="dim">({selSuffix})</span></button>
          <button className="btn btn-ghost btn-sm" disabled={!exportRows.length} title="复制 邮箱:邮箱现密码(当前邮箱登录密码,改密后为新值);未勾选则复制全部" onClick={() => copy(exportRows.map((r) => `${r.email || ''}:${pwView(r).mbCur}`).join('\n'))}>复制 邮箱:现密码</button>
          <button className="btn btn-ghost btn-sm" disabled={!exportRows.length} title="复制 邮箱:z.ai现密码(当前 z.ai 登录密码);未勾选则复制全部" onClick={() => copy(exportRows.map((r) => `${r.email || ''}:${pwView(r).orCur}`).join('\n'))}>复制 邮箱:z.ai密码</button>
          <button className="btn btn-soft btn-sm" disabled={!exportRows.length} title="自定义格式导出(选中优先,未勾选则全部):模板变量 + 自增序号,可导 .txt / .json" onClick={() => setExportOpen(true)}><Icon name="download" size={12} />自定义导出 <span className="dim">({selSuffix})</span></button>
          <button className="btn btn-danger-soft btn-sm" disabled={!all.length || busy} title="删除本机所有成功结果(含子机推送缓存),不影响其它节点" onClick={clearLocal}><Icon name="trash" size={12} />清空本机</button>
        </div>
      </section>

      <div className="section-gap" />

      <section className="card">
        <DataTable
          rows={all}
          columns={ACC_COLUMNS}
          rowKey={(a, i) => `${a.nodeId || ''}|${a.jobId || ''}|${a.email || ''}|${a.apiKey || ''}|${i}`}
          search={{ keys: [(a) => a.email || '', (a) => a.apiKey || '', (a) => a.nodeId || ''], placeholder: '搜索邮箱 / Key / 节点…' }}
          filters={[
            { key: 'billingStatus', label: '账单', accessor: (a) => a.billingStatus || '—', options: [{ value: 'success', label: 'success' }, { value: '—', label: '无' }] },
            { key: 'passwordChanged', label: '改密', accessor: (a) => a.passwordChanged ? 'yes' : 'no', options: [{ value: 'yes', label: '已改' }, { value: 'no', label: '未改' }] },
          ]}
          columnSettings={{ tableId: 'results-accounts' }}
          exportName="results-accounts"
          maxHeight={560}
          fillViewport
          selectable
          onSelectionChange={setSelRows}
          onViewChange={setFilteredView}
          batchActions={(sel, clearSel) => (
            <button className="btn btn-danger-soft btn-sm" disabled={busy} onClick={() => deleteRows(sel, clearSel)}><Icon name="trash" size={12} />删除选中</button>
          )}
          emptyText="暂无成功账号,去控制台跑一批"
        />
      </section>

      <div className="section-gap" />

      <section className="card">
        <div className="panel-sec">
          <div className="sub-head"><h4>卡池使用情况</h4><span className="cnt-pill">本节点 · 共 <b style={{ color: 'var(--text)' }}>{poolCards.length}</b> 张 · 可用 <b style={{ color: 'var(--success)' }}>{cards?.available || 0}</b></span>
            <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} disabled={!poolCards.length} onClick={() => downloadCsv('cards', ['卡号末4', '有效期', '已用', '上限', '状态'], poolCards.map((c) => [c.masked, c.exp, c.usedCount, c.maxUses, CARD_STATUS[c.status] || c.status]))}><Icon name="download" size={12} />导出</button>
          </div>
          <div className="tbl-wrap" style={{ maxHeight: 320 }}>
            <table className="tbl">
              <thead><tr><th>卡号末4</th><th>有效期</th><th>已用/上限</th><th>状态</th></tr></thead>
              <tbody>
                {poolCards.length ? poolCards.map((c) => (
                  <tr key={c.id}><td className="mono">{c.masked}</td><td className="mono">{c.exp}</td><td className="mono">{c.usedCount} / {c.maxUses}</td>
                    <td>{c.status === 'active' ? <span className="kbadge ok">可用</span> : c.status === 'exhausted' ? <span className="kbadge fail">已用尽</span> : <span className="kbadge neutral">{CARD_STATUS[c.status] || c.status}</span>}</td></tr>
                )) : <tr><td colSpan={4} className="tbl-empty">暂无卡片</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <ResultsExportModal open={exportOpen} onClose={() => setExportOpen(false)} rows={exportRows} onDownload={download} onCopy={copy} />
    </main>
  );
}
