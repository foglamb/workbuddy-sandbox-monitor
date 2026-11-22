<script setup lang="ts">
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { errorMessage } from '../api'
import { pythonStatus, type PythonActions, type PythonField, type PythonTask, type PythonValue } from '../python-model'
import PythonTaskLogs from './PythonTaskLogs.vue'

const props = defineProps<{
  task: PythonTask
  schema: readonly PythonField[]
  enabled: boolean
  busy: boolean
  actions: Pick<PythonActions, 'reveal' | 'logs' | 'clearLogs'>
}>()
const emit = defineEmits<{ edit: []; start: []; stop: []; remove: [] }>()
const editable = computed(() => props.task.status === 'stopped' || props.task.status === 'error')
const memory = computed(() => (props.task.memoryBytes === null ? '—' : `${(props.task.memoryBytes / 1024 / 1024).toFixed(1)} MiB`))
const statusClass = computed(() => ({ starting: 'status-degraded', running: 'status-up', stopping: 'status-degraded',
  stopped: 'status-paused', error: 'status-down' })[props.task.status])
const credentials = shallowRef<{ JWT: string; RT: string } | null>(null)
const revealing = shallowRef(false)
const revealError = shallowRef('')
let revealVersion = 0
const sandboxKeys = new Set(['CONV_ID', 'SITE', 'SITE_ENABLE'])
function source(key: string) {
  if (!props.task.accountId) return '独立保存'
  if (key === 'BASE' || key === 'UID') return '共享账号'
  if (sandboxKeys.has(key)) return '当前沙盒'
  return props.task.overrideKeys.includes(key) ? '沙盒覆盖' : '继承统一默认'
}
const fields = computed(() => {
  const known = new Set(props.schema.map(field => field.key))
  return [
    ...props.schema.map(field => ({ key: field.key, label: field.label, group: field.group || '脚本参数',
      value: props.task.params[field.key], saved: Object.hasOwn(props.task.params, field.key), source: source(field.key) })),
    ...Object.entries(props.task.params).filter(([key]) => !known.has(key)).map(([key, value]) =>
      ({ key, label: key, group: '其他参数', value, saved: true, source: source(key) })),
  ]
})
const basicFields = computed(() => fields.value.filter(field => sandboxKeys.has(field.key)))
const groups = computed(() => {
  const result = new Map<string, typeof fields.value>()
  for (const field of fields.value.filter(item => !sandboxKeys.has(item.key))) {
    if (!result.has(field.group)) result.set(field.group, [])
    result.get(field.group)!.push(field)
  }
  return [...result].map(([name, fields]) => ({ name, fields }))
})
const snapshot = computed(() => Object.entries(props.task.runningParams ?? {}).map(([key, value]) => ({
  key, label: props.schema.find(field => field.key === key)?.label ?? key, value,
})))
function displayValue(value: PythonValue | undefined, saved = true) {
  if (!saved) return '未保存'
  return value === '' ? '（空字符串）' : String(value)
}
function dateTime(value: number | null) { return value === null ? '—' : new Date(value).toLocaleString('zh-CN', { hour12: false }) }
function hideCredentials() { revealVersion++; credentials.value = null; revealing.value = false; revealError.value = '' }
async function revealCredentials() {
  if (revealing.value || !props.enabled) return
  if (credentials.value) { hideCredentials(); return }
  const version = ++revealVersion, id = props.task.id
  revealing.value = true
  revealError.value = ''
  try {
    const result = await props.actions.reveal(id)
    if (version === revealVersion && props.task.id === id) credentials.value = result.credentials
  } catch (cause) { if (version === revealVersion) revealError.value = errorMessage(cause) }
  finally { if (version === revealVersion) revealing.value = false }
}
watch([() => props.task.id, () => props.task.accountId, () => props.task.hasJWT, () => props.task.hasRT], hideCredentials)
onScopeDispose(hideCredentials)
</script>

<template>
  <section class="panel detail python-details" aria-labelledby="python-detail-title">
    <div class="detail-heading"><h2 id="python-detail-title">{{ task.name }}</h2><span class="status-pill" :class="statusClass"><span class="status-dot" aria-hidden="true"></span>{{ pythonStatus[task.status] }}</span></div>
    <div class="detail-actions">
      <button v-if="editable" class="button primary" type="button" :disabled="busy || !enabled" @click="emit('start')">启动脚本</button>
      <button v-else-if="task.status === 'running'" class="button" type="button" :disabled="busy || !enabled" @click="emit('stop')">停止脚本</button>
      <button v-else class="button" type="button" disabled>{{ task.status === 'starting' ? '正在启动…' : '正在停止…' }}</button>
      <button class="button" type="button" :disabled="busy || !enabled || !editable" @click="emit('edit')">编辑配置</button>
      <button class="button danger" type="button" :disabled="busy || !enabled || !editable" @click="emit('remove')">删除配置</button>
    </div>
    <p v-if="!editable" class="scope-note">停止脚本后才可编辑或删除配置。</p>
    <p v-if="task.lastError" role="alert" class="notice error task-error">{{ task.lastError }}</p>
    <dl class="run-metadata"><div><dt>进程 PID</dt><dd class="mono">{{ task.pid ?? '—' }}</dd></div><div><dt>内存占用</dt><dd class="mono">{{ memory }}</dd></div><div><dt>最近退出码</dt><dd class="mono">{{ task.lastExitCode ?? '—' }}</dd></div><div><dt>最近启动</dt><dd>{{ dateTime(task.lastStartedAt) }}</dd></div><div><dt>最近停止</dt><dd>{{ dateTime(task.lastStoppedAt) }}</dd></div></dl>

    <section class="saved-config" aria-labelledby="python-saved-title">
      <h3 id="python-saved-title" class="section-title">{{ editable ? '有效配置与来源' : '下次启动有效配置与来源' }}</h3>
      <dl class="parameter-values">
        <div class="parameter-row"><dt>配置名称</dt><dd>{{ task.name }}</dd></div>
        <div class="parameter-row"><dt>备注</dt><dd>{{ task.notes || '（未填写）' }}</dd></div>
        <div class="parameter-row"><dt>账号来源</dt><dd>{{ task.accountId ? `共享账号：${task.accountName || task.accountId}` : '旧独立配置（保留原账号资料）' }}</dd></div>
        <div v-for="field in basicFields" :key="field.key" class="parameter-row"><dt>{{ field.label }}<small class="mono parameter-key">{{ field.key }}</small></dt><dd class="mono">{{ displayValue(field.value, field.saved) }}<small class="source-label">{{ field.source }}</small></dd></div>
      </dl>
      <details v-if="groups.length" class="parameter-disclosure">
        <summary>{{ task.accountId ? '公共参数与来源（含单独覆盖）' : '原独立配置参数' }}</summary>
        <section v-for="group in groups" :key="group.name" class="saved-group" :aria-label="group.name">
          <h4 class="group-title">{{ group.name }}</h4>
          <dl class="parameter-values"><div v-for="field in group.fields" :key="field.key" class="parameter-row"><dt>{{ field.label }}<small class="mono parameter-key">{{ field.key }}</small></dt><dd class="mono">{{ displayValue(field.value, field.saved) }}<small class="source-label" :class="{ overridden: field.source === '沙盒覆盖' }">{{ field.source }}</small></dd></div></dl>
        </section>
      </details>
    </section>

    <section v-if="!editable" class="snapshot-section" aria-label="当前运行参数">
      <p class="scope-note snapshot-note">当前进程使用启动快照，修改统一配置仅下次启动生效。</p>
      <details v-if="task.runningParams" class="parameter-disclosure"><summary>查看当前进程启动快照</summary><dl class="parameter-values snapshot-values"><div v-for="field in snapshot" :key="field.key" class="parameter-row"><dt>{{ field.label }}<small class="mono parameter-key">{{ field.key }}</small></dt><dd class="mono">{{ displayValue(field.value) }}</dd></div></dl></details>
    </section>

    <section class="saved-credentials" aria-labelledby="python-credentials-title">
      <div class="credential-heading"><h3 id="python-credentials-title" class="section-title">已保存凭据</h3><button class="button" type="button" :disabled="revealing || !enabled" :aria-expanded="Boolean(credentials)" @click="revealCredentials">{{ revealing ? '正在读取…' : credentials ? '隐藏凭据' : '查看已保存凭据' }}</button></div>
      <p class="scope-note credential-status">{{ task.accountId ? `来自共享账号「${task.accountName || task.accountId}」` : '来自此独立配置' }} · JWT：{{ task.hasJWT ? '已保存' : '未保存' }} · RT：{{ task.hasRT ? '已保存' : '未保存' }}。默认隐藏。</p>
      <p v-if="revealError" role="alert" class="notice error task-error">{{ revealError }}</p>
      <div v-if="credentials" class="revealed-credentials"><label>JWT<textarea class="mono" :value="credentials.JWT" readonly rows="3" spellcheck="false" placeholder="未保存 JWT" /></label><label>RT<textarea class="mono" :value="credentials.RT" readonly rows="3" spellcheck="false" placeholder="未保存 RT" /></label></div>
    </section>
    <PythonTaskLogs :task-id="task.id" :enabled="enabled" :read-logs="actions.logs" :clear-logs="actions.clearLogs" />
  </section>
</template>

<style scoped>
.python-details { min-width: 0; }.detail-heading { align-items: start; flex-wrap: wrap; }.detail-heading h2 { flex: 1; min-width: 120px; }.task-error { margin-top: 14px; }
.run-metadata { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; padding: 16px; margin: 20px 0; border: 1px solid var(--line); border-radius: 9px; }.run-metadata dt { color: var(--muted); font-size: 12px; }.run-metadata dd { margin-top: 5px; font-size: 13px; overflow-wrap: anywhere; }
.section-title { font-size: 15px; }.group-title { color: #d2e2dd; margin: 20px 0 8px; font-size: 13px; }.parameter-values { margin-top: 10px; }
.parameter-row { display: grid; grid-template-columns: minmax(100px, .85fr) minmax(0, 1.2fr); gap: 14px; padding: 10px 0; border-bottom: 1px solid var(--line); font-size: 13px; line-height: 1.6; }.parameter-row dt { color: var(--muted); min-width: 0; overflow-wrap: anywhere; }.parameter-row dd { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }.parameter-key { display: block; font-size: 11px; }.source-label { display: block; margin-top: 3px; font-family: system-ui, sans-serif; font-size: 11px; color: var(--muted); }.source-label.overridden { color: var(--warning); }
.parameter-disclosure { margin-top: 18px; }.parameter-disclosure summary { cursor: pointer; font-size: 13px; line-height: 1.6; color: var(--accent); }.snapshot-section { margin-top: 20px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; }.snapshot-note { margin: 0; }.snapshot-values { max-height: 420px; overflow: auto; }
.saved-credentials { margin-top: 24px; }.credential-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }.credential-status { margin-top: 10px; }.revealed-credentials { display: grid; gap: 12px; margin-top: 14px; }.revealed-credentials label { display: grid; gap: 6px; min-width: 0; font-size: 13px; }.revealed-credentials textarea { width: 100%; resize: vertical; line-height: 1.5; }
@media (max-width: 530px) { .parameter-row { grid-template-columns: minmax(0, 1fr); gap: 4px; } }
</style>
