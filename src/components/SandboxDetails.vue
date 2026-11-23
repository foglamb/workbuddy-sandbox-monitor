<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { errorMessage } from '../api'
import { checkText, displayInterval, displayTime, type Check, type CheckStats, type Sandbox } from '../model'
import StatusBadge from './StatusBadge.vue'

// 检查记录用于回答"这个站到底什么情况"，所以明细默认可见，
// 不默认折叠。统计从原始记录算出，可逐条核对。
const props = defineProps<{
  sandbox: Sandbox
  busy: boolean
  history: (id: string, signal: AbortSignal, options?: { limit?: number; before?: number }) => Promise<{ checks: Check[] }>
  stats: (id: string, signal: AbortSignal, hours?: number) => Promise<{ stats: CheckStats }>
}>()
const emit = defineEmits<{ edit: []; check: []; toggle: []; copy: []; remove: [] }>()
const checks = shallowRef<Check[]>([])
const summary = shallowRef<CheckStats | null>(null)
const loading = shallowRef(false)
const loadingMore = shallowRef(false)
const error = shallowRef('')
const hasMore = shallowRef(false)
const showMore = shallowRef(false)
const showDetail = shallowRef(true)
const pageSize = 100
const recent = computed(() => checks.value.slice(0, 24).reverse())
const lastFailed = computed(() => checks.value.find(check => !check.ok) ?? null)
const availability = computed(() => {
  const value = summary.value?.availability
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`
})
// 只在不处于最新一代配置时提示，避免正常情况也占一行
const hasLegacy = computed(() => checks.value.some(check => !check.latest))

async function load(signal: AbortSignal, reset: boolean) {
  const before = reset ? undefined : checks.value.at(-1)?.id
  const result = await props.history(props.sandbox.id, signal, { limit: pageSize, before })
  if (signal.aborted) return
  checks.value = reset ? result.checks : [...checks.value, ...result.checks]
  hasMore.value = result.checks.length === pageSize
}

watch(() => [props.sandbox.id, props.sandbox.lastCheck?.id] as const, async ([id, last], previous, onCleanup) => {
  const request = new AbortController()
  onCleanup(() => request.abort())
  if (id !== previous?.[0] || last === undefined) {
    checks.value = []
    summary.value = null
    showMore.value = false
  }
  loading.value = true
  error.value = ''
  try {
    await load(request.signal, true)
    if (!request.signal.aborted) summary.value = (await props.stats(id, request.signal)).stats
  } catch (cause) {
    if (!request.signal.aborted) error.value = errorMessage(cause)
  } finally {
    if (!request.signal.aborted) loading.value = false
  }
}, { immediate: true })

async function loadOlder() {
  if (loadingMore.value) return
  const request = new AbortController()
  loadingMore.value = true
  try {
    await load(request.signal, false)
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    loadingMore.value = false
  }
}

function codeLabel(code: string) {
  return { ok: '正常', http: '状态码不符', body: '内容不符', timeout: '超时', dns: '解析失败', tls: 'TLS 错误', network: '连接失败', blocked: '被规则拒绝' }[code] ?? code
}
</script>

<template>
  <section class="panel detail compact-detail" aria-labelledby="sandbox-detail-title">
    <div class="detail-heading">
      <h2 id="sandbox-detail-title" tabindex="-1">{{ sandbox.config.name }}</h2>
      <StatusBadge :status="sandbox.status" />
    </div>

    <a class="detail-url mono" :href="sandbox.config.url" target="_blank" rel="noreferrer">{{ sandbox.config.url }} ↗</a>

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

    <div class="history-compact">
      <div class="history-heading">
        <h3 id="checks-title">检查记录</h3>
        <button class="link-button" type="button" :aria-expanded="showDetail" @click="showDetail = !showDetail">
          {{ showDetail ? '收起明细' : '展开明细' }}
        </button>
      </div>

      <p v-if="error" role="alert" class="notice error">{{ error }}</p>
      <template v-else-if="summary && summary.total">
        <!-- 关键结论放最上面：能不能用、稳不稳、什么时候开始坏 -->
        <dl class="stats-line">
          <div><dt>可用率</dt><dd :class="summary.failed ? 'text-warn' : 'text-up'">{{ availability }}</dd></div>
          <div><dt>成功 / 失败</dt><dd>{{ summary.ok }} / <span :class="{ 'text-down': summary.failed }">{{ summary.failed }}</span></dd></div>
          <div><dt>耗时</dt><dd>{{ summary.durationMs ? `${summary.durationMs.avg} ms 平均` : '—' }}</dd></div>
          <div><dt>记录区间</dt><dd>{{ displayTime(summary.firstAt) }} 起</dd></div>
        </dl>
        <p v-if="summary.byCode.length > 1 || summary.byCode[0]?.code !== 'ok'" class="stats-codes">
          <span class="muted">失败构成：</span>
          <span v-for="item in summary.byCode.filter(row => row.code !== 'ok')" :key="item.code" class="code-chip">
            {{ codeLabel(item.code) }} {{ item.count }}
          </span>
        </p>
        <p v-if="hasLegacy" class="stats-legacy muted">
          包含改动前的旧配置记录（已标注），用于对照是否由配置变更引起。
        </p>

        <div v-if="recent.length" class="history-bars" aria-hidden="true">
          <span v-for="check in recent" :key="check.id" :class="{ failed: !check.ok }" :title="checkText(check)"></span>
        </div>

        <ul v-if="showDetail" class="history-list">
          <li v-for="check in checks" :key="check.id" :class="{ legacy: !check.latest }">
            <span class="mono muted">{{ displayTime(check.at) }}</span>
            <span :class="check.ok ? 'text-up' : 'text-down'">{{ checkText(check) }}</span>
            <span class="muted history-trigger">{{ check.trigger === 'manual' ? '手动' : '定时' }}</span>
            <span class="mono history-duration">{{ check.durationMs }} ms</span>
          </li>
        </ul>
        <button v-if="showDetail && hasMore" class="button load-more" type="button" :disabled="loadingMore" @click="loadOlder">
          {{ loadingMore ? '正在读取…' : '加载更早的记录' }}
        </button>
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
.stats-line { display: grid; grid-template-columns: repeat(auto-fit, minmax(88px, 1fr)); gap: 10px; margin: 12px 0 0; }
.stats-line dt { color: var(--muted); font-size: 11px; }
.stats-line dd { margin: 4px 0 0; font-size: 14px; font-variant-numeric: tabular-nums; }
.stats-codes { margin-top: 10px; font-size: 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.code-chip { border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; color: var(--danger); }
.stats-legacy { margin-top: 8px; font-size: 11px; }
.text-warn { color: var(--warning); }
.history-bars { margin-top: 12px; }
.history-list { list-style: none; padding: 0; margin: 10px 0 0; max-height: 340px; overflow-y: auto; }
.history-list li { display: grid; grid-template-columns: 1fr auto auto auto; gap: 10px; padding: 5px 0; font-size: 12px; border-top: 1px solid var(--line); }
.history-list li.legacy { opacity: .58; }
.history-trigger { font-size: 11px; }
.load-more { margin-top: 10px; width: 100%; }
.history-empty { margin-top: 10px; font-size: 12px; }
@media (max-width: 560px) {
  .history-list li { grid-template-columns: 1fr auto; }
  .history-trigger { display: none; }
}
</style>
