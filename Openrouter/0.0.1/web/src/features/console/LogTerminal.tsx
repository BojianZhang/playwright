// 「实时终端」运行日志面板:把朴素的 io-box 日志升级成深色终端样式(窗口栏 + 严重度色轨 + 动效流入 + 活动光标)。
// 纯展示 + 纯 CSS 动效(不引入 framer-motion/tailwind;严守本控制台「零依赖手写」约定),图标用本仓 Icon。
// 严重度从 LogLine.cls + 文案推导(不动 useJobStream 的 SSE 热路径)。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../lib/icons';
import type { LogLine } from '../../lib/useJobStream';

type Level = 'info' | 'ok' | 'warn' | 'err';

// 推导严重度:失败标记 / 文案关键词。顺序 = err → warn → 连接信息(info) → 成功(ok) → 兜底 info。
function levelOf(l: LogLine): Level {
  if (l.cls === 'ln-fail') return 'err';
  const m = l.msg || '';
  if (/✗|失败|错误|无法|拒|declin|\berror\b|\bfail/i.test(m)) return 'err';
  if (/中断|重连|重试|超时|警告|稍后|降级|\bwarn|timeout|retry/i.test(m)) return 'warn';
  if (/已连接|连接|connected|\bsse\b/i.test(m)) return 'info';
  if (l.cls === 'ln-ok' || /✓|成功|完成|结束|■|\bdone\b|\bok\b/i.test(m)) return 'ok';
  return 'info';
}

const META: Record<Level, { tag: string; icon: string }> = {
  info: { tag: 'INFO', icon: 'info' },
  ok: { tag: 'OK', icon: 'okcircle' },
  warn: { tag: 'WARN', icon: 'alert' },
  err: { tag: 'ERR', icon: 'xcircle' },
};
const ORDER: Level[] = ['info', 'ok', 'warn', 'err'];

export default function LogTerminal({ logs, running, jobId }: { logs: LogLine[]; running: boolean; jobId: string | null }) {
  // 稳定行 id:useJobStream 用 slice 续传,既有 LogLine 对象引用跨渲染不变 → WeakMap 派发单调 id。
  // 这样最新行必是「新挂载」→ 触发流入动效(即便已到 200 上限),旧行原位不重放、溢出者干净卸载。
  const idMap = useRef(new WeakMap<LogLine, number>());
  const seqRef = useRef(0);
  const items = useMemo(
    () =>
      logs.map((l) => {
        let id = idMap.current.get(l);
        if (id == null) {
          id = ++seqRef.current;
          idMap.current.set(l, id);
        }
        return { line: l, lv: levelOf(l), id };
      }),
    [logs],
  );
  const counts = useMemo(() => {
    const c: Record<Level, number> = { info: 0, ok: 0, warn: 0, err: 0 };
    for (const it of items) c[it.lv]++;
    return c;
  }, [items]);

  const [only, setOnly] = useState<Set<Level>>(new Set());
  const view = useMemo(() => (only.size ? items.filter((it) => only.has(it.lv)) : items), [items, only]);
  const toggle = (lv: Level) =>
    setOnly((prev) => {
      const next = new Set(prev);
      next.has(lv) ? next.delete(lv) : next.add(lv);
      return next;
    });

  // 智能自动滚动:贴底时跟随最新;用户上滚阅读历史则不抢滚动,改显「↓ 最新」。
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [stuck, setStuck] = useState(true);
  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
    stickRef.current = near;
    setStuck(near);
  };
  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [view]);
  const jumpLatest = () => {
    const el = bodyRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      stickRef.current = true;
      setStuck(true);
    }
  };

  const path = `openrouter://run/${jobId ? jobId.slice(0, 8) : 'session'}.log`;

  return (
    <div className="logterm" data-running={running ? '1' : undefined}>
      <div className="lt-bar">
        <span className="lt-dots" aria-hidden>
          <i /><i /><i />
        </span>
        <span className="lt-path" title={jobId || ''}>{path}</span>
        <span className="lt-meta">
          {ORDER.map((lv) => (
            <button
              key={lv}
              type="button"
              className={'lt-flt lt-' + lv + (only.has(lv) ? ' on' : '')}
              onClick={() => toggle(lv)}
              title={(only.has(lv) ? '取消筛选 ' : '只看 ') + META[lv].tag}
              disabled={!counts[lv]}
            >
              <i className="lt-swatch" />
              {counts[lv]}
            </button>
          ))}
          <span className={'lt-live' + (running ? ' on' : '')}>
            <i className="lt-pulse" />
            {running ? 'LIVE' : 'IDLE'}
          </span>
        </span>
      </div>

      <div className="lt-body" ref={bodyRef} onScroll={onScroll} role="log" aria-live="polite" tabIndex={0}>
        {view.length ? (
          view.map((it, i) => {
            const last = running && i === view.length - 1;
            return (
              <div className="lt-ln" data-lv={it.lv} key={it.id}>
                <span className="lt-ts">{it.line.ts}</span>
                <span className="lt-tag">
                  <Icon name={META[it.lv].icon} size={12} />
                  <span className="lt-tagtxt">[{META[it.lv].tag}]</span>
                </span>
                <span className="lt-msg">
                  {it.line.msg}
                  {last ? <i className="lt-cur" aria-hidden /> : null}
                </span>
              </div>
            );
          })
        ) : (
          <div className="lt-empty">
            <span className="lt-prompt">$</span>
            {only.size ? '该严重度暂无日志 —— 点上方徽标取消筛选。' : running ? ' 监听中,等待第一条日志…' : ' 等待开始 —— 点上方「开始执行」后,运行日志会实时流入这里。'}
            {running && !only.size ? <i className="lt-cur" aria-hidden /> : null}
          </div>
        )}
      </div>

      <div className="lt-fade" aria-hidden />

      {!stuck && view.length ? (
        <button type="button" className="lt-jump" onClick={jumpLatest}>
          <Icon name="arrow" size={12} style={{ transform: 'rotate(90deg)' }} />最新
        </button>
      ) : null}
    </div>
  );
}
