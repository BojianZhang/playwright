// 结果聚合页「自定义格式导出」(复刻成功回显 EchoModal 的模板编辑器):
//  - 模板里写 {{变量}},导出时每行替换成真实值;新增 {{index}} 自增序号(从「序号起始」开始每行 +1)。
//  - 导出 .txt(按模板逐行渲染)/ 导出 .json(结构化数组,每条含 index + 全字段)/ 复制 TXT。
//  - 模板记到 localStorage,下次打开沿用。
import { useEffect, useRef, useState } from 'react';
import { Modal } from '../components/Modal';
import { Icon } from '../lib/icons';
import type { AccountRow } from '../lib/types';

const SEP: Record<string, string> = { space: ' ', pipe: ' | ', colon: ':', comma: ',', nl: '\n' };
const SEP_LABEL: Record<string, string> = { space: '空格', pipe: '|', colon: ':', comma: ',', nl: '换行' };

interface VarDef { k: string; label: string; desc: string; sample: string; }
const VARS: VarDef[] = [
  { k: 'index', label: '序号', desc: '自增序号(从「序号起始」开始,每行 +1)', sample: '1' },
  { k: 'email', label: '邮箱', desc: '账号邮箱', sample: 'user1@firstmail.com' },
  { k: 'password', label: '密码', desc: '当前密码(设了统一密码即统一密码,否则原密码)', sample: 'MyNewPass#2026' },
  { k: 'originalPassword', label: '原密码', desc: '邮箱原始密码(注册时用的)', sample: 'oldpw123' },
  { k: 'apiKey', label: 'key', desc: 'OpenRouter API Key', sample: 'sk-or-v1-abcd…ef01' },
  { k: 'billingStatus', label: 'billing', desc: 'skipped/address-bound/card-bound/success/declined', sample: 'success' },
  { k: 'charged', label: '充值', desc: '实际充值金额(美元,未充值为 0)', sample: '10' },
  { k: 'cardLast4', label: 'card', desc: '本次所用卡号末 4 位', sample: '8695' },
  { k: 'passwordChanged', label: '改密', desc: '邮箱密码是否改为统一密码(true / false)', sample: 'true' },
  { k: 'exitIp', label: 'ip', desc: '代理出口 IP(实际出网 IP)', sample: '203.0.113.7' },
  { k: 'nodeId', label: '节点', desc: '产出该账号的节点 ID', sample: 'PC-01' },
  { k: 'createdAt', label: '时间', desc: '产出时间', sample: '2026-06-14 04:14:57' },
];

// 默认:多行 per-account 块(对齐 FirstMail 批量改密导出格式)。模板含换行 → 每个账号渲染成整块,块间换行拼接。
const DEFAULT_TPL = [
  '====== {{index}} ======',
  '原始数据：{{email}}:{{originalPassword}}',
  '当前数据：{{email}}:{{password}}',
  '邮箱：{{email}}',
  '现密码：{{password}}',
  '原密码：{{originalPassword}}',
  'openrouter密钥：{{apiKey}}',
].join('\n');
const TPL_KEY = 'or_results_export_tpl';
const SAMPLE: AccountRow = { email: 'user1@firstmail.com', password: 'MyNewPass#2026', originalPassword: 'oldpw123', apiKey: 'sk-or-v1-abcd…ef01', billingStatus: 'success', charged: 10, cardLast4: '8695', passwordChanged: true, exitIp: '203.0.113.7', nodeId: 'PC-01', createdAt: '2026-06-14 04:14:57' };

function fieldStr(a: AccountRow, k: string, index: number): string {
  if (k === 'index') return String(index);
  if (k === 'charged') return a.charged != null ? String(a.charged) : (a.topUpAmount != null ? String(a.topUpAmount) : '0');
  if (k === 'passwordChanged') return a.passwordChanged ? 'true' : 'false';
  const v = (a as unknown as Record<string, unknown>)[k];
  return v == null ? '' : String(v);
}
function renderRow(tpl: string, a: AccountRow, index: number): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_m, k) => fieldStr(a, k, index));
}

export function ResultsExportModal({ open, onClose, rows, onDownload, onCopy }: {
  open: boolean; onClose: () => void; rows: AccountRow[];
  onDownload: (name: string, content: string, type: string) => void; onCopy: (txt: string) => void;
}) {
  const [tpl, setTpl] = useState(() => { try { return localStorage.getItem(TPL_KEY) || DEFAULT_TPL; } catch { return DEFAULT_TPL; } });
  const [start, setStart] = useState('1');
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { try { localStorage.setItem(TPL_KEY, tpl); } catch { /* ignore */ } }, [tpl]);

  const startN = (() => { const n = Math.floor(Number(start)); return Number.isFinite(n) ? n : 1; })();
  const preview = renderRow(tpl, rows[0] || SAMPLE, startN);

  function insert(text: string) {
    const ta = taRef.current; if (!ta) { setTpl((t) => t + text); return; }
    const s = ta.selectionStart ?? tpl.length, e = ta.selectionEnd ?? tpl.length;
    const next = tpl.slice(0, s) + text + tpl.slice(e);
    setTpl(next);
    requestAnimationFrame(() => { ta.focus(); const pos = s + text.length; ta.setSelectionRange(pos, pos); });
  }

  const buildTxt = () => rows.map((a, i) => renderRow(tpl, a, startN + i)).join('\n');
  const buildJson = () => JSON.stringify(rows.map((a, i) => ({
    index: startN + i, email: a.email || '', password: a.password || '', originalPassword: a.originalPassword || '',
    apiKey: a.apiKey || '', billingStatus: a.billingStatus || '', charged: a.charged != null ? a.charged : (a.topUpAmount != null ? a.topUpAmount : 0),
    cardLast4: a.cardLast4 || '', passwordChanged: !!a.passwordChanged, exitIp: a.exitIp || '', nodeId: a.nodeId || '', createdAt: a.createdAt || '',
  })), null, 2);

  return (
    <Modal open={open} onClose={onClose} size="md" icon="download"
      title={<>自定义导出 <span className="dim">— 可用变量 / 编辑格式({rows.length} 条)</span></>}
      foot={<>
        <button className="btn btn-ghost" onClick={() => setTpl(DEFAULT_TPL)}><Icon name="refresh" size={14} /> 恢复默认</button>
        <button className="btn btn-ghost" onClick={() => setTpl('')}><Icon name="trash" size={14} /> 清空格式</button>
        <div className="spacer" />
        <button className="btn btn-ghost" disabled={!rows.length} onClick={() => onCopy(buildTxt())}>复制 TXT</button>
        <button className="btn btn-soft" disabled={!rows.length} onClick={() => onDownload('accounts.txt', buildTxt(), 'text/plain')}><Icon name="download" size={14} /> 导出 .txt</button>
        <button className="btn btn-primary" disabled={!rows.length} onClick={() => onDownload('accounts.json', buildJson(), 'application/json')}><Icon name="download" size={14} /> 导出 .json</button>
      </>}>
      <div className="modal-body">
        <p className="modal-intro">把变量写进格式里,导出 .txt 时每行替换成真实值。<b>{'{{index}}'}</b> 是自增序号(从下面「序号起始」开始,每行 +1)。导出 .json 则输出结构化数组(每条含 index + 全字段,不受文本格式影响)。</p>
        <div className="m-field">
          <div className="m-label">输出格式(.txt)</div>
          <textarea ref={taRef} className="m-tpl" spellCheck={false} rows={8} style={{ minHeight: 150, fontFamily: 'var(--mono, monospace)', whiteSpace: 'pre' }} value={tpl} onChange={(e) => setTpl(e.target.value)} />
        </div>
        <div className="m-field">
          <div className="m-label">实时预览 <span className="dim">({rows.length ? '第 1 条真实数据' : '示例数据'})</span></div>
          <div className="m-preview" style={{ whiteSpace: 'pre-wrap' }}>{preview ? preview : <span className="ph">(格式为空)</span>}</div>
        </div>
        <div className="m-field" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="m-label" style={{ margin: 0 }}>序号起始</div>
          <input type="number" value={start} style={{ width: 100 }} onChange={(e) => setStart(e.target.value)} />
          <span className="dim" style={{ fontSize: 12 }}>{'{{index}}'} 从此值开始,每行 +1(如填 1 → 1,2,3…)</span>
        </div>
        <div className="m-field">
          <div className="m-label">分隔符 <span className="dim">(点击插入到光标处)</span></div>
          <div className="sep-row">
            {Object.keys(SEP).map((s) => <button key={s} className="sep-btn" onClick={() => insert(SEP[s])}>{SEP_LABEL[s]}</button>)}
          </div>
        </div>
        <div className="m-field">
          <div className="m-label">可用变量及含义 <span className="dim">(「插入」=只插变量;「带名」=简称变量)</span></div>
          <div>
            {VARS.map((v) => (
              <div className="vrow" key={v.k}>
                <div className="vname"><span className="vvar">{`{{${v.k}}}`}</span><span className="vlabel">{v.label}</span></div>
                <div className="vdesc">{v.desc}</div>
                <button className="btn btn-soft btn-sm" onClick={() => insert(`{{${v.k}}}`)}>插入</button>
                <button className="btn btn-ghost btn-sm" onClick={() => insert(`${v.label}:{{${v.k}}}`)}>带名</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
