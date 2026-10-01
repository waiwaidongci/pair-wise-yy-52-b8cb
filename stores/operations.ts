import { defineStore } from 'pinia'
import type { AuditEvent, Operation, OpResult, Permit } from '~/types'
import { useOperationsApi } from '~/composables/useOperationsApi'

/**
 * 客户端只保存「待确认的操作队列」；许可、审计、版本以服务端为唯一事实源。
 * 每次提交带 opId（操作号 = 幂等键）+ seenRevision（看到的状态版本）。
 */
const QUEUE_KEY = 'yy52-permit-queue-v2'

interface PendingOp {
  opId: string
  ops: Operation[]
  status: 'pending' | 'confirmed' | 'conflict'
  createdAt: number
  results?: OpResult[]
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export const useOperationsStore = defineStore('operations', () => {
  const api = useOperationsApi()

  // ── 服务端唯一事实源 ──
  const permits = ref<Permit[]>([])
  const audit = ref<AuditEvent[]>([])
  const revision = ref(0)
  const serverTime = ref('')

  // ── 客户端待确认队列 ──
  const pendingOps = ref<PendingOp[]>([])
  const connection = ref<'在线' | '重连中'>('在线')
  const latestAlert = ref('')
  const loaded = ref(false)
  const submitting = ref(false)

  const pendingRetry = computed(() => pendingOps.value.filter((o) => o.status !== 'confirmed').length)

  function applyState(state: { permits: Permit[]; audit: AuditEvent[]; revision: number; serverTime?: string }) {
    permits.value = structuredClone(state.permits)
    audit.value = structuredClone(state.audit)
    revision.value = state.revision
    if (state.serverTime) serverTime.value = state.serverTime
  }

  function persistQueue() {
    if (import.meta.client) {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(pendingOps.value.filter((o) => o.status === 'pending')))
    }
  }

  function restoreQueue() {
    if (!import.meta.client) return
    const raw = localStorage.getItem(QUEUE_KEY)
    if (raw) {
      try {
        const items = JSON.parse(raw) as PendingOp[]
        pendingOps.value = items.map((o) => ({ ...o, status: 'pending' as const }))
      } catch { /* 忽略损坏的本地队列 */ }
    }
  }

  /** 从服务端拉取最新状态；检测新失效的许可并提示值班负责人 */
  async function fetchState() {
    const state = await api.fetchState()
    if (loaded.value) {
      const newlyInvalidated = state.permits.filter((np) => {
        const prev = permits.value.find((p) => p.id === np.id)
        return np.reviewRequired && (!prev || !prev.reviewRequired)
      })
      if (newlyInvalidated.length) {
        latestAlert.value = `隔离点状态已变更，${newlyInvalidated.map((p) => p.id).join('、')} 个共享许可已失效，请值班负责人重新确认。`
      }
    }
    applyState(state)
    loaded.value = true
  }

  /** 提交一批操作（带 opId 幂等键 + seenRevision 版本），并入队等待确认 */
  async function submit(ops: Operation[]) {
    const entry: PendingOp = { opId: uuid(), ops, status: 'pending', createdAt: Date.now() }
    pendingOps.value.push(entry)
    persistQueue()
    await flush()
  }

  /** 顺序处理队列中的待确认操作；网络失败保留队列，稍后重试（同一 opId 不重复写入） */
  async function flush() {
    if (submitting.value) return
    submitting.value = true
    try {
      while (true) {
        const entry = pendingOps.value.find((o) => o.status === 'pending')
        if (!entry) break
        try {
          const res = await api.submit(entry.opId, revision.value, entry.ops)
          // 以服务端状态为准：applied 生效 / conflict 回滚
          applyState(res.state)
          entry.results = res.results
          const conflicts = res.results.filter((r) => r.status === 'conflict')
          if (conflicts.length) {
            entry.status = 'conflict'
            const names = [...new Set(conflicts.map((r) => r.permitId).filter(Boolean))].join('、')
            latestAlert.value = `值班负责人请注意：许可 ${names} 版本已过期，其他班组已修改，请重新确认后继续。`
          } else {
            entry.status = 'confirmed'
          }
        } catch {
          // 网络失败：保留为 pending，等 reconnect 后用同一 opId 重试
          connection.value = '重连中'
          persistQueue()
          break
        }
      }
      pendingOps.value = pendingOps.value.filter((o) => o.status !== 'confirmed')
      persistQueue()
    } finally {
      submitting.value = false
    }
  }

  /** 网络恢复后重试所有待确认操作（从最后确认项恢复） */
  async function retryPending() {
    connection.value = '在线'
    await flush()
    if (!pendingOps.value.some((o) => o.status === 'pending')) {
      // 全部已确认
    }
  }

  /** 冲突后 rebase：拉取最新状态，用新版本号重新提交，页面可继续处理 */
  async function rebaseAndRetry(permitId: string) {
    const state = await api.fetchState()
    applyState(state)
    const entry = pendingOps.value.find(
      (o) => o.status === 'conflict' && o.ops.some((op) => 'permitId' in op && op.permitId === permitId),
    )
    if (!entry) return
    // 内容随版本变化 → 新操作号；更新该批次所有许可的 seenPermitRevision
    const newOps = entry.ops.map((op) => {
      if ('permitId' in op && op.permitId) {
        const permit = permits.value.find((p) => p.id === op.permitId)
        if (permit) return { ...op, seenPermitRevision: permit.revision }
      }
      return op
    })
    const newEntry: PendingOp = { opId: uuid(), ops: newOps, status: 'pending', createdAt: Date.now() }
    pendingOps.value = pendingOps.value.filter((o) => o !== entry)
    pendingOps.value.push(newEntry)
    persistQueue()
    await flush()
    // 冲突已全部解决则清除冲突提示
    if (!pendingOps.value.some((o) => o.status === 'conflict')) latestAlert.value = ''
  }

  // ── 页面调用的操作（与旧接口保持一致，底层走服务端） ──

  function advancePermit(id: string) {
    const permit = permits.value.find((p) => p.id === id)
    if (!permit) return
    const flow: Record<string, Permit['status']> = { 待复核: '待执行', 待执行: '执行中', 执行中: '待结束', 待结束: '待关闭', 待关闭: '已完成' }
    const next = flow[permit.status]
    if (!next) return
    if (permit.status === '待复核' && permit.reviewRequired && !confirm('该许可存在待复核冲突，确认由值班负责人承担审批责任？')) return
    const seen = permit.revision
    permit.status = next // 乐观更新，服务端确认后以服务端为准
    permit.reviewRequired = false
    submit([{ kind: 'advance', permitId: id, seenPermitRevision: seen }])
  }

  function toggleStep(permitId: string, stepId: string) {
    const permit = permits.value.find((p) => p.id === permitId)
    const step = permit?.steps.find((s) => s.id === stepId)
    if (!permit || !step) return
    const seen = permit.revision
    const newDone = !step.done
    step.done = newDone // 乐观更新
    submit([{ kind: 'toggle-step', permitId, stepId, done: newDone, seenPermitRevision: seen }])
  }

  function addPermit(permit: Permit) {
    submit([{ kind: 'add-permit', permit }])
  }

  function acceptAlert() {
    latestAlert.value = ''
    submit([{ kind: 'accept-alert', actor: '值班负责人' }])
  }

  function markOffline() { connection.value = '重连中' }
  function markOnline() { connection.value = '在线' }

  /** 模拟其他班组提交（演示版本冲突） */
  async function simulateExternalChange() {
    await api.simulateExternalAdvance('WP-260930-004')
    await fetchState()
    latestAlert.value = '检测到其他班组已提交变更，本地版本可能已过期；提交时将自动驳回受影响的许可。'
  }

  restoreQueue()
  return {
    permits, audit, revision, serverTime, connection, pendingOps, latestAlert, loaded, submitting, pendingRetry,
    fetchState, submit, flush, retryPending, rebaseAndRetry,
    advancePermit, toggleStep, addPermit, acceptAlert, markOffline, markOnline, simulateExternalChange,
  }
})
