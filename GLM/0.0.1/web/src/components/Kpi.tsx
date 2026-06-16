// 统一 KPI 卡(各资源页报表区复用)。
import { type ReactNode } from 'react';
import { Icon } from '../lib/icons';

export function Kpi({ icon, label, value, sub, tone }: { icon: string; label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'info' | 'warn' }) {
  return (
    <div className={'card kpi' + (tone ? ' ' + tone : '')}>
      <div className="kpi-label"><Icon name={icon} />{label}</div>
      <div className="kpi-num">{value}</div>
      {sub != null && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}
