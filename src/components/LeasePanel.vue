<script setup lang="ts">
import { computed, reactive, shallowRef, watch } from 'vue'
import { errorMessage } from '../api'
import { leaseEventText, leaseStatus, leaseTime, type Lease, type LeasePolicy } from '../lease-model'

const props = defineProps<{
  lease: Lease
  update: (id: string, policy: LeasePolicy) => Promise<{ lease: Lease }>
  query: (id: string) => Promise<{ lease: Lease }>
}>()
const emit = defineEmits<{ changed: [] }>()
const draft = reactive<LeasePolicy>({ ...props.lease.policy })
const busy = shallowRef(false)
const feedback = shallowRef<{ text: string; error: boolean } | null>(null)
const fields = ['enabled', 'intervalSec', 'renewBeforeMinutes', 'extendMinutes', 'runForMinutes'] as const
const dirty = computed(() => fields.some(field => draft[field] !== props.lease.policy[field]))
const status = computed(() => leaseStatus(props.lease.observed?.status))
const recent = computed(() => props.lease.history.slice(0, 12))

watch(fields.map(field => () => props.lease.policy[field]), () => Object.assign(draft, props.lease.policy))

async function run(work: () => Promise<{ lease: Lease }>, saved: boolean) {
  if (busy.value) return
  busy.value = true
  feedback.value = null
  try {
    const { lease } = await work()
    if (saved) Object.assign(draft, lease.policy)
    feedback.value = !saved && lease.lastError
      ? { text: `查询未完成：${lease.lastError.code}`, error: true }
      : { text: saved ? '续期策略已保存。' : '已查询实例状态。', error: false }
    emit('changed')
  } catch (cause) {
    feedback.value = { text: errorMessage(cause), error: true }
  } finally {
    busy.value = false
  }
}

function save() {
  if (draft.enabled && !props.lease.policy.enabled &&
      !window.confirm('启用后将按策略延长运行时长，可能增加腾讯云费用。确认启用此实例的自动续期？')) return
  void run(() => props.update(props.lease.id, { ...draft }), true)
}
</script>

<template>
  <section class="panel detail" aria-labelledby="lease-detail-title">
    <div class="detail-heading">
      <div>
        <p class="detail-group">腾讯云 Agent Runtime · {{ lease.region }}</p>
        <h2 id="lease-detail-title" tabindex="-1">{{ lease.label }}</h2>
      </div>
      <span class="status-pill" :class="{ 'status-up': lease.observed?.status === 'RUNNING' }">
        <span class="status-dot" aria-hidden="true"></span>{{ status }}
      </span>
    </div>
    <dl class="lease-facts">
      <div><dt>云端到期时间</dt><dd>{{ lease.observed?.persistent ? '常驻实例' : leaseTime(lease.observed?.expiresAt) }}</dd></div>
      <div><dt>最近查询</dt><dd>{{ leaseTime(lease.observed?.at) }}</dd></div>
      <div><dt>下次派发时间</dt><dd>{{ leaseTime(lease.nextAt) }}</dd></div>
      <div><dt>最近续期核验</dt><dd>{{ leaseTime(lease.lastVerifiedAt) }}</dd></div>
      <div><dt>定时暂停</dt><dd>{{ lease.pauseAt === null ? '未设置' : leaseTime(lease.pauseAt) }}</dd></div>
    </dl>
    <p v-if="lease.pending" class="notice" role="status">
      {{ lease.pending.acknowledged ? '云端已受理续期，等待重新查询核对到期时间。' : '续期结果尚未确认，将先查询状态再决定是否重试。' }}
    </p>
    <p v-if="lease.lastError" class="notice error" role="status">
      {{ lease.lastError.phase === 'query' ? '查询失败' : '续期调用未完成' }} · {{ lease.lastError.code }}
      <small v-if="lease.lastError.requestId" class="mono block">请求 ID：{{ lease.lastError.requestId }}</small>
    </p>
    <form class="lease-form" @submit.prevent="save">
      <fieldset class="config-fields" :disabled="busy">
        <legend class="form-title">续期策略</legend>
        <label>查询间隔（秒）<input v-model.number="draft.intervalSec" type="number" min="60" max="1800" required /></label>
        <label>提前续期（分钟）<input v-model.number="draft.renewBeforeMinutes" type="number" min="3" max="240" required /></label>
        <label>续期后时长（分钟）<input v-model.number="draft.extendMinutes" type="number"
          :min="Math.max(15, Number(draft.renewBeforeMinutes) + 10)" max="1440" required /></label>
        <label>自动续期持续时间（分钟）<input v-model.number="draft.runForMinutes" type="number" min="0" max="10080" step="1" required /></label>
        <label class="activation"><input v-model="draft.enabled" type="checkbox" />启用自动续期</label>
      </fieldset>
      <p class="muted tip">持续时间填 0 表示不限时，或填 15–10080 分钟。到点仅暂停本平台的续期，不会关停云实例。</p>
      <p class="muted tip">修改持续时间会从保存时重新计时。查询间隔不得超过提前量的一半。「查询实例」只读。</p>
      <div class="detail-actions">
        <button class="button primary" type="submit" :disabled="busy || !dirty">保存策略</button>
        <button class="button" type="button" :disabled="busy || lease.running" @click="run(() => query(lease.id), false)">
          {{ lease.running ? '云端操作中…' : '查询实例' }}
        </button>
      </div>
    </form>
    <p v-if="feedback" class="notice feedback" :class="{ error: feedback.error }" :role="feedback.error ? 'alert' : 'status'">
      {{ feedback.text }}
    </p>
    <section class="history lease-history" aria-labelledby="lease-history-title">
      <div class="history-heading"><h3 id="lease-history-title">近期事件</h3></div>
      <p v-if="!recent.length" class="history-empty muted">还没有操作记录。</p>
      <ul v-else class="history-list lease-events">
        <li v-for="(event, index) in recent" :key="`${event.at}-${event.kind}-${index}`">
          <span class="mono muted">{{ leaseTime(event.at) }}</span>
          <span>{{ leaseEventText(event) }}</span>
          <small v-if="event.pauseAt !== undefined" class="mono muted span-row">定时截止：{{ leaseTime(event.pauseAt) }}</small>
          <small v-if="event.requestId" class="mono muted span-row">请求 ID：{{ event.requestId }}</small>
        </li>
      </ul>
    </section>
  </section>
</template>

<style scoped>
.lease-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 16px 0; }
.lease-facts dt, .tip { color: var(--muted); font-size: 12px; }
.lease-facts dd { margin-top: 4px; font-size: 13px; overflow-wrap: anywhere; }
.lease-form { border-block: 1px solid var(--line); padding: 13px 0; }
.form-title { font-size: 15px; font-weight: 650; margin-bottom: 8px; }
.tip { margin-top: 8px; line-height: 1.5; }
.block { display: block; margin-top: 4px; }
.feedback, .lease-history { margin-top: 13px; }
.lease-events { margin-top: 8px; }
.lease-events li { grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); overflow-wrap: anywhere; }
.span-row { grid-column: 1 / -1; }
</style>
