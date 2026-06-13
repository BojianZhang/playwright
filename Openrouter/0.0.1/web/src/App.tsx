import { useEffect, useState } from 'react';
import { Route, Routes, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet } from './lib/api';
import { onUnauthorized } from './lib/auth';
import { onMutation } from './lib/sync';
import { useThemePref } from './lib/theme';
import { Icon } from './lib/icons';
import type { NodeInfo, HealthInfo, SetupStatus } from './lib/types';
import Sidebar, { type NavGroup } from './components/Sidebar';
import ConsolePage from './pages/ConsolePage';
import ResultsPage from './pages/ResultsPage';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import RunsPage from './pages/RunsPage';
import RunDetailPage from './pages/RunDetailPage';
import SettingsPage from './pages/SettingsPage';
import EngineConfigPage from './pages/EngineConfigPage';
import StrategiesPage from './pages/StrategiesPage';
import HealthPage from './pages/HealthPage';
import CardsPage from './pages/CardsPage';
import AccountsPage from './pages/AccountsPage';
import ProxiesPage from './pages/ProxiesPage';
import AddressesPage from './pages/AddressesPage';
import AdsPowerPage from './pages/AdsPowerPage';
import CaptchaPage from './pages/CaptchaPage';
import MailboxPage from './pages/MailboxPage';
import ClusterPage from './pages/ClusterPage';
import DiagnosePage from './pages/DiagnosePage';
import AnalysisPage from './pages/AnalysisPage';
import SetupPage from './pages/SetupPage';
import ComingSoon from './pages/ComingSoon';

const NAV: NavGroup[] = [
  { group: '运行', items: [
    { to: '/', label: '总览', icon: 'home', end: true },
    { to: '/console', label: '控制台', icon: 'play' },
    { to: '/engine-config', label: '引擎配置', icon: 'sliders' },
    { to: '/strategies', label: '环节策略', icon: 'activity' },
    { to: '/runs', label: '运行历史', icon: 'history' },
    { to: '/results', label: '结果聚合', icon: 'grid' },
  ] },
  { group: '资源', items: [
    { to: '/cards', label: '卡池', icon: 'card' },
    { to: '/proxies', label: '代理 / IP', icon: 'layers' },
    { to: '/accounts', label: '账号', icon: 'okcircle' },
    { to: '/addresses', label: '账单地址', icon: 'home' },
    { to: '/adspower', label: 'AdsPower', icon: 'cpu' },
    { to: '/captcha', label: '验证码', icon: 'shield' },
    { to: '/mailbox', label: '邮箱', icon: 'mail' },
  ] },
  { group: '系统', items: [
    { to: '/setup', label: '部署引导', icon: 'play' },
    { to: '/diagnose', label: '诊断 / 排查', icon: 'search' },
    { to: '/analysis', label: '失败分析', icon: 'alert' },
    { to: '/cluster', label: '集群', icon: 'server' },
    { to: '/health', label: '系统健康', icon: 'activity' },
    { to: '/settings', label: '设置中心', icon: 'settings' },
  ] },
];
const FLAT = NAV.flatMap((g) => g.items);

function pageTitle(pathname: string): string {
  if (pathname.startsWith('/runs/')) return '运行详情';
  const hit = FLAT.find((n) => (n.end ? pathname === n.to : pathname === n.to || pathname.startsWith(n.to + '/')))
    || FLAT.find((n) => n.to !== '/' && pathname.startsWith(n.to));
  return hit?.label || '控制台';
}

const THEME_ICON: Record<string, string> = { system: 'monitor', light: 'sun', dark: 'moon' };
const THEME_LABEL: Record<string, string> = { system: '跟随系统', light: '浅色', dark: '深色' };

function TopBar() {
  const loc = useLocation();
  // 全局鉴权探针:token 必需而未提供时 401 → notifyUnauthorized → 守卫跳 /login。
  const { data: node } = useQuery({ queryKey: ['node'], queryFn: () => apiGet<NodeInfo>('/api/node'), retry: false });
  const [pref, cycle] = useThemePref();
  return (
    <header className="topbar">
      <div className="tb-title">{pageTitle(loc.pathname)}</div>
      <div className="topbar-spacer" />
      <button className="tb-theme" onClick={cycle} title={`主题:${THEME_LABEL[pref]}(点击切换)`} aria-label="theme">
        <Icon name={THEME_ICON[pref]} size={15} />
      </button>
      <span className="node-badge"><span className="dot" />node&nbsp;{node?.nodeId || '…'}{node?.role === 'sub' ? ' (子机)' : ''}</span>
    </header>
  );
}

export default function App() {
  const navigate = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('or_sidebar') === '1'; } catch { return false; } });
  const [setupRedirected, setSetupRedirected] = useState(false);
  useEffect(() => onUnauthorized(() => { if (loc.pathname !== '/login') navigate('/login'); }), [navigate, loc.pathname]);

  // 跨标签同步(rt-11):其它标签发生写操作 → 本标签作废所有查询缓存,活跃查询立即重取、其余下次访问刷新。
  useEffect(() => onMutation(() => qc.invalidateQueries()), [qc]);

  // 首次部署引导:未配齐 + 没走完 + 没主动跳过时,落到总览页自动带去 /setup(每会话只跳一次,不劫持深链)。
  const { data: setup } = useQuery({ queryKey: ['setup-status'], queryFn: () => apiGet<SetupStatus>('/api/setup/status', true), retry: false, staleTime: 60_000 });
  useEffect(() => {
    if (setupRedirected) return;
    // 一旦本会话到过引导页(自动或手动),就不再自动跳 —— 也避免「以后再说」navigate('/') 时撞上
    // 尚未刷新的 dismissed 状态被弹回 /setup。
    if (loc.pathname === '/setup') { setSetupRedirected(true); return; }
    if (setup && loc.pathname === '/' && !setup.completed && !setup.dismissed && !setup.allRequiredDone) {
      setSetupRedirected(true);
      navigate('/setup');
    }
  }, [setup, loc.pathname, navigate, setupRedirected]);

  // 侧栏页脚显示版本(轻量,不轮询;未鉴权时静默回退)
  const { data: health } = useQuery({ queryKey: ['health-ver'], queryFn: () => apiGet<HealthInfo>('/api/health'), retry: false, staleTime: 5 * 60_000 });

  function toggleCollapse() {
    setCollapsed((c) => { const v = !c; try { localStorage.setItem('or_sidebar', v ? '1' : '0'); } catch { /* ignore */ } return v; });
  }

  if (loc.pathname === '/login') {
    return <Routes><Route path="/login" element={<LoginPage />} /></Routes>;
  }

  return (
    <div className={'shell' + (collapsed ? ' is-collapsed' : '')}>
      <Sidebar nav={NAV} collapsed={collapsed} onToggle={toggleCollapse} version={health?.version} />
      <div className="main">
        <TopBar />
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/console" element={<ConsolePage />} />
          <Route path="/engine-config" element={<EngineConfigPage />} />
          <Route path="/strategies" element={<StrategiesPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:jobId" element={<RunDetailPage />} />
          <Route path="/results" element={<ResultsPage />} />
          <Route path="/cards" element={<CardsPage />} />
          <Route path="/proxies" element={<ProxiesPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/addresses" element={<AddressesPage />} />
          <Route path="/adspower" element={<AdsPowerPage />} />
          <Route path="/captcha" element={<CaptchaPage />} />
          <Route path="/mailbox" element={<MailboxPage />} />
          <Route path="/cluster" element={<ClusterPage />} />
          <Route path="/diagnose" element={<DiagnosePage />} />
          <Route path="/analysis" element={<AnalysisPage />} />
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/health" element={<HealthPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<ComingSoon title="页面不存在" note="检查地址,或从左侧导航进入。" />} />
        </Routes>
      </div>
    </div>
  );
}
