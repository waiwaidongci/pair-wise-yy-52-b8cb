import { defineStore } from 'pinia'
import type { AuditEvent, Permit } from '~/types'
import { auditEvents as seedAudit, permits as seedPermits } from '~/utils/mock'

const STORAGE_KEY = 'yy52-permit-ops-v1'

export const useOperationsStore = defineStore('operations', () => {
  const permits = ref<Permit[]>(structuredClone(seedPermits))
  const audit = ref<AuditEvent[]>(structuredClone(seedAudit))
  const connection = ref<'在线' | '重连中'>('在线')
  const pendingRetry = ref(0)
  const latestAlert = ref('18:00–20:00 LINE-A2 存在跨班组重叠作业')
  const loaded = ref(false)

  function persist() {
    if (import.meta.client) localStorage.setItem(STORAGE_KEY, JSON.stringify({ permits: permits.value, audit: audit.value }))
  }
  function restore() {
    if (!import.meta.client || loaded.value) return
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const draft = JSON.parse(raw)
      permits.value = draft.permits
      audit.value = draft.audit
    }
    loaded.value = true
  }
  function addAudit(actor: string, action: string, target: string, detail: string) {
    audit.value.unshift({ id: `AE-${Date.now().toString().slice(-5)}`, time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }), actor, action, target, detail })
    persist()
  }
  function advancePermit(id: string) {
    const permit = permits.value.find((item) => item.id === id)
    if (!permit) return
    const flow: Record<string, Permit['status']> = { 待复核: '待执行', 待执行: '执行中', 执行中: '待结束', 待结束: '待关闭', 待关闭: '已完成' }
    const next = flow[permit.status]
    if (!next) return
    if (permit.status === '待复核' && permit.reviewRequired && !confirm('该许可存在待复核冲突，确认由值班负责人承担审批责任？')) return
    permit.status = next
    permit.reviewRequired = false
    permit.revision += 1
    addAudit('当前用户', '流程推进', permit.id, `状态由“${Object.keys(flow).find((key) => flow[key] === next)}”变更为“${next}”`)
  }
  function toggleStep(permitId: string, stepId: string) {
    const permit = permits.value.find((item) => item.id === permitId)
    const step = permit?.steps.find((item) => item.id === stepId)
    if (!permit || !step) return
    const previous = permit.steps.filter((item) => item.done).length
    step.done = !step.done
    if (previous === 2 && permit.steps.filter((item) => item.done).length === 3 && permit.id === 'WP-260929-018') {
      latestAlert.value = 'WP-260929-018 检测到 LINE-A2 共用母线隔离点，需要复核'
      permit.reviewRequired = true
      permits.value.find((item) => item.id === 'WP-260929-021')!.reviewRequired = true
    }
    addAudit('当前用户', step.done ? '完成步骤' : '撤销步骤', `${permit.id} / ${step.id}`, step.text)
  }
  function addPermit(permit: Permit) { permits.value.unshift(permit); addAudit('当前用户', '新建许可', permit.id, permit.title) }
  function acceptAlert() { latestAlert.value = ''; addAudit('值班负责人', '确认冲突', '跨班组重叠', '同意调整 LINE-A2 作业时间，不允许同时开工') }
  function markOffline() { connection.value = '重连中'; pendingRetry.value += 1 }
  function markOnline() { connection.value = '在线' }
  function retryPending() { pendingRetry.value = 0; connection.value = '在线'; addAudit('系统', '重试成功', '实时通道', '断线期间的现场确认已补传') }

  restore()
  return { permits, audit, connection, pendingRetry, latestAlert, advancePermit, toggleStep, addPermit, acceptAlert, markOffline, markOnline, retryPending, restore }
})
