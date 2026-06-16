// 下方监控面板:卡池 / 充值台账 / 账号状态(断点续跑) / 错误记录。
// 各自走真实 /api,用 react-query 缓存+刷新;SSE 事件由 ConsolePage 触发 invalidate。
// 卡池 / 账号状态用通用 DataTable(排序/筛选/列设置);台账 / 错误保持原样。
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api';
import { shortTime } from '../lib/parse';
import { Icon } from '../lib/icons';
import { useToast } from '../lib/toast';
import { downloadCsv } from '../lib/export';
import type { AccountsResp, CardRow, CardsResp, ErrorSummary, LedgerSummary } from '../lib/types';
import { DataTable, type Column, type FilterDef } from '../components/DataTable';
import { RowMenu } from '../components/RowMenu';
import { batchRun } from '../lib/batch';

const CARD_STATUS: Record<string, string> = { active: '可用', exhausted: '用尽', declined: '被拒', disabled: '已禁用', dispatched: '已下发' };
const ERR_ACTION: Record<string, string> = { retry: '同代理重试', 'retry-new-proxy': '换代理重试', relogin: '重新登录', blacklist: '拉黑', abort: '放弃' };

// 卡池页独立于具体运行,按最小充值额 $5 估算「这张卡还能真充几次」(与 card-pool.js cardChargeRemaining 同口径)。
const CHARGE_AMOUNT_EST = 5;
function cardTracked(c: CardRow): boolean { return (c.chargeCap || 0) > 0 || (c.balance || 0) > 0; }
function chargeRemaining(c: CardRow): number {
  const cap = c.chargeCap || 0;
  if (cap > 0) return Math.max(0, cap - (c.chargedTotal || 0));          // 次数模式:cap - 已充
  const bal = c.balance || 0;
  if (bal > 0) return Math.floor(bal / CHARGE_AMOUNT_EST);               // 金额模式:floor(余额/充值额)(余额已在 commit 扣减)
  return Number.POSITIVE_INFINITY;                                       // 未跟踪=不限
}

function SubHead({ children }: { children: React.ReactNode }) { return <div className="sub-head">{children}</div>; }

// 受控数字编辑格(M-frontend-stale-input 修):无本地编辑时显示【服务端最新值】(后台 SSE/跨标签刷新即时跟随);
// 编辑中显示本地输入;失焦提交后清本地 → 重新跟随服务端。修复 defaultValue 只在挂载读一次 → 刷新后误把【陈旧显示值】
// 在失焦时回写覆盖掉别处刚改的新值(跨标签/多机编辑同卡时的数据丢失)。
function NumCell({ value, min, max, step, float, title, onCommit }: {
  value: number; min: number; max: number; step?: number; float?: boolean; title?: string; onCommit: (v: number) => void;
}) {
  const [local, setLocal] = useState<string | null>(null);
  const shown = local === null ? String(value ?? 0) : local;
  const commit = () => {
    if (local === null) return;                                   // 没动过 → 不提交(避免无编辑失焦回写陈旧值)
    let v = float ? (Number(local) || 0) : (Math.floor(Number(local)) || 0);
    v = Math.max(min, Math.min(max, v));
    setLocal(null);                                               // 提交即清本地 → 重新跟随服务端最新值
    if (v !== (value || 0)) onCommit(v);
  };
  return <input className="cell-num" type="number" min={min} max={max} step={step} value={shown} title={title}
    onChange={(e) => setLocal(e.target.value)} onBlur={commit} />;
}

/* ---------------- 卡池 ---------------- */
export function PoolTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['cards'], queryFn: () => apiGet<CardsResp>('/api/cards', true) });
  const cards = data?.cards || [];
  const avail = data?.available ?? cards.filter((c) => c.status === 'active').length;
  const act = async (action: string, body?: unknown) => {
    try { await apiPost(`/api/cards/${action}`, body); qc.invalidateQueries({ queryKey: ['cards'] }); }
    catch (e) { toast.push(`操作失败:${(e as Error).message}`, 'err'); }
  };
  const statusBadge = (c: CardRow) => c.status === 'active' ? <span className="kbadge ok">可用</span> : c.status === 'exhausted' ? <span className="kbadge fail">已用尽</span> : <span className="kbadge neutral">{CARD_STATUS[c.status] || c.status}</span>;

  const columns: Column<CardRow>[] = [
    { key: 'masked', label: '卡号(末4)', className: 'mono', sortAccessor: (c) => c.masked, render: (c) => c.masked },
    { key: 'exp', label: '有效期', className: 'mono', render: (c) => c.exp },
    { key: 'status', label: '状态', sortAccessor: (c) => c.status, exportValue: (c) => CARD_STATUS[c.status] || c.status, render: statusBadge },
    { key: 'maxUses', label: '可用次数', sortAccessor: (c) => c.maxUses, render: (c) => (
      <NumCell value={c.maxUses} min={1} max={100} onCommit={(v) => act('update', { id: c.id, maxUses: v })} />
    ) },
    // 充值容量账本:充值次数 / 金额(填哪个用哪个,次数优先)/ 同卡并发上限。改了即重置「已充」(新预算可重新充满)。
    { key: 'chargeCap', label: '充值次数', sortAccessor: (c) => c.chargeCap || 0, render: (c) => (
      <NumCell value={c.chargeCap || 0} min={0} max={9999} title="这张卡能真充几次;0=不按次数。与「金额」二选一,填了次数优先" onCommit={(v) => act('set-charge', { id: c.id, chargeCap: v })} />
    ) },
    { key: 'balance', label: '金额$', sortAccessor: (c) => c.balance || 0, render: (c) => (
      <NumCell value={c.balance || 0} min={0} max={99999} step={0.01} float title="卡上真实有多少钱;系统按 floor(金额/充值额) 算能充几次。0=不按金额" onCommit={(v) => act('set-charge', { id: c.id, balance: v })} />
    ) },
    { key: 'chargeConcurrency', label: '同卡并发', sortAccessor: (c) => c.chargeConcurrency || 0, defaultHidden: true, render: (c) => (
      <NumCell value={c.chargeConcurrency || 0} min={0} max={99} title="同一时间最多几个号在这张卡上充值;0=不限" onCommit={(v) => act('set-charge', { id: c.id, chargeConcurrency: v })} />
    ) },
    { key: 'chargedTotal', label: '已充', className: 'mono', align: 'right', defaultHidden: true, sortAccessor: (c) => c.chargedTotal || 0, render: (c) => <span title={`已真充 ${c.chargedTotal || 0} 次 · 在飞预留 ${c.chargeInflight || 0}`}>{c.chargedTotal || 0}{(c.chargeInflight || 0) > 0 ? ` (+${c.chargeInflight})` : ''}</span> },
    // 充值余量:这张卡【还能真充几次】(按 $5 估)。用尽=充值步会返「钱不够」END 不真扣 → 红徽提示该补容量/换卡。
    { key: 'chargeRemaining', label: '充值余量', className: 'mono', align: 'right', sortAccessor: (c) => { const r = chargeRemaining(c); return r === Infinity ? 1e9 : r; }, render: (c) => {
      if (!cardTracked(c)) return <span style={{ color: 'var(--text-4)' }} title="未设充值次数/金额=不跟踪不限(默认旧行为)">不限</span>;
      const rem = chargeRemaining(c); const infl = c.chargeInflight || 0;
      if (rem <= 0) return <span className="kbadge fail" title="充值容量已用尽:充值步会返回「钱不够」END,不会真扣。请补「充值次数/金额」或换卡">充值用尽</span>;
      const avail = rem - infl;
      return <span title={`还能真充 ${rem} 次${infl ? `,其中 ${infl} 个在飞预留(可立即用 ${Math.max(0, avail)})` : ''}${(c.chargeCap || 0) > 0 ? `(次数 ${c.chargeCap}−已充 ${c.chargedTotal || 0})` : `(余额 $${c.balance} ÷ $${CHARGE_AMOUNT_EST})`}`}
        style={{ color: avail <= 0 ? 'var(--warn)' : undefined, fontWeight: 600 }}>{rem}{infl ? ` (−${infl})` : ''}</span>;
    } },
    { key: 'usedCount', label: '已用', className: 'mono', align: 'right', sortAccessor: (c) => c.usedCount, render: (c) => c.usedCount },
    { key: 'remaining', label: '剩余', className: 'mono', align: 'right', sortAccessor: (c) => c.remaining, render: (c) => <b>{c.remaining}</b> },
    { key: 'successCount', label: '成功', className: 'mono', align: 'right', sortAccessor: (c) => c.successCount, cellStyle: { color: 'var(--success)' }, render: (c) => c.successCount },
    { key: 'declineCount', label: '被拒', className: 'mono', align: 'right', sortAccessor: (c) => c.declineCount, cellStyle: { color: 'var(--danger)' }, render: (c) => c.declineCount },
    { key: 'lastUsedAt', label: '最近用', className: 'mono', cellStyle: { color: 'var(--text-3)' }, sortAccessor: (c) => c.lastUsedAt || '', render: (c) => shortTime(c.lastUsedAt) },
    { key: 'lastError', label: '最近错误', className: 'mono', defaultHidden: true, render: (c) => <span title={c.lastError || ''} style={{ color: c.lastError ? 'var(--danger)' : 'var(--text-4)' }}>{c.lastError ? String(c.lastError).slice(0, 22) : '—'}</span> },
    { key: 'actions', label: '操作', align: 'right', alwaysVisible: true, render: (c) => (
      <RowMenu
        inline={<Link className="btn btn-ghost btn-sm" to={`/diagnose?by=card&value=${c.last4}`} title="诊断这张卡的使用记录">🔍</Link>}
        actions={[
          { label: (c.status === 'disabled' || c.status === 'dispatched') ? '启用' : '禁用', icon: (c.status === 'disabled' || c.status === 'dispatched') ? 'play' : 'pause', onClick: () => act((c.status === 'disabled' || c.status === 'dispatched') ? 'enable' : 'disable', { id: c.id }) },
          { label: '重置', icon: 'refresh', onClick: () => act('reset', { id: c.id }) },
          { label: '删除', icon: 'trash', danger: true, onClick: () => { if (confirm('从卡池删除这张卡?')) act('remove', { id: c.id }); } },
        ]}
      />
    ) },
  ];
  const filters: FilterDef<CardRow>[] = [{ key: 'status', label: '状态', accessor: (c) => c.status, options: Object.entries(CARD_STATUS).map(([value, label]) => ({ value, label })) }];

  return (
    <DataTable
      rows={cards}
      columns={columns}
      rowKey={(c) => c.id}
      getRowClass={(c) => (c.status === 'disabled' || c.status === 'declined') ? 'is-banned' : (c.status === 'exhausted' || c.status === 'dispatched') ? 'is-used' : undefined}
      search={{ keys: [(c) => c.masked, (c) => c.lastError || ''], placeholder: '搜索 末4 / 错误…' }}
      filters={filters}
      columnSettings={{ tableId: 'cards' }}
      exportName="cards"
      maxHeight={460}
      selectable
      batchActions={(sel, clear) => (<>
        <button className="btn btn-ghost btn-sm" onClick={() => { sel.forEach((c) => act('enable', { id: c.id })); clear(); }}>启用</button>
        <button className="btn btn-ghost btn-sm" onClick={() => { sel.forEach((c) => act('disable', { id: c.id })); clear(); }}>禁用</button>
        <button className="btn btn-ghost btn-sm" onClick={() => { sel.forEach((c) => act('reset', { id: c.id })); clear(); }}>重置</button>
        <button className="btn btn-danger-soft btn-sm" onClick={() => { if (confirm(`从卡池删除选中的 ${sel.length} 张卡?`)) { sel.forEach((c) => act('remove', { id: c.id })); clear(); } }}>删除</button>
      </>)}
      emptyText="尚无卡片,去上方「卡池」粘贴或上传后点「导入卡池」。"
      toolbarLeft={<>
        <button className="btn btn-ghost btn-sm" onClick={() => qc.invalidateQueries({ queryKey: ['cards'] })}><Icon name="refresh" size={12} />刷新</button>
        <button className="btn btn-danger-soft btn-sm" onClick={() => { if (confirm('清空整个卡池?')) act('clear'); }}><Icon name="trash" size={12} />清空卡池</button>
      </>}
      toolbarRight={<span className="cnt-pill">共 <b style={{ color: 'var(--text)' }}>{cards.length}</b> · 可用 <b style={{ color: 'var(--success)' }}>{avail}</b></span>}
    />
  );
}

/* ---------------- 充值台账 ---------------- */
const BILL: Record<string, JSX.Element> = {
  success: <span className="kbadge ok">✓ 成功</span>, declined: <span className="kbadge fail">✕ 被拒</span>,
  'card-bound': <span className="kbadge info">✓ 加卡</span>, 'address-bound': <span className="kbadge info">✓ 地址</span>,
  'no-card': <span className="kbadge neutral">无卡</span>, 'no-address': <span className="kbadge neutral">无地址</span>,
  'page-closed': <span className="kbadge fail">页面关闭</span>,
};
export function LedgerTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['billing'], queryFn: () => apiGet<LedgerSummary>('/api/billing', true) });
  const entries = data?.entries || [];
  return (
    <>
      <SubHead>
        <button className="btn btn-ghost btn-sm" onClick={() => qc.invalidateQueries({ queryKey: ['billing'] })}><Icon name="refresh" size={12} />刷新</button>
        <span className="cnt-pill">按邮箱记账,不做重复扣账</span>
        <div className="right">
          <span className="kbadge info">总充值 ${data?.totalCharged || 0}</span>
          <span className="kbadge ok">成功 {data?.success || 0}</span>
          <span className="kbadge fail">被拒 {data?.declined || 0}</span>
          {/* 诚实标注:KPI(总充值/成功/被拒)按【全量】算,但下方明细只列最近 N 条 → 别让用户以为只有这么多笔 */}
          <span className="cnt-pill">{data?.truncated ? <>最近 <b>{data?.returned}</b> / 共 <b>{data?.total}</b> 笔</> : <>共 <b>{data?.total || 0}</b> 笔</>}</span>
          <button className="btn btn-ghost btn-sm" disabled={!entries.length} onClick={() => downloadCsv('billing', ['时间', '邮箱', '卡末4', '金额', '结果', '错误'], entries.map((e) => [shortTime(e.at), e.email, e.cardLast4 || '', e.charged || '', e.result, e.error || '']))}><Icon name="download" size={12} />导出</button>
          <button className="btn btn-danger-soft btn-sm" onClick={async () => { if (!confirm('清空充值台账?')) return; await apiPost('/api/billing/clear'); qc.invalidateQueries({ queryKey: ['billing'] }); toast.push('台账已清空', 'ok'); }}><Icon name="trash" size={12} />清空台账</button>
        </div>
      </SubHead>
      {!entries.length ? <div className="empty-note">暂无充值记录。</div> : (
        <div className="tbl-wrap" style={{ maxHeight: 460 }}>
          <table className="tbl">
            <thead><tr><th>时间</th><th>邮箱</th><th>卡</th><th>金额</th><th>结果</th><th>错误</th></tr></thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={i} className={e.result === 'declined' ? 'is-banned' : ''}>
                  <td className="mono" style={{ color: 'var(--text-3)' }}>{shortTime(e.at)}</td>
                  <td className="mono">{e.email}</td>
                  <td className="mono">{e.cardLast4 ? '•••• ' + e.cardLast4 : '—'}</td>
                  <td className="mono">{e.charged ? '$' + e.charged : '—'}</td>
                  <td>{BILL[e.result] || e.result}</td>
                  <td className="mono" style={{ color: e.error ? 'var(--danger)' : 'var(--text-4)' }} title={e.error || ''}>{e.error ? String(e.error).slice(0, 24) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/* ---------------- 账号状态 ---------------- */
type AcctRow = AccountsResp['accounts'][number];
const yn = (v?: boolean) => v ? <span style={{ color: 'var(--success)', fontWeight: 700 }}>✓</span> : <span className="mini-x">—</span>;
export function StatusTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['accounts'], queryFn: () => apiGet<AccountsResp>('/api/accounts', true) });
  const accts = data?.accounts || [];
  const reset = async (a: AcctRow) => { if (!confirm(`重置账号 ${a.email}?下次将从头跑(解黑/清进度)。`)) return; await apiPost('/api/accounts/reset', { email: a.email }); qc.invalidateQueries({ queryKey: ['accounts'] }); };

  const columns: Column<AcctRow>[] = [
    { key: 'email', label: '邮箱', className: 'mono', sortAccessor: (a) => a.email, render: (a) => a.email },
    { key: 'registered', label: '注册', exportValue: (a) => a.registered ? '是' : '否', render: (a) => yn(a.registered) },
    { key: 'apiKey', label: 'Key', exportValue: (a) => a.apiKey ? '有' : '无', render: (a) => a.apiKey ? <span style={{ color: 'var(--success)', fontWeight: 700 }}>✓</span> : <span className="mini-x">—</span> },
    { key: 'billingStatus', label: '账单', className: 'mono', cellStyle: { color: 'var(--text-2)' }, render: (a) => a.billingStatus || '—' },
    { key: 'charged', label: '充值', className: 'mono', align: 'right', sortAccessor: (a) => a.charged || 0, exportValue: (a) => a.charged ? '$' + a.charged + (a.balanceAfter != null ? ` (余$${a.balanceAfter})` : '') : '', render: (a) => a.charged ? <span style={{ color: 'var(--success)', fontWeight: 600 }} title={a.balanceAfter != null ? `充值后真实余额 $${a.balanceAfter}` : '充值额'}>${a.charged}{a.balanceAfter != null ? <span className="dim" style={{ fontWeight: 400 }}>&nbsp;→余${a.balanceAfter}</span> : null}</span> : <span className="mini-x">—</span> },
    { key: 'cardLast4', label: '卡', exportValue: (a) => a.cardLast4 || '', render: (a) => a.cardLast4 ? <span className="mono">•••• {a.cardLast4}</span> : <span className="mini-x">—</span> },
    { key: 'passwordChanged', label: '改密', exportValue: (a) => a.passwordChanged ? '是' : '否', render: (a) => yn(a.passwordChanged) },
    { key: 'exitIp', label: '出口 IP', className: 'mono', cellStyle: { color: 'var(--text-2)' }, defaultHidden: true, render: (a) => a.exitIp || '—' },
    { key: 'status', label: '状态', sortAccessor: (a) => a.blacklisted ? 1 : 0, exportValue: (a) => a.blacklisted ? '拉黑' : '正常', render: (a) => a.blacklisted ? <span className="kbadge fail">⊘ 拉黑</span> : <span className="kbadge ok">正常</span> },
    { key: 'updatedAt', label: '更新', className: 'mono', cellStyle: { color: 'var(--text-3)' }, sortAccessor: (a) => a.updatedAt || '', render: (a) => shortTime(a.updatedAt) },
    { key: 'actions', label: '操作', align: 'right', alwaysVisible: true, render: (a) => (
      <div className="row-actions">
        <Link className="btn btn-ghost btn-sm" to={`/diagnose?by=email&value=${encodeURIComponent(a.email)}`} title="诊断这个账号">🔍</Link>
        <button className={'btn btn-sm ' + (a.blacklisted ? 'btn-danger-soft' : 'btn-ghost')} onClick={() => reset(a)}>{a.blacklisted ? '解黑' : '重置'}</button>
      </div>
    ) },
  ];
  const filters: FilterDef<AcctRow>[] = [{ key: 'status', label: '状态', accessor: (a) => a.blacklisted ? 'banned' : 'ok', options: [{ value: 'ok', label: '正常' }, { value: 'banned', label: '拉黑' }] }];

  return (
    <>
      <SubHead>
        <button className="btn btn-ghost btn-sm" onClick={() => qc.invalidateQueries({ queryKey: ['accounts'] })}><Icon name="refresh" size={12} />刷新</button>
        <button className="btn btn-danger-soft btn-sm" onClick={async () => { if (!confirm('清空全部账号状态?清空后重跑将从头执行。')) return; await apiPost('/api/accounts/clear'); qc.invalidateQueries({ queryKey: ['accounts'] }); }}><Icon name="trash" size={12} />清空</button>
        <span className="cnt-pill">本节点 · 共 <b style={{ color: 'var(--text)' }}>{accts.length}</b> 个账号</span>
      </SubHead>
      <p className="help" style={{ margin: '-2px 0 12px' }}>记录每个账号跑到哪一步。重跑会自动跳过已完成阶段(已注册→直接登录、已有 Key→复用、账单达标→不复扣、已改密→跳过)。「重置」让某账号下次从头跑,「解黑」解除拉黑。</p>
      {data?.summary && data.summary.total > 0 && (
        <div className="stage-funnel" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '0 0 12px' }}>
          {([['注册', 'registered'], ['取Key', 'key'], ['绑地址', 'address'], ['加卡', 'card'], ['充值', 'charge'], ['改密', 'changepw']] as const).map(([label, k]) => {
            const v = data.summary![k]; const t = data.summary!.total || 1; const pct = Math.round(100 * v / t);
            return (
              <span key={k} className="cnt-pill" title={`${v} / ${t}(${pct}%)`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {label} <b style={{ color: 'var(--text)' }}>{v}</b><span style={{ color: 'var(--text-3)' }}>/{t}</span>
                <span style={{ display: 'inline-block', width: 40, height: 4, background: 'var(--surface-3)', borderRadius: 2, overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: 'var(--success)', borderRadius: 2 }} />
                </span>
              </span>
            );
          })}
          {data.summary.blacklisted > 0 && <span className="cnt-pill" style={{ color: 'var(--danger)' }} title="拉黑账号数">⊘ 拉黑 <b>{data.summary.blacklisted}</b></span>}
        </div>
      )}
      <DataTable
        rows={accts}
        columns={columns}
        rowKey={(a) => a.email}
        getRowClass={(a) => a.blacklisted ? 'is-banned' : undefined}
        search={{ keys: [(a) => a.email, (a) => a.billingStatus || '', (a) => a.cardLast4 || ''], placeholder: '搜索 邮箱 / 账单 / 卡末4…' }}
        filters={filters}
        columnSettings={{ tableId: 'accounts' }}
        exportName="accounts"
        maxHeight={520}
        selectable
        batchActions={(sel, clear) => (
          <button className="btn btn-danger-soft btn-sm" onClick={() => { if (!confirm(`重置选中的 ${sel.length} 个账号?将从头跑(解黑/清进度)。`)) return; batchRun(sel, (a) => apiPost('/api/accounts/reset', { email: a.email }), { toast, verb: '重置', onDone: () => { qc.invalidateQueries({ queryKey: ['accounts'] }); clear(); } }); }}>批量重置 / 解黑</button>
        )}
        emptyText="暂无账号状态。运行后自动记录。"
      />
    </>
  );
}

/* ---------------- 错误记录 ---------------- */
export function ErrorsTab({ onOpenPolicy }: { onOpenPolicy: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['errors'], queryFn: () => apiGet<ErrorSummary>('/api/errors', true) });
  const entries = data?.entries || [];
  const chips = [
    ...Object.entries(data?.byAction || {}).map(([k, v]) => <span key={'a' + k} className="err-chip act">{ERR_ACTION[k] || k} <b>{v}</b></span>),
    ...Object.entries(data?.byReason || {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => <span key={'r' + k} className="err-chip code">{k} <b>{v}</b></span>),
  ];
  return (
    <>
      <SubHead>
        <button className="btn btn-ghost btn-sm" onClick={() => qc.invalidateQueries({ queryKey: ['errors'] })}><Icon name="refresh" size={12} />刷新</button>
        <button className="btn btn-ghost btn-sm" disabled={!entries.length} onClick={() => downloadCsv('errors', ['时间', '邮箱', '阶段', '错误', '动作', '第几次'], entries.map((e) => [shortTime(e.at), e.email || '', e.stage || '', e.reason, ERR_ACTION[e.action || ''] || e.action || '', e.attempt ?? '']))}><Icon name="download" size={12} />导出</button>
        <button className="btn btn-danger-soft btn-sm" onClick={async () => { if (!confirm('清空全部错误记录?')) return; await apiPost('/api/errors/clear'); qc.invalidateQueries({ queryKey: ['errors'] }); toast.push('错误记录已清空', 'ok'); }}><Icon name="trash" size={12} />清空</button>
        <span className="cnt-pill">本节点 · {data?.truncated ? <>最近 <b style={{ color: 'var(--text)' }}>{data?.returned}</b> / 共 <b style={{ color: 'var(--text)' }}>{data?.total}</b></> : <>共 <b style={{ color: 'var(--text)' }}>{data?.total || 0}</b></>} 条</span>
      </SubHead>
      <p className="help" style={{ margin: '-2px 0 10px' }}>每次阶段失败都会记一条(含被路由成什么动作)。错误的「说明 / 策略配置」在 <button className="link-inline" onClick={onOpenPolicy}>📖 错误策略 / 说明</button> 里改。</p>
      {chips.length > 0 && <div className="err-summary">{chips}</div>}
      {!entries.length ? <div className="empty-note">暂无错误记录。</div> : (
        <div className="tbl-wrap" style={{ maxHeight: 420 }}>
          <table className="tbl">
            <thead><tr><th>时间</th><th>邮箱</th><th>阶段</th><th>错误</th><th>动作</th><th>第几次</th></tr></thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={i}>
                  <td className="mono" style={{ color: 'var(--text-3)' }}>{shortTime(e.at)}</td>
                  <td className="mono">{e.email || '—'}</td>
                  <td className="mono" style={{ color: 'var(--text-2)' }}>{e.stage || '—'}</td>
                  <td className="mono" style={{ color: 'var(--danger)' }}>{e.reason}</td>
                  <td><span className={'kbadge ' + (e.action === 'blacklist' ? 'fail' : 'warn')}>{ERR_ACTION[e.action || ''] || e.action || '—'}</span></td>
                  <td className="mono">{e.attempt != null ? e.attempt : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
