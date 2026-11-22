<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { errorMessage } from '../api'
import { checkText, displayInterval, displayTime, type Check, type Sandbox } from '../model'
import StatusBadge from './StatusBadge.vue'

const props = defineProps<{
  sandbox: Sandbox
  busy: boolean
  history: (id: string, signal: AbortSignal) => Promise<{ checks: Check[] }>
}>()
const emit = defineEmits<{ edit: []; check: []; toggle: []; copy: []; remove: [] }>()
const checks = shallowRef<Check[]>([])
const loading = shallowRef(false)
const error = shallowRef('')
const recent = computed(() => checks.value.slice(0, 24).reverse())

watch(() => [props.sandbox.id, props.sandbox.lastCheck?.id] as const, async ([id, last], previous, onCleanup) => {
  const request = new AbortController()
  onCleanup(() => request.abort())
  if (id !== previous?.[0] || last === undefined) checks.value = []
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
  <section class="panel detail" aria-labelledby="sandbox-detail-title">
    <div class="detail-heading">
      <div>
        <p class="detail-group">{{ sandbox.config.group || '未分组' }}</p>
        <h2 id="sandbox-detail-title" tabindex="-1">{{ sandbox.config.name }}</h2>
      </div>
      <StatusBadge :status="sandbox.status" />
    </div>
    <a class="detail-url mono" :href="sandbox.config.url" target="_blank" rel="noreferrer">{{ sandbox.config.url }} ↗</a>
    <p v-if="sandbox.config.notes" class="detail-notes">{{ sandbox.config.notes }}</p>
    <p v-if="sandbox.config.expectedText" class="detail-notes">预期响应文本 <code>{{ sandbox.config.expectedText }}</code></p>
    <div class="detail-actions" aria-label="沙盒操作">
      <button class="button primary" type="button" :disabled="busy || sandbox.running" @click="emit('check')">
        {{ sandbox.running ? '检查中…' : '立即检查' }}
      </button>
      <button class="button" type="button" :disabled="busy" @click="emit('toggle')">
        {{ sandbox.config.enabled ? '暂停' : '启用' }}
      </button>
      <button class="button" type="button" :disabled="busy" @click="emit('edit')">编辑</button>
      <button class="button" type="button" :disabled="busy" @click="emit('copy')">复制</button>
      <button class="button danger" type="button" :disabled="busy" @click="emit('remove')">删除</button>
    </div>

    <dl class="readings">
      <div><dt>最近检查</dt><dd class="mono">{{ displayTime(sandbox.lastCheck?.at) }}</dd></div>
      <div><dt>下次检查</dt><dd class="mono">{{ displayTime(sandbox.nextCheckAt) }}</dd></div>
      <div><dt>检查频率</dt><dd>{{ displayInterval(sandbox.config.intervalSec) }}</dd></div>
      <div><dt>最近耗时</dt><dd class="mono">{{ sandbox.lastCheck ? `${sandbox.lastCheck.durationMs} ms` : '—' }}</dd></div>
      <div><dt>连续失败</dt><dd class="mono">{{ sandbox.failures }} / {{ sandbox.config.failureThreshold }}</dd></div>
      <div><dt>成功条件</dt><dd class="mono">{{ sandbox.config.method }} · {{ sandbox.config.successMin }}–{{ sandbox.config.successMax }}</dd></div>
    </dl>

    <section class="history" aria-labelledby="checks-title">
      <div class="history-heading">
        <h3 id="checks-title">检查记录</h3>
        <span v-if="recent.length" class="muted">最近 {{ recent.length }} 次</span>
      </div>
      <div v-if="recent.length" class="history-bars" aria-hidden="true">
        <span v-for="check in recent" :key="check.id" :class="{ failed: !check.ok }" :title="checkText(check)"></span>
      </div>
      <p v-if="error" role="alert" class="notice error">{{ error }}</p>
      <p v-else-if="!checks.length" class="history-empty muted">{{ loading ? '正在读取记录…' : '这项配置还没有检查记录。' }}</p>
      <ul v-else class="history-list">
        <li v-for="check in checks" :key="check.id">
          <span class="mono muted">{{ displayTime(check.at) }}</span>
          <span :class="check.ok ? 'text-up' : 'text-down'">{{ checkText(check) }}</span>
          <span class="history-trigger muted">{{ check.trigger === 'manual' ? '手动' : '定时' }}</span>
          <span class="mono history-duration">{{ check.durationMs }} ms</span>
        </li>
      </ul>
    </section>
  </section>
</template>
