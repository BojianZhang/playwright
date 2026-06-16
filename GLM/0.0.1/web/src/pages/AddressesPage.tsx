// 账单地址池(资源页):报表(KPI + 状态环图 + 按州分布)+ 管理表(导入/编辑/删除)。
// 边界:只管加卡用的账单地址。不管代理、不管卡。绑地址阶段从池取(否则随机生成)。
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { Icon } from '../lib/icons';
import { useToast } from '../lib/toast';
import { parseKind } from '../lib/parse';
import { batchRun } from '../lib/batch';
import type { AddressRow } from '../lib/types';
import { Kpi } from '../components/Kpi';
import { Bars, DrillableChart, type Seg, type DrillCol } from '../components/charts';
import { ImportModal } from '../components/ImportModal';
import { DataTable, type Column, type FilterDef } from '../components/DataTable';

const PALETTE = ['--primary', '--info', '--success', '--warn', '--danger', '--primary-text'];

export default function AddressesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['addresses'], queryFn: () => apiGet<{ items: AddressRow[] }>('/api/addresses', true), refetchInterval: 12000 });
  const rows = data?.items || [];
  const onSuccess = () => qc.invalidateQueries({ queryKey: ['addresses'] });
  const importM = useMutation({ mutationFn: (b: unknown) => apiPost('/api/addresses/import', b), onSuccess });
  const update = useMutation({ mutationFn: (b: unknown) => apiPost('/api/addresses/update', b), onSuccess });
  const remove = useMutation({ mutationFn: (b: unknown) => apiPost('/api/addresses/remove', b), onSuccess });
  const clear = useMutation({ mutationFn: (b: unknown) => apiPost('/api/addresses/clear', b), onSuccess });
  const [addOpen, setAddOpen] = useState(false);

  const active = rows.filter((r) => r.status === 'active').length;
  const byState = Object.entries(rows.reduce<Record<string, number>>((m, r) => { const s = r.state || '其它'; m[s] = (m[s] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const stateBars: Seg[] = byState.map(([label, value], i) => ({ label, value, colorVar: PALETTE[i % PALETTE.length] }));
  const addrDrillCols: DrillCol<AddressRow>[] = [
    { label: '姓名', className: 'mono', render: (r) => r.name || '—' },
    { label: '街道', className: 'mono', render: (r) => r.line1 },
    { label: '城市', className: 'mono', render: (r) => r.city || '—' },
    { label: '邮编', className: 'mono', render: (r) => r.zip },
    { label: '状态', render: (r) => r.status === 'active' ? <span className="kbadge ok">可用</span> : <span className="kbadge neutral">停用</span> },
  ];

  const columns: Column<AddressRow>[] = [
    { key: 'name', label: '姓名', className: 'mono', sortAccessor: (r) => r.name, render: (r) => r.name || '—' },
    { key: 'line1', label: '街道', className: 'mono', cellStyle: { color: 'var(--text-2)' }, render: (r) => r.line1 },
    { key: 'city', label: '城市', className: 'mono', sortAccessor: (r) => r.city, render: (r) => r.city || '—' },
    { key: 'state', label: '州', className: 'mono', sortAccessor: (r) => r.state, render: (r) => r.state || '—' },
    { key: 'zip', label: '邮编', className: 'mono', render: (r) => r.zip },
    { key: 'status', label: '状态', sortAccessor: (r) => r.status, render: (r) => r.status === 'active' ? <span className="kbadge ok">可用</span> : <span className="kbadge neutral">停用</span> },
    { key: 'useCount', label: '用量', className: 'mono', align: 'right', sortAccessor: (r) => r.useCount, render: (r) => r.useCount },
    { key: 'actions', label: '操作', align: 'right', alwaysVisible: true, render: (r) => (
      <div className="row-actions">
        <button className="btn btn-ghost btn-sm" onClick={() => update.mutate({ id: r.id, patch: { status: r.status === 'active' ? 'disabled' : 'active' } })}>{r.status === 'active' ? '停用' : '启用'}</button>
        <button className="btn btn-danger-soft btn-sm" onClick={() => { if (confirm('删除该地址?')) remove.mutate({ id: r.id }); }}>删除</button>
      </div>
    ) },
  ];
  const filters: FilterDef<AddressRow>[] = [{ key: 'status', label: '状态', accessor: (r) => r.status, options: [{ value: 'active', label: '可用' }, { value: 'disabled', label: '停用' }] }];

  return (
    <main className="page">
      <div className="page-head"><h1>账单地址池</h1><p>加卡用的账单地址 <code>姓名|街道|城市|州|邮编</code>。绑地址阶段<b>从池取</b>(留空则随机生成)。不管代理 / 卡。</p></div>

      <div className="grid-2">
        <div className="kpi-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <Kpi icon="home" label="地址总数" value={rows.length} sub={`可用 ${active}`} />
          <Kpi icon="okcircle" label="可用" value={active} tone="ok" sub={`停用 ${rows.length - active}`} />
          <Kpi icon="grid" label="覆盖州数" value={byState.length} sub={byState.slice(0, 3).map(([s]) => s).join(' / ') || '—'} />
          <Kpi icon="activity" label="累计用量" value={rows.reduce((n, r) => n + (r.useCount || 0), 0)} tone="info" />
        </div>
        <section className="card"><div className="card-head"><span className="idx c-green">▤</span><h3>按州分布(Top 6)</h3><span className="head-hint">点击查看明细</span></div><div style={{ padding: '12px 18px 16px' }}>{rows.length ? (
          <DrillableChart<AddressRow>
            chart={(onSelect, active) => <Bars data={stateBars} onSelect={onSelect} activeIndex={active} />}
            resolve={(i) => ({ title: <>账单地址 · {stateBars[i].label}</>, rows: rows.filter((r) => (r.state || '其它') === stateBars[i].label), columns: addrDrillCols })}
            rowKey={(r) => r.id}
          />
        ) : <div className="empty-note">地址池为空。</div>}</div></section>
      </div>

      <div className="section-gap" />

      <section className="card">
        <div className="eb-top"><span className="idx c-info">▥</span><h3>地址明细</h3><span className="head-hint">导入 / 停用 / 删除</span></div>
        <DataTable
          rows={rows} columns={columns} rowKey={(r) => r.id}
          getRowClass={(r) => r.status === 'disabled' ? 'is-used' : undefined}
          search={{ keys: [(r) => r.name, (r) => r.line1, (r) => r.city, (r) => r.zip], placeholder: '搜索 姓名 / 街道 / 城市 / 邮编…' }}
          filters={filters} columnSettings={{ tableId: 'addresses' }} maxHeight={520} exportName="addresses"
          selectable
          batchActions={(sel, clear) => (<>
            <button className="btn btn-ghost btn-sm" onClick={() => batchRun(sel, (r) => update.mutateAsync({ id: r.id, patch: { status: 'active' } }), { toast, verb: '启用', onDone: clear })}>启用</button>
            <button className="btn btn-ghost btn-sm" onClick={() => batchRun(sel, (r) => update.mutateAsync({ id: r.id, patch: { status: 'disabled' } }), { toast, verb: '停用', onDone: clear })}>停用</button>
            <button className="btn btn-danger-soft btn-sm" onClick={() => { if (confirm(`删除选中的 ${sel.length} 个地址?`)) batchRun(sel, (r) => remove.mutateAsync({ id: r.id }), { toast, verb: '删除', onDone: clear }); }}>删除</button>
          </>)}
          emptyText="地址池为空。点「导入地址」粘贴 姓名|街道|城市|州|邮编(一行一个,支持 CSV)。"
          toolbarLeft={<>
            <button className="btn btn-soft btn-sm" onClick={() => setAddOpen(true)}><Icon name="upload" size={12} />导入地址</button>
            <button className="btn btn-danger-soft btn-sm" disabled={!rows.length} onClick={() => { if (confirm('清空整个地址池?')) clear.mutate({}); }}><Icon name="trash" size={12} />清空</button>
          </>}
          toolbarRight={<><span className="lg-dot" style={{ background: 'var(--success)' }} />可用 {active}</>}
        />
      </section>

      <ImportModal open={addOpen} onClose={() => setAddOpen(false)} title="导入账单地址" label="地址列表"
        hint={<>一行一个 <code>姓名|街道|城市|州|邮编[|地址行2]</code>(分隔符 | 或逗号 或制表);带表头的 CSV 也可,首行自动跳过;或选文件上传</>}
        placeholder={'Katherine Lee|128 NW 11th Ave|Portland|Oregon|97209'}
        accept=".txt,.csv,text/csv,text/*"
        parse={(t) => parseKind('address', t)}
        onImport={(raw) => importM.mutateAsync({ raw: parseKind('address', raw).kept.join('\n') || raw })}
        formatResult={(r) => { const d = r as { added?: number; dup?: number }; return `新增 ${d.added || 0} · 重复 ${d.dup || 0}`; }} />
    </main>
  );
}
