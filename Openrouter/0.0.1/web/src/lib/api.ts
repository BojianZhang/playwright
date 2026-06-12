// 带 token 的 fetch + 类型化 GET/POST 助手(移植自旧 authFetch,401 改为通知守卫跳登录)。
import { getToken, notifyUnauthorized } from './auth';

export interface FetchOpts extends RequestInit { silent?: boolean; }

export async function authFetch(url: string, opts: FetchOpts = {}): Promise<Response> {
  const tok = getToken();
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string> | undefined) };
  if (tok) headers['X-Auth-Token'] = tok;
  const r = await fetch(url, { ...opts, headers });
  if (r.status === 401 && !opts.silent) notifyUnauthorized();
  return r;
}

export async function apiGet<T>(url: string, silent = false): Promise<T> {
  const r = await authFetch(url, { silent });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return (await r.json()) as T;
}

export async function apiPost<T>(url: string, body?: unknown, silent = false): Promise<T> {
  const r = await authFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    silent,
  });
  const data = (await r.json().catch(() => ({}))) as T;
  if (!r.ok) throw new Error((data as { error?: string; message?: string })?.message || (data as { error?: string })?.error || `POST ${url} → ${r.status}`);
  return data;
}
