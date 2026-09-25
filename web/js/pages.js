// Dashboard, reports, replenishment, tool crib / assets, users, settings
import { sb, state, must, run, rpc, hasRole, canSeeCost, go, loadRefs, loadRef, refRow, refLabel, money, qty, aed, dt, label, num, today, toast, ROLES, loadCompany, refreshPending } from './lib.js';
import { DataTable, Modal, FieldInput, RefSelect, Badge, ask } from './components.js';

const PALETTE = ['#8a5a2b', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#dc2626', '#475569', '#a16207'];
const ZONE_COLORS = { BLACK: '#111827', RED: '#dc2626', YELLOW: '#eab308', GREEN: '#16a34a', BLUE: '#2563eb' };
const AGE_ORDER = ['0-30', '31-60', '61-90', '91-180', '181-365', '365+'];

function chart(el, cfg) {
  if (!el || !window.Chart) return null;
  return new window.Chart(el, { ...cfg, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } }, ...(cfg.options || {}) } });
}

// ======================================================================
// DASHBOARD
// ======================================================================
export const Dashboard = {
  components: { DataTable, Badge },
  data: () => ({ loading: true, val: [], aging: [], stock: [], pay: [], assets: [], myPending: [], charts: [] }),
  computed: {
    cost() { return canSeeCost(); },
    stockValue() { return this.val.filter(v => v.kind === 'STOCK').reduce((s, v) => s + num(v.value), 0); },
    assetValue() { return this.val.filter(v => v.kind === 'ASSET').reduce((s, v) => s + num(v.value), 0); },
    stockOuts() { return this.stock.filter(s => s.stock_status === 'STOCK_OUT').length; },
    redZone() { return this.stock.filter(s => ['RED', 'BLACK'].includes(s.buffer_zone)).length; },
    overstockVal() { return this.stock.filter(s => ['OVERSTOCK', 'NON_MOVING'].includes(s.stock_status)).reduce((a, s) => a + num(s.stock_value), 0); },
    over90() { return this.aging.filter(a => !['0-30', '31-60', '61-90'].includes(a.age_bucket)).reduce((s, a) => s + num(a.value), 0); },
    netPayable() { return this.pay.reduce((s, p) => s + num(p.net_payable_aed), 0); },
    overduePay() { return this.pay.reduce((s, p) => s + num(p.overdue_1_30_aed) + num(p.overdue_31_60_aed) + num(p.overdue_61_90_aed) + num(p.overdue_90_plus_aed), 0); },
    toolsOverdue() { return this.assets.filter(a => a.is_overdue).length; },
    calibDue() { return this.assets.filter(a => ['OVERDUE', 'DUE_SOON'].includes(a.calibration_status)).length; },
  },
  async mounted() { await this.load(); },
  beforeUnmount() { this.charts.forEach(c => c && c.destroy()); },
  methods: {
    money, aed, qty, label,
    async load() {
      await run(async () => {
        const q = [
          sb.from('v_valuation_by_category').select('*'),
          sb.from('v_aging_summary').select('*'),
          sb.from('v_item_stock').select('item_id,code,name,class_code,stock_status,buffer_zone,stock_value,on_hand,available,suggested_order_qty,uom').eq('is_active', true),
          sb.from('v_asset_register').select('id,is_overdue,calibration_status'),
        ];
        const [v, a, s, as] = await Promise.all(q);
        this.val = must(v); this.aging = must(a); this.stock = must(s); this.assets = must(as);
        if (hasRole('finance', 'factory_manager', 'purchase')) this.pay = must(await sb.from('v_vendor_payables').select('*'));
        await this.loadPending();
      });
      this.loading = false;
      this.$nextTick(() => this.draw());
    },
    async loadPending() {
      const out = [];
      const add = (rows, type, key, no) => rows.forEach(r => out.push({ type, no: r[no], date: r.created_at, status: r.status, link: `d/${key}/${r.id}` }));
      if (hasRole('factory_manager')) {
        add(must(await sb.from('purchase_orders').select('id,po_no,status,created_at').eq('status', 'PENDING_FM')), 'Purchase order', 'po', 'po_no');
        add(must(await sb.from('stock_adjustments').select('id,adj_no,status,created_at').eq('status', 'PENDING_APPROVAL')), 'Stock adjustment', 'adj', 'adj_no');
        add(must(await sb.from('scrap_notes').select('id,scrap_no,status,created_at').eq('status', 'PENDING_APPROVAL')), 'Scrap note', 'scrap', 'scrap_no');
        add(must(await sb.from('scrap_disposals').select('id,disposal_no,status,created_at').eq('status', 'PENDING_APPROVAL')), 'Scrap disposal', 'disposal', 'disposal_no');
      }
      if (hasRole('finance')) {
        add(must(await sb.from('purchase_orders').select('id,po_no,status,created_at').eq('status', 'PENDING_FINANCE')), 'Purchase order', 'po', 'po_no');
        add(must(await sb.from('scrap_disposals').select('id,disposal_no,status,created_at').eq('status', 'PENDING_FINANCE')), 'Scrap disposal (confirm rate)', 'disposal', 'disposal_no');
      }
      if (hasRole('purchase')) add(must(await sb.from('purchase_orders').select('id,po_no,status,created_at').in('status', ['PENDING_TOP_MGMT', 'APPROVED'])), 'Purchase order (top mgmt / release)', 'po', 'po_no');
      if (hasRole('production_incharge')) add(must(await sb.from('material_requests').select('id,mr_no,status,created_at').eq('status', 'PENDING_APPROVAL')), 'Material request', 'mr', 'mr_no');
      if (hasRole('stores')) add(must(await sb.from('material_requests').select('id,mr_no,status,created_at').in('status', ['APPROVED', 'PARTIALLY_ISSUED'])), 'Material request to issue', 'mr', 'mr_no');
      this.myPending = out;
    },
    draw() {
      this.charts.forEach(c => c && c.destroy()); this.charts = [];
      const byClass = {};
      this.val.forEach(v => { byClass[v.class_name] = (byClass[v.class_name] || 0) + num(v.value); });
      if (this.cost) {
        const cls = Object.keys(byClass).sort((a, b) => byClass[b] - byClass[a]);
        this.charts.push(chart(this.$refs.cVal, { type: 'bar', data: { labels: cls, datasets: [{ label: 'AED', data: cls.map(c => byClass[c]), backgroundColor: PALETTE[0] }] },
          options: { indexAxis: 'y', plugins: { legend: { display: false } } } }));
        const classes = [...new Set(this.aging.map(a => a.class_name))];
        this.charts.push(chart(this.$refs.cAge, { type: 'bar', data: { labels: AGE_ORDER.map(b => b + ' d'),
          datasets: classes.map((c, i) => ({ label: c, backgroundColor: PALETTE[i % PALETTE.length], data: AGE_ORDER.map(b => num(this.aging.find(a => a.class_name === c && a.age_bucket === b)?.value)) })) },
          options: { scales: { x: { stacked: true }, y: { stacked: true } } } }));
      }
      const zones = ['BLACK', 'RED', 'YELLOW', 'GREEN', 'BLUE'];
      const zc = zones.map(z => this.stock.filter(s => s.buffer_zone === z).length);
      this.charts.push(chart(this.$refs.cZone, { type: 'doughnut', data: { labels: ['Stock-out', 'Red', 'Yellow', 'Green', 'Over (blue)'], datasets: [{ data: zc, backgroundColor: zones.map(z => ZONE_COLORS[z]) }] } }));
      const sts = ['STOCK_OUT', 'BELOW_SAFETY', 'REORDER', 'OK', 'OVERSTOCK', 'NON_MOVING'];
      this.charts.push(chart(this.$refs.cStatus, { type: 'bar', data: { labels: sts.map(label), datasets: [{ label: 'Items', data: sts.map(s => this.stock.filter(x => x.stock_status === s && (num(x.on_hand) > 0 || s === 'STOCK_OUT')).length), backgroundColor: ['#111827', '#dc2626', '#eab308', '#16a34a', '#2563eb', '#7c3aed'] }] },
        options: { plugins: { legend: { display: false } } } }));
    },
    open(r) { go(r.link); },
  },
  template: `<div>
    <div class="kpis">
      <div class="kpi" v-if="cost"><div class="l">Inventory value (stock)</div><div class="v">{{ aed(stockValue) }}</div><div class="s">FIFO / weighted average</div></div>
      <div class="kpi" v-if="cost"><div class="l">Assets & tools (at cost)</div><div class="v">{{ aed(assetValue) }}</div><div class="s">machines, tools, office, camp</div></div>
      <div class="kpi bad"><div class="l">Stock-outs</div><div class="v">{{ stockOuts }}</div><div class="s">items with zero available</div></div>
      <div class="kpi warn"><div class="l">Buffer in RED</div><div class="v">{{ redZone }}</div><div class="s">order urgently</div></div>
      <div class="kpi" v-if="cost"><div class="l">Overstock / non-moving</div><div class="v">{{ aed(overstockVal) }}</div></div>
      <div class="kpi" v-if="cost"><div class="l">Stock older than 90 days</div><div class="v">{{ aed(over90) }}</div></div>
      <div class="kpi" v-if="pay.length"><div class="l">Net payables</div><div class="v">{{ aed(netPayable) }}</div><div class="s">overdue {{ aed(overduePay) }}</div></div>
      <div class="kpi" :class="{bad: toolsOverdue}"><div class="l">Tools overdue for return</div><div class="v">{{ toolsOverdue }}</div><div class="s">calibration due: {{ calibDue }}</div></div>
    </div>
    <div class="card" v-if="myPending.length">
      <h3>Waiting for your action ({{ myPending.length }})</h3>
      <DataTable :columns="[{k:'type',label:'Document'},{k:'no',label:'No.'},{k:'date',label:'Created',fmt:'datetime'},{k:'status',label:'Status',fmt:'badge'}]" :rows="myPending" clickable @row="open" :searchable="false" />
    </div>
    <div class="charts">
      <div class="card" v-if="cost"><h3>Inventory valuation by class (AED)</h3><div class="chart-box"><canvas ref="cVal"></canvas></div></div>
      <div class="card" v-if="cost"><h3>Inventory aging by class (AED)</h3><div class="chart-box"><canvas ref="cAge"></canvas></div></div>
      <div class="card"><h3>TOC buffer zones (items with a buffer)</h3><div class="chart-box"><canvas ref="cZone"></canvas></div></div>
      <div class="card"><h3>Stock status (items)</h3><div class="chart-box"><canvas ref="cStatus"></canvas></div></div>
    </div>
    <div class="card" v-if="cost">
      <h3>Valuation by category</h3>
      <DataTable :columns="[{k:'kind',label:'Kind',fmt:'label'},{k:'class_name',label:'Class'},{k:'category_name',label:'Category'},{k:'items',label:'Items',n:true},{k:'qty',label:'Qty',fmt:'qty'},{k:'value',label:'Value AED',fmt:'money',sum:true}]" :rows="val" filename="valuation_by_category" />
    </div>
  </div>`,
};

// ======================================================================
// REPORTS
// ======================================================================
const Z = { k: 'buffer_zone', label: 'Zone', fmt: 'badge' };
const REPORTS = {
  stock: { title: 'Stock in hand', src: 'v_item_stock', filter: q => q.gt('on_hand', 0), columns: [
    { k: 'code', label: 'Code' }, { k: 'name', label: 'Item' }, { k: 'class_code', label: 'Class' }, { k: 'category_name', label: 'Category' }, { k: 'uom', label: 'UoM' },
    { k: 'on_hand', label: 'On hand', fmt: 'qty' }, { k: 'available', label: 'Available', fmt: 'qty' }, { k: 'on_order', label: 'On order', fmt: 'qty' }, { k: 'open_demand', label: 'Open requests', fmt: 'qty' },
    { k: 'stock_value', label: 'Value AED', fmt: 'money', cost: true, sum: true }, { k: 'avg_daily_consumption', label: 'Avg/day', fmt: 'qty' }, { k: 'stock_cover_days', label: 'Cover days', n: true },
    { k: 'last_receipt', label: 'Last receipt', fmt: 'date' }, { k: 'last_issue', label: 'Last issue', fmt: 'date' }, { k: 'stock_status', label: 'Status', fmt: 'badge' }, Z] },
  lots: { title: 'Stock by lot & location', src: 'v_lot_values', columns: [
    { k: 'item_code', label: 'Code' }, { k: 'item_name', label: 'Item' }, { k: 'class_code', label: 'Class' }, { k: 'location_code', label: 'Location' }, { k: 'lot_no', label: 'Lot' }, { k: 'batch_no', label: 'Batch' },
    { k: 'received_date', label: 'Received', fmt: 'date' }, { k: 'expiry_date', label: 'Expiry', fmt: 'date' }, { k: 'qty_on_hand', label: 'Qty', fmt: 'qty' }, { k: 'uom', label: 'UoM' },
    { k: 'value_rate', label: 'Rate', fmt: 'money', cost: true }, { k: 'value', label: 'Value', fmt: 'money', cost: true, sum: true }, { k: 'age_days', label: 'Age (days)', n: true }, { k: 'lot_status', label: 'Status', fmt: 'badge' }] },
  stockout: { title: 'Stock-out & below safety', src: 'v_item_stock', filter: q => q.in('stock_status', ['STOCK_OUT', 'BELOW_SAFETY', 'REORDER']).eq('is_active', true), columns: [
    { k: 'code', label: 'Code' }, { k: 'name', label: 'Item' }, { k: 'class_code', label: 'Class' }, { k: 'uom', label: 'UoM' }, { k: 'available', label: 'Available', fmt: 'qty' }, { k: 'safety_stock', label: 'Safety', fmt: 'qty' },
    { k: 'reorder_level', label: 'ROL', fmt: 'qty' }, { k: 'on_order', label: 'On order', fmt: 'qty' }, { k: 'open_demand', label: 'Open requests', fmt: 'qty' }, { k: 'suggested_order_qty', label: 'Suggested order', fmt: 'qty' },
    { k: 'lead_time_days', label: 'Lead days', n: true }, { k: 'stock_status', label: 'Status', fmt: 'badge' }, Z] },
  overstock: { title: 'Overstock & non-moving', src: 'v_item_stock', filter: q => q.in('stock_status', ['OVERSTOCK', 'NON_MOVING']), columns: [
    { k: 'code', label: 'Code' }, { k: 'name', label: 'Item' }, { k: 'class_code', label: 'Class' }, { k: 'uom', label: 'UoM' }, { k: 'on_hand', label: 'On hand', fmt: 'qty' },
    { k: r => num(r.max_stock) || num(r.buffer_target) || null, label: 'Max / target', fmt: 'qty' },
    { k: r => Math.max(0, num(r.on_hand) - (num(r.max_stock) || num(r.buffer_target) || Math.round(num(r.avg_daily_consumption) * num(r.overstock_months) * 30))), label: 'Excess qty', fmt: 'qty' },
    { k: 'stock_cover_days', label: 'Cover days', n: true }, { k: 'stock_value', label: 'Value AED', fmt: 'money', cost: true, sum: true }, { k: 'last_issue', label: 'Last issue', fmt: 'date' }, { k: 'stock_status', label: 'Status', fmt: 'badge' }] },
  buffer: { title: 'TOC buffer status', src: 'v_item_stock', filter: q => q.gt('buffer_target', 0), columns: [
    { k: 'code', label: 'Code' }, { k: 'name', label: 'Item' }, { k: 'uom', label: 'UoM' }, { k: 'buffer_target', label: 'Target', fmt: 'qty' }, { k: 'available', label: 'Available', fmt: 'qty' },
    { k: 'on_order', label: 'On order', fmt: 'qty' }, { k: 'open_demand', label: 'Demand', fmt: 'qty' }, { k: 'net_flow_position', label: 'Net position', fmt: 'qty' },
    { k: 'buffer_penetration_pct', label: 'Penetration %', n: true }, Z, { k: 'suggested_order_qty', label: 'Order qty', fmt: 'qty' }, { k: 'moq', label: 'MOQ', fmt: 'qty' }] },
  aging: { title: 'Inventory aging', src: 'v_lot_values', filter: q => q.neq('loc_type', 'SCRAP_YARD'), pivot: true, columns: [
    { k: 'item_code', label: 'Code' }, { k: 'item_name', label: 'Item' }, { k: 'class_name', label: 'Class' }, { k: 'category_name', label: 'Category' }, { k: 'location_code', label: 'Location' }, { k: 'lot_no', label: 'Lot' },
    { k: 'received_date', label: 'Received', fmt: 'date' }, { k: 'age_days', label: 'Age days', n: true }, { k: 'age_bucket', label: 'Bucket' }, { k: 'qty_on_hand', label: 'Qty', fmt: 'qty' }, { k: 'value', label: 'Value AED', fmt: 'money', cost: true, sum: true }] },
  abc: { title: 'ABC analysis (12-month consumption value)', src: 'v_abc_analysis', order: 'rank', cost: true, columns: [
    { k: 'rank', label: '#', n: true }, { k: 'code', label: 'Code' }, { k: 'name', label: 'Item' }, { k: 'class_code', label: 'Class' }, { k: 'uom', label: 'UoM' }, { k: 'annual_qty', label: 'Annual qty', fmt: 'qty' },
    { k: 'annual_value', label: 'Annual value AED', fmt: 'money', sum: true }, { k: 'value_pct', label: '% value', n: true }, { k: 'cumulative_pct', label: 'Cumulative %', n: true }, { k: 'abc_class', label: 'ABC', fmt: 'badge' }] },
  valuation: { title: 'Valuation by category', src: 'v_valuation_by_category', cost: true, columns: [
    { k: 'kind', label: 'Kind', fmt: 'label' }, { k: 'class_code', label: 'Class' }, { k: 'class_name', label: 'Class name' }, { k: 'category_name', label: 'Category' }, { k: 'items', label: 'Items', n: true },
    { k: 'qty', label: 'Qty', fmt: 'qty' }, { k: 'value', label: 'Value AED', fmt: 'money', sum: true }] },
  projects: { title: 'Project / MTS consumption', src: 'v_project_consumption', order: 'code', cost: true, columns: [
    { k: 'code', label: 'Code' }, { k: 'name', label: 'Project' }, { k: 'project_type', label: 'Type', fmt: 'label' }, { k: 'status', label: 'Status', fmt: 'badge' },
    { k: 'issued_value', label: 'Issued', fmt: 'money', sum: true }, { k: 'returned_value', label: 'Returned', fmt: 'money', sum: true }, { k: 'net_consumption', label: 'Net consumption', fmt: 'money', sum: true },
    { k: 'budget_material', label: 'Budget', fmt: 'money' }, { k: r => r.budget_material ? Math.round(num(r.net_consumption) / num(r.budget_material) * 1000) / 10 : null, label: '% of budget', n: true }, { k: 'last_movement', label: 'Last movement', fmt: 'date' }] },
  expiry: { title: 'Expiring stock (next 90 days)', src: 'v_lot_values', filter: q => q.not('expiry_date', 'is', null).lte('expiry_date', new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10)), order: 'expiry_date', columns: [
    { k: 'item_code', label: 'Code' }, { k: 'item_name', label: 'Item' }, { k: 'lot_no', label: 'Lot' }, { k: 'batch_no', label: 'Batch' }, { k: 'location_code', label: 'Location' },
    { k: 'expiry_date', label: 'Expiry', fmt: 'date' }, { k: 'qty_on_hand', label: 'Qty', fmt: 'qty' }, { k: 'value', label: 'Value', fmt: 'money', cost: true, sum: true }] },
  payables: { title: 'Vendor payables (net)', src: 'v_vendor_payables', order: 'name', roles: ['finance', 'factory_manager', 'purchase'], columns: [
    { k: 'code', label: 'Code' }, { k: 'name', label: 'Vendor' }, { k: 'payment_term', label: 'Terms' }, { k: 'invoiced_aed', label: 'Invoiced', fmt: 'money', sum: true }, { k: 'paid_aed', label: 'Paid', fmt: 'money', sum: true },
    { k: 'debit_notes_aed', label: 'Debit notes', fmt: 'money', sum: true }, { k: 'advances_unallocated_aed', label: 'Advances', fmt: 'money', sum: true }, { k: 'net_payable_aed', label: 'NET PAYABLE', fmt: 'money', sum: true },
    { k: 'not_due_aed', label: 'Not due', fmt: 'money', sum: true }, { k: 'overdue_1_30_aed', label: '1-30', fmt: 'money', sum: true }, { k: 'overdue_31_60_aed', label: '31-60', fmt: 'money', sum: true },
    { k: 'overdue_61_90_aed', label: '61-90', fmt: 'money', sum: true }, { k: 'overdue_90_plus_aed', label: '90+', fmt: 'money', sum: true }, { k: 'pdc_not_matured_aed', label: 'PDC not matured', fmt: 'money', sum: true }] },
  invoices: { title: 'Open invoices & due dates', src: 'v_invoice_balances', filter: q => q.gt('balance_aed', 0.005), order: 'due_date', roles: ['finance', 'factory_manager', 'purchase'], columns: [
    { k: r => refLabel('vendors', r.vendor_id), label: 'Vendor' }, { k: 'vendor_invoice_no', label: 'Invoice' }, { k: 'inv_no', label: 'Our ref' }, { k: 'invoice_date', label: 'Date', fmt: 'date' }, { k: 'due_date', label: 'Due', fmt: 'date' },
    { k: 'total_aed', label: 'Total', fmt: 'money', sum: true }, { k: 'paid_aed', label: 'Paid', fmt: 'money', sum: true }, { k: 'balance_aed', label: 'Balance', fmt: 'money', sum: true }, { k: 'days_overdue', label: 'Days overdue', n: true }, { k: 'aging_bucket', label: 'Aging', fmt: 'badge' }] },
  grni: { title: 'Goods received not invoiced', src: 'v_grn_not_invoiced', order: 'grn_date', roles: ['finance', 'factory_manager', 'purchase', 'stores'], cost: true, columns: [
    { k: 'grn_no', label: 'GRN' }, { k: 'grn_date', label: 'Date', fmt: 'date' }, { k: 'vendor_name', label: 'Vendor' }, { k: 'item_code', label: 'Item' }, { k: 'item_name', label: 'Name' },
    { k: 'accepted_qty', label: 'Received', fmt: 'qty' }, { k: 'invoiced_qty', label: 'Invoiced', fmt: 'qty' }, { k: 'pending_qty', label: 'Pending', fmt: 'qty' }, { k: 'pending_value_aed', label: 'Accrual AED', fmt: 'money', sum: true }] },
  tools: { title: 'Tools with workers / overdue', src: 'v_asset_register', filter: q => q.eq('status', 'ISSUED'), order: 'due_back', columns: [
    { k: 'asset_tag', label: 'Tag' }, { k: 'item_name', label: 'Tool' }, { k: 'serial_no', label: 'Serial' }, { k: 'custodian_name', label: 'With' }, { k: 'last_moved_at', label: 'Issued', fmt: 'datetime' },
    { k: 'due_back', label: 'Due back', fmt: 'date' }, { k: r => r.is_overdue ? 'OVERDUE' : 'OK', label: 'Status', fmt: 'badge' }] },
  calibration: { title: 'Calibration due', src: 'v_asset_register', filter: q => q.not('calibration_due_date', 'is', null), order: 'calibration_due_date', columns: [
    { k: 'asset_tag', label: 'Tag' }, { k: 'item_name', label: 'Instrument' }, { k: 'serial_no', label: 'Serial' }, { k: 'last_calibration_date', label: 'Last', fmt: 'date' }, { k: 'calibration_due_date', label: 'Due', fmt: 'date' }, { k: 'calibration_status', label: 'Status', fmt: 'badge' }] },
};

export const Reports = {
  components: { DataTable, RefSelect },
  props: { rkey: String },
  data: () => ({ rows: [], loading: false, cls: '', ledger: { item_id: null, from: '', to: today(), location_id: null } }),
  computed: {
    list() { return Object.entries(REPORTS).filter(([k, r]) => !(r.cost && !canSeeCost()) && !(r.roles && !hasRole(...r.roles))).map(([k, r]) => ({ k, t: r.title })).concat([{ k: 'ledger', t: 'Stock ledger / item card' }]); },
    rep() { return REPORTS[this.rkey]; },
    classes() { return [...new Set(this.rows.map(r => r.class_code || r.class_name).filter(Boolean))].sort(); },
    shown() { return this.cls ? this.rows.filter(r => (r.class_code || r.class_name) === this.cls) : this.rows; },
    pivot() {
      if (!this.rep?.pivot) return null;
      const cls = [...new Set(this.shown.map(r => r.class_name))].sort();
      return cls.map(c => { const o = { class_name: c }; AGE_ORDER.forEach(b => { o[b] = this.shown.filter(r => r.class_name === c && r.age_bucket === b).reduce((s, r) => s + num(canSeeCost() ? r.value : r.qty_on_hand), 0); }); o.total = AGE_ORDER.reduce((s, b) => s + o[b], 0); return o; });
    },
    pivotCols() { const f = canSeeCost() ? 'money' : 'qty'; return [{ k: 'class_name', label: 'Class' }, ...AGE_ORDER.map(b => ({ k: b, label: b + ' days', fmt: f, sum: true })), { k: 'total', label: 'Total', fmt: f, sum: true }]; },
    abcSummary() {
      if (this.rkey !== 'abc') return null;
      return ['A', 'B', 'C'].map(c => { const r = this.rows.filter(x => x.abc_class === c); return { abc: c, items: r.length, value: r.reduce((s, x) => s + num(x.annual_value), 0) }; });
    },
    ledgerCols() {
      return [{ k: 'txn_date', label: 'Date', fmt: 'date' }, { k: 'txn_type', label: 'Type', fmt: 'label' }, { k: 'doc_no', label: 'Document' }, { k: r => r.locations?.code, label: 'Loc' }, { k: r => r.stock_lots?.lot_no, label: 'Lot' },
        { k: r => r.projects?.code || r.cost_centers?.code, label: 'Project / CC' }, { k: r => num(r.qty) > 0 ? r.qty : null, label: 'In', fmt: 'qty' }, { k: r => num(r.qty) < 0 ? -r.qty : null, label: 'Out', fmt: 'qty' },
        { k: 'balance', label: 'Balance', fmt: 'qty' }, { k: 'unit_cost', label: 'Rate', fmt: 'money', cost: true }, { k: 'value', label: 'Value', fmt: 'money', cost: true }];
    },
  },
  watch: { rkey() { this.load(); } },
  async mounted() { await loadRefs(['items', 'locations', 'vendors']); this.load(); },
  methods: {
    pick(k) { go('r/' + k); },
    async load() {
      this.rows = []; this.cls = '';
      if (this.rkey === 'ledger' || !this.rep) return;
      this.loading = true;
      await run(async () => {
        let q = sb.from(this.rep.src).select('*');
        if (this.rep.filter) q = this.rep.filter(q);
        if (this.rep.order) q = q.order(this.rep.order);
        this.rows = must(await q.limit(20000));
      });
      this.loading = false;
    },
    async loadLedger() {
      const l = this.ledger;
      if (!l.item_id) return toast('Select an item', 'error');
      this.loading = true;
      await run(async () => {
        let q = sb.from('stock_ledger').select('*, locations(code), stock_lots(lot_no), projects(code), cost_centers(code)').eq('item_id', l.item_id).order('txn_date').order('id');
        if (l.location_id) q = q.eq('location_id', l.location_id);
        const all = must(await q.limit(20000));
        let bal = 0;
        all.forEach(r => { bal += num(r.qty); r.balance = bal; });
        this.rows = all.filter(r => (!l.from || r.txn_date >= l.from) && (!l.to || r.txn_date <= l.to));
      });
      this.loading = false;
    },
  },
  template: `<div>
    <div class="tabs">
      <a v-for="r in list" :href="'#/r/' + r.k" :class="{on: rkey===r.k}">{{ r.t }}</a>
    </div>
    <div v-if="rkey==='ledger'" class="card">
      <div class="grid" style="margin-bottom:12px">
        <label class="f wide">Item<RefSelect v-model="ledger.item_id" refName="items" /></label>
        <label class="f">Location (optional)<RefSelect v-model="ledger.location_id" refName="locations" /></label>
        <label class="f">From<input type="date" v-model="ledger.from"></label>
        <label class="f">To<input type="date" v-model="ledger.to"></label>
        <label class="f">&nbsp;<button class="btn primary" @click="loadLedger">Show</button></label>
      </div>
      <DataTable :columns="ledgerCols" :rows="rows" :loading="loading" filename="stock_ledger" />
    </div>
    <template v-else-if="rep">
      <div class="card" v-if="pivot">
        <h3>Aging summary by class ({{ canSeeCost() ? 'AED' : 'qty' }})</h3>
        <DataTable :columns="pivotCols" :rows="pivot" :searchable="false" />
      </div>
      <div class="card" v-if="abcSummary">
        <h3>ABC summary</h3>
        <DataTable :columns="[{k:'abc',label:'Class',fmt:'badge'},{k:'items',label:'Items',n:true},{k:'value',label:'Annual value AED',fmt:'money',sum:true}]" :rows="abcSummary" :searchable="false" />
        <div class="small muted" style="margin-top:6px">A = top {{ $root.company?.abc_a_pct ?? 70 }}% of consumption value, B = up to {{ $root.company?.abc_b_pct ?? 90 }}%, C = the rest. Thresholds are set in Settings.</div>
      </div>
      <div class="card">
        <div class="hd"><h3>{{ rep.title }}</h3><span class="spacer"></span>
          <select v-if="classes.length > 1" v-model="cls" style="max-width:200px"><option value="">All classes</option><option v-for="c in classes" :value="c">{{ c }}</option></select>
          <button class="btn sm" @click="load">↻ Refresh</button>
        </div>
        <DataTable :columns="rep.columns" :rows="shown" :loading="loading" :filename="rkey" />
      </div>
    </template>
  </div>`,
  setup() { return { canSeeCost }; },
};

// ======================================================================
// REPLENISHMENT (buffer / re-order suggestions -> PR or draft POs)
// ======================================================================
export const Replenishment = {
  components: { DataTable, RefSelect, Badge },
  data: () => ({ rows: [], loading: true, busy: false }),
  computed: { vendorsOpts() { return (state.refs.vendors || []).filter(v => v.status === 'ACTIVE'); } },
  async mounted() { await loadRefs(['items', 'vendors']); await this.load(); },
  methods: {
    qty, money, label,
    async load() {
      this.loading = true;
      await run(async () => {
        const rows = must(await sb.from('v_item_stock').select('*').gt('suggested_order_qty', 0).eq('is_active', true).order('buffer_penetration_pct', { ascending: false, nullsFirst: false }));
        const iv = rows.length ? must(await sb.from('item_vendors').select('item_id,vendor_id,price,is_preferred').in('item_id', rows.map(r => r.item_id))) : [];
        rows.forEach(r => {
          const cands = iv.filter(x => x.item_id === r.item_id).sort((a, b) => (b.is_preferred ? 1 : 0) - (a.is_preferred ? 1 : 0));
          r._sel = ['BLACK', 'RED'].includes(r.buffer_zone) || r.stock_status === 'STOCK_OUT';
          r._vendor = cands[0]?.vendor_id || null;
          r._price = cands[0]?.price ?? r.last_purchase_rate ?? 0;
          r._qty = num(r.suggested_order_qty);
        });
        this.rows = rows;
      });
      this.loading = false;
    },
    async createPR() {
      const sel = this.rows.filter(r => r._sel && r._qty > 0);
      if (!sel.length) return toast('Select at least one item', 'error');
      this.busy = true;
      const id = await run(async () => {
        const pr = must(await sb.from('purchase_requisitions').insert({ source: 'BUFFER', remarks: 'Generated from buffer / re-order suggestions' }).select().single());
        must(await sb.from('pr_lines').insert(sel.map((r, i) => ({ pr_id: pr.id, line_no: i + 1, item_id: r.item_id, qty: r._qty }))));
        return pr.id;
      }, 'Requisition created');
      this.busy = false;
      if (id) go('d/pr/' + id);
    },
    async createPOs() {
      const sel = this.rows.filter(r => r._sel && r._qty > 0);
      if (!sel.length) return toast('Select at least one item', 'error');
      if (sel.some(r => !r._vendor)) return toast('Choose a vendor for every selected item', 'error');
      this.busy = true;
      const n = await run(async () => {
        const byVendor = {};
        sel.forEach(r => (byVendor[r._vendor] ||= []).push(r));
        let count = 0;
        for (const [vid, lines] of Object.entries(byVendor)) {
          const v = refRow('vendors', vid);
          const po = must(await sb.from('purchase_orders').insert({ vendor_id: vid, currency: v.currency, payment_term_id: v.payment_term_id, po_type: v.vendor_type, terms_conditions: state.company?.po_terms_conditions || null, remarks: 'Generated from buffer / re-order suggestions' }).select().single());
          must(await sb.from('po_lines').insert(lines.map((r, i) => ({ po_id: po.id, line_no: i + 1, item_id: r.item_id, description: r.name, qty: r._qty, rate: num(r._price), vat_rate: v.vendor_type === 'IMPORT' ? 0 : num(refRow('items', r.item_id)?.vat_rate ?? 5) }))));
          count++;
        }
        return count;
      });
      this.busy = false;
      if (n) { toast(`${n} draft PO(s) created — review and submit them for approval`, 'ok'); go('d/po'); }
    },
  },
  template: `<div>
    <div class="card">
      <div class="hd"><h3>Replenishment suggestions</h3><span class="spacer"></span>
        <button class="btn" @click="load">↻ Refresh</button>
        <button class="btn" :disabled="busy" @click="createPR" v-if="$root.hasRole('stores','purchase','factory_manager','production_incharge')">Create requisition</button>
        <button class="btn primary" :disabled="busy" @click="createPOs" v-if="$root.hasRole('purchase')">Create draft POs (grouped by vendor)</button>
      </div>
      <p class="small muted" style="margin-top:0">Items in RED / YELLOW buffer zone or below re-order level. Qty tops up to the buffer target (or max stock), rounded up to MOQ and order multiple. Stock position = available + on order − open requests.</p>
      <div class="tbl-wrap">
        <table class="t lines">
          <thead><tr><th></th><th>Item</th><th>Zone</th><th class="n">Available</th><th class="n">On order</th><th class="n">Demand</th><th class="n">Target / ROL</th><th class="n">MOQ</th><th>Order qty</th><th>Vendor</th><th v-if="$root.canSeeCost()">Rate</th></tr></thead>
          <tbody>
            <tr v-if="loading"><td colspan="11" class="empty">Loading…</td></tr>
            <tr v-else-if="!rows.length"><td colspan="11" class="empty">Nothing to replenish 🎉</td></tr>
            <tr v-for="r in rows" :key="r.item_id">
              <td><input type="checkbox" v-model="r._sel"></td>
              <td>{{ r.code }} — {{ r.name }} <span class="muted small">({{ r.uom }})</span></td>
              <td><Badge :v="r.buffer_zone || r.stock_status" /></td>
              <td class="n">{{ qty(r.available) }}</td><td class="n">{{ qty(r.on_order) }}</td><td class="n">{{ qty(r.open_demand) }}</td>
              <td class="n">{{ qty(r.buffer_target || r.reorder_level) }}</td><td class="n">{{ qty(r.moq) }}</td>
              <td style="width:110px"><input type="number" v-model.number="r._qty"></td>
              <td style="min-width:240px"><RefSelect v-model="r._vendor" :options="vendorsOpts.map(v => ({ id: v.id, label: v.name }))" /></td>
              <td v-if="$root.canSeeCost()" style="width:110px"><input type="number" v-model.number="r._price"></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>`,
};

// ======================================================================
// BUFFER REVIEW (dynamic buffer management suggestions)
// ======================================================================
export const BufferReview = {
  components: { DataTable, Badge },
  data: () => ({ tab: 'pending', pending: [], history: [], loading: true, busy: false, dbmItems: 0 }),
  computed: {
    canDecide() { return hasRole('purchase', 'factory_manager'); },
    histCols() {
      return [{ k: 'created_at', label: 'Suggested', fmt: 'datetime' }, { k: r => r.items?.code, label: 'Item' }, { k: r => r.items?.name, label: 'Name' },
        { k: 'source', label: 'Source', fmt: 'label' }, { k: 'direction', label: 'Direction', fmt: 'label' }, { k: 'current_target', label: 'From', fmt: 'qty' },
        { k: r => r.applied_target ?? r.suggested_target, label: 'To', fmt: 'qty' }, { k: 'status', label: 'Status', fmt: 'badge' },
        { k: r => r.profiles?.full_name || r.profiles?.email, label: 'Decided by' }, { k: 'decided_at', label: 'When', fmt: 'datetime' }, { k: r => r.comments || r.reason, label: 'Reason / comments' }];
    },
  },
  async mounted() { await this.load(); },
  methods: {
    qty, label,
    async load() {
      this.loading = true;
      await run(async () => {
        const sel = '*, items(code,name,lead_time_days,moq,order_multiple,uoms(code)), profiles:decided_by(full_name,email)';
        const p = must(await sb.from('buffer_suggestions').select(sel).eq('status', 'PENDING').order('created_at'));
        const zones = p.length ? must(await sb.from('v_item_stock').select('item_id,buffer_zone,available,on_order,net_flow_position').in('item_id', p.map(x => x.item_id))) : [];
        p.forEach(x => { const z = zones.find(q => q.item_id === x.item_id) || {}; Object.assign(x, { _zone: z.buffer_zone, _nfp: z.net_flow_position, _target: Number(x.suggested_target) }); });
        this.pending = p;
        this.history = must(await sb.from('buffer_suggestions').select(sel).neq('status', 'PENDING').order('created_at', { ascending: false }).limit(1000));
        const { count } = await sb.from('items').select('id', { count: 'exact', head: true }).eq('dbm_enabled', true).gt('buffer_target', 0);
        this.dbmItems = count || 0;
      });
      this.loading = false;
    },
    async runNow() {
      this.busy = true;
      const n = await run(() => rpc('dbm_run'));
      this.busy = false;
      if (n !== undefined) { toast(`${n} new suggestion(s)`, n ? 'ok' : 'info'); await this.load(); refreshPendingSafe(); }
    },
    async decide(x, action) {
      let comments = null;
      if (action === 'REJECT') {
        const v = await ask({ title: 'Reject suggestion for ' + x.items.code, fields: [{ k: 'c', label: 'Reason', type: 'textarea' }], okText: 'Reject' });
        if (!v) return; comments = v.c || null;
      }
      this.busy = true;
      const ok = await run(() => rpc('dbm_decide', { p_id: x.id, p_action: action, p_target: action === 'ACCEPT' ? Number(x._target) : null, p_comments: comments }),
        action === 'ACCEPT' ? `Buffer for ${x.items.code} set to ${qty(x._target)}` : 'Suggestion rejected');
      this.busy = false;
      if (ok) { await this.load(); refreshPendingSafe(); }
    },
  },
  template: `<div>
    <div class="tabs">
      <a href="javascript:void 0" :class="{on: tab==='pending'}" @click="tab='pending'">Pending suggestions ({{ pending.length }})</a>
      <a href="javascript:void 0" :class="{on: tab==='history'}" @click="tab='history'">History</a>
    </div>
    <div class="card" v-if="tab==='pending'">
      <div class="hd"><h3>Dynamic buffer management</h3><span class="spacer"></span>
        <span class="muted small">{{ dbmItems }} items have DBM switched on</span>
        <button class="btn" v-if="canDecide" :disabled="busy" @click="runNow">↻ Run check now</button></div>
      <p class="small muted" style="margin-top:0">Checked every night at 01:00. Too long in <b>RED</b> (longer than the lead time) → raise the buffer by ⅓. Too long in <b>GREEN/above</b> (longer than 2 × lead time) → lower it by ⅓, never below MOQ.
        Switch DBM on per item in the Item master. You can edit the new target before accepting.</p>
      <div class="tbl-wrap">
        <table class="t lines">
          <thead><tr><th>Item</th><th>Zone now</th><th class="n">Days</th><th>Why</th><th class="n">Current</th><th>New target</th><th v-if="canDecide"></th></tr></thead>
          <tbody>
            <tr v-if="loading"><td colspan="7" class="empty">Loading…</td></tr>
            <tr v-else-if="!pending.length"><td colspan="7" class="empty">No pending suggestions</td></tr>
            <tr v-for="x in pending" :key="x.id">
              <td>{{ x.items.code }} — {{ x.items.name }} <span class="muted small">({{ x.items.uoms?.code }}, lead {{ x.items.lead_time_days }} d)</span></td>
              <td><Badge :v="x._zone" /></td>
              <td class="n">{{ x.days_in_zone }}</td>
              <td class="small">{{ x.reason }}</td>
              <td class="n">{{ qty(x.current_target) }}</td>
              <td style="width:120px"><input type="number" v-model.number="x._target" :disabled="!canDecide"> <span class="small" :style="{color: x.direction==='INCREASE' ? '#b91c1c' : '#15803d'}">{{ x.direction==='INCREASE' ? '▲' : '▼' }}</span></td>
              <td v-if="canDecide" style="white-space:nowrap"><button class="btn sm ok" :disabled="busy" @click="decide(x,'ACCEPT')">Accept</button> <button class="btn sm bad" :disabled="busy" @click="decide(x,'REJECT')">Reject</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div class="card" v-else><DataTable :columns="histCols" :rows="history" :loading="loading" filename="buffer_history" /></div>
  </div>`,
};
function refreshPendingSafe() { refreshPending().catch(() => {}); }

// ======================================================================
// TOOL CRIB & ASSET REGISTER
// ======================================================================
const MOVES = [
  { t: 'ISSUE', l: 'Issue to worker', st: ['IN_STORE'], roles: ['stores'] },
  { t: 'RETURN', l: 'Return to store', st: ['ISSUED', 'INSTALLED'], roles: ['stores'] },
  { t: 'INSTALL', l: 'Install / assign', st: ['IN_STORE', 'INSTALLED'], roles: ['stores'] },
  { t: 'TRANSFER', l: 'Transfer location', st: ['IN_STORE', 'INSTALLED', 'ISSUED'], roles: ['stores'] },
  { t: 'REPAIR_OUT', l: 'Send for repair', st: ['IN_STORE', 'INSTALLED', 'ISSUED'], roles: ['stores'] },
  { t: 'REPAIR_IN', l: 'Back from repair', st: ['UNDER_REPAIR'], roles: ['stores'] },
  { t: 'CALIBRATION', l: 'Record calibration', st: ['IN_STORE', 'INSTALLED', 'ISSUED', 'AT_CALIBRATION'], roles: ['stores'] },
  { t: 'LOST', l: 'Mark lost', st: ['IN_STORE', 'INSTALLED', 'ISSUED', 'UNDER_REPAIR'], roles: ['factory_manager'] },
  { t: 'SCRAP', l: 'Scrap asset', st: ['IN_STORE', 'INSTALLED', 'UNDER_REPAIR'], roles: ['factory_manager'] },
];
export const Assets = {
  components: { DataTable, Modal, FieldInput, Badge },
  data: () => ({ rows: [], loading: true, sel: null, hist: [], cls: '', st: '', edit: null }),
  computed: {
    cols() { return [{ k: 'asset_tag', label: 'Tag' }, { k: 'item_name', label: 'Item' }, { k: 'class_code', label: 'Class' }, { k: 'serial_no', label: 'Serial' }, { k: 'location_name', label: 'Location' },
      { k: 'custodian_name', label: 'Custodian' }, { k: 'due_back', label: 'Due back', fmt: 'date' }, { k: 'purchase_date', label: 'Purchased', fmt: 'date' }, { k: 'purchase_cost', label: 'Cost', fmt: 'money', cost: true, sum: true },
      { k: 'calibration_due_date', label: 'Calib. due', fmt: 'date' }, { k: r => r.is_overdue ? 'OVERDUE' : r.status, label: 'Status', fmt: 'badge' }]; },
    classes() { return [...new Set(this.rows.map(r => r.class_code))].sort(); },
    shown() { return this.rows.filter(r => (!this.cls || r.class_code === this.cls) && (!this.st || r.status === this.st)); },
    moves() { return this.sel ? MOVES.filter(m => m.st.includes(this.sel.status) && hasRole(...m.roles)) : []; },
  },
  async mounted() { await loadRefs(['employees', 'locations', 'projects', 'cost_centers']); await this.load(); },
  methods: {
    label,
    async load() { this.loading = true; await run(async () => { this.rows = must(await sb.from('v_asset_register').select('*').order('asset_tag')); }); this.loading = false; },
    async open(r) {
      this.sel = r;
      this.edit = { serial_no: r.serial_no, warranty_expiry: r.warranty_expiry, useful_life_years: r.useful_life_years, remarks: r.remarks };
      this.hist = must(await sb.from('asset_movements').select('*, employees(name), f:from_location_id(code), t:to_location_id(code), projects(code)').eq('asset_id', r.id).order('moved_at', { ascending: false }));
    },
    async move(m) {
      const fields = [];
      if (['ISSUE', 'INSTALL'].includes(m.t)) fields.push({ k: 'emp', label: m.t === 'ISSUE' ? 'Employee' : 'Custodian (optional)', type: 'ref', ref: 'employees', required: m.t === 'ISSUE' });
      if (m.t === 'ISSUE') fields.push({ k: 'proj', label: 'Project (optional)', type: 'ref', ref: 'projects' }, { k: 'due', label: 'Due back', type: 'date', default: today() });
      if (['INSTALL', 'TRANSFER', 'RETURN', 'REPAIR_IN'].includes(m.t)) fields.push({ k: 'loc', label: 'Location', type: 'ref', ref: 'locations', required: ['INSTALL', 'TRANSFER'].includes(m.t) });
      if (m.t === 'INSTALL') fields.push({ k: 'cc', label: 'Cost centre', type: 'ref', ref: 'cost_centers' });
      if (m.t === 'RETURN') fields.push({ k: 'cond', label: 'Condition', type: 'select', required: true, options: ['GOOD', 'DAMAGED', 'NEEDS_REPAIR'], default: 'GOOD' });
      fields.push({ k: 'rem', label: 'Remarks', type: 'textarea' });
      const v = await ask({ title: `${m.l} — ${this.sel.asset_tag}`, fields, okText: m.l });
      if (!v) return;
      const no = await run(() => rpc('asset_move', { p_asset: this.sel.id, p_type: m.t, p_employee: v.emp || null, p_project: v.proj || null, p_cost_center: v.cc || null,
        p_to_location: v.loc || null, p_due_back: v.due || null, p_condition: v.cond || null, p_remarks: v.rem || null }));
      if (no) { toast(`${m.l}: ${no}`, 'ok'); await this.load(); await this.open(this.rows.find(r => r.id === this.sel.id)); }
    },
    async saveDetails() {
      const ok = await run(async () => must(await sb.from('assets').update(this.edit).eq('id', this.sel.id)), 'Saved');
      if (ok) await this.load();
    },
  },
  template: `<div>
    <div class="card">
      <div class="hd"><h3>Asset register & tool crib</h3><span class="spacer"></span>
        <select v-model="cls" style="max-width:160px"><option value="">All classes</option><option v-for="c in classes">{{ c }}</option></select>
        <select v-model="st" style="max-width:160px"><option value="">All statuses</option><option v-for="s in ['IN_STORE','ISSUED','INSTALLED','UNDER_REPAIR','LOST','SCRAPPED']" :value="s">{{ label(s) }}</option></select>
      </div>
      <p class="small muted" style="margin-top:0">Machines, tools, office & camp equipment are registered automatically (one asset tag per unit) when their GRN is posted.</p>
      <DataTable :columns="cols" :rows="shown" :loading="loading" clickable @row="open" filename="asset_register" />
    </div>
    <Modal v-if="sel" :title="sel.asset_tag + ' — ' + sel.item_name" @close="sel=null">
      <div class="row" style="margin-bottom:12px"><Badge :v="sel.status" /><span class="muted">{{ sel.class_name }} · {{ sel.location_name }}</span><span v-if="sel.custodian_name">· with <b>{{ sel.custodian_name }}</b></span></div>
      <div class="row" style="margin-bottom:14px"><button v-for="m in moves" class="btn" @click="move(m)">{{ m.l }}</button></div>
      <div class="grid" style="margin-bottom:12px">
        <label class="f">Serial no.<input v-model="edit.serial_no"></label>
        <label class="f">Warranty expiry<input type="date" v-model="edit.warranty_expiry"></label>
        <label class="f">Useful life (years)<input type="number" v-model.number="edit.useful_life_years"></label>
        <label class="f wide">Remarks<input v-model="edit.remarks"></label>
        <label class="f">&nbsp;<button class="btn" v-if="$root.hasRole('stores')" @click="saveDetails">Save details</button></label>
      </div>
      <h3 style="font-size:13px">Movement history</h3>
      <DataTable :searchable="false" :rows="hist" :columns="[{k:'moved_at',label:'When',fmt:'datetime'},{k:'doc_no',label:'Doc'},{k:'move_type',label:'Move',fmt:'label'},{k:r=>r.employees?.name,label:'Employee'},{k:r=>r.f?.code,label:'From'},{k:r=>r.t?.code,label:'To'},{k:r=>r.projects?.code,label:'Project'},{k:'due_back',label:'Due back',fmt:'date'},{k:'condition',label:'Condition',fmt:'label'},{k:'remarks',label:'Remarks'}]" />
    </Modal>
  </div>`,
};

// ======================================================================
// USERS (admin)
// ======================================================================
export const Users = {
  components: { DataTable, Modal },
  data: () => ({ rows: [], loading: true, edit: null, nu: null, busy: false }),
  computed: { roles() { return Object.entries(ROLES).map(([v, l]) => ({ v, l })); } },
  async mounted() { await this.load(); },
  methods: {
    async load() { this.loading = true; await run(async () => { this.rows = must(await sb.from('profiles').select('*').order('created_at')); }); this.loading = false; },
    open(r) { this.edit = { ...r }; },
    async save() {
      const e = this.edit;
      const ok = await run(async () => must(await sb.from('profiles').update({ full_name: e.full_name, role: e.role, is_active: e.is_active, employee_code: e.employee_code }).eq('id', e.id)), 'User updated');
      if (ok) { this.edit = null; this.load(); loadRef('profiles', true); }
    },
    async create() {
      const u = this.nu;
      if (!u.email || !u.password || u.password.length < 8) return toast('Email and a password of at least 8 characters are required', 'error');
      this.busy = true;
      const ok = await run(async () => {
        const { data, error } = await sb.functions.invoke('admin-users', { body: { action: 'create', ...u } });
        if (error) throw new Error((await error.context?.json?.())?.error || error.message);
        if (data?.error) throw new Error(data.error);
      }, 'User created — share the email and temporary password with them');
      this.busy = false;
      if (ok) { this.nu = null; this.load(); }
    },
    async resetPw(r) {
      const v = await ask({ title: 'Set new password for ' + r.email, fields: [{ k: 'pw', label: 'New password (min 8 chars)', required: true }] });
      if (!v) return;
      await run(async () => {
        const { data, error } = await sb.functions.invoke('admin-users', { body: { action: 'reset_password', user_id: r.id, password: v.pw } });
        if (error) throw new Error((await error.context?.json?.())?.error || error.message);
        if (data?.error) throw new Error(data.error);
      }, 'Password updated');
    },
  },
  template: `<div>
    <div class="row" style="margin-bottom:12px"><span class="muted small">New sign-ups stay inactive until an administrator activates them and assigns a role.</span><span class="spacer"></span>
      <button class="btn primary" @click="nu={email:'',password:'',full_name:'',role:'shop_floor'}">+ Create user</button></div>
    <div class="card"><DataTable :rows="rows" :loading="loading" clickable @row="open" filename="users"
      :columns="[{k:'full_name',label:'Name'},{k:'email',label:'Email'},{k:r=>$root.ROLES[r.role],label:'Role'},{k:'employee_code',label:'Emp code'},{k:r=>r.is_active?'ACTIVE':'BLOCKED',label:'Status',fmt:'badge'},{k:'created_at',label:'Created',fmt:'date'}]" /></div>
    <Modal v-if="edit" :title="'User — ' + edit.email" small @close="edit=null">
      <div class="grid">
        <label class="f full">Full name<input v-model="edit.full_name"></label>
        <label class="f">Role<select v-model="edit.role"><option v-for="r in roles" :value="r.v">{{ r.l }}</option></select></label>
        <label class="f">Employee code<input v-model="edit.employee_code"></label>
        <label class="f">Active<span class="row"><input type="checkbox" v-model="edit.is_active"> can log in</span></label>
      </div>
      <template #footer><button class="btn" @click="resetPw(edit)">Reset password</button><span class="spacer"></span><button class="btn" @click="edit=null">Close</button><button class="btn primary" @click="save">Save</button></template>
    </Modal>
    <Modal v-if="nu" title="Create user" small @close="nu=null">
      <div class="grid">
        <label class="f full">Full name<input v-model="nu.full_name"></label>
        <label class="f full">Email (login)<input v-model="nu.email" type="email"></label>
        <label class="f full">Temporary password<input v-model="nu.password"></label>
        <label class="f full">Role<select v-model="nu.role"><option v-for="r in roles" :value="r.v">{{ r.l }}</option></select></label>
      </div>
      <template #footer><button class="btn" @click="nu=null">Cancel</button><button class="btn primary" :disabled="busy" @click="create">Create</button></template>
    </Modal>
  </div>`,
};

// ======================================================================
// SETTINGS (admin)
// ======================================================================
export const Settings = {
  components: { FieldInput },
  data: () => ({ c: null }),
  computed: {
    fields() {
      return [
        { k: 'company_name', label: 'Company name', required: true, full: true }, { k: 'trn', label: 'Company TRN' }, { k: 'phone', label: 'Phone' }, { k: 'email', label: 'Email' },
        { k: 'address', label: 'Address', type: 'textarea', full: true },
        { k: 'default_vat_rate', label: 'Default VAT %', type: 'number' }, { k: 'grn_over_receipt_pct', label: 'Allowed over-receipt vs PO %', type: 'number' },
        { k: 'overstock_months', label: 'Overstock if cover > months', type: 'number' },
        { k: 'dbm_min_red_days', label: 'DBM: min days in RED before raising', type: 'number' },
        { k: 'dbm_min_green_days', label: 'DBM: min days in GREEN before lowering', type: 'number' },
        { k: 'dbm_step_pct', label: 'DBM: adjustment step %', type: 'number' }, { k: 'abc_a_pct', label: 'ABC: A up to cumulative %', type: 'number' }, { k: 'abc_b_pct', label: 'ABC: B up to cumulative %', type: 'number' },
        { k: 'po_terms_conditions', label: 'Default PO terms & conditions', type: 'textarea', full: true },
      ];
    },
  },
  mounted() { this.c = { ...state.company }; },
  methods: {
    async save() {
      const row = {}; this.fields.forEach(f => { row[f.k] = this.c[f.k]; });
      const ok = await run(async () => must(await sb.from('company_settings').update(row).eq('id', 1)), 'Settings saved');
      if (ok) await loadCompany();
    },
  },
  template: `<div class="card" v-if="c">
    <div class="grid"><FieldInput v-for="f in fields" :key="f.k" :f="f" :doc="c" :disabled="!$root.hasRole()" /></div>
    <div class="row" style="margin-top:14px"><span class="spacer"></span><button class="btn primary" v-if="$root.hasRole()" @click="save">Save settings</button></div>
  </div>`,
};
