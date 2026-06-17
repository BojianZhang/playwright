// 单次运行下钻:汇总 + 成功账号表 + 失败原因表 + 下载/复制。数据 /api/runs/detail。
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api';
import { withToken } from '../lib/auth';
import { Icon } from '../lib/icons';
import { useToast } from '../lib/toast';
import { downloadCsv } from '../lib/export';
import { fmtDateTime, fmtDuration, trunc } from '../lib/parse';
import type { RunDetailResp, StartJobResp, IncompleteRow, AccountRow } from '../lib/types';
import { pwView } from '../lib/pwView';
import { RunStatus, BILLING_ACTION_LABEL, EngineBadge } from '../features/runs';

const PY_ENGINES = ['selenium', 'hybrid', 'split'];

export default function RunDetailPage() {
  const { jobId = '' } = useParams();
  const toast = useToast();
  const navigate = useNavigate();
  const [resuming, setResuming] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['run-detail', jobId], queryFn: () => apiGet<RunDetailResp>(`/api/runs/detail?jobId=${encodeURIComponent(jobId)}`, true), refetchInterval: (q) => (q.state.data?.summary?.status === 'running' ? 5000 : false) });
  const s = data?.summary;
  const success = data?.success || [];
  const failed = data?.failed || [];
  const incomplete = data?.incomplete || [];
  // 未完整里【可续跑】的(banned/坏邮箱是永久态,不重跑)→ 给「只续跑未完整」按钮用
  const resumableEmails = incomplete.filter((r) => r.status === 'incomplete' || r.status === 'not-run').map((r) => r.email).filter(Boolean);
  // ★M21:大批次详情(后端封顶 5000 行)若整表渲染进 DOM 会卡顿 → 只渲染前 RENDER_CAP 行,溢出给提示+引导下载(完整数据在 .csv/.txt)。
  const RENDER_CAP = 1000;
  const copy = (txt: string) => navigator.clipboard.writeText(txt).then(() => toast.push('已复制', 'ok'), () => toast.push('复制失败', 'err'));

  // 「续跑这批」:中断/异常的 Python 任务,后端用残留输入强制 resume 重起 → 跳控制台实时显示。
  // onlyEmails 传子集 → 后端只重跑这些号(运行详情「未完整」桶的「只续跑未完整」按钮);不传=整批续跑。
  const canResume = !!s && PY_ENGINES.includes(s.engine || '') && (s.status === 'interrupted' || s.status === 'error');
  async function resume(onlyEmails?: string[]) {
    if (resuming) return;
    setResuming(true);
    try {
      const body: { jobId: string; engine?: string; onlyEmails?: string[] } = { jobId, engine: s?.engine };
      if (onlyEmails && onlyEmails.length) body.onlyEmails = onlyEmails;
      const d = await apiPost<StartJobResp>('/api/run/resume', body);
      toast.push(`已续跑 · 接受 ${d.accepted} 个号(已完成的自动跳过)`, 'ok');
      navigate(`/console?attach=${encodeURIComponent(d.jobId)}&total=${d.accepted || 0}&engine=${encodeURIComponent(d.engine || s?.engine || 'selenium')}`);
    } catch (e) {
      toast.push('续跑失败:' + ((e as Error).message || '未知'), 'err');
    } finally { setResuming(false); }
  }

  return (
    <main className="page">
      <div className="zone">
        <Link className="link-btn" to="/runs"><Icon name="chevron" size={14} style={{ transform: 'rotate(180deg)' }} />运行历史</Link>
        <h2 style={{ marginLeft: 8 }}>运行详情</h2>
        <span className="z-hint mono">{jobId.slice(-14)}</span><span className="z-line" />
        {canResume && (
          <button className="btn btn-primary btn-sm" disabled={resuming} onClick={() => resume()} title="用这批账号断点续跑:自动跳过已完成的号,只跑没跑完的;跑起后跳到控制台看实时进度">
            <Icon name="refresh" size={13} />{resuming ? '续跑中…' : '续跑这批'}
          </button>
        )}
      </div>

      {isLoading ? <div className="card card-pad"><div className="empty-note">加载中…</div></div> : !s ? (
        <div className="card card-pad"><div className="empty-note">未找到该任务的汇总(可能历史已清或 jobId 有误)。仍可查看下方 batch-results 明细(若有)。</div></div>
      ) : (
        <section className="card statbar" style={{ gridTemplateColumns: 'repeat(6,1fr)' }}>
          <div className="stat-cell s-total"><div className="num">{s.total}</div><div className="lbl">账号总数</div></div>
          <div className="stat-cell s-ok"><div className="num">{s.success}</div><div className="lbl">成功</div></div>
          <div className="stat-cell s-fail"><div className="num">{s.failed}</div><div className="lbl">失败</div></div>
          {/* ★第三桶「未完整」:本批无结果且历史回填不到的号(被 kill/并发没排到/丢结果);total = 成功+失败+未完整,无号丢失。*/}
          <div className="stat-cell s-q" title="未完整=本批没产出结果、历史也查不到的号(疑中途被 kill / 并发未排到 / 子进程丢结果)。下方有逐号原因,可一键只续跑这些。"><div className="num">{s.incomplete != null ? s.incomplete : Math.max(0, s.total - s.success - s.failed)}</div><div className="lbl">未完整</div></div>
          <div className="stat-cell s-br"><div className="num" style={{ fontSize: 18 }}>{fmtDuration(s.durationMs)}</div><div className="lbl">用时</div></div>
          <div className="stat-cell s-q"><div className="num" style={{ fontSize: 18 }}><RunStatus status={s.status} partial={s.partial} completenessPct={s.completenessPct} /></div><div className="lbl">{fmtDateTime(s.startedAt)} 起</div></div>
        </section>
      )}

      {s && (
        <>
          <div className="section-gap" />
          <section className="card card-pad">
            <div className="err-summary">
              <span className="err-chip">引擎 <b><EngineBadge engine={s.engine} /></b></span>
              <span className="err-chip">模式 <b>{s.params?.mode || '—'}</b></span>
              <span className="err-chip">计费 <b>{BILLING_ACTION_LABEL[s.params?.billingAction || 'none'] || s.params?.billingAction}</b></span>
              <span className="err-chip">并发 <b>{s.params?.concurrency ?? '—'}</b></span>
              <span className="err-chip">取Key <b>{s.params?.doApiKey ? '是' : '否'}</b></span>
              <span className="err-chip">改密 <b>{s.params?.doPasswordChange ? '是' : '否'}</b></span>
              <span className="err-chip">指纹 <b>{s.params?.browserProvider || 'none'}</b></span>
              {s.params?.configSnapshot && (
                <span className="err-chip" title={'引擎opts: ' + JSON.stringify(s.params.configSnapshot.engineOpts || {}) + '\n高级参数: ' + JSON.stringify(s.params.configSnapshot.advanced || {})}>
                  配置快照 <b>预设 {s.params.configSnapshot.enginePresetId || '—'} · 方案 {s.params.configSnapshot.schemeId || '—'}</b>
                </span>
              )}
              {s.resumedFrom && <span className="err-chip">续跑自 <b className="mono">{String(s.resumedFrom).slice(-10)}</b></span>}
              {s.error && <span className="err-chip code">异常 <b>{trunc(s.error, 40)}</b></span>}
            </div>
          </section>
        </>
      )}

      <div className="section-gap" />

      <div className="grid-2">
        {/* 成功 */}
        <section className="card">
          <div className="card-head"><span className="idx c-green"><Icon name="okcircle" size={12} /></span><h3>成功账号 <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>{success.length}</span></h3>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button className="btn btn-ghost btn-sm" disabled={!success.length} onClick={() => copy(success.map((a) => `${a.email || ''}:${a.apiKey || ''}`).join('\n'))}>复制 邮箱:Key</button>
              <button className="btn btn-ghost btn-sm" disabled={!success.length} onClick={() => downloadCsv('run-success', ['邮箱', 'API Key', '账单', '充值状态', '充值额', '卡末4', '出口IP', '耗时s', '邮箱现密码', 'z.ai现密码'], success.map((a) => { const pv = pwView(a); return [a.email || '', a.apiKey || '', a.billingStatus || '', PURCHASE_LABEL[a.purchaseStatus || ''] || (a.charged ? '成功' : '—'), a.charged != null ? a.charged : '', a.cardLast4 || '', a.exitIp || '', a.durationSec != null ? a.durationSec : '', pv.mbCur, pv.orCur]; }))}><Icon name="download" size={12} />.csv</button>
              <button className="btn btn-ghost btn-sm" disabled={!success.length} onClick={() => window.open(withToken(`/download?jobId=${encodeURIComponent(jobId)}`), '_blank')}><Icon name="download" size={12} />.txt</button>
            </div>
          </div>
          <div className="panel-sec" style={{ paddingTop: 8 }}>
            {!success.length ? <div className="empty-note">无成功账号。</div> : (
              <div className="tbl-wrap" style={{ maxHeight: 460 }}>
                <table className="tbl">
                  <thead><tr><th>邮箱</th><th>API Key</th><th>账单</th><th>充值</th><th>卡末4</th><th>出口IP</th><th>耗时</th></tr></thead>{/* 充值列:明确 成功/失败/已充跳过/未充值,不再只显 $0;耗时=单号端到端秒数 */}
                  <tbody>
                    {success.slice(0, RENDER_CAP).map((a, i) => (
                      <tr key={i}>
                        <td className="mono">{a.email}</td>
                        <td className="mono" style={{ color: 'var(--primary-text)' }} title={a.apiKey}>{trunc(a.apiKey, 20)}</td>
                        <td>{a.billingStatus === 'success' ? <span className="kbadge ok">success</span> : a.billingStatus ? <span className="kbadge warn">{a.billingStatus}</span> : <span className="kbadge neutral">—</span>}</td>
                        <td>{renderPurchase(a)}</td>
                        <td className="mono">{a.cardLast4 ? '•••• ' + a.cardLast4 : '—'}</td>
                        <td className="mono" style={{ color: 'var(--text-2)' }}>{a.exitIp || '—'}</td>
                        <td className="mono" style={{ color: 'var(--text-3)', cursor: a.timings ? 'help' : undefined, textDecoration: a.timings ? 'underline dotted' : undefined }} title={timingTip(a)}>{a.durationSec != null ? a.durationSec + 's' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {success.length > RENDER_CAP && <div className="empty-note">仅显示前 {RENDER_CAP} / 共 {success.length} 行(防卡顿)——完整数据请用上方「.csv」「.txt」下载。</div>}
              </div>
            )}
          </div>
        </section>

        {/* 失败 */}
        <section className="card">
          <div className="card-head"><span className="idx c-amber"><Icon name="xcircle" size={12} /></span><h3>失败账号 <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>{failed.length}</span></h3>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button className="btn btn-ghost btn-sm" disabled={!failed.length} title="z.ai现密码=z.ai 登录密码(设了统一密码就是它);重跑已注册的失败号(如 key:false)用这个登录" onClick={() => copy(failed.map((a) => `${a.email || ''}:${pwView(a).orCur}`).join('\n'))}>复制 邮箱:z.ai密码</button>
              <button className="btn btn-ghost btn-sm" disabled={!failed.length} title="邮箱现密码=当前邮箱登录密码(改密后为新值;失败号通常=原邮箱密码)。重导入 accounts.txt 重跑用这个" onClick={() => copy(failed.map((a) => `${a.email || ''}:${pwView(a).mbCur}`).join('\n'))}>复制 邮箱:邮箱现密码</button>
              <button className="btn btn-ghost btn-sm" disabled={!failed.length} onClick={() => downloadCsv('run-failed', ['邮箱', '原因', '阶段', '分类', '尝试', '出口/代理', '邮箱现密码', 'z.ai现密码', '邮箱原密码'], failed.map((a) => { const pv = pwView(a); return [a.email || '', a.reason || '', a.stage || '', a.failClass || '', a.attempts ?? '', a.proxy || '', pv.mbCur, pv.orCur, pv.mbOrig]; }))}><Icon name="download" size={12} />.csv</button>
              <button className="btn btn-ghost btn-sm" disabled={!failed.length} onClick={() => window.open(withToken(`/download?type=failed&jobId=${encodeURIComponent(jobId)}`), '_blank')}><Icon name="download" size={12} />.txt</button>
            </div>
          </div>
          <div className="panel-sec" style={{ paddingTop: 8 }}>
            {!failed.length ? <div className="empty-note">无失败账号。</div> : (
              <div className="tbl-wrap" style={{ maxHeight: 460 }}>
                <table className="tbl">
                  <thead><tr><th>邮箱</th><th>原因</th><th>阶段</th><th>分类</th><th>试</th><th>出口/代理</th><th title="z.ai现密码=z.ai 登录密码(续跑重登用);邮箱密码见悬停/导出">z.ai现密码</th></tr></thead>
                  <tbody>
                    {failed.slice(0, RENDER_CAP).map((a, i) => { const pv = pwView(a); return (
                      <tr key={i} className="is-banned">
                        <td className="mono">{a.email}</td>
                        <td className="mono" style={{ color: 'var(--danger)' }}>{a.reason}</td>
                        <td className="mono" style={{ color: 'var(--text-2)' }}>{a.stage || '—'}</td>
                        <td className="mono" style={{ color: 'var(--text-3)' }}>{a.failClass || '—'}</td>
                        <td className="mono">{a.attempts ?? '—'}</td>
                        <td className="mono" style={{ color: 'var(--text-3)' }} title={a.proxy}>{a.proxy ? String(a.proxy).split(':').slice(0, 2).join(':') : '—'}</td>
                        <td className="mono" style={{ color: 'var(--primary-text)', cursor: pv.orCur ? 'pointer' : 'default' }} title={'z.ai现密码=当前 z.ai 登录密码(设了统一密码就是它)' + (pv.orCur ? '·点击复制' : '') + (pv.mbCur && pv.mbCur !== pv.orCur ? '\n邮箱现密码:' + pv.mbCur : '')} onClick={() => pv.orCur && copy(pv.orCur)}>{pv.orCur ? trunc(pv.orCur, 16) : '—'}</td>
                      </tr>
                    ); })}
                  </tbody>
                </table>
                {failed.length > RENDER_CAP && <div className="empty-note">仅显示前 {RENDER_CAP} / 共 {failed.length} 行(防卡顿)——完整数据请用上方「.csv」「.txt」下载。</div>}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* ★第三桶「未完整 / 未运行」:本批无结果且历史回填不到的号 —— 逐号标原因(banned/坏邮箱/中途中断/未跑到),可一键只续跑可恢复的。*/}
      {incomplete.length > 0 && (
        <>
          <div className="section-gap" />
          <section className="card">
            <div className="card-head"><span className="idx c-amber"><Icon name="alert" size={12} /></span><h3>未完整 / 未运行 <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>{incomplete.length}</span></h3>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className="z-hint">这些号本批没产出结果(被中断/并发没排到/丢结果),已逐号标明原因</span>
                {canResume && resumableEmails.length > 0 && (
                  <button className="btn btn-primary btn-sm" disabled={resuming} onClick={() => resume(resumableEmails)} title={`只把这 ${resumableEmails.length} 个【可恢复】的未完整号续跑(banned/坏邮箱永久态不重跑);已完成的环节自动跳过、防重复扣费`}>
                    <Icon name="refresh" size={13} />{resuming ? '续跑中…' : `只续跑未完整(${resumableEmails.length})`}
                  </button>
                )}
                <button className="btn btn-ghost btn-sm" disabled={!incomplete.length} onClick={() => downloadCsv('run-incomplete', ['邮箱', '状态', '原因', '现密码'], incomplete.map((a) => [a.email || '', a.status || '', a.reason || '', a.password || '']))}><Icon name="download" size={12} />.csv</button>
              </div>
            </div>
            <div className="panel-sec" style={{ paddingTop: 8 }}>
              <div className="tbl-wrap" style={{ maxHeight: 420 }}>
                <table className="tbl">
                  <thead><tr><th>邮箱</th><th>状态</th><th>为啥未完整(可续跑性)</th></tr></thead>
                  <tbody>
                    {incomplete.slice(0, RENDER_CAP).map((a: IncompleteRow, i) => (
                      <tr key={i}>
                        <td className="mono">{a.email}</td>
                        <td>{INCOMPLETE_BADGE[a.status] || <span className="kbadge neutral">{a.status}</span>}</td>
                        <td className="mono" style={{ color: 'var(--text-2)' }}>{a.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {incomplete.length > RENDER_CAP && <div className="empty-note">仅显示前 {RENDER_CAP} / 共 {incomplete.length} 行(防卡顿)——完整数据请用上方「.csv」下载。</div>}
              </div>
            </div>
          </section>
        </>
      )}
    </main>
  );
}

// 逐步耗时分解(详情页「耗时」列 hover 显示):排查【哪步慢】可优化。慢→快排序,一眼看瓶颈。
const STAGE_LABEL: Record<string, string> = { env: '环境', auth: '登录', register: '注册', key: '取Key', address: '绑址', card: '加卡', charge: '充值', changepw: '改密' };
function timingTip(a: AccountRow): string | undefined {
  const t = a.timings;
  if (!t || typeof t !== 'object') return undefined;
  const parts = Object.entries(t)
    .filter(([, v]) => typeof v === 'number' && (v as number) > 0)
    .sort((x, y) => (y[1] as number) - (x[1] as number))
    .map(([k, v]) => `${STAGE_LABEL[k] || k} ${Math.round((v as number) * 10) / 10}s`);
  return parts.length ? '逐步耗时(慢→快):\n' + parts.join('\n') : undefined;
}

// 充值结果列:明确 成功(+金额)/ 失败(带真因)/ 已充跳过 / 未充值,消除「charged=$0」的歧义。
const PURCHASE_LABEL: Record<string, string> = { success: '成功', failed: '失败', skipped: '已充跳过', 'not-attempted': '未充值', 'dry-run': '未真扣' };
function renderPurchase(a: AccountRow) {
  const ps = a.purchaseStatus;
  if (ps === 'success') return <span className="kbadge ok">成功{a.charged ? ' $' + a.charged : ''}</span>;
  if (ps === 'dry-run') return <span className="kbadge info" title="真实充值关:走到充值步未真点 Purchase(dry-run 测全流程)">未真扣·dry-run</span>;
  if (ps === 'failed') return <span className="kbadge fail" title={a.purchaseReason || ''}>{a.purchaseReason ? a.purchaseReason : '失败'}</span>;
  if (ps === 'skipped') return <span className="kbadge neutral" title="续跑检测到已充值,跳过(防重复扣款)">已充·跳过</span>;
  if (ps === 'not-attempted') return <span className="kbadge neutral" title="本次未启用充值(do_purchase 关)或未走到充值阶段">未充值</span>;
  return <span className="mono">{a.charged != null ? '$' + a.charged : '—'}</span>;   // 老结果行无 purchaseStatus → 回退原显示
}
// 未完整号状态徽章:banned/坏邮箱=永久态(红/灰,不重跑)、incomplete/not-run=可续跑(黄/蓝)
const INCOMPLETE_BADGE: Record<string, JSX.Element> = {
  banned: <span className="kbadge fail">号被拒</span>,
  'bad-mailbox': <span className="kbadge neutral">坏邮箱</span>,
  incomplete: <span className="kbadge warn">中途中断</span>,
  'not-run': <span className="kbadge warn">未跑到</span>,
};
