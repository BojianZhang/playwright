// 任务 SSE 实时流 hook(移植自旧 controller.js openStream)。订阅 /events?jobId=,
// 把 worker-update/runtime-stats/account-success/account-failed/log/job-done 等事件归并成 React 状态。
import { useCallback, useEffect, useRef, useState } from 'react';
import { withToken } from './auth';
import type { AccountFailedEvt, JobDoneEvt, RuntimeStats } from './types';

export interface WorkerState { status?: string; stage?: string; account?: string; stageAt?: number; }
export interface LogLine { ts: string; msg: string; cls?: 'ln-ok' | 'ln-fail'; }

export interface JobStreamState {
  running: boolean;
  jobId: string | null;
  counters: { total: number; ok: number; fail: number };
  stats: { br: string; q: string; env: string; envBurned: number };
  workers: Record<number, WorkerState>;
  okLines: string[];
  failLines: string[];
  failed: AccountFailedEvt[];
  logs: LogLine[];
  done: JobDoneEvt | null;
}

const EMPTY: JobStreamState = {
  running: false, jobId: null,
  counters: { total: 0, ok: 0, fail: 0 },
  stats: { br: '0/0', q: '0', env: '0/0', envBurned: 0 },
  workers: {}, okLines: [], failLines: [], failed: [], logs: [], done: null,
};

function nowTs() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }

export interface JobStreamHandlers {
  onCardStats?: () => void;
  onBillingStats?: () => void;
  onFailureStats?: () => void;
  onAccountSuccess?: () => void;
  onAccountFailed?: () => void;
  onDone?: (s: JobDoneEvt) => void;
  onError?: () => void;
}

export function useJobStream(handlers: JobStreamHandlers = {}) {
  const [state, setState] = useState<JobStreamState>(EMPTY);
  const esRef = useRef<EventSource | null>(null);
  const hRef = useRef(handlers); hRef.current = handlers;

  const log = useCallback((msg: string, cls?: 'ln-ok' | 'ln-fail') => {
    setState((s) => ({ ...s, logs: [...s.logs.slice(-199), { ts: nowTs(), msg, cls }] }));   // 仅供展示(MonitorPanel 直接渲染,不再 slice)→ 状态即封顶 200,省热路径每帧重切
  }, []);

  const close = useCallback(() => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    setState((s) => ({ ...s, running: false }));
  }, []);

  const start = useCallback((jobId: string, total: number) => {
    if (esRef.current) esRef.current.close();
    setState({ ...EMPTY, running: true, jobId, counters: { total, ok: 0, fail: 0 } });
    const es = new EventSource(withToken(`/events?jobId=${encodeURIComponent(jobId)}`));
    esRef.current = es;
    const J = (e: MessageEvent) => { try { return JSON.parse(e.data); } catch { return null; } };

    es.addEventListener('connected', () => log(`SSE 已连接 (${jobId})`));
    es.addEventListener('log', (e) => log(String(J(e as MessageEvent) ?? '')));
    es.addEventListener('worker-update', (e) => {
      const w = (J(e as MessageEvent) || {}).worker || {};
      if (w.workerId == null) return;
      setState((s) => {
        const prev = s.workers[w.workerId] || {};
        const stage = w.stage ?? prev.stage;
        const status = w.status ?? prev.status;
        // 阶段(或 running→done)切换时记当前时刻 → 面板按它显示「当前阶段已用 Ns」(长阶段如加卡 ~80s 也看得到在动,不像冻结)。
        const stageChanged = stage !== prev.stage || (status !== prev.status);
        return { ...s, workers: { ...s.workers, [w.workerId]: { status, stage, account: w.account ?? prev.account, stageAt: stageChanged ? Date.now() : (prev.stageAt || Date.now()) } } };
      });
    });
    es.addEventListener('runtime-stats', (e) => {
      const x: RuntimeStats = J(e as MessageEvent) || {};
      setState((s) => ({ ...s, stats: { br: `${x.browsersActive || 0}/${x.browsersMax || 0}`, q: String(x.browsersQueued || 0), env: `${x.envBurned || 0}/${x.envTotal || 0}`, envBurned: x.envBurned || 0 } }));
    });
    es.addEventListener('account-success', (e) => {
      const d = J(e as MessageEvent) || {};
      setState((s) => ({ ...s, counters: { ...s.counters, ok: s.counters.ok + 1 }, okLines: [...s.okLines.slice(-199), d.rendered || JSON.stringify(d.raw || {})] }));   // 展示用,封顶 200(下载走后端 /download,非此数组)
      hRef.current.onAccountSuccess?.();
    });
    es.addEventListener('account-failed', (e) => {
      const d: AccountFailedEvt = J(e as MessageEvent) || {};
      setState((s) => ({ ...s, counters: { ...s.counters, fail: s.counters.fail + 1 }, failLines: [...s.failLines.slice(-199), d.rendered || `${d.email || ''} | ${d.reason || ''}`], failed: [...s.failed.slice(-1999), d] }));   // failLines 展示封顶 200;★failed 保留 1999(喂「重跑登录」requeue 需全量)
      log(`✗ ${d.email || ''} → ${d.reason || ''} (${d.failClass || ''})`, 'ln-fail');
      hRef.current.onAccountFailed?.();
    });
    es.addEventListener('card-stats', () => hRef.current.onCardStats?.());
    es.addEventListener('billing-stats', () => hRef.current.onBillingStats?.());
    es.addEventListener('failure-stats', () => hRef.current.onFailureStats?.());
    es.addEventListener('job-done', (e) => {
      const s: JobDoneEvt = J(e as MessageEvent) || {};
      log(`■ 任务结束:成功 ${s.success || 0} · 失败 ${s.failed || 0} · 用时 ${s.durationMs || 0}ms`, 'ln-ok');
      setState((st) => ({ ...st, running: false, done: s }));
      hRef.current.onDone?.(s);
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
    });
    es.onerror = () => {
      // readyState===CLOSED = 永久断开(服务重启/401/内容类型不符,浏览器放弃重连)。
      // 此时 job-done 不会再来,必须复位 running,否则按钮永远停在「停止」、进度永不结束。
      if (es.readyState === EventSource.CLOSED) {
        log('SSE 连接已断开,停止监听(服务可能已重启)');
        esRef.current = null;
        setState((s) => ({ ...s, running: false }));
        hRef.current.onError?.();
      } else {
        log('SSE 连接中断,重连中…'); // CONNECTING:浏览器会自动重连,不复位
      }
    };
  }, [log]);

  useEffect(() => () => { if (esRef.current) esRef.current.close(); }, []);

  return { state, start, close, log };
}
