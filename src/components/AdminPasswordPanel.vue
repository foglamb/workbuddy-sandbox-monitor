<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import { errorMessage } from '../api'
import type { PythonSharedActions } from '../python-model'

const props = defineProps<{ actions: PythonSharedActions; disabled?: boolean }>()
const emit = defineEmits<{ pending: [value: boolean]; saved: [] }>()

const current = shallowRef('')
const next = shallowRef('')
const confirm = shallowRef('')
const busy = shallowRef(false)
const notice = shallowRef<{ text: string; error?: boolean } | null>(null)
const canSubmit = () => current.value.length > 0 && next.value.length > 0 && next.value === confirm.value
const weak = computed(() => next.value.length > 0 && next.value.length < 16)

async function submit() {
  if (busy.value || props.disabled) return
  notice.value = null
  if (next.value !== confirm.value) {
    notice.value = { text: '两次输入的新口令不一致。', error: true }
    return
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(next.value)) {
    notice.value = { text: '新口令须为 8–128 位字母、数字、下划线或连字符。', error: true }
    return
  }
  busy.value = true
  emit('pending', true)
  try {
    await props.actions.changeAdminPassword(current.value, next.value)
    current.value = next.value = confirm.value = ''
    notice.value = { text: '管理口令已更新，请使用新口令重新登录。' }
    emit('saved')
  } catch (cause) {
    notice.value = { text: errorMessage(cause), error: true }
  } finally {
    busy.value = false
    emit('pending', false)
  }
}
</script>

<template>
  <section class="panel detail admin-password-panel" aria-labelledby="admin-password-title">
    <div class="settings-heading">
      <h2 id="admin-password-title">管理口令</h2>
      <span class="muted admin-password-state">修改后立即生效</span>
    </div>
    <p class="scope-note admin-password-intro">
      口令使用 scrypt 加盐哈希保存在本机数据库，不保存明文。修改成功后当前页面会退出登录，需要使用新口令重新进入。
    </p>
    <p v-if="notice" :role="notice.error ? 'alert' : 'status'" class="notice" :class="{ error: notice.error }">{{ notice.text }}</p>
    <div class="admin-password-fields">
      <label>
        当前口令
        <input class="mono" type="password" autocomplete="current-password" spellcheck="false"
          :disabled="disabled || busy" :value="current"
          @input="current = ($event.target as HTMLInputElement).value">
      </label>
      <label>
        新口令
        <input class="mono" type="password" autocomplete="new-password" spellcheck="false"
          placeholder="8–128 位字母、数字、下划线或连字符" :disabled="disabled || busy" :value="next"
          @input="next = ($event.target as HTMLInputElement).value">
      </label>
      <p v-if="weak" class="scope-note admin-password-weak" role="status">
        当前新口令少于 16 位，强度较弱，建议加长。
      </p>
      <label>
        确认新口令
        <input class="mono" type="password" autocomplete="new-password" spellcheck="false"
          :disabled="disabled || busy" :value="confirm"
          @input="confirm = ($event.target as HTMLInputElement).value">
      </label>
    </div>
    <div class="detail-actions">
      <button class="button primary" type="button" :disabled="disabled || busy || !canSubmit()" @click="submit">更新口令</button>
    </div>
    <p class="scope-note admin-password-hint">
      忘记口令时，可在服务的 <code>.env</code> 中修改 <code>WB_ADMIN_TOKEN</code> 后重启；启动时会用该值作为初始口令，登录后再改回。
    </p>
  </section>
</template>

<style scoped>
.admin-password-panel { min-width: 0; }
.settings-heading { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
.settings-heading h2 { font-size: 19px; }
.admin-password-state { font-size: 12px; }
.admin-password-intro { margin-top: 10px; }
.admin-password-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 16px 0; }
.admin-password-fields label { display: grid; gap: 6px; font-size: 13px; }
.admin-password-fields input { width: 100%; }
.admin-password-hint { margin-top: 10px; }
.admin-password-hint code { font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
@media (max-width: 760px) { .admin-password-fields { grid-template-columns: minmax(0, 1fr); } }
</style>
