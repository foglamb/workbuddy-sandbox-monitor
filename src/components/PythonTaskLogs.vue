<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { errorMessage } from '../api'
import { usePythonLogs } from '../composables/usePythonLogs'
import type { PythonActions } from '../python-model'

const props = defineProps<{ taskId: string; enabled: boolean; readLogs: PythonActions['logs']; clearLogs: PythonActions['clearLogs'] }>()
const emit = defineEmits<{ cleared: [] }>()
const { logs, loading, error, restart } = usePythonLogs(() => props.taskId, () => props.enabled, (id, after, signal) => props.readLogs(id, after, signal))
const output = useTemplateRef<HTMLTextAreaElement>('output')
const clearing = shallowRef(false)
const notice = shallowRef<{ text: string; error?: boolean } | null>(null)
const confirming = ref(false)

const text = computed(() => logs.value.flatMap(line => {
  const at = new Date(line.at).toLocaleTimeString('zh-CN', { hour12: false })
  return line.text.split(/\r?\n/).map(content => `[${at}] [${line.stream}] ${content}`)
}).slice(-200).join('\n'))

async function clear() {
  if (clearing.value) return
  clearing.value = true
  notice.value = null
  try {
    const { removed } = await props.clearLogs(props.taskId)
    restart()
    notice.value = { text: removed > 0 ? `已清理 ${removed} 行日志，并删除磁盘日志文件。` : '没有可清理的日志，磁盘日志文件已删除。' }
    emit('cleared')
  } catch (cause) {
    notice.value = { text: errorMessage(cause), error: true }
  } finally {
    clearing.value = false
    confirming.value = false
  }
}

watch(text, async () => {
  const area = output.value
  const following = !area || area.scrollHeight - area.scrollTop - area.clientHeight < 48
  await nextTick()
  if (following && output.value) output.value.scrollTop = output.value.scrollHeight
})
</script>

<template>
  <section class="python-logs" aria-labelledby="python-log-title">
    <div class="history-heading">
      <h3 id="python-log-title">运行日志</h3>
      <span class="muted">{{ loading ? '正在读取…' : '每秒更新' }} · 最多 200 行</span>
      <template v-if="!confirming">
        <button class="button" type="button" :disabled="!enabled || clearing" @click="confirming = true">删除日志</button>
      </template>
      <template v-else>
        <button class="button danger" type="button" :disabled="clearing" @click="clear">{{ clearing ? '正在清理…' : '确认删除' }}</button>
        <button class="button" type="button" :disabled="clearing" @click="confirming = false">取消</button>
      </template>
    </div>
    <p v-if="notice" :role="notice.error ? 'alert' : 'status'" class="notice" :class="{ error: notice.error }">{{ notice.text }}</p>
    <p v-if="error" class="notice error log-error" role="alert">{{ error }}，将自动重试。</p>
    <textarea ref="output" class="log-output mono" :value="text" readonly rows="14" wrap="off" spellcheck="false"
      aria-label="所选 Python 任务运行日志" :placeholder="loading ? '正在读取日志…' : '暂无日志。保存配置后，点击启动运行脚本。'" />
  </section>
</template>

<style scoped>
.python-logs { margin-top: 24px; min-width: 0; }
.history-heading { flex-wrap: wrap; gap: 8px; }
.log-output { display: block; width: 100%; margin-top: 12px; line-height: 1.65; resize: vertical; min-height: 220px; font-size: 12px; }
.log-error { margin-top: 12px; margin-bottom: 0; }
</style>
