// 改密存档查看器:展示 pw-changes 账本的审计 log(每次「更新邮箱/OpenRouter 密码」一条)。
// 只读;打开时拉取最近若干条(新→旧)。from→to 为改前/改后密码(本地数据,与结果表同密级)。
import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { useToast } from '../lib/toast';
import { apiGet } from '../lib/api';
import type { PwLogEntry, PwLogResp } from '../lib/types';

const TYPE_LABEL: Record<string, string> = { mailbox: '邮箱', openrouter: 'OpenRouter' };

export function PwChangeLogModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [log, setLog] = useState<PwLogEntry[]>([]);
  const [total, setTotal] = useState(0);   // 存档总条数 → >已加载时诚实标注被截断
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    apiGet<PwLogResp>('/api/accounts/pw-log?limit=500', true)
      .then((r) => { setLog(r.log || []); setTotal(r.total ?? (r.log || []).length); })
      .catch((e) => toast.push('读改密存档失败:' + (e as Error).message, 'err'))
      .finally(() => setLoading(false));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal open={open} onClose={onClose} size="lg" icon="edit"
      title={<>改密存档 <span className="dim">— {total > log.length ? `最近 ${log.length} / 共 ${total}` : `共 ${log.length}`} 条(新→旧)</span></>}
      foot={<button className="btn btn-ghost" onClick={onClose}>关闭</button>}>
      <div className="modal-body">
        <p className="modal-intro">每次「更新邮箱密码 / OpenRouter 密码」都留一条审计(含成败与原因)。仅本机存档,落盘 data/pw-changes.json。</p>
        <div className="tbl-wrap" style={{ maxHeight: 460 }}>
          <table className="tbl">
            <thead><tr><th>时间</th><th>邮箱</th><th>类型</th><th>改前→改后</th><th>结果</th><th>方式</th><th>原因</th></tr></thead>
            <tbody>
              {log.length ? log.map((e, i) => (
                <tr key={i}>
                  <td className="mono" style={{ color: 'var(--text-3)' }}>{(e.at || '').replace('T', ' ').slice(0, 19)}</td>
                  <td className="mono">{e.email}</td>
                  <td>{TYPE_LABEL[e.type] || e.type}</td>
                  <td className="mono" style={{ color: 'var(--text-2)' }}>{e.from || '—'} <span className="dim">→</span> {e.to || '—'}</td>
                  <td>{e.ok ? <span className="kbadge ok">成功</span> : <span className="kbadge fail">失败</span>}</td>
                  <td className="dim">{e.by === 'batch' ? '批量' : e.by === 'single' ? '单个' : (e.by || '—')}</td>
                  <td className="dim" style={{ fontSize: 12 }}>{e.reason || ''}</td>
                </tr>
              )) : <tr><td colSpan={7} className="tbl-empty">{loading ? '加载中…' : '暂无改密记录'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}
