export type PermitStatus = '待复核' | '待执行' | '执行中' | '待结束' | '待关闭' | '已完成'

export interface IsolationPoint {
  id: string
  device: string
  label: string
  type: '开关' | '刀闸' | '阀门' | '接地'
  state: '已隔离' | '待操作' | '已恢复'
}

export interface Permit {
  id: string
  title: string
  device: string
  crew: string
  owner: string
  window: string
  status: PermitStatus
  risk: '一级' | '二级' | '三级'
  isolationPoints: IsolationPoint[]
  steps: { id: string; text: string; done: boolean; owner: string; evidence?: string }[]
  revision: number
  reviewRequired: boolean
}

export interface AuditEvent {
  id: string
  time: string
  actor: string
  action: string
  target: string
  detail: string
}

// ── 并发控制：操作号 + 状态版本 ──────────────────────────────

export type OpKind = 'advance' | 'toggle-step' | 'add-permit' | 'accept-alert' | 'set-point-state'

/** 单次提交（操作号 = 幂等键，seenRevision = 看到的全局状态版本） */
export interface OperationEnvelope {
  opId: string
  seenRevision: number
  ops: Operation[]
}

export type Operation =
  | { kind: 'advance'; permitId: string; seenPermitRevision: number }
  | { kind: 'toggle-step'; permitId: string; stepId: string; done: boolean; seenPermitRevision: number }
  | { kind: 'add-permit'; permit: Permit }
  | { kind: 'accept-alert'; alertId?: string; actor?: string }
  | { kind: 'set-point-state'; pointId: string; state: IsolationPoint['state']; actor?: string }

export type OpResultStatus = 'applied' | 'conflict' | 'duplicate' | 'rejected'

export interface OpResult {
  opId: string
  ref: string
  status: OpResultStatus
  permitId?: string
  reason?: string
  currentPermitRevision?: number
  /** 冲突时带回许可最新版本，供页面 rebase 后继续 */
  currentPermit?: Permit
  /** set-point-state 影响到的许可 */
  affectedPermitIds?: string[]
}

export interface OperationResponse {
  opId: string
  results: OpResult[]
  state: ServerState
  revision: number
  appliedCount: number
  conflictCount: number
  rejectedCount: number
  duplicateCount: number
}

export interface ServerState {
  permits: Permit[]
  audit: AuditEvent[]
  revision: number
  serverTime: string
}

export interface PointStateResponse {
  ok: boolean
  affectedPermitIds: string[]
  state: ServerState
  revision: number
}
