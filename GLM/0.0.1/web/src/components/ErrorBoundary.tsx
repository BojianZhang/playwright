import { Component, type ErrorInfo, type ReactNode } from 'react';

// 错误边界:任一页面渲染抛错时,不再整个 SPA 白屏(连带丢掉侧栏/实时任务监视器),
// 只在边界内显示可恢复的兜底面板。包在 <Routes> 外层 → 出错也保留侧栏与正在跑的任务监视。
interface Props { children: ReactNode; label?: string }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    try { console.error('[ErrorBoundary]', this.props.label || '', error, info.componentStack); } catch { /* ignore */ }
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card" style={{ margin: 16, padding: 20 }}>
        <h3 style={{ marginTop: 0, color: 'var(--danger)' }}>页面渲染出错</h3>
        <p style={{ color: 'var(--text-2)' }}>这一块抛了异常,已被隔离 —— 侧栏与正在跑的任务监视器不受影响。</p>
        <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--text-3)', fontSize: 12, maxHeight: 160, overflow: 'auto' }}>{String(this.state.error.message || this.state.error)}</pre>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary btn-sm" onClick={() => this.setState({ error: null })}>重试</button>
          <button className="btn btn-ghost btn-sm" onClick={() => { window.location.href = '/'; }}>回总览</button>
        </div>
      </div>
    );
  }
}
