// 占位页:尚未上线的页面(后续期填充),保证导航与 SPA 路由完整、不出现 404。
import { Icon } from '../lib/icons';

export default function ComingSoon({ title, note }: { title: string; note: string }) {
  return (
    <main className="page">
      <div className="card card-pad" style={{ textAlign: 'center', padding: '48px 24px' }}>
        <div style={{ display: 'inline-grid', placeItems: 'center', width: 48, height: 48, borderRadius: 12, background: 'var(--primary-weak)', color: 'var(--primary-text)', marginBottom: 14 }}>
          <Icon name="activity" size={24} />
        </div>
        <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>{title}</h2>
        <p style={{ color: 'var(--text-2)', fontSize: 13, maxWidth: 460, margin: '0 auto' }}>{note}</p>
      </div>
    </main>
  );
}
