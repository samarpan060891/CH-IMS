// App shell: authentication, role-based navigation, routing
import { createApp } from 'vue';
import { sb, state, route, go, hasRole, canSeeCost, ROLES, run, must, toast, loadCompany, loadRefs, refreshPending, errMsg, markRead, dtm } from './lib.js';
import { dialog, FieldInput, Modal, Icon } from './components.js';
import { DocList, DocEditor } from './docengine.js';
import { DOCS } from './documents.js';
import { MASTERS, MasterPage } from './masters.js';
import { Dashboard, Reports, Replenishment, Assets, Users, Settings, BufferReview } from './pages.js';
import { CONFIG } from './config.js';
import { Importer } from './importer.js';
import { Logo } from './logo.js';

const ALL = null;
// Dashboard is the fixed home link; below it four main menus in workflow order.
// { sep } entries are small sub-headings inside a menu.
const MENU = [
  { g: 'Purchase', icon: 'shopping-cart', items: [
    { to: 'replenish', t: 'Replenishment', roles: ['purchase', 'stores', 'factory_manager'] },
    { to: 'buffers', t: 'Buffer review', roles: ['purchase', 'factory_manager', 'stores'], badge: 'dbm' },
    { to: 'd/pr', t: 'Requisitions', roles: ['purchase', 'stores', 'factory_manager', 'production_incharge'] },
    { to: 'd/po', t: 'Purchase orders', roles: ['purchase', 'factory_manager', 'finance', 'stores'], badge: 'po' },
    { to: 'm/vendors', t: 'Vendors', roles: ['purchase', 'finance', 'factory_manager'] },
    { to: 'm/item_vendors', t: 'Vendor price list', roles: ['purchase', 'finance', 'factory_manager'] },
  ] },
  { g: 'Inventory', icon: 'building-warehouse', items: [
    { sep: 'Shop floor' },
    { to: 'd/mr', t: 'Material requests', roles: ALL, badge: 'mr' },
    { sep: 'Stores' },
    { to: 'd/grn', t: 'Goods receipts (GRN)', roles: ['stores', 'purchase', 'finance', 'factory_manager'] },
    { to: 'd/issue', t: 'Material issues', roles: ['stores', 'factory_manager', 'production_incharge'], badge: 'issue' },
    { to: 'd/ret', t: 'Returns from floor', roles: ['stores', 'factory_manager', 'production_incharge'] },
    { to: 'd/trf', t: 'Stock transfers', roles: ['stores', 'factory_manager'] },
    { to: 'd/rel', t: 'Project stock releases', roles: ['stores', 'factory_manager', 'production_incharge'], badge: 'rel' },
    { to: 'd/adj', t: 'Stock adjustments', roles: ['stores', 'factory_manager', 'finance'], badge: 'adj' },
    { to: 'd/prt', t: 'Purchase returns', roles: ['stores', 'purchase', 'finance'] },
    { sep: 'Assets & scrap' },
    { to: 'assets', t: 'Tool crib & assets', roles: ['stores', 'factory_manager', 'finance', 'production_incharge'] },
    { to: 'd/scrap', t: 'Scrap notes', roles: ['stores', 'production_incharge', 'factory_manager'], badge: 'scrap' },
    { to: 'd/disposal', t: 'Scrap disposals', roles: ['stores', 'factory_manager', 'finance'], badge: 'disposal' },
  ] },
  { g: 'Finance', icon: 'report-money', items: [
    { to: 'd/inv', t: 'Vendor invoices', roles: ['finance', 'factory_manager'] },
    { to: 'd/pay', t: 'Payments', roles: ['finance', 'factory_manager'] },
    { to: 'd/dn', t: 'Debit notes', roles: ['finance'] },
    { to: 'r/payables', t: 'Net payables', roles: ['finance', 'factory_manager', 'purchase'] },
  ] },
  { g: 'Reports & setup', icon: 'settings', items: [
    { to: 'r/stock', t: 'Reports', roles: ALL },
    { to: 'import/items', t: 'Excel import', roles: ['stores', 'purchase', 'finance'] },
    { sep: 'Masters' },
    { to: 'm/items', t: 'Items', roles: ALL },
    { to: 'm/locations', t: 'Locations', roles: ['stores', 'factory_manager'] },
    { to: 'm/projects', t: 'Projects & MTS', roles: ALL },
    { to: 'm/employees', t: 'Employees', roles: ['stores', 'factory_manager', 'production_incharge'] },
    { to: 'm/cost_centers', t: 'Cost centres', roles: ['factory_manager', 'finance', 'stores'] },
    { to: 'm/payment_terms', t: 'Payment terms', roles: ['purchase', 'finance'] },
    { to: 'm/item_categories', t: 'Categories', roles: ['stores', 'purchase'] },
    { to: 'm/item_classes', t: 'Item classes', roles: ['stores', 'purchase', 'finance'] },
    { to: 'm/uoms', t: 'Units of measure', roles: ['stores', 'purchase'] },
    { sep: 'Administration' },
    { to: 'users', t: 'Users & roles', roles: [] },
    { to: 'settings', t: 'Settings', roles: [] },
  ] },
];
const OPEN_KEY = 'ims.menu.open';

const Login = {
  data: () => ({ mode: 'in', email: '', password: '', name: '', busy: false, msg: '' }),
  methods: {
    async submit() {
      this.busy = true; this.msg = '';
      try {
        if (this.mode === 'in') {
          const { error } = await sb.auth.signInWithPassword({ email: this.email.trim(), password: this.password });
          if (error) throw error;
        } else if (this.mode === 'up') {
          const { error } = await sb.auth.signUp({ email: this.email.trim(), password: this.password, options: { data: { full_name: this.name } } });
          if (error) throw error;
          this.msg = 'Account requested. If email confirmation is on, confirm your email; then ask the administrator to activate you.';
        } else {
          const { error } = await sb.auth.resetPasswordForEmail(this.email.trim(), { redirectTo: location.origin + location.pathname });
          if (error) throw error;
          this.msg = 'Password reset email sent.';
        }
      } catch (e) { this.msg = errMsg(e); }
      this.busy = false;
    },
  },
  components: { Logo },
  template: `<div class="login"><form class="box" @submit.prevent="submit">
    <div style="text-align:center;margin-bottom:10px"><Logo :size="120" /></div>
    <h1 style="text-align:center">Citi Homes — Inventory</h1>
    <p style="text-align:center">Kitchen & Wooden Furniture Manufacturing LLC</p>
    <div class="grid" style="grid-template-columns:1fr">
      <label class="f" v-if="mode==='up'">Full name<input v-model="name" required></label>
      <label class="f">Email<input v-model="email" type="email" required autocomplete="username"></label>
      <label class="f" v-if="mode!=='reset'">Password<input v-model="password" type="password" required autocomplete="current-password" minlength="8"></label>
      <button class="btn primary" :disabled="busy" style="justify-content:center">{{ mode==='in' ? 'Sign in' : mode==='up' ? 'Request account' : 'Send reset link' }}</button>
      <div v-if="msg" class="small" style="color:#b91c1c">{{ msg }}</div>
      <div class="row small">
        <a href="javascript:void 0" v-if="mode!=='in'" @click="mode='in'">Sign in</a>
        <a href="javascript:void 0" v-if="mode!=='up'" @click="mode='up'">Request an account</a>
        <a href="javascript:void 0" v-if="mode!=='reset'" @click="mode='reset'">Forgot password?</a>
      </div>
    </div>
  </form></div>`,
};

const App = {
  components: { Login, DocList, DocEditor, MasterPage, Dashboard, Reports, Replenishment, Assets, Users, Settings, Importer, BufferReview, FieldInput, Modal, Logo, Icon },
  data: () => ({ state, route, dialog, ready: false, sideOpen: false, bellOpen: false, ROLES, openGroup: null }),
  watch: {
    // opening a page expands its menu group
    activeGroup: { immediate: true, handler(g) { if (g) this.openGroup = g; } },
  },
  computed: {
    company() { return state.company; },
    unread() { return state.notifs.filter(n => !n.read).length; },
    menu() {
      return MENU.map(g => {
        const allowed = g.items.filter(i => i.sep || i.roles === null || hasRole(...i.roles));
        // drop sub-headings with nothing under them
        const items = allowed.filter((i, n) => !i.sep || (allowed[n + 1] && !allowed[n + 1].sep));
        return { ...g, items };
      }).filter(g => g.items.some(i => !i.sep));
    },
    activeGroup() { return this.menu.find(g => g.items.some(i => !i.sep && this.active(i.to)))?.g || null; },
    view() {
      const [a, b, c] = route.parts;
      if (a === 'd' && DOCS[b]) return c ? { comp: 'DocEditor', props: { cfg: DOCS[b], id: c }, title: DOCS[b].title } : { comp: 'DocList', props: { cfg: DOCS[b] }, title: DOCS[b].title };
      if (a === 'm' && MASTERS[b]) return { comp: 'MasterPage', props: { cfg: MASTERS[b] }, title: MASTERS[b].title };
      if (a === 'r') return { comp: 'Reports', props: { rkey: b || 'stock' }, title: 'Reports' };
      if (a === 'import') return { comp: 'Importer', props: { tkey: b || 'items' }, title: 'Excel import' };
      const simple = { dashboard: ['Dashboard', 'Dashboard'], replenish: ['Replenishment', 'Replenishment'], buffers: ['BufferReview', 'Buffer review'], assets: ['Assets', 'Tool crib & assets'], users: ['Users', 'Users & roles'], settings: ['Settings', 'Settings'] };
      if (simple[a]) return { comp: simple[a][0], props: {}, title: simple[a][1] };
      return { comp: 'Dashboard', props: {}, title: 'Dashboard' };
    },
    viewKey() { return route.path; },
  },
  methods: {
    hasRole, canSeeCost, dtm,
    async openNotif(n) { this.bellOpen = false; await run(() => markRead([n.id])); if (n.link) go(n.link); },
    async readAll() { await run(() => markRead(state.notifs.map(n => n.id))); },
    active(to) { return route.path === to || route.path.startsWith(to + '/') || (to === 'r/stock' && route.parts[0] === 'r' && route.path !== 'r/payables') || (to.startsWith('import') && route.parts[0] === 'import'); },
    nav(to) { go(to); this.sideOpen = false; },
    toggle(g) {
      this.openGroup = this.openGroup === g ? null : g;
      try { localStorage.setItem(OPEN_KEY, this.openGroup || ''); } catch { /* storage unavailable */ }
    },
    groupBadge(g) { return g.items.reduce((s, i) => s + (i.badge ? (state.pending[i.badge] || 0) : 0), 0); },
    async logout() { await sb.auth.signOut(); },
    async boot(session) {
      state.session = session;
      state.profile = null;
      if (!session) { this.ready = true; return; }
      await run(async () => {
        state.profile = must(await sb.from('profiles').select('*').eq('id', session.user.id).single());
        if (state.profile.is_active) {
          await loadCompany();
          await loadRefs(['items', 'locations', 'projects', 'vendors', 'cost_centers', 'uoms', 'profiles']);
          refreshPending();
        }
      });
      this.ready = true;
    },
    dlgOk() {
      for (const f of dialog.fields) if (f.required && (dialog.values[f.k] === null || dialog.values[f.k] === '' || dialog.values[f.k] === undefined)) return toast(`${f.label} is required`, 'error');
      dialog.open = false; dialog.resolve({ ...dialog.values });
    },
    dlgCancel() { dialog.open = false; dialog.resolve(null); },
  },
  async mounted() {
    if (!this.openGroup) { try { this.openGroup = localStorage.getItem(OPEN_KEY) || null; } catch { /* storage unavailable */ } }
    const { data } = await sb.auth.getSession();
    await this.boot(data.session);
    sb.auth.onAuthStateChange(async (event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        const v = await new Promise(res => { Object.assign(dialog, { open: true, title: 'Set a new password', message: '', fields: [{ k: 'pw', label: 'New password (min 8 characters)', required: true }], values: { pw: '' }, resolve: res, okText: 'Save', danger: false }); });
        if (v) await run(async () => { const { error } = await sb.auth.updateUser({ password: v.pw }); if (error) throw error; }, 'Password changed');
      }
      if (event === 'SIGNED_IN' && state.session?.user?.id === session?.user?.id) return;
      if (['SIGNED_IN', 'SIGNED_OUT'].includes(event)) await this.boot(session);
    });
    setInterval(() => { if (state.profile?.is_active) refreshPending(); }, 60000);
  },
  template: `
  <div v-if="!ready" class="boot">Loading…</div>
  <Login v-else-if="!state.session" />
  <div v-else-if="!state.profile?.is_active" class="login"><div class="box">
    <div style="text-align:center;margin-bottom:10px"><Logo :size="96" /></div>
    <h1>Account pending activation</h1>
    <p>Signed in as {{ state.session.user.email }}. An administrator must activate your account and assign your role (Purchase, Stores, Shop Floor, Production In-charge, Factory Manager or Finance).</p>
    <button class="btn" @click="logout">Sign out</button>
  </div></div>
  <div v-else class="shell">
    <nav class="side" :class="{open: sideOpen}">
      <div class="logo"><Logo :size="58" /><div>Citi Homes IMS<small>{{ company?.company_name }}</small></div></div>
      <a class="home" href="#/dashboard" :class="{on: active('dashboard')}" @click="sideOpen=false"><Icon name="layout-dashboard" />Dashboard</a>
      <div v-for="g in menu" :key="g.g" class="mgrp" :class="{open: openGroup === g.g}">
        <button class="mhead" @click="toggle(g.g)" :aria-expanded="openGroup === g.g">
          <Icon :name="g.icon" /><span>{{ g.g }}</span>
          <span class="badge" v-if="groupBadge(g) && openGroup !== g.g">{{ groupBadge(g) }}</span>
          <Icon name="chevron-down" :size="16" class="chev" :style="groupBadge(g) && openGroup !== g.g ? '' : 'margin-left:auto'" />
        </button>
        <div class="msub" v-show="openGroup === g.g">
          <template v-for="i in g.items">
            <div v-if="i.sep" class="sep">{{ i.sep }}</div>
            <a v-else :href="'#/' + i.to" :class="{on: active(i.to)}" @click="sideOpen=false">{{ i.t }}
              <span class="badge" v-if="i.badge && state.pending[i.badge]">{{ state.pending[i.badge] }}</span></a>
          </template>
        </div>
      </div>
      <div class="foot">Citi Homes IMS · {{ ROLES[state.profile.role] }}</div>
    </nav>
    <div class="main">
      <div class="top">
        <button class="btn sm menu-btn" @click="sideOpen=!sideOpen" aria-label="Menu"><Icon name="menu-2" :size="17" /></button>
        <div class="title">{{ view.title }}</div>
        <div class="bell">
          <button class="btn sm" @click="bellOpen=!bellOpen" title="Notifications" aria-label="Notifications"><Icon name="bell" :size="17" /><span class="badge" v-if="unread">{{ unread }}</span></button>
          <div class="bell-dd" v-if="bellOpen">
            <div class="row" style="padding:8px 12px;border-bottom:1px solid var(--line)"><b>Notifications</b><span class="spacer"></span>
              <a href="javascript:void 0" class="small" @click="readAll">Mark all read</a></div>
            <div v-if="!state.notifs.length" class="empty">Nothing yet</div>
            <div v-for="n in state.notifs" :key="n.id" class="notif" :class="{unread: !n.read}" @click="openNotif(n)">
              <div class="nt">{{ n.title }}</div><div class="nb" v-if="n.body">{{ n.body }}</div><div class="nd">{{ dtm(n.created_at) }}</div>
            </div>
          </div>
        </div>
        <div class="who" style="margin-left:0"><span>{{ state.profile.full_name || state.profile.email }} · <b>{{ ROLES[state.profile.role] }}</b></span><button class="btn sm" @click="logout">Sign out</button></div>
      </div>
      <div class="content"><component :is="view.comp" v-bind="view.props" :key="viewKey" /></div>
    </div>
  </div>
  <Modal v-if="dialog.open" :title="dialog.title" small @close="dlgCancel">
    <p v-if="dialog.message" style="margin-top:0">{{ dialog.message }}</p>
    <div class="grid" style="grid-template-columns:1fr" v-if="dialog.fields.length"><FieldInput v-for="f in dialog.fields" :key="f.k" :f="f" :doc="dialog.values" /></div>
    <template #footer><button class="btn" @click="dlgCancel">Cancel</button><button class="btn" :class="dialog.danger ? 'bad' : 'primary'" @click="dlgOk">{{ dialog.okText }}</button></template>
  </Modal>
  <div class="toasts"><div v-for="t in state.toasts" :key="t.id" class="toast" :class="t.type">{{ t.msg }}</div></div>`,
};

document.title = CONFIG.appName;
const vm = createApp(App);
vm.config.errorHandler = (err, inst, info) => { console.error('[vue]', info, err); toast(errMsg(err), 'error'); };
vm.mount('#app');
if (location.hostname === 'localhost') window.__ims = { state, go };   // local debugging only
