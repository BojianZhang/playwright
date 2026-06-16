// 执行方案预设的 react-query 封装:拉取 + 保存/删除/设激活(成功后 invalidate)。
// 一个方案 = 控制台"怎么跑"的整套配置快照(引擎/流程/并发/浏览器/资源池),不含凭证/密码/数据。
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../lib/api';

export interface SchemeCfg {
  engine: string; mode: string; conc: string; count: string;
  chk: { headed: boolean; resume: boolean; humanLike: boolean };
  stages: Record<string, boolean>;
  browserProvider: string; envIds: string;
  useAdspowerPool: boolean; useProxyPool: boolean; useAddressPool: boolean;
  useDispatch: boolean; shipResources: boolean;
}
export interface SchemePreset { id: string; name: string; builtin?: boolean; cfg: SchemeCfg }
export interface SchemesResp { version: number; schemes: { activeId: string; presets: SchemePreset[] } }

export function useSchemes() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['schemes'],
    queryFn: () => apiGet<SchemesResp>('/api/schemes'),
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
  const inval = () => qc.invalidateQueries({ queryKey: ['schemes'] });
  const save = useMutation({ mutationFn: (b: { id?: string; name?: string; cfg: SchemeCfg }) => apiPost('/api/schemes/save', b), onSuccess: inval });
  const del = useMutation({ mutationFn: (b: { id: string }) => apiPost('/api/schemes/delete', b), onSuccess: inval });
  const active = useMutation({ mutationFn: (b: { id: string }) => apiPost('/api/schemes/active', b), onSuccess: inval });
  return { data: q.data, isLoading: q.isLoading, isError: q.isError, error: q.error as Error | null, save, del, active };
}
