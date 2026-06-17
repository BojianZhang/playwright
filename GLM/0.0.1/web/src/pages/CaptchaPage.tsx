// 验证码 key 池(资源页):多个求解服务 key,失效转移(只要有可用就一直用)+ 余额。
// 边界:只管 API key 的增删改/选用/余额,不改求解逻辑。池空回退设置中心单 key。
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { Icon } from '../lib/icons';
import { useToast } from '../lib/toast';
import type { CaptchaKey } from '../lib/types';
import { Kpi } from '../components/Kpi';
import { Donut, DrillableChart, type Seg, type DrillCol } from '../components/charts';
import { Modal } from '../components/Modal';
import { ImportModal } from '../components/ImportModal';
import { RowMenu } from '../components/RowMenu';
import { batchRun } from '../lib/batch';
import { DataTable, type Column } from '../components/DataTable';

export default function CaptchaPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['captcha-keys'], queryFn: () => apiGet<{ items: CaptchaKey[] }>('/api/captcha/keys', true), refetchInterval: 15000 });
  const keys = data?.items || [];
  const inval = () => qc.invalidateQueries({ queryKey: ['captcha-keys'] });
  const add = useMutation({ mutationFn: (b: unknown) => apiPost('/api/captcha/keys/add', b), onSuccess: inval });
  const upd = useMutation({ mutationFn: (b: unknown) => apiPost('/api/captcha/keys/update', b), onSuccess: inval });
  const del = useMutation({ mutationFn: (b: unknown) => apiPost('/api/captcha/keys/remove', b), onSuccess: inval });
  const clear = useMutation({ mutationFn: (b: unknown) => apiPost('/api/captcha/keys/clear', b), onSuccess: inval });
  const bal = useMutation({ mutationFn: (b: unknown) => apiPost('/api/captcha/keys/balance', b), onSuccess: inval });
  const importM = useMutation({ mutationFn: (b: unknown) => apiPost('/api/captcha/keys/import', b), onSuccess: inval });
  const [open, setOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [form, setForm] = useState({ label: '', provider: '2captcha', apiKey: '' });
  const [checking, setChecking] = useState(false);

  const active = keys.filter((k) => k.status === 'active').length;
  const usable = keys.filter((k) => k.usable).length;
  const funded = keys.filter((k) => k.balance != null && k.balance > 0).length;
  const segs: Seg[] = [{ label: '可用', value: active, colorVar: '--success' }, { label: '停用', value: keys.length - active, colorVar: '--text-4' }];
  const keyDrillCols: DrillCol<CaptchaKey>[] = [
    { label: '标签', className: 'mono', render: (k) => k.label },
    { label: '服务商', render: (k) => <span className="kbadge neutral">{k.provider}</span> },
    { label: '状态', render: (k) => k.usable ? <span className="kbadge ok">可用</span> : (k.status === 'active' ? <span className="kbadge warn">余额耗尽</span> : <span className="kbadge neutral">停用</span>) },
    { label: '余额', className: 'mono', align: 'right', render: (k) => k.balance == null ? <span style={{ color: 'var(--text-4)' }}>未查</span> : <span style={{ color: k.balance > 0 ? 'var(--success)' : 'var(--danger)' }}>${k.balance}</span> },
  ];
  async function checkAll() { setChecking(true); try { await bal.mutateAsync({}); toast.push('余额已刷新', 'ok'); } finally { setChecking(false); } }

  const cols: Column<CaptchaKey>[] = [
    { key: 'label', label: '标签', className: 'mono', sortAccessor: (k) => k.label, render: (k) => k.label },
    { key: 'provider', label: '服务商', render: (k) => <span className="kbadge neutral">{k.provider}</span> },
    { key: 'apiKeySet', label: '密钥', exportValue: (k) => k.apiKeySet ? '已设置' : '缺失', render: (k) => k.apiKeySet ? <span className="kbadge ok">已设置</span> : <span className="kbadge fail">缺失</span> },
    { key: 'status', label: '状态', sortAccessor: (k) => k.usable ? 2 : (k.status === 'active' ? 1 : 0), exportValue: (k) => k.usable ? '可用' : (k.status === 'active' ? '余额耗尽' : '停用'), render: (k) => k.usable ? <span className="kbadge ok">可用</span> : (k.status === 'active' ? <span className="kbadge warn">余额耗尽</span> : <span className="kbadge neutral">停用</span>) },
    { key: 'balance', label: '余额', className: 'mono', align: 'right', sortAccessor: (k) => k.balance ?? -1, exportValue: (k) => k.balance == null ? '未查' : k.balance, render: (k) => k.balance == null ? <span style={{ color: 'var(--text-4)' }}>未查</span> : <span style={{ color: k.balance > 0 ? 'var(--success)' : 'var(--danger)' }}>${k.balance}</span> },
    { key: 'lastError', label: '最近错误', className: 'mono', cellStyle: { color: 'var(--danger)' }, defaultHidden: true, render: (k) => k.lastError || '—' },
    { key: 'actions', label: '操作', align: 'right', alwaysVisible: true, render: (k) => (
      <RowMenu
        inline={<button className="btn btn-ghost btn-sm" onClick={() => bal.mutate({ id: k.id })}>查余额</button>}
        actions={[
          { label: k.status === 'active' ? '停用' : '启用', icon: k.status === 'active' ? 'pause' : 'play', onClick: () => upd.mutate({ id: k.id, patch: { status: k.status === 'active' ? 'disabled' : 'active' } }) },
          { label: '删除', icon: 'trash', danger: true, onClick: () => { if (confirm('删除该 key?')) del.mutate({ id: k.id }); } },
        ]}
      />
    ) },
  ];

  return (
    <main className="page">
      <div className="page-head"><h1>验证码 key 池</h1><p>多个求解服务 key(2captcha/capsolver),<b>只要有可用的就一直用</b>(禁用/额度耗尽自动跳过)。只管 key,不改求解逻辑;池空回退设置中心单 key。</p></div>

      <div className="grid-2">
        <div className="kpi-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <Kpi icon="shield" label="key 总数" value={keys.length} sub={`可用 ${active}`} />
          <Kpi icon="okcircle" label="有额度" value={funded} tone="ok" sub={`已查 ${keys.filter((k) => k.balance != null).length}`} />
          <Kpi icon="activity" label="可用" value={usable} tone="info" sub={`启用 ${active}`} />
          <Kpi icon="alert" label="停用" value={keys.length - active} tone="warn" />
        </div>
        <section className="card"><div className="card-head"><span className="idx c-green">▤</span><h3>key 状态</h3><span className="head-hint">点击查看明细</span></div><div style={{ padding: '16px 18px' }}>{keys.length ? (
          <DrillableChart<CaptchaKey>
            chart={(onSelect, active) => <Donut data={segs} centerValue={keys.length} centerLabel="key" onSelect={onSelect} activeIndex={active} />}
            resolve={(i) => ({ title: <>key 状态 · {segs[i].label}</>, rows: keys.filter((k) => i === 0 ? k.status === 'active' : k.status !== 'active'), columns: keyDrillCols })}
            rowKey={(k) => k.id}
          />
        ) : <div className="empty-note">key 池为空。</div>}</div></section>
      </div>

      <div className="section-gap" />

      <section className="card">
        <div className="eb-top"><span className="idx c-info">▥</span><h3>验证码 key 明细</h3><span className="head-hint">添加 / 查余额 / 停用 / 删除</span></div>
        <DataTable
          rows={keys} columns={cols} rowKey={(k) => k.id}
          getRowClass={(k) => k.status === 'disabled' ? 'is-used' : (k.balance === 0 ? 'is-banned' : undefined)}
          search={{ keys: [(k) => k.label, (k) => k.provider], placeholder: '搜索 标签 / 服务商…' }}
          filters={[
            { key: 'status', label: '状态', accessor: (k) => k.status, options: [{ value: 'active', label: '启用' }, { value: 'disabled', label: '停用' }] },
            { key: 'balance', label: '余额', accessor: (k) => k.balance == null ? 'unq' : k.balance > 0 ? 'funded' : 'empty', options: [{ value: 'funded', label: '有额度' }, { value: 'empty', label: '耗尽' }, { value: 'unq', label: '未查' }] },
          ]}
          columnSettings={{ tableId: 'captcha-keys' }} maxHeight={460} fillViewport exportName="captcha-keys"
          selectable
          batchActions={(sel, clear) => (<>
            <button className="btn btn-ghost btn-sm" onClick={() => batchRun(sel, (k) => bal.mutateAsync({ id: k.id }), { toast, verb: '查余额', onDone: clear })}>查余额</button>
            <button className="btn btn-ghost btn-sm" onClick={() => batchRun(sel, (k) => upd.mutateAsync({ id: k.id, patch: { status: 'active' } }), { toast, verb: '启用', onDone: clear })}>启用</button>
            <button className="btn btn-ghost btn-sm" onClick={() => batchRun(sel, (k) => upd.mutateAsync({ id: k.id, patch: { status: 'disabled' } }), { toast, verb: '停用', onDone: clear })}>停用</button>
            <button className="btn btn-danger-soft btn-sm" onClick={() => { if (confirm(`删除选中的 ${sel.length} 个 key?`)) batchRun(sel, (k) => del.mutateAsync({ id: k.id }), { toast, verb: '删除', onDone: clear }); }}>删除</button>
          </>)}
          emptyText="key 池为空。点「添加 key」加入 2captcha/capsolver 的 API key(可多个)。"
          toolbarLeft={<>
            <button className="btn btn-soft btn-sm" onClick={() => { setForm({ label: '', provider: '2captcha', apiKey: '' }); setOpen(true); }}><Icon name="shield" size={12} />添加 key</button>
            <button className="btn btn-soft btn-sm" onClick={() => setBulkOpen(true)}><Icon name="upload" size={12} />批量导入</button>
            <button className="btn btn-ghost btn-sm" disabled={checking || !keys.length} onClick={checkAll}><Icon name="refresh" size={12} />{checking ? '查询中…' : '查全部余额'}</button>
            <button className="btn btn-danger-soft btn-sm" disabled={!keys.length} onClick={() => { if (confirm('清空验证码 key 池?')) clear.mutate({}); }}><Icon name="trash" size={12} />清空</button>
          </>}
        />
      </section>

      <Modal open={open} onClose={() => setOpen(false)} title="添加验证码 key" icon="shield" size="md"
        foot={<><button className="btn btn-ghost" onClick={() => setOpen(false)}>取消</button><button className="btn btn-primary" disabled={!form.apiKey.trim()} onClick={async () => { await add.mutateAsync(form); toast.push('已添加', 'ok'); setOpen(false); }}>添加</button></>}>
        <div style={{ padding: '16px 20px', display: 'grid', gap: 12 }}>
          <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">标签</span></div><input type="text" value={form.label} placeholder="主key / 备用" onChange={(e) => setForm((s) => ({ ...s, label: e.target.value }))} /></div>
          <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">服务商</span></div><select value={form.provider} onChange={(e) => setForm((s) => ({ ...s, provider: e.target.value }))}><option value="2captcha">2Captcha</option><option value="capsolver">CapSolver</option></select></div>
          <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">API Key</span></div><input type="password" value={form.apiKey} autoComplete="new-password" onChange={(e) => setForm((s) => ({ ...s, apiKey: e.target.value }))} /></div>
          <p className="help" style={{ margin: 0 }}>注:求解服务按所选 key 的「服务商」生效 —— <b>2Captcha</b>=截图点缺口坐标;<b>CapSolver</b>=VisionEngine slider_1(喂拼图块+背景图直接返回滑动距离,更贴合 z.ai 的阿里云滑块)。池里多个 key 自动挑可用的用。</p>
        </div>
      </Modal>

      <ImportModal open={bulkOpen} onClose={() => setBulkOpen(false)} title="批量导入验证码 key" icon="shield" label="验证码 key 列表"
        hint={<>一行一个:裸 <code>apiKey</code>(默认 2captcha),或 <code>provider|apiKey|label</code>(provider = 2captcha / capsolver);或选文件上传</>}
        placeholder={'key_abc123\ncapsolver|key_def456|备用'}
        onImport={(raw) => importM.mutateAsync({ raw })}
        formatResult={(r) => { const d = r as { added?: number; dup?: number }; return `新增 ${d.added || 0} · 重复 ${d.dup || 0}`; }} />
    </main>
  );
}
