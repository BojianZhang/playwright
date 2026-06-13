// 通用导出工具:把任意"表头 + 行"导出成 CSV / 文本文件并触发浏览器下载。
// 给 DataTable 内置导出按钮和各页"导出"按钮共用 —— 凡是有列表的地方都能一键导出。
//
// 设计要点:
//  - CSV 带 UTF-8 BOM(Excel 正确识别中文)+ CRLF 行尾。
//  - 单元格转义:含 " , \n \r 的值整体加引号、内部 " 转义成 ""。
//  - CSV 注入防护:以 = + @ \t \r 开头的值前置一个 '(防止 Excel/Sheets 把它当公式执行)。
//  - 文件名自动带时间戳,避免多次导出覆盖。

function csvCell(v: string | number | null | undefined): string {
  if (v == null) return '';
  let s = String(v);
  // CSV 注入防护:Excel/Sheets 会把以这些字符开头的单元格当公式。
  if (/^[=+@\t\r]/.test(s)) s = "'" + s;
  // 含特殊字符 → 加引号并转义内部引号。
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** 把表头 + 二维数据拼成 CSV 文本(含 BOM)。 */
export function toCsv(headers: (string | number)[], rows: (string | number | null | undefined)[][]): string {
  const head = headers.map((h) => csvCell(h)).join(',');
  const body = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  return '﻿' + head + '\r\n' + body;
}

/** 触发浏览器下载一段内容为文件。 */
export function downloadFile(name: string, content: string, type = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

/** 文件名安全时间戳,如 20260613-142530。 */
export function stamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 一步到位:导出 CSV 文件(自动补 .csv 后缀 + 时间戳)。 */
export function downloadCsv(baseName: string, headers: (string | number)[], rows: (string | number | null | undefined)[][]): void {
  downloadFile(`${baseName}-${stamp()}.csv`, toCsv(headers, rows), 'text/csv;charset=utf-8');
}
