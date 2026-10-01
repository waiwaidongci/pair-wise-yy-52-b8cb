export type PermitStatus = '待复核' | '待执行' | '执行中' | '待结束' | '待关闭' | '已完成'

export interface IsolationPoint {
  id: string
  device: string
  label: string
  type: '开关' | '刀闸' | '阀门' | '接地'
  state: '已隔离' | '待操作' | '已恢复'
  /** 隔离点状态版本，每次状态变更递增；许可据此判断自己看到的隔离边界是否已过期 */
  revision: number
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
  /** 许可聚合版本：锁定、步骤、状态或共享隔离点任一变化都会递增，提交时必须回传 */
  revision: number
  reviewRequired: boolean
  /** 失效原因（共享隔离点状态变化时由服务端写入） */
  invalidReason?: string
}

export interface AuditEvent {
  id: string
  time: string
  actor: string
  action: string
  target: string
  detail: string
}

/** 作业许可支持的写操作类型 */
export type OperationType =
  | 'toggle-step'
  | 'advance'
  | 'create-permit'
  | 'set-point-state'
  | 'reconfirm'

/** 客户端提交的一次操作：opId 幂等键 + baseRevision 为客户端看到的许可版本 */
export interface OperationRequest {
  opId: string
  permitId: string
  type: OperationType
  baseRevision: number
  actor?: string
  stepId?: string
  pointId?: string
  pointState?: IsolationPoint['state']
  permit?: Permit
}

export type RejectCode =
  | 'stale-revision'
  | 'review-required'
  | 'not-found'
  | 'invalid-transition'
  | 'bad-payload'

export interface OperationResult {
  opId: string
  permitId: string
  type: OperationType
  accepted: boolean
  code?: RejectCode
  message: string
  baseRevision?: number
  currentRevision?: number
  /** 操作完成后的许可快照 */
  permit?: Permit
}

export interface SiteState {
  permits: Permit[]
  audit: AuditEvent[]
  stateVersion: number
  serverTime: string
}

export interface OperationsBatchResponse extends SiteState {
  results: OperationResult[]
}
