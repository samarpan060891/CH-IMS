// App shell: authentication, role-based navigation, routing
import { createApp } from 'vue';
import { sb, state, route, go, hasRole, canSeeCost, ROLES, run, must, toast, loadCompany, loadRefs, refreshPending, errMsg, markRead, dtm } from './lib.js';
import { dialog, FieldInput, Modal, Icon } from './components.js';
import { DocList, DocEditor } from './docengine.js';
import { DOCS } from './documents.js';
import { MASTERS, MasterPage } from './masters.js';
import { Dashboard, DASHBOARDS, userDashboards, homeDashboard } from './dashboards.js';
import { Reports, REPORTS, Replenishment, Assets, Users, Settings, BufferReview, ConsolidatePR, Holds, MySignature } from './pages.js';
import { CONFIG } from './config.js';
import { Importer } from './importer.js';
import { Logo } from './logo.js';
import { CountSheet, CountApp } from './counting.js';
import { Labels } from './labels.js';
import { Scanner, describeCode } from './scan.js';
import { PROD_DOCS, StageBoard, QcApprovals, ProductionPlanner } from './production.js';
import { FactorySchedule } from './schedule.js';
import { PROJ_DOCS, Mrp } from './projects.js';
import { SiteApp } from './site.js';
import { HR_DOCS, AttendanceSheet } from './hr.js';
import { FIN_DOCS, Books } from './finance.js';
import { FloorApp } from './floor.js';
import { ApprovalsApp, myQueues } from './approve.js';
import { ReceiveApp } from './receive.js';
import { EXP_DOCS, PettyCash } from './expenses.js';
import { PROV_DOCS, Provisions } from './provisions.js';
import { MDR_DOCS } from './masterreq.js';
import { SALES_DOCS } from './sales.js';
import { CashForecast } from './cash.js';
import { PdfPanel } from './pdf.js';
import { RFQ_DOCS } from './rfq.js';
import { PM_DOCS } from './maintenance.js';
import { MachineRates } from './machinerates.js';

Object.assign(DOCS, PROD_DOCS, PROJ_DOCS, HR_DOCS, FIN_DOCS, EXP_DOCS, PROV_DOCS, MDR_DOCS, SALES_DOCS, RFQ_DOCS, PM_DOCS);

// build stamp: the deploy adds ?v=<commit> to every script and writes version.json; locally there is none
const BUILD = new URL(import.meta.url).searchParams.get('v');

const ALL = null;
// short menu names for reports (full titles show on the report page)
const REP_SHORT = { stock: 'Stock in hand', lots: 'Stock by lot & location', reserved: 'Reserved for projects', stockout: 'Stock-outs', overstock: 'Overstock & non-moving',
  expiry: 'Expiring stock', buffer: 'Buffer status', aging: 'Aging', abc: 'ABC analysis', valuation: 'Valuation', projects: 'Project consumption',
  invoices: 'Open invoices', grni: 'Received, not invoiced', tools: 'Tools with workers', calibration: 'Calibration due',
  boqprog: 'BOQ progress & billing', unitprog: 'Unit progress & billing', snags: 'Snag register',
  leavebal: 'Leave balances', docexpiry: 'Document expiry', gratuity: 'Gratuity provision', attmonth: 'Monthly attendance',
  jobcost: 'Job costing & margin', wcload: 'Work centre load & availability', downtime: 'Downtime analysis', mntcost: 'Maintenance cost by machine', pmdue: 'PM due list', pmcost: 'PM job costs', fg: 'Finished goods stock', projprod: 'Project cost & margin' };
// Dashboard is the fixed home link; below it the main menus in workflow order.
// { sep } entries are small sub-headings inside a menu.
const MENU = [
  { g: 'Sales', icon: 'tag', items: [
    { to: 'd/qt', t: 'Quotations', roles: ['sales', 'finance', 'factory_manager'] },
    { to: 'd/so', t: 'Sales & internal orders', roles: ALL, badge: 'so' },
    { to: 'm/customers', t: 'Customers', roles: ['sales', 'finance', 'factory_manager'] },
    { to: 'r/somargin', t: 'Order delivery, billing & margin', roles: ['sales', 'finance', 'factory_manager'], cost: true },
  ] },
  // confirmed project orders from Sales become projects here
  { g: 'Projects', icon: 'building-community', items: [
    { to: 'site', t: '📱 Site app', roles: ['site_supervisor', 'production_incharge', 'factory_manager'], badge: 'snag' },
    { to: 'd/proj', t: 'Projects & BOQ', roles: ALL },
    { to: 'd/snag', t: 'Snag list', roles: ['site_supervisor', 'production_incharge', 'factory_manager', 'finance'], badge: 'snagVerify' },
    { to: 'd/vo', t: 'Variation orders', roles: ['factory_manager', 'production_incharge', 'finance'], badge: 'vo' },
    { to: 'mrp', t: 'Material planning (MRP)', roles: ['purchase', 'stores', 'production_incharge', 'factory_manager'] },
    { to: 'd/ins', t: 'Installation logs', roles: ['shop_floor', 'production_incharge', 'factory_manager', 'finance', 'site_supervisor'] },
    { sep: 'Progress & billing' },
    { to: 'billable', t: 'Billable now (projects)', roles: ['stores', 'finance', 'factory_manager'], badge: 'projBillable' },
    ...['boqprog', 'unitprog', 'snags', 'projprod'].map(rep),
  ] },
  { g: 'Purchase', icon: 'shopping-cart', items: [
    { to: 'replenish', t: 'Replenishment', roles: ['purchase', 'stores', 'factory_manager'] },
    { to: 'buffers', t: 'Buffer review', roles: ['purchase', 'factory_manager', 'stores'], badge: 'dbm' },
    { to: 'd/pr', t: 'Requisitions', roles: ['purchase', 'stores', 'factory_manager', 'production_incharge'] },
    { to: 'consolidate', t: 'Consolidate requisitions', roles: ['purchase'], badge: 'prOpen' },
    { to: 'd/rfq', t: 'Requests for quotation (RFQ)', roles: ['purchase', 'finance', 'factory_manager'] },
    { to: 'd/po', t: 'Purchase orders', roles: ['purchase', 'factory_manager', 'finance', 'stores'], badge: 'po' },
    { to: 'm/vendors', t: 'Vendors', roles: ['purchase', 'finance', 'factory_manager'] },
    { to: 'import/vendors', t: '⬆ Vendors upload', roles: ['purchase', 'finance'] },
    { to: 'm/item_vendors', t: 'Vendor price list', roles: ['purchase', 'finance', 'factory_manager'] },
  ] },
  // the warehouse dispatches finished goods and issues the invoices / progress claims; Finance certifies and collects
  { g: 'Dispatch & invoicing', icon: 'truck-delivery', items: [
    { to: 'r/fg', t: 'Finished goods stock', roles: ['stores', 'factory_manager', 'production_incharge', 'finance', 'sales'] },
    { to: 'd/dsp', t: 'Deliveries & dispatch notes', roles: ['stores', 'factory_manager', 'production_incharge', 'finance', 'site_supervisor'], badge: 'dsp' },
    // installed quantities drive the progress claims (read-only for the warehouse)
    { to: 'd/ins', t: 'Installation logs', roles: ['stores', 'shop_floor', 'production_incharge', 'factory_manager', 'finance', 'site_supervisor'] },
    { sep: 'Invoicing' },
    { to: 'r/sotoinv', t: 'Sales orders to invoice', roles: ['stores', 'finance', 'factory_manager', 'sales'], badge: 'soToInv' },
    { to: 'billable', t: 'Billable now (projects)', roles: ['stores', 'finance', 'factory_manager'], badge: 'projBillable' },
    { to: 'd/si', t: 'Sales invoices & progress claims', roles: ['stores', 'finance', 'factory_manager'], badge: 'siStores' },
    { to: 'r/boqprog', t: 'BOQ progress & billing', roles: ['stores', 'finance', 'factory_manager', 'production_incharge'] },
    { to: 'r/unitprog', t: 'Unit progress & billing', roles: ['stores', 'finance', 'factory_manager', 'production_incharge'] },
    // approved variations change the BOQ quantities / rates the progress claims bill (read-only for the warehouse)
    { to: 'd/vo', t: 'Variation orders', roles: ['stores', 'factory_manager', 'production_incharge', 'finance'] },
    // open snags hold back handover / final progress claims and may need replacement items dispatched
    rep('snags'),
  ] },
  { g: 'Inventory', icon: 'building-warehouse', items: [
    { to: 'd/grn', t: 'Goods receipts (GRN)', roles: ['stores', 'purchase', 'finance', 'factory_manager', 'site_supervisor'] },
    { to: 'receiveapp', t: '📱 Receive app (phone)', roles: ['stores', 'site_supervisor'] },
    { to: 'd/issue', t: 'Material issues', roles: ['stores', 'factory_manager', 'production_incharge'], badge: 'issue' },
    { to: 'd/trf', t: 'Stock transfers', roles: ['stores', 'factory_manager'] },
    { to: 'd/rel', t: 'Project stock releases', roles: ['stores', 'factory_manager', 'production_incharge', 'purchase', 'finance'], badge: 'rel' },
    { to: 'd/adj', t: 'Stock adjustments', roles: ['stores', 'factory_manager', 'finance'], badge: 'adj' },
    { to: 'd/prt', t: 'Purchase returns', roles: ['stores', 'purchase', 'finance'] },
    { to: 'holds', t: 'Quarantine & exceptions', roles: ['stores', 'purchase', 'factory_manager', 'finance'], badge: 'holds' },
    { to: 'd/cnt', t: 'Stock counts', roles: ['stores', 'factory_manager', 'finance'] },
    { to: 'countapp', t: '📱 Count app (phone)', roles: ['stores', 'factory_manager'] },
    { to: 'r/offcuts', t: '✂ Offcut stock', roles: ['stores', 'factory_manager', 'production_incharge', 'purchase', 'finance', 'shop_floor'] },
    { to: 'r/wip', t: '🏭 WIP — material on the shop floor', roles: ['stores', 'factory_manager', 'production_incharge', 'purchase', 'finance'] },
    { to: 'labels/lots', t: 'Labels & QR codes', roles: ['stores', 'factory_manager'] },
    { sep: 'Assets & scrap' },
    { to: 'assets', t: 'Tool crib & assets', roles: ['stores', 'factory_manager', 'finance', 'production_incharge'] },
    { to: 'd/disposal', t: 'Scrap disposals', roles: ['stores', 'factory_manager', 'finance'], badge: 'disposal' },
  ] },
  // production planning and the shop floor's material in one menu
  { g: 'Production', icon: 'building-factory', items: [
    { to: 'floorapp', t: '📱 Floor app (phone)', roles: ['shop_floor', 'production_incharge', 'stores', 'factory_manager'] },
    { to: 'floor', t: 'Stage board', roles: ['shop_floor', 'production_incharge', 'factory_manager'], badge: 'stages' },
    { to: 'plan', t: 'Production orders', roles: ['production_incharge', 'factory_manager', 'shop_floor', 'stores', 'finance'], badge: 'wo' },
    { to: 'd/wo', t: 'All production orders (list)', roles: ['production_incharge', 'factory_manager', 'shop_floor', 'stores', 'finance'] },
    { to: 'schedule', t: 'Factory schedule', roles: ['production_incharge', 'factory_manager', 'shop_floor', 'stores'] },
    { to: 'qc', t: 'QC approvals', roles: ['factory_manager', 'production_incharge'], badge: 'qc' },
    { sep: 'Shop floor material' },
    { to: 'r/wip', t: 'WIP — material on the floor', roles: ['production_incharge', 'factory_manager', 'stores', 'shop_floor'] },
    { to: 'd/mr', t: 'Material requests', roles: ALL, badge: 'mr' },
    { to: 'd/ack', t: 'Receive material', roles: ['shop_floor', 'production_incharge', 'stores', 'factory_manager', 'site_supervisor'], badge: 'ack' },
    { to: 'd/ret', t: 'Return to store & offcuts', roles: ['shop_floor', 'production_incharge', 'stores', 'factory_manager', 'site_supervisor'], badge: 'ret' },
    { to: 'd/scrap', t: 'Scrap notes', roles: ['stores', 'production_incharge', 'factory_manager', 'shop_floor'], badge: 'scrap' },
    { sep: 'BOM & rates' },
    { to: 'd/bom', t: 'BOM templates', roles: ['production_incharge', 'factory_manager'] },
    { to: 'import/bom', t: '⬆ BOM & man-hours upload', roles: ['production_incharge', 'factory_manager'] },
    { to: 'm/labour_grades', t: 'Worker grades & rates', roles: ['factory_manager', 'finance'] },
    { sep: 'Production reports' },
    ...['jobcost', 'wcload', 'fg'].map(rep),
  ] },
  // machines (MNT-MAC) and factory building / office (MNT-FAC): breakdowns, spares from store, repair & AMC bills, machine costs
  { g: 'Maintenance', icon: 'tool', items: [
    { to: 'd/pm', t: 'PM jobs', roles: ['shop_floor', 'production_incharge', 'factory_manager', 'stores'], badge: 'pm' },
    { to: 'd/pms', t: 'PM schedules', roles: ['production_incharge', 'factory_manager', 'shop_floor', 'stores'] },
    { to: 'd/down', t: 'Breakdowns & planned stops', roles: ['shop_floor', 'production_incharge', 'factory_manager', 'stores'], badge: 'down' },
    { to: 'floorapp', t: '📱 Spares & consumables (phone)', roles: ['shop_floor', 'production_incharge', 'stores', 'factory_manager'] },
    { to: 'd/mr', t: 'Spares requests', roles: ALL },
    { to: 'd/exp', t: 'Repair bills & service claims', roles: ['finance', 'factory_manager', 'purchase', 'stores', 'production_incharge', 'shop_floor', 'site_supervisor', 'hr_officer'] },
    { to: 'd/rexp', t: 'AMC & service contracts', roles: ['finance', 'factory_manager'] },
    { sep: 'Machines' },
    { to: 'm/work_centers', t: 'Machines & work centres', roles: ['factory_manager', 'finance', 'production_incharge'] },
    { to: 'assets', t: 'Tool crib & assets', roles: ['stores', 'factory_manager', 'finance', 'production_incharge'] },
    { to: 'machinerates', t: 'Machine-rate calculator', roles: ['factory_manager', 'finance', 'production_incharge'] },
    { to: 'import/machines', t: '⬆ Machine rates upload', roles: ['factory_manager', 'finance'] },
    { sep: 'Maintenance reports' },
    ...['pmdue', 'pmcost', 'mntcost', 'downtime', 'calibration'].map(rep),
  ] },
  { g: 'HR', icon: 'users', items: [
    { to: 'd/emp', t: 'Employees', roles: ['hr_officer', 'finance'] },
    { to: 'attendance', t: 'Attendance & overtime', roles: ['hr_officer', 'site_supervisor', 'shop_floor', 'production_incharge', 'factory_manager'] },
    { to: 'd/leave', t: 'Leave requests', roles: ['hr_officer', 'factory_manager', 'production_incharge', 'site_supervisor', 'shop_floor', 'stores', 'finance'], badge: 'leave' },
    { to: 'd/adv', t: 'Salary advances', roles: ['hr_officer', 'finance'], badge: 'adv' },
    { to: 'd/payroll', t: 'Payroll & WPS', roles: ['hr_officer', 'finance'], badge: 'payroll' },
    { sep: 'HR reports' },
    ...['leavebal', 'docexpiry', 'gratuity', 'attmonth'].map(rep),
  ] },
  { g: 'Finance', icon: 'report-money', items: [
    { sep: 'Cash' },
    { to: 'cashforecast', t: 'Cash position & forecast', roles: ['finance', 'factory_manager'] },
    { sep: 'Expenses' },
    { to: 'd/exp', t: 'Expenses, bills & claims', roles: ['finance', 'factory_manager', 'purchase', 'stores', 'production_incharge', 'shop_floor', 'site_supervisor', 'hr_officer'], badge: 'exp' },
    { to: 'd/rexp', t: 'Recurring bills', roles: ['finance', 'factory_manager'] },
    { to: 'pettycash', t: 'Petty cash', roles: ['finance', 'factory_manager'] },
    { to: 'r/expreg', t: 'Expense register', roles: ['finance', 'factory_manager'] },
    { to: 'm/cc_budgets', t: 'Expense budgets', roles: ['finance', 'factory_manager'] },
    { to: 'r/budget', t: 'Budget vs actual', roles: ['finance', 'factory_manager'] },
    { to: 'r/overhead', t: 'Factory overheads vs absorbed', roles: ['finance', 'factory_manager'] },
    { sep: 'Receivables' },
    { to: 'd/si', t: 'Invoices — certificates & posting', roles: ['finance', 'factory_manager'], badge: 'siCert' },
    { to: 'd/rcv', t: 'Customer receipts', roles: ['finance', 'factory_manager'], badge: 'pdc' },
    { to: 'books/billing', t: 'Project billing', roles: ['finance', 'factory_manager'], badge: 'projBillable' },
    { to: 'books/aging', t: 'Receivables aging', roles: ['finance', 'factory_manager'] },
    { to: 'm/customers', t: 'Customers', roles: ['finance', 'factory_manager'] },
    { sep: 'Payables' },
    { to: 'd/inv', t: 'Vendor invoices', roles: ['finance', 'factory_manager'] },
    { to: 'd/pay', t: 'Payments', roles: ['finance', 'factory_manager'] },
    { to: 'd/dn', t: 'Debit notes', roles: ['finance'] },
    { to: 'r/payables', t: 'Net payables', roles: ['finance', 'factory_manager', 'purchase'] },
    { sep: 'General ledger' },
    { to: 'books/tb', t: 'Trial balance', roles: ['finance', 'factory_manager'] },
    { to: 'books/pl', t: 'Profit & loss', roles: ['finance', 'factory_manager'] },
    { to: 'books/bs', t: 'Balance sheet', roles: ['finance', 'factory_manager'] },
    { to: 'books/ledger', t: 'Ledgers & bank reconciliation', roles: ['finance', 'factory_manager'] },
    { to: 'books/vat', t: 'VAT return (201)', roles: ['finance'] },
    { to: 'd/jv', t: 'Journals', roles: ['finance', 'factory_manager'] },
    { to: 'provisions', t: 'Provisions & accruals', roles: ['finance', 'factory_manager'] },
    { to: 'd/acr', t: 'Accruals', roles: ['finance', 'factory_manager'] },
    { to: 'd/ppm', t: 'Prepayments', roles: ['finance', 'factory_manager'] },
    { to: 'books/periods', t: 'Month end & period close', roles: ['finance'] },
    { to: 'm/gl_accounts', t: 'Chart of accounts', roles: ['finance', 'factory_manager'] },
  ] },
  { g: 'Reports', icon: 'chart-bar', items: [
    { sep: 'Stock' },
    ...['stock', 'lots', 'reserved', 'stockout', 'overstock', 'expiry', 'wip'].map(rep),
    { to: 'r/ledger', t: 'Stock ledger', roles: ALL },
    { sep: 'Analysis' },
    ...['buffer', 'aging', 'abc', 'valuation'].map(rep),
    { sep: 'Projects & purchasing' },
    ...['projects', 'invoices', 'grni'].map(rep),
    { sep: 'Tools & assets' },
    ...['tools', 'calibration'].map(rep),
  ] },
  { g: 'Masters', icon: 'database', items: [
    { to: 'd/mdr', t: '➕ Requests for new entries', roles: ALL, badge: 'mdr' },
    { to: 'm/lookups', t: 'Drop-down lists', roles: ['hr_officer', 'finance', 'stores', 'purchase', 'factory_manager', 'production_incharge'] },
    { to: 'import/items', t: 'Excel import', roles: ['stores', 'purchase', 'finance', 'production_incharge', 'factory_manager'] },
    { to: 'm/items', t: 'Items', roles: ALL },
    { to: 'm/locations', t: 'Locations', roles: ['stores', 'factory_manager'] },
    { to: 'm/projects', t: 'Projects & MTS', roles: ALL },
    { to: 'm/employees', t: 'Employees', roles: ['stores', 'factory_manager', 'production_incharge'] },
    { to: 'm/cost_centers', t: 'Cost centres', roles: ['factory_manager', 'finance', 'stores'] },
    { to: 'm/payment_terms', t: 'Payment terms', roles: ['purchase', 'finance'] },
    { to: 'm/item_categories', t: 'Categories', roles: ['stores', 'purchase'] },
    { to: 'm/item_classes', t: 'Item classes', roles: ['stores', 'purchase', 'finance'] },
    { to: 'm/uoms', t: 'Units of measure', roles: ['stores', 'purchase'] },
    { to: 'm/public_holidays', t: 'Public holidays', roles: ['factory_manager', 'hr_officer', 'production_incharge'] },
  ] },
  { g: 'Administration', icon: 'settings', items: [
    { to: 'users', t: 'Users & roles', roles: [] },
    { to: 'settings', t: 'Settings', roles: [] },
  ] },
];
// a report menu entry, honouring the report's own role and cost visibility
function rep(k) { const r = REPORTS[k]; return { to: 'r/' + k, t: REP_SHORT[k] || r.title, roles: r.roles || ALL, cost: !!r.cost }; }
const OPEN_KEY = 'ims.menu.open';

// Sign-in only: the Administrator creates users and resets passwords (Users & roles),
// so no self sign-up or reset emails are needed.
const Login = {
  data: () => ({ email: '', password: '', busy: false, msg: '' }),
  methods: {
    async submit() {
      this.busy = true; this.msg = '';
      try {
        const { error } = await sb.auth.signInWithPassword({ email: this.email.trim(), password: this.password });
        if (error) throw error;
      } catch (e) {
        this.msg = /invalid login credentials/i.test(errMsg(e)) ? 'Email or password is incorrect.' : errMsg(e);
      }
      this.busy = false;
    },
  },
  components: { Logo },
  template: `<div class="login"><form class="box" @submit.prevent="submit">
    <div style="text-align:center;margin-bottom:10px"><Logo :size="120" /></div>
    <h1 style="text-align:center">CitiCore</h1>
    <p style="text-align:center">Kitchen & Wooden Furniture Manufacturing LLC</p>
    <div class="grid" style="grid-template-columns:1fr">
      <label class="f">Email<input v-model="email" type="email" required autocomplete="username"></label>
      <label class="f">Password<input v-model="password" type="password" required autocomplete="current-password"></label>
      <button class="btn primary" :disabled="busy" style="justify-content:center">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
      <div v-if="msg" class="small" style="color:#b91c1c">{{ msg }}</div>
      <p class="small muted" style="margin:4px 0 0;text-align:center">Contact your administrator for access or a password reset.</p>
    </div>
  </form></div>`,
};

const App = {
  components: { Login, DocList, DocEditor, MasterPage, Dashboard, Reports, Replenishment, Assets, Users, Settings, Importer, BufferReview, ConsolidatePR, Holds, CountSheet, Labels, Scanner, FieldInput, Modal, Logo, Icon, StageBoard, QcApprovals, ProductionPlanner, FactorySchedule, Mrp, SiteApp, AttendanceSheet, Books, FloorApp, ApprovalsApp, CountApp, ReceiveApp, PettyCash, Provisions, MachineRates, CashForecast, PdfPanel, MySignature },
  data: () => ({ state, route, dialog, ready: false, sideOpen: false, bellOpen: false, ROLES, openGroup: null, scanning: false, scanResult: null, newVersion: false }),
  watch: {
    // opening a page expands its menu group
    activeGroup: { immediate: true, handler(g) { if (g) this.openGroup = g; } },
  },
  computed: {
    company() { return state.company; },
    unread() { return state.notifs.filter(n => !n.read).length; },
    menu() {
      return MENU.map(g => {
        const allowed = g.items.filter(i => i.sep || ((i.roles === null || hasRole(...i.roles)) && !(i.cost && !canSeeCost())));
        // drop sub-headings with nothing under them
        const items = allowed.filter((i, n) => !i.sep || (allowed[n + 1] && !allowed[n + 1].sep));
        return { ...g, items };
      }).filter(g => g.items.some(i => !i.sep));
    },
    // users with more than one dashboard (set by the administrator) get a Dashboards menu instead of the single link
    dashMenu() {
      const ks = userDashboards();
      return ks.length > 1 ? { g: 'Dashboards', icon: 'layout-dashboard', items: ks.map(k => ({ to: DASHBOARDS[k].route || 'dashboard/' + k, t: DASHBOARDS[k].title })) } : null;
    },
    fullMenu() { return this.dashMenu ? [this.dashMenu, ...this.menu] : this.menu; },
    // approvers get a one-tap inbox of everything waiting for their decision
    hasApprovals() { return !!state.profile && myQueues().length > 0; },
    activeGroup() { return this.fullMenu.find(g => g.items.some(i => !i.sep && this.active(i.to)))?.g || null; },
    view() {
      const [a, b, c] = route.parts;
      if (a === 'd' && DOCS[b]) return c ? { comp: 'DocEditor', props: { cfg: DOCS[b], id: c }, title: DOCS[b].title } : { comp: 'DocList', props: { cfg: DOCS[b] }, title: DOCS[b].title };
      if (a === 'm' && MASTERS[b]) return { comp: 'MasterPage', props: { cfg: MASTERS[b] }, title: MASTERS[b].title };
      if (a === 'r') return { comp: 'Reports', props: { rkey: b || 'stock' }, title: b === 'ledger' ? 'Stock ledger / item card' : (REPORTS[b || 'stock']?.title || 'Reports') };
      if (a === 'import') return { comp: 'Importer', props: { tkey: b || 'items' }, title: 'Excel import' };
      if (a === 'count' && b) return { comp: 'CountSheet', props: { id: b }, title: 'Stock count' };
      if (a === 'labels') return { comp: 'Labels', props: { mode: b || 'lots', ref_id: c }, title: 'Labels & QR codes' };
      if (a === 'assets') return { comp: 'Assets', props: { tag: b || null }, title: 'Tool crib & assets' };
      if (a === 'floor') return { comp: 'StageBoard', props: { woId: b || null }, title: 'Stage board' };
      if (a === 'qc') return { comp: 'QcApprovals', props: {}, title: 'QC approvals' };
      if (a === 'schedule') return { comp: 'FactorySchedule', props: {}, title: 'Factory schedule' };
      if (a === 'plan') return { comp: 'ProductionPlanner', props: { projectId: b || null, lineId: c || null }, title: 'Production orders' };
      if (a === 'mrp') return { comp: 'Mrp', props: { projectId: b || null }, title: 'Material planning (MRP)' };
      if (a === 'attendance') return { comp: 'AttendanceSheet', props: {}, title: 'Attendance & overtime' };
      // project billing on its own for the warehouse (no accounting tabs)
      if (a === 'billable') return { comp: 'Books', props: { tab: 'billing', arg: null, only: true }, title: 'Billable now (projects)' };
      if (a === 'books') return { comp: 'Books', props: { tab: b || 'tb', arg: c || null }, title: 'Books of account' };
      // site supervisors land on the phone-friendly site app
      if (a === 'site' || (a === 'dashboard' && !b && homeDashboard() === 'site')) return { comp: 'SiteApp', props: {}, title: 'Site' };
      if (a === 'floorapp' || (a === 'dashboard' && !b && homeDashboard() === 'floor')) return { comp: 'FloorApp', props: {}, title: 'Floor' };
      if (a === 'approvals' || (a === 'dashboard' && !b && homeDashboard() === 'approvals')) return { comp: 'ApprovalsApp', props: {}, title: 'Approvals' };
      if (a === 'pettycash') return { comp: 'PettyCash', props: {}, title: 'Petty cash' };
      if (a === 'provisions') return { comp: 'Provisions', props: {}, title: 'Provisions & accruals' };
      if (a === 'cashforecast') return { comp: 'CashForecast', props: {}, title: 'Cash position & forecast' };
      if (a === 'machinerates') return { comp: 'MachineRates', props: {}, title: 'Machine-rate calculator' };
      if (a === 'receiveapp' || (a === 'dashboard' && !b && homeDashboard() === 'receiving')) return { comp: 'ReceiveApp', props: {}, title: 'Receive goods' };
      if (a === 'countapp' || (a === 'dashboard' && !b && homeDashboard() === 'counting')) return { comp: 'CountApp', props: { id: a === 'countapp' ? b || null : null }, title: 'Stock count' };
      if (a === 'dashboard') return { comp: 'Dashboard', props: { kind: b || null }, title: 'Dashboard' };
      const simple = { replenish: ['Replenishment', 'Replenishment'], buffers: ['BufferReview', 'Buffer review'], consolidate: ['ConsolidatePR', 'Consolidate requisitions'], holds: ['Holds', 'Quarantine & exceptions'], assets: ['Assets', 'Tool crib & assets'], users: ['Users', 'Users & roles'], settings: ['Settings', 'Settings'], signature: ['MySignature', 'My signature'] };
      if (simple[a]) return { comp: simple[a][0], props: {}, title: simple[a][1] };
      return { comp: 'Dashboard', props: {}, title: 'Dashboard' };
    },
    viewKey() { return route.path; },
  },
  methods: {
    hasRole, canSeeCost, dtm,
    async openNotif(n) { this.bellOpen = false; await run(() => markRead([n.id])); if (n.link) go(n.link); },
    async readAll() { await run(() => markRead(state.notifs.map(n => n.id))); },
    active(to) { return route.path === to || route.path.startsWith(to + '/') || (to.startsWith('import') && route.parts[0] === 'import') || (to.startsWith('labels') && route.parts[0] === 'labels')
        || (to === 'd/cnt' && route.parts[0] === 'count'); },
    nav(to) { go(to); this.sideOpen = false; },
    toggle(g) {
      this.openGroup = this.openGroup === g ? null : g;
      try { localStorage.setItem(OPEN_KEY, this.openGroup || ''); } catch { /* storage unavailable */ }
    },
    async onScan(code) {
      this.scanning = false;
      const r = await run(() => describeCode(code));
      if (r) this.scanResult = r;
    },
    scanGo(to) { this.scanResult = null; go(to); },
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
          await loadRefs(['items', 'locations', 'projects', 'vendors', 'cost_centers', 'uoms', 'profiles', 'lookups']);
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
    // a push while the app is open: offer a reload (not forced, so unsaved work is not lost)
    async checkVersion() {
      if (!BUILD || this.newVersion) return;
      try {
        const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
        if (r.ok && (await r.json()).v !== BUILD) this.newVersion = true;
      } catch { /* offline: try again later */ }
    },
    reload() { location.reload(); },
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
    setInterval(() => this.checkVersion(), 300000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.checkVersion(); });
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
      <div class="logo"><Logo :size="58" /><div>CitiCore<small>{{ company?.company_name }}</small></div></div>
      <a v-if="!dashMenu" class="home" href="#/dashboard" :class="{on: active('dashboard')}" @click="sideOpen=false"><Icon name="layout-dashboard" />Dashboard</a>
      <a v-if="hasApprovals" class="home" href="#/approvals" :class="{on: active('approvals')}" @click="sideOpen=false"><Icon name="checkbox" />My approvals</a>
      <div v-for="g in fullMenu" :key="g.g" class="mgrp" :class="{open: openGroup === g.g}">
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
      <div class="foot">CitiCore · {{ ROLES[state.profile.role] }}</div>
    </nav>
    <div class="main">
      <div class="top">
        <button class="btn sm menu-btn" @click="sideOpen=!sideOpen" aria-label="Menu"><Icon name="menu-2" :size="17" /></button>
        <div class="title">{{ view.title }}</div>
        <div class="bell">
          <button class="btn sm" @click="scanning = true" title="Scan a label" aria-label="Scan">📷<span class="hide-sm"> Scan</span></button>
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
        <div class="who" style="margin-left:0"><span>{{ state.profile.full_name || state.profile.email }} · <b>{{ ROLES[state.profile.role] }}</b></span><button class="btn sm" @click="nav('signature')" title="Store your signature for printed documents">✍<span class="hide-sm"> My signature</span></button><button class="btn sm" @click="logout">Sign out</button></div>
      </div>
      <div class="content"><component :is="view.comp" v-bind="view.props" :key="viewKey" /></div>
    </div>
  </div>
  <Modal v-if="dialog.open" :title="dialog.title" small @close="dlgCancel">
    <p v-if="dialog.message" style="margin-top:0;white-space:pre-line">{{ dialog.message }}</p>
    <div class="grid" style="grid-template-columns:1fr" v-if="dialog.fields.length"><FieldInput v-for="f in dialog.fields" :key="f.k" :f="f" :doc="dialog.values" /></div>
    <template #footer><button class="btn" @click="dlgCancel">Cancel</button><button class="btn" :class="dialog.danger ? 'bad' : 'primary'" @click="dlgOk">{{ dialog.okText }}</button></template>
  </Modal>
  <Scanner v-if="scanning" @code="onScan" @close="scanning = false" />
  <Modal v-if="scanResult" :title="scanResult.title" small @close="scanResult = null">
    <div v-for="l in scanResult.lines" style="padding:3px 0">{{ l }}</div>
    <template #footer>
      <button class="btn" v-if="scanResult.kind === 'asset'" @click="scanGo('assets/' + scanResult.asset_tag)">Open in tool crib</button>
      <button class="btn" v-if="scanResult.item_id" @click="scanGo('r/lots')">Stock by lot</button>
      <template v-if="scanResult.kind === 'wo'">
        <button class="btn" @click="scanGo('d/wo/' + scanResult.wo_id)">Open order</button>
        <button class="btn primary" @click="scanGo('floor/' + scanResult.wo_id)">Log stages</button>
      </template>
      <button class="btn primary" @click="scanResult = null">Close</button>
    </template>
  </Modal>
  <PdfPanel />
  <div v-if="newVersion" class="update-bar" role="status">A new version of CitiCore is ready. Save your work, then <button class="btn sm primary" @click="reload">Reload</button></div>
  <div class="toasts"><div v-for="t in state.toasts" :key="t.id" class="toast" :class="t.type">{{ t.msg }}</div></div>`,
};

document.title = CONFIG.appName;
const vm = createApp(App);
vm.config.errorHandler = (err, inst, info) => { console.error('[vue]', info, err); toast(errMsg(err), 'error'); };
vm.mount('#app');
if (location.hostname === 'localhost') window.__ims = { state, go };   // local debugging only
