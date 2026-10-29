<script setup>
import { computed, ref, watch } from 'vue';
import { mailDocument } from '../utils/safe-mail';
const props = defineProps({ html: { type: String, default: '' } });
const images = ref(false);
watch(() => props.html, () => images.value = false);
const document = computed(() => mailDocument(props.html, images.value));
</script>
<template>
  <div class="safe-mail">
    <div class="image-notice"><span>{{ images ? '已允许此邮件加载外部图片' : '已拦截外部图片，保护你的阅读隐私' }}</span><button type="button" @click="images = !images">{{ images ? '重新拦截' : '显示图片' }}</button></div>
    <iframe title="邮件正文" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" :srcdoc="document"></iframe>
  </div>
</template>
<style scoped>
.image-notice{display:flex;align-items:center;justify-content:space-between;gap:12px;background:#f0f4f9;color:#5f6368;padding:10px 16px;border-radius:8px;font-size:12px}.image-notice button{border:0;background:none;color:#0b57d0;cursor:pointer;white-space:nowrap}iframe{border:0;width:100%;min-height:430px;background:#fff;border-radius:8px;margin-top:12px}
</style>
