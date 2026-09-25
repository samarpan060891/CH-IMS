// Document configurations: requisitions, POs, GRNs, requests, issues, returns, transfers,
// adjustments, scrap, disposals, purchase returns, vendor invoices, debit notes, payments.
import { reactive } from 'vue';
import { sb, state, must, rpc, hasRole, canSeeCost, go, today, refRow, refLabel, money, qty, dt, label, num, loadRef, toast } from './lib.js';
import { ask } from './components.js';
import { makePdf } from './pdf.js';

// shared dynamic option lists for ref fields ({id,label})
export const opts = reactive({ pos: [], mrs: [], issues: [], grns: [], prts: [], invs: [], vpos: [] });

// ---------- common field builders ----------
const isLotItem = r => r.is_active && r.item_classes?.tracking === 'LOT' && !r.item_classes?.is_scrap;
const isScrapItem = r => r.is_active && r.item_classes?.is_scrap;
const itemF = (extra = {}) => ({ k: 'item_id', label: 'Item', type: 'ref', ref: 'items', required: true, width: '260px', ...extra });
const uomF = { k: '_uom', label: 'UoM', type: 'ro', virtual: true, fmt: (v, r) => refRow('items', r.item_id)?.uoms?.code || '' };
const roMoney = (k, lbl, extra = {}) => ({ k, label: lbl, type: 'ro', fmt: v => money(v), cost: true, ...extra });
const roQty = (k, lbl, extra = {}) => ({ k, label: lbl, type: 'ro', fmt: v => qty(v), ...extra });
const statusIs = (ctx, ...s) => s.includes(ctx.doc.status);
const itemName = id => { const r = refRow('items', id); return r ? `${r.code} — ${r.name}` : ''; };
const itemUom = id => refRow('items', id)?.uoms?.code || '';
const upd = async (table, id, patch) => must(await sb.from(table).update(patch).eq('id', id));

// usable stock = free stock + stock reserved for the given project (other projects' reserved stock is excluded)
async function availableAt(itemIds, locationId, projectId = null) {
  if (!itemIds.length) return {};
  let q = sb.from('v_lot_values').select('item_id,qty_on_hand,lot_status,loc_type,location_id,project_id').in('item_id', itemIds);
  if (locationId) q = q.eq('location_id', locationId);
  const rows = must(await q);
  const m = {};
  rows.forEach(r => {
    if (r.lot_status !== 'AVAILABLE' || r.loc_type === 'QUARANTINE') return;
    if (r.project_id && r.project_id !== projectId) return;
    m[r.item_id] = (m[r.item_id] || 0) + Number(r.qty_on_hand);
  });
  return m;
}
async function fillAvail(ctx, gridKey, locationId) {
  const rows = ctx.grids[gridKey];
  const m = await availableAt([...new Set(rows.map(r => r.item_id).filter(Boolean))], locationId, ctx.doc.project_id || null);
  rows.forEach(r => { r._avail = m[r.item_id] || 0; });
}
const availF = { k: '_avail', label: 'Available', type: 'ro', virtual: true, fmt: v => qty(v ?? '') };
// line purpose: blank = general stock, otherwise reserved for that project on receipt
const lineProjectF = (extra = {}) => ({ k: 'project_id', label: 'For project (blank = stock)', type: 'ref', ref: 'projects', width: '190px',
  filter: r => r.status === 'OPEN' && r.project_type === 'PROJECT', ...extra });
const locId = code => (state.refs.locations || []).find(l => l.code === code)?.id || null;

function approvalsInfo(rows) {
  return {
    title: 'Approval history',
    columns: [{ k: 'acted_at', label: 'When', fmt: 'datetime' }, { k: 'stage', label: 'Stage', fmt: 'label' }, { k: 'action', label: 'Action', fmt: 'badge' },
              { k: r => r.profiles?.full_name || r.profiles?.email, label: 'By' }, { k: 'ref_no', label: 'Ref' }, { k: 'comments', label: 'Comments' }],
    rows,
  };
}
async function reason(title, required = true) {
  const v = await ask({ title, fields: [{ k: 'c', label: 'Comments / reason', type: 'textarea', required }], okText: 'Submit' });
  return v ? v.c : null;
}

// ======================================================================
// PURCHASE REQUISITION
// ======================================================================
const pr = {
  key: 'pr', title: 'Purchase Requisitions', single: 'Requisition', table: 'purchase_requisitions', noField: 'pr_no', dateField: 'pr_date',
  statuses: ['DRAFT', 'SUBMITTED', 'PARTIAL_PO', 'PO_CREATED', 'CANCELLED'],
  createRoles: ['stores', 'purchase', 'production_incharge', 'factory_manager'], editStatuses: ['DRAFT', 'SUBMITTED'],
  refs: ['items', 'projects'],
  list: { select: '*, projects(code), material_requests(mr_no)', columns: [{ k: 'source', label: 'Source', fmt: 'label' }, { k: r => r.projects?.code || 'Stock', label: 'For' },
          { k: r => r.material_requests?.mr_no, label: 'From request' }, { k: 'required_date', label: 'Required', fmt: 'date' }, { k: 'remarks', label: 'Remarks' }] },
  defaults: () => ({ pr_date: today(), source: 'MANUAL' }),
  async afterLoad(ctx) {
    if (ctx.doc.mr_id) ctx.doc._mr_no = must(await sb.from('material_requests').select('mr_no').eq('id', ctx.doc.mr_id).single()).mr_no;
  },
  header: [
    { k: '_mr_no', label: 'Raised from material request', type: 'ro', virtual: true, show: d => !!d.mr_id },
    { k: 'pr_date', label: 'Date', type: 'date', required: true },
    { k: 'source', label: 'Source', type: 'select', options: ['MANUAL', 'BUFFER', 'MATERIAL_REQUEST'], required: true },
    { k: 'project_id', label: 'Project (optional)', type: 'ref', ref: 'projects' },
    { k: 'required_date', label: 'Required by', type: 'date' },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  grids: [{
    key: 'lines', title: 'Items required', table: 'pr_lines', fk: 'pr_id', order: 'line_no',
    newRow: ctx => ({ project_id: ctx.doc.project_id || null }),
    fields: [itemF({ filter: r => r.is_active }), uomF, { k: 'qty', label: 'Qty', type: 'number', required: true }, lineProjectF(), roQty('ordered_qty', 'Ordered'),
             { k: 'required_date', label: 'Required', type: 'date' }, { k: 'remarks', label: 'Remarks' }],
  }],
  actions: ctx => [
    { label: 'Submit to Purchase', cls: 'primary', show: statusIs(ctx, 'DRAFT') && ctx.editable, done: 'Submitted',
      run: c => upd('purchase_requisitions', c.doc.id, { status: 'SUBMITTED' }) },
    { label: 'Create PO', cls: 'ok', show: statusIs(ctx, 'SUBMITTED', 'PARTIAL_PO') && hasRole('purchase'), reload: false,
      run: c => go(`d/po/new/pr/${c.doc.id}`) },
    { label: 'Open material request', show: !!ctx.doc.mr_id, reload: false, run: c => go(`d/mr/${c.doc.mr_id}`) },
    { label: 'Cancel', show: statusIs(ctx, 'DRAFT', 'SUBMITTED') && ctx.editable, confirm: 'Cancel this requisition?',
      run: c => upd('purchase_requisitions', c.doc.id, { status: 'CANCELLED' }) },
    { label: '🖨 PDF', reload: false, run: c => makePdf({
        title: 'Purchase Requisition', no: c.doc.pr_no, date: c.doc.pr_date,
        meta: [['Source', label(c.doc.source)], ['Project', refLabel('projects', c.doc.project_id)], ['Required by', dt(c.doc.required_date)], ['Status', label(c.doc.status)]],
        columns: [{ h: '#', k: (r) => c.grids.lines.indexOf(r) + 1, w: 8 }, { h: 'Item', k: r => itemName(r.item_id) }, { h: 'UoM', k: r => itemUom(r.item_id) },
                  { h: 'Qty', k: r => qty(r.qty), align: 'right' }, { h: 'Required', k: r => dt(r.required_date) }, { h: 'Remarks', k: 'remarks' }],
        rows: c.grids.lines, notes: c.doc.remarks || '', signatures: ['Requested by', 'Store In-charge', 'Purchase'] }) },
  ],
};

// ======================================================================
// PURCHASE ORDER
// ======================================================================
function poLineAmount(r) { return num(r.qty) * num(r.rate) * (1 - num(r.discount_pct) / 100); }
async function loadPrLines(ctx, prId) {
  const lines = must(await sb.from('pr_lines').select('id,item_id,qty,ordered_qty,required_date,pr_id,project_id').eq('pr_id', prId).order('line_no'));
  for (const l of lines) {
    const bal = num(l.qty) - num(l.ordered_qty);
    if (bal <= 0) continue;
    if (ctx.grids.lines.some(x => x.pr_line_id === l.id)) continue;
    const row = { item_id: l.item_id, qty: bal, pr_line_id: l.id, required_date: l.required_date, discount_pct: 0, project_id: l.project_id };
    await poItemDefaults(row, ctx);
    ctx.grids.lines.push(row);
  }
  const pr = must(await sb.from('purchase_requisitions').select('project_id').eq('id', prId).single());
  if (pr.project_id && !ctx.doc.project_id) ctx.doc.project_id = pr.project_id;
  ctx.dirty = true;
}
async function poItemDefaults(row, ctx) {
  const it = refRow('items', row.item_id);
  if (!it) return;
  row.description = it.name;
  row.vat_rate = ctx.doc.po_type === 'IMPORT' ? 0 : num(it.vat_rate);
  let price = null;
  if (ctx.doc.vendor_id) {
    const iv = must(await sb.from('item_vendors').select('price').eq('item_id', it.id).eq('vendor_id', ctx.doc.vendor_id).maybeSingle());
    price = iv?.price ?? null;
  }
  row.rate = price ?? it.last_purchase_rate ?? it.standard_cost ?? 0;
}
export const po = {
  key: 'po', title: 'Purchase Orders', single: 'Purchase Order', table: 'purchase_orders', noField: 'po_no', dateField: 'po_date',
  statuses: ['DRAFT', 'PENDING_FM', 'PENDING_FINANCE', 'PENDING_TOP_MGMT', 'APPROVED', 'RELEASED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'REJECTED', 'CANCELLED'],
  createRoles: ['purchase'], editStatuses: ['DRAFT', 'REJECTED'],
  refs: ['items', 'vendors', 'payment_terms', 'locations', 'projects'],
  list: { select: '*, vendors(name)', columns: [{ k: r => r.vendors?.name, label: 'Vendor' }, { k: 'po_type', label: 'Type', fmt: 'label' }, { k: 'currency', label: 'Cur' },
          { k: 'total_amount', label: 'Total', fmt: 'money', cost: true }, { k: 'total_aed', label: 'Total AED', fmt: 'money', cost: true, sum: true }, { k: 'delivery_date', label: 'Delivery', fmt: 'date' }] },
  defaults: () => ({ po_date: today(), po_type: 'LOCAL', currency: 'AED', exchange_rate: 1, delivery_location_id: locId('MS'), terms_conditions: state.company?.po_terms_conditions || '' }),
  async onNew(ctx, parts) { if (parts[0] === 'pr' && parts[1]) await loadPrLines(ctx, parts[1]); },
  header: [
    { k: 'vendor_id', label: 'Vendor', type: 'ref', ref: 'vendors', required: true, wide: true, filter: r => r.status === 'ACTIVE',
      onChange: async (d, v, ctx) => {
        const vd = refRow('vendors', v); if (!vd) return;
        d.currency = vd.currency; d.payment_term_id = vd.payment_term_id; d.po_type = vd.vendor_type;
        if (vd.currency === 'AED') d.exchange_rate = 1;
        for (const r of ctx.grids.lines) await poItemDefaults(r, ctx);
      } },
    { k: 'po_date', label: 'PO date', type: 'date', required: true },
    { k: 'po_type', label: 'Type', type: 'select', options: ['LOCAL', 'IMPORT'], required: true,
      onChange: (d, v, ctx) => ctx.grids.lines.forEach(r => { r.vat_rate = v === 'IMPORT' ? 0 : num(refRow('items', r.item_id)?.vat_rate ?? 5); }) },
    { k: 'currency', label: 'Currency', type: 'text', required: true },
    { k: 'exchange_rate', label: 'Exchange rate to AED', type: 'number', required: true },
    { k: 'payment_term_id', label: 'Payment terms', type: 'ref', ref: 'payment_terms', required: true },
    { k: 'delivery_date', label: 'Delivery date', type: 'date' },
    { k: 'delivery_location_id', label: 'Deliver to', type: 'ref', ref: 'locations' },
    { k: 'project_id', label: 'Default project for new lines', type: 'ref', ref: 'projects', filter: r => r.status === 'OPEN' && r.project_type === 'PROJECT' },
    { k: 'quotation_ref', label: 'Quotation ref' },
    { k: 'incoterms', label: 'Incoterms', show: d => d.po_type === 'IMPORT' },
    { k: 'top_mgmt_ref_no', label: 'Top mgmt approval ref', type: 'ro', show: d => !!d.top_mgmt_ref_no },
    { k: 'top_mgmt_ref_date', label: 'Top mgmt approval date', type: 'ro', fmt: v => dt(v), show: d => !!d.top_mgmt_ref_no },
    { k: 'terms_conditions', label: 'Terms & conditions', type: 'textarea', full: true },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  grids: [{
    key: 'lines', title: 'PO lines', table: 'po_lines', fk: 'po_id', order: 'line_no', saveKeys: ['pr_line_id'],
    newRow: ctx => ({ discount_pct: 0, vat_rate: 5, project_id: ctx.doc.project_id || null }),
    importers: [{ label: '⇩ From requisition', run: async ctx => {
      const prs = must(await sb.from('purchase_requisitions').select('id,pr_no,pr_date').in('status', ['SUBMITTED', 'PARTIAL_PO']).order('pr_date'));
      if (!prs.length) throw new Error('No open requisitions');
      const v = await ask({ title: 'Import requisition lines', fields: [{ k: 'pr', label: 'Requisition', type: 'select', required: true, options: prs.map(p => ({ v: p.id, l: `${p.pr_no} (${dt(p.pr_date)})` })) }] });
      if (v) await loadPrLines(ctx, v.pr);
    } }],
    fields: [
      itemF({ filter: r => r.is_active, onChange: (r, v, ctx) => poItemDefaults(r, ctx) }), uomF,
      { k: 'description', label: 'Description', width: '180px' },
      lineProjectF(),
      { k: 'qty', label: 'Qty', type: 'number', required: true },
      { k: 'rate', label: 'Rate', type: 'number', required: true },
      { k: 'discount_pct', label: 'Disc %', type: 'number' },
      { k: 'vat_rate', label: 'VAT %', type: 'number' },
      { k: '_amt', label: 'Amount', type: 'ro', virtual: true, fmt: (v, r) => money(poLineAmount(r)) },
      roQty('received_qty', 'Received'),
      { k: 'required_date', label: 'Required', type: 'date' },
    ],
  }],
  totals: ctx => {
    const sub = ctx.grids.lines.reduce((s, r) => s + poLineAmount(r), 0);
    const vat = ctx.grids.lines.reduce((s, r) => s + poLineAmount(r) * num(r.vat_rate) / 100, 0);
    return [{ l: 'Subtotal ' + ctx.doc.currency, v: sub }, { l: 'VAT', v: vat }, { l: 'Total ' + ctx.doc.currency, v: sub + vat }, { l: 'Total AED', v: (sub + vat) * num(ctx.doc.exchange_rate) }];
  },
  async loadInfo(ctx) {
    const ap = must(await sb.from('po_approvals').select('*, profiles:acted_by(full_name,email)').eq('po_id', ctx.doc.id).order('acted_at'));
    const grns = must(await sb.from('grns').select('grn_no,grn_date,status,vendor_dn_no,vendor_invoice_no').eq('po_id', ctx.doc.id).order('grn_date'));
    return [approvalsInfo(ap), { title: 'Receipts (GRN)', columns: [{ k: 'grn_no', label: 'GRN' }, { k: 'grn_date', label: 'Date', fmt: 'date' }, { k: 'vendor_dn_no', label: 'DN' }, { k: 'vendor_invoice_no', label: 'Invoice' }, { k: 'status', label: 'Status', fmt: 'badge' }], rows: grns }];
  },
  actions: ctx => {
    const s = ctx.doc.status;
    const approver = (s === 'PENDING_FM' && hasRole('factory_manager')) || (s === 'PENDING_FINANCE' && hasRole('finance'));
    return [
      { label: 'Submit for approval', cls: 'primary', show: ['DRAFT', 'REJECTED'].includes(s) && hasRole('purchase'), done: 'Sent to Factory Manager',
        run: c => rpc('po_action', { p_po: c.doc.id, p_action: 'SUBMIT' }) },
      { label: '✔ Approve', cls: 'ok', show: approver, done: 'Approved',
        run: async c => { const cm = await ask({ title: 'Approve PO ' + c.doc.po_no, fields: [{ k: 'c', label: 'Comments (optional)', type: 'textarea' }], okText: 'Approve' }); if (!cm) return; return rpc('po_action', { p_po: c.doc.id, p_action: 'APPROVE', p_comments: cm.c || null }); } },
      { label: '✖ Reject', cls: 'bad', show: approver, done: 'Rejected',
        run: async c => { const r = await reason('Reject PO ' + c.doc.po_no); if (r) return rpc('po_action', { p_po: c.doc.id, p_action: 'REJECT', p_comments: r }); } },
      { label: 'Record top-management approval', cls: 'ok', show: s === 'PENDING_TOP_MGMT' && hasRole('purchase', 'finance'), done: 'Top management approval recorded',
        run: async c => {
          const v = await ask({ title: 'Top management approval (parent system)', message: 'Enter the approval reference from the parent system.',
            fields: [{ k: 'ref', label: 'Approval reference no.', required: true }, { k: 'date', label: 'Approval date', type: 'date', default: today() }, { k: 'url', label: 'Document link (optional)' }, { k: 'c', label: 'Comments', type: 'textarea' }] });
          if (!v) return;
          return rpc('po_action', { p_po: c.doc.id, p_action: 'APPROVE', p_comments: v.c || null, p_ref_no: v.ref, p_ref_date: v.date || null, p_doc_url: v.url || null });
        } },
      { label: 'Top mgmt rejected', cls: 'bad', show: s === 'PENDING_TOP_MGMT' && hasRole('purchase', 'finance'),
        run: async c => { const r = await reason('Top management rejection'); if (r) return rpc('po_action', { p_po: c.doc.id, p_action: 'REJECT', p_comments: r }); } },
      { label: '📤 Release to vendor', cls: 'primary', show: s === 'APPROVED' && hasRole('purchase'), done: 'PO released',
        confirm: 'Release this PO to the vendor? It can then be received against.', run: c => rpc('po_action', { p_po: c.doc.id, p_action: 'RELEASE' }) },
      { label: 'Short close', show: ['RELEASED', 'PARTIALLY_RECEIVED'].includes(s) && hasRole('purchase', 'factory_manager'),
        confirm: 'Close this PO? Pending quantities will no longer be expected.', run: c => rpc('po_action', { p_po: c.doc.id, p_action: 'CLOSE' }) },
      { label: 'Cancel PO', cls: 'bad', show: !['CLOSED', 'CANCELLED', 'RECEIVED', 'PARTIALLY_RECEIVED'].includes(s) && hasRole('purchase', 'factory_manager'),
        confirm: 'Cancel this PO?', danger: true, run: c => rpc('po_action', { p_po: c.doc.id, p_action: 'CANCEL' }) },
      { label: '🖨 PO PDF', reload: false, show: canSeeCost(), run: c => pdfPO(c) },
    ];
  },
};
function pdfPO(c) {
  const d = c.doc, v = refRow('vendors', d.vendor_id) || {};
  const t = po.totals(c);
  return makePdf({
    title: 'Purchase Order', no: d.po_no, date: d.po_date, subtitle: label(d.status),
    meta: [['Vendor', v.name], ['Vendor TRN', v.trn || '-'], ['Currency', d.currency + (d.currency !== 'AED' ? ` @ ${d.exchange_rate}` : '')], ['Payment terms', refLabel('payment_terms', d.payment_term_id)],
           ['Delivery date', dt(d.delivery_date)], ['Deliver to', refLabel('locations', d.delivery_location_id)], ['Quotation ref', d.quotation_ref || '-'], ['Project', refLabel('projects', d.project_id) || '-']],
    columns: [{ h: '#', k: r => c.grids.lines.indexOf(r) + 1, w: 8 }, { h: 'Item', k: r => itemName(r.item_id) + (r.description && r.description !== refRow('items', r.item_id)?.name ? '\n' + r.description : '') },
              ...(c.grids.lines.some(r => r.project_id) ? [{ h: 'For project', k: r => r.project_id ? refRow('projects', r.project_id)?.code : 'Stock' }] : []),
              { h: 'UoM', k: r => itemUom(r.item_id) }, { h: 'Qty', k: r => qty(r.qty), align: 'right' }, { h: 'Rate', k: r => money(r.rate), align: 'right' },
              { h: 'Disc%', k: r => num(r.discount_pct) || '', align: 'right' }, { h: 'VAT%', k: r => num(r.vat_rate), align: 'right' }, { h: 'Amount', k: r => money(poLineAmount(r)), align: 'right' }],
    rows: c.grids.lines,
    totals: t.map(x => [x.l, money(x.v)]),
    notes: [d.terms_conditions, d.top_mgmt_ref_no ? `Top management approval ref: ${d.top_mgmt_ref_no} dated ${dt(d.top_mgmt_ref_date)}` : ''].filter(Boolean).join('\n\n'),
    signatures: [['Prepared by', 'Purchase'], ['Approved', 'Factory Manager'], ['Approved', 'Finance Manager'], ['Vendor acceptance', v.name || '']],
  });
}

// ======================================================================
// GRN / STOCK RECEIPT
// ======================================================================
async function loadOpenPos(extraId) {
  const rows = must(await sb.from('purchase_orders').select('id,po_no,vendors(name)').in('status', ['RELEASED', 'PARTIALLY_RECEIVED']).order('po_date', { ascending: false }));
  opts.pos = rows.map(r => ({ id: r.id, label: `${r.po_no} — ${r.vendors?.name}` }));
  if (extraId && !opts.pos.some(p => p.id === extraId)) {
    const p = must(await sb.from('purchase_orders').select('id,po_no,vendors(name)').eq('id', extraId).single());
    opts.pos.push({ id: p.id, label: `${p.po_no} — ${p.vendors?.name}` });
  }
}
async function loadPoIntoGrn(ctx, poId) {
  const p = must(await sb.from('purchase_orders').select('*').eq('id', poId).single());
  Object.assign(ctx.doc, { vendor_id: p.vendor_id, currency: p.currency, exchange_rate: p.exchange_rate, project_id: p.project_id, location_id: ctx.doc.location_id || p.delivery_location_id });
  const lines = must(await sb.from('po_lines').select('*').eq('po_id', poId).order('line_no'));
  ctx.grids.lines = lines.filter(l => num(l.qty) > num(l.received_qty)).map(l => ({
    po_line_id: l.id, item_id: l.item_id, project_id: l.project_id, _bal: num(l.qty) - num(l.received_qty),
    dn_qty: num(l.qty) - num(l.received_qty), received_qty: num(l.qty) - num(l.received_qty), damaged_qty: 0,
    rate: num(l.rate) * (1 - num(l.discount_pct) / 100), vat_rate: l.vat_rate,
  }));
  ctx.dirty = true;
}
const isSerial = r => refRow('items', r.item_id)?.item_classes?.tracking === 'SERIAL';
// preview of what posting will do: good = received - damaged; to stock = good up to PO balance; rest = excess
function grnSplit(r) {
  const good = Math.max(num(r.received_qty) - num(r.damaged_qty), 0);
  const acc = r.po_line_id && r._bal !== undefined ? Math.min(good, Math.max(num(r._bal), 0)) : good;
  return { good, acc, exc: good - acc };
}
export const grn = {
  key: 'grn', title: 'Goods Receipts (GRN)', single: 'GRN', table: 'grns', noField: 'grn_no', dateField: 'grn_date',
  statuses: ['DRAFT', 'POSTED', 'CANCELLED'], createRoles: ['stores'],
  refs: ['items', 'vendors', 'locations', 'projects'],
  list: { select: '*, vendors(name), purchase_orders(po_no)', columns: [{ k: 'receipt_type', label: 'Type', fmt: 'label' }, { k: r => r.purchase_orders?.po_no, label: 'PO' },
          { k: r => r.vendors?.name, label: 'Vendor' }, { k: 'vendor_dn_no', label: 'DN no.' }, { k: 'vendor_invoice_no', label: 'Invoice no.' }] },
  defaults: () => ({ grn_date: today(), receipt_type: 'PO', currency: 'AED', exchange_rate: 1, location_id: locId('MS') }),
  async onNew(ctx, parts) { await loadOpenPos(); if (parts[0] === 'po' && parts[1]) { ctx.doc.po_id = parts[1]; await loadPoIntoGrn(ctx, parts[1]); } },
  async afterLoad(ctx) {
    await loadOpenPos(ctx.doc.po_id);
    if (ctx.doc.status === 'DRAFT' && ctx.doc.po_id) {
      const lines = must(await sb.from('po_lines').select('id,qty,received_qty').eq('po_id', ctx.doc.po_id));
      ctx.grids.lines.forEach(r => { const l = lines.find(x => x.id === r.po_line_id); if (l) r._bal = num(l.qty) - num(l.received_qty); });
    }
  },
  header: [
    { k: 'receipt_type', label: 'Receipt type', type: 'select', required: true, options: [{ v: 'PO', l: 'Against PO' }, { v: 'NON_PO', l: 'Non-PO receipt' }, { v: 'OPENING', l: 'Opening stock' }, { v: 'CUSTOMER_SUPPLIED', l: 'Customer supplied' }, { v: 'SAMPLE', l: 'Free sample' }],
      onChange: (d, v, ctx) => { if (v !== 'PO') { d.po_id = null; ctx.grids.lines.forEach(r => { r.po_line_id = null; }); } } },
    { k: 'po_id', label: 'Purchase order', type: 'ref', refOptions: () => opts.pos, required: true, wide: true, show: d => d.receipt_type === 'PO',
      onChange: (d, v, ctx) => v && loadPoIntoGrn(ctx, v) },
    { k: 'vendor_id', label: 'Vendor', type: 'ref', ref: 'vendors', ro: d => d.receipt_type === 'PO', show: d => d.receipt_type !== 'OPENING' },
    { k: 'project_id', label: 'Project', type: 'ref', ref: 'projects', required: false, show: d => d.receipt_type !== 'OPENING' },
    { k: 'grn_date', label: 'GRN date', type: 'date', required: true },
    { k: 'location_id', label: 'Receiving location', type: 'ref', ref: 'locations', required: true, filter: r => r.is_stock && r.is_active },
    { k: 'vendor_dn_no', label: 'Vendor delivery note no.', show: d => !['OPENING'].includes(d.receipt_type) },
    { k: 'vendor_dn_date', label: 'DN date', type: 'date', show: d => !['OPENING'].includes(d.receipt_type) },
    { k: 'vendor_invoice_no', label: 'Vendor invoice no.', show: d => ['PO', 'NON_PO'].includes(d.receipt_type) },
    { k: 'vendor_invoice_date', label: 'Invoice date', type: 'date', show: d => ['PO', 'NON_PO'].includes(d.receipt_type) },
    { k: 'currency', label: 'Currency', ro: d => d.receipt_type === 'PO', cost: true },
    { k: 'exchange_rate', label: 'Exchange rate to AED', type: 'number', cost: true },
    { k: 'vehicle_no', label: 'Vehicle no.' },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  headerNote: ctx => ctx.doc.receipt_type === 'OPENING' ? 'Opening stock: enter the <b>Original receipt date</b> on each line so the aging report shows the true age.' :
    'Enter the <b>DN qty</b> (per supplier delivery note), the qty physically <b>received</b> and how many are <b>damaged</b>. On posting: good qty up to the PO balance is accepted into stock; ' +
    '<b>damaged</b> and <b>excess</b> go to Quarantine on hold (damaged → draft purchase return; excess → Purchase accepts or returns); <b>short</b> vs DN is recorded and the PO stays open.',
  grids: [
    { key: 'lines', title: 'Items received', table: 'grn_lines', fk: 'grn_id', order: 'line_no', saveKeys: ['po_line_id'],
      newRow: () => ({ vat_rate: 5, received_qty: null, damaged_qty: 0 }),
      fields: [
        itemF({ ro: r => !!r.po_line_id, filter: r => r.is_active, onChange: r => { const it = refRow('items', r.item_id); if (it) { r.vat_rate = it.vat_rate; if (!r.rate) r.rate = it.last_purchase_rate || it.standard_cost || 0; } } }), uomF,
        { k: '_bal', label: 'PO balance', type: 'ro', virtual: true, fmt: v => qty(v ?? ''), show: d => d.receipt_type === 'PO' && d.status === 'DRAFT' },
        lineProjectF({ label: 'Reserve for project', ro: r => !!r.po_line_id, show: d => ['PO', 'NON_PO'].includes(d.receipt_type) }),
        { k: 'dn_qty', label: 'DN qty', type: 'number', show: d => !['OPENING'].includes(d.receipt_type) },
        { k: 'received_qty', label: 'Received (counted)', type: 'number', required: true },
        { k: 'damaged_qty', label: 'Damaged', type: 'number' },
        { k: '_acc', label: 'To stock', type: 'ro', virtual: true, show: d => d.status === 'DRAFT', fmt: (v, r) => qty(grnSplit(r).acc) },
        { k: '_exc', label: 'Excess', type: 'ro', virtual: true, show: d => d.status === 'DRAFT', fmt: (v, r) => { const x = grnSplit(r).exc; return x > 0 ? '⚠ ' + qty(x) : ''; } },
        { k: '_short', label: 'Short vs DN', type: 'ro', virtual: true, show: d => d.status === 'DRAFT', fmt: (v, r) => { const x = num(r.dn_qty) - num(r.received_qty); return r.dn_qty != null && x > 0 ? '⚠ ' + qty(x) : ''; } },
        roQty('accepted_qty', 'Accepted', { show: d => d.status === 'POSTED' }),
        { k: 'excess_qty', label: 'Excess (open)', type: 'ro', fmt: v => num(v) ? '⚠ ' + qty(v) : '', show: d => d.status === 'POSTED' },
        { k: 'short_qty', label: 'Short vs DN', type: 'ro', fmt: v => num(v) ? '⚠ ' + qty(v) : '', show: d => d.status === 'POSTED' },
        { k: 'rejection_reason', label: 'Damage / short remarks', width: '170px' },
        { k: 'rate', label: 'Rate (excl. VAT)', type: 'number', cost: true },
        { k: 'vat_rate', label: 'VAT %', type: 'number', cost: true },
        { k: 'unit_cost_aed', label: 'Landed cost AED', type: 'ro', fmt: v => money(v), cost: true, show: d => d.status === 'POSTED' },
        { k: 'lot_no', label: 'Lot no.', placeholder: 'auto' },
        { k: 'batch_no', label: 'Batch no.' },
        { k: 'mfg_date', label: 'Mfg date', type: 'date' },
        { k: 'expiry_date', label: 'Expiry', type: 'date' },
        { k: 'original_receipt_date', label: 'Original receipt date', type: 'date', show: d => d.receipt_type === 'OPENING' },
        { k: 'serial_nos', label: 'Serial nos (tools/assets)', type: 'tags', width: '180px' },
        { k: 'remarks', label: 'Remarks' },
      ] },
    { key: 'charges', title: 'Landed cost charges (freight, customs duty, clearing…)', table: 'grn_charges', fk: 'grn_id', lineNo: false,
      show: d => ['PO', 'NON_PO'].includes(d.receipt_type) && canSeeCost(),
      newRow: () => ({ alloc_basis: 'VALUE', vat_amount: 0 }),
      fields: [
        { k: 'charge_type', label: 'Charge', type: 'select', required: true, options: ['FREIGHT', 'CUSTOMS_DUTY', 'CLEARING', 'INSURANCE', 'HANDLING', 'OTHER'] },
        { k: 'vendor_id', label: 'Service provider (payable to)', type: 'ref', ref: 'vendors', width: '220px' },
        { k: 'reference', label: 'Bill / BoE ref' },
        { k: 'amount_aed', label: 'Amount AED (excl. VAT)', type: 'number', required: true },
        { k: 'vat_amount', label: 'VAT AED', type: 'number' },
        { k: 'alloc_basis', label: 'Allocate by', type: 'select', required: true, options: [{ v: 'VALUE', l: 'Value' }, { v: 'QTY', l: 'Quantity' }] },
      ] },
  ],
  validate(ctx) {
    for (const r of ctx.grids.lines) {
      if (num(r.damaged_qty) < 0 || num(r.damaged_qty) > num(r.received_qty)) throw new Error(`${itemName(r.item_id)}: damaged qty must be between 0 and the received qty`);
      if ((num(r.damaged_qty) > 0 || (r.dn_qty != null && num(r.dn_qty) > num(r.received_qty))) && !r.rejection_reason)
        throw new Error(`${itemName(r.item_id)}: add a remark for the damaged / short quantity`);
      const acc = grnSplit(r).acc;
      if (isSerial(r) && r.serial_nos?.length && r.serial_nos.length !== acc) throw new Error(`${itemName(r.item_id)}: enter ${acc} serial numbers or leave blank`);
    }
  },
  totals: ctx => {
    const goods = ctx.grids.lines.reduce((s, r) => s + num(r.received_qty) * num(r.rate), 0) * num(ctx.doc.exchange_rate);
    const ch = (ctx.grids.charges || []).reduce((s, r) => s + num(r.amount_aed), 0);
    return [{ l: 'Goods value AED', v: goods, cost: true }, { l: 'Landed charges AED', v: ch, cost: true }, { l: 'Total landed AED', v: goods + ch, cost: true }];
  },
  async loadInfo(ctx) {
    if (ctx.doc.status !== 'POSTED') return [];
    const ids = ctx.grids.lines.map(l => l.id);
    const lots = must(await sb.from('stock_lots').select('lot_no,batch_no,received_date,expiry_date,qty_in,unit_cost,items(code,name),locations(code)').eq('source_type', 'GRN').in('source_id', ids));
    const assets = must(await sb.from('assets').select('asset_tag,serial_no,purchase_cost,items(code,name)').in('grn_line_id', ids));
    const out = [{ title: 'Stock lots created', rows: lots, columns: [{ k: 'lot_no', label: 'Lot' }, { k: r => r.items?.code, label: 'Item' }, { k: r => r.items?.name, label: 'Name' }, { k: r => r.locations?.code, label: 'Loc' }, { k: 'qty_in', label: 'Qty', fmt: 'qty' }, { k: 'unit_cost', label: 'Unit cost', fmt: 'money', cost: true }, { k: 'expiry_date', label: 'Expiry', fmt: 'date' }] }];
    if (assets.length) out.push({ title: 'Assets registered', rows: assets, columns: [{ k: 'asset_tag', label: 'Tag' }, { k: r => r.items?.name, label: 'Item' }, { k: 'serial_no', label: 'Serial' }, { k: 'purchase_cost', label: 'Cost', fmt: 'money', cost: true }] });
    return out;
  },
  actions: ctx => [
    { label: '✔ Post GRN', cls: 'ok', show: statusIs(ctx, 'DRAFT') && hasRole('stores'), done: 'GRN posted — stock updated',
      confirm: 'Post this GRN? Stock lots will be created and the PO updated. This cannot be undone.', run: c => rpc('post_grn', { p_grn: c.doc.id }) },
    { label: 'Return to vendor', show: statusIs(ctx, 'POSTED') && hasRole('stores', 'purchase') && !!ctx.doc.vendor_id, reload: false, run: c => go(`d/prt/new/grn/${c.doc.id}`) },
    { label: 'Book vendor invoice', show: statusIs(ctx, 'POSTED') && hasRole('finance') && ctx.doc.receipt_type === 'PO', reload: false, run: c => go(`d/inv/new/grn/${c.doc.id}`) },
    { label: '🖨 GRN PDF', reload: false, run: c => {
        const d = c.doc; const cost = canSeeCost();
        const cols = [{ h: '#', k: r => c.grids.lines.indexOf(r) + 1, w: 8 }, { h: 'Item', k: r => itemName(r.item_id) }, { h: 'UoM', k: r => itemUom(r.item_id) },
          { h: 'DN qty', k: r => qty(r.dn_qty), align: 'right' }, { h: 'Received', k: r => qty(r.received_qty), align: 'right' },
          { h: 'Damaged', k: r => num(r.damaged_qty) ? qty(r.damaged_qty) : '', align: 'right' }, { h: 'Accepted', k: r => qty(r.accepted_qty), align: 'right' },
          { h: 'Excess', k: r => num(r.excess_qty) ? qty(r.excess_qty) : '', align: 'right' }, { h: 'Short', k: r => num(r.short_qty) ? qty(r.short_qty) : '', align: 'right' },
          { h: 'Remarks', k: 'rejection_reason' },
          { h: 'Lot / Batch', k: r => [r.lot_no, r.batch_no].filter(Boolean).join(' / ') }, { h: 'Expiry', k: r => dt(r.expiry_date) }];
        if (cost) cols.push({ h: 'Rate', k: r => money(r.rate), align: 'right' }, { h: 'Landed AED', k: r => money(r.unit_cost_aed), align: 'right' });
        makePdf({ title: 'Goods Receipt Note', no: d.grn_no, date: d.grn_date, subtitle: label(d.status), landscape: true,
          meta: [['Receipt type', label(d.receipt_type)], ['PO', opts.pos.find(p => p.id === d.po_id)?.label || '-'], ['Vendor', refLabel('vendors', d.vendor_id) || '-'], ['Location', refLabel('locations', d.location_id)],
                 ['Delivery note', `${d.vendor_dn_no || '-'} ${d.vendor_dn_date ? '(' + dt(d.vendor_dn_date) + ')' : ''}`], ['Vendor invoice', d.vendor_invoice_no || '-'], ['Vehicle', d.vehicle_no || '-'], ['Project', refLabel('projects', d.project_id) || '-']],
          columns: cols, rows: c.grids.lines, notes: d.remarks || '', signatures: ['Received by (Stores)', 'Quality check', 'Store In-charge'] });
      } },
  ],
};

// ======================================================================
// MATERIAL REQUEST (floor -> store)
// ======================================================================
const mrTarget = [
  { k: 'purpose', label: 'Purpose', type: 'select', required: true, options: [{ v: 'PROJECT', l: 'Project' }, { v: 'MTS', l: 'Make to stock' }, { v: 'COST_CENTER', l: 'Cost centre (maintenance, camp …)' }],
    onChange: d => { d.project_id = null; d.cost_center_id = null; } },
  { k: 'project_id', label: 'Project / MTS order', type: 'ref', ref: 'projects', required: true, show: d => d.purpose !== 'COST_CENTER',
    filter: (r, d) => r.status === 'OPEN' && r.project_type === (d.purpose === 'MTS' ? 'MTS' : 'PROJECT') },
  { k: 'cost_center_id', label: 'Cost centre', type: 'ref', ref: 'cost_centers', required: true, show: d => d.purpose === 'COST_CENTER' },
];
export const mr = {
  key: 'mr', title: 'Material Requests', single: 'Material Request', table: 'material_requests', noField: 'mr_no', dateField: 'mr_date',
  statuses: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_ISSUED', 'ISSUED', 'REJECTED', 'CANCELLED', 'CLOSED'],
  createRoles: ['shop_floor', 'production_incharge', 'stores'],
  canEdit: ctx => (['DRAFT', 'REJECTED'].includes(ctx.doc.status) && hasRole('shop_floor', 'production_incharge', 'stores')) ||
                  (ctx.doc.status === 'PENDING_APPROVAL' && hasRole('production_incharge')),
  headerEditable: ctx => ['DRAFT', 'REJECTED'].includes(ctx.doc.status),
  refs: ['items', 'projects', 'cost_centers', 'profiles'],
  list: { select: '*, projects(code,name), cost_centers(code), profiles:requested_by(full_name)', columns: [
    { k: 'purpose', label: 'Purpose', fmt: 'label' }, { k: r => r.projects ? `${r.projects.code} — ${r.projects.name}` : r.cost_centers?.code, label: 'Project / Cost centre' },
    { k: 'priority', label: 'Priority', fmt: 'badge' }, { k: 'required_date', label: 'Required', fmt: 'date' }, { k: r => r.profiles?.full_name, label: 'Requested by' }] },
  defaults: () => ({ mr_date: today(), purpose: 'PROJECT', priority: 'NORMAL' }),
  async afterLoad(ctx) {
    await fillAvail(ctx, 'lines');
    if (['APPROVED', 'PARTIALLY_ISSUED'].includes(ctx.doc.status)) {
      const sh = must(await sb.rpc('mr_shortage', { p_mr: ctx.doc.id }));
      ctx.grids.lines.forEach(r => { const x = sh.find(s => s.mr_line_id === r.id); r._short = x ? num(x.shortage) : 0; r._onord = x ? num(x.on_order) + num(x.requested) : 0; });
      ctx.extra.shortLines = sh.filter(s => num(s.shortage) > 0).length;
    }
    ctx.extra.prs = must(await sb.from('purchase_requisitions').select('id,pr_no,status,pr_date').eq('mr_id', ctx.doc.id).order('created_at'));
  },
  async loadInfo(ctx) {
    const prs = ctx.extra.prs || [];
    return prs.length ? [{ title: 'Requisitions raised for this request', rows: prs,
      columns: [{ k: 'pr_no', label: 'Requisition' }, { k: 'pr_date', label: 'Date', fmt: 'date' }, { k: 'status', label: 'Status', fmt: 'badge' }] }] : [];
  },
  header: [
    ...mrTarget,
    { k: 'mr_date', label: 'Request date', type: 'date', required: true },
    { k: 'required_date', label: 'Required by', type: 'date' },
    { k: 'priority', label: 'Priority', type: 'select', required: true, options: ['NORMAL', 'URGENT'] },
    { k: 'requested_by', label: 'Requested by', type: 'ro', fmt: v => refLabel('profiles', v), show: d => !!d.id },
    { k: 'approved_by', label: 'Approved / rejected by', type: 'ro', fmt: v => refLabel('profiles', v), show: d => !!d.approved_by },
    { k: 'approval_comments', label: 'Approval comments', type: 'ro', show: d => !!d.approval_comments, wide: true },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  headerNote: ctx => ctx.doc.status === 'PENDING_APPROVAL' && hasRole('production_incharge') ? 'You can adjust <b>Approved qty</b> on each line, then Save and Approve.' : '',
  grids: [{
    key: 'lines', title: 'Materials requested', table: 'mr_lines', fk: 'mr_id', order: 'line_no',
    fields: [
      itemF({ filter: isLotItem, lockSaved: false, onChange: async (r, v, ctx) => { await fillAvail(ctx, 'lines'); } }), uomF, availF,
      { k: 'requested_qty', label: 'Requested', type: 'number', required: true },
      { k: 'approved_qty', label: 'Approved qty', type: 'number', show: d => d.status !== 'DRAFT' },
      roQty('issued_qty', 'Issued', { show: d => !['DRAFT', 'PENDING_APPROVAL'].includes(d.status) }),
      { k: '_onord', label: 'On order / requisitioned', type: 'ro', virtual: true, fmt: v => v ? qty(v) : '', show: d => ['APPROVED', 'PARTIALLY_ISSUED'].includes(d.status) },
      { k: '_short', label: 'Shortage', type: 'ro', virtual: true, fmt: v => v ? '⚠ ' + qty(v) : '—', show: d => ['APPROVED', 'PARTIALLY_ISSUED'].includes(d.status) },
      { k: 'remarks', label: 'Remarks / drawing ref', width: '180px' },
    ],
  }],
  actions: ctx => {
    const s = ctx.doc.status;
    return [
      { label: 'Submit for approval', cls: 'primary', show: ['DRAFT', 'REJECTED'].includes(s) && hasRole('shop_floor', 'production_incharge', 'stores'), done: 'Sent to Production In-charge',
        run: c => rpc('mr_action', { p_mr: c.doc.id, p_action: 'SUBMIT' }) },
      { label: '✔ Approve', cls: 'ok', show: s === 'PENDING_APPROVAL' && hasRole('production_incharge'), done: 'Approved — Stores can issue',
        run: c => rpc('mr_action', { p_mr: c.doc.id, p_action: 'APPROVE' }) },
      { label: '✖ Reject', cls: 'bad', show: s === 'PENDING_APPROVAL' && hasRole('production_incharge'),
        run: async c => { const r = await reason('Reject request'); if (r) return rpc('mr_action', { p_mr: c.doc.id, p_action: 'REJECT', p_comments: r }); } },
      { label: '📦 Issue material', cls: 'primary', show: ['APPROVED', 'PARTIALLY_ISSUED'].includes(s) && hasRole('stores'), reload: false, run: c => go(`d/issue/new/mr/${c.doc.id}`) },
      { label: `🛒 Requisition shortage (${ctx.extra.shortLines || 0})`, show: ['APPROVED', 'PARTIALLY_ISSUED'].includes(s) && !!ctx.extra.shortLines && hasRole('stores', 'production_incharge', 'factory_manager', 'purchase'),
        confirm: 'Create a requisition for the shortage and send it to Purchase? Stock, open POs and open requisitions are already deducted.',
        reload: false, run: async c => { const id = await rpc('mr_raise_pr', { p_mr: c.doc.id }); toast('Requisition sent to Purchase', 'ok'); go('d/pr/' + id); } },
      { label: 'Short close', show: ['APPROVED', 'PARTIALLY_ISSUED'].includes(s) && hasRole('stores', 'production_incharge'), confirm: 'Close this request? Balance will not be issued.',
        run: c => rpc('mr_action', { p_mr: c.doc.id, p_action: 'CLOSE' }) },
      { label: 'Cancel', show: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'].includes(s), confirm: 'Cancel this request?',
        run: c => rpc('mr_action', { p_mr: c.doc.id, p_action: 'CANCEL' }) },
      { label: '🖨 PDF', reload: false, run: c => makePdf({
          title: 'Material Request', no: c.doc.mr_no, date: c.doc.mr_date, subtitle: label(c.doc.status),
          meta: [['Purpose', label(c.doc.purpose)], ['Project / CC', refLabel('projects', c.doc.project_id) || refLabel('cost_centers', c.doc.cost_center_id)], ['Priority', c.doc.priority], ['Required by', dt(c.doc.required_date)],
                 ['Requested by', refLabel('profiles', c.doc.requested_by)], ['Approved by', refLabel('profiles', c.doc.approved_by) || '-']],
          columns: [{ h: '#', k: r => c.grids.lines.indexOf(r) + 1, w: 8 }, { h: 'Item', k: r => itemName(r.item_id) }, { h: 'UoM', k: r => itemUom(r.item_id) },
                    { h: 'Requested', k: r => qty(r.requested_qty), align: 'right' }, { h: 'Approved', k: r => qty(r.approved_qty), align: 'right' }, { h: 'Issued', k: r => qty(r.issued_qty), align: 'right' }, { h: 'Remarks', k: 'remarks' }],
          rows: c.grids.lines, notes: c.doc.remarks || '', signatures: ['Requested by', 'Production In-charge', 'Stores'] }) },
    ];
  },
};

// ======================================================================
// MATERIAL ISSUE (store -> floor) with PDF issue slip
// ======================================================================
async function loadApprovedMrs(extraId) {
  const rows = must(await sb.from('material_requests').select('id,mr_no,purpose,projects(code),cost_centers(code)').in('status', ['APPROVED', 'PARTIALLY_ISSUED']).order('mr_date'));
  opts.mrs = rows.map(r => ({ id: r.id, label: `${r.mr_no} — ${r.projects?.code || r.cost_centers?.code}` }));
  if (extraId && !opts.mrs.some(x => x.id === extraId)) {
    const r = must(await sb.from('material_requests').select('id,mr_no').eq('id', extraId).single());
    opts.mrs.push({ id: r.id, label: r.mr_no });
  }
}
async function loadMrIntoIssue(ctx, mrId) {
  const m = must(await sb.from('material_requests').select('*').eq('id', mrId).single());
  Object.assign(ctx.doc, { mr_id: m.id, purpose: m.purpose, project_id: m.project_id, cost_center_id: m.cost_center_id });
  const lines = must(await sb.from('mr_lines').select('*').eq('mr_id', mrId).order('line_no'));
  ctx.grids.lines = lines.map(l => ({ mr_line_id: l.id, item_id: l.item_id, qty: num(l.approved_qty ?? l.requested_qty) - num(l.issued_qty), remarks: l.remarks }))
    .filter(l => l.qty > 0);
  await fillAvail(ctx, 'lines', ctx.doc.from_location_id);
  ctx.dirty = true;
}
export const issue = {
  key: 'issue', title: 'Material Issues', single: 'Issue Slip', table: 'material_issues', noField: 'issue_no', dateField: 'issue_date',
  statuses: ['DRAFT', 'POSTED'], createRoles: ['stores'],
  refs: ['items', 'projects', 'cost_centers', 'locations', 'employees'],
  list: { select: '*, projects(code,name), cost_centers(code), material_requests(mr_no)', columns: [
    { k: 'purpose', label: 'Purpose', fmt: 'label' }, { k: r => r.projects ? `${r.projects.code} — ${r.projects.name}` : r.cost_centers?.code, label: 'Project / CC' },
    { k: r => r.material_requests?.mr_no, label: 'Request' }, { k: 'received_by_name', label: 'Received by' }, { k: 'total_value', label: 'Value', fmt: 'money', cost: true, sum: true },
    { k: 'ack_status', label: 'Receipt', fmt: 'badge' }] },
  defaults: () => ({ issue_date: today(), purpose: 'PROJECT', from_location_id: locId('MS') }),
  async onNew(ctx, parts) { await loadApprovedMrs(); if (parts[0] === 'mr' && parts[1]) await loadMrIntoIssue(ctx, parts[1]); },
  async afterLoad(ctx) {
    await loadApprovedMrs(ctx.doc.mr_id);
    if (ctx.doc.status === 'DRAFT') await fillAvail(ctx, 'lines', ctx.doc.from_location_id);
    ctx.extra.budget = ctx.doc.project_id ? must(await sb.rpc('issue_budget_check', { p_issue: ctx.doc.id })) : null;
  },
  header: [
    { k: 'mr_id', label: 'Against material request', type: 'ref', refOptions: () => opts.mrs, wide: true, onChange: (d, v, ctx) => v && loadMrIntoIssue(ctx, v) },
    ...mrTarget.map(f => ({ ...f, ro: d => !!d.mr_id })),
    { k: 'issue_date', label: 'Issue date', type: 'date', required: true },
    { k: 'from_location_id', label: 'Issue from', type: 'ref', ref: 'locations', required: true, filter: r => r.is_stock && r.loc_type !== 'QUARANTINE',
      onChange: (d, v, ctx) => fillAvail(ctx, 'lines', v) },
    { k: 'received_by_employee_id', label: 'Received by (employee)', type: 'ref', ref: 'employees', onChange: (d, v) => { const e = refRow('employees', v); if (e) d.received_by_name = e.name; } },
    { k: 'received_by_name', label: 'Received by (name)' },
    roMoney('total_value', 'Issue value AED', { show: d => d.status === 'POSTED' }),
    { k: 'budget_note', label: 'Over-budget approval', type: 'ro', wide: true, fmt: (v, d) => v ? `${refLabel('profiles', d.budget_approved_by)}: ${v}` : '', show: d => !!d.budget_approved_by },
    { k: 'ack_status', label: 'Receipt acknowledgement', type: 'ro', fmt: v => label(v || ''), show: d => !!d.ack_status },
    { k: 'ack_by', label: 'Acknowledged by', type: 'ro', fmt: (v, d) => v ? `${refLabel('profiles', v)} · ${dt(d.ack_at)}` : '', show: d => !!d.ack_by },
    { k: 'ack_remarks', label: 'Acknowledgement remarks', type: 'ro', wide: true, show: d => !!d.ack_remarks },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  headerNote: ctx => {
    let s = 'Stock is consumed <b>FIFO</b> (oldest lot first; earliest expiry first for dated items) when the issue is posted.';
    const b = ctx.extra.budget;
    if (b?.has_budget && canSeeCost()) {
      const pct = Number(b.projected_pct), over = Number(b.projected) > Number(b.budget);
      const col = over ? '#b91c1c' : pct >= Number(b.warn_pct) ? '#b45309' : '#15803d';
      s += `<div style="margin-top:8px;padding:8px 10px;border-radius:6px;background:#f8fafc;border:1px solid #e5e7eb">
        <b>Project material budget:</b> AED ${money(b.budget)} · used AED ${money(b.used)}${ctx.doc.status === 'DRAFT' ? ` · this issue ≈ AED ${money(b.this_issue)}` : ''}
        → <b style="color:${col}">${pct}%</b>${over ? (b.approved ? ' — over budget, <b>approved by FM</b>' : b.requested ? ' — over budget, <b>waiting for FM approval</b>' : ' — <b>over budget: FM approval needed before posting</b>') : ''}
        <div style="height:6px;background:#e5e7eb;border-radius:3px;margin-top:6px"><div style="height:6px;border-radius:3px;background:${col};width:${Math.min(pct, 100)}%"></div></div></div>`;
    }
    return s;
  },
  grids: [{
    key: 'lines', title: 'Items to issue', table: 'issue_lines', fk: 'issue_id', order: 'line_no', saveKeys: ['mr_line_id'],
    fields: [
      itemF({ filter: isLotItem, ro: r => !!r.mr_line_id, onChange: (r, v, ctx) => fillAvail(ctx, 'lines', ctx.doc.from_location_id) }), uomF,
      { ...availF, show: d => d.status === 'DRAFT' },
      { k: 'qty', label: 'Issue qty', type: 'number', required: true },
      roMoney('value', 'Value', { show: d => d.status === 'POSTED' }),
      { k: 'received_qty', label: 'Received good', type: 'ro', fmt: (v, r) => v == null ? '' : (num(v) + num(r.damaged_qty) === num(r.qty) ? qty(v) : '⚠ ' + qty(v)), show: d => ['ACKNOWLEDGED', 'DISCREPANCY'].includes(d.ack_status) },
      { k: 'damaged_qty', label: 'Damaged', type: 'ro', fmt: v => num(v) ? '⚠ ' + qty(v) : '', show: d => ['ACKNOWLEDGED', 'DISCREPANCY'].includes(d.ack_status) },
      roQty('returned_qty', 'Returned', { show: d => d.status === 'POSTED' }),
      { k: 'remarks', label: 'Remarks' },
    ],
  }],
  validate(ctx) { for (const r of ctx.grids.lines) if (r._avail !== undefined && num(r.qty) > num(r._avail)) throw new Error(`${itemName(r.item_id)}: only ${qty(r._avail)} available at this location`); },
  async loadInfo(ctx) {
    if (ctx.doc.status !== 'POSTED') return [];
    const rows = must(await sb.from('issue_line_lots').select('qty,unit_cost,returned_qty,issue_lines!inner(issue_id,item_id),stock_lots(lot_no,batch_no,received_date,expiry_date)').eq('issue_lines.issue_id', ctx.doc.id).order('seq'));
    ctx.extra.lots = rows;
    return [{ title: 'FIFO lot allocation', rows, columns: [{ k: r => itemName(r.issue_lines.item_id), label: 'Item' }, { k: r => r.stock_lots?.lot_no, label: 'Lot' }, { k: r => r.stock_lots?.batch_no, label: 'Batch' },
      { k: r => r.stock_lots?.received_date, label: 'Received', fmt: 'date' }, { k: 'qty', label: 'Qty', fmt: 'qty' }, { k: 'unit_cost', label: 'Unit cost', fmt: 'money', cost: true }, { k: r => num(r.qty) * num(r.unit_cost), label: 'Value', fmt: 'money', cost: true }] }];
  },
  actions: ctx => [
    { label: '✔ Post issue', cls: 'ok', show: statusIs(ctx, 'DRAFT') && hasRole('stores'), done: 'Issued — stock deducted FIFO',
      confirm: 'Post this issue? Stock will be deducted FIFO and charged to the project / cost centre.', run: c => rpc('post_issue', { p_issue: c.doc.id }) },
    { label: 'Request FM approval (over budget)', cls: 'primary', done: 'Factory Manager notified',
      show: statusIs(ctx, 'DRAFT') && hasRole('stores') && isOverBudget(ctx) && !ctx.extra.budget.approved && !ctx.extra.budget.requested,
      run: c => rpc('issue_budget_request', { p_issue: c.doc.id }) },
    { label: '✔ Approve over budget', cls: 'ok', show: statusIs(ctx, 'DRAFT') && hasRole('factory_manager') && isOverBudget(ctx) && !ctx.extra.budget.approved, done: 'Approved — Stores can post',
      run: async c => { const r = await reason('Why may this project exceed its material budget?'); if (r) return rpc('issue_budget_approve', { p_issue: c.doc.id, p_note: r }); } },
    { label: '✔ Acknowledge receipt', cls: 'ok', show: statusIs(ctx, 'POSTED') && ctx.doc.ack_status === 'PENDING' && hasRole('shop_floor', 'production_incharge'),
      run: c => acknowledge(c) },
    { label: 'Resolve discrepancy', show: ctx.doc.ack_status === 'DISCREPANCY' && hasRole('stores', 'factory_manager'), done: 'Discrepancy resolved',
      run: async c => { const r = await reason('How was the discrepancy resolved? (re-issued, returned, adjusted …)'); if (r) return rpc('issue_resolve_discrepancy', { p_issue: c.doc.id, p_note: r }); } },
    { label: '🖨 Issue slip PDF', cls: 'primary', show: statusIs(ctx, 'POSTED'), reload: false, run: c => pdfIssue(c) },
    { label: '↩ Return to store', show: statusIs(ctx, 'POSTED') && hasRole('stores', 'shop_floor', 'production_incharge'), reload: false, run: c => go(`d/ret/new/issue/${c.doc.id}`) },
  ],
};

const isOverBudget = ctx => !!ctx.extra.budget?.has_budget && Number(ctx.extra.budget.projected) > Number(ctx.extra.budget.budget) + 0.005;

// shop floor confirms what physically arrived; any difference needs a remark and alerts Stores + FM
async function acknowledge(c) {
  const lines = c.grids.lines;
  const fields = [];
  lines.forEach(l => {
    fields.push({ k: l.id + '_g', label: `${itemName(l.item_id)} — issued ${qty(l.qty)} ${itemUom(l.item_id)}: good`, type: 'number', required: true, default: num(l.qty) });
    fields.push({ k: l.id + '_d', label: '… damaged', type: 'number', default: 0 });
  });
  fields.push({ k: '_rem', label: 'Remarks (required for short, excess or damaged)', type: 'textarea' });
  const v = await ask({ title: 'Acknowledge receipt — ' + c.doc.issue_no,
    message: 'For each item enter the good quantity received and any damaged quantity. Damaged goes back to Stores automatically; short or excess is flagged to Stores.', fields, okText: 'Acknowledge' });
  if (!v) return;
  const payload = lines.map(l => ({ line_id: l.id, received_qty: num(v[l.id + '_g']), damaged_qty: num(v[l.id + '_d']) }));
  const res = await rpc('issue_acknowledge', { p_issue: c.doc.id, p_lines: payload, p_remarks: v._rem || null });
  const dmg = payload.some(p => p.damaged_qty > 0);
  toast(res === 'DISCREPANCY' ? 'Recorded with short / excess — Stores and Factory Manager alerted'
        : dmg ? 'Acknowledged — damaged items returned to Stores for replacement' : 'Receipt acknowledged', res === 'DISCREPANCY' || dmg ? 'info' : 'ok', 7000);
}

// "Receive material": the shop-floor view of posted issues awaiting acknowledgement
export const ack = {
  ...issue, key: 'ack', title: 'Receive Material', noCreate: true,
  statusField: 'ack_status', statusLabel: 'Receipt', statuses: ['PENDING', 'DISCREPANCY', 'ACKNOWLEDGED'], defaultTab: 'PENDING',
  list: { ...issue.list, columns: issue.list.columns.filter(c => c.k !== 'ack_status'), filter: q => q.eq('status', 'POSTED').not('ack_status', 'is', null) },
};
function pdfIssue(c) {
  const d = c.doc; const cost = canSeeCost();
  const lots = c.extra.lots || [];
  const lotText = l => lots.filter(x => x.issue_lines.item_id === l.item_id).map(x => `${x.stock_lots?.lot_no} (${qty(x.qty)})`).join(', ');
  const cols = [{ h: '#', k: r => c.grids.lines.indexOf(r) + 1, w: 8 }, { h: 'Item code', k: r => refRow('items', r.item_id)?.code }, { h: 'Description', k: r => refRow('items', r.item_id)?.name },
    { h: 'UoM', k: r => itemUom(r.item_id) }, { h: 'Qty issued', k: r => qty(r.qty), align: 'right' }, { h: 'Lots (FIFO)', k: lotText }];
  if (cost) cols.push({ h: 'Value AED', k: r => money(r.value), align: 'right' });
  return makePdf({
    title: 'Material Issue Slip', no: d.issue_no, date: d.issue_date,
    meta: [['Purpose', label(d.purpose)], ['Project / CC', refLabel('projects', d.project_id) || refLabel('cost_centers', d.cost_center_id)], ['Request no.', opts.mrs.find(m => m.id === d.mr_id)?.label || '-'],
           ['Issued from', refLabel('locations', d.from_location_id)], ['Received by', d.received_by_name || refLabel('employees', d.received_by_employee_id) || '-'], ['Remarks', d.remarks || '-']],
    columns: cols, rows: c.grids.lines,
    totals: cost ? [['Total value AED', money(d.total_value)]] : [],
    notes: d.ack_by ? `Receipt ${label(d.ack_status).toLowerCase()} by ${refLabel('profiles', d.ack_by)} on ${dt(d.ack_at)}${d.ack_remarks ? ' — ' + d.ack_remarks : ''}` : '',
    signatures: [['Issued by', 'Stores'], ['Received by', d.received_by_name || 'Shop floor'], ['Approved by', 'Production In-charge']],
  });
}

// ======================================================================
// MATERIAL RETURN (floor -> store)
// ======================================================================
async function loadPostedIssues(extraId) {
  const rows = must(await sb.from('material_issues').select('id,issue_no,issue_date,projects(code),cost_centers(code)').eq('status', 'POSTED').order('issue_date', { ascending: false }).limit(500));
  opts.issues = rows.map(r => ({ id: r.id, label: `${r.issue_no} — ${r.projects?.code || r.cost_centers?.code} (${dt(r.issue_date)})` }));
  if (extraId && !opts.issues.some(x => x.id === extraId)) {
    const r = must(await sb.from('material_issues').select('id,issue_no').eq('id', extraId).single());
    opts.issues.push({ id: r.id, label: r.issue_no });
  }
}
async function loadIssueIntoReturn(ctx, issueId) {
  const lines = must(await sb.from('issue_lines').select('*').eq('issue_id', issueId).order('line_no'));
  ctx.grids.lines = lines.filter(l => num(l.qty) > num(l.returned_qty)).map(l => ({ issue_line_id: l.id, item_id: l.item_id, _bal: num(l.qty) - num(l.returned_qty), qty: null, condition: 'GOOD' }));
  ctx.dirty = true;
}
export const ret = {
  key: 'ret', title: 'Returns to Store', single: 'Material Return', table: 'material_returns', noField: 'return_no', dateField: 'return_date',
  statuses: ['DRAFT', 'SUBMITTED', 'POSTED', 'CANCELLED'], createRoles: ['stores', 'shop_floor', 'production_incharge'],
  // floor drafts and submits; Stores verifies (can change qty / condition) and posts
  canEdit: ctx => (ctx.doc.status === 'DRAFT' && hasRole('stores', 'shop_floor', 'production_incharge')) || (ctx.doc.status === 'SUBMITTED' && hasRole('stores')),
  refs: ['items', 'locations'],
  list: { select: '*, material_issues(issue_no, projects(code), cost_centers(code))', columns: [{ k: r => r.material_issues?.issue_no, label: 'Issue' },
    { k: r => r.material_issues?.projects?.code || r.material_issues?.cost_centers?.code, label: 'Project / CC' }, { k: 'returned_by_name', label: 'Returned by' }, { k: 'total_value', label: 'Value', fmt: 'money', cost: true, sum: true }] },
  defaults: () => ({ return_date: today(), to_location_id: locId('MS'), returned_by_name: state.profile?.full_name || '' }),
  async onNew(ctx, parts) { await loadPostedIssues(); if (parts[0] === 'issue' && parts[1]) { ctx.doc.issue_id = parts[1]; await loadIssueIntoReturn(ctx, parts[1]); } },
  async afterLoad(ctx) { await loadPostedIssues(ctx.doc.issue_id); },
  header: [
    { k: 'issue_id', label: 'Against issue slip', type: 'ref', refOptions: () => opts.issues, required: true, wide: true, onChange: (d, v, ctx) => v && loadIssueIntoReturn(ctx, v) },
    { k: 'return_date', label: 'Return date', type: 'date', required: true },
    { k: 'to_location_id', label: 'Return to location', type: 'ref', ref: 'locations', required: true, filter: r => r.is_stock },
    { k: 'returned_by_name', label: 'Returned by' },
    roMoney('total_value', 'Credit value AED', { show: d => d.status === 'POSTED' }),
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  headerNote: ctx => ctx.doc.status === 'SUBMITTED'
    ? '<b>Stores:</b> physically check the material, correct the quantity / condition if needed, then click <b>Receive & post</b>.'
    : 'Shop floor: pick the issue slip, enter what you are returning and <b>Submit to Stores</b>. Good material goes back to its original lot (same cost and receipt date); damaged goes to Quarantine. The project is credited when Stores posts.',
  grids: [{
    key: 'lines', title: 'Items returned', table: 'return_lines', fk: 'return_id', lineNo: false, addable: false, saveKeys: ['issue_line_id'],
    fields: [itemF({ ro: true }), uomF, { k: '_bal', label: 'Returnable', type: 'ro', virtual: true, fmt: v => qty(v ?? ''), show: d => d.status === 'DRAFT' },
             roQty('requested_qty', 'Returned by floor', { show: d => ['SUBMITTED', 'POSTED'].includes(d.status) }),
             { k: 'qty', label: 'Return qty (verified)', type: 'number', required: true },
             { k: 'condition', label: 'Condition', type: 'select', required: true, options: ['GOOD', 'DAMAGED'] },
             { k: 'reason', label: 'Reason', width: '200px' }, roMoney('value', 'Credit value', { show: d => d.status === 'POSTED' })],
  }],
  validate(ctx) {
    ctx.grids.lines = ctx.grids.lines.filter(r => num(r.qty) > 0);
    if (!ctx.grids.lines.length) throw new Error('Enter a return quantity on at least one line');
    for (const r of ctx.grids.lines) if (r._bal !== undefined && num(r.qty) > num(r._bal)) throw new Error(`${itemName(r.item_id)}: max returnable ${qty(r._bal)}`);
  },
  actions: ctx => [
    { label: 'Submit to Stores', cls: 'primary', show: statusIs(ctx, 'DRAFT') && hasRole('shop_floor', 'production_incharge') && !hasRole('stores'), done: 'Sent to Stores for verification',
      run: c => rpc('return_action', { p_ret: c.doc.id, p_action: 'SUBMIT' }) },
    { label: '✔ Receive & post', cls: 'ok', show: statusIs(ctx, 'DRAFT', 'SUBMITTED') && hasRole('stores'), confirm: 'Material checked? Stock will be added back and the project credited.', done: 'Return posted',
      run: c => rpc('post_return', { p_ret: c.doc.id }) },
    { label: 'Cancel', show: statusIs(ctx, 'DRAFT', 'SUBMITTED') && ctx.editable, confirm: 'Cancel this return?', run: c => rpc('return_action', { p_ret: c.doc.id, p_action: 'CANCEL' }) },
    { label: '🖨 Return note PDF', reload: false, run: c => makePdf({
        title: 'Material Return Note', no: c.doc.return_no, date: c.doc.return_date,
        meta: [['Against issue', opts.issues.find(i => i.id === c.doc.issue_id)?.label || ''], ['Returned to', refLabel('locations', c.doc.to_location_id)], ['Returned by', c.doc.returned_by_name || '-'], ['Status', label(c.doc.status)]],
        columns: [{ h: '#', k: r => c.grids.lines.indexOf(r) + 1, w: 8 }, { h: 'Item', k: r => itemName(r.item_id) }, { h: 'UoM', k: r => itemUom(r.item_id) }, { h: 'Qty', k: r => qty(r.qty), align: 'right' },
                  { h: 'Condition', k: r => label(r.condition) }, { h: 'Reason', k: 'reason' }, ...(canSeeCost() ? [{ h: 'Value', k: r => money(r.value), align: 'right' }] : [])],
        rows: c.grids.lines, signatures: ['Returned by', 'Received by (Stores)', 'Production In-charge'] }) },
  ],
};

// ======================================================================
// STOCK TRANSFER
// ======================================================================
export const trf = {
  key: 'trf', title: 'Stock Transfers', single: 'Transfer', table: 'stock_transfers', noField: 'trf_no', dateField: 'trf_date',
  statuses: ['DRAFT', 'POSTED'], createRoles: ['stores'], refs: ['items', 'locations'],
  list: { select: '*, f:from_location_id(code), t:to_location_id(code)', columns: [{ k: r => r.f?.code, label: 'From' }, { k: r => r.t?.code, label: 'To' }, { k: 'remarks', label: 'Remarks' }] },
  defaults: () => ({ trf_date: today(), from_location_id: locId('MS') }),
  // from Quarantine & exceptions: release a held lot back to the main store
  async onNew(ctx, parts) {
    if (parts[0] !== 'lot' || !parts[1]) return;
    const l = must(await sb.from('stock_lots').select('id,item_id,location_id,qty_on_hand,lot_no').eq('id', parts[1]).single());
    Object.assign(ctx.doc, { from_location_id: l.location_id, to_location_id: locId('MS'), remarks: `Release of held lot ${l.lot_no} after inspection` });
    ctx.grids.lines = [{ item_id: l.item_id, lot_id: l.id, qty: num(l.qty_on_hand), _avail: num(l.qty_on_hand) }];
    ctx.dirty = true;
  },
  async afterLoad(ctx) { if (ctx.doc.status === 'DRAFT') await fillAvail(ctx, 'lines', ctx.doc.from_location_id); },
  header: [
    { k: 'from_location_id', label: 'From location', type: 'ref', ref: 'locations', required: true, filter: r => r.is_stock, onChange: (d, v, ctx) => fillAvail(ctx, 'lines', v) },
    { k: 'to_location_id', label: 'To location', type: 'ref', ref: 'locations', required: true, filter: r => r.is_stock },
    { k: 'trf_date', label: 'Date', type: 'date', required: true },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  headerNote: () => 'Lots keep their original receipt date and cost when moved. Moving out of Quarantine releases the HOLD.',
  grids: [{ key: 'lines', title: 'Items', table: 'transfer_lines', fk: 'transfer_id', order: 'line_no', saveKeys: ['lot_id'],
    fields: [itemF({ filter: r => r.is_active && r.item_classes?.tracking === 'LOT', onChange: (r, v, ctx) => fillAvail(ctx, 'lines', ctx.doc.from_location_id) }), uomF, { ...availF, show: d => d.status === 'DRAFT' },
             { k: 'qty', label: 'Qty', type: 'number', required: true }] }],
  validate(ctx) { if (ctx.doc.from_location_id === ctx.doc.to_location_id) throw new Error('From and To locations must differ'); },
  actions: ctx => [
    { label: '✔ Post transfer', cls: 'ok', show: statusIs(ctx, 'DRAFT') && hasRole('stores'), confirm: 'Post this transfer?', done: 'Transfer posted', run: c => rpc('post_transfer', { p_trf: c.doc.id }) },
    { label: '🖨 PDF', reload: false, run: c => makePdf({ title: 'Stock Transfer Note', no: c.doc.trf_no, date: c.doc.trf_date,
        meta: [['From', refLabel('locations', c.doc.from_location_id)], ['To', refLabel('locations', c.doc.to_location_id)], ['Status', label(c.doc.status)], ['Remarks', c.doc.remarks || '-']],
        columns: [{ h: '#', k: r => c.grids.lines.indexOf(r) + 1, w: 8 }, { h: 'Item', k: r => itemName(r.item_id) }, { h: 'UoM', k: r => itemUom(r.item_id) }, { h: 'Qty', k: r => qty(r.qty), align: 'right' }],
        rows: c.grids.lines, signatures: ['Sent by', 'Received by'] }) },
  ],
};

// ======================================================================
// STOCK ADJUSTMENT / PHYSICAL COUNT (FM approval)
// ======================================================================
async function systemQty(itemId, locationId) {
  const rows = must(await sb.from('v_lot_values').select('qty_on_hand').eq('item_id', itemId).eq('location_id', locationId));
  return rows.reduce((s, r) => s + num(r.qty_on_hand), 0);
}
export const adj = {
  key: 'adj', title: 'Stock Adjustments', single: 'Adjustment', table: 'stock_adjustments', noField: 'adj_no', dateField: 'adj_date',
  statuses: ['DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REJECTED'], createRoles: ['stores'], editStatuses: ['DRAFT', 'REJECTED'],
  refs: ['items', 'locations', 'profiles'],
  list: { select: '*, locations(code)', columns: [{ k: r => r.locations?.code, label: 'Location' }, { k: 'reason', label: 'Reason', fmt: 'label' }, { k: 'total_value', label: 'Net value', fmt: 'money', cost: true, sum: true }] },
  defaults: () => ({ adj_date: today(), reason: 'PHYSICAL_COUNT', location_id: locId('MS') }),
  header: [
    { k: 'location_id', label: 'Location', type: 'ref', ref: 'locations', required: true, filter: r => r.is_stock },
    { k: 'reason', label: 'Reason', type: 'select', required: true, options: ['PHYSICAL_COUNT', 'DAMAGE', 'EXPIRY', 'FOUND', 'OTHER'] },
    { k: 'adj_date', label: 'Date', type: 'date', required: true },
    { k: 'approved_by', label: 'Approved / rejected by', type: 'ro', fmt: v => refLabel('profiles', v), show: d => !!d.approved_by },
    { k: 'approval_comments', label: 'Approval comments', type: 'ro', show: d => !!d.approval_comments },
    roMoney('total_value', 'Net value AED', { show: d => d.status === 'POSTED' }),
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  grids: [{ key: 'lines', title: 'Count lines', table: 'adjustment_lines', fk: 'adj_id', lineNo: false,
    importers: [{ label: '⇩ Load all stock at location (count sheet)', run: async ctx => {
      const rows = must(await sb.from('v_lot_values').select('item_id,qty_on_hand').eq('location_id', ctx.doc.location_id));
      const m = {}; rows.forEach(r => { m[r.item_id] = (m[r.item_id] || 0) + num(r.qty_on_hand); });
      Object.entries(m).forEach(([item_id, q]) => { if (!ctx.grids.lines.some(l => l.item_id === item_id)) ctx.grids.lines.push({ item_id, system_qty: q, counted_qty: q }); });
      ctx.dirty = true;
    } }],
    fields: [itemF({ filter: r => r.is_active && r.item_classes?.tracking === 'LOT', onChange: async (r, v, ctx) => { r.system_qty = await systemQty(v, ctx.doc.location_id); if (r.counted_qty == null) r.counted_qty = r.system_qty; } }), uomF,
             roQty('system_qty', 'System qty'), { k: 'counted_qty', label: 'Counted qty', type: 'number', required: true },
             { k: '_diff', label: 'Difference', type: 'ro', virtual: true, fmt: (v, r) => qty(num(r.counted_qty) - num(r.system_qty)) },
             roMoney('value', 'Value', { show: d => d.status === 'POSTED' }), { k: 'remarks', label: 'Remarks' }],
    saveKeys: ['system_qty'] }],
  actions: ctx => [
    { label: 'Submit for approval', cls: 'primary', show: statusIs(ctx, 'DRAFT', 'REJECTED') && hasRole('stores'), done: 'Sent to Factory Manager', run: c => rpc('adj_action', { p_adj: c.doc.id, p_action: 'SUBMIT' }) },
    { label: '✔ Approve & post', cls: 'ok', show: statusIs(ctx, 'PENDING_APPROVAL') && hasRole('factory_manager'), confirm: 'Approve and post these stock differences?', done: 'Adjustment posted',
      run: c => rpc('adj_action', { p_adj: c.doc.id, p_action: 'APPROVE' }) },
    { label: '✖ Reject', cls: 'bad', show: statusIs(ctx, 'PENDING_APPROVAL') && hasRole('factory_manager'),
      run: async c => { const r = await reason('Reject adjustment'); if (r) return rpc('adj_action', { p_adj: c.doc.id, p_action: 'REJECT', p_comments: r }); } },
    { label: '🖨 Count sheet PDF', reload: false, run: c => makePdf({ title: 'Stock Count / Adjustment', no: c.doc.adj_no, date: c.doc.adj_date, subtitle: label(c.doc.status),
        meta: [['Location', refLabel('locations', c.doc.location_id)], ['Reason', label(c.doc.reason)]],
        columns: [{ h: '#', k: r => c.grids.lines.indexOf(r) + 1, w: 8 }, { h: 'Item', k: r => itemName(r.item_id) }, { h: 'UoM', k: r => itemUom(r.item_id) },
                  { h: 'System', k: r => qty(r.system_qty), align: 'right' }, { h: 'Counted', k: r => qty(r.counted_qty), align: 'right' }, { h: 'Diff', k: r => qty(num(r.counted_qty) - num(r.system_qty)), align: 'right' }],
        rows: c.grids.lines, signatures: ['Counted by', 'Store In-charge', 'Factory Manager'] }) },
  ],
};

// ======================================================================
// SCRAP NOTE (write-off / generation) and DISPOSAL
// ======================================================================
export const scrap = {
  key: 'scrap', title: 'Scrap Notes', single: 'Scrap Note', table: 'scrap_notes', noField: 'scrap_no', dateField: 'scrap_date',
  statuses: ['DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REJECTED'], createRoles: ['stores', 'production_incharge'], editStatuses: ['DRAFT', 'REJECTED'],
  refs: ['items', 'locations', 'projects', 'cost_centers', 'profiles'],
  list: { select: '*, projects(code), locations(code)', columns: [{ k: 'scrap_type', label: 'Type', fmt: 'label' }, { k: r => r.locations?.code, label: 'From' }, { k: r => r.projects?.code, label: 'Project' },
          { k: 'reason', label: 'Reason' }, { k: 'total_value', label: 'Written off', fmt: 'money', cost: true, sum: true }] },
  defaults: () => ({ scrap_date: today(), scrap_type: 'GENERATION' }),
  // from Quarantine & exceptions: write off a damaged held lot
  async onNew(ctx, parts) {
    if (parts[0] !== 'lot' || !parts[1]) return;
    const l = must(await sb.from('stock_lots').select('id,item_id,location_id,qty_on_hand,lot_no,project_id,hold_reason').eq('id', parts[1]).single());
    Object.assign(ctx.doc, { scrap_type: 'WRITE_OFF', location_id: l.location_id, project_id: l.project_id, reason: `Damaged stock (${label(l.hold_reason || '')}) — lot ${l.lot_no}` });
    ctx.grids.lines = [{ item_id: l.item_id, lot_id: l.id, qty: num(l.qty_on_hand), scrap_qty: 0 }];
    ctx.dirty = true;
  },
  header: [
    { k: 'scrap_type', label: 'Type', type: 'select', required: true, options: [{ v: 'GENERATION', l: 'Scrap generated on floor (offcuts, sawdust …)' }, { v: 'WRITE_OFF', l: 'Write-off stock to scrap (damaged / expired)' }] },
    { k: 'location_id', label: 'Write-off from location', type: 'ref', ref: 'locations', required: true, filter: r => r.is_stock, show: d => d.scrap_type === 'WRITE_OFF' },
    { k: 'project_id', label: 'Project (source)', type: 'ref', ref: 'projects' },
    { k: 'cost_center_id', label: 'Cost centre', type: 'ref', ref: 'cost_centers' },
    { k: 'scrap_date', label: 'Date', type: 'date', required: true },
    { k: 'approved_by', label: 'Approved / rejected by', type: 'ro', fmt: v => refLabel('profiles', v), show: d => !!d.approved_by },
    roMoney('total_value', 'Value written off AED', { show: d => d.status === 'POSTED' }),
    { k: 'reason', label: 'Reason', type: 'textarea', full: true, required: true },
  ],
  headerNote: () => 'Scrap items (class <b>Scrap</b>) are held in the Scrap Yard until disposed/sold through a Scrap Disposal.',
  grids: [{ key: 'lines', title: 'Lines', table: 'scrap_lines', fk: 'scrap_id', lineNo: false, saveKeys: ['lot_id'],
    fields: [
      { ...itemF({ filter: isLotItem, required: false }), label: 'Stock item written off', show: d => d.scrap_type === 'WRITE_OFF' },
      { k: 'qty', label: 'Qty written off', type: 'number', show: d => d.scrap_type === 'WRITE_OFF' },
      { k: 'scrap_item_id', label: 'Becomes scrap item', type: 'ref', ref: 'items', filter: isScrapItem, width: '220px' },
      { k: 'scrap_qty', label: 'Scrap qty (kg / nos)', type: 'number' },
      roMoney('value', 'Value', { show: d => d.status === 'POSTED' }),
      { k: 'remarks', label: 'Remarks' },
    ] }],
  actions: ctx => [
    { label: 'Submit for approval', cls: 'primary', show: statusIs(ctx, 'DRAFT', 'REJECTED') && hasRole('stores', 'production_incharge'), done: 'Sent to Factory Manager', run: c => rpc('scrap_action', { p_scr: c.doc.id, p_action: 'SUBMIT' }) },
    { label: '✔ Approve & post', cls: 'ok', show: statusIs(ctx, 'PENDING_APPROVAL') && hasRole('factory_manager'), confirm: 'Approve and post this scrap note?', done: 'Scrap posted',
      run: c => rpc('scrap_action', { p_scr: c.doc.id, p_action: 'APPROVE' }) },
    { label: '✖ Reject', cls: 'bad', show: statusIs(ctx, 'PENDING_APPROVAL') && hasRole('factory_manager'),
      run: async c => { const r = await reason('Reject scrap note'); if (r) return rpc('scrap_action', { p_scr: c.doc.id, p_action: 'REJECT', p_comments: r }); } },
    { label: '🖨 PDF', reload: false, run: c => makePdf({ title: 'Scrap Note', no: c.doc.scrap_no, date: c.doc.scrap_date, subtitle: label(c.doc.status),
        meta: [['Type', label(c.doc.scrap_type)], ['Location', refLabel('locations', c.doc.location_id) || '-'], ['Project', refLabel('projects', c.doc.project_id) || '-'], ['Reason', c.doc.reason || '']],
        columns: [{ h: 'Stock item', k: r => itemName(r.item_id) }, { h: 'Qty', k: r => qty(r.qty) || '', align: 'right' }, { h: 'Scrap item', k: r => itemName(r.scrap_item_id) }, { h: 'Scrap qty', k: r => qty(r.scrap_qty), align: 'right' },
                  ...(canSeeCost() ? [{ h: 'Value', k: r => money(r.value), align: 'right' }] : [])],
        rows: c.grids.lines, signatures: ['Prepared by', 'Store In-charge', 'Factory Manager'] }) },
  ],
};

export const disposal = {
  key: 'disposal', title: 'Scrap Disposals', single: 'Scrap Disposal', table: 'scrap_disposals', noField: 'disposal_no', dateField: 'disposal_date',
  statuses: ['DRAFT', 'PENDING_APPROVAL', 'PENDING_FINANCE', 'POSTED', 'REJECTED'], createRoles: ['stores'],
  // Stores drafts; Finance confirms sale rates & receipt at the final step
  canEdit: ctx => (['DRAFT', 'REJECTED'].includes(ctx.doc.status) && hasRole('stores')) || (ctx.doc.status === 'PENDING_FINANCE' && hasRole('finance')),
  refs: ['items', 'locations', 'profiles'],
  list: { select: '*', columns: [{ k: 'method', label: 'Method', fmt: 'label' }, { k: 'buyer_name', label: 'Buyer' }, { k: 'gate_pass_no', label: 'Gate pass' }, { k: 'total_amount', label: 'Sale value', fmt: 'money', cost: true, sum: true }] },
  defaults: () => ({ disposal_date: today(), method: 'SALE', vat_rate: 5, location_id: locId('SY') }),
  async afterLoad(ctx) { if (ctx.doc.status !== 'POSTED') await fillAvail(ctx, 'lines', ctx.doc.location_id); },
  header: [
    { k: 'method', label: 'Disposal method', type: 'select', required: true, options: ['SALE', 'RECYCLE', 'FREE_DISPOSAL', 'LANDFILL'] },
    { k: 'disposal_date', label: 'Date', type: 'date', required: true },
    { k: 'location_id', label: 'From location', type: 'ref', ref: 'locations', required: true, filter: r => r.is_stock },
    { k: 'buyer_name', label: 'Buyer / contractor', required: true },
    { k: 'buyer_trn', label: 'Buyer TRN' },
    { k: 'buyer_contact', label: 'Buyer contact' },
    { k: 'gate_pass_no', label: 'Gate pass no.' },
    { k: 'vehicle_no', label: 'Vehicle no.' },
    { k: 'weighbridge_ticket', label: 'Weighbridge ticket' },
    { k: 'vat_rate', label: 'VAT %', type: 'number', cost: true },
    roMoney('subtotal', 'Subtotal'), roMoney('vat_amount', 'VAT'), roMoney('total_amount', 'Total'),
    { k: 'payment_received', label: 'Payment received', type: 'check', show: d => d.method === 'SALE' },
    { k: 'receipt_ref', label: 'Receipt ref', show: d => d.method === 'SALE' },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  grids: [{ key: 'lines', title: 'Scrap items', table: 'disposal_lines', fk: 'disposal_id', lineNo: false,
    fields: [{ k: 'scrap_item_id', label: 'Scrap item', type: 'ref', ref: 'items', filter: isScrapItem, required: true, width: '240px', onChange: async (r, v, ctx) => { const m = await availableAt([v], ctx.doc.location_id); r._avail = m[v] || 0; } },
             { k: '_uom', label: 'UoM', type: 'ro', virtual: true, fmt: (v, r) => itemUom(r.scrap_item_id) }, { ...availF, show: d => d.status !== 'POSTED' },
             { k: 'qty', label: 'Qty', type: 'number', required: true }, { k: 'rate', label: 'Rate', type: 'number', cost: true },
             { k: '_amt', label: 'Amount', type: 'ro', virtual: true, cost: true, fmt: (v, r) => money(num(r.qty) * num(r.rate)) }] }],
  actions: ctx => [
    { label: 'Submit for approval', cls: 'primary', show: statusIs(ctx, 'DRAFT', 'REJECTED') && hasRole('stores'), done: 'Sent to Factory Manager', run: c => rpc('disposal_action', { p_d: c.doc.id, p_action: 'SUBMIT' }) },
    { label: '✔ Approve (Factory Manager)', cls: 'ok', show: statusIs(ctx, 'PENDING_APPROVAL') && hasRole('factory_manager'), done: 'Approved — sent to Finance',
      run: c => rpc('disposal_action', { p_d: c.doc.id, p_action: 'APPROVE' }) },
    { label: '✔ Confirm rates & post (Finance)', cls: 'ok', show: statusIs(ctx, 'PENDING_FINANCE') && hasRole('finance'),
      confirm: 'Confirm sale rates and post? Scrap stock will be released for the gate pass.', done: 'Disposal posted',
      run: c => rpc('disposal_action', { p_d: c.doc.id, p_action: 'APPROVE' }) },
    { label: '✖ Reject', cls: 'bad', show: (statusIs(ctx, 'PENDING_APPROVAL') && hasRole('factory_manager')) || (statusIs(ctx, 'PENDING_FINANCE') && hasRole('finance')),
      run: async c => { const r = await reason('Reject disposal'); if (r) return rpc('disposal_action', { p_d: c.doc.id, p_action: 'REJECT', p_comments: r }); } },
    { label: '💰 Record payment receipt', show: statusIs(ctx, 'POSTED') && hasRole('finance') && ctx.doc.method === 'SALE' && !ctx.doc.payment_received, done: 'Receipt recorded',
      run: async c => {
        const v = await ask({ title: 'Payment received from ' + c.doc.buyer_name, fields: [{ k: 'ref', label: 'Receipt / voucher ref', required: true }] });
        if (v) return upd('scrap_disposals', c.doc.id, { payment_received: true, receipt_ref: v.ref });
      } },
    { label: '🖨 Gate pass / sale note', reload: false, run: c => makePdf({ title: c.doc.method === 'SALE' ? 'Scrap Sale & Gate Pass' : 'Scrap Disposal Gate Pass', no: c.doc.disposal_no, date: c.doc.disposal_date, subtitle: label(c.doc.status),
        meta: [['Method', label(c.doc.method)], ['Buyer', c.doc.buyer_name], ['Buyer TRN', c.doc.buyer_trn || '-'], ['Contact', c.doc.buyer_contact || '-'], ['Gate pass', c.doc.gate_pass_no || '-'], ['Vehicle', c.doc.vehicle_no || '-'], ['Weighbridge', c.doc.weighbridge_ticket || '-']],
        columns: [{ h: 'Scrap item', k: r => itemName(r.scrap_item_id) }, { h: 'UoM', k: r => itemUom(r.scrap_item_id) }, { h: 'Qty', k: r => qty(r.qty), align: 'right' },
                  ...(canSeeCost() ? [{ h: 'Rate', k: r => money(r.rate), align: 'right' }, { h: 'Amount', k: r => money(num(r.qty) * num(r.rate)), align: 'right' }] : [])],
        rows: c.grids.lines, totals: canSeeCost() && c.doc.method === 'SALE' ? [['Subtotal', money(c.doc.subtotal)], [`VAT ${c.doc.vat_rate}%`, money(c.doc.vat_amount)], ['Total AED', money(c.doc.total_amount)]] : [],
        signatures: ['Stores', 'Factory Manager', 'Security (gate)', 'Buyer / driver'] }) },
  ],
};

// ======================================================================
// PURCHASE RETURN (to vendor)
// ======================================================================
async function loadPostedGrns(extraId) {
  const rows = must(await sb.from('grns').select('id,grn_no,grn_date,vendors(name)').eq('status', 'POSTED').not('vendor_id', 'is', null).order('grn_date', { ascending: false }).limit(500));
  opts.grns = rows.map(r => ({ id: r.id, label: `${r.grn_no} — ${r.vendors?.name} (${dt(r.grn_date)})` }));
  if (extraId && !opts.grns.some(x => x.id === extraId)) {
    const r = must(await sb.from('grns').select('id,grn_no').eq('id', extraId).single()); opts.grns.push({ id: r.id, label: r.grn_no });
  }
}
async function loadGrnIntoPrt(ctx, grnId) {
  const g = must(await sb.from('grns').select('vendor_id').eq('id', grnId).single());
  ctx.doc.vendor_id = g.vendor_id;
  const lines = must(await sb.from('grn_lines').select('id,item_id,received_qty,accepted_qty,rejected_qty,unit_cost_aed,rate,vat_rate').eq('grn_id', grnId).order('line_no'));
  const done = must(await sb.from('prt_lines').select('grn_line_id,qty,purchase_returns!inner(status,return_type)').in('grn_line_id', lines.map(l => l.id)).eq('purchase_returns.status', 'POSTED'));
  const type = ctx.doc.return_type;
  ctx.grids.lines = lines.map(l => {
    const already = done.filter(d => d.grn_line_id === l.id && d.purchase_returns.return_type === type).reduce((s, d) => s + num(d.qty), 0);
    const bal = (type === 'REJECTED_AT_GRN' ? num(l.rejected_qty) : num(l.accepted_qty)) - already;
    return { grn_line_id: l.id, item_id: l.item_id, _bal: bal, qty: type === 'REJECTED_AT_GRN' ? bal : null, rate_aed: num(l.unit_cost_aed), vat_rate: l.vat_rate };
  }).filter(l => l._bal > 0);
  ctx.dirty = true;
}
export const prt = {
  key: 'prt', title: 'Purchase Returns', single: 'Purchase Return', table: 'purchase_returns', noField: 'prt_no', dateField: 'return_date',
  statuses: ['DRAFT', 'POSTED'], createRoles: ['stores', 'purchase'], refs: ['items', 'vendors'],
  list: { select: '*, vendors(name), grns(grn_no)', columns: [{ k: r => r.vendors?.name, label: 'Vendor' }, { k: r => r.grns?.grn_no, label: 'GRN' }, { k: 'return_type', label: 'Type', fmt: 'label' }, { k: 'total_amount', label: 'Amount', fmt: 'money', cost: true, sum: true }] },
  defaults: () => ({ return_date: today(), return_type: 'REJECTED_AT_GRN', replacement_required: false }),
  async onNew(ctx, parts) { await loadPostedGrns(); if (parts[0] === 'grn' && parts[1]) { ctx.doc.grn_id = parts[1]; await loadGrnIntoPrt(ctx, parts[1]); } },
  async afterLoad(ctx) { await loadPostedGrns(ctx.doc.grn_id); },
  header: [
    { k: 'grn_id', label: 'Against GRN', type: 'ref', refOptions: () => opts.grns, required: true, wide: true, onChange: (d, v, ctx) => v && loadGrnIntoPrt(ctx, v) },
    { k: 'vendor_id', label: 'Vendor', type: 'ref', ref: 'vendors', ro: true },
    { k: 'return_type', label: 'Return type', type: 'select', required: true, options: [{ v: 'REJECTED_AT_GRN', l: 'Rejected at receipt (not in stock)' }, { v: 'FROM_STOCK', l: 'From stock (defect found later)' }],
      onChange: (d, v, ctx) => d.grn_id && loadGrnIntoPrt(ctx, d.grn_id) },
    { k: 'replacement_required', label: 'Replacement required', type: 'check', hint: 'Re-open PO qty', show: d => d.return_type === 'FROM_STOCK' },
    { k: 'return_date', label: 'Return date', type: 'date', required: true },
    { k: 'gate_pass_no', label: 'Gate pass no.' }, { k: 'vehicle_no', label: 'Vehicle no.' },
    roMoney('total_amount', 'Total AED', { show: d => d.status === 'POSTED' }),
    { k: 'reason', label: 'Reason', type: 'textarea', full: true, required: true },
  ],
  grids: [{ key: 'lines', title: 'Items returned', table: 'prt_lines', fk: 'prt_id', lineNo: false, addable: false, saveKeys: ['grn_line_id'],
    fields: [itemF({ ro: true }), uomF, { k: '_bal', label: 'Returnable', type: 'ro', virtual: true, fmt: v => qty(v ?? ''), show: d => d.status === 'DRAFT' },
             { k: 'qty', label: 'Return qty', type: 'number', required: true }, { k: 'rate_aed', label: 'Rate AED', type: 'number', cost: true }, { k: 'vat_rate', label: 'VAT %', type: 'number', cost: true },
             { k: '_amt', label: 'Amount', type: 'ro', virtual: true, cost: true, fmt: (v, r) => money(num(r.qty) * num(r.rate_aed)) }] }],
  validate(ctx) { ctx.grids.lines = ctx.grids.lines.filter(r => num(r.qty) > 0); if (!ctx.grids.lines.length) throw new Error('Enter at least one return quantity'); },
  actions: ctx => [
    { label: '✔ Post return', cls: 'ok', show: statusIs(ctx, 'DRAFT') && hasRole('stores', 'purchase'), confirm: 'Post this purchase return?', done: 'Purchase return posted', run: c => rpc('post_purchase_return', { p_prt: c.doc.id }) },
    { label: 'Raise debit note', show: statusIs(ctx, 'POSTED') && hasRole('finance'), reload: false, run: c => go(`d/dn/new/prt/${c.doc.id}`) },
    { label: '🖨 Return note PDF', reload: false, run: c => makePdf({ title: 'Purchase Return Note', no: c.doc.prt_no, date: c.doc.return_date,
        meta: [['Vendor', refLabel('vendors', c.doc.vendor_id)], ['GRN', opts.grns.find(g => g.id === c.doc.grn_id)?.label || ''], ['Type', label(c.doc.return_type)], ['Gate pass', c.doc.gate_pass_no || '-'], ['Vehicle', c.doc.vehicle_no || '-'], ['Reason', c.doc.reason || '']],
        columns: [{ h: 'Item', k: r => itemName(r.item_id) }, { h: 'UoM', k: r => itemUom(r.item_id) }, { h: 'Qty', k: r => qty(r.qty), align: 'right' },
                  ...(canSeeCost() ? [{ h: 'Rate', k: r => money(r.rate_aed), align: 'right' }, { h: 'Amount', k: r => money(num(r.qty) * num(r.rate_aed)), align: 'right' }] : [])],
        rows: c.grids.lines, totals: canSeeCost() ? [['Subtotal', money(c.doc.subtotal)], ['VAT', money(c.doc.vat_amount)], ['Total AED', money(c.doc.total_amount)]] : [],
        signatures: ['Stores', 'Purchase', 'Vendor / driver'] }) },
  ],
};

// ======================================================================
// VENDOR INVOICE (3-way match)
// ======================================================================
async function loadVendorPos(vendorId) {
  if (!vendorId) { opts.vpos = []; return; }
  const rows = must(await sb.from('purchase_orders').select('id,po_no').eq('vendor_id', vendorId).in('status', ['RELEASED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED']).order('po_date', { ascending: false }));
  opts.vpos = rows.map(r => ({ id: r.id, label: r.po_no }));
}
async function importGrnLines(ctx, grnId) {
  let q = sb.from('v_grn_not_invoiced').select('*').eq('vendor_id', ctx.doc.vendor_id);
  if (grnId) q = q.eq('grn_id', grnId);
  const rows = must(await q.order('grn_date'));
  if (!rows.length) throw new Error('No un-invoiced GRN lines for this vendor');
  const gl = must(await sb.from('grn_lines').select('id,rate,vat_rate,item_id,dn_qty,received_qty').in('id', rows.map(r => r.grn_line_id)));
  for (const r of rows) {
    if (ctx.grids.lines.some(l => l.grn_line_id === r.grn_line_id)) continue;
    const g = gl.find(x => x.id === r.grn_line_id);
    // billed default = what the supplier delivered per DN (or received), less anything already invoiced
    const delivered = Math.max(num(g?.dn_qty), num(g?.received_qty));
    const billed = Math.max(num(r.pending_qty), delivered - num(r.invoiced_qty));
    ctx.grids.lines.push({ grn_line_id: r.grn_line_id, item_id: r.item_id ?? g?.item_id, description: `${r.grn_no}: ${r.item_name}`,
      qty: billed, rate: num(g?.rate), vat_rate: num(g?.vat_rate), _pend: num(r.pending_qty) });
  }
  ctx.dirty = true;
}
// accepted-but-not-yet-invoiced qty per GRN line, for the claim preview on draft invoices
async function fillInvoicePending(ctx) {
  const ids = ctx.grids.lines.map(l => l.grn_line_id).filter(Boolean);
  if (!ids.length || ctx.doc.status !== 'DRAFT') return;
  const gl = must(await sb.from('grn_lines').select('id,accepted_qty').in('id', ids));
  const billed = must(await sb.from('vendor_invoice_lines').select('grn_line_id,qty,vendor_invoices!inner(status)').in('grn_line_id', ids).eq('vendor_invoices.status', 'POSTED'));
  ctx.grids.lines.forEach(l => {
    const g = gl.find(x => x.id === l.grn_line_id); if (!g) return;
    l._pend = num(g.accepted_qty) - billed.filter(b => b.grn_line_id === l.grn_line_id).reduce((s, b) => s + num(b.qty), 0);
  });
}
const invClaim = r => r.grn_line_id && r._pend !== undefined ? Math.max(num(r.qty) - Math.max(num(r._pend), 0), 0) : 0;
export const inv = {
  key: 'inv', title: 'Vendor Invoices', single: 'Vendor Invoice', table: 'vendor_invoices', noField: 'inv_no', dateField: 'invoice_date',
  statuses: ['DRAFT', 'POSTED', 'CANCELLED'], createRoles: ['finance'], refs: ['items', 'vendors', 'payment_terms'],
  list: { select: '*, vendors(name)', columns: [{ k: r => r.vendors?.name, label: 'Vendor' }, { k: 'vendor_invoice_no', label: 'Vendor inv no.' }, { k: 'due_date', label: 'Due', fmt: 'date' },
          { k: 'total_aed', label: 'Total AED', fmt: 'money', sum: true }, { k: 'has_variance', label: 'Variance', fmt: 'bool' }] },
  defaults: () => ({ invoice_date: today(), currency: 'AED', exchange_rate: 1 }),
  async onNew(ctx, parts) {
    if (parts[0] === 'grn' && parts[1]) {
      const g = must(await sb.from('grns').select('vendor_id,po_id,currency,exchange_rate,vendor_invoice_no,vendor_invoice_date').eq('id', parts[1]).single());
      Object.assign(ctx.doc, { vendor_id: g.vendor_id, po_id: g.po_id, currency: g.currency, exchange_rate: g.exchange_rate, vendor_invoice_no: g.vendor_invoice_no, invoice_date: g.vendor_invoice_date || today() });
      const v = refRow('vendors', g.vendor_id); if (v) ctx.doc.payment_term_id = v.payment_term_id;
      await loadVendorPos(g.vendor_id);
      await importGrnLines(ctx, parts[1]);
    }
  },
  async afterLoad(ctx) {
    await loadVendorPos(ctx.doc.vendor_id);
    await fillInvoicePending(ctx);
    ctx.extra.dns = must(await sb.from('vendor_debit_notes').select('id,dn_no,status,total_aed,auto_generated').eq('invoice_id', ctx.doc.id));
  },
  header: [
    { k: 'vendor_id', label: 'Vendor', type: 'ref', ref: 'vendors', required: true, wide: true,
      onChange: async (d, v) => { const vd = refRow('vendors', v); if (vd) { d.currency = vd.currency; d.payment_term_id = vd.payment_term_id; } await loadVendorPos(v); } },
    { k: 'vendor_invoice_no', label: 'Vendor tax invoice no.', required: true },
    { k: 'invoice_date', label: 'Invoice date', type: 'date', required: true },
    { k: 'po_id', label: 'PO', type: 'ref', refOptions: () => opts.vpos },
    { k: 'currency', label: 'Currency', required: true },
    { k: 'exchange_rate', label: 'Exchange rate', type: 'number', required: true },
    { k: 'payment_term_id', label: 'Payment terms', type: 'ref', ref: 'payment_terms' },
    { k: 'due_date', label: 'Due date (blank = from terms)', type: 'date' },
    { k: 'attachment_url', label: 'Scanned invoice link', wide: true },
    { k: 'has_variance', label: 'Price variance vs PO', type: 'ro', fmt: v => v ? 'YES — check' : 'No', show: d => d.status === 'POSTED' },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  headerNote: () => 'Load the goods received but not yet invoiced for this vendor (3-way match: PO → GRN → Invoice). Enter the <b>billed qty exactly as on the supplier invoice</b> — ' +
    'anything billed above the accepted qty (short / damaged / excess) becomes an automatic <b>draft debit note</b> on posting. The due date comes from the payment terms.',
  grids: [{ key: 'lines', title: 'Invoice lines', table: 'vendor_invoice_lines', fk: 'invoice_id', lineNo: false, saveKeys: ['grn_line_id', 'grn_charge_id'],
    newRow: () => ({ qty: 1, vat_rate: 5 }),
    importers: [
      { label: '⇩ Un-invoiced GRN lines', run: ctx => { if (!ctx.doc.vendor_id) throw new Error('Select vendor first'); return importGrnLines(ctx); } },
      { label: '⇩ Landed-cost charges', run: async ctx => {
          if (!ctx.doc.vendor_id) throw new Error('Select vendor first');
          const ch = must(await sb.from('grn_charges').select('id,charge_type,reference,amount_aed,vat_amount,grns!inner(grn_no,status)').eq('vendor_id', ctx.doc.vendor_id).eq('grns.status', 'POSTED'));
          const billed = must(await sb.from('vendor_invoice_lines').select('grn_charge_id,vendor_invoices!inner(status)').in('grn_charge_id', ch.map(c => c.id)).eq('vendor_invoices.status', 'POSTED')).map(b => b.grn_charge_id);
          const open = ch.filter(c => !billed.includes(c.id) && !ctx.grids.lines.some(l => l.grn_charge_id === c.id));
          if (!open.length) throw new Error('No un-invoiced charges for this vendor');
          open.forEach(c => ctx.grids.lines.push({ grn_charge_id: c.id, description: `${c.grns.grn_no}: ${label(c.charge_type)} ${c.reference || ''}`, qty: 1, rate: num(c.amount_aed), vat_rate: num(c.amount_aed) ? Math.round(num(c.vat_amount) / num(c.amount_aed) * 10000) / 100 : 0 }));
          ctx.dirty = true;
        } },
    ],
    fields: [{ ...itemF({ required: false }), width: '200px' }, { k: 'description', label: 'Description', width: '220px' },
             { k: '_pend', label: 'Accepted (GRN)', type: 'ro', virtual: true, fmt: v => v === undefined ? '' : qty(v), show: d => d.status === 'DRAFT' },
             { k: 'qty', label: 'Billed qty', type: 'number', required: true },
             { k: '_claim', label: 'Claim qty', type: 'ro', virtual: true, fmt: (v, r) => { const c = invClaim(r); return c > 0 ? '⚠ ' + qty(c) : ''; }, show: d => d.status === 'DRAFT' },
             { k: 'claim_qty', label: 'Claim qty', type: 'ro', fmt: v => num(v) ? '⚠ ' + qty(v) : '', show: d => d.status === 'POSTED' },
             { k: 'rate', label: 'Rate', type: 'number', required: true }, { k: 'vat_rate', label: 'VAT %', type: 'number' },
             { k: '_amt', label: 'Amount', type: 'ro', virtual: true, fmt: (v, r) => money(num(r.qty) * num(r.rate)) },
             { k: '_vat', label: 'VAT', type: 'ro', virtual: true, fmt: (v, r) => money(num(r.qty) * num(r.rate) * num(r.vat_rate) / 100) }] }],
  totals: ctx => {
    const sub = ctx.grids.lines.reduce((s, r) => s + num(r.qty) * num(r.rate), 0);
    const vat = ctx.grids.lines.reduce((s, r) => s + num(r.qty) * num(r.rate) * num(r.vat_rate) / 100, 0);
    return [{ l: 'Subtotal', v: sub }, { l: 'VAT', v: vat }, { l: 'Total ' + ctx.doc.currency, v: sub + vat }, { l: 'Total AED', v: (sub + vat) * num(ctx.doc.exchange_rate) }];
  },
  async loadInfo(ctx) {
    if (ctx.doc.status !== 'POSTED') return [];
    const b = must(await sb.from('v_invoice_balances').select('*').eq('id', ctx.doc.id));
    const out = [{ title: 'Payment status', rows: b, columns: [{ k: 'total_aed', label: 'Total', fmt: 'money' }, { k: 'paid_aed', label: 'Paid', fmt: 'money' }, { k: 'dn_aed', label: 'Debit notes', fmt: 'money' },
      { k: 'balance_aed', label: 'Balance', fmt: 'money' }, { k: 'due_date', label: 'Due', fmt: 'date' }, { k: 'aging_bucket', label: 'Aging', fmt: 'badge' }] }];
    if (ctx.extra.dns?.length) out.push({ title: 'Debit notes on this invoice', rows: ctx.extra.dns, columns: [{ k: 'dn_no', label: 'Debit note' },
      { k: r => r.auto_generated ? 'Automatic claim' : 'Manual', label: 'Type' }, { k: 'total_aed', label: 'Total AED', fmt: 'money' }, { k: 'status', label: 'Status', fmt: 'badge' }] });
    return out;
  },
  actions: ctx => [
    { label: '➖ Review suggested debit note', cls: 'primary', show: (ctx.extra.dns || []).some(d => d.auto_generated && d.status === 'DRAFT') && hasRole('finance'), reload: false,
      run: c => go('d/dn/' + c.extra.dns.find(d => d.auto_generated && d.status === 'DRAFT').id) },
    { label: '✔ Post invoice', cls: 'ok', show: statusIs(ctx, 'DRAFT') && hasRole('finance'), confirm: 'Post this invoice to payables?', done: 'Invoice posted', run: c => rpc('post_vendor_invoice', { p_inv: c.doc.id }) },
    { label: '💳 Make payment', show: statusIs(ctx, 'POSTED') && hasRole('finance'), reload: false, run: c => go(`d/pay/new/vendor/${c.doc.vendor_id}`) },
    { label: 'Cancel', show: statusIs(ctx, 'DRAFT') && hasRole('finance'), confirm: 'Cancel this draft invoice?', run: c => upd('vendor_invoices', c.doc.id, { status: 'CANCELLED' }) },
  ],
};

// ======================================================================
// DEBIT NOTE
// ======================================================================
async function loadVendorDocs(vendorId) {
  if (!vendorId) { opts.prts = []; opts.invs = []; return; }
  const p = must(await sb.from('purchase_returns').select('id,prt_no,total_amount').eq('vendor_id', vendorId).eq('status', 'POSTED'));
  opts.prts = p.map(r => ({ id: r.id, label: `${r.prt_no} (AED ${money(r.total_amount)})`, row: r }));
  const i = must(await sb.from('v_invoice_balances').select('id,inv_no,vendor_invoice_no,balance_aed,due_date').eq('vendor_id', vendorId).order('due_date'));
  opts.invs = i.map(r => ({ id: r.id, label: `${r.vendor_invoice_no} / ${r.inv_no} — bal ${money(r.balance_aed)} due ${dt(r.due_date)}`, row: r }));
}
export const dn = {
  key: 'dn', title: 'Debit Notes', single: 'Debit Note', table: 'vendor_debit_notes', noField: 'dn_no', dateField: 'dn_date',
  statuses: ['DRAFT', 'POSTED', 'CANCELLED'], createRoles: ['finance'], refs: ['vendors'],
  list: { select: '*, vendors(name)', columns: [{ k: r => r.vendors?.name, label: 'Vendor' }, { k: r => r.auto_generated ? 'Auto claim' : 'Manual', label: 'Source' },
          { k: 'reason', label: 'Reason' }, { k: 'total_aed', label: 'Total AED', fmt: 'money', sum: true }] },
  defaults: () => ({ dn_date: today(), vat_amount: 0 }),
  headerNote: ctx => ctx.doc.auto_generated ? 'Suggested automatically when the invoice was posted: the supplier billed more than was accepted. Check the amount against the supplier\'s credit / claim, adjust if needed, then post.' : '',
  async onNew(ctx, parts) {
    if (parts[0] === 'prt' && parts[1]) {
      const p = must(await sb.from('purchase_returns').select('*').eq('id', parts[1]).single());
      Object.assign(ctx.doc, { vendor_id: p.vendor_id, prt_id: p.id, amount_aed: p.subtotal, vat_amount: p.vat_amount, reason: `Purchase return ${p.prt_no}: ${p.reason || ''}` });
      await loadVendorDocs(p.vendor_id);
    }
  },
  async afterLoad(ctx) { await loadVendorDocs(ctx.doc.vendor_id); },
  header: [
    { k: 'vendor_id', label: 'Vendor', type: 'ref', ref: 'vendors', required: true, wide: true, onChange: (d, v) => loadVendorDocs(v) },
    { k: 'dn_date', label: 'Date', type: 'date', required: true },
    { k: 'prt_id', label: 'Purchase return', type: 'ref', refOptions: () => opts.prts },
    { k: 'invoice_id', label: 'Against invoice (optional)', type: 'ref', refOptions: () => opts.invs, wide: true },
    { k: 'amount_aed', label: 'Amount AED (excl. VAT)', type: 'number', required: true },
    { k: 'vat_amount', label: 'VAT AED', type: 'number' },
    { k: 'total_aed', label: 'Total AED', type: 'ro', fmt: (v, d) => money(num(d.amount_aed) + num(d.vat_amount)), virtual: true },
    { k: 'reason', label: 'Reason', type: 'textarea', full: true, required: true },
  ],
  actions: ctx => [
    { label: '✔ Post debit note', cls: 'ok', show: statusIs(ctx, 'DRAFT') && hasRole('finance'), confirm: 'Post this debit note? It reduces the vendor payable.', done: 'Debit note posted', run: c => rpc('post_debit_note', { p_dn: c.doc.id }) },
    { label: '🖨 PDF', reload: false, run: c => makePdf({ title: 'Debit Note', no: c.doc.dn_no, date: c.doc.dn_date, subtitle: label(c.doc.status),
        meta: [['Vendor', refLabel('vendors', c.doc.vendor_id)], ['Vendor TRN', refRow('vendors', c.doc.vendor_id)?.trn || '-'], ['Purchase return', opts.prts.find(p => p.id === c.doc.prt_id)?.label || '-'], ['Invoice', opts.invs.find(i => i.id === c.doc.invoice_id)?.label || '-']],
        columns: [{ h: 'Description', k: 'reason' }, { h: 'Amount', k: r => money(r.amount_aed), align: 'right' }, { h: 'VAT', k: r => money(r.vat_amount), align: 'right' }, { h: 'Total', k: r => money(num(r.amount_aed) + num(r.vat_amount)), align: 'right' }],
        rows: [c.doc], signatures: ['Prepared by', 'Finance Manager', 'Vendor acknowledgement'] }) },
  ],
};

// ======================================================================
// PAYMENT VOUCHER
// ======================================================================
export const pay = {
  key: 'pay', title: 'Payments', single: 'Payment Voucher', table: 'vendor_payments', noField: 'payment_no', dateField: 'payment_date',
  statuses: ['DRAFT', 'POSTED', 'CANCELLED', 'BOUNCED'], createRoles: ['finance'], refs: ['vendors'],
  list: { select: '*, vendors(name)', columns: [{ k: r => r.vendors?.name, label: 'Vendor' }, { k: 'mode', label: 'Mode', fmt: 'label' }, { k: 'reference_no', label: 'Ref / cheque' },
          { k: 'cheque_date', label: 'Cheque date', fmt: 'date' }, { k: 'amount_aed', label: 'Amount AED', fmt: 'money', sum: true }] },
  defaults: () => ({ payment_date: today(), mode: 'BANK_TRANSFER', currency: 'AED' }),
  async onNew(ctx, parts) { if (parts[0] === 'vendor' && parts[1]) { ctx.doc.vendor_id = parts[1]; await loadVendorDocs(parts[1]); await loadVendorPos(parts[1]); } },
  async afterLoad(ctx) { await loadVendorDocs(ctx.doc.vendor_id); await loadVendorPos(ctx.doc.vendor_id); },
  header: [
    { k: 'vendor_id', label: 'Vendor', type: 'ref', ref: 'vendors', required: true, wide: true, onChange: async (d, v, ctx) => { ctx.grids.alloc = []; await loadVendorDocs(v); await loadVendorPos(v); } },
    { k: 'payment_date', label: 'Payment date', type: 'date', required: true },
    { k: 'mode', label: 'Mode', type: 'select', required: true, options: ['BANK_TRANSFER', 'CHEQUE', 'PDC', 'CASH', 'LC'] },
    { k: 'bank_name', label: 'Bank' },
    { k: 'reference_no', label: 'Cheque / transfer ref' },
    { k: 'cheque_date', label: 'Cheque (PDC) date', type: 'date', show: d => ['CHEQUE', 'PDC'].includes(d.mode) },
    { k: 'amount_aed', label: 'Amount AED', type: 'number', required: true },
    { k: 'currency', label: 'Paid currency' },
    { k: 'fc_amount', label: 'Foreign currency amount', type: 'number', show: d => d.currency && d.currency !== 'AED' },
    { k: 'po_id', label: 'Advance against PO', type: 'ref', refOptions: () => opts.vpos },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  headerNote: () => 'Allocate the payment to invoices below. Any unallocated amount is kept as an <b>advance</b> and can be allocated later.',
  grids: [{ key: 'alloc', title: 'Allocation to invoices', table: 'payment_allocations', fk: 'payment_id', lineNo: false,
    importers: [{ label: '⚡ Auto-allocate (oldest due first)', run: ctx => {
      let left = num(ctx.doc.amount_aed) - ctx.grids.alloc.reduce((s, r) => s + num(r.amount_aed), 0);
      for (const o of opts.invs) {
        if (left <= 0) break;
        if (ctx.grids.alloc.some(a => a.invoice_id === o.id)) continue;
        const amt = Math.min(left, num(o.row.balance_aed));
        if (amt > 0) { ctx.grids.alloc.push({ invoice_id: o.id, amount_aed: Math.round(amt * 100) / 100 }); left -= amt; }
      }
      ctx.dirty = true;
    } }],
    fields: [{ k: 'invoice_id', label: 'Invoice', type: 'ref', refOptions: () => opts.invs, required: true, width: '380px' },
             { k: 'amount_aed', label: 'Amount AED', type: 'number', required: true }] }],
  validate(ctx) {
    const a = ctx.grids.alloc.reduce((s, r) => s + num(r.amount_aed), 0);
    if (a > num(ctx.doc.amount_aed) + 0.005) throw new Error('Allocated amount exceeds payment amount');
  },
  totals: ctx => {
    const a = ctx.grids.alloc.reduce((s, r) => s + num(r.amount_aed), 0);
    return [{ l: 'Payment', v: num(ctx.doc.amount_aed) }, { l: 'Allocated', v: a }, { l: 'Advance / unallocated', v: num(ctx.doc.amount_aed) - a }];
  },
  actions: ctx => [
    { label: '✔ Post payment', cls: 'ok', show: statusIs(ctx, 'DRAFT') && hasRole('finance'), confirm: 'Post this payment voucher?', done: 'Payment posted', run: c => rpc('post_payment', { p_pay: c.doc.id }) },
    { label: 'Allocate advance', show: statusIs(ctx, 'POSTED') && hasRole('finance'), done: 'Allocated',
      run: async c => {
        const v = await ask({ title: 'Allocate to invoice', fields: [{ k: 'inv', label: 'Invoice', type: 'select', required: true, options: opts.invs.filter(o => num(o.row.balance_aed) > 0).map(o => ({ v: o.id, l: o.label })) }, { k: 'amt', label: 'Amount AED', type: 'number', required: true }] });
        if (v) return rpc('allocate_payment', { p_pay: c.doc.id, p_invoice: v.inv, p_amount: v.amt });
      } },
    { label: '🖨 Payment voucher', reload: false, run: c => makePdf({ title: 'Payment Voucher', no: c.doc.payment_no, date: c.doc.payment_date, subtitle: label(c.doc.status),
        meta: [['Pay to', refLabel('vendors', c.doc.vendor_id)], ['Mode', label(c.doc.mode)], ['Bank', c.doc.bank_name || '-'], ['Reference', c.doc.reference_no || '-'], ['Cheque date', dt(c.doc.cheque_date) || '-'], ['Amount AED', money(c.doc.amount_aed)]],
        columns: [{ h: 'Invoice', k: r => opts.invs.find(o => o.id === r.invoice_id)?.label || r.invoice_id }, { h: 'Allocated AED', k: r => money(r.amount_aed), align: 'right' }],
        rows: c.grids.alloc, totals: pay.totals(c).map(t => [t.l, money(t.v)]), notes: c.doc.remarks || '', signatures: ['Prepared by', 'Finance Manager', 'Authorised signatory', 'Received by'] }) },
  ],
};

// ======================================================================
// STOCK RELEASE: project-reserved leftovers -> general stock (FM approval)
// ======================================================================
async function loadReservedLots(ctx) {
  if (!ctx.doc.project_id) throw new Error('Select the project first');
  const lots = must(await sb.from('v_project_reserved').select('*').eq('project_id', ctx.doc.project_id).order('item_code'));
  if (!lots.length) throw new Error('This project has no reserved stock');
  for (const l of lots) {
    if (ctx.grids.lines.some(x => x.lot_id === l.lot_id)) continue;
    ctx.grids.lines.push({ lot_id: l.lot_id, item_id: l.item_id, qty: num(l.qty_on_hand), _lot: l.lot_no, _loc: l.location_code, _avail: num(l.qty_on_hand), _age: l.age_days });
  }
  ctx.dirty = true;
}
export const rel = {
  key: 'rel', title: 'Project Stock Releases', single: 'Stock Release', table: 'stock_releases', noField: 'release_no', dateField: 'release_date',
  statuses: ['DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REJECTED'], createRoles: ['stores', 'production_incharge'], editStatuses: ['DRAFT', 'REJECTED'],
  refs: ['items', 'projects', 'profiles'],
  list: { select: '*, projects(code,name)', columns: [{ k: r => r.projects ? `${r.projects.code} — ${r.projects.name}` : '', label: 'Project' }, { k: 'reason', label: 'Reason' },
          { k: 'total_value', label: 'Value released', fmt: 'money', cost: true, sum: true }] },
  defaults: () => ({ release_date: today() }),
  async afterLoad(ctx) {
    if (!ctx.grids.lines.length) return;
    const lots = must(await sb.from('stock_lots').select('id,lot_no,qty_on_hand,locations(code)').in('id', ctx.grids.lines.map(l => l.lot_id)));
    ctx.grids.lines.forEach(l => { const x = lots.find(q => q.id === l.lot_id); if (x) Object.assign(l, { _lot: x.lot_no, _loc: x.locations?.code, _avail: num(x.qty_on_hand) }); });
  },
  header: [
    { k: 'project_id', label: 'Project', type: 'ref', ref: 'projects', required: true, wide: true, onChange: (d, v, ctx) => { ctx.grids.lines = []; } },
    { k: 'release_date', label: 'Date', type: 'date', required: true },
    { k: 'approved_by', label: 'Approved / rejected by', type: 'ro', fmt: v => refLabel('profiles', v), show: d => !!d.approved_by },
    { k: 'approval_comments', label: 'Approval comments', type: 'ro', show: d => !!d.approval_comments },
    roMoney('total_value', 'Value released AED', { show: d => d.status === 'POSTED' }),
    { k: 'reason', label: 'Reason', type: 'textarea', full: true, required: true },
  ],
  headerNote: () => 'Moves stock that is still <b>reserved</b> for the project (never issued) back to general stock. Cost and receipt date stay the same. Material already issued to the floor comes back through <b>Return from floor</b> instead.',
  grids: [{ key: 'lines', title: 'Reserved lots to release', table: 'release_lines', fk: 'release_id', lineNo: false, addable: false, saveKeys: ['lot_id', 'item_id'],
    importers: [{ label: '⇩ Load reserved stock of project', run: ctx => loadReservedLots(ctx) }],
    fields: [itemF({ ro: true }), uomF,
             { k: '_lot', label: 'Lot', type: 'ro', virtual: true }, { k: '_loc', label: 'Location', type: 'ro', virtual: true },
             { k: '_avail', label: 'Reserved now', type: 'ro', virtual: true, fmt: v => qty(v ?? '') },
             { k: 'qty', label: 'Release qty', type: 'number', required: true },
             roMoney('value', 'Value', { show: d => d.status === 'POSTED' })] }],
  validate(ctx) {
    ctx.grids.lines = ctx.grids.lines.filter(r => num(r.qty) > 0);
    if (!ctx.grids.lines.length) throw new Error('Load the reserved stock and enter at least one release qty');
    for (const r of ctx.grids.lines) if (r._avail !== undefined && num(r.qty) > num(r._avail)) throw new Error(`${itemName(r.item_id)}: only ${qty(r._avail)} reserved in lot ${r._lot}`);
  },
  actions: ctx => [
    { label: 'Submit for approval', cls: 'primary', show: statusIs(ctx, 'DRAFT', 'REJECTED') && hasRole('stores', 'production_incharge'), done: 'Sent to Factory Manager',
      run: c => rpc('release_action', { p_rel: c.doc.id, p_action: 'SUBMIT' }) },
    { label: '✔ Approve & release', cls: 'ok', show: statusIs(ctx, 'PENDING_APPROVAL') && hasRole('factory_manager'), confirm: 'Release this stock to general stock? Other projects will be able to use it.', done: 'Released to general stock',
      run: c => rpc('release_action', { p_rel: c.doc.id, p_action: 'APPROVE' }) },
    { label: '✖ Reject', cls: 'bad', show: statusIs(ctx, 'PENDING_APPROVAL') && hasRole('factory_manager'),
      run: async c => { const r = await reason('Reject release'); if (r) return rpc('release_action', { p_rel: c.doc.id, p_action: 'REJECT', p_comments: r }); } },
    { label: '🖨 PDF', reload: false, run: c => makePdf({ title: 'Project Stock Release', no: c.doc.release_no, date: c.doc.release_date, subtitle: label(c.doc.status),
        meta: [['Project', refLabel('projects', c.doc.project_id)], ['Reason', c.doc.reason || ''], ['Approved by', refLabel('profiles', c.doc.approved_by) || '-']],
        columns: [{ h: 'Item', k: r => itemName(r.item_id) }, { h: 'Lot', k: '_lot' }, { h: 'Location', k: '_loc' }, { h: 'UoM', k: r => itemUom(r.item_id) }, { h: 'Qty released', k: r => qty(r.qty), align: 'right' },
                  ...(canSeeCost() ? [{ h: 'Value', k: r => money(r.value), align: 'right' }] : [])],
        rows: c.grids.lines, signatures: ['Stores', 'Production In-charge', 'Factory Manager'] }) },
  ],
};

export const DOCS = { pr, po, grn, mr, issue, ack, ret, trf, adj, scrap, disposal, prt, inv, dn, pay, rel };
