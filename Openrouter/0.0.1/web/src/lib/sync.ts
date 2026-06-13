// 跨标签页同步(rt-11):一个标签发生写操作(apiPost)后,通过 BroadcastChannel 通知其它标签,
// 其它标签据此让 React Query 缓存失效 → 后台重取,避免「A 标签禁卡 / 改配置,B 标签还显示旧数据」。
// 不支持 BroadcastChannel 的环境静默降级(各页自身的 refetchInterval 仍兜底)。

const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('openrouter-sync') : null;

// 写操作成功后广播(apiPost 调用)。url 仅用于诊断,接收端统一作废所有查询即可。
export function notifyMutation(url: string): void {
  try { channel?.postMessage({ type: 'mutation', url, ts: Date.now() }); } catch { /* ignore */ }
}

// 监听其它标签的写操作通知;返回取消订阅函数。
export function onMutation(cb: (url: string) => void): () => void {
  if (!channel) return () => { /* no-op */ };
  const h = (e: MessageEvent) => { if (e?.data?.type === 'mutation') cb(String(e.data.url || '')); };
  channel.addEventListener('message', h);
  return () => channel.removeEventListener('message', h);
}
