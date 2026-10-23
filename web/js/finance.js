// Accounting: customer billing (progress claims with payment certificates, advance & recovery, retention),
// receipts, journal vouchers, and the books (trial balance, P&L, balance sheet, ledgers with bank
// reconciliation, VAT 201, receivables aging, customer statements, project billing, period close).
// Every other module posts to the ledger automatically (gl_sync, every 15 minutes or on demand).
import { reactive } from 'vue';
import { sb, state, must, run, rpc, hasRole, go, today, refRow, refLabel, money, qty, dt, label, num, loadRefs, toast } from './lib.js';
import { ask, confirmBox, Badge, DataTable, FieldInput, uomPick } from './components.js';
import { makePdf, partyOf } from './pdf.js';

const isFin = () => hasRole('finance');
const statusIs = (ctx, ...s) => s.includes(ctx.doc.status);
const PROGRESS = ['PROGRESS', 'FINAL'];
const INV_TYPES = [{ v: 'PROGRESS', l: 'Progress claim (interim payment application)' }, { v: 'ADVANCE', l: 'Advance payment invoice' },
  { v: 'FINAL', l: 'Final account / final claim' }, { v: 'RETENTION_RELEASE', l: 'Retention release' }, { v: 'GENERAL', l: 'General / product sale' }, { v: 'CREDIT_NOTE', l: 'Credit note' },
  { v: 'SALES', l: 'Sales order invoice (made from the order — advance recovered)' }];
const yearStart = () => today().slice(0, 4) + '-01-01';
const custOf = id => refRow('customers', id);

export const fopts = reactive({ invs: [], custInvs: [] });

async function loadCustInvoices(customerId) {
  if (!customerId) { fopts.invs = []; return; }
  const r = must(await sb.from('v_sales_invoice_balance').select('*').eq('customer_id', customerId).order('due_date'));
  fopts.invs = r.filter(x => x.inv_type !== 'CREDIT_NOTE').map(x => ({ id: x.invoice_id, label: `${x.inv_no} ${x.project_code ? '· ' + x.project_code : ''} — bal ${money(x.balance)} due ${dt(x.due_date)}`, row: x }));
  fopts.custInvs = must(await sb.from('sales_invoices').select('id,inv_no,total_amount,inv_type').eq('customer_id', customerId).eq('status', 'POSTED').neq('inv_type', 'CREDIT_NOTE').order('invoice_date', { ascending: false }))
    .map(x => ({ id: x.id, label: `${x.inv_no} — ${money(x.total_amount)}`, row: x }));
}

// ======================================================================
// SALES INVOICE / PROGRESS CLAIM
// ======================================================================
const lineAmt = r => Math.round((num(r.cum_qty) - num(r.prev_qty)) * num(r.rate) * 100) / 100;
export const si = {
  key: 'si', title: 'Sales Invoices & Claims', single: 'Sales Invoice', table: 'sales_invoices', noField: 'inv_no', dateField: 'invoice_date',
  statuses: ['DRAFT', 'SUBMITTED', 'CERTIFIED', 'POSTED', 'CANCELLED'], createRoles: ['finance', 'factory_manager'], refs: ['customers', 'projects', 'gl_accounts', 'profiles', 'uoms'],
  list: { select: '*, customers(name), projects(code)', columns: [{ k: 'inv_type', label: 'Type', fmt: 'label' }, { k: r => r.customers?.name, label: 'Customer' },
    { k: r => r.projects?.code, label: 'Project' }, { k: r => r.claim_no ? '#' + r.claim_no : '', label: 'Claim' }, { k: 'cert_no', label: 'Certificate' },
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
  },
  async afterLoad(ctx) { await loadCustInvoices(ctx.doc.customer_id); },
  header: [
    { k: 'inv_type', label: 'Type', type: 'select', required: true, options: INV_TYPES, wide: true, ro: d => !!d.id,
      onChange: d => { if (d.inv_type === 'RETENTION_RELEASE') d.vat_rate = 0; else if (!num(d.vat_rate)) d.vat_rate = 5; } },
    { k: 'project_id', label: 'Project', type: 'ref', ref: 'projects', wide: true, required: false, filter: (r, d) => d.inv_type === 'ADVANCE' ? ['PROJECT', 'SALES'].includes(r.project_type) : PROGRESS.concat('RETENTION_RELEASE').includes(d.inv_type) ? r.project_type === 'PROJECT' : d.inv_type === 'SALES' ? r.project_type === 'SALES' : true,
      onChange: (d, v) => { const p = refRow('projects', v); if (p?.customer_id) d.customer_id = p.customer_id; } },
    { k: 'customer_id', label: 'Customer', type: 'ref', ref: 'customers', required: true, wide: true, onChange: (d, v) => loadCustInvoices(v) },
    { k: 'invoice_date', label: 'Invoice date', type: 'date', required: true },
    { k: 'period_to', label: 'Work done up to', type: 'date', show: d => PROGRESS.includes(d.inv_type) },
    { k: 'due_date', label: 'Due date (blank = payment terms)', type: 'date' },
    { k: 'customer_ref', label: 'Client PO / contract / LPO ref' },
    { k: 'credit_of', label: 'Credit against invoice', type: 'ref', refOptions: () => fopts.custInvs, wide: true, show: d => d.inv_type === 'CREDIT_NOTE' },
    { k: 'vat_rate', label: 'VAT %', type: 'number', required: true },
    { k: 'claim_no', label: 'Claim no.', type: 'ro', show: d => !!d.claim_no },
    { k: 'cert_no', label: 'Payment certificate', type: 'ro', fmt: (v, d) => v ? `${v} · ${dt(d.cert_date)}` : '', show: d => !!d.cert_no },
    { k: 'remarks', label: 'Remarks (printed)', type: 'textarea', full: true },
  ],
  headerNote: ctx => PROGRESS.includes(ctx.doc.inv_type)
    ? 'Save, then <b>Fill from site progress</b>: each BOQ line (or unit, for unit-wise billing) shows the quantity certified on earlier claims and the cumulative quantity done to date. ' +
      'Adjust the cumulative quantities, <b>submit</b> the claim to the client, then record the client\'s <b>payment certificate</b> (the certified quantities may be lower) and post the tax invoice. ' +
      'Advance recovery and retention are deducted at the project\'s % — VAT is charged on the certified value less advance recovery.'
    : ctx.doc.inv_type === 'ADVANCE' ? 'Save, then <b>Fill</b> to bill the advance % of the project / sales order value (less advance already billed). The advance is recovered from each progress claim or order invoice.'
    : ctx.doc.inv_type === 'RETENTION_RELEASE' ? 'Save, then <b>Fill</b> with the retention still held on this project (VAT was charged on the original claims). Reduce the amount for a partial release.'
    : ctx.doc.inv_type === 'SALES' ? 'Made from the sales order (Sales → order → Invoice delivered / done): goods delivered, services done and job-work hours not yet invoiced. The order\'s advance is recovered pro rata, and in full on the invoice that completes the order.'
    : 'Enter the lines; choose a revenue account per line or leave blank for the default sales account.',
  grids: [{ key: 'lines', title: 'Lines', table: 'sales_invoice_lines', fk: 'invoice_id', order: 'line_no',
    newRow: ctx => ({ contract_qty: PROGRESS.includes(ctx.doc.inv_type) ? null : 1, prev_qty: 0, cum_qty: 1, rate: 0 }),
    fields: [
      { k: 'description', label: 'Description', width: '260px', required: true },
      { k: 'uom', label: 'UoM', ...uomPick({ width: '80px' }) },
      { k: 'contract_qty', label: 'Contract qty', type: 'number', show: d => PROGRESS.includes(d.inv_type) },
      { k: 'rate', label: 'Rate', type: 'number', required: true },
      { k: 'prev_qty', label: 'Previous certified', type: 'ro', fmt: v => qty(v), show: d => PROGRESS.includes(d.inv_type) },
      { k: 'cum_qty', label: 'Cumulative to date', type: 'number', required: true, show: d => PROGRESS.includes(d.inv_type) },
      { k: 'cum_qty', label: 'Qty', type: 'number', required: true, show: d => !PROGRESS.includes(d.inv_type) },
      { k: 'amount', label: 'This claim', type: 'ro', fmt: (v, r) => money(lineAmt(r)) },
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
    const out = [{ l: 'This claim (gross)', v: gross }];
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
        { k: 'earned_value', label: 'Earned (site progress)', fmt: 'money' }, { k: 'certified_to_date', label: 'Certified', fmt: 'money' }, { k: 'billed_pct', label: 'Billed %', n: true },
        { k: 'advance_invoiced', label: 'Advance billed', fmt: 'money' }, { k: 'advance_recovered', label: 'Recovered', fmt: 'money' }, { k: 'retention_held', label: 'Retention held', fmt: 'money' },
        { k: 'outstanding', label: 'Outstanding', fmt: 'money' }] });
    }
    return out;
  },
  actions: ctx => {
    const s = ctx.doc.status, t = ctx.doc.inv_type, prog = PROGRESS.includes(t);
    return [
      { label: '⇩ Fill from site progress', cls: 'primary', show: s === 'DRAFT' && prog && hasRole('finance', 'factory_manager'),
        confirm: 'Replace the lines with the current BOQ / unit progress?', done: 'Lines filled', run: c => rpc('si_fill', { p_inv: c.doc.id }) },
      { label: '⇩ Fill', cls: 'primary', show: s === 'DRAFT' && ['ADVANCE', 'RETENTION_RELEASE'].includes(t) && hasRole('finance', 'factory_manager'), done: 'Filled', run: c => rpc('si_fill', { p_inv: c.doc.id }) },
      { label: '📤 Submit claim to client', show: s === 'DRAFT' && prog && hasRole('finance', 'factory_manager'), confirm: 'Mark this claim as submitted to the client / consultant?', done: 'Claim submitted',
        run: c => rpc('si_action', { p_inv: c.doc.id, p_action: 'SUBMIT' }) },
      { label: '📜 Record payment certificate', cls: 'ok', show: s === 'SUBMITTED' && isFin(), done: 'Certificate recorded', run: c => certify(c) },
      { label: '✔ Post tax invoice', cls: 'ok', show: isFin() && ((s === 'CERTIFIED') || (!prog && ['DRAFT', 'SUBMITTED'].includes(s))),
        confirm: 'Post this invoice? It goes to receivables, revenue and the VAT return and can then only be corrected by a credit note.', done: 'Invoice posted',
        run: c => rpc('si_action', { p_inv: c.doc.id, p_action: 'POST' }) },
      { label: '↩ Back to draft', show: ['SUBMITTED', 'CERTIFIED'].includes(s) && isFin(), confirm: 'Return this claim to draft (the certificate is cleared)?', run: c => rpc('si_action', { p_inv: c.doc.id, p_action: 'RETURN' }) },
      { label: '💰 Receive payment', show: s === 'POSTED' && t !== 'CREDIT_NOTE' && isFin(), reload: false, run: c => go(`d/rcv/new/customer/${c.doc.customer_id}`) },
      { label: '➖ Credit note', show: s === 'POSTED' && t !== 'CREDIT_NOTE' && isFin(), reload: false, run: c => go(`d/si/new/credit/${c.doc.id}`) },
      { label: '🖨 ' + (s === 'POSTED' ? (t === 'CREDIT_NOTE' ? 'Tax credit note' : 'Tax invoice') : prog ? 'Payment application' : 'Proforma'), reload: false, run: c => siPdf(c) },
      { label: 'Cancel', show: ['DRAFT', 'SUBMITTED', 'CERTIFIED'].includes(s) && isFin(), confirm: 'Cancel this invoice?', run: c => rpc('si_action', { p_inv: c.doc.id, p_action: 'CANCEL' }) },
    ];
  },
};

async function certify(c) {
  const lines = c.grids.lines;
  const fields = [{ k: 'cert_no', label: 'Certificate no. (client / consultant)', required: true }, { k: 'cert_date', label: 'Certificate date', type: 'date', default: today() }];
  if (lines.length <= 40) lines.forEach((l, i) => fields.push({ k: 'l' + i, label: `${l.description} — certified cumulative (claimed ${qty(l.cum_qty)}, previous ${qty(l.prev_qty)})`, type: 'number', default: num(l.cum_qty) }));
  const v = await ask({ title: 'Payment certificate', message: 'Enter the cumulative quantities the client certified. Leave as claimed if certified in full.', fields, okText: 'Record certificate' });
  if (!v) return false;
  const payload = { cert_no: v.cert_no, cert_date: v.cert_date };
  if (lines.length <= 40) payload.lines = lines.map((l, i) => ({ id: l.id, cert_cum_qty: v['l' + i] === null || v['l' + i] === '' ? num(l.cum_qty) : num(v['l' + i]) }));
  return rpc('si_action', { p_inv: c.doc.id, p_action: 'CERTIFY', p_data: payload });
}

function siPdf(c) {
  const d = c.doc, cu = custOf(d.customer_id) || {}, p = refRow('projects', d.project_id), prog = PROGRESS.includes(d.inv_type), posted = d.status === 'POSTED';
  const cert = ['CERTIFIED', 'POSTED'].includes(d.status) && prog;
  const title = posted ? (d.inv_type === 'CREDIT_NOTE' ? 'Tax Credit Note' : 'Tax Invoice') : prog ? 'Interim Payment Application' : 'Proforma Invoice';
  const meta = [['Our TRN', state.company?.trn || ''], ['Project', p ? `${p.code} — ${p.name}` : ''],
    ['Type', label(d.inv_type)], ['Client ref', d.customer_ref || ''], ['Due date', dt(d.due_date)]];
  if (prog) meta.push(['Claim no.', d.claim_no || '-'], ['Work up to', dt(d.period_to) || '-'], ['Payment certificate', d.cert_no ? `${d.cert_no} (${dt(d.cert_date)})` : 'pending']);
  const cols = prog
    ? [{ h: 'Sr. No.', k: r => c.grids.lines.indexOf(r) + 1, w: 15 }, { h: 'Description', k: 'description', strong: true }, { h: 'UoM', k: 'uom' }, { h: 'Contract', k: r => qty(r.contract_qty), align: 'right' }, { h: 'Rate', k: r => money(r.rate), align: 'right' },
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
    subtitle: posted ? '' : label(d.status), party: partyOf(cu), meta, columns: cols, rows: c.grids.lines, totals, landscape: prog, words: d.total_amount,
    notes: [d.remarks, posted ? 'Please remit to the bank account on file quoting the invoice number.' : ''].filter(Boolean).join('\n'),
    sign: { prepared: d.created_by, checked: d.certified_by || d.submitted_by, approved: posted,
            labels: prog && !posted ? ['Prepared By', 'Submitted By', 'Approved & Authorized Signatory'] : undefined },
    acceptance: prog && !posted ? '' : cu.name || '' });
}

// ======================================================================
// CUSTOMER RECEIPT
// ======================================================================
export const rcv = {
  key: 'rcv', title: 'Customer Receipts', single: 'Receipt', table: 'customer_receipts', noField: 'receipt_no', dateField: 'receipt_date',
  statuses: ['DRAFT', 'POSTED', 'CLEARED', 'BOUNCED', 'CANCELLED'], createRoles: ['finance'], refs: ['customers', 'projects'],
  list: { select: '*, customers(name), projects(code)', columns: [{ k: r => r.customers?.name, label: 'Customer' }, { k: r => r.projects?.code, label: 'Project' },
    { k: 'mode', label: 'Mode', fmt: 'label' }, { k: 'reference_no', label: 'Ref / cheque' }, { k: 'cheque_date', label: 'Cheque date', fmt: 'date' }, { k: 'amount', label: 'Amount AED', fmt: 'money', sum: true }] },
  defaults: () => ({ receipt_date: today(), mode: 'BANK_TRANSFER' }),
  async onNew(ctx, parts) { if (parts[0] === 'customer' && parts[1]) { ctx.doc.customer_id = parts[1]; await loadCustInvoices(parts[1]); } },
  async afterLoad(ctx) { await loadCustInvoices(ctx.doc.customer_id); },
  header: [
    { k: 'customer_id', label: 'Customer', type: 'ref', ref: 'customers', required: true, wide: true, onChange: async (d, v, ctx) => { ctx.grids.alloc = []; await loadCustInvoices(v); } },
    { k: 'receipt_date', label: 'Date received', type: 'date', required: true },
    { k: 'project_id', label: 'Project (optional)', type: 'ref', ref: 'projects', filter: (r, d) => !d.customer_id || r.customer_id === d.customer_id },
    { k: 'mode', label: 'Mode', type: 'select', required: true, options: ['BANK_TRANSFER', 'CHEQUE', 'PDC', 'CASH'] },
    { k: 'bank_name', label: 'Drawn on bank', type: 'lookup', list: 'BANK' }, { k: 'reference_no', label: 'Cheque / transfer ref' },
    { k: 'cheque_date', label: 'Cheque date', type: 'date', show: d => ['CHEQUE', 'PDC'].includes(d.mode) },
    { k: 'amount', label: 'Amount AED', type: 'number', required: true },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  headerNote: () => 'Cheques and PDCs sit in <b>cheques in hand</b> until you mark them <b>cleared</b> (moved to the bank). A returned cheque reverses the receipt and re-opens the invoices. Unallocated money stays on the customer\'s account.',
  grids: [{ key: 'alloc', title: 'Allocation to invoices', table: 'receipt_allocations', fk: 'receipt_id', lineNo: false,
    importers: [{ label: '⚡ Auto-allocate (oldest due first)', run: ctx => {
      let left = num(ctx.doc.amount) - ctx.grids.alloc.reduce((s, r) => s + num(r.amount), 0);
      for (const o of fopts.invs) {
        if (left <= 0) break;
        if (ctx.grids.alloc.some(a => a.invoice_id === o.id) || (ctx.doc.project_id && o.row.project_id !== ctx.doc.project_id)) continue;
        const amt = Math.min(left, num(o.row.balance));
        if (amt > 0) { ctx.grids.alloc.push({ invoice_id: o.id, amount: Math.round(amt * 100) / 100 }); left -= amt; }
      }
      ctx.dirty = true;
    } }],
    fields: [{ k: 'invoice_id', label: 'Invoice', type: 'ref', refOptions: () => fopts.invs, required: true, width: '380px' }, { k: 'amount', label: 'Amount AED', type: 'number', required: true }] }],
  validate(ctx) { if (ctx.grids.alloc.reduce((s, r) => s + num(r.amount), 0) > num(ctx.doc.amount) + 0.005) throw new Error('Allocated amount exceeds the receipt'); },
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
  props: { tab: String, arg: String },
  data: () => ({ f: { from: yearStart(), to: today(), account_id: null, project_id: null, customer_id: null }, rows: [], loading: false, sel: {}, periods: [], syncing: false }),
  computed: {
    TABS: () => TABS,
    t() { return this.tab || 'tb'; },
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
        else if (this.t === 'billing') this.rows = must(await sb.from('v_project_billing').select('*').order('project_code'));
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
    <div class="tabs">
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
      <p class="small muted">Box 1 is reported in the company's emirate (Settings). Retention releases carry no VAT (taxed on the original claims). Box 3 / 10: services and goods from overseas suppliers
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
        {k:'earned_value',label:'Earned (progress)',fmt:'money',sum:true},{k:'certified_to_date',label:'Certified',fmt:'money',sum:true},{k:'billed_pct',label:'Billed %',n:true},
        {k: r => num(r.earned_value) - num(r.certified_to_date), label:'Unbilled work',fmt:'money',sum:true},
        {k:'advance_invoiced',label:'Advance',fmt:'money',sum:true},{k:'advance_recovered',label:'Recovered',fmt:'money',sum:true},{k:'retention_held',label:'Retention held',fmt:'money',sum:true},
        {k:'invoiced_total',label:'Invoiced',fmt:'money',sum:true},{k:'received',label:'Received',fmt:'money',sum:true},{k:'outstanding',label:'Outstanding',fmt:'money',sum:true}]"
        :rows="rows" :loading="loading" clickable @row="r => go('d/si/new/project/' + r.project_id)" filename="project-billing" />
      <p class="small muted">Click a project to start its next claim. Unbilled work = site progress earned value not yet certified.</p>
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
