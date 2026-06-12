// 后端 /api 数据结构的 TS 类型(对照 server.js + 各数据模块导出)。

export interface NodeInfo { nodeId: string; hostname: string; role: 'master' | 'sub'; centralUrl: string; }

export interface CardRow {
  id: string; masked: string; last4: string; exp: string;
  status: 'active' | 'exhausted' | 'declined' | 'disabled';
  maxUses: number; usedCount: number; remaining: number;
  successCount: number; declineCount: number;
  firstUsedAt?: string; lastUsedAt?: string; lastResult?: string; lastError?: string;
  cooldownUntil?: string; disabledReason?: string; inUse?: boolean;
}
export interface CardsResp { cards: CardRow[]; available: number; }

export interface LedgerEntry { at: string; email: string; result: string; charged: number; cardLast4?: string; jobId?: string; error?: string; }
export interface LedgerSummary {
  total: number; success: number; declined: number; totalCharged: number;
  byResult?: Record<string, number>; byCard?: Record<string, { count: number; charged: number }>;
  entries: LedgerEntry[];
}

export interface AccountRow {
  email: string; createdAt?: string; updatedAt?: string;
  registered?: boolean; apiKey?: string; apiKeyName?: string;
  passwordChanged?: boolean; billingStatus?: string; charged?: number;
  cardLast4?: string; exitIp?: string; blacklisted?: boolean; blacklistReason?: string;
  originalPassword?: string; password?: string; nodeId?: string; topUpAmount?: number;
}
export interface AccountsResp { count: number; accounts: AccountRow[]; }

export interface ErrorEntry { at: string; email?: string; stage?: string; reason: string; action?: string; attempt?: number; jobId?: string; }
export interface ErrorSummary { total: number; byReason: Record<string, number>; byAction: Record<string, number>; entries: ErrorEntry[]; }

export type PolicyAction = 'retry' | 'retry-new-proxy' | 'relogin' | 'blacklist' | 'abort';
export interface PolicyRow {
  code: string; stage?: string; why?: string; settable?: boolean;
  builtin?: { action: PolicyAction; maxRetries: number };
  override?: { action: PolicyAction; maxRetries: number } | null;
  effective?: { action: PolicyAction; maxRetries: number };
}
export interface PolicyResp { actions: PolicyAction[]; policy: PolicyRow[]; }

export interface ClusterPeer { nodeId: string; url: string; ageSec: number; }
export interface ClusterResp { nodeId: string; hosts: string[]; peers: ClusterPeer[]; }

export interface AggregateSource { source: string; count: number; ok: boolean; error?: string; }
export interface AggregateResp { total: number; count: number; sources: AggregateSource[]; accounts: AccountRow[]; }

export interface StartJobResp { jobId: string; accepted: number; }

// SSE 事件 payload(对照 job-runner publish)。
export interface WorkerUpdate { workerId: number; status?: string; stage?: string; account?: string; }
export interface RuntimeStats {
  browsersActive?: number; browsersMax?: number; browsersQueued?: number;
  jobRunning?: number; jobQueued?: number; jobDone?: number; jobTotal?: number;
  envTotal?: number; envInUse?: number; envBurned?: number;
}
export interface AccountSuccessEvt { rendered?: string; raw?: AccountRow; attempts?: number; }
export interface AccountFailedEvt {
  email?: string; password?: string; originalPassword?: string;
  reason?: string; stage?: string; failClass?: string; attempts?: number; detail?: string; rendered?: string;
}
export interface JobDoneEvt { jobId: string; total: number; success: number; failed: number; durationMs: number; failureStats?: { total: number; byClass: Record<string, number>; byReason: Record<string, number> }; }
