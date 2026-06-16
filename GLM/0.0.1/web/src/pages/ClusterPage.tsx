// 集群(系统页):本机信息 + 在线子机列表 + 各机 AdsPower 状态。
// 边界:**当前只聚合结果,不派发任务**;各机配置在各自机器上改;自动派发为后续。
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { Icon } from '../lib/icons';
import { downloadCsv } from '../lib/export';
import type { HealthInfo } from '../lib/types';
import { Kpi } from '../components/Kpi';
import { DataTable, type Column } from '../components/DataTable';

interface ClusterResp { nodeId: string; hosts: string[]; peers: { nodeId: string; url: string; ageSec: number }[] }
type Peer = ClusterResp['peers'][number];

const PEER_COLS: Column<Peer>[] = [
  { key: 'nodeId', label: '节点', className: 'mono', sortAccessor: (p) => p.nodeId, render: (p) => p.nodeId },
  { key: 'url', label: '地址', className: 'mono', cellStyle: { color: 'var(--text-2)' }, render: (p) => p.url || '—' },
  { key: 'ageSec', label: '最后心跳', className: 'mono', align: 'right', cellStyle: { color: 'var(--text-3)' }, sortAccessor: (p) => p.ageSec, exportValue: (p) => `${p.ageSec}s`, render: (p) => `${p.ageSec}s 前` },
  { key: 'live', label: '状态', sortAccessor: (p) => p.ageSec < 90 ? 0 : 1, exportValue: (p) => p.ageSec < 90 ? '在线' : '疑似离线', render: (p) => p.ageSec < 90 ? <span className="kbadge ok">在线</span> : <span className="kbadge warn">疑似离线</span> },
];

interface DispatchRec { parentJobId: string; at: number; engine: string; total: number; dispatched: number; targets: number; slices: { target: string; accepted: number; count: number; ok: boolean; error?: string }[] }

export default function ClusterPage() {
  const { data } = useQuery({ queryKey: ['cluster'], queryFn: () => apiGet<ClusterResp>('/api/cluster', true), refetchInterval: 8000 });
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: () => apiGet<HealthInfo>('/api/health', true), refetchInterval: 10000 });
  const { data: disp } = useQuery({ queryKey: ['dispatch-recent'], queryFn: () => apiGet<{ dispatches: DispatchRec[] }>('/api/dispatch/recent', true), refetchInterval: 8000 });
  const dispatches = disp?.dispatches || [];
  const [ping, setPing] = useState<{ ok?: boolean; latencyMs?: number; apiBase?: string; error?: string } | null>(null);
  async function testSelf() { setPing(null); try { setPing(await apiGet('/api/adspower/ping')); } catch (e) { setPing({ ok: false, error: (e as Error).message }); } }

  const peers = data?.peers || [];
  const hosts = data?.hosts || [];

  return (
    <main className="page">
      <div className="page-head"><h1>集群</h1><p>多机:在线子机 + 各机 AdsPower 状态。<b>当前只聚合结果,不派发任务</b>;各机配置在各自机器上改。</p></div>

      <section className="card card-pad" style={{ background: 'var(--info-weak)', borderColor: 'var(--info-bd)' }}>
        <span className="ps-title" style={{ color: 'var(--info)' }}><Icon name="info" size={14} />集群当前=结果聚合(中心机向各机拉结果去重,见 <Link to="/results" style={{ color: 'var(--primary-text)' }}>结果聚合</Link>)。<b>任务自动派发(中心机拆一批给多台机各用自己 AdsPower 跑)为后续</b>;现在每台机各自在自己控制台起任务。</span>
      </section>

      <div className="section-gap" />

      <div className="kpi-grid">
        <Kpi icon="server" label="本机" value={data?.nodeId || health?.nodeId || '…'} sub={health ? (health.role === 'master' ? '中心机 / 单机' : '子机') : ''} />
        <Kpi icon="grid" label="在线子机" value={peers.length} tone="info" sub={peers.length ? peers.map((p) => p.nodeId).join(', ').slice(0, 40) : '无(单机)'} />
        <Kpi icon="layers" label="静态 hosts" value={hosts.length} sub="config.cluster.hosts" />
        <Kpi icon="cpu" label="本机 AdsPower" value={ping ? (ping.ok ? '连通' : '不通') : '点测试'} tone={ping?.ok ? 'ok' : undefined} sub={ping?.apiBase || ''} />
      </div>

      <div className="section-gap" />

      <section className="card">
        <div className="eb-top"><span className="idx c-info">♥</span><h3>本机 AdsPower 端点</h3><Link className="link-btn" to="/adspower" style={{ marginLeft: 'auto' }}><Icon name="settings" size={14} />配置端点</Link></div>
        <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn btn-ghost btn-sm" onClick={testSelf}><Icon name="activity" size={13} />测试本机连通</button>
          {ping && (ping.ok ? <span className="kbadge ok">连通 ✓ {ping.latencyMs}ms · {ping.apiBase}</span> : <span className="kbadge fail">不通 {ping.error || ''} · {ping.apiBase || ''}</span>)}
          <span className="help" style={{ margin: 0 }}>每台机的 AdsPower 端点在该机「AdsPower」页配;此处测的是<b>本机</b>。</span>
        </div>
      </section>

      <div className="section-gap" />

      <section className="card">
        <div className="eb-top"><span className="idx c-green">▥</span><h3>在线子机</h3><span className="head-hint">子机配 cluster.centralUrl 后自动注册 + 每 30s 心跳</span></div>
        {peers.length ? <DataTable rows={peers} columns={PEER_COLS} rowKey={(p) => p.nodeId} initialSort={{ key: 'ageSec', dir: 'asc' }} maxHeight={420} exportName="cluster-peers" columnSettings={{ tableId: 'cluster-peers' }} search={{ keys: [(p) => p.nodeId, (p) => p.url], placeholder: '搜索 节点 / 地址…' }} filters={[{ key: 'live', label: '状态', accessor: (p) => p.ageSec < 90 ? 'live' : 'stale', options: [{ value: 'live', label: '在线' }, { value: 'stale', label: '疑似离线' }] }]} /> : (
          <div className="empty-note">无在线子机(单机运行)。要多机:在子机 <Link to="/settings" style={{ color: 'var(--primary-text)' }}>设置中心 → 多机集群</Link> 填中心机地址。</div>
        )}
      </section>

      <div className="section-gap" />
      <section className="card">
        <div className="eb-top"><span className="idx c-amber">↗</span><h3>最近派发</h3><span className="head-hint">控制台「多机派发」把一批拆给各机执行的记录(本会话内)</span>
          {dispatches.length > 0 && <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => downloadCsv('dispatches', ['时间', '引擎', '账号总数', '已派发', '目标台数', '明细'], dispatches.map((d) => [new Date(d.at).toISOString().replace('T', ' ').slice(0, 19), d.engine, d.total, d.dispatched, d.targets, d.slices.map((s) => `${s.target}:${s.ok ? s.accepted : 'fail'}`).join(' / ')]))}><Icon name="download" size={13} />导出</button>}
        </div>
        <div style={{ padding: '12px 18px 16px' }}>
          {dispatches.length ? dispatches.map((d) => (
            <div key={d.parentJobId} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="mono" style={{ color: 'var(--text-3)' }}>{new Date(d.at).toLocaleString('zh-CN', { hour12: false })}</span>
                <span className="kbadge info">{d.engine}</span>
                <span className="kbadge neutral">共 {d.total} 账号</span>
                <span className={'kbadge ' + (d.dispatched === d.targets ? 'ok' : 'warn')}>{d.dispatched}/{d.targets} 台接受</span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                {d.slices.map((s, i) => <span key={i} className={'kbadge ' + (s.ok ? 'ok' : 'fail')}>{s.target}: {s.ok ? s.accepted + ' 账号 ✓' : '失败 ' + (s.error || '')}</span>)}
              </div>
            </div>
          )) : <div className="empty-note">暂无派发记录。去控制台开「多机派发」选目标机后执行。</div>}
        </div>
      </section>
    </main>
  );
}
