<script setup lang="ts">
import { computed } from 'vue'
import type { Sandbox } from '../model'

// 主页只回答"有哪些分组、每组整体是否健康"。单个网址的细节进入下一层。
const props = defineProps<{ sandboxes: readonly Sandbox[]; disabled: boolean }>()
const emit = defineEmits<{ open: [group: string]; openAll: []; create: [] }>()

interface GroupTile {
  key: string
  label: string
  total: number
  up: number
  problem: number
  paused: number
  pending: number
}

const ungrouped = '(未分组)'

const tiles = computed<GroupTile[]>(() => {
  const map = new Map<string, GroupTile>()
  for (const item of props.sandboxes) {
    const key = item.config.group || ungrouped
    let tile = map.get(key)
    if (!tile) {
      tile = { key, label: key, total: 0, up: 0, problem: 0, paused: 0, pending: 0 }
      map.set(key, tile)
    }
    tile.total++
    if (item.status === 'up') tile.up++
    else if (item.status === 'down' || item.status === 'degraded') tile.problem++
    else if (item.status === 'paused') tile.paused++
    else tile.pending++
  }
  // 有异常的分组排前面，其次按名称，让需要处理的内容浮到顶部。
  return [...map.values()].sort((a, b) => (b.problem - a.problem) || a.label.localeCompare(b.label, 'zh-CN'))
})

const totals = computed(() => {
  const sum = { total: 0, up: 0, problem: 0, paused: 0 }
  for (const item of props.sandboxes) {
    sum.total++
    if (item.status === 'up') sum.up++
    else if (item.status === 'down' || item.status === 'degraded') sum.problem++
    else if (item.status === 'paused') sum.paused++
  }
  return sum
})

function health(tile: GroupTile) {
  if (!tile.total) return '无配置'
  if (tile.problem) return `${tile.problem} 异常`
  if (tile.paused === tile.total) return '全部暂停'
  if (tile.up === tile.total) return '全部正常'
  return '部分待检查'
}

function tone(tile: GroupTile) {
  if (tile.problem) return 'status-down'
  if (tile.paused === tile.total) return 'status-paused'
  if (tile.up === tile.total) return 'status-up'
  return 'status-degraded'
}
</script>

<template>
  <section aria-labelledby="group-home-title">
    <div class="home-heading">
      <div>
        <h2 id="group-home-title">分组</h2>
        <p class="muted home-summary">
          {{ totals.total }} 个网址 · {{ totals.up }} 正常 · {{ totals.problem }} 异常 · {{ totals.paused }} 暂停
        </p>
      </div>
      <div class="primary-actions">
        <button v-if="totals.total" class="button" type="button" :disabled="disabled" @click="emit('openAll')">查看全部</button>
        <button class="button primary" type="button" :disabled="disabled" @click="emit('create')">＋ 添加网址</button>
      </div>
    </div>

    <div v-if="!totals.total" class="panel empty-state">
      <h3>还没有监控网址</h3>
      <p>添加项目的部署地址，平台按间隔检查并记录可用性。可以按项目或环境分组，便于分层查看。</p>
      <button class="button primary" type="button" :disabled="disabled" @click="emit('create')">添加第一个网址</button>
    </div>

    <ul v-else class="group-grid">
      <li v-for="tile in tiles" :key="tile.key">
        <button class="panel group-tile" type="button" :disabled="disabled" @click="emit('open', tile.key === ungrouped ? '' : tile.key)">
          <span class="tile-top">
            <strong class="tile-name">{{ tile.label }}</strong>
            <span class="status-pill" :class="tone(tile)">
              <span class="status-dot" aria-hidden="true"></span>{{ health(tile) }}
            </span>
          </span>
          <span class="tile-stats">
            <span><b>{{ tile.total }}</b> 个网址</span>
            <span class="up"><b>{{ tile.up }}</b> 正常</span>
            <span v-if="tile.problem" class="down"><b>{{ tile.problem }}</b> 异常</span>
            <span v-if="tile.paused" class="muted"><b>{{ tile.paused }}</b> 暂停</span>
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
.group-grid { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(268px, 1fr)); gap: 14px; }
.group-tile {
  width: 100%; display: grid; gap: 12px; padding: 18px; text-align: left; color: inherit;
  transition: border-color .15s ease, background-color .15s ease;
}
.group-tile:not(:disabled):hover { background: #1b2728; border-color: #3d5254; }
.group-tile:not(:disabled):hover .tile-open { color: var(--accent); }
.tile-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; }
.tile-name { font-size: 16px; overflow-wrap: anywhere; }
.tile-stats { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: var(--muted); }
.tile-stats b { color: #edf5f2; font-variant-numeric: tabular-nums; }
.tile-stats .up b { color: var(--accent); }
.tile-stats .down b { color: var(--danger); }
.tile-open { font-size: 12px; color: var(--muted); font-weight: 650; }
@media (prefers-reduced-motion: reduce) { .group-tile { transition: none; } }
</style>
