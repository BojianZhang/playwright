// 通用资源导入弹窗(人性化版):文件上传 + 粘贴框 + 拖拽 + 剪贴板 + 实时解析计数 + 忽略行预览 + 示例/模板。
// 解析逻辑沿用 console 的 parseKind;复用 app.css 的 .upload/.fname/.field,新增 .import-* 系列样式。
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon } from '../lib/icons';
import { useToast } from '../lib/toast';
import { Modal } from './Modal';

export interface ImportParseResult { kept: string[]; ignored: number; }

export function ImportModal({
  open, onClose, title, icon = 'upload', label, hint, placeholder,
  accept = '.txt,.csv,text/*', parse, extra, example, template, templateName, onImport, formatResult,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  icon?: string;
  label?: string;                 // 字段名 + 文件解析失败提示里的「符合『X』的数据」(默认用 title)
  hint: ReactNode;
  placeholder: string;
  accept?: string;
  parse?: (text: string) => ImportParseResult;   // 给了→逐行解析+实时计数+忽略行预览;没给→按非空行
  extra?: ReactNode;              // 文本框上方的额外字段(如 AdsPower「所属端点」下拉)
  example?: string;               // 「填入示例」内容(缺省用 placeholder)
  template?: string;              // 「下载模板」内容(缺省用 example/placeholder)
  templateName?: string;          // 模板文件名(缺省 <label>-模板.txt)
  onImport: (raw: string) => Promise<unknown>;    // 通常 = (raw) => mutation.mutateAsync({ raw })
  formatResult: (r: unknown) => string;           // 把后端返回拼成 toast 文案
}) {
  const toast = useToast();
  const [raw, setRaw] = useState('');
  const [fileMsg, setFileMsg] = useState<{ cls: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const name = label || title;

  useEffect(() => { if (open) { setRaw(''); setFileMsg(null); setBusy(false); setDragging(false); setShowIgnored(false); } }, [open]);

  // 实时计数:每次内容变就算「识别 N 条 · 忽略 M 行」
  const stats = useMemo(() => {
    if (!raw.trim()) return { kept: 0, ignored: 0 };
    if (parse) { const { kept, ignored } = parse(raw); return { kept: kept.length, ignored }; }
    return { kept: raw.split(/\r?\n/).filter((l) => l.trim()).length, ignored: 0 };
  }, [raw, parse]);

  // 被忽略的原始行(展开预览时才算,避免大粘贴每键卡顿)
  const ignoredLines = useMemo(() => {
    if (!parse || !showIgnored) return [];
    return raw.split(/\r?\n/).map((s) => s.trim()).filter((l) => l && !l.startsWith('#') && parse(l).kept.length === 0);
  }, [raw, parse, showIgnored]);

  function append(text: string) {
    const add = text.replace(/\s+$/, '');
    if (!add) return;
    setRaw((prev) => { const p = prev.replace(/\s+$/, ''); return p ? `${p}\n${add}` : add; });
  }
  // 文件/剪贴板/拖拽统一入口:有 parse 先校验能不能识别,识别不到给「传错了?」提示。
  function ingest(text: string) {
    if (parse) {
      const { kept, ignored } = parse(text);
      if (!kept.length) { setFileMsg({ cls: 'err', text: `✕ 没识别出符合「${name}」的数据(忽略 ${ignored} 行)—— 传错文件了?` }); return; }
      append(kept.join('\n'));
      setFileMsg({ cls: 'ok', text: `✓ 追加 ${kept.length} 条${ignored ? ` · 跳过 ${ignored} 行` : ''}` });
    } else {
      const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (!lines.length) { setFileMsg({ cls: 'err', text: '✕ 没有内容' }); return; }
      append(lines.join('\n'));
      setFileMsg({ cls: 'ok', text: `✓ 追加 ${lines.length} 行` });
    }
  }
  function onFiles(files: FileList | File[]) {
    Array.from(files).forEach((f) => {
      const reader = new FileReader();
      reader.onload = () => ingest(String(reader.result || ''));
      reader.onerror = () => setFileMsg({ cls: 'err', text: '✕ 读取失败' });
      reader.readAsText(f);
    });
  }
  async function pasteClip() {
    try { const t = await navigator.clipboard.readText(); if (t && t.trim()) ingest(t); else setFileMsg({ cls: 'err', text: '✕ 剪贴板是空的' }); }
    catch { toast.push('读不到剪贴板(浏览器限制),请直接 Ctrl+V 到框里', 'err'); }
  }
  function downloadTemplate() {
    const content = template || example || placeholder || '';
    const blob = new Blob([content + '\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = templateName || `${name}-模板.txt`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function doImport() {
    if (!raw.trim() || busy) return;
    setBusy(true);
    try {
      const r = await onImport(raw);
      toast.push(formatResult(r), 'ok');
      onClose();
    } catch (e) {
      toast.push(`导入失败:${(e as Error).message}`, 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={title} icon={icon} size="md"
      foot={<>
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
        <button className="btn btn-primary" disabled={!raw.trim() || busy} onClick={doImport}>{busy ? '导入中…' : `导入${stats.kept ? ` ${stats.kept} 条` : ''}`}</button>
      </>}>
      <div style={{ padding: '16px 20px', display: 'grid', gap: 12 }}>
        {extra}
        <div className="field" style={{ margin: 0 }}>
          <div className="label">
            <span className="l-name">{name}</span><span className="l-hint">{hint}</span>
          </div>
          <div className="import-tools">
            <label className="upload"><Icon name="upload" size={12} />选文件
              <input type="file" hidden multiple accept={accept}
                onChange={(e) => { if (e.target.files?.length) onFiles(e.target.files); e.currentTarget.value = ''; }} />
            </label>
            <button type="button" className="btn btn-ghost btn-sm" onClick={pasteClip}><Icon name="edit" size={12} />粘贴板</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRaw(example || placeholder)}>填入示例</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={downloadTemplate}><Icon name="download" size={12} />模板</button>
          </div>
          <div className={'import-drop' + (dragging ? ' dragover' : '')}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files?.length) onFiles(e.dataTransfer.files); }}>
            <textarea rows={9} spellCheck={false} value={raw} placeholder={placeholder + '\n\n…也可把文件拖到这里'} onChange={(e) => setRaw(e.target.value)} />
            {dragging && <div className="drop-hint"><Icon name="upload" size={18} />松开导入文件</div>}
          </div>
          <div className="import-status">
            {fileMsg && <span className={'fname ' + fileMsg.cls}>{fileMsg.text}</span>}
            {stats.kept + stats.ignored > 0 && (
              <span className="fname ok">识别 <b>{stats.kept}</b> 条{stats.ignored > 0 && <> · 忽略 {stats.ignored} 行 <button type="button" className="linklike" onClick={() => setShowIgnored((v) => !v)}>{showIgnored ? '收起' : '查看'}</button></>}</span>
            )}
          </div>
          {showIgnored && ignoredLines.length > 0 && (
            <div className="import-ignored">
              {ignoredLines.slice(0, 50).map((l, i) => <div key={i} className="ig-line" title={l}>{l}</div>)}
              {ignoredLines.length > 50 && <div className="ig-more">…共 {ignoredLines.length} 行未识别</div>}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
