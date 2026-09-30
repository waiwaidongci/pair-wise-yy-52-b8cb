<script setup lang="ts">
import { useOperationsStore } from '~/stores/operations'

const store = useOperationsStore()
const keyword = ref('')
const filtered = computed(() => store.audit.filter((event) => `${event.actor}${event.action}${event.target}${event.detail}`.includes(keyword.value)))
</script>

<template>
  <div class="page">
    <div class="head"><div><p class="eyebrow">不可覆盖的操作记录</p><h1 class="page-title">审计与交接时间线</h1><p class="muted">隔离点变化、许可签署、附件补传、失败重试和现场确认完整留痕。</p></div><UButton color="gray" variant="outline" icon="i-heroicons-arrow-down-tray">导出审计包</UButton></div>
    <section class="panel p-4">
      <div class="inline justify-between wrap mb-4"><UInput v-model="keyword" icon="i-heroicons-magnifying-glass" placeholder="搜索人员、许可或操作" class="search" /><div class="inline"><UBadge color="gray">共 {{ filtered.length }} 条</UBadge><UButton size="sm" variant="ghost" icon="i-heroicons-funnel">筛选</UButton></div></div>
      <div class="timeline"><div v-for="event in filtered" :key="event.id" class="event"><time>{{ event.time }}</time><i></i><div><div class="inline wrap"><b>{{ event.actor }}</b><UBadge size="xs" variant="subtle">{{ event.action }}</UBadge><span class="target">{{ event.target }}</span></div><p>{{ event.detail }}</p></div></div></div>
    </section>
  </div>
</template>

<style scoped>
.head{display:flex;justify-content:space-between;margin-bottom:18px}.head h1{margin:3px 0 7px}.head p{margin:0}.eyebrow{font-size:12px;color:#2563eb;font-weight:700}.search{min-width:300px}.timeline{padding:4px 0}.event{display:grid;grid-template-columns:65px 16px 1fr;gap:10px;position:relative;padding:7px 0}.event time{color:#667085;font-size:13px;padding-top:3px}.event i{position:relative;width:10px;height:10px;border-radius:50%;background:#2563eb;top:7px;z-index:1;box-shadow:0 0 0 4px #dbeafe}.event:not(:last-child):after{content:"";position:absolute;left:77px;top:21px;bottom:-7px;width:2px;background:#dbeafe}.event>div{border-bottom:1px solid #edf0f5;padding:0 0 14px 8px}.event p{margin:6px 0 0;color:#667085}.target{font-family:monospace;color:#475569;font-size:12px}
@media(max-width:620px){.head{flex-direction:column;gap:12px}.event{grid-template-columns:55px 14px 1fr}.event:not(:last-child):after{left:64px}.search{min-width:100%}.inline.justify-between{align-items:flex-start;flex-direction:column}}
</style>
