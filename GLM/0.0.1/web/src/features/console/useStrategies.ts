// 环节命名策略预设的 react-query 封装:拉取 + 保存/删除/设激活(成功后 invalidate)。
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../lib/api';
import type { StrategiesResp } from '../../lib/types';

type Opts = Record<string, string | boolean>;

export function useStrategies() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['strategies'],
    queryFn: () => apiGet<StrategiesResp>('/api/strategies'),
    refetchOnWindowFocus: false,   // 编辑中不被窗口聚焦刷新冲掉本地 draft
    staleTime: 30_000,
  });
  const inval = () => qc.invalidateQueries({ queryKey: ['strategies'] });
  const save = useMutation({ mutationFn: (b: { stage: string; id?: string; name?: string; opts: Opts }) => apiPost('/api/strategies/save', b), onSuccess: inval });
  const del = useMutation({ mutationFn: (b: { stage: string; id: string }) => apiPost('/api/strategies/delete', b), onSuccess: inval });
  const active = useMutation({ mutationFn: (b: { stage: string; id: string }) => apiPost('/api/strategies/active', b), onSuccess: inval });
  return { data: q.data, isLoading: q.isLoading, isError: q.isError, error: q.error as Error | null, save, del, active };
}
