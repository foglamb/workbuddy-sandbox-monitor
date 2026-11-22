<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import { pythonStatus, type PythonAccount, type PythonTask } from '../python-model'

// 第二层：某个账号下的脚本清单。这里只回答"这个账号有哪些脚本、各自是否在跑"，
// 具体参数与日志留在第三层，避免一次铺开所有字段。
const props = defineProps<{
  account: PythonAccount | null
  tasks: readonly PythonTask[]
  disabled: boolean
}>()
const emit = defineEmits<{
  back: []
  open: [taskId: string]
  createTask: []
  reveal: []
  editAccount: []
}>()

const running = computed(() => props.tasks.filter(task => task.status === 'running' || task.status === 'starting').length)
const title = computed(() => props.account?.name ?? '旧独立配置')
const revealedOpen = shallowRef(false)

function toggleReveal() {
  revealedOpen.value = !revealedOpen.value
  emit('reveal')
}
</script>

<template>
  <section aria-labelledby="account-detail-title">
    <div class="detail-bar">
      <button class="button back" type="button" @click="emit('back')">← 返回账号列表</button>
      <div class="detail-actions">
        <button v-if="account" class="button" type="button" :disabled="disabled" @click="emit('editAccount')">编辑账号</button>
        <button v-if="account" class="button" type="button" :disabled="disabled" :aria-expanded="revealedOpen" @click="toggleReveal">
          {{ revealedOpen ? '隐藏凭据' : '查看凭据' }}
        </button>
        <button class="button primary" type="button" :disabled="disabled" @click="emit('createTask')">＋ 新建脚本</button>
      </div>
    </div>

    <div class="panel account-head">
      <div class="head-main">
        <h2 id="account-detail-title">{{ title }}</h2>
        <p v-if="account" class="muted mono">{{ account.base }}</p>
        <p v-else class="muted">这些配置在账号共用功能之前创建，各自保存凭据，不随账号设置变化。</p>
      </div>
      <dl class="head-stats">
        <div><dt>脚本配置</dt><dd>{{ tasks.length }}</dd></div>
        <div><dt>运行中</dt><dd :class="{ 'text-up': running }">{{ running }}</dd></div>
        <div v-if="account"><dt>UID</dt><dd class="mono small">{{ account.uid || '—' }}</dd></div>
      </dl>
    </div>

    <div class="panel list-panel script-panel">
      <div class="list-heading">
        <h3>脚本配置</h3>
        <small class="muted">{{ tasks.length }} 项 · {{ running }} 项运行中</small>
      </div>
      <ul v-if="tasks.length" class="sandbox-list" aria-label="此账号下的脚本配置">
        <li v-for="task in tasks" :key="task.id">
          <button class="sandbox-row task-row" type="button" :disabled="disabled" @click="emit('open', task.id)">
            <span class="row-main">
              <strong class="row-name">{{ task.name }}</strong>
              <span class="row-sub muted">{{ task.params.CONV_ID || '未填会话 ID' }}</span>
            </span>
            <span class="status-pill" :class="{
              starting: 'status-degraded', running: 'status-up', stopping: 'status-degraded',
              stopped: 'status-paused', error: 'status-down',
            }[task.status]">
              <span class="status-dot" aria-hidden="true"></span>{{ pythonStatus[task.status] }}
            </span>
            <span class="row-chevron" aria-hidden="true">›</span>
          </button>
        </li>
      </ul>
      <div v-else class="empty-state">
        <h3>这个账号下还没有脚本</h3>
        <p>新建脚本时只需填写会话 ID 与业务地址，令牌沿用账号。</p>
        <button class="button primary" type="button" :disabled="disabled" @click="emit('createTask')">新建第一份脚本</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.detail-bar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
.button.back { padding-left: 10px; }
.account-head { display: flex; justify-content: space-between; align-items: start; flex-wrap: wrap; gap: 18px; padding: 20px; margin-bottom: 16px; }
.head-main { min-width: 0; }
.head-main h2 { font-size: 22px; overflow-wrap: anywhere; }
.head-main p { margin-top: 8px; font-size: 13px; overflow-wrap: anywhere; }
.head-stats { display: flex; gap: 26px; margin: 0; }
.head-stats dt { color: var(--muted); font-size: 12px; }
.head-stats dd { margin: 5px 0 0; font-size: 22px; line-height: 1; font-variant-numeric: tabular-nums; }
.head-stats dd.small { font-size: 14px; }
.script-panel { min-width: 0; }
.list-heading h3 { font-size: 16px; }
.task-row { grid-template-columns: minmax(0, 1fr) auto auto; }
.row-sub { font-size: 12px; }
.row-chevron { color: var(--muted); font-size: 18px; line-height: 1; }
@media (max-width: 620px) {
  .account-head { flex-direction: column; }
  .head-stats { gap: 18px; }
}
</style>
