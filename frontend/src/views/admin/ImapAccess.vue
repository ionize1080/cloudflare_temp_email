<script setup>
import { ref, onMounted, watch } from 'vue';
import { useMessage } from 'naive-ui';
import { api } from '../../api';
import MailIcon from '../../components/MailIcon.vue';
const message = useMessage();
const emit = defineEmits(['changed']);
const rows = ref([]), count = ref(0), page = ref(1), query = ref(''), pending = ref(false), busy = ref(false), error = ref('');
const modal = ref(false), editing = ref(null), enabled = ref(false), saving = ref(false);
const status = row => row.enabled ? '已开通' : row.requested_at ? '等待审批' : row.reviewed_at ? '已停用 / 未通过' : '未申请';
async function load() { busy.value = true; error.value = ''; try { const res = await api.fetch('/admin/imap?offset=' + (page.value - 1) * 20 + '&q=' + encodeURIComponent(query.value.trim()) + '&pending=' + (pending.value ? '1' : '0'), { quiet: true }); rows.value = res.results || []; count.value = res.count || 0; } catch (e) { error.value = e.message; } finally { busy.value = false; } }
function edit(row) { editing.value = row; enabled.value = Boolean(row.enabled || row.requested_at); modal.value = true; }
async function save() { saving.value = true; try { await api.fetch('/admin/imap', { method: 'POST', body: JSON.stringify({ address_id: editing.value.address_id, enabled: enabled.value }), quiet: true }); modal.value = false; message.success('IMAP 权限已更新'); await load(); emit('changed'); } catch (e) { message.error(e.message); } finally { saving.value = false; } }
function search() { page.value = 1; load(); }
watch([page, pending], load); onMounted(load);
</script>
<template>
  <div>
    <div class="admin-callout"><MailIcon name="shield" /><p>用户在“邮箱与账号 → 第三方客户端”提交申请。批准后由用户生成客户端专用密码。<b>停用会立即撤销所有客户端密码</b>，再次开通后需重新生成；发件权限独立管理。</p></div>
    <div class="admin-filterbar"><form @submit.prevent="search"><MailIcon name="search" /><input v-model="query" placeholder="搜索邮箱地址" aria-label="搜索 IMAP 邮箱" /><button class="text-button">搜索</button></form><label class="admin-filter-check"><input type="checkbox" v-model="pending" @change="page = 1" />只看待审批</label><button class="icon-button" :disabled="busy" @click="load" aria-label="刷新 IMAP 申请"><MailIcon name="refresh" /></button></div>
    <div v-if="error" role="alert" class="mail-error">{{ error }}</div>
    <div class="admin-table-scroll"><table class="admin-table"><thead><tr><th>邮箱地址</th><th>IMAP 权限</th><th>客户端密码数</th><th>申请 / 审批时间（UTC）</th><th>操作</th></tr></thead><tbody><tr v-for="row in rows" :key="row.address_id"><td><strong>{{ row.address }}</strong></td><td><span class="admin-status" :class="{ pending: row.requested_at, good: row.enabled }">{{ status(row) }}</span></td><td>{{ row.clients }} / 5</td><td>{{ row.requested_at || row.reviewed_at || '—' }}</td><td><button class="text-button" @click="edit(row)">{{ row.requested_at ? '审核申请' : '调整权限' }}</button></td></tr><tr v-if="!rows.length"><td colspan="5" class="admin-empty">{{ busy ? '正在读取…' : '没有匹配的邮箱或申请' }}</td></tr></tbody></table></div>
    <div class="admin-pagination"><span>共 {{ count }} 个邮箱</span><button class="icon-button" :disabled="page === 1 || busy" @click="page--" aria-label="上一页"><MailIcon name="prev" /></button><span>{{ page }}</span><button class="icon-button" :disabled="page * 20 >= count || busy" @click="page++" aria-label="下一页"><MailIcon name="next" /></button></div>
    <n-modal v-model:show="modal" preset="card" title="审核 IMAP 权限" class="mail-modal"><p><b>{{ editing?.address }}</b></p><n-checkbox v-model:checked="enabled" :disabled="saving">允许使用 IMAP 客户端</n-checkbox><p class="muted">关闭并保存会撤销该邮箱的全部客户端专用密码。网页邮箱与发件权限不受影响。</p><div style="display:flex;justify-content:flex-end;gap:12px"><n-button :disabled="saving" @click="modal = false">取消</n-button><n-button type="primary" :loading="saving" @click="save">确认保存</n-button></div></n-modal>
  </div>
</template>
