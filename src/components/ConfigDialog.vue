<script setup lang="ts">
import { onMounted, reactive, useTemplateRef } from 'vue'
import type { SandboxConfig } from '../model'

const props = defineProps<{
  initial: SandboxConfig; title: string; busy: boolean; error: string; allowHttp: boolean
}>()
const emit = defineEmits<{ close: []; save: [config: SandboxConfig] }>()
const draft = reactive({ ...props.initial })
const dialog = useTemplateRef('configuration')
onMounted(() => dialog.value?.showModal())

function close() {
  if (!props.busy) dialog.value?.close()
}

function save() {
  emit('save', { ...draft, expectedText: draft.method === 'GET' ? draft.expectedText : '' })
}
</script>

<template>
  <dialog ref="configuration" class="config-dialog" aria-labelledby="config-title" @close="emit('close')" @cancel.prevent="close">
    <form class="config-form" @submit.prevent="save">
      <div class="dialog-header">
        <h2 id="config-title">{{ title }}</h2>
        <button class="button" type="button" :disabled="busy" @click="close">关闭</button>
      </div>
      <fieldset :disabled="busy" class="config-fields">
        <label>沙盒名称<input v-model.trim="draft.name" maxlength="60" required autofocus placeholder="例如 官网生产环境" /></label>
        <label>分组<input v-model.trim="draft.group" maxlength="40" placeholder="例如 生产环境" /></label>
        <label class="wide">部署网址<input v-model.trim="draft.url" type="url" maxlength="768" required
          :placeholder="'https://example.com/healthz 或 http://内网地址/healthz'" />
          <small>填写你有权监控的应用健康地址。请去掉查询参数和访问令牌。</small>
        </label>
        <label>请求方式<select v-model="draft.method"><option>GET</option><option>HEAD</option></select></label>
        <label>检查间隔（秒）<input v-model.number="draft.intervalSec" type="number" min="60" max="86400" required /></label>
        <label>超时（秒）<input v-model.number="draft.timeoutSec" type="number" min="2" max="30" required /></label>
        <label>连续失败阈值<input v-model.number="draft.failureThreshold" type="number" min="1" max="10" required /></label>
        <label>成功状态码下限<input v-model.number="draft.successMin" type="number" min="200" max="499" required /></label>
        <label>成功状态码上限<input v-model.number="draft.successMax" type="number" :min="draft.successMin" max="499" required /></label>
        <label v-if="draft.method === 'GET'" class="wide">预期响应文本
          <input v-model.trim="draft.expectedText" maxlength="128" placeholder="例如 app-ready" />
          <small>选填。填写应用健康地址会返回的公开标记，同时校验状态码和响应正文。</small>
        </label>
        <label class="wide">备注<textarea v-model.trim="draft.notes" rows="2" maxlength="400" placeholder="维护人、用途或环境信息"></textarea></label>
        <label class="wide activation"><input v-model="draft.enabled" type="checkbox" />保存后启用定时检查</label>
      </fieldset>
      <p v-if="error" role="alert" class="notice error">{{ error }}</p>
      <div class="dialog-footer">
        <button class="button" type="button" :disabled="busy" @click="close">取消</button>
        <button class="button primary" type="submit" :disabled="busy">{{ busy ? '正在保存…' : '保存配置' }}</button>
      </div>
    </form>
  </dialog>
</template>
