// 通用命名预设编辑器:预设下拉(选=切激活)+ 新建/复制/重命名/删除 + 字段编辑(draft + 保存)。
// 环节策略(StrategyEditor)与引擎配置(EngineConfigEditor)共用此实现 —— 两者只是字段集 + 落盘维度不同。
// 编辑改的是"当前激活预设"的本地草稿,点保存才落盘;后台 refetch 不冲掉正在编辑的 draft。
import { useEffect, useState } from 'react';
import { useToast } from '../../lib/toast';
import { Field, Check } from './shared';

export type Opts = Record<string, string | boolean>;
export interface PresetField {
  key: string; label: string; hint?: string;
  type: 'text' | 'number' | 'select' | 'bool';
  options?: { value: string; label: string }[];
  default: string | boolean; min?: number; max?: number; step?: number;
}
export interface Preset { id: string; name: string; builtin?: boolean; opts: Opts; }
export interface PresetGroup { activeId: string; presets: Preset[]; }
export interface PresetActions {
  switchActive: (id: string) => void;
  save: (args: { id?: string; name: string; opts: Opts }, onSuccess: () => void) => void;
  remove: (id: string, onSuccess: () => void) => void;
}

interface Props {
  group: PresetGroup | undefined;
  fields: PresetField[];
  defaults: Opts;
  actions: PresetActions;
  /** 草稿重置的额外依赖(如 stage / engine),切换时重置 draft */
  resetKey: string;
  /** 预设下拉左侧标签,如「策略预设」「引擎配置」 */
  presetLabel?: string;
  /** 新建预设的默认名,如「新策略」「新配置」 */
  newName?: string;
  /** 无可调字段时的提示 */
  emptyHint?: string;
}

export default function PresetEditor({ group, fields, defaults, actions, resetKey, presetLabel = '预设', newName = '新预设', emptyHint }: Props) {
  const toast = useToast();
  const activeId = group?.activeId;
  const activePreset = group?.presets.find((p) => p.id === activeId);

  const [draft, setDraft] = useState<Opts>({});
  const [dirty, setDirty] = useState(false);
  // 仅在"激活预设 / 维度"变化时重置 draft(不随后台 refetch 冲掉编辑)。
  useEffect(() => {
    if (activePreset) { setDraft({ ...defaults, ...activePreset.opts }); setDirty(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, resetKey]);

  if (!group || !activePreset) return <p className="help" style={{ margin: 0 }}>加载中…</p>;
  if (!fields.length) return <p className="help" style={{ margin: 0 }}>{emptyHint || '当前无可调参数,使用内置默认。'}</p>;

  const setField = (k: string, v: string | boolean) => { setDraft((d) => ({ ...d, [k]: v })); setDirty(true); };
  const reset = () => { setDraft({ ...defaults, ...activePreset.opts }); setDirty(false); };

  function switchActive(id: string) {
    if (id === activeId) return;
    if (dirty && !window.confirm('当前预设有未保存修改,切换会丢弃,确定?')) return;
    actions.switchActive(id);
  }
  const doSave = () => actions.save({ id: activeId, name: activePreset!.name, opts: draft }, () => { setDirty(false); toast.push(`已保存到「${activePreset!.name}」`, 'ok'); });
  // 新建会切换激活预设(activeId 变 → draft 重置),当前未保存编辑会丢 → 先确认。
  const doNew = () => { if (dirty && !window.confirm('当前预设有未保存修改,新建会丢弃,确定?')) return; actions.save({ name: newName, opts: { ...defaults } }, () => toast.push('已新建并激活', 'ok')); };
  const doDup = () => actions.save({ name: activePreset!.name + ' 副本', opts: draft }, () => toast.push('已复制为新预设', 'ok'));
  function doRename() {
    const n = window.prompt('新名称', activePreset!.name);
    if (n == null || !n.trim()) return;
    actions.save({ id: activeId, name: n.trim(), opts: draft }, () => toast.push('已重命名', 'ok'));
  }
  function doDelete() {
    if (!window.confirm(`删除预设「${activePreset!.name}」?`)) return;
    actions.remove(activeId!, () => toast.push('已删除', 'ok'));
  }

  const selectFields = fields.filter((f) => f.type !== 'bool');
  const boolFields = fields.filter((f) => f.type === 'bool');

  return (
    <div>
      <div className="strat-bar">
        <span className="strat-lbl">{presetLabel}</span>
        <select className="strat-select" value={activeId} onChange={(e) => switchActive(e.target.value)}>
          {group.presets.map((p) => <option key={p.id} value={p.id}>{p.name}{p.builtin ? '(内置)' : ''}</option>)}
        </select>
        {dirty && <span className="kbadge warn">待保存</span>}
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost btn-sm" onClick={doNew}>新建</button>
        <button className="btn btn-ghost btn-sm" onClick={doDup}>复制</button>
        <button className="btn btn-ghost btn-sm" disabled={!!activePreset.builtin} title={activePreset.builtin ? '内置预设不可改名' : ''} onClick={doRename}>重命名</button>
        <button className="btn btn-ghost btn-sm" disabled={!!activePreset.builtin} title={activePreset.builtin ? '内置预设不可删除' : ''} onClick={doDelete}>删除</button>
      </div>

      {!!selectFields.length && (
        <div className="set-grid" style={{ marginTop: 4 }}>
          {selectFields.map((f) => (
            <Field key={f.key} name={f.label} hint={f.hint}>
              {f.type === 'select'
                ? <select value={String(draft[f.key] ?? '')} onChange={(e) => setField(f.key, e.target.value)}>{(f.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                : <input type={f.type === 'number' ? 'number' : 'text'} value={String(draft[f.key] ?? '')} min={f.min} max={f.max} step={f.step} placeholder={f.type === 'text' ? '随机' : undefined} onChange={(e) => setField(f.key, e.target.value)} />}
            </Field>
          ))}
        </div>
      )}

      {!!boolFields.length && (
        <div className="set-foot" style={{ display: 'block', marginTop: 12 }}>
          <div className="check-grid">
            {boolFields.map((f) => <Check key={f.key} label={f.label} sub={f.hint || ''} v={!!draft[f.key]} on={(v) => setField(f.key, v)} />)}
          </div>
        </div>
      )}

      {dirty && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost btn-sm" onClick={reset}>放弃修改</button>
          <button className="btn btn-soft btn-sm" onClick={doSave}>保存到「{activePreset.name}」</button>
        </div>
      )}
    </div>
  );
}
