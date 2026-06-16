// 失败恢复策略预设的 react-query 封装:拉取 + 保存/删除/设激活(成功后 invalidate)。
// 单一全局命名空间(无 stage/engine 维度),与 useStrategies 同范式但参数更简。
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../lib/api';
import type { RecoveryResp } from '../../lib/types';

type Opts = Record<string, string | boolean>;

export function useRecovery() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['recovery'],
    queryFn: () => apiGet<RecoveryResp>('/api/recovery'),
    refetchOnWindowFocus: false,   // 编辑中不被窗口聚焦刷新冲掉本地 draft
    staleTime: 30_000,
  });
  const inval = () => qc.invalidateQueries({ queryKey: ['recovery'] });
  const save = useMutation({ mutationFn: (b: { id?: string; name?: string; opts: Opts }) => apiPost('/api/recovery/save', b), onSuccess: inval });
  const del = useMutation({ mutationFn: (b: { id: string }) => apiPost('/api/recovery/delete', b), onSuccess: inval });
  const active = useMutation({ mutationFn: (b: { id: string }) => apiPost('/api/recovery/active', b), onSuccess: inval });
  return { data: q.data, isLoading: q.isLoading, isError: q.isError, error: q.error as Error | null, save, del, active };
}
