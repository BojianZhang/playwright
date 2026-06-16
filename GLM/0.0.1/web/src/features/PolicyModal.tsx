// 错误策略表(移植自旧 modals.js setupErrors):加载 /api/policy effective,行内改动作/重试次数→保存覆盖、重置。
import { useEffect, useRef, useState } from 'react';
import { Modal } from '../components/Modal';
import { Icon } from '../lib/icons';
import { apiGet, apiPost } from '../lib/api';
import { useToast } from '../lib/toast';
import type { PolicyAction, PolicyResp, PolicyRow } from '../lib/types';

const ACTION_LABEL: Record<string, string> = { retry: '同代理重试', 'retry-new-proxy': '换代理重试', relogin: '重新登录', blacklist: '拉黑(不重试)', abort: '放弃' };

export function PolicyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<PolicyRow[]>([]);
  const [actions, setActions] = useState<PolicyAction[]>(['retry', 'retry-new-proxy', 'relogin', 'blacklist', 'abort']);
  const [loading, setLoading] = useState(false);
  // 行内待保存草稿(code → {action,maxRetries})
  const draft = useRef<Record<string, { action: PolicyAction; maxRetries: number }>>({});

  async function load() {
    setLoading(true);
    try {
      const d = await apiGet<PolicyResp>('/api/policy', true);
      if (Array.isArray(d.actions) && d.actions.length) setActions(d.actions);
      setRows(d.policy || []);
      draft.current = {};
    } catch { toast.push('错误策略加载失败(检查令牌)', 'err'); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (open) load(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const settable = rows.filter((p) => p.settable !== false && !String(p.code).startsWith('_'));
  const fallback = rows.filter((p) => p.settable === false || String(p.code).startsWith('_'));

  async function save(code: string, fallbackEff: { action: PolicyAction; maxRetries: number }) {
    const d = draft.current[code] || fallbackEff;
    try {
      const r = await apiPost<PolicyResp>('/api/policy/set', { code, action: d.action, maxRetries: d.maxRetries });
      setRows(r.policy || []); delete draft.current[code]; toast.push(`${code} 已保存`, 'ok');
    } catch (e) { toast.push('保存失败:' + (e as Error).message, 'err'); }
  }
  async function reset(code?: string) {
    try { const r = await apiPost<PolicyResp>('/api/policy/reset', code ? { code } : {}); setRows(r.policy || []); if (code) delete draft.current[code]; else draft.current = {}; }
    catch (e) { toast.push('重置失败:' + (e as Error).message, 'err'); }
  }

  return (
    <Modal open={open} onClose={onClose} size="lg" icon="alert"
      title={<>错误策略 <span className="dim">/ 说明</span></>}
      foot={<>
        <button className="btn btn-ghost" onClick={() => { if (confirm('把所有错误策略恢复为内置默认?')) reset(); }}><Icon name="refresh" size={14} />全部重置为内置</button>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={onClose}>完成</button>
      </>}>
      <div className="modal-body">
        <p className="modal-intro">每个错误对应一条恢复流程。可改「动作」和「重试次数」覆盖内置默认,改完点该行「保存」。最下方「兜底桶」是未知报错文本按关键字归类的规则(不可单独配置)。错误的实际发生记录见控制台的「错误记录」面板。</p>
        {loading ? <div className="empty-note">加载中…</div> : (
          <>
            <div>
              {settable.map((p) => {
                const eff = p.effective || { action: 'retry' as PolicyAction, maxRetries: 0 };
                const overridden = !!p.override;
                const d = draft.current[p.code];
                const dirty = !!d && (d.action !== eff.action || d.maxRetries !== eff.maxRetries);
                return (
                  <div className="erow" key={p.code}>
                    <div><div className="ecode">{p.code}</div><div className="edesc">{p.why || ''}</div></div>
                    <select className="esel" defaultValue={eff.action}
                      onChange={(e) => { draft.current[p.code] = { action: e.target.value as PolicyAction, maxRetries: (draft.current[p.code]?.maxRetries ?? eff.maxRetries) }; setRows((r) => [...r]); }}>
                      {actions.map((a) => <option key={a} value={a}>{ACTION_LABEL[a] || a}</option>)}
                    </select>
                    <input className="eretry" type="number" min={0} max={10} defaultValue={eff.maxRetries}
                      onChange={(e) => { draft.current[p.code] = { action: (draft.current[p.code]?.action ?? eff.action), maxRetries: Number(e.target.value) || 0 }; setRows((r) => [...r]); }} />
                    <span className={'ebadge ' + (dirty ? 'changed' : overridden ? 'changed' : 'neutral')}>{dirty ? '待保存' : overridden ? '已覆盖' : '内置'}</span>
                    <button className="btn btn-soft btn-sm" onClick={() => save(p.code, eff)}>保存</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => reset(p.code)}>重置</button>
                  </div>
                );
              })}
            </div>
            <div className="erow-grouphd">兜底桶 · 未知报错归类</div>
            <div>
              {fallback.map((p) => (
                <div className="erow fallback" key={p.code}>
                  <div><div className="ecode">{p.code}</div><div className="edesc">{p.why || ''}</div></div>
                  <span className="fb-act">{ACTION_LABEL[(p.effective || {}).action || ''] || (p.effective || {}).action || ''}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
