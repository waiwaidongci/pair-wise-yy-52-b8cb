import type { AuditEvent, IsolationPoint, OpResult, Operation, OperationResponse, Permit, ServerState } from '~/types'
import { auditEvents as seedAudit, permits as seedPermits } from '~/utils/mock'

/**
 * 服务端唯一事实源（single source of truth）。
 * 所有许可、审计、隔离点状态以服务端为准；浏览器只保存待确认的操作队列。
 */

interface ProcessedOp {
  results: OpResult[]
  revision: number
  processedAt: string
}

interface AuthoritativeState {
  permits: Permit[]
  audit: AuditEvent[]
  revision: number
  /** opId → 已处理结果，用于幂等去重（重试同一操作号不重复写入） */
  processed: Map<string, ProcessedOp>
}

const state: AuthoritativeState = {
  permits: structuredClone(seedPermits),
  audit: structuredClone(seedAudit),
  revision: 12,
  processed: new Map(),
}

function nextRevision(): number {
  state.revision += 1
  return state.revision
}

function now(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function addAudit(actor: string, action: string, target: string, detail: string): void {
  const id = `AE-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`
  state.audit.unshift({ id, time: now(), actor, action, target, detail })
}

function publicState(): ServerState {
  return {
    permits: structuredClone(state.permits),
    audit: structuredClone(state.audit),
    revision: state.revision,
    serverTime: new Date().toISOString(),
  }
}

/** 找出共享同一隔离点（同 pointId）的所有许可 */
function findPermitsSharingPoint(pointId: string): Permit[] {
  return state.permits.filter((p) => p.isolationPoints.some((ip) => ip.id === pointId))
}

const FLOW: Record<string, Permit['status']> = {
  待复核: '待执行',
  待执行: '执行中',
  执行中: '待结束',
  待结束: '待关闭',
  待关闭: '已完成',
}

/** 应用单条操作，返回该操作的结果（applied / conflict / rejected） */
function applyOperation(op: Operation, opId: string, snapshot: Map<string, number>): OpResult {
  switch (op.kind) {
    case 'advance': {
      const permit = state.permits.find((p) => p.id === op.permitId)
      if (!permit) {
        return { opId, ref: `${op.permitId}:advance`, status: 'rejected', permitId: op.permitId, reason: '许可不存在' }
      }
      if (snapshot.get(op.permitId) !== op.seenPermitRevision) {
        return {
          opId, ref: `${op.permitId}:advance`, status: 'conflict', permitId: op.permitId,
          reason: '版本过期：其他班组已修改该许可，请重新确认后再推进',
          currentPermitRevision: permit.revision, currentPermit: structuredClone(permit),
        }
      }
      const next = FLOW[permit.status]
      if (!next) {
        return { opId, ref: `${op.permitId}:advance`, status: 'rejected', permitId: op.permitId, reason: '许可已至终态，无法继续推进' }
      }
      const prev = permit.status
      permit.status = next
      permit.reviewRequired = false
      permit.revision += 1
      nextRevision()
      addAudit('当前用户', '流程推进', permit.id, `状态由"${prev}"变更为"${next}"`)
      return { opId, ref: `${op.permitId}:advance`, status: 'applied', permitId: op.permitId, currentPermitRevision: permit.revision }
    }

    case 'toggle-step': {
      const permit = state.permits.find((p) => p.id === op.permitId)
      if (!permit) {
        return { opId, ref: `${op.permitId}:${op.stepId}`, status: 'rejected', permitId: op.permitId, reason: '许可不存在' }
      }
      if (snapshot.get(op.permitId) !== op.seenPermitRevision) {
        return {
          opId, ref: `${op.permitId}:${op.stepId}`, status: 'conflict', permitId: op.permitId,
          reason: '版本过期：其他班组已修改该许可，步骤状态可能已变化，请重新确认',
          currentPermitRevision: permit.revision, currentPermit: structuredClone(permit),
        }
      }
      const step = permit.steps.find((s) => s.id === op.stepId)
      if (!step) {
        return { opId, ref: `${op.permitId}:${op.stepId}`, status: 'rejected', permitId: op.permitId, reason: '步骤不存在' }
      }
      step.done = op.done
      permit.revision += 1
      nextRevision()
      addAudit('当前用户', op.done ? '完成步骤' : '撤销步骤', `${permit.id} / ${step.id}`, step.text)

      // 演示：018 完成验电接地后，共享母线隔离点状态变化，触发共享许可失效待复核
      if (permit.id === 'WP-260929-018' && step.id === 'ST-03' && op.done) {
        const affected = changePointState('IP-413', '已隔离', '系统')
        return {
          opId, ref: `${op.permitId}:${op.stepId}`, status: 'applied', permitId: op.permitId,
          currentPermitRevision: permit.revision, affectedPermitIds: affected,
        }
      }
      return { opId, ref: `${op.permitId}:${op.stepId}`, status: 'applied', permitId: op.permitId, currentPermitRevision: permit.revision }
    }

    case 'add-permit': {
      if (state.permits.some((p) => p.id === op.permit.id)) {
        return { opId, ref: `${op.permit.id}:add`, status: 'rejected', permitId: op.permit.id, reason: '许可编号已存在' }
      }
      const permit: Permit = structuredClone(op.permit)
      permit.revision = 1
      state.permits.unshift(permit)
      nextRevision()
      addAudit(op.permit.owner || '当前用户', '新建许可', permit.id, permit.title)
      return { opId, ref: `${permit.id}:add`, status: 'applied', permitId: permit.id, currentPermitRevision: permit.revision }
    }

    case 'accept-alert': {
      let cleared = 0
      for (const permit of state.permits) {
        if (permit.reviewRequired) {
          permit.reviewRequired = false
          permit.revision += 1
          cleared += 1
        }
      }
      if (cleared) nextRevision()
      addAudit(op.actor || '值班负责人', '确认冲突', op.alertId || '跨班组重叠', `值班负责人已重新确认 ${cleared} 个许可，同意调整作业安排`)
      return { opId, ref: `${op.alertId || 'alert'}:accept`, status: 'applied', affectedPermitIds: state.permits.filter((p) => !p.reviewRequired).map((p) => p.id) }
    }

    case 'set-point-state': {
      const affected = changePointState(op.pointId, op.state, op.actor || '系统')
      return { opId, ref: `${op.pointId}:point-state`, status: 'applied', affectedPermitIds: affected }
    }
  }
}

/**
 * 改变隔离点状态，并让共享该点的所有许可立即失效等待复核。
 * 状态未变且已标记复核时不重复推版本；返回受影响的许可 id 列表。
 */
function changePointState(pointId: string, newState: IsolationPoint['state'], actor: string): string[] {
  const affected = findPermitsSharingPoint(pointId)
  let changed = false
  for (const permit of affected) {
    const point = permit.isolationPoints.find((ip) => ip.id === pointId)
    if (point && point.state !== newState) {
      point.state = newState
      changed = true
    }
    if (!permit.reviewRequired) {
      permit.reviewRequired = true
      permit.revision += 1
      changed = true
    }
  }
  if (changed) {
    nextRevision()
    addAudit(actor, '隔离点状态变更', pointId, `隔离点状态变更为"${newState}"，${affected.length} 个共享许可已失效、等待值班负责人复核`)
  }
  return affected.map((p) => p.id)
}

/** 处理一批提交：幂等去重 + 逐条乐观锁 */
export function processOperations(envelope: { opId: string; ops: Operation[] }): OperationResponse {
  const { opId, ops } = envelope

  // 幂等：同一操作号已处理过，直接返回缓存结果（重试不重复写入）
  const cached = state.processed.get(opId)
  if (cached) {
    return {
      opId,
      results: cached.results.map((r) => ({ ...r, status: r.status === 'applied' ? 'duplicate' : r.status })),
      state: publicState(),
      revision: state.revision,
      appliedCount: 0,
      conflictCount: cached.results.filter((r) => r.status === 'conflict').length,
      rejectedCount: cached.results.filter((r) => r.status === 'rejected').length,
      duplicateCount: cached.results.filter((r) => r.status === 'applied').length,
    }
  }

  // 快照：本批开始前各许可的版本，批内多条操作共享同一基准版本
  const snapshot = new Map<string, number>()
  for (const p of state.permits) snapshot.set(p.id, p.revision)

  const results: OpResult[] = []
  for (const op of ops) results.push(applyOperation(op, opId, snapshot))

  state.processed.set(opId, { results, revision: state.revision, processedAt: new Date().toISOString() })

  return {
    opId,
    results,
    state: publicState(),
    revision: state.revision,
    appliedCount: results.filter((r) => r.status === 'applied').length,
    conflictCount: results.filter((r) => r.status === 'conflict').length,
    rejectedCount: results.filter((r) => r.status === 'rejected').length,
    duplicateCount: 0,
  }
}

export function getServerState(): ServerState {
  return publicState()
}

/** 服务端模拟"现场/其他班组"产生的隔离点状态变化 */
export function simulatePointState(pointId: string, newState: IsolationPoint['state'], actor: string): { affectedPermitIds: string[]; state: ServerState; revision: number } {
  const affected = changePointState(pointId, newState, actor)
  return { affectedPermitIds: affected, state: publicState(), revision: state.revision }
}

/** 服务端模拟"其他班组"推进了某许可（用于演示冲突） */
export function simulateExternalAdvance(permitId: string): ServerState {
  const permit = state.permits.find((p) => p.id === permitId)
  if (permit && FLOW[permit.status]) {
    const prev = permit.status
    permit.status = FLOW[permit.status]
    permit.revision += 1
    nextRevision()
    addAudit('其他班组', '流程推进', permit.id, `（模拟）其他班组将状态由"${prev}"变更为"${permit.status}"`)
  }
  return publicState()
}

/** 重置为种子数据（演示用） */
export function resetState(): ServerState {
  state.permits = structuredClone(seedPermits)
  state.audit = structuredClone(seedAudit)
  state.revision = 12
  state.processed.clear()
  return publicState()
}
