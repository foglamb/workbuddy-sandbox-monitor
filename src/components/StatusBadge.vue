<script setup lang="ts">
import { statusLabel, type SandboxStatus } from '../model'

defineProps<{ status: SandboxStatus }>()
</script>

<template>
  <span class="status-pill" :class="`status-${status}`">
    <span class="status-dot" aria-hidden="true"></span>{{ statusLabel[status] }}
  </span>
</template>
