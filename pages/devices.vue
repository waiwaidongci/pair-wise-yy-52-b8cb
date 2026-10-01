<script setup lang="ts">
import { useOperationsStore } from '~/stores/operations'

const store = useOperationsStore()
const selectedDevice = ref('WTG-03')

// 同一隔离点可能出现在多张许可中（如 BUS-A 的 IP-413），按 id 归并为服务端事实视图
const pointIndex = computed(() => {
  const map = new Map<string, { point: { id: string; device: string; label: string; type: string; state: string; revision: number }; permits: string[]; crews: string[] }>()
  for (const permit of store.permits) {
    for (const point of permit.isolationPoints) {
      const entry = map.get(point.id) ?? { point: { ...point }, permits: [] as string[], crews: [] as string[] }
      entry.point = { ...point }
      entry.permits.push(permit.id)
      entry.crews.push(permit.crew)
      map.set(point.id, entry)
    }
  }
  return map
})

const selectedPoints = computed(() => [...pointIndex.value.values()].filter((entry) => entry.point.device.includes(selectedDevice.value) || entry.permits.some((id) => id.includes(selectedDevice.value))))

const devices = computed(() => [
  { id: 'WTG-03', name: '3 号风力发电机组', state: '检修隔离', load: '0 kW', points: 3, crew: '机务二班' },
  { id: 'LINE-A2', name: 'A2 集电线路', state: '待隔离', load: '0.8 MW', points: 3, crew: '线路一班' },
  { id: 'BOX-12', name: '12 号箱式变压器', state: '运行', load: '2.4 MW', points: 2, crew: '电气一班' },
  { id: 'BUS-A', name: 'A 段 35kV 母线', state: '运行', load: '18.6 MW', points: 1, crew: '公用' },
])

function operatePoint(pointId: string, current: string) {
  // 从任一引用该点的许可提交即可；服务端会同步级联失效其他共享许可
  const holder = store.permits.find((permit) => permit.isolationPoints.some((point) => point.id === pointId))
  if (!holder) return
  const next = current === '待操作' ? '已隔离' : current === '已隔离' ? '已恢复' : '待操作'
  void store.setPointState(holder.id, pointId, next as '已隔离' | '待操作' | '已恢复')
}
</script>

<template>
  <div class="page">
    <div class="head"><div><p class="eyebrow">LOCKOUT / TAGOUT · 服务端锁定状态</p><h1 class="page-title">设备隔离与锁定点</h1><p class="muted">隔离操作携带版本与操作号提交；共享隔离点状态一变，相关许可立即失效待复核。</p></div><UButton color="primary" icon="i-heroicons-plus">登记隔离点</UButton></div>

    <UAlert v-if="store.activeConflicts.length" class="mb-4" color="red" variant="soft" icon="i-heroicons-exclamation-triangle" title="隔离操作引发许可复核" :description="store.activeConflicts[0].message">
      <template #actions><UButton size="xs" color="red" variant="solid" @click="navigateTo(`/permits?id=${store.activeConflicts[0].permitId}`)">去重新确认</UButton></template>
    </UAlert>

    <div class="device-grid">
      <article v-for="device in devices" :key="device.id" class="panel device" :class="{ active: selectedDevice === device.id }" @click="selectedDevice = device.id"><div class="inline justify-between"><UBadge variant="subtle">{{ device.id }}</UBadge><UBadge :color="device.state === '运行' ? 'green' : device.state === '检修隔离' ? 'red' : 'amber'" variant="subtle">{{ device.state }}</UBadge></div><h2>{{ device.name }}</h2><div class="kv"><span>当前负荷</span><b>{{ device.load }}</b></div><div class="kv"><span>隔离点</span><b>{{ device.points }} 个</b></div><div class="kv"><span>责任班组</span><b>{{ device.crew }}</b></div></article>
    </div>
    <section class="grid lower"><article class="panel p-4"><h2>{{ selectedDevice }} · 隔离检查单（服务端版本）</h2><div v-for="entry in selectedPoints" :key="entry.point.id" class="point"><div class="lock-icon"><UIcon name="i-heroicons-lock-closed" /></div><div><b>{{ entry.point.label }}</b><small>{{ entry.point.type }} · {{ entry.point.id }} · 版本 p{{ entry.point.revision }}</small><small class="share" :class="{ warn: entry.permits.length > 1 }">被 {{ entry.permits.length }} 张许可引用：{{ entry.permits.join('、') }}<template v-if="entry.permits.length > 1">（状态变化将全部触发复核）</template></small></div><UBadge :color="entry.point.state === '已隔离' ? 'green' : entry.point.state === '已恢复' ? 'gray' : 'amber'" variant="subtle">{{ entry.point.state }}</UBadge><UButton size="xs" variant="outline" :loading="store.inflight" @click="operatePoint(entry.point.id, entry.point.state)">{{ entry.point.state === '待操作' ? '执行隔离' : entry.point.state === '已隔离' ? '恢复送电' : '重新隔离' }}</UButton><UButton size="xs" variant="ghost">操作记录</UButton></div><UAlert v-if="!selectedPoints.length" color="amber" variant="subtle" title="该设备暂无隔离点" description="可在许可中新建隔离点并关联设备。" /></article><article class="panel p-4"><h2>交叉冲突检测</h2><UAlert color="red" variant="soft" title="LINE-A2 与 BOX-12 共用母线隔离边界（IP-413）" description="两个作业在同一时间窗内涉及 BUS-A；任一班组改变 IP-413 状态，两张许可同时失效，需值班负责人确认先后顺序与交接条件。" /><h3>锁定器具台账</h3><div class="tool"><span>LK-2107</span><b>WTG-03 · 周野</b></div><div class="tool"><span>LK-2118</span><b>LINE-A2 · 待领用</b></div><div class="tool"><span>GND-042</span><b>17 号杆 · 谭勇</b></div><div v-if="store.pendingRetry" class="tool"><span>待提交</span><b class="warn">{{ store.pendingRetry }} 项操作等待网络恢复</b></div></article></section>
  </div>
</template>

<style scoped>
.head{display:flex;justify-content:space-between;margin-bottom:18px}.head h1{margin:3px 0 7px}.head p{margin:0}.eyebrow{font-size:12px;color:#2563eb;font-weight:700}.device-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}.device{padding:16px;cursor:pointer}.device.active{border-color:#2563eb;box-shadow:0 0 0 2px #dbeafe}.device h2{font-size:16px;margin:14px 0}.kv{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #edf0f5;font-size:13px}.kv span{color:#667085}.lower{grid-template-columns:1.3fr .7fr;gap:16px}.panel h2{font-size:17px;margin:0 0 14px}.point{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid #edf0f5}.point>div:nth-child(2){flex:1}.point b,.point small{display:block}.point small{color:#667085;margin-top:4px}.point small.share{font-family:monospace;font-size:11px}.point small.warn{color:#b91c1c}.warn{color:#b91c1c}.lock-icon{display:grid;place-items:center;width:34px;height:34px;background:#eff6ff;color:#2563eb;border-radius:7px}.tool{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #edf0f5}.tool span{color:#2563eb;font-family:monospace}.tool b{font-size:13px}
@media(max-width:1050px){.device-grid{grid-template-columns:1fr 1fr}.lower{grid-template-columns:1fr}}@media(max-width:600px){.head{flex-direction:column;gap:12px}.device-grid{grid-template-columns:1fr}}
</style>
