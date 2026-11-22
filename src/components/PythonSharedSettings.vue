<script setup lang="ts">
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { errorMessage } from '../api'
import type { PythonAccount, PythonField, PythonSharedActions, PythonTask, PythonValue } from '../python-model'
import PythonAccountForm from './PythonAccountForm.vue'
import PythonDefaultsForm from './PythonDefaultsForm.vue'
import PushPlusSettings from './PushPlusSettings.vue'
import AdminPasswordPanel from './AdminPasswordPanel.vue'

const props = defineProps<{
  accounts: readonly PythonAccount[]
  defaults: Readonly<Record<string, PythonValue>>
  schema: readonly PythonField[]
  tasks: readonly PythonTask[]
  actions: PythonSharedActions
}>()
const emit = defineEmits<{ changed: []; pending: [value: boolean]; signedOut: [] }>()
const editor = shallowRef<{ id?: string } | null>(null)
const accountBusy = shallowRef(false)
const defaultsBusy = shallowRef(false)
const commandBusy = shallowRef(false)
const busy = computed(() => accountBusy.value || defaultsBusy.value || commandBusy.value)
const notice = shallowRef<{ text: string; error?: boolean } | null>(null)
const recentAccount = shallowRef<PythonAccount | null>(null)
const removedId = shallowRef('')
const revealed = shallowRef<{ id: string; JWT: string; RT: string } | null>(null)
let revealVersion = 0
const accounts = computed(() => {
  const result = props.accounts.filter(account => account.id !== removedId.value)
  const recent = recentAccount.value
  if (!recent) return result
  return result.some(account => account.id === recent.id) ? result.map(account => account.id === recent.id ? recent : account) : [...result, recent]
})
const editingAccount = computed(() => accounts.value.find(account => account.id === editor.value?.id))
watch(busy, value => emit('pending', value))
watch(() => props.accounts, () => { recentAccount.value = null; removedId.value = '' })
function hideCredentials() { revealVersion++; revealed.value = null }
onScopeDispose(hideCredentials)
function openEditor(account?: PythonAccount) {
  if (busy.value) return
  hideCredentials()
  notice.value = null
  editor.value = account ? { id: account.id } : {}
}
function saved(account: PythonAccount) {
  recentAccount.value = account
  editor.value = null
  accountBusy.value = false
  notice.value = { text: '共享账号已保存。可返回脚本配置选择此账号；现有进程不会重启。' }
  emit('changed')
}
async function reveal(account: PythonAccount) {
  if (busy.value) return
  if (revealed.value?.id === account.id) { hideCredentials(); return }
  hideCredentials()
  const version = revealVersion
  commandBusy.value = true
  notice.value = null
  try {
    const result = await props.actions.revealAccount(account.id)
    if (version === revealVersion) revealed.value = { id: account.id, ...result.credentials }
  } catch (cause) { if (version === revealVersion) notice.value = { text: errorMessage(cause), error: true } }
  finally { commandBusy.value = false }
}
async function remove(account: PythonAccount) {
  if (busy.value || account.inUse > 0 || !window.confirm(`删除共享账号「${account.name}」及其已保存凭据？`)) return
  commandBusy.value = true
  notice.value = null
  hideCredentials()
  try {
    const result = await props.actions.removeAccount(account.id)
    if (!result.ok) throw new Error('账号未删除，请刷新后重试。')
    removedId.value = account.id
    recentAccount.value = null
    notice.value = { text: '共享账号已删除。' }
    emit('changed')
  } catch (cause) { notice.value = { text: errorMessage(cause), error: true } }
  finally { commandBusy.value = false }
}
</script>

<template>
  <div class="shared-settings">
    <p class="settings-explanation muted">账号资料和公共参数在这里统一填写一次。每个沙盒只需选择账号、填写会话与业务地址；需要不同的公共参数时，再单独覆盖。</p>
    <p v-if="notice" :role="notice.error ? 'alert' : 'status'" class="notice" :class="{ error: notice.error }">{{ notice.text }}</p>
    <section class="panel detail accounts-panel" aria-labelledby="python-accounts-title">
      <div class="settings-heading"><h2 id="python-accounts-title">账号共用</h2><button v-if="!editor" class="button primary" type="button" :disabled="busy" @click="openEditor()">＋ 新增账号</button></div>
      <p class="scope-note accounts-intro">同一账号的 BASE、UID、JWT、RT 由多个沙盒共用，无需重复输入令牌。</p>
      <PythonAccountForm v-if="editor" :key="editor.id ?? 'new'" :account="editingAccount" :tasks="tasks" :schema="schema" :actions="actions"
        :disabled="defaultsBusy || commandBusy" @saved="saved" @cancel="editor = null" @pending="accountBusy = $event" />
      <div v-else-if="!accounts.length" class="empty-state compact">尚无共享账号。点击「新增账号」填写，或从已有独立配置提取，原配置保持不变。</div>
      <ul v-else class="account-list">
        <li v-for="account in accounts" :key="account.id" class="account-card">
          <div class="settings-heading"><h3>{{ account.name }}</h3><span class="muted account-use">{{ account.inUse }} 个配置使用</span></div>
          <dl class="account-info"><div><dt>BASE</dt><dd class="mono">{{ account.base || '（空字符串）' }}</dd></div><div><dt>UID</dt><dd class="mono">{{ account.uid }}</dd></div></dl>
          <p class="scope-note">JWT：{{ account.hasJWT ? '已保存' : '未保存' }} · RT：{{ account.hasRT ? '已保存' : '未保存' }}</p>
          <div class="detail-actions account-actions">
            <button class="button" type="button" :disabled="busy" @click="openEditor(account)">编辑账号</button>
            <button class="button" type="button" :disabled="busy" :aria-expanded="revealed?.id === account.id" @click="reveal(account)">{{ revealed?.id === account.id ? '隐藏凭据' : '查看已保存凭据' }}</button>
            <button class="button danger" type="button" :disabled="busy || account.inUse > 0" @click="remove(account)">删除账号</button>
          </div>
          <p v-if="account.inUse > 0" class="scope-note account-delete-hint">仍有配置使用此账号，解除关联后才可删除。</p>
          <div v-if="revealed?.id === account.id" class="revealed-credentials">
            <label>JWT<textarea class="mono" :value="revealed.JWT" readonly rows="3" spellcheck="false" placeholder="未保存 JWT" /></label>
            <label>RT<textarea class="mono" :value="revealed.RT" readonly rows="3" spellcheck="false" placeholder="未保存 RT" /></label>
          </div>
        </li>
      </ul>
    </section>
    <PythonDefaultsForm :schema="schema" :defaults="defaults" :save="actions.saveDefaults" :disabled="accountBusy || commandBusy"
      @changed="emit('changed')" @pending="defaultsBusy = $event" />
    <PushPlusSettings :actions="actions" :disabled="accountBusy || defaultsBusy || commandBusy" @pending="commandBusy = $event" />
    <AdminPasswordPanel :actions="actions" :disabled="accountBusy || defaultsBusy || commandBusy"
      @pending="commandBusy = $event" @saved="emit('signedOut')" />
  </div>
</template>

<style scoped>
.shared-settings { display: grid; gap: 18px; }.settings-explanation { font-size: 13px; line-height: 1.8; }
.shared-settings > .notice { margin: 0; }.accounts-panel { min-width: 0; }
.settings-heading { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }.settings-heading h2 { font-size: 19px; }.settings-heading h3 { font-size: 15px; overflow-wrap: anywhere; }
.accounts-intro { margin-top: 10px; }.account-list { list-style: none; padding: 0; }.account-card { padding: 18px 0; border-top: 1px solid var(--line); margin-top: 18px; }.account-card:last-child { padding-bottom: 0; }
.account-use { font-size: 12px; }.account-info { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 16px; margin-top: 14px; font-size: 13px; }.account-info dt { color: var(--muted); font-size: 12px; }.account-info dd { margin-top: 5px; overflow-wrap: anywhere; }
.account-actions { margin-top: 12px; }.account-delete-hint { margin-top: 8px; }.revealed-credentials { display: grid; gap: 12px; margin-top: 14px; }.revealed-credentials label { display: grid; gap: 6px; font-size: 13px; }.revealed-credentials textarea { width: 100%; resize: vertical; }
@media (max-width: 600px) { .account-info { grid-template-columns: minmax(0, 1fr); } }
</style>
