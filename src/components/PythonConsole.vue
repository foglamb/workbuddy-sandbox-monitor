<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { errorMessage } from '../api'
import { pythonStatus, type PythonAccount, type PythonActions, type PythonField, type PythonSharedActions, type PythonTask, type PythonValue } from '../python-model'
import AccountHome from './AccountHome.vue'
import AccountScripts from './AccountScripts.vue'
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
// 三级视图：账号列表 → 某账号下的脚本 → 某份脚本的详情。
// 打开某个层级时清空下一层，避免保留了不该看到的上一个账号的内容。
const openAccountId = shallowRef<string | null | undefined>(undefined)
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
// 当前处在第几层：'' = 账号列表，'__orphan__' = 旧独立配置，其余为账号 id。
const accountTasks = computed(() => openAccountId.value === '__orphan__'
  ? visibleTasks.value.filter(task => task.accountId === null)
  : visibleTasks.value.filter(task => task.accountId === openAccountId.value))
const openAccount = computed(() => props.accounts.find(account => account.id === openAccountId.value) ?? null)
const level = computed<'home' | 'account' | 'task'>(() => {
  if (editor.value || selectedId.value) return 'task'
  return openAccountId.value === undefined ? 'home' : 'account'
})
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
  if (value === 'tasks') {
    selectedId.value = ''
    openAccountId.value = undefined
  }
}

function enterAccount(id: string | null) {
  if (busy.value) return
  selectedId.value = ''
  editor.value = null
  notice.value = null
  openAccountId.value = id === null ? '__orphan__' : id
}

function backToAccounts() {
  if (busy.value) return
  selectedId.value = ''
  editor.value = null
  notice.value = null
  openAccountId.value = undefined
}

function select(id: string) {
  if (busy.value) return
  selectedId.value = id
  editor.value = null
  notice.value = null
}

// 从账号层新建脚本时，默认带上该账号，省去重复选择。
const draftAccountId = computed(() => (openAccountId.value && openAccountId.value !== '__orphan__' ? openAccountId.value : undefined))

function openEditor(task?: PythonTask) {
  if (!props.enabled || busy.value || (task && !editable(task))) return
  notice.value = null
  if (task) {
    // 编辑已有脚本时定位到它所属的账号层，返回时才落到正确层级。
    openAccountId.value = task.accountId ?? '__orphan__'
    selectedId.value = task.id
  }
  editor.value = task ? { id: task.id } : {}
}

function editable(task: PythonTask) {
  return task.status === 'stopped' || task.status === 'error'
}

function saved(task: PythonTask) {
  recentTask.value = task
  selectedId.value = task.id
  openAccountId.value = task.accountId ?? '__orphan__'
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
    <div>
      <h1>Python脚本</h1>
      <p>账号在最外层，点开账号查看它名下的脚本，再点开脚本看参数与日志。</p>
    </div>
    <div class="primary-actions">
      <button class="button" type="button" :class="{ primary: section === 'tasks' }" :aria-pressed="section === 'tasks'"
        :disabled="busy" @click="switchSection('tasks')">脚本</button>
      <button class="button" type="button" :class="{ primary: section === 'settings' }" :aria-pressed="section === 'settings'"
        :disabled="!enabled || busy" @click="switchSection('settings')">设置</button>
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

    <AccountHome v-if="level === 'home'" :accounts="accounts" :tasks="visibleTasks" :disabled="busy"
      @open="enterAccount" @open-orphans="enterAccount(null)" @create-account="switchSection('settings')" />

    <template v-else-if="level === 'account'">
      <AccountScripts :account="openAccount" :tasks="accountTasks" :disabled="busy"
        @back="backToAccounts" @open="select" @create-task="openEditor()" @edit-account="switchSection('settings')" />
    </template>

    <template v-else>
      <div class="detail-bar">
        <button class="button back" type="button" @click="selectedId = ''; editor = null">← 返回脚本列表</button>
      </div>
      <PythonTaskForm v-if="editor" :key="editor.id ?? 'new'" :task="editingTask" :schema="schema" :accounts="accounts"
        :defaults="defaults" :actions="actions" :preset-account-id="draftAccountId"
        @saved="saved" @pending="formBusy = $event" @cancel="editor = null; selectedId = ''" @settings="switchSection('settings')" />
      <PythonTaskDetails v-else-if="selected" :key="selected.id" :task="selected" :schema="schema" :enabled="enabled" :busy="busy"
        :actions="actions" @edit="openEditor(selected)" @start="run('start')" @stop="run('stop')" @remove="run('remove')" />
    </template>
  </template>
</template>

<style scoped>
.detail-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.button.back { padding-left: 10px; }
.disabled-state p { max-width: 700px; margin: 14px auto 0; line-height: 1.8; }
</style>
