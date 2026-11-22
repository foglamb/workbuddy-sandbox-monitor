<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { errorMessage } from '../api'
import { pythonStatus, type PythonAccount, type PythonActions, type PythonField, type PythonSharedActions, type PythonTask, type PythonValue } from '../python-model'
import PythonSharedSettings from './PythonSharedSettings.vue'
import PythonTaskDetails from './PythonTaskDetails.vue'
import PythonTaskForm from './PythonTaskForm.vue'

const props = defineProps<{
  tasks: readonly PythonTask[]
  schema: readonly PythonField[]
  enabled: boolean
  actions: PythonActions
  accounts: readonly PythonAccount[]
  defaults: Readonly<Record<string, PythonValue>>
  sharedActions: PythonSharedActions
}>()
const emit = defineEmits<{ changed: []; signedOut: [] }>()
const section = shallowRef<'tasks' | 'settings'>('tasks')
const sharedBusy = shallowRef(false)
const selectedId = shallowRef('')
const editor = shallowRef<{ id?: string } | null>(null)
const commandBusy = shallowRef(false)
const formBusy = shallowRef(false)
const notice = shallowRef<{ text: string; error?: boolean } | null>(null)
// Retain the authoritative mutation response until the root's next workspace refresh arrives.
const recentTask = shallowRef<PythonTask | null>(null)
const removedId = shallowRef('')
const visibleTasks = computed(() => {
  const tasks = props.tasks.filter(task => task.id !== removedId.value)
  const recent = recentTask.value
  if (!recent) return tasks
  const index = tasks.findIndex(task => task.id === recent.id)
  if (index < 0) return [...tasks, recent]
  return tasks.map(task => task.id === recent.id ? recent : task)
})
const selected = computed(() => visibleTasks.value.find(task => task.id === selectedId.value) ?? visibleTasks.value[0])
const editingTask = computed(() => editor.value?.id ? visibleTasks.value.find(task => task.id === editor.value?.id) : undefined)
const busy = computed(() => commandBusy.value || formBusy.value || sharedBusy.value)
const runningCount = computed(() => visibleTasks.value.filter(task => task.status === 'running' || task.status === 'starting').length)
const statusClasses = { starting: 'status-degraded', running: 'status-up', stopping: 'status-degraded',
  stopped: 'status-paused', error: 'status-down' } as const

watch(() => props.tasks, () => {
  recentTask.value = null
  removedId.value = ''
  if (editor.value?.id && !props.tasks.some(task => task.id === editor.value?.id)) editor.value = null
})

function switchSection(value: 'tasks' | 'settings') {
  if (busy.value) return
  editor.value = null
  notice.value = null
  section.value = value
}

function select(id: string) {
  if (busy.value) return
  selectedId.value = id
  editor.value = null
  notice.value = null
}

function openEditor(task?: PythonTask) {
  if (!props.enabled || busy.value || (task && !editable(task))) return
  notice.value = null
  editor.value = task ? { id: task.id } : {}
}

function editable(task: PythonTask) {
  return task.status === 'stopped' || task.status === 'error'
}

function saved(task: PythonTask) {
  recentTask.value = task
  selectedId.value = task.id
  editor.value = null
  formBusy.value = false
  notice.value = { text: '脚本配置已保存。点击「启动脚本」运行此配置。' }
  emit('changed')
}

async function run(action: 'start' | 'stop' | 'remove') {
  const task = selected.value
  if (!task || !props.enabled || busy.value) return
  if ((action === 'start' || action === 'remove') && !editable(task)) return
  if (action === 'stop' && task.status !== 'running') return
  if (action === 'remove' && !window.confirm(task.accountId ? `删除「${task.name}」的沙盒配置？共享账号及其凭据会保留。` : `删除「${task.name}」及其已保存参数和凭据？`)) return
  commandBusy.value = true
  notice.value = null
  try {
    if (action === 'remove') {
      const result = await props.actions.remove(task.id)
      if (!result.ok) throw new Error('配置未删除，请刷新后重试。')
      removedId.value = task.id
      recentTask.value = null
      selectedId.value = ''
      notice.value = { text: '脚本配置已删除。' }
    } else {
      if (action === 'stop' && !task.runId) throw new Error('运行状态已变化，请刷新后重试。')
      const result = action === 'stop' && task.runId
        ? await props.actions.stop(task.id, task.runId)
        : await props.actions.start(task.id)
      recentTask.value = result.task
      selectedId.value = result.task.id
      notice.value = { text: action === 'start' ? '已提交启动，运行状态和日志将自动更新。' : '已提交停止，运行状态和日志将自动更新。' }
    }
    emit('changed')
  } catch (cause) {
    notice.value = { text: errorMessage(cause), error: true }
    emit('changed')
  } finally {
    commandBusy.value = false
  }
}
</script>

<template>
  <div class="page-heading">
    <div><h1>Python脚本</h1><p>账号和公共参数统一设置，每个沙盒只填写会话与业务地址。</p></div>
    <div class="primary-actions">
      <button class="button" type="button" :class="{ primary: section === 'tasks' }" :aria-pressed="section === 'tasks'" :disabled="busy" @click="switchSection('tasks')">脚本配置</button>
      <button class="button" type="button" :class="{ primary: section === 'settings' }" :aria-pressed="section === 'settings'" :disabled="!enabled || busy" @click="switchSection('settings')">统一设置</button>
      <button v-if="section === 'tasks'" class="button primary" type="button" :disabled="!enabled || busy" @click="openEditor()">＋ 新建沙盒配置</button>
    </div>
  </div>
  <section v-if="!enabled" class="panel empty-state disabled-state" aria-labelledby="python-disabled-title">
    <h2 id="python-disabled-title">需要设置管理口令</h2>
    <p>请在服务端设置 <code>WB_ADMIN_TOKEN</code> 并重启服务，再使用管理口令登录。Python 脚本配置、凭据查看与进程启停需要管理认证。</p>
  </section>
  <PythonSharedSettings v-else-if="section === 'settings'" :accounts="accounts" :defaults="defaults" :tasks="tasks" :schema="schema"
    :actions="sharedActions" @changed="emit('changed')" @pending="sharedBusy = $event" @signed-out="emit('signedOut')" />
  <template v-else>
    <p v-if="notice" :role="notice.error ? 'alert' : 'status'" class="notice" :class="{ error: notice.error }">{{ notice.text }}</p>
    <div class="dashboard python-dashboard">
      <section class="panel list-panel" aria-labelledby="python-list-title">
        <div class="list-heading"><h2 id="python-list-title">脚本配置</h2><small class="muted">{{ visibleTasks.length }} 项 · {{ runningCount }} 项运行中</small></div>
        <ul v-if="visibleTasks.length" class="sandbox-list" aria-label="Python 脚本配置列表">
          <li v-for="task in visibleTasks" :key="task.id">
            <button class="sandbox-row python-task-row" :class="{ selected: selected?.id === task.id && !editor }" type="button"
              :disabled="busy" :aria-pressed="selected?.id === task.id && !editor" @click="select(task.id)">
              <span class="row-main"><strong class="row-name">{{ task.name }}</strong><span class="row-url">{{ task.accountName ? `账号：${task.accountName}` : '旧独立配置' }} · {{ task.notes || '未填写备注' }}</span></span>
              <span class="status-pill" :class="statusClasses[task.status]"><span class="status-dot" aria-hidden="true"></span>{{ pythonStatus[task.status] }}</span>
            </button>
          </li>
        </ul>
        <div v-else class="empty-state">
          <h3>尚无沙盒配置</h3><p>{{ accounts.length ? '选择共享账号，填写当前沙盒的会话和业务地址。' : '先在统一设置新增共享账号，后续沙盒无需重复填写令牌。' }}</p>
          <button v-if="!accounts.length" class="button" type="button" :disabled="busy" @click="switchSection('settings')">前往统一设置</button>
          <button v-else class="button" type="button" :disabled="busy" @click="openEditor()">新建第一份配置</button>
        </div>
        <p class="scope-note list-note">运行服务端已固定的附件 Python 脚本。共享账号与公共默认值在「统一设置」维护，旧独立配置保持兼容。</p>
      </section>
      <PythonTaskForm v-if="editor" :key="editor.id ?? 'new'" :task="editingTask" :schema="schema" :accounts="accounts" :defaults="defaults" :actions="actions"
        @saved="saved" @pending="formBusy = $event" @cancel="editor = null" @settings="switchSection('settings')" />
      <PythonTaskDetails v-else-if="selected" :key="selected.id" :task="selected" :schema="schema" :enabled="enabled" :busy="busy"
        :actions="actions" @edit="openEditor(selected)" @start="run('start')" @stop="run('stop')" @remove="run('remove')" />
      <section v-else class="panel detail empty-details" aria-labelledby="python-empty-title">
        <h2 id="python-empty-title">脚本配置详情</h2><p class="muted">新建或选择配置后，可查看已保存参数、按需查看凭据，并启动或停止脚本。</p>
      </section>
    </div>
  </template>
</template>

<style scoped>
.python-dashboard { grid-template-columns: minmax(240px, .65fr) minmax(0, 1.35fr); }
.python-task-row { grid-template-columns: minmax(0, 1fr) auto; }
.python-task-row:disabled { opacity: .65; }
.list-note { padding: 0 18px 18px; }
.disabled-state p { max-width: 700px; margin: 14px auto 0; line-height: 1.8; }
@media (max-width: 920px) {
  .python-dashboard { grid-template-columns: minmax(0, 1fr); }
}
</style>
