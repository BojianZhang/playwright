// 设置中心(横向子标签):验证码/邮箱 · 安全访问 · 多机集群 · 失败策略 · 系统信息(只读)。
// 密钥脱敏:只显示「已设置/未设置」,输入框留空=保持原值不改;保存只写 config.local.json。
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { Icon } from '../lib/icons';
import { useToast } from '../lib/toast';
import type { ConfigView, HealthInfo } from '../lib/types';
import { PolicyModal } from '../features/PolicyModal';

const arr2text = (a?: string[]) => (a || []).join('\n');
const text2arr = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

type TabKey = 'svc' | 'sec' | 'cluster' | 'policy' | 'sys';
const TABS: { k: TabKey; label: string; icon: string }[] = [
  { k: 'svc', label: '验证码 / 邮箱', icon: 'cpu' },
  { k: 'sec', label: '安全访问', icon: 'lock' },
  { k: 'cluster', label: '多机集群', icon: 'server' },
  { k: 'policy', label: '失败策略', icon: 'alert' },
  { k: 'sys', label: '系统信息', icon: 'info' },
];

interface Form {
  mailboxProvider: string; mailboxApiBaseUrl: string; mailboxApiTimeoutMs: string; mailboxApiKey: string; mailboxPasswordChangeMode: string;
  captchaEnabled: boolean; captchaProvider: string; captchaSolveTimeoutMs: string; captchaApiKey: string;
  adspowerApiBase: string; adspowerApiKey: string;
  clusterHosts: string; clusterCentralUrl: string; clusterSelfUrl: string;
  securityGateStatic: boolean; securityAllowIps: string; securityAllowHosts: string; securityTrustForwardedFor: boolean; securityToken: string;
}

function fromConfig(c: ConfigView['config']): Form {
  return {
    mailboxProvider: c.mailbox.provider, mailboxApiBaseUrl: c.mailbox.apiBaseUrl, mailboxApiTimeoutMs: String(c.mailbox.apiTimeoutMs || ''), mailboxApiKey: '', mailboxPasswordChangeMode: c.mailbox.passwordChangeMode || 'skip',
    captchaEnabled: c.captcha.enabled, captchaProvider: c.captcha.provider, captchaSolveTimeoutMs: String(c.captcha.solveTimeoutMs || ''), captchaApiKey: '',
    adspowerApiBase: c.adspower.apiBase, adspowerApiKey: '',
    clusterHosts: arr2text(c.cluster.hosts), clusterCentralUrl: c.cluster.centralUrl, clusterSelfUrl: c.cluster.selfUrl,
    securityGateStatic: c.security.gateStatic, securityAllowIps: arr2text(c.security.allowIps), securityAllowHosts: arr2text(c.security.allowHosts), securityTrustForwardedFor: c.security.trustForwardedFor, securityToken: '',
  };
}

function SecretInput({ label, hint, skey, set, value, onChange }: { label: string; hint: string; skey: string; set: boolean; value: string; onChange: (v: string) => void }) {
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  async function toggle() {
    if (show) { setShow(false); return; }
    if (!value && set) {
      setLoading(true);
      try { const r = await apiGet<{ value: string }>(`/api/config/secret?key=${encodeURIComponent(skey)}`); onChange(r.value || ''); } catch { /* ignore */ }
      setLoading(false);
    }
    setShow(true);
  }
  return (
    <div className="field" style={{ margin: 0 }}>
      <div className="label"><span className="l-name">{label}</span><span className="l-hint">{hint}</span>{set ? <span className="kbadge ok" style={{ marginLeft: 'auto' }}>已设置</span> : <span className="kbadge warn" style={{ marginLeft: 'auto' }}>未设置</span>}</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input type={show ? 'text' : 'password'} value={value} style={{ flex: 1 }} placeholder={set ? '已设置 · 点「显示」可查看/修改;留空=不改' : '未设置 · 在此填入'} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" />
        <button type="button" className="btn btn-ghost btn-sm" disabled={loading} onClick={toggle} style={{ whiteSpace: 'nowrap' }}>{loading ? '…' : (show ? '隐藏' : '显示')}</button>
      </div>
    </div>
  );
}

function fmtUptime(s: number): string {
  if (!s) return '—'; const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}天 ${h}时` : h ? `${h}时 ${m}分` : `${m}分`;
}
function fmtBytes(n: number): string {
  if (!n) return '0 B'; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = n; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${v.toFixed(v < 10 && i ? 1 : 0)} ${u[i]}`;
}

function SystemInfoTab() {
  const { data: h } = useQuery({ queryKey: ['health'], queryFn: () => apiGet<HealthInfo>('/api/health'), refetchInterval: 15000 });
  if (!h) return <div className="empty-note" style={{ padding: 24 }}>加载中…</div>;
  const cfg = h.config || ({} as HealthInfo['config']);
  return (
    <section className="card">
      <div className="eb-top"><span className="idx c-info"><Icon name="info" size={12} /></span><h3>系统信息</h3><span className="head-hint">只读 · 节点 / 存储 / 配置自检</span></div>
      <div style={{ padding: '16px 18px' }}>
        <div className="kpi-grid">
          <div className="card card-pad"><div className="head-hint">版本</div><div style={{ fontSize: 20, fontWeight: 700 }}>v{h.version}</div></div>
          <div className="card card-pad"><div className="head-hint">节点</div><div style={{ fontSize: 15, fontWeight: 600 }}>{h.nodeId}</div><div className="head-hint">{h.role === 'sub' ? '子机' : '中心机'} · {h.hostname}</div></div>
          <div className="card card-pad"><div className="head-hint">运行时长</div><div style={{ fontSize: 20, fontWeight: 700, color: 'var(--primary-text)' }}>{fmtUptime(h.uptimeSec)}</div></div>
          <div className="card card-pad"><div className="head-hint">结果存储</div><div style={{ fontSize: 20, fontWeight: 700 }}>{fmtBytes((h.storage?.resultsBytes || 0) + (h.storage?.runsBytes || 0))}</div><div className="head-hint">{h.storage?.resultFiles || 0} 个文件</div></div>
        </div>
        <div style={{ marginTop: 16 }}>
          <div className="head-hint" style={{ marginBottom: 8 }}>配置自检</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span className={'kbadge ' + (cfg.captchaKeySet ? 'ok' : 'warn')}>验证码 key {cfg.captchaKeySet ? '已设置' : '未设置'}{cfg.captchaProvider ? ' · ' + cfg.captchaProvider : ''}</span>
            <span className={'kbadge ' + (cfg.mailboxKeySet ? 'ok' : 'warn')}>邮箱 key {cfg.mailboxKeySet ? '已设置' : '未设置'}{cfg.mailboxProvider ? ' · ' + cfg.mailboxProvider : ''}</span>
            <span className={'kbadge ' + (cfg.tokenSet ? 'ok' : 'neutral')}>访问令牌 {cfg.tokenSet ? '已设置' : '未设置'}</span>
            <span className="kbadge neutral">页面令牌门 {cfg.gateStatic ? '开' : '关'}</span>
          </div>
        </div>
        {(h.warnings || []).length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div className="head-hint" style={{ marginBottom: 8 }}>告警</div>
            {h.warnings.map((w, i) => <div key={i} className="kbadge warn" style={{ display: 'block', marginBottom: 6 }}>{w}</div>)}
          </div>
        )}
      </div>
    </section>
  );
}

export default function SettingsPage() {
  const toast = useToast();
  const { data, refetch, isError, isLoading } = useQuery({ queryKey: ['config'], queryFn: () => apiGet<ConfigView>('/api/config') });
  const [f, setF] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [tab, setTab] = useState<TabKey>('svc');
  // rt-2:后台/跨标签刷新到的新 config 只在【用户没在编辑】时才回填表单,避免冲掉正在改的内容。
  const editedRef = useRef(false);
  useEffect(() => { if (data && !editedRef.current) setF(fromConfig(data.config)); }, [data]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => { editedRef.current = true; setF((s) => (s ? { ...s, [k]: v } : s)); };
  const sset = data?.config.secretsSet || {};

  // 脏改:非密钥字段有变更,或任一密钥填了新值(显示现值不算"改",留空不覆盖)
  const base = data ? fromConfig(data.config) : null;
  const blank = (x: Form) => ({ ...x, captchaApiKey: '', mailboxApiKey: '', securityToken: '', adspowerApiKey: '' });
  const dirty = !!(f && base && (JSON.stringify(blank(f)) !== JSON.stringify(blank(base)) || f.captchaApiKey.trim() || f.mailboxApiKey.trim() || f.securityToken.trim() || f.adspowerApiKey.trim()));

  async function save() {
    if (!f) return;
    setBusy(true);
    const patch: Record<string, unknown> = {
      'mailbox.provider': f.mailboxProvider, 'mailbox.apiBaseUrl': f.mailboxApiBaseUrl, 'mailbox.apiTimeoutMs': Number(f.mailboxApiTimeoutMs) || 30000, 'mailbox.passwordChangeMode': f.mailboxPasswordChangeMode,
      'captcha.enabled': f.captchaEnabled, 'captcha.provider': f.captchaProvider, 'captcha.solveTimeoutMs': Number(f.captchaSolveTimeoutMs) || 120000,
      'adspower.apiBase': f.adspowerApiBase,
      'cluster.hosts': text2arr(f.clusterHosts), 'cluster.centralUrl': f.clusterCentralUrl, 'cluster.selfUrl': f.clusterSelfUrl,
      'security.gateStatic': f.securityGateStatic, 'security.allowIps': text2arr(f.securityAllowIps), 'security.allowHosts': text2arr(f.securityAllowHosts), 'security.trustForwardedFor': f.securityTrustForwardedFor,
    };
    if (f.mailboxApiKey.trim()) patch['mailbox.apiKey'] = f.mailboxApiKey.trim();
    if (f.captchaApiKey.trim()) patch['captcha.apiKey'] = f.captchaApiKey.trim();
    if (f.adspowerApiKey.trim()) patch['adspower.apiKey'] = f.adspowerApiKey.trim();
    if (f.securityToken.trim()) patch['security.token'] = f.securityToken.trim();
    try {
      await apiPost('/api/config', { patch });
      toast.push('已保存到 config.local.json · 重启 node web/server.js 后对新任务生效', 'ok');
      editedRef.current = false;   // 保存成功 → 允许下次回填刷新到的最新值
      await refetch();
    } catch (e) { toast.push('保存失败:' + (e as Error).message, 'err'); }
    finally { setBusy(false); }
  }

  if (isError) return (
    <main className="page">
      <div className="page-head"><h1>设置中心</h1></div>
      <div className="card card-pad">
        <div className="empty-note" style={{ borderColor: 'var(--danger-bd)', background: 'var(--danger-weak)', color: 'var(--text-1)', textAlign: 'left', lineHeight: 1.7 }}>
          <b style={{ color: 'var(--danger)' }}>加载配置失败</b> —— 读取 <code>/api/config</code> 出错。若刚更新代码,多半是<b>后端未重启</b>(运行中的 <code>node server.js</code> 还是旧进程)。
          <br />请重启 <code>node server.js</code> 后重试,或点下方按钮重试。
          <div style={{ marginTop: 12 }}><button className="btn btn-soft btn-sm" onClick={() => refetch()}>重试</button></div>
        </div>
      </div>
    </main>
  );
  if (!f) return <main className="page"><div className="card card-pad"><div className="empty-note">{isLoading ? '加载配置中…' : '无配置数据,请重试或重启后端。'}</div></div></main>;

  return (
    <main className="page">
      <div className="page-head"><h1>设置中心</h1><p>改完保存到 config.local.json · 重启服务后对新任务生效(不动 config.json)。密钥留空 = 保持原值不变。</p></div>

      <div className="tabs tabs-settings">
        {TABS.map((t) => (
          <button key={t.k} className={'tab' + (tab === t.k ? ' on' : '')} onClick={() => setTab(t.k)}>
            <Icon name={t.icon} size={13} />{t.label}
          </button>
        ))}
      </div>

      {tab === 'svc' && (
        <>
        <section className="card">
          <div className="eb-top"><span className="idx c-info"><Icon name="cpu" size={12} /></span><h3>验证码 / 邮箱服务</h3><span className="head-hint">默认服务商 / 超时 / 开关;API 密钥改为多 key 池管理</span></div>
          <div style={{ margin: '4px 18px 0', padding: '11px 14px', borderRadius: 'var(--r-md)', background: 'var(--info-weak)', border: '1px solid var(--info-bd)', fontSize: 12, color: 'var(--text-2)', lineHeight: 1.7 }}>
            <b style={{ color: 'var(--info)' }}>API 密钥已改为多 key 池</b>(可加多个、失效自动转移):去 <Link to="/captcha" style={{ color: 'var(--primary-text)' }}>验证码池</Link> / <Link to="/mailbox" style={{ color: 'var(--primary-text)' }}>邮箱池</Link> 管理。此处仅设默认服务商 / 超时 / 地址;池为空时回退这里(config)的单 key。
          </div>
          <div className="set-grid">
            <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">验证码默认服务商</span></div><select value={f.captchaProvider} onChange={(e) => set('captchaProvider', e.target.value)}><option value="capsolver">CapSolver</option><option value="2captcha">2Captcha</option></select></div>
            <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">验证码求解超时(ms)</span></div><input type="number" value={f.captchaSolveTimeoutMs} onChange={(e) => set('captchaSolveTimeoutMs', e.target.value)} /></div>
            <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">邮箱服务商</span></div><input type="text" value={f.mailboxProvider} onChange={(e) => set('mailboxProvider', e.target.value)} /></div>
            <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">邮箱 API 地址</span></div><input type="text" value={f.mailboxApiBaseUrl} onChange={(e) => set('mailboxApiBaseUrl', e.target.value)} /></div>
            <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">邮箱改密模式</span><span className="l-hint">注册后是否改邮箱密码</span></div><select value={f.mailboxPasswordChangeMode} onChange={(e) => set('mailboxPasswordChangeMode', e.target.value)}><option value="skip">skip(不改密)</option><option value="change">change(改密·暂未实现)</option></select></div>
          </div>
          <div className="set-foot">
            <label className="check"><input type="checkbox" checked={f.captchaEnabled} onChange={(e) => set('captchaEnabled', e.target.checked)} /><span className="box"><Icon name="check" size={11} /></span>启用验证码自动求解</label>
          </div>
        </section>
        <div className="section-gap" />
        <section className="card">
          <div className="eb-top"><span className="idx c-info"><Icon name="cpu" size={12} /></span><h3>AdsPower 指纹浏览器</h3><span className="head-hint">本地 / 远程 Local API 地址与密钥(多端点池在 AdsPower 页管)</span></div>
          <div className="set-grid">
            <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">Local API 地址</span><span className="l-hint">默认 http://127.0.0.1:50325;走系统代理可能 502,用 127.0.0.1</span></div><input type="text" value={f.adspowerApiBase} placeholder="http://127.0.0.1:50325" onChange={(e) => set('adspowerApiBase', e.target.value)} /></div>
            <SecretInput label="API Key" hint="adspower.apiKey · 多数本地部署无需;开了 API 鉴权才填" skey="adspower.apiKey" set={!!sset['adspower.apiKey']} value={f.adspowerApiKey} onChange={(v) => set('adspowerApiKey', v)} />
          </div>
          <div style={{ padding: '0 18px 14px' }}><p className="help" style={{ margin: 0 }}>多机 / 多端点连通测试去 <Link to="/adspower" style={{ color: 'var(--primary-text)' }}>AdsPower 管理</Link>。</p></div>
        </section>
        </>
      )}

      {tab === 'sec' && (
        <section className="card">
          <div className="eb-top"><span className="idx c-amber"><Icon name="lock" size={12} /></span><h3>安全访问</h3><span className="head-hint">控制谁能打开这个控制台 / 拉结果</span></div>
          <div style={{ padding: '16px 18px' }}>
            <SecretInput label="访问令牌 token" hint="security.token · 设了之后所有页面/接口/聚合都要带它" skey="security.token" set={!!sset['security.token']} value={f.securityToken} onChange={(v) => set('securityToken', v)} />
            <div className="grid-2" style={{ marginTop: 14 }}>
              <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">IP 白名单</span><span className="l-hint">只放行这些 IP/网段(CIDR),本机始终放行;一行一个</span></div><textarea rows={3} value={f.securityAllowIps} placeholder={'203.0.113.7\n10.0.0.0/8'} onChange={(e) => set('securityAllowIps', e.target.value)} /></div>
              <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">域名白名单</span><span className="l-hint">只接受这些域名访问,支持 *.example.com;一行一个</span></div><textarea rows={3} value={f.securityAllowHosts} placeholder={'panel.example.com\n*.example.com'} onChange={(e) => set('securityAllowHosts', e.target.value)} /></div>
            </div>
          </div>
          <div className="set-foot">
            <label className="check"><input type="checkbox" checked={f.securityGateStatic} onChange={(e) => set('securityGateStatic', e.target.checked)} /><span className="box"><Icon name="check" size={11} /></span>页面也要令牌 <span className="sub">陌生人有域名也打不开(用 ?token= 访问一次)</span></label>
            <label className="check"><input type="checkbox" checked={f.securityTrustForwardedFor} onChange={(e) => set('securityTrustForwardedFor', e.target.checked)} /><span className="box"><Icon name="check" size={11} /></span>信任反代 IP <span className="sub">前置 Nginx 时用 X-Forwarded-For 取真实 IP(仅可信反代时开)</span></label>
          </div>
        </section>
      )}

      {tab === 'cluster' && (
        <section className="card">
          <div className="eb-top"><span className="idx c-green"><Icon name="server" size={12} /></span><h3>多机集群</h3><span className="head-hint">单机用不到 · 多机分布式跑时配</span></div>
          <div style={{ padding: '16px 18px' }}>
            <div className="field"><div className="label"><span className="l-name">中心机:其它机器地址</span><span className="l-hint">中心机填所有跑任务机器的地址,聚合结果用;一行一个,如 http://机器:4317</span></div><textarea rows={2} value={f.clusterHosts} placeholder={'http://10.0.0.11:4317\nhttp://10.0.0.12:4317'} onChange={(e) => set('clusterHosts', e.target.value)} /></div>
            <div className="grid-2">
              <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">子机:中心机地址</span><span className="l-hint">设了本机就自动向中心机注册+心跳</span></div><input type="text" value={f.clusterCentralUrl} placeholder="http://中心机:4317" onChange={(e) => set('clusterCentralUrl', e.target.value)} /></div>
              <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">子机:本机可达地址</span><span className="l-hint">可选,NAT 推断不准时填</span></div><input type="text" value={f.clusterSelfUrl} placeholder="http://本机IP:4317" onChange={(e) => set('clusterSelfUrl', e.target.value)} /></div>
            </div>
          </div>
        </section>
      )}

      {tab === 'policy' && (
        <section className="card">
          <div className="eb-top"><span className="idx"><Icon name="alert" size={12} /></span><h3>失败策略</h3><span className="head-hint">每种错误怎么重试/换代理/拉黑/放弃</span></div>
          <div style={{ padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 14 }}>
            <p className="help" style={{ margin: 0, flex: 1 }}>每个错误码对应一条恢复动作(同代理重试 / 换代理 / 重新登录 / 拉黑 / 放弃)和最多重试次数,可逐条覆盖内置默认。<b style={{ color: 'var(--success)' }}>这部分即时生效,无需重启,也不走下方保存。</b></p>
            <button className="btn btn-primary" onClick={() => setPolicyOpen(true)}><Icon name="edit" size={14} />编辑失败策略</button>
          </div>
        </section>
      )}

      {tab === 'sys' && <SystemInfoTab />}

      {tab !== 'sys' && (
        <>
          <div className="section-gap" />
          <section className="card">
            <div className="runbar">
              <button className={'btn btn-lg ' + (dirty ? 'btn-primary' : 'btn-ghost')} disabled={busy} onClick={save}><Icon name="check" size={16} />{busy ? '保存中…' : dirty ? '保存设置(有改动)' : '保存设置'}</button>
              <span className="run-hint">{data?.note || '改完保存到 config.local.json。密钥留空=保持原值不变。'}<b style={{ color: 'var(--warn)' }}> 改完需重启 node web/server.js 才对新任务生效。</b></span>
            </div>
          </section>
        </>
      )}

      <PolicyModal open={policyOpen} onClose={() => setPolicyOpen(false)} />
    </main>
  );
}
