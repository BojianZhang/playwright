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
import type { RunDetailResp, StartJobResp } from '../lib/types';
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
  const copy = (txt: string) => navigator.clipboard.writeText(txt).then(() => toast.push('已复制', 'ok'), () => toast.push('复制失败', 'err'));

  // 「续跑这批」:中断/异常的 Python 任务,后端用残留输入强制 resume 重起 → 跳控制台实时显示。
  const canResume = !!s && PY_ENGINES.includes(s.engine || '') && (s.status === 'interrupted' || s.status === 'error');
  async function resume() {
    if (resuming) return;
    setResuming(true);
    try {
      const d = await apiPost<StartJobResp>('/api/run/resume', { jobId, engine: s?.engine });
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
          <button className="btn btn-primary btn-sm" disabled={resuming} onClick={resume} title="用这批账号断点续跑:自动跳过已完成的号,只跑没跑完的;跑起后跳到控制台看实时进度">
            <Icon name="refresh" size={13} />{resuming ? '续跑中…' : '续跑这批'}
          </button>
        )}
      </div>

      {isLoading ? <div className="card card-pad"><div className="empty-note">加载中…</div></div> : !s ? (
        <div className="card card-pad"><div className="empty-note">未找到该任务的汇总(可能历史已清或 jobId 有误)。仍可查看下方 batch-results 明细(若有)。</div></div>
      ) : (
        <section className="card statbar" style={{ gridTemplateColumns: 'repeat(5,1fr)' }}>
          <div className="stat-cell s-total"><div className="num">{s.total}</div><div className="lbl">账号总数</div></div>
          <div className="stat-cell s-ok"><div className="num">{s.success}</div><div className="lbl">成功</div></div>
          <div className="stat-cell s-fail"><div className="num">{s.failed}</div><div className="lbl">失败</div></div>
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
                <span className="err-chip" title={'本次高级参数: ' + JSON.stringify(s.params.configSnapshot.advanced || {})}>
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
              <button className="btn btn-ghost btn-sm" disabled={!success.length} onClick={() => downloadCsv('run-success', ['邮箱', 'API Key', '账单', '充值', '卡末4', '出口IP', '现密码'], success.map((a) => [a.email || '', a.apiKey || '', a.billingStatus || '', a.charged != null ? a.charged : '', a.cardLast4 || '', a.exitIp || '', a.password || '']))}><Icon name="download" size={12} />.csv</button>
              <button className="btn btn-ghost btn-sm" disabled={!success.length} onClick={() => window.open(withToken(`/download?jobId=${encodeURIComponent(jobId)}`), '_blank')}><Icon name="download" size={12} />.txt</button>
            </div>
          </div>
          <div className="panel-sec" style={{ paddingTop: 8 }}>
            {!success.length ? <div className="empty-note">无成功账号。</div> : (
              <div className="tbl-wrap" style={{ maxHeight: 460 }}>
                <table className="tbl">
                  <thead><tr><th>邮箱</th><th>API Key</th><th>账单</th><th>充值</th><th>卡末4</th><th>出口IP</th></tr></thead>
                  <tbody>
                    {success.map((a, i) => (
                      <tr key={i}>
                        <td className="mono">{a.email}</td>
                        <td className="mono" style={{ color: 'var(--primary-text)' }} title={a.apiKey}>{trunc(a.apiKey, 20)}</td>
                        <td>{a.billingStatus === 'success' ? <span className="kbadge ok">success</span> : a.billingStatus ? <span className="kbadge warn">{a.billingStatus}</span> : <span className="kbadge neutral">—</span>}</td>
                        <td className="mono">{a.charged != null ? '$' + a.charged : '—'}</td>
                        <td className="mono">{a.cardLast4 ? '•••• ' + a.cardLast4 : '—'}</td>
                        <td className="mono" style={{ color: 'var(--text-2)' }}>{a.exitIp || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        {/* 失败 */}
        <section className="card">
          <div className="card-head"><span className="idx c-amber"><Icon name="xcircle" size={12} /></span><h3>失败账号 <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>{failed.length}</span></h3>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button className="btn btn-ghost btn-sm" disabled={!failed.length} onClick={() => copy(failed.map((a) => `${a.email || ''}:${a.originalPassword || a.password || ''}`).join('\n'))}>复制 邮箱:原密码</button>
              <button className="btn btn-ghost btn-sm" disabled={!failed.length} onClick={() => downloadCsv('run-failed', ['邮箱', '原因', '阶段', '分类', '尝试', '出口/代理', '原密码'], failed.map((a) => [a.email || '', a.reason || '', a.stage || '', a.failClass || '', a.attempts ?? '', a.proxy || '', a.originalPassword || a.password || '']))}><Icon name="download" size={12} />.csv</button>
              <button className="btn btn-ghost btn-sm" disabled={!failed.length} onClick={() => window.open(withToken(`/download?type=failed&jobId=${encodeURIComponent(jobId)}`), '_blank')}><Icon name="download" size={12} />.txt</button>
            </div>
          </div>
          <div className="panel-sec" style={{ paddingTop: 8 }}>
            {!failed.length ? <div className="empty-note">无失败账号。</div> : (
              <div className="tbl-wrap" style={{ maxHeight: 460 }}>
                <table className="tbl">
                  <thead><tr><th>邮箱</th><th>原因</th><th>阶段</th><th>分类</th><th>试</th><th>出口/代理</th></tr></thead>
                  <tbody>
                    {failed.map((a, i) => (
                      <tr key={i} className="is-banned">
                        <td className="mono">{a.email}</td>
                        <td className="mono" style={{ color: 'var(--danger)' }}>{a.reason}</td>
                        <td className="mono" style={{ color: 'var(--text-2)' }}>{a.stage || '—'}</td>
                        <td className="mono" style={{ color: 'var(--text-3)' }}>{a.failClass || '—'}</td>
                        <td className="mono">{a.attempts ?? '—'}</td>
                        <td className="mono" style={{ color: 'var(--text-3)' }} title={a.proxy}>{a.proxy ? String(a.proxy).split(':').slice(0, 2).join(':') : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
