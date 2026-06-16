// ⟦共享规范实现⟧ 改这里;各项目 web/src/{components,lib}/ 下同名文件是 export* 的 re-export shim,勿改。见 shared-web-ui/README.md
// 轻量 Toast 通知(替代原生 alert/confirm 的提示部分);confirm 仍用浏览器原生(期4 再做自定义)。
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Icon } from './icons';

type ToastKind = 'ok' | 'err' | 'info';
interface ToastItem { id: number; kind: ToastKind; msg: string; }
interface ToastCtx { push: (msg: string, kind?: ToastKind) => void; }

const Ctx = createContext<ToastCtx>({ push: () => {} });
export function useToast() { return useContext(Ctx); }

let seq = 1;
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((msg: string, kind: ToastKind = 'info') => {
    const id = seq++;
    setItems((xs) => [...xs, { id, kind, msg }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 4200);
  }, []);
  const dismiss = (id: number) => setItems((xs) => xs.filter((x) => x.id !== id));
  return (
    <Ctx.Provider value={{ push }}>
      {children}
      <div className="toast-wrap">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <Icon name={t.kind === 'ok' ? 'okcircle' : t.kind === 'err' ? 'xcircle' : 'info'} size={16}
              style={{ color: t.kind === 'ok' ? 'var(--success)' : t.kind === 'err' ? 'var(--danger)' : 'var(--primary)', flex: 'none', marginTop: 1 }} />
            <span className="t-msg">{t.msg}</span>
            <button className="t-x" onClick={() => dismiss(t.id)} aria-label="关闭">×</button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
