// 结果聚合页「更新邮箱密码 / 更新 OpenRouter 密码」确认弹窗(单个 + 批量共用)。
//  - 改前确认:列出受影响账号 + 输新密码(两遍确认)→ 点「确认执行」才真改。
//  - 邮箱密码:走后端 /api/accounts/change-pw(firstmail API),逐号回成败。
//  - OpenRouter 密码:Phase B(浏览器自动化)未交付 → 弹窗明示 + 执行禁用,不静默假成功。
//  - 改成功后,新密码=现密码、改前值降级为原密码(后端 pw-changes 账本滚动 + 存档),弹窗关闭后父组件刷新四列。
import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { Icon } from '../lib/icons';
import { useToast } from '../lib/toast';
import { apiPost } from '../lib/api';
import type { PwChangeType, PwChangeResp } from '../lib/types';

export interface PwTarget { email: string; current: string; }   // 受影响账号 + 各自「改前现密码」(=认证用当前密码)

const LABEL: Record<PwChangeType, string> = { mailbox: '邮箱密码', openrouter: 'OpenRouter 密码' };

export function ChangePwModal({ open, onClose, type, targets, onDone }: {
  open: boolean; onClose: () => void;
  type: PwChangeType; targets: PwTarget[];
  onDone: () => void;   // 有任意成功后回调:父组件重新聚合 + 拉覆盖账本刷新四列
}) {
  const toast = useToast();
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PwChangeResp | null>(null);

  // 每次打开重置(避免上次的新密码/结果残留)
  useEffect(() => { if (open) { setNewPw(''); setConfirmPw(''); setResult(null); setBusy(false); } }, [open, type]);

  const isOR = type === 'openrouter';
  const n = targets.length;
  const mismatch = confirmPw.length > 0 && newPw !== confirmPw;
  const canRun = !isOR && !busy && n > 0 && newPw.length > 0 && newPw === confirmPw;

  async function run() {
    if (!canRun) return;
    setBusy(true); setResult(null);
    try {
      const resp = await apiPost<PwChangeResp>('/api/accounts/change-pw', {
        type,
        items: targets.map((t) => ({ email: t.email, current: t.current, next: newPw })),
      });
      setResult(resp);
      if (resp.ok > 0) toast.push(`${LABEL[type]}:成功 ${resp.ok} / 失败 ${resp.fail}`, resp.fail ? 'info' : 'ok');
      else toast.push(`${LABEL[type]}:全部失败(${resp.fail})`, 'err');
      onDone();   // 不论成败都刷新四列:成功要反映滚动后的新现密码,全失败也刷新保持覆盖账本/列表一致
    } catch (e) {
      toast.push('改密失败:' + (e as Error).message, 'err');
    } finally { setBusy(false); }
  }

  const failed = result ? result.results.filter((r) => !r.ok) : [];

  return (
    <Modal open={open} onClose={onClose} size="md" icon={isOR ? 'shield' : 'mail'} iconKind={isOR ? 'fail' : undefined}
      title={<>更新{LABEL[type]} <span className="dim">— {n} 个账号</span></>}
      foot={<>
        <button className="btn btn-ghost" onClick={onClose}>{result ? '关闭' : '取消'}</button>
        <div className="spacer" />
        {!isOR && (
          <button className="btn btn-primary" disabled={!canRun} onClick={run}>
            <Icon name="lock" size={14} /> {busy ? '执行中…' : `确认执行(${n})`}
          </button>
        )}
      </>}>
      <div className="modal-body">
        {isOR ? (
          <div className="m-field">
            <div className="banner banner-warn" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: 12, border: '1px solid var(--warn, #b8860b)', borderRadius: 8 }}>
              <Icon name="alert" size={16} />
              <div>
                <b>OpenRouter 改密为 Phase B(浏览器自动化),尚未交付。</b>
                <div className="dim" style={{ marginTop: 4, fontSize: 12, lineHeight: 1.5 }}>
                  改 OpenRouter 登录密码需逐号建环境登录、改 Clerk 安全设置,可能触发风控/二次验证,真站未验证过。
                  当前仅展示入口,执行已禁用。邮箱密码可正常更改。
                </div>
              </div>
            </div>
          </div>
        ) : (
          <p className="modal-intro">
            将把选中 <b>{n}</b> 个账号的<b>邮箱密码</b>改为下方新密码(走 Firstmail API)。
            改成功后:新密码记为<b>现密码</b>,改前的值自动降级为<b>原密码</b>,并写入改密存档。此操作真实生效,请确认。
          </p>
        )}

        {!isOR && (
          <>
            <div className="m-field">
              <div className="m-label">新密码</div>
              <input type="text" autoComplete="off" spellCheck={false} value={newPw} placeholder="所有选中账号统一改成此密码"
                style={{ width: '100%', fontFamily: 'var(--mono, monospace)' }} onChange={(e) => setNewPw(e.target.value)} />
            </div>
            <div className="m-field">
              <div className="m-label">确认新密码</div>
              <input type="text" autoComplete="off" spellCheck={false} value={confirmPw} placeholder="再输一遍,防手误"
                style={{ width: '100%', fontFamily: 'var(--mono, monospace)' }} onChange={(e) => setConfirmPw(e.target.value)} />
              {mismatch && <div style={{ color: 'var(--danger, #d33)', fontSize: 12, marginTop: 4 }}>两次输入不一致</div>}
            </div>
          </>
        )}

        <div className="m-field">
          <div className="m-label">受影响账号 <span className="dim">({n})</span></div>
          <div className="tbl-wrap" style={{ maxHeight: 200 }}>
            <table className="tbl">
              <thead><tr><th>邮箱</th><th>改前现密码</th></tr></thead>
              <tbody>
                {targets.slice(0, 200).map((t) => {
                  const r = result?.results.find((x) => x.email === t.email);
                  return (
                    <tr key={t.email}>
                      <td className="mono">{t.email}{r && (r.ok ? <span className="kbadge ok" style={{ marginLeft: 6 }}>已改</span> : <span className="kbadge fail" style={{ marginLeft: 6 }} title={r.reason}>失败</span>)}</td>
                      <td className="mono" style={{ color: 'var(--text-3)' }}>{t.current || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {n > 200 && <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>列表仅预览前 200 个,执行仍覆盖全部 {n} 个。</div>}
        </div>

        {result && failed.length > 0 && (
          <div className="m-field">
            <div className="m-label" style={{ color: 'var(--danger, #d33)' }}>失败 {failed.length} 个(原因)</div>
            <div className="tbl-wrap" style={{ maxHeight: 140 }}>
              <table className="tbl">
                <tbody>
                  {failed.slice(0, 100).map((r) => (
                    <tr key={r.email}><td className="mono">{r.email}</td><td className="dim" style={{ fontSize: 12 }}>{r.reason || '失败'}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
