// AdsPower(资源页):①端点池(多台机/多实例:label+地址+密钥+连通)②环境编号池(绑所属端点)。
// 边界:只管 AdsPower 端点与环境。不管代理、不管账号。端点池为空则回退 config 单端点;改完新任务生效。
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { Icon } from '../lib/icons';
import { useToast } from '../lib/toast';
import type { AdsPowerEnv, AdsPowerEndpoint } from '../lib/types';
import { Kpi } from '../components/Kpi';
import { Modal } from '../components/Modal';
import { ImportModal } from '../components/ImportModal';
import { RowMenu } from '../components/RowMenu';
import { batchRun } from '../lib/batch';
import { DataTable, type Column } from '../components/DataTable';

export default function AdsPowerPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: epData } = useQuery({ queryKey: ['adspower-endpoints'], queryFn: () => apiGet<{ items: AdsPowerEndpoint[] }>('/api/adspower/endpoints', true), refetchInterval: 15000 });
  const { data: envData } = useQuery({ queryKey: ['adspower'], queryFn: () => apiGet<{ items: AdsPowerEnv[] }>('/api/adspower', true), refetchInterval: 15000 });
  const eps = epData?.items || [];
  const envs = envData?.items || [];
  const epById = new Map(eps.map((e) => [e.id, e]));

  const invalEp = () => qc.invalidateQueries({ queryKey: ['adspower-endpoints'] });
  const invalEnv = () => qc.invalidateQueries({ queryKey: ['adspower'] });
  const epAdd = useMutation({ mutationFn: (b: unknown) => apiPost('/api/adspower/endpoints/add', b), onSuccess: invalEp });
  const epUpd = useMutation({ mutationFn: (b: unknown) => apiPost('/api/adspower/endpoints/update', b), onSuccess: invalEp });
  const epDel = useMutation({ mutationFn: (b: unknown) => apiPost('/api/adspower/endpoints/remove', b), onSuccess: invalEp });
  const epTest = useMutation({ mutationFn: (b: unknown) => apiPost('/api/adspower/endpoints/test', b), onSuccess: invalEp });
  const envAdd = useMutation({ mutationFn: (b: unknown) => apiPost('/api/adspower/add', b), onSuccess: invalEnv });
  const envUpd = useMutation({ mutationFn: (b: unknown) => apiPost('/api/adspower/update', b), onSuccess: invalEnv });
  const envDel = useMutation({ mutationFn: (b: unknown) => apiPost('/api/adspower/remove', b), onSuccess: invalEnv });
  const envClear = useMutation({ mutationFn: (b: unknown) => apiPost('/api/adspower/clear', b), onSuccess: invalEnv });

  const [epOpen, setEpOpen] = useState(false);
  const [epForm, setEpForm] = useState<{ id?: string; label: string; apiBase: string; apiKey: string; apiKeySet?: boolean; clearKey?: boolean }>({ label: '', apiBase: 'http://127.0.0.1:50325', apiKey: '' });
  const [envOpen, setEnvOpen] = useState(false);
  const [envEp, setEnvEp] = useState('');
  const [testing, setTesting] = useState(false);

  const epActive = eps.filter((e) => e.status === 'active').length;
  const epOk = eps.filter((e) => e.lastOk === true).length;
  const envActive = envs.filter((e) => e.status === 'active').length;

  async function testAllEp() { setTesting(true); try { await epTest.mutateAsync({}); toast.push('端点连通测试完成', 'ok'); } finally { setTesting(false); } }

  const epCols: Column<AdsPowerEndpoint>[] = [
    { key: 'label', label: '标签', className: 'mono', sortAccessor: (e) => e.label, render: (e) => e.label },
    { key: 'apiBase', label: 'API 地址', className: 'mono', cellStyle: { color: 'var(--text-2)' }, render: (e) => e.apiBase },
    { key: 'apiKeySet', label: '密钥', exportValue: (e) => e.apiKeySet ? '已设置' : '无', render: (e) => e.apiKeySet ? <span className="kbadge ok">已设置</span> : <span className="kbadge neutral">无</span> },
    { key: 'status', label: '状态', sortAccessor: (e) => e.status, exportValue: (e) => e.status === 'active' ? '可用' : '停用', render: (e) => e.status === 'active' ? <span className="kbadge ok">可用</span> : <span className="kbadge neutral">停用</span> },
    { key: 'lastOk', label: '连通/延迟', className: 'mono', align: 'right', sortAccessor: (e) => e.lastOk === false ? 9e9 : (e.latencyMs ?? 8e9), exportValue: (e) => e.lastOk == null ? '未测' : e.lastOk ? `${e.latencyMs}ms` : '不通', render: (e) => e.lastOk == null ? <span style={{ color: 'var(--text-4)' }}>未测</span> : e.lastOk ? <span style={{ color: 'var(--success)' }}>{e.latencyMs}ms</span> : <span style={{ color: 'var(--danger)' }}>不通</span> },
    { key: 'envCount', label: '绑定环境', className: 'mono', align: 'right', exportValue: (e) => envs.filter((v) => v.endpoint === e.id).length, render: (e) => envs.filter((v) => v.endpoint === e.id).length },
    { key: 'actions', label: '操作', align: 'right', alwaysVisible: true, render: (e) => (
      <RowMenu
        inline={<button className="btn btn-ghost btn-sm" onClick={() => epTest.mutate({ id: e.id })}>测试</button>}
        actions={[
          { label: '编辑', icon: 'edit', onClick: () => { setEpForm({ id: e.id, label: e.label, apiBase: e.apiBase, apiKey: '', apiKeySet: e.apiKeySet, clearKey: false }); setEpOpen(true); } },
          { label: e.status === 'active' ? '停用' : '启用', icon: e.status === 'active' ? 'pause' : 'play', onClick: () => epUpd.mutate({ id: e.id, patch: { status: e.status === 'active' ? 'disabled' : 'active' } }) },
          { label: '删除', icon: 'trash', danger: true, onClick: () => { if (confirm('删除该端点?')) epDel.mutate({ id: e.id }); } },
        ]}
      />
    ) },
  ];
  const envCols: Column<AdsPowerEnv>[] = [
    { key: 'id', label: '环境编号', className: 'mono', sortAccessor: (e) => e.id, render: (e) => e.id },
    { key: 'label', label: '标签', render: (e) => <input className="cell-num" style={{ width: 100 }} defaultValue={e.label} placeholder="备注" onBlur={(ev) => { if (ev.target.value !== e.label) envUpd.mutate({ id: e.id, patch: { label: ev.target.value } }); }} /> },
    { key: 'endpoint', label: '所属端点', exportValue: (e) => epById.get(e.endpoint || '')?.label || '(默认/本机)', render: (e) => (
      <select className="dt-filter" style={{ minWidth: 110 }} value={e.endpoint || ''} onChange={(ev) => envUpd.mutate({ id: e.id, patch: { endpoint: ev.target.value } })}>
        <option value="">(默认/本机)</option>
        {eps.map((ep) => <option key={ep.id} value={ep.id}>{ep.label}</option>)}
      </select>
    ) },
    { key: 'status', label: '状态', sortAccessor: (e) => e.status, exportValue: (e) => e.status === 'active' ? '可用' : '停用', render: (e) => e.status === 'active' ? <span className="kbadge ok">可用</span> : <span className="kbadge neutral">停用</span> },
    { key: 'useCount', label: '用量', className: 'mono', align: 'right', sortAccessor: (e) => e.useCount, render: (e) => e.useCount },
    { key: 'actions', label: '操作', align: 'right', alwaysVisible: true, render: (e) => (
      <RowMenu
        inline={<Link className="btn btn-ghost btn-sm" to={`/diagnose?by=env&value=${e.id}`} title="诊断该环境">🔍</Link>}
        actions={[
          { label: e.status === 'active' ? '停用' : '启用', icon: e.status === 'active' ? 'pause' : 'play', onClick: () => envUpd.mutate({ id: e.id, patch: { status: e.status === 'active' ? 'disabled' : 'active' } }) },
          { label: '删除', icon: 'trash', danger: true, onClick: () => { if (confirm('删除该环境编号?')) envDel.mutate({ id: e.id }); } },
        ]}
      />
    ) },
  ];

  return (
    <main className="page">
      <div className="page-head"><h1>AdsPower</h1><p>①端点池(每台机/实例的 API 地址+密钥)②环境编号池(绑所属端点)。<b>不管代理/账号</b>;端点池空则回退 config 单端点;改完<b>新任务</b>生效。</p></div>

      {/* 报表 */}
      <div className="kpi-grid">
        <Kpi icon="server" label="端点数" value={eps.length} sub={`可用 ${epActive}`} />
        <Kpi icon="okcircle" label="端点连通" value={epOk} tone="ok" sub={`已测 ${eps.filter((e) => e.lastTestedAt).length}`} />
        <Kpi icon="cpu" label="环境总数" value={envs.length} tone="info" sub={`可用 ${envActive}`} />
        <Kpi icon="layers" label="环境累计用量" value={envs.reduce((n, e) => n + (e.useCount || 0), 0)} />
      </div>

      <div className="section-gap" />

      {/* ① 端点池 */}
      <section className="card">
        <div className="eb-top"><span className="idx c-info">①</span><h3>AdsPower 端点池</h3><span className="head-hint">多台机/多实例;别用 local.adspower.net(开代理 502)</span></div>
        <DataTable
          rows={eps} columns={epCols} rowKey={(e) => e.id}
          getRowClass={(e) => e.status === 'disabled' ? 'is-used' : e.lastOk === false ? 'is-banned' : undefined}
          search={{ keys: [(e) => e.label, (e) => e.apiBase], placeholder: '搜索 标签 / 地址…' }}
          filters={[
            { key: 'status', label: '状态', accessor: (e) => e.status, options: [{ value: 'active', label: '可用' }, { value: 'disabled', label: '停用' }] },
            { key: 'conn', label: '连通', accessor: (e) => e.lastOk == null ? 'untested' : e.lastOk ? 'ok' : 'fail', options: [{ value: 'ok', label: '连通' }, { value: 'fail', label: '不通' }, { value: 'untested', label: '未测' }] },
          ]}
          columnSettings={{ tableId: 'adspower-endpoints' }} maxHeight={360} exportName="adspower-endpoints"
          emptyText="端点池为空(当前回退 config 单端点/127.0.0.1:50325)。点「添加端点」管多台机。"
          toolbarLeft={<>
            <button className="btn btn-soft btn-sm" onClick={() => { setEpForm({ label: '', apiBase: 'http://127.0.0.1:50325', apiKey: '' }); setEpOpen(true); }}><Icon name="upload" size={12} />添加端点</button>
            <button className="btn btn-ghost btn-sm" disabled={testing || !eps.length} onClick={testAllEp}><Icon name="activity" size={12} />{testing ? '测试中…' : '测试全部连通'}</button>
          </>}
        />
      </section>

      <div className="section-gap" />

      {/* ② 环境编号池 */}
      <div className="grid-2">
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="eb-top"><span className="idx c-green">②</span><h3>环境编号池</h3><span className="head-hint">指纹环境编号(envId),绑定所属端点;任务可复用</span></div>
          <DataTable
            rows={envs} columns={envCols} rowKey={(e) => e.id}
            getRowClass={(e) => e.status === 'disabled' ? 'is-used' : undefined}
            search={{ keys: [(e) => e.id, (e) => e.label, (e) => epById.get(e.endpoint || '')?.label || ''], placeholder: '搜索 编号 / 标签 / 端点…' }}
            filters={[
              { key: 'status', label: '状态', accessor: (e) => e.status, options: [{ value: 'active', label: '可用' }, { value: 'disabled', label: '停用' }] },
              { key: 'endpoint', label: '端点', accessor: (e) => e.endpoint || '', options: eps.map((ep) => ({ value: ep.id, label: ep.label })) },
            ]}
            columnSettings={{ tableId: 'adspower-envs' }} maxHeight={420} exportName="adspower-envs"
            selectable
            batchActions={(sel, clear) => (<>
              <button className="btn btn-ghost btn-sm" onClick={() => batchRun(sel, (e) => envUpd.mutateAsync({ id: e.id, patch: { status: 'active' } }), { toast, verb: '启用', onDone: clear })}>启用</button>
              <button className="btn btn-ghost btn-sm" onClick={() => batchRun(sel, (e) => envUpd.mutateAsync({ id: e.id, patch: { status: 'disabled' } }), { toast, verb: '停用', onDone: clear })}>停用</button>
              <button className="btn btn-danger-soft btn-sm" onClick={() => { if (confirm(`删除选中的 ${sel.length} 个环境?`)) batchRun(sel, (e) => envDel.mutateAsync({ id: e.id }), { toast, verb: '删除', onDone: clear }); }}>删除</button>
            </>)}
            emptyText="环境池为空。点「添加环境」粘贴 envId(一行一个或逗号),并选所属端点。"
            toolbarLeft={<>
              <button className="btn btn-soft btn-sm" onClick={() => { setEnvEp(''); setEnvOpen(true); }}><Icon name="upload" size={12} />添加环境</button>
              <button className="btn btn-danger-soft btn-sm" disabled={!envs.length} onClick={() => { if (confirm('清空环境池?')) envClear.mutate({}); }}><Icon name="trash" size={12} />清空</button>
            </>}
            toolbarRight={<><span className="lg-dot" style={{ background: 'var(--success)' }} />可用 {envActive}</>}
          />
        </section>
      </div>

      {/* 端点 Modal */}
      <Modal open={epOpen} onClose={() => setEpOpen(false)} title={epForm.id ? '编辑端点' : '添加 AdsPower 端点'} icon="server" size="md"
        foot={<><button className="btn btn-ghost" onClick={() => setEpOpen(false)}>取消</button><button className="btn btn-primary" disabled={!epForm.apiBase.trim()} onClick={async () => {
          if (epForm.id) await epUpd.mutateAsync({ id: epForm.id, patch: { label: epForm.label, apiBase: epForm.apiBase, ...(epForm.clearKey ? { clearApiKey: true } : (epForm.apiKey.trim() ? { apiKey: epForm.apiKey } : {})) } });
          else await epAdd.mutateAsync({ label: epForm.label, apiBase: epForm.apiBase, apiKey: epForm.apiKey.trim() });
          toast.push('已保存端点', 'ok'); setEpOpen(false);
        }}>保存</button></>}>
        <div style={{ padding: '16px 20px', display: 'grid', gap: 12 }}>
          <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">标签</span><span className="l-hint">如 机器1 / 北京-A</span></div><input type="text" value={epForm.label} placeholder="机器1" onChange={(e) => setEpForm((s) => ({ ...s, label: e.target.value }))} /></div>
          <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">API 地址</span><span className="l-hint">如 http://127.0.0.1:50325 或 http://机器IP:50325</span></div><input type="text" value={epForm.apiBase} onChange={(e) => setEpForm((s) => ({ ...s, apiBase: e.target.value }))} /></div>
          <div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">API 密钥</span><span className="l-hint">本地网关一般无需;{epForm.id ? '留空=不改' : '可留空'}</span></div>
            {/* readonly + 聚焦才解锁 + lp/1p-ignore:彻底挡掉浏览器/密码管理器把它当登录密码自动填充(否则会存进幽灵密钥) */}
            <input type="password" value={epForm.clearKey ? '' : epForm.apiKey} disabled={!!epForm.clearKey} placeholder={epForm.id ? (epForm.apiKeySet ? '留空=保持原密钥' : '可留空') : '可留空'}
              autoComplete="off" name="adspower-endpoint-key-nofill" data-lpignore="true" data-1p-ignore readOnly onFocus={(e) => { e.currentTarget.readOnly = false; }}
              onChange={(e) => setEpForm((s) => ({ ...s, apiKey: e.target.value, clearKey: false }))} />
            {epForm.id && epForm.apiKeySet && (
              <label className="check" style={{ marginTop: 8, fontSize: 12 }}>
                <input type="checkbox" checked={!!epForm.clearKey} onChange={(e) => setEpForm((s) => ({ ...s, clearKey: e.target.checked, apiKey: '' }))} />
                <span className="box"><Icon name="check" size={11} /></span>清除已存密钥(本地端点无需密钥)
              </label>
            )}
          </div>
        </div>
      </Modal>

      {/* 环境 ImportModal(文件 + 粘贴) */}
      <ImportModal open={envOpen} onClose={() => setEnvOpen(false)} title="添加 AdsPower 环境" label="环境编号"
        hint={<>一行一个或逗号隔开;或选文件上传</>}
        placeholder={'k1db9yk8\nk1db9yk7'}
        parse={(t) => ({ kept: t.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean), ignored: 0 })}
        extra={<div className="field" style={{ margin: 0 }}><div className="label"><span className="l-name">所属端点</span><span className="l-hint">这些环境在哪个 AdsPower 端点上</span></div>
          <select value={envEp} onChange={(e) => setEnvEp(e.target.value)}><option value="">(默认/本机)</option>{eps.map((ep) => <option key={ep.id} value={ep.id}>{ep.label}</option>)}</select></div>}
        onImport={(raw) => envAdd.mutateAsync({ raw, endpoint: envEp })}
        formatResult={(r) => { const d = r as { added?: number; dup?: number }; return `新增 ${d.added || 0} · 重复 ${d.dup || 0}`; }} />
    </main>
  );
}
