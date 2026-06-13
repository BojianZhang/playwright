// 执行 & 监控(原 ConsolePage zone B 整块):运行条 + 统计条 + 工作线程/成败/日志 tabs。
// 与向导同级常驻 —— 切步不会 unmount 它,SSE 连接和进度不丢。
import { useMemo, useState } from 'react';
import { Icon } from '../../lib/icons';
import { withToken } from '../../lib/auth';
import type { JobStreamState } from '../../lib/useJobStream';
import { PoolTab, LedgerTab, StatusTab, ErrorsTab } from '../panels';
import { ENGINE_LABEL, STAGE_LABELS, STAGE_ORDER, type Engine, type TabKey } from './shared';

export default function MonitorPanel({ state, isPython, engine, submitting, jobId, runHint, onRun, requeue, onOpenPolicy }: {
  state: JobStreamState; isPython: boolean; engine: Engine; submitting?: boolean; jobId: string | null;
  runHint: { html?: string; danger?: boolean }; onRun: () => void; requeue: () => void; onOpenPolicy: () => void;
}) {
  const [tab, setTab] = useState<TabKey>('logs');   // 默认「运行日志」(空),不再一打开就糊一大张卡池表
  const failed = state.failed;

  const workerRows = useMemo(() => {
    const ids = Object.keys(state.workers).map(Number).sort((a, b) => a - b);
    return ids.map((id) => {
      const w = state.workers[id];
      const idx = STAGE_ORDER.indexOf(w.stage || '');
      const pct = w.status === 'done' ? 100 : Math.max(2, Math.round(((idx < 0 ? 0 : idx) / (STAGE_ORDER.length - 1)) * 100));
      const stage = STAGE_LABELS[w.stage || ''] || w.stage || w.status || '';
      return { id, account: w.account || '', stage, pct };
    });
  }, [state.workers]);
  const aliveCount = workerRows.filter((w) => { const s = state.workers[w.id]; return s && s.status !== 'done' && s.status !== 'idle' && s.status !== 'failed'; }).length;

  const Stat = ({ cls, val, label }: { cls: string; val: string | number; label: React.ReactNode }) => (
    <div className={'stat-cell ' + cls}><div className="num" style={cls === 's-env' && state.stats.envBurned > 0 ? { color: 'var(--danger)' } : undefined}>{val}</div><div className="lbl">{label}</div></div>
  );

  return (
    <>
      <div className="zone" id="run-zone"><span className="z-no">B</span><h2>执行 &amp; 监控</h2><span className="z-hint">运行状态实时回显</span><span className="z-line" /></div>

      {/* 运行条 */}
      <section className="card">
        <div className="runbar">
          <button className={'btn btn-lg ' + (state.running ? 'btn-danger-soft' : 'btn-primary')} onClick={onRun} disabled={submitting}>
            <Icon name={submitting ? 'refresh' : (state.running ? 'pause' : 'play')} size={16} />{submitting ? '提交中…' : (state.running ? '停止' : '开始执行')}
          </button>
          <span className="run-hint" dangerouslySetInnerHTML={{ __html: runHint.html || '填好上方配置后点 <b>开始执行</b>。运行中可随时暂停,断点续跑保证不重复扣费。' }} style={runHint.danger ? { color: 'var(--danger)' } : undefined} />
        </div>
      </section>

      <div className="section-gap" />

      {/* 统计条:Python 引擎不上报 浏览器/排队/环境,改显「进度」;Playwright 才显示那 3 格 */}
      <section className="card statbar" style={{ gridTemplateColumns: `repeat(${isPython ? 4 : 6}, 1fr)` }}>
        <Stat cls="s-total" val={state.counters.total} label="总数" />
        <Stat cls="s-ok" val={state.counters.ok} label="成功" />
        <Stat cls="s-fail" val={state.counters.fail} label="失败" />
        {isPython ? (
          <Stat cls="s-br" val={`${state.counters.ok + state.counters.fail}/${state.counters.total}`} label={<>进度 <span style={{ color: 'var(--text-3)' }}>完成 / 总</span></>} />
        ) : (
          <>
            <Stat cls="s-br" val={state.stats.br} label={<>浏览器 <span style={{ color: 'var(--text-3)' }}>在用 / 上限</span></>} />
            <Stat cls="s-q" val={state.stats.q} label="排队中" />
            <Stat cls="s-env" val={state.stats.env} label={<>环境 <span style={{ color: 'var(--text-3)' }}>弃用 / 总</span></>} />
          </>
        )}
      </section>

      <div className="section-gap" />

      {/* 监控面板 */}
      <section className="card">
        {isPython ? (
          <div className="panel-sec">
            <div className="panel-sec-head"><span className="ps-title"><Icon name="activity" size={14} style={{ color: 'var(--primary)' }} />实时进度</span></div>
            <div className="worker-empty">{ENGINE_LABEL[engine]} 引擎按【运行日志】展示实时进度(见下方标签);成败计数见上方统计条。{state.running ? ' 运行中…' : ''}</div>
          </div>
        ) : (
          <div className="panel-sec">
            <div className="panel-sec-head"><span className="ps-title"><Icon name="cpu" size={14} style={{ color: 'var(--primary)' }} />工作线程实时状态</span><span className="cnt-pill" style={{ marginLeft: 8 }}>{aliveCount} 个线程</span></div>
            <div>
              {!workerRows.length ? <div className="worker-empty">尚未开始 —— 在上方填好配置后点 <b style={{ color: 'var(--text)' }}>「开始执行」</b>,每个浏览器线程的实时进度会显示在这里。</div> :
                workerRows.map((w) => (
                  <div className="worker-row" key={w.id}>
                    <span className="wid">#{w.id}</span>
                    <div><div className="wmail">{w.account}</div><div className="wstage">阶段:{w.stage}</div></div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="wbar"><i style={{ width: w.pct + '%' }} /></div><span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)', minWidth: 34, textAlign: 'right' }}>{w.pct}%</span></div>
                  </div>
                ))}
            </div>
          </div>
        )}

        <div className="panel-sec">
          <div className="io-grid">
            <div>
              <div className="panel-sec-head" style={{ marginBottom: 8 }}>
                <span className="ps-title ok"><Icon name="okcircle" size={14} />成功账号</span>
                <div className="right"><button className="btn btn-ghost btn-sm" disabled={!jobId || !state.okLines.length} onClick={() => jobId && window.open(withToken(`/download?jobId=${encodeURIComponent(jobId)}`), '_blank')}><Icon name="download" size={12} />下载</button></div>
              </div>
              <div className={'io-box' + (state.okLines.length ? '' : ' empty')}>{state.okLines.length ? state.okLines.map((l, i) => <div key={i} className="ln-ok">{l}</div>) : (state.running ? '运行中…' : '等待中…')}</div>
            </div>
            <div>
              <div className="panel-sec-head" style={{ marginBottom: 8 }}>
                <span className="ps-title fail"><Icon name="xcircle" size={14} />失败账号</span>
                <div className="right">
                  <button className="btn btn-ghost btn-sm" disabled={!jobId || !state.failLines.length} onClick={() => jobId && window.open(withToken(`/download?type=failed&jobId=${encodeURIComponent(jobId)}`), '_blank')}><Icon name="download" size={12} />下载</button>
                  <button className="btn btn-ghost btn-sm" disabled={!failed.length} onClick={requeue}><Icon name="refresh" size={12} />重跑(登录)</button>
                </div>
              </div>
              <div className={'io-box' + (state.failLines.length ? '' : ' empty')}>{state.failLines.length ? state.failLines.map((l, i) => <div key={i} className="ln-fail">{l}</div>) : (state.running ? '运行中…' : '等待中…')}</div>
            </div>
          </div>
        </div>

        <div className="tabs">
          {([['pool', '卡池统计'], ['ledger', '充值台账'], ['status', '账号状态 · 断点续跑'], ['errors', '错误记录'], ['logs', '运行日志']] as [TabKey, string][]).map(([k, label]) => (
            <button key={k} className={'tab' + (tab === k ? ' on' : '')} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
        <div className="tabpane on">
          {tab === 'pool' && <PoolTab />}
          {tab === 'ledger' && <LedgerTab />}
          {tab === 'status' && <StatusTab />}
          {tab === 'errors' && <ErrorsTab onOpenPolicy={onOpenPolicy} />}
          {tab === 'logs' && (
            <div className="io-box" style={{ minHeight: 200, maxHeight: 320 }}>
              {state.logs.length ? state.logs.map((l, i) => <div key={i}><span style={{ color: 'var(--text-4)' }}>{l.ts}</span>  <span className={l.cls}>{l.msg}</span></div>) : '等待开始…'}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
