<script setup lang="ts">
import { computed } from 'vue'
import { displayInterval, type Sandbox } from '../model'
import StatusBadge from './StatusBadge.vue'

// 列表只保留三样东西：名称、状态、地址。分组已在上一层选定，不再重复显示。
const props = defineProps<{ items: readonly Sandbox[]; selectedId?: string; total: number }>()
const emit = defineEmits<{ select: [id: string]; create: [] }>()
const isFiltered = computed(() => props.total > 0 && !props.items.length)
</script>

<template>
  <p v-if="isFiltered" class="empty-state compact">没有符合筛选条件的网址。</p>
  <div v-else-if="!items.length" class="empty-state compact">
    <p>这个分组还没有网址。</p>
    <button class="button primary" type="button" @click="emit('create')">添加网址</button>
  </div>
  <ul v-else class="sandbox-list row-list" aria-label="网址列表">
    <li v-for="item in items" :key="item.id">
      <button class="sandbox-row slim-row" :class="{ selected: item.id === selectedId }" type="button"
        :aria-pressed="item.id === selectedId" @click="emit('select', item.id)">
        <span class="row-main">
          <strong class="row-name">{{ item.config.name }}</strong>
          <span class="row-url mono" :title="item.config.url">{{ item.config.url }}</span>
        </span>
        <StatusBadge :status="item.status" />
      </button>
    </li>
  </ul>
</template>

<style scoped>
.slim-row { grid-template-columns: minmax(0, 1fr) auto; gap: 10px; padding: 11px 14px; }
.row-url { font-size: 11px; }
@media (max-width: 560px) {
  .slim-row { grid-template-columns: minmax(0, 1fr) auto; }
  .row-url { display: none; }
}
</style>
