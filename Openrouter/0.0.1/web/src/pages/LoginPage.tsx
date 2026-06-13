// 独立登录页:输入访问令牌(token),探活成功后进入控制台(替代旧的 prompt 弹窗)。
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authFetch } from '../lib/api';
import { setToken, getToken } from '../lib/auth';
import { Icon } from '../lib/icons';

export default function LoginPage() {
  const navigate = useNavigate();
  const [tok, setTok] = useState(getToken());
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(''); setBusy(true);
    setToken(tok);
    try {
      const r = await authFetch('/api/node', { silent: true });
      if (r.ok) { navigate('/'); return; }
      if (r.status === 401) setErr('令牌无效或缺失,请检查后重试。');
      else setErr(`服务异常(${r.status})。`);
    } catch {
      setErr('连接服务失败,确认后端已启动(node web/server.js)。');
    } finally { setBusy(false); }
  }

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <span className="brand-mark"><Icon name="lock" size={20} /></span>
        <h1>OpenRouter 控制台</h1>
        <p>该实例已启用访问令牌。请输入令牌以继续;若未配置令牌,直接点进入即可。</p>
        <div className="field">
          <div className="label"><span className="l-name">访问令牌 (token)</span></div>
          <input type="password" value={tok} autoFocus placeholder="粘贴 security.token / OPENROUTER_AUTH_TOKEN"
            onChange={(e) => setTok(e.target.value)} />
        </div>
        {err && <div className="kbadge fail" style={{ marginBottom: 12 }}>{err}</div>}
        <button className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={busy}>
          <Icon name="arrow" size={16} />{busy ? '校验中…' : '进入控制台'}
        </button>
      </form>
    </div>
  );
}
