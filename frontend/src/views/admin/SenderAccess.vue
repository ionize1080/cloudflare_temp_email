<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useMessage } from 'naive-ui';
import { api } from '../../api';
import MailIcon from '../../components/MailIcon.vue';
const message = useMessage();
const emit = defineEmits(['changed']);
const rows = ref([]), count = ref(0), page = ref(1), query = ref(''), pendingOnly = ref(false), busy = ref(false), error = ref('');
const modal = ref(false), saving = ref(false), editing = ref(null), form = ref({ address: '', balance: 100, enabled: true });
const title = computed(() => editing.value?.requested_at ? '审核发件申请' : editing.value ? '调整发件权限' : '配置邮箱发件权限');
const status = row => row.requested_at ? '等待审批' : !row.enabled ? '已停用' : row.balance > 0 ? '已开通' : '额度用完';
async function load() {
  busy.value = true; error.value = '';
  try { const res = await api.fetch('/admin/address_sender?limit=20&offset=' + (page.value - 1) * 20 + '&address=' + encodeURIComponent(query.value.trim()) + '&pending=' + (pendingOnly.value ? '1' : '0'), { quiet: true }); rows.value = res.results || []; count.value = res.count || 0; }
  catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
function search() { page.value = 1; load(); }
function edit(row = null) { editing.value = row; form.value = { address: row?.address || '', balance: row ? Number(row.balance) : 100, enabled: row ? Boolean(row.enabled) : true }; if (row?.requested_at) { form.value.enabled = true; if (!form.value.balance) form.value.balance = 100; } modal.value = true; }
async function save() {
  if (!Number.isInteger(form.value.balance) || form.value.balance < 0 || form.value.balance > 100000) { message.error('请输入 0 到 100000 的整数额度'); return; }
  saving.value = true;
  try { const result = await api.fetch('/admin/address_sender', { method: 'POST', quiet: true, body: JSON.stringify({ ...form.value, ...(editing.value ? { address_id: editing.value.id } : {}) }) }); message.success(result.notification_sent === false ? '权限已保存，但站内通知未能写入。用户可刷新发件状态。' : '权限已保存，已发送站内通知'); modal.value = false; await load(); emit('changed'); }
  catch (e) { message.error(e.message); }
  finally { saving.value = false; }
}
watch([page, pendingOnly], load);
onMounted(load);
</script>
<template>
  <div class="sender-panel">
    <div class="admin-callout"><MailIcon name="shield" /><p>用户在写信窗口申请，管理员在这里审批。开通时设置的是<b>剩余总额度</b>；关闭“允许发件”可停用该邮箱。审批会发送站内通知。</p></div>
    <div class="admin-filterbar"><form @submit.prevent="search"><MailIcon name="search" /><input v-model="query" aria-label="搜索发件邮箱" placeholder="搜索邮箱地址" /><button class="text-button">搜索</button></form><label class="admin-filter-check"><input type="checkbox" v-model="pendingOnly" @change="page = 1" />只看待审批</label><button class="outline-button" @click="edit()">配置邮箱</button><button class="icon-button" aria-label="刷新申请列表" :disabled="busy" @click="load"><MailIcon name="refresh" /></button></div>
    <div v-if="error" class="mail-error" role="alert">{{ error }}</div>
    <div class="admin-table-scroll"><table class="admin-table"><thead><tr><th>邮箱地址</th><th>状态</th><th>剩余额度</th><th>申请 / 创建时间（UTC）</th><th>操作</th></tr></thead><tbody><tr v-for="row in rows" :key="row.id"><td><strong>{{ row.address }}</strong></td><td><span class="admin-status" :class="{ pending: row.requested_at, good: row.enabled && row.balance > 0 && !row.requested_at }">{{ status(row) }}</span></td><td>{{ row.balance }} 封</td><td>{{ row.requested_at || row.created_at }}</td><td><button class="text-button" @click="edit(row)">{{ row.requested_at ? '审核申请' : '调整权限' }}</button></td></tr><tr v-if="!rows.length"><td colspan="5" class="admin-empty">{{ busy ? '正在读取申请…' : pendingOnly ? '目前没有待审批的发件申请' : '暂无发件权限记录。用户可在写信窗口提交申请，也可点击“配置邮箱”直接设置。' }}</td></tr></tbody></table></div>
    <div class="admin-pagination"><span>共 {{ count }} 个邮箱</span><button class="icon-button" aria-label="上一页" :disabled="page === 1 || busy" @click="page--"><MailIcon name="prev" /></button><span>{{ page }}</span><button class="icon-button" aria-label="下一页" :disabled="page * 20 >= count || busy" @click="page++"><MailIcon name="next" /></button></div>
    <n-modal v-model:show="modal" preset="card" :title="title" class="mail-modal" :mask-closable="!saving" :closable="!saving"><form class="sender-form" @submit.prevent="save"><label>邮箱地址<n-input v-model:value="form.address" :disabled="!!editing || saving" placeholder="填写已经存在的邮箱地址" /></label><label>剩余发件额度<n-input-number v-model:value="form.balance" :min="0" :max="100000" :precision="0" :disabled="saving" /></label><n-checkbox v-model:checked="form.enabled" :disabled="saving">允许发件</n-checkbox><p class="muted">启用且额度大于 0 时，用户才可以发信。取消勾选并保存，将关闭发件权限。</p><div class="sender-form-actions"><n-button :disabled="saving" @click="modal = false">取消</n-button><n-button type="primary" attr-type="submit" :loading="saving">确认保存</n-button></div></form></n-modal>
  </div>
</template>
<style scoped>
.sender-form{display:grid;gap:22px}.sender-form>label{display:grid;gap:8px}.sender-form-actions{display:flex;justify-content:flex-end;gap:12px}.sender-form .muted{line-height:1.7}
</style>
