// 执行流程(可视化)— 看清楚每个引擎在页面上一步步怎么走 + 每步关联的可维护元素 + 【编辑走法】就地切。
// 数据来自 src/lib/engineFlows.ts(对照真实源码逐条核验);只读展示不参与执行。
// 「编辑走法」= 同一引擎维护多套命名「走法方案」(=engine-config 预设),每步就地选走法存进预设;
//   纯配置组合,只驱动 Python 已读的环境变量,不改自动化逻辑。空值=跟随默认、跑批逐字节不变。
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { Icon } from '../lib/icons';
import { useToast } from '../lib/toast';
import { ENGINE_FLOWS, STAGE_META, STAGE_ORDER, type EngineFlow, type FlowStep, type FlowStage } from '../lib/engineFlows';
import type { SelectorsResp } from '../lib/selectorsSchema';
import { useEngineConfigs } from '../features/console/useEngineConfigs';
import { ENGINE_FIELDS, engineActiveOpts, type EngineField, type EngineKey } from '../lib/engineSchema';

type Opts = Record<string, string | boolean>;

export default function FlowPage() {
  const [engine, setEngine] = useState<EngineKey>('selenium');
  const [openAll, setOpenAll] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const toast = useToast();
  // 拉「元素维护」注册表:给每步的 sel 标签 + 标注是否已被覆盖。失败静默。
  const { data: selData } = useQuery({ queryKey: ['selectors'], queryFn: () => apiGet<SelectorsResp>('/api/selectors', true), retry: false });
  const selMap = useMemo(() => {
    const m: Record<string, { label: string; overridden: boolean }> = {};
    for (const s of selData?.steps || []) m[s.id] = { label: s.label, overridden: !!(selData?.values?.[s.id] || '').trim() };
    return m;
  }, [selData]);

  // 走法方案 = engine-config 的每引擎多预设。
  const { data: engineConfigs, save, active, del } = useEngineConfigs();
  const flow = ENGINE_FLOWS.find((e) => e.key === engine)!;
  const fields: EngineField[] = ENGINE_FIELDS[engine] || [];
  const fieldByKey = useMemo(() => { const m: Record<string, EngineField> = {}; for (const f of fields) m[f.key] = f; return m; }, [fields]);
  const group = engineConfigs?.engines?.[engine];
  const activeId = group?.activeId;
  const activePreset = group?.presets.find((p) => p.id === activeId);
  // 该引擎是否有"可就地切的走法"(某步的 knob 落在该引擎字段集里)→ 决定是否给「编辑走法」入口
  const editable = !!flow.steps?.some((s) => (s.knobs || []).some((k) => fieldByKey[k]));

  const [draft, setDraft] = useState<Opts>({});
  const [dirty, setDirty] = useState(false);
  // 仅在引擎 / 激活预设变化时重置 draft(不被后台 refetch 冲掉编辑)。
  useEffect(() => {
    if (!group || !activePreset) return;
    setDraft(engineActiveOpts(engineConfigs, engine));
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, activeId]);

  const setField = (k: string, v: string | boolean) => { setDraft((d) => ({ ...d, [k]: v })); setDirty(true); };

  function switchActive(id: string) {
    if (id === activeId) return;
    if (dirty && !window.confirm('当前走法方案有未保存修改,切换会丢弃,确定?')) return;
    active.mutate({ engine, id });
  }
  function doSave() {
    if (!activePreset) return;
    save.mutate({ engine, id: activeId, name: activePreset.name, opts: draft }, {
      onSuccess: () => { setDirty(false); toast.push(`已保存到走法方案「${activePreset!.name}」`, 'ok'); },
      onError: (e) => toast.push('保存失败:' + (e as Error).message, 'err'),
    });
  }
  function reset() { setDraft(engineActiveOpts(engineConfigs, engine)); setDirty(false); }
  function doNew() {
    if (dirty && !window.confirm('有未保存修改,新建会丢弃,确定?')) return;
    const defs: Opts = {}; for (const f of fields) defs[f.key] = f.default;   // 新方案=该引擎默认(走法全空=跟随默认)
    save.mutate({ engine, name: '新走法方案', opts: defs }, { onSuccess: () => toast.push('已新建并设为当前', 'ok') });
  }
  function doDup() { if (activePreset) save.mutate({ engine, name: activePreset.name + ' 副本', opts: draft }, { onSuccess: () => toast.push('已复制为新方案', 'ok') }); }
  function doRename() {
    if (!activePreset) return;
    const n = window.prompt('新名称', activePreset.name);
    if (n == null || !n.trim()) return;
    save.mutate({ engine, id: activeId, name: n.trim(), opts: draft }, { onSuccess: () => toast.push('已重命名', 'ok') });
  }
  function doDelete() {
    if (!activePreset || !activeId) return;
    if (!window.confirm(`删除走法方案「${activePreset.name}」?`)) return;
    del.mutate({ engine, id: activeId }, { onSuccess: () => toast.push('已删除', 'ok') });
  }

  const showEditor = editMode && editable && !!flow.steps;

  return (
    <div style={{ padding: '16px 20px', maxWidth: 1080, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>执行流程 · 可视化</h1>
          <div style={{ fontSize: 13, color: 'var(--text-3,#6b7280)', marginTop: 4, maxWidth: 760 }}>
            每个引擎在页面上<b>一步步到底怎么走</b>(对照真实代码逐条核验)。开<b>编辑走法</b>可给同一引擎维护<b>多套走法方案</b>、每步就地切
            ——纯配置,<b>不改自动化逻辑</b>;空=跟随默认。元素定位变了去 <Link to="/elements" style={{ color: 'var(--primary-text,#2563eb)' }}>元素维护</Link> 改。
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button className="btn btn-soft btn-sm" onClick={() => setOpenAll((v) => !v)}><Icon name="chevron" size={13} />&nbsp;{openAll ? '全部收起' : '全部展开'}</button>
          <button className="btn btn-sm" onClick={() => setEditMode((v) => !v)}
            style={{ border: '1px solid ' + (editMode ? 'var(--primary,#2563eb)' : 'var(--border,#e5e7eb)'), background: editMode ? 'var(--primary,#2563eb)' : 'var(--surface,#fff)', color: editMode ? '#fff' : 'var(--text-1,#111)' }}>
            <Icon name="sliders" size={13} />&nbsp;{editMode ? '退出编辑' : '编辑走法'}
          </button>
        </div>
      </div>

      {/* 引擎 tab */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '16px 0 6px' }}>
        {ENGINE_FLOWS.map((e) => {
          const on = e.key === engine;
          return (
            <button key={e.key} onClick={() => setEngine(e.key)}
              style={{ padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: on ? 600 : 500,
                border: '1px solid ' + (on ? 'var(--primary,#2563eb)' : 'var(--border,#e5e7eb)'),
                background: on ? 'var(--primary,#2563eb)' : 'var(--surface,#fff)', color: on ? '#fff' : 'var(--text-1,#111)' }}>
              {e.label}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '6px 0 14px', fontSize: 12, color: 'var(--text-3,#6b7280)' }}>
        {flow.verified && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 6, background: 'rgba(22,163,74,.12)', color: '#16a34a', fontWeight: 600 }}><Icon name="check" size={11} />源码核验</span>}
        <span>{flow.tag}</span>
      </div>

      {/* 编辑态:走法方案选择条(=该引擎多套预设) */}
      {showEditor && group && activePreset && (
        <section className="card" style={{ padding: '10px 14px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', border: '1px solid var(--primary,#2563eb)' }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>走法方案</span>
          <select value={activeId} onChange={(e) => switchActive(e.target.value)} style={{ minWidth: 200, height: 30, borderRadius: 6, border: '1px solid var(--border,#d1d5db)', padding: '0 8px', fontSize: 13 }}>
            {group.presets.map((p) => <option key={p.id} value={p.id}>{p.name}{p.builtin ? '(默认)' : ''}</option>)}
          </select>
          {dirty && <span style={{ fontSize: 11, color: '#b45309', background: 'rgba(245,158,11,.14)', padding: '2px 7px', borderRadius: 5 }}>待保存</span>}
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost btn-sm" onClick={doNew}>新建</button>
          <button className="btn btn-ghost btn-sm" onClick={doDup}>复制</button>
          <button className="btn btn-ghost btn-sm" disabled={!!activePreset.builtin} title={activePreset.builtin ? '默认方案不可改名' : ''} onClick={doRename}>重命名</button>
          <button className="btn btn-ghost btn-sm" disabled={!!activePreset.builtin} title={activePreset.builtin ? '默认方案不可删除' : ''} onClick={doDelete}>删除</button>
          <span style={{ width: '100%', fontSize: 11, color: 'var(--text-3,#9ca3af)' }}>下拉=切当前方案(下次跑批用它);每步展开就地选走法,改完点底部「保存」。空选项=跟随默认。</span>
        </section>
      )}
      {editMode && !editable && (
        <div style={{ fontSize: 12, color: 'var(--text-3,#6b7280)', marginBottom: 14, padding: '8px 12px', borderRadius: 8, background: 'var(--muted,#f8fafc)' }}>
          该引擎暂无可就地切的走法变体{flow.key === 'split' ? '(分流的走法在 纯Selenium / 混合 引擎 tab 里各自编辑)' : ''}。
        </div>
      )}

      {/* 阶段图例 */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        {STAGE_ORDER.map((st) => (
          <span key={st} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '2px 8px', borderRadius: 6, background: STAGE_META[st].bg, color: STAGE_META[st].color, fontWeight: 600 }}>
            <span style={{ width: 7, height: 7, borderRadius: 99, background: STAGE_META[st].color }} />{STAGE_META[st].label}
          </span>
        ))}
      </div>

      {flow.steps
        ? <Timeline steps={flow.steps} openAll={openAll} selMap={selMap} edit={showEditor} draft={draft} setField={setField} fieldByKey={fieldByKey} />
        : <SplitView flow={flow} onJump={setEngine} />}

      {/* 编辑态保存条 */}
      {showEditor && dirty && activePreset && (
        <div style={{ position: 'sticky', bottom: 12, marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', padding: '10px 14px', borderRadius: 10, background: 'var(--surface,#fff)', border: '1px solid var(--primary,#2563eb)', boxShadow: '0 4px 16px rgba(0,0,0,.10)' }}>
          <span style={{ fontSize: 12, color: 'var(--text-3,#6b7280)', marginRight: 'auto' }}>改动未保存到走法方案「{activePreset.name}」</span>
          <button className="btn btn-ghost btn-sm" onClick={reset}>放弃</button>
          <button className="btn btn-soft btn-sm" onClick={doSave}>保存到「{activePreset.name}」</button>
        </div>
      )}
    </div>
  );
}

interface TLProps { steps: FlowStep[]; openAll: boolean; selMap: Record<string, { label: string; overridden: boolean }>; edit: boolean; draft: Opts; setField: (k: string, v: string | boolean) => void; fieldByKey: Record<string, EngineField>; }

function Timeline({ steps, openAll, selMap, edit, draft, setField, fieldByKey }: TLProps) {
  return (
    <div style={{ position: 'relative' }}>
      {steps.map((s, i) => {
        const prev = steps[i - 1];
        const showStage = !prev || prev.stage !== s.stage;
        return (
          <div key={s.n}>
            {showStage && <StageDivider stage={s.stage} />}
            <StepCard step={s} openAll={openAll} selMap={selMap} last={i === steps.length - 1} edit={edit} draft={draft} setField={setField} fieldByKey={fieldByKey} />
          </div>
        );
      })}
    </div>
  );
}

function StageDivider({ stage }: { stage: FlowStage }) {
  const m = STAGE_META[stage];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0 8px' }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: m.color, padding: '3px 10px', borderRadius: 6, background: m.bg }}>{m.label}</span>
      <span style={{ flex: 1, height: 1, background: 'var(--border,#e5e7eb)' }} />
    </div>
  );
}

interface SCProps extends Omit<TLProps, 'steps' | 'openAll' | 'selMap'> { step: FlowStep; openAll: boolean; selMap: Record<string, { label: string; overridden: boolean }>; last: boolean; }

function StepCard({ step, openAll, selMap, last, edit, draft, setField, fieldByKey }: SCProps) {
  const [open, setOpen] = useState(false);
  const expanded = openAll || open;
  const m = STAGE_META[step.stage];
  const editKnobs = (step.knobs || []).filter((k) => fieldByKey[k]);
  const hasEditable = edit && editKnobs.length > 0;
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, width: 30 }}>
        <div style={{ width: 28, height: 28, borderRadius: 99, background: m.color, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>{step.n}</div>
        {!last && <div style={{ flex: 1, width: 2, background: 'var(--border,#e5e7eb)', minHeight: 10 }} />}
      </div>
      <div style={{ flex: 1, marginBottom: 10, border: '1px solid ' + (hasEditable ? 'var(--primary,#2563eb)' : 'var(--border,#e5e7eb)'), borderRadius: 10, padding: '10px 14px', background: 'var(--surface,#fff)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', cursor: 'pointer' }} onClick={() => setOpen((v) => !v)}>
          <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 5, background: m.bg, color: m.color, fontWeight: 700 }}>{m.label}</span>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{step.name}</span>
          {hasEditable && <span style={{ fontSize: 11, color: 'var(--primary-text,#2563eb)', background: 'rgba(37,99,235,.12)', padding: '1px 6px', borderRadius: 5 }}>可切走法</span>}
          {step.note && <span title={step.note} style={{ fontSize: 11, color: '#b45309', background: 'rgba(245,158,11,.14)', padding: '1px 6px', borderRadius: 5 }}>注</span>}
          <span style={{ marginLeft: 'auto', color: 'var(--text-3,#9ca3af)', transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}><Icon name="chevron" size={14} /></span>
        </div>

        <div style={{ fontSize: 12.5, color: 'var(--text-2,#374151)', marginTop: 6, lineHeight: 1.6 }}>{step.how}</div>

        {/* 编辑态:本步可切的走法控件(始终显示,不必展开) */}
        {hasEditable && (
          <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: 'rgba(37,99,235,.05)', border: '1px dashed rgba(37,99,235,.35)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {editKnobs.map((k) => {
              const f = fieldByKey[k];
              return (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, fontWeight: 600, minWidth: 130 }}>{f.label}</span>
                  <EngineFieldControl field={f} value={draft[f.key] ?? f.default} onChange={(v) => setField(f.key, v)} />
                  {f.hint && <span style={{ fontSize: 11, color: 'var(--text-3,#9ca3af)' }}>{f.hint}</span>}
                </div>
              );
            })}
          </div>
        )}

        {expanded && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {step.when && <div style={{ fontSize: 12, color: 'var(--text-3,#6b7280)', lineHeight: 1.55 }}><b style={{ color: 'var(--text-2,#4b5563)' }}>何时跳过/前置:</b>{step.when}</div>}
            {step.note && <div style={{ fontSize: 12, color: '#92400e', background: 'rgba(245,158,11,.10)', borderRadius: 6, padding: '6px 10px', lineHeight: 1.55 }}>{step.note}</div>}
            {step.sel && step.sel.length > 0 && (
              <div style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--text-3,#6b7280)' }}>可维护元素:</span>
                {step.sel.map((id) => {
                  const meta = selMap[id];
                  return (
                    <Link key={id} to="/elements" title={meta?.overridden ? '已设页面覆盖(点去元素维护)' : '当前用内置默认(点去元素维护可改)'}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '2px 8px', borderRadius: 6, textDecoration: 'none',
                        border: '1px solid ' + (meta?.overridden ? 'rgba(22,163,74,.5)' : 'var(--border,#d1d5db)'),
                        background: meta?.overridden ? 'rgba(22,163,74,.10)' : 'var(--muted,#f8fafc)', color: meta?.overridden ? '#16a34a' : 'var(--text-2,#475569)' }}>
                      <Icon name="search" size={10} />{meta?.label || id}{meta?.overridden ? ' ·已改' : ''}
                    </Link>
                  );
                })}
              </div>
            )}
            {step.ev && <div style={{ fontSize: 11, color: 'var(--text-3,#9ca3af)', fontFamily: 'monospace' }}><Icon name="search" size={10} />&nbsp;代码:{step.ev}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// 引擎字段控件(只读复用 engineSchema 字段定义渲染;不动 PresetEditor)。
function EngineFieldControl({ field, value, onChange }: { field: EngineField; value: string | boolean; onChange: (v: string | boolean) => void }) {
  if (field.type === 'bool') {
    return <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }}><input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /></label>;
  }
  if (field.type === 'select') {
    return (
      <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} style={{ height: 28, borderRadius: 6, border: '1px solid var(--border,#d1d5db)', padding: '0 8px', fontSize: 12, minWidth: 200 }}>
        {(field.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  return (
    <input type={field.type === 'number' ? 'number' : 'text'} value={String(value ?? '')} min={field.min} max={field.max} step={field.step}
      onChange={(e) => onChange(e.target.value)} style={{ height: 28, width: 110, borderRadius: 6, border: '1px solid var(--border,#d1d5db)', padding: '0 8px', fontSize: 12 }} />
  );
}

function SplitView({ flow, onJump }: { flow: EngineFlow; onJump: (k: EngineKey) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <section style={{ border: '1px solid var(--border,#e5e7eb)', borderRadius: 10, padding: '14px 16px', background: 'var(--surface,#fff)' }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 10 }}>{flow.handoff?.title}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {flow.handoff?.lines.map((ln, i) => <div key={i} style={{ fontSize: 12.5, color: 'var(--text-2,#374151)', lineHeight: 1.65, paddingLeft: 4 }}>{ln}</div>)}
        </div>
      </section>
      <div style={{ fontSize: 13, color: 'var(--text-3,#6b7280)' }}>两条子流程各自的详细步骤(及各自的走法编辑),点这里看:</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {(flow.composedOf || []).map((k) => {
          const child = ENGINE_FLOWS.find((e) => e.key === k)!;
          return (
            <button key={k} onClick={() => onJump(k)}
              style={{ flex: '1 1 260px', textAlign: 'left', cursor: 'pointer', border: '1px solid var(--border,#e5e7eb)', borderRadius: 10, padding: '12px 14px', background: 'var(--surface,#fff)' }}>
              <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>{child.label}<Icon name="chevron" size={13} /></div>
              <div style={{ fontSize: 12, color: 'var(--text-3,#6b7280)', marginTop: 4 }}>{child.tag}</div>
              <div style={{ fontSize: 11, color: 'var(--text-3,#9ca3af)', marginTop: 4 }}>{child.steps?.length} 步</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
