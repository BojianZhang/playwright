// 邮箱 key 池(资源页):多个邮箱服务 key(收验证邮件),失效转移。
// 边界:只管 key + 地址,不改收信逻辑。池空回退设置中心单 key。
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { Icon } from '../lib/icons';
import { useToast } from '../lib/toast';
import type { MailboxKey } from '../lib/types';
import { Kpi } from '../components/Kpi';
import { Donut, DrillableChart, type Seg, type DrillCol } from '../components/charts';
import { Modal } from '../components/Modal';
import { ImportModal } from '../components/ImportModal';
import { batchRun } from '../lib/batch';
import { DataTable, type Column } from '../components/DataTable';

export default function MailboxPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['mailbox-keys'], queryFn: () => apiGet<{ items: MailboxKey[] }>('/api/mailbox/keys', true), refetchInterval: 15000 });
  const keys = data?.items || [];
  const inval = () => qc.invalidateQueries({ queryKey: ['mailbox-keys'] });
  const add = useMutation({ mutationFn: (b: unknown) => apiPost('/api/mailbox/keys/add', b), onSuccess: inval });
  const upd = useMutation({ mutationFn: (b: unknown) => apiPost('/api/mailbox/keys/update', b), onSuccess: inval });
  const del = useMutation({ mutationFn: (b: unknown) => apiPost('/api/mailbox/keys/remove', b), onSuccess: inval });
  const clear = useMutation({ mutationFn: (b: unknown) => apiPost('/api/mailbox/keys/clear', b), onSuccess: inval });
  const importM = useMutation({ mutationFn: (b: unknown) => apiPost('/api/mailbox/keys/import', b), onSuccess: inval });
  const [open, setOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [form, setForm] = useState({ label: '', provider: 'firstmail', apiKey: '', apiBaseUrl: 'https://firstmail.ltd' });

  const active = keys.filter((k) => k.status === 'active').length;
  const segs: Seg[] = [{ label: '可用', value: active, colorVar: '--success' }, { label: '停用', value: keys.length - active, colorVar: '--text-4' }];
  const keyDrillCols: DrillCol<MailboxKey>[] = [
    { label: '标签', className: 'mono', render: (k) => k.label },
    { label: '服务商', render: (k) => <span className="kbadge neutral">{k.provider}</span> },
    { label: 'API 地址', className: 'mono', render: (k) => k.apiBaseUrl },
    { label: '密钥', render: (k) => k.apiKeySet ? <span className="kbadge ok">已设置</span> : <span className="kbadge fail">缺失</span> },
    { label: '状态', render: (k) => k.status === 'active' ? <span className="kbadge ok">可用</span> : <span className="kbadge neutral">停用</span> },
  ];

  const cols: Column<MailboxKey>[] = [
    { key: 'label', label: '标签', className: 'mono', sortAccessor: (k) => k.label, render: (k) => k.label },
    { key: 'provider', label: '服务商', render: (k) => <span className="kbadge neutral">{k.provider}</span> },
    { key: 'apiBaseUrl', label: 'API 地址', className: 'mono', cellStyle: { color: 'var(--text-2)' }, render: (k) => k.apiBaseUrl },
    { key: 'apiKeySet', label: '密钥', exportValue: (k) => k.apiKeySet ? '已设置' : '缺失', render: (k) => k.apiKeySet ? <span className="kbadge ok">已设置</span> : <span className="kbadge fail">缺失</span> },
    { key: 'status', label: '状态', sortAccessor: (k) => k.status, exportValue: (k) => k.status === 'active' ? '可用' : '停用', render: (k) => k.status === 'active' ? <span className="kbadge ok">可用</span> : <span className="kbadge neutral">停用</span> },
    { key: 'actions', label: '操作', align: 'right', alwaysVisible: true, render: (k) => (
      <div className="row-actions">
        <button className="btn btn-ghost btn-sm" onClick={() => upd.mutate({ id: k.id, patch: { status: k.status === 'active' ? 'disabled' : 'active' } })}>{k.status === 'active' ? '停用' : '启用'}</button>
        <button className="btn btn-danger-soft btn-sm" onClick={() => { if (confirm('删除该 key?')) del.mutate({ id: k.id }); }}>删除</button>
      </div>
    ) },
  ];

  return (
    <main className="page">
      <div className="page-head"><h1>邮箱 key 池</h1><p>多个邮箱服务 key(收 z.ai 验证邮件),<b>只要有可用的就一直用</b>。只管 key + 地址,不改收信逻辑;池空回退设置中心单 key。</p></div>

      <div className="grid-2">
        <div className="kpi-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <Kpi icon="mail" label="key 总数" value={keys.length} sub={`可用 ${active}`} />
          <Kpi icon="okcircle" label="可用" value={active} tone="ok" sub={`停用 ${keys.length - active}`} />
        </div>
        <section className="card"><div className="card-head"><span className="idx c-green">▤</span><h3>key 状态</h3><span className="head-hint">点击查看明细</span></div><div style={{ padding: '16px 18px' }}>{keys.length ? (
          <DrillableChart<MailboxKey>
            chart={(onSelect, active) => <Donut data={segs} centerValue={keys.length} centerLabel="key" onSelect={onSelect} activeIndex={active} />}
            resolve={(i) => ({ title: <>key 状态 · {segs[i].label}</>, rows: keys.filter((k) => i === 0 ? k.status === 'active' : k.status !== 'active'), columns: keyDrillCols })}
            rowKey={(k) => k.id}
          />
        ) : <div className="empty-note">key 池为空。</div>}</div></section>
      </div>

      <div className="section-gap" />

      <section className="card">
        <div className="eb-top"><span className="idx c-info">▥</span><h3>邮箱 key 明细</h3><span className="head-hint">添加 / 停用 / 删除</span></div>
        <DataTable
          rows={keys} columns={cols} rowKey={(k) => k.id}
          getRowClass={(k) => k.status === 'disabled' ? 'is-used' : undefined}
          search={{ keys: [(k) => k.label, (k) => k.provider, (k) => k.apiBaseUrl], placeholder: '搜索 标签 / 服务商 / 地址…' }}
          filters={[{ key: 'status', label: '状态', accessor: (k) => k.status, options: [{ value: 'active', label: '可用' }, { value: 'disabled', label: '停用' }] }]}
          columnSettings={{ tableId: 'mailbox-keys' }} maxHeight={460} exportName="mailbox-keys"
          selectable
          batchActions={(sel, clear) => (<>
            <button className="btn btn-ghost btn-sm" onClick={() => batchRun(sel, (k) => upd.mutateAsync({ id: k.id, patch: { status: 'active' } }), { toast, verb: '启用', onDone: clear })}>启用</button>
            <button className="btn btn-ghost btn-sm" onClick={() => batchRun(sel, (k) => upd.mutateAsync({ id: k.id, patch: { status: 'disabled' } }), { toast, verb: '停用', onDone: clear })}>停用</button>
            <button className="btn btn-danger-soft btn-sm" onClick={() => { if (confirm(`删除选中的 ${sel.length} 个 key?`)) batchRun(sel, (k) => del.mutateAsync({ id: k.id }), { toast, verb: '删除', onDone: clear }); }}>删除</button>
          </>)}
          emptyText="key 池为空。点「添加 key」加入邮箱服务(firstmail)的 API key(可多个)。"
          toolbarLeft={<>
            <button className="btn btn-soft btn-sm" onClick={() => { setForm({ label: '', provider: 'firstmail', apiKey: '', apiBaseUrl: 'https://firstmail.ltd' }); setOpen(true); }}><Icon name="mail" size={12} />添加 key</button>
            <button className="btn btn-soft btn-sm" onClick={() => setBulkOpen(true)}><Icon name="upload" size={12} />批量导入</button>
            <button className="btn btn-danger-soft btn-sm" disabled={!keys.length} onClick={() => { if (confirm('清空邮箱 key 池?')) clear.mutate({}); }}><Icon name="trash" size={12} />清空</button>
          </>}
        />
      </section>

      <Modal open={open} onClose={() => setOpen(false)} title="添加邮箱 key" icon="mail" size="md"
        foot={<><button className="btn btn-ghost" onClick={() => setOpen(false)}>取消</button><button className="btn btn-primary" disabled={!form.apiKey.trim()} onClick={async () => { await add.mutateAsync(form); toast.push('已添加', 'ok'); setOpen(false); }}>添加</button></>}>
        <div style={{ padding: '16px 20px', display: 'grid', gap: 12 }}>
          <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">标签</span></div><input type="text" value={form.label} placeholder="firstmail-1" onChange={(e) => setForm((s) => ({ ...s, label: e.target.value }))} /></div>
          <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">服务商</span></div><input type="text" value={form.provider} onChange={(e) => setForm((s) => ({ ...s, provider: e.target.value }))} /></div>
          <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">API 地址</span></div><input type="text" value={form.apiBaseUrl} onChange={(e) => setForm((s) => ({ ...s, apiBaseUrl: e.target.value }))} /></div>
          <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">API Key</span></div><input type="password" value={form.apiKey} autoComplete="new-password" onChange={(e) => setForm((s) => ({ ...s, apiKey: e.target.value }))} /></div>
        </div>
      </Modal>

      <ImportModal open={bulkOpen} onClose={() => setBulkOpen(false)} title="批量导入邮箱 key" icon="mail" label="邮箱 key 列表"
        hint={<>一行一个:裸 <code>apiKey</code>,或 <code>provider|apiKey|apiBaseUrl|label</code>(缺省 firstmail / firstmail.ltd);或选文件上传</>}
        placeholder={'key_abc123\nfirstmail|key_def456|https://firstmail.ltd|备用'}
        onImport={(raw) => importM.mutateAsync({ raw })}
        formatResult={(r) => { const d = r as { added?: number; dup?: number }; return `新增 ${d.added || 0} · 重复 ${d.dup || 0}`; }} />
    </main>
  );
}
