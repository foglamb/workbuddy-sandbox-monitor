<script setup lang="ts">
import { computed, useId } from 'vue'
import type { PythonField, PythonValue } from '../python-model'

const props = defineProps<{
  fields: readonly PythonField[]
  values: Readonly<Record<string, PythonValue>>
  disabled?: boolean
  overrideKeys?: readonly string[]
  inherited?: Readonly<Record<string, PythonValue>>
}>()
const emit = defineEmits<{ change: [key: string, value: PythonValue]; override: [key: string, enabled: boolean] }>()
const id = useId()
const overrides = computed(() => new Set(props.overrideKeys))
const groups = computed(() => {
  const result = new Map<string, PythonField[]>()
  for (const field of props.fields) {
    const name = field.group || '脚本参数'
    if (!result.has(name)) result.set(name, [])
    result.get(name)!.push(field)
  }
  return [...result].map(([name, fields]) => ({ name, fields }))
})
const isInherited = (key: string) => props.overrideKeys !== undefined && !overrides.value.has(key)
function value(field: PythonField) {
  return isInherited(field.key) ? props.inherited?.[field.key] ?? field.default : props.values[field.key] ?? field.default
}
function change(field: PythonField, event: Event) {
  const input = event.currentTarget as HTMLInputElement
  emit('change', field.key, field.type === 'boolean' ? input.checked :
    field.type === 'number' && input.value !== '' ? Number(input.value) : input.value)
}
</script>

<template>
  <fieldset v-for="group in groups" :key="group.name" class="parameter-group" :disabled="disabled">
    <legend>{{ group.name }}</legend>
    <div class="config-fields">
      <div v-for="field in group.fields" :key="field.key" class="parameter-field" :class="{ wide: field.type === 'string' }">
        <label v-if="overrideKeys !== undefined" class="override-toggle">
          <input type="checkbox" :name="`override-${field.key}`" :checked="overrides.has(field.key)"
            @change="emit('override', field.key, ($event.currentTarget as HTMLInputElement).checked)" />
          单独覆盖 {{ field.label }}
          <small v-if="isInherited(field.key)" class="muted">继承统一默认值</small>
        </label>
        <label :for="`${id}-${field.key}`" :class="{ activation: field.type === 'boolean' }">
          <template v-if="field.type === 'boolean'">
            <input :id="`${id}-${field.key}`" type="checkbox" :name="field.key" :checked="value(field) === true"
              :disabled="disabled || isInherited(field.key)" @change="change(field, $event)" />
            <span>{{ field.label }} <small class="mono">{{ field.key }}</small></span>
          </template>
          <template v-else>
            <span>{{ field.label }} <small class="mono">{{ field.key }}</small></span>
            <input :id="`${id}-${field.key}`" :type="field.type === 'number' ? 'number' : 'text'" :name="field.key"
              :value="value(field)" :min="field.min" :max="field.max" :step="field.step ?? 'any'"
              :disabled="disabled || isInherited(field.key)" :required="field.type === 'number' && !isInherited(field.key)"
              autocomplete="off" spellcheck="false" @input="change(field, $event)" />
          </template>
        </label>
        <small v-if="field.hint" class="field-hint muted">{{ field.hint }}</small>
      </div>
    </div>
  </fieldset>
</template>

<style scoped>
.parameter-group { border: 1px solid var(--line); border-radius: 9px; padding: 14px; margin: 18px 0 0; min-width: 0; }
.parameter-group legend { padding: 0 6px; font-size: 14px; font-weight: 650; }
.parameter-field { min-width: 0; }
.parameter-field > label { font-size: 13px; }
.parameter-field > label:not(.activation, .override-toggle) { display: grid; gap: 6px; }
.parameter-field input:not([type=checkbox]) { width: 100%; }
.override-toggle { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 9px; }
.override-toggle input { accent-color: var(--accent); }
.override-toggle small, .field-hint { font-size: 12px; line-height: 1.5; }
.field-hint { display: block; margin-top: 5px; }
.parameter-field input:disabled { opacity: .65; }
@media (max-width: 600px) { .config-fields { grid-template-columns: minmax(0, 1fr); } }
</style>
