import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { Icon } from '../lib/icons';
import { ADV_FIELDS, ADV_GROUPS, SCOPE_LABEL, SCOPE_COLOR, type AdvScope } from '../lib/advancedSchema';

type Vals = Record<string, string>;

function ScopeTag({ scope }: { scope: AdvScope }) {
  return (
    <span style={{
      fontSize: 11, lineHeight: '14px', padding: '1px 6px', borderRadius: 4, marginLeft: 8,
      color: '#fff', background: SCOPE_COLOR[scope], whiteSpace: 'nowrap',
    }}>{SCOPE_LABEL[scope]}</span>
  );
}

export default function AdvancedPage() {
  const qc = useQueryClient();
  const { data: saved } = useQuery({ queryKey: ['advanced'], queryFn: () => apiGet<Vals>('/api/advanced', true), retry: false });
  const [vals, setVals] = useState<Vals>({});
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (saved) { setVals({ ...saved }); setDirty(false); } }, [saved]);

  const save = useMutation({
    mutationFn: () => apiPost('/api/advanced/save', vals),
    onSuccess: () => { setDirty(false); qc.invalidateQueries({ queryKey: ['advanced'] }); },
  });

  function set(k: string, v: string) { setVals((s) => ({ ...s, [k]: v })); setDirty(true); }

  return (
    <div style={{ padding: '16px 20px', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>高级参数</h1>
          <div style={{ fontSize: 13, color: 'var(--muted-foreground, #6b7280)', marginTop: 4 }}>
            引擎配置页【没有的】全局/共用调优旋钮 · 留空 = 用代码内置默认(不改默认行为) · 改完<b>重起 job</b> 生效
          </div>
        </div>
        <button className="btn primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}
          style={{ flexShrink: 0, opacity: (!dirty || save.isPending) ? 0.5 : 1 }}>
          <Icon name="check" size={14} />&nbsp;{save.isPending ? '保存中…' : (dirty ? '保存' : '已保存')}
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, color: 'var(--muted-foreground,#6b7280)', margin: '8px 0 16px' }}>
        作用范围:
        <ScopeTag scope="selenium" /><ScopeTag scope="hybrid" /><ScopeTag scope="both" />
        <span>— 标「纯Selenium / 混合」的只对那套执行流程生效;两套引擎跑同样的 OpenRouter 界面但取key/账单路不同。</span>
      </div>

      {ADV_GROUPS.map((g) => {
        const fields = ADV_FIELDS.filter((f) => f.group === g);
        if (!fields.length) return null;
        return (
          <section key={g} className="card" style={{ marginBottom: 16, padding: 16, border: '1px solid var(--border,#e5e7eb)', borderRadius: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>{g}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(320px,1fr))', gap: 14 }}>
              {fields.map((f) => (
                <div key={f.key} style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{f.label}</span>
                    <ScopeTag scope={f.scope} />
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted-foreground,#6b7280)', margin: '2px 0 6px' }}>{f.hint}</div>
                  {f.type === 'select' ? (
                    <select value={vals[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)}
                      style={{ width: '100%', height: 34, borderRadius: 6, border: '1px solid var(--border,#d1d5db)', padding: '0 8px' }}>
                      <option value="">默认({f.def || '—'})</option>
                      {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input type={f.type === 'number' ? 'number' : 'text'} value={vals[f.key] ?? ''}
                      placeholder={f.def ? `默认 ${f.def}` : '留空=代码默认'}
                      onChange={(e) => set(f.key, e.target.value)}
                      style={{ width: '100%', height: 34, borderRadius: 6, border: '1px solid var(--border,#d1d5db)', padding: '0 8px' }} />
                  )}
                  <div style={{ fontSize: 10, color: 'var(--muted-foreground,#9ca3af)', marginTop: 3, fontFamily: 'monospace' }}>{f.env}</div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
