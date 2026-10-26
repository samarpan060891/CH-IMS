// Role dashboards: every user lands on the dashboard of their role; the administrator can open all of them
// (Dashboards menu). A dashboard is a list of sections; data is loaded only for the sections shown.
import { sb, state, must, run, hasRole, canSeeCost, go, loadRefs, refRow, money, qty, aed, dt, label, num, today } from './lib.js';
import { DataTable, Badge, ask, confirmBox } from './components.js';
import { METRICS, PERIODS, userMetrics, computeKpi } from './kpis.js';

const fmtVal = (v, f) => f === 'money' ? aed(v) : f === 'hours' ? qty(v) + ' h' : Math.round(num(v)).toLocaleString('en-GB');

const PALETTE = ['#1b3a6b', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#dc2626', '#475569', '#a16207'];
const ZONE_COLORS = { BLACK: '#111827', RED: '#dc2626', YELLOW: '#eab308', GREEN: '#16a34a', BLUE: '#2563eb' };
const AGE_ORDER = ['0-30', '31-60', '61-90', '91-180', '181-365', '365+'];
const WO_OPEN = ['RELEASED', 'IN_PROGRESS'];
const PO_OPEN = ['RELEASED', 'PARTIALLY_RECEIVED'];

function chart(el, cfg) {
  if (!el || !window.Chart) return null;
  return new window.Chart(el, { ...cfg, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } }, ...(cfg.options || {}) } });
}

// role → dashboard; the first role listed is the one whose approvals the administrator sees on that dashboard
export const DASHBOARDS = {
  management: { title: 'Management', roles: ['factory_manager'], sections: ['pending', 'projects', 'mgmtKpis', 'prodKpis', 'pmJobs', 'budgets', 'stockCharts'] },
  finance:    { title: 'Finance', roles: ['finance'], sections: ['pending', 'finKpis', 'billing', 'payables', 'budgets'] },
  purchase:   { title: 'Purchase', roles: ['purchase'], sections: ['pending', 'purKpis', 'poLate', 'zoneChart', 'payables'] },
  stores:     { title: 'Stores', roles: ['stores'], sections: ['pending', 'stockKpis', 'expiring', 'stockCharts', 'valuation'] },
  production: { title: 'Production', roles: ['production_incharge', 'shop_floor'], sections: ['pending', 'prodKpis', 'woLate', 'pmJobs', 'wcLoad', 'projects'] },
  sales:      { title: 'Sales', roles: ['sales'], sections: ['pending', 'salesKpis', 'soOpen'] },
  hr:         { title: 'HR', roles: ['hr_officer'], sections: ['pending', 'hrKpis', 'docExpiry', 'onLeave'] },
  site:       { title: 'Site', roles: ['site_supervisor'], route: 'site' },
  floor:      { title: 'Floor app', roles: [], route: 'floorapp' },   // phone screen for the shop floor; given to users by the administrator
  approvals:  { title: 'Approvals inbox', roles: [], route: 'approvals' },   // phone inbox of decisions waiting; can be a user's landing screen
  counting:   { title: 'Count app', roles: [], route: 'countapp' },   // phone screen for physical stock counts
  receiving:  { title: 'Receive app', roles: [], route: 'receiveapp' },   // phone screen for goods receipts at the gate / dock
};
export const dashboardFor = role => Object.keys(DASHBOARDS).find(k => DASHBOARDS[k].roles.includes(role)) || 'management';
// dashboards a user may open: as set by the administrator, else all (administrator) or the role's own
export function userDashboards(p = state.profile) {
  const set = (p?.dashboards || []).filter(k => DASHBOARDS[k]);
  if (set.length) return set;
  return p?.role === 'admin' ? Object.keys(DASHBOARDS) : [dashboardFor(p?.role)];
}
// the dashboard opened at sign-in: the user's own choice if still granted
export function homeDashboard(p = state.profile) {
  const ks = userDashboards(p), h = p?.dashboard_prefs?.home;
  return ks.includes(h) ? h : ks[0];
}

// every section a dashboard can show (users add / remove / reorder these on their own dashboards)
export const SECTIONS = {
  pending: 'Waiting for your action', projects: 'Running projects', budgets: 'Projects near / over material budget',
  mgmtKpis: 'Business overview figures', finKpis: 'Finance figures (bank, receivables, profit, VAT)', billing: 'Project billing', payables: 'Payables by vendor',
  purKpis: 'Purchasing figures', poLate: 'Open purchase orders', zoneChart: 'Buffer zones chart',
  stockKpis: 'Stock figures', expiring: 'Lots expiring within 60 days', stockCharts: 'Stock charts (value, aging, zones, status)', valuation: 'Valuation by category',
  prodKpis: 'Production figures', woLate: 'Open production orders', wcLoad: 'Work centre load', pmJobs: 'Preventive maintenance (PM jobs due & done)',
  salesKpis: 'Sales figures (quotations, orders, margin)', soOpen: 'Open sales orders',
  hrKpis: 'HR figures (headcount, attendance, leave, documents)', docExpiry: 'Employee documents expiring', onLeave: 'Current & upcoming leave',
};
// section sizes: width in columns of a 12-column grid (full width on phones); height cap with scrolling
const WIDTHS = [{ v: 12, l: 'Full width' }, { v: 9, l: '¾ width' }, { v: 8, l: '⅔ width' }, { v: 6, l: '½ width' }, { v: 4, l: '⅓ width' }, { v: 3, l: '¼ width' }];
const HEIGHTS = [{ v: '', l: 'Auto height' }, { v: 'S', l: 'Short', px: 260 }, { v: 'M', l: 'Medium', px: 420 }, { v: 'L', l: 'Tall', px: 640 }];
// sections a user may put on a dashboard: those of all dashboards granted to them (so the data is theirs to see)
export function userSections(p = state.profile) {
  const out = new Set(['pending']);
  userDashboards(p).forEach(k => (DASHBOARDS[k].sections || []).forEach(s => out.add(s)));
  return Object.keys(SECTIONS).filter(s => out.has(s));
}

export const Dashboard = {
  components: { DataTable, Badge },
  props: { kind: String },
  data: () => ({ loading: true, d: {}, kv: {}, myPending: [], charts: [], ed: null, drag: null, over: null }),
  computed: {
    isAdmin: () => state.profile?.role === 'admin',
    // only dashboards granted to the user open, whatever the address says
    allowed() { return userDashboards().filter(k => !DASHBOARDS[k].route); },
    k() {
      if (this.allowed.includes(this.kind)) return this.kind;
      const h = homeDashboard();
      return this.allowed.includes(h) ? h : (this.allowed[0] || dashboardFor(state.profile?.role));
    },
    cfg() { return DASHBOARDS[this.k]; },
    // the layout being edited, else the user's own layout for this dashboard, else the standard one
    sections() {
      const mine = this.ed ? this.ed.list : state.profile?.dashboard_prefs?.layouts?.[this.k], ok = userSections();
      return (Array.isArray(mine) ? mine : this.cfg.sections).filter(s => ok.includes(s) || (s.startsWith('kpi:') && this.card(s)));
    },
    customised() { return Array.isArray(state.profile?.dashboard_prefs?.layouts?.[this.k]); },
    // the user's own KPI cards (shared by all their dashboards)
    cards() { return (this.ed ? this.ed.kpis : state.profile?.dashboard_prefs?.kpis) || []; },
    myCards() { return this.sections.filter(s => s.startsWith('kpi:')).map(s => this.card(s)).filter(Boolean); },
    addable() {
      if (!this.ed) return [];
      return [...userSections(), ...this.cards.map(c => 'kpi:' + c.id)].filter(s => !this.ed.list.includes(s));
    },
    homeOpts() { return userDashboards().map(k => ({ v: k, l: DASHBOARDS[k].title })); },
    // approvals: the user's own; the administrator sees those of the dashboard's role
    viewRole() { const r = state.profile?.role; return this.cfg.roles.includes(r) || !this.isAdmin ? r : this.cfg.roles[0]; },
    cost() { return canSeeCost(); },
    stock() { return this.d.stock || []; },
    stockValue() { return (this.d.val || []).filter(v => v.kind === 'STOCK').reduce((s, v) => s + num(v.value), 0); },
    // material issued to production orders, on the shop floor until FG receipts consume it
    wipValue() { return (this.d.wip || []).reduce((s, w) => s + num(w.value), 0); },
    wipOrders() { return new Set((this.d.wip || []).map(w => w.project_id)).size; },
    assetValue() { return (this.d.val || []).filter(v => v.kind === 'ASSET').reduce((s, v) => s + num(v.value), 0); },
    stockOuts() { return this.stock.filter(s => s.stock_status === 'STOCK_OUT').length; },
    redZone() { return this.stock.filter(s => ['RED', 'BLACK'].includes(s.buffer_zone)).length; },
    toOrder() { return this.stock.filter(s => num(s.suggested_order_qty) > 0).length; },
    overstockVal() { return this.stock.filter(s => ['OVERSTOCK', 'NON_MOVING'].includes(s.stock_status)).reduce((a, s) => a + num(s.stock_value), 0); },
    over90() { return (this.d.aging || []).filter(a => !['0-30', '31-60', '61-90'].includes(a.age_bucket)).reduce((s, a) => s + num(a.value), 0); },
    netPayable() { return (this.d.pay || []).reduce((s, p) => s + num(p.net_payable_aed), 0); },
    overduePay() { return (this.d.pay || []).reduce((s, p) => s + num(p.overdue_1_30_aed) + num(p.overdue_31_60_aed) + num(p.overdue_61_90_aed) + num(p.overdue_90_plus_aed), 0); },
    toolsOverdue() { return (this.d.assets || []).filter(a => a.is_overdue).length; },
    calibDue() { return (this.d.assets || []).filter(a => ['OVERDUE', 'DUE_SOON'].includes(a.calibration_status)).length; },
    fin() { return { cash: 0, bank: 0, pdc: 0, vat: 0, revM: 0, revY: 0, profitY: 0, ...(this.d.fin || {}) }; },
    ar() { const a = this.d.ar || []; return { bal: a.reduce((s, r) => s + num(r.balance), 0), over: a.reduce((s, r) => s + num(r.d1_30) + num(r.d31_60) + num(r.d61_90) + num(r.d90_plus), 0) }; },
    unbilled() { return (this.d.billing || []).reduce((s, r) => s + Math.max(num(r.earned_value) - num(r.certified_to_date), 0), 0); },
    retention() { return (this.d.billing || []).reduce((s, r) => s + num(r.retention_held), 0); },
    wos() { return this.d.wos || []; },
    woLate() { return this.wos.filter(w => w.due_date && w.due_date < today()); },
    // preventive maintenance: an open job past its due date counts as overdue
    pmRows() {
      const t = today(), rank = { OVERDUE: 0, IN_PROGRESS: 1, OPEN: 2, DUE_SOON: 3 };
      return (this.d.pm || []).map(r => ({ ...r, state: r.job_id ? (r.job_due < t ? 'OVERDUE' : r.job_status) : r.due_state, due: r.job_due || r.next_due }))
        .filter(r => r.state !== 'OK').sort((a, b) => rank[a.state] - rank[b.state] || String(a.due || '9').localeCompare(String(b.due || '9')));
    },
    pmOnTime() { const d = this.d.pmDone || []; return d.length ? Math.round(d.filter(j => j.completed_at.slice(0, 10) <= j.due_date).length / d.length * 100) : null; },
  },
  watch: { kind() { this.load(); } },
  async mounted() { await this.load(); },
  beforeUnmount() { this.charts.forEach(c => c && c.destroy()); },
  methods: {
    money, aed, qty, label, dt,
    has(s) { return this.sections.includes(s); },
    any(...s) { return s.some(x => this.has(x)); },
    // blocks follow the user's order, width (of 12 columns) and height
    o(...s) {
      const i = Math.min(...s.map(x => this.sections.indexOf(x)).filter(i => i >= 0));
      const z = this.size(s.find(x => this.has(x)) || s[0]), h = HEIGHTS.find(x => x.v === z.h)?.px;
      return { order: Number.isFinite(i) ? i : 99, gridColumn: `span ${z.w}`, ...(h ? { maxHeight: h + 'px', overflow: 'auto' } : {}) };
    },
    // KPI cards default to a quarter of the row so four sit side by side
    size(s) { const z = (this.ed?.sizes || state.profile?.dashboard_prefs?.sizes?.[this.k] || {})[s] || {}; return { w: z.w || (s?.startsWith('kpi:') ? 3 : 12), h: z.h || '' }; },
    setSize(s, key, v) { const cur = this.ed.sizes[s] || {}; this.ed.sizes[s] = { ...cur, [key]: v }; },
    customise() {
      const p = state.profile?.dashboard_prefs || {};
      this.ed = { list: [...this.sections], home: homeDashboard(), add: '', sizes: JSON.parse(JSON.stringify(p.sizes?.[this.k] || {})), kpis: JSON.parse(JSON.stringify(p.kpis || [])) };
    },
    card(s) { const id = s.slice(4); return this.cards.find(c => c.id === id); },
    secLabel(s) { const c = s.startsWith('kpi:') && this.card(s); return c ? `★ ${c.title} (my KPI card)` : SECTIONS[s]; },
    // create / edit a KPI card: measure from the catalogue, period, project, goal
    async editCard(s) {
      const c = s ? this.card(s) : null;
      await loadRefs(['projects']);
      const metrics = userMetrics(userDashboards());
      const v = await ask({ title: c ? 'Edit KPI card' : 'New KPI card', okText: c ? 'Update' : 'Add card',
        message: 'Pick what to measure. Period and project apply only to measures that support them; a goal colours the card green (met) or red (missed).',
        fields: [
          { k: 'metric', label: 'Measure', type: 'select', required: true, options: metrics, default: c?.metric || metrics[0]?.v },
          { k: 'title', label: 'Card title (blank = measure name)', default: c?.title || '' },
          { k: 'period', label: 'Period', type: 'select', options: PERIODS, default: c?.period || 'month' },
          { k: 'project_id', label: 'Project (optional)', type: 'select', options: (state.refs.projects || []).filter(p => p.status === 'OPEN').map(p => ({ v: p.id, l: `${p.code} — ${p.name}` })), default: c?.project_id || '' },
          { k: 'goal', label: 'Goal (optional)', type: 'number', default: c?.goal ?? null },
          { k: 'dir', label: 'Goal is met when the value is', type: 'select', options: [{ v: 'min', l: 'at least the goal' }, { v: 'max', l: 'at most the goal' }], default: c?.dir || '' },
        ] });
      if (!v) return;
      const m = METRICS[v.metric];
      const card = { id: c?.id || Math.random().toString(36).slice(2, 10), metric: v.metric, title: (v.title || '').trim() || m.l,
        period: m.period ? (v.period || 'month') : null, project_id: m.project ? (v.project_id || null) : null,
        goal: v.goal === null || v.goal === '' ? null : num(v.goal), dir: v.dir || (m.lowerBetter ? 'max' : 'min') };
      if (c) Object.assign(c, card); else { this.ed.kpis.push(card); this.ed.list.unshift('kpi:' + card.id); }
      await this.loadCard(card);
    },
    async removeCard(s) {
      if (!(await confirmBox('Delete KPI card', 'Delete this KPI card from all your dashboards (when you save)?', true))) return;
      this.ed.kpis = this.ed.kpis.filter(c => 'kpi:' + c.id !== s); this.ed.list = this.ed.list.filter(x => x !== s);
    },
    async loadCard(c) {
      // await first, then merge: cards load in parallel and must not overwrite each other
      let v;
      try { v = await computeKpi(c); } catch (e) { v = { err: e.message || String(e) }; }
      this.kv = { ...this.kv, [c.id]: v };
    },
    kpiText(c) { const r = this.kv[c.id], m = METRICS[c.metric]; if (!r || r.err) return '—'; return fmtVal(r.v, m?.fmt); },
    kpiSub(c) {
      const r = this.kv[c.id], m = METRICS[c.metric]; if (!m) return 'measure no longer available'; if (r?.err) return 'not available: ' + r.err;
      const parts = [];
      if (m.period) parts.push(PERIODS.find(p => p.v === c.period)?.l || '');
      if (c.project_id) parts.push(refRow('projects', c.project_id)?.code || 'project');
      if (r && r.prev !== null && r.prev !== undefined && c.period !== 'all') {
        const d = r.v - r.prev; parts.push(r.prev ? `${d >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(d / Math.abs(r.prev) * 100))}% vs previous` : `previous ${fmtVal(r.prev, m.fmt)}`);
      }
      if (c.goal !== null && c.goal !== undefined) parts.push(`goal ${c.dir === 'max' ? '≤' : '≥'} ${fmtVal(c.goal, m.fmt)}`);
      return parts.filter(Boolean).join(' · ');
    },
    kpiClass(c) {
      const r = this.kv[c.id]; if (!r || r.err || c.goal === null || c.goal === undefined) return '';
      return (c.dir === 'max' ? r.v <= c.goal : r.v >= c.goal) ? 'ok' : 'bad';
    },
    // drag & drop (while customising): drag a section on the dashboard or a row in the panel onto another to take its place
    secOf(el) { const b = el?.closest?.('[data-sec]'); return b ? b.dataset.sec.split(',').find(s => this.ed?.list.includes(s)) : null; },
    dragStart(e, key) {
      const s = key || this.secOf(e.target); if (!this.ed || !s) return;
      this.drag = s; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s);
    },
    dragOver(e, key) {
      const s = key || this.secOf(e.target); if (!this.drag || !s) return;
      e.preventDefault(); this.over = s;
      if (!key) this.mark(e.target.closest('[data-sec]'));
    },
    // highlight the dashboard block a section would be dropped on
    mark(el) { this.$el.querySelectorAll('.dash-body .drop-at').forEach(x => x !== el && x.classList.remove('drop-at')); if (el && this.secOf(el) !== this.drag) el.classList.add('drop-at'); },
    drop(e, key) {
      const s = key || this.secOf(e.target), l = this.ed?.list;
      if (l && this.drag && s && s !== this.drag) { e.preventDefault(); const from = l.indexOf(this.drag), to = l.indexOf(s); l.splice(to, 0, ...l.splice(from, 1)); }
      this.dragEnd();
    },
    dragEnd() { this.drag = this.over = null; this.mark(null); },
    move(i, dir) { const l = this.ed.list, j = i + dir; if (j < 0 || j >= l.length) return; [l[i], l[j]] = [l[j], l[i]]; },
    async addSection() {
      if (!this.ed.add) return;
      const s = this.ed.add; this.ed.list.push(s); this.ed.add = '';
      if (s.startsWith('kpi:')) await this.loadCard(this.card(s)); else await this.load();
    },
    async savePrefs(reset) {
      const cur = state.profile.dashboard_prefs || {};
      const layouts = { ...(cur.layouts || {}) }, sizes = { ...(cur.sizes || {}) };
      if (reset) { delete layouts[this.k]; delete sizes[this.k]; }
      else {
        layouts[this.k] = this.ed.list;
        // keep only non-default sizes of sections still on the dashboard
        const z = Object.fromEntries(Object.entries(this.ed.sizes).filter(([s, v]) => this.ed.list.includes(s) && ((v.w && v.w !== 12) || v.h)));
        if (Object.keys(z).length) sizes[this.k] = z; else delete sizes[this.k];
      }
      // keep the KPI cards still used on any dashboard
      const used = new Set(Object.values(layouts).flat());
      const kpis = this.ed.kpis.filter(c => used.has('kpi:' + c.id));
      const prefs = { home: this.ed.home, layouts, sizes, kpis };
      const ok = await run(async () => must(await sb.rpc('save_my_dashboard_prefs', { p_prefs: prefs })), reset ? 'Dashboard reset to standard' : 'Dashboard saved');
      if (ok) { state.profile.dashboard_prefs = prefs; this.ed = null; await this.load(); }
    },
    is(...roles) { return roles.includes(this.viewRole); },
    async load() {
      this.loading = true; this.d = {};
      await run(async () => {
        const d = {}, jobs = [];
        const get = (key, q) => jobs.push(q.then(r => { d[key] = must(r); }));
        if (this.any('mgmtKpis', 'stockKpis', 'purKpis', 'stockCharts', 'zoneChart'))
          get('stock', sb.from('v_item_stock').select('item_id,code,name,class_code,stock_status,buffer_zone,stock_value,on_hand,available,suggested_order_qty,uom').eq('is_active', true));
        if (this.cost && this.any('mgmtKpis', 'stockKpis', 'stockCharts', 'valuation')) { get('val', sb.from('v_valuation_by_category').select('*')); get('aging', sb.from('v_aging_summary').select('*')); }
        if (this.cost && this.any('stockKpis', 'mgmtKpis', 'prodKpis', 'production')) get('wip', sb.from('v_wip_stock').select('project_id,value'));
        if (this.any('stockKpis', 'mgmtKpis')) get('assets', sb.from('v_asset_register').select('id,is_overdue,calibration_status'));
        if (this.has('projects')) get('projects', sb.from('v_project_overview').select('*').order('end_date', { nullsFirst: false }));
        if (this.cost && this.any('payables', 'mgmtKpis', 'finKpis')) get('pay', sb.from('v_vendor_payables').select('*'));
        if (this.any('finKpis', 'mgmtKpis') && hasRole('finance', 'factory_manager')) get('ar', sb.from('v_ar_aging').select('*'));
        if (this.any('billing', 'finKpis') && hasRole('finance', 'factory_manager')) get('billing', sb.from('v_project_billing').select('*').order('project_code'));
        if (this.any('production', 'prodKpis', 'woLate'))
          get('wos', sb.from('production_orders').select('id,wo_no,description,qty,qty_completed,due_date,priority,status,projects(code)').in('status', WO_OPEN).order('due_date', { nullsFirst: false }));
        if (this.any('prodKpis', 'production')) {
          get('qc', sb.from('wo_receipts').select('id', { count: 'exact', head: true }).eq('qc_status', 'PENDING_FM').then(r => ({ data: r.count || 0, error: r.error })));
          get('stagesRunning', sb.from('wo_operations').select('id', { count: 'exact', head: true }).eq('status', 'IN_PROGRESS').then(r => ({ data: r.count || 0, error: r.error })));
        }
        if (this.has('pmJobs')) {
          get('pm', sb.from('v_pm_due').select('*').eq('status', 'ACTIVE'));
          get('pmDone', sb.from('pm_jobs').select('id,due_date,completed_at').eq('status', 'DONE').gte('completed_at', today().slice(0, 8) + '01'));
        }
        if (this.any('wcLoad', 'prodKpis')) get('wc', sb.from('v_work_center_load').select('*').neq('kind', 'UTILITY').order('sort_order'));
        if (this.any('purKpis', 'poLate'))
          get('pos', sb.from('purchase_orders').select('id,po_no,po_date,delivery_date,status,total_aed,vendors(name),projects(code)').not('status', 'in', '(CLOSED,CANCELLED,RECEIVED,REJECTED)').order('delivery_date', { nullsFirst: false }));
        if (this.has('expiring')) get('expiring', sb.from('v_lot_values').select('item_code,item_name,location_code,lot_no,batch_no,expiry_date,qty_on_hand,uom').not('expiry_date', 'is', null)
          .lte('expiry_date', new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10)).gt('qty_on_hand', 0).order('expiry_date'));
        if (this.any('salesKpis', 'soOpen')) get('sos', sb.from('v_sales_orders').select('id,so_no,so_type,title,customer_name,cost_center_code,delivery_date,status,subtotal,delivered_pct,invoiced_value,margin_pct,created_at')
          .not('status', 'in', '(CLOSED,CANCELLED)').order('delivery_date', { nullsFirst: false }));
        if (this.has('salesKpis') && hasRole('sales', 'finance', 'factory_manager')) get('qts', sb.from('quotations').select('id,status,subtotal,qt_date').gte('qt_date', today().slice(0, 4) + '-01-01'));
        if (this.any('hrKpis', 'docExpiry')) get('docs', sb.from('v_document_expiry').select('*').lte('days_left', 60).order('days_left'));
        if (this.has('hrKpis')) {
          get('emps', sb.from('employees').select('id,emp_status,is_active').eq('is_active', true));
          get('att', sb.from('attendance').select('status').eq('att_date', today()));
          get('payrollRun', sb.from('payroll_runs').select('run_no,period_month,status,total_net').neq('status', 'CANCELLED').order('period_month', { ascending: false }).limit(1));
          get('advances', sb.from('employee_advances').select('amount,recovered').eq('status', 'APPROVED'));
        }
        if (this.any('hrKpis', 'onLeave')) get('leaves', sb.from('leave_requests').select('id,leave_no,leave_type,from_date,to_date,days,status,employees(name,emp_code)')
          .in('status', ['APPROVED', 'PENDING']).gte('to_date', today()).order('from_date'));
        if (this.has('finKpis') && hasRole('finance', 'factory_manager')) jobs.push(this.loadFin(d));
        if (this.cost && this.has('budgets')) {
          const warn = num(state.company?.budget_warn_pct || 80);
          jobs.push(sb.from('v_project_consumption').select('*').eq('status', 'OPEN').gt('budget_material', 0).then(r => {
            d.budgets = must(r).map(p => ({ ...p, pct: Math.round(num(p.net_consumption) / num(p.budget_material) * 1000) / 10 })).filter(p => p.pct >= warn).sort((a, b) => b.pct - a.pct); }));
        }
        if (this.has('pending')) jobs.push(this.loadPending());
        if (this.myCards.some(c => METRICS[c.metric]?.project)) jobs.push(loadRefs(['projects']));
        this.myCards.forEach(c => jobs.push(this.loadCard(c)));
        await Promise.all(jobs);
        this.d = d;
      });
      this.loading = false;
      this.$nextTick(() => this.draw());
    },
    // cash, bank, VAT and profit from the ledger (this year)
    async loadFin(d) {
      await loadRefs(['gl_accounts']);
      const ys = today().slice(0, 4) + '-01-01', ms = today().slice(0, 8) + '01';
      const [y, m] = await Promise.all([sb.rpc('gl_trial_balance', { p_from: ys, p_to: today() }), sb.rpc('gl_trial_balance', { p_from: ms, p_to: today() })]);
      const key = r => (state.refs.gl_accounts || []).find(a => a.id === r.account_id)?.system_key;
      const isBank = r => (state.refs.gl_accounts || []).find(a => a.id === r.account_id)?.is_bank;
      const ty = must(y), tm = must(m);
      const sum = (rows, f, v) => rows.filter(f).reduce((s, r) => s + v(r), 0);
      const inc = rows => sum(rows, r => r.acc_type === 'INCOME', r => num(r.credit) - num(r.debit));
      const exp = rows => sum(rows, r => r.acc_type === 'EXPENSE', r => num(r.debit) - num(r.credit));
      d.fin = {
        cash: sum(ty, r => key(r) === 'CASH', r => num(r.closing)), bank: sum(ty, r => isBank(r), r => num(r.closing)),
        pdc: sum(ty, r => key(r) === 'PDC_RECEIVED', r => num(r.closing)),
        vat: -sum(ty, r => ['VAT_OUT', 'VAT_IN'].includes(key(r)), r => num(r.closing)),
        revM: inc(tm), revY: inc(ty), profitY: inc(ty) - exp(ty),
      };
    },
    async loadPending() {
      const out = [];
      const add = (rows, type, key, no) => rows.forEach(r => out.push({ type, no: r[no], date: r.created_at, status: r.status, link: `d/${key}/${r.id}` }));
      const q = (t, cols) => sb.from(t).select(cols);
      if (this.is('factory_manager')) {
        add(must(await q('purchase_orders', 'id,po_no,status,created_at').eq('status', 'PENDING_FM')), 'Purchase order', 'po', 'po_no');
        add(must(await q('stock_adjustments', 'id,adj_no,status,created_at').eq('status', 'PENDING_APPROVAL')), 'Stock adjustment', 'adj', 'adj_no');
        add(must(await q('scrap_notes', 'id,scrap_no,status,created_at').eq('status', 'PENDING_APPROVAL')), 'Scrap note', 'scrap', 'scrap_no');
        add(must(await q('scrap_disposals', 'id,disposal_no,status,created_at').eq('status', 'PENDING_APPROVAL')), 'Scrap disposal', 'disposal', 'disposal_no');
        add(must(await q('stock_releases', 'id,release_no,status,created_at').eq('status', 'PENDING_APPROVAL')), 'Project stock release', 'rel', 'release_no');
        add(must(await q('variation_orders', 'id,vo_no,status,created_at').eq('status', 'SUBMITTED')), 'Variation order', 'vo', 'vo_no');
        add(must(await q('leave_requests', 'id,leave_no,status,created_at').eq('status', 'PENDING')), 'Leave request', 'leave', 'leave_no');
        add(must(await q('material_returns', 'id,return_no,status,created_at').eq('status', 'PENDING_FM')), 'Offcuts: approve keep / scrap', 'ret', 'return_no');
        add(must(await q('expenses', 'id,exp_no,status,created_at').eq('status', 'PENDING_FM')), 'Expense above the limit', 'exp', 'exp_no');
      }
      if (this.is('finance')) {
        add(must(await q('purchase_orders', 'id,po_no,status,created_at').eq('status', 'PENDING_FINANCE')), 'Purchase order', 'po', 'po_no');
        add(must(await q('scrap_disposals', 'id,disposal_no,status,created_at').eq('status', 'PENDING_FINANCE')), 'Scrap disposal (confirm rate)', 'disposal', 'disposal_no');
        add(must(await q('stock_releases', 'id,release_no,status,created_at').eq('status', 'PENDING_FINANCE')), 'Project stock release (final approval)', 'rel', 'release_no');
        add(must(await q('payroll_runs', 'id,run_no,status,created_at').eq('status', 'SUBMITTED')), 'Payroll to approve', 'payroll', 'run_no');
        add(must(await q('employee_advances', 'id,adv_no,status,created_at').eq('status', 'DRAFT')), 'Salary advance to approve', 'adv', 'adv_no');
        add(must(await q('sales_invoices', 'id,inv_no,status,created_at').eq('status', 'SUBMITTED')), 'Progress claim awaiting payment certificate', 'si', 'inv_no');
        add(must(await q('sales_invoices', 'id,inv_no,status,created_at').eq('status', 'CERTIFIED')), 'Certified progress claim to invoice', 'si', 'inv_no');
        add(must(await q('expenses', 'id,exp_no,status,created_at').eq('status', 'APPROVED')), 'Expense to post', 'exp', 'exp_no');
        add(must(await q('expenses', 'id,exp_no,status,created_at').eq('status', 'POSTED').eq('exp_type', 'CLAIM')), 'Claim to reimburse', 'exp', 'exp_no');
        add(must(await q('customer_receipts', 'id,receipt_no,status,created_at').eq('status', 'POSTED').in('mode', ['CHEQUE', 'PDC']).lte('cheque_date', today())), 'Cheque due — deposit / clear', 'rcv', 'receipt_no');
      }
      if (this.is('purchase')) add(must(await q('purchase_orders', 'id,po_no,status,created_at').in('status', ['PENDING_TOP_MGMT', 'APPROVED'])), 'Purchase order (top mgmt / release)', 'po', 'po_no');
      if (this.is('production_incharge')) {
        add(must(await q('material_requests', 'id,mr_no,status,created_at').eq('status', 'PENDING_APPROVAL')), 'Material request', 'mr', 'mr_no');
        add(must(await q('production_orders', 'id,wo_no,status,created_at').eq('status', 'DRAFT')), 'Production order to release', 'wo', 'wo_no');
        add(must(await q('snags', 'id,snag_no,status,created_at').eq('status', 'FIXED')), 'Snag fixed — verify', 'snag', 'snag_no');
        add(must(await q('material_returns', 'id,return_no,status,created_at').eq('status', 'PENDING_PI')), 'Offcuts: propose keep / scrap', 'ret', 'return_no');
      }
      if (this.is('stores')) {
        add(must(await q('material_requests', 'id,mr_no,status,created_at').in('status', ['APPROVED', 'PARTIALLY_ISSUED'])), 'Material request to issue', 'mr', 'mr_no');
        add(must(await q('material_returns', 'id,return_no,status,created_at').eq('status', 'SUBMITTED')), 'Return to receive', 'ret', 'return_no');
        add(must(await q('dispatch_notes', 'id,dispatch_no,status,created_at').eq('status', 'DRAFT')), 'Delivery to dispatch', 'dsp', 'dispatch_no');
      }
      if (this.is('shop_floor', 'production_incharge'))
        add(must(await q('material_issues', 'id,issue_no,ack_status,created_at').eq('status', 'POSTED').eq('ack_status', 'PENDING')).map(r => ({ ...r, status: 'PENDING' })), 'Material issued — acknowledge receipt', 'ack', 'issue_no');
      if (this.is('stores', 'factory_manager'))
        add(must(await q('material_issues', 'id,issue_no,ack_status,created_at').eq('ack_status', 'DISCREPANCY')).map(r => ({ ...r, status: 'DISCREPANCY' })), 'Receipt discrepancy to resolve', 'issue', 'issue_no');
      if (this.is('hr_officer')) {
        add(must(await q('leave_requests', 'id,leave_no,status,created_at').eq('status', 'PENDING')), 'Leave request', 'leave', 'leave_no');
        add(must(await q('payroll_runs', 'id,run_no,status,created_at').eq('status', 'APPROVED')), 'Approved payroll — WPS file & payment', 'payroll', 'run_no');
      }
      this.myPending = out;
    },
    draw() {
      this.charts.forEach(c => c && c.destroy()); this.charts = [];
      if (this.has('stockCharts') && this.cost) {
        const byClass = {};
        (this.d.val || []).forEach(v => { byClass[v.class_name] = (byClass[v.class_name] || 0) + num(v.value); });
        const cls = Object.keys(byClass).sort((a, b) => byClass[b] - byClass[a]);
        this.charts.push(chart(this.$refs.cVal, { type: 'bar', data: { labels: cls, datasets: [{ label: 'AED', data: cls.map(c => byClass[c]), backgroundColor: PALETTE[0] }] },
          options: { indexAxis: 'y', plugins: { legend: { display: false } } } }));
        const aging = this.d.aging || [], classes = [...new Set(aging.map(a => a.class_name))];
        this.charts.push(chart(this.$refs.cAge, { type: 'bar', data: { labels: AGE_ORDER.map(b => b + ' d'),
          datasets: classes.map((c, i) => ({ label: c, backgroundColor: PALETTE[i % PALETTE.length], data: AGE_ORDER.map(b => num(aging.find(a => a.class_name === c && a.age_bucket === b)?.value)) })) },
          options: { scales: { x: { stacked: true }, y: { stacked: true } } } }));
      }
      if (this.any('stockCharts', 'zoneChart')) {
        const zones = ['BLACK', 'RED', 'YELLOW', 'GREEN', 'BLUE'];
        this.charts.push(chart(this.$refs.cZone, { type: 'doughnut', data: { labels: ['Stock-out', 'Red', 'Yellow', 'Green', 'Over (blue)'],
          datasets: [{ data: zones.map(z => this.stock.filter(s => s.buffer_zone === z).length), backgroundColor: zones.map(z => ZONE_COLORS[z]) }] } }));
      }
      if (this.has('stockCharts')) {
        const sts = ['STOCK_OUT', 'BELOW_SAFETY', 'REORDER', 'OK', 'OVERSTOCK', 'NON_MOVING'];
        this.charts.push(chart(this.$refs.cStatus, { type: 'bar', data: { labels: sts.map(label), datasets: [{ label: 'Items', data: sts.map(s => this.stock.filter(x => x.stock_status === s && (num(x.on_hand) > 0 || s === 'STOCK_OUT')).length),
          backgroundColor: ['#111827', '#dc2626', '#eab308', '#16a34a', '#2563eb', '#7c3aed'] }] }, options: { plugins: { legend: { display: false } } } }));
      }
    },
    open(r) { go(r.link); },
    openProject(p) { go('d/proj/' + p.project_id); },
    barColor(p) { return p.units_overdue || (p.days_left < 0 && p.progress_pct < 100) ? '#dc2626' : p.days_left !== null && p.days_left < 14 && p.progress_pct < 80 ? '#d97706' : '#16a34a'; },
    count(key) { return this.d[key] || 0; },
  },
  template: `<div>
    <div class="row" style="margin-bottom:10px">
      <h2 style="margin:0;font-size:18px">{{ cfg.title }} dashboard</h2>
      <span class="muted small" v-if="viewRole !== $root.state.profile.role">· showing approvals of the {{ label(viewRole) }} role</span>
      <span class="muted small" v-if="customised">· customised</span>
      <span class="spacer"></span>
      <button class="btn sm" v-if="!ed" @click="customise">✎ Customise</button>
      <button class="btn sm" @click="load">⟳ Refresh</button>
    </div>

    <div class="card" v-if="ed">
      <h3>Customise the {{ cfg.title }} dashboard</h3>
      <p class="small muted" style="margin-top:0">Choose the sections you want, their order and size — <b>drag</b> a row here or a section on the dashboard below onto the place you want it (or use ↑ ↓); the dashboard changes as you edit. Sections side by side need widths that add up to a full row (e.g. ½ + ½, ⅓ + ⅔). On phones every section is full width. <b>★ New KPI card</b> adds your own figure (any measure from your dashboards, for a period / project, with an optional goal); cards are shared by all your dashboards. These settings are yours only.</p>
      <div class="dash-ed">
        <div v-for="(s, i) in ed.list" :key="s" class="row" draggable="true" :class="{dragging: drag === s, 'drop-at': over === s && drag !== s}"
             @dragstart="dragStart($event, s)" @dragover="dragOver($event, s)" @drop="drop($event, s)" @dragend="dragEnd">
          <span class="grip" title="Drag to reorder">⠿</span>
          <span class="muted small" style="width:20px">{{ i + 1 }}</span><span style="flex:1">{{ secLabel(s) }}</span>
          <template v-if="s.startsWith('kpi:')">
            <button class="btn sm" @click="editCard(s)" title="Edit card">✎</button>
            <button class="btn sm" @click="removeCard(s)" title="Delete card everywhere">🗑</button>
          </template>
          <select class="sm" title="Width" :value="size(s).w" @change="setSize(s, 'w', Number($event.target.value))"><option v-for="w in WIDTHS" :value="w.v">{{ w.l }}</option></select>
          <select class="sm" title="Height" :value="size(s).h" @change="setSize(s, 'h', $event.target.value)"><option v-for="h in HEIGHTS" :value="h.v">{{ h.l }}</option></select>
          <button class="btn sm" :disabled="i === 0" @click="move(i, -1)" title="Move up">↑</button>
          <button class="btn sm" :disabled="i === ed.list.length - 1" @click="move(i, 1)" title="Move down">↓</button>
          <button class="btn sm bad" @click="ed.list.splice(i, 1)" title="Remove">✕</button>
        </div>
        <div v-if="!ed.list.length" class="muted small">No sections — add at least one below.</div>
      </div>
      <div class="row" style="flex-wrap:wrap;gap:10px;margin-top:10px">
        <select v-model="ed.add" style="max-width:340px"><option value="">+ Add a section…</option><option v-for="s in addable" :value="s">{{ secLabel(s) }}</option></select>
        <button class="btn sm" :disabled="!ed.add" @click="addSection">Add</button>
        <button class="btn sm primary" @click="editCard(null)">★ New KPI card</button>
        <label class="row small" style="gap:6px" v-if="homeOpts.length > 1">Open at sign-in
          <select v-model="ed.home"><option v-for="h in homeOpts" :value="h.v">{{ h.l }}</option></select></label>
        <span class="spacer"></span>
        <button class="btn sm" @click="savePrefs(true)" v-if="customised">Reset to standard</button>
        <button class="btn sm" @click="ed = null">Cancel</button>
        <button class="btn sm primary" :disabled="!ed.list.length" @click="savePrefs(false)">Save</button>
      </div>
    </div>

    <div class="dash-body" :class="{editing: !!ed}" @dragstart="ed && dragStart($event)" @dragover="ed && dragOver($event)" @drop="ed && drop($event)" @dragend="dragEnd">

    <!-- the user's own KPI cards -->
    <div v-for="c in myCards" :key="c.id" class="kpi my-kpi" :class="kpiClass(c)" :data-sec="'kpi:' + c.id" :draggable="!!ed" :style="o('kpi:' + c.id)"
         :title="kv[c.id]?.err || ''">
      <div class="l">{{ c.title }}<span v-if="ed" class="kpi-tools"><a href="javascript:void 0" @click="editCard('kpi:' + c.id)" title="Edit">✎</a></span></div>
      <div class="v">{{ kpiText(c) }}</div>
      <div class="s">{{ kpiSub(c) }}</div>
    </div>

    <div class="card" data-sec="pending" :draggable="!!ed" :style="o('pending')" v-if="has('pending') && myPending.length">
      <h3>Waiting for {{ viewRole !== $root.state.profile.role ? label(viewRole) : 'your action' }} ({{ myPending.length }})</h3>
      <DataTable :columns="[{k:'type',label:'Document'},{k:'no',label:'No.'},{k:'date',label:'Created',fmt:'datetime'},{k:'status',label:'Status',fmt:'badge'}]" :rows="myPending" clickable @row="open" :searchable="false" />
    </div>

    <!-- finance -->
    <div class="kpis" data-sec="finKpis" :draggable="!!ed" :style="o('finKpis')" v-if="has('finKpis')">
      <div class="kpi"><div class="l">Bank balance</div><div class="v">{{ aed(fin.bank) }}</div><div class="s">cash {{ aed(fin.cash) }} · cheques in hand {{ aed(fin.pdc) }}</div></div>
      <div class="kpi" :class="{warn: ar.over > 0}"><div class="l">Receivables</div><div class="v">{{ aed(ar.bal) }}</div><div class="s">overdue {{ aed(ar.over) }}</div></div>
      <div class="kpi" :class="{warn: overduePay > 0}"><div class="l">Net payables</div><div class="v">{{ aed(netPayable) }}</div><div class="s">overdue {{ aed(overduePay) }}</div></div>
      <div class="kpi"><div class="l">Revenue this month</div><div class="v">{{ aed(fin.revM) }}</div><div class="s">year to date {{ aed(fin.revY) }}</div></div>
      <div class="kpi" :class="{bad: fin.profitY < 0}"><div class="l">Profit year to date</div><div class="v">{{ aed(fin.profitY) }}</div><div class="s">per ledger</div></div>
      <div class="kpi"><div class="l">VAT payable (net)</div><div class="v">{{ aed(fin.vat) }}</div><div class="s">output − input to date</div></div>
      <div class="kpi"><div class="l">Unbilled work</div><div class="v">{{ aed(unbilled) }}</div><div class="s">retention held {{ aed(retention) }}</div></div>
    </div>
    <div class="card" data-sec="billing" :draggable="!!ed" :style="o('billing')" v-if="has('billing') && (d.billing || []).length">
      <h3>Project billing</h3>
      <DataTable :searchable="false" :rows="d.billing" clickable @row="r => go('d/si/new/project/' + r.project_id)" :columns="[{k:'project_code',label:'Project'},{k:'customer_name',label:'Customer'},
        {k:'contract_value',label:'Contract',fmt:'money',sum:true},{k:'billed_pct',label:'Billed %',n:true},{k: r => Math.max(Number(r.earned_value) - Number(r.certified_to_date), 0), label:'Unbilled work', fmt:'money', sum:true},
        {k:'retention_held',label:'Retention held',fmt:'money',sum:true},{k:'outstanding',label:'Outstanding',fmt:'money',sum:true}]" />
    </div>

    <!-- management -->
    <div class="kpis" data-sec="mgmtKpis" :draggable="!!ed" :style="o('mgmtKpis')" v-if="has('mgmtKpis')">
      <div class="kpi" v-if="cost"><div class="l">Inventory value</div><div class="v">{{ aed(stockValue) }}</div><div class="s">assets at cost {{ aed(assetValue) }}</div></div>
      <div class="kpi" v-if="cost" style="cursor:pointer" @click="go('r/wip')"><div class="l">WIP — material on the floor</div><div class="v">{{ aed(wipValue) }}</div><div class="s">{{ wipOrders }} project(s) · report →</div></div>
      <div class="kpi bad"><div class="l">Stock-outs</div><div class="v">{{ stockOuts }}</div><div class="s">buffer in red: {{ redZone }}</div></div>
      <div class="kpi" v-if="cost"><div class="l">Overstock / non-moving</div><div class="v">{{ aed(overstockVal) }}</div><div class="s">older than 90 days {{ aed(over90) }}</div></div>
      <div class="kpi" v-if="(d.pay || []).length"><div class="l">Net payables</div><div class="v">{{ aed(netPayable) }}</div><div class="s">overdue {{ aed(overduePay) }}</div></div>
      <div class="kpi" v-if="d.ar"><div class="l">Receivables</div><div class="v">{{ aed(ar.bal) }}</div><div class="s">overdue {{ aed(ar.over) }}</div></div>
      <div class="kpi" :class="{bad: toolsOverdue}"><div class="l">Tools overdue for return</div><div class="v">{{ toolsOverdue }}</div><div class="s">calibration due: {{ calibDue }}</div></div>
    </div>

    <!-- purchase -->
    <div class="kpis" data-sec="purKpis" :draggable="!!ed" :style="o('purKpis')" v-if="has('purKpis')">
      <div class="kpi bad"><div class="l">Stock-outs</div><div class="v">{{ stockOuts }}</div></div>
      <div class="kpi warn"><div class="l">Buffer in RED</div><div class="v">{{ redZone }}</div><div class="s">order urgently</div></div>
      <div class="kpi"><div class="l">Items to order</div><div class="v">{{ toOrder }}</div><div class="s"><a href="#/replenish">replenishment →</a></div></div>
      <div class="kpi"><div class="l">Open POs</div><div class="v">{{ (d.pos || []).length }}</div><div class="s">awaiting approval {{ (d.pos || []).filter(p => p.status.startsWith('PENDING')).length }}</div></div>
      <div class="kpi" :class="{bad: (d.pos || []).some(p => p.delivery_date && p.delivery_date < today() && ['RELEASED','PARTIALLY_RECEIVED'].includes(p.status))}"><div class="l">Late deliveries</div>
        <div class="v">{{ (d.pos || []).filter(p => p.delivery_date && p.delivery_date < today() && ['RELEASED','PARTIALLY_RECEIVED'].includes(p.status)).length }}</div><div class="s">past PO delivery date</div></div>
    </div>
    <div class="card" data-sec="poLate" :draggable="!!ed" :style="o('poLate')" v-if="has('poLate')">
      <h3>Open purchase orders by delivery date</h3>
      <DataTable :rows="d.pos || []" :loading="loading" clickable @row="r => go('d/po/' + r.id)" :columns="[{k:'po_no',label:'PO'},{k: r => r.vendors?.name, label:'Vendor'},{k: r => r.projects?.code || 'Stock', label:'For'},
        {k:'delivery_date',label:'Delivery',fmt:'date'},{k: r => r.delivery_date && r.delivery_date < today() && ['RELEASED','PARTIALLY_RECEIVED'].includes(r.status) ? 'OVERDUE' : '', label:'', fmt:'badge'},
        {k:'total_aed',label:'Value AED',fmt:'money',cost:true},{k:'status',label:'Status',fmt:'badge'}]" />
    </div>

    <!-- sales -->
    <div class="kpis" data-sec="salesKpis" :draggable="!!ed" :style="o('salesKpis')" v-if="has('salesKpis')">
      <div class="kpi"><div class="l">Quotations open</div><div class="v">{{ (d.qts || []).filter(q => ['DRAFT','SENT'].includes(q.status)).length }}</div>
        <div class="s" v-if="cost">{{ aed((d.qts || []).filter(q => ['DRAFT','SENT'].includes(q.status)).reduce((s, q) => s + Number(q.subtotal), 0)) }}</div></div>
      <div class="kpi ok"><div class="l">Quotes won this year</div><div class="v">{{ (d.qts || []).filter(q => q.status === 'ACCEPTED').length }} / {{ (d.qts || []).filter(q => ['ACCEPTED','LOST'].includes(q.status)).length }}</div><div class="s">won / decided</div></div>
      <div class="kpi"><div class="l">Open customer orders</div><div class="v">{{ (d.sos || []).filter(s => s.so_type === 'CUSTOMER' && s.status === 'CONFIRMED').length }}</div>
        <div class="s" v-if="cost">{{ aed((d.sos || []).filter(s => s.so_type === 'CUSTOMER' && s.status === 'CONFIRMED').reduce((a, s) => a + Number(s.subtotal), 0)) }}</div></div>
      <div class="kpi" :class="{bad: (d.sos || []).some(s => s.status === 'CONFIRMED' && s.delivery_date && s.delivery_date < today() && s.delivered_pct < 100)}"><div class="l">Late orders</div>
        <div class="v">{{ (d.sos || []).filter(s => s.status === 'CONFIRMED' && s.delivery_date && s.delivery_date < today() && s.delivered_pct < 100).length }}</div><div class="s">past delivery date</div></div>
      <div class="kpi warn"><div class="l">Internal orders to approve</div><div class="v">{{ (d.sos || []).filter(s => s.status === 'PENDING_FM').length }}</div></div>
    </div>
    <div class="card" data-sec="soOpen" :draggable="!!ed" :style="o('soOpen')" v-if="has('soOpen')">
      <h3>Open sales & internal orders</h3>
      <DataTable :rows="d.sos || []" :loading="loading" clickable @row="r => go('d/so/' + r.id)" :columns="[{k:'so_no',label:'Order'},{k: r => r.so_type === 'INTERNAL' ? 'Internal · ' + (r.cost_center_code || '') : r.customer_name, label:'Customer'},
        {k:'title',label:'Title'},{k:'delivery_date',label:'Delivery',fmt:'date'},{k:'delivered_pct',label:'% delivered',n:true},{k:'subtotal',label:'Value AED',fmt:'money',cost:true},
        {k:'margin_pct',label:'Margin %',n:true,cost:true},{k:'status',label:'Status',fmt:'badge'}]" />
    </div>

    <!-- stores -->
    <div class="kpis" data-sec="stockKpis" :draggable="!!ed" :style="o('stockKpis')" v-if="has('stockKpis')">
      <div class="kpi" v-if="cost"><div class="l">Inventory value (stock)</div><div class="v">{{ aed(stockValue) }}</div><div class="s">FIFO / weighted average</div></div>
      <div class="kpi" v-if="cost" style="cursor:pointer" @click="go('r/wip')"><div class="l">WIP — material on the floor</div><div class="v">{{ aed(wipValue) }}</div><div class="s">issued, not yet consumed · {{ wipOrders }} project(s) →</div></div>
      <div class="kpi bad"><div class="l">Stock-outs</div><div class="v">{{ stockOuts }}</div><div class="s">items with zero available</div></div>
      <div class="kpi warn"><div class="l">Buffer in RED</div><div class="v">{{ redZone }}</div><div class="s">order urgently</div></div>
      <div class="kpi" v-if="cost"><div class="l">Stock older than 90 days</div><div class="v">{{ aed(over90) }}</div></div>
      <div class="kpi" :class="{warn: (d.expiring || []).length}"><div class="l">Lots expiring ≤ 60 days</div><div class="v">{{ (d.expiring || []).length }}</div></div>
      <div class="kpi" :class="{bad: toolsOverdue}"><div class="l">Tools overdue for return</div><div class="v">{{ toolsOverdue }}</div><div class="s">calibration due: {{ calibDue }}</div></div>
    </div>
    <div class="card" data-sec="expiring" :draggable="!!ed" :style="o('expiring')" v-if="has('expiring') && (d.expiring || []).length">
      <h3>Expiring within 60 days</h3>
      <DataTable :searchable="false" :rows="d.expiring" :columns="[{k:'item_code',label:'Item'},{k:'item_name',label:'Description'},{k:'location_code',label:'Location'},{k:'lot_no',label:'Lot'},{k:'batch_no',label:'Batch'},
        {k:'expiry_date',label:'Expiry',fmt:'date'},{k:'qty_on_hand',label:'Qty',fmt:'qty'},{k:'uom',label:'UoM'}]" />
    </div>

    <!-- production -->
    <div class="kpis" data-sec="prodKpis" :draggable="!!ed" :style="o('prodKpis')" v-if="has('prodKpis') || has('production')">
      <div class="kpi"><div class="l">Open production orders</div><div class="v">{{ wos.length }}</div></div>
      <div class="kpi" :class="{bad: woLate.length}"><div class="l">Late orders</div><div class="v">{{ woLate.length }}</div><div class="s">past due date</div></div>
      <div class="kpi"><div class="l">Stages running</div><div class="v">{{ count('stagesRunning') }}</div><div class="s"><a href="#/floor">stage board →</a></div></div>
      <div class="kpi" :class="{warn: count('qc')}"><div class="l">QC rejects awaiting FM</div><div class="v">{{ count('qc') }}</div></div>
      <div class="kpi" v-if="cost && !has('mgmtKpis') && !has('stockKpis')" style="cursor:pointer" @click="go('r/wip')"><div class="l">WIP — material on the floor</div><div class="v">{{ aed(wipValue) }}</div><div class="s">{{ wipOrders }} project(s) · report →</div></div>
      <div class="kpi" v-if="has('prodKpis')" :class="{bad: (d.wc || []).some(w => w.is_down)}"><div class="l">Machines down</div><div class="v">{{ (d.wc || []).filter(w => w.is_down).length }}</div></div>
    </div>
    <div class="card" data-sec="woLate" :draggable="!!ed" :style="o('woLate')" v-if="has('woLate')">
      <h3>Open production orders by due date</h3>
      <DataTable :rows="wos" :loading="loading" clickable @row="r => go('d/wo/' + r.id)" :columns="[{k:'wo_no',label:'Order'},{k:'description',label:'Description'},{k: r => r.projects?.code || 'MTS', label:'Project'},
        {k: r => qty(r.qty_completed) + ' / ' + qty(r.qty), label:'Done / qty'},{k:'due_date',label:'Due',fmt:'date'},{k: r => r.due_date && r.due_date < today() ? 'OVERDUE' : '', label:'', fmt:'badge'},
        {k:'priority',label:'Priority',fmt:'label'},{k:'status',label:'Status',fmt:'badge'}]" />
    </div>
    <div class="card" data-sec="pmJobs" :draggable="!!ed" :style="o('pmJobs')" v-if="has('pmJobs')">
      <div class="hd"><h3>Preventive maintenance</h3><span class="spacer"></span><a class="small" href="#/r/pmdue">PM due list →</a></div>
      <div class="kpis">
        <div class="kpi" :class="{bad: pmRows.some(r => r.state === 'OVERDUE')}"><div class="l">Overdue</div><div class="v">{{ pmRows.filter(r => r.state === 'OVERDUE').length }}</div><div class="s">past due, not done</div></div>
        <div class="kpi"><div class="l">PM jobs open</div><div class="v">{{ pmRows.filter(r => r.job_id).length }}</div><div class="s">in progress {{ pmRows.filter(r => r.state === 'IN_PROGRESS').length }}</div></div>
        <div class="kpi" :class="{warn: pmRows.some(r => r.state === 'DUE_SOON')}"><div class="l">Coming due</div><div class="v">{{ pmRows.filter(r => r.state === 'DUE_SOON').length }}</div><div class="s">job raised automatically</div></div>
        <div class="kpi"><div class="l">Done this month</div><div class="v">{{ (d.pmDone || []).length }}</div><div class="s" v-if="pmOnTime !== null">{{ pmOnTime }}% on time</div></div>
      </div>
      <DataTable v-if="pmRows.length" :searchable="false" :rows="pmRows" clickable @row="r => go(r.job_id ? 'd/pm/' + r.job_id : 'd/pms/' + r.id)"
        :columns="[{k:'state',label:'State',fmt:'badge'},{k:'target_label',label:'Machine / asset / area'},{k:'title',label:'Maintenance'},{k:'due',label:'Due',fmt:'date'},
        {k:'hours_left',label:'Running h left',n:true},{k: r => r.done_by === 'VENDOR' ? 'AMC · ' + (r.vendor_name || '') : 'In-house', label:'Done by'},{k:'job_no',label:'Job'}]" />
      <div v-else-if="!loading" class="muted small">Nothing due — all machines are within their PM intervals.</div>
    </div>
    <div class="card" data-sec="wcLoad":draggable="!!ed" :style="o('wcLoad')" v-if="has('wcLoad') && (d.wc || []).length">
      <h3>Work centre load</h3>
      <DataTable :searchable="false" :rows="d.wc" :columns="[{k:'code',label:'Code'},{k:'name',label:'Work centre'},{k:'open_stages',label:'Open stages',n:true},{k:'running',label:'Running',n:true},
        {k:'remaining_hours',label:'Hours queued',fmt:'qty'},{k:'load_days',label:'Load (days)',fmt:'qty'},{k:'availability_pct_30d',label:'Availability 30d %',n:true},{k: r => r.is_down ? 'DOWN' : 'RUNNING', label:'Now', fmt:'badge'}]" />
    </div>

    <!-- HR -->
    <div class="kpis" data-sec="hrKpis" :draggable="!!ed" :style="o('hrKpis')" v-if="has('hrKpis')">
      <div class="kpi"><div class="l">Active employees</div><div class="v">{{ (d.emps || []).length }}</div><div class="s">on leave {{ (d.emps || []).filter(e => e.emp_status === 'ON_LEAVE').length }}</div></div>
      <div class="kpi"><div class="l">Attendance today</div><div class="v">{{ (d.att || []).filter(a => ['PRESENT','HALF_DAY'].includes(a.status)).length }}</div>
        <div class="s">absent {{ (d.att || []).filter(a => a.status === 'ABSENT').length }} · not marked {{ Math.max((d.emps || []).length - (d.att || []).length, 0) }}</div></div>
      <div class="kpi" :class="{warn: (d.leaves || []).some(l => l.status === 'PENDING')}"><div class="l">Leave requests pending</div><div class="v">{{ (d.leaves || []).filter(l => l.status === 'PENDING').length }}</div></div>
      <div class="kpi" :class="{bad: (d.docs || []).some(x => x.days_left < 0)}"><div class="l">Documents expiring ≤ 60 days</div><div class="v">{{ (d.docs || []).length }}</div>
        <div class="s">expired {{ (d.docs || []).filter(x => x.days_left < 0).length }}</div></div>
      <div class="kpi" v-if="(d.payrollRun || [])[0]"><div class="l">Latest payroll</div><div class="v" style="font-size:16px">{{ new Date(d.payrollRun[0].period_month + 'T00:00:00').toLocaleDateString('en-GB', {month:'short', year:'numeric'}) }}</div>
        <div class="s"><span class="b" :class="d.payrollRun[0].status">{{ label(d.payrollRun[0].status) }}</span></div></div>
      <div class="kpi" v-if="cost"><div class="l">Advances outstanding</div><div class="v">{{ aed((d.advances || []).reduce((s, a) => s + Number(a.amount) - Number(a.recovered || 0), 0)) }}</div></div>
    </div>
    <div class="card" data-sec="docExpiry" :draggable="!!ed" :style="o('docExpiry')" v-if="has('docExpiry') && (d.docs || []).length">
      <h3>Employee documents expiring</h3>
      <DataTable :searchable="false" :rows="d.docs" clickable @row="r => go('d/emp/' + r.employee_id)" :columns="[{k:'emp_code',label:'Code'},{k:'name',label:'Employee'},{k:'doc_type',label:'Document',fmt:'label'},
        {k:'doc_no',label:'No.'},{k:'expiry_date',label:'Expiry',fmt:'date'},{k:'days_left',label:'Days left',n:true},{k:'expiry_status',label:'Status',fmt:'badge'}]" />
    </div>
    <div class="card" data-sec="onLeave" :draggable="!!ed" :style="o('onLeave')" v-if="has('onLeave') && (d.leaves || []).length">
      <h3>Current & upcoming leave</h3>
      <DataTable :searchable="false" :rows="d.leaves" clickable @row="r => go('d/leave/' + r.id)" :columns="[{k: r => r.employees ? r.employees.name + ' (' + r.employees.emp_code + ')' : '', label:'Employee'},
        {k:'leave_type',label:'Type',fmt:'label'},{k:'from_date',label:'From',fmt:'date'},{k:'to_date',label:'To',fmt:'date'},{k:'days',label:'Days',n:true},{k:'status',label:'Status',fmt:'badge'}]" />
    </div>

    <!-- shared sections -->
    <div class="card" data-sec="projects" :draggable="!!ed" :style="o('projects')" v-if="has('projects') && (d.projects || []).length">
      <h3>Running projects ({{ d.projects.length }})</h3>
      <div class="tbl-wrap"><table class="t">
        <thead><tr><th>Project</th><th>Due</th><th style="min-width:160px">Progress (installed value)</th><th class="n">Units handed over</th><th class="n">Snagging</th>
          <th class="n">Overdue units</th><th class="n">Open snags</th><th class="n">Production orders</th><th class="n">Variations</th><th class="n" v-if="cost">Margin %</th></tr></thead>
        <tbody><tr v-for="p in d.projects" :key="p.project_id" style="cursor:pointer" @click="openProject(p)">
          <td><b>{{ p.code }}</b> {{ p.name }}<div class="small muted">{{ p.customer }}{{ p.boq_locked ? ' · BOQ locked' : '' }}</div></td>
          <td :style="p.days_left < 0 ? 'color:#b91c1c;font-weight:600' : ''">{{ p.end_date ? dt(p.end_date) : '—' }}
            <div class="small muted" v-if="p.days_left !== null">{{ p.days_left < 0 ? -p.days_left + ' days late' : p.days_left + ' days left' }}</div></td>
          <td><div style="height:8px;background:#e5e7eb;border-radius:4px"><div :style="{height:'8px',borderRadius:'4px',width:Math.min(p.progress_pct,100)+'%',background:barColor(p)}"></div></div>
            <div class="small muted">{{ p.progress_pct }}%</div></td>
          <td class="n">{{ p.units_handed }} / {{ p.units_total }}</td><td class="n">{{ p.units_snagging || '' }}</td>
          <td class="n" :style="p.units_overdue ? 'color:#b91c1c;font-weight:600' : ''">{{ p.units_overdue || '' }}</td>
          <td class="n">{{ p.open_snags || '' }}<span v-if="p.overdue_snags" style="color:#b91c1c"> ({{ p.overdue_snags }} late)</span></td>
          <td class="n">{{ p.wo_open }}<span v-if="p.wo_late" style="color:#b91c1c"> ({{ p.wo_late }} late)</span></td>
          <td class="n">{{ p.vo_pending ? p.vo_pending + ' pending' : '' }}<div class="small muted" v-if="cost && Number(p.vo_approved_value)">{{ money(p.vo_approved_value) }}</div></td>
          <td class="n" v-if="cost" :style="p.margin_pct !== null && Number(p.margin_pct) < 10 ?'color:#b91c1c;font-weight:600' : ''">{{ p.margin_pct ?? '' }}</td>
        </tr></tbody>
      </table></div>
    </div>
    <div class="card" data-sec="payables" :draggable="!!ed" :style="o('payables')" v-if="has('payables') && (d.pay || []).some(p => Number(p.net_payable_aed))">
      <h3>Payables by vendor</h3>
      <DataTable :searchable="false" :rows="(d.pay || []).filter(p => Number(p.net_payable_aed))" :columns="[{k:'name',label:'Vendor'},{k:'payment_term',label:'Terms'},{k:'not_due_aed',label:'Not due',fmt:'money',sum:true},
        {k: r => Number(r.overdue_1_30_aed) + Number(r.overdue_31_60_aed) + Number(r.overdue_61_90_aed) + Number(r.overdue_90_plus_aed), label:'Overdue', fmt:'money', sum:true},
        {k:'pdc_not_matured_aed',label:'PDC not matured',fmt:'money',sum:true},{k:'net_payable_aed',label:'Net payable',fmt:'money',sum:true}]" />
    </div>
    <div class="card" data-sec="budgets" :draggable="!!ed" :style="o('budgets')" v-if="has('budgets') && (d.budgets || []).length">
      <h3>Projects near or over material budget ({{ d.budgets.length }})</h3>
      <DataTable :searchable="false" :rows="d.budgets" :columns="[{k:'code',label:'Project'},{k:'name',label:'Name'},{k:'budget_material',label:'Budget AED',fmt:'money'},{k:'net_consumption',label:'Consumed AED',fmt:'money'},{k:'pct',label:'% used',n:true},{k:r=>r.pct>=100?'OVER':'WARNING',label:'Status',fmt:'badge'}]" />
    </div>
    <div class="charts" data-sec="stockCharts,zoneChart" :draggable="!!ed" :style="o('stockCharts', 'zoneChart')" v-if="has('stockCharts') || has('zoneChart')">
      <div class="card" v-if="has('stockCharts') && cost"><h3>Inventory valuation by class (AED)</h3><div class="chart-box"><canvas ref="cVal"></canvas></div></div>
      <div class="card" v-if="has('stockCharts') && cost"><h3>Inventory aging by class (AED)</h3><div class="chart-box"><canvas ref="cAge"></canvas></div></div>
      <div class="card"><h3>TOC buffer zones (items with a buffer)</h3><div class="chart-box"><canvas ref="cZone"></canvas></div></div>
      <div class="card" v-if="has('stockCharts')"><h3>Stock status (items)</h3><div class="chart-box"><canvas ref="cStatus"></canvas></div></div>
    </div>
    <div class="card" data-sec="valuation" :draggable="!!ed" :style="o('valuation')" v-if="has('valuation') && cost">
      <h3>Valuation by category</h3>
      <DataTable :columns="[{k:'kind',label:'Kind',fmt:'label'},{k:'class_name',label:'Class'},{k:'category_name',label:'Category'},{k:'items',label:'Items',n:true},{k:'qty',label:'Qty',fmt:'qty'},{k:'value',label:'Value AED',fmt:'money',sum:true}]" :rows="d.val || []" filename="valuation_by_category" />
    </div>
    </div>
  </div>`,
  setup() { return { go, today, SECTIONS, WIDTHS, HEIGHTS }; },
};
