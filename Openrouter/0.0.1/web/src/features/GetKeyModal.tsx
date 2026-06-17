// 结果聚合页「获取新Key」确认弹窗(单个 + 批量共用)。
//  - 对【已 card-bound 但 API Key 空】的号:登录已有账号 → 工作台新建一把 Key(旧 Key 明文不可再取回)。
//  - 走后端 /api/accounts/get-key → tools/get_new_key.py(纯 Selenium,逐号建环境登录取Key,服务端实时落盘)。
//  - ★只 登录 + 建Key,绝不 加卡/充值/改密 → 零扣款。新 Key 进 key-changes 覆盖账本,叠加到原行 API Key 列(原行账单/卡末4不变)。
//  - 引擎下拉当前仅启用「纯Selenium」(取Key核心 get_api_key 为纯 Selenium);并发对批量生效(服务端 clamp 到 AdsPower 上限)。
import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { Icon } from '../lib/icons';
import { useToast } from '../lib/toast';
import { apiGet, apiPost } from '../lib/api';
import type { GetKeyResp, KeyOverridesResp } from '../lib/types';

// 受影响账号 + 各自 OR 登录密码(orCur)+ 邮箱现密码(mbCur,读 factor-two 验证码用,可空)
export interface GetKeyTarget { email: string; opPw: string; mailboxPw: string; }

export function GetKeyModal({ open, onClose, targets, onDone }: {
  open: boolean; onClose: () => void;
  targets: GetKeyTarget[];
  onDone: () => void;   // 有任意成功后回调:父组件重新聚合 + 拉 key 覆盖账本刷新 API Key 列
}) {
  const toast = useToast();
  const [engine, setEngine] = useState('selenium');
  const [concurrency, setConcurrency] = useState(6);
  const [proxySource, setProxySource] = useState<'pool' | 'paste'>('pool');
  const [proxiesRaw, setProxiesRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GetKeyResp | null>(null);
  const [runStart, setRunStart] = useState('');   // 本次运行起点(ISO)→ 轮询覆盖账本算「已取回 X/N」
  const [recovered, setRecovered] = useState(0);

  // 每次打开重置(避免上次结果残留)
  useEffect(() => { if (open) { setResult(null); setBusy(false); setRecovered(0); setRunStart(''); } }, [open]);

  // 进度:busy 期间轮询 key-overrides,按 updatedAt 落在本次运行后的 target 数显示「已取回 X/N」(断连/超时也看得到已落盘进度)。
  useEffect(() => {
    if (!busy || !runStart) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await apiGet<KeyOverridesResp>('/api/accounts/key-overrides', true);
        const ov = r.overrides || {};
        let c = 0;
        for (const t of targets) { const o = ov[t.email]; if (o && o.updatedAt && o.updatedAt >= runStart) c += 1; }
        if (alive) setRecovered(c);
      } catch { /* 轮询失败忽略,下次再试 */ }
    };
    const id = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(id); };
  }, [busy, runStart, targets]);

  const n = targets.length;
  const needPaste = proxySource === 'paste' && !proxiesRaw.trim();
  const canRun = !busy && n > 0 && !needPaste;

  async function run() {
    if (!canRun) return;
    setBusy(true); setResult(null); setRecovered(0);
    setRunStart(new Date(Date.now() - 10000).toISOString());   // 留 10s 余量抗轻微时钟偏差,免漏算早完成的号
    try {
      const resp = await apiPost<GetKeyResp>('/api/accounts/get-key', {
        engine,
        concurrency,
        items: targets.map((t) => ({ email: t.email, password: t.opPw, mailboxPassword: t.mailboxPw })),
        proxiesRaw: proxySource === 'paste' ? proxiesRaw : undefined,
      });
      setResult(resp);
      if (resp.ok > 0) toast.push(`获取新Key:成功 ${resp.ok} / 失败 ${resp.fail}`, resp.fail ? 'info' : 'ok');
      else toast.push(`获取新Key:全部失败(${resp.fail})`, 'err');
      onDone();   // 不论成败都刷新:成功要叠加新 Key,全失败也刷新覆盖账本/列表状态保持一致(原仅 ok>0 才刷会漏掉对账)
    } catch (e) {
      toast.push('获取新Key失败:' + (e as Error).message, 'err');
    } finally { setBusy(false); }
  }

  const failed = result ? result.results.filter((r) => !r.ok) : [];

  return (
    <Modal open={open} onClose={onClose} size="md" icon="refresh"
      title={<>获取新 API Key <span className="dim">— {n} 个账号</span></>}
      foot={<>
        <button className="btn btn-ghost" onClick={onClose}>{result ? '关闭' : '取消'}</button>
        <div className="spacer" />
        <button className="btn btn-primary" disabled={!canRun} onClick={run}>
          <Icon name="refresh" size={14} /> {busy ? `执行中…(已取回 ${recovered}/${n})` : `开始获取(${n})`}
        </button>
      </>}>
      <div className="modal-body">
        <p className="modal-intro">
          对选中的 <b>{n}</b> 个【已绑卡但缺 Key】账号:逐号登录已有账号 → 在工作台<b>新建一把 Key</b>
          (OpenRouter 旧 Key 明文不可再取回,只能新建)。新 Key 叠加到该行 API Key 列,<b>账单/卡末4/充值信息不变</b>。
          <br />本操作<b>只登录 + 建 Key,绝不加卡/充值/改密(零扣款)</b>;登录用各号「OR现密码」,需可用代理池。
          <br />登录会触发<b>邮箱验证码(Check your email)</b> → 自动读各号<b>邮箱(Firstmail)</b>里的新验证码填入,
          因此用到各号「<b>邮箱现密码</b>」;邮箱密码读不到验证码的号会以 <code>login-fail:OTP</code> 失败(不会静默假成功)。
        </p>

        <div className="m-field">
          <div className="m-label">执行引擎</div>
          <select value={engine} onChange={(e) => setEngine(e.target.value)} style={{ width: '100%' }} disabled={busy}>
            <option value="selenium">纯 Selenium</option>
            <option value="hybrid" disabled>混合(暂仅纯Sel)</option>
            <option value="split" disabled>Split(暂仅纯Sel)</option>
            <option value="playwright" disabled>Playwright(暂仅纯Sel)</option>
          </select>
        </div>

        {n > 1 && (
          <div className="m-field">
            <div className="m-label">并发 <span className="dim">(同时跑几个号,1–16;服务端按 AdsPower 上限自动钳制)</span></div>
            <input type="number" min={1} max={16} value={concurrency} disabled={busy}
              style={{ width: 120 }} onChange={(e) => setConcurrency(Math.max(1, Math.min(16, Math.floor(Number(e.target.value) || 1))))} />
          </div>
        )}

        <div className="m-field">
          <div className="m-label">代理来源</div>
          <div style={{ display: 'flex', gap: 16, marginBottom: 6 }}>
            <label className="check"><input type="radio" name="gk-proxy" checked={proxySource === 'pool'} disabled={busy} onChange={() => setProxySource('pool')} /> 用保存的代理池</label>
            <label className="check"><input type="radio" name="gk-proxy" checked={proxySource === 'paste'} disabled={busy} onChange={() => setProxySource('paste')} /> 粘贴自定义代理</label>
          </div>
          {proxySource === 'paste' && (
            <textarea rows={3} value={proxiesRaw} disabled={busy} placeholder="每行一个:host:port:user:pass 或 socks5://user:pass@host:port"
              style={{ width: '100%', fontFamily: 'var(--mono, monospace)', fontSize: 12 }} onChange={(e) => setProxiesRaw(e.target.value)} />
          )}
          {needPaste && <div style={{ color: 'var(--danger, #d33)', fontSize: 12, marginTop: 4 }}>请粘贴至少一行代理</div>}
        </div>

        <div className="m-field">
          <div className="m-label">受影响账号 <span className="dim">({n})</span></div>
          <div className="tbl-wrap" style={{ maxHeight: 200 }}>
            <table className="tbl">
              <thead><tr><th>邮箱</th><th>状态</th></tr></thead>
              <tbody>
                {targets.slice(0, 200).map((t) => {
                  const r = result?.results.find((x) => x.email === t.email);
                  return (
                    <tr key={t.email}>
                      <td className="mono">{t.email}</td>
                      <td>{r ? (r.ok ? <span className="kbadge ok">已取回</span> : <span className="kbadge fail" title={r.reason}>失败</span>) : (busy ? <span className="kbadge neutral">进行中…</span> : <span className="kbadge neutral">待执行</span>)}</td>
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
