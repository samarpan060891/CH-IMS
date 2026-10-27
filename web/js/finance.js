// Accounting: customer billing (progress claims with payment certificates, advance & recovery, retention),
// receipts, journal vouchers, and the books (trial balance, P&L, balance sheet, ledgers with bank
// reconciliation, VAT 201, receivables aging, customer statements, project billing, period close).
// Every other module posts to the ledger automatically (gl_sync, every 15 minutes or on demand).
import { reactive } from 'vue';
import { sb, state, must, run, rpc, hasRole, go, today, refRow, refLabel, money, qty, dt, label, num, loadRefs, toast } from './lib.js';
import { ask, confirmBox, Badge, DataTable, FieldInput, uomPick } from './components.js';
import { makePdf, partyOf } from './pdf.js';

const isFin = () => hasRole('finance');
// Stores / warehouse issue sales invoices and progress / final progress claims (dispatch & invoicing); Finance controls the rest
const STORES_TYPES = ['SALES', 'PROGRESS', 'FINAL'];
const canBill = t => hasRole('finance', 'factory_manager') || (hasRole('stores') && STORES_TYPES.includes(t));
const statusIs = (ctx, ...s) => s.includes(ctx.doc.status);
const PROGRESS = ['PROGRESS', 'FINAL'];
const INV_TYPES = [{ v: 'PROGRESS', l: 'Progress claim (interim payment application)' }, { v: 'ADVANCE', l: 'Advance payment invoice' },
  { v: 'FINAL', l: 'Final account / final progress claim' }, { v: 'RETENTION_RELEASE', l: 'Retention release' }, { v: 'GENERAL', l: 'General / product sale' }, { v: 'CREDIT_NOTE', l: 'Credit note' },
  { v: 'SALES', l: 'Sales order invoice (made from the order — advance recovered)' }];
// short names for the invoice list
const INV_SHORT = { PROGRESS: 'Progress claim', FINAL: 'Final progress claim', ADVANCE: 'Advance invoice', RETENTION_RELEASE: 'Retention release',
  GENERAL: 'General invoice', CREDIT_NOTE: 'Credit note', SALES: 'Sales order invoice' };
const yearStart = () => today().slice(0, 4) + '-01-01';
const custOf = id => refRow('customers', id);

export const fopts = reactive({ invs: [], custInvs: [] });

async function loadCustInvoices(customerId) {
  if (!customerId) { fopts.invs = []; return; }
  const r = must(await sb.from('v_sales_invoice_balance').select('*').eq('customer_id', customerId).order('due_date'));
  fopts.invs = r.filter(x => x.inv_type !== 'CREDIT_NOTE').map(x => ({ id: x.invoice_id, label: `${x.inv_no} · ${INV_SHORT[x.inv_type] || label(x.inv_type)}${x.project_code ? ' · ' + x.project_code : ''}`, row: x }));
  fopts.custInvs = must(await sb.from('sales_invoices').select('id,inv_no,total_amount,inv_type').eq('customer_id', customerId).eq('status', 'POSTED').neq('inv_type', 'CREDIT_NOTE').order('invoice_date', { ascending: false }))
    .map(x => ({ id: x.id, label: `${x.inv_no} — ${money(x.total_amount)}`, row: x }));
}

// ======================================================================
// SALES INVOICE / PROGRESS CLAIM
// ======================================================================
const lineAmt = r => Math.round((num(r.cum_qty) - num(r.prev_qty)) * num(r.rate) * 100) / 100;
// progress claim: every BOQ line (or unit) of the project with contract qty, rate, previously certified and dispatched to date.
// replace = load them as the lines (new claim / project changed); otherwise only show "dispatched to date" on the saved lines
async function claimLines(ctx, replace) {
  const d = ctx.doc;
  if (!PROGRESS.includes(d.inv_type) || !d.project_id || (d.status && d.status !== 'DRAFT') || !canBill(d.inv_type)) return;
  const rows = await rpc('si_claim_lines', { p_project: d.project_id, p_final: d.inv_type === 'FINAL', p_inv: d.id || null }) || [];
  const key = r => r.boq_line_id || r.unit_id;
  if (!replace) {
    const m = Object.fromEntries(rows.map(r => [key(r), r]));
    ctx.grids.lines.forEach(l => { const r = m[key(l)]; if (r) l._done = num(r.done_qty); });
    return;
  }
  ctx.grids.lines.forEach(l => { if (l.id) (ctx.removed.lines ||= []).push(l.id); });
  ctx.grids.lines = rows.map(r => ({ boq_line_id: r.boq_line_id, unit_id: r.unit_id, description: r.description, uom: r.uom, contract_qty: num(r.contract_qty),
    rate: num(r.rate), prev_qty: num(r.prev_qty), cum_qty: num(r.cum_qty), _done: num(r.done_qty) }));
  ctx.dirty = true;
  if (!rows.length) toast('This project has no BOQ lines with a selling rate', 'warn');
}
// a new claim (or one whose lines are all blank) loads the project's lines on its own
const blankLines = ctx => ctx.grids.lines.every(l => !l.description && !l.boq_line_id && !l.unit_id);
export const si = {
  key: 'si', title: 'Sales Invoices & Progress Claims', single: 'Sales Invoice', table: 'sales_invoices', noField: 'inv_no', dateField: 'invoice_date',
  statuses: ['DRAFT', 'SUBMITTED', 'CERTIFIED', 'POSTED', 'CANCELLED'], createRoles: ['finance', 'factory_manager', 'stores'], refs: ['customers', 'projects', 'gl_accounts', 'profiles', 'uoms'],
  canEdit: ctx => ctx.doc.status === 'DRAFT' && canBill(ctx.doc.inv_type || 'PROGRESS'),
  list: { select: '*, customers(name), projects(code)', columns: [{ k: r => INV_SHORT[r.inv_type] || label(r.inv_type), label: 'Type' }, { k: r => r.customers?.name, label: 'Customer' },
    { k: r => r.projects?.code, label: 'Project' }, { k: r => r.claim_no ? '#' + r.claim_no : '', label: 'Progress claim' }, { k: 'cert_no', label: 'Certificate' },
    { k: r => r.certified_gross ?? r.gross_claimed, label: 'Gross', fmt: 'money', sum: true }, { k: 'vat_amount', label: 'VAT', fmt: 'money', sum: true },
    { k: r => r.inv_type === 'CREDIT_NOTE' ? -r.total_amount : r.total_amount, label: 'Total due', fmt: 'money', sum: true }, { k: 'due_date', label: 'Due', fmt: 'date' }] },
  defaults: () => ({ inv_type: 'PROGRESS', invoice_date: today(), vat_rate: num(state.company?.default_vat_rate) || 5 }),
  async onNew(ctx, parts) {
    if (parts[0] === 'project' && parts[1]) { ctx.doc.project_id = parts[1]; ctx.doc.customer_id = refRow('projects', parts[1])?.customer_id || null; }
    if (parts[0] === 'credit' && parts[1]) {
      const o = must(await sb.from('sales_invoices').select('*').eq('id', parts[1]).single());
      Object.assign(ctx.doc, { inv_type: 'CREDIT_NOTE', customer_id: o.customer_id, project_id: o.project_id, credit_of: o.id, vat_rate: o.vat_rate, customer_ref: o.inv_no });
      await loadCustInvoices(o.customer_id);
    }
    if (ctx.doc.project_id) await claimLines(ctx, true);
  },
  async afterLoad(ctx) {
    await loadCustInvoices(ctx.doc.customer_id);
    if (ctx.doc.id) await claimLines(ctx, blankLines(ctx));
  },
  header: [
    { k: 'inv_type', label: 'Type', type: 'select', required: true, wide: true, ro: d => !!d.id,
      options: () => hasRole('finance', 'factory_manager') ? INV_TYPES : INV_TYPES.filter(o => STORES_TYPES.includes(o.v)),
      onChange: async (d, v, ctx) => { if (d.inv_type === 'RETENTION_RELEASE') d.vat_rate = 0; else if (!num(d.vat_rate)) d.vat_rate = 5;
        if (PROGRESS.includes(d.inv_type) && d.project_id) await claimLines(ctx, true); } },
    { k: 'project_id', label: 'Project', type: 'ref', ref: 'projects', wide: true, required: false, filter: (r, d) => d.inv_type === 'ADVANCE' ? ['PROJECT', 'SALES'].includes(r.project_type) : PROGRESS.concat('RETENTION_RELEASE').includes(d.inv_type) ? r.project_type === 'PROJECT' : d.inv_type === 'SALES' ? r.project_type === 'SALES' : true,
      onChange: async (d, v, ctx) => { const p = refRow('projects', v); if (p?.customer_id) d.customer_id = p.customer_id;
        if (PROGRESS.includes(d.inv_type) && v) await claimLines(ctx, true); } },
    { k: 'customer_id', label: 'Customer', type: 'ref', ref: 'customers', required: true, wide: true, onChange: (d, v) => loadCustInvoices(v) },
    { k: 'invoice_date', label: 'Invoice date', type: 'date', required: true },
    { k: 'period_to', label: 'Work done up to', type: 'date', show: d => PROGRESS.includes(d.inv_type) },
    { k: 'due_date', label: 'Due date (blank = payment terms)', type: 'date' },
    { k: 'customer_ref', label: 'Client PO / contract / LPO ref' },
    { k: 'credit_of', label: 'Credit against invoice', type: 'ref', refOptions: () => fopts.custInvs, wide: true, show: d => d.inv_type === 'CREDIT_NOTE' },
    { k: 'vat_rate', label: 'VAT %', type: 'number', required: true },
    { k: 'claim_no', label: 'Progress claim no.', type: 'ro', show: d => !!d.claim_no },
    { k: 'cert_no', label: 'Payment certificate', type: 'ro', fmt: (v, d) => v ? `${v} · ${dt(d.cert_date)}` : '', show: d => !!d.cert_no },
    { k: 'remarks', label: 'Remarks (printed)', type: 'textarea', full: true },
  ],
  headerNote: ctx => PROGRESS.includes(ctx.doc.inv_type)
    ? 'Choosing the project lists every BOQ line (unit-wise billing: every unit) with the quantity certified on earlier progress claims and the quantity dispatched to date, which is the default cumulative. ' +
      '<b>Refill from dispatches</b> reloads them after more deliveries (<b>Invoice this dispatch</b> on a posted delivery note does the same). ' +
      'Adjust the cumulative quantities, <b>submit</b> the progress claim to the client, then record the client\'s <b>payment certificate</b> (the certified quantities may be lower) and post the tax invoice. ' +
      'Advance recovery and retention are deducted at the project\'s % — VAT is charged on the certified value less advance recovery.'
    : ctx.doc.inv_type === 'ADVANCE' ? 'Save, then <b>Fill</b> to bill the advance % of the project / sales order value (less advance already billed). The advance is recovered from each progress claim or order invoice.'
    : ctx.doc.inv_type === 'RETENTION_RELEASE' ? 'Save, then <b>Fill</b> with the retention still held on this project (VAT was charged on the original progress claims). Reduce the amount for a partial release.'
    : ctx.doc.inv_type === 'SALES' ? 'Made from the sales order (Sales → order → Invoice delivered / done): goods delivered, services done and job-work hours not yet invoiced. The order\'s advance is recovered pro rata, and in full on the invoice that completes the order.'
    : 'Enter the lines; choose a revenue account per line or leave blank for the default sales account.',
  grids: [{ key: 'lines', title: 'Lines', table: 'sales_invoice_lines', fk: 'invoice_id', order: 'line_no', saveKeys: ['boq_line_id', 'unit_id'],
    newRow: ctx => ({ contract_qty: PROGRESS.includes(ctx.doc.inv_type) ? null : 1, prev_qty: 0, cum_qty: 1, rate: 0 }),
    fields: [
      { k: 'description', label: 'Description', width: '260px', required: true },
      { k: 'uom', label: 'UoM', ...uomPick({ width: '80px' }) },
      { k: 'contract_qty', label: 'Contract qty', type: 'number', show: d => PROGRESS.includes(d.inv_type) },
      { k: 'rate', label: 'Rate', type: 'number', required: true },
      { k: 'prev_qty', label: 'Previous certified', type: 'ro', fmt: v => qty(v), show: d => PROGRESS.includes(d.inv_type) },
      { k: '_done', label: 'Dispatched to date', type: 'ro', virtual: true, fmt: v => v === undefined ? '' : qty(v), show: d => PROGRESS.includes(d.inv_type) && d.status !== 'POSTED' },
      { k: 'cum_qty', label: 'Cumulative to date', type: 'number', required: true, show: d => PROGRESS.includes(d.inv_type) },
      { k: 'cum_qty', label: 'Qty', type: 'number', required: true, show: d => !PROGRESS.includes(d.inv_type) },
      { k: 'amount', label: 'This progress claim', type: 'ro', fmt: (v, r) => money(lineAmt(r)) },
      { k: 'cert_cum_qty', label: 'Certified cum.', type: 'ro', fmt: (v, r) => v === null || v === undefined ? '' : qty(v), show: d => ['CERTIFIED', 'POSTED'].includes(d.status) && PROGRESS.includes(d.inv_type) },
      { k: 'cert_amount', label: 'Certified', type: 'ro', fmt: v => money(v), show: d => ['CERTIFIED', 'POSTED'].includes(d.status) && PROGRESS.includes(d.inv_type) },
      { k: 'account_id', label: 'Revenue account', type: 'ref', ref: 'gl_accounts', width: '200px', filter: r => !r.is_group && r.acc_type === 'INCOME',
        show: d => ['GENERAL', 'CREDIT_NOTE'].includes(d.inv_type) },
    ] }],
  validate(ctx) {
    if (PROGRESS.concat('ADVANCE', 'RETENTION_RELEASE').includes(ctx.doc.inv_type) && !ctx.doc.project_id) throw new Error('Choose the project');
    for (const r of ctx.grids.lines) if (r.contract_qty !== null && r.contract_qty !== undefined && num(r.cum_qty) > num(r.contract_qty) + 0.0005 && PROGRESS.includes(ctx.doc.inv_type))
      throw new Error(`"${r.description}": cumulative ${qty(r.cum_qty)} is more than the contract qty ${qty(r.contract_qty)} — raise a variation order first`);
  },
  totals: ctx => {
    const d = ctx.doc, gross = ctx.grids.lines.reduce((s, r) => s + lineAmt(r), 0);
    const out = [{ l: 'This progress claim (gross)', v: gross }];
    if (d.certified_gross !== null && d.certified_gross !== undefined) out.push({ l: 'Certified', v: num(d.certified_gross) });
    if (num(d.advance_recovery)) out.push({ l: `Advance recovery (${num(d.advance_recovery_pct)}%)`, v: -num(d.advance_recovery) });
    out.push({ l: `VAT ${num(d.vat_rate)}%`, v: num(d.vat_amount) });
    if (num(d.retention_amount)) out.push({ l: `Retention (${num(d.retention_pct)}%)`, v: -num(d.retention_amount) });
    out.push({ l: d.inv_type === 'CREDIT_NOTE' ? 'Credit total' : 'Amount due', v: num(d.total_amount) });
    return out;
  },
  async loadInfo(ctx) {
    const out = [];
    if (ctx.doc.status === 'POSTED') {
      const b = must(await sb.from('v_sales_invoice_balance').select('*').eq('invoice_id', ctx.doc.id));
      out.push({ title: 'Collection', rows: b, columns: [{ k: 'total_amount', label: 'Invoice', fmt: 'money' }, { k: 'allocated', label: 'Received', fmt: 'money' },
        { k: 'balance', label: 'Balance', fmt: 'money' }, { k: 'due_date', label: 'Due', fmt: 'date' }, { k: 'days_overdue', label: 'Days overdue', n: true }] });
    }
    if (ctx.doc.project_id) {
      const p = must(await sb.from('v_project_billing').select('*').eq('project_id', ctx.doc.project_id));
      if (p.length) out.push({ title: 'Project billing to date (posted)', rows: p, columns: [{ k: 'contract_value', label: 'Contract', fmt: 'money' },
        { k: 'earned_value', label: 'Dispatched (billable)', fmt: 'money' }, { k: 'certified_to_date', label: 'Certified', fmt: 'money' }, { k: 'billed_pct', label: 'Billed %', n: true },
        { k: 'advance_invoiced', label: 'Advance billed', fmt: 'money' }, { k: 'advance_recovered', label: 'Recovered', fmt: 'money' }, { k: 'retention_held', label: 'Retention held', fmt: 'money' },
        { k: 'outstanding', label: 'Outstanding', fmt: 'money' }] });
    }
    return out;
  },
  actions: ctx => {
    const s = ctx.doc.status, t = ctx.doc.inv_type, prog = PROGRESS.includes(t);
    return [
      { label: '⇩ Refill from dispatches', cls: 'primary', show: s === 'DRAFT' && prog && canBill(t) && !!ctx.doc.id,
        confirm: 'Replace the lines with the quantities dispatched to date (unit progress for unit-wise billing)?', done: 'Lines filled', run: c => rpc('si_fill', { p_inv: c.doc.id }) },
      { label: '⇩ Fill', cls: 'primary', show: s === 'DRAFT' && ['ADVANCE', 'RETENTION_RELEASE'].includes(t) && hasRole('finance', 'factory_manager'), done: 'Filled', run: c => rpc('si_fill', { p_inv: c.doc.id }) },
      { label: '📤 Submit progress claim to client', show: s === 'DRAFT' && prog && canBill(t), confirm: 'Mark this progress claim as submitted to the client / consultant?', done: 'Progress claim submitted — Finance records the payment certificate',
        run: c => rpc('si_action', { p_inv: c.doc.id, p_action: 'SUBMIT' }) },
      { label: '📜 Record payment certificate', cls: 'ok', show: s === 'SUBMITTED' && isFin(), done: 'Certificate recorded', run: c => certify(c) },
      { label: '✔ Post tax invoice', cls: 'ok', show: (isFin() || (hasRole('stores') && STORES_TYPES.includes(t))) && ((s === 'CERTIFIED') || (!prog && ['DRAFT', 'SUBMITTED'].includes(s))),
        confirm: 'Post this invoice? It goes to receivables, revenue and the VAT return and can then only be corrected by a credit note.', done: 'Invoice posted',
        run: c => rpc('si_action', { p_inv: c.doc.id, p_action: 'POST' }) },
      { label: '↩ Back to draft', show: ['SUBMITTED', 'CERTIFIED'].includes(s) && isFin(), confirm: 'Return this progress claim to draft (the certificate is cleared)?', run: c => rpc('si_action', { p_inv: c.doc.id, p_action: 'RETURN' }) },
      { label: '💰 Receive payment', show: s === 'POSTED' && t !== 'CREDIT_NOTE' && isFin(), reload: false, run: c => go(`d/rcv/new/customer/${c.doc.customer_id}/${c.doc.id}`) },
      { label: '➖ Credit note', show: s === 'POSTED' && t !== 'CREDIT_NOTE' && isFin(), reload: false, run: c => go(`d/si/new/credit/${c.doc.id}`) },
      { label: '🖨 ' + (s === 'POSTED' ? (t === 'CREDIT_NOTE' ? 'Tax credit note' : 'Tax invoice') : prog ? 'Payment application' : 'Proforma'), reload: false, run: c => siPdf(c) },
      { label: 'Cancel', show: (['DRAFT', 'SUBMITTED', 'CERTIFIED'].includes(s) && isFin()) || (['DRAFT', 'SUBMITTED'].includes(s) && hasRole('stores') && STORES_TYPES.includes(t)),
        confirm: 'Cancel this invoice?', run: c => rpc('si_action', { p_inv: c.doc.id, p_action: 'CANCEL' }) },
    ];
  },
};

async function certify(c) {
  const lines = c.grids.lines;
  // only lines claimed this period are asked; the rest (nothing claimed) are certified as they stand
  const claimed = lines.filter(l => Math.abs(num(l.cum_qty) - num(l.prev_qty)) > 0.0005);
  const fields = [{ k: 'cert_no', label: 'Certificate no. (client / consultant)', required: true }, { k: 'cert_date', label: 'Certificate date', type: 'date', default: today() }];
  if (claimed.length <= 40) claimed.forEach(l => fields.push({ k: 'l' + lines.indexOf(l), label: `${l.description} — certified cumulative (claimed ${qty(l.cum_qty)}, previous ${qty(l.prev_qty)})`, type: 'number', default: num(l.cum_qty) }));
  const v = await ask({ title: 'Payment certificate', message: `Enter the cumulative quantities the client certified. Leave as claimed if certified in full.` +
    (claimed.length < lines.length ? ` Showing the ${claimed.length} line(s) claimed this period; the other ${lines.length - claimed.length} have nothing claimed.` : ''), fields, okText: 'Record certificate' });
  if (!v) return false;
  const payload = { cert_no: v.cert_no, cert_date: v.cert_date };
  if (claimed.length <= 40) payload.lines = lines.map((l, i) => {
    const e = v['l' + i];
    return { id: l.id, cert_cum_qty: e === undefined || e === null || e === '' ? num(l.cum_qty) : num(e) };
  });
  return rpc('si_action', { p_inv: c.doc.id, p_action: 'CERTIFY', p_data: payload });
}

function siPdf(c) {
  const d = c.doc, cu = custOf(d.customer_id) || {}, p = refRow('projects', d.project_id), prog = PROGRESS.includes(d.inv_type), posted = d.status === 'POSTED';
  const cert = ['CERTIFIED', 'POSTED'].includes(d.status) && prog;
  const title = posted ? (d.inv_type === 'CREDIT_NOTE' ? 'Tax Credit Note' : 'Tax Invoice') : prog ? 'Interim Payment Application' : 'Proforma Invoice';
  const meta = [['Our TRN', state.company?.trn || ''], ['Project', p ? `${p.code} — ${p.name}` : ''],
    ['Type', label(d.inv_type)], ['Client ref', d.customer_ref || ''], ['Due date', dt(d.due_date)]];
  if (prog) meta.push(['Progress claim no.', d.claim_no || '-'], ['Work up to', dt(d.period_to) || '-'], ['Payment certificate', d.cert_no ? `${d.cert_no} (${dt(d.cert_date)})` : 'pending']);
  // progress claims print only the lines with a value this period (claimed, or certified once certified)
  const rows = prog ? c.grids.lines.filter(r => Math.abs(cert ? num(r.cert_amount) : lineAmt(r)) > 0.004) : c.grids.lines;
  const cols = prog
    ? [{ h: 'Sr. No.', k: r => rows.indexOf(r) + 1, w: 15 }, { h: 'Description', k: 'description', strong: true }, { h: 'UoM', k: 'uom' }, { h: 'Contract', k: r => qty(r.contract_qty), align: 'right' }, { h: 'Rate', k: r => money(r.rate), align: 'right' },
       { h: 'Previous', k: r => qty(r.prev_qty), align: 'right' }, { h: 'Cumulative', k: r => qty(cert ? (r.cert_cum_qty ?? r.cum_qty) : r.cum_qty), align: 'right' },
       { h: 'This period AED', k: r => money(cert ? r.cert_amount : lineAmt(r)), align: 'right' }]
    : [{ h: 'Sr. No.', k: r => c.grids.lines.indexOf(r) + 1, w: 15 }, { h: 'Description', k: 'description', strong: true }, { h: 'UoM', k: 'uom' }, { h: 'Qty', k: r => qty(r.cum_qty), align: 'right' }, { h: 'Rate', k: r => money(r.rate), align: 'right' },
       { h: 'Amount AED', k: r => money(lineAmt(r)), align: 'right' }];
  const base = d.certified_gross ?? d.gross_claimed;
  const totals = [[prog ? (cert ? 'Certified value this period' : 'Value claimed this period') : 'Subtotal', money(base)]];
  if (num(d.advance_recovery)) totals.push([`Less advance recovery ${num(d.advance_recovery_pct)}%`, '-' + money(d.advance_recovery)]);
  totals.push(['Taxable value', money(d.taxable_amount)], [`VAT ${num(d.vat_rate)}%`, money(d.vat_amount)], ['Total incl. VAT', money(num(d.taxable_amount) + num(d.vat_amount))]);
  if (num(d.retention_amount)) totals.push([`Less retention ${num(d.retention_pct)}%`, '-' + money(d.retention_amount)]);
  totals.push(['AMOUNT DUE (AED)', money(d.total_amount)]);
  return makePdf({ title, noLabel: posted ? (d.inv_type === 'CREDIT_NOTE' ? 'Credit Note No.' : 'Invoice No.') : 'Reference', no: d.inv_no, date: d.invoice_date,
    subtitle: posted ? '' : label(d.status), party: partyOf(cu), meta, columns: cols, rows, totals, landscape: prog, words: d.total_amount,
    notes: [d.remarks, posted ? 'Please remit to the bank account on file quoting the invoice number.' : ''].filter(Boolean).join('\n'),
    sign: { prepared: d.created_by, checked: d.certified_by || d.submitted_by, approved: posted,
            labels: prog && !posted ? ['Prepared By', 'Submitted By', 'Approved & Authorized Signatory'] : undefined },
    acceptance: prog && !posted ? '' : cu.name || '' });
}

// ======================================================================
// CUSTOMER RECEIPT
// ======================================================================
const invInfo = x => x ? { _due: x.due_date, _total: num(x.total_amount), _recd: num(x.allocated), _bal: num(x.balance) } : { _due: null, _total: undefined, _recd: undefined, _bal: undefined };
// a draft receipt lists every open invoice of the customer (of the project, when chosen) with its balance; receive in full or in part
function openInvoices(ctx) {
  if (ctx.doc.id && ctx.doc.status !== 'DRAFT') return;
  const pj = ctx.doc.project_id;
  ctx.grids.alloc = ctx.grids.alloc.filter(a => {
    if (num(a.amount) > 0 || !fopts.invs.some(o => o.id === a.invoice_id)) return true;
    if (a.id) (ctx.removed.alloc ||= []).push(a.id);
    return false;
  });
  for (const a of ctx.grids.alloc) { const o = fopts.invs.find(x => x.id === a.invoice_id); if (o) Object.assign(a, invInfo(o.row), { _full: Math.abs(num(a.amount) - num(o.row.balance)) < 0.005 }); }
  for (const o of fopts.invs) {
    if (num(o.row.balance) <= 0.005 || (pj && o.row.project_id !== pj) || ctx.grids.alloc.some(a => a.invoice_id === o.id)) continue;
    ctx.grids.alloc.push({ invoice_id: o.id, amount: 0, _full: false, ...invInfo(o.row) });
  }
  const due = id => fopts.invs.find(o => o.id === id)?.row.due_date || '';
  ctx.grids.alloc.sort((a, b) => String(due(a.invoice_id)).localeCompare(String(due(b.invoice_id))));
}
// Amount AED follows what is ticked / typed against the invoices
function rcvSync(ctx) { ctx.doc.amount = Math.round(ctx.grids.alloc.reduce((s, r) => s + num(r.amount), 0) * 100) / 100; ctx.dirty = true; }

export const rcv = {
  key: 'rcv', title: 'Customer Receipts', single: 'Receipt', table: 'customer_receipts', noField: 'receipt_no', dateField: 'receipt_date',
  statuses: ['DRAFT', 'POSTED', 'CLEARED', 'BOUNCED', 'CANCELLED'], createRoles: ['finance'], refs: ['customers', 'projects'],
  list: { select: '*, customers(name), projects(code)', columns: [{ k: r => r.customers?.name, label: 'Customer' }, { k: r => r.projects?.code, label: 'Project' },
    { k: 'mode', label: 'Mode', fmt: 'label' }, { k: 'reference_no', label: 'Ref / cheque' }, { k: 'cheque_date', label: 'Cheque date', fmt: 'date' }, { k: 'amount', label: 'Amount AED', fmt: 'money', sum: true }] },
  defaults: () => ({ receipt_date: today(), mode: 'BANK_TRANSFER' }),
  // from an invoice's "Receive payment": that invoice is ticked in full
  async onNew(ctx, parts) {
    if (parts[0] !== 'customer' || !parts[1]) return;
    ctx.doc.customer_id = parts[1];
    await loadCustInvoices(parts[1]);
    openInvoices(ctx);
    const r = parts[2] && ctx.grids.alloc.find(a => a.invoice_id === parts[2]);
    if (r) { r._full = true; r.amount = r._bal; rcvSync(ctx); }
  },
  async afterLoad(ctx) { await loadCustInvoices(ctx.doc.customer_id); openInvoices(ctx); },
  header: [
    { k: 'customer_id', label: 'Customer', type: 'ref', ref: 'customers', required: true, wide: true,
      onChange: async (d, v, ctx) => { ctx.grids.alloc.forEach(a => { if (a.id) (ctx.removed.alloc ||= []).push(a.id); }); ctx.grids.alloc = []; await loadCustInvoices(v); openInvoices(ctx); rcvSync(ctx); } },
    { k: 'receipt_date', label: 'Date received', type: 'date', required: true },
    { k: 'project_id', label: 'Project (optional)', type: 'ref', ref: 'projects', filter: (r, d) => !d.customer_id || r.customer_id === d.customer_id,
      onChange: (d, v, ctx) => { openInvoices(ctx); rcvSync(ctx); } },
    { k: 'mode', label: 'Mode', type: 'select', required: true, options: ['BANK_TRANSFER', 'CHEQUE', 'PDC', 'CASH'] },
    { k: 'bank_name', label: 'Drawn on bank', type: 'lookup', list: 'BANK' }, { k: 'reference_no', label: 'Cheque / transfer ref' },
    { k: 'cheque_date', label: 'Cheque date', type: 'date', show: d => ['CHEQUE', 'PDC'].includes(d.mode) },
    { k: 'amount', label: 'Amount AED', type: 'number', required: true },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  headerNote: () => 'Every open invoice of the customer is listed: tick <b>Full</b> to receive the whole balance, or type a part amount in <b>Receive now</b>. Amount AED follows the ticks — raise it for money kept on account. '
    + 'Cheques and PDCs sit in <b>cheques in hand</b> until you mark them <b>cleared</b> (moved to the bank). A returned cheque reverses the receipt and re-opens the invoices.',
  grids: [{ key: 'alloc', title: 'Allocation to invoices', table: 'receipt_allocations', fk: 'receipt_id', lineNo: false,
    importers: [{ label: '⚡ Auto-allocate Amount AED (oldest due first)', show: ctx => ctx.doc.status === 'DRAFT' || !ctx.doc.id, run: ctx => {
      if (!(num(ctx.doc.amount) > 0)) throw new Error('Enter Amount AED first');
      let left = num(ctx.doc.amount);
      for (const r of ctx.grids.alloc) {
        const amt = Math.max(Math.min(left, r._bal ?? num(r.amount)), 0);
        r.amount = Math.round(amt * 100) / 100; r._full = r._bal !== undefined && Math.abs(r.amount - r._bal) < 0.005; left -= amt;
      }
      ctx.dirty = true;
    } }],
    fields: [
      { k: 'invoice_id', label: 'Invoice', type: 'ref', refOptions: () => fopts.invs, required: true, width: '300px', ro: r => r._bal !== undefined,
        onChange: (r, v, ctx) => { const o = fopts.invs.find(x => x.id === v); Object.assign(r, invInfo(o?.row)); } },
      { k: '_due', label: 'Due', type: 'ro', virtual: true, fmt: v => dt(v), show: d => d.status === 'DRAFT' || !d.id },
      { k: '_total', label: 'Invoice total', type: 'ro', virtual: true, fmt: v => v === undefined ? '' : money(v), show: d => d.status === 'DRAFT' || !d.id },
      { k: '_recd', label: 'Received before', type: 'ro', virtual: true, fmt: v => v === undefined ? '' : money(v), show: d => d.status === 'DRAFT' || !d.id },
      { k: '_bal', label: 'Balance due', type: 'ro', virtual: true, fmt: v => v === undefined ? '' : money(v), show: d => d.status === 'DRAFT' || !d.id },
      { k: '_full', label: 'Full', type: 'check', virtual: true, width: '60px', show: d => d.status === 'DRAFT' || !d.id,
        onChange: (r, v, ctx) => { r.amount = v ? num(r._bal) : 0; rcvSync(ctx); } },
      { k: 'amount', label: 'Receive now (AED)', type: 'number', required: true,
        onChange: (r, v, ctx) => { r._full = r._bal !== undefined && Math.abs(num(v) - r._bal) < 0.005; rcvSync(ctx); } }] }],
  validate(ctx) {
    const a = ctx.grids.alloc;
    for (const r of a) {
      const o = fopts.invs.find(x => x.id === r.invoice_id);
      if (num(r.amount) < 0) throw new Error(`${o?.row.inv_no || 'Invoice'}: amount cannot be negative`);
      if (r._bal !== undefined && num(r.amount) > r._bal + 0.005) throw new Error(`${o?.row.inv_no || 'Invoice'}: ${money(r.amount)} is more than the balance due ${money(r._bal)}`);
    }
    if (a.reduce((s, r) => s + num(r.amount), 0) > num(ctx.doc.amount) + 0.005) throw new Error('Allocated amount exceeds the receipt');
    // invoices not received against are not saved
    ctx.grids.alloc = a.filter(r => { if (num(r.amount) > 0) return true; if (r.id) (ctx.removed.alloc ||= []).push(r.id); return false; });
  },
  totals: ctx => { const a = ctx.grids.alloc.reduce((s, r) => s + num(r.amount), 0); return [{ l: 'Received', v: num(ctx.doc.amount) }, { l: 'Allocated', v: a }, { l: 'On account', v: num(ctx.doc.amount) - a }]; },
  actions: ctx => {
    const s = ctx.doc.status, chq = ['CHEQUE', 'PDC'].includes(ctx.doc.mode);
    return [
      { label: '✔ Post receipt', cls: 'ok', show: s === 'DRAFT' && isFin(), confirm: 'Post this receipt?', done: 'Receipt posted', run: c => rpc('receipt_action', { p_rcpt: c.doc.id, p_action: 'POST' }) },
      { label: '🏦 Cheque cleared', cls: 'ok', show: s === 'POSTED' && chq && isFin(), confirm: 'The cheque has been credited to the bank?', done: 'Cleared', run: c => rpc('receipt_action', { p_rcpt: c.doc.id, p_action: 'CLEAR' }) },
      { label: '⚠ Cheque returned', cls: 'bad', show: ['POSTED', 'CLEARED'].includes(s) && chq && isFin(), confirm: 'Mark the cheque as returned unpaid? The receipt is reversed and the invoices re-open.', danger: true,
        done: 'Cheque marked returned', run: c => rpc('receipt_action', { p_rcpt: c.doc.id, p_action: 'BOUNCE' }) },
      { label: '🖨 Receipt voucher', reload: false, run: c => makePdf({ title: 'Receipt Voucher', no: c.doc.receipt_no, date: c.doc.receipt_date, subtitle: label(c.doc.status),
          meta: [['Received from', refLabel('customers', c.doc.customer_id)], ['Mode', label(c.doc.mode)], ['Bank', c.doc.bank_name || '-'], ['Reference', c.doc.reference_no || '-'],
                 ['Cheque date', dt(c.doc.cheque_date) || '-'], ['Amount AED', money(c.doc.amount)]],
          columns: [{ h: 'Invoice', k: r => fopts.invs.find(o => o.id === r.invoice_id)?.row.inv_no || '' }, { h: 'Allocated AED', k: r => money(r.amount), align: 'right' }],
          rows: c.grids.alloc, totals: rcv.totals(c).map(t => [t.l, money(t.v)]), notes: c.doc.remarks || '', signatures: ['Received by', 'Finance Manager'] }) },
      { label: 'Cancel', show: s === 'DRAFT' && isFin(), confirm: 'Cancel this draft receipt?', run: c => rpc('receipt_action', { p_rcpt: c.doc.id, p_action: 'CANCEL' }) },
    ];
  },
};

// ======================================================================
// JOURNAL VOUCHER (manual) — also opens any system journal read-only
// ======================================================================
export const jv = {
  key: 'jv', title: 'Journals', single: 'Journal Voucher', table: 'journal_entries', noField: 'je_no', dateField: 'je_date',
  statuses: ['DRAFT', 'POSTED', 'REVERSED'], createRoles: ['finance'], refs: ['gl_accounts', 'projects', 'cost_centers', 'customers', 'vendors', 'employees'],
  list: { select: '*', columns: [{ k: 'source', label: 'Source', fmt: 'label' }, { k: 'doc_no', label: 'Document' }, { k: 'narration', label: 'Narration' }, { k: 'total', label: 'Amount', fmt: 'money' }] },
  canEdit: ctx => ctx.doc && (ctx.doc.source || 'MANUAL') === 'MANUAL' && (ctx.doc.status || 'DRAFT') === 'DRAFT' && isFin(),
  header: [
    { k: 'je_date', label: 'Date', type: 'date', required: true },
    { k: 'narration', label: 'Narration', required: true, full: true },
    { k: 'project_id', label: 'Project (optional)', type: 'ref', ref: 'projects' },
    { k: 'source', label: 'Source', type: 'ro', fmt: v => label(v || 'MANUAL'), show: d => !!d.id },
    { k: 'doc_no', label: 'Source document', type: 'ro', show: d => !!d.doc_no },
  ],
  defaults: () => ({ je_date: today() }),
  headerNote: ctx => (ctx.doc.source || 'MANUAL') === 'MANUAL' ? 'Use journals for opening balances, accruals, bank charges, owner\'s capital, corrections. Debits must equal credits. Posted journals are corrected by reversing.'
    : 'Posted automatically from the source document — reverse it here only to correct the ledger.',
  grids: [{ key: 'lines', title: 'Entries', table: 'journal_lines', fk: 'je_id', order: 'line_no',
    newRow: () => ({ debit: 0, credit: 0 }),
    fields: [
      { k: 'account_id', label: 'Account', type: 'ref', ref: 'gl_accounts', required: true, width: '240px', filter: r => !r.is_group && r.is_active },
      { k: 'debit', label: 'Debit', type: 'number' }, { k: 'credit', label: 'Credit', type: 'number' },
      { k: 'project_id', label: 'Project', type: 'ref', ref: 'projects', width: '150px' }, { k: 'cost_center_id', label: 'Cost centre', type: 'ref', ref: 'cost_centers', width: '130px' },
      { k: 'customer_id', label: 'Customer', type: 'ref', ref: 'customers', width: '150px' }, { k: 'vendor_id', label: 'Vendor', type: 'ref', ref: 'vendors', width: '150px' },
      { k: 'memo', label: 'Memo', width: '160px' }] }],
  validate(ctx) {
    for (const r of ctx.grids.lines) { r.debit = num(r.debit); r.credit = num(r.credit); if (r.debit && r.credit) throw new Error('A line has both a debit and a credit — split it'); }
  },
  totals: ctx => { const d = ctx.grids.lines.reduce((s, r) => s + num(r.debit), 0), c = ctx.grids.lines.reduce((s, r) => s + num(r.credit), 0); return [{ l: 'Debits', v: d }, { l: 'Credits', v: c }, { l: 'Difference', v: d - c }]; },
  actions: ctx => [
    { label: '✔ Post journal', cls: 'ok', show: statusIs(ctx, 'DRAFT') && isFin(), confirm: 'Post this journal to the ledger?', done: 'Journal posted', run: c => rpc('jv_action', { p_je: c.doc.id, p_action: 'POST' }) },
    { label: '↺ Reverse', cls: 'bad', show: statusIs(ctx, 'POSTED') && isFin(), confirm: 'Post a reversing journal dated today (or the first open day)?', done: 'Reversed', run: c => rpc('jv_action', { p_je: c.doc.id, p_action: 'REVERSE' }) },
    { label: '🖨 Journal voucher', reload: false, run: c => makePdf({ title: 'Journal Voucher', no: c.doc.je_no, date: c.doc.je_date, subtitle: label(c.doc.status),
        meta: [['Narration', c.doc.narration || ''], ['Source', label(c.doc.source)], ['Document', c.doc.doc_no || '-']],
        columns: [{ h: 'Account', k: r => refLabel('gl_accounts', r.account_id) }, { h: 'Project', k: r => refRow('projects', r.project_id)?.code || '' }, { h: 'Memo', k: r => r.memo || '' },
          { h: 'Debit', k: r => num(r.debit) ? money(r.debit) : '', align: 'right' }, { h: 'Credit', k: r => num(r.credit) ? money(r.credit) : '', align: 'right' }],
        rows: c.grids.lines, totals: jv.totals(c).map(t => [t.l, money(t.v)]), signatures: ['Prepared by', 'Finance Manager', 'Approved by'] }) },
  ],
};

export const FIN_DOCS = { si, rcv, jv };

// ======================================================================
// BOOKS
// ======================================================================
const TABS = [['tb', 'Trial balance'], ['pl', 'Profit & loss'], ['bs', 'Balance sheet'], ['ledger', 'Ledger & bank reconciliation'], ['vat', 'VAT return (201)'],
  ['aging', 'Receivables aging'], ['stmt', 'Customer statement'], ['billing', 'Project billing'], ['periods', 'Period close']];
const typeSign = t => ['ASSET', 'EXPENSE'].includes(t) ? 1 : -1;

export const Books = {
  components: { DataTable, FieldInput, Badge },
  // only: one tab on its own, without the accounting tabs (Dispatch & invoicing → Billable now)
  props: { tab: String, arg: String, only: Boolean },
  data: () => ({ f: { from: yearStart(), to: today(), account_id: null, project_id: null, customer_id: null }, rows: [], loading: false, sel: {}, periods: [], syncing: false }),
  computed: {
    // the warehouse sees only project billing (what can be claimed); the books stay with Finance
    TABS() { return this.only ? [] : hasRole('finance', 'factory_manager') ? TABS : TABS.filter(([k]) => k === 'billing'); },
    t() { return this.only ? this.tab : hasRole('finance', 'factory_manager') ? (this.tab || 'tb') : 'billing'; },
    isFin,
    acct() { return refRow('gl_accounts', this.f.account_id); },
    reconcilable() { const a = this.acct; return !!a && (a.is_bank || ['CASH', 'PDC_RECEIVED', 'PDC_ISSUED'].includes(a.system_key)); },
    tbTotals() { return { dr: this.rows.reduce((s, r) => s + num(r.debit), 0), cr: this.rows.reduce((s, r) => s + num(r.credit), 0), cl: this.rows.reduce((s, r) => s + num(r.closing), 0) }; },
    pl() {
      const mv = r => num(r.debit) - num(r.credit);
      const inc = this.rows.filter(r => r.acc_type === 'INCOME').map(r => ({ ...r, amt: -mv(r) }));
      const cos = this.rows.filter(r => r.acc_type === 'EXPENSE' && r.code.startsWith('5')).map(r => ({ ...r, amt: mv(r) }));
      const opx = this.rows.filter(r => r.acc_type === 'EXPENSE' && !r.code.startsWith('5')).map(r => ({ ...r, amt: mv(r) }));
      const s = a => a.reduce((x, r) => x + r.amt, 0);
      return { inc, cos, opx, ti: s(inc), tc: s(cos), to: s(opx), gp: s(inc) - s(cos), np: s(inc) - s(cos) - s(opx) };
    },
    bs() {
      const pick = t => this.rows.filter(r => r.acc_type === t).map(r => ({ ...r, amt: num(r.closing) * typeSign(t) })).filter(r => Math.abs(r.amt) > 0.005);
      const s = a => a.reduce((x, r) => x + r.amt, 0);
      const earn = -this.rows.filter(r => ['INCOME', 'EXPENSE'].includes(r.acc_type)).reduce((x, r) => x + num(r.closing), 0);
      const a = pick('ASSET'), l = pick('LIABILITY'), e = pick('EQUITY');
      return { a, l, e, ta: s(a), tl: s(l), te: s(e) + earn, earn };
    },
    selIds() { return Object.keys(this.sel).filter(k => this.sel[k]); },
    recon() {
      const rows = this.rows.filter(r => r.line_id);
      const recd = rows.filter(r => r.reconciled).reduce((s, r) => s + num(r.debit) - num(r.credit), 0);
      return { unrec: rows.filter(r => !r.reconciled).length, recBal: recd };
    },
  },
  watch: { tab() { this.rows = []; this.load(); } },
  async mounted() {
    await loadRefs(['gl_accounts', 'projects', 'customers']);
    if (this.t === 'ledger' && this.arg) this.f.account_id = this.arg;
    if (this.t === 'stmt' && this.arg) this.f.customer_id = this.arg;
    if (this.t === 'ledger' && !this.f.account_id) this.f.account_id = (state.refs.gl_accounts || []).find(a => a.system_key === 'BANK')?.id || null;
    await this.load();
  },
  methods: {
    money, dt, label, num,
    nav(t, arg) { go('books/' + t + (arg ? '/' + arg : '')); },
    async load() {
      this.loading = true; this.sel = {};
      await run(async () => {
        const f = this.f;
        if (this.t === 'tb' || this.t === 'pl') this.rows = must(await sb.rpc('gl_trial_balance', { p_from: f.from, p_to: f.to }));
        else if (this.t === 'bs') this.rows = must(await sb.rpc('gl_trial_balance', { p_from: '1900-01-01', p_to: f.to }));
        else if (this.t === 'ledger') this.rows = f.account_id ? must(await sb.rpc('gl_ledger', { p_account: f.account_id, p_from: f.from, p_to: f.to, p_project: f.project_id || null })) : [];
        else if (this.t === 'vat') this.rows = must(await sb.rpc('vat_return', { p_from: f.from, p_to: f.to }));
        else if (this.t === 'aging') this.rows = must(await sb.from('v_ar_aging').select('*').order('balance', { ascending: false }));
        else if (this.t === 'stmt') this.rows = f.customer_id ? must(await sb.rpc('customer_statement', { p_customer: f.customer_id, p_from: f.from, p_to: f.to })) : [];
        else if (this.t === 'billing') {
          // billable now = progress earned but not yet in a submitted / certified / posted claim
          const [rows, bl] = await Promise.all([sb.from('v_project_billing').select('*').order('project_code'), sb.from('v_project_billable').select('project_id,billable,has_draft')]);
          const by = Object.fromEntries(must(bl).map(b => [b.project_id, b]));
          this.rows = must(rows).map(r => ({ ...r, billable_now: by[r.project_id]?.billable ?? null, has_draft: !!by[r.project_id]?.has_draft }));
        }
        else if (this.t === 'periods') await this.loadPeriods();
      });
      this.loading = false;
    },
    async loadPeriods() {
      const p = must(await sb.from('gl_periods').select('*'));
      const by = Object.fromEntries(p.map(x => [x.period_month, x]));
      const out = []; const d = new Date(today().slice(0, 7) + '-01T00:00:00');
      for (let i = 0; i < 15; i++) {
        const m = new Date(d.getFullYear(), d.getMonth() - i, 1); const k = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-01`;
        out.push({ period_month: k, name: m.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), status: by[k]?.status || 'OPEN', month_end_done: !!by[k]?.month_end_done, closed_at: by[k]?.closed_at });
      }
      this.periods = out;
    },
    async sync() {
      this.syncing = true;
      await run(async () => { const n = await rpc('gl_sync', {}); toast(n ? `${n} journal(s) posted from documents` : 'Ledger is up to date', 'ok'); });
      this.syncing = false; await this.load();
    },
    async monthEnd(p) {
      if (!(await confirmBox('Month end', `Post depreciation and the gratuity / leave-salary provision true-up for ${p.name}, and run the provisions & accruals you have set to automate?`))) return;
      await run(async () => { const r = await rpc('gl_month_end', { p_month: p.period_month });
        const names = { ACCRUALS: 'accruals suggested', PREPAYMENTS: 'prepayment releases', DOUBTFUL: 'doubtful debts adj.', SLOW_STOCK: 'slow stock adj.', WARRANTY: 'warranty adj.', ACCRUED_REVENUE: 'unbilled work adj.' };
        const auto = Object.entries(r.automated || {}).map(([k, v]) => `${names[k] || k} ${['ACCRUALS', 'PREPAYMENTS'].includes(k) ? v : money(v)}`).join(' · ');
        toast(`Depreciation ${money(r.depreciation)} · gratuity provision ${money(r.gratuity_provision)} · leave provision ${money(r.leave_provision)}${auto ? ' · ' + auto : ''}`, 'ok', 10000); });
      await this.load();
    },
    async closeP(p, close) {
      if (!(await confirmBox(close ? 'Close period' : 'Reopen period', close ? `Close ${p.name}? Nothing more can be posted into it; later documents post to the next open day.` : `Reopen ${p.name}?`, !close))) return;
      await run(() => rpc('gl_close_period', { p_month: p.period_month, p_close: close }), close ? 'Period closed' : 'Period reopened');
      await this.load();
    },
    async reconcile(flag) {
      if (!this.selIds.length) return;
      await run(() => rpc('gl_reconcile', { p_lines: this.selIds, p_reconciled: flag, p_date: today() }), flag ? 'Marked as on the bank statement' : 'Unmarked');
      await this.load();
    },
    openJe(r) { if (r.je_id) go('d/jv/' + r.je_id); },
    stmtPdf() {
      const c = custOf(this.f.customer_id) || {};
      return makePdf({ title: 'Statement of Account', no: c.code, date: this.f.to, subtitle: `${dt(this.f.from)} – ${dt(this.f.to)}`,
        meta: [['Customer', c.name], ['TRN', c.trn || '-'], ['Address', c.address || '-']],
        columns: [{ h: 'Date', k: r => dt(r.txn_date) }, { h: 'Document', k: r => r.doc_no || '' }, { h: 'Details', k: r => r.details || '' },
          { h: 'Debit', k: r => num(r.debit) ? money(r.debit) : '', align: 'right' }, { h: 'Credit', k: r => num(r.credit) ? money(r.credit) : '', align: 'right' }, { h: 'Balance', k: r => money(r.balance), align: 'right' }],
        rows: this.rows, totals: [['Balance due AED', money(this.rows.at(-1)?.balance)]], signatures: [] });
    },
    tbPdf() {
      return makePdf({ title: 'Trial Balance', no: '', date: this.f.to, subtitle: `${dt(this.f.from)} – ${dt(this.f.to)}`,
        columns: [{ h: 'Code', k: 'code' }, { h: 'Account', k: 'name' }, { h: 'Opening', k: r => money(r.opening), align: 'right' }, { h: 'Debit', k: r => money(r.debit), align: 'right' },
          { h: 'Credit', k: r => money(r.credit), align: 'right' }, { h: 'Closing Dr / (Cr)', k: r => money(r.closing), align: 'right' }],
        rows: this.rows, totals: [['Debits', money(this.tbTotals.dr)], ['Credits', money(this.tbTotals.cr)]], signatures: [] });
    },
  },
  template: `<div>
    <div class="tabs" v-if="TABS.length > 1">
      <a v-for="[k, n] in TABS" href="javascript:void 0" :class="{on: t===k}" @click="nav(k)">{{ n }}</a>
    </div>
    <div class="card" v-if="t !== 'periods' && t !== 'aging' && t !== 'billing'">
      <div class="row" style="flex-wrap:wrap;gap:10px;align-items:flex-end">
        <label class="f" v-if="t !== 'bs'">From<input type="date" v-model="f.from"></label>
        <label class="f">{{ t === 'bs' ? 'As at' : 'To' }}<input type="date" v-model="f.to"></label>
        <FieldInput v-if="t==='ledger'" :f="{k:'account_id', label:'Account', type:'ref', ref:'gl_accounts', wide:true, filter: r => !r.is_group}" :doc="f" @changed="load" />
        <FieldInput v-if="t==='ledger'" :f="{k:'project_id', label:'Project (optional)', type:'ref', ref:'projects'}" :doc="f" @changed="load" />
        <FieldInput v-if="t==='stmt'" :f="{k:'customer_id', label:'Customer', type:'ref', ref:'customers', wide:true}" :doc="f" @changed="load" />
        <button class="btn primary" @click="load">Show</button>
        <span class="spacer"></span>
        <button v-if="isFin" class="btn" :disabled="syncing" @click="sync">⟳ Post pending documents</button>
        <button v-if="t==='tb' && rows.length" class="btn" @click="tbPdf">🖨 PDF</button>
        <button v-if="t==='stmt' && rows.length" class="btn" @click="stmtPdf">🖨 Statement PDF</button>
      </div>
    </div>

    <div class="card" v-if="t==='tb'">
      <DataTable :columns="[{k:'code',label:'Code'},{k:'name',label:'Account'},{k:'acc_type',label:'Type',fmt:'label'},{k:'opening',label:'Opening Dr/(Cr)',fmt:'money'},
        {k:'debit',label:'Debit',fmt:'money',sum:true},{k:'credit',label:'Credit',fmt:'money',sum:true},{k:'closing',label:'Closing Dr/(Cr)',fmt:'money',sum:true}]"
        :rows="rows" :loading="loading" clickable @row="r => { f.account_id = r.account_id; nav('ledger', r.account_id); }" filename="trial-balance" />
      <div class="small" :style="{marginTop:'8px', color: Math.abs(tbTotals.cl) > 0.01 ? '#b91c1c' : ''}">
        {{ Math.abs(tbTotals.cl) > 0.01 ? '⚠ Out of balance by ' + money(tbTotals.cl) : '✔ Debits equal credits' }} · click an account for its ledger</div>
    </div>

    <div class="card" v-if="t==='pl'">
      <table class="t fin">
        <tr class="h"><td colspan="2">Revenue</td></tr>
        <tr v-for="r in pl.inc"><td>{{ r.code }} {{ r.name }}</td><td class="n">{{ money(r.amt) }}</td></tr>
        <tr class="s"><td>Total revenue</td><td class="n">{{ money(pl.ti) }}</td></tr>
        <tr class="h"><td colspan="2">Cost of sales</td></tr>
        <tr v-for="r in pl.cos"><td>{{ r.code }} {{ r.name }}</td><td class="n">{{ money(r.amt) }}</td></tr>
        <tr class="s"><td>Total cost of sales</td><td class="n">{{ money(pl.tc) }}</td></tr>
        <tr class="g"><td>GROSS PROFIT <span class="muted small" v-if="pl.ti">({{ (pl.gp / pl.ti * 100).toFixed(1) }}%)</span></td><td class="n">{{ money(pl.gp) }}</td></tr>
        <tr class="h"><td colspan="2">Operating expenses</td></tr>
        <tr v-for="r in pl.opx"><td>{{ r.code }} {{ r.name }}</td><td class="n">{{ money(r.amt) }}</td></tr>
        <tr class="s"><td>Total operating expenses</td><td class="n">{{ money(pl.to) }}</td></tr>
        <tr class="g"><td>NET PROFIT / (LOSS)</td><td class="n">{{ money(pl.np) }}</td></tr>
      </table>
      <p class="small muted">Production labour and overhead are absorbed into work in progress (shown as a credit under cost of sales) and reach cost of goods when finished goods are delivered.</p>
    </div>

    <div class="card" v-if="t==='bs'">
      <table class="t fin">
        <tr class="h"><td colspan="2">Assets</td></tr>
        <tr v-for="r in bs.a"><td>{{ r.code }} {{ r.name }}</td><td class="n">{{ money(r.amt) }}</td></tr>
        <tr class="g"><td>TOTAL ASSETS</td><td class="n">{{ money(bs.ta) }}</td></tr>
        <tr class="h"><td colspan="2">Liabilities</td></tr>
        <tr v-for="r in bs.l"><td>{{ r.code }} {{ r.name }}</td><td class="n">{{ money(r.amt) }}</td></tr>
        <tr class="s"><td>Total liabilities</td><td class="n">{{ money(bs.tl) }}</td></tr>
        <tr class="h"><td colspan="2">Equity</td></tr>
        <tr v-for="r in bs.e"><td>{{ r.code }} {{ r.name }}</td><td class="n">{{ money(r.amt) }}</td></tr>
        <tr><td>Profit / (loss) not yet closed to retained earnings</td><td class="n">{{ money(bs.earn) }}</td></tr>
        <tr class="s"><td>Total equity</td><td class="n">{{ money(bs.te) }}</td></tr>
        <tr class="g"><td>TOTAL LIABILITIES & EQUITY</td><td class="n">{{ money(bs.tl + bs.te) }}</td></tr>
      </table>
      <div class="small" v-if="Math.abs(bs.ta - bs.tl - bs.te) > 0.01" style="color:#b91c1c">⚠ Difference {{ money(bs.ta - bs.tl - bs.te) }}</div>
    </div>

    <div class="card" v-if="t==='ledger'">
      <div class="row" v-if="reconcilable && isFin" style="margin-bottom:8px">
        <span class="small muted">Tick the entries that appear on the bank statement. Unreconciled: <b>{{ recon.unrec }}</b> · reconciled movement in view: <b>{{ money(recon.recBal) }}</b></span>
        <span class="spacer"></span>
        <button class="btn sm ok" :disabled="!selIds.length" @click="reconcile(true)">✔ On statement ({{ selIds.length }})</button>
        <button class="btn sm" :disabled="!selIds.length" @click="reconcile(false)">Unmark</button>
      </div>
      <div class="tbl-wrap"><table class="t">
        <thead><tr><th v-if="reconcilable"></th><th>Date</th><th>Journal</th><th>Source</th><th>Document</th><th>Narration</th><th>Project</th><th class="n">Debit</th><th class="n">Credit</th><th class="n">Balance</th></tr></thead>
        <tbody>
          <tr v-if="loading"><td colspan="10" class="empty">Loading…</td></tr>
          <tr v-else-if="!rows.length"><td colspan="10" class="empty">Choose an account</td></tr>
          <tr v-for="r in rows" :key="r.line_id || 'ob'" :class="{click: !!r.je_id}">
            <td v-if="reconcilable"><input v-if="r.line_id" type="checkbox" v-model="sel[r.line_id]" :title="r.reconciled ? 'Reconciled' : ''"><span v-if="r.reconciled" class="small" style="color:var(--ok)"> ✔</span></td>
            <td @click="openJe(r)">{{ dt(r.je_date) }}</td><td @click="openJe(r)">{{ r.je_no }}</td><td @click="openJe(r)">{{ label(r.source) }}</td><td>{{ r.doc_no }}</td>
            <td @click="openJe(r)">{{ r.narration }}<span v-if="r.memo" class="muted small"> · {{ r.memo }}</span></td><td>{{ r.project_code }}</td>
            <td class="n">{{ num(r.debit) ? money(r.debit) : '' }}</td><td class="n">{{ num(r.credit) ? money(r.credit) : '' }}</td><td class="n"><b>{{ money(r.balance) }}</b></td>
          </tr>
        </tbody>
      </table></div>
    </div>

    <div class="card" v-if="t==='vat'">
      <DataTable :columns="[{k:'box',label:'Box'},{k:'description',label:'Description'},{k:'amount',label:'Amount AED',fmt:'money'},{k:'vat',label:'VAT AED',fmt:'money'},{k:'adjustment',label:'Adjustment',fmt:'money'}]"
        :rows="rows" :loading="loading" :searchable="false" />
      <p class="small muted">Box 1 is reported in the company's emirate (Settings). Retention releases carry no VAT (taxed on the original progress claims). Box 3 / 10: services and goods from overseas suppliers
        invoiced without VAT (reverse charge). Imports cleared through customs (box 6) are entered from the customs declaration. Check against the ledger: VAT payable (2200) and VAT recoverable (1450).</p>
    </div>

    <div class="card" v-if="t==='aging'">
      <DataTable :columns="[{k:'customer_name',label:'Customer'},{k:'not_due',label:'Not due',fmt:'money',sum:true},{k:'d1_30',label:'1–30',fmt:'money',sum:true},{k:'d31_60',label:'31–60',fmt:'money',sum:true},
        {k:'d61_90',label:'61–90',fmt:'money',sum:true},{k:'d90_plus',label:'90+',fmt:'money',sum:true},{k:'balance',label:'Balance',fmt:'money',sum:true},{k:'unallocated_receipts',label:'Unallocated receipts',fmt:'money',sum:true}]"
        :rows="rows" :loading="loading" clickable @row="r => { f.customer_id = r.customer_id; nav('stmt', r.customer_id); }" filename="ar-aging" />
      <p class="small muted">Retention receivable is not in the aging until a retention release invoice is raised. Click a customer for the statement.</p>
    </div>

    <div class="card" v-if="t==='stmt'">
      <DataTable :columns="[{k:'txn_date',label:'Date',fmt:'date'},{k:'doc_no',label:'Document'},{k:'doc_type',label:'Type',fmt:'label'},{k:'details',label:'Details'},
        {k:'debit',label:'Debit',fmt:'money'},{k:'credit',label:'Credit',fmt:'money'},{k:'balance',label:'Balance',fmt:'money'}]" :rows="rows" :loading="loading" :searchable="false" />
    </div>

    <div class="card" v-if="t==='billing'">
      <DataTable :columns="[{k:'project_code',label:'Project'},{k:'project_name',label:'Name'},{k:'customer_name',label:'Customer'},{k:'contract_value',label:'Contract',fmt:'money',sum:true},
        {k:'earned_value',label:'Dispatched (billable)',fmt:'money',sum:true},{k:'certified_to_date',label:'Certified',fmt:'money',sum:true},{k:'billed_pct',label:'Billed %',n:true},
        {k: r => num(r.earned_value) - num(r.certified_to_date), label:'Unbilled work',fmt:'money',sum:true},
        {k:'billable_now',label:'Billable now (not yet in a progress claim)',fmt:'money',sum:true},{k: r => r.has_draft ? 'Progress claim drafted' : '', label:'Progress claim', fmt:'badge'},
        {k:'advance_invoiced',label:'Advance',fmt:'money',sum:true},{k:'advance_recovered',label:'Recovered',fmt:'money',sum:true},{k:'retention_held',label:'Retention held',fmt:'money',sum:true},
        {k:'invoiced_total',label:'Invoiced',fmt:'money',sum:true},{k:'received',label:'Received',fmt:'money',sum:true},{k:'outstanding',label:'Outstanding',fmt:'money',sum:true}]"
        :rows="rows" :loading="loading" clickable @row="r => go('d/si/new/project/' + r.project_id)" filename="project-billing" />
      <p class="small muted">Click a project to start its next progress claim. Unbilled work = dispatched value (BOQ qty × rate; unit progress for unit-wise projects) not yet certified; billable now = dispatched value not yet in a submitted, certified or posted progress claim.</p>
    </div>

    <div class="card" v-if="t==='periods'">
      <div class="row" style="margin-bottom:10px">
        <span class="small muted" style="max-width:820px">Documents post to the ledger every 15 minutes. At month end: <b>post pending documents</b>, run <b>month end</b> (depreciation of fixed assets and the gratuity /
          leave-salary provision true-up, plus any <a href="#/provisions">provisions & accruals</a> set to automate), review the trial balance, then <b>close</b> the month. Documents dated in a closed month post on the first open day.</span>
        <span class="spacer"></span>
        <button v-if="isFin" class="btn primary" :disabled="syncing" @click="sync">⟳ Post pending documents</button>
      </div>
      <table class="t">
        <thead><tr><th>Month</th><th>Month end</th><th>Status</th><th></th></tr></thead>
        <tbody><tr v-for="p in periods" :key="p.period_month">
          <td>{{ p.name }}</td><td>{{ p.month_end_done ? '✔ done' : '' }}</td><td><Badge :v="p.status" /></td>
          <td style="text-align:right" v-if="isFin">
            <button class="btn sm" v-if="p.status==='OPEN' && !p.month_end_done" @click="monthEnd(p)">Run month end</button>
            <button class="btn sm ok" v-if="p.status==='OPEN'" @click="closeP(p, true)">Close</button>
            <button class="btn sm bad" v-if="p.status==='CLOSED'" @click="closeP(p, false)">Reopen</button>
          </td><td v-else></td>
        </tr></tbody>
      </table>
    </div>
  </div>`,
  setup() { return { go }; },
};
