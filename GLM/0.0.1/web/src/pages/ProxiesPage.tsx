// 代理 / IP 池(资源页):报表(KPI + 状态/连通环图)+ 管理表(增删改 + 连通性测试)。
// 边界:只管出口代理 host:port:user:pass + 连通性。不管 AdsPower(浏览器环境另有页)。
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { Icon } from '../lib/icons';
import { useToast } from '../lib/toast';
import { shortTime, parseKind } from '../lib/parse';
import { batchRun } from '../lib/batch';
import type { ProxyRow } from '../lib/types';
import { Kpi } from '../components/Kpi';
import { Donut, DrillableChart, type Seg, type DrillCol } from '../components/charts';
import { ImportModal } from '../components/ImportModal';
import { RowMenu } from '../components/RowMenu';
import { DataTable, type Column, type FilterDef } from '../components/DataTable';

export default function ProxiesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['proxies'], queryFn: () => apiGet<{ items: ProxyRow[] }>('/api/proxies', true), refetchInterval: 10000 });
  const rows = data?.items || [];
  const onSuccess = () => qc.invalidateQueries({ queryKey: ['proxies'] });
  const add = useMutation({ mutationFn: (b: unknown) => apiPost('/api/proxies/add', b), onSuccess });
  const update = useMutation({ mutationFn: (b: unknown) => apiPost('/api/proxies/update', b), onSuccess });
  const remove = useMutation({ mutationFn: (b: unknown) => apiPost('/api/proxies/remove', b), onSuccess });
  const clear = useMutation({ mutationFn: (b: unknown) => apiPost('/api/proxies/clear', b), onSuccess });
  const test = useMutation({ mutationFn: (b: unknown) => apiPost('/api/proxies/test', b), onSuccess });
  const setType = useMutation({ mutationFn: (b: unknown) => apiPost('/api/proxies/set-type', b), onSuccess });
  const [addOpen, setAddOpen] = useState(false);
  const [testing, setTesting] = useState(false);

  const active = rows.filter((r) => r.status === 'active').length;
  const okN = rows.filter((r) => r.lastOk === true).length;
  const failN = rows.filter((r) => r.lastOk === false).length;
  const tested = rows.filter((r) => r.lastTestedAt).map((r) => r.latencyMs || 0);
  const avgMs = tested.length ? Math.round(tested.reduce((a, b) => a + b, 0) / tested.length) : 0;
  const stateSegs: Seg[] = [{ label: '可用', value: active, colorVar: '--success' }, { label: '停用', value: rows.length - active, colorVar: '--text-4' }];
  const connSegs: Seg[] = [{ label: '连通', value: okN, colorVar: '--success' }, { label: '失败', value: failN, colorVar: '--danger' }, { label: '未测', value: rows.length - okN - failN, colorVar: '--text-4' }];

  async function testAll() { setTesting(true); try { await test.mutateAsync({}); toast.push('连通性测试完成', 'ok'); } finally { setTesting(false); } }

  const columns: Column<ProxyRow>[] = [
    { key: 'server', label: '地址', className: 'mono', sortAccessor: (r) => r.host, exportValue: (r) => `${r.host}:${r.port}`, render: (r) => `${r.host}:${r.port}` },
    { key: 'user', label: '账号', className: 'mono', cellStyle: { color: 'var(--text-3)' }, render: (r) => r.user || '—' },
    { key: 'type', label: '类型', sortAccessor: (r) => r.type, render: (r) => (
      <select className="cell-num" style={{ width: 78 }} value={r.type || 'socks5'} onChange={(e) => update.mutate({ id: r.id, patch: { type: e.target.value } })}>
        <option value="socks5">socks5</option><option value="http">http</option><option value="https">https</option>
      </select>
    ) },
    { key: 'label', label: '标签', render: (r) => <input className="cell-num" style={{ width: 90 }} defaultValue={r.label} placeholder="备注" onBlur={(e) => { if (e.target.value !== r.label) update.mutate({ id: r.id, patch: { label: e.target.value } }); }} /> },
    { key: 'status', label: '状态', sortAccessor: (r) => r.status, exportValue: (r) => r.status === 'active' ? '可用' : '停用', render: (r) => r.status === 'active' ? <span className="kbadge ok">可用</span> : <span className="kbadge neutral">停用</span> },
    { key: 'latencyMs', label: '延迟/连通', className: 'mono', align: 'right', sortAccessor: (r) => r.lastOk === false ? 9e9 : (r.latencyMs ?? 8e9), exportValue: (r) => r.lastOk == null ? '未测' : r.lastOk ? `${r.latencyMs}ms` : '失败', render: (r) => r.lastOk == null ? <span style={{ color: 'var(--text-4)' }}>未测</span> : r.lastOk ? <span style={{ color: 'var(--success)' }}>{r.latencyMs}ms</span> : <span style={{ color: 'var(--danger)' }}>失败</span> },
    { key: 'exitIp', label: '出口IP', className: 'mono', cellStyle: { color: 'var(--text-2)' }, defaultHidden: true, render: (r) => r.exitIp || '—' },
    { key: 'lastTestedAt', label: '最近测', className: 'mono', cellStyle: { color: 'var(--text-3)' }, sortAccessor: (r) => r.lastTestedAt || 0, exportValue: (r) => r.lastTestedAt ? new Date(r.lastTestedAt).toISOString().replace('T', ' ').slice(0, 19) : '', render: (r) => shortTime(r.lastTestedAt ? new Date(r.lastTestedAt).toISOString() : undefined) },
    { key: 'actions', label: '操作', align: 'right', alwaysVisible: true, render: (r) => (
      <RowMenu
        inline={<>
          <Link className="btn btn-ghost btn-sm" to={`/diagnose?by=proxy&value=${r.id}`} title="诊断该代理的使用记录">🔍</Link>
          <button className="btn btn-ghost btn-sm" onClick={() => test.mutate({ id: r.id })}>测试</button>
        </>}
        actions={[
          { label: r.status === 'active' ? '停用' : '启用', icon: r.status === 'active' ? 'pause' : 'play', onClick: () => update.mutate({ id: r.id, patch: { status: r.status === 'active' ? 'disabled' : 'active' } }) },
          { label: '删除', icon: 'trash', danger: true, onClick: () => { if (confirm('删除该代理?')) remove.mutate({ id: r.id }); } },
        ]}
      />
    ) },
  ];
  const filters: FilterDef<ProxyRow>[] = [
    { key: 'status', label: '状态', accessor: (r) => r.status, options: [{ value: 'active', label: '可用' }, { value: 'disabled', label: '停用' }] },
    { key: 'conn', label: '连通', accessor: (r) => r.lastOk == null ? 'untested' : r.lastOk ? 'ok' : 'fail', options: [{ value: 'ok', label: '连通' }, { value: 'fail', label: '失败' }, { value: 'untested', label: '未测' }] },
  ];
  // 图表下钻:点环图某段 → 列出该段对应的代理明细。
  const proxyDrillCols: DrillCol<ProxyRow>[] = [
    { label: '地址', className: 'mono', render: (r) => `${r.host}:${r.port}` },
    { label: '类型', className: 'mono', render: (r) => r.type || 'socks5' },
    { label: '状态', render: (r) => r.status === 'active' ? <span className="kbadge ok">可用</span> : <span className="kbadge neutral">停用</span> },
    { label: '连通', render: (r) => r.lastOk == null ? <span style={{ color: 'var(--text-4)' }}>未测</span> : r.lastOk ? <span style={{ color: 'var(--success)' }}>{r.latencyMs}ms</span> : <span style={{ color: 'var(--danger)' }}>失败</span> },
  ];

  return (
    <main className="page">
      <div className="page-head"><h1>代理 / IP 池</h1><p>出口代理管理 <code>host:port:user:pass</code> —— 给账号分配出口(Python 建 AdsPower 环境必需)。<b>不是 AdsPower</b>(浏览器环境在 AdsPower 页)。</p></div>

      <div className="kpi-grid">
        <Kpi icon="layers" label="代理总数" value={rows.length} sub={`可用 ${active}`} />
        <Kpi icon="okcircle" label="连通" value={okN} tone="ok" sub={`失败 ${failN} · 未测 ${rows.length - okN - failN}`} />
        <Kpi icon="activity" label="平均延迟" value={avgMs ? avgMs + 'ms' : '—'} tone="info" sub={`已测 ${tested.length}`} />
        <Kpi icon="alert" label="失败" value={failN} tone="warn" />
      </div>

      <div className="section-gap" />

      <div className="grid-2">
        <section className="card"><div className="card-head"><span className="idx c-green">▤</span><h3>启用状态</h3><span className="head-hint">点击查看明细</span></div><div style={{ padding: '16px 18px' }}>{rows.length ? (
          <DrillableChart<ProxyRow>
            chart={(onSelect, active) => <Donut data={stateSegs} centerValue={rows.length} centerLabel="代理" onSelect={onSelect} activeIndex={active} />}
            resolve={(i) => ({ title: <>启用状态 · {stateSegs[i].label}</>, rows: rows.filter((r) => i === 0 ? r.status === 'active' : r.status !== 'active'), columns: proxyDrillCols })}
            rowKey={(r) => r.id}
          />
        ) : <div className="empty-note">代理池为空。</div>}</div></section>
        <section className="card"><div className="card-head"><span className="idx c-info">◌</span><h3>连通性</h3><span className="head-hint">点击查看明细</span></div><div style={{ padding: '16px 18px' }}>{rows.length ? (
          <DrillableChart<ProxyRow>
            chart={(onSelect, active) => <Donut data={connSegs} centerValue={okN} centerLabel="连通" onSelect={onSelect} activeIndex={active} />}
            resolve={(i) => ({ title: <>连通性 · {connSegs[i].label}</>, rows: rows.filter((r) => i === 0 ? r.lastOk === true : i === 1 ? r.lastOk === false : r.lastOk == null), columns: proxyDrillCols })}
            rowKey={(r) => r.id}
          />
        ) : <div className="empty-note">尚未测试。</div>}</div></section>
      </div>

      <div className="section-gap" />

      <section className="card">
        <div className="eb-top"><span className="idx c-info">▥</span><h3>代理明细</h3><span className="head-hint">添加 / 测试连通 / 停用 / 删除</span></div>
        <DataTable
          rows={rows} columns={columns} rowKey={(r) => r.id}
          getRowClass={(r) => r.status === 'disabled' ? 'is-used' : r.lastOk === false ? 'is-banned' : undefined}
          search={{ keys: [(r) => `${r.host}:${r.port}`, (r) => r.label, (r) => r.user], placeholder: '搜索 地址 / 标签…' }}
          filters={filters} columnSettings={{ tableId: 'proxies' }} maxHeight={520} exportName="proxies"
          selectable
          batchActions={(sel, clear) => (<>
            <button className="btn btn-ghost btn-sm" onClick={() => batchRun(sel, (r) => test.mutateAsync({ id: r.id }), { toast, verb: '测试', onDone: clear })}>测试</button>
            <button className="btn btn-ghost btn-sm" onClick={() => batchRun(sel, (r) => update.mutateAsync({ id: r.id, patch: { status: 'active' } }), { toast, verb: '启用', onDone: clear })}>启用</button>
            <button className="btn btn-ghost btn-sm" onClick={() => batchRun(sel, (r) => update.mutateAsync({ id: r.id, patch: { status: 'disabled' } }), { toast, verb: '停用', onDone: clear })}>停用</button>
            <button className="btn btn-danger-soft btn-sm" onClick={() => { if (confirm(`删除选中的 ${sel.length} 个代理?`)) batchRun(sel, (r) => remove.mutateAsync({ id: r.id }), { toast, verb: '删除', onDone: clear }); }}>删除</button>
          </>)}
          emptyText="代理池为空。点「添加代理」粘贴 host:port:user:pass(一行一个)。"
          toolbarLeft={<>
            <button className="btn btn-soft btn-sm" onClick={() => setAddOpen(true)}><Icon name="upload" size={12} />添加代理</button>
            <button className="btn btn-ghost btn-sm" disabled={testing || !rows.length} onClick={testAll}><Icon name="activity" size={12} />{testing ? '测试中…' : '测试全部连通'}</button>
            <button className="btn btn-ghost btn-sm" disabled={!rows.length} title="AdsPower 对 socks5 代理的启动自检常失败(本地DNS),而多数代理商同 host:port 也支持 http;改 http 一般就能过自检" onClick={async () => { if (confirm('把全部代理类型设为 HTTP?\n(AdsPower 启动自检对 socks5 常报 Check Proxy Fail;改 http 多数代理商也支持且兼容性更好)')) { await setType.mutateAsync({ type: 'http' }); toast.push('已将全部代理设为 HTTP', 'ok'); } }}>全部设为 HTTP</button>
            <button className="btn btn-ghost btn-sm" disabled={!rows.length} onClick={async () => { if (confirm('把全部代理类型设为 socks5?')) { await setType.mutateAsync({ type: 'socks5' }); toast.push('已将全部代理设为 socks5', 'ok'); } }}>设为 socks5</button>
            <button className="btn btn-danger-soft btn-sm" disabled={!rows.length} onClick={async () => { if (confirm('清空整个代理池?')) { await clear.mutateAsync({}); toast.push('代理池已清空', 'ok'); } }}><Icon name="trash" size={12} />清空</button>
          </>}
        />
      </section>

      <ImportModal open={addOpen} onClose={() => setAddOpen(false)} title="添加代理" label="代理列表"
        hint={<>一行一个,<code>host:port</code> 或 <code>host:port:user:pass</code>(密码可含冒号);默认 socks5,可加协议前缀如 <code>http://user:pass@host:port</code>,或加完用上方「全部设为 HTTP」批量改。AdsPower 对 socks5 自检常失败,代理多用 http。</>}
        placeholder={'1.2.3.4:8080:user:pass\nhttp://user:pass@5.6.7.8:3128'}
        parse={(t) => parseKind('proxy', t)}
        onImport={(raw) => add.mutateAsync({ raw })}
        formatResult={(r) => { const d = r as { added?: number; dup?: number }; return `新增 ${d.added || 0} · 重复 ${d.dup || 0}`; }} />
    </main>
  );
}
