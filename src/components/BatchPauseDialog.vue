<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, useTemplateRef } from 'vue'
import { errorMessage } from '../api'
import { taskKey, type PauseCandidate, type PauseResult, type TaskTarget } from '../task-model'

const props = defineProps<{
  candidates: readonly PauseCandidate[]
  submit: (targets: TaskTarget[]) => Promise<{ results: PauseResult[] }>
}>()
const emit = defineEmits<{ close: []; changed: [] }>()
const dialog = useTemplateRef('batch-dialog')
const selected = ref<string[]>([])
const busy = shallowRef(false)
const error = shallowRef('')
const results = shallowRef<PauseResult[] | null>(null)
const submitted = shallowRef<readonly PauseCandidate[]>([])
const chosen = computed(() => props.candidates.filter(item => selected.value.includes(taskKey(item.target))))
const failed = computed(() => results.value?.filter(item => item.status === 'failed').length ?? 0)
const paused = computed(() => results.value?.filter(item => item.status === 'paused').length ?? 0)
const alreadyPaused = computed(() => results.value?.filter(item => item.status === 'already_paused').length ?? 0)
const rows = computed(() => (results.value ?? []).map(result => ({
  result, name: submitted.value.find(item => taskKey(item.target) === taskKey(result))?.name ?? '任务',
  context: result.kind === 'url' ? '网址检查' : '实例续期',
})))

onMounted(() => dialog.value?.showModal())
function close() { if (!busy.value) dialog.value?.close() }
function selectAll() { selected.value = props.candidates.map(item => taskKey(item.target)) }

async function pause() {
  if (busy.value || !chosen.value.length || results.value) return
  busy.value = true
  error.value = ''
  submitted.value = chosen.value.slice()
  try {
    results.value = (await props.submit(submitted.value.map(item => item.target))).results
    emit('changed')
  } catch (cause) {
    error.value = `${errorMessage(cause)}。结果未确认，请关闭后刷新查看；不会自动重试。`
    emit('changed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <dialog ref="batch-dialog" class="config-dialog" aria-labelledby="batch-title" @close="emit('close')" @cancel.prevent="close">
    <div class="config-form">
      <div class="dialog-header">
        <h2 id="batch-title">批量暂停任务</h2>
        <button class="button" type="button" :disabled="busy" @click="close">关闭</button>
      </div>
      <p class="batch-description muted">只暂停本平台的计划任务，不关停云实例。网址的当前检查可能取消，已发出的云端续期请求无法撤销。</p>
      <template v-if="results === null">
        <div class="batch-toolbar">
          <span class="muted">已选 {{ chosen.length }} / {{ candidates.length }} 项</span>
          <div class="batch-buttons">
            <button class="button" type="button" :disabled="busy || !candidates.length" @click="selectAll">选择全部</button>
            <button class="button" type="button" :disabled="busy || !chosen.length" @click="selected = []">取消选择</button>
          </div>
        </div>
        <ul v-if="candidates.length" class="batch-list" aria-label="可暂停任务">
          <li v-for="item in candidates" :key="taskKey(item.target)">
            <label class="batch-choice">
              <input v-model="selected" :value="taskKey(item.target)" type="checkbox" :disabled="busy" />
              <span class="batch-name"><strong>{{ item.name }}</strong><small class="muted">{{ item.context }}</small></span>
            </label>
          </li>
        </ul>
        <p v-else class="muted">当前没有已启用的任务。</p>
        <p v-if="error" role="alert" class="notice error batch-feedback">{{ error }}</p>
        <div class="dialog-footer">
          <button class="button" type="button" :disabled="busy" @click="close">取消</button>
          <button class="button primary" type="button" :disabled="busy || !chosen.length" @click="pause">
            {{ busy ? '正在暂停…' : `确认暂停 ${chosen.length} 项` }}
          </button>
        </div>
      </template>
      <template v-else>
        <p class="notice batch-feedback" :class="{ error: failed > 0 }" :role="failed ? 'alert' : 'status'">
          已暂停 {{ paused }} 项，原已暂停 {{ alreadyPaused }} 项，未确认 {{ failed }} 项。
        </p>
        <ul class="batch-list" aria-label="逐项暂停结果">
          <li v-for="row in rows" :key="taskKey(row.result)" class="batch-result">
            <span class="batch-name"><strong>{{ row.name }}</strong><small class="muted">{{ row.context }}</small></span>
            <span :class="row.result.status === 'failed' ? 'text-down' : 'text-up'">
              {{ row.result.status === 'paused' ? '已暂停' : row.result.status === 'already_paused' ? '原已暂停' : '未确认暂停' }}
            </span>
            <p v-if="row.result.status === 'failed'" class="batch-error muted">{{ row.result.message }}</p>
          </li>
        </ul>
        <div class="dialog-footer"><button class="button primary" type="button" @click="close">完成</button></div>
      </template>
    </div>
  </dialog>
</template>

<style scoped>
.batch-description { font-size: 13px; line-height: 1.6; }
.batch-toolbar, .batch-buttons { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.batch-toolbar { justify-content: space-between; margin: 14px 0 9px; font-size: 13px; }
.batch-list { padding: 0; list-style: none; max-height: 45dvh; overflow-y: auto; }
.batch-list > li { border-top: 1px solid var(--line); }
.batch-choice { display: flex; gap: 10px; padding: 12px 4px; align-items: center; cursor: pointer; }
.batch-choice input { accent-color: var(--accent); width: 17px; height: 17px; flex-shrink: 0; }
.batch-name { display: grid; gap: 4px; font-size: 13px; min-width: 0; overflow-wrap: anywhere; }
.batch-name small { font-size: 12px; }
.batch-feedback { margin-top: 13px; }
.batch-result { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding: 12px 4px; font-size: 13px; }
.batch-error { grid-column: 1 / -1; font-size: 12px; }
</style>
