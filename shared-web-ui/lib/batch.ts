// ⟦共享规范实现⟧ 改这里;各项目 web/src/{components,lib}/ 下同名文件是 export* 的 re-export shim,勿改。见 shared-web-ui/README.md
// 批量操作执行器:对每个 item 跑 fn(并发),用 Promise.allSettled 收集成功/失败,
// 完成后弹汇总 toast(失败不再静默),再 onDone()(通常 = 清空选择)。
// 替代各页「sel.forEach(.mutate); clear()」的即发即忘——那种写法任一项失败无任何反馈、且已清空选中。
interface ToastLike { push: (msg: string, kind?: 'ok' | 'err' | 'info') => void }

export async function batchRun<T>(
  items: T[],
  fn: (item: T) => Promise<unknown>,
  opts: { toast: ToastLike; verb: string; onDone?: () => void },
): Promise<void> {
  if (!items.length) return;
  const results = await Promise.allSettled(items.map((it) => fn(it)));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const fail = results.length - ok;
  if (fail === 0) opts.toast.push(`${opts.verb}成功 ${ok} 项`, 'ok');
  else opts.toast.push(`${opts.verb}:成功 ${ok} · 失败 ${fail}(可重试)`, 'err');
  opts.onDone?.();
}
