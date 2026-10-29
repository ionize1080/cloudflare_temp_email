<script setup>
import { onMounted, ref } from 'vue';
import { useMessage } from 'naive-ui';
import { api } from '../api';
import { useGlobalState } from '../store';
const { settings } = useGlobalState();
const message = useMessage(), data = ref(null), busy = ref(false), label = ref(''), secret = ref(''), secretOpen = ref(false);
const password = ref(''), confirm = ref(''), passwordOpen = ref(false);
async function load() { try { data.value = await api.fetch('/api/imap/settings', { quiet: true }); } catch (e) { message.error(e.message); } }
async function request() { busy.value = true; try { await api.fetch('/api/imap/request', { method: 'POST', body: '{}', quiet: true }); await load(); message.success('申请已提交，等待管理员审批。'); } catch (e) { message.error(e.message); } finally { busy.value = false; } }
async function generate() { busy.value = true; try { const res = await api.fetch('/api/imap/passwords', { method: 'POST', body: JSON.stringify({ label: label.value }), quiet: true }); secret.value = res.password; secretOpen.value = true; label.value = ''; await load(); } catch (e) { message.error(e.message); } finally { busy.value = false; } }
async function revoke(id) { busy.value = true; try { await api.fetch('/api/imap/passwords/' + id, { method: 'DELETE', quiet: true }); await load(); message.success('客户端密码已撤销'); } catch (e) { message.error(e.message); } finally { busy.value = false; } }
async function savePassword() { if (password.value !== confirm.value) { message.error('两次密码不一致'); return; } busy.value = true; try { await api.fetch('/api/address_change_password', { method: 'POST', body: JSON.stringify({ new_password: password.value }), quiet: true }); password.value = ''; confirm.value = ''; passwordOpen.value = false; await load(); message.success('登录密码已保存，原 IMAP 客户端密码已撤销。'); } catch (e) { message.error(e.message); } finally { busy.value = false; } }
async function copy() { try { await navigator.clipboard.writeText(secret.value); message.success('已复制'); } catch { message.info('请选中并复制专用密码'); } }
onMounted(load);
</script>
<template>
  <section class="client-access">
    <div class="client-title"><h3>账号密码</h3><button class="text-button" @click="passwordOpen = !passwordOpen">设置 / 修改登录密码</button></div>
    <p class="muted">登录账号：{{ settings.address }}。已有邮箱可在这里设置密码。</p>
    <form v-if="passwordOpen" @submit.prevent="savePassword" class="client-form"><label>新密码<input v-model="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password" placeholder="12–128 个字符" /></label><label>确认密码<input v-model="confirm" type="password" required minlength="12" maxlength="128" autocomplete="new-password" /></label><small>修改后将撤销所有 IMAP 客户端专用密码，需重新生成。</small><button class="primary-button" :disabled="busy">保存密码</button></form>
    <div class="client-title"><h3>第三方客户端 · IMAP</h3><button class="text-button" :disabled="busy" @click="load">刷新状态</button></div>
    <template v-if="data">
      <p v-if="data.state === 'pending'" role="status">申请已提交，等待管理员审批。</p>
      <template v-else-if="data.state !== 'approved'"><p class="muted">需先申请 IMAP 权限。开通后可生成独立的客户端密码；发件权限另行申请。</p><button class="outline-button" :disabled="busy" @click="request">{{ data.state === 'disabled' ? '重新申请 IMAP 权限' : '申请 IMAP 权限' }}</button></template>
      <template v-else>
        <p class="client-approved">IMAP 权限已开通</p>
        <p v-if="!data.available" class="muted">管理员正在配置服务入口，准备完成后会显示连接信息。</p>
        <dl v-else class="client-config"><dt>服务器</dt><dd>{{ data.host }}</dd><dt>端口 / 安全</dt><dd>{{ data.port }} / SSL/TLS</dd><dt>用户名</dt><dd>{{ settings.address }}</dd><dt>密码</dt><dd>下方生成的客户端专用密码</dd></dl>
        <p class="muted">支持收件箱、已发送、已读标记与删除同步。IMAP 用于收信，发送邮件请使用网页邮箱。</p>
        <form @submit.prevent="generate" class="client-create"><input v-model="label" maxlength="50" required aria-label="客户端名称" placeholder="客户端名称，例如 Outlook 笔记本" /><button class="outline-button" :disabled="busy || data.passwords.length >= 5">生成专用密码</button></form>
        <ul class="client-passwords"><li v-for="item in data.passwords" :key="item.id"><span><b>{{ item.label }}</b><small>{{ item.last_used_at ? '最近使用（UTC）：' + item.last_used_at : '尚未使用' }}</small></span><n-popconfirm @positive-click="revoke(item.id)" positive-text="撤销" negative-text="取消"><template #trigger><button class="text-button" :disabled="busy">撤销</button></template>撤销后此客户端将无法继续连接，需要重新生成密码。</n-popconfirm></li></ul>
        <small class="muted">最多 5 个客户端。停用 IMAP 或修改登录密码会撤销所有客户端密码。</small>
      </template>
    </template>
    <n-modal v-model:show="secretOpen" preset="card" title="保存客户端专用密码" class="mail-modal" @after-leave="secret = ''"><p>仅显示这一次。请保存到你的邮件客户端；不要使用网页登录密码替代。</p><input class="client-secret" :value="secret" readonly aria-label="新客户端专用密码" /><button class="primary-button" @click="copy">复制专用密码</button><p class="muted">生成密码不会自动开通发件权限。</p></n-modal>
  </section>
</template>
<style scoped>
.client-access{margin:20px 0;padding:20px;border:1px solid var(--mail-border,#e0e5ec);border-radius:16px;text-align:left}.client-title{display:flex;align-items:center;justify-content:space-between;gap:12px}.client-title h3{font-size:16px;margin:12px 0}.client-form{display:grid;gap:12px;margin:12px 0 24px}.client-form label{display:grid;gap:6px}.client-access input{min-width:0;box-sizing:border-box;padding:12px;border:1px solid #b8c4d4;border-radius:8px;background:transparent;color:inherit;font:inherit}.client-create{display:flex;gap:8px;flex-wrap:wrap}.client-create input{flex:1;min-width:180px}.client-config{display:grid;grid-template-columns:90px 1fr;gap:10px;font-size:13px}.client-config dd{margin:0;overflow-wrap:anywhere}.client-config dt{color:#68758a}.client-approved{color:#188038}.client-passwords{padding:0;list-style:none}.client-passwords li{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid #e0e5ec}.client-passwords small{display:block;color:#68758a;margin-top:5px}.client-secret{display:block;width:100%;font-family:monospace;margin:16px 0;padding:12px;box-sizing:border-box}.client-access .muted{line-height:1.65}
</style>
