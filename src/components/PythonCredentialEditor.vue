<script setup lang="ts">
import { reactive, useId } from 'vue'
import type { PythonTaskInput } from '../python-model'

const props = defineProps<{ hasJwt: boolean; hasRt: boolean; disabled?: boolean }>()
const changes = defineModel<NonNullable<PythonTaskInput['credentials']>>({ required: true })
const id = useId()
const keys = ['JWT', 'RT'] as const
const values = reactive({ JWT: '', RT: '' })
const modes = reactive<Record<'JWT' | 'RT', 'keep' | 'replace' | 'clear'>>({ JWT: 'keep', RT: 'keep' })
function publish() {
  const next: NonNullable<PythonTaskInput['credentials']> = {}
  for (const key of keys) {
    if (modes[key] === 'clear') next[key] = null
    else if (modes[key] === 'replace') next[key] = values[key].trim()
  }
  changes.value = next
}
function setMode(key: 'JWT' | 'RT', event: Event) {
  modes[key] = (event.currentTarget as HTMLSelectElement).value as typeof modes[typeof key]
  values[key] = ''
  publish()
}
function setValue(key: 'JWT' | 'RT', event: Event) {
  values[key] = (event.currentTarget as HTMLInputElement).value
  publish()
}
</script>

<template>
  <fieldset class="credential-editor" :disabled="disabled">
    <legend>登录凭据</legend>
    <p class="credential-note muted">仅在平台填写，无需在聊天发送。保留不提交该字段，清除提交空值，替换提交本次新值。</p>
    <div class="credential-grid">
      <div v-for="key in keys" :key="key" class="credential-field">
        <label :for="`${id}-${key}-mode`">{{ key }} <small class="muted">{{ (key === 'JWT' ? props.hasJwt : props.hasRt) ? '已保存' : '未保存' }}</small></label>
        <select :id="`${id}-${key}-mode`" :name="`${key}-mode`" :value="modes[key]" :aria-label="`${key} 保存方式`" @change="setMode(key, $event)">
          <option value="keep">保留当前值</option><option value="replace">填写新值</option><option value="clear">清除已保存值</option>
        </select>
        <label v-if="modes[key] === 'replace'" class="new-credential">新的 {{ key }}
          <input type="password" :value="values[key]" :name="`new-${key}`" required autocomplete="new-password" spellcheck="false"
            :placeholder="`输入新的 ${key}`" @input="setValue(key, $event)" />
        </label>
        <small v-if="modes[key] === 'clear'" class="text-down">保存后将清除 {{ key }}。</small>
      </div>
    </div>
  </fieldset>
</template>

<style scoped>
.credential-editor { border: 1px solid var(--line); border-radius: 9px; padding: 14px; margin: 18px 0 0; min-width: 0; }
.credential-editor legend { padding: 0 6px; font-size: 14px; font-weight: 650; }
.credential-note { font-size: 12px; line-height: 1.6; margin-bottom: 14px; }
.credential-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.credential-field, .new-credential { display: grid; align-content: start; gap: 7px; font-size: 13px; min-width: 0; }
.credential-field small { font-size: 12px; line-height: 1.5; }
.credential-field select, .credential-field input { width: 100%; }
@media (max-width: 600px) { .credential-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
