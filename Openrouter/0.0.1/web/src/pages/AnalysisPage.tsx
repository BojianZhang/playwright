// 失败分析(只读):漏斗 + 环节失败排名 + 智能分类(外部不可控/可优化)+ IP战绩 + 卡战绩 + 错误分布 + 趋势。
// 数据全来自 /api/analytics(后端 failure-analytics 现算);顶部可按引擎 / 最近N天筛选。
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { useToast } from '../lib/toast';
import { Icon } from '../lib/icons';
import type { AnalyticsResp, AnalyticsProxyRow, AnalyticsCardRow, ProxyRow, CardsResp } from '../lib/types';
import { Donut, AreaLine, Bars, DrillableChart, type Seg, type DrillCol } from '../components/charts';
import { DataTable, type Column } from '../components/DataTable';

// 下钻面板的通用行/列(项 · 次数 · 占比)。这些图来自后端预聚合计数,无逐账号明细,
// 故下钻展示的是该图「完整排名细分」(图上只画前几根,面板给全量 + 占比)。
type DrillRow = { label: string; value: number; pct: number };
const DRILL_COLS: DrillCol<DrillRow>[] = [
  { label: '项', className: 'mono', render: (r) => r.label },
  { label: '次数', align: 'right', className: 'mono', render: (r) => r.value },
  { label: '占比', align: 'right', className: 'mono', render: (r) => r.pct + '%' },
];
const toDrillRows = (items: { label: string; value: number }[]): DrillRow[] => {
  const total = items.reduce((s, b) => s + b.value, 0) || 1;
  return items.map((b) => ({ label: b.label, value: b.value, pct: Math.round((b.value / total) * 100) }));
};

const ENGINES = [['all', '全部引擎'], ['playwright', 'Playwright'], ['selenium', 'Selenium'], ['hybrid', '混合'], ['split', '分流']] as const;
const DAYS = [[0, '全部'], [7, '最近7天'], [30, '最近30天']] as const;
const CAT_COLOR: Record<string, string> = { radar: '--danger', cardenv: '--warn', hcaptcha: '--warn', banned: '--text-3', infra: '--info', auth: '--primary', detect: '--primary-text', other: '--text-4' };
const STAGE_COLOR: Record<string, string> = { A: '--info', B: '--text-3', C: '--primary', D: '--danger', E: '--warn', Z: '--text-4' };
const CARD_COLOR: Record<string, string> = { 'card-bound': '--success', 'server-error': '--danger', declined: '--warn', hcaptcha: '--primary-text', unknown: '--info', 'card-502': '--warn', 'fill-fail': '--text-3', '(未到加卡)': '--text-4' };

const PROXY_COLS: Column<AnalyticsProxyRow>[] = [
  { key: 'host', label: '出口 IP', className: 'mono' },
  { key: 'attempts', label: '加卡尝试', align: 'right', className: 'mono', sortAccessor: (r) => r.attempts },
  { key: 'bound', label: '绑成', align: 'right', className: 'mono', sortAccessor: (r) => r.bound },
  { key: 'boundPct', label: '绑成率', align: 'right', className: 'mono', sortAccessor: (r) => r.boundPct, render: (r) => <span style={{ color: r.boundPct >= 50 ? 'var(--success)' : r.boundPct >= 30 ? 'var(--warn)' : 'var(--danger)' }}>{r.boundPct}%</span> },
  { key: 'serverError', label: 'server-error', align: 'right', className: 'mono', sortAccessor: (r) => r.serverError, render: (r) => r.serverError || '—' },
  { key: 'declined', label: 'declined', align: 'right', className: 'mono', sortAccessor: (r) => r.declined, render: (r) => r.declined || '—' },
];
const CARD_COLS: Column<AnalyticsCardRow>[] = [
  { key: 'last4', label: '卡末4', className: 'mono', render: (r) => '••••' + r.last4 },
  { key: 'attempts', label: '尝试', align: 'right', className: 'mono', sortAccessor: (r) => r.attempts },
  { key: 'bound', label: '绑成', align: 'right', className: 'mono', sortAccessor: (r) => r.bound },
  { key: 'boundPct', label: '绑成率', align: 'right', className: 'mono', sortAccessor: (r) => r.boundPct, render: (r) => <span style={{ color: r.boundPct >= 50 ? 'var(--success)' : 'var(--warn)' }}>{r.boundPct}%</span> },
  { key: 'declined', label: 'declined', align: 'right', className: 'mono', sortAccessor: (r) => r.declined, render: (r) => r.declined || '—' },
];

export default function AnalysisPage() {
  const [engine, setEngine] = useState('all');
  const [days, setDays] = useState(7);   // 默认近 7 天(原 0=全史:首屏就全量扫 results.jsonl,大文件慢);要全史用筛选切到「全部」
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['analytics', engine, days],
    queryFn: () => apiGet<AnalyticsResp>(`/api/analytics?engine=${engine}&days=${days}`, true),
    staleTime: 60_000,
    refetchInterval: 60_000, // 只读分析,自动刷新放宽到 60s(后端已加 mtime 缓存,文件没变近乎零成本);手动「刷新」仍可用
  });

  // 一键禁用差 IP / 差卡:前端把 战绩行(host / 末4)映射回已保存的代理池/卡池 id,复用现有禁用接口。
  const qc = useQueryClient();
  const toast = useToast();
  const { data: proxies } = useQuery({ queryKey: ['proxies'], queryFn: () => apiGet<{ items: ProxyRow[] }>('/api/proxies', true), staleTime: 30_000 });
  const { data: cards } = useQuery({ queryKey: ['cards'], queryFn: () => apiGet<CardsResp>('/api/cards', true), staleTime: 30_000 });
  const proxyIdsForHost = (host: string) => (proxies?.items || []).filter((p) => p.host === host && p.status === 'active').map((p) => p.id);
  const cardIdsForLast4 = (last4: string) => (cards?.cards || []).filter((c) => c.last4 === last4 && c.status !== 'disabled').map((c) => c.id);  // 含 exhausted(用满)→ 也可禁
  async function disableProxy(host: string) {
    const ids = proxyIdsForHost(host);
    if (!ids.length) { toast.push('该 IP 不在已保存的代理池里(粘贴的代理不能在此禁用)', 'err'); return; }
    if (!window.confirm(`禁用出口 IP ${host} 的 ${ids.length} 个代理?之后运行不再用它。`)) return;
    // allSettled:逐个失败不中断其余;无论成败都 invalidate+refetch,避免部分禁用后战绩表停留旧态。
    const rs = await Promise.allSettled(ids.map((id) => apiPost('/api/proxies/update', { id, patch: { status: 'disabled' } })));
    const ok = rs.filter((r) => r.status === 'fulfilled').length;
    toast.push(ok === ids.length ? `已禁用 ${ok} 个代理(${host})` : `禁用 ${ok}/${ids.length} 个代理(${ids.length - ok} 个失败)`, ok ? 'ok' : 'err');
    qc.invalidateQueries({ queryKey: ['proxies'] }); refetch();
  }
  async function disableCard(last4: string) {
    const ids = cardIdsForLast4(last4);
    if (!ids.length) { toast.push('该卡不在卡池(或已禁用)', 'err'); return; }
    if (!window.confirm(`禁用卡 ••••${last4} 的 ${ids.length} 张?之后加卡不再用它。`)) return;
    const rs = await Promise.allSettled(ids.map((id) => apiPost('/api/cards/disable', { id })));
    const ok = rs.filter((r) => r.status === 'fulfilled').length;
    toast.push(ok === ids.length ? `已禁用 ${ok} 张卡(••••${last4})` : `禁用 ${ok}/${ids.length} 张卡(${ids.length - ok} 张失败)`, ok ? 'ok' : 'err');
    qc.invalidateQueries({ queryKey: ['cards'] }); refetch();
  }
  const proxyActCol: Column<AnalyticsProxyRow> = { key: 'act', label: '操作', render: (r) => proxyIdsForHost(r.host).length ? <button className="btn btn-ghost btn-sm" onClick={() => disableProxy(r.host)} title="把该出口 IP 的代理设为禁用,后续不再用">禁用此IP</button> : <span style={{ color: 'var(--text-4)', fontSize: 11 }}>不在池/已禁</span> };
  const cardActCol: Column<AnalyticsCardRow> = { key: 'act', label: '操作', render: (r) => { const n = cardIdsForLast4(r.last4).length; return n ? <button className="btn btn-ghost btn-sm" onClick={() => disableCard(r.last4)} title="把该卡设为禁用,后续加卡不再用">禁用此卡{n > 1 ? `(${n})` : ''}</button> : <span style={{ color: 'var(--text-4)', fontSize: 11 }}>不在池/已禁</span>; } };

  const cardSegs: Seg[] = (() => {
    const m = new Map<string, number>();
    for (const e of data?.engines || []) for (const s of e.cardStates || []) if (s.label !== '(未到加卡)') m.set(s.label, (m.get(s.label) || 0) + s.value);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value, colorVar: CARD_COLOR[label] || '--text-4' }));
  })();
  const stageSegs: Seg[] = (data?.blameByStage || []).map((b) => ({ label: b.label.replace(/^[A-Z]\./, ''), value: b.value, colorVar: STAGE_COLOR[b.label[0]] || '--text-4' }));
  const reasonSegs: Seg[] = (data?.errorLog?.byReason || []).slice(0, 8).map((b, i) => ({ label: b.label, value: b.value, colorVar: ['--danger', '--warn', '--info', '--primary', '--primary-text', '--success', '--text-3', '--text-4'][i % 8] }));

  return (
    <main className="page">
      <div className="page-head">
        <h1>失败分析</h1>
        <p>跨真实运行数据聚合「哪个环节经常报错、为什么、能不能优化」。漏斗 + 环节排名 + 智能分类 + IP/卡战绩 + 趋势。<b>只读</b>,不改数据。</p>
      </div>

      {/* 筛选条 */}
      <section className="card card-pad">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="dt-filter" value={engine} onChange={(e) => setEngine(e.target.value)}>{ENGINES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <select className="dt-filter" value={days} onChange={(e) => setDays(Number(e.target.value))}>{DAYS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <button className="btn btn-ghost btn-sm" onClick={() => refetch()}><Icon name="refresh" size={14} />{isFetching ? '刷新中…' : '刷新'}</button>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-3)' }}>{data ? `共 ${data.combined.total} 号 · 成功率 ${data.combined.okRate}%` : ''}</span>
        </div>
      </section>

      {isError && <div className="card card-pad" style={{ marginTop: 16 }}><div className="empty-note" style={{ borderColor: 'var(--danger-bd)', background: 'var(--danger-weak)' }}><b style={{ color: 'var(--danger)' }}>加载失败</b> —— 后端缺少 <code>/api/analytics</code>,多半是 <code>node server.js</code> 还是旧进程,请重启后端再刷新。</div></div>}
      {!isError && !data && <div className="card card-pad" style={{ marginTop: 16 }}><div className="empty-note">{isLoading ? '分析中…' : '无数据'}</div></div>}

      {data && (
        <>
          {/* 漏斗(各引擎) */}
          <div className="section-gap" />
          <section className="card">
            <div className="eb-top"><span className="idx c-info">▣</span><h3>转化漏斗</h3><span className="head-hint">注册 → 取Key → 进加卡 → 绑成;看账号死在哪一级</span></div>
            <div style={{ padding: '12px 18px', display: 'flex', flexWrap: 'wrap', gap: 16 }}>
              {!data.engines.length && <span className="empty-note" style={{ padding: 0 }}>该引擎无 Python 结果数据(Playwright 看下方错误/趋势)。</span>}
              {data.engines.map((e) => (
                <div key={e.engine} style={{ flex: '1 1 280px', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: '12px 14px' }}>
                  <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8 }}><b style={{ color: 'var(--text)' }}>{e.engine}</b> · {e.total} 号 · 成功率 <b style={{ color: e.okRate >= 50 ? 'var(--success)' : 'var(--warn)' }}>{e.okRate}%</b></div>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
                    {[['取Key', e.funnel.keyPct], ['进加卡', e.funnel.cardPct], ['绑成', e.funnel.boundPct]].map(([lb, p]) => (
                      <div key={lb as string} style={{ flex: 1, textAlign: 'center' }}>
                        <div style={{ height: 70, display: 'flex', alignItems: 'flex-end' }}><div style={{ width: '100%', height: `${Math.max(4, p as number)}%`, background: lb === '绑成' ? 'var(--success)' : 'var(--primary)', borderRadius: '4px 4px 0 0' }} /></div>
                        <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--mono)' }}>{p as number}%</div>
                        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{lb as string}</div>
                      </div>
                    ))}
                  </div>
                  {e.funnel.diedAtCard > 0 && <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 8 }}>⚠ {e.funnel.diedAtCard} 号走到加卡却没绑成(死在加卡这一步)</div>}
                </div>
              ))}
            </div>
          </section>

          {/* 智能分类 + 建议 */}
          <div className="section-gap" />
          <section className="card">
            <div className="eb-top"><span className="idx c-amber">◎</span><h3>失败智能分类</h3>
              <span className="head-hint">共 {data.summary.totalFail} 次失败 · <b style={{ color: 'var(--danger)' }}>外部不可控 {data.summary.externalPct}%</b> · <b style={{ color: 'var(--primary-text)' }}>可优化 {data.summary.fixablePct}%</b></span>
            </div>
            <div style={{ padding: '12px 18px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 10 }}>
              {data.byCategory.map((c) => (
                <div key={c.key} style={{ border: '1px solid var(--border)', borderLeft: `3px solid var(${CAT_COLOR[c.key] || '--text-4'})`, borderRadius: 'var(--r-md)', padding: '10px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <b style={{ fontSize: 12.5 }}>{c.name}</b>
                    <span className={'kbadge ' + (c.external ? 'neutral' : 'info')} style={{ marginLeft: 'auto' }}>{c.external ? '外部' : '可优化'}</span>
                    <span style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>{c.count}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{c.pct}%</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginTop: 6, lineHeight: 1.6 }}>{c.advice}</div>
                </div>
              ))}
            </div>
          </section>

          {/* 环节失败排名 + card 状态分布 */}
          <div className="section-gap" />
          <div className="grid-2">
            <section className="card">
              <div className="eb-top"><span className="idx c-green">▤</span><h3>环节失败排名</h3><span className="head-hint">失败卡在哪个环节 · 点击看细分</span></div>
              <div style={{ padding: '14px 18px' }}>
                {stageSegs.length ? (
                  <DrillableChart<DrillRow>
                    chart={(onSelect, active) => <Bars data={stageSegs} onSelect={onSelect} activeIndex={active} />}
                    resolve={() => ({ title: <>环节失败细分(全量)</>, rows: toDrillRows(data.blameDetail), columns: DRILL_COLS })}
                    rowKey={(r) => r.label}
                  />
                ) : <div className="empty-note">无失败数据</div>}
                <div style={{ marginTop: 12, fontSize: 12 }}>
                  {(data.blameDetail || []).slice(0, 10).map((b) => (
                    <div key={b.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid var(--border)', color: 'var(--text-2)' }}><span className="mono" style={{ fontSize: 11.5 }}>{b.label}</span><b style={{ fontFamily: 'var(--mono)' }}>{b.value}</b></div>
                  ))}
                </div>
              </div>
            </section>
            <section className="card">
              <div className="eb-top"><span className="idx c-info">◔</span><h3>加卡结果分布</h3><span className="head-hint">进了加卡阶段的最终状态 · 点击看细分</span></div>
              <div style={{ padding: '14px 18px' }}>
                {cardSegs.length ? (
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <div style={{ width: '100%', maxWidth: 420 }}>
                      <DrillableChart<DrillRow>
                        chart={(onSelect, active) => <Donut data={cardSegs} centerValue={cardSegs.find((s) => s.label === 'card-bound')?.value ?? 0} centerLabel="绑成" onSelect={onSelect} activeIndex={active} />}
                        resolve={() => ({ title: <>加卡结果分布(全量)</>, rows: toDrillRows(cardSegs), columns: DRILL_COLS })}
                        rowKey={(r) => r.label}
                      />
                    </div>
                  </div>
                ) : <div className="empty-note">无加卡数据</div>}
              </div>
            </section>
          </div>

          {/* IP 战绩 + 卡战绩 */}
          <div className="section-gap" />
          <section className="card"><div className="eb-top"><span className="idx c-amber">⊞</span><h3>IP 战绩(加卡)</h3><span className="head-hint">按出口 IP 看绑成率 / server-error —— 绑成率低的是差 IP</span></div>
            <DataTable rows={data.byProxy} columns={[...PROXY_COLS, proxyActCol]} rowKey={(r) => r.host} initialSort={{ key: 'attempts', dir: 'desc' }} maxHeight={360} getRowClass={(r) => (r.attempts >= 4 && r.boundPct < 30) ? 'is-banned' : undefined} emptyText="无加卡记录" exportName="analysis-proxy" columnSettings={{ tableId: 'analysis-proxy' }} search={{ keys: [(r) => r.host], placeholder: '搜索出口 IP…' }} />
          </section>
          <div className="section-gap" />
          <section className="card"><div className="eb-top"><span className="idx">$</span><h3>卡战绩(加卡)</h3><span className="head-hint">按卡末4 看绑成 / declined —— 多 declined 的卡可能质量差</span></div>
            <DataTable rows={data.byCard} columns={[...CARD_COLS, cardActCol]} rowKey={(r) => r.last4} initialSort={{ key: 'attempts', dir: 'desc' }} maxHeight={320} emptyText="无加卡记录" exportName="analysis-card" columnSettings={{ tableId: 'analysis-card' }} search={{ keys: [(r) => r.last4], placeholder: '搜索卡末4…' }} />
          </section>

          {/* Playwright 错误日志 + 趋势 */}
          {(engine === 'all' || engine === 'playwright') && data.errorLog.total > 0 && (
            <><div className="section-gap" />
              <div className="grid-2">
                <section className="card"><div className="eb-top"><span className="idx c-amber">⚑</span><h3>错误日志 · 按阶段</h3><span className="head-hint">内置(Playwright)引擎 · 共 {data.errorLog.total} 条 · 点击看细分</span></div>
                  <div style={{ padding: '14px 18px' }}>
                    <DrillableChart<DrillRow>
                      chart={(onSelect, active) => <Bars data={data.errorLog.byStage.map((b, i) => ({ label: b.label, value: b.value, colorVar: ['--danger', '--warn', '--info', '--primary', '--text-3'][i % 5] }))} onSelect={onSelect} activeIndex={active} />}
                      resolve={() => ({ title: <>错误日志 · 按阶段(全量)</>, rows: toDrillRows(data.errorLog.byStage), columns: DRILL_COLS })}
                      rowKey={(r) => r.label}
                    />
                  </div>
                </section>
                <section className="card"><div className="eb-top"><span className="idx c-amber">⚑</span><h3>错误日志 · 按原因(前8)</h3><span className="head-hint">点击看全量</span></div>
                  <div style={{ padding: '14px 18px' }}>{reasonSegs.length ? (
                    <DrillableChart<DrillRow>
                      chart={(onSelect, active) => <Bars data={reasonSegs} onSelect={onSelect} activeIndex={active} />}
                      resolve={() => ({ title: <>错误日志 · 按原因(全量)</>, rows: toDrillRows(data.errorLog.byReason), columns: DRILL_COLS })}
                      rowKey={(r) => r.label}
                    />
                  ) : <div className="empty-note">无</div>}</div>
                </section>
              </div></>
          )}

          {data.trend.length > 0 && (
            <><div className="section-gap" />
              <section className="card"><div className="eb-top"><span className="idx c-info">📈</span><h3>按天趋势</h3><span className="head-hint">运行历史 · 成功 / 失败 · 点击某天看明细</span></div>
                <div style={{ padding: '14px 18px' }}>
                  <DrillableChart<DrillRow>
                    chart={(onSelect, active) => <AreaLine labels={data.trend.map((t) => t.day)} series={[
                      { name: '成功', colorVar: '--success', values: data.trend.map((t) => t.success) },
                      { name: '失败', colorVar: '--danger', values: data.trend.map((t) => t.failed) },
                    ]} onSelect={onSelect} activeIndex={active} />}
                    resolve={(i) => { const t = data.trend[i]; return { title: <>{t.day} 当天</>, rows: toDrillRows([{ label: '运行', value: t.runs }, { label: '成功', value: t.success }, { label: '失败', value: t.failed }]), columns: DRILL_COLS }; }}
                    rowKey={(r) => r.label}
                  />
                </div>
              </section></>
          )}
        </>
      )}
    </main>
  );
}
