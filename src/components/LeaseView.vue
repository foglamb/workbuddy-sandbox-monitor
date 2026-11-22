<script setup lang="ts">
import { computed } from 'vue'
import LeasePanel from './LeasePanel.vue'
import { leaseStatus, type Lease, type LeasePolicy } from '../lease-model'

const props = defineProps<{
  leases: readonly Lease[]
  update: (id: string, policy: LeasePolicy) => Promise<{ lease: Lease }>
  query: (id: string) => Promise<{ lease: Lease }>
}>()
const emit = defineEmits<{ changed: [] }>()
const selectedId = defineModel<string>('selectedId', { required: true })
const selected = computed(() => props.leases.find(lease => lease.id === selectedId.value) ?? props.leases[0])
const enabledCount = computed(() => props.leases.filter(lease => lease.policy.enabled).length)
</script>

<template>
  <div class="page-heading">
    <div><h1>实例保活</h1><p>查询腾讯云 Agent Runtime 实例的到期时间，按策略延长运行期限。</p></div>
  </div>
  <section v-if="!selected" class="panel empty-state" aria-labelledby="bindings-title">
    <h2 id="bindings-title">尚未绑定实例</h2>
    <p>在服务端配置 <code>WB_AGS_BINDINGS</code> 与对应的腾讯云凭据，然后重启服务。</p>
    <p>如果你只有 WorkBuddy 部署网址，请使用「网址监控」。网址和 WorkBuddy 会话 ID 不能当作腾讯云实例 ID。</p>
    <a href="https://cloud.tencent.com/document/product/1814/132377" target="_blank" rel="noreferrer">腾讯云实例查询说明 ↗</a>
  </section>
  <div v-else class="dashboard">
    <section class="panel list-panel" aria-labelledby="lease-list-title">
      <div class="list-heading"><h2 id="lease-list-title">已绑定实例</h2><small class="muted">{{ enabledCount }} / {{ leases.length }} 项已启用</small></div>
      <ul class="sandbox-list" aria-label="实例绑定列表">
        <li v-for="lease in leases" :key="lease.id">
          <button class="sandbox-row" :class="{ selected: selected.id === lease.id }" type="button"
            :aria-pressed="selected.id === lease.id" @click="selectedId = lease.id">
            <span class="row-main">
              <strong class="row-name">{{ lease.label }}</strong>
              <span class="row-url mono">{{ lease.id }} · {{ lease.region }}</span>
            </span>
            <span class="row-meta">{{ leaseStatus(lease.observed?.status) }}</span>
            <span class="status-pill" :class="lease.policy.enabled ? 'status-up' : 'status-paused'">
              <span class="status-dot" aria-hidden="true"></span>{{ lease.policy.enabled ? '已启用' : '已暂停' }}
            </span>
          </button>
        </li>
      </ul>
    </section>
    <LeasePanel :key="selected.id" :lease="selected" :update="update" :query="query" @changed="emit('changed')" />
  </div>
  <footer class="scope-note">仅续期已绑定且正在运行的限时实例。已停止、暂停或常驻的实例不会被启动或修改。</footer>
</template>
