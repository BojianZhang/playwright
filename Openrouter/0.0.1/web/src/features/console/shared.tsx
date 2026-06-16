// 控制台共享:类型、常量、无状态小组件(从 ConsolePage 抽出,供各步骤复用)。
import { Icon } from '../../lib/icons';
import type { Kind } from '../../lib/parse';

export type Stage = 'key' | 'addr' | 'card' | 'charge' | 'pwd';
export type Engine = 'playwright' | 'selenium' | 'hybrid' | 'split';
export type TabKey = 'pool' | 'ledger' | 'status' | 'errors' | 'logs';

export const BILL_CHAIN: Stage[] = ['addr', 'card', 'charge'];
export const STAGE_LABELS: Record<string, string> = { 'waiting-slot': '排队等待', 'proxy-precheck': '代理预检', 'email-password-change': '邮箱改密', 'openrouter-register': '注册', 'magic-link-login': '邮箱验证', 'api-key': '创建Key', 'billing-card-topup': '充值', export: '导出' };
export const STAGE_ORDER = ['proxy-precheck', 'email-password-change', 'openrouter-register', 'magic-link-login', 'api-key', 'billing-card-topup', 'export'];
// Selenium / 混合 引擎的逐号阶段词表(对齐 Python common.log_stage 发的 stage 名:env/auth/key/card/charge/changepw/done)。
export const SEL_STAGE_ORDER = ['env', 'auth', 'key', 'card', 'charge', 'changepw'];
export const SEL_STAGE_LABELS: Record<string, string> = { env: '建环境/接管', auth: '注册/登录', key: '取Key', card: '加卡', charge: '充值', changepw: '改密', done: '完成' };

export const DEF_TPL_OK = '{{email}}:{{password}} | key:{{apiKey}} | 原密码:{{originalPassword}} | 改密:{{passwordChanged}} | billing:{{billingStatus}} ${{charged}} | card:{{cardLast4}} | ip:{{exitIp}}';
export const DEF_TPL_FAIL = '{{email}}:{{password}} | X{{stage}} | {{reason}} | 试{{attempts}}次';

export { ENGINE_LABEL } from '../../lib/labels';   // ★单一来源 lib/labels(原本地 split='两引擎随机' 与 runs.tsx '两引擎' 不一致 → 统一 '两套分流')
export const ENGINE_LIST: { key: Engine; label: string; sub: string }[] = [
  { key: 'playwright', label: 'Playwright(内置)', sub: '最快上手 · 无需额外软件,先用这个' },
  { key: 'selenium', label: 'Selenium', sub: '需本机 AdsPower + 代理 · 跑完整流程' },
  { key: 'hybrid', label: '混合(更稳)', sub: '需 AdsPower + 代理 · 过 Stripe 加卡更稳' },
  { key: 'split', label: '两套分流', sub: '需 AdsPower · 账号随机分两组,上两种各跑一半' },
];

/* ---------- 无状态小组件 ---------- */
export function Arrow() { return <span className="p-arrow"><Icon name="chevron" size={14} /></span>; }

// locked=锁定态:渲染成 .stage.locked(默认光标、不可点),用于"该引擎下此步被流水线强制/不支持、不可单独开关"。
export function Chip({ on, charge, dim, locked, title, onClick, children }: { on: boolean; charge?: boolean; dim?: boolean; locked?: boolean; title?: string; onClick?: () => void; children: React.ReactNode }) {
  const clickable = !locked && !!onClick;   // 可点的开关 chip → 当作 button:可 Tab 聚焦 + Enter/Space 触发(键盘也能开关步骤)
  return <div className={'stage' + (on ? ' on' : '') + (charge ? ' charge' : '') + (locked ? ' locked' : '')} style={dim ? { opacity: 0.5 } : undefined} title={title}
    role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined} aria-pressed={clickable ? on : undefined}
    onClick={clickable ? onClick : undefined}
    onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick!(); } } : undefined}>
    <span className="schk"><Icon name="check" size={10} /></span>{children}</div>;
}

export function Field({ name, hint, children }: { name: string; hint?: string; children: React.ReactNode }) {
  return <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">{name}</span>{hint && <span className="l-hint">{hint}</span>}</div>{children}</div>;
}

export function Check({ label, sub, v, on }: { label: string; sub: string; v: boolean; on: (v: boolean) => void }) {
  // label 与 sub 纵向堆叠:label 独占一行(中文不再被 sub 挤到断词换行),sub 灰字在下。
  return (
    <label className="check">
      <input type="checkbox" checked={v} onChange={(e) => on(e.target.checked)} />
      <span className="box"><Icon name="check" size={11} /></span>
      <span className="check-text"><span className="check-label">{label}</span>{sub && <span className="sub">{sub}</span>}</span>
    </label>
  );
}

export function DataCol({ kind, label, hint, placeholder, value, onChange, fname, onFile, extra, disabled, disabledNote }: {
  kind: Kind; label: string; hint: React.ReactNode; placeholder: string; value: string; onChange: (v: string) => void;
  fname: { cls: string; text: string }; onFile: (k: Kind, f: File) => void; extra?: React.ReactNode;
  disabled?: boolean; disabledNote?: React.ReactNode;
}) {
  return (
    <div className="data-col">
      <div className="field fill" style={{ margin: 0 }}>
        <div className="label">
          <span className="l-name">{label}</span><span className="l-hint">{hint}</span>
          {extra}
          {!disabled && <label className="upload"><Icon name="upload" size={12} />上传<input type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(kind, f); e.currentTarget.value = ''; }} /></label>}
        </div>
        {disabled
          ? <div className="pool-note" style={{ minHeight: 128 }}>{disabledNote}</div>
          : <><textarea spellCheck={false} style={{ minHeight: 128 }} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} /><span className={'fname ' + fname.cls}>{fname.text}</span></>}
      </div>
    </div>
  );
}
