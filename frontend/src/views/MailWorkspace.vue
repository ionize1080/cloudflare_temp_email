<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { useLocalStorage, useSessionStorage, useMediaQuery } from '@vueuse/core';
import { useMessage, useNotification } from 'naive-ui';
import { useGlobalState } from '../store';
import { api } from '../api';
import { processItem } from '../utils/email-parser';
import MailIcon from '../components/MailIcon.vue';
import SafeMail from '../components/SafeMail.vue';
import SendAccess from '../components/SendAccess.vue';
import ClientAccess from '../components/ClientAccess.vue';
import Login from './common/Login.vue';
import AddressBar from './index/AddressBar.vue';
import AccountSettings from './index/AccountSettings.vue';
import Appearance from './common/Appearance.vue';
import AutoReply from './index/AutoReply.vue';
import Webhook from './index/Webhook.vue';
import Attachment from './index/Attachment.vue';
import '../styles/mail.css';

const { settings, openSettings, jwt, auth, adminAuth, userJwt, userSettings, isDark, toggleDark, sendMailModel, indexTab } = useGlobalState();
const message = useMessage(), notification = useNotification(), router = useRouter();
const folder = ref('inbox'), query = ref(''), appliedQuery = ref(''), page = ref(1), total = ref(0);
const rows = ref([]), selected = ref(null), checked = ref([]), busy = ref(false), error = ref('');
const sidebar = ref(false), composing = ref(false), minimized = ref(false), expanded = ref(false), sending = ref(false);
const isMobile = useMediaQuery('(max-width:760px)'), navCollapsed = ref(false);
function toggleNavigation() { if (isMobile.value) sidebar.value = !sidebar.value; else navCollapsed.value = !navCollapsed.value; }
const settingsOpen = ref(false), accountOpen = ref(false), deleteOpen = ref(false), discardOpen = ref(false);
const pendingDelete = ref([]), loginReady = ref(false), searchInput = ref(null), composeTo = ref(null);
const sitePassword = ref(''), needsSitePassword = ref(false);
const flags = useLocalStorage('ionacs-mail-flags-v1', {});
const drafts = useSessionStorage('ionacs-drafts-v1', {});
const draft = ref({ to: '', subject: '', body: '' });
const size = 25;
const address = computed(() => settings.value.address || '');
const title = computed(() => ({ inbox: '收件箱', sent: '已发送', drafts: '草稿' })[folder.value]);
const flagKey = (id) => `${address.value}:${folder.value}:${id}`;
const flag = (id) => flags.value[flagKey(id)] || {};
const draftExists = computed(() => !!(draft.value.to || draft.value.subject || draft.value.body));
const allChecked = computed(() => rows.value.length > 0 && checked.value.length === rows.value.length);
const subtitle = (row) => (row.text || '').replace(/\s+/g, ' ').slice(0, 140);
const sender = (row) => (folder.value === 'sent' ? row.to : row.source) || '未知发件人';
const senderName = (row) => sender(row).replace(/<[^>]*>/g, '').replace(/["']/g, '').trim() || sender(row);
const stamp = (value) => {
  const date = new Date(value?.includes('T') ? value : `${value?.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return '';
  return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
};
function freeRows(items) { items.forEach(r => (r.attachments || []).forEach(a => URL.revokeObjectURL(a.url))); }
let requestId = 0;
async function refresh() {
  const id = ++requestId;
  const loadedFolder = folder.value;
  if (!address.value || folder.value === 'drafts') { busy.value = false; return; }
  busy.value = true; error.value = ''; checked.value = [];
  try {
    const path = folder.value === 'sent' ? '/api/sendbox' : '/api/mails';
    const res = await api.fetch(`${path}?limit=${size}&offset=${(page.value - 1) * size}&q=${encodeURIComponent(appliedQuery.value)}`, { quiet: true });
    const items = await Promise.all((res.results || []).map(async item => {
      if (loadedFolder !== 'sent') return processItem({ ...item });
      try {
        const data = JSON.parse(item.raw);
        if (data.version === 'smtp-v1') {
          const parsed = await processItem({ ...item, raw: Uint8Array.from(atob(data.mime_base64), c => c.charCodeAt(0)) });
          return { ...parsed, to: data.to_mail };
        }
        const content = data.version === 'v2' ? data.content : data.content?.[0]?.value;
        return { ...item, to: data.to_mail || data.personalizations?.[0]?.to?.[0]?.email, subject: data.subject, text: data.is_html ? '' : content, message: data.is_html || data.content?.[0]?.type === 'text/html' ? content : '', attachments: [] };
      } catch { return { ...item, subject: '无法解析的邮件', text: item.raw, attachments: [] }; }
    }));
    if (id !== requestId) { freeRows(items); return; }
    if (selected.value) selected.value = items.find(item => item.id === selected.value.id) || null;
    freeRows(rows.value); rows.value = items; total.value = Number(res.count || 0);
  } catch (e) { if (id === requestId) error.value = e.message; }
  finally { if (id === requestId) busy.value = false; }
}
function switchFolder(value) { folder.value = value; page.value = 1; selected.value = null; checked.value = []; sidebar.value = false; appliedQuery.value = ''; query.value = ''; refresh(); }
function search() { appliedQuery.value = query.value.trim(); page.value = 1; selected.value = null; refresh(); }
function paginate(delta) { page.value += delta; selected.value = null; refresh(); }
function toggleFlag(id, key) { flags.value = { ...flags.value, [flagKey(id)]: { ...flag(id), [key]: !flag(id)[key] } }; }
function openMail(row) { selected.value = row; flags.value = { ...flags.value, [flagKey(row.id)]: { ...flag(row.id), read: true } }; }
function selectAll() { checked.value = allChecked.value ? [] : rows.value.map(r => r.id); }
function askDelete(ids) { pendingDelete.value = ids; deleteOpen.value = true; }
async function deleteMails() {
  let deleted = 0;
  try {
    for (const id of pendingDelete.value) { await api.fetch(`/api/${folder.value === 'sent' ? 'sendbox' : 'mails'}/${id}`, { method: 'DELETE', quiet: true }); deleted++; }
    message.success(`已删除 ${deleted} 封邮件`);
  } catch (e) { message.error(`已删除 ${deleted} 封；${e.message}`); }
  finally { deleteOpen.value = false; selected.value = null; if (page.value > 1 && deleted === rows.value.length) page.value--; await refresh(); }
}
async function compose() { composing.value = true; minimized.value = false; await nextTick(); composeTo.value?.focus(); }
function reply(forward = false) {
  if (draftExists.value && !window.confirm('当前草稿将被替换。继续吗？')) return;
  const mail = selected.value;
  draft.value = { to: forward ? '' : (mail.source.match(/<([^>]+)>/)?.[1] || mail.originalSource || mail.source), subject: `${forward ? 'Fwd' : 'Re'}: ${mail.subject || ''}`, body: `\n\n---------- ${forward ? '转发邮件' : '原始邮件'} ----------\n发件人：${mail.source}\n主题：${mail.subject}\n\n${mail.text || ''}` };
  compose();
}
async function send() {
  if (sending.value) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.value.to.trim()) || !draft.value.subject.trim() || !draft.value.body.trim()) { message.error('请填写有效的收件人、主题和正文。'); return; }
  if (!settings.value.send_balance) { message.error('当前邮箱没有发送额度。'); return; }
  sending.value = true;
  try {
    await api.fetch('/api/send_mail', { method: 'POST', quiet: true, body: JSON.stringify({ from_name: '', to_name: '', to_mail: draft.value.to.trim(), subject: draft.value.subject.trim(), content: draft.value.body, is_html: false }) });
    draft.value = { to: '', subject: '', body: '' }; composing.value = false;
    message.success('邮件已提交发送'); switchFolder('sent'); await api.getSettings();
  } catch (e) { message.error(`发送失败，草稿已保留。${e.message}`); }
  finally { sending.value = false; }
}
function discard() { draft.value = { to: '', subject: '', body: '' }; composing.value = false; discardOpen.value = false; }
function download(row) {
  const blob = new Blob([row.raw], { type: folder.value === 'sent' ? 'application/json' : 'message/rfc822' });
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `mail-${row.id}.${folder.value === 'sent' ? 'json' : 'eml'}`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function logout() {
  jwt.value = ''; auth.value = ''; adminAuth.value = ''; userJwt.value = ''; userSettings.value = {}; settings.value = { fetched: true, address: '' }; drafts.value = {}; flags.value = {};
  for (const key of ['jwt', 'auth', 'adminAuth', 'userJwt', 'sendMailModel', 'addressPassword']) { localStorage.removeItem(key); sessionStorage.removeItem(key); }
  location.assign('/cdn-cgi/access/logout');
}
async function unlockSite() { auth.value = sitePassword.value; try { await api.fetch('/health_check'); needsSitePassword.value = false; await api.getSettings(); } catch (e) { message.error(e.message); } }
function keyboard(e) {
  if (e.key === 'Escape') { selected.value = null; sidebar.value = false; if (composing.value) minimized.value = true; return; }
  if (e.target.closest('input,textarea,[contenteditable=true]') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); searchInput.value?.focus(); }
  if (e.key === 'c' && address.value) compose();
}
watch(address, (value) => { requestId++; freeRows(rows.value); rows.value = []; selected.value = null; checked.value = []; draft.value = drafts.value[value] || { to: '', subject: '', body: '' }; page.value = 1; if (loginReady.value) refresh(); });
watch(draft, (value) => { if (address.value) drafts.value = { ...drafts.value, [address.value]: { ...value } }; }, { deep: true });
watch(indexTab, value => { if (value === 'sendmail') { draft.value = { to: sendMailModel.value.toMail, subject: sendMailModel.value.subject, body: sendMailModel.value.content }; compose(); indexTab.value = 'mailbox'; } });
let timer;
onMounted(async () => {
  document.title = 'IONACS Mail'; document.addEventListener('keydown', keyboard);
  await api.getOpenSettings(message, notification); needsSitePassword.value = openSettings.value.needAuth && !auth.value;
  try { await api.getSettings(); } catch (e) { error.value = e.message; }
  loginReady.value = true;
  draft.value = drafts.value[address.value] || { to: '', subject: '', body: '' };
  await refresh();
  timer = setInterval(() => { if (!document.hidden && !selected.value && !busy.value && !composing.value) refresh(); }, 60000);
});
onBeforeUnmount(() => { clearInterval(timer); requestId++; freeRows(rows.value); document.removeEventListener('keydown', keyboard); });
</script>

<template>
  <div class="mail-app" :class="{ 'mail-dark': isDark }">
    <header class="mail-header">
      <div class="mail-brand"><button v-if="address" class="icon-button" aria-label="展开导航" :aria-expanded="isMobile ? sidebar : !navCollapsed" @click="toggleNavigation"><MailIcon name="menu" /></button><a href="/" class="brand-link"><span class="brand-mark"><MailIcon name="mail" :size="25" /></span><span>IONACS <b>Mail</b></span></a></div>
      <form v-if="address" class="mail-search" role="search" @submit.prevent="search"><MailIcon name="search" /><input ref="searchInput" v-model="query" aria-label="搜索邮件" placeholder="搜索邮件" /><button v-if="query" type="button" class="icon-button" aria-label="清除搜索" @click="query = ''; search()"><MailIcon name="close" :size="18" /></button><kbd>/</kbd></form>
      <div class="header-actions"><span class="private-badge"><MailIcon name="shield" :size="15" />私人邮箱</span><button class="icon-button" aria-label="切换明暗外观" title="切换明暗外观" @click="toggleDark()"><MailIcon name="sun" /></button><button v-if="address" class="icon-button" aria-label="设置" @click="settingsOpen = true"><MailIcon name="settings" /></button><button v-if="address" class="account-avatar" :title="address" aria-label="邮箱与账号" @click="accountOpen = true">{{ address[0]?.toUpperCase() }}</button></div>
    </header>

    <main v-if="!address" class="login-stage">
      <section class="login-card"><div class="login-intro"><span class="brand-mark large"><MailIcon name="mail" :size="32" /></span><p class="eyebrow">IONACS MAIL</p><h1>每一次沟通，<br>都井然有序。</h1><p>登录你的私人邮箱。<br>专注收发，让重要的消息有处可寻。</p><div class="login-security"><MailIcon name="shield" :size="18" /><span>Cloudflare Access 保护下的私人空间</span></div></div><div class="login-form"><p class="eyebrow">欢迎回来</p><h2>登录邮箱</h2><p class="muted">使用完整邮箱地址和密码登录，或注册一个新账号。</p><p v-if="!loginReady" role="status">正在连接邮箱…</p><form v-else-if="needsSitePassword" @submit.prevent="unlockSite"><label class="field-label">站点访问密码<input v-model="sitePassword" type="password" required autocomplete="current-password" /></label><button class="primary-button">继续</button></form><Login v-else /><div class="login-links"><router-link to="/user">用户中心</router-link><router-link to="/admin">管理员登录</router-link></div></div></section>
      <footer class="login-footer"><span>IONACS · 你的邮件，你的空间</span><span>安全连接 · mail.ionacs.com</span></footer>
    </main>

    <div v-else class="mail-layout">
      <button v-if="sidebar" class="mobile-shade" aria-label="收起导航" @click="sidebar = false"></button>
      <aside class="mail-sidebar" :class="{ open: sidebar, 'nav-collapsed': navCollapsed }"><button class="compose-button" @click="compose"><MailIcon name="edit" :size="23" />写邮件</button><nav aria-label="邮箱文件夹"><button v-for="item in [{ id: 'inbox', name: '收件箱', icon: 'inbox' }, { id: 'sent', name: '已发送', icon: 'send' }, { id: 'drafts', name: '草稿', icon: 'draft' }]" :key="item.id" :class="['folder-button', { active: folder === item.id }]" :aria-current="folder === item.id ? 'page' : undefined" @click="switchFolder(item.id)"><MailIcon :name="item.icon" /><span>{{ item.name }}</span><b v-if="item.id === 'inbox' && folder === 'inbox' && total">{{ total }}</b><b v-if="item.id === 'drafts' && draftExists">1</b></button></nav><div class="sidebar-divider"></div><button class="folder-button" @click="accountOpen = true"><MailIcon name="mail" /><span>管理邮箱</span></button><button class="folder-button" @click="settingsOpen = true"><MailIcon name="settings" /><span>设置</span></button><router-link class="folder-button" to="/admin"><MailIcon name="shield" /><span>管理控制台</span></router-link><div class="sidebar-bottom"><span class="security-dot"></span>受保护的私人邮箱<small>{{ address }}</small></div></aside>

      <button class="mobile-compose" @click="compose"><MailIcon name="edit" />写邮件</button><section class="mail-surface" :aria-label="title">
        <div class="mail-toolbar"><template v-if="selected"><button class="icon-button" aria-label="返回邮件列表" @click="selected = null"><MailIcon name="back" /></button><button v-if="openSettings.enableUserDeleteEmail" class="icon-button" aria-label="删除邮件" @click="askDelete([selected.id])"><MailIcon name="trash" /></button><button class="icon-button" aria-label="下载原始邮件" @click="download(selected)"><MailIcon name="download" /></button><span class="toolbar-spacer"></span><span class="muted">{{ stamp(selected.created_at) }}</span></template><template v-else><input v-if="folder !== 'drafts'" type="checkbox" :checked="allChecked" aria-label="选择本页全部邮件" @change="selectAll" /><button class="icon-button" aria-label="刷新邮件" :disabled="busy" @click="refresh"><MailIcon name="refresh" /></button><button v-if="checked.length && openSettings.enableUserDeleteEmail" class="icon-button" aria-label="删除选中邮件" @click="askDelete(checked)"><MailIcon name="trash" /></button><span v-if="checked.length" class="muted">已选择 {{ checked.length }} 封</span><span v-else class="toolbar-caption">{{ appliedQuery ? `搜索：${appliedQuery}` : title }}</span><span class="toolbar-spacer"></span><span v-if="folder !== 'drafts'" class="page-count">{{ total ? `${(page - 1) * size + 1}–${Math.min(page * size, total)}` : '0' }} / {{ total }}</span><button class="icon-button" aria-label="上一页" :disabled="page === 1 || busy" @click="paginate(-1)"><MailIcon name="prev" :size="17" /></button><button class="icon-button" aria-label="下一页" :disabled="page * size >= total || busy" @click="paginate(1)"><MailIcon name="next" :size="17" /></button></template></div>
        <div v-if="error" class="mail-error" role="alert">{{ error }}<button @click="refresh">重试</button></div>
        <div v-if="busy" class="mail-progress" role="status" aria-label="正在加载邮件"></div>

        <article v-if="selected" class="reading-pane"><h1>{{ selected.subject || '（无主题）' }}</h1><div class="sender-heading"><div class="sender-avatar">{{ senderName(selected)[0]?.toUpperCase() }}</div><div><strong>{{ senderName(selected) }}</strong><p>{{ sender(selected) }}</p><small>收件人：{{ selected.to || selected.address || address }}</small></div><button class="icon-button star-button" :class="{ starred: flag(selected.id).starred }" aria-label="切换星标" :aria-pressed="!!flag(selected.id).starred" @click="toggleFlag(selected.id, 'starred')"><MailIcon name="star" /></button></div><SafeMail v-if="selected.message" :html="selected.message" /><pre v-else class="plain-message">{{ selected.text }}</pre><div v-if="selected.attachments?.length" class="attachments"><a v-for="a in selected.attachments" :key="a.id" :href="a.url" :download="a.filename" rel="noopener noreferrer"><MailIcon name="attach" /><span>{{ a.filename }}<small>{{ a.size }}</small></span><MailIcon name="download" :size="18" /></a></div><div v-if="folder !== 'sent'" class="reading-actions"><button class="outline-button" @click="reply()"><MailIcon name="reply" />回复</button><button class="outline-button" @click="reply(true)"><MailIcon name="send" />转发</button></div></article>

        <template v-else-if="folder === 'drafts'"><div class="folder-heading"><h1>草稿</h1><p>草稿仅保存在当前浏览器会话，关闭浏览器或退出登录后清除。</p></div><button v-if="draftExists" class="draft-row" @click="compose"><MailIcon name="draft" /><span><strong>{{ draft.subject || '（无主题）' }}</strong><small>{{ draft.to || '尚未填写收件人' }}</small></span><span class="draft-label">草稿</span></button><div v-else class="mail-empty"><MailIcon name="draft" :size="52" /><h2>还没有草稿</h2><p>未发送的邮件会暂存在这里。</p><button class="text-button" @click="compose">写一封邮件</button></div></template>
        <template v-else><div class="inbox-tabs"><span class="active"><MailIcon :name="folder === 'sent' ? 'send' : 'inbox'" :size="19" />{{ appliedQuery ? '搜索结果' : title }}</span><small>{{ appliedQuery ? '在当前文件夹中搜索' : '所有邮件，尽在此处' }}</small></div><div v-if="!rows.length && !busy && !error" class="mail-empty"><div class="empty-illustration"><MailIcon :name="appliedQuery ? 'search' : 'inbox'" :size="54" /><i></i></div><h2>{{ appliedQuery ? '没有找到匹配的邮件' : folder === 'sent' ? '还没有已发送的邮件' : '收件箱很清爽' }}</h2><p>{{ appliedQuery ? '换一个关键词，再试一次。' : folder === 'sent' ? '发出的每一封邮件，都会在这里留存。' : '新的来信会出现在这里。你也可以开始一段对话。' }}</p><button v-if="!appliedQuery" class="text-button" @click="compose">写一封邮件</button></div><div class="mail-list"><div v-for="row in rows" :key="row.id" class="mail-row" :class="{ unread: folder === 'inbox' && !flag(row.id).read, selected: checked.includes(row.id) }"><input type="checkbox" v-model="checked" :value="row.id" :aria-label="`选择 ${row.subject || '无主题'}`" /><button class="icon-button star-button" :class="{ starred: flag(row.id).starred }" :aria-label="`${flag(row.id).starred ? '取消' : '添加'}星标`" :aria-pressed="!!flag(row.id).starred" @click="toggleFlag(row.id, 'starred')"><MailIcon name="star" :size="19" /></button><button class="mail-row-content" @click="openMail(row)"><span class="row-sender">{{ senderName(row) }}</span><span class="row-summary"><strong>{{ row.subject || '（无主题）' }}</strong><span> — {{ subtitle(row) }}</span></span><MailIcon v-if="row.attachments?.length" name="attach" :size="16" /><time>{{ stamp(row.created_at) }}</time></button></div></div></template>
        <footer class="mail-list-footer"><span>IONACS Mail</span><span>星标与已读状态保存在本机 · 每分钟自动检查新邮件</span></footer>
      </section>
    </div>

    <section v-if="composing" class="compose-window" :class="{ minimized, expanded }" role="dialog" aria-label="写邮件" @keydown.ctrl.enter.prevent="send" @keydown.meta.enter.prevent="send"><header @dblclick="minimized = !minimized"><strong>新邮件</strong><span v-if="draftExists">会话草稿已暂存</span><button class="icon-button" aria-label="最小化写信窗口" @click="minimized = !minimized">−</button><button class="icon-button" aria-label="切换写信窗口大小" @click="expanded = !expanded; minimized = false"><MailIcon name="expand" :size="16" /></button><button class="icon-button" aria-label="关闭并暂存草稿" :disabled="sending" @click="composing = false"><MailIcon name="close" :size="17" /></button></header><form v-show="!minimized" @submit.prevent="send"><SendAccess /><fieldset :disabled="sending"><div class="compose-from">发件人 <span>{{ address }}</span></div><label class="compose-field"><span>收件人</span><input ref="composeTo" v-model="draft.to" required type="email" autocomplete="email" aria-label="收件人" /></label><label class="compose-field"><span>主题</span><input v-model="draft.subject" required maxlength="250" aria-label="主题" /></label><textarea v-model="draft.body" required maxlength="100000" placeholder="写下你想说的话…" aria-label="邮件正文"></textarea><div class="compose-actions"><button class="primary-button" type="submit" :disabled="sending || !settings.send_balance"><span>{{ sending ? '发送中…' : '发送' }}</span><MailIcon name="send" :size="17" /></button><span class="compose-hint">{{ settings.send_balance ? 'Ctrl / ⌘ + Enter 发送' : '审批通过后即可发送，草稿会继续保留' }}</span><button type="button" class="icon-button" aria-label="丢弃草稿" @click="discardOpen = true"><MailIcon name="trash" :size="19" /></button></div></fieldset></form></section>

    <n-modal v-model:show="accountOpen" preset="card" title="邮箱与账号" class="mail-modal"><SendAccess /><ClientAccess /><AddressBar /><div class="account-links"><router-link to="/user">用户中心与地址管理</router-link><button class="outline-button" @click="logout"><MailIcon name="logout" />退出邮箱与 Access</button></div></n-modal>
    <n-modal v-model:show="settingsOpen" preset="card" title="设置" class="mail-modal"><n-tabs><n-tab-pane name="account" tab="账户"><AccountSettings /></n-tab-pane><n-tab-pane name="appearance" tab="外观"><Appearance /></n-tab-pane><n-tab-pane v-if="openSettings.enableAutoReply" name="reply" tab="自动回复"><AutoReply /></n-tab-pane><n-tab-pane v-if="openSettings.enableWebhook" name="webhook" tab="Webhook"><Webhook /></n-tab-pane><n-tab-pane v-if="openSettings.isS3Enabled" name="attachments" tab="附件"><Attachment /></n-tab-pane></n-tabs></n-modal>
    <n-modal v-model:show="deleteOpen" preset="dialog" title="永久删除邮件？" positive-text="删除" negative-text="取消" @positive-click="deleteMails">将删除 {{ pendingDelete.length }} 封邮件。当前邮件服务不提供垃圾箱，删除后无法恢复。</n-modal>
    <n-modal v-model:show="discardOpen" preset="dialog" title="丢弃这封草稿？" positive-text="丢弃" negative-text="继续编辑" @positive-click="discard">草稿内容将被清除。</n-modal>
  </div>
</template>
