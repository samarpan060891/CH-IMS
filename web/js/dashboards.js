// Role dashboards: every user lands on the dashboard of their role; the administrator can open all of them
// (Dashboards menu). A dashboard is a list of sections; data is loaded only for the sections shown.
import { sb, state, must, run, hasRole, canSeeCost, go, loadRefs, money, qty, aed, dt, label, num, today } from './lib.js';
import { DataTable, Badge } from './components.js';

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
  management: { title: 'Management', roles: ['factory_manager'], sections: ['pending', 'projects', 'mgmtKpis', 'production', 'budgets', 'stockCharts'] },
  finance:    { title: 'Finance', roles: ['finance'], sections: ['pending', 'finKpis', 'billing', 'payables', 'budgets'] },
  purchase:   { title: 'Purchase', roles: ['purchase'], sections: ['pending', 'purKpis', 'poLate', 'zoneChart', 'payables'] },
  stores:     { title: 'Stores', roles: ['stores'], sections: ['pending', 'stockKpis', 'expiring', 'stockCharts', 'valuation'] },
  production: { title: 'Production', roles: ['production_incharge', 'shop_floor'], sections: ['pending', 'prodKpis', 'woLate', 'wcLoad', 'projects'] },
  hr:         { title: 'HR', roles: ['hr_officer'], sections: ['pending', 'hrKpis', 'docExpiry', 'onLeave'] },
  site:       { title: 'Site', roles: ['site_supervisor'], route: 'site' },
};
export const dashboardFor = role => Object.keys(DASHBOARDS).find(k => DASHBOARDS[k].roles.includes(role)) || 'management';

export const Dashboard = {
  components: { DataTable, Badge },
  props: { kind: String },
  data: () => ({ loading: true, d: {}, myPending: [], charts: [] }),
  computed: {
    isAdmin: () => state.profile?.role === 'admin',
    // non-admins always get their own dashboard, whatever the address says
    k() { const own = dashboardFor(state.profile?.role); return this.isAdmin ? (DASHBOARDS[this.kind] && !DASHBOARDS[this.kind].route ? this.kind : 'management') : own; },
    cfg() { return DASHBOARDS[this.k]; },
    viewRole() { return this.isAdmin ? this.cfg.roles[0] : state.profile?.role; },
    cost() { return canSeeCost(); },
    stock() { return this.d.stock || []; },
    stockValue() { return (this.d.val || []).filter(v => v.kind === 'STOCK').reduce((s, v) => s + num(v.value), 0); },
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
  },
  watch: { kind() { this.load(); } },
  async mounted() { await this.load(); },
  beforeUnmount() { this.charts.forEach(c => c && c.destroy()); },
  methods: {
    money, aed, qty, label, dt,
    has(s) { return (this.cfg.sections || []).includes(s); },
    any(...s) { return s.some(x => this.has(x)); },
    is(...roles) { return roles.includes(this.viewRole); },
    async load() {
      this.loading = true; this.d = {};
      await run(async () => {
        const d = {}, jobs = [];
        const get = (key, q) => jobs.push(q.then(r => { d[key] = must(r); }));
        if (this.any('mgmtKpis', 'stockKpis', 'purKpis', 'stockCharts', 'zoneChart'))
          get('stock', sb.from('v_item_stock').select('item_id,code,name,class_code,stock_status,buffer_zone,stock_value,on_hand,available,suggested_order_qty,uom').eq('is_active', true));
        if (this.cost && this.any('mgmtKpis', 'stockKpis', 'stockCharts', 'valuation')) { get('val', sb.from('v_valuation_by_category').select('*')); get('aging', sb.from('v_aging_summary').select('*')); }
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
        if (this.any('wcLoad', 'prodKpis')) get('wc', sb.from('v_work_center_load').select('*').order('sort_order'));
        if (this.any('purKpis', 'poLate'))
          get('pos', sb.from('purchase_orders').select('id,po_no,po_date,delivery_date,status,total_aed,vendors(name),projects(code)').not('status', 'in', '(CLOSED,CANCELLED,RECEIVED,REJECTED)').order('delivery_date', { nullsFirst: false }));
        if (this.has('expiring')) get('expiring', sb.from('v_lot_values').select('item_code,item_name,location_code,lot_no,batch_no,expiry_date,qty_on_hand,uom').not('expiry_date', 'is', null)
          .lte('expiry_date', new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10)).gt('qty_on_hand', 0).order('expiry_date'));
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
      }
      if (this.is('finance')) {
        add(must(await q('purchase_orders', 'id,po_no,status,created_at').eq('status', 'PENDING_FINANCE')), 'Purchase order', 'po', 'po_no');
        add(must(await q('scrap_disposals', 'id,disposal_no,status,created_at').eq('status', 'PENDING_FINANCE')), 'Scrap disposal (confirm rate)', 'disposal', 'disposal_no');
        add(must(await q('stock_releases', 'id,release_no,status,created_at').eq('status', 'PENDING_FINANCE')), 'Project stock release (final approval)', 'rel', 'release_no');
        add(must(await q('payroll_runs', 'id,run_no,status,created_at').eq('status', 'SUBMITTED')), 'Payroll to approve', 'payroll', 'run_no');
        add(must(await q('employee_advances', 'id,adv_no,status,created_at').eq('status', 'DRAFT')), 'Salary advance to approve', 'adv', 'adv_no');
        add(must(await q('sales_invoices', 'id,inv_no,status,created_at').eq('status', 'SUBMITTED')), 'Claim awaiting payment certificate', 'si', 'inv_no');
        add(must(await q('sales_invoices', 'id,inv_no,status,created_at').eq('status', 'CERTIFIED')), 'Certified claim to invoice', 'si', 'inv_no');
        add(must(await q('customer_receipts', 'id,receipt_no,status,created_at').eq('status', 'POSTED').in('mode', ['CHEQUE', 'PDC']).lte('cheque_date', today())), 'Cheque due — deposit / clear', 'rcv', 'receipt_no');
      }
      if (this.is('purchase')) add(must(await q('purchase_orders', 'id,po_no,status,created_at').in('status', ['PENDING_TOP_MGMT', 'APPROVED'])), 'Purchase order (top mgmt / release)', 'po', 'po_no');
      if (this.is('production_incharge')) {
        add(must(await q('material_requests', 'id,mr_no,status,created_at').eq('status', 'PENDING_APPROVAL')), 'Material request', 'mr', 'mr_no');
        add(must(await q('production_orders', 'id,wo_no,status,created_at').eq('status', 'DRAFT')), 'Production order to release', 'wo', 'wo_no');
        add(must(await q('snags', 'id,snag_no,status,created_at').eq('status', 'FIXED')), 'Snag fixed — verify', 'snag', 'snag_no');
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
      <span class="muted small" v-if="isAdmin">· showing approvals of the {{ label(viewRole) }} role</span>
      <span class="spacer"></span><button class="btn sm" @click="load">⟳ Refresh</button>
    </div>

    <div class="card" v-if="has('pending') && myPending.length">
      <h3>Waiting for {{ isAdmin ? label(viewRole) : 'your action' }} ({{ myPending.length }})</h3>
      <DataTable :columns="[{k:'type',label:'Document'},{k:'no',label:'No.'},{k:'date',label:'Created',fmt:'datetime'},{k:'status',label:'Status',fmt:'badge'}]" :rows="myPending" clickable @row="open" :searchable="false" />
    </div>

    <!-- finance -->
    <div class="kpis" v-if="has('finKpis')">
      <div class="kpi"><div class="l">Bank balance</div><div class="v">{{ aed(fin.bank) }}</div><div class="s">cash {{ aed(fin.cash) }} · cheques in hand {{ aed(fin.pdc) }}</div></div>
      <div class="kpi" :class="{warn: ar.over > 0}"><div class="l">Receivables</div><div class="v">{{ aed(ar.bal) }}</div><div class="s">overdue {{ aed(ar.over) }}</div></div>
      <div class="kpi" :class="{warn: overduePay > 0}"><div class="l">Net payables</div><div class="v">{{ aed(netPayable) }}</div><div class="s">overdue {{ aed(overduePay) }}</div></div>
      <div class="kpi"><div class="l">Revenue this month</div><div class="v">{{ aed(fin.revM) }}</div><div class="s">year to date {{ aed(fin.revY) }}</div></div>
      <div class="kpi" :class="{bad: fin.profitY < 0}"><div class="l">Profit year to date</div><div class="v">{{ aed(fin.profitY) }}</div><div class="s">per ledger</div></div>
      <div class="kpi"><div class="l">VAT payable (net)</div><div class="v">{{ aed(fin.vat) }}</div><div class="s">output − input to date</div></div>
      <div class="kpi"><div class="l">Unbilled work</div><div class="v">{{ aed(unbilled) }}</div><div class="s">retention held {{ aed(retention) }}</div></div>
    </div>
    <div class="card" v-if="has('billing') && (d.billing || []).length">
      <h3>Project billing</h3>
      <DataTable :searchable="false" :rows="d.billing" clickable @row="r => go('d/si/new/project/' + r.project_id)" :columns="[{k:'project_code',label:'Project'},{k:'customer_name',label:'Customer'},
        {k:'contract_value',label:'Contract',fmt:'money',sum:true},{k:'billed_pct',label:'Billed %',n:true},{k: r => Math.max(Number(r.earned_value) - Number(r.certified_to_date), 0), label:'Unbilled work', fmt:'money', sum:true},
        {k:'retention_held',label:'Retention held',fmt:'money',sum:true},{k:'outstanding',label:'Outstanding',fmt:'money',sum:true}]" />
    </div>

    <!-- management -->
    <div class="kpis" v-if="has('mgmtKpis')">
      <div class="kpi" v-if="cost"><div class="l">Inventory value</div><div class="v">{{ aed(stockValue) }}</div><div class="s">assets at cost {{ aed(assetValue) }}</div></div>
      <div class="kpi bad"><div class="l">Stock-outs</div><div class="v">{{ stockOuts }}</div><div class="s">buffer in red: {{ redZone }}</div></div>
      <div class="kpi" v-if="cost"><div class="l">Overstock / non-moving</div><div class="v">{{ aed(overstockVal) }}</div><div class="s">older than 90 days {{ aed(over90) }}</div></div>
      <div class="kpi" v-if="(d.pay || []).length"><div class="l">Net payables</div><div class="v">{{ aed(netPayable) }}</div><div class="s">overdue {{ aed(overduePay) }}</div></div>
      <div class="kpi" v-if="d.ar"><div class="l">Receivables</div><div class="v">{{ aed(ar.bal) }}</div><div class="s">overdue {{ aed(ar.over) }}</div></div>
      <div class="kpi" :class="{bad: toolsOverdue}"><div class="l">Tools overdue for return</div><div class="v">{{ toolsOverdue }}</div><div class="s">calibration due: {{ calibDue }}</div></div>
    </div>

    <!-- purchase -->
    <div class="kpis" v-if="has('purKpis')">
      <div class="kpi bad"><div class="l">Stock-outs</div><div class="v">{{ stockOuts }}</div></div>
      <div class="kpi warn"><div class="l">Buffer in RED</div><div class="v">{{ redZone }}</div><div class="s">order urgently</div></div>
      <div class="kpi"><div class="l">Items to order</div><div class="v">{{ toOrder }}</div><div class="s"><a href="#/replenish">replenishment →</a></div></div>
      <div class="kpi"><div class="l">Open POs</div><div class="v">{{ (d.pos || []).length }}</div><div class="s">awaiting approval {{ (d.pos || []).filter(p => p.status.startsWith('PENDING')).length }}</div></div>
      <div class="kpi" :class="{bad: (d.pos || []).some(p => p.delivery_date && p.delivery_date < today() && ['RELEASED','PARTIALLY_RECEIVED'].includes(p.status))}"><div class="l">Late deliveries</div>
        <div class="v">{{ (d.pos || []).filter(p => p.delivery_date && p.delivery_date < today() && ['RELEASED','PARTIALLY_RECEIVED'].includes(p.status)).length }}</div><div class="s">past PO delivery date</div></div>
    </div>
    <div class="card" v-if="has('poLate')">
      <h3>Open purchase orders by delivery date</h3>
      <DataTable :rows="d.pos || []" :loading="loading" clickable @row="r => go('d/po/' + r.id)" :columns="[{k:'po_no',label:'PO'},{k: r => r.vendors?.name, label:'Vendor'},{k: r => r.projects?.code || 'Stock', label:'For'},
        {k:'delivery_date',label:'Delivery',fmt:'date'},{k: r => r.delivery_date && r.delivery_date < today() && ['RELEASED','PARTIALLY_RECEIVED'].includes(r.status) ? 'OVERDUE' : '', label:'', fmt:'badge'},
        {k:'total_aed',label:'Value AED',fmt:'money',cost:true},{k:'status',label:'Status',fmt:'badge'}]" />
    </div>

    <!-- stores -->
    <div class="kpis" v-if="has('stockKpis')">
      <div class="kpi" v-if="cost"><div class="l">Inventory value (stock)</div><div class="v">{{ aed(stockValue) }}</div><div class="s">FIFO / weighted average</div></div>
      <div class="kpi bad"><div class="l">Stock-outs</div><div class="v">{{ stockOuts }}</div><div class="s">items with zero available</div></div>
      <div class="kpi warn"><div class="l">Buffer in RED</div><div class="v">{{ redZone }}</div><div class="s">order urgently</div></div>
      <div class="kpi" v-if="cost"><div class="l">Stock older than 90 days</div><div class="v">{{ aed(over90) }}</div></div>
      <div class="kpi" :class="{warn: (d.expiring || []).length}"><div class="l">Lots expiring ≤ 60 days</div><div class="v">{{ (d.expiring || []).length }}</div></div>
      <div class="kpi" :class="{bad: toolsOverdue}"><div class="l">Tools overdue for return</div><div class="v">{{ toolsOverdue }}</div><div class="s">calibration due: {{ calibDue }}</div></div>
    </div>
    <div class="card" v-if="has('expiring') && (d.expiring || []).length">
      <h3>Expiring within 60 days</h3>
      <DataTable :searchable="false" :rows="d.expiring" :columns="[{k:'item_code',label:'Item'},{k:'item_name',label:'Description'},{k:'location_code',label:'Location'},{k:'lot_no',label:'Lot'},{k:'batch_no',label:'Batch'},
        {k:'expiry_date',label:'Expiry',fmt:'date'},{k:'qty_on_hand',label:'Qty',fmt:'qty'},{k:'uom',label:'UoM'}]" />
    </div>

    <!-- production -->
    <div class="kpis" v-if="has('prodKpis') || has('production')">
      <div class="kpi"><div class="l">Open production orders</div><div class="v">{{ wos.length }}</div></div>
      <div class="kpi" :class="{bad: woLate.length}"><div class="l">Late orders</div><div class="v">{{ woLate.length }}</div><div class="s">past due date</div></div>
      <div class="kpi"><div class="l">Stages running</div><div class="v">{{ count('stagesRunning') }}</div><div class="s"><a href="#/floor">stage board →</a></div></div>
      <div class="kpi" :class="{warn: count('qc')}"><div class="l">QC rejects awaiting FM</div><div class="v">{{ count('qc') }}</div></div>
      <div class="kpi" v-if="has('prodKpis')" :class="{bad: (d.wc || []).some(w => w.is_down)}"><div class="l">Machines down</div><div class="v">{{ (d.wc || []).filter(w => w.is_down).length }}</div></div>
    </div>
    <div class="card" v-if="has('woLate')">
      <h3>Open production orders by due date</h3>
      <DataTable :rows="wos" :loading="loading" clickable @row="r => go('d/wo/' + r.id)" :columns="[{k:'wo_no',label:'Order'},{k:'description',label:'Description'},{k: r => r.projects?.code || 'MTS', label:'Project'},
        {k: r => qty(r.qty_completed) + ' / ' + qty(r.qty), label:'Done / qty'},{k:'due_date',label:'Due',fmt:'date'},{k: r => r.due_date && r.due_date < today() ? 'OVERDUE' : '', label:'', fmt:'badge'},
        {k:'priority',label:'Priority',fmt:'label'},{k:'status',label:'Status',fmt:'badge'}]" />
    </div>
    <div class="card" v-if="has('wcLoad') && (d.wc || []).length">
      <h3>Work centre load</h3>
      <DataTable :searchable="false" :rows="d.wc" :columns="[{k:'code',label:'Code'},{k:'name',label:'Work centre'},{k:'open_stages',label:'Open stages',n:true},{k:'running',label:'Running',n:true},
        {k:'remaining_hours',label:'Hours queued',fmt:'qty'},{k:'load_days',label:'Load (days)',fmt:'qty'},{k:'availability_pct_30d',label:'Availability 30d %',n:true},{k: r => r.is_down ? 'DOWN' : 'RUNNING', label:'Now', fmt:'badge'}]" />
    </div>

    <!-- HR -->
    <div class="kpis" v-if="has('hrKpis')">
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
    <div class="card" v-if="has('docExpiry') && (d.docs || []).length">
      <h3>Employee documents expiring</h3>
      <DataTable :searchable="false" :rows="d.docs" clickable @row="r => go('d/emp/' + r.employee_id)" :columns="[{k:'emp_code',label:'Code'},{k:'name',label:'Employee'},{k:'doc_type',label:'Document',fmt:'label'},
        {k:'doc_no',label:'No.'},{k:'expiry_date',label:'Expiry',fmt:'date'},{k:'days_left',label:'Days left',n:true},{k:'expiry_status',label:'Status',fmt:'badge'}]" />
    </div>
    <div class="card" v-if="has('onLeave') && (d.leaves || []).length">
      <h3>Current & upcoming leave</h3>
      <DataTable :searchable="false" :rows="d.leaves" clickable @row="r => go('d/leave/' + r.id)" :columns="[{k: r => r.employees ? r.employees.name + ' (' + r.employees.emp_code + ')' : '', label:'Employee'},
        {k:'leave_type',label:'Type',fmt:'label'},{k:'from_date',label:'From',fmt:'date'},{k:'to_date',label:'To',fmt:'date'},{k:'days',label:'Days',n:true},{k:'status',label:'Status',fmt:'badge'}]" />
    </div>

    <!-- shared sections -->
    <div class="card" v-if="has('projects') && (d.projects || []).length">
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
    <div class="card" v-if="has('payables') && (d.pay || []).some(p => Number(p.net_payable_aed))">
      <h3>Payables by vendor</h3>
      <DataTable :searchable="false" :rows="(d.pay || []).filter(p => Number(p.net_payable_aed))" :columns="[{k:'name',label:'Vendor'},{k:'payment_term',label:'Terms'},{k:'not_due_aed',label:'Not due',fmt:'money',sum:true},
        {k: r => Number(r.overdue_1_30_aed) + Number(r.overdue_31_60_aed) + Number(r.overdue_61_90_aed) + Number(r.overdue_90_plus_aed), label:'Overdue', fmt:'money', sum:true},
        {k:'pdc_not_matured_aed',label:'PDC not matured',fmt:'money',sum:true},{k:'net_payable_aed',label:'Net payable',fmt:'money',sum:true}]" />
    </div>
    <div class="card" v-if="has('budgets') && (d.budgets || []).length">
      <h3>Projects near or over material budget ({{ d.budgets.length }})</h3>
      <DataTable :searchable="false" :rows="d.budgets" :columns="[{k:'code',label:'Project'},{k:'name',label:'Name'},{k:'budget_material',label:'Budget AED',fmt:'money'},{k:'net_consumption',label:'Consumed AED',fmt:'money'},{k:'pct',label:'% used',n:true},{k:r=>r.pct>=100?'OVER':'WARNING',label:'Status',fmt:'badge'}]" />
    </div>
    <div class="charts" v-if="has('stockCharts') || has('zoneChart')">
      <div class="card" v-if="has('stockCharts') && cost"><h3>Inventory valuation by class (AED)</h3><div class="chart-box"><canvas ref="cVal"></canvas></div></div>
      <div class="card" v-if="has('stockCharts') && cost"><h3>Inventory aging by class (AED)</h3><div class="chart-box"><canvas ref="cAge"></canvas></div></div>
      <div class="card"><h3>TOC buffer zones (items with a buffer)</h3><div class="chart-box"><canvas ref="cZone"></canvas></div></div>
      <div class="card" v-if="has('stockCharts')"><h3>Stock status (items)</h3><div class="chart-box"><canvas ref="cStatus"></canvas></div></div>
    </div>
    <div class="card" v-if="has('valuation') && cost">
      <h3>Valuation by category</h3>
      <DataTable :columns="[{k:'kind',label:'Kind',fmt:'label'},{k:'class_name',label:'Class'},{k:'category_name',label:'Category'},{k:'items',label:'Items',n:true},{k:'qty',label:'Qty',fmt:'qty'},{k:'value',label:'Value AED',fmt:'money',sum:true}]" :rows="d.val || []" filename="valuation_by_category" />
    </div>
  </div>`,
  setup() { return { go, today }; },
};
