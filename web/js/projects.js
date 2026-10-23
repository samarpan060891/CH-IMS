// Projects: workspace (BOQ of made in-house / bought-out / service lines, unit codes, progress, cost & margin),
// own-team installation logs, and material planning (MRP) across all running projects.
import { reactive } from 'vue';
import { sb, state, must, run, rpc, hasRole, canSeeCost, go, today, refRow, refLabel, money, qty, dt, label, num, loadRef, loadRefs, toast } from './lib.js';
import { ask, confirmBox, Badge, uomPick, namePick } from './components.js';
import { loadXlsx } from './importer.js';
import { makePdf } from './pdf.js';

const popts = reactive({ boq: [], units: [] });
const CATS = [{ v: 'MANUFACTURED', l: 'Made in-house' }, { v: 'BOUGHT_OUT', l: 'Bought-out' }, { v: 'SERVICE', l: 'Service' }];
const itemOk = (r, row) => r.is_active && (
  row.category === 'MANUFACTURED' ? r.item_classes?.code === 'FG'
  : row.category === 'SERVICE' ? r.item_classes?.code === 'SRV'
  : !['FG', 'SRV'].includes(r.item_classes?.code) && !r.item_classes?.is_scrap);
const str = v => (v === null || v === undefined) ? '' : String(v).trim();
const norm = s => str(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function pickFile(accept) {
  return new Promise(res => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.onchange = () => res(i.files[0] || null); i.click(); });
}

// ---------- BOQ Excel: sheet "BOQ" (or first) + optional sheet "Units" ----------
const BOQ_COLS = ['Ref', 'Description', 'Category', 'Item code', 'UoM', 'Unit type', 'Unit codes', 'Qty per unit', 'Qty', 'Sell rate', 'Est cost per unit', 'Supply', 'Service by', 'Remarks'];
const UNIT_COLS = ['Unit code', 'Unit type', 'Building', 'Floor', 'Unit price', 'Description'];
async function boqTemplate() {
  const XLSX = await loadXlsx();
  const wb = XLSX.utils.book_new();
  const b = XLSX.utils.aoa_to_sheet([BOQ_COLS,
    ['K-01', 'Kitchen complete — 2BR type A', 'Made in-house', 'FG-KIT-2BRA', 'NOS', '2BR-A', '', 1, '', 18500, 11200, '', '', 'Drg K-01'],
    ['A-01', 'Built-in oven', 'Bought-out', 'APP-OVEN-60', 'NOS', '', 'A-101, A-102', 1, '', 2400, 1850, 'Site', '', ''],
    ['S-01', 'Kitchen installation', 'Service', 'SRV-INSTALL-KIT', 'NOS', '2BR-A', '', 1, '', 1200, 700, '', 'Subcontract', ''],
    ['S-02', 'Delivery to site', 'Service', 'SRV-TRUCK-3T', 'TRIP', '', '', '', 12, 450, 350, '', 'Hired', '']]);
  const u = XLSX.utils.aoa_to_sheet([UNIT_COLS, ['A-101', '2BR-A', 'Tower A', '1', 32000, ''], ['A-102', '2BR-A', 'Tower A', '1', 32000, '']]);
  b['!cols'] = BOQ_COLS.map((c, i) => ({ wch: i === 1 ? 34 : 13 })); u['!cols'] = UNIT_COLS.map(() => ({ wch: 13 }));
  XLSX.utils.book_append_sheet(wb, b, 'BOQ'); XLSX.utils.book_append_sheet(wb, u, 'Units');
  XLSX.writeFile(wb, 'project-boq-template.xlsx');
}
function col(keys, ...names) { return keys.find(k => names.includes(norm(k))); }
async function importBoq(ctx) {
  const XLSX = await loadXlsx();
  const f = await pickFile('.xlsx,.xls,.csv');
  if (!f) return;
  await loadRefs(['items']);
  const wb = XLSX.read(await f.arrayBuffer());
  const unitSheet = wb.SheetNames.find(n => norm(n) === 'units');
  // a file with only a Units sheet adds units to a project whose BOQ came from its order
  const sheetName = wb.SheetNames.find(n => norm(n) === 'boq') || (unitSheet && wb.SheetNames.length === 1 ? null : wb.SheetNames[0]);
  const rows = sheetName ? XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' }) : [];
  const byCode = Object.fromEntries((state.refs.items || []).map(r => [r.code.toUpperCase(), r]));
  const errs = [];
  // units first, so BOQ lines can refer to them
  let newUnits = 0;
  if (unitSheet) {
    const ur = XLSX.utils.sheet_to_json(wb.Sheets[unitSheet], { defval: '' });
    const k = Object.keys(ur[0] || {});
    const c = { code: col(k, 'unitcode', 'unit', 'code'), type: col(k, 'unittype', 'type'), bld: col(k, 'building', 'block', 'tower'), fl: col(k, 'floor', 'level'),
                price: col(k, 'unitprice', 'price', 'salevalue', 'value'), desc: col(k, 'description', 'remarks') };
    if (ur.length && !c.code) errs.push('Units sheet: column "Unit code" not found');
    const have = new Set(ctx.grids.units.map(u => str(u.unit_code).toUpperCase()));
    // unit type matched to the Unit type list ignoring spaces and case ("1BR" → "1 BR"); unknown types are refused
    const squash = s => str(s).replace(/\s+/g, '').toUpperCase();
    const types = Object.fromEntries((state.refs.lookups || []).filter(l => l.list_key === 'UNIT_TYPE' && l.is_active).map(l => [squash(l.value), l.value]));
    const badTypes = new Set(), adds = [];
    ur.forEach(r => {
      const code = str(r[c.code]); if (!code || have.has(code.toUpperCase())) return;
      const t = str(r[c.type]); if (t && !types[squash(t)]) { badTypes.add(t); return; }
      have.add(code.toUpperCase());
      adds.push({ unit_code: code, unit_type: t ? types[squash(t)] : null, building: str(r[c.bld]) || null, floor: str(r[c.fl]) || null,
        sale_value: str(r[c.price]) === '' ? null : Number(r[c.price]), description: str(r[c.desc]) || null, status: 'NOT_STARTED' });
    });
    if (badTypes.size) errs.push(`Unit type(s) not in the Unit type list: ${[...badTypes].join(', ')} — add them in Masters → Lists or correct the file`);
    else { ctx.grids.units.push(...adds); newUnits = adds.length; }
  }
  if (errs.length) throw new Error(errs.join(' · '));
  if (!rows.length && newUnits) { ctx.dirty = true; toast(`${newUnits} units imported — Save to keep them`, 'ok', 6000); return; }
  const out = parseBoqRows(rows, byCode);
  const cur = ctx.grids.boq;
  if (cur.length && await confirmBox('Replace BOQ', `Replace the ${cur.length} existing BOQ line(s)? Choose Cancel to add the imported lines below them. Lines already used by orders cannot be deleted.`)) {
    cur.forEach(r => { if (r.id) (ctx.removed.boq ||= []).push(r.id); });
    ctx.grids.boq = out;
  } else ctx.grids.boq = [...cur, ...out];
  ctx.dirty = true;
  toast(`${out.length} BOQ lines${newUnits ? ` and ${newUnits} units` : ''} imported — Save to allocate units`, 'ok', 6000);
}
// BOQ sheet rows → BOQ lines (item codes checked against the item master); throws the first errors found
function parseBoqRows(rows, byCode) {
  if (!rows.length) throw new Error('The BOQ sheet is empty');
  const errs = [];
  const k = Object.keys(rows[0]);
  const c = { ref: col(k, 'ref', 'boqref', 'item', 'itemno', 'no'), desc: col(k, 'description', 'desc'), cat: col(k, 'category', 'type', 'cat'),
    item: col(k, 'itemcode', 'code', 'productcode'), uom: col(k, 'uom', 'unit'), utype: col(k, 'unittype'), ucodes: col(k, 'unitcodes', 'units'),
    qpu: col(k, 'qtyperunit', 'perunit'), qty: col(k, 'qty', 'quantity', 'totalqty'), rate: col(k, 'sellrate', 'rate', 'unitrate', 'price'),
    cost: col(k, 'estcostperunit', 'estcost', 'costperunit', 'cost'), supply: col(k, 'supply', 'supplymode', 'delivery'), svc: col(k, 'serviceby', 'servicemode'), rem: col(k, 'remarks', 'notes') };
  if (!c.desc || !c.cat) throw new Error('Columns "Description" and "Category" are required — download the template');
  const cat = v => { const s = norm(v); return s.startsWith('m') || s.includes('inhouse') || s.includes('made') ? 'MANUFACTURED' : s.startsWith('b') || s.includes('buy') ? 'BOUGHT_OUT' : s.startsWith('s') ? 'SERVICE' : null; };
  const out = [];
  rows.forEach((r, i) => {
    if (!str(r[c.desc])) return;
    const ca = cat(r[c.cat]);
    if (!ca) { errs.push(`Row ${i + 2}: category must be Made in-house, Bought-out or Service`); return; }
    const code = str(r[c.item]); const it = code ? byCode[code.toUpperCase()] : null;
    if (code && !it) errs.push(`Row ${i + 2}: item code "${code}" not in item master`);
    if (it && !itemOk(it, { category: ca })) errs.push(`Row ${i + 2}: "${code}" is not a ${CATS.find(x => x.v === ca).l.toLowerCase()} item (FG for made in-house, SRV for services)`);
    const sup = norm(r[c.supply]); const svc = norm(r[c.svc]);
    out.push({ boq_ref: str(r[c.ref]) || null, description: str(r[c.desc]), category: ca, item_id: it?.id || null,
      uom: str(r[c.uom]) || it?.uoms?.code || null, unit_type: str(r[c.utype]) || null, unit_codes: str(r[c.ucodes]) || null,
      qty_per_unit: str(r[c.qpu]) === '' ? null : Number(r[c.qpu]), qty: str(r[c.qty]) === '' ? 0 : Number(r[c.qty]),
      sell_rate: Number(r[c.rate]) || 0, est_unit_cost: Number(r[c.cost]) || 0,
      supply_mode: ca !== 'BOUGHT_OUT' ? null : sup.startsWith('s') || sup.includes('direct') ? 'DIRECT_TO_SITE' : 'FACTORY',
      service_mode: ca !== 'SERVICE' ? null : svc.startsWith('o') || svc.includes('own') ? 'OWN_TEAM' : svc.startsWith('h') ? 'HIRED' : 'SUBCONTRACT',
      remarks: str(r[c.rem]) || null });
  });
  if (errs.length) throw new Error(errs.slice(0, 8).join(' · ') + (errs.length > 8 ? ` · …and ${errs.length - 8} more` : ''));
  return out;
}
// the same BOQ file read for a project quotation / order's lines (sheet "BOQ" or the first sheet)
export async function readBoqFile() {
  const XLSX = await loadXlsx();
  const f = await pickFile('.xlsx,.xls,.csv');
  if (!f) return null;
  await loadRefs(['items']);
  const wb = XLSX.read(await f.arrayBuffer());
  const sheetName = wb.SheetNames.find(n => norm(n) === 'boq') || wb.SheetNames[0];
  const byCode = Object.fromEntries((state.refs.items || []).map(r => [r.code.toUpperCase(), r]));
  return parseBoqRows(XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' }), byCode);
}
export { boqTemplate };

// ======================================================================
// PROJECT WORKSPACE
// ======================================================================
const planner = () => hasRole('factory_manager', 'production_incharge');
export const proj = {
  key: 'proj', title: 'Projects', single: 'Project', table: 'projects', noField: 'code', dateField: 'start_date',
  // customer projects are created by confirming a project order in Sales (the administrator can still add one here)
  statuses: ['OPEN', 'ON_HOLD', 'CLOSED'], defaultTab: 'OPEN', createRoles: [],
  canEdit: ctx => hasRole('factory_manager', 'production_incharge', 'finance') && ctx.doc.status !== 'CLOSED',
  headerEditable: () => planner(),
  refs: ['items', 'bom_templates', 'profiles', 'customers', 'uoms'], saveKeys: ['customer'],
  // sales / internal order jobs are opened from their sales order
  list: { select: '*', filter: q => q.in('project_type', ['PROJECT', 'MTS']), columns: [{ k: 'name', label: 'Project' }, { k: 'project_type', label: 'Type', fmt: 'label' }, { k: 'customer', label: 'Customer' },
    { k: 'end_date', label: 'Due', fmt: 'date' }, { k: r => r.billing_basis === 'UNIT' ? 'Unit-wise' : 'BOQ item', label: 'Billing' },
    { k: 'contract_value', label: 'Contract', fmt: 'money', cost: true, sum: true }],
    // a project order becomes a project when it is confirmed; until then list it here so it is not missed
    notice: async () => {
      const so = must(await sb.from('sales_orders').select('id,so_no,title,status').eq('so_type', 'PROJECT').in('status', ['DRAFT', 'REJECTED']).order('so_date'));
      return { text: `${so.length} project order${so.length === 1 ? '' : 's'} in Sales not confirmed yet — the project (with its BOQ) is created when the order is confirmed (✔ Confirm — create the project).`,
               items: so.map(o => ({ label: `${o.so_no} — ${o.title}`, to: 'd/so/' + o.id })) };
    } },
  defaults: () => ({ status: 'OPEN', project_type: 'PROJECT', billing_basis: 'BOQ_ITEM' }),
  header: [
    { k: 'code', label: 'Project code', required: true },
    { k: 'name', label: 'Project name', required: true, wide: true },
    { k: 'project_type', label: 'Type', type: 'select', required: true, options: [{ v: 'PROJECT', l: 'Customer project' }, { v: 'MTS', l: 'Make-to-stock order' }] },
    { k: 'customer_id', label: 'Customer / developer', type: 'ref', ref: 'customers', wide: true, show: d => d.project_type === 'PROJECT',
      onChange: (d, v) => { d.customer = refRow('customers', v)?.name || null; } },
    { k: 'customer', label: 'Customer (typed in earlier)', type: 'ro', show: d => !d.customer_id && !!d.customer },
    { k: 'site_address', label: 'Site address', wide: true },
    { k: 'start_date', label: 'Start', type: 'date' }, { k: 'end_date', label: 'Completion due', type: 'date' },
    { k: 'billing_basis', label: 'Billing basis', type: 'select', required: true, options: [{ v: 'BOQ_ITEM', l: 'Per BOQ item (qty × rate)' }, { v: 'UNIT', l: 'Per unit (unit price × progress / handover)' }] },
    { k: 'contract_value', label: 'Contract value AED (blank = BOQ total)', type: 'number', cost: true },
    { k: 'budget_material', label: 'Material budget AED', type: 'number', cost: true },
    { k: 'status', label: 'Status', type: 'select', required: true, options: ['OPEN', 'ON_HOLD', 'CLOSED'] },
  ],
  headerNote: ctx => (ctx.doc.boq_locked ? `<div style="margin-bottom:6px;padding:6px 10px;border-radius:6px;background:#eff6ff;border:1px solid #bfdbfe">🔒 <b>BOQ baseline locked</b>
    ${dt(ctx.doc.boq_locked_at)} — scope changes go through <b>Variation orders</b> (Factory Manager approval). New units can still be added; they are attached when a variation re-allocates the line.</div>` : '') +
    'BOQ lines are <b>Made in-house</b> (FG product → production orders), <b>Bought-out</b> (bought for the project, into the factory store or direct to site) or <b>Service</b> ' +
    '(installation, delivery: own team, subcontract or hired). To attach a line to units, enter a <b>Unit type</b> (all units of that type) or <b>Unit codes</b> (comma separated) with ' +
    '<b>Qty per unit</b> — the total qty is calculated on Save. Lines without units are billed as flat BOQ items.',
  grids: [
    { key: 'units', title: 'Units (apartments / villas)', table: 'project_units', fk: 'project_id', order: 'unit_code', lineNo: false,
      // grouped by building / batch: click a group to open its units
      groupBy: r => r.building, groupNoun: 'units',
      groupSummary: rows => {
        const c = {}; rows.forEach(r => { const t = r.unit_type || 'no type'; c[t] = (c[t] || 0) + 1; });
        const done = rows.filter(r => r.status === 'HANDED_OVER').length;
        return Object.entries(c).map(([t, n]) => `${n} ${t}`).join(', ') + (done ? ` · ${done} handed over` : '');
      },
      newRow: () => ({ status: 'NOT_STARTED' }),
      fields: [{ k: 'unit_code', label: 'Unit code', required: true, width: '100px' }, { k: 'unit_type', label: 'Unit type', type: 'lookup', list: 'UNIT_TYPE', width: '110px' },
        { k: 'building', label: 'Building', width: '100px' }, { k: 'floor', label: 'Floor', width: '60px' },
        { k: 'sale_value', label: 'Unit price AED', type: 'number', cost: true },
        { k: 'status', label: 'Status', type: 'ro', fmt: v => label(v || 'NOT_STARTED') },
        { k: 'handed_over_to', label: 'Handed over to', type: 'ro', fmt: (v, r) => v ? `${v} · ${dt(r.handed_over_at)}` : '' },
        { k: 'description', label: 'Description', width: '160px' }] },
    { key: 'boq', title: 'BOQ', table: 'boq_lines', fk: 'project_id', order: 'line_no',
      readonly: ctx => !!ctx.doc.boq_locked,
      newRow: () => ({ category: 'MANUFACTURED', qty: 0, sell_rate: 0, est_unit_cost: 0 }),
      importers: [{ label: '⬆ Import BOQ (Excel)', run: c => importBoq(c) }, { label: 'Template', run: () => boqTemplate() }],
      fields: [
        { k: 'boq_ref', label: 'Ref', width: '70px' },
        { k: 'description', label: 'Description', required: true, width: '200px' },
        { k: 'category', label: 'Category', type: 'select', required: true, options: CATS, width: '130px' },
        { k: 'item_id', label: 'Item / product / service', type: 'ref', ref: 'items', width: '200px', filter: itemOk,
          onChange: (r, v) => { const it = refRow('items', v); if (it && !r.uom) r.uom = it.uoms?.code; } },
        { k: 'uom', label: 'UoM', ...uomPick({ width: '80px' }) },
        { k: 'unit_type', label: 'Unit type', type: 'lookup', list: 'UNIT_TYPE', width: '110px' }, { k: 'unit_codes', label: 'Unit codes', width: '120px' },
        { k: 'qty_per_unit', label: 'Qty / unit', type: 'number' },
        { k: 'qty', label: 'Qty (auto with units)', type: 'number', required: true },
        { k: 'sell_rate', label: 'Sell rate', type: 'number', cost: true },
        { k: 'est_unit_cost', label: 'Est. cost / unit', type: 'number', cost: true },
        { k: '_amt', label: 'Amount', type: 'ro', virtual: true, cost: true, fmt: (v, r) => money(num(r.qty) * num(r.sell_rate)) },
        { k: 'supply_mode', label: 'Bought-out to', type: 'select', options: [{ v: 'FACTORY', l: 'Factory store' }, { v: 'DIRECT_TO_SITE', l: 'Direct to site' }] },
        { k: 'service_mode', label: 'Service by', type: 'select', options: [{ v: 'OWN_TEAM', l: 'Own team' }, { v: 'SUBCONTRACT', l: 'Subcontractor' }, { v: 'HIRED', l: 'Hired (per trip)' }] },
        { k: 'template_id', label: 'BOM template', type: 'ref', width: '150px',
          refOptions: r => (state.refs.bom_templates || []).filter(t => t.item_id === r.item_id && t.is_active).map(t => ({ id: t.id, label: `${t.name} (v${t.version})` })) },
        { k: 'remarks', label: 'Remarks', width: '120px' }] },
  ],
  totals: ctx => [
    { l: 'BOQ value', v: ctx.grids.boq.reduce((s, r) => s + num(r.qty) * num(r.sell_rate), 0), cost: true },
    { l: 'Estimated cost', v: ctx.grids.boq.reduce((s, r) => s + num(r.qty) * num(r.est_unit_cost), 0), cost: true },
  ],
  validate(ctx) {
    const seen = new Set();
    for (const u of ctx.grids.units) { const k = str(u.unit_code).toUpperCase(); if (seen.has(k)) throw new Error(`Unit code ${u.unit_code} is repeated`); seen.add(k); }
    for (const [i, r] of ctx.grids.boq.entries()) {
      if ((str(r.unit_type) || str(r.unit_codes)) && !(num(r.qty_per_unit) > 0)) throw new Error(`BOQ line ${i + 1}: enter Qty / unit`);
      if (r.category === 'MANUFACTURED' && !r.item_id) throw new Error(`BOQ line ${i + 1}: choose the FG product made in-house`);
    }
  },
  async afterSave(ctx) {
    if (ctx.grids.boq.some(r => str(r.unit_type) || str(r.unit_codes))) await rpc('boq_sync_units', { p_project: ctx.doc.id });
    await loadRef('boq_lines', true); await loadRef('projects', true);
  },
  async afterLoad(ctx) {
    await loadRef('bom_templates', true);
    const id = ctx.doc.id;
    ctx.extra.vos = must(await sb.from('variation_orders').select('id,vo_no,vo_date,title,client_ref,status,value_change').eq('project_id', id).order('created_at'));
    const [p, u, m, w, ins] = await Promise.all([
      sb.from('v_boq_progress').select('*').eq('project_id', id).order('line_no'),
      sb.from('v_unit_progress').select('*').eq('project_id', id).order('unit_code'),
      sb.from('v_project_margin').select('*').eq('project_id', id).maybeSingle(),
      sb.from('production_orders').select('id,wo_no,status,qty,qty_completed,due_date,description,is_rework').eq('project_id', id).order('created_at'),
      sb.from('install_logs').select('id,log_no,log_date,status,team_leader,total_cost').eq('project_id', id).order('log_date', { ascending: false }).limit(50)]);
    Object.assign(ctx.extra, { prog: must(p), units: must(u), margin: must(m), wos: must(w), ins: must(ins) });
  },
  async loadInfo(ctx) {
    const out = [], x = ctx.extra;
    if (x.margin && canSeeCost()) out.push({ title: 'Cost & margin to date (AED)', rows: [x.margin], columns: [
      { k: r => r.contract_value ?? r.boq_value, label: 'Contract / BOQ value', fmt: 'money' }, { k: 'boq_est_cost', label: 'Estimated cost', fmt: 'money' },
      { k: 'wip_value', label: 'Production WIP', fmt: 'money' }, { k: 'fg_in_store', label: 'FG in store', fmt: 'money' }, { k: 'dispatched_value', label: 'Delivered', fmt: 'money' },
      { k: 'reserved_stock', label: 'Bought, not delivered', fmt: 'money' }, { k: 'site_material', label: 'Site material', fmt: 'money' },
      { k: 'services_cost', label: 'Subcontract / hire', fmt: 'money' }, { k: 'install_labour', label: 'Own installation', fmt: 'money' },
      { k: r => num(r.scrap_written_off) + num(r.qc_pending_value) + num(r.other_costs), label: 'Scrap & other', fmt: 'money' },
      { k: 'total_cost', label: 'TOTAL COST', fmt: 'money' }, { k: 'margin', label: 'Margin', fmt: 'money' }, { k: 'margin_pct', label: 'Margin %', n: true }] });
    if (x.prog?.length) out.push({ title: 'BOQ progress', rows: x.prog, columns: [
      { k: 'boq_ref', label: 'Ref' }, { k: 'description', label: 'Description' }, { k: 'category', label: 'Category', fmt: 'label' }, { k: 'qty', label: 'Qty', fmt: 'qty' },
      { k: r => r.category === 'MANUFACTURED' ? `${qty(r.wo_qty)} / ${qty(r.produced_qty)}` : r.category === 'BOUGHT_OUT' ? `${qty(r.ordered_qty)} / ${qty(r.received_qty)}` : `${qty(r.ordered_qty)} / ${qty(r.received_qty)}`,
        label: 'Ordered / produced or received' },
      { k: 'delivered_qty', label: 'Delivered', fmt: 'qty' }, { k: 'installed_qty', label: 'Installed', fmt: 'qty' }, { k: 'installed_pct', label: '% installed', n: true },
      { k: 'contract_value', label: 'Contract', fmt: 'money', cost: true, sum: true }, { k: 'earned_value', label: 'Earned (installed)', fmt: 'money', cost: true, sum: true },
      { k: 'est_cost', label: 'Est. cost', fmt: 'money', cost: true, sum: true }, { k: 'actual_cost', label: 'Actual cost', fmt: 'money', cost: true, sum: true }] });
    if (x.units?.length) out.push({ title: 'Unit progress', rows: x.units, columns: [
      { k: 'unit_code', label: 'Unit' }, { k: 'unit_type', label: 'Type' }, { k: 'building', label: 'Building' }, { k: 'status', label: 'Status', fmt: 'badge' },
      { k: r => `${r.lines_done}/${r.boq_lines}`, label: 'BOQ lines done' }, { k: 'progress_pct', label: 'Progress %', n: true },
      { k: 'sale_value', label: 'Unit price', fmt: 'money', cost: true, sum: true }, { k: 'earned_value', label: 'Earned', fmt: 'money', cost: true, sum: true },
      { k: r => r.handed_over_to ? `${r.handed_over_to} · ${dt(r.handed_over_at)}` : '', label: 'Handover' }] });
    if (x.vos?.length) out.push({ title: 'Variation orders', rows: x.vos, columns: [{ k: 'vo_no', label: 'VO' }, { k: 'vo_date', label: 'Date', fmt: 'date' },
      { k: 'title', label: 'Title' }, { k: 'client_ref', label: 'Client ref' }, { k: 'value_change', label: 'Value change', fmt: 'money', cost: true, sum: true }, { k: 'status', label: 'Status', fmt: 'badge' }] });
    if (x.wos?.length) out.push({ title: 'Production orders', rows: x.wos, columns: [{ k: 'wo_no', label: 'Order' }, { k: r => (r.is_rework ? '↻ ' : '') + (r.description || ''), label: 'Description' },
      { k: 'qty', label: 'Qty', fmt: 'qty' }, { k: 'qty_completed', label: 'To FG', fmt: 'qty' }, { k: 'due_date', label: 'Due', fmt: 'date' }, { k: 'status', label: 'Status', fmt: 'badge' }] });
    if (x.ins?.length) out.push({ title: 'Installation logs', rows: x.ins, columns: [{ k: 'log_no', label: 'Log' }, { k: 'log_date', label: 'Date', fmt: 'date' },
      { k: 'team_leader', label: 'Team leader' }, { k: 'total_cost', label: 'Labour cost', fmt: 'money', cost: true, sum: true }, { k: 'status', label: 'Status', fmt: 'badge' }] });
    return out;
  },
  actions: ctx => {
    if (!ctx.doc.id) return [];
    const open = ctx.doc.status === 'OPEN';
    return [
      { label: '🏭 Production orders from BOQ', show: open && planner(), run: c => boqToWos(c) },
      { label: '➕ One production order', show: open && planner(), reload: false, run: c => go('d/wo/new/proj/' + c.doc.id) },
      { label: '🛒 Requisition traded items', show: open && hasRole('stores', 'purchase', 'production_incharge', 'factory_manager'), reload: false, run: c => go('d/pr/new/proj/' + c.doc.id) },
      { label: '🔧 Installation log', show: open && hasRole('shop_floor', 'production_incharge', 'factory_manager', 'site_supervisor'), reload: false, run: c => go('d/ins/new/proj/' + c.doc.id) },
      { label: '🏠 Unit status / handover', show: open && hasRole('production_incharge', 'factory_manager', 'site_supervisor') && ctx.grids.units.length > 0, run: c => unitStatus(c) },
      { label: '🔒 Lock BOQ baseline', show: open && !ctx.doc.boq_locked && hasRole('factory_manager') && ctx.grids.boq.length > 0,
        confirm: 'Lock the BOQ as the agreed baseline? After this, scope changes are made only through approved variation orders.', done: 'BOQ baseline locked',
        run: c => rpc('project_lock_boq', { p_project: c.doc.id, p_lock: true }) },
      { label: '🔓 Unlock BOQ', show: !!ctx.doc.boq_locked && hasRole('factory_manager'), danger: true,
        confirm: 'Unlock the BOQ for direct editing? Changes will no longer be tracked as variations (the unlock is recorded in the audit log).', done: 'BOQ unlocked',
        run: c => rpc('project_lock_boq', { p_project: c.doc.id, p_lock: false }) },
      { label: '📝 New variation order', show: open && hasRole('factory_manager', 'production_incharge', 'finance'), reload: false, run: c => go('d/vo/new/proj/' + c.doc.id) },
      { label: '🧮 Material planning', show: open, reload: false, run: c => go('mrp/' + c.doc.id) },
    ];
  },
};

async function boqToWos(c) {
  const rows = (c.extra.prog || []).filter(r => r.category === 'MANUFACTURED' && num(r.qty) - num(r.wo_qty) > 0.0005);
  if (!rows.length) throw new Error('All made in-house BOQ lines already have production orders');
  const v = await ask({ title: 'Create production orders', message: 'Quantity still to be put on production orders for each made in-house BOQ line. Set 0 to skip; you can split a line into several orders (batches by floor or building).',
    fields: [...rows.map(r => ({ k: r.boq_line_id, label: `${r.boq_ref || ''} ${r.description} — remaining ${qty(num(r.qty) - num(r.wo_qty))}`, type: 'number', default: num(r.qty) - num(r.wo_qty) })),
      { k: '_due', label: 'Due date', type: 'date', default: c.doc.end_date || '' }], okText: 'Create' });
  if (!v) return;
  let n = 0;
  for (const r of rows) if (num(v[r.boq_line_id]) > 0) { await rpc('boq_create_wo', { p_line: r.boq_line_id, p_qty: num(v[r.boq_line_id]), p_due: v._due || null }); n++; }
  toast(`${n} production order(s) created as drafts — BOM template applied where one exists`, 'ok', 6000);
}
async function unitStatus(c) {
  const v = await ask({ title: 'Unit status / handover', fields: [
    { k: 'u', label: 'Unit', type: 'select', required: true, options: c.grids.units.filter(u => u.id).map(u => ({ v: u.id, l: `${u.unit_code} — ${label(u.status)}` })) },
    { k: 's', label: 'New status', type: 'select', required: true, options: [{ v: 'IN_PROGRESS', l: 'In progress' }, { v: 'INSTALLED', l: 'Installed' }, { v: 'SNAGGING', l: 'Snagging' }, { v: 'HANDED_OVER', l: 'Handed over' }] },
    { k: 'h', label: 'Handed over to (client representative)' }, { k: 'r', label: 'Remarks / snag list', type: 'textarea' }], okText: 'Update' });
  if (!v) return;
  await rpc('unit_set_status', { p_unit: v.u, p_status: v.s, p_handed_to: v.h || null, p_remarks: v.r || null });
  toast('Unit status updated', 'ok');
}

// ======================================================================
// INSTALLATION LOG (own team on site)
// ======================================================================
async function loadProjectOpts(projectId) {
  if (!projectId) { popts.boq = []; popts.units = []; return; }
  const [b, u] = await Promise.all([sb.from('boq_lines').select('id,line_no,boq_ref,description,category,qty').eq('project_id', projectId).order('line_no'),
    sb.from('project_units').select('id,unit_code,unit_type,status').eq('project_id', projectId).order('unit_code')]);
  popts.boq = must(b).map(r => ({ id: r.id, label: `${r.boq_ref || r.line_no} — ${r.description}` }));
  popts.units = must(u).map(r => ({ id: r.id, label: `${r.unit_code}${r.unit_type ? ' (' + r.unit_type + ')' : ''}` }));
}
export const ins = {
  key: 'ins', title: 'Installation Logs', single: 'Installation Log', table: 'install_logs', noField: 'log_no', dateField: 'log_date',
  statuses: ['DRAFT', 'POSTED'], createRoles: ['shop_floor', 'production_incharge', 'factory_manager', 'site_supervisor'],
  refs: ['projects', 'labour_grades', 'profiles', 'employees', 'vendors'],
  list: { select: '*, projects(code,name)', columns: [{ k: r => r.projects ? `${r.projects.code} — ${r.projects.name}` : '', label: 'Project' },
    { k: 'team_leader', label: 'Team leader' }, { k: 'notes', label: 'Notes' }, { k: 'total_cost', label: 'Labour cost', fmt: 'money', cost: true, sum: true }] },
  defaults: () => ({ log_date: today() }),
  async onNew(ctx, parts) { if (parts[0] === 'proj' && parts[1]) ctx.doc.project_id = parts[1]; await loadProjectOpts(ctx.doc.project_id); },
  async afterLoad(ctx) { await loadProjectOpts(ctx.doc.project_id); },
  header: [
    { k: 'project_id', label: 'Project / site', type: 'ref', ref: 'projects', required: true, wide: true, filter: r => r.status === 'OPEN' && r.project_type === 'PROJECT',
      onChange: (d, v) => loadProjectOpts(v) },
    { k: 'log_date', label: 'Date', type: 'date', required: true },
    // an employee, or a subcontractor from the vendor master
    { k: 'team_leader', label: 'Team leader / subcontractor', ...namePick('employees', { wide: true,
      refOptions: () => [...(state.refs.employees || []).filter(e => e.is_active).map(e => ({ id: e.name, label: e.name })),
        ...(state.refs.vendors || []).filter(v => v.status !== 'BLOCKED').map(v => ({ id: v.name, label: v.name + ' (subcontractor)' }))] }) },
    { k: 'total_cost', label: 'Labour cost AED', type: 'ro', fmt: v => money(v), cost: true, show: d => d.status === 'POSTED' },
    { k: 'notes', label: 'Notes / issues on site', type: 'textarea', full: true },
  ],
  headerNote: () => 'Record what was <b>installed today</b> per BOQ line and unit, and the <b>own crew</b> by grade (normal + overtime hours). Crew cost is spread over the lines by value. ' +
    'For work done by a <b>subcontractor</b>, record the installed quantities with no crew — their cost comes from the work-done certificate on their service PO.',
  grids: [
    { key: 'lines', title: 'Installed today', table: 'install_log_lines', fk: 'log_id', order: 'line_no', fields: [
      { k: 'boq_line_id', label: 'BOQ line', type: 'ref', required: true, width: '260px', refOptions: () => popts.boq },
      { k: 'unit_id', label: 'Unit', type: 'ref', width: '140px', refOptions: () => popts.units },
      { k: 'qty', label: 'Qty installed', type: 'number', required: true }, { k: 'remarks', label: 'Remarks', width: '180px' }] },
    { key: 'crew', title: 'Own crew', table: 'install_log_crew', fk: 'log_id', order: 'id', lineNo: false, newRow: () => ({ workers: 1, hours: 8, ot_hours: 0 }), fields: [
      { k: 'grade_id', label: 'Worker grade', type: 'ref', ref: 'labour_grades', required: true, width: '200px', filter: r => r.is_active },
      { k: 'workers', label: 'Workers', type: 'number', required: true }, { k: 'hours', label: 'Normal h each', type: 'number' }, { k: 'ot_hours', label: 'Overtime h each', type: 'number' },
      { k: '_cost', label: 'Cost', type: 'ro', virtual: true, cost: true, fmt: (v, r) => { const g = refRow('labour_grades', r.grade_id);
        return money(num(r.workers) * (num(r.hours) * num(g?.rate_per_hour) + num(r.ot_hours) * num(g?.ot_rate_per_hour))); } }] },
  ],
  actions: ctx => [
    { label: '✔ Post log', cls: 'ok', show: ctx.doc.status === 'DRAFT' && hasRole('shop_floor', 'production_incharge', 'factory_manager', 'site_supervisor'), done: 'Posted — progress and cost updated',
      confirm: 'Post this installation log? Installed quantities update the BOQ / unit progress and the crew cost is charged to the project.', run: c => rpc('post_install_log', { p_log: c.doc.id }) },
    { label: 'Open project', reload: false, run: c => go('d/proj/' + c.doc.project_id) },
  ],
};

// ======================================================================
// MATERIAL PLANNING (MRP)
// ======================================================================
export const Mrp = {
  components: { Badge },
  props: { projectId: String },
  data: () => ({ rows: [], loading: true, busy: false, proj: '', cls: '', cat: '', onlyShort: true }),
  computed: {
    projects() { return [...new Map(this.rows.map(r => [r.project_id, r.project_code])).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]))); },
    // categories of the materials on screen (narrowed by the class filter)
    cats() { return [...new Set(this.rows.filter(r => !this.cls || r.class_code === this.cls).map(r => r._cat).filter(Boolean))].sort(); },
    shown() {
      return this.rows.filter(r => (!this.proj || r.project_id === this.proj) && (!this.cls || r.class_code === this.cls) && (!this.cat || r._cat === this.cat)
        && (!this.onlyShort || Number(r.suggested_qty) > 0));
    },
    picked() { return this.shown.filter(r => r._pick && Number(r._qty) > 0); },
    canOrder() { return hasRole('purchase', 'stores', 'production_incharge', 'factory_manager'); },
  },
  async mounted() { this.proj = this.projectId || ''; await this.reload(); },
  methods: {
    qty, dt, label,
    async reload() {
      this.loading = true;
      await run(async () => {
        const rows = must(await sb.from('v_mrp').select('*').order('due_date', { nullsFirst: false }).order('project_code').order('item_code'));
        // item category (sub-category shown as "Category › Sub")
        const ids = [...new Set(rows.map(r => r.item_id))];
        const its = ids.length ? must(await sb.from('items').select('id, item_categories(name, parent:parent_id(name))').in('id', ids)) : [];
        const catOf = Object.fromEntries(its.map(i => { const c = i.item_categories; return [i.id, c ? (c.parent ? `${c.parent.name} › ${c.name}` : c.name) : '']; }));
        rows.forEach(r => {
          const s = Number(r.suggested_qty); const moq = Number(r.moq) || 0; r._qty = s > 0 ? Math.max(s, moq) : 0; r._pick = s > 0;
          r._cat = catOf[r.item_id] || '';
          // "BOQ AV-01 (to produce), BOQ AV-02 (to produce) …" → "14 BOQ lines (to produce)"; full list on hover
          const src = String(r.sources || '').split(', ').filter(Boolean), prod = src.filter(s => s.endsWith('(to produce)'));
          r._src = prod.length > 2 ? [`${prod.length} BOQ lines (to produce)`, ...src.filter(s => !s.endsWith('(to produce)'))].join(', ') : r.sources;
        });
        if (this.cat && !rows.some(r => r._cat === this.cat)) this.cat = '';
        this.rows = rows;
      });
      this.loading = false;
    },
    all(v) { this.shown.forEach(r => { if (Number(r._qty) > 0) r._pick = v; }); },
    async create() {
      if (!this.picked.length) return toast('Tick the lines to requisition', 'error');
      if (!(await confirmBox('Create requisitions', `Raise ${new Set(this.picked.map(r => r.project_id)).size} requisition(s) (one per project) for ${this.picked.length} line(s) and send them to Purchase?`))) return;
      this.busy = true;
      const n = await run(() => rpc('mrp_create_prs', { p_lines: this.picked.map(r => ({ project_id: r.project_id, item_id: r.item_id, qty: Number(r._qty), required_date: r.due_date, boq_line_id: r.boq_line_id })) }));
      this.busy = false;
      if (n) { toast(`${n} requisition(s) sent to Purchase`, 'ok'); await this.reload(); }
    },
  },
  template: `<div>
    <div class="card">
      <div class="row" style="flex-wrap:wrap;gap:10px">
        <label class="f" style="min-width:200px"><span>Project</span><select v-model="proj"><option value="">All running projects</option><option v-for="p in projects" :value="p[0]">{{ p[1] }}</option></select></label>
        <label class="f" style="min-width:140px"><span>Class</span><select v-model="cls" @change="cat=''"><option value="">All</option><option v-for="c in [...new Set(rows.map(r=>r.class_code))]" :value="c">{{ c }}</option></select></label>
        <label class="f" style="min-width:220px"><span>Category</span><select v-model="cat"><option value="">All</option><option v-for="c in cats" :value="c">{{ c }}</option></select></label>
        <label class="row small" style="gap:6px;margin-top:18px"><input type="checkbox" v-model="onlyShort"> Only lines to order</label>
        <span class="spacer"></span>
        <button class="btn sm" @click="reload" :disabled="loading">↻ Recalculate</button>
        <button class="btn sm" @click="all(true)">Tick all</button><button class="btn sm" @click="all(false)">Untick</button>
        <button v-if="canOrder" class="btn primary" :disabled="busy || !picked.length" @click="create">🛒 Create requisitions ({{ picked.length }})</button>
      </div>
      <p class="small muted" style="margin:8px 0 0">Demand = open production orders (not yet issued) + made in-house BOQ not yet on production orders × BOM template + bought-out BOQ not yet delivered + subcontract / hired services not yet certified.
        Each project first uses its own reserved stock and open orders; free stock and open stock POs then go to the earliest-due project.</p>
    </div>
    <div class="card">
      <div class="tbl-wrap"><table class="t">
        <thead><tr><th></th><th>Project</th><th>Item</th><th>Category</th><th>UoM</th><th>Due</th><th class="n">Gross need</th><th class="n">Project stock</th><th class="n">Project on order</th>
          <th class="n">Net need</th><th class="n">From free stock</th><th class="n">To order</th><th class="n" style="width:110px">Requisition qty</th><th>Sources</th></tr></thead>
        <tbody>
          <tr v-if="loading"><td colspan="14" class="empty">Calculating…</td></tr>
          <tr v-else-if="!shown.length"><td colspan="14" class="empty">Nothing to order — running projects are covered</td></tr>
          <tr v-for="r in shown" :key="r.project_id + r.item_id">
            <td><input type="checkbox" v-model="r._pick" :disabled="!(Number(r._qty) > 0)"></td>
            <td>{{ r.project_code }}</td><td><b>{{ r.item_code }}</b> {{ r.item_name }}<div class="small muted">{{ r.class_code }}{{ r.lead_time_days ? ' · lead ' + r.lead_time_days + 'd' : '' }}</div></td>
            <td class="small">{{ r._cat }}</td><td>{{ r.uom }}</td><td>{{ dt(r.due_date) }}</td>
            <td class="n">{{ qty(r.gross_req) }}</td><td class="n">{{ qty(r.project_stock) }}</td><td class="n">{{ qty(r.project_on_order) }}</td>
            <td class="n">{{ qty(r.net_req) }}</td><td class="n">{{ qty(r.from_free) }}</td><td class="n"><b>{{ qty(r.suggested_qty) }}</b></td>
            <td><input type="number" step="any" min="0" v-model.number="r._qty" style="width:100px" :title="r.moq ? 'MOQ ' + r.moq : ''"></td>
            <td class="small" :title="r.sources">{{ r._src }}</td>
          </tr>
        </tbody>
      </table></div>
    </div>
  </div>`,
};

// ======================================================================
// VARIATION ORDER (scope change after the BOQ baseline; Factory Manager approves)
// ======================================================================
const voOpts = reactive({ boq: [] });
async function loadVoBoq(projectId) {
  voOpts.boq = projectId ? must(await sb.from('boq_lines').select('id,line_no,boq_ref,description,qty,sell_rate').eq('project_id', projectId).order('line_no'))
    .map(r => ({ id: r.id, label: `${r.boq_ref || r.line_no} — ${r.description} (qty ${qty(r.qty)})` })) : [];
}
const voEditable = ctx => ['DRAFT', 'REJECTED'].includes(ctx.doc.status) && hasRole('factory_manager', 'production_incharge', 'finance');
export const vo = {
  key: 'vo', title: 'Variation Orders', single: 'Variation Order', table: 'variation_orders', noField: 'vo_no', dateField: 'vo_date',
  statuses: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'], createRoles: ['factory_manager', 'production_incharge', 'finance'],
  canEdit: voEditable, refs: ['projects', 'items', 'profiles', 'uoms'],
  list: { select: '*, projects(code,name)', columns: [{ k: r => r.projects ? `${r.projects.code} — ${r.projects.name}` : '', label: 'Project' },
    { k: 'title', label: 'Title' }, { k: 'client_ref', label: 'Client ref' }, { k: 'value_change', label: 'Value change', fmt: 'money', cost: true, sum: true }] },
  defaults: () => ({ vo_date: today() }),
  async onNew(ctx, parts) { if (parts[0] === 'proj' && parts[1]) ctx.doc.project_id = parts[1]; await loadVoBoq(ctx.doc.project_id); },
  async afterLoad(ctx) {
    await loadVoBoq(ctx.doc.project_id);
    ctx.extra.preview = must(await sb.from('v_vo_lines').select('*').eq('vo_id', ctx.doc.id).order('line_no'));
  },
  header: [
    { k: 'project_id', label: 'Project', type: 'ref', ref: 'projects', required: true, wide: true, filter: r => r.status === 'OPEN' && r.project_type === 'PROJECT',
      onChange: (d, v) => loadVoBoq(v) },
    { k: 'vo_date', label: 'Date', type: 'date', required: true },
    { k: 'title', label: 'Title', required: true, wide: true },
    { k: 'client_ref', label: 'Client / site instruction ref' },
    { k: 'value_change', label: 'Value change AED', type: 'ro', fmt: v => money(v), cost: true, show: d => d.status !== 'DRAFT' },
    { k: 'submitted_by', label: 'Submitted by', type: 'ro', fmt: (v, d) => v ? `${refLabel('profiles', v)} · ${dt(d.submitted_at)}` : '', show: d => !!d.submitted_by },
    { k: 'approved_by', label: 'Approved / rejected by', type: 'ro', fmt: (v, d) => v ? `${refLabel('profiles', v)} · ${dt(d.approved_at)}` : '', show: d => !!d.approved_by },
    { k: 'approval_comments', label: 'Approval comments', type: 'ro', wide: true, show: d => !!d.approval_comments },
    { k: 'reason', label: 'Reason / description of the change', type: 'textarea', full: true },
  ],
  headerNote: () => '<b>ADD</b> a new BOQ line (fill description, category, item, qty or unit type + qty per unit, rates). <b>CHANGE</b> an existing line — fill only the fields that change ' +
    '(e.g. new qty, new rate, or a unit type to re-attach units). <b>OMIT</b> removes a line that has nothing ordered, produced, delivered or installed. ' +
    'Save to see the before / after preview; on approval the BOQ is updated and the change is added to the contract value.',
  grids: [{ key: 'lines', title: 'Changes', table: 'vo_lines', fk: 'vo_id', order: 'line_no',
    newRow: () => ({ change_type: 'ADD' }),
    fields: [
      { k: 'change_type', label: 'Change', type: 'select', required: true, options: ['ADD', 'CHANGE', 'OMIT'], width: '95px' },
      { k: 'boq_line_id', label: 'BOQ line (change / omit)', type: 'ref', width: '230px', refOptions: () => voOpts.boq, ro: r => r.change_type === 'ADD' },
      { k: 'boq_ref', label: 'Ref', width: '70px', ro: r => r.change_type === 'OMIT' },
      { k: 'description', label: 'Description', width: '180px', ro: r => r.change_type === 'OMIT' },
      { k: 'category', label: 'Category', type: 'select', options: CATS, width: '125px', ro: r => r.change_type !== 'ADD' },
      { k: 'item_id', label: 'Item / product / service', type: 'ref', ref: 'items', width: '180px', filter: (r, row) => !row.category || itemOk(r, row), ro: r => r.change_type === 'OMIT' },
      { k: 'uom', label: 'UoM', ...uomPick({ width: '80px', ro: r => r.change_type === 'OMIT' }) },
      { k: 'unit_type', label: 'Unit type', type: 'lookup', list: 'UNIT_TYPE', width: '110px', ro: r => r.change_type === 'OMIT' },
      { k: 'unit_codes', label: 'Unit codes', width: '110px', ro: r => r.change_type === 'OMIT' },
      { k: 'qty_per_unit', label: 'Qty / unit', type: 'number', ro: r => r.change_type === 'OMIT' },
      { k: 'qty', label: 'New qty', type: 'number', ro: r => r.change_type === 'OMIT' },
      { k: 'sell_rate', label: 'New sell rate', type: 'number', cost: true, ro: r => r.change_type === 'OMIT' },
      { k: 'est_unit_cost', label: 'New est. cost', type: 'number', cost: true, ro: r => r.change_type === 'OMIT' },
      { k: 'remarks', label: 'Remarks', width: '120px' }] }],
  validate(ctx) {
    ctx.grids.lines.forEach((r, i) => {
      if (r.change_type !== 'ADD' && !r.boq_line_id) throw new Error(`Line ${i + 1}: choose the BOQ line to ${r.change_type.toLowerCase()}`);
      if (r.change_type === 'ADD' && (!r.description || !r.category)) throw new Error(`Line ${i + 1}: description and category are required for a new line`);
    });
  },
  async loadInfo(ctx) {
    const p = ctx.extra.preview || [];
    return p.length ? [{ title: ctx.doc.status === 'APPROVED' ? 'Applied to the BOQ' : 'Preview — before / after', rows: p, columns: [
      { k: 'change_type', label: 'Change', fmt: 'badge' }, { k: 'boq_ref', label: 'Ref' }, { k: 'description', label: 'Description' },
      { k: 'before_qty', label: 'Qty before', fmt: 'qty' }, { k: 'after_qty', label: 'Qty after', fmt: 'qty' },
      { k: 'before_rate', label: 'Rate before', fmt: 'money', cost: true }, { k: 'after_rate', label: 'Rate after', fmt: 'money', cost: true },
      { k: 'value_change', label: 'Value change', fmt: 'money', cost: true, sum: true }, { k: 'cost_change', label: 'Est. cost change', fmt: 'money', cost: true, sum: true }] }] : [];
  },
  actions: ctx => {
    const s = ctx.doc.status, fm = hasRole('factory_manager');
    return [
      { label: 'Submit for approval', cls: 'primary', show: ['DRAFT', 'REJECTED'].includes(s) && voEditable(ctx), done: 'Sent to the Factory Manager',
        run: c => rpc('vo_action', { p_vo: c.doc.id, p_action: 'SUBMIT' }) },
      { label: '✔ Approve & apply to BOQ', cls: 'ok', show: s === 'SUBMITTED' && fm, done: 'Approved — BOQ and contract value updated',
        confirm: 'Approve this variation? The BOQ is updated and the value change is added to the contract value.',
        run: c => rpc('vo_action', { p_vo: c.doc.id, p_action: 'APPROVE' }) },
      { label: '✖ Reject', cls: 'bad', show: s === 'SUBMITTED' && fm,
        run: async c => { const v = await ask({ title: 'Reject variation', fields: [{ k: 'r', label: 'Reason', type: 'textarea', required: true }], okText: 'Reject' });
          if (v) return rpc('vo_action', { p_vo: c.doc.id, p_action: 'REJECT', p_comments: v.r }); } },
      { label: 'Cancel', show: ['DRAFT', 'SUBMITTED', 'REJECTED'].includes(s) && hasRole('factory_manager', 'production_incharge', 'finance'), confirm: 'Cancel this variation?',
        run: c => rpc('vo_action', { p_vo: c.doc.id, p_action: 'CANCEL' }) },
      { label: 'Open project', reload: false, run: c => go('d/proj/' + c.doc.project_id) },
      { label: '🖨 PDF', reload: false, run: c => makePdf({
          title: 'Variation Order', no: c.doc.vo_no, date: c.doc.vo_date, subtitle: label(c.doc.status),
          meta: [['Project', refLabel('projects', c.doc.project_id)], ['Title', c.doc.title], ['Client ref', c.doc.client_ref || '-'],
                 ['Value change', canSeeCost() ? 'AED ' + money(c.doc.value_change) : '-'], ['Approved by', c.doc.approved_by ? refLabel('profiles', c.doc.approved_by) : '-']],
          columns: [{ h: 'Change', k: 'change_type' }, { h: 'Ref', k: 'boq_ref' }, { h: 'Description', k: 'description' },
                    { h: 'Qty before', k: r => qty(r.before_qty), align: 'right' }, { h: 'Qty after', k: r => qty(r.after_qty), align: 'right' },
                    ...(canSeeCost() ? [{ h: 'Rate', k: r => money(r.after_rate), align: 'right' }, { h: 'Value change', k: r => money(r.value_change), align: 'right' }] : [])],
          rows: c.extra.preview || [], totals: canSeeCost() ? [['Total value change AED', money((c.extra.preview || []).reduce((t, r) => t + num(r.value_change), 0))]] : [],
          notes: c.doc.reason || '', signatures: [['Prepared by', 'Citi Homes'], ['Approved by', 'Factory Manager'], ['Accepted by', 'Client']] }) },
    ];
  },
};

// ======================================================================
// SNAGS (site supervisor raises / fixes with photos, Production In-charge or FM verifies)
// ======================================================================
// photos: shrunk to max 1600 px JPEG on the phone, stored in the private "snags" bucket
export async function shrink(file, max = 1600) {
  try {
    const img = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return await new Promise(res => cv.toBlob(b => res(b), 'image/jpeg', 0.82));
  } catch { return file; }   // e.g. HEIC the browser cannot decode: upload as is
}
export async function addSnagPhotos(snag, kind, files) {
  let n = 0;
  for (const f of files) {
    const blob = await shrink(f);
    const ext = blob.type === 'image/jpeg' ? 'jpg' : (f.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `${snag.project_id}/${snag.id}/${kind.toLowerCase()}-${Date.now()}-${n}.${ext}`;
    must(await sb.storage.from('snags').upload(path, blob, { contentType: blob.type || f.type, upsert: false }));
    must(await sb.from('snag_photos').insert({ snag_id: snag.id, kind, path }));
    n++;
  }
  return n;
}
export function pickPhotos() {
  return new Promise(res => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.multiple = true; i.setAttribute('capture', 'environment');
    i.onchange = () => res([...(i.files || [])]); i.click();
  });
}
export const SnagPhotos = {
  props: { ctx: Object, snag: Object, compact: Boolean },
  data: () => ({ photos: [], busy: false, big: null }),
  computed: {
    s() { return this.snag || this.ctx?.doc; },
    canAdd() { return ['OPEN', 'FIXED'].includes(this.s?.status) && hasRole('site_supervisor', 'production_incharge', 'factory_manager'); },
  },
  async mounted() { await this.load(); },
  methods: {
    async load() {
      const rows = must(await sb.from('snag_photos').select('*').eq('snag_id', this.s.id).order('created_at'));
      if (rows.length) {
        const urls = must(await sb.storage.from('snags').createSignedUrls(rows.map(r => r.path), 3600));
        rows.forEach((r, i) => { r.url = urls[i]?.signedUrl; });
      }
      this.photos = rows;
    },
    async add(kind) {
      const files = await pickPhotos(); if (!files.length) return;
      this.busy = true;
      const n = await run(() => addSnagPhotos(this.s, kind, files));
      this.busy = false;
      if (n) { toast(`${n} photo(s) added`, 'ok'); await this.load(); }
    },
  },
  template: `<div :class="compact ? '' : 'card'">
    <div class="hd" v-if="!compact"><h3>Photos</h3><span class="spacer"></span>
      <template v-if="canAdd"><button class="btn sm" :disabled="busy" @click="add('BEFORE')">📷 Snag photo</button>
        <button class="btn sm" :disabled="busy" @click="add('AFTER')">📷 After fix</button></template></div>
    <div v-if="!photos.length" class="small muted">No photos yet</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px">
      <figure v-for="p in photos" :key="p.id" style="margin:0;width:120px">
        <img :src="p.url" @click="big = p.url" style="width:120px;height:90px;object-fit:cover;border-radius:6px;cursor:zoom-in;border:1px solid var(--line)">
        <figcaption class="small muted">{{ p.kind === 'AFTER' ? 'After fix' : 'Snag' }}</figcaption>
      </figure>
    </div>
    <div v-if="big" class="modal-bg" @click="big = null"><img :src="big" style="max-width:94vw;max-height:90vh;margin:auto;display:block;border-radius:8px"></div>
  </div>`,
};

const SNAG_CATS = ['FINISH', 'DAMAGE', 'ALIGNMENT', 'MISSING', 'HARDWARE', 'GAP_SEALANT', 'OTHER'];
export async function snagFixDialog(s) {
  await loadRef('labour_grades');
  const grades = (state.refs.labour_grades || []).filter(g => g.is_active);
  const v = await ask({ title: 'Mark fixed — ' + s.snag_no, message: 'Describe the fix and log the rework crew (optional). Add an "after" photo so the In-charge can verify.',
    fields: [{ k: 'n', label: 'What was done', type: 'textarea', required: true },
      { k: 'g', label: 'Crew grade', type: 'select', options: grades.map(g => ({ v: g.id, l: g.name })) },
      { k: 'w', label: 'Workers', type: 'number', default: 1 }, { k: 'h', label: 'Normal hours each', type: 'number' }, { k: 'o', label: 'Overtime hours each', type: 'number' }],
    okText: 'Mark fixed' });
  if (!v) return false;
  const crew = v.g && (num(v.h) + num(v.o)) > 0 ? [{ grade_id: v.g, workers: num(v.w) || 1, hours: num(v.h), ot_hours: num(v.o) }] : [];
  await rpc('snag_fix', { p_snag: s.id, p_notes: v.n, p_crew: crew });
  return true;
}
export async function snagVerifyDialog(s, accept) {
  const v = await ask({ title: (accept ? 'Accept fix — ' : 'Reopen — ') + s.snag_no, fields: [{ k: 'n', label: accept ? 'Remarks (optional)' : 'Why is the fix not accepted?', type: 'textarea', required: !accept }],
    okText: accept ? 'Close snag' : 'Reopen', danger: !accept });
  if (!v) return false;
  await rpc('snag_verify', { p_snag: s.id, p_accept: accept, p_notes: v.n || null });
  return true;
}
export const snag = {
  key: 'snag', title: 'Snag List', single: 'Snag', table: 'snags', noField: 'snag_no', dateField: 'snag_date',
  statuses: ['OPEN', 'FIXED', 'CLOSED', 'CANCELLED'], defaultTab: 'OPEN', createRoles: ['site_supervisor', 'production_incharge', 'factory_manager'],
  editStatuses: ['DRAFT', 'OPEN'], refs: ['projects', 'vendors', 'profiles', 'labour_grades'], panel: SnagPhotos,
  list: { select: '*, projects(code), project_units(unit_code)', columns: [{ k: r => r.projects?.code, label: 'Project' }, { k: r => r.project_units?.unit_code, label: 'Unit' },
    { k: 'location_text', label: 'Location' }, { k: 'description', label: 'Snag' }, { k: 'severity', label: 'Severity', fmt: 'badge' }, { k: 'responsible', label: 'By', fmt: 'label' },
    { k: 'due_date', label: 'Due', fmt: 'date' }, { k: 'reopen_count', label: 'Reopened', n: true }] },
  defaults: () => ({ snag_date: today(), category: 'FINISH', severity: 'MINOR', raised_by_party: 'INTERNAL', responsible: 'OWN_TEAM' }),
  async onNew(ctx, parts) {
    if (parts[0] === 'proj' && parts[1]) ctx.doc.project_id = parts[1];
    if (parts[2] === 'unit' && parts[3]) ctx.doc.unit_id = parts[3];
    await loadProjectOpts(ctx.doc.project_id);
  },
  async afterLoad(ctx) { await loadProjectOpts(ctx.doc.project_id); },
  header: [
    { k: 'project_id', label: 'Project', type: 'ref', ref: 'projects', required: true, wide: true, filter: r => r.status === 'OPEN' && r.project_type === 'PROJECT',
      onChange: (d, v) => { d.unit_id = null; d.boq_line_id = null; return loadProjectOpts(v); } },
    { k: 'unit_id', label: 'Unit', type: 'ref', refOptions: () => popts.units },
    { k: 'location_text', label: 'Location in unit (room / area)', type: 'lookup', list: 'ROOM' },
    { k: 'boq_line_id', label: 'BOQ line (optional)', type: 'ref', wide: true, refOptions: () => popts.boq },
    { k: 'description', label: 'Snag description', type: 'textarea', required: true, full: true },
    { k: 'category', label: 'Category', type: 'select', required: true, options: SNAG_CATS },
    { k: 'severity', label: 'Severity', type: 'select', required: true, options: ['MINOR', 'MAJOR', 'CRITICAL'] },
    { k: 'raised_by_party', label: 'Raised by', type: 'select', required: true, options: [{ v: 'INTERNAL', l: 'Our inspection' }, { v: 'CLIENT', l: 'Client' }, { v: 'CONSULTANT', l: 'Consultant' }] },
    { k: 'responsible', label: 'To be fixed by', type: 'select', required: true, options: [{ v: 'OWN_TEAM', l: 'Own team' }, { v: 'SUBCONTRACTOR', l: 'Subcontractor' }, { v: 'FACTORY', l: 'Factory (replace part)' }] },
    { k: 'vendor_id', label: 'Subcontractor', type: 'ref', ref: 'vendors', show: d => d.responsible === 'SUBCONTRACTOR' },
    { k: 'due_date', label: 'Fix by', type: 'date' },
    { k: 'fix_notes', label: 'Fix', type: 'ro', wide: true, fmt: (v, d) => v ? `${v} — ${refLabel('profiles', d.fixed_by)} · ${dt(d.fixed_at)}` : '', show: d => !!d.fix_notes },
    { k: 'verify_notes', label: 'Verification', type: 'ro', wide: true, fmt: (v, d) => `${v || 'Accepted'} — ${refLabel('profiles', d.verified_by)} · ${dt(d.verified_at)}`, show: d => !!d.verified_by },
    { k: 'reopen_count', label: 'Times reopened', type: 'ro', show: d => d.reopen_count > 0 },
    { k: 'labour_cost', label: 'Rework labour AED', type: 'ro', fmt: v => money(v), cost: true, show: d => num(d.labour_cost) > 0 },
  ],
  headerNote: () => 'Save the snag, then add photos. The <b>site supervisor</b> marks it fixed (with an after-photo and the rework crew); the <b>Production In-charge / Factory Manager</b> verifies and closes it — or reopens it. ' +
    'Material for the fix is issued against the snag. A unit cannot be handed over while it has open snags.',
  actions: ctx => {
    const s = ctx.doc.status;
    return [
      { label: '🔧 Mark fixed', cls: 'primary', show: s === 'OPEN' && hasRole('site_supervisor', 'production_incharge', 'factory_manager'), done: 'Marked fixed — sent for verification',
        run: c => snagFixDialog(c.doc) },
      { label: '✔ Accept & close', cls: 'ok', show: s === 'FIXED' && hasRole('production_incharge', 'factory_manager'), done: 'Snag closed', run: c => snagVerifyDialog(c.doc, true) },
      { label: '↺ Reopen', cls: 'bad', show: s === 'FIXED' && hasRole('production_incharge', 'factory_manager'), done: 'Snag reopened', run: c => snagVerifyDialog(c.doc, false) },
      { label: 'Cancel snag', show: ['OPEN', 'FIXED'].includes(s) && hasRole('production_incharge', 'factory_manager'),
        run: async c => { const v = await ask({ title: 'Cancel snag', fields: [{ k: 'r', label: 'Reason (e.g. duplicate, not our scope)', type: 'textarea', required: true }], okText: 'Cancel snag', danger: true });
          if (v) return rpc('snag_cancel', { p_snag: c.doc.id, p_reason: v.r }); } },
      { label: 'Open project', reload: false, run: c => go('d/proj/' + c.doc.project_id) },
    ];
  },
};

export const PROJ_DOCS = { proj, ins, vo, snag };
