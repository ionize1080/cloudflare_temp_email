<script setup>
import { computed, defineAsyncComponent, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMessage, useNotification } from 'naive-ui';
import { useGlobalState } from '../store';
import { api } from '../api';
import MailIcon from '../components/MailIcon.vue';
import '../styles/mail.css';
import '../styles/admin.css';

const { adminAuth, showAdminAuth, adminTab, isDark, toggleDark } = useGlobalState();
const route = useRoute(), router = useRouter(), message = useMessage(), notification = useNotification();
const ready = ref(false), busy = ref(false), error = ref(''), password = ref(''), navigation = ref(''), mobileNav = ref(false);
const overview = ref(null), refreshKey = ref(0), audit = ref([]), auditCount = ref(0), auditPage = ref(1), auditLoading = ref(false);
const navInput = ref(null);
const navGroups = [
  { label: '工作空间', items: [
    ['overview', '管理概览', 'inbox', '邮箱运行概况与待办'],
    ['senderAccess', '发件审批', 'send', '审批申请、调整发送额度'],
    ['account', '邮箱管理', 'mail', '查询邮箱与管理地址'],
    ['account_create', '创建邮箱', 'edit', '为团队建立新的邮箱'],
    ['user_management', '用户管理', 'users', '账号、角色与地址绑定'],
    ['mails', '收件管理', 'inbox', '查看已接收的邮件'],
    ['sendBox', '发件记录', 'send', '查询历史发件'],
  ]},
  { label: '设置与安全', items: [
    ['security', '安全中心', 'shield', '访问保护与发送服务状态'],
    ['user_settings', '注册与用户设置', 'users', '注册、邮箱验证与白名单'],
    ['account_settings', '邮箱规则', 'settings', '地址规则与邮件转发'],
    ['ipBlacklistSettings', '访问限制', 'shield', 'IP 黑名单与访问规则'],
    ['audit', '操作记录', 'history', '查看管理员最近操作'],
  ]},
  { label: '更多功能', advanced: true, items: [
    ['sendMail', '管理员写信', 'edit', '使用管理权限发送邮件'],
    ['unknow', '未匹配收件人', 'mail', '处理未知地址的邮件'],
    ['userOauth2Settings', '第三方登录', 'link', '管理用户 OAuth 登录'],
    ['roleAddressConfig', '角色与域名', 'users', '设置角色可用的地址域名'],
    ['webhook', 'Webhook', 'link', '邮箱与事件通知'],
    ['mailWebhook', '邮件通知规则', 'link', '邮件事件回调'],
    ['telegram', 'Telegram', 'send', '机器人配置'],
    ['aiExtractSettings', '内容提取', 'search', '邮件内容提取设置'],
    ['maintenance', '数据维护', 'settings', '清理规则与数据维护'],
    ['database', '数据库状态', 'database', '查看数据库版本与迁移'],
    ['workerconfig', '运行配置', 'settings', '只读查看服务配置'],
    ['appearance', '外观设置', 'sun', '个性化邮箱外观'],
  ]},
];
const allItems = navGroups.flatMap(group => group.items);
const componentPaths = {
  senderAccess: 'SenderAccess', account: 'Account', account_create: 'CreateAccount',
  user_management: 'UserManagement', mails: 'Mails', sendBox: 'SendBox', sendMail: 'SendMail',
  unknow: 'MailsUnknow', user_settings: 'UserSettings', account_settings: 'AccountSettings',
  ipBlacklistSettings: 'IpBlacklistSettings', userOauth2Settings: 'UserOauth2Settings',
  roleAddressConfig: 'RoleAddressConfig', webhook: 'Webhook', mailWebhook: 'MailWebhook',
  telegram: 'Telegram', aiExtractSettings: 'AiExtractSettings', maintenance: 'Maintenance',
  database: 'DatabaseManager', workerconfig: 'WorkerConfig',
};
const modules = import.meta.glob('./admin/*.vue');
const components = Object.fromEntries(Object.entries(componentPaths).map(([key, path]) => [key, defineAsyncComponent(modules['./admin/' + path + '.vue'])]));
components.appearance = defineAsyncComponent(() => import('./common/Appearance.vue'));
const current = computed(() => allItems.find(item => item[0] === adminTab.value) || allItems[0]);
const filteredGroups = computed(() => navGroups.map(group => ({ ...group, items: group.items.filter(item => (item[1] + item[3]).includes(navigation.value.trim())) })).filter(group => group.items.length));
const checks = computed(() => {
  const s = overview.value?.security || {};
  return [
    { name: 'Cloudflare Access', good: s.accessVerified, detail: '每次请求校验身份签名，沿用现有访问策略。' },
    { name: '管理员二次鉴权', good: s.adminCheckEnabled && s.adminCredentialConfigured, detail: '管理接口仍要求管理员凭据或授权角色。' },
    { name: '加密密码配置', good: s.encryptedAdminSecret, detail: '管理员密码保存在加密 Secret 中。' },
    { name: '请求频率限制', good: s.rateLimitEnabled, detail: '保护登录、发件申请、发送和管理接口。' },
    { name: '邮箱凭据签名', good: s.jwtConfigured, detail: '邮箱访问使用签名凭据。' },
  ];
});
let lastActive = Date.now(), timer;
function activity() { lastActive = Date.now(); }
function keyboard(event) { activity(); if (event.key === 'Escape') mobileNav.value = false; if (event.key === '/' && !event.target.closest('input,textarea,[contenteditable=true]')) { event.preventDefault(); navInput.value?.focus(); } }
function select(id) { adminTab.value = id; mobileNav.value = false; navigation.value = ''; }
function lock() { adminAuth.value = ''; ready.value = false; password.value = ''; overview.value = null; audit.value = []; showAdminAuth.value = false; }
function logoutAccess() { lock(); location.assign('/cdn-cgi/access/logout'); }
async function refreshOverview() {
  const hadCredential = Boolean(adminAuth.value);
  busy.value = true; error.value = '';
  try { overview.value = await api.fetch('/admin/overview', { quiet: true }); ready.value = true; showAdminAuth.value = false; activity(); }
  catch (e) { if (e.message.includes('401')) { lock(); error.value = hadCredential ? '请输入有效的管理员密码。' : ''; } else error.value = e.message; }
  finally { busy.value = false; }
}
async function login() { adminAuth.value = password.value; await refreshOverview(); password.value = ''; if (ready.value && adminTab.value === 'audit') await loadAudit(); }
async function loadAudit() {
  auditLoading.value = true;
  try { const res = await api.fetch('/admin/audit?offset=' + (auditPage.value - 1) * 50, { quiet: true }); audit.value = res.results || []; auditCount.value = res.count || 0; }
  catch (e) { message.error(e.message); }
  finally { auditLoading.value = false; }
}
async function refreshPage() { if (adminTab.value === 'audit') await loadAudit(); else if (['overview', 'security'].includes(adminTab.value)) await refreshOverview(); else refreshKey.value++; }
watch(() => route.query.tab, value => { if (allItems.some(item => item[0] === value)) adminTab.value = value; });
watch(adminTab, value => {
  if (!allItems.some(item => item[0] === value)) { adminTab.value = 'overview'; return; }
  router.replace({ query: { ...route.query, tab: value } });
  if (ready.value && value === 'audit') loadAudit();
  if (ready.value && ['overview', 'security'].includes(value)) refreshOverview();
});
watch(auditPage, loadAudit);
watch(showAdminAuth, value => { if (value && ready.value) { lock(); error.value = '管理会话已失效，请重新登录。'; } });
onMounted(async () => {
  adminTab.value = allItems.some(item => item[0] === route.query.tab) ? route.query.tab : 'overview';
  document.addEventListener('pointerdown', activity); document.addEventListener('keydown', keyboard);
  timer = setInterval(() => { if (ready.value && Date.now() - lastActive > 15 * 60000) { lock(); error.value = '长时间未操作，管理页面已锁定。'; } }, 30000);
  await api.getOpenSettings(message, notification);
  await refreshOverview();
  if (ready.value && adminTab.value === 'audit') await loadAudit();
});
onBeforeUnmount(() => { clearInterval(timer); document.removeEventListener('pointerdown', activity); document.removeEventListener('keydown', keyboard); });
</script>

<template>
  <div class="mail-app admin-app" :class="{ 'mail-dark': isDark }">
    <header class="mail-header">
      <div class="mail-brand"><button v-if="ready" class="icon-button admin-menu-toggle" aria-label="展开管理导航" :aria-expanded="mobileNav" @click="mobileNav = !mobileNav"><MailIcon name="menu" /></button><a href="/" class="brand-link"><span class="brand-mark"><MailIcon name="mail" :size="25" /></span><span>IONACS <b>Mail</b></span></a></div>
      <div v-if="ready" class="mail-search admin-nav-search"><MailIcon name="search" /><input ref="navInput" v-model="navigation" aria-label="查找管理功能" placeholder="查找管理功能，例如：发件、用户、安全" /><kbd>/</kbd></div>
      <div class="header-actions"><span class="private-badge"><MailIcon name="shield" :size="15" />管理控制台</span><a href="/" class="admin-inbox-link">返回邮箱</a><button class="icon-button" aria-label="切换明暗外观" @click="toggleDark()"><MailIcon name="sun" /></button><button v-if="ready" class="icon-button" aria-label="锁定管理页面" title="锁定管理页面" @click="lock"><MailIcon name="lock" /></button></div>
    </header>
    <main v-if="!ready" class="login-stage">
      <section class="login-card"><div class="login-intro"><span class="brand-mark large"><MailIcon name="shield" :size="32" /></span><p class="eyebrow">IONACS ADMIN</p><h1>让管理有序，<br>让沟通安心。</h1><p>集中管理邮箱、发件申请与访问规则。<br>你的私人邮件空间，从这里开始。</p><div class="login-security"><MailIcon name="shield" :size="18" />保留 Cloudflare Access 身份保护</div></div><form class="login-form admin-login-form" @submit.prevent="login"><p class="eyebrow">管理控制台</p><h2>验证管理员身份</h2><p class="muted">通过 Access 后，输入管理密码继续。无需单独的管理员用户名。</p><label class="field-label">管理密码<input v-model="password" type="password" required autocomplete="current-password" aria-label="管理密码" /></label><p v-if="error" class="mail-error" role="alert">{{ error }}</p><button class="primary-button" :disabled="busy">{{ busy ? '正在验证…' : '进入管理控制台' }}</button><div class="login-links"><a href="/">返回邮箱</a><span>密码不会显示在管理概览中</span></div></form></section>
    </main>
    <div v-else class="mail-layout admin-layout">
      <button v-if="mobileNav" class="mobile-shade" aria-label="收起管理导航" @click="mobileNav = false"></button>
      <aside class="mail-sidebar admin-sidebar" :class="{ open: mobileNav }">
        <button class="compose-button" @click="select('account_create')"><MailIcon name="edit" />创建邮箱</button>
        <nav aria-label="管理功能">
          <template v-for="group in filteredGroups" :key="group.label"><details v-if="group.advanced" :open="!!navigation || group.items.some(item => item[0] === adminTab)"><summary>{{ group.label }}</summary><button v-for="item in group.items" :key="item[0]" :class="['folder-button', { active: adminTab === item[0] }]" :aria-current="adminTab === item[0] ? 'page' : undefined" @click="select(item[0])"><MailIcon :name="item[2]" /><span>{{ item[1] }}</span></button></details><section v-else><h2>{{ group.label }}</h2><button v-for="item in group.items" :key="item[0]" :class="['folder-button', { active: adminTab === item[0] }]" :aria-current="adminTab === item[0] ? 'page' : undefined" @click="select(item[0])"><MailIcon :name="item[2]" /><span>{{ item[1] }}</span><b v-if="item[0] === 'senderAccess' && overview?.counts?.pending">{{ overview.counts.pending }}</b></button></section></template>
          <p v-if="!filteredGroups.length" class="admin-nav-empty">没有找到匹配的功能</p>
        </nav>
        <div class="sidebar-bottom"><span class="security-dot"></span>Access 保护已启用<small>{{ overview?.identity }}</small><button class="text-button" @click="logoutAccess">退出管理与 Access</button></div>
      </aside>
      <main class="mail-surface admin-surface">
        <header class="admin-page-heading"><div><p class="eyebrow">IONACS · 管理控制台</p><h1>{{ current[1] }}</h1><p>{{ current[3] }}</p></div><button class="icon-button" aria-label="刷新当前管理页面" :disabled="busy || auditLoading" @click="refreshPage"><MailIcon name="refresh" /></button></header>
        <div v-if="error" class="mail-error" role="alert">{{ error }}</div>
        <div class="admin-page-body">
          <template v-if="adminTab === 'overview'">
            <section class="admin-welcome"><div><span class="admin-status good">服务运行中</span><h2>把日常管理，放在顺手的位置。</h2><p>先处理发件申请，再查看邮箱和安全状态。</p><button class="primary-button" @click="select('senderAccess')">查看发件申请 <MailIcon name="next" :size="16" /></button></div><div class="admin-welcome-mark"><MailIcon name="shield" :size="76" /></div></section>
            <div class="admin-metrics"><button @click="select('senderAccess')"><span>待审批申请</span><strong>{{ overview?.counts?.pending ?? '—' }}</strong><small>等待处理的发件申请</small></button><button @click="select('account')"><span>邮箱地址</span><strong>{{ overview?.counts?.addresses ?? '—' }}</strong><small>{{ overview?.counts?.senders ?? '—' }} 个邮箱可发信</small></button><button @click="select('mails')"><span>收到的邮件</span><strong>{{ overview?.counts?.received ?? '—' }}</strong><small>保留的邮件总数</small></button><button @click="select('sendBox')"><span>发出的邮件</span><strong>{{ overview?.counts?.sent ?? '—' }}</strong><small>已留存的发送记录</small></button></div>
            <div class="admin-overview-grid"><section class="admin-panel"><h2>常用操作</h2><button class="admin-shortcut" @click="select('account_create')"><MailIcon name="edit" /><span><strong>创建新邮箱</strong><small>为新成员准备邮件地址</small></span><MailIcon name="next" /></button><button class="admin-shortcut" @click="select('user_settings')"><MailIcon name="users" /><span><strong>注册与用户设置</strong><small>注册开关、白名单与邮箱验证</small></span><MailIcon name="next" /></button><button class="admin-shortcut" @click="select('audit')"><MailIcon name="history" /><span><strong>查看操作记录</strong><small>追踪管理变更与执行结果</small></span><MailIcon name="next" /></button></section><section class="admin-panel"><h2>安全状态</h2><div v-for="check in checks.slice(0, 4)" :key="check.name" class="admin-check-row"><MailIcon :name="check.good ? 'check' : 'shield'" /><span>{{ check.name }}</span><b :class="{ warning: !check.good }">{{ check.good ? '已启用' : '需检查' }}</b></div><button class="text-button" @click="select('security')">查看安全中心 →</button></section></div>
          </template>
          <template v-else-if="adminTab === 'security'">
            <div class="admin-callout"><MailIcon name="shield" /><p>这里展示服务当前的安全配置。Access 的允许名单与登录方式继续由现有 Cloudflare 策略控制。</p></div>
            <div class="admin-security-grid"><section v-for="check in checks" :key="check.name" class="admin-panel"><span class="admin-status" :class="{ good: check.good, pending: !check.good }">{{ check.good ? '已启用' : '需检查' }}</span><h2>{{ check.name }}</h2><p>{{ check.detail }}</p></section><section class="admin-panel"><span class="admin-status good">当前会话</span><h2>管理页面自动锁定</h2><p>15 分钟无操作后清除本页管理密码；可随时点击右上角锁定。Access 会话仍按原策略有效。</p></section></div>
            <section class="admin-panel admin-domain-panel"><h2>发件服务</h2><p>已配置表示存在服务凭据；域名验证、供应商额度与实际投递结果仍以发送服务为准。</p><div v-for="domain in overview?.domains" :key="domain.domain" class="admin-check-row"><MailIcon name="mail" /><span>{{ domain.domain }}</span><b :class="{ warning: !domain.outboundConfigured }">{{ domain.outboundConfigured ? '已配置发送服务' : '尚未配置发送服务' }}</b></div></section>
          </template>
          <template v-else-if="adminTab === 'audit'">
            <div class="admin-callout"><MailIcon name="history" /><p>保留最近 1000 条已鉴权的管理操作（含查看邮箱凭据），从本次更新开始记录。只记录操作者、接口和结果，不记录密码、令牌、请求正文或邮件正文。时间为 UTC。</p></div>
            <div class="admin-table-scroll"><table class="admin-table"><thead><tr><th>时间（UTC）</th><th>操作者</th><th>操作</th><th>结果</th></tr></thead><tbody><tr v-for="item in audit" :key="item.id"><td>{{ item.created_at }}</td><td>{{ item.actor }}</td><td><code>{{ item.method }} {{ item.path }}</code></td><td><span class="admin-status" :class="{ good: item.status < 400, pending: item.status >= 400 }">{{ item.status < 400 ? '成功' : '失败' }} · {{ item.status }}</span></td></tr><tr v-if="!audit.length"><td colspan="4" class="admin-empty">{{ auditLoading ? '正在加载…' : '暂无操作记录。之后的管理变更会显示在这里。' }}</td></tr></tbody></table></div>
            <div class="admin-pagination"><span>共 {{ auditCount }} 条</span><button class="icon-button" aria-label="上一页记录" :disabled="auditPage === 1 || auditLoading" @click="auditPage--"><MailIcon name="prev" /></button><span>{{ auditPage }}</span><button class="icon-button" aria-label="下一页记录" :disabled="auditPage * 50 >= auditCount || auditLoading" @click="auditPage++"><MailIcon name="next" /></button></div>
          </template>
          <div v-else class="admin-legacy-panel"><div v-if="adminTab === 'maintenance'" class="admin-callout danger"><MailIcon name="shield" /><p>清理操作会永久移除数据。请确认清理范围；已有备份不等于可以在网页内撤销。</p></div><component :is="components[adminTab]" :key="adminTab + ':' + refreshKey" @changed="refreshOverview" /></div>
        </div>
        <footer class="admin-footer"><span>IONACS Mail · 管理控制台</span><span>mail.ionacs.com</span></footer>
      </main>
    </div>
  </div>
</template>
