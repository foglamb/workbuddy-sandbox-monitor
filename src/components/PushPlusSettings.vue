<script setup lang="ts">
import { onMounted, shallowRef } from 'vue'
import { errorMessage } from '../api'
import type { PushPlusConfig, PushPlusInput, PythonSharedActions } from '../python-model'

const props = defineProps<{ actions: PythonSharedActions; disabled?: boolean }>()
const emit = defineEmits<{ pending: [value: boolean] }>()

const eventOptions = [
  { key: 'started', label: '脚本启动' },
  { key: 'stopped', label: '脚本停止' },
  { key: 'failure', label: '异常退出' },
] as const

const config = shallowRef<PushPlusConfig>({ enabled: false, hasToken: false, topic: '', events: [] })
const token = shallowRef('')
const clearToken = shallowRef(false)
const busy = shallowRef(false)
const loaded = shallowRef(false)
const notice = shallowRef<{ text: string; error?: boolean } | null>(null)

async function load() {
  busy.value = true
  emit('pending', true)
  try {
    config.value = (await props.actions.loadPushPlus()).pushplus
    loaded.value = true
  } catch (cause) {
    notice.value = { text: errorMessage(cause), error: true }
  } finally {
    busy.value = false
    emit('pending', false)
  }
}

function toggleEvent(key: string) {
  const current = config.value.events
  const events = current.includes(key) ? current.filter(item => item !== key) : [...current, key]
  config.value = { ...config.value, events }
}

async function save() {
  if (busy.value) return
  const input: PushPlusInput = {
    enabled: config.value.enabled,
    topic: config.value.topic,
    events: config.value.events,
  }
  if (clearToken.value) input.token = ''
  else if (token.value.trim()) input.token = token.value.trim()
  busy.value = true
  emit('pending', true)
  notice.value = null
  try {
    config.value = (await props.actions.savePushPlus(input)).pushplus
    token.value = ''
    clearToken.value = false
    notice.value = { text: config.value.enabled ? '推送配置已保存并启用。' : '推送配置已保存，当前为停用。' }
  } catch (cause) {
    notice.value = { text: errorMessage(cause), error: true }
  } finally {
    busy.value = false
    emit('pending', false)
  }
}

async function sendTest() {
  if (busy.value) return
  if (!config.value.hasToken && !token.value.trim()) {
    notice.value = { text: '请先填写并保存 PushPlus Token。', error: true }
    return
  }
  busy.value = true
  emit('pending', true)
  notice.value = null
  try {
    await props.actions.testPushPlus()
    notice.value = { text: '测试消息已送达 PushPlus，请检查微信或客户端。' }
  } catch (cause) {
    notice.value = { text: errorMessage(cause), error: true }
  } finally {
    busy.value = false
    emit('pending', false)
  }
}

onMounted(load)
</script>

<template>
  <section class="panel detail pushplus-panel" aria-labelledby="pushplus-title">
    <div class="settings-heading">
      <h2 id="pushplus-title">状态推送（PushPlus）</h2>
      <span class="muted pushplus-state">{{ config.enabled ? '已启用' : '未启用' }}</span>
    </div>
    <p class="scope-note pushplus-intro">
      脚本启动、停止或异常退出时，通过 PushPlus 推送到微信。Token 加密保存在本机数据库，不会回显到页面。
    </p>
    <p v-if="notice" :role="notice.error ? 'alert' : 'status'" class="notice" :class="{ error: notice.error }">{{ notice.text }}</p>

    <div class="pushplus-fields">
      <label class="pushplus-enabled">
        <input type="checkbox" :checked="config.enabled" :disabled="disabled || busy" @change="config = { ...config, enabled: ($event.target as HTMLInputElement).checked }">
        启用状态推送
      </label>
      <label>
        PushPlus Token
        <input
          class="mono"
          type="password"
          autocomplete="off"
          spellcheck="false"
          :disabled="disabled || busy"
          :placeholder="config.hasToken ? '已保存（留空则保持不变）' : '粘贴你的 PushPlus Token'"
          :value="token"
          @input="token = ($event.target as HTMLInputElement).value"
        >
      </label>
      <label v-if="config.hasToken" class="pushplus-clear">
        <input type="checkbox" :checked="clearToken" :disabled="disabled || busy" @change="clearToken = ($event.target as HTMLInputElement).checked">
        清除已保存的 Token
      </label>
      <label>
        群组编码（可选）
        <input
          class="mono"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="留空推送给 Token 所有者"
          :value="config.topic"
          :disabled="disabled || busy"
          @input="config = { ...config, topic: ($event.target as HTMLInputElement).value }"
        >
      </label>
      <fieldset class="pushplus-events">
        <legend>推送事件</legend>
        <label v-for="option in eventOptions" :key="option.key">
          <input
            type="checkbox"
            :checked="config.events.includes(option.key)"
            :disabled="disabled || busy"
            @change="toggleEvent(option.key)"
          >
          {{ option.label }}
        </label>
      </fieldset>
    </div>

    <div class="detail-actions">
      <button class="button primary" type="button" :disabled="disabled || busy || !loaded" @click="save">保存推送配置</button>
      <button class="button" type="button" :disabled="disabled || busy || !loaded" @click="sendTest">发送测试消息</button>
    </div>
    <p class="scope-note pushplus-hint">未勾选任何事件时不会发送通知；推送失败不会影响脚本运行。</p>
  </section>
</template>

<style scoped>
.pushplus-panel { min-width: 0; }
.settings-heading { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
.settings-heading h2 { font-size: 19px; }
.pushplus-state { font-size: 12px; }
.pushplus-intro { margin-top: 10px; }
.pushplus-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 16px 0; }
.pushplus-fields label { display: grid; gap: 6px; font-size: 13px; }
.pushplus-fields input[type=text], .pushplus-fields input[type=password] { width: 100%; }
.pushplus-enabled, .pushplus-clear { display: flex !important; align-items: center; gap: 8px; }
.pushplus-enabled input, .pushplus-clear input { accent-color: var(--accent); width: 15px; height: 15px; }
.pushplus-events { grid-column: 1 / -1; border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px; display: flex; flex-wrap: wrap; gap: 14px; }
.pushplus-events legend { font-size: 12px; color: var(--muted); padding: 0 6px; }
.pushplus-events label { display: inline-flex !important; align-items: center; gap: 7px; }
.pushplus-events input { accent-color: var(--accent); width: 15px; height: 15px; }
.pushplus-hint { margin-top: 10px; }
@media (max-width: 600px) { .pushplus-fields { grid-template-columns: minmax(0, 1fr); } }
</style>
