<script setup lang="ts">
import { useOperationsStore } from '~/stores/operations'

const store = useOperationsStore()
const { data } = await useFetch('/api/operations')
const { reconnect } = useRealtime((event) => {
  if (event.type === 'connection') {
    const online = event.payload.startsWith('在线')
    if (online) void store.markOnline()
    else store.markOffline()
  }
  // 其他班组的现场确认到达：立即以服务端事实刷新本端，暴露过期许可
  if (event.type === 'permit-update') void store.refresh()
})
const counts = computed(() => ({
  active: store.permits.filter((item) => ['执行中', '待结束'].includes(item.status)).length,
  pending: store.permits.filter((item) => ['待复核', '待执行'].includes(item.status)).length,
  conflicts: store.permits.filter((item) => item.reviewRequired).length,
}))
</script>

<template>
  <div class="page">
    <div class="head">
      <div><p class="eyebrow">现场安全运行</p><h1 class="page-title">隔离与作业许可总览</h1><p class="muted">许可、锁定与审计以服务端为唯一事实；冲突只影响相关许可，其余班组可继续作业。</p></div>
      <div class="inline wrap"><UButton color="gray" variant="outline" icon="i-heroicons-arrow-path" @click="reconnect">检查连接</UButton><UButton color="primary" icon="i-heroicons-document-plus" @click="navigateTo('/permits?new=1')">申请作业许可</UButton></div>
    </div>
    <UAlert v-if="store.latestAlert" class="mb-4" color="red" variant="soft" icon="i-heroicons-exclamation-triangle" title="提交冲突：操作被驳回，需值班负责人重新确认" :description="`${store.latestAlert.permitId} · ${store.latestAlert.message}`">
      <template #actions>
        <UButton size="sm" color="red" variant="solid" icon="i-heroicons-user-check" @click="navigateTo(`/permits?id=${store.latestAlert.permitId}`)">去重新确认</UButton>
        <UButton size="sm" color="white" variant="ghost" @click="store.dismissConflict(store.latestAlert.opId)">暂不处理（其他许可可继续操作）</UButton>
      </template>
    </UAlert>
    <UAlert v-else-if="store.connection !== '在线'" class="mb-4" :color="store.connection === '提交中' ? 'blue' : 'amber'" variant="soft" :title="store.connection === '提交中' ? '正在提交' : '重连中：操作已保留在待提交队列'" :description="store.lastError || `恢复后从最后确认项之后重发 ${store.pendingRetry} 项，同一操作号不会重复写入。`" />

    <section class="grid metrics">
      <article class="panel metric"><span>执行中许可</span><strong>{{ counts.active }}</strong><small>3 个班组在场</small></article>
      <article class="panel metric"><span>待复核 / 待执行</span><strong>{{ counts.pending }}</strong><small>最早 18:00 开工</small></article>
      <article class="panel metric"><span>隔离冲突</span><strong class="danger">{{ counts.conflicts }}</strong><small>必须复核后推进</small></article>
      <article class="panel metric"><span>设备在线</span><strong>{{ data?.onlineDevices }}/{{ data?.totalDevices }}</strong><small>平均风速 {{ data?.windSpeed }} m/s</small></article>
    </section>
    <section class="grid main-grid">
      <article class="panel p-4">
        <div class="panel-head"><div><h2>当前作业状态</h2><p class="muted">按风险和开始时间排序 · 数据来自服务端</p></div><span class="inline" style="gap:6px"><UBadge v-if="store.pendingRetry" color="blue" variant="soft">待同步 {{ store.pendingRetry }}</UBadge><UBadge color="blue" variant="subtle">事实版本 s{{ store.stateVersion }}</UBadge></span></div>
        <div class="table-scroll"><table class="data-table"><thead><tr><th>许可 / 作业</th><th>设备</th><th>负责人</th><th>时间窗</th><th>版本</th><th>状态</th><th></th></tr></thead><tbody>
          <tr v-for="permit in store.displayPermits" :key="permit.id"><td><b>{{ permit.id }}</b><small class="block muted">{{ permit.title }}</small></td><td>{{ permit.device }}</td><td>{{ permit.owner }} · {{ permit.crew }}</td><td>{{ permit.window }}</td><td><span class="mono">r{{ permit.revision }}</span></td><td><UBadge v-if="permit.pending || store.pendingPermitIds.has(permit.id)" color="blue" variant="soft">待同步</UBadge><UBadge v-else :color="permit.reviewRequired ? 'red' : permit.status === '执行中' ? 'green' : 'amber'" variant="subtle">{{ permit.reviewRequired ? '失效待复核' : permit.status }}</UBadge></td><td><UButton size="xs" variant="ghost" @click="navigateTo(`/permits?id=${permit.id}`)">{{ permit.reviewRequired ? '去复核' : '进入' }}</UButton></td></tr>
        </tbody></table></div>
      </article>
      <aside class="grid side-grid">
        <article class="panel p-4"><h2>设备状态</h2><div class="device-row"><span class="dot green" /><div><b>WTG-01 ~ WTG-28</b><small>正常运行</small></div><UBadge color="green">28</UBadge></div><div class="device-row"><span class="dot amber" /><div><b>WTG-03、LINE-A2</b><small>检修隔离中</small></div><UBadge color="amber">2</UBadge></div><div class="device-row"><span class="dot red" /><div><b>BOX-12</b><small>待执行许可</small></div><UBadge color="red">1</UBadge></div></article>
        <article class="panel p-4"><h2>现场条件</h2><div class="condition"><span>轮毂高度风速</span><b>10.8 m/s</b></div><div class="condition"><span>能见度</span><b>12 km</b></div><div class="condition"><span>高空作业</span><b class="danger">暂停</b></div><div class="condition"><span>下一次窗口</span><b>17:40 复核</b></div></article>
      </aside>
    </section>
  </div>
</template>

<style scoped>
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;margin-bottom:18px}.head h1{margin:3px 0 7px}.head p{margin:0}.eyebrow{font-size:12px;color:#2563eb;font-weight:700}.metrics{grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}.metric{padding:17px}.main-grid{grid-template-columns:minmax(0,1.65fr) minmax(290px,.7fr);gap:16px}.panel-head{display:flex;justify-content:space-between;margin-bottom:12px}.panel h2{font-size:17px;margin:0 0 12px}.panel-head h2{margin:0}.panel-head p{font-size:12px;margin:3px 0}.block,.device-row small{display:block}.side-grid{gap:14px}.device-row,.condition{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 0;border-bottom:1px solid #edf0f5}.device-row{justify-content:flex-start}.device-row div{flex:1}.dot{width:9px;height:9px;border-radius:50%}.dot.green{background:#22c55e}.dot.amber{background:#f59e0b}.dot.red{background:#ef4444}.condition{font-size:14px}.condition span{color:#667085}.mono{font-family:monospace;color:#475569;font-size:12px}
@media(max-width:1100px){.metrics{grid-template-columns:1fr 1fr}.main-grid{grid-template-columns:1fr}}@media(max-width:620px){.head{flex-direction:column}.metrics{grid-template-columns:1fr}}
</style>
