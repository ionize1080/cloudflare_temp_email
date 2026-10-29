<script setup>
import { computed, ref } from 'vue';
import { useMessage } from 'naive-ui';
import { useGlobalState } from '../store';
import { api } from '../api';
import MailIcon from './MailIcon.vue';
const { settings } = useGlobalState();
const message = useMessage(), busy = ref(false);
const state = computed(() => settings.value.send_access_status || 'not_requested');
const pending = computed(() => state.value === 'pending');
const canSend = computed(() => settings.value.send_balance > 0);
const label = computed(() => ({ not_requested: '申请发件权限', pending: '申请已提交，等待管理员审批', approved: `剩余发件额度：${settings.value.send_balance} 封`, unlimited: '发件权限已开通', exhausted: '发件额度已用完', disabled: '发件权限未启用' })[state.value]);
async function refresh() {
  busy.value = true;
  try { await api.getSettings({ quiet: true }); }
  catch (error) { message.error(error.message); }
  finally { busy.value = false; }
}
async function request() {
  busy.value = true;
  try {
    const result = await api.fetch('/api/request_send_mail_access', { method: 'POST', body: '{}', quiet: true });
    settings.value.send_access_status = result.send_access_status;
    message.success('申请已提交，管理员审核后即可发信。');
    await api.getSettings({ quiet: true });
  } catch (error) { message.error(error.message); }
  finally { busy.value = false; }
}
</script>
<template>
  <div class="send-access" :class="{ pending, ready: canSend }" role="status">
    <MailIcon :name="canSend ? 'check' : 'shield'" :size="18" />
    <div><strong>{{ label }}</strong><small v-if="!canSend">{{ pending ? '可以先写好草稿，审核结果会以站内邮件通知。' : '先提交申请，由管理员审核并设置发送额度。' }}</small></div>
    <button v-if="!canSend && !pending" type="button" :disabled="busy" @click="request">{{ busy ? '提交中…' : state === 'exhausted' ? '申请增加额度' : '申请权限' }}</button>
    <button type="button" :disabled="busy" @click="refresh" aria-label="刷新发件权限">刷新状态</button>
  </div>
</template>
<style scoped>
.send-access{display:flex;align-items:center;gap:10px;margin:12px 20px;padding:12px;border:1px solid #d4e3fc;background:#f2f6fd;color:#25426d;border-radius:10px;font-size:12px;flex-wrap:wrap}.send-access>div{flex:1;min-width:160px}.send-access strong{font-weight:600}.send-access small{display:block;margin-top:4px;color:#5f6d81}.send-access button{background:transparent;border:0;color:#0b57d0;font:inherit;cursor:pointer;padding:6px}.send-access.ready{border-color:#cee7dc;background:#f0f8f3;color:#24634b}.send-access svg{flex-shrink:0}:global(.mail-dark) .send-access{background:#263447;border-color:#40516b;color:#c8dcf9}:global(.mail-dark) .send-access small{color:#c1cbd7}:global(.mail-dark) .send-access button{color:#a8c7fa}
</style>
