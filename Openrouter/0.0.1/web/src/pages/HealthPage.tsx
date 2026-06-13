// 系统健康:配置健康分(非 SLA)+ 存储占比 + 节点 KPI + 配置自检 + 集群节点。
// 只用我们真采集的数据(配置自检/告警/uptime/存储/peers);QPS/延迟/CPU 等未采集,不画占位假图。
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { Icon } from '../lib/icons';
import type { HealthInfo } from '../lib/types';
import { Gauge, Donut, type Seg } from '../components/charts';
import { DataTable, type Column } from '../components/DataTable';

function fmtBytes(n: number) { if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }
function fmtUptime(s: number) { if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm'; const h = Math.floor(m / 60); return `${h}h${m % 60}m`; }

type Peer = HealthInfo['peers'][number];
const PEER_COLS: Column<Peer>[] = [
  { key: 'nodeId', label: '节点', className: 'mono', sortAccessor: (p) => p.nodeId, render: (p) => p.nodeId },
  { key: 'url', label: '地址', className: 'mono', cellStyle: { color: 'var(--text-2)' }, render: (p) => p.url || '—' },
  { key: 'ageSec', label: '最后心跳', className: 'mono', align: 'right', cellStyle: { color: 'var(--text-3)' }, sortAccessor: (p) => p.ageSec, render: (p) => `${p.ageSec}s 前` },
];

export default function HealthPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError, error } = useQuery({ queryKey: ['health'], queryFn: () => apiGet<HealthInfo>('/api/health', true), refetchInterval: 10000 });

  const score = data ? Math.max(0, Math.min(100, 100 - data.warnings.length * 15 - (data.uptimeSec < 60 ? 10 : 0))) : 0;
  const scoreColor = score >= 80 ? '--success' : score >= 60 ? '--warn' : '--danger';
  const storageSegs: Seg[] = data ? [
    { label: '结果', value: Math.max(0, Math.round(data.storage.resultsBytes / 1024)), colorVar: '--primary' },
    { label: '历史', value: Math.max(0, Math.round(data.storage.runsBytes / 1024)), colorVar: '--info' },
  ] : [];
  const totalBytes = data ? data.storage.resultsBytes + data.storage.runsBytes : 0;

  return (
    <main className="page">
      <div className="page-head"><h1>系统健康</h1><p>节点 / 存储 / 配置自检 —— 每 10s 刷新</p></div>

      {isLoading && !data && <div className="card card-pad"><div className="empty-note">检测中…</div></div>}
      {isError && <div className="card card-pad" style={{ background: 'var(--danger-weak)', borderColor: 'var(--danger-bd)' }}><div className="empty-note" style={{ color: 'var(--danger)' }}>健康检测失败:{(error as Error)?.message || '后端无响应'}。请确认服务在线后自动重试(每 10s)。</div></div>}

      {data && (
        <>
          {data.warnings.length > 0 ? (
            <section className="card card-pad" style={{ background: 'var(--warn-weak)', borderColor: 'var(--warn-bd)' }}>
              <div className="panel-sec-head"><span className="ps-title" style={{ color: 'var(--warn)' }}><Icon name="alert" size={14} />配置告警({data.warnings.length})</span></div>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: 'var(--text-2)', fontSize: 12.5, lineHeight: 1.8 }}>
                {data.warnings.map((w, i) => <li key={i}>{w} <Link to="/settings" style={{ color: 'var(--primary-text)' }}>去设置</Link></li>)}
              </ul>
            </section>
          ) : (
            <section className="card card-pad" style={{ background: 'var(--success-weak)', borderColor: 'var(--success-bd)' }}>
              <span className="ps-title" style={{ color: 'var(--success)' }}><Icon name="okcircle" size={14} />配置自检通过 —— 验证码 / 邮箱 key 已配,访问安全 OK</span>
            </section>
          )}

          <div className="section-gap" />

          {/* 健康分 + 存储占比 */}
          <div className="grid-2">
            <section className="card">
              <div className="card-head"><span className="idx c-info">♥</span><h3>配置健康分</h3></div>
              <div style={{ padding: '8px 18px 18px', display: 'flex', justifyContent: 'center' }}>
                <Gauge value={score} colorVar={scoreColor} label={score >= 80 ? '健康' : score >= 60 ? '注意' : '风险'} sub="基于配置自检 / 告警(非可用性 SLA)" />
              </div>
            </section>
            <section className="card">
              <div className="card-head"><span className="idx c-green">▤</span><h3>结果存储占比 <span className="head-hint">(KB)</span></h3></div>
              <div style={{ padding: '16px 18px' }}>
                {totalBytes > 0 ? <Donut data={storageSegs} centerValue={fmtBytes(totalBytes)} centerLabel={`${data.storage.resultFiles} 文件`} onSelect={(i) => navigate(i === 0 ? '/results' : '/runs')} /> : <div className="empty-note">暂无结果文件。</div>}
              </div>
            </section>
          </div>

          <div className="section-gap" />

          {/* 节点 KPI */}
          <div className="kpi-grid">
            <div className="card kpi"><div className="kpi-label"><Icon name="server" />节点</div><div className="kpi-num" style={{ fontSize: 18 }}>{data.nodeId}</div><div className="kpi-sub">{data.role === 'master' ? '中心机 / 单机' : '子机 → ' + data.centralUrl} · {data.hostname}</div></div>
            <div className="card kpi info"><div className="kpi-label"><Icon name="activity" />运行时长</div><div className="kpi-num">{fmtUptime(data.uptimeSec)}</div><div className="kpi-sub">版本 v{data.version}</div></div>
            <div className="card kpi"><div className="kpi-label"><Icon name="grid" />在线子机</div><div className="kpi-num">{data.peers.length}</div><div className="kpi-sub">{data.peers.length ? data.peers.map((p) => p.nodeId).join(', ') : '无(单机)'}</div></div>
            <div className="card kpi"><div className="kpi-label"><Icon name="layers" />结果存储</div><div className="kpi-num" style={{ fontSize: 20 }}>{fmtBytes(data.storage.resultsBytes)}</div><div className="kpi-sub">{data.storage.resultFiles} 个文件 · 历史 {fmtBytes(data.storage.runsBytes)}</div></div>
          </div>

          <div className="section-gap" />

          {/* 配置状态 */}
          <section className="card">
            <div className="eb-top"><span className="idx c-info">i</span><h3>配置状态</h3><Link className="link-btn" to="/settings" style={{ marginLeft: 'auto' }}><Icon name="settings" size={14} />去设置中心</Link></div>
            <div style={{ padding: '16px 18px', display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              <span className={'kbadge ' + (data.config.captchaKeySet ? 'ok' : 'fail')}>验证码 key {data.config.captchaKeySet ? '已设置' : '未设置'}{data.config.captchaProvider ? ' · ' + data.config.captchaProvider : ''}</span>
              <span className={'kbadge ' + (data.config.mailboxKeySet ? 'ok' : 'fail')}>邮箱 key {data.config.mailboxKeySet ? '已设置' : '未设置'}{data.config.mailboxProvider ? ' · ' + data.config.mailboxProvider : ''}</span>
              <span className={'kbadge ' + (data.config.tokenSet ? 'ok' : 'warn')}>访问令牌 {data.config.tokenSet ? '已设置' : '未设置'}</span>
              <span className={'kbadge ' + (data.config.gateStatic ? 'info' : 'neutral')}>页面令牌门 {data.config.gateStatic ? '开' : '关'}</span>
            </div>
            <div style={{ padding: '0 18px 14px' }}><p className="help" style={{ margin: 0 }}>注:本机不采集 QPS / 延迟分位 / CPU 内存 / SLA 等运行指标,故不展示这些图表。</p></div>
          </section>

          {/* 集群节点 */}
          {data.peers.length > 0 && (
            <>
              <div className="section-gap" />
              <section className="card">
                <div className="eb-top"><span className="idx c-green">▥</span><h3>集群节点</h3></div>
                <DataTable rows={data.peers} columns={PEER_COLS} rowKey={(p) => p.nodeId} initialSort={{ key: 'ageSec', dir: 'asc' }} maxHeight={400} emptyText="无在线子机" exportName="health-peers" columnSettings={{ tableId: 'health-peers' }} search={{ keys: [(p) => p.nodeId, (p) => p.url], placeholder: '搜索 节点 / 地址…' }} />
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}
