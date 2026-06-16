// 左侧边栏:品牌 + 分组导航 + 收起。收起态由 App(.shell)控制并记忆 localStorage。
import { NavLink } from 'react-router-dom';
import { Icon } from '../lib/icons';

export interface NavItem { to: string; label: string; icon: string; end?: boolean }
export interface NavGroup { group: string; items: NavItem[] }

export default function Sidebar({ nav, collapsed, onToggle, version }: { nav: NavGroup[]; collapsed: boolean; onToggle: () => void; version?: string }) {
  return (
    <aside className="sidebar">
      <div className="sb-brand">
        <span className="brand-mark"><Icon name="arrow" size={15} /></span>
        <span className="brand-title">GLM <span className="dim">· z.ai 控制台</span></span>
        <button className="sb-collapse" onClick={onToggle} title={collapsed ? '展开侧栏' : '收起侧栏'} aria-label="toggle sidebar">
          <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} size={15} />
        </button>
      </div>

      <nav className="sb-nav">
        {nav.map((g) => (
          <div className="sb-group" key={g.group}>
            <div className="sb-group-label">{g.group}</div>
            {g.items.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => 'sb-link' + (isActive ? ' active' : '')} title={n.label}>
                <Icon name={n.icon} size={15} /><span className="nl-text">{n.label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="sb-foot">
        <span className="sb-ver"><span className="dot" />v{version || '1.0'}</span>
      </div>
    </aside>
  );
}
