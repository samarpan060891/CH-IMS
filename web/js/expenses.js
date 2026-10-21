// Running expenses: utilities, rent, telecom, fuel, repairs … each line to an expense head + cost centre (+ optional project).
// Types: supplier bill (→ payables), paid now (bank / cash), petty cash, employee claim (reimbursed later).
// Above the approval limit the Factory Manager approves; Finance posts. Recurring bills, petty cash floats, budgets.
import { reactive } from 'vue';
import { sb, state, must, run, rpc, hasRole, canSeeCost, go, today, refRow, refLabel, money, qty, dt, label, num, loadRefs, toast } from './lib.js';
import { ask, confirmBox, Badge, DataTable } from './components.js';
import { makePdf } from './pdf.js';
import { shrink } from './projects.js';

const isFin = () => hasRole('finance');
const statusIs = (ctx, ...s) => s.includes(ctx.doc.status);
export const EXP_TYPES = [{ v: 'BILL', l: 'Supplier bill — pay later (payables)' }, { v: 'PAID', l: 'Paid now — bank / card / cash' },
  { v: 'PETTY', l: 'Petty cash' }, { v: 'CLAIM', l: 'Employee claim — reimburse' }];
const TYPE_SHORT = { BILL: 'Supplier bill', PAID: 'Paid now', PETTY: 'Petty cash', CLAIM: 'Employee claim' };
// expense heads: posting accounts of type expense (not the production / labour absorption credits)
const isHead = r => !r.is_group && r.is_active && r.acc_type === 'EXPENSE' && !['PROD_ABSORBED', 'LABOUR_ABSORBED', 'MAT_CONSUMED', 'COGS', 'DEPRECIATION'].includes(r.system_key);
const isPayAcct = r => !r.is_group && r.is_active && (r.is_bank || ['CASH', 'BANK'].includes(r.system_key));
const staffOnly = () => !hasRole('finance', 'factory_manager', 'purchase', 'stores');

export const xopts = reactive({ floats: [] });
async function loadFloats() { xopts.floats = must(await sb.from('petty_floats').select('id,name,gl_account_id,is_active').eq('is_active', true).order('name')).map(f => ({ id: f.id, label: f.name })); }

// ---------- bill photos / PDFs (private "expenses" bucket) ----------
function pickFiles() {
  return new Promise(res => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*,application/pdf'; i.multiple = true;
    i.onchange = () => res([...(i.files || [])]); i.click();
  });
}
export const ExpenseFiles = {
  props: { ctx: Object },
  data: () => ({ busy: false }),
  computed: {
    d() { return this.ctx.doc; },
    files() { return Array.isArray(this.d.attachments) ? this.d.attachments : []; },
    canAdd() { return ['DRAFT', 'REJECTED'].includes(this.d.status) && (this.d.created_by === state.profile?.id || isFin()); },
  },
  methods: {
    async add() {
      const files = await pickFiles(); if (!files.length) return;
      this.busy = true;
      await run(async () => {
        const list = [...this.files];
        for (const [n, f] of files.entries()) {
          const blob = f.type.startsWith('image/') ? await shrink(f) : f;
          const ext = blob.type === 'image/jpeg' ? 'jpg' : (f.name.split('.').pop() || 'bin').toLowerCase();
          const path = `${this.d.id}/${Date.now()}-${n}.${ext}`;
          must(await sb.storage.from('expenses').upload(path, blob, { contentType: blob.type || f.type, upsert: false }));
          list.push({ path, name: f.name });
        }
        must(await sb.from('expenses').update({ attachments: list }).eq('id', this.d.id));
        this.d.attachments = list;
      }, 'Attached');
      this.busy = false;
    },
    async open(f) {
      const r = await run(async () => must(await sb.storage.from('expenses').createSignedUrl(f.path, 300)));
      if (r?.signedUrl) window.open(r.signedUrl, '_blank');
    },
  },
  template: `<div class="card">
    <div class="hd"><h3>📎 Bill / receipt</h3><span class="spacer"></span>
      <button v-if="canAdd" class="btn sm primary" :disabled="busy" @click="add">📷 Add photo / PDF</button></div>
    <div v-if="!files.length" class="muted small">No bill attached{{ canAdd ? ' — take a photo of the bill or receipt' : '' }}.</div>
    <div class="row" style="flex-wrap:wrap;gap:6px"><a v-for="f in files" :key="f.path" class="chip" href="javascript:void 0" @click="open(f)">📄 {{ f.name }}</a></div>
  </div>`,
};

// ======================================================================
// EXPENSE VOUCHER
// ======================================================================
export const exp = {
  key: 'exp', title: 'Expenses & Bills', single: 'Expense', table: 'expenses', noField: 'exp_no', dateField: 'exp_date',
  statuses: ['DRAFT', 'PENDING_FM', 'APPROVED', 'POSTED', 'REIMBURSED', 'REJECTED', 'CANCELLED'],
  createRoles: ['finance', 'factory_manager', 'purchase', 'stores', 'production_incharge', 'shop_floor', 'site_supervisor', 'hr_officer'],
  canEdit: ctx => ['DRAFT', 'REJECTED'].includes(ctx.doc.status) && (!ctx.doc.id || ctx.doc.created_by === state.profile?.id || isFin()),
  refs: ['gl_accounts', 'cost_centers', 'projects', 'vendors', 'employees', 'profiles'],
  panel: ExpenseFiles,
  list: { select: '*, vendors(name), employees(name)', columns: [{ k: r => TYPE_SHORT[r.exp_type], label: 'Type' },
    { k: r => r.vendors?.name || r.employees?.name || r.payee_name, label: 'Paid to' }, { k: 'bill_no', label: 'Bill no.' },
    { k: 'subtotal', label: 'Amount', fmt: 'money', sum: true }, { k: 'vat_amount', label: 'VAT', fmt: 'money', sum: true }, { k: 'total', label: 'Total', fmt: 'money', sum: true }] },
  defaults: () => ({ exp_date: today(), exp_type: staffOnly() ? 'CLAIM' : 'BILL', attachments: [] }),
  async onNew(ctx) {
    await loadFloats();
    // staff claims: the employee is the person raising it, when their login is linked to an employee record
    if (ctx.doc.exp_type === 'CLAIM') { const e = must(await sb.from('employees').select('id').eq('profile_id', state.profile?.id).limit(1)); if (e[0]) ctx.doc.employee_id = e[0].id; }
  },
  async afterLoad() { await loadFloats(); },
  header: [
    { k: 'exp_type', label: 'Type', type: 'select', required: true, wide: true, options: () => staffOnly() ? EXP_TYPES.filter(t => ['CLAIM', 'PETTY'].includes(t.v)) : EXP_TYPES },
    { k: 'exp_date', label: 'Bill / receipt date', type: 'date', required: true },
    { k: 'vendor_id', label: 'Supplier', type: 'ref', ref: 'vendors', wide: true, show: d => ['BILL', 'PAID'].includes(d.exp_type) },
    { k: 'payee_name', label: 'Paid to (shop / payee)', show: d => d.exp_type !== 'BILL' },
    { k: 'bill_no', label: 'Bill / receipt no.' },
    { k: 'due_date', label: 'Due date (blank = supplier terms)', type: 'date', show: d => d.exp_type === 'BILL' },
    { k: 'pay_account_id', label: 'Paid from (bank / cash)', type: 'ref', ref: 'gl_accounts', filter: isPayAcct, show: d => d.exp_type === 'PAID' },
    { k: 'petty_float_id', label: 'Petty cash float', type: 'ref', refOptions: () => xopts.floats, show: d => d.exp_type === 'PETTY' },
    { k: 'employee_id', label: 'Employee to reimburse', type: 'ref', ref: 'employees', show: d => d.exp_type === 'CLAIM' },
    { k: 'approval_comments', label: 'Approval comments', type: 'ro', wide: true, show: d => !!d.approval_comments },
    { k: 'reimb_ref', label: 'Reimbursed', type: 'ro', fmt: (v, d) => `${refLabel('gl_accounts', d.reimb_account_id)}${v ? ' · ' + v : ''}`, show: d => d.status === 'REIMBURSED' },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  headerNote: ctx => `Charge each line to an <b>expense head</b> and a <b>cost centre</b>; add a <b>project</b> when the cost belongs to a job (it then counts in the project margin). ` +
    `Attach a photo of the bill after saving. Above AED ${money(state.company?.expense_approval_limit ?? 1000)} the Factory Manager approves; Finance posts.` +
    (ctx.doc.exp_type === 'BILL' ? ' A posted supplier bill appears in <b>payables</b> and is paid through <b>Payments</b>.' : ''),
  grids: [{ key: 'lines', title: 'Expense lines', table: 'expense_lines', fk: 'expense_id', order: 'line_no',
    newRow: ctx => ({ vat_rate: ctx.doc.exp_type === 'CLAIM' ? 0 : 5, cost_center_id: ctx.grids.lines.at(-1)?.cost_center_id || null }),
    fields: [
      { k: 'account_id', label: 'Expense head', type: 'ref', ref: 'gl_accounts', required: true, width: '230px', filter: isHead },
      { k: 'description', label: 'Description', width: '200px' },
      { k: 'cost_center_id', label: 'Cost centre', type: 'ref', ref: 'cost_centers', required: true, width: '150px', filter: r => r.is_active },
      { k: 'project_id', label: 'Project (optional)', type: 'ref', ref: 'projects', width: '150px', filter: r => r.status === 'OPEN' },
      { k: 'amount', label: 'Amount (excl. VAT)', type: 'number', required: true },
      { k: 'vat_rate', label: 'VAT %', type: 'number' },
      { k: '_vat', label: 'VAT', type: 'ro', virtual: true, fmt: (v, r) => money(num(r.amount) * num(r.vat_rate) / 100) },
      // prepaid (insurance, rent in advance …): held in Prepayments and released monthly to the expense head
      { k: 'spread_months', label: 'Spread over months (prepaid)', type: 'number', show: () => isFin() },
    ] }],
  totals: ctx => {
    const a = ctx.grids.lines.reduce((s, r) => s + num(r.amount), 0), v = ctx.grids.lines.reduce((s, r) => s + Math.round(num(r.amount) * num(r.vat_rate)) / 100, 0);
    return [{ l: 'Amount', v: a }, { l: 'VAT', v }, { l: 'Total', v: a + v }];
  },
  async loadInfo(ctx) {
    if (!ctx.doc.vendor_invoice_id) return [];
    const b = must(await sb.from('v_invoice_balances').select('*').eq('id', ctx.doc.vendor_invoice_id));
    return [{ title: 'Payable (supplier invoice)', rows: b, columns: [{ k: 'inv_no', label: 'Invoice' }, { k: 'total_aed', label: 'Total', fmt: 'money' }, { k: 'paid_aed', label: 'Paid', fmt: 'money' },
      { k: 'balance_aed', label: 'Balance', fmt: 'money' }, { k: 'due_date', label: 'Due', fmt: 'date' }] }];
  },
  actions: ctx => {
    const s = ctx.doc.status, mine = ctx.doc.created_by === state.profile?.id;
    return [
      { label: '📤 Submit', cls: 'primary', show: ['DRAFT', 'REJECTED'].includes(s) && (mine || isFin()), done: 'Submitted',
        run: async c => { const r = await rpc('expense_action', { p_exp: c.doc.id, p_action: 'SUBMIT' }); toast(r === 'PENDING_FM' ? 'Sent to the Factory Manager for approval' : 'Sent to Finance to post', 'ok'); } },
      { label: '✔ Approve', cls: 'ok', show: s === 'PENDING_FM' && hasRole('factory_manager'), done: 'Approved',
        run: async c => { const v = await ask({ title: 'Approve ' + c.doc.exp_no, fields: [{ k: 'c', label: 'Comments (optional)', type: 'textarea' }], okText: 'Approve' }); if (!v) return false;
          return rpc('expense_action', { p_exp: c.doc.id, p_action: 'APPROVE', p_data: { comments: v.c || null } }); } },
      { label: '✖ Reject', cls: 'bad', show: s === 'PENDING_FM' && hasRole('factory_manager'), done: 'Rejected',
        run: async c => { const v = await ask({ title: 'Reject ' + c.doc.exp_no, fields: [{ k: 'c', label: 'Reason', type: 'textarea', required: true }], okText: 'Reject', danger: true }); if (!v) return false;
          return rpc('expense_action', { p_exp: c.doc.id, p_action: 'REJECT', p_data: { comments: v.c } }); } },
      { label: '✔ Post', cls: 'ok', show: s === 'APPROVED' && isFin(), done: 'Posted to the ledger',
        confirm: ctx.doc.exp_type === 'BILL' ? 'Post this bill? It goes to payables (pay it from Payments).' : ctx.doc.exp_type === 'CLAIM' ? 'Post this claim? The employee is then owed the amount until reimbursed.' : 'Post this expense to the ledger?',
        run: c => rpc('expense_action', { p_exp: c.doc.id, p_action: 'POST' }) },
      { label: '💸 Reimburse', cls: 'ok', show: s === 'POSTED' && ctx.doc.exp_type === 'CLAIM' && isFin(), done: 'Reimbursed',
        run: async c => {
          const v = await ask({ title: 'Reimburse ' + c.doc.exp_no + ' — AED ' + money(c.doc.total), okText: 'Reimburse', fields: [
            { k: 'a', label: 'Paid from', type: 'select', required: true, options: (state.refs.gl_accounts || []).filter(isPayAcct).map(a => ({ v: a.id, l: `${a.code} — ${a.name}` })) },
            { k: 'd', label: 'Date', type: 'date', default: today() }, { k: 'r', label: 'Reference (transfer / cash voucher)' }] });
          if (!v) return false; return rpc('expense_action', { p_exp: c.doc.id, p_action: 'REIMBURSE', p_data: { account_id: v.a, date: v.d, ref: v.r || null } }); } },
      { label: '💳 Pay this bill', show: s === 'POSTED' && ctx.doc.exp_type === 'BILL' && isFin(), reload: false, run: c => go(`d/pay/new/vendor/${c.doc.vendor_id}`) },
      { label: '📒 Journal', show: !!(ctx.doc.gl_je_id), reload: false, run: c => go('d/jv/' + c.doc.gl_je_id) },
      { label: '🖨 Voucher', reload: false, run: c => makePdf({ title: TYPE_SHORT[c.doc.exp_type] + ' voucher', no: c.doc.exp_no, date: c.doc.exp_date, subtitle: label(c.doc.status),
          meta: [['Paid to', refLabel('vendors', c.doc.vendor_id) || refLabel('employees', c.doc.employee_id) || c.doc.payee_name || '-'], ['Bill / receipt', c.doc.bill_no || '-'],
                 ['Paid from', c.doc.exp_type === 'PAID' ? refLabel('gl_accounts', c.doc.pay_account_id) : c.doc.exp_type === 'PETTY' ? (xopts.floats.find(f => f.id === c.doc.petty_float_id)?.label || '') : '-']],
          columns: [{ h: 'Expense head', k: r => refLabel('gl_accounts', r.account_id) }, { h: 'Description', k: r => r.description || '' }, { h: 'Cost centre', k: r => refRow('cost_centers', r.cost_center_id)?.code || '' },
            { h: 'Project', k: r => refRow('projects', r.project_id)?.code || '' }, { h: 'Amount', k: r => money(r.amount), align: 'right' }, { h: 'VAT', k: r => money(num(r.amount) * num(r.vat_rate) / 100), align: 'right' }],
          rows: c.grids.lines, totals: exp.totals(c).map(t => [t.l, money(t.v)]), notes: c.doc.remarks || '',
          signatures: c.doc.exp_type === 'CLAIM' ? ['Claimed by', 'Approved by', 'Finance', 'Received by'] : ['Prepared by', 'Approved by', 'Finance'] }) },
      { label: 'Cancel', show: ['DRAFT', 'PENDING_FM', 'APPROVED', 'REJECTED'].includes(s) && (mine || isFin()), confirm: 'Cancel this expense?', run: c => rpc('expense_action', { p_exp: c.doc.id, p_action: 'CANCEL' }) },
    ];
  },
};

// ======================================================================
// RECURRING BILLS (monthly drafts)
// ======================================================================
export const rexp = {
  key: 'rexp', title: 'Recurring Bills', single: 'Recurring Bill', table: 'expense_templates', noField: 'tpl_no', dateField: 'tpl_date',
  statuses: ['ACTIVE', 'PAUSED'], createRoles: ['finance'], editStatuses: ['ACTIVE', 'PAUSED'],
  refs: ['gl_accounts', 'cost_centers', 'projects', 'vendors'],
  list: { select: '*, vendors(name)', columns: [{ k: 'title', label: 'Bill' }, { k: r => TYPE_SHORT[r.exp_type], label: 'Type' }, { k: r => r.vendors?.name || r.payee_name, label: 'Paid to' },
    { k: 'day_of_month', label: 'Day', n: true }, { k: 'next_date', label: 'Next draft', fmt: 'date' }] },
  defaults: () => ({ status: 'ACTIVE', exp_type: 'BILL', day_of_month: 1, next_date: today() }),
  async onNew() { await loadFloats(); }, async afterLoad() { await loadFloats(); },
  header: [
    { k: 'title', label: 'Bill name (e.g. Factory rent, DEWA, Etisalat)', required: true, wide: true },
    { k: 'exp_type', label: 'Type', type: 'select', required: true, options: EXP_TYPES },
    { k: 'vendor_id', label: 'Supplier', type: 'ref', ref: 'vendors', wide: true, show: d => ['BILL', 'PAID'].includes(d.exp_type) },
    { k: 'payee_name', label: 'Paid to', show: d => d.exp_type !== 'BILL' },
    { k: 'pay_account_id', label: 'Paid from', type: 'ref', ref: 'gl_accounts', filter: isPayAcct, show: d => d.exp_type === 'PAID' },
    { k: 'petty_float_id', label: 'Petty cash float', type: 'ref', refOptions: () => xopts.floats, show: d => d.exp_type === 'PETTY' },
    { k: 'day_of_month', label: 'Bill day of month (1–28)', type: 'number', required: true },
    { k: 'next_date', label: 'Next draft on', type: 'date', required: true },
    { k: 'end_date', label: 'Stop after (optional)', type: 'date' },
    { k: 'status', label: 'Status', type: 'select', required: true, options: ['ACTIVE', 'PAUSED'] },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  headerNote: () => 'Each month on the <b>next draft</b> date a draft expense is created with these lines and Finance is notified — check the amount against the actual bill (utilities vary), attach the bill and submit.',
  grids: [{ key: 'lines', title: 'Lines (usual amount)', table: 'expense_template_lines', fk: 'template_id', order: 'line_no',
    newRow: () => ({ vat_rate: 5 }),
    fields: [
      { k: 'account_id', label: 'Expense head', type: 'ref', ref: 'gl_accounts', required: true, width: '230px', filter: isHead },
      { k: 'description', label: 'Description', width: '200px' },
      { k: 'cost_center_id', label: 'Cost centre', type: 'ref', ref: 'cost_centers', required: true, width: '150px' },
      { k: 'project_id', label: 'Project', type: 'ref', ref: 'projects', width: '150px' },
      { k: 'amount', label: 'Amount (excl. VAT)', type: 'number', required: true }, { k: 'vat_rate', label: 'VAT %', type: 'number' }] }],
  actions: ctx => [
    { label: '⚡ Create this month\'s draft now', cls: 'primary', show: isFin() && ctx.doc.status === 'ACTIVE', done: 'Draft created',
      run: async c => { const n = await rpc('expense_recurring_run', { p_template: c.doc.id }); if (!n) toast('Nothing created — check the dates', 'info'); } },
  ],
};

export const EXP_DOCS = { exp, rexp };

// ======================================================================
// PETTY CASH: floats, balances, top-ups
// ======================================================================
export const PettyCash = {
  components: { DataTable },
  data: () => ({ rows: [], loading: false }),
  computed: { isFin },
  async mounted() { await loadRefs(['gl_accounts', 'profiles']); await this.load(); },
  methods: {
    money,
    async load() { this.loading = true; await run(async () => { this.rows = must(await sb.from('v_petty_floats').select('*').order('name')); }); this.loading = false; },
    async add() {
      const v = await ask({ title: 'New petty cash float', fields: [{ k: 'n', label: 'Name (e.g. Factory float, Site float — PRJ-0007)', required: true },
        { k: 'c', label: 'Custodian', type: 'select', options: (state.refs.profiles || []).map(p => ({ v: p.id, l: p.full_name || p.email })) }, { k: 'l', label: 'Float limit AED', type: 'number' }] });
      if (v && await run(async () => must(await sb.from('petty_floats').insert({ name: v.n, custodian_id: v.c || null, float_limit: num(v.l) })), 'Float created with its own ledger account')) { await loadRefs(['gl_accounts']); await this.load(); }
    },
    async topup(f) {
      const short = Math.max(num(f.float_limit) - num(f.balance), 0);
      const v = await ask({ title: 'Top up ' + f.name, message: `Balance AED ${money(f.balance)} of a AED ${money(f.float_limit)} limit.`, okText: 'Top up', fields: [
        { k: 'a', label: 'Amount AED', type: 'number', required: true, default: short || null },
        { k: 'f', label: 'From', type: 'select', required: true, options: (state.refs.gl_accounts || []).filter(isPayAcct).map(a => ({ v: a.id, l: `${a.code} — ${a.name}` })) },
        { k: 'd', label: 'Date', type: 'date', default: today() }, { k: 'r', label: 'Reference' }] });
      if (v && await run(() => rpc('petty_topup', { p_float: f.id, p_amount: num(v.a), p_from: v.f, p_ref: v.r || null, p_date: v.d || today() }), 'Topped up')) await this.load();
    },
  },
  template: `<div>
    <div class="row" style="margin-bottom:12px"><span class="muted small" style="max-width:820px">Each float has its own ledger account (under 1115). Spends are entered as <b>Petty cash</b> expenses; Finance tops the float up from the bank or cash.</span>
      <span class="spacer"></span><button class="btn primary" v-if="isFin" @click="add">+ New float</button></div>
    <div class="card"><DataTable :rows="rows" :loading="loading" :searchable="false" :columns="[{k:'name',label:'Float'},{k:'custodian',label:'Custodian'},{k:'account_code',label:'Account'},
      {k:'float_limit',label:'Limit',fmt:'money'},{k:'balance',label:'Balance',fmt:'money',sum:true},{k:'pending_spend',label:'Spends not yet posted',fmt:'money'},
      {k: r => Number(r.float_limit) ? Math.round(100 * Number(r.balance) / Number(r.float_limit)) + '%' : '', label:'Left'}]" clickable @row="r => isFin && topup(r)" />
      <p class="small muted" v-if="isFin">Click a float to top it up. Its ledger shows every spend and top-up (Finance → Ledgers).</p></div>
  </div>`,
};
