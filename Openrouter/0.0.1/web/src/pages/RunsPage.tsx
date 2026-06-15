// 运行历史列表:过往任务一览,点行下钻。数据 /api/runs。表格用通用 DataTable(排序/筛选/搜索/列设置)。
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api';
import { Icon } from '../lib/icons';
import { useToast } from '../lib/toast';
import { fmtDateTime, fmtDuration } from '../lib/parse';
import type { RunsResp, RunSummary } from '../lib/types';
import { RunStatus, BILLING_ACTION_LABEL, EngineBadge, ENGINE_LABEL } from '../features/runs';
import { Kpi } from '../components/Kpi';
import { DataTable, type Column, type FilterDef } from '../components/DataTable';

const RUN_STATUS_LABEL: Record<string, string> = { running: '运行中', finished: '完成', error: '异常', interrupted: '中断' };

const COLUMNS: Column<RunSummary>[] = [
  { key: 'startedAt', label: '开始时间', sortAccessor: (r) => r.startedAt, exportValue: (r) => fmtDateTime(r.startedAt), className: 'mono', cellStyle: { color: 'var(--text-3)' }, render: (r) => fmtDateTime(r.startedAt) },
  { key: 'engine', label: '引擎', sortAccessor: (r) => r.engine || 'playwright', exportValue: (r) => ENGINE_LABEL[r.engine || 'playwright'] || r.engine || 'playwright', render: (r) => <EngineBadge engine={r.engine} /> },
  { key: 'mode', label: '模式', className: 'mono', exportValue: (r) => r.params?.mode || '', render: (r) => r.params?.mode || '—' },
  { key: 'billingAction', label: '计费', className: 'mono', cellStyle: { color: 'var(--text-2)' }, exportValue: (r) => BILLING_ACTION_LABEL[r.params?.billingAction || 'none'] || r.params?.billingAction || '', render: (r) => BILLING_ACTION_LABEL[r.params?.billingAction || 'none'] || r.params?.billingAction || '—' },
  { key: 'total', label: '账号', className: 'mono', align: 'right', sortAccessor: (r) => r.total, render: (r) => r.total },
  { key: 'success', label: '成功', className: 'mono', align: 'right', sortAccessor: (r) => r.success, cellStyle: { color: 'var(--success)' }, render: (r) => r.success },
  { key: 'failed', label: '失败', className: 'mono', align: 'right', sortAccessor: (r) => r.failed, cellStyle: { color: 'var(--danger)' }, render: (r) => r.failed },
  { key: 'incomplete', label: '未完整', className: 'mono', align: 'right', sortAccessor: (r) => r.incomplete != null ? r.incomplete : Math.max(0, r.total - r.success - r.failed), exportValue: (r) => r.incomplete != null ? r.incomplete : Math.max(0, r.total - r.success - r.failed), cellStyle: { color: 'var(--text-3)' }, render: (r) => (r.incomplete != null ? r.incomplete : Math.max(0, r.total - r.success - r.failed)) || 0 },
  { key: 'durationMs', label: '用时', className: 'mono', align: 'right', sortAccessor: (r) => r.durationMs || 0, exportValue: (r) => fmtDuration(r.durationMs), cellStyle: { color: 'var(--text-2)' }, render: (r) => fmtDuration(r.durationMs) },
  { key: 'status', label: '状态', sortAccessor: (r) => r.status, exportValue: (r) => RUN_STATUS_LABEL[r.status] || r.status, render: (r) => <RunStatus status={r.status} partial={r.partial} completenessPct={r.completenessPct} /> },
  { key: 'jobId', label: 'jobId', className: 'mono', cellStyle: { color: 'var(--text-4)' }, render: (r) => <span title={r.jobId}>{r.jobId.slice(-10)}</span> },
];
const FILTERS: FilterDef<RunSummary>[] = [
  { key: 'engine', label: '引擎', accessor: (r) => r.engine || 'playwright', options: Object.entries(ENGINE_LABEL).map(([value, label]) => ({ value, label })) },
  { key: 'status', label: '状态', accessor: (r) => r.status, options: [{ value: 'running', label: '运行中' }, { value: 'finished', label: '完成' }, { value: 'error', label: '异常' }] },
];

export default function RunsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, isLoading, isError, error } = useQuery({ queryKey: ['runs'], queryFn: () => apiGet<RunsResp>('/api/runs?limit=200', true), refetchInterval: 5000 });
  const runs = data?.runs || [];

  const running = runs.filter((r) => r.status === 'running').length;
  const accSuccess = runs.reduce((n, r) => n + (r.success || 0), 0);
  const accFailed = runs.reduce((n, r) => n + (r.failed || 0), 0);
  const accTotal = runs.reduce((n, r) => n + (r.total || 0), 0);
  const rate = accTotal ? Math.round((accSuccess / accTotal) * 100) : 0;

  return (
    <main className="page">
      <div className="page-head"><h1>运行历史</h1><p>本节点 · 共 {runs.length} 次 · 每 5s 刷新 · 点任一行查看该次的账号与错误明细</p></div>

      <div className="kpi-grid">
        <Kpi icon="history" label="总运行" value={runs.length} sub={running ? `运行中 ${running}` : '全部完成'} />
        <Kpi icon="okcircle" label="成功账号" value={accSuccess} tone="ok" sub={`共 ${accTotal} 个`} />
        <Kpi icon="xcircle" label="失败账号" value={accFailed} tone={accFailed ? 'warn' : undefined} />
        <Kpi icon="activity" label="成功率" value={accTotal ? rate + '%' : '—'} tone="info" sub={`成功 ${accSuccess} / ${accTotal}`} />
      </div>

      <div className="section-gap" />

      <section className="card">
        <DataTable
          rows={runs}
          columns={COLUMNS}
          rowKey={(r) => r.jobId}
          onRowClick={(r) => navigate(`/runs/${r.jobId}`)}
          loading={isLoading}
          error={isError ? ((error as Error)?.message || '加载失败') : null}
          search={{ keys: [(r) => r.jobId, (r) => r.params?.mode || '', (r) => r.engine || ''], placeholder: '搜索 jobId / 模式 / 引擎…' }}
          filters={FILTERS}
          columnSettings={{ tableId: 'runs' }}
          exportName="runs"
          initialSort={{ key: 'startedAt', dir: 'desc' }}
          maxHeight={640}
          emptyText="还没有运行记录。去控制台跑一批,这里会自动出现(含进行中)。"
          toolbarLeft={<>
            <button className="btn btn-ghost btn-sm" onClick={() => qc.invalidateQueries({ queryKey: ['runs'] })}><Icon name="refresh" size={12} />刷新</button>
            <button className="btn btn-danger-soft btn-sm" onClick={async () => { if (!confirm('清空运行历史?(不影响 batch-results 结果文件)')) return; await apiPost('/api/runs/clear'); qc.invalidateQueries({ queryKey: ['runs'] }); toast.push('运行历史已清空', 'ok'); }}><Icon name="trash" size={12} />清空历史</button>
          </>}
        />
      </section>
    </main>
  );
}
