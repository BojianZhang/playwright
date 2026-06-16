// 单次运行下钻:汇总 + 成功账号表 + 失败原因表 + 下载/复制。数据 /api/runs/detail。
import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api';
import { withToken } from '../lib/auth';
import { Icon } from '../lib/icons';
import { useToast } from '../lib/toast';
import { downloadCsv } from '../lib/export';
import { fmtDateTime, fmtDuration, trunc } from '../lib/parse';
import type { RunDetailResp, StartJobResp, IncompleteRow, AccountRow, FailedRecord } from '../lib/types';
import { RunStatus, BILLING_ACTION_LABEL, EngineBadge } from '../features/runs';
import { Modal } from '../components/Modal';
import { DECLINE_LABEL } from '../lib/labels';   // ★单一来源(原本地副本,与 panels/Diagnose 三处重复)
import { useRecovery } from '../features/console/useRecovery';
import { recoveryResumeOptions } from '../lib/recoverySchema';

const PY_ENGINES = ['selenium', 'hybrid', 'split'];

export default function RunDetailPage() {
  const { jobId = '' } = useParams();
  const toast = useToast();
  const navigate = useNavigate();
  const [resuming, setResuming] = useState(false);
  // 失败列表「按原因批量恢复」:多选(按邮箱)+ 恢复弹窗 + 恢复参数。
  const [selFailed, setSelFailed] = useState<Set<string>>(new Set());
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [recZip, setRecZip] = useState(3);        // declined/加卡 时 ZIP 重试次数
  const [recSwapHc, setRecSwapHc] = useState(true); // hCaptcha 时换卡
  const [recRounds, setRecRounds] = useState(1);    // 自动重试轮数(每轮换出口 IP)
  const [recCardStrategy, setRecCardStrategy] = useState(''); // 换卡策略(由所选方案带,无独立旋钮)
  const [selProfileId, setSelProfileId] = useState('');       // 选中的恢复方案 id(空=用自动推荐)
  const { data, isLoading, isError, error } = useQuery({ queryKey: ['run-detail', jobId], queryFn: () => apiGet<RunDetailResp>(`/api/runs/detail?jobId=${encodeURIComponent(jobId)}`, true), refetchInterval: (q) => (q.state.data?.summary?.status === 'running' ? 5000 : false) });
  const { data: recData } = useRecovery();   // 恢复方案预设(全局缓存)+ 历史恢复战绩
  const recPresets = recData?.recovery?.presets || [];
  const resumedStats = recData?.resumedStats || null;
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

  // ── 失败列表「按原因批量恢复」──────────────────────────────────────────
  const isPy = !!s && PY_ENGINES.includes(s.engine || '');   // 有失败/未完整即可恢复(不再限 interrupted/error;输入已保留/可按明细重建)
  // 每行 reasonInfo 只算一次(按邮箱缓存):分组/选择/分类列复用,避免每渲染多次重复计算
  const riByEmail = useMemo(() => { const m = new Map<string, ReasonInfo>(); for (const a of failed) { if (a.email) m.set(a.email, reasonInfo(a)); } return m; }, [failed]);
  const riOf = (a: FailedRecord): ReasonInfo => (a.email && riByEmail.get(a.email)) || reasonInfo(a);
  const toggleFail = (email: string) => setSelFailed((p) => { const n = new Set(p); if (n.has(email)) n.delete(email); else n.add(email); return n; });
  // 点原因 chip = 整组切换选中(全选则取消,否则全加)
  const selectReason = (emails: string[]) => setSelFailed((p) => { const n = new Set(p); const all = emails.every((e) => n.has(e)); emails.forEach((e) => { if (all) n.delete(e); else n.add(e); }); return n; });
  const allFailEmails = failed.map((a) => a.email || '').filter(Boolean);
  const toggleAllFail = () => setSelFailed((p) => (allFailEmails.every((e) => p.has(e)) ? new Set() : new Set(allFailEmails)));
  // 失败行按恢复原因分组(chips + 弹窗用),按组大小降序
  const reasonGroups = (() => {
    const m = new Map<string, { info: ReasonInfo; emails: string[] }>();
    for (const a of failed) { if (!a.email) continue; const info = riOf(a); const g = m.get(info.key) || { info, emails: [] }; g.emails.push(a.email); m.set(info.key, g); }
    return Array.from(m.values()).sort((x, y) => y.emails.length - x.emails.length);
  })();
  const selectedRows = failed.filter((a) => a.email && selFailed.has(a.email));
  const selectedRecoverable = selectedRows.filter((a) => riOf(a).recoverable);
  // 选中行的原因分布(弹窗里逐组诚实标注)
  const selectedGroups = (() => {
    const m = new Map<string, { info: ReasonInfo; n: number }>();
    for (const a of selectedRows) { const info = riOf(a); const g = m.get(info.key) || { info, n: 0 }; g.n += 1; m.set(info.key, g); }
    return Array.from(m.values()).sort((x, y) => y.n - x.n);
  })();
  const selHasCharge = selectedRecoverable.some((a) => riOf(a).key.startsWith('charge'));
  const selHasHc = selectedRecoverable.some((a) => riOf(a).key === 'card:hcaptcha');
  // 选中失败的【主因】→ 推荐恢复方案(已是恢复跑则升一档「加力」);用户在下拉里另选则用其选择
  const dominantKey = selectedGroups.length ? selectedGroups[0].info.key : '';
  const isEscalation = !!s?.resumedFrom;   // 本次详情本身就是一次恢复跑 → 再恢复=加力
  const recommendedProfileId = dominantKey ? (isEscalation ? (ESCALATE_PROFILE[RECOMMEND_PROFILE(dominantKey)] || RECOMMEND_PROFILE(dominantKey)) : RECOMMEND_PROFILE(dominantKey)) : '';
  const chosenProfile = recPresets.find((p) => p.id === selProfileId) || recPresets.find((p) => p.id === recommendedProfileId) || null;

  // 打开弹窗(或选中主因变化)→ 自动推荐方案;用户没手动改过才跟随推荐
  useEffect(() => { if (recoverOpen) setSelProfileId(recommendedProfileId); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [recoverOpen, recommendedProfileId]);
  // 所选方案 → 预填旋钮(动作字段 → recoverOptions 同口径);用户仍可手调,手调优先
  useEffect(() => {
    if (!chosenProfile) return;
    const ro = recoveryResumeOptions(chosenProfile.opts);
    setRecRounds(ro.autoRetryTimes != null ? ro.autoRetryTimes : 0);
    setRecZip(ro.zipRetry != null ? ro.zipRetry : 0);
    setRecSwapHc(ro.solveHcaptcha === 'swap');
    setRecCardStrategy(ro.cardStrategy || '');
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [chosenProfile?.id]);

  async function recover() {
    if (resuming) return;
    const emails = selectedRecoverable.map((a) => a.email || '').filter(Boolean);
    if (!emails.length) { toast.push('没有可恢复的选中号(永久态已排除)', 'err'); return; }
    const recoverOptions: Record<string, unknown> = { recoveryOverride: { retryRegister: 'on', retryKey: 'on', retryCard: 'on', retryCharge: 'on' } };
    if (selHasCharge && recZip > 0) recoverOptions.zipRetry = recZip;
    if (selHasHc && recSwapHc) recoverOptions.solveHcaptcha = 'swap';
    if (recRounds > 0) { recoverOptions.autoRetryFailed = true; recoverOptions.autoRetryTimes = recRounds; }
    if (recCardStrategy) recoverOptions.cardStrategy = recCardStrategy;   // 换卡策略(方案带;仅对未绑卡号选新卡有效)
    if (chosenProfile) { recoverOptions.recoveryProfileId = chosenProfile.id; recoverOptions.recoveryProfileName = chosenProfile.name; }   // 可溯源
    setResuming(true);
    try {
      const d = await apiPost<StartJobResp>('/api/run/resume', { jobId, engine: s?.engine, onlyEmails: emails, recoverOptions });
      toast.push(`已发起批量恢复 · 接受 ${d.accepted} 个号${d.rebuilt ? '(输入已清→按明细重建)' : ''}`, 'ok');
      setRecoverOpen(false); setSelFailed(new Set());
      navigate(`/console?attach=${encodeURIComponent(d.jobId)}&total=${d.accepted || 0}&engine=${encodeURIComponent(d.engine || s?.engine || 'selenium')}`);
    } catch (e) {
      toast.push('批量恢复失败:' + ((e as Error).message || '未知'), 'err');
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

      {isLoading ? <div className="card card-pad"><div className="empty-note">加载中…</div></div> : isError ? (
        <div className="card card-pad"><div className="empty-note" style={{ color: 'var(--danger)' }}>加载失败:{(error as Error)?.message || '接口错误'}(服务可能未启动/网络问题)—— 请「重启服务」或稍后重试。</div></div>
      ) : !s ? (
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
              {s.resumedFrom && s.params?.configSnapshot?.recoveryProfileName && <span className="err-chip" title="本次恢复跑采用的恢复方案(可溯源)">恢复方案 <b>{s.params.configSnapshot.recoveryProfileName}</b></span>}
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
              <button className="btn btn-ghost btn-sm" disabled={!success.length} onClick={() => downloadCsv('run-success', ['邮箱', 'API Key', '账单', '充值状态', '充值额', '卡末4', '出口IP', '耗时s', '现密码'], success.map((a) => [a.email || '', a.apiKey || '', a.billingStatus || '', PURCHASE_LABEL[a.purchaseStatus || ''] || (a.charged ? '成功' : '—'), a.charged != null ? a.charged : '', a.cardLast4 || '', a.exitIp || '', a.durationSec != null ? a.durationSec : '', a.password || '']))}><Icon name="download" size={12} />.csv</button>
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
              {isPy && failed.length > 0 && (
                <button className="btn btn-primary btn-sm" disabled={!selectedRecoverable.length || resuming} title="把选中的失败号按失败原因走专属恢复流程重跑(换卡/换IP/ZIP重试等);断点续跑,已完成环节自动跳过、防重复扣费" onClick={() => setRecoverOpen(true)}>
                  <Icon name="refresh" size={13} />批量恢复{selectedRecoverable.length ? `(${selectedRecoverable.length})` : ''}
                </button>
              )}
              <button className="btn btn-ghost btn-sm" disabled={!failed.length} title="现密码=OpenRouter 登录密码(设了统一密码就是它);重跑已注册的失败号(如 key:false)用这个登录" onClick={() => copy(failed.map((a) => `${a.email || ''}:${a.password || a.originalPassword || ''}`).join('\n'))}>复制 邮箱:密码</button>
              <button className="btn btn-ghost btn-sm" disabled={!failed.length} title="原密码=账号原始/邮箱密码" onClick={() => copy(failed.map((a) => `${a.email || ''}:${a.originalPassword || a.password || ''}`).join('\n'))}>复制 邮箱:原密码</button>
              <button className="btn btn-ghost btn-sm" disabled={!failed.length} onClick={() => downloadCsv('run-failed', ['邮箱', '原因', '阶段', '恢复动作', '人机模式', '拒付码', '尝试', '出口/代理', '现密码', '原密码'], failed.map((a) => [a.email || '', a.reason || '', a.stage || '', actionClassOf(riOf(a)), a.failClass || '', a.declineCode || '', a.attempts ?? '', a.proxy || '', a.password || '', a.originalPassword || '']))}><Icon name="download" size={12} />.csv</button>
              <button className="btn btn-ghost btn-sm" disabled={!failed.length} onClick={() => window.open(withToken(`/download?type=failed&jobId=${encodeURIComponent(jobId)}`), '_blank')}><Icon name="download" size={12} />.txt</button>
            </div>
          </div>
          {/* 按原因分组 chips:点一组=一键选中该组(再点取消);用于「选中所有 declined / 所有 hCaptcha」批量恢复 */}
          {isPy && failed.length > 0 && reasonGroups.length > 0 && (
            <div className="panel-sec" style={{ paddingTop: 8, paddingBottom: 0, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <span className="z-hint">按原因选:</span>
              {reasonGroups.map((g) => {
                const on = g.emails.every((e) => selFailed.has(e));
                return (
                  <button key={g.info.key} className={'err-chip' + (on ? ' is-active' : '')} title={g.info.note + (g.info.recoverable ? '' : ' (不可恢复,点选无效)')} disabled={!g.info.recoverable}
                    style={{ cursor: g.info.recoverable ? 'pointer' : 'not-allowed', opacity: g.info.recoverable ? 1 : 0.5, border: on ? '1px solid var(--primary)' : undefined }}
                    onClick={() => g.info.recoverable && selectReason(g.emails)}>
                    {g.info.label} <b>{g.emails.length}</b>
                  </button>
                );
              })}
              {selFailed.size > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setSelFailed(new Set())}>清除选择({selFailed.size})</button>}
            </div>
          )}
          <div className="panel-sec" style={{ paddingTop: 8 }}>
            {!failed.length ? <div className="empty-note">无失败账号。</div> : (
              <div className="tbl-wrap" style={{ maxHeight: 460 }}>
                <table className="tbl">
                  <thead><tr>
                    {isPy && <th style={{ width: 28 }}><input type="checkbox" checked={allFailEmails.length > 0 && allFailEmails.every((e) => selFailed.has(e))} onChange={toggleAllFail} title="全选/全不选" /></th>}
                    <th>邮箱</th><th>原因</th><th>阶段</th><th title="基于失败原因建议的恢复动作(换环境/换卡/换IP);原 hcap_mode 移到悬停">恢复动作</th><th>拒付码</th><th>试</th><th>出口/代理</th><th>现密码</th>
                  </tr></thead>
                  <tbody>
                    {failed.slice(0, RENDER_CAP).map((a, i) => {
                      const ri = riOf(a);
                      return (
                      <tr key={i} className={'is-banned' + (a.email && selFailed.has(a.email) ? ' is-selected' : '')}>
                        {isPy && <td><input type="checkbox" disabled={!ri.recoverable} checked={!!(a.email && selFailed.has(a.email))} onChange={() => a.email && toggleFail(a.email)} title={ri.recoverable ? '选中以批量恢复' : '永久态,不可恢复'} /></td>}
                        <td className="mono">{a.email}</td>
                        <td className="mono" style={{ color: 'var(--danger)' }}>{a.reason}</td>
                        <td className="mono" style={{ color: 'var(--text-2)' }}>{a.stage || '—'}</td>
                        <td className="mono" style={{ color: ri.recoverable ? 'var(--primary-text)' : 'var(--text-3)' }} title={'恢复动作建议(基于失败原因)' + (a.failClass ? '\n人机模式(hcap_mode):' + a.failClass : '')}>{actionClassOf(ri)}</td>
                        <td className="mono" style={{ color: a.declineCode === 'insufficient_funds' ? 'var(--danger)' : 'var(--text-3)' }} title={a.declineCode ? (DECLINE_LABEL[a.declineCode] || a.declineCode) : ''}>{a.declineCode ? (DECLINE_LABEL[a.declineCode] || a.declineCode) : '—'}</td>
                        <td className="mono">{a.attempts ?? '—'}</td>
                        <td className="mono" style={{ color: 'var(--text-3)' }} title={a.proxy}>{a.proxy ? String(a.proxy).split(':').slice(0, 2).join(':') : '—'}</td>
                        <td className="mono" style={{ color: 'var(--primary-text)', cursor: a.password ? 'pointer' : 'default' }} title={'现密码=当前 OpenRouter 登录密码(设了统一密码就是它)' + (a.password ? '·点击复制' : '') + (a.originalPassword && a.originalPassword !== a.password ? '\n原密码:' + a.originalPassword : '')} onClick={() => a.password && copy(a.password)}>{a.password ? trunc(a.password, 16) : '—'}</td>
                      </tr>
                      );
                    })}
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
                {isPy && resumableEmails.length > 0 && (
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

      {/* 批量恢复确认弹窗:逐组诚实标注(declined 多为风控·争取不保证 / insufficient_funds 卡可能没钱)+ 恢复参数 */}
      <Modal open={recoverOpen} onClose={() => { if (!resuming) { setRecoverOpen(false); setSelProfileId(''); } }} size="md" title={`批量恢复 · ${selectedRecoverable.length} 个号`} icon="refresh"
        foot={(
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, width: '100%' }}>
            <button className="btn btn-ghost btn-sm" disabled={resuming} onClick={() => { setRecoverOpen(false); setSelProfileId(''); }}>取消</button>
            <button className="btn btn-primary btn-sm" disabled={resuming || !selectedRecoverable.length} onClick={recover}>{resuming ? '发起中…' : `确认恢复 ${selectedRecoverable.length} 个`}</button>
          </div>
        )}>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, lineHeight: 1.6, background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>
            断点续跑:已完成环节(注册/取Key/绑卡)自动跳过、<b>不重复扣费</b>;只重做失败的那步。
            保持源引擎 <b>{s?.engine}</b>(跨引擎换会绕过同引擎的防双扣门)。
          </div>
          {/* ★恢复方案:按选中失败的主因自动推荐一套重试流程,可改;一套方案=一条流程 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
              <b>恢复方案</b>
              <select value={selProfileId || (chosenProfile ? chosenProfile.id : '')} onChange={(e) => setSelProfileId(e.target.value)} style={{ minWidth: 200 }}>
                {recPresets.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === recommendedProfileId ? ' · 推荐' : ''}</option>)}
              </select>
              {chosenProfile && chosenProfile.id === recommendedProfileId && <span className="kbadge ok" style={{ fontSize: 11 }}>已按主因自动选</span>}
              {isEscalation && <span className="kbadge warn" style={{ fontSize: 11 }} title="本次详情本身是一次恢复跑,仍有失败 → 自动升一档加力(换IP→换环境→换卡)">加力再恢复</span>}
            </label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="z-hint">流程:</span>
              {recRounds > 0 && <span className="err-chip">换出口IP×{recRounds}</span>}
              {selHasCharge && recZip > 0 && <span className="err-chip">ZIP重试×{recZip}</span>}
              {recCardStrategy && <span className="err-chip">换卡·{recCardStrategy}</span>}
              {selHasHc && recSwapHc && <span className="err-chip">人机换卡(swap)</span>}
              {!(recRounds > 0 || (selHasCharge && recZip > 0) || recCardStrategy || (selHasHc && recSwapHc)) && <span className="z-hint">原样重试(不加动作)</span>}
              <Link to="/recovery" style={{ fontSize: 12, color: 'var(--primary-text)', marginLeft: 'auto' }}>管理方案</Link>
            </div>
            {resumedStats && resumedStats.runs > 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>历史:恢复跑 <b>{resumedStats.runs}</b> 批 · 成功率 ~<b>{resumedStats.pct != null ? resumedStats.pct + '%' : '—'}</b>(总体·非按原因,仅供参考)</div>
            )}
          </div>
          {/* 选中行的原因分布 + 逐组诚实标注 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {selectedGroups.map((g) => (
              <div key={g.info.key} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 }}>
                <span className={'kbadge ' + (g.info.recoverable ? 'warn' : 'neutral')} style={{ minWidth: 96, textAlign: 'center', flexShrink: 0 }}>{g.info.label} {g.n}</span>
                <span style={{ color: g.info.recoverable ? 'var(--text-2)' : 'var(--text-3)' }}>{g.info.recoverable ? g.info.note : g.info.note + '(不计入恢复)'}</span>
              </div>
            ))}
          </div>
          {/* 恢复参数 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            {selHasCharge && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                ZIP 重试次数(declined 多为 AVS/ZIP)
                <input type="number" min={0} max={12} value={recZip} onChange={(e) => setRecZip(Math.max(0, Math.min(12, Number(e.target.value) || 0)))} style={{ width: 64 }} />
              </label>
            )}
            {selHasHc && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input type="checkbox" checked={recSwapHc} onChange={(e) => setRecSwapHc(e.target.checked)} />
                hCaptcha 时换卡(swap,隐形框硬解常无效)
              </label>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              自动重试轮数(每轮换出口 IP)
              <input type="number" min={0} max={5} value={recRounds} onChange={(e) => setRecRounds(Math.max(0, Math.min(5, Number(e.target.value) || 0)))} style={{ width: 64 }} />
            </label>
          </div>
          {selHasCharge && <div style={{ fontSize: 12, color: 'var(--text-3)', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>⚠ 充值 declined 多为 Stripe 风控/环境因素,换卡+换IP 也<b>未必能成,这是争取不是保证</b>;若是「余额不足」请换卡或核对卡池余额。</div>}
        </div>
      </Modal>
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

// ── 失败原因分组(失败列表「按原因批量恢复」用)──────────────────────────────
interface ReasonInfo { key: string; label: string; recoverable: boolean; note: string }
// 把一条失败行归到「恢复原因组」+ 诚实标注(哪些争取/哪些无效)。stage + decline_code 细分。
function reasonInfo(a: FailedRecord): ReasonInfo {
  const stage = a.stage || '';
  const dc = a.declineCode || '';
  const reason = String(a.reason || '');
  if (a.blacklisted || /not[_-]?allowed|banned/i.test(reason)) return { key: 'banned', label: '号被拒(永久)', recoverable: false, note: 'OpenRouter 永久拒该号,恢复无效(已自动排除)。' };
  if (stage === 'charge') {
    if (dc === 'insufficient_funds') return { key: 'charge:insufficient_funds', label: '充值·余额不足', recoverable: true, note: '卡可能真没钱 → 换卡或核对卡池余额;同卡再试多半仍不足。' };
    if (dc) return { key: 'charge:' + dc, label: '充值·' + (DECLINE_LABEL[dc] || dc), recoverable: true, note: '多为 Stripe 风控/环境 → 换卡+换IP+ZIP 重试【争取,非保证】。' };
    return { key: 'charge:declined', label: '充值·拒付', recoverable: true, note: '多为 Stripe 风控/环境 → 换卡+换IP 重试【争取,非保证】。' };
  }
  if (stage === 'card') {
    if (/hcaptcha/i.test(reason) || a.failClass === 'swap' || a.failClass === 'solve') return { key: 'card:hcaptcha', label: '加卡·hCaptcha', recoverable: true, note: '隐形框硬解常无效 → 换卡(swap)重试。' };
    return { key: 'card', label: '加卡失败', recoverable: true, note: '换IP/换卡重试可救回一部分。' };
  }
  if (stage === 'key') return { key: 'key', label: '取 Key 失败', recoverable: true, note: '换IP重试(本次保持源引擎,跨引擎换会绕过防双扣门)。' };
  if (stage === 'register') return { key: 'register', label: '注册失败', recoverable: true, note: '换IP重试。' };
  if (stage === 'changepw') return { key: 'changepw', label: '改密失败', recoverable: true, note: '邮箱密钥/旧密码问题,重试或个案看。' };
  return { key: stage || 'other', label: stage || '其它', recoverable: true, note: '重试争取。' };
}

// ── 失败主因 → 推荐恢复方案(批量恢复弹窗自动选)──────────────────────────────
//   与后端内置方案 id 对齐(recovery-store.js BUILTIN_PRESETS)。
const RECOMMEND_PROFILE = (reasonKey: string): string => {
  if (reasonKey === 'charge:insufficient_funds' || reasonKey === 'card:hcaptcha') return 'r_swap_card';
  if (reasonKey.startsWith('charge') || reasonKey === 'card') return 'r_swap_env';
  return 'r_swap_ip';   // key / register / changepw / other → 换IP
};
// 「加力再恢复」:已是一次恢复跑仍失败 → 升一档(换IP→换环境→换卡)
const ESCALATE_PROFILE: Record<string, string> = { r_swap_ip: 'r_swap_env', r_swap_env: 'r_swap_card', r_swap_card: 'r_swap_card' };
// 方案 → 失败表「分类」列显示的简短【恢复动作】(替代误导的 hcap_mode)
const PROFILE_SHORT: Record<string, string> = { r_swap_env: '换环境', r_swap_card: '换卡', r_swap_ip: '换IP', r_default: '重试' };
// 一条失败行的恢复动作类(分类列):不可恢复→「不可恢复」,否则按推荐方案给简短动作
function actionClassOf(ri: ReasonInfo): string {
  if (!ri.recoverable) return '不可恢复';
  return PROFILE_SHORT[RECOMMEND_PROFILE(ri.key)] || '重试';
}
