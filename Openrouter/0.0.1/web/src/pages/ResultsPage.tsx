// 结果聚合页(移植自旧 results.html + results.js):多节点聚合 + 去重 + 搜索 + 导出 + 卡池只读。
// + 改密:四列密码展示(邮箱原/现、OpenRouter 原/现)+ 单行/批量「更新邮箱密码 / OpenRouter 密码」(确认弹窗)。
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { Icon } from '../lib/icons';
import { useToast } from '../lib/toast';
import { trunc } from '../lib/parse';
import { downloadCsv } from '../lib/export';
import type { AccountRow, AggregateResp, CardsResp, PwOverridesMap, PwOverridesResp, PwChangeType, KeyOverridesMap, KeyOverridesResp } from '../lib/types';
import { pwView } from '../lib/pwView';
import { keyView } from '../lib/keyView';
import { DataTable, type Column } from '../components/DataTable';
import { ResultsExportModal } from '../features/ResultsExportModal';
import { ChangePwModal, type PwTarget } from '../features/ChangePwModal';
import { GetKeyModal, type GetKeyTarget } from '../features/GetKeyModal';
import { PwChangeLogModal } from '../features/PwChangeLogModal';

const CARD_STATUS: Record<string, string> = { active: '可用', exhausted: '已用尽', declined: '被拒', disabled: '已禁用', dispatched: '已下发' };

export default function ResultsPage() {
  const toast = useToast();
  const [all, setAll] = useState<AccountRow[]>([]);
  const [sources, setSources] = useState<AggregateResp['sources']>([]);
  const [updatedAt, setUpdatedAt] = useState('');
  const [dedupe, setDedupe] = useState('email+apiKey');
  const [includeLocal, setIncludeLocal] = useState(true);
  const [hosts, setHosts] = useState('');
  const [auto, setAuto] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [selRows, setSelRows] = useState<AccountRow[]>([]);   // 表格里【当前筛选下可见的】勾选行 → 复制/导出/批量改密"选中优先"(DataTable 已按筛选上报)
  const [filteredView, setFilteredView] = useState<AccountRow[] | null>(null);   // 表格当前(搜索/筛选/排序后)的视图 → 未勾选时复制/导出按【筛选后】而非原始全量
  const [busy, setBusy] = useState(false);                    // 删除/清空在飞 → 禁按钮防双击重复提交(后端幂等,纯防重复 toast/请求)
  const [pwModal, setPwModal] = useState<{ type: PwChangeType; targets: PwTarget[] } | null>(null);
  const [pwLogOpen, setPwLogOpen] = useState(false);
  const [getKeyTargets, setGetKeyTargets] = useState<GetKeyTarget[] | null>(null);   // 「获取新Key」弹窗目标(null=关)
  const loadingRef = useRef(false);

  const { data: cards } = useQuery({ queryKey: ['cards'], queryFn: () => apiGet<CardsResp>('/api/cards', true), refetchInterval: auto ? 20000 : false });
  // 改密覆盖账本:把 {original,current} 叠加到四列(改密成功后即时刷新)。
  const { data: ovResp, refetch: refetchOverrides } = useQuery({ queryKey: ['pw-overrides'], queryFn: () => apiGet<PwOverridesResp>('/api/accounts/pw-overrides', true), refetchInterval: auto ? 20000 : false });
  const overrides: PwOverridesMap = ovResp?.overrides || {};
  // 「获取新Key」覆盖账本:把新建的 apiKey 叠加到 API Key 列(取Key成功后即时刷新)。
  const { data: keyResp, refetch: refetchKeyOverrides } = useQuery({ queryKey: ['key-overrides'], queryFn: () => apiGet<KeyOverridesResp>('/api/accounts/key-overrides', true), refetchInterval: auto ? 20000 : false });
  const keyOv: KeyOverridesMap = keyResp?.overrides || {};

  async function loadData(silent: boolean) {
    if (loadingRef.current) return; loadingRef.current = true;
    // 安全阀:/api/aggregate 万一卡死(网络僵死;浏览器 fetch 本身无超时),30s 后强制释放在飞标志,
    // 否则 loadingRef 永久 true → 20s 自动刷新彻底失效、只能手动刷页。仅作用于本页聚合,不动全局 apiPost(免误杀取Key/改密的长 POST)。
    const release = setTimeout(() => { loadingRef.current = false; }, 30000);
    try {
      const data = await apiPost<AggregateResp>('/api/aggregate', { hosts: hosts.split(/\r?\n/).map((s) => s.trim()).filter(Boolean), includeLocal, dedupe }, silent);
      setAll(data.accounts || []); setSources(data.sources || []);
      setUpdatedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    } catch (e) { if (!silent) toast.push('聚合失败:' + (e as Error).message, 'err'); }
    finally { clearTimeout(release); loadingRef.current = false; }
  }

  useEffect(() => { loadData(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 自动刷新会【整集群重聚合 + 全量重渲染】,代价高 → 从 5s 放宽到 20s(默认仍关;跑批时实时进度看控制台 SSE)。
  useEffect(() => { if (!auto) return; const t = setInterval(() => loadData(true), 20000); return () => clearInterval(t); }, [auto, hosts, includeLocal, dedupe]); // eslint-disable-line react-hooks/exhaustive-deps

  function download(name: string, content: string, type: string) {
    const blob = new Blob([content], { type });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const copy = (txt: string) => { navigator.clipboard.writeText(txt).then(() => toast.push('已复制', 'ok'), () => toast.push('复制失败', 'err')); };

  // 改密:单行 → 该号一项;批量 → 选中按邮箱去重。current=该号「改前现密码」(认证用当前密码)。
  function openSingle(type: PwChangeType, a: AccountRow) {
    if (!a.email) { toast.push('该行无邮箱,无法改密', 'err'); return; }
    const v = pwView(a, overrides[a.email]);
    setPwModal({ type, targets: [{ email: a.email, current: type === 'mailbox' ? v.mbCur : v.orCur }] });
  }
  function openBatch(type: PwChangeType) {
    const seen = new Set<string>();
    const targets: PwTarget[] = [];
    for (const a of selRows) {
      const email = a.email || ''; if (!email || seen.has(email)) continue; seen.add(email);
      const v = pwView(a, overrides[email]);
      targets.push({ email, current: type === 'mailbox' ? v.mbCur : v.orCur });
    }
    if (!targets.length) { toast.push('选中行里没有可改密的邮箱', 'err'); return; }
    setPwModal({ type, targets });
  }
  const onPwDone = () => { loadData(false); refetchOverrides(); };

  // 获取新Key:对【缺Key】的号(keyView 为空)登录后新建一把 Key。登录用「OR现密码」(orCur);没 orCur 的号无法登录→剔除并提示。
  //   ★登录会触发 factor-two 邮箱验证码 → 同时带「邮箱现密码」(mbCur)给后端读 OTP(缺则后端退回用 opPw 当邮箱密码)。
  function openGetKey(rows: AccountRow[]) {
    const seen = new Set<string>();
    const targets: GetKeyTarget[] = [];
    let skippedHasKey = 0, skippedNoPw = 0;
    for (const a of rows) {
      const email = a.email || ''; if (!email || seen.has(email)) continue; seen.add(email);
      if (keyView(a, keyOv[email]).trim()) { skippedHasKey += 1; continue; }   // 已有Key(含已取回)→ 无需再取
      const v = pwView(a, overrides[email]);
      if (!v.orCur) { skippedNoPw += 1; continue; }
      targets.push({ email, opPw: v.orCur, mailboxPw: v.mbCur });   // mbCur=邮箱现密码,读 factor-two OTP 用
    }
    if (!targets.length) {
      toast.push(skippedNoPw ? `选中号缺「OR现密码」无法登录取Key(${skippedNoPw} 个)` : '选中行没有缺Key的号', 'err');
      return;
    }
    if (skippedNoPw) toast.push(`${skippedNoPw} 个号缺 OR现密码、已跳过(无法登录)`, 'info');
    setGetKeyTargets(targets);
  }
  const onGetKeyDone = () => { loadData(false); refetchKeyOverrides(); };

  // 删除选中结果行:按 (nodeId,jobId,email,apiKey) 定位;非本机记录后端尝试转发源节点删。
  async function deleteRows(rows: AccountRow[], clearSel: () => void) {
    if (busy) return;
    if (!window.confirm(`删除选中的 ${rows.length} 条结果?\n\n结果含 API Key / 已绑卡,删除后不可恢复(建议先导出备份)。\n非本机的记录会尝试到源节点一并删除。`)) return;
    setBusy(true);
    try {
      const items = rows.map((r) => ({ nodeId: r.nodeId, jobId: r.jobId, email: r.email, apiKey: r.apiKey }));
      const resp = await apiPost<{ localDeleted: number; pushedDeleted: number; remote: { nodeId: string; ok: boolean; deleted?: number; error?: string }[] }>('/api/results/delete', { items });
      const localN = (resp.localDeleted || 0) + (resp.pushedDeleted || 0);
      const remoteN = (resp.remote || []).filter((x) => x.ok).reduce((n, x) => n + (x.deleted || 0), 0);
      const remoteErr = (resp.remote || []).filter((x) => !x.ok);
      const msg = `已删除 本机 ${localN} 条` + (remoteN ? ` · 远端 ${remoteN} 条` : '') + (remoteErr.length ? ` · ${remoteErr.length} 个远端节点未删(${remoteErr.map((e) => e.nodeId).join(', ')})` : '');
      toast.push(msg, remoteErr.length ? 'info' : 'ok');
      clearSel();
      loadData(false);
    } catch (e) { toast.push('删除失败:' + (e as Error).message, 'err'); }
    finally { setBusy(false); }
  }
  async function clearLocal() {
    if (busy) return;
    if (!window.confirm('清空本机所有成功结果?\n\n含 API Key / 已绑卡,删除后不可恢复(建议先点 .json 导出备份)。\n只清本机(含子机推送缓存),不影响其它节点自身的结果。')) return;
    setBusy(true);
    try {
      const r = await apiPost<{ files: number; records: number; pushedFiles: number }>('/api/results/clear', {});
      toast.push(`已清空本机 ${r.records} 条结果(${r.files} 个文件${r.pushedFiles ? ` + ${r.pushedFiles} 个推送缓存` : ''})`, 'ok');
      loadData(false);
    } catch (e) { toast.push('清空失败:' + (e as Error).message, 'err'); }
    finally { setBusy(false); }
  }

  // 密码单元格:值 + 行内「改」按钮(放在「现密码」列,紧跟各自原密码列,点开单号改密弹窗)。
  const pwCell = (val: string, onChange?: () => void) => (
    <span className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {val || '—'}
      {onChange && <button className="btn btn-ghost btn-sm" style={{ padding: '0 6px', lineHeight: '18px' }} title="更改此账号该密码" onClick={onChange}><Icon name="edit" size={11} /> 改</button>}
    </span>
  );

  const columns: Column<AccountRow>[] = useMemo(() => [
    { key: 'idx', label: '#', className: 'mono', cellStyle: { color: 'var(--text-3)' }, render: (_r, i) => i + 1 },
    { key: 'email', label: '邮箱', className: 'mono', sortAccessor: (a) => a.email || '', render: (a) => a.email },
    { key: 'mbOrig', label: '邮箱原密码', className: 'mono', cellStyle: { color: 'var(--text-3)' }, exportValue: (a) => pwView(a, overrides[a.email || '']).mbOrig, render: (a) => pwView(a, overrides[a.email || '']).mbOrig || '—' },
    { key: 'mbCur', label: '邮箱现密码', className: 'mono', cellStyle: { color: 'var(--text-2)' }, exportValue: (a) => pwView(a, overrides[a.email || '']).mbCur, render: (a) => pwCell(pwView(a, overrides[a.email || '']).mbCur, a.email ? () => openSingle('mailbox', a) : undefined) },
    { key: 'orOrig', label: 'OR原密码', className: 'mono', cellStyle: { color: 'var(--text-3)' }, defaultHidden: true, exportValue: (a) => pwView(a, overrides[a.email || '']).orOrig, render: (a) => pwView(a, overrides[a.email || '']).orOrig || '—' },
    { key: 'orCur', label: 'OR现密码', className: 'mono', cellStyle: { color: 'var(--text-2)' }, exportValue: (a) => pwView(a, overrides[a.email || '']).orCur, render: (a) => pwCell(pwView(a, overrides[a.email || '']).orCur, a.email ? () => openSingle('openrouter', a) : undefined) },
    { key: 'apiKey', label: 'API Key', className: 'mono', cellStyle: { color: 'var(--primary-text)' }, exportValue: (a) => keyView(a, keyOv[a.email || '']), render: (a) => {
      const eff = keyView(a, keyOv[a.email || '']);
      if (eff) return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title={eff}>{trunc(eff, 24)}{keyOv[a.email || ''] && <span className="kbadge ok" title="本Key由「获取新Key」补取">新</span>}</span>;
      return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span className="kbadge warn">缺Key</span>
        {a.email && <button className="btn btn-ghost btn-sm" style={{ padding: '0 6px', lineHeight: '18px' }} title="登录该账号后新建一把 Key(只登录+建Key,不碰加卡/充值)" onClick={() => openGetKey([a])}><Icon name="refresh" size={11} /> 获取</button>}
      </span>;
    } },
    { key: 'billingStatus', label: '账单', sortAccessor: (a) => a.billingStatus || '', render: (a) => a.billingStatus === 'success' ? <span className="kbadge ok">success</span> : a.billingStatus ? <span className="kbadge warn">{a.billingStatus}</span> : <span className="kbadge neutral">—</span> },
    { key: 'charged', label: '充值', className: 'mono', align: 'right', sortAccessor: (a) => a.charged ?? a.topUpAmount ?? 0, exportValue: (a) => a.charged != null ? a.charged : (a.topUpAmount != null ? a.topUpAmount : ''), render: (a) => a.charged != null ? '$' + a.charged : (a.topUpAmount != null ? '$' + a.topUpAmount : '—') },
    { key: 'cardLast4', label: '卡末4', className: 'mono', exportValue: (a) => a.cardLast4 || '', render: (a) => a.cardLast4 ? '•••• ' + a.cardLast4 : '—' },
    { key: 'passwordChanged', label: '改密', exportValue: (a) => a.passwordChanged ? '已改' : '未改', render: (a) => a.passwordChanged ? <span className="kbadge ok">已改</span> : <span className="kbadge neutral">未改</span> },
    { key: 'exitIp', label: '出口IP', className: 'mono', cellStyle: { color: 'var(--text-2)' }, render: (a) => a.exitIp || '—' },
    { key: 'nodeId', label: '节点', className: 'mono', cellStyle: { color: 'var(--text-3)' }, sortAccessor: (a) => a.nodeId || '', render: (a) => a.nodeId || '' },
    { key: 'createdAt', label: '时间', className: 'mono', cellStyle: { color: 'var(--text-3)' }, sortAccessor: (a) => a.createdAt || '', render: (a) => (a.createdAt || '').replace('T', ' ').slice(0, 19) },
  ], [overrides, keyOv]); // eslint-disable-line react-hooks/exhaustive-deps

  const poolCards = cards?.cards || [];
  // 有勾选 → 复制/导出只针对【可见的】选中行;否则导【当前筛选后的视图】(filteredView,未筛选时即全量)——
  // 而非原始 all,避免「筛到 10 条、未勾选,却复制了全部 1000 条」。filteredView 为 null(首帧未上报)时回退 all。
  const baseRows = filteredView ?? all;
  const exportRows = selRows.length ? selRows : baseRows;
  const selSuffix = selRows.length ? `选中 ${selRows.length}` : (baseRows.length === all.length ? `全部 ${all.length}` : `筛选后 ${baseRows.length}`);
  // 批量改密按邮箱去重后的真实账号数(徽章显示它,避免「选 5 行实际只改 3 个邮箱」的数字不符)。
  const selEmailCount = new Set(selRows.map((r) => r.email).filter(Boolean)).size;
  // 选中里【缺Key且有 OR现密码可登录】的去重邮箱数(获取新Key 徽章 + 禁用判定):与 openGetKey 实际处理口径一致 ——
  // 缺 Key 但没 OR现密码的号无法登录取Key、会被 openGetKey 剔除,故不计入(否则徽章显 5、实际只跑 3,数字对不上)。
  const selNoKeyCount = new Set(selRows.filter((r) => !keyView(r, keyOv[r.email || '']).trim() && pwView(r, overrides[r.email || '']).orCur).map((r) => r.email).filter(Boolean)).size;

  return (
    <main className="page">
      <section className="card masthead">
        <div className="mh-strip">
          <div className="mh-cluster">
            <span className="mh-ic"><Icon name="grid" size={16} /></span>
            <span className="mh-title">结果聚合</span>
          </div>
          <span className="mh-meta">节点 <b>{sources.length || 1}</b> · 账号 <b>{all.length}</b></span>
          <span className="mh-spacer" />
          <span className="mh-updated">更新于 <b>{updatedAt || '—'}</b></span>
          <label className="check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /><span className="box"><Icon name="check" size={11} /></span>自动刷新 <span className="sub">20s</span></label>
          <button className="btn btn-primary btn-sm" onClick={() => loadData(false)}><Icon name="refresh" size={12} />立即聚合</button>
        </div>
        <div className="mh-strip mh-tools">
          <div className="mh-field-inline"><span className="mh-label">去重</span>
            <select className="mh-select" value={dedupe} onChange={(e) => setDedupe(e.target.value)}>
              <option value="email+apiKey">每组 邮箱+Key 一行(去完全重复)</option>
              <option value="email">每邮箱一行(同邮箱保留最新 Key)</option>
              <option value="none">全部保留(不去重)</option>
            </select>
          </div>
          <label className="check"><input type="checkbox" checked={includeLocal} onChange={(e) => setIncludeLocal(e.target.checked)} /><span className="box"><Icon name="check" size={11} /></span>含本机</label>
        </div>
        <div className="mh-strip">
          <div className="mh-field-inline" style={{ flex: 1, alignItems: 'flex-start' }}>
            <span className="mh-label" style={{ paddingTop: 7 }}>其它节点</span>
            <textarea rows={1} style={{ minHeight: 34 }} placeholder="可留空(自动用配置 cluster.hosts + 在线子机)。手动加远程节点:http://机器:4317,一行一个"
              value={hosts} onChange={(e) => setHosts(e.target.value)} />
          </div>
        </div>
        <div className="mh-strip">
          {(sources.length ? sources : [{ source: '本机', count: 0, ok: true }]).map((s, i) => {
            const name = String(s.source).replace(/^local\(/, '本机(').replace(/^push\(/, '推送(');
            return <span className="node-chip" key={i}><span className={'dot' + (s.ok ? '' : ' bad')} />{name} <em>{s.ok ? s.count + ' 条' : s.error}</em></span>;
          })}
          <span className="mh-spacer" />
          <button className="btn btn-soft btn-sm" disabled={!selEmailCount} title="把选中账号的邮箱密码批量改为统一新密码(改前有确认);徽章=按邮箱去重后的账号数" onClick={() => openBatch('mailbox')}><Icon name="mail" size={12} />批量改邮箱密码 <span className="dim">({selEmailCount})</span></button>
          <button className="btn btn-soft btn-sm" disabled={!selEmailCount} title="把选中账号的 OpenRouter 密码批量改密(Phase B,浏览器自动化下一步交付);徽章=按邮箱去重后的账号数" onClick={() => openBatch('openrouter')}><Icon name="shield" size={12} />批量改OR密码 <span className="dim">({selEmailCount})</span></button>
          <button className="btn btn-soft btn-sm" disabled={!selNoKeyCount} title="对选中的【缺Key且有 OR现密码可登录】号登录后新建一把 Key(单个/批量;批量可设并发)。只登录+建Key,不碰加卡/充值;徽章=选中里缺Key且有 OR现密码的账号数(缺密码的无法登录、不计入)" onClick={() => openGetKey(selRows)}><Icon name="refresh" size={12} />获取新Key <span className="dim">({selNoKeyCount})</span></button>
          <button className="btn btn-ghost btn-sm" title="查看改密存档(每次更新邮箱/OR 密码的审计记录)" onClick={() => setPwLogOpen(true)}><Icon name="edit" size={12} />改密存档</button>
          <button className="btn btn-ghost btn-sm" disabled={!exportRows.length} title="复制选中的;未勾选则复制全部(Key 优先取「获取新Key」补取的新值)" onClick={() => copy(exportRows.map((r) => `${r.email || ''}:${keyView(r, keyOv[r.email || ''])}`).join('\n'))}>复制 邮箱:Key <span className="dim">({selSuffix})</span></button>
          <button className="btn btn-ghost btn-sm" disabled={!exportRows.length} title="复制 邮箱:邮箱现密码(当前邮箱登录密码,改密后为新值);未勾选则复制全部" onClick={() => copy(exportRows.map((r) => `${r.email || ''}:${pwView(r, overrides[r.email || '']).mbCur}`).join('\n'))}>复制 邮箱:现密码</button>
          <button className="btn btn-ghost btn-sm" disabled={!exportRows.length} title="复制 邮箱:OpenRouter现密码(当前 OR 登录密码);未勾选则复制全部" onClick={() => copy(exportRows.map((r) => `${r.email || ''}:${pwView(r, overrides[r.email || '']).orCur}`).join('\n'))}>复制 邮箱:OR密码</button>
          <button className="btn btn-soft btn-sm" disabled={!exportRows.length} title="自定义格式导出(选中优先,未勾选则全部):模板变量 + 自增序号,可导 .txt / .json" onClick={() => setExportOpen(true)}><Icon name="download" size={12} />自定义导出 <span className="dim">({selSuffix})</span></button>
          <button className="btn btn-danger-soft btn-sm" disabled={!all.length || busy} title="删除本机所有成功结果(含子机推送缓存),不影响其它节点" onClick={clearLocal}><Icon name="trash" size={12} />清空本机</button>
        </div>
      </section>

      <div className="section-gap" />

      <section className="card">
        <DataTable
          rows={all}
          columns={columns}
          rowKey={(a, i) => `${a.nodeId || ''}|${a.jobId || ''}|${a.email || ''}|${a.apiKey || ''}|${i}`}
          search={{ keys: [(a) => a.email || '', (a) => a.apiKey || '', (a) => a.nodeId || ''], placeholder: '搜索邮箱 / Key / 节点…' }}
          filters={[
            { key: 'billingStatus', label: '账单', accessor: (a) => a.billingStatus || '—', options: [{ value: 'success', label: 'success' }, { value: '—', label: '无' }] },
            { key: 'apiKey', label: 'Key', accessor: (a) => keyView(a, keyOv[a.email || '']).trim() ? 'yes' : 'no', options: [{ value: 'yes', label: '有Key' }, { value: 'no', label: '缺Key' }] },
            { key: 'passwordChanged', label: '改密', accessor: (a) => a.passwordChanged ? 'yes' : 'no', options: [{ value: 'yes', label: '已改' }, { value: 'no', label: '未改' }] },
          ]}
          columnSettings={{ tableId: 'results-accounts' }}
          exportName="results-accounts"
          maxHeight={560}
          fillViewport
          selectable
          onSelectionChange={setSelRows}
          onViewChange={setFilteredView}
          batchActions={(sel, clearSel) => {
            const emailN = new Set(sel.map((r) => r.email).filter(Boolean)).size;   // 改密按邮箱去重的真实账号数
            const noKeyN = new Set(sel.filter((r) => !keyView(r, keyOv[r.email || '']).trim() && pwView(r, overrides[r.email || '']).orCur).map((r) => r.email).filter(Boolean)).size;   // 选中里缺Key且有 OR现密码可登录的账号数(与 openGetKey 口径一致)
            return (
            <>
              <button className="btn btn-soft btn-sm" onClick={() => openBatch('mailbox')}><Icon name="mail" size={12} />改邮箱密码({emailN})</button>
              <button className="btn btn-soft btn-sm" onClick={() => openBatch('openrouter')}><Icon name="shield" size={12} />改OR密码({emailN})</button>
              <button className="btn btn-soft btn-sm" disabled={!noKeyN} onClick={() => openGetKey(sel)}><Icon name="refresh" size={12} />获取新Key({noKeyN})</button>
              <button className="btn btn-danger-soft btn-sm" disabled={busy} onClick={() => deleteRows(sel, clearSel)}><Icon name="trash" size={12} />删除选中({sel.length})</button>
            </>
            );
          }}
          emptyText="暂无成功账号,去控制台跑一批"
        />
      </section>

      <div className="section-gap" />

      <section className="card">
        <div className="panel-sec">
          <div className="sub-head"><h4>卡池使用情况</h4><span className="cnt-pill">本节点 · 共 <b style={{ color: 'var(--text)' }}>{poolCards.length}</b> 张 · 可用 <b style={{ color: 'var(--success)' }}>{cards?.available || 0}</b></span>
            <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} disabled={!poolCards.length} onClick={() => downloadCsv('cards', ['卡号末4', '有效期', '已用', '上限', '状态'], poolCards.map((c) => [c.masked, c.exp, c.usedCount, c.maxUses, CARD_STATUS[c.status] || c.status]))}><Icon name="download" size={12} />导出</button>
          </div>
          <div className="tbl-wrap" style={{ maxHeight: 320 }}>
            <table className="tbl">
              <thead><tr><th>卡号末4</th><th>有效期</th><th>已用/上限</th><th>状态</th></tr></thead>
              <tbody>
                {poolCards.length ? poolCards.map((c) => (
                  <tr key={c.id}><td className="mono">{c.masked}</td><td className="mono">{c.exp}</td><td className="mono">{c.usedCount} / {c.maxUses}</td>
                    <td>{c.status === 'active' ? <span className="kbadge ok">可用</span> : c.status === 'exhausted' ? <span className="kbadge fail">已用尽</span> : <span className="kbadge neutral">{CARD_STATUS[c.status] || c.status}</span>}</td></tr>
                )) : <tr><td colSpan={4} className="tbl-empty">暂无卡片</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <ResultsExportModal open={exportOpen} onClose={() => setExportOpen(false)} rows={exportRows} overrides={overrides} keyOverrides={keyOv} onDownload={download} onCopy={copy} />
      <ChangePwModal open={!!pwModal} onClose={() => setPwModal(null)} type={pwModal?.type || 'mailbox'} targets={pwModal?.targets || []} onDone={onPwDone} />
      <GetKeyModal open={!!getKeyTargets} onClose={() => setGetKeyTargets(null)} targets={getKeyTargets || []} onDone={onGetKeyDone} />
      <PwChangeLogModal open={pwLogOpen} onClose={() => setPwLogOpen(false)} />
    </main>
  );
}
