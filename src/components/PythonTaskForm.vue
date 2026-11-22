<script setup lang="ts">
import { computed, reactive, shallowRef, watch } from 'vue'
import { errorMessage } from '../api'
import type { PythonAccount, PythonActions, PythonField, PythonTask, PythonTaskInput, PythonValue } from '../python-model'
import PythonCredentialEditor from './PythonCredentialEditor.vue'
import PythonParameterFields from './PythonParameterFields.vue'

const props = defineProps<{
  task?: PythonTask
  schema: readonly PythonField[]
  accounts: readonly PythonAccount[]
  defaults: Readonly<Record<string, PythonValue>>
  actions: Pick<PythonActions, 'create' | 'update'>
  /** 从某个账号层新建时预选该账号，省去重复选择。 */
  presetAccountId?: string
}>()
const emit = defineEmits<{ saved: [task: PythonTask]; cancel: []; settings: []; pending: [value: boolean] }>()
const name = shallowRef(props.task?.name ?? '')
const notes = shallowRef(props.task?.notes ?? '')
const accountId = shallowRef(props.task ? props.task.accountId ?? '' : (props.presetAccountId ?? props.accounts[0]?.id ?? ''))
const legacyTask = Boolean(props.task && !props.task.accountId)
const independent = computed(() => legacyTask && !accountId.value)
const account = computed(() => props.accounts.find(item => item.id === accountId.value))
const sandboxKeys = new Set(['CONV_ID', 'SITE', 'SITE_ENABLE'])
const accountKeys = new Set(['BASE', 'UID'])
const basicFields = computed(() => props.schema.filter(field => sandboxKeys.has(field.key)))
const globalFields = computed(() => props.schema.filter(field => !sandboxKeys.has(field.key) && !accountKeys.has(field.key)))
const legacyFields = computed(() => props.schema.filter(field => !sandboxKeys.has(field.key)))
const overrideKeys = shallowRef<readonly string[]>((props.task?.accountId ? props.task.overrideKeys : [])
  .filter(key => !sandboxKeys.has(key) && !accountKeys.has(key)))
const touchedOverrides = new Set(overrideKeys.value)
const params = reactive<Record<string, PythonValue>>({ ...props.task?.params })
for (const field of props.schema) {
  if (!Object.hasOwn(params, field.key)) params[field.key] = props.defaults[field.key] ?? field.default
}
const credentials = shallowRef<NonNullable<PythonTaskInput['credentials']>>({})
watch(accountId, () => { credentials.value = {} })
const busy = shallowRef(false)
const error = shallowRef('')
const editable = computed(() => !props.task || props.task.status === 'stopped' || props.task.status === 'error')
const canSave = computed(() => editable.value && (independent.value || Boolean(account.value)))
function setParam(key: string, value: PythonValue) { params[key] = value }
function setOverride(key: string, enabled: boolean) {
  if (enabled) {
    if (!touchedOverrides.has(key)) {
      const field = globalFields.value.find(item => item.key === key)
      if (field) params[key] = props.defaults[key] ?? field.default
      touchedOverrides.add(key)
    }
    overrideKeys.value = [...new Set([...overrideKeys.value, key])]
  } else overrideKeys.value = overrideKeys.value.filter(item => item !== key)
}

async function submit() {
  if (busy.value || !editable.value) return
  error.value = ''
  if (!name.value.trim()) { error.value = '请填写配置名称。'; return }
  if (!canSave.value) { error.value = '请先到「统一设置」新增共享账号，再选择账号。'; return }
  const submittedParams: Record<string, PythonValue> = independent.value ? { ...params } : {}
  const fields = independent.value ? props.schema : [...basicFields.value, ...globalFields.value.filter(field => overrideKeys.value.includes(field.key))]
  for (const field of fields) {
    const value = params[field.key] ?? field.default
    if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value) ||
      (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max))) {
      error.value = `请检查「${field.label}」的数值范围。`
      return
    }
    submittedParams[field.key] = value
  }
  if (independent.value) {
    for (const [key, value] of Object.entries(credentials.value)) {
      if (typeof value === 'string' && !value.trim()) { error.value = `请输入新的 ${key}，或选择保留／清除。`; return }
    }
  }
  const input: PythonTaskInput = {
    name: name.value.trim(), notes: notes.value, accountId: independent.value ? null : accountId.value,
    params: submittedParams,
    ...(independent.value && Object.keys(credentials.value).length ? { credentials: { ...credentials.value } } : {}),
  }
  busy.value = true
  emit('pending', true)
  try {
    const { task } = props.task ? await props.actions.update(props.task.id, input) : await props.actions.create(input)
    credentials.value = {}
    emit('saved', task)
  } catch (cause) { error.value = errorMessage(cause) }
  finally { busy.value = false; emit('pending', false) }
}
</script>

<template>
  <section class="panel detail python-editor" aria-labelledby="python-form-title">
    <div class="dialog-header"><h2 id="python-form-title">{{ task ? '编辑沙盒配置' : '新建沙盒配置' }}</h2><button class="button" type="button" :disabled="busy" @click="emit('cancel')">取消</button></div>
    <p class="muted form-intro">账号与公共参数只需统一填写一次。这里设置当前沙盒的会话和业务地址，保存后手动启动。</p>
    <p v-if="!editable" class="notice error" role="alert">此配置正在运行或切换状态，请停止后再编辑。</p>
    <form @submit.prevent="submit">
      <fieldset class="form-body" :disabled="busy || !editable">
        <div class="config-fields">
          <label class="wide">配置名称<input v-model="name" name="python-name" required autocomplete="off" /></label>
          <label class="wide">备注<textarea v-model="notes" name="python-notes" rows="2" /></label>
          <label class="wide">使用账号
            <select v-model="accountId" name="python-account" :required="!legacyTask">
              <option v-if="legacyTask" value="">独立配置（保留原账号资料）</option>
              <option v-else-if="!accounts.length" value="" disabled>请先新增共享账号</option>
              <option v-for="item in accounts" :key="item.id" :value="item.id">{{ item.name }}</option>
            </select>
          </label>
        </div>
        <p v-if="account" class="scope-note account-summary">共用账号资料：BASE <span class="mono">{{ account.base || '（空字符串）' }}</span> · UID <span class="mono">{{ account.uid }}</span>。JWT / RT 在统一设置维护。</p>
        <div v-if="!accounts.length" class="account-needed">
          <p class="scope-note">{{ legacyTask ? '此配置仍可按原方式保存。新沙盒建议使用共享账号。' : '先新增共享账号，后续每个沙盒都可直接选择，无需重复填写令牌。' }}</p>
          <button class="button" type="button" :disabled="busy" @click="emit('settings')">前往统一设置新增账号</button>
        </div>
        <PythonParameterFields :fields="basicFields" :values="params" :disabled="busy || !editable" @change="setParam" />
        <template v-if="independent">
          <p class="scope-note legacy-note">这是旧独立配置，继续使用原有全量参数和凭据；不会自动迁移到共享账号或继承公共默认值。</p>
          <details class="advanced-disclosure">
            <summary>兼容高级表单 · 原独立参数与凭据</summary>
            <PythonParameterFields :fields="legacyFields" :values="params" :disabled="busy || !editable" @change="setParam" />
            <PythonCredentialEditor v-model="credentials" :has-jwt="task?.hasJWT ?? false" :has-rt="task?.hasRT ?? false" :disabled="busy || !editable" />
          </details>
        </template>
        <details v-else-if="account" class="advanced-disclosure">
          <summary>高级覆盖 <span class="muted">{{ overrideKeys.length ? `（${overrideKeys.length} 项）` : '（默认全部继承）' }}</span></summary>
          <p class="scope-note">仅勾选确实需要与统一默认值不同的字段；未勾选的字段不会保存覆盖，下次启动时继承最新公共设置。</p>
          <PythonParameterFields :fields="globalFields" :values="params" :inherited="defaults" :override-keys="overrideKeys"
            :disabled="busy || !editable" @change="setParam" @override="setOverride" />
        </details>
      </fieldset>
      <p v-if="error" role="alert" class="notice error form-error">{{ error }}</p>
      <div class="dialog-footer"><button class="button" type="button" :disabled="busy" @click="emit('cancel')">取消</button><button class="button primary" type="submit" :disabled="busy || !canSave">{{ busy ? '正在保存…' : '保存沙盒配置' }}</button></div>
    </form>
  </section>
</template>

<style scoped>
.python-editor { min-width: 0; }.dialog-header h2 { font-size: 21px; }
.form-intro { margin-bottom: 18px; font-size: 13px; line-height: 1.7; }
.form-body { border: 0; margin: 0; padding: 0; min-width: 0; }
.account-summary { overflow-wrap: anywhere; }.account-needed { margin-top: 12px; }.account-needed .scope-note { margin: 0 0 10px; }
.advanced-disclosure { margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--line); }.advanced-disclosure summary { cursor: pointer; font-size: 14px; color: var(--accent); line-height: 1.6; }
.legacy-note { margin-top: 16px; }.form-error { margin-top: 16px; }
@media (max-width: 600px) { .config-fields { grid-template-columns: minmax(0, 1fr); } }
</style>
