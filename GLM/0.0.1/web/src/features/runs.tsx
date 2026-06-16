// 运行历史共享件:状态徽章 + 计费动作标签。
import type { RunSummary } from '../lib/types';

export function RunStatus({ status, partial, completenessPct }: { status: RunSummary['status']; partial?: boolean; completenessPct?: number }) {
  if (status === 'finished' && partial) return <span className="kbadge warn" title="结果可能未完整:某分流组/子进程疑似中途退出丢了部分账号结果 —— 可「续跑这批」补齐">⚠ 未完整{completenessPct != null ? ` ${completenessPct}%` : ''}</span>;
  if (status === 'finished') return <span className="kbadge ok">✓ 完成</span>;
  if (status === 'running') return <span className="kbadge info">● 运行中</span>;
  if (status === 'error') return <span className="kbadge fail">✕ 异常</span>;
  if (status === 'interrupted') return <span className="kbadge warn" title="进程中断(服务重启/崩溃)未跑完 —— 重新提交同一批账号即可断点续跑">⚠ 中断</span>;
  return <span className="kbadge neutral">{status}</span>;
}

export const BILLING_ACTION_LABEL: Record<string, string> = {
  none: '仅取Key', address: '绑地址', card: '加卡', charge: '充值',
};

export const ENGINE_LABEL: Record<string, string> = { playwright: 'Playwright', selenium: 'Selenium', hybrid: '混合', split: '两引擎' };
export function EngineBadge({ engine }: { engine?: string }) {
  const e = engine || 'playwright';
  const cls = e === 'playwright' ? 'neutral' : e === 'split' ? 'warn' : 'info';
  return <span className={'kbadge ' + cls}>{ENGINE_LABEL[e] || e}</span>;
}
