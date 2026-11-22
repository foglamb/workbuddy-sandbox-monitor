<script setup lang="ts">
import { computed } from 'vue'
import type { PythonAccount, PythonTask } from '../python-model'

// 主页只承载"有哪些账号"这一问题。脚本的运行细节、参数、日志都不在这里出现，
// 点开某个账号后再进入下一层，避免一屏铺开所有配置。
const props = defineProps<{
  accounts: readonly PythonAccount[]
  tasks: readonly PythonTask[]
  disabled: boolean
}>()
const emit = defineEmits<{
  open: [accountId: string]
  openOrphans: []
  createAccount: []
}>()

interface Card {
  key: string
  accountId: string | null
  name: string
  subtitle: string
  taskCount: number
  runningCount: number
  hasJWT: boolean
  hasRT: boolean
  warning: string
}

const cards = computed<Card[]>(() => {
  const list: Card[] = props.accounts.map(account => {
    const owned = props.tasks.filter(task => task.accountId === account.id)
    return {
      key: account.id,
      accountId: account.id,
      name: account.name,
      subtitle: account.uid ? `UID ${account.uid}` : '未填写 UID',
      taskCount: owned.length,
      runningCount: owned.filter(task => task.status === 'running' || task.status === 'starting').length,
      hasJWT: account.hasJWT,
      hasRT: account.hasRT,
      warning: account.hasJWT || account.hasRT ? '' : '尚未保存凭据',
    }
  })
  // 早期版本建立的独立配置不挂在任何账号上，单独成一项，否则会被彻底藏起来。
  const orphans = props.tasks.filter(task => task.accountId === null)
  if (orphans.length) {
    list.push({
      key: '__orphan__',
      accountId: null,
      name: '旧独立配置',
      subtitle: '自带凭据的早期配置',
      taskCount: orphans.length,
      runningCount: orphans.filter(task => task.status === 'running' || task.status === 'starting').length,
      hasJWT: true,
      hasRT: true,
      warning: '',
    })
  }
  return list
})

const totalRunning = computed(() => props.tasks.filter(task => task.status === 'running' || task.status === 'starting').length)

function open(card: Card) {
  if (props.disabled) return
  if (card.accountId === null) emit('openOrphans')
  else emit('open', card.accountId)
}
</script>

<template>
  <section aria-labelledby="account-home-title">
    <div class="home-heading">
      <div>
        <h2 id="account-home-title">账号</h2>
        <p class="muted home-summary">
          {{ accounts.length }} 个共享账号 · {{ tasks.length }} 份脚本配置 · {{ totalRunning }} 份运行中
        </p>
      </div>
      <button class="button primary" type="button" :disabled="disabled" @click="emit('createAccount')">＋ 新增账号</button>
    </div>

    <div v-if="!cards.length" class="panel empty-state">
      <h3>还没有账号</h3>
      <p>一个账号对应一套 BASE、UID 和令牌，可以被多份脚本配置共用。先添加账号，再为它创建脚本。</p>
      <button class="button primary" type="button" :disabled="disabled" @click="emit('createAccount')">添加第一个账号</button>
    </div>

    <ul v-else class="account-grid">
      <li v-for="card in cards" :key="card.key">
        <button class="panel account-tile" type="button" :disabled="disabled" @click="open(card)">
          <span class="tile-top">
            <strong class="tile-name">{{ card.name }}</strong>
            <span v-if="card.runningCount" class="status-pill status-up">
              <span class="status-dot" aria-hidden="true"></span>{{ card.runningCount }} 运行中
            </span>
          </span>
          <span class="tile-sub muted mono">{{ card.subtitle }}</span>
          <span class="tile-stats">
            <span>{{ card.taskCount }} 份配置</span>
            <span class="tile-cred" :class="{ missing: card.warning }">
              {{ card.warning || (card.hasJWT ? 'JWT 已保存' : 'RT 已保存') }}
            </span>
          </span>
          <span class="tile-open" aria-hidden="true">查看详情 →</span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.home-heading { display: flex; justify-content: space-between; align-items: end; flex-wrap: wrap; gap: 14px; margin-bottom: 18px; }
.home-heading h2 { font-size: 19px; }
.home-summary { margin-top: 7px; font-size: 13px; }
.account-grid { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(268px, 1fr)); gap: 14px; }
.account-tile {
  width: 100%; display: grid; gap: 10px; padding: 18px; text-align: left; color: inherit;
  transition: border-color .15s ease, background-color .15s ease;
}
.account-tile:not(:disabled):hover { background: #1b2728; border-color: #3d5254; }
.account-tile:not(:disabled):hover .tile-open { color: var(--accent); }
.tile-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; }
.tile-name { font-size: 16px; overflow-wrap: anywhere; }
.tile-sub { font-size: 12px; overflow-wrap: anywhere; }
.tile-stats { display: flex; flex-wrap: wrap; gap: 10px; font-size: 12px; color: var(--muted); }
.tile-cred { color: var(--accent); }
.tile-cred.missing { color: var(--warning); }
.tile-open { font-size: 12px; color: var(--muted); font-weight: 650; }
@media (prefers-reduced-motion: reduce) { .account-tile { transition: none; } }
</style>
