import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { Icon } from '../lib/icons';
import { type SelectorsResp, SEL_SCOPE_LABEL, SEL_SCOPE_COLOR, SEL_KIND_LABEL } from '../lib/selectorsSchema';

type Vals = Record<string, string>;

export default function ElementsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['selectors'], queryFn: () => apiGet<SelectorsResp>('/api/selectors', true), retry: false });
  const [vals, setVals] = useState<Vals>({});
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (data && data.values) { setVals({ ...data.values }); setDirty(false); } }, [data]);

  const save = useMutation({
    mutationFn: () => apiPost('/api/selectors/save', vals),
    onSuccess: () => { setDirty(false); qc.invalidateQueries({ queryKey: ['selectors'] }); },
  });
  function set(id: string, v: string) { setVals((s) => ({ ...s, [id]: v })); setDirty(true); }

  const steps = data?.steps || [];
  const groups = useMemo(() => Array.from(new Set(steps.map((s) => s.group))), [steps]);

  return (
    <div style={{ padding: '16px 20px', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>元素维护</h1>
          <div style={{ fontSize: 13, color: 'var(--muted-foreground,#6b7280)', marginTop: 4 }}>
            OpenRouter 改版「元素找不到」时,在这改对应步骤的定位规则、<b>不改代码</b>,两引擎共用。
            「覆盖」留空 = 用<b>内置默认</b>(行为不变)。多个写一行用 <code>||</code> 分隔,按序尝试。改完<b>重起 job</b> 生效。
          </div>
        </div>
        <button className="btn primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}
          style={{ flexShrink: 0, opacity: (!dirty || save.isPending) ? 0.5 : 1 }}>
          <Icon name="check" size={14} />&nbsp;{save.isPending ? '保存中…' : (dirty ? '保存' : '已保存')}
        </button>
      </div>

      <div style={{ fontSize: 12, color: 'var(--muted-foreground,#6b7280)', margin: '8px 0 16px' }}>
        作用范围:
        {(['selenium', 'hybrid', 'both'] as const).map((sc) => (
          <span key={sc} style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, marginLeft: 6, color: '#fff', background: SEL_SCOPE_COLOR[sc] }}>{SEL_SCOPE_LABEL[sc]}</span>
        ))}
        <span style={{ marginLeft: 8 }}>— 当前提取的是<b>纯 Selenium</b> 流程的元素;Playwright 引擎随后接同一份。</span>
      </div>

      {groups.map((g) => (
        <section key={g} className="card" style={{ marginBottom: 16, padding: 16, border: '1px solid var(--border,#e5e7eb)', borderRadius: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>{g}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {steps.filter((s) => s.group === g).map((s) => (
              <div key={s.id} style={{ borderBottom: '1px dashed var(--border,#eee)', paddingBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{s.label}</span>
                  <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, color: '#fff', background: SEL_SCOPE_COLOR[s.scope] }}>{SEL_SCOPE_LABEL[s.scope]}</span>
                  <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: 'var(--muted,#f1f5f9)', color: 'var(--muted-foreground,#64748b)' }}>{SEL_KIND_LABEL[s.kind]}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted-foreground,#6b7280)', margin: '3px 0 6px' }}>{s.desc}</div>
                <div style={{ fontSize: 12, marginBottom: 6 }}>
                  <span style={{ color: 'var(--muted-foreground,#9ca3af)' }}>内置默认:</span>{' '}
                  <code style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{s.builtin.join('  ||  ')}</code>
                </div>
                <input value={vals[s.id] ?? ''} placeholder="覆盖(留空=用内置默认);多个用 || 分隔"
                  onChange={(e) => set(s.id, e.target.value)}
                  style={{ width: '100%', height: 32, borderRadius: 6, border: '1px solid var(--border,#d1d5db)', padding: '0 8px', fontFamily: 'monospace', fontSize: 12 }} />
                <div style={{ fontSize: 10, color: 'var(--muted-foreground,#9ca3af)', marginTop: 3, fontFamily: 'monospace' }}>{s.env}</div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
