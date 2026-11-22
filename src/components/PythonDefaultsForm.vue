<script setup lang="ts">
import { computed, reactive, shallowRef, watch } from 'vue'
import { errorMessage } from '../api'
import type { PythonField, PythonSharedActions, PythonValue } from '../python-model'
import PythonParameterFields from './PythonParameterFields.vue'

const props = defineProps<{
  schema: readonly PythonField[]
  defaults: Readonly<Record<string, PythonValue>>
  save: PythonSharedActions['saveDefaults']
  disabled?: boolean
}>()
const emit = defineEmits<{ changed: []; pending: [value: boolean] }>()
const excluded = new Set(['BASE', 'UID', 'CONV_ID', 'SITE', 'SITE_ENABLE'])
const fields = computed(() => props.schema.filter(field => !excluded.has(field.key)))
const values = reactive<Record<string, PythonValue>>({})
const dirty = shallowRef(false)
const busy = shallowRef(false)
const error = shallowRef('')
const saved = shallowRef(false)
function hydrate(defaults: Readonly<Record<string, PythonValue>>) {
  for (const field of fields.value) values[field.key] = defaults[field.key] ?? field.default
}
hydrate(props.defaults)
watch(() => props.defaults, defaults => { if (!dirty.value && !busy.value) hydrate(defaults) })
function change(key: string, value: PythonValue) {
  values[key] = value
  dirty.value = true
  saved.value = false
}
async function submit() {
  if (busy.value || props.disabled) return
  error.value = ''
  const params: Record<string, PythonValue> = {}
  for (const field of fields.value) {
    const value = values[field.key] ?? field.default
    if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value) ||
      (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max))) {
      error.value = `请检查「${field.label}」的数值范围。`
      return
    }
    params[field.key] = value
  }
  busy.value = true
  emit('pending', true)
  try {
    const result = await props.save(params)
    hydrate(result.defaults)
    dirty.value = false
    saved.value = true
    emit('changed')
  } catch (cause) { error.value = errorMessage(cause) }
  finally { busy.value = false; emit('pending', false) }
}
</script>

<template>
  <section class="panel detail defaults-panel" aria-labelledby="python-defaults-title">
    <h2 id="python-defaults-title" class="settings-title">脚本公共参数</h2>
    <p class="scope-note defaults-intro">所有使用共享账号的沙盒默认继承这里的设置；某个沙盒勾选了「高级覆盖」的字段除外。旧独立配置继续使用自己保存的值。</p>
    <details class="defaults-disclosure">
      <summary>调整统一默认参数（{{ fields.length }} 项）</summary>
      <form @submit.prevent="submit">
        <PythonParameterFields :fields="fields" :values="values" :disabled="busy || disabled" @change="change" />
        <p v-if="error" role="alert" class="notice error result-notice">{{ error }}</p>
        <p v-if="saved" role="status" class="notice result-notice">公共参数已保存；仅下次启动生效，未重启任何任务。</p>
        <div class="dialog-footer"><button class="button primary" type="submit" :disabled="busy || disabled">{{ busy ? '正在保存…' : '保存公共参数' }}</button></div>
      </form>
    </details>
    <p class="scope-note">保存不会自动重启进程，也不会发起实际保活请求。</p>
  </section>
</template>

<style scoped>
.defaults-panel { min-width: 0; }.settings-title { font-size: 19px; }
.defaults-intro { margin-top: 10px; }
.defaults-disclosure { margin-top: 16px; }.defaults-disclosure summary { cursor: pointer; font-size: 14px; color: var(--accent); line-height: 1.6; }
.result-notice { margin-top: 16px; margin-bottom: 0; }
</style>
