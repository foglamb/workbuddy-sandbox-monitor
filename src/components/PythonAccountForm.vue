<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { errorMessage } from '../api'
import type { PythonAccount, PythonAccountInput, PythonField, PythonSharedActions, PythonTask } from '../python-model'
import PythonCredentialEditor from './PythonCredentialEditor.vue'

const props = defineProps<{
  account?: PythonAccount
  tasks: readonly PythonTask[]
  schema: readonly PythonField[]
  actions: Pick<PythonSharedActions, 'createAccount' | 'updateAccount'>
  disabled?: boolean
}>()
const emit = defineEmits<{ saved: [account: PythonAccount]; cancel: []; pending: [value: boolean] }>()
const name = shallowRef(props.account?.name ?? '')
const base = shallowRef(props.account?.base ?? String(props.schema.find(field => field.key === 'BASE')?.default ?? ''))
const uid = shallowRef(props.account?.uid ?? '')
const mode = shallowRef<'manual' | 'task'>('manual')
const sourceTaskId = shallowRef('')
const credentials = shallowRef<NonNullable<PythonAccountInput['credentials']>>({})
const sources = computed(() => props.tasks.filter(task => !task.accountId))
const source = computed(() => sources.value.find(task => task.id === sourceTaskId.value))
const busy = shallowRef(false)
const error = shallowRef('')

async function submit() {
  if (busy.value || props.disabled) return
  error.value = ''
  if (!name.value.trim()) { error.value = '请填写账号名称。'; return }
  let input: PythonAccountInput
  if (!props.account && mode.value === 'task') {
    if (!source.value) { error.value = '请选择需要提取账号的独立配置。'; return }
    input = { name: name.value.trim(), sourceTaskId: source.value.id }
  } else {
    if (!uid.value.trim()) { error.value = '请填写账号 UID。'; return }
    for (const [key, value] of Object.entries(credentials.value)) {
      if (typeof value === 'string' && !value.trim()) { error.value = `请输入新的 ${key}，或选择保留／清除。`; return }
    }
    input = { name: name.value.trim(), base: base.value.trim(), uid: uid.value.trim(),
      ...(Object.keys(credentials.value).length ? { credentials: { ...credentials.value } } : {}) }
  }
  busy.value = true
  emit('pending', true)
  try {
    const { account } = props.account ? await props.actions.updateAccount(props.account.id, input) : await props.actions.createAccount(input)
    credentials.value = {}
    emit('saved', account)
  } catch (cause) { error.value = errorMessage(cause) }
  finally { busy.value = false; emit('pending', false) }
}
</script>

<template>
  <form class="account-form" @submit.prevent="submit">
    <h3 class="form-title">{{ account ? '编辑共享账号' : '新增共享账号' }}</h3>
    <fieldset class="form-body" :disabled="busy || disabled">
      <div class="config-fields account-fields">
        <label class="wide">账号名称<input v-model="name" name="account-name" required autocomplete="off" placeholder="如：我的 WorkBuddy 账号" /></label>
        <label v-if="!account && sources.length" class="wide">创建方式
          <select v-model="mode" name="account-source-mode"><option value="manual">手动填写账号资料</option><option value="task">从已有独立配置提取</option></select>
        </label>
        <template v-if="!account && mode === 'task'">
          <label class="wide">来源配置<select v-model="sourceTaskId" name="account-source-task" required><option value="" disabled>选择已有独立配置</option><option v-for="task in sources" :key="task.id" :value="task.id">{{ task.name }}</option></select></label>
          <p class="wide scope-note extract-note">仅复制所选配置的 BASE、UID、JWT 和 RT 为新账号，不改原配置，也不影响其运行。</p>
          <dl v-if="source" class="wide source-summary"><div><dt>BASE</dt><dd class="mono">{{ source.params.BASE || '（空字符串）' }}</dd></div><div><dt>UID</dt><dd class="mono">{{ source.params.UID || '（未填写）' }}</dd></div></dl>
        </template>
        <template v-else>
          <label class="wide">账号接口地址 <small class="mono">BASE</small><input v-model="base" name="account-base" autocomplete="off" spellcheck="false" /></label>
          <label class="wide">用户标识 <small class="mono">UID</small><input v-model="uid" name="account-uid" required autocomplete="off" spellcheck="false" /></label>
        </template>
      </div>
      <PythonCredentialEditor v-if="account || mode === 'manual'" v-model="credentials" :has-jwt="account?.hasJWT ?? false"
        :has-rt="account?.hasRT ?? false" :disabled="busy || disabled" />
    </fieldset>
    <p class="scope-note">共享此账号的沙盒无需重复填写账号资料。修改仅在它们下次启动时生效，不会重启当前进程。</p>
    <p v-if="error" role="alert" class="notice error form-error">{{ error }}</p>
    <div class="dialog-footer"><button class="button" type="button" :disabled="busy" @click="emit('cancel')">取消</button><button class="button primary" type="submit" :disabled="busy || disabled">{{ busy ? '正在保存…' : '保存账号' }}</button></div>
  </form>
</template>

<style scoped>
.account-form { margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--line); }
.form-title { font-size: 17px; margin-bottom: 16px; }
.form-body { border: 0; padding: 0; margin: 0; min-width: 0; }
.account-fields { max-width: 720px; }
.extract-note { margin-top: 0; }
.source-summary { display: grid; gap: 8px; font-size: 12px; }
.source-summary dt { color: var(--muted); }.source-summary dd { margin-top: 4px; overflow-wrap: anywhere; }
.form-error { margin-top: 16px; }
</style>
