<script setup lang="ts">
import { computed, nextTick, shallowRef, useTemplateRef } from 'vue'
import { errorMessage } from './api'
import BatchPauseDialog from './components/BatchPauseDialog.vue'
import ConfigDialog from './components/ConfigDialog.vue'
import LeaseView from './components/LeaseView.vue'
import OverviewView from './components/OverviewView.vue'
import PythonConsole from './components/PythonConsole.vue'
import SandboxDetails from './components/SandboxDetails.vue'
import SandboxList from './components/SandboxList.vue'
import { useMonitor } from './composables/useMonitor'
import { checkText, defaultConfig, type Sandbox, type SandboxConfig, type SandboxStatus } from './model'
import type { OverviewTarget } from './overview'
import { collectPauseCandidates, type PauseCandidate } from './task-model'

const { workspace, locked, loading, error, authenticated, remember, api, refresh, signIn, signOut } = useMonitor()
const view = shallowRef<'python' | 'overview' | 'urls' | 'leases'>('python')
const selectedLeaseId = shallowRef('')
const password = shallowRef('')
const rememberOnThisDevice = shallowRef(false)
const query = shallowRef('')
const groupFilter = shallowRef('')
const statusFilter = shallowRef<SandboxStatus | 'all' | 'problem'>('all')
const selectedId = shallowRef('')
const notice = shallowRef<{ text: string; error?: boolean } | null>(null)
const editor = shallowRef<{ id?: string; title: string; config: SandboxConfig } | null>(null)
const editorError = shallowRef('')
const busy = shallowRef(false)
const fileInput = useTemplateRef('import-file')
const pauseCandidates = shallowRef<PauseCandidate[] | null>(null)

function openBatchPause() {
  if (!workspace.value || busy.value) return
  pauseCandidates.value = collectPauseCandidates(workspace.value.sandboxes, workspace.value.leases)
}

const pythonTasks = computed(() => workspace.value?.pythonTasks.map(task => ({ ...task, overrideKeys: [...task.overrideKeys] })) ?? [])
const sandboxes = computed(() => workspace.value?.sandboxes ?? [])
// 实例保活只在服务端配置了 WB_AGS_BINDINGS 时才有意义；未配置时整块入口隐藏。
const hasLeases = computed(() => (workspace.value?.leases.length ?? 0) > 0)
const groups = computed(() => [...new Set(sandboxes.value.map(item => item.config.group).filter(Boolean))].sort())
const counts = computed(() => {
  const count = { all: sandboxes.value.length, up: 0, problem: 0, paused: 0, pending: 0 }
  for (const { status } of sandboxes.value) {
    if (status === 'down' || status === 'degraded') count.problem++
    else count[status]++
  }
  return count
})
const visible = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return sandboxes.value.filter(({ config, status }) => {
    const matchesSearch = !needle || [config.name, config.group, config.url].some(value => value.toLowerCase().includes(needle))
    const matchesGroup = !groupFilter.value || config.group === groupFilter.value
    const matchesStatus = statusFilter.value === 'all' || status === statusFilter.value ||
      (statusFilter.value === 'problem' && (status === 'down' || status === 'degraded'))
    return matchesSearch && matchesGroup && matchesStatus
  })
})
const selected = computed(() => visible.value.find(item => item.id === selectedId.value) ?? visible.value[0])
const originHint = computed(() => 'HTTP(S)')
const atCapacity = computed(() => Boolean(workspace.value && sandboxes.value.length >= workspace.value.maxSandboxes))

async function unlock() {
  const value = password.value
  password.value = ''
  await signIn(value, rememberOnThisDevice.value)
}

function logout() {
  notice.value = null
  editor.value = null
  pauseCandidates.value = null
  signOut()
}

function clearFilters() {
  query.value = ''
  groupFilter.value = ''
  statusFilter.value = 'all'
}

async function openFinding(target: OverviewTarget) {
  if (target.kind === 'url') {
    clearFilters()
    selectedId.value = target.id
    view.value = 'urls'
  } else {
    selectedLeaseId.value = target.id
    view.value = 'leases'
  }
  await nextTick()
  const heading = target.kind === 'url' ? 'sandbox-detail-title' : 'lease-detail-title'
  document.getElementById(heading)?.focus()
}

function openEditor(mode: 'create' | 'edit' | 'copy', item?: Sandbox) {
  editorError.value = ''
  if (mode === 'edit' && item) {
    editor.value = { id: item.id, title: '编辑沙盒配置', config: { ...item.config } }
  } else if (mode === 'copy' && item) {
    editor.value = { title: '复制沙盒配置', config: { ...item.config,
      name: `${item.config.name.slice(0, 55)}（副本）`, enabled: false } }
  } else {
    editor.value = { title: '添加沙盒', config: { ...defaultConfig } }
  }
}

async function save(config: SandboxConfig) {
  if (!editor.value || busy.value) return
  const id = editor.value.id
  busy.value = true
  editorError.value = ''
  try {
    const { sandbox } = id ? await api.edit(id, config) : await api.add(config)
    clearFilters()
    selectedId.value = sandbox.id
    editor.value = null
    notice.value = { text: '沙盒配置已保存。' }
    await refresh()
  } catch (cause) {
    editorError.value = errorMessage(cause)
  } finally {
    busy.value = false
  }
}

async function runAction(work: () => Promise<string>) {
  if (busy.value) return
  busy.value = true
  notice.value = null
  try {
    const text = await work()
    notice.value = { text }
    await refresh()
  } catch (cause) {
    notice.value = { text: errorMessage(cause), error: true }
  } finally {
    busy.value = false
  }
}

function check(item: Sandbox) {
  return runAction(async () => {
    const { result } = await api.check(item.id)
    return `检查完成 · ${checkText(result)} · ${result.durationMs} ms`
  })
}

function toggle(item: Sandbox) {
  return runAction(async () => {
    await api.enable(item.id, !item.config.enabled)
    return item.config.enabled ? '已暂停定时检查。' : '已启用定时检查。'
  })
}

function remove(item: Sandbox) {
  if (!window.confirm(`删除「${item.config.name}」及其检查记录？`)) return
  return runAction(async () => {
    await api.remove(item.id)
    if (groupFilter.value === item.config.group) groupFilter.value = ''
    return '沙盒配置和检查记录已删除。'
  })
}

function exportBackup() {
  const configs = sandboxes.value.map(item => item.config)
  const backup = JSON.stringify({ version: 1, configs }, null, 2)
  const url = URL.createObjectURL(new Blob([backup], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'workbuddy-sandboxes.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function importBackup(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  return runAction(async () => {
    if (file.size > 512 * 1024) throw new Error('备份文件超过 512 KiB')
    let data: unknown
    try {
      data = JSON.parse(await file.text())
    } catch {
      throw new Error('请选择有效的 JSON 备份文件')
    }
    const { count } = await api.importBackup(data)
    clearFilters()
    return `已导入 ${count} 项配置，状态为已暂停。`
  })
}
</script>

<template>
  <header class="site-header">
    <div class="frame header-inner">
      <div class="brand"><span class="brand-mark" aria-hidden="true"></span>WorkBuddy <span class="brand-label">保活平台</span></div>
      <div class="server-controls">
        <span v-if="workspace" class="server-state" :class="{ disconnected: error }">
          <span class="status-dot" aria-hidden="true"></span>{{ error ? '连接异常' : '监控服务在线' }}
        </span>
        <button v-if="authenticated" class="button" type="button" :disabled="busy" @click="logout">退出</button>
      </div>
    </div>
  </header>

  <main class="frame main">
    <nav v-if="workspace && !locked" class="workspace-nav" aria-label="平台功能">
      <button class="button" type="button" :class="{ primary: view === 'python' }" :aria-pressed="view === 'python'"
        :disabled="busy" @click="view = 'python'">Python脚本</button>
      <button class="button" type="button" :class="{ primary: view === 'overview' }" :aria-pressed="view === 'overview'"
        :disabled="busy" @click="view = 'overview'">运行总览</button>
      <button class="button" type="button" :class="{ primary: view === 'urls' }" :aria-pressed="view === 'urls'"
        :disabled="busy" @click="view = 'urls'">网址监控</button>
      <button v-if="hasLeases" class="button" type="button" :class="{ primary: view === 'leases' }"
        :aria-pressed="view === 'leases'" :disabled="busy" @click="view = 'leases'">实例保活</button>
    </nav>
    <p v-if="workspace && !locked && error" role="alert" class="notice error">{{ error }}。下方显示最后一次取得的状态。</p>
    <section v-if="locked" class="panel gate" aria-labelledby="sign-in-title">
      <h1 id="sign-in-title">登录管理台</h1>
      <p class="muted">输入部署时设置的管理口令。</p>
      <form class="login-form" @submit.prevent="unlock">
        <label>管理口令<input v-model="password" type="password" maxlength="128" autocomplete="current-password" required /></label>
        <label class="remember-device">
          <input v-model="rememberOnThisDevice" type="checkbox">
          在此设备上保持登录（关闭浏览器后仍有效）
        </label>
        <p class="muted remember-hint">不勾选时刷新页面无需重输，关闭标签页后需重新登录。</p>
        <p v-if="error" role="alert" class="notice error">{{ error }}</p>
        <button class="button primary" type="submit" :disabled="loading">{{ loading ? '正在验证…' : '登录' }}</button>
      </form>
    </section>

    <section v-else-if="!workspace" class="panel gate" aria-labelledby="connect-title">
      <h1 id="connect-title">连接监控服务</h1>
      <p v-if="error" role="alert" class="notice error">{{ error }}</p>
      <p v-else class="muted" role="status">正在读取沙盒配置…</p>
      <button v-if="error" class="button primary" type="button" :disabled="loading" @click="refresh">重新连接</button>
    </section>

    <PythonConsole v-else-if="view === 'python'" :tasks="pythonTasks" :schema="workspace.pythonSchema"
      :accounts="workspace.pythonAccounts" :defaults="workspace.pythonDefaults" :shared-actions="api.pythonShared"
      :enabled="workspace.pythonEnabled" :actions="api.python" @changed="refresh" @signed-out="signOut" />
    <OverviewView v-else-if="view === 'overview'" :sandboxes="workspace.sandboxes" :leases="workspace.leases"
      :server-time="workspace.serverTime" @open="openFinding" @configure="view = 'urls'; openEditor('create')" @pause="openBatchPause" />
    <LeaseView v-else-if="view === 'leases' && hasLeases" v-model:selected-id="selectedLeaseId"
      :leases="workspace.leases" :update="api.updateLease" :query="api.queryLease" @changed="refresh" />
    <template v-else>
      <div class="page-heading">
        <div><h1>沙盒部署</h1><p>统一跟踪 WorkBuddy 部署网址的可用性与响应耗时。</p></div>
        <div class="primary-actions">
          <input ref="import-file" type="file" accept="application/json,.json" hidden @change="importBackup" />
          <button class="button" type="button" :disabled="busy || atCapacity" @click="fileInput?.click()">导入</button>
          <button class="button" type="button" :disabled="!counts.all" @click="exportBackup">导出</button>
          <button class="button primary" type="button" :disabled="busy || atCapacity" @click="openEditor('create')">＋ 添加沙盒</button>
        </div>
      </div>
      <div class="summary" aria-label="部署概况">
        <div class="stat"><span>全部配置</span><strong>{{ counts.all }}<small> / {{ workspace.maxSandboxes }}</small></strong></div>
        <div class="stat"><span>正常</span><strong class="text-up">{{ counts.up }}</strong></div>
        <div class="stat"><span>异常</span><strong class="text-down">{{ counts.problem }}</strong></div>
        <div class="stat"><span>已暂停</span><strong>{{ counts.paused }}</strong></div>
      </div>
      <p v-if="notice" :role="notice.error ? 'alert' : 'status'" class="notice" :class="{ error: notice.error }">{{ notice.text }}</p>
      <div class="dashboard">
        <section class="panel list-panel" aria-labelledby="list-title">
          <div class="list-heading"><h2 id="list-title">沙盒列表</h2><small v-if="counts.pending" class="muted">{{ counts.pending }} 项待检查</small></div>
          <div class="filters" v-if="counts.all">
            <input v-model="query" aria-label="搜索沙盒" placeholder="搜索名称、网址" />
            <select v-model="groupFilter" aria-label="按分组筛选">
              <option value="">全部分组</option><option v-for="group in groups" :key="group">{{ group }}</option>
            </select>
            <select v-model="statusFilter" aria-label="按状态筛选">
              <option value="all">全部状态</option><option value="up">正常</option><option value="problem">异常</option>
              <option value="paused">已暂停</option><option value="pending">待检查</option>
            </select>
          </div>
          <SandboxList :items="visible" :selected-id="selected?.id" :total="counts.all"
            @select="selectedId = $event" @create="openEditor('create')" />
        </section>
        <SandboxDetails v-if="selected" :sandbox="selected" :busy="busy" :history="api.history"
          @edit="openEditor('edit', selected)" @check="check(selected)" @toggle="toggle(selected)"
          @copy="openEditor('copy', selected)" @remove="remove(selected)" />
        <section v-else class="panel detail empty-details" aria-labelledby="detail-title">
          <h2 id="detail-title">检查详情</h2><p class="muted">选择沙盒后可查看 {{ originHint }} 检查结果和下次检查时间。</p>
        </section>
      </div>
      <footer class="scope-note">状态来自部署网址的 HTTP 响应。沙盒的启动与休眠由 WorkBuddy 管理。</footer>
    </template>
    <BatchPauseDialog v-if="pauseCandidates && workspace && !locked" :candidates="pauseCandidates" :submit="api.pauseTasks"
      @close="pauseCandidates = null" @changed="refresh" />
    <ConfigDialog v-if="editor" :initial="editor.config" :title="editor.title" :error="editorError"
      :allow-http="workspace?.allowHttp ?? false" :busy="busy" @save="save" @close="editor = null" />
  </main>
</template>
