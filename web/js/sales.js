// Sales: quotation → sales order (customer, or internal for mock-ups / internal use) → production orders, stock, services and
// job work → delivery notes → advance and tax invoices. A confirmed order collects its costs on a job (projects row of type SALES /
// INTERNAL with the order number as code), so material requests, issues, deliveries and the margin report work as for projects.
import { sb, state, must, run, rpc, hasRole, go, today, refRow, refLabel, money, qty, dt, label, num, toast } from './lib.js';
import { ask, uomPick } from './components.js';
import { makePdf } from './pdf.js';

const SALES_ROLES = ['sales', 'finance', 'factory_manager'];
const isSales = () => hasRole(...SALES_ROLES);
export const LINE_TYPES = [{ v: 'MADE', l: 'Made in-house' }, { v: 'STOCK', l: 'From stock / trading' }, { v: 'SERVICE', l: 'Service' }, { v: 'JOB_WORK', l: 'Job work (machine hours)' }];
const typeText = t => LINE_TYPES.find(x => x.v === t)?.l || t;
const PCTS = [0, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100].map(v => ({ v, l: v + '%' }));
const VATS = [{ v: 5, l: '5% (UAE standard)' }, { v: 0, l: '0% (export / zero-rated)' }];
// which items fit a line: finished goods for made-in-house, stocked items for stock lines, service items for services
const itemFits = (r, row) => r.is_active && (row.line_type === 'MADE' ? r.item_classes?.code === 'FG'
  : row.line_type === 'SERVICE' ? r.item_classes?.code === 'SRV'
  : row.line_type === 'STOCK' ? r.item_classes?.tracking === 'LOT' && !r.item_classes?.is_scrap && r.item_classes?.code !== 'SRV' : false);

// the line grid shared by quotations and orders
function lineFields(priceShown = () => true) {
  return [
    { k: 'line_type', label: 'Type', type: 'select', required: true, options: LINE_TYPES, width: '150px',
      onChange: r => { r.item_id = null; r.work_center_id = null; if (r.line_type === 'JOB_WORK') r.uom = 'HR'; } },
    { k: 'item_id', label: 'Product / item / service', type: 'ref', ref: 'items', width: '230px', filter: itemFits, ro: r => r.line_type === 'JOB_WORK',
      onChange: (r, v) => { const it = refRow('items', v); if (!it) return; r.description ||= it.name; r.uom = it.uoms?.code || r.uom; if (!num(r.est_unit_cost)) r.est_unit_cost = num(it.standard_cost) || num(it.avg_cost) || num(it.last_purchase_rate); } },
    { k: 'work_center_id', label: 'Work centre (job work)', type: 'ref', ref: 'work_centers', width: '170px', filter: r => r.is_active, ro: r => r.line_type !== 'JOB_WORK',
      onChange: (r, v) => { const w = refRow('work_centers', v); if (!w) return; r.description ||= 'Job work — ' + w.name; r.uom = 'HR'; if (!num(r.est_unit_cost)) r.est_unit_cost = num(w.machine_rate_per_hour); } },
    { k: 'description', label: 'Description (printed)', required: true, width: '220px' },
    { k: 'qty', label: 'Qty', type: 'number', required: true },
    { k: 'uom', label: 'UoM', ...uomPick({ width: '80px' }) },
    { k: 'rate', label: 'Rate AED', type: 'number', show: priceShown },
    { k: 'discount_pct', label: 'Disc. %', type: 'number', show: priceShown },
    { k: '_amt', label: 'Amount', type: 'ro', virtual: true, show: priceShown, fmt: (v, r) => money(num(r.qty) * num(r.rate) * (1 - num(r.discount_pct) / 100)) },
    { k: 'est_unit_cost', label: 'Est. unit cost', type: 'number', cost: true },
    { k: 'remarks', label: 'Remarks / drawing', width: '150px' },
  ];
}
function lineCheck(lines) {
  lines.forEach((r, i) => {
    if (['MADE', 'STOCK'].includes(r.line_type) && !r.item_id) throw new Error(`Line ${i + 1}: pick the ${r.line_type === 'MADE' ? 'product (finished-goods item)' : 'item'}`);
    if (r.line_type === 'JOB_WORK' && !r.work_center_id) throw new Error(`Line ${i + 1}: pick the work centre for the job work`);
    if (r.line_type !== 'JOB_WORK') r.work_center_id = null;
  });
}
const sumLines = (lines, f) => lines.reduce((s, r) => s + f(r), 0);
const lineAmt = r => Math.round(num(r.qty) * num(r.rate) * (1 - num(r.discount_pct) / 100) * 100) / 100;
function totals(ctx, priced = true) {
  const sub = sumLines(ctx.grids.lines, lineAmt), cost = sumLines(ctx.grids.lines, r => num(r.qty) * num(r.est_unit_cost));
  const vat = Math.round(sub * num(ctx.doc.vat_rate)) / 100;
  if (!priced) return [{ l: 'Estimated cost', v: cost, cost: true }];
  return [{ l: 'Subtotal', v: sub }, { l: `VAT ${num(ctx.doc.vat_rate)}%`, v: vat }, { l: 'Total', v: sub + vat },
    { l: 'Est. cost', v: cost, cost: true }, { l: 'Est. margin', v: sub - cost, cost: true }];
}
function salesPdf(c, kind) {
  const d = c.doc, cu = refRow('customers', d.customer_id) || {}, internal = d.so_type === 'INTERNAL';
  const meta = internal
    ? [['Cost centre', refLabel('cost_centers', d.cost_center_id)], ['Needed by', dt(d.delivery_date) || '-'], ['Requested by', refLabel('profiles', d.created_by) || '-']]
    : [['Customer', cu.name || ''], ['TRN', cu.trn || '-'], ['Address', cu.address || '-'], ['Your ref', d.customer_ref || '-'],
       kind === 'qt' ? ['Valid until', dt(d.valid_until)] : ['Delivery', dt(d.delivery_date) || '-'],
       ['Payment', [num(d.advance_pct) ? num(d.advance_pct) + '% advance' : '', refLabel('payment_terms', d.payment_term_id)].filter(Boolean).join(' · ') || '-']];
  if (kind === 'qt' && d.delivery_weeks) meta.push(['Delivery time', `${d.delivery_weeks} weeks from order`]);
  const cols = [{ h: '#', k: r => c.grids.lines.indexOf(r) + 1, w: 8 }, { h: 'Description', k: r => r.description + (r.remarks ? '\n' + r.remarks : '') },
    { h: 'Qty', k: r => qty(r.qty), align: 'right' }, { h: 'UoM', k: r => r.uom || '' }];
  if (!internal) cols.push({ h: 'Rate', k: r => money(r.rate), align: 'right' }, { h: 'Disc.', k: r => num(r.discount_pct) ? num(r.discount_pct) + '%' : '', align: 'right' },
    { h: 'Amount AED', k: r => money(lineAmt(r)), align: 'right' });
  const t = totals(c).filter(x => !x.cost);
  return makePdf({ title: kind === 'qt' ? 'Quotation' : internal ? 'Internal Order' : 'Order Confirmation', no: kind === 'qt' ? d.qt_no : d.so_no,
    date: kind === 'qt' ? d.qt_date : d.so_date, subtitle: d.title, meta, columns: cols, rows: c.grids.lines,
    totals: internal ? [] : t.map(x => [x.l, money(x.v)]), notes: [d.terms, d.remarks].filter(Boolean).join('\n'),
    signatures: kind === 'qt' ? ['Prepared by', 'Approved by', 'Accepted by customer (sign & stamp)'] : internal ? ['Requested by', 'Factory Manager'] : ['Sales', 'Finance', 'Customer acceptance'] });
}

// ======================================================================
// QUOTATIONS
// ======================================================================
export const qt = {
  key: 'qt', title: 'Quotations', single: 'Quotation', table: 'quotations', noField: 'qt_no', dateField: 'qt_date',
  statuses: ['DRAFT', 'SENT', 'ACCEPTED', 'LOST', 'REVISED', 'CANCELLED'], createRoles: SALES_ROLES, editStatuses: ['DRAFT', 'SENT'],
  refs: ['customers', 'items', 'work_centers', 'payment_terms', 'uoms', 'profiles'],
  list: { select: '*, customers(name)', columns: [{ k: r => r.customers?.name, label: 'Customer' }, { k: 'title', label: 'Title' }, { k: 'valid_until', label: 'Valid until', fmt: 'date' },
    { k: 'subtotal', label: 'Value AED', fmt: 'money', sum: true }, { k: r => num(r.subtotal) ? Math.round((1 - num(r.est_cost) / num(r.subtotal)) * 1000) / 10 : null, label: 'Est. margin %', n: true, cost: true }] },
  defaults: () => ({ qt_date: today(), valid_until: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), vat_rate: 5, advance_pct: 0 }),
  header: [
    { k: 'customer_id', label: 'Customer', type: 'ref', ref: 'customers', required: true, wide: true, filter: r => r.status === 'ACTIVE',
      onChange: (d, v) => { const c = refRow('customers', v); if (c && !d.payment_term_id) d.payment_term_id = c.payment_term_id; } },
    { k: 'title', label: 'Title (e.g. Villa 12 — kitchen & wardrobes)', required: true, wide: true },
    { k: 'customer_ref', label: 'Customer enquiry ref' },
    { k: 'qt_date', label: 'Date', type: 'date', required: true },
    { k: 'valid_until', label: 'Valid until', type: 'date' },
    { k: 'delivery_weeks', label: 'Delivery (weeks from order)', type: 'select', options: [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24].map(v => ({ v, l: v + (v === 1 ? ' week' : ' weeks') })) },
    { k: 'advance_pct', label: 'Advance payment', type: 'select', required: true, options: PCTS },
    { k: 'payment_term_id', label: 'Payment terms (balance)', type: 'ref', ref: 'payment_terms' },
    { k: 'vat_rate', label: 'VAT', type: 'select', required: true, options: VATS },
    { k: 'lost_reason', label: 'Lost because', type: 'ro', wide: true, show: d => d.status === 'LOST' },
    { k: 'sales_order_id', label: 'Sales order', type: 'ro', show: d => !!d.sales_order_id, fmt: () => 'Accepted — see the sales order' },
    { k: 'terms', label: 'Terms & conditions (printed)', type: 'textarea', full: true },
    { k: 'remarks', label: 'Internal remarks', type: 'textarea', full: true },
  ],
  headerNote: () => 'Line types: <b>Made in-house</b> (finished-goods product — becomes a production order), <b>From stock / trading</b>, <b>Service</b> (installation, delivery, design) and <b>Job work</b> (machine hours sold on a work centre). ' +
    'Est. unit cost is only for your margin check and is never printed. A missing product, customer or unit can be requested from the bottom of its drop-down.',
  grids: [{ key: 'lines', title: 'Lines', table: 'quotation_lines', fk: 'qt_id', order: 'line_no', newRow: () => ({ line_type: 'MADE', qty: 1, rate: 0, discount_pct: 0, est_unit_cost: 0 }), fields: lineFields() }],
  validate(ctx) { lineCheck(ctx.grids.lines); },
  totals: ctx => totals(ctx),
  actions: ctx => {
    const s = ctx.doc.status, open = ['DRAFT', 'SENT'].includes(s);
    return [
      { label: '📤 Mark sent to customer', cls: 'primary', show: s === 'DRAFT' && isSales(), done: 'Marked as sent', run: c => rpc('quotation_action', { p_qt: c.doc.id, p_action: 'SEND' }) },
      { label: '✔ Customer accepted → sales order', cls: 'ok', show: open && isSales(), reload: false,
        run: async c => {
          const v = await ask({ title: 'Accepted — create the sales order', message: 'The order is created as a draft with these lines; check the delivery date and confirm it.',
            fields: [{ k: 'ref', label: 'Customer PO / LPO number', default: c.doc.customer_ref || '' }], okText: 'Create sales order' });
          if (!v) return false;
          const id = await rpc('quotation_action', { p_qt: c.doc.id, p_action: 'ACCEPT', p_comments: v.ref || null });
          toast('Sales order created — confirm it to start production', 'ok'); go('d/so/' + id);
        } },
      { label: '✎ Revise', show: open && isSales(), confirm: 'Make a new revision (R+1) of this quotation? This one is kept as revised.', reload: false,
        run: async c => { const id = await rpc('quotation_action', { p_qt: c.doc.id, p_action: 'REVISE' }); go('d/qt/' + id); } },
      { label: '✖ Lost', cls: 'bad', show: open && isSales(),
        run: async c => { const v = await ask({ title: 'Quotation lost', fields: [{ k: 'r', label: 'Why (price, delivery time, competitor…)', type: 'textarea', required: true }], okText: 'Mark lost' });
          if (!v) return false; return rpc('quotation_action', { p_qt: c.doc.id, p_action: 'LOST', p_comments: v.r }); } },
      { label: '➜ Sales order', show: !!ctx.doc.sales_order_id, reload: false, run: c => go('d/so/' + c.doc.sales_order_id) },
      { label: '🖨 Quotation PDF', reload: false, run: c => salesPdf(c, 'qt') },
      { label: 'Cancel', show: open && isSales(), confirm: 'Cancel this quotation?', run: c => rpc('quotation_action', { p_qt: c.doc.id, p_action: 'CANCEL' }) },
    ];
  },
};

// ======================================================================
// SALES ORDERS (customer and internal)
// ======================================================================
async function soDocs(ctx) {
  const pid = ctx.doc.project_id;
  if (!pid) return { mrs: [], dns: [], invs: [] };
  const [m, d, i] = await Promise.all([
    sb.from('material_requests').select('id,mr_no,mr_date,status').eq('project_id', pid).order('mr_date'),
    sb.from('dispatch_notes').select('id,dispatch_no,dispatch_date,status,total_value').eq('project_id', pid).order('dispatch_date'),
    hasRole('finance', 'factory_manager') ? sb.from('sales_invoices').select('id,inv_no,inv_type,invoice_date,status,total_amount').eq('project_id', pid).order('invoice_date') : Promise.resolve({ data: [] })]);
  return { mrs: must(m), dns: must(d), invs: must(i) };
}
async function advanceInvoice(c) {
  const d = c.doc;
  const ex = must(await sb.from('sales_invoices').select('id').eq('project_id', d.project_id).eq('inv_type', 'ADVANCE').neq('status', 'CANCELLED').limit(1));
  if (ex[0] && !(await ask({ title: 'Advance already invoiced', message: 'An advance invoice exists for this order. Make another one for the remaining advance?', okText: 'Yes' }))) return false;
  const inv = must(await sb.from('sales_invoices').insert({ inv_type: 'ADVANCE', customer_id: d.customer_id, project_id: d.project_id, invoice_date: today(), vat_rate: d.vat_rate, customer_ref: d.customer_ref || d.so_no, status: 'DRAFT' }).select('id').single());
  await rpc('si_fill', { p_inv: inv.id });
  toast('Advance invoice drafted — check and post it', 'ok'); go('d/si/' + inv.id);
}
async function logJobWork(c) {
  const lines = c.grids.lines.filter(l => l.line_type === 'JOB_WORK');
  const v = await ask({ title: 'Log job-work hours', message: 'Costed at the work centre\'s machine and labour rates plus factory overhead; the hours become billable.', okText: 'Log hours', fields: [
    { k: 'l', label: 'Order line', type: 'select', required: true, default: lines.length === 1 ? lines[0].id : '', options: lines.map(l => ({ v: l.id, l: `${l.description} (${qty(l.qty)} h sold)` })) },
    { k: 'd', label: 'Date', type: 'date', default: today() },
    { k: 'm', label: 'Machine hours', type: 'number', required: true }, { k: 'h', label: 'Operator man-hours', type: 'number' }, { k: 'n', label: 'Notes', type: 'textarea' }] });
  if (!v) return false;
  return rpc('so_job_log', { p_line: v.l, p_date: v.d || today(), p_machine_hours: num(v.m), p_labour_hours: num(v.h), p_notes: v.n || null });
}
async function servicesDone(c) {
  const lines = c.grids.lines.filter(l => l.line_type === 'SERVICE');
  const v = await ask({ title: 'Services done', message: 'Quantity of each service completed so far (blank / 0 = bill on the order).', okText: 'Save',
    fields: lines.map((l, i) => ({ k: 's' + i, label: `${l.description} — ordered ${qty(l.qty)} ${l.uom || ''}`, type: 'number', default: num(l.service_done_qty) })) });
  if (!v) return false;
  for (const [i, l] of lines.entries()) await rpc('so_service_done', { p_line: l.id, p_qty: num(v['s' + i]) });
}

export const so = {
  key: 'so', title: 'Sales Orders', single: 'Sales Order', table: 'sales_orders', noField: 'so_no', dateField: 'so_date',
  statuses: ['DRAFT', 'PENDING_FM', 'REJECTED', 'CONFIRMED', 'CLOSED', 'CANCELLED'], createRoles: ['sales', 'finance', 'factory_manager', 'production_incharge', 'stores', 'shop_floor', 'site_supervisor', 'purchase', 'hr_officer'],
  canEdit: ctx => ['DRAFT', 'REJECTED'].includes(ctx.doc.status || 'DRAFT') && (ctx.isNew || isSales() || ctx.doc.created_by === state.profile?.id),
  refs: ['customers', 'cost_centers', 'items', 'work_centers', 'payment_terms', 'uoms', 'profiles'],
  list: { select: '*, customers(name), cost_centers(code)', columns: [{ k: r => r.so_type === 'INTERNAL' ? '🔧 Internal' : 'Customer', label: 'Type' },
    { k: r => r.customers?.name || r.cost_centers?.code, label: 'Customer / cost centre' }, { k: 'title', label: 'Title' }, { k: 'customer_ref', label: 'Customer PO' },
    { k: 'delivery_date', label: 'Delivery', fmt: 'date' }, { k: 'subtotal', label: 'Value AED', fmt: 'money', sum: true, cost: true }] },
  defaults: () => ({ so_date: today(), so_type: isSales() ? 'CUSTOMER' : 'INTERNAL', vat_rate: 5, advance_pct: 0 }),
  onNew(ctx, parts) { if (parts[0] === 'internal') ctx.doc.so_type = 'INTERNAL'; },
  header: [
    { k: 'so_type', label: 'Order type', type: 'select', required: true, wide: true, ro: d => !!d.id,
      options: () => isSales() ? [{ v: 'CUSTOMER', l: 'Customer order' }, { v: 'INTERNAL', l: 'Internal order (mock-up / internal use — Factory Manager approves)' }]
                               : [{ v: 'INTERNAL', l: 'Internal order (mock-up / internal use — Factory Manager approves)' }] },
    { k: 'customer_id', label: 'Customer', type: 'ref', ref: 'customers', required: true, wide: true, show: d => d.so_type === 'CUSTOMER', filter: r => r.status === 'ACTIVE',
      onChange: (d, v) => { const c = refRow('customers', v); if (c && !d.payment_term_id) d.payment_term_id = c.payment_term_id; } },
    { k: 'cost_center_id', label: 'Charge to cost centre', type: 'ref', ref: 'cost_centers', required: true, wide: true, show: d => d.so_type === 'INTERNAL', filter: r => r.is_active },
    { k: 'title', label: 'Title (what is it for)', required: true, wide: true },
    { k: 'customer_ref', label: 'Customer PO / LPO no.', show: d => d.so_type === 'CUSTOMER' },
    { k: 'so_date', label: 'Order date', type: 'date', required: true },
    { k: 'delivery_date', label: 'Delivery / needed by', type: 'date', required: true },
    { k: 'delivery_address', label: 'Delivery address', wide: true, show: d => d.so_type === 'CUSTOMER' },
    { k: 'advance_pct', label: 'Advance payment', type: 'select', options: PCTS, show: d => d.so_type === 'CUSTOMER' },
    { k: 'payment_term_id', label: 'Payment terms (balance)', type: 'ref', ref: 'payment_terms', show: d => d.so_type === 'CUSTOMER' },
    { k: 'vat_rate', label: 'VAT', type: 'select', options: VATS, show: d => d.so_type === 'CUSTOMER' },
    { k: 'quotation_id', label: 'From quotation', type: 'ro', show: d => !!d.quotation_id, fmt: () => 'Yes — see Quotations' },
    { k: 'created_by', label: 'Raised by', type: 'ro', show: d => !!d.id, fmt: v => refLabel('profiles', v) },
    { k: 'approval_comments', label: 'Approval comments', type: 'ro', wide: true, show: d => !!d.approval_comments },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  headerNote: ctx => ctx.doc.so_type === 'INTERNAL'
    ? 'Internal orders (showroom mock-ups, samples, internal use) are approved by the <b>Factory Manager</b>. Once approved, material is requested against the order and every cost is charged to the chosen <b>cost centre</b>; made-in-house lines become production orders.'
    : 'Confirming the order opens it for material requests, creates a <b>production order</b> for each made-in-house line (the Production In-charge picks the BOM and route), and lets Stores deliver stock lines. ' +
      'Finance raises the <b>advance invoice</b> and then <b>invoices</b> what has been delivered, services and job-work hours — the advance is recovered on each invoice.',
  grids: [{ key: 'lines', title: 'Order lines', table: 'sales_order_lines', fk: 'so_id', order: 'line_no', saveKeys: ['service_done_qty'],
    newRow: ctx => ({ line_type: 'MADE', qty: 1, rate: 0, discount_pct: 0, est_unit_cost: 0 }), fields: lineFields(d => d.so_type !== 'INTERNAL') }],
  validate(ctx) {
    const d = ctx.doc;
    if (d.so_type === 'INTERNAL') { d.customer_id = null; d.advance_pct = 0; ctx.grids.lines.forEach(l => { l.rate = 0; l.discount_pct = 0; }); }
    else d.cost_center_id = null;
    lineCheck(ctx.grids.lines);
  },
  totals: ctx => totals(ctx, ctx.doc.so_type !== 'INTERNAL'),
  async loadInfo(ctx) {
    if (!ctx.doc.project_id) return [];
    const lines = must(await sb.from('v_so_lines').select('*').eq('so_id', ctx.doc.id).order('line_no'));
    const docs = await soDocs(ctx);
    const out = [{ title: 'Progress by line', rows: lines, columns: [{ k: r => typeText(r.line_type), label: 'Type' }, { k: 'description', label: 'Line' },
      { k: 'qty', label: 'Ordered', fmt: 'qty' }, { k: r => r.wo_no ? `${r.wo_no} · ${label(r.wo_status)} · ${qty(r.wo_completed)} made` : '', label: 'Production order' },
      { k: r => r.line_type === 'JOB_WORK' ? qty(r.hours_logged) + ' h logged' : r.line_type === 'SERVICE' ? qty(r.service_done_qty) + ' done' : qty(r.delivered_qty), label: 'Delivered / done' },
      { k: 'invoiced_qty', label: 'Invoiced', fmt: 'qty' }] }];
    if (docs.mrs.length) out.push({ title: 'Material requests', rows: docs.mrs, columns: [{ k: 'mr_no', label: 'Request' }, { k: 'mr_date', label: 'Date', fmt: 'date' }, { k: 'status', label: 'Status', fmt: 'badge' }] });
    if (docs.dns.length) out.push({ title: 'Delivery notes', rows: docs.dns, columns: [{ k: 'dispatch_no', label: 'Delivery' }, { k: 'dispatch_date', label: 'Date', fmt: 'date' }, { k: 'status', label: 'Status', fmt: 'badge' }] });
    if (docs.invs.length) out.push({ title: 'Invoices', rows: docs.invs, columns: [{ k: 'inv_no', label: 'Invoice' }, { k: 'inv_type', label: 'Type', fmt: 'label' }, { k: 'invoice_date', label: 'Date', fmt: 'date' },
      { k: 'total_amount', label: 'Total', fmt: 'money' }, { k: 'status', label: 'Status', fmt: 'badge' }] });
    if (hasRole('sales', 'finance', 'factory_manager')) {
      const m = must(await sb.from('v_sales_orders').select('subtotal,delivered_value,invoiced_value,advance_invoiced,actual_cost,margin,margin_pct').eq('id', ctx.doc.id));
      out.push({ title: 'Order value, cost & margin', rows: m, columns: [{ k: 'subtotal', label: 'Order value', fmt: 'money' }, { k: 'delivered_value', label: 'Delivered', fmt: 'money' },
        { k: 'advance_invoiced', label: 'Advance billed', fmt: 'money' }, { k: 'invoiced_value', label: 'Invoiced', fmt: 'money' }, { k: 'actual_cost', label: 'Cost so far', fmt: 'money' },
        { k: 'margin', label: 'Margin', fmt: 'money' }, { k: 'margin_pct', label: 'Margin %', n: true }] });
    }
    return out;
  },
  actions: ctx => {
    const d = ctx.doc, s = d.status, cust = d.so_type === 'CUSTOMER', live = s === 'CONFIRMED', mine = d.created_by === state.profile?.id;
    const has = t => ctx.grids.lines.some(l => l.line_type === t);
    return [
      { label: cust ? '✔ Confirm order' : '📤 Send to Factory Manager', cls: 'primary', show: ['DRAFT', 'REJECTED'].includes(s) && (cust ? isSales() : (mine || isSales())),
        confirm: cust ? 'Confirm this order? Production orders are created for made-in-house lines and the lines can no longer change.' : null,
        done: cust ? 'Order confirmed' : 'Sent for approval', run: c => rpc('so_action', { p_so: c.doc.id, p_action: 'SUBMIT' }) },
      { label: '✔ Approve', cls: 'ok', show: s === 'PENDING_FM' && hasRole('factory_manager'), done: 'Approved',
        run: async c => { const v = await ask({ title: 'Approve ' + c.doc.so_no, fields: [{ k: 'c', label: 'Comments (optional)', type: 'textarea' }], okText: 'Approve' }); if (!v) return false;
          return rpc('so_action', { p_so: c.doc.id, p_action: 'APPROVE', p_comments: v.c || null }); } },
      { label: '✖ Reject', cls: 'bad', show: s === 'PENDING_FM' && hasRole('factory_manager'), done: 'Rejected',
        run: async c => { const v = await ask({ title: 'Reject ' + c.doc.so_no, fields: [{ k: 'c', label: 'Reason', type: 'textarea', required: true }], okText: 'Reject', danger: true }); if (!v) return false;
          return rpc('so_action', { p_so: c.doc.id, p_action: 'REJECT', p_comments: v.c }); } },
      { label: '📦 Request material', show: live && hasRole('shop_floor', 'production_incharge', 'stores', 'site_supervisor'), reload: false, run: c => go('d/mr/new/so/' + c.doc.project_id) },
      { label: '🚚 Delivery note', show: live && (has('STOCK') || has('MADE')) && hasRole('stores', 'factory_manager'), reload: false, run: c => go('d/dsp/new/so/' + c.doc.id) },
      { label: '⏱ Log job-work hours', show: live && has('JOB_WORK') && hasRole('production_incharge', 'factory_manager', 'shop_floor'), done: 'Hours logged', run: logJobWork },
      { label: '✔ Services done', show: live && has('SERVICE') && hasRole('sales', 'factory_manager', 'finance', 'production_incharge', 'site_supervisor'), done: 'Saved', run: servicesDone },
      { label: '💰 Advance invoice', show: live && cust && num(d.advance_pct) > 0 && hasRole('finance', 'factory_manager'), reload: false, run: advanceInvoice },
      { label: '🧾 Invoice delivered / done', show: ['CONFIRMED', 'CLOSED'].includes(s) && cust && hasRole('finance', 'factory_manager'), reload: false,
        run: async c => { const id = await rpc('so_invoice', { p_so: c.doc.id }); toast('Invoice drafted — check and post it', 'ok'); go('d/si/' + id); } },
      { label: '🖨 ' + (cust ? 'Order confirmation' : 'Internal order'), reload: false, run: c => salesPdf(c, 'so') },
      { label: 'Close order', show: live && isSales(), confirm: 'Close this order? No more material, deliveries or invoices against it.', done: 'Closed', run: c => rpc('so_action', { p_so: c.doc.id, p_action: 'CLOSE' }) },
      { label: 'Cancel', show: !['CLOSED', 'CANCELLED'].includes(s) && (isSales() || (mine && ['DRAFT', 'REJECTED'].includes(s))), confirm: 'Cancel this order?', run: c => rpc('so_action', { p_so: c.doc.id, p_action: 'CANCEL' }) },
    ];
  },
};

export const SALES_DOCS = { qt, so };
