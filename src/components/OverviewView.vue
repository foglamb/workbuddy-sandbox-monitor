<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import { leaseStatus, leaseTime, type Lease } from '../lease-model'
import type { Sandbox } from '../model'
import { buildOverview, type OverviewTarget } from '../overview'

const props = defineProps<{
  sandboxes: readonly Sandbox[]
  leases: readonly Lease[]
  serverTime: number
}>()
const emit = defineEmits<{ open: [target: OverviewTarget]; configure: []; pause: [] }>()
const filter = shallowRef<'all' | 'attention' | 'waiting'>('all')
const overview = computed(() => buildOverview(props.sandboxes, props.leases, props.serverTime))
const total = computed(() => props.sandboxes.length + props.leases.length)
const enabled = computed(() => overview.value.urlsActive + overview.value.leasesActive)
const visible = computed(() => overview.value.items.filter(item => filter.value === 'all' ||
  (filter.value === 'waiting' ? item.severity === 'waiting' : item.severity !== 'waiting')))
const labels = { urgent: '优先处理', attention: '请关注', waiting: '等待结果' } as const
</script>

<template>
  <div class="page-heading">
    <div><h1>运行总览</h1><p>一起查看网址检查和实例续期状态。这里只显示已启用任务的待处理或等待事项。</p></div>
    <button class="button" type="button" :disabled="!enabled" @click="emit('pause')">批量暂停</button>
  </div>
  <div class="summary" aria-label="运行概况">
    <div class="stat"><span>启用网址检查</span><strong>{{ overview.urlsActive }}<small> / {{ sandboxes.length }}</small></strong></div>
    <div v-if="leases.length" class="stat"><span>启用实例续期</span><strong>{{ overview.leasesActive }}<small> / {{ leases.length }}</small></strong></div>
    <div class="stat"><span>需关注</span><strong :class="{ 'text-down': overview.attention }">{{ overview.attention }}</strong></div>
    <div class="stat"><span>等待结果</span><strong>{{ overview.waiting }}</strong></div>
  </div>
  <section class="panel list-panel" aria-labelledby="findings-title">
    <div class="list-heading overview-heading">
      <div>
        <h2 id="findings-title">待处理事项</h2>
        <p v-if="serverTime" class="muted as-of">状态截至 {{ leaseTime(serverTime) }}</p>
      </div>
      <label v-if="overview.items.length" class="overview-filter">
        <span class="muted">筛选</span>
        <select v-model="filter" aria-label="筛选事项">
          <option value="all">全部事项</option>
          <option value="attention">需关注</option>
          <option value="waiting">等待结果</option>
        </select>
      </label>
    </div>
    <ul v-if="visible.length" class="sandbox-list" aria-label="待处理任务">
      <li v-for="item in visible" :key="`${item.target.kind}:${item.target.id}`">
        <button class="sandbox-row finding" type="button" @click="emit('open', item.target)">
          <span class="row-main finding-title">
            <strong>{{ item.name }}</strong>
            <span class="row-url">{{ item.context }}</span>
          </span>
          <span class="reason">
            <strong>{{ item.title }}<template v-if="item.leaseStatus"> · {{ leaseStatus(item.leaseStatus) }}</template></strong>
            <span class="muted">{{ item.detail }}</span>
            <small v-if="item.expiresAt !== undefined" class="muted mono">记录的到期时间：{{ leaseTime(item.expiresAt) }}</small>
          </span>
          <span class="status-pill finding-badge" :class="{ 'status-down': item.severity === 'urgent', 'status-degraded': item.severity === 'attention' }">
            <span class="status-dot" aria-hidden="true"></span>{{ labels[item.severity] }} <span aria-hidden="true">↗</span>
          </span>
        </button>
      </li>
    </ul>
    <div v-else class="empty-state compact">
      <template v-if="!total">
        <p>还没有配置任务。</p>
        <button class="button primary" type="button" @click="emit('configure')">添加网址监控</button>
      </template>
      <p v-else-if="!enabled">所有任务都已暂停。</p>
      <p v-else-if="overview.items.length">没有符合当前筛选条件的事项。</p>
      <p v-else>已启用的任务当前没有待处理事项。</p>
    </div>
  </section>
  <footer class="scope-note">点开事项查看详情。已暂停任务不计入总览；网址响应和实例上次查询状态都不是实时停机证明。</footer>
</template>

<style scoped>
.overview-heading { align-items: center; }
.as-of { font-size: 12px; margin-top: 4px; }
.overview-filter { display: flex; gap: 8px; align-items: center; font-size: 12px; }
.finding { grid-template-columns: minmax(6rem, .6fr) minmax(9rem, 1.4fr) auto; gap: 14px; }
.finding-title, .reason { overflow-wrap: anywhere; }
.reason { display: grid; gap: 3px; line-height: 1.45; font-size: 13px; }
.finding-title strong, .reason strong { font-size: 14px; }
.finding-badge { justify-self: end; }
@media (max-width: 530px) {
  .overview-heading { align-items: flex-start; }
  .overview-filter > span { display: none; }
  .finding { grid-template-columns: minmax(0, 1fr) auto; gap: 6px 12px; }
  .reason { grid-column: 1 / -1; grid-row: 2; }
  .finding-badge { grid-column: 2; grid-row: 1; }
}
</style>
