// 账号(资源页):报表区(KPI + 阶段完成度柱图 + 正常/拉黑环图)+ 管理表(复用 StatusTab)+ 手动添加。
// 边界:账号"运行进度台账"(断点续跑/拉黑),**不是账号凭证库**(凭证在控制台输入)。
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api';
import { Icon } from '../lib/icons';
import { useToast } from '../lib/toast';
import { parseKind } from '../lib/parse';
import type { AccountsResp, AccountRow } from '../lib/types';
import { Kpi } from '../components/Kpi';
import { Bars, Donut, DrillableChart, type Seg, type DrillCol } from '../components/charts';
import { trunc } from '../lib/parse';
import { Modal } from '../components/Modal';
import { ImportModal } from '../components/ImportModal';
import { StatusTab } from '../features/panels';

export default function AccountsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['accounts'], queryFn: () => apiGet<AccountsResp>('/api/accounts', true), refetchInterval: 8000 });
  const accts = data?.accounts || [];
  const [addOpen, setAddOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [form, setForm] = useState({ email: '', originalPassword: '', note: '' });
  const inval = () => qc.invalidateQueries({ queryKey: ['accounts'] });
  const upsert = useMutation({ mutationFn: (b: unknown) => apiPost('/api/accounts/upsert', b), onSuccess: inval });
  const importM = useMutation({ mutationFn: (b: unknown) => apiPost('/api/accounts/import', b), onSuccess: inval });
  const n = accts.length;
  const c = (f: (a: AccountsResp['accounts'][number]) => boolean) => accts.filter(f).length;
  const reg = c((a) => !!a.registered), key = c((a) => !!a.apiKey), card = c((a) => !!a.cardLast4), charged = c((a) => !!(a.charged && a.charged > 0)), pw = c((a) => !!a.passwordChanged), banned = c((a) => !!a.blacklisted);
  const stageBars: Seg[] = [
    { label: '注册', value: reg, colorVar: '--primary' },
    { label: 'Key', value: key, colorVar: '--info' },
    { label: '加卡', value: card, colorVar: '--success' },
    { label: '充值', value: charged, colorVar: '--warn' },
    { label: '改密', value: pw, colorVar: '--primary-text' },
  ];
  const stateSegs: Seg[] = [{ label: '正常', value: n - banned, colorVar: '--success' }, { label: '拉黑', value: banned, colorVar: '--danger' }];
  // 各阶段柱子 i → 命中谓词(与 stageBars 顺序一致)
  const STAGE_PRED: ((a: AccountRow) => boolean)[] = [
    (a) => !!a.registered, (a) => !!a.apiKey, (a) => !!a.cardLast4, (a) => !!(a.charged && a.charged > 0), (a) => !!a.passwordChanged,
  ];
  const acctDrillCols: DrillCol<AccountRow>[] = [
    { label: '邮箱', className: 'mono', render: (a) => a.email },
    { label: 'API Key', className: 'mono', render: (a) => a.apiKey ? <span title={a.apiKey}>{trunc(a.apiKey, 18)}</span> : '—' },
    { label: '卡末4', className: 'mono', render: (a) => a.cardLast4 ? '•••• ' + a.cardLast4 : '—' },
    { label: '充值', className: 'mono', align: 'right', render: (a) => a.charged ? <span title={a.balanceAfter != null ? `充值后余额 $${a.balanceAfter}` : ''}>${a.charged}{a.balanceAfter != null ? ` →余$${a.balanceAfter}` : ''}</span> : '—' },
    { label: '状态', render: (a) => a.blacklisted ? <span className="kbadge fail" title={a.blacklistReason}>拉黑</span> : <span className="kbadge ok">正常</span> },
  ];

  return (
    <main className="page">
      <div className="page-head"><h1>账号</h1><p>账号<b>运行进度台账</b>(断点续跑)—— 跑到哪步 / 是否拉黑。<b>不是凭证库</b>:账号凭证在控制台粘贴输入。</p></div>

      <div className="kpi-grid">
        <Kpi icon="okcircle" label="账号总数" value={n} sub={`已注册 ${reg}`} />
        <Kpi icon="activity" label="已取 Key" value={key} tone="info" sub={`加卡 ${card} · 充值 ${charged}`} />
        <Kpi icon="lock" label="已改密" value={pw} sub="passwordChanged" />
        <Kpi icon="alert" label="拉黑" value={banned} tone="warn" sub={`正常 ${n - banned}`} />
      </div>

      <div className="section-gap" />

      <div className="grid-2">
        <section className="card">
          <div className="card-head"><span className="idx c-info">▦</span><h3>阶段完成度</h3><span className="head-hint">各阶段已完成账号数 · 点击查看明细</span></div>
          <div style={{ padding: '12px 18px 16px' }}>{n ? (
            <DrillableChart<AccountRow>
              chart={(onSelect, active) => <Bars data={stageBars} onSelect={onSelect} activeIndex={active} />}
              resolve={(i) => ({ title: <>已完成「{stageBars[i].label}」的账号</>, rows: accts.filter(STAGE_PRED[i]), columns: acctDrillCols })}
              rowKey={(a) => a.email}
            />
          ) : <div className="empty-note">暂无账号。</div>}</div>
        </section>
        <section className="card">
          <div className="card-head"><span className="idx c-amber">●</span><h3>账号状态</h3><span className="head-hint">点击查看明细</span></div>
          <div style={{ padding: '16px 18px' }}>{n ? (
            <DrillableChart<AccountRow>
              chart={(onSelect, active) => <Donut data={stateSegs} centerValue={n} centerLabel="账号" onSelect={onSelect} activeIndex={active} />}
              resolve={(i) => ({ title: <>账号状态 · {stateSegs[i].label}</>, rows: accts.filter((a) => i === 0 ? !a.blacklisted : !!a.blacklisted), columns: acctDrillCols })}
              rowKey={(a) => a.email}
            />
          ) : <div className="empty-note">暂无账号。</div>}</div>
        </section>
      </div>

      <div className="section-gap" />

      <section className="card">
        <div className="eb-top"><span className="idx c-green">▥</span><h3>账号明细 · 断点续跑</h3>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <Link className="btn btn-ghost btn-sm" to="/diagnose?by=email"><Icon name="search" size={12} />诊断</Link>
            <button className="btn btn-soft btn-sm" onClick={() => { setForm({ email: '', originalPassword: '', note: '' }); setAddOpen(true); }}><Icon name="edit" size={12} />手动添加</button>
            <button className="btn btn-soft btn-sm" onClick={() => setBulkOpen(true)}><Icon name="upload" size={12} />批量导入</button>
          </div>
        </div>
        <div style={{ padding: '12px 18px 0' }}><StatusTab /></div>
      </section>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="手动添加 / 编辑账号" icon="upload" size="md"
        foot={<><button className="btn btn-ghost" onClick={() => setAddOpen(false)}>取消</button><button className="btn btn-primary" disabled={!/.+@.+/.test(form.email)} onClick={async () => { await upsert.mutateAsync({ email: form.email.trim(), patch: { originalPassword: form.originalPassword, note: form.note } }); toast.push('已保存', 'ok'); setAddOpen(false); }}>保存</button></>}>
        <div style={{ padding: '16px 20px', display: 'grid', gap: 12 }}>
          <p className="help" style={{ margin: 0 }}>这里登记的是<b>账号进度台账</b>(用于续跑/排查),不是跑批入口;跑批仍在控制台粘贴账号。已存在的邮箱会被合并更新。</p>
          <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">邮箱</span><span className="l-hint">必填</span></div><input type="text" value={form.email} placeholder="user@firstmail.com" onChange={(e) => setForm((s) => ({ ...s, email: e.target.value }))} /></div>
          <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">原密码</span><span className="l-hint">可选</span></div><input type="text" value={form.originalPassword} onChange={(e) => setForm((s) => ({ ...s, originalPassword: e.target.value }))} /></div>
          <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">备注</span></div><input type="text" value={form.note} onChange={(e) => setForm((s) => ({ ...s, note: e.target.value }))} /></div>
        </div>
      </Modal>

      <ImportModal open={bulkOpen} onClose={() => setBulkOpen(false)} title="批量导入账号" label="账号凭证"
        hint={<>一行一个 <code>email:password</code>(密码可留空);或选文件上传。登记进度台账,非跑批入口</>}
        placeholder={'user1@firstmail.com:原密码1\nuser2@firstmail.com:原密码2'}
        parse={(t) => parseKind('account', t)}
        onImport={(raw) => importM.mutateAsync({ raw })}
        formatResult={(r) => { const d = r as { added?: number; updated?: number }; return `新增 ${d.added || 0} · 更新 ${d.updated || 0}`; }} />
    </main>
  );
}
