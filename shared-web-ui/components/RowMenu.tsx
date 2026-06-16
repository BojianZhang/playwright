// ⟦共享规范实现⟧ 改这里;各项目 web/src/{components,lib}/ 下同名文件是 export* 的 re-export shim,勿改。见 shared-web-ui/README.md
// 操作列「⋯」溢出菜单:把次要逐行操作收起来,操作列更窄。
// 用 position:fixed + 按钮坐标定位(表格容器 overflow:auto 会裁切普通 absolute 菜单);
// 点外、滚动、Esc 均关闭。inline 槽放保留在外面的主操作(如诊断🔍)。
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../lib/icons';

export interface RowAction {
  label: string;
  onClick: () => void;
  icon?: string;
  danger?: boolean;
  hide?: boolean;
}

export function RowMenu({ actions, inline }: { actions: RowAction[]; inline?: ReactNode }) {
  const items = actions.filter((a) => !a.hide);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 160 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const width = 160;
    const h = items.length * 34 + 8;
    let left = Math.max(8, r.right - width);
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    setPos({ top, left, width });
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);   // 捕获:表格容器滚动也关
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  if (!items.length) return <div className="row-actions">{inline}</div>;

  return (
    <div className="row-actions">
      {inline}
      <button ref={btnRef} className="btn btn-ghost btn-sm row-menu-btn" aria-label="更多操作" title="更多操作"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>⋯</button>
      {open && (
        <div ref={menuRef} className="row-menu" style={{ top: pos.top, left: pos.left, width: pos.width }} onClick={(e) => e.stopPropagation()}>
          {items.map((a, i) => (
            <button key={i} className={'row-menu-item' + (a.danger ? ' danger' : '')}
              onClick={() => { setOpen(false); a.onClick(); }}>
              {a.icon && <Icon name={a.icon} size={13} />}<span>{a.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
