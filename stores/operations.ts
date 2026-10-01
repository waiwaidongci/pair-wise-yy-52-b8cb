import { defineStore } from 'pinia'
import type { AuditEvent, OperationRequest, OperationResult, OperationsBatchResponse, Permit, SiteState } from '~/types'
import { auditEvents as seedAudit, permits as seedPermits } from '~/utils/mock'

/** 旧版本把许可存在浏览器里，各浏览器各一份 —— 已废弃，启动时清理 */
const LEGACY_STORAGE_KEY = 'yy52-permit-ops-v1'
/** 只持久化“尚未得到服务端确认”的操作和待处理冲突提示；事实本身只来自服务端 */
const OUTBOX_KEY = 'yy52-permit-outbox-v2'

export interface OutboxEntry extends OperationRequest {
  queuedAt: number
  attempts: number
}

export interface ConflictNote {
  opId: string
  permitId: string
  type: OperationRequest['type']
  code: 'stale-revision' | 'review-required' | 'not-found' | 'invalid-transition' | 'bad-payload'
  message: string
  currentRevision?: number
  at: string
  dismissed: boolean
}

const REJECT_FINAL: ReadonlySet<OperationResult['code']> = new Set(['stale-revision', 'review-required', 'not-found', 'invalid-transition', 'bad-payload'])

let refreshTimer: ReturnType<typeof setInterval> | undefined

export function newOpId() {
  if (import.meta.client && window.crypto?.randomUUID) return `OP-${window.crypto.randomUUID()}`
  return `OP-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function nowLabel() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

interface PersistedQueue {
  outbox: OutboxEntry[]
  conflicts: ConflictNote[]
}

export const useOperationsStore = defineStore('operations', () => {
  // 服务端事实（SSR / 首屏先用种子数据渲染，客户端挂载后立即拉取服务端唯一事实）
  const permits = ref<Permit[]>(structuredClone(seedPermits))
  const audit = ref<AuditEvent[]>(structuredClone(seedAudit))
  const stateVersion = ref(0)
  const loaded = ref(false)

  const connection = ref<'在线' | '重连中' | '提交中'>('在线')
  const lastError = ref('')
  const outbox = ref<OutboxEntry[]>([])
  const conflicts = ref<ConflictNote[]>([])
  const inflight = ref(false)
  /** 最近一次批量提交的逐条结果，供页面展示成功/驳回明细 */
  const lastResults = ref<OperationResult[]>([])

  const pendingRetry = computed(() => outbox.value.length)
  const pendingPermitIds = computed(() => new Set(outbox.value.map((op) => op.permitId)))
  const activeConflicts = computed(() => conflicts.value.filter((note) => !note.dismissed))
  const latestAlert = computed(() => activeConflicts.value[0])
  /** 断线期间排队的“新建许可”，在服务端确认前以待同步占位形式显示 */
  const queuedCreates = computed<(Permit & { pending: boolean })[]>(() => {
    if (!loaded.value) return []
    return outbox.value
      .filter((op) => op.type === 'create-permit' && op.permit)
      .map((op) => ({ ...op.permit!, pending: true }))
  })
  const displayPermits = computed<(Permit & { pending?: boolean })[]>(() => [...queuedCreates.value, ...permits.value])

  function persistQueue() {
    if (!import.meta.client) return
    const payload: PersistedQueue = { outbox: outbox.value, conflicts: conflicts.value }
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(payload))
  }
  function restoreQueue() {
    if (!import.meta.client || loaded.value) return
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY)
      const raw = localStorage.getItem(OUTBOX_KEY)
      if (raw) {
        const draft = JSON.parse(raw) as PersistedQueue
        outbox.value = Array.isArray(draft.outbox) ? draft.outbox : []
        conflicts.value = Array.isArray(draft.conflicts) ? draft.conflicts : []
      }
    } catch {
      outbox.value = []
    }
    loaded.value = true
  }

  function reconcile(state: SiteState) {
    permits.value = state.permits
    audit.value = state.audit
    stateVersion.value = state.stateVersion
    loaded.value = true
  }

  async function refresh() {
    if (!import.meta.client) return
    try {
      const state = await $fetch<SiteState>('/api/state')
      reconcile(state)
      if (outbox.value.length === 0) connection.value = '在线'
      lastError.value = ''
    } catch {
      if (outbox.value.length > 0) connection.value = '重连中'
    }
  }

  function noteConflict(result: OperationResult) {
    conflicts.value = conflicts.value.filter((note) => note.opId !== result.opId)
    conflicts.value.unshift({
      opId: result.opId,
      permitId: result.permitId,
      type: result.type,
      code: result.code as ConflictNote['code'],
      message: result.message,
      currentRevision: result.currentRevision,
      at: nowLabel(),
      dismissed: false,
    })
  }

  function dismissConflict(opId: string) {
    const note = conflicts.value.find((item) => item.opId === opId)
    if (note) note.dismissed = true
    persistQueue()
  }

  /**
   * 把 outbox 中“最后确认项之后”的全部操作批量提交：
   * - 网络失败：outbox 原样保留，恢复在线后从第一项（即最后确认项的下一项）重发；
   * - 已成功 / 已被服务端裁决（版本过期等）的 opId 都会从 outbox 摘除；
   * - 同一 opId 重发由服务端幂等处理，绝不重复写入。
   */
  async function flush() {
    if (!import.meta.client || inflight.value || outbox.value.length === 0) return
    inflight.value = true
    connection.value = '提交中'
    const batch = outbox.value.map((entry) => {
      entry.attempts += 1
      const { queuedAt: _queuedAt, attempts: _attempts, ...op } = entry
      return op
    })
    try {
      const response = await $fetch<OperationsBatchResponse>('/api/operations', { method: 'POST', body: { operations: batch } })
      const decided = new Set<string>()
      for (const result of response.results) {
        decided.add(result.opId)
        if (result.accepted) continue
        if (REJECT_FINAL.has(result.code)) noteConflict(result)
      }
      // 只有服务端给出裁决（成功或明确驳回）的操作才摘除；未出现在响应里的保留待恢复
      outbox.value = outbox.value.filter((entry) => !decided.has(entry.opId))
      lastResults.value = response.results
      reconcile(response)
      connection.value = outbox.value.length > 0 ? '重连中' : '在线'
      lastError.value = ''
      persistQueue()
    } catch (error) {
      connection.value = '重连中'
      lastError.value = '网络失败，操作已保留在本地待提交队列，将从最后确认项之后恢复，不会重复写入'
      persistQueue()
    } finally {
      inflight.value = false
    }
  }

  /** 入队一条携带“看到的版本 + 唯一操作号”的操作并立即尝试提交 */
  async function enqueue(partial: Omit<OperationRequest, 'opId' | 'actor'> & { actor?: string }) {
    const entry: OutboxEntry = { ...partial, opId: newOpId(), actor: partial.actor ?? '当前用户', queuedAt: Date.now(), attempts: 0 }
    outbox.value.push(entry)
    persistQueue()
    await flush()
    return entry.opId
  }

  function revisionOf(permitId: string) {
    return permits.value.find((item) => item.id === permitId)?.revision ?? 0
  }

  function toggleStep(permitId: string, stepId: string) {
    return enqueue({ permitId, type: 'toggle-step', stepId, baseRevision: revisionOf(permitId) })
  }
  function advancePermit(permitId: string) {
    return enqueue({ permitId, type: 'advance', baseRevision: revisionOf(permitId) })
  }
  function setPointState(permitId: string, pointId: string, pointState: Permit['isolationPoints'][number]['state']) {
    return enqueue({ permitId, type: 'set-point-state', pointId, pointState, baseRevision: revisionOf(permitId) })
  }
  /** 值班负责人在冲突提示上重新确认（携带当前最新版本） */
  function reconfirm(permitId: string) {
    return enqueue({ permitId, type: 'reconfirm', baseRevision: revisionOf(permitId), actor: '值班负责人' })
  }
  function addPermit(permit: Permit) {
    return enqueue({ permitId: permit.id, type: 'create-permit', baseRevision: 0, permit: structuredClone(permit) })
  }

  /** 网络恢复 / 手动重试：先拉取最新事实（暴露过期版本），再重发未确认队列 */
  async function retryPending() {
    await refresh()
    await flush()
  }

  function markOffline() {
    connection.value = '重连中'
  }
  function markOnline() {
    if (outbox.value.length === 0) connection.value = '在线'
    return retryPending()
  }
  /** 兼容旧版总览页的“协调并确认”入口：定位到最新冲突许可由值班负责人处理 */
  function acceptAlert() {
    const note = latestAlert.value
    if (note) dismissConflict(note.opId)
  }

  restoreQueue()
  if (import.meta.client) {
    // 启动即从服务端恢复，并尝试补提交断线期间排队的操作
    void refresh().then(() => flush())
    // 轮询服务端事实：其他班组一改隔离点/步骤，本端立即看到失效标记
    if (!refreshTimer) {
      refreshTimer = setInterval(() => void refresh(), 8000)
      window.addEventListener('online', () => void retryPending())
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refresh() })
    }
  }

  return {
    permits,
    displayPermits,
    audit,
    stateVersion,
    loaded,
    connection,
    lastError,
    outbox,
    conflicts,
    activeConflicts,
    latestAlert,
    lastResults,
    inflight,
    pendingRetry,
    pendingPermitIds,
    refresh,
    flush,
    enqueue,
    toggleStep,
    advancePermit,
    setPointState,
    reconfirm,
    addPermit,
    retryPending,
    markOffline,
    markOnline,
    dismissConflict,
    acceptAlert,
    revisionOf,
    restoreQueue,
  }
})
