<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { errorMessage } from '../api'
import { checkText, displayInterval, displayTime, type Check, type Sandbox } from '../model'
import StatusBadge from './StatusBadge.vue'

// 详情面板只保留判断"是否需要处理"所必需的信息：
// 名称、状态、地址、一行关键读数、历史条形图。其余全部折叠。
const props = defineProps<{
  sandbox: Sandbox
  busy: boolean
  history: (id: string, signal: AbortSignal) => Promise<{ checks: Check[] }>
}>()
const emit = defineEmits<{ edit: []; check: []; toggle: []; copy: []; remove: [] }>()
const checks = shallowRef<Check[]>([])
const loading = shallowRef(false)
const error = shallowRef('')
const showHistory = shallowRef(false)
const showMore = shallowRef(false)
const recent = computed(() => checks.value.slice(0, 24).reverse())
const lastFailed = computed(() => checks.value.find(check => !check.ok) ?? null)

watch(() => [props.sandbox.id, props.sandbox.lastCheck?.id] as const, async ([id, last], previous, onCleanup) => {
  const request = new AbortController()
  onCleanup(() => request.abort())
  if (id !== previous?.[0] || last === undefined) {
    checks.value = []
    showHistory.value = false
    showMore.value = false
  }
  loading.value = true
  error.value = ''
  try {
    const result = await props.history(id, request.signal)
    if (!request.signal.aborted) checks.value = result.checks
  } catch (cause) {
    if (!request.signal.aborted) error.value = errorMessage(cause)
  } finally {
    if (!request.signal.aborted) loading.value = false
  }
}, { immediate: true })
</script>

<template>
  <section class="panel detail compact-detail" aria-labelledby="sandbox-detail-title">
    <div class="detail-heading">
      <h2 id="sandbox-detail-title" tabindex="-1">{{ sandbox.config.name }}</h2>
      <StatusBadge :status="sandbox.status" />
    </div>

    <a class="detail-url mono" :href="sandbox.config.url" target="_blank" rel="noreferrer">{{ sandbox.config.url }} ↗</a>

    <!-- 一行读数：把原来的六个格子压成一行，扫一眼就知道要不要处理 -->
    <p class="compact-line">
      <span>{{ sandbox.lastCheck ? `${sandbox.lastCheck.durationMs} ms` : '未检查' }}</span>
      <span class="dot" aria-hidden="true">·</span>
      <span>{{ displayInterval(sandbox.config.intervalSec) }}一次</span>
      <span class="dot" aria-hidden="true">·</span>
      <span>下次 {{ displayTime(sandbox.nextCheckAt) }}</span>
      <template v-if="sandbox.failures">
        <span class="dot" aria-hidden="true">·</span>
        <span class="text-down">连续失败 {{ sandbox.failures }}/{{ sandbox.config.failureThreshold }}</span>
      </template>
    </p>
    <p v-if="lastFailed" class="compact-line">
      <span class="text-down">最近一次失败：{{ checkText(lastFailed) }}</span>
      <span class="dot" aria-hidden="true">·</span>
      <span class="muted">{{ displayTime(lastFailed.at) }}</span>
    </p>
    <p v-if="sandbox.config.notes" class="compact-line muted">{{ sandbox.config.notes }}</p>

    <div class="detail-actions">
      <button class="button primary" type="button" :disabled="busy || sandbox.running" @click="emit('check')">
        {{ sandbox.running ? '检查中…' : '立即检查' }}
      </button>
      <button class="button" type="button" :disabled="busy" @click="emit('toggle')">
        {{ sandbox.config.enabled ? '暂停' : '启用' }}
      </button>
      <button class="button" type="button" :disabled="busy" :aria-expanded="showMore" @click="showMore = !showMore">
        {{ showMore ? '收起' : '更多' }}
      </button>
    </div>
    <div v-if="showMore" class="detail-actions more-actions">
      <button class="button" type="button" :disabled="busy" @click="emit('edit')">编辑</button>
      <button class="button" type="button" :disabled="busy" @click="emit('copy')">复制</button>
      <button class="button danger" type="button" :disabled="busy" @click="emit('remove')">删除</button>
    </div>

    <!-- 历史只给条形图；文字明细按需展开 -->
    <div class="history-compact">
      <div class="history-heading">
        <h3 id="checks-title">最近检查</h3>
        <button v-if="recent.length" class="link-button" type="button" :aria-expanded="showHistory" @click="showHistory = !showHistory">
          {{ showHistory ? '收起明细' : '查看明细' }}
        </button>
      </div>
      <p v-if="error" role="alert" class="notice error">{{ error }}</p>
      <template v-else-if="recent.length">
        <div class="history-bars" aria-hidden="true">
          <span v-for="check in recent" :key="check.id" :class="{ failed: !check.ok }" :title="checkText(check)"></span>
        </div>
        <ul v-if="showHistory" class="history-list">
          <li v-for="check in checks" :key="check.id">
            <span class="mono muted">{{ displayTime(check.at) }}</span>
            <span :class="check.ok ? 'text-up' : 'text-down'">{{ checkText(check) }}</span>
            <span class="mono history-duration">{{ check.durationMs }} ms</span>
          </li>
        </ul>
      </template>
      <p v-else class="history-empty muted">{{ loading ? '正在读取记录…' : '还没有检查记录。' }}</p>
    </div>
  </section>
</template>

<style scoped>
.compact-detail { padding: 18px; }
.detail-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.detail-heading h2 { font-size: 17px; overflow-wrap: anywhere; }
.compact-line { margin-top: 8px; font-size: 12px; color: var(--muted); display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.compact-line .dot { opacity: .5; }
.detail-actions { margin-top: 14px; display: flex; flex-wrap: wrap; gap: 8px; }
.more-actions { margin-top: 8px; }
.history-compact { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line); }
.history-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.history-heading h3 { font-size: 13px; color: var(--muted); font-weight: 600; }
.link-button { border: none; background: none; color: var(--accent); font-size: 12px; padding: 2px 0; }
.link-button:hover { text-decoration: underline; }
.history-list { list-style: none; padding: 0; margin: 10px 0 0; }
.history-list li { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; padding: 5px 0; font-size: 12px; border-top: 1px solid var(--line); }
.history-empty { margin-top: 10px; font-size: 12px; }
</style>
