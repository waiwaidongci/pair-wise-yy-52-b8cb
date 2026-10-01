import type { AuditEvent, OperationRequest, OperationResult, Permit } from '~~/types'
import { auditEvents as seedAudit, permits as seedPermits } from '~~/utils/mock'

/**
 * 服务端唯一事实源：
 * - 许可（锁定、步骤、状态）和审计只在服务端内存中保存；
 * - permits.audit 为追加式日志，任何操作都不覆盖既有记录；
 * - processed 记录已落地的 opId，保证同一操作号重试不会重复写入；
 * HMR 下通过 globalThis 保留状态。
 */
interface ServerStore {
  permits: Permit[]
  audit: AuditEvent[]
  /** opId -> 首次处理结果（幂等回放时原样返回） */
  processed: Map<string, OperationResult>
  stateVersion: number
  seq: number
}

declare global {
  // eslint-disable-next-line no-var
  var __windFarmStore__: ServerStore | undefined
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function createStore(): ServerStore {
  return {
    permits: clone(seedPermits),
    audit: clone(seedAudit),
    processed: new Map(),
    stateVersion: 1,
    seq: 1000,
  }
}

export function useServerStore(): ServerStore {
  if (!globalThis.__windFarmStore__) globalThis.__windFarmStore__ = createStore()
  return globalThis.__windFarmStore__
}

function nowTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function nextAuditId(store: ServerStore) {
  store.seq += 1
  return `AE-${store.seq}`
}

function appendAudit(store: ServerStore, event: Omit<AuditEvent, 'id' | 'time'>) {
  store.audit.unshift({ id: nextAuditId(store), time: nowTime(), ...event })
}

/** 许可的任何实质变化都必须经过这里：聚合版本递增、全局状态版本递增 */
function bumpPermit(store: ServerStore, permit: Permit) {
  permit.revision += 1
  store.stateVersion += 1
}

function reject(op: OperationRequest, code: NonNullable<OperationResult['code']>, message: string, permit?: Permit): OperationResult {
  return {
    opId: op.opId,
    permitId: op.permitId,
    type: op.type,
    accepted: false,
    code,
    message,
    baseRevision: op.baseRevision,
    currentRevision: permit?.revision,
    permit: permit ? clone(permit) : undefined,
  }
}

function accept(store: ServerStore, op: OperationRequest, permit: Permit | undefined, message: string): OperationResult {
  return {
    opId: op.opId,
    permitId: op.permitId,
    type: op.type,
    accepted: true,
    message,
    baseRevision: op.baseRevision,
    currentRevision: permit?.revision,
    permit: permit ? clone(permit) : undefined,
  }
}

const STATUS_FLOW: Record<Permit['status'], Permit['status'] | undefined> = {
  待复核: '待执行',
  待执行: '执行中',
  执行中: '待结束',
  待结束: '待关闭',
  待关闭: '已完成',
  已完成: undefined,
}

/**
 * 隔离点状态变更后的级联失效：
 * 共享该隔离点的其他许可立即标记为“待复核”并记录原因，等待值班负责人重新确认。
 * 返回被连带失效的许可数（不含操作者自身）。
 */
function cascadeInvalidate(store: ServerStore, pointId: string, pointState: Permit['isolationPoints'][number]['state'], actorPermitId: string, actorName: string): number {
  let affected = 0
  for (const holder of store.permits) {
    if (holder.id === actorPermitId) continue
    const shared = holder.isolationPoints.some((point) => point.id === pointId)
    if (!shared) continue
    const reason = `共享隔离点 ${pointId} 状态变为“${pointState}”（${actorName} 在 ${actorPermitId} 中操作），隔离边界已变化，等待值班负责人重新确认`
    // 同步该许可内的嵌入视图并递增隔离点版本
    for (const point of holder.isolationPoints) {
      if (point.id === pointId) {
        point.state = pointState
        point.revision += 1
      }
    }
    holder.reviewRequired = true
    holder.invalidReason = reason
    bumpPermit(store, holder)
    affected += 1
    appendAudit(store, { actor: '系统', action: '隔离点联动失效', target: `${holder.id} / ${pointId}`, detail: reason })
  }
  return affected
}

/** 在操作提交时的许可快照基础上应用一条操作；不做版本判断（版本判断在批处理中完成） */
function applyOperation(store: ServerStore, op: OperationRequest, permit: Permit | undefined): OperationResult {
  const actor = op.actor || '当前用户'

  if (op.type === 'create-permit') {
    if (!op.permit) return reject(op, 'bad-payload', '缺少许可内容')
    const created: Permit = clone(op.permit)
    created.revision = 1
    created.reviewRequired = false
    created.invalidReason = undefined
    store.permits.unshift(created)
    store.stateVersion += 1
    appendAudit(store, { actor, action: '新建许可', target: created.id, detail: created.title })
    return accept(store, op, created, '许可已创建并进入安全复核')
  }

  if (!permit) return reject(op, 'not-found', `许可 ${op.permitId} 不存在或已关闭`)

  switch (op.type) {
    case 'toggle-step': {
      const step = permit.steps.find((item) => item.id === op.stepId)
      if (!step) return reject(op, 'not-found', `步骤 ${op.stepId ?? ''} 不存在`, permit)
      step.done = !step.done
      bumpPermit(store, permit)
      appendAudit(store, { actor, action: step.done ? '完成步骤' : '撤销步骤', target: `${permit.id} / ${step.id}`, detail: step.text })
      return accept(store, op, permit, `步骤已${step.done ? '完成' : '撤销'}（r${permit.revision}）`)
    }
    case 'advance': {
      const next = STATUS_FLOW[permit.status]
      if (!next) return reject(op, 'invalid-transition', `许可已处于终态“${permit.status}”，无法继续推进`, permit)
      const from = permit.status
      permit.status = next
      bumpPermit(store, permit)
      appendAudit(store, { actor, action: '流程推进', target: permit.id, detail: `状态由“${from}”变更为“${next}”（基于 r${op.baseRevision}）` })
      return accept(store, op, permit, `已推进至“${next}”（r${permit.revision}）`)
    }
    case 'set-point-state': {
      const point = permit.isolationPoints.find((item) => item.id === op.pointId)
      if (!point) return reject(op, 'not-found', `隔离点 ${op.pointId ?? ''} 不在该许可的隔离边界内`, permit)
      if (!op.pointState) return reject(op, 'bad-payload', '缺少隔离点目标状态', permit)
      const previous = point.state
      if (previous === op.pointState) {
        return accept(store, op, permit, `隔离点 ${point.label} 已是“${op.pointState}”，未重复写入`)
      }
      point.state = op.pointState
      point.revision += 1
      bumpPermit(store, permit)
      appendAudit(store, { actor, action: '隔离点操作', target: `${permit.id} / ${point.id}`, detail: `${point.label}：${previous} → ${op.pointState}` })
      const affected = cascadeInvalidate(store, point.id, op.pointState, permit.id, actor)
      if (affected > 0) {
        appendAudit(store, { actor: '系统', action: '联动提示', target: point.id, detail: `另有 ${affected} 张共享该隔离点的许可已失效待复核` })
      }
      return accept(store, op, permit, `隔离点已更新为“${op.pointState}”，${affected} 张共享许可已转入待复核（r${permit.revision}）`)
    }
    case 'reconfirm': {
      if (!permit.reviewRequired && !permit.invalidReason) {
        return reject(op, 'invalid-transition', '许可当前不处于待复核状态，无需重新确认', permit)
      }
      // 值班负责人重新确认：清除失效标记，版本推进到当前；仍需基于最新版本提交
      const reason = permit.invalidReason
      permit.reviewRequired = false
      permit.invalidReason = undefined
      bumpPermit(store, permit)
      appendAudit(store, {
        actor: actor === '当前用户' ? '值班负责人' : actor,
        action: '值班负责人重新确认',
        target: permit.id,
        detail: `隔离边界变化后重新确认有效${reason ? `；原因：${reason}` : ''}（基于 r${op.baseRevision}）`,
      })
      return accept(store, op, permit, `值班负责人已重新确认，许可恢复可执行（r${permit.revision}）`)
    }
  }
}

/**
 * 批量顺序处理一个客户端（班组）提交的操作：
 * - 同一批内基于“批首版本”校验，前序操作造成的版本递增不会让本批后续操作误判过期；
 * - 版本过期只驳回该许可对应的操作，同批其他操作正常落地并保留成功结果；
 * - 已处理的 opId 直接回放首次结果，绝不重复写入。
 */
export function processBatch(operations: OperationRequest[]): OperationResult[] {
  const store = useServerStore()
  const batchBase = new Map<string, number>()
  const seenInBatch = new Set<string>()
  const results: OperationResult[] = []

  for (const op of operations) {
    // 幂等：同一操作号（网络重试 / 断线重发）回放首次结果
    const replay = store.processed.get(op.opId)
    if (replay) {
      results.push(clone(replay))
      continue
    }
    if (seenInBatch.has(op.opId)) {
      results.push(reject(op, 'bad-payload', '同一批次内出现重复操作号，已忽略'))
      continue
    }
    seenInBatch.add(op.opId)

    // create-permit 不针对既有许可，直接应用
    if (op.type === 'create-permit') {
      const result = applyOperation(store, op, undefined)
      store.processed.set(op.opId, clone(result))
      results.push(result)
      continue
    }

    const permit = store.permits.find((item) => item.id === op.permitId)
    if (!permit) {
      const result = reject(op, 'not-found', `许可 ${op.permitId} 不存在`)
      store.processed.set(op.opId, clone(result))
      results.push(result)
      continue
    }

    // 记录批首版本：本批内只与“客户端提交时看到的版本”比较，
    // 前序同批操作造成的版本递增（如断线期间排队的多条操作）不视为过期
    if (!batchBase.has(permit.id)) batchBase.set(permit.id, permit.revision)
    const entryRevision = batchBase.get(permit.id)!

    // 共享隔离点变化导致的失效状态优先提示：必须先由值班负责人重新确认
    if (permit.reviewRequired && op.type !== 'reconfirm') {
      const result = reject(
        op,
        'review-required',
        `许可因${permit.invalidReason ? '隔离边界变化' : '冲突'}处于待复核状态（r${permit.revision}），请值班负责人重新确认后再继续操作`,
        permit,
      )
      store.processed.set(op.opId, clone(result))
      results.push(result)
      continue
    }

    if (op.baseRevision !== entryRevision) {
      const result = reject(
        op,
        'stale-revision',
        `版本过期：您看到的是 r${op.baseRevision}，服务端当前 r${permit.revision}（锁定、步骤或状态已被其他班组更新），本操作未写入，其余提交照常处理；请值班负责人重新确认后再提交`,
        permit,
      )
      // 驳回结果同样登记 opId：客户端重试同一操作号会拿到一致结论，不会被误应用
      store.processed.set(op.opId, clone(result))
      results.push(result)
      continue
    }

    const result = applyOperation(store, op, permit)
    store.processed.set(op.opId, clone(result))
    results.push(result)
  }

  return results
}

export function snapshotState(results: OperationResult[] = []) {
  const store = useServerStore()
  return {
    permits: clone(store.permits),
    audit: clone(store.audit),
    stateVersion: store.stateVersion,
    serverTime: new Date().toISOString(),
    results,
  }
}
