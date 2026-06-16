// ⟦共享规范实现⟧ 改这里;各项目 web/src/{components,lib}/ 下同名文件是 export* 的 re-export shim,勿改。见 shared-web-ui/README.md
// 客户端访问令牌助手(移植自旧 auth.js)。token 存 localStorage('or_token');
// 支持 ?token= 带入并清理 URL;withToken 给 EventSource/下载拼 ?token=(无法带请求头的场景)。
const KEY = 'or_token';

function readUrlToken(): void {
  try {
    const usp = new URLSearchParams(location.search);
    const t = usp.get('token');
    if (t) {
      localStorage.setItem(KEY, t.trim());
      usp.delete('token');
      const clean = location.pathname + (usp.toString() ? '?' + usp.toString() : '') + location.hash;
      history.replaceState(null, '', clean);
    }
  } catch { /* ignore */ }
}
readUrlToken();

export function getToken(): string {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}

export function setToken(t: string): void {
  try { localStorage.setItem(KEY, (t || '').trim()); } catch { /* ignore */ }
}

export function clearToken(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export function withToken(u: string): string {
  const tok = getToken();
  if (!tok) return u;
  return u + (u.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(tok);
}

// 鉴权事件:401 时由 App 的守卫订阅,跳登录页(替代旧 prompt 弹窗)。
type AuthListener = () => void;
const listeners = new Set<AuthListener>();
export function onUnauthorized(fn: AuthListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function notifyUnauthorized(): void {
  for (const fn of listeners) { try { fn(); } catch { /* ignore */ } }
}
