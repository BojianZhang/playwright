// 坏邮箱管理(资源页):查看 / 维护永久跳过的邮箱 + 整域拉黑。
// 数据源:selenium-e2e/state/bad_mailboxes.json(已永久跳过) + mailbox_verify_fails.json(软坏累计未达阈值)。
// 边界:只读写这两份账本(跨进程锁与 run.py 互斥),不改注册/验证逻辑本身。
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { Icon } from '../lib/icons';
import { useToast } from '../lib/toast';
import type { BadMailboxSnapshot, BadMailboxRow, BadMailboxType } from '../lib/types';
import { Kpi } from '../components/Kpi';
import { Donut, type Seg } from '../components/charts';
import { Modal } from '../components/Modal';
import { ImportModal } from '../components/ImportModal';
import { DataTable, type Column } from '../components/DataTable';

const DOMAIN_SUGGEST = 3; // 某域坏号 ≥ 此数且未整域拉黑 → 顶部建议条

const TYPE_LABEL: Record<BadMailboxType, string> = {
  hard404: '信箱404·不可达', hard401: '信箱401·密码错', soft: '收不到验证信',
  manual: '手动', 'manual-domain': '手动整域', 'domain-auto': '整域自动', other: '其它',
};
const TYPE_TONE: Record<BadMailboxType, 'ok' | 'neutral' | 'fail'> = {
  hard404: 'fail', hard401: 'fail', soft: 'neutral', manual: 'neutral',
  'manual-domain': 'fail', 'domain-auto': 'fail', other: 'neutral',
};
const TYPE_FILTER = (Object.keys(TYPE_LABEL) as BadMailboxType[]).map((v) => ({ value: v, label: TYPE_LABEL[v] }));

export default function BadMailboxPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['bad-mailboxes'], queryFn: () => apiGet<BadMailboxSnapshot>('/api/bad-mailboxes', true), refetchInterval: 15000 });
  const items = useMemo(() => data?.items || [], [data]);
  const softfails = data?.softfails || [];
  const domains = data?.domains || [];
  const stats = data?.stats;
  const inval = () => qc.invalidateQueries({ queryKey: ['bad-mailboxes'] });

  const add = useMutation({ mutationFn: (b: unknown) => apiPost('/api/bad-mailboxes/add', b), onSuccess: inval });
  const remove = useMutation({ mutationFn: (b: unknown) => apiPost('/api/bad-mailboxes/remove', b), onSuccess: inval });
  const clearSoft = useMutation({ mutationFn: (b: unknown) => apiPost('/api/bad-mailboxes/clear-softfail', b), onSuccess: inval });
  const blockDom = useMutation({ mutationFn: (b: unknown) => apiPost('/api/bad-mailboxes/block-domain', b), onSuccess: inval });
  const unblockDom = useMutation({ mutationFn: (b: unknown) => apiPost('/api/bad-mailboxes/unblock-domain', b), onSuccess: inval });

  const [addOpen, setAddOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [addVal, setAddVal] = useState('');

  const suggestDomains = domains.filter((d) => !d.blocked && d.badCount >= DOMAIN_SUGGEST);

  const segs: Seg[] = stats ? [
    { label: '硬坏(404/401)', value: stats.hard, colorVar: '--danger' },
    { label: '收不到信', value: stats.soft, colorVar: '--warning' },
    { label: '手动/整域', value: stats.manual, colorVar: '--text-4' },
    { label: '整域自动', value: stats.byType['domain-auto'] || 0, colorVar: '--text-2' },
  ].filter((s) => s.value > 0) : [];

  const cols: Column<BadMailboxRow>[] = [
    { key: 'key', label: '邮箱 / 域', className: 'mono', sortAccessor: (r) => r.key, render: (r) => r.kind === 'domain'
      ? <span><span className="kbadge fail" style={{ marginRight: 6 }}>整域</span>{r.key}</span> : r.key },
    { key: 'domain', label: '域', className: 'mono', sortAccessor: (r) => r.domain, cellStyle: { color: 'var(--text-2)' }, render: (r) => r.domain },
    { key: 'reasonType', label: '类型', sortAccessor: (r) => r.reasonType, exportValue: (r) => TYPE_LABEL[r.reasonType],
      render: (r) => <span className={`kbadge ${TYPE_TONE[r.reasonType]}`}>{TYPE_LABEL[r.reasonType]}</span> },
    { key: 'reason', label: '原因', className: 'mono', cellStyle: { color: 'var(--text-2)', fontSize: 12 }, sortAccessor: (r) => r.reason, render: (r) => r.reason || '—' },
    { key: 'at', label: '登记时间', sortAccessor: (r) => r.at, cellStyle: { color: 'var(--text-3)' }, render: (r) => r.at || '—' },
    { key: 'actions', label: '操作', align: 'right', alwaysVisible: true, render: (r) => (
      <div className="row-actions">
        <button className="btn btn-ghost btn-sm" title="从坏邮箱移除(恢复参与跑批)" onClick={() => { if (confirm(`恢复 ${r.key}?将重新参与跑批。`)) remove.mutate({ email: r.key }); }}>移除 / 恢复</button>
        {r.kind === 'email' && r.domain && <button className="btn btn-danger-soft btn-sm" title="把整个域拉黑" onClick={() => { if (confirm(`整域拉黑 ${r.domain}?该域所有号都将永久跳过。`)) blockDom.mutate({ domain: r.domain }); }}>整域拉黑</button>}
      </div>
    ) },
  ];

  async function importLines(raw: string) {
    const lines = raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    let added = 0;
    for (const line of lines) { try { await add.mutateAsync({ email: line }); added++; } catch { /* skip */ } }
    return { added, total: lines.length };
  }

  return (
    <main className="page">
      <div className="page-head"><h1>坏邮箱</h1><p>永久跳过的邮箱(收不到验证邮件 / 信箱不可达 / 手动拉黑)与<b>即将自动拉黑</b>的号,以及<b>整域拉黑</b>。<br />「软坏」= 信箱能登录但跨批连续收不到验证信,累计达阈值自动登记(治"重发空转");收到信一次即清零。</p></div>

      <div className="grid-2">
        <div className="kpi-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <Kpi icon="alert" label="坏邮箱总数" value={stats?.total ?? 0} tone="warn" sub={`整域 ${stats?.domainsBlocked ?? 0}`} />
          <Kpi icon="shield" label="硬坏(404/401)" value={stats?.hard ?? 0} sub="信箱本身不可用" />
          <Kpi icon="mail" label="软坏(收不到信)" value={stats?.soft ?? 0} sub={`即将拉黑 ${softfails.length}`} />
          <Kpi icon="layers" label="受影响域" value={stats?.domainsAffected ?? 0} sub={`已整域 ${stats?.domainsBlocked ?? 0}`} />
        </div>
        <section className="card"><div className="card-head"><span className="idx c-green">▤</span><h3>坏邮箱构成</h3><span className="head-hint">按原因类型</span></div><div style={{ padding: '16px 18px' }}>
          {segs.length ? <Donut data={segs} centerValue={stats?.total ?? 0} centerLabel="坏号" /> : <div className="empty-note">暂无坏邮箱。</div>}
        </div></section>
      </div>

      {suggestDomains.length > 0 && (
        <>
          <div className="section-gap" />
          <section className="card" style={{ borderColor: 'var(--warning, #d99)', background: 'var(--warn-bg, rgba(217,153,0,0.06))' }}>
            <div className="eb-top"><span className="idx">⚠</span><h3>整域拉黑建议</h3><span className="head-hint">某域坏号 ≥ {DOMAIN_SUGGEST} 个</span></div>
            <div style={{ padding: '10px 18px 16px', display: 'grid', gap: 8 }}>
              {suggestDomains.map((d) => (
                <div key={d.domain} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span className="mono" style={{ minWidth: 200 }}>{d.domain}</span>
                  <span className="kbadge fail">坏号 {d.badCount}</span>
                  {d.softCount > 0 && <span className="kbadge neutral">软坏 {d.softCount}</span>}
                  <button className="btn btn-danger-soft btn-sm" onClick={() => { if (confirm(`整域拉黑 ${d.domain}?该域所有号永久跳过。`)) blockDom.mutate({ domain: d.domain }); }}>整域拉黑</button>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {softfails.length > 0 && (
        <>
          <div className="section-gap" />
          <section className="card">
            <div className="eb-top"><span className="idx c-info">▥</span><h3>即将自动拉黑(软坏累计)</h3><span className="head-hint">连续收不到验证信,达阈值自动登记</span></div>
            <DataTable
              rows={softfails} columns={[
                { key: 'email', label: '邮箱', className: 'mono', sortAccessor: (r) => r.email, render: (r) => r.email },
                { key: 'count', label: '累计批次', sortAccessor: (r) => r.count, render: (r) => <span className="kbadge neutral">{r.count} 次</span> },
                { key: 'lastReason', label: '最近原因', className: 'mono', cellStyle: { color: 'var(--text-2)', fontSize: 12 }, render: (r) => r.lastReason || '—' },
                { key: 'lastAt', label: '最近时间', cellStyle: { color: 'var(--text-3)' }, sortAccessor: (r) => r.lastAt, render: (r) => r.lastAt || '—' },
                { key: 'actions', label: '操作', align: 'right', alwaysVisible: true, render: (r) => (
                  <div className="row-actions">
                    <button className="btn btn-danger-soft btn-sm" title="不等阈值,立即拉黑" onClick={() => { if (confirm(`立即拉黑 ${r.email}?`)) add.mutate({ email: r.email }); }}>立即拉黑</button>
                    <button className="btn btn-ghost btn-sm" title="清零累计(给它重新机会)" onClick={() => clearSoft.mutate({ email: r.email })}>清零</button>
                  </div>
                ) },
              ]} rowKey={(r) => r.email}
              search={{ keys: [(r) => r.email], placeholder: '搜索邮箱…' }}
              maxHeight={300} exportName="bad-mailbox-softfails"
              emptyText="暂无软坏累计。"
            />
          </section>
        </>
      )}

      {domains.length > 0 && (
        <>
          <div className="section-gap" />
          <section className="card">
            <div className="eb-top"><span className="idx">▦</span><h3>按域聚合</h3><span className="head-hint">整域拉黑 / 解除</span></div>
            <DataTable
              rows={domains} columns={[
                { key: 'domain', label: '域', className: 'mono', sortAccessor: (r) => r.domain, render: (r) => r.domain },
                { key: 'badCount', label: '坏号数', sortAccessor: (r) => r.badCount, render: (r) => r.badCount || '—' },
                { key: 'softCount', label: '软坏数', sortAccessor: (r) => r.softCount, render: (r) => r.softCount || '—' },
                { key: 'blocked', label: '整域状态', sortAccessor: (r) => (r.blocked ? 1 : 0), exportValue: (r) => (r.blocked ? '已整域拉黑' : '未'),
                  render: (r) => r.blocked ? <span className="kbadge fail">已整域拉黑</span> : <span className="kbadge neutral">未</span> },
                { key: 'actions', label: '操作', align: 'right', alwaysVisible: true, render: (r) => (
                  <div className="row-actions">
                    {r.blocked
                      ? <button className="btn btn-ghost btn-sm" onClick={() => { if (confirm(`解除整域拉黑 ${r.domain}?`)) unblockDom.mutate({ domain: r.domain }); }}>解除整域</button>
                      : <button className="btn btn-danger-soft btn-sm" onClick={() => { if (confirm(`整域拉黑 ${r.domain}?该域所有号永久跳过。`)) blockDom.mutate({ domain: r.domain }); }}>整域拉黑</button>}
                  </div>
                ) },
              ]} rowKey={(r) => r.domain}
              search={{ keys: [(r) => r.domain], placeholder: '搜索域…' }}
              maxHeight={320} exportName="bad-mailbox-domains"
              emptyText="暂无域聚合。"
            />
          </section>
        </>
      )}

      <div className="section-gap" />

      <section className="card">
        <div className="eb-top"><span className="idx c-info">▥</span><h3>坏邮箱明细</h3><span className="head-hint">添加 / 移除 / 整域拉黑</span></div>
        <DataTable
          rows={items} columns={cols} rowKey={(r) => r.key}
          getRowClass={(r) => r.kind === 'domain' ? 'is-used' : undefined}
          search={{ keys: [(r) => r.key, (r) => r.domain, (r) => r.reason], placeholder: '搜索 邮箱 / 域 / 原因…' }}
          filters={[
            { key: 'reasonType', label: '类型', accessor: (r) => r.reasonType, options: TYPE_FILTER },
            { key: 'kind', label: '粒度', accessor: (r) => r.kind, options: [{ value: 'email', label: '邮箱' }, { value: 'domain', label: '整域' }] },
          ]}
          columnSettings={{ tableId: 'bad-mailboxes' }} maxHeight={500} fillViewport exportName="bad-mailboxes"
          emptyText="暂无坏邮箱。注册时信箱不可达 / 跨批连续收不到验证信会自动登记;也可手动添加。"
          toolbarLeft={<>
            <button className="btn btn-soft btn-sm" onClick={() => { setAddVal(''); setAddOpen(true); }}><Icon name="alert" size={12} />手动添加</button>
            <button className="btn btn-soft btn-sm" onClick={() => setBulkOpen(true)}><Icon name="upload" size={12} />批量导入</button>
          </>}
        />
      </section>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="手动添加坏邮箱 / 整域" icon="alert" size="md"
        foot={<><button className="btn btn-ghost" onClick={() => setAddOpen(false)}>取消</button>
          <button className="btn btn-primary" disabled={!addVal.trim()} onClick={async () => { await add.mutateAsync({ email: addVal.trim() }); toast.push('已添加', 'ok'); setAddOpen(false); }}>添加</button></>}>
        <div style={{ padding: '16px 20px', display: 'grid', gap: 10 }}>
          <div className="field" style={{ margin: 0 }}>
            <div className="label"><span className="l-name">邮箱 或 @域</span></div>
            <input type="text" value={addVal} placeholder="dead@x.com  或  @deaddomain.com" autoFocus onChange={(e) => setAddVal(e.target.value)} />
          </div>
          <p style={{ margin: 0, color: 'var(--text-3)', fontSize: 12 }}>填 <code>a@b.com</code> 拉黑单个邮箱;填 <code>@b.com</code>(或裸 <code>b.com</code>)<b>整域拉黑</b> —— 该域所有号都永久跳过。</p>
        </div>
      </Modal>

      <ImportModal open={bulkOpen} onClose={() => setBulkOpen(false)} title="批量导入坏邮箱" icon="alert" label="邮箱 / @域 列表"
        hint={<>一行一个:<code>a@b.com</code> 单邮箱,或 <code>@b.com</code> 整域;支持逗号/空格/换行分隔,或选文件上传</>}
        placeholder={'dead1@x.com\ndead2@y.com\n@deaddomain.com'}
        onImport={(raw) => importLines(raw)}
        formatResult={(r) => { const d = r as { added?: number; total?: number }; return `新增 ${d.added || 0} / ${d.total || 0}`; }} />
    </main>
  );
}
