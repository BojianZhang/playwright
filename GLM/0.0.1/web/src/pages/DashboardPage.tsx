// 总览仪表盘:KPI + 7天趋势(AreaLine)+ 卡池/错误分布(Donut)+ 近期运行。聚合自 /api/overview。
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { Icon } from '../lib/icons';
import { fmtDateTime } from '../lib/parse';
import type { Overview } from '../lib/types';
import { RunStatus } from '../features/runs';
import { Donut, AreaLine, type Seg } from '../components/charts';

const ERR_COLORS = ['--primary', '--info', '--warn', '--danger', '--success', '--primary-text'];

export default function DashboardPage() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ['overview'], queryFn: () => apiGet<Overview>('/api/overview', true), refetchInterval: 8000 });

  const r = data?.runs;
  const trend = data?.trend || [];
  const cardSegs: Seg[] = [
    { label: '可用', value: data?.cards.available ?? 0, colorVar: '--success' },
    { label: '用尽', value: data?.cards.exhausted ?? 0, colorVar: '--warn' },
    { label: '禁用', value: data?.cards.disabled ?? 0, colorVar: '--danger' },
  ];
  const errSegs: Seg[] = (data?.errors.topReasons || []).map((e, i) => ({ label: e.code, value: e.n, colorVar: ERR_COLORS[i % ERR_COLORS.length] }));

  return (
    <main className="page">
      <div className="page-head"><h1>总览</h1><p>状态 · 成败 · 趋势 —— 实时聚合,每 8s 刷新</p></div>

      <div className="kpi-grid">
        <div className="card kpi ok">
          <div className="kpi-label"><Icon name="okcircle" />累计成功账号</div>
          <div className="kpi-num">{r?.accSuccess ?? (isLoading ? '…' : 0)}</div>
          <div className="kpi-sub">失败 {r?.accFailed ?? 0} · 共 {r?.accTotal ?? 0}</div>
        </div>
        <div className="card kpi info">
          <div className="kpi-label"><Icon name="activity" />成功率</div>
          <div className="kpi-num">{r?.successRate ?? 0}<span style={{ fontSize: 16 }}>%</span></div>
          <div className="kpi-sub">{r?.finished ?? 0} 个已完成任务 · {r?.running ?? 0} 个进行中</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label"><Icon name="card" />卡池可用</div>
          <div className="kpi-num">{data?.cards.available ?? 0}<span style={{ fontSize: 15, color: 'var(--text-3)' }}> / {data?.cards.total ?? 0}</span></div>
          <div className="kpi-sub">用尽 {data?.cards.exhausted ?? 0} · 禁用 {data?.cards.disabled ?? 0}</div>
        </div>
        <div className="card kpi warn">
          <div className="kpi-label"><Icon name="alert" />错误记录</div>
          <div className="kpi-num">{data?.errors.total ?? 0}</div>
          <div className="kpi-sub">充值 ${data?.billing.totalCharged ?? 0} · 被拒 {data?.billing.declined ?? 0}</div>
        </div>
      </div>

      <div className="section-gap" />

      <div className="grid-2">
        {/* 近期运行 */}
        <section className="card">
          <div className="card-head"><span className="idx c-info">▸</span><h3>近期运行</h3><Link className="link-btn" to="/runs" style={{ marginLeft: 'auto' }}>全部历史 <Icon name="chevron" size={14} /></Link></div>
          <div className="panel-sec" style={{ paddingTop: 8 }}>
            {!r?.recent.length ? <div className="empty-note">还没有运行记录。去 <Link to="/console" style={{ color: 'var(--primary-text)' }}>控制台</Link> 跑一批。</div> : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>时间</th><th>模式</th><th>账号</th><th>成功</th><th>失败</th><th>状态</th></tr></thead>
                  <tbody>
                    {r.recent.map((run) => (
                      <tr key={run.jobId} className="clickable" onClick={() => navigate(`/runs/${run.jobId}`)}>
                        <td className="mono" style={{ color: 'var(--text-3)' }}>{fmtDateTime(run.startedAt)}</td>
                        <td className="mono">{run.params?.mode || '—'}</td>
                        <td className="mono">{run.total}</td>
                        <td className="mono" style={{ color: 'var(--success)' }}>{run.success}</td>
                        <td className="mono" style={{ color: 'var(--danger)' }}>{run.failed}</td>
                        <td><RunStatus status={run.status} partial={run.partial} completenessPct={run.completenessPct} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        {/* 7 天趋势 */}
        <section className="card">
          <div className="card-head"><span className="idx c-info">📈</span><h3>近 7 天运行趋势</h3></div>
          <div style={{ padding: '14px 18px 16px' }}>
            {trend.length ? <AreaLine labels={trend.map((t) => t.day)} series={[
              { name: '运行', colorVar: '--primary', values: trend.map((t) => t.runs) },
              { name: '成功', colorVar: '--success', values: trend.map((t) => t.success) },
              { name: '失败', colorVar: '--danger', values: trend.map((t) => t.failed) },
            ]} onSelect={() => navigate('/runs')} /> : <div className="empty-note">暂无趋势数据。</div>}
          </div>
        </section>
      </div>

      <div className="section-gap" />

      <div className="grid-2">
        {/* 卡池分布 */}
        <section className="card">
          <div className="card-head"><span className="idx c-green">▤</span><h3>卡池分布</h3><Link className="link-btn" to="/cards" style={{ marginLeft: 'auto' }}>卡池 <Icon name="chevron" size={14} /></Link></div>
          <div style={{ padding: '16px 18px' }}>
            {(data?.cards.total ?? 0) > 0 ? <Donut data={cardSegs} centerValue={data?.cards.total ?? 0} centerLabel="总卡数" onSelect={() => navigate('/cards')} /> : <div className="empty-note">卡池为空。</div>}
          </div>
        </section>

        {/* Top 错误原因 */}
        <section className="card">
          <div className="card-head"><span className="idx c-amber">⚑</span><h3>Top 错误原因</h3><Link className="link-btn" to="/analysis" style={{ marginLeft: 'auto' }}>失败分析 <Icon name="chevron" size={14} /></Link></div>
          <div style={{ padding: '16px 18px' }}>
            {errSegs.length ? <Donut data={errSegs} centerValue={data?.errors.total ?? 0} centerLabel="错误" onSelect={() => navigate('/analysis')} /> : <div className="empty-note">暂无错误。</div>}
          </div>
        </section>
      </div>
    </main>
  );
}
