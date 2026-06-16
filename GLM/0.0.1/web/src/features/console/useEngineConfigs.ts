// 引擎配置命名预设的 react-query 封装:拉取 + 保存/删除/设激活(成功后 invalidate)。
// 与 useStrategies 同范式,只是顶层维度从"环节"换成"引擎"。
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../lib/api';
import type { EngineConfigsResp } from '../../lib/types';

type Opts = Record<string, string | boolean>;

export function useEngineConfigs() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['engine-configs'],
    queryFn: () => apiGet<EngineConfigsResp>('/api/engine-configs'),
    refetchOnWindowFocus: false,   // 编辑中不被窗口聚焦刷新冲掉本地 draft
    staleTime: 30_000,
  });
  const inval = () => qc.invalidateQueries({ queryKey: ['engine-configs'] });
  const save = useMutation({ mutationFn: (b: { engine: string; id?: string; name?: string; opts: Opts }) => apiPost('/api/engine-configs/save', b), onSuccess: inval });
  const del = useMutation({ mutationFn: (b: { engine: string; id: string }) => apiPost('/api/engine-configs/delete', b), onSuccess: inval });
  const active = useMutation({ mutationFn: (b: { engine: string; id: string }) => apiPost('/api/engine-configs/active', b), onSuccess: inval });
  return { data: q.data, isLoading: q.isLoading, isError: q.isError, error: q.error as Error | null, save, del, active };
}
