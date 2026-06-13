// 文件/粘贴上传的逐行解析(移植自旧 controller.js:按字段格式抽取,只留匹配,忽略杂质)。
export type Kind = 'account' | 'proxy' | 'card' | 'address';

const unq = (s: string) => s.replace(/^["']|["']$/g, '').trim();

const LINE_EXTRACT: Record<'account' | 'proxy' | 'card', (line: string) => string | null> = {
  account(line) {
    const em = line.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
    if (!em) return null;
    const email = em[0];
    const after = line.slice((em.index ?? 0) + email.length);
    const pm = after.match(/[\s:|,;\t]+(\S[^\s|,;\t]*)/);
    return `${email}:${pm ? unq(pm[1]) : ''}`;
  },
  proxy(line) {
    const t = unq(line.split(/\s+\|\s+/)[0]);
    // scheme://[user:pass@]host:port —— 后端 _parseLine 原生支持且能保留 type,故校验后原样返回(别剥 scheme,否则丢 http/socks 类型)。
    if (/^[a-zA-Z][\w+.\-]*:\/\//.test(t)) {
      return /\/\/(?:[^@/]+@)?[A-Za-z0-9.\-]+:\d{1,5}/.test(t) ? t : null;
    }
    let m = t.match(/^([^\s:@]+):([^\s:@]+)@([A-Za-z0-9.\-]+):(\d{1,5})$/);
    if (m) return `${m[3]}:${m[4]}:${m[1]}:${m[2]}`;
    m = t.match(/^([A-Za-z0-9.\-]+):(\d{1,5})(?::(.+))?$/);
    if (m) return m[3] != null ? `${m[1]}:${m[2]}:${m[3]}` : `${m[1]}:${m[2]}`;
    return null;
  },
  card(line) {
    // 与后端 billing/card-pool.parseCardLines 对齐:需 有效期(MM/YY)+ 13-19 位卡号 + CVC(3-4)。
    // 否则上传预览"解析出 N 条"会与导入"N 行全部无法解析"打架(预览只验卡号就算数)。
    const expM = line.match(/(\d{1,2})\s*[/\-]\s*(\d{2,4})/);
    if (!expM) return null;
    const rest = line.replace(expM[0], ' ');
    const runs = rest.match(/(?:\d[ \t]?){13,19}/g) || [];
    let number = '';
    for (const run of runs) { const d = run.replace(/\D/g, ''); if (d.length >= 13 && d.length <= 19 && d.length > number.length) number = d; }
    if (!number) return null;
    const shorts = rest.replace(/(?:\d[ \t]?){13,19}/g, ' ').match(/\d+/g) || [];
    if (!shorts.some((t) => t.length === 3 || t.length === 4)) return null;  // 需 CVC
    return line.trim();
  },
};

export interface ParseResult { kept: string[]; ignored: number; }

function lineParse(text: string, ex: (line: string) => string | null): ParseResult {
  const kept: string[] = []; let ignored = 0;
  text.split(/\r?\n/).forEach((line) => {
    const s = line.trim();
    if (!s || s.startsWith('#')) return;
    const out = ex(s);
    if (out) kept.push(out); else ignored += 1;
  });
  return { kept, ignored };
}

// CSV(引号字段/字段内逗号/"" 转义/BOM/CRLF)
function csvRows(text: string): string[][] {
  const s = String(text).replace(/^﻿/, '');
  const rows: string[][] = []; let row: string[] = [], cell = '', inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function splitUsAddress(addr: string): { line1: string; city: string; state: string; zip: string } | null {
  let parts = String(addr).split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length && /^(united states|usa|u\.?s\.?a?\.?)$/i.test(parts[parts.length - 1])) parts.pop();
  if (parts.length < 3) return null;
  const sz = (parts.pop() as string).match(/^(.+?)\s+(\d{5}(?:-\d{4})?)$/);
  if (!sz) return null;
  const state = sz[1].trim(); const zip = sz[2];
  const city = parts.pop() as string;
  const line1 = parts.join(' ').replace(/\s+/g, ' ').trim();
  return (line1 && city && state && zip) ? { line1, city, state, zip } : null;
}
function rowToAddress(cells: string[], nameIdx: number, addrIdx: number): string | null {
  // 注意外层括号:nameIdx 越界(行比表头短)时 cells[nameIdx] 为 undefined,必须整体 || '' 再 trim,否则崩溃。
  const name = ((nameIdx >= 0 ? cells[nameIdx] : cells[0]) || '').trim();
  let addr = addrIdx >= 0 ? (cells[addrIdx] || '').trim()
    : (cells.find((c) => /\d{5}(?:-\d{4})?\s*,\s*united states/i.test(c) || /,\s*[A-Za-z][A-Za-z .]+\s+\d{5}(?:-\d{4})?\b/.test(c)) || '').trim();
  if (!name || !addr) return null;
  const c = splitUsAddress(addr);
  return c ? [name, c.line1, c.city, c.state, c.zip].join('|') : null;
}
function parseAddressSmart(text: string): ParseResult {
  const rows = csvRows(text);
  const kept: string[] = []; let ignored = 0;
  let nameIdx = -1, addrIdx = -1, start = 0;
  if (rows.length) {
    rows[0].forEach((c, i) => { const h = String(c).toLowerCase(); if (nameIdx < 0 && /(name|姓名)/.test(h)) nameIdx = i; if (addrIdx < 0 && /(address|地址)/.test(h)) addrIdx = i; });
    if (nameIdx >= 0 && addrIdx >= 0) start = 1;
  }
  for (let r = start; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells || !cells.join('').trim()) continue;
    if (cells.length === 1 && cells[0].includes('|')) {
      const p = cells[0].split(/\s*\|\s*/).map((x) => x.trim()).filter(Boolean);
      if (p.length >= 4) { kept.push(p.join('|')); continue; }
      ignored += 1; continue;
    }
    const canon = rowToAddress(cells, nameIdx, addrIdx);
    if (canon) { kept.push(canon); continue; }
    // 扁平兜底:去掉尾部"国家"列后,要求末列真含 5 位邮编,且恰好 4/5 列(避免多出前置列→字段右移塞错城市/州/邮编)。
    const flat = cells.map((x) => x.trim()).filter(Boolean);
    if (flat.length && /^(united states|usa|u\.?s\.?a?\.?)$/i.test(flat[flat.length - 1])) flat.pop();
    if ((flat.length === 5 || flat.length === 4) && /\b\d{5}(?:-\d{4})?\b/.test(flat[flat.length - 1])) {
      kept.push((flat.length === 5 ? flat : ['', ...flat]).join('|'));  // 4 列=无姓名 → 补空姓名,对齐 name|line1|city|state|zip
      continue;
    }
    ignored += 1;
  }
  return { kept, ignored };
}

export const KIND_LABEL: Record<Kind, string> = {
  account: '邮箱:密码', proxy: 'host:port:user:pass', card: '银行卡', address: '姓名|街道|城市|州|邮编',
};

export function parseKind(kind: Kind, text: string): ParseResult {
  if (kind === 'account') return lineParse(text, LINE_EXTRACT.account);
  if (kind === 'proxy') return lineParse(text, LINE_EXTRACT.proxy);
  if (kind === 'card') return lineParse(text, LINE_EXTRACT.card);
  if (kind === 'address') return parseAddressSmart(text);
  return { kept: text.split(/\r?\n/).filter(Boolean), ignored: 0 };
}

// 展示小工具
export function shortTime(s?: string): string {
  if (!s) return '—';
  try { return new Date(s).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return s; }
}
export function trunc(s: string | undefined, n: number): string { return s && s.length > n ? s.slice(0, n) + '…' : (s || ''); }

export function fmtDuration(ms?: number | null): string {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60); const r = s % 60;
  if (m < 60) return `${m}m${r ? r + 's' : ''}`;
  const h = Math.floor(m / 60); return `${h}h${m % 60}m`;
}
export function fmtDateTime(ts?: number | null): string {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return '—'; }
}
