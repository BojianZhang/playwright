// 首次部署引导(向导页):把分散在设置中心 + 各资源池的「必须配齐才能跑」串成一条分步引导。
// 每步只做最小录入 + 连通测试,复杂管理仍跳对应资源页。done 由 /api/setup/status 实时算,
// 录入打的全是已有接口(/api/captcha|mailbox|proxies|cards|addresses|adspower/* + /api/config)。
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { Icon } from '../lib/icons';
import { useToast } from '../lib/toast';
import type { SetupStatus, SetupStep } from '../lib/types';

const STEP_ICON: Record<string, string> = {
  captcha: 'shield', mailbox: 'mail', adspower: 'cpu', token: 'lock',
  proxies: 'layers', cards: 'card', addresses: 'home', adsenvs: 'cpu',
};
// 每步白话说明:这是什么 + 为什么需要 + 去哪拿。
const STEP_INTRO: Record<string, { what: string; manage?: { to: string; label: string } }> = {
  captcha: { what: '注册要过 Cloudflare Turnstile / hCaptcha,靠打码服务自动求解。没有它注册会卡在验证码。去 2captcha.com 或 capsolver.com 充值拿 API key。', manage: { to: '/captcha', label: '验证码 key 池' } },
  mailbox: { what: '注册需要收激活邮件(魔法链接)。没有它读不到邮件,注册无法完成。用 Firstmail 等服务,拿 API key。', manage: { to: '/mailbox', label: '邮箱 key 池' } },
  adspower: { what: 'AdsPower 提供指纹浏览器环境。本机装好 AdsPower 客户端并开启 Local API(默认 http://127.0.0.1:50325)即可。填地址后点「测试连接」确认通。', manage: { to: '/adspower', label: 'AdsPower 管理' } },
  token: { what: '设了访问令牌后,打开控制台 / 拉结果都要带它 —— 防止别人连到你的端口就能拿走账号和 Key。单机本地跑可不设;监听公网强烈建议设。', manage: { to: '/settings', label: '设置中心 · 安全' } },
  proxies: { what: '每个账号需要独立出口 IP,降低风控撞车。粘贴 host:port:user:pass(一行一个)。', manage: { to: '/proxies', label: '代理 / IP 池' } },
  cards: { what: '加卡环节要用的支付卡。粘贴卡号信息(一行一个),系统按次数轮用。', manage: { to: '/cards', label: '卡池管理' } },
  addresses: { what: '加卡时填的账单地址(影响 AVS / ZIP 过审)。粘贴地址(一行一个)。', manage: { to: '/addresses', label: '账单地址池' } },
  adsenvs: { what: '复用已有的 AdsPower 环境编号(老号续跑用);全新跑可留空,流水线会自动建环境。填环境 ID,逗号或换行分隔。', manage: { to: '/adspower', label: 'AdsPower 环境' } },
};

function StepBadge({ done, required }: { done: boolean; required: boolean }) {
  if (done) return <span className="kbadge ok">已完成</span>;
  return <span className={'kbadge ' + (required ? 'warn' : 'neutral')}>{required ? '待配置' : '可选'}</span>;
}

export default function SetupPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const { data } = useQuery({ queryKey: ['setup-status'], queryFn: () => apiGet<SetupStatus>('/api/setup/status', true), refetchInterval: 8000 });
  const steps = data?.steps || [];
  const [active, setActive] = useState(0);
  const inval = () => qc.invalidateQueries({ queryKey: ['setup-status'] });

  const cur = steps[active];
  const doneCount = steps.filter((s) => s.done).length;
  const reqTotal = steps.filter((s) => s.required).length;
  const reqDone = steps.filter((s) => s.required && s.done).length;
  const pct = steps.length ? Math.round((doneCount / steps.length) * 100) : 0;

  const complete = useMutation({ mutationFn: (b: unknown) => apiPost('/api/setup/complete', b), onSuccess: inval });
  async function finish() { await complete.mutateAsync({}); toast.push('引导已完成 · 可随时从侧栏「部署引导」回来', 'ok'); nav('/console'); }
  async function later() { await complete.mutateAsync({ dismissed: true }); toast.push('已跳过 · 之后可从侧栏「部署引导」继续', 'info'); nav('/'); }

  if (!data) return <main className="page"><div className="card card-pad"><div className="empty-note">加载引导状态中…</div></div></main>;

  return (
    <main className="page">
      <div className="page-head">
        <h1>部署引导</h1>
        <p>按下面的步骤把「跑通注册 / 加卡流水线」需要的东西配齐。每步都能测试,资源类的也可以跳到完整管理页。<b>访问令牌为建议项,不影响完成。</b></p>
      </div>

      {/* 进度条 */}
      <section className="card card-pad">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
          <b style={{ fontSize: 14 }}>已完成 {doneCount} / {steps.length} 步</b>
          <span className="head-hint">必需项 {reqDone}/{reqTotal}{data.allRequiredDone ? ' · 已可开跑 🎉' : ''}</span>
          <span style={{ marginLeft: 'auto' }} className={'kbadge ' + (data.allRequiredDone ? 'ok' : 'warn')}>{data.allRequiredDone ? '必需项已齐' : '还差必需项'}</span>
        </div>
        <div style={{ height: 8, borderRadius: 999, background: 'var(--surface-3, #2222)', overflow: 'hidden' }}>
          <div style={{ width: pct + '%', height: '100%', background: data.allRequiredDone ? 'var(--success)' : 'var(--primary)', transition: 'width .3s' }} />
        </div>
      </section>

      <div className="section-gap" />

      <div className="grid-2" style={{ gridTemplateColumns: '260px 1fr', alignItems: 'start' }}>
        {/* 步骤导航 */}
        <section className="card" style={{ padding: '8px' }}>
          {steps.map((s, i) => (
            <button key={s.key} className={'sb-link' + (i === active ? ' active' : '')} style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => setActive(i)}>
              <Icon name={s.done ? 'check' : (STEP_ICON[s.key] || 'sliders')} size={15} />
              <span className="nl-text" style={{ flex: 1, textAlign: 'left' }}>{s.label}</span>
              {s.done ? <span className="kbadge ok" style={{ fontSize: 10 }}>✓</span> : (s.required ? <span className="kbadge warn" style={{ fontSize: 10 }}>!</span> : null)}
            </button>
          ))}
        </section>

        {/* 当前步内容 */}
        <div>
          {cur && <StepEditor step={cur} onDone={inval} />}
        </div>
      </div>

      <div className="section-gap" />

      {/* 底部导航 */}
      <section className="card">
        <div className="runbar">
          <button className="btn btn-ghost" disabled={active === 0} onClick={() => setActive((i) => Math.max(0, i - 1))}><Icon name="chevron-left" size={15} />上一步</button>
          <button className="btn btn-ghost" disabled={active >= steps.length - 1} onClick={() => setActive((i) => Math.min(steps.length - 1, i + 1))}>下一步<Icon name="chevron-right" size={15} /></button>
          <span style={{ marginLeft: 'auto' }} />
          <button className="btn btn-ghost btn-sm" disabled={complete.isPending} onClick={later}>以后再说</button>
          <button className={'btn ' + (data.allRequiredDone ? 'btn-primary' : 'btn-soft')} disabled={complete.isPending} onClick={finish}><Icon name="check" size={16} />完成引导</button>
        </div>
      </section>
    </main>
  );
}

// ── 单步编辑器:按 step.key 分派到对应录入 / 测试 ─────────────────────────────
function StepEditor({ step, onDone }: { step: SetupStep; onDone: () => void }) {
  const intro = STEP_INTRO[step.key] || { what: '' };
  return (
    <section className="card">
      <div className="eb-top">
        <span className="idx c-info"><Icon name={STEP_ICON[step.key] || 'sliders'} size={12} /></span>
        <h3>{step.label}</h3>
        <span style={{ marginLeft: 'auto' }}><StepBadge done={step.done} required={step.required} /></span>
      </div>
      <div style={{ margin: '4px 18px 0', padding: '11px 14px', borderRadius: 'var(--r-md)', background: 'var(--info-weak)', border: '1px solid var(--info-bd)', fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.7 }}>
        {intro.what}
        {intro.manage && <> <Link to={intro.manage.to} style={{ color: 'var(--primary-text)' }}>打开{intro.manage.label} →</Link></>}
        <div style={{ marginTop: 6, color: 'var(--text-3)' }}>当前:{step.detail}</div>
      </div>
      <div style={{ padding: '16px 18px' }}>
        {step.key === 'captcha' && <CaptchaStep onDone={onDone} />}
        {step.key === 'mailbox' && <MailboxStep onDone={onDone} />}
        {step.key === 'adspower' && <AdsPowerStep onDone={onDone} />}
        {step.key === 'token' && <TokenStep onDone={onDone} />}
        {step.key === 'proxies' && <PoolStep onDone={onDone} url="/api/proxies/add" bodyKey="raw" placeholder={'1.2.3.4:8080:user:pass\n5.6.7.8:3128'} hint="一行一个,host:port 或 host:port:user:pass" />}
        {step.key === 'cards' && <CardsStep onDone={onDone} />}
        {step.key === 'addresses' && <PoolStep onDone={onDone} url="/api/addresses/import" bodyKey="raw" placeholder={'John Doe|123 Main St|New York|NY|10001'} hint="一行一个,支持 CSV / 竖线 / Tab 分隔(自动跳表头去重)" />}
        {step.key === 'adsenvs' && <PoolStep onDone={onDone} url="/api/adspower/add" bodyKey="raw" placeholder={'kxabc123, kxdef456'} hint="环境 ID,逗号或换行分隔(全新跑可留空)" />}
      </div>
    </section>
  );
}

function CaptchaStep({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ label: '', provider: '2captcha', apiKey: '' });
  const add = useMutation({ mutationFn: (b: unknown) => apiPost('/api/captcha/keys/add', b), onSuccess: onDone });
  const bal = useMutation({ mutationFn: (b: unknown) => apiPost('/api/captcha/keys/balance', b), onSuccess: onDone });
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="grid-2">
        <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">服务商</span></div><select value={form.provider} onChange={(e) => setForm((s) => ({ ...s, provider: e.target.value }))}><option value="2captcha">2Captcha</option><option value="capsolver">CapSolver</option></select></div>
        <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">标签(可选)</span></div><input type="text" value={form.label} placeholder="主key" onChange={(e) => setForm((s) => ({ ...s, label: e.target.value }))} /></div>
      </div>
      <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">API Key</span></div><input type="password" value={form.apiKey} autoComplete="new-password" placeholder="粘贴打码服务的 API key" onChange={(e) => setForm((s) => ({ ...s, apiKey: e.target.value }))} /></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary btn-sm" disabled={!form.apiKey.trim() || add.isPending} onClick={async () => { await add.mutateAsync(form); toast.push('已添加验证码 key', 'ok'); setForm({ label: '', provider: form.provider, apiKey: '' }); }}><Icon name="upload" size={12} />添加 key</button>
        <button className="btn btn-ghost btn-sm" disabled={bal.isPending} onClick={async () => { await bal.mutateAsync({}); toast.push('余额已刷新', 'ok'); }}><Icon name="refresh" size={12} />{bal.isPending ? '查询中…' : '查全部余额'}</button>
      </div>
    </div>
  );
}

function MailboxStep({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ label: '', provider: 'firstmail', apiKey: '', apiBaseUrl: 'https://firstmail.ltd' });
  const add = useMutation({ mutationFn: (b: unknown) => apiPost('/api/mailbox/keys/add', b), onSuccess: onDone });
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="grid-2">
        <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">服务商</span></div><input type="text" value={form.provider} onChange={(e) => setForm((s) => ({ ...s, provider: e.target.value }))} /></div>
        <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">API 地址</span></div><input type="text" value={form.apiBaseUrl} onChange={(e) => setForm((s) => ({ ...s, apiBaseUrl: e.target.value }))} /></div>
      </div>
      <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">API Key</span></div><input type="password" value={form.apiKey} autoComplete="new-password" placeholder="粘贴邮箱服务的 API key" onChange={(e) => setForm((s) => ({ ...s, apiKey: e.target.value }))} /></div>
      <div><button className="btn btn-primary btn-sm" disabled={!form.apiKey.trim() || add.isPending} onClick={async () => { await add.mutateAsync(form); toast.push('已添加邮箱 key', 'ok'); setForm((s) => ({ ...s, label: '', apiKey: '' })); }}><Icon name="upload" size={12} />添加 key</button></div>
    </div>
  );
}

function AdsPowerStep({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [apiBase, setApiBase] = useState('http://127.0.0.1:50325');
  const [apiKey, setApiKey] = useState('');
  const [pinging, setPinging] = useState(false);
  const save = useMutation({ mutationFn: (b: unknown) => apiPost('/api/config', b), onSuccess: onDone });
  async function saveAndPing() {
    setPinging(true);
    try {
      // 密钥非空才写(空值不覆盖已有);本机网关一般免填,远程/带鉴权网关才需要。
      const patch: Record<string, string> = { 'adspower.apiBase': apiBase.trim() };
      if (apiKey.trim()) patch['adspower.apiKey'] = apiKey.trim();
      await save.mutateAsync({ patch });
      const r = await apiGet<{ ok: boolean; latencyMs: number; status?: number; error?: string }>('/api/adspower/ping', true);
      if (r.ok) toast.push(`连接成功 · ${r.latencyMs}ms`, 'ok');
      else toast.push(`连接失败:${r.error || r.status || '无响应'} · 确认 AdsPower 客户端已开 Local API`, 'err');
      onDone();
    } catch (e) { toast.push('保存/测试出错:' + (e as Error).message, 'err'); }
    finally { setPinging(false); }
  }
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">Local API 地址</span><span className="l-hint">AdsPower 客户端「设置 → Local API」里能看到,默认 127.0.0.1:50325</span></div><input type="text" value={apiBase} onChange={(e) => setApiBase(e.target.value)} /></div>
      <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">API 密钥</span><span className="l-hint">本机网关一般<b>免填</b>;指向远程 / 开了 Local API 鉴权才填</span></div><input type="password" value={apiKey} autoComplete="new-password" placeholder="可留空" onChange={(e) => setApiKey(e.target.value)} /></div>
      <div><button className="btn btn-primary btn-sm" disabled={pinging || !apiBase.trim()} onClick={saveAndPing}><Icon name="activity" size={12} />{pinging ? '保存并测试中…' : '保存并测试连接'}</button></div>
      <p className="help" style={{ margin: 0 }}>注:多机 / 多端点(各带地址+密钥)可在 <Link to="/adspower" style={{ color: 'var(--primary-text)' }}>AdsPower 管理</Link> 里加端点池。本地走系统代理可能 502,改 127.0.0.1 或排除代理。</p>
    </div>
  );
}

function TokenStep({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [token, setToken] = useState('');
  const save = useMutation({ mutationFn: (b: unknown) => apiPost('/api/config', b), onSuccess: onDone });
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">访问令牌 token</span><span className="l-hint">设了之后所有页面 / 接口 / 聚合都要带它;留空不改</span></div><input type="password" value={token} autoComplete="new-password" placeholder="建议用随机长字符串" onChange={(e) => setToken(e.target.value)} /></div>
      <div><button className="btn btn-primary btn-sm" disabled={!token.trim() || save.isPending} onClick={async () => { await save.mutateAsync({ patch: { 'security.token': token.trim() } }); toast.push('令牌已保存 · 重启 server.js 后生效,下次需带令牌访问', 'ok'); setToken(''); }}><Icon name="lock" size={12} />保存令牌</button></div>
    </div>
  );
}

// 通用「粘贴一批 → 导入」步骤(代理 / 地址 / AdsPower 环境)。
function PoolStep({ onDone, url, bodyKey, placeholder, hint }: { onDone: () => void; url: string; bodyKey: string; placeholder: string; hint: string }) {
  const toast = useToast();
  const [raw, setRaw] = useState('');
  const imp = useMutation({ mutationFn: (b: unknown) => apiPost<{ added?: number; dup?: number }>(url, b), onSuccess: onDone });
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">批量粘贴</span><span className="l-hint">{hint}</span></div><textarea rows={6} value={raw} placeholder={placeholder} onChange={(e) => setRaw(e.target.value)} /></div>
      <div><button className="btn btn-primary btn-sm" disabled={!raw.trim() || imp.isPending} onClick={async () => { const r = await imp.mutateAsync({ [bodyKey]: raw }); toast.push(`新增 ${r.added || 0} · 重复 ${r.dup || 0}`, 'ok'); setRaw(''); }}><Icon name="upload" size={12} />导入</button></div>
    </div>
  );
}

function CardsStep({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [raw, setRaw] = useState('');
  const [maxUses, setMaxUses] = useState('10');
  const imp = useMutation({ mutationFn: (b: unknown) => apiPost<{ added?: number; updated?: number }>('/api/cards/import', b), onSuccess: onDone });
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">每张卡最多用几次</span></div><input type="number" value={maxUses} style={{ width: 120 }} onChange={(e) => setMaxUses(e.target.value)} /></div>
      <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">批量粘贴卡</span><span className="l-hint">一行一张,格式按卡池页说明(卡号|月|年|CVV 等)</span></div><textarea rows={6} value={raw} placeholder={'4111111111111111|12|2028|123'} onChange={(e) => setRaw(e.target.value)} /></div>
      <div><button className="btn btn-primary btn-sm" disabled={!raw.trim() || imp.isPending} onClick={async () => { const r = await imp.mutateAsync({ cardsRaw: raw, maxUses: Math.max(1, Math.floor(Number(maxUses)) || 10) }); toast.push(`新增 ${r.added || 0} · 更新 ${r.updated || 0}`, 'ok'); setRaw(''); }}><Icon name="upload" size={12} />导入卡</button></div>
    </div>
  );
}
