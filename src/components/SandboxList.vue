<script setup lang="ts">
import { computed } from 'vue'
import { displayInterval, type Sandbox } from '../model'
import StatusBadge from './StatusBadge.vue'

const props = defineProps<{ items: readonly Sandbox[]; selectedId?: string; total: number }>()
const emit = defineEmits<{ select: [id: string]; create: [] }>()
const isFiltered = computed(() => props.total > 0 && !props.items.length)
</script>

<template>
  <p v-if="isFiltered" class="empty-state compact">没有符合筛选条件的配置。</p>
  <div v-else-if="!items.length" class="empty-state">
    <h3>还没有沙盒配置</h3>
    <p>添加项目的部署网址，开始独立监控。</p>
    <button class="button primary" type="button" @click="emit('create')">添加第一个沙盒</button>
  </div>
  <ul v-else class="sandbox-list" aria-label="沙盒部署列表">
    <li v-for="item in items" :key="item.id">
      <button class="sandbox-row" :class="{ selected: item.id === selectedId }" type="button"
        :aria-pressed="item.id === selectedId" @click="emit('select', item.id)">
        <span class="row-main">
          <strong class="row-name">{{ item.config.name }}</strong>
          <span class="row-url mono" :title="item.config.url">{{ item.config.url }}</span>
        </span>
        <span class="row-meta">{{ item.config.group || '未分组' }} · {{ displayInterval(item.config.intervalSec) }}</span>
        <StatusBadge :status="item.status" />
      </button>
    </li>
  </ul>
</template>
