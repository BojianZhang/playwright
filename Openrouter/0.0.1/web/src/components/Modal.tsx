// 通用模态:overlay + Esc/点外关闭 + 进出动画(沿用旧 .modal-overlay/.open class)。
import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from '../lib/icons';

export function Modal({ open, onClose, size = 'md', title, icon, iconKind, children, foot }: {
  open: boolean; onClose: () => void; size?: 'md' | 'lg';
  title: ReactNode; icon?: string; iconKind?: 'ok' | 'fail';
  children: ReactNode; foot?: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (open) { setMounted(true); requestAnimationFrame(() => setShown(true)); document.body.style.overflow = 'hidden'; }
    else { setShown(false); document.body.style.overflow = ''; const t = setTimeout(() => setMounted(false), 180); return () => clearTimeout(t); }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [open, onClose]);
  // 兜底:若组件在 open 态被直接卸载(父组件移除而非先置 open=false),恢复 body 滚动,避免整页永久锁死无法滚动。
  useEffect(() => () => { document.body.style.overflow = ''; }, []);
  if (!mounted) return null;
  return (
    <div className={'modal-overlay' + (shown ? ' open' : '')} style={{ opacity: shown ? 1 : 0, pointerEvents: shown ? 'auto' : 'none' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={'modal modal-' + size} role="dialog" aria-modal>
        <div className="modal-head">
          <h2>{icon && <span className={'mi' + (iconKind ? ' ' + iconKind : '')}><Icon name={icon} size={14} /></span>}{title}</h2>
          <button className="modal-x" onClick={onClose} aria-label="关闭"><Icon name="x" size={15} /></button>
        </div>
        {children}
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}
