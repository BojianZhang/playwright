// 诊断 / 排查(只读整合):按 邮箱/卡末4/代理/环境 搜 → 一页看完整链路。
// 边界:只读关联展示,不改任何资源数据。
import { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { Icon } from '../lib/icons';
import { DataTable, type Column } from '../components/DataTable';
import { DECLINE_LABEL as DECLINE_LABEL_D } from '../lib/labels';   // ★单一来源(原本地副本,与 panels/RunDetail 三处重复)

type By = 'email' | 'card' | 'proxy' | 'env';
interface UsageRow { at: number; jobId: string; engine: string; email: string; host: string; exitIp: string; proxyId: string; cardLast4: string; envId: string; stage: string; ok: boolean; reason: string }
interface ErrRow { at: string; email: string; stage: string; reason: string; action: string; attempt: number; jobId: string }
interface BillRow { at: string; email: string; result: string; charged: number; cardLast4: string; declineCode?: string; error: string }
interface DiagResp {
  by: By; value: string;
  account?: Record<string, unknown> | null;
  usage: UsageRow[]; errors: ErrRow[]; billing: BillRow[];
  emails?: string[];
  related?: { cards: string[]; proxies: { proxyId: string; host: string; exitIp: string }[]; envs: string[] };
}

const BY_LABEL: Record<By, string> = { email: '邮箱', card: '卡末4', proxy: '代理(id/host/IP)', env: 'AdsPower 环境' };
const fmt = (t: number | string) => { try { return new Date(typeof t === 'number' ? t : t).toLocaleString('zh-CN', { hour12: false }); } catch { return String(t); } };

const USAGE_COLS: Column<UsageRow>[] = [
  { key: 'at', label: '时间', className: 'mono', cellStyle: { color: 'var(--text-3)' }, sortAccessor: (r) => r.at, exportValue: (r) => fmt(r.at), render: (r) => fmt(r.at) },
  { key: 'email', label: '账号', className: 'mono', exportValue: (r) => r.email || '', render: (r) => <Link to={`/diagnose?by=email&value=${encodeURIComponent(r.email)}`} style={{ color: 'var(--primary-text)' }}>{r.email}</Link> },
  { key: 'engine', label: '引擎', className: 'mono', render: (r) => r.engine },
  { key: 'stage', label: '阶段', className: 'mono', render: (r) => r.stage || '—' },
  { key: 'ok', label: '结果', sortAccessor: (r) => r.ok ? 1 : 0, exportValue: (r) => r.ok ? '成功' : '失败', render: (r) => r.ok ? <span className="kbadge ok">成功</span> : <span className="kbadge fail">失败</span> },
  { key: 'cardLast4', label: '卡', className: 'mono', render: (r) => r.cardLast4 ? <Link to={`/diagnose?by=card&value=${r.cardLast4}`} style={{ color: 'var(--primary-text)' }}>••••{r.cardLast4}</Link> : '—' },
  { key: 'proxy', label: '代理/出口', className: 'mono', cellStyle: { color: 'var(--text-2)' }, exportValue: (r) => r.host || r.exitIp || r.proxyId || '', render: (r) => r.proxyId ? <Link to={`/diagnose?by=proxy&value=${r.proxyId}`} style={{ color: 'var(--primary-text)' }}>{r.host || r.exitIp || r.proxyId}</Link> : (r.host || r.exitIp || '—') },
  { key: 'envId', label: '环境', className: 'mono', render: (r) => r.envId ? <Link to={`/diagnose?by=env&value=${r.envId}`} style={{ color: 'var(--primary-text)' }}>{r.envId}</Link> : '—' },
  { key: 'reason', label: '错误', className: 'mono', cellStyle: { color: 'var(--danger)' }, render: (r) => r.reason || '—' },
];
const ERR_COLS: Column<ErrRow>[] = [
  { key: 'at', label: '时间', className: 'mono', cellStyle: { color: 'var(--text-3)' }, sortAccessor: (r) => r.at, exportValue: (r) => fmt(r.at), render: (r) => fmt(r.at) },
  { key: 'email', label: '账号', className: 'mono', render: (r) => r.email || '—' },
  { key: 'stage', label: '阶段', className: 'mono', render: (r) => r.stage || '—' },
  { key: 'reason', label: '错误', className: 'mono', cellStyle: { color: 'var(--danger)' }, render: (r) => r.reason },
  { key: 'action', label: '动作', render: (r) => <span className="kbadge warn">{r.action || '—'}</span> },
  { key: 'attempt', label: '第几次', className: 'mono', align: 'right', render: (r) => r.attempt ?? '—' },
];
const BILL_COLS: Column<BillRow>[] = [
  { key: 'at', label: '时间', className: 'mono', cellStyle: { color: 'var(--text-3)' }, sortAccessor: (r) => r.at, exportValue: (r) => fmt(r.at), render: (r) => fmt(r.at) },
  { key: 'email', label: '账号', className: 'mono', render: (r) => r.email || '—' },
  { key: 'cardLast4', label: '卡', className: 'mono', render: (r) => r.cardLast4 ? '••••' + r.cardLast4 : '—' },
  { key: 'charged', label: '金额', className: 'mono', align: 'right', render: (r) => r.charged ? '$' + r.charged : '—' },
  { key: 'result', label: '结果', render: (r) => r.result === 'success' ? <span className="kbadge ok">成功</span> : <span className="kbadge fail">{r.result}</span> },
  { key: 'declineCode', label: '拒付原因', className: 'mono', exportValue: (r) => r.declineCode || '', render: (r) => r.declineCode ? <span style={{ color: r.declineCode === 'insufficient_funds' ? 'var(--danger)' : 'var(--text-3)' }} title={DECLINE_LABEL_D[r.declineCode] || r.declineCode}>{DECLINE_LABEL_D[r.declineCode] || r.declineCode}</span> : '—' },
  { key: 'error', label: '错误', className: 'mono', cellStyle: { color: 'var(--danger)' }, render: (r) => r.error || '—' },
];

export default function DiagnosePage() {
  const [sp, setSp] = useSearchParams();
  const by = (sp.get('by') as By) || 'email';
  const value = sp.get('value') || '';
  const [byInput, setByInput] = useState<By>(by);
  const [valInput, setValInput] = useState(value);
  // URL 参数外部变化(如从图表下钻跳过来 /diagnose?by=card&value=...)时同步回输入框,否则表格已按新值查、输入框还显旧值。
  useEffect(() => { setByInput(by); setValInput(value); }, [by, value]);

  const { data, isLoading } = useQuery({
    queryKey: ['diagnose', by, value],
    queryFn: () => apiGet<DiagResp>(`/api/diagnose?by=${by}&value=${encodeURIComponent(value)}`, true),
    enabled: !!value,
    refetchInterval: 30000,   // 取证查看页,每次后端全量扫 usage.jsonl;5s→30s(react-query 页面隐藏即暂停,手动改查询也会立刷)
  });
  // ★无搜索值时的默认落地:最近活动(不再空页 dead-end)。点任意行的 账号/卡/代理/环境 即下钻排查。
  const { data: recent, isLoading: recentLoading } = useQuery({
    queryKey: ['diagnose-recent'],
    queryFn: () => apiGet<{ usage: UsageRow[]; declines: BillRow[] }>('/api/diagnose/recent?limit=200', true),
    enabled: !value,
    refetchInterval: 30000,
  });

  function submit(e: React.FormEvent) { e.preventDefault(); setSp({ by: byInput, value: valInput.trim() }); }
  const acc = (data?.account || null) as Record<string, string | number | boolean> | null;

  return (
    <main className="page">
      <div className="page-head"><h1>诊断 / 排查</h1><p>按 邮箱 / 卡末4 / 代理 / 环境 搜 → 一页看它的完整链路(用了哪张卡/哪个代理/哪个环境、卡在哪步、错误)。<b>只读</b>,不改数据。</p></div>

      <section className="card card-pad">
        <form onSubmit={submit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="dt-filter" style={{ width: 160 }} value={byInput} onChange={(e) => setByInput(e.target.value as By)}>
            {(['email', 'card', 'proxy', 'env'] as By[]).map((b) => <option key={b} value={b}>按 {BY_LABEL[b]}</option>)}
          </select>
          <div className="search-box" style={{ flex: '1 1 320px', maxWidth: 560 }}><Icon name="search" size={14} /><input placeholder={`输入${BY_LABEL[byInput]}…`} value={valInput} onChange={(e) => setValInput(e.target.value)} /></div>
          <button className="btn btn-primary" type="submit"><Icon name="search" size={14} />查</button>
        </form>
      </section>

      {!value && (
        <>
          <div className="section-gap" />
          {/* 拒付速览:最近被拒的卡(点卡末4 下钻看这张卡的完整链路)——直奔「充值全 declined」排查 */}
          {!!(recent?.declines?.length) && (
            <section className="card">
              <div className="eb-top"><span className="idx c-amber">⚑</span><h3>最近拒付 <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>{recent!.declines.length}</span></h3><span className="head-hint">点卡末4 看这张卡的完整链路;余额不足=换卡,其余多为风控</span></div>
              <div style={{ padding: '12px 18px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {recent!.declines.slice(0, 40).map((b, i) => (
                  <Link key={i} className={'kbadge ' + (b.declineCode === 'insufficient_funds' ? 'fail' : 'neutral')} to={b.cardLast4 ? `/diagnose?by=card&value=${b.cardLast4}` : `/diagnose?by=email&value=${encodeURIComponent(b.email)}`}
                    title={`${b.email}${b.declineCode ? ' · ' + (DECLINE_LABEL_D[b.declineCode] || b.declineCode) : ''} · ${fmt(b.at)}`}>
                    {b.cardLast4 ? '••••' + b.cardLast4 : b.email}{b.declineCode ? ' · ' + (DECLINE_LABEL_D[b.declineCode] || b.declineCode) : ''}
                  </Link>
                ))}
              </div>
            </section>
          )}
          <div className="section-gap" />
          <section className="card">
            <div className="eb-top"><span className="idx c-green">▥</span><h3>最近活动</h3><span className="head-hint">点任意行的 账号 / 卡 / 代理 / 环境 即下钻排查它的完整链路</span></div>
            <DataTable rows={recent?.usage || []} columns={USAGE_COLS} rowKey={(_r, i) => i} getRowClass={(r) => r.ok ? undefined : 'is-banned'} initialSort={{ key: 'at', dir: 'desc' }} maxHeight={460} fillViewport loading={recentLoading}
              emptyText="还没有任何运行记录(跑过批次后这里会显示最近活动,点行可下钻)。" exportName="diagnose-recent" columnSettings={{ tableId: 'diag-recent' }}
              search={{ keys: [(r) => r.email, (r) => r.stage, (r) => r.reason, (r) => r.host, (r) => r.cardLast4], placeholder: '搜索 账号 / 阶段 / 错误 / 卡 / 代理…' }}
              filters={[{ key: 'ok', label: '结果', accessor: (r) => r.ok ? 'ok' : 'fail', options: [{ value: 'ok', label: '成功' }, { value: 'fail', label: '失败' }] }, { key: 'engine', label: '引擎', accessor: (r) => r.engine || '—', options: [...new Set((recent?.usage || []).map((r) => r.engine || '—'))].map((s) => ({ value: s, label: s }))} ]} />
          </section>
        </>
      )}

      {value && (
        <>
          <div className="section-gap" />
          {/* 概要 */}
          <section className="card">
            <div className="eb-top"><span className="idx c-info">i</span><h3>{BY_LABEL[by]}:{value}</h3><span className="head-hint">{isLoading ? '查询中…' : `使用记录 ${data?.usage.length || 0} · 错误 ${data?.errors.length || 0} · 充值 ${data?.billing.length || 0}`}</span></div>
            <div style={{ padding: '14px 18px', display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {by === 'email' && acc && <>
                <span className={'kbadge ' + (acc.registered ? 'ok' : 'neutral')}>注册 {acc.registered ? '✓' : '—'}</span>
                <span className={'kbadge ' + (acc.apiKey ? 'ok' : 'neutral')}>Key {acc.apiKey ? '✓' : '—'}</span>
                <span className="kbadge neutral">账单 {String(acc.billingStatus || '—')}</span>
                {acc.cardLast4 ? <span className="kbadge info">卡 ••••{String(acc.cardLast4)}</span> : null}
                {acc.exitIp ? <span className="kbadge neutral">出口 {String(acc.exitIp)}</span> : null}
                {acc.blacklisted ? <span className="kbadge fail">⊘ 拉黑 {String(acc.blacklistReason || '')}</span> : <span className="kbadge ok">未拉黑</span>}
                {acc.lastStage ? <span className="kbadge warn">卡在 {String(acc.lastStage)} · {String(acc.lastReason || '')}</span> : null}
              </>}
              {by === 'email' && !acc && !isLoading && <span className="empty-note" style={{ padding: 0 }}>账号台账无此邮箱(可能只在结果文件里);下方仍可看使用/错误/充值记录。</span>}
              {data?.related && <>
                {data.related.cards.map((c) => <Link key={c} className="kbadge info" to={`/diagnose?by=card&value=${c}`}>卡 ••••{c}</Link>)}
                {data.related.proxies.map((p, i) => <Link key={i} className="kbadge neutral" to={`/diagnose?by=proxy&value=${p.proxyId || p.host || p.exitIp}`}>代理 {p.host || p.exitIp || p.proxyId}</Link>)}
                {data.related.envs.map((e) => <Link key={e} className="kbadge neutral" to={`/diagnose?by=env&value=${e}`}>环境 {e}</Link>)}
              </>}
              {by !== 'email' && (data?.emails?.length ? data.emails.slice(0, 30).map((em) => <Link key={em} className="kbadge neutral" to={`/diagnose?by=email&value=${encodeURIComponent(em)}`}>{em}</Link>) : (!isLoading && <span className="empty-note" style={{ padding: 0 }}>无关联账号记录。</span>))}
            </div>
          </section>

          <div className="section-gap" />
          <section className="card"><div className="eb-top"><span className="idx c-green">▥</span><h3>使用记录(链路时间线)</h3><span className="head-hint">每次跑用了什么资源、卡在哪步</span></div>
            <DataTable rows={data?.usage || []} columns={USAGE_COLS} rowKey={(_r, i) => i} getRowClass={(r) => r.ok ? undefined : 'is-banned'} initialSort={{ key: 'at', dir: 'desc' }} maxHeight={420} emptyText="无使用记录(该资源还没被跑过,或运行早于本功能上线)。" exportName="diagnose-usage" columnSettings={{ tableId: 'diag-usage' }} loading={isLoading} search={{ keys: [(r) => r.email, (r) => r.stage, (r) => r.reason, (r) => r.host], placeholder: '搜索 账号 / 阶段 / 错误…' }} filters={[{ key: 'ok', label: '结果', accessor: (r) => r.ok ? 'ok' : 'fail', options: [{ value: 'ok', label: '成功' }, { value: 'fail', label: '失败' }] }, { key: 'stage', label: '阶段', accessor: (r) => r.stage || '—', options: [...new Set((data?.usage || []).map((r) => r.stage || '—'))].map((s) => ({ value: s, label: s })) }]} />
          </section>

          {!!(data?.errors.length) && <><div className="section-gap" /><section className="card"><div className="eb-top"><span className="idx c-amber">⚑</span><h3>错误记录</h3></div><DataTable rows={data!.errors} columns={ERR_COLS} rowKey={(_r, i) => i} initialSort={{ key: 'at', dir: 'desc' }} maxHeight={360} exportName="diagnose-errors" /></section></>}
          {!!(data?.billing.length) && <><div className="section-gap" /><section className="card"><div className="eb-top"><span className="idx">$</span><h3>充值记录</h3></div><DataTable rows={data!.billing} columns={BILL_COLS} rowKey={(_r, i) => i} initialSort={{ key: 'at', dir: 'desc' }} maxHeight={300} exportName="diagnose-billing" /></section></>}
        </>
      )}
    </main>
  );
}
