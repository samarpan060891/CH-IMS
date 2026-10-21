// Production: BOM templates, production orders (cut list, materials, route), job cards,
// floor stage board with supervisor time logs, FG receipt and dispatch notes to site.
import { reactive } from 'vue';
import { sb, state, must, run, rpc, hasRole, canSeeCost, go, today, refRow, refLabel, money, qty, dt, label, num, loadRef, loadRefs, toast } from './lib.js';
import { ask, confirmBox, Badge, Icon, Modal, namePick } from './components.js';
import { makePdf } from './pdf.js';
import { logoPng } from './logo.js';
import { qrMatrix, qrText } from './scan.js';
import { loadXlsx } from './importer.js';

const popts = reactive({ wos: [] });
const dspProject = reactive({ id: null, units: [] });   // project of the open dispatch note (BOQ line / unit choices)
async function setDspProject(id) {
  dspProject.id = id || null;
  dspProject.units = id ? must(await sb.from('project_units').select('id,unit_code').eq('project_id', id).order('unit_code')).map(u => ({ id: u.id, label: u.unit_code })) : [];
}

// ---------- field helpers ----------
const isFG = r => r.is_active && r.item_classes?.code === 'FG';
const isMat = r => r.is_active && r.item_classes?.tracking === 'LOT' && !r.item_classes?.is_scrap && r.item_classes?.code !== 'FG';
const itemF = (extra = {}) => ({ k: 'item_id', label: 'Item', type: 'ref', ref: 'items', required: true, width: '240px', filter: isMat, ...extra });
const uomF = (k = 'item_id') => ({ k: '_uom', label: 'UoM', type: 'ro', virtual: true, fmt: (v, r) => refRow('items', r[k])?.uoms?.code || '' });
const itemCode = id => refRow('items', id)?.code || '';
const itemName = id => { const r = refRow('items', id); return r ? `${r.code} — ${r.name}` : ''; };
const itemUom = id => refRow('items', id)?.uoms?.code || '';
const locId = code => (state.refs.locations || []).find(l => l.code === code)?.id || null;
const edges = r => ['l1', 'l2', 'w1', 'w2'].filter(e => r['edge_' + e]).map(e => e.toUpperCase()).join(' ');

// cut-list grid (same shape for templates = per unit, and orders = whole order)
const partFields = [
  { k: 'part_name', label: 'Part', required: true, width: '150px' },
  { k: 'material_id', label: 'Board / timber', type: 'ref', ref: 'items', required: true, width: '220px', filter: isMat },
  uomF('material_id'),
  { k: 'length_mm', label: 'Length mm', type: 'number', required: true, width: '80px' },
  { k: 'width_mm', label: 'Width mm', type: 'number', required: true, width: '80px' },
  { k: 'pieces', label: 'Qty', type: 'number', required: true, width: '60px' },
  { k: 'edge_item_id', label: 'Edge band', type: 'ref', ref: 'items', width: '180px', filter: isMat },
  { k: 'edge_l1', label: 'L1', type: 'check' }, { k: 'edge_l2', label: 'L2', type: 'check' },
  { k: 'edge_w1', label: 'W1', type: 'check' }, { k: 'edge_w2', label: 'W2', type: 'check' },
  { k: 'grain', label: 'Grain', type: 'check' },
  { k: 'notes', label: 'Notes / drawing ref', width: '140px' },
];

// ---------- cut list Excel / CSV ----------
const CUT_COLS = ['Part', 'Material code', 'Length mm', 'Width mm', 'Qty', 'Edge band code', 'Edge L1', 'Edge L2', 'Edge W1', 'Edge W2', 'Grain', 'Notes'];
const ALIAS = {
  part: ['part', 'partname', 'description', 'name', 'component'], material: ['materialcode', 'material', 'board', 'boardcode', 'itemcode', 'item'],
  length: ['lengthmm', 'length', 'l', 'len'], width: ['widthmm', 'width', 'w'], qty: ['qty', 'quantity', 'pcs', 'pieces', 'nos', 'count'],
  edge: ['edgebandcode', 'edgeband', 'edge', 'edgecode', 'edging'], l1: ['edgel1', 'l1'], l2: ['edgel2', 'l2'], w1: ['edgew1', 'w1'], w2: ['edgew2', 'w2'],
  grain: ['grain', 'graindirection'], notes: ['notes', 'remarks', 'drawing', 'drawingref'],
};
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const yes = v => ['y', 'yes', 'true', '1', 'x', '✓'].includes(String(v ?? '').trim().toLowerCase());

function pickFile(accept) {
  return new Promise(res => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = accept;
    i.onchange = () => res(i.files[0] || null);
    i.click();
  });
}
async function cutTemplate() {
  const XLSX = await loadXlsx();
  const ws = XLSX.utils.aoa_to_sheet([CUT_COLS, ['Side panel', 'MDF18', 720, 560, 2, 'EB22', 'Y', '', '', '', 'Y', 'Drg K-01'], ['Shelf', 'MDF18', 564, 520, 1, 'EB22', 'Y', '', '', '', '', '']]);
  ws['!cols'] = CUT_COLS.map(() => ({ wch: 14 }));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Cut list');
  XLSX.writeFile(wb, 'cut-list-template.xlsx');
}
async function importCutList(ctx, gridKey) {
  const XLSX = await loadXlsx();
  const f = await pickFile('.xlsx,.xls,.csv');
  if (!f) return;
  await loadRefs(['items']);
  const wb = XLSX.read(await f.arrayBuffer());
  const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  if (!raw.length) throw new Error('The sheet is empty');
  const keys = Object.keys(raw[0]);
  const col = {};
  for (const [k, al] of Object.entries(ALIAS)) col[k] = keys.find(h => al.includes(norm(h)));
  for (const k of ['part', 'material', 'length', 'width']) if (!col[k]) throw new Error(`Column "${CUT_COLS[['part', 'material', 'length', 'width'].indexOf(k)]}" not found — download the template`);
  const byCode = Object.fromEntries((state.refs.items || []).map(r => [r.code.toUpperCase(), r]));
  const errs = [], rows = [];
  raw.forEach((r, i) => {
    const g = k => col[k] ? r[col[k]] : '';
    if (!String(g('part')).trim() && !String(g('material')).trim()) return;
    const m = byCode[String(g('material')).trim().toUpperCase()];
    const e = String(g('edge')).trim() ? byCode[String(g('edge')).trim().toUpperCase()] : null;
    const L = Number(g('length')), W = Number(g('width')), Q = String(g('qty')).trim() === '' ? 1 : Number(g('qty'));
    if (!m) errs.push(`Row ${i + 2}: material code "${g('material')}" not in item master`);
    if (String(g('edge')).trim() && !e) errs.push(`Row ${i + 2}: edge band code "${g('edge')}" not in item master`);
    if (!(L > 0) || !(W > 0) || !(Q > 0)) errs.push(`Row ${i + 2}: length, width and qty must be numbers above 0`);
    rows.push({ part_name: String(g('part')).trim() || 'Part', material_id: m?.id, length_mm: L, width_mm: W, pieces: Q, edge_item_id: e?.id || null,
      edge_l1: yes(g('l1')), edge_l2: yes(g('l2')), edge_w1: yes(g('w1')), edge_w2: yes(g('w2')), grain: yes(g('grain')), notes: String(g('notes')).trim() || null });
  });
  if (errs.length) throw new Error(errs.slice(0, 8).join(' · ') + (errs.length > 8 ? ` · …and ${errs.length - 8} more` : ''));
  const cur = ctx.grids[gridKey];
  if (cur.length && await confirmBox('Replace cut list', `Replace the ${cur.length} existing part line(s)? Choose Cancel to add the new lines below them.`)) {
    cur.forEach(r => { if (r.id) (ctx.removed[gridKey] ||= []).push(r.id); });
    ctx.grids[gridKey] = rows;
  } else ctx.grids[gridKey] = [...cur, ...rows];
  ctx.dirty = true;
  toast(`${rows.length} parts imported — Save, then Calculate materials`, 'ok', 6000);
}

// add stages to a route grid from the work-centre master
async function addRoute(ctx, gridKey) {
  await loadRef('work_centers', true);
  const wcs = (state.refs.work_centers || []).filter(w => w.is_active);
  const have = new Set(ctx.grids[gridKey].map(r => r.work_center_id));
  const v = await ask({ title: 'Add production stages', message: 'Tick the stages this product goes through. They are added in the standard route order; adjust Seq to change it.',
    fields: wcs.map(w => ({ k: w.id, label: `${w.name}${w.kind === 'MANUAL' ? ' (manual)' : ''}`, type: 'check', default: false, hint: have.has(w.id) ? 'already in route' : 'Include' })), okText: 'Add' });
  if (!v) return;
  wcs.filter(w => v[w.id] && !have.has(w.id)).forEach(w => ctx.grids[gridKey].push({ seq: w.sort_order, work_center_id: w.id, std_labour_hours: 0, std_machine_hours: 0, planned_labour_hours: 0, planned_machine_hours: 0 }));
  ctx.grids[gridKey].sort((a, b) => num(a.seq) - num(b.seq));
  ctx.dirty = true;
}

// board yield: area of parts vs sheets planned (nesting allowance)
function yieldRows(ctx) {
  const by = {};
  for (const p of ctx.grids.parts || []) {
    const it = refRow('items', p.material_id); if (!it) continue;
    const b = by[p.material_id] ||= { material: `${it.code} — ${it.name}`, uom: it.uoms?.code, area: 0 };
    b.area += num(p.length_mm) * num(p.width_mm) * num(p.pieces) / 1e6;
  }
  return Object.entries(by).map(([id, b]) => {
    const m = (ctx.grids.materials || []).find(x => x.item_id === id && x.source === 'CUTLIST');
    const net = m ? num(m.net_qty) : null, req = m ? num(m.required_qty) : null;
    return { ...b, net, req, yield: net && req ? Math.round(net / req * 1000) / 10 : null };
  });
}

// ======================================================================
// BOM TEMPLATES (standard products, quantities per ONE unit)
// ======================================================================
export const bom = {
  key: 'bom', title: 'BOM Templates', single: 'BOM Template', table: 'bom_templates', noField: 'name', dateField: 'created_at',
  statuses: [], createRoles: ['production_incharge', 'factory_manager'], canEdit: () => hasRole('production_incharge', 'factory_manager'),
  refs: ['items', 'work_centers'],
  list: { select: '*, items(code,name)', columns: [{ k: r => r.items ? `${r.items.code} — ${r.items.name}` : '', label: 'Product' },
    { k: 'version', label: 'Version', n: true }, { k: 'is_active', label: 'Active', fmt: 'bool' }, { k: 'remarks', label: 'Remarks' }] },
  defaults: () => ({ version: 1, is_active: true }),
  header: [
    { k: 'item_id', label: 'Product (finished good)', type: 'ref', ref: 'items', required: true, filter: isFG, wide: true },
    { k: 'name', label: 'Template name', required: true, wide: true, placeholder: 'e.g. Base cabinet 600 — 2 shelves' },
    { k: 'version', label: 'Version', type: 'number', required: true },
    { k: 'is_active', label: 'Active', type: 'check' },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  headerNote: () => 'All quantities are for <b>one unit</b>; a production order multiplies them by its quantity. Products are items of class <b>FG — Finished Goods</b> (add them in Masters → Items).',
  grids: [
    { key: 'parts', title: 'Cut list (per unit)', table: 'bom_template_parts', fk: 'template_id', order: 'line_no', fields: partFields,
      importers: [{ label: '⬆ Import Excel / CSV', run: c => importCutList(c, 'parts') }, { label: 'Template', run: () => cutTemplate() }] },
    { key: 'materials', title: 'Hardware, finish & other materials (per unit)', table: 'bom_template_materials', fk: 'template_id', order: 'line_no', fields: [
      itemF(), uomF(), { k: 'qty', label: 'Qty per unit', type: 'number', required: true }, { k: 'notes', label: 'Notes' }] },
    { key: 'routing', title: 'Route — production stages', table: 'bom_template_routing', fk: 'template_id', order: 'seq', lineNo: false,
      newRow: c => ({ seq: Math.max(0, ...c.grids.routing.map(r => num(r.seq))) + 10 }),
      importers: [{ label: '+ Add stages', run: c => addRoute(c, 'routing') }],
      fields: [{ k: 'seq', label: 'Seq', type: 'number', required: true, width: '60px' },
        { k: 'work_center_id', label: 'Work centre', type: 'ref', ref: 'work_centers', required: true, width: '220px', filter: r => r.is_active },
        { k: 'std_labour_hours', label: 'Man-hours / unit', type: 'number' }, { k: 'std_machine_hours', label: 'Machine hours / unit', type: 'number' },
        { k: 'instructions', label: 'Instructions', width: '220px' }] },
  ],
  async afterLoad() { await loadRef('bom_templates', true); },
  actions: ctx => [
    { label: '➕ New production order', cls: 'primary', show: hasRole('production_incharge', 'factory_manager') && ctx.doc.is_active, reload: false, run: c => go('d/wo/new/tpl/' + c.doc.id) },
    { label: 'Copy as new version', show: hasRole('production_incharge', 'factory_manager'), reload: false,
      confirm: 'Create version ' + (num(ctx.doc.version) + 1) + ' with the same cut list, materials and route? This version will be set inactive.',
      run: async c => {
        const d = c.doc;
        const n = must(await sb.from('bom_templates').insert({ item_id: d.item_id, name: d.name, version: num(d.version) + 1, remarks: d.remarks }).select('id').single());
        const strip = ({ id, template_id, ...r }) => ({ ...r, template_id: n.id });
        for (const [g, t] of [['parts', 'bom_template_parts'], ['materials', 'bom_template_materials'], ['routing', 'bom_template_routing']]) {
          if (c.grids[g].length) must(await sb.from(t).insert(c.grids[g].map(r => strip(Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_')))))));
        }
        must(await sb.from('bom_templates').update({ is_active: false }).eq('id', d.id));
        toast('New version created', 'ok'); go('d/bom/' + n.id);
      } },
  ],
};

// ======================================================================
// PRODUCTION ORDER (custom project or MTS)
// ======================================================================
export const wo = {
  key: 'wo', title: 'Production Orders', single: 'Production Order', table: 'production_orders', noField: 'wo_no', dateField: 'wo_date',
  statuses: ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'], createRoles: ['production_incharge', 'factory_manager'],
  refs: ['items', 'projects', 'work_centers', 'bom_templates', 'profiles'],
  list: { select: '*, projects(code,name), items(code,name)', columns: [
    { k: r => r.projects ? `${r.projects.code} — ${r.projects.name}` : '', label: 'Project / MTS' }, { k: r => r.items ? `${r.items.code} — ${r.items.name}` : '', label: 'Product' },
    { k: r => (r.is_rework ? '↻ ' : '') + (r.description || ''), label: 'Description' }, { k: 'qty', label: 'Qty', fmt: 'qty' },
    { k: 'qty_completed', label: 'To FG', fmt: 'qty' }, { k: 'due_date', label: 'Due', fmt: 'date' }, { k: 'priority', label: 'Priority', fmt: 'badge' },
    { k: 'cost_total', label: 'Cost AED', fmt: 'money', cost: true, sum: true }] },
  defaults: () => ({ wo_date: today(), priority: 'NORMAL', qty: 1 }),
  async onNew(ctx, parts) {
    await loadRef('bom_templates', true);
    if (parts[0] === 'tpl' && parts[1]) {
      const t = refRow('bom_templates', parts[1]);
      if (t) Object.assign(ctx.doc, { item_id: t.item_id, template_id: t.id });
    }
  },
  header: [
    { k: 'project_id', label: 'Project / MTS order', type: 'ref', ref: 'projects', required: true, wide: true, filter: r => r.status === 'OPEN' },
    { k: 'item_id', label: 'Product', type: 'ref', ref: 'items', required: true, wide: true, filter: isFG },
    { k: 'description', label: 'Description (unit / type / drawing)', wide: true },
    { k: 'qty', label: 'Quantity', type: 'number', required: true },
    { k: 'wo_date', label: 'Order date', type: 'date', required: true },
    { k: 'due_date', label: 'Due date', type: 'date' },
    { k: 'priority', label: 'Priority', type: 'select', required: true, options: ['NORMAL', 'URGENT'] },
    { k: 'template_id', label: 'Standard BOM template (optional)', type: 'ref', wide: true,
      refOptions: d => (state.refs.bom_templates || []).filter(t => t.item_id === d.item_id && t.is_active).map(t => ({ id: t.id, label: `${t.name} (v${t.version})` })) },
    { k: 'board_waste_pct', label: 'Board waste % (blank = Settings default)', type: 'number' },
    { k: 'edge_waste_pct', label: 'Edge band waste % (blank = Settings default)', type: 'number' },
    { k: 'sale_value', label: 'Selling value of this order AED (optional, for margin)', type: 'number', cost: true },
    { k: 'parent_wo_id', label: 'Rework of order', type: 'ro', fmt: (v, d) => d._parentNo || '', show: d => d.is_rework },
    { k: 'carry_in_cost', label: 'Cost carried in from rejected units AED', type: 'ro', fmt: v => money(v), cost: true, show: d => d.is_rework },
    { k: 'qty_completed', label: 'Good qty to FG store', type: 'ro', fmt: v => qty(v), show: d => ['IN_PROGRESS', 'COMPLETED'].includes(d.status) },
    { k: 'qty_rejected', label: 'Rejected at QC (rework + scrap)', type: 'ro', fmt: v => qty(v), show: d => ['IN_PROGRESS', 'COMPLETED'].includes(d.status) },
    { k: 'cost_total', label: 'Total cost AED', type: 'ro', fmt: (v, d) => `${money(v)}  (unit ${money(num(v) / (num(d.qty_completed) || 1))})`, cost: true, show: d => d.status === 'COMPLETED' },
    { k: 'released_by', label: 'Released', type: 'ro', fmt: (v, d) => v ? `${refLabel('profiles', v)} · ${dt(d.released_at)}` : '', show: d => !!d.released_by },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  headerNote: ctx => {
    if (ctx.doc.is_rework && ctx.doc.status === 'DRAFT') return '<b>Rework order</b> created at QC. The original route was copied — delete the stages that are not needed (or skip them later), add any replacement material, then <b>Release</b>.';
    if (ctx.doc.status !== 'DRAFT') return 'Stages are tracked on the <b>Stage board</b> (Production menu or scan the job card QR). Material comes through the linked material request. ' +
      'Send finished units to the FG store in batches with <b>Receive batch</b>; the <b>Final receipt</b> closes the order and absorbs all remaining cost.';
    return 'Pick a template and <b>Apply template</b>, or import / type the cut list. <b>Calculate materials</b> turns the cut list into sheets (with board waste %) and edge banding metres. ' +
      'Add hardware lines manually. Then <b>Release</b> — a material request goes to the Production In-charge and Stores.';
  },
  grids: [
    { key: 'parts', title: 'Cut list (whole order)', table: 'wo_parts', fk: 'wo_id', order: 'line_no', fields: partFields,
      importers: [{ label: '⬆ Import Excel / CSV', run: c => importCutList(c, 'parts') }, { label: 'Template', run: () => cutTemplate() }] },
    { key: 'materials', title: 'Material requirement', table: 'wo_materials', fk: 'wo_id', order: 'line_no', fields: [
      itemF(), uomF(), { k: 'source', label: 'Source', type: 'ro', fmt: v => label(v || 'MANUAL') },
      { k: 'net_qty', label: 'Net (no waste)', type: 'ro', fmt: (v, r) => r.source === 'CUTLIST' ? qty(v) : '' },
      { k: 'required_qty', label: 'Required', type: 'number', required: true }, { k: 'notes', label: 'Notes', width: '200px' }] },
    { key: 'ops', title: 'Route — production stages', table: 'wo_operations', fk: 'wo_id', order: 'seq', lineNo: false,
      newRow: c => ({ seq: Math.max(0, ...c.grids.ops.map(r => num(r.seq))) + 10, planned_labour_hours: 0, planned_machine_hours: 0 }),
      importers: [{ label: '+ Add stages', run: c => addRoute(c, 'ops') }],
      fields: [{ k: 'seq', label: 'Seq', type: 'number', required: true, width: '60px' },
        { k: 'work_center_id', label: 'Work centre', type: 'ref', ref: 'work_centers', required: true, width: '220px', filter: r => r.is_active },
        { k: 'planned_labour_hours', label: 'Planned man-hours', type: 'number' }, { k: 'planned_machine_hours', label: 'Planned machine hours', type: 'number' },
        { k: 'instructions', label: 'Instructions', width: '200px' },
        { k: 'status', label: 'Status', type: 'ro', fmt: v => label(v || 'PENDING'), show: d => d.status !== 'DRAFT' },
        { k: 'qty_done', label: 'Qty done', type: 'ro', fmt: v => qty(v), show: d => d.status !== 'DRAFT' }] },
  ],
  async afterLoad(ctx) {
    await loadRef('bom_templates', true);
    const id = ctx.doc.id;
    ctx.extra.cost = must(await sb.from('v_wo_cost').select('*').eq('wo_id', id).maybeSingle());
    ctx.extra.logs = must(await sb.from('wo_time_logs').select('*, wo_operations(seq, work_centers(name)), profiles:logged_by(full_name), wo_time_log_crew(workers,hours,ot_hours,labour_grades(name))')
      .eq('wo_id', id).order('log_date').order('logged_at'));
    ctx.extra.mat = must(await sb.from('stock_ledger').select('txn_date,txn_type,doc_no,qty,value,item_id').eq('production_order_id', id).in('txn_type', ['ISSUE', 'RETURN']).order('txn_at'));
    ctx.extra.receipts = must(await sb.from('wo_receipts').select('*, rw:production_orders!wo_receipts_rework_wo_id_fkey(id,wo_no), scrap_notes(id,scrap_no,status)').eq('wo_id', id).order('created_at'));
    ctx.extra.reworks = must(await sb.from('production_orders').select('id,wo_no,status,qty').eq('parent_wo_id', id).order('created_at'));
    if (ctx.doc.parent_wo_id) ctx.doc._parentNo = must(await sb.from('production_orders').select('wo_no').eq('id', ctx.doc.parent_wo_id).single()).wo_no;
  },
  async loadInfo(ctx) {
    const out = [];
    const y = yieldRows(ctx);
    if (y.length) out.push({ title: 'Board yield / nesting', rows: y, columns: [{ k: 'material', label: 'Material' }, { k: 'uom', label: 'UoM' }, { k: 'area', label: 'Parts area m²', fmt: 'qty' },
      { k: 'net', label: 'Net qty', fmt: 'qty' }, { k: 'req', label: 'Planned qty (with waste)', fmt: 'qty' }, { k: 'yield', label: 'Yield %', n: true }] });
    // suggest offcuts in stock that a cut-list part fits into (best fit first; parts without grain may be turned)
    if (['DRAFT', 'RELEASED', 'IN_PROGRESS'].includes(ctx.doc.status)) {
      const m = must(await sb.rpc('offcut_matches', { p_wo: ctx.doc.id }));
      if (m.length) out.push({ title: `✂ Offcuts in stock that fit this cut list (${new Set(m.map(r => r.lot_id)).size} pieces) — use before cutting new sheets`, rows: m, columns: [
        { k: 'part_name', label: 'Part' }, { k: r => `${qty(r.part_length)}${r.part_width ? ' × ' + qty(r.part_width) : ''}${r.grain ? ' (grain)' : ''}`, label: 'Part size mm' },
        { k: 'pieces', label: 'Pcs', fmt: 'qty' }, { k: 'lot_no', label: 'Offcut' }, { k: r => `${qty(r.offcut_length)}${r.offcut_width ? ' × ' + qty(r.offcut_width) : ''}`, label: 'Offcut size mm' },
        { k: 'location_code', label: 'Location' }, { k: 'waste_pct', label: 'Left over %', n: true }, { k: 'age_days', label: 'Age (days)', n: true },
        { k: 'value', label: 'Value', fmt: 'money', cost: true }] });
    }
    const c = ctx.extra.cost;
    if (c && canSeeCost()) {
      const v = (p, a) => ({ plan: num(p), act: num(a), var: num(a) - num(p) });
      out.push({ title: 'Job cost — planned vs actual (AED)', rows: [
        { el: 'Material', ...v(c.plan_material, c.act_material) }, { el: `Labour (${qty(c.act_labour_hours)} of ${qty(c.plan_labour_hours)} man-h)`, ...v(c.plan_labour, c.act_labour) },
        { el: `Machine (${qty(c.act_machine_hours)} of ${qty(c.plan_machine_hours)} h)`, ...v(c.plan_machine, c.act_machine) },
        { el: `Overhead (${num(state.company?.overhead_pct)}% of labour + machine)`, ...v(c.plan_overhead, c.act_overhead) },
        ...(num(c.carry_in_cost) ? [{ el: 'Carried in from rejected units', ...v(c.carry_in_cost, c.carry_in_cost) }] : []),
        { el: 'TOTAL', ...v(c.plan_total, c.act_total) },
        ...(c.sale_value != null ? [{ el: 'Selling value', plan: num(c.sale_value), act: num(c.sale_value), var: 0 }, { el: 'MARGIN', ...v(num(c.sale_value) - num(c.plan_total), c.margin) }] : [])],
        columns: [{ k: 'el', label: 'Element' }, { k: 'plan', label: 'Planned', fmt: 'money' }, { k: 'act', label: 'Actual', fmt: 'money' }, { k: 'var', label: 'Variance', fmt: 'money' }] });
    }
    if (ctx.extra.receipts?.length) out.push({ title: 'Finished goods receipts & QC', rows: ctx.extra.receipts, columns: [
      { k: 'receipt_no', label: 'Receipt' }, { k: 'receipt_date', label: 'Date', fmt: 'date' }, { k: r => r.is_final ? 'Final' : 'Batch', label: 'Type' },
      { k: 'good_qty', label: 'Good → FG', fmt: 'qty' }, { k: 'rework_qty', label: 'Rework', fmt: 'qty' }, { k: 'scrap_qty', label: 'Scrap', fmt: 'qty' },
      { k: 'unit_cost', label: 'Unit cost', fmt: 'money', cost: true }, { k: 'value', label: 'FG value', fmt: 'money', cost: true, sum: true },
      { k: r => r.qc_status === 'NONE' ? '' : r.qc_status, label: 'FM approval', fmt: 'badge' },
      { k: r => r.rw?.wo_no || '', label: 'Rework order' }, { k: r => r.scrap_notes ? `${r.scrap_notes.scrap_no} (${label(r.scrap_notes.status)})` : '', label: 'Scrap note' },
      { k: r => [r.remarks, r.qc_note ? 'FM: ' + r.qc_note : ''].filter(Boolean).join(' · '), label: 'QC / FM remarks' }] });
    if (ctx.extra.logs?.length) out.push({ title: 'Stage time logs', rows: ctx.extra.logs, columns: [
      { k: 'log_date', label: 'Date', fmt: 'date' }, { k: r => `${r.wo_operations?.seq} · ${r.wo_operations?.work_centers?.name}`, label: 'Stage' },
      { k: r => (r.wo_time_log_crew || []).map(x => `${x.workers}× ${x.labour_grades?.name} ${qty(x.hours)}h${num(x.ot_hours) ? ' + ' + qty(x.ot_hours) + 'h OT' : ''}`).join(', ') || r.crew, label: 'Crew' },
      { k: 'labour_hours', label: 'Man-hours', n: true }, { k: 'machine_hours', label: 'Machine h', n: true }, { k: 'qty_done', label: 'Qty done', fmt: 'qty' },
      { k: r => num(r.labour_hours) * num(r.labour_rate) + num(r.machine_hours) * num(r.machine_rate), label: 'Cost', fmt: 'money', cost: true },
      { k: r => r.profiles?.full_name, label: 'Logged by' }, { k: 'notes', label: 'Notes' }] });
    if (ctx.extra.mat?.length) out.push({ title: 'Material issued / returned', rows: ctx.extra.mat, columns: [
      { k: 'txn_date', label: 'Date', fmt: 'date' }, { k: 'txn_type', label: 'Type', fmt: 'badge' }, { k: 'doc_no', label: 'Document' }, { k: r => itemName(r.item_id), label: 'Item' },
      { k: r => -num(r.qty), label: 'Qty (net out)', fmt: 'qty' }, { k: r => -num(r.value), label: 'Value', fmt: 'money', cost: true, sum: true }] });
    return out;
  },
  actions: ctx => {
    const s = ctx.doc.status, plan = hasRole('production_incharge', 'factory_manager');
    return [
      { label: '📋 Apply template', show: s === 'DRAFT' && plan && !!ctx.doc.template_id,
        confirm: 'Replace the cut list, materials and route with the template × order quantity?', done: 'Template applied',
        run: c => rpc('wo_apply_template', { p_wo: c.doc.id, p_template: c.doc.template_id }) },
      { label: '🧮 Calculate materials', show: s === 'DRAFT' && plan && ctx.grids.parts.length > 0, done: 'Sheets and edge banding calculated from the cut list',
        run: c => rpc('wo_compute_materials', { p_wo: c.doc.id }) },
      { label: '🚀 Release to floor', cls: 'primary', show: s === 'DRAFT' && plan,
        confirm: 'Release this order? The cut list and route are locked, a material request is sent for approval and the stages appear on the stage board.',
        run: async c => { const mr = await rpc('wo_release', { p_wo: c.doc.id }); toast(mr ? 'Released — material request sent for approval' : 'Released', 'ok'); } },
      { label: '🖨 Job card', show: s !== 'CANCELLED', reload: false, run: c => jobCard(c) },
      { label: '⏱ Stage board', show: ['RELEASED', 'IN_PROGRESS'].includes(s), reload: false, run: c => go('floor/' + c.doc.id) },
      { label: '📦 Material request', show: !!ctx.doc.mr_id, reload: false, run: c => go('d/mr/' + c.doc.mr_id) },
      { label: '📥 Receive batch to FG', show: ['RELEASED', 'IN_PROGRESS'].includes(s) && plan, run: c => receiveFg(c, false) },
      { label: '✔ Final receipt & complete', cls: 'ok', show: ['RELEASED', 'IN_PROGRESS'].includes(s) && plan, run: c => receiveFg(c, true) },
      ...(ctx.extra.receipts || []).filter(r => r.qc_status === 'PENDING_FM').map(r => ({ label: `⚖ QC decision ${r.receipt_no}`, cls: 'primary',
        show: hasRole('factory_manager'), run: () => qcDecide(r, ctx.doc.wo_no) })),
      { label: '↻ Parent order', show: !!ctx.doc.parent_wo_id, reload: false, run: c => go('d/wo/' + c.doc.parent_wo_id) },
      ...(ctx.extra.reworks || []).map(r => ({ label: `↻ ${r.wo_no} (${label(r.status)})`, reload: false, run: () => go('d/wo/' + r.id) })),
      { label: '🚚 Dispatch', cls: 'primary', show: s === 'COMPLETED' && hasRole('stores', 'factory_manager'), reload: false, run: c => go('d/dsp/new/wo/' + c.doc.id) },
      { label: 'Cancel order', show: ['RELEASED', 'IN_PROGRESS'].includes(s) && plan,
        run: async c => { const v = await ask({ title: 'Cancel ' + c.doc.wo_no, fields: [{ k: 'r', label: 'Reason', type: 'textarea', required: true }], okText: 'Cancel order', danger: true });
          if (v) return rpc('wo_cancel', { p_wo: c.doc.id, p_reason: v.r }); } },
    ];
  },
};

// ---------- FG receipt (batch or final) with QC outcome ----------
async function receiveFg(c, final) {
  const d = c.doc, open = Math.max(0, num(d.qty) - num(d.qty_completed) - num(d.qty_rejected));
  const v = await ask({
    title: (final ? 'Final receipt — ' : 'Receive batch — ') + d.wo_no,
    message: (final
      ? `All remaining cost goes to these units and the order closes. ${qty(open)} of ${qty(d.qty)} still open. Return leftover material to store first.`
      : `Send a batch to the Finished Goods Store; the order stays open. ${qty(open)} of ${qty(d.qty)} still open.`) +
      ' Units rejected at QC are proposed for rework or scrap and go to the Factory Manager for approval; the FM may also accept some as good.',
    fields: [{ k: 'g', label: 'Good quantity → FG store', type: 'number', required: true, default: final ? open : null },
      { k: 'rw', label: 'Rejected — for rework', type: 'number', default: 0 }, { k: 'sc', label: 'Rejected — scrap', type: 'number', default: 0 },
      { k: 'm', label: 'QC remarks (reason for rejection)', type: 'textarea' }],
    okText: final ? 'Receive & complete' : 'Receive batch' });
  if (!v) return;
  if ((num(v.rw) || num(v.sc)) && !v.m) throw new Error('Enter the QC remarks for the rejected units');
  await rpc('wo_receive_fg', { p_wo: d.id, p_good: num(v.g), p_rework: num(v.rw), p_scrap: num(v.sc), p_final: final, p_remarks: v.m || null });
  const rej = num(v.rw) + num(v.sc);
  toast(`${final ? 'Order completed' : 'Batch received'} — ${qty(v.g)} to FG store${rej ? `; ${qty(rej)} rejected unit(s) sent to the Factory Manager for approval` : ''}`, 'ok', 7000);
}

// FM decision on rejected units of one receipt (accept as good / rework / scrap)
export async function qcDecide(r, woNo) {
  const total = num(r.rework_qty) + num(r.scrap_qty);
  const v = await ask({ title: `QC decision — ${woNo} · ${r.receipt_no}`,
    message: `${qty(total)} unit(s) rejected: proposed ${qty(r.rework_qty)} rework, ${qty(r.scrap_qty)} scrap${canSeeCost() ? ` (AED ${money(num(r.rework_value) + num(r.scrap_value))})` : ''}. QC reason: ${r.remarks || '-'}. ` +
      'Split them between accepted as good (to FG store), rework (new rework order carries their cost) and scrap (cost written off, scrap note raised). The three must add up to ' + qty(total) + '.',
    fields: [{ k: 'g', label: 'Accept as good', type: 'number', default: 0 }, { k: 'r', label: 'Rework', type: 'number', default: num(r.rework_qty) },
      { k: 's', label: 'Scrap', type: 'number', default: num(r.scrap_qty) }, { k: 'n', label: 'Factory Manager remarks', type: 'textarea' }], okText: 'Approve decision' });
  if (!v) return false;
  await rpc('wo_qc_decide', { p_receipt: r.id, p_good: num(v.g), p_rework: num(v.r), p_scrap: num(v.s), p_note: v.n || null });
  toast('QC decision recorded', 'ok');
  return true;
}

// ---------- job card PDF with QR (scan opens the stage board) ----------
async function jobCard(c) {
  const d = c.doc;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const BRAND = [27, 58, 107];
  doc.setFillColor(...BRAND); doc.rect(0, 0, W, 3, 'F');
  try { doc.addImage(await logoPng(), 'PNG', 12, 6, 22, 22); } catch (e) { console.warn('logo', e); }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(40);
  doc.text(state.company?.company_name || 'Citi Homes', 37, 13);
  doc.setFontSize(18); doc.setTextColor(...BRAND); doc.text('JOB CARD', 37, 22);
  doc.setFontSize(12); doc.setTextColor(30); doc.text(d.wo_no, 37, 28);
  // QR
  const S = 28, X = W - 14 - S, Y = 5;
  const q = await qrMatrix(qrText.wo(d.wo_no)); const cell = S / q.n;
  doc.setFillColor(0, 0, 0);
  for (let r = 0; r < q.n; r++) for (let k = 0; k < q.n; k++) if (q.dark(r, k)) doc.rect(X + k * cell, Y + r * cell, cell + 0.02, cell + 0.02, 'F');
  doc.setFontSize(7); doc.setTextColor(110); doc.text('Scan to log stages', X + S / 2, Y + S + 3, { align: 'center' });

  const meta = [['Project / MTS', refLabel('projects', d.project_id)], ['Product', itemName(d.item_id)], ['Description', d.description || '-'],
    ['Quantity', `${qty(d.qty)} ${itemUom(d.item_id)}`], ['Order date', dt(d.wo_date)], ['Due date', dt(d.due_date) || '-'], ['Priority', label(d.priority)], ['Status', label(d.status)]];
  let y = 40; doc.setFontSize(8.5);
  meta.forEach(([l, v], i) => { const x = i % 2 ? W / 2 + 2 : 14, yy = y + Math.floor(i / 2) * 5;
    doc.setFont('helvetica', 'bold'); doc.setTextColor(90); doc.text(l + ':', x, yy);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(30); doc.text(doc.splitTextToSize(String(v ?? ''), W / 2 - 46)[0] || '', x + 26, yy); });
  y += Math.ceil(meta.length / 2) * 5 + 3;

  const tbl = (title, head, body, opts = {}) => {
    if (y > H - 40) { doc.addPage(); y = 16; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...BRAND); doc.text(title, 14, y); y += 2;
    doc.autoTable({ startY: y, head: [head], body, styles: { fontSize: 8, cellPadding: 1.6, lineColor: [210, 210, 210], lineWidth: 0.1 },
      headStyles: { fillColor: BRAND, textColor: 255 }, margin: { left: 14, right: 14 }, ...opts });
    y = doc.lastAutoTable.finalY + 7;
  };
  const wcName = id => refRow('work_centers', id)?.name || '';
  tbl('Production stages', ['Seq', 'Stage / work centre', 'Plan man-h', 'Plan mach-h', 'Instructions', 'Date', 'Crew', 'Hours', 'Qty', 'Supervisor'],
    c.grids.ops.map(o => [o.seq, wcName(o.work_center_id), qty(o.planned_labour_hours), qty(o.planned_machine_hours), o.instructions || '', '', '', '', '', '']),
    { bodyStyles: { minCellHeight: 8 }, columnStyles: { 4: { cellWidth: 38 } } });
  if (c.grids.parts.length) tbl('Cut list', ['#', 'Part', 'Material', 'L mm', 'W mm', 'Qty', 'Edge band', 'Edges', 'Grain', 'Notes'],
    c.grids.parts.map((p, i) => [i + 1, p.part_name, itemCode(p.material_id), qty(p.length_mm), qty(p.width_mm), qty(p.pieces), itemCode(p.edge_item_id), edges(p), p.grain ? 'Yes' : '', p.notes || '']));
  if (c.grids.materials.length) tbl('Materials', ['#', 'Item', 'UoM', 'Required'],
    c.grids.materials.map((m, i) => [i + 1, itemName(m.item_id), itemUom(m.item_id), qty(m.required_qty)]), { columnStyles: { 3: { halign: 'right' } } });

  const sy = Math.min(Math.max(y + 12, H - 34), H - 20);
  if (sy > H - 20 || y > H - 30) { doc.addPage(); }
  const sigY = y > H - 30 ? H - 34 : sy;
  ['Production In-charge', 'QC', 'Received in FG store'].forEach((s, i) => { const w = (W - 28) / 3, x = 14 + i * w;
    doc.setDrawColor(150); doc.line(x + 3, sigY, x + w - 6, sigY); doc.setFontSize(8.5); doc.setTextColor(60); doc.text(s, x + 3, sigY + 4.5); });
  const pages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= pages; p++) { doc.setPage(p); doc.setFontSize(7.5); doc.setTextColor(140);
    doc.text(`${d.wo_no} · CitiCore`, 14, H - 8); doc.text(`Page ${p} of ${pages}`, W - 14, H - 8, { align: 'right' }); }
  doc.save(`Job-card-${d.wo_no.replace(/[\/\\]/g, '-')}.pdf`);
}

// ======================================================================
// STAGE BOARD (supervisors log crew & hours per stage)
// ======================================================================
export const StageBoard = {
  components: { Badge, Icon, Modal },
  props: { woId: String },
  data: () => ({ rows: [], load: [], wc: '', busy: false, loading: true, dlg: null }),
  computed: {
    shown() { return this.rows.filter(r => !this.wc || r.work_center_id === this.wc); },
    title() { return this.woId && this.rows[0] ? `${this.rows[0].wo_no} — open stages` : ''; },
    grades() { return (state.refs.labour_grades || []).filter(g => g.is_active); },
  },
  async mounted() { await this.reload(); },
  methods: {
    qty, dt, label, itemName, money, canSeeCost,
    async reload() {
      this.loading = true;
      await run(async () => {
        await loadRefs(['items', 'work_centers', 'projects']);
        await loadRef('labour_grades', true);
        let q = sb.from('v_wo_stage_board').select('*');
        if (this.woId) q = q.eq('wo_id', this.woId);
        this.rows = must(await q.order('due_date', { nullsFirst: false }).order('wo_no').order('seq'));
        this.load = must(await sb.from('v_work_center_load').select('*').order('sort_order'));
      });
      this.loading = false;
    },
    proj(id) { return refRow('projects', id)?.code || ''; },
    late(r) { return r.due_date && r.due_date < today(); },
    async start(r) { this.busy = true; await run(() => rpc('wo_stage_action', { p_op: r.operation_id, p_action: 'START' }), 'Stage started'); this.busy = false; await this.reload(); },
    // crew is logged per worker grade: each line = grade × workers × hours
    log(r, finish = false) {
      const wc = refRow('work_centers', r.work_center_id);
      const g = wc?.default_grade_id || this.grades[0]?.id || null;
      this.dlg = { r, d: today(), crew: [{ grade_id: g, workers: 1, hours: null, ot: 0 }], mh: null, q: 0, n: '', f: finish, machine: wc?.kind === 'MACHINE' };
    },
    addCrew() { const c0 = this.dlg.crew[0] || {}; this.dlg.crew.push({ grade_id: null, workers: 1, hours: c0.hours ?? null, ot: c0.ot || 0 }); },
    lineHours(c) { return num(c.workers) * (num(c.hours) + num(c.ot)); },
    lineCost(c) { const g = refRow('labour_grades', c.grade_id); return num(c.workers) * (num(c.hours) * num(g?.rate_per_hour) + num(c.ot) * num(g?.ot_rate_per_hour)); },
    manHours() { return this.dlg.crew.reduce((s, c) => s + this.lineHours(c), 0); },
    crewCost() { return this.dlg.crew.reduce((s, c) => s + this.lineCost(c), 0); },
    isDown(wcId) { return this.load.some(w => w.work_center_id === wcId && w.is_down); },
    reportDown(r) { go('d/down/new/wc/' + r.work_center_id); },
    async saveLog() {
      const v = this.dlg;
      const crew = v.crew.filter(c => c.grade_id && num(c.workers) > 0 && num(c.hours) + num(c.ot) > 0);
      if (!crew.length) return toast('Enter at least one crew line: grade, workers and hours', 'error');
      if (crew.length < v.crew.length) return toast('Complete or remove the empty crew lines', 'error');
      this.busy = true;
      const ok = await run(() => rpc('wo_log_time', { p_op: v.r.operation_id, p_date: v.d,
        p_crew: crew.map(c => ({ grade_id: c.grade_id, workers: num(c.workers), hours: num(c.hours), ot_hours: num(c.ot) })),
        p_machine_hours: v.mh === null || v.mh === '' ? null : num(v.mh), p_qty_done: num(v.q), p_notes: v.n || null, p_complete: !!v.f }),
        v.f ? 'Logged — stage closed' : 'Time logged');
      this.busy = false;
      if (ok) { this.dlg = null; await this.reload(); }
    },
    async done(r) {
      if (!(await confirmBox('Close stage', `Close ${r.wc_name} on ${r.wo_no} without logging more time?`))) return;
      this.busy = true; await run(() => rpc('wo_stage_action', { p_op: r.operation_id, p_action: 'DONE' }), 'Stage closed'); this.busy = false; await this.reload();
    },
    openWo(r) { go('d/wo/' + r.wo_id); },
    all() { go('floor'); },
  },
  template: `<div>
    <div class="row" style="margin-bottom:12px;flex-wrap:wrap;gap:8px">
      <button v-if="woId" class="btn" @click="all">← All orders</button>
      <b v-if="title">{{ title }}</b>
      <a href="javascript:void 0" class="chip" :class="{on: !wc}" @click="wc=''">All stages <span class="muted">({{ rows.length }})</span></a>
      <a v-for="w in load" :key="w.work_center_id" href="javascript:void 0" class="chip" :class="{on: wc===w.work_center_id}" @click="wc = w.work_center_id"
         :title="w.remaining_hours + ' h remaining · ' + (w.load_days || 0) + ' days load' + (w.is_down ? ' · MACHINE DOWN' : '')" :style="w.is_down ? 'border-color:#b91c1c' : ''">
        <span v-if="w.is_down" style="color:#b91c1c">⛔ </span>{{ w.name }} <span class="muted">({{ rows.filter(r=>r.work_center_id===w.work_center_id).length }}{{ w.load_days ? ' · ' + w.load_days + 'd' : '' }})</span></a>
      <span class="spacer"></span>
      <button class="btn sm" @click="reload" :disabled="loading">↻ Refresh</button>
    </div>
    <div class="card">
      <div class="tbl-wrap"><table class="t">
        <thead><tr><th>Order</th><th>Project</th><th>Product</th><th>Due</th><th>Stage</th><th>Status</th><th class="n">Plan man-h</th><th class="n">Logged</th><th class="n">Qty done</th><th></th></tr></thead>
        <tbody>
          <tr v-if="loading"><td colspan="10" class="empty">Loading…</td></tr>
          <tr v-else-if="!shown.length"><td colspan="10" class="empty">No open stages{{ wc ? ' at this work centre' : '' }}</td></tr>
          <tr v-for="r in shown" :key="r.operation_id" :style="r.is_current ? '' : 'opacity:.62'">
            <td><a href="javascript:void 0" @click="openWo(r)"><b>{{ r.wo_no }}</b></a><div class="small muted">{{ r.description }}</div></td>
            <td>{{ proj(r.project_id) }}</td>
            <td>{{ itemName(r.item_id) }}<div class="small muted">Qty {{ qty(r.qty) }}</div></td>
            <td :style="late(r) ? 'color:#b91c1c;font-weight:600' : ''">{{ dt(r.due_date) }}<div v-if="r.priority==='URGENT'"><Badge v="URGENT" /></div></td>
            <td>{{ r.seq }} · <b>{{ r.wc_name }}</b> <Badge v-if="isDown(r.work_center_id)" v="DOWN" />
              <div class="small muted">{{ r.is_current ? 'Current stage' : 'Waiting for earlier stage' }}</div>
              <div class="small" v-if="r.instructions">{{ r.instructions }}</div></td>
            <td><Badge :v="r.status" /></td>
            <td class="n">{{ qty(r.planned_labour_hours) }}</td>
            <td class="n" :style="Number(r.act_labour_hours) > Number(r.planned_labour_hours) && Number(r.planned_labour_hours) ? 'color:#b45309;font-weight:600' : ''">{{ qty(r.act_labour_hours) }}</td>
            <td class="n">{{ qty(r.qty_done) }}</td>
            <td style="white-space:nowrap">
              <button v-if="r.status==='PENDING'" class="btn sm" :disabled="busy" @click="start(r)">▶ Start</button>
              <button class="btn sm primary" :disabled="busy" @click="log(r)">⏱ Log time</button>
              <button class="btn sm ok" :disabled="busy" @click="log(r, true)" title="Log the last session and close the stage">✔ Finish</button>
              <button v-if="r.status==='IN_PROGRESS'" class="btn sm" :disabled="busy" @click="done(r)" title="Close without logging">Close</button>
              <button v-if="!isDown(r.work_center_id)" class="btn sm" @click="reportDown(r)" title="Report a breakdown or stoppage at this work centre">🔧</button>
            </td>
          </tr>
        </tbody>
      </table></div>
    </div>
    <p class="small muted">Supervisors log the crew by <b>worker grade × workers × hours</b> for each stage; machine hours default to the longest crew line on machine stages. Scan the QR on the job card to open one order directly.</p>

    <Modal v-if="dlg" :title="dlg.r.wo_no + ' · ' + dlg.r.wc_name" @close="dlg = null">
      <p class="small muted" style="margin-top:0">Planned {{ qty(dlg.r.planned_labour_hours) }} man-hours · logged so far {{ qty(dlg.r.act_labour_hours) }} · order qty {{ qty(dlg.r.qty) }}</p>
      <div class="grid">
        <label class="f"><span>Date <span class="req">*</span></span><input type="date" v-model="dlg.d"></label>
        <label class="f"><span>Qty completed this session</span><input type="number" step="any" v-model.number="dlg.q"></label>
        <label class="f" v-if="dlg.machine"><span>Machine hours (blank = longest crew line)</span><input type="number" step="any" v-model.number="dlg.mh"></label>
      </div>
      <h3 style="margin:14px 0 6px">Crew</h3>
      <div class="tbl-wrap"><table class="t lines">
        <thead><tr><th>Worker grade</th><th style="width:80px">Workers</th><th style="width:90px">Normal h each</th><th style="width:90px">Overtime h each</th><th class="n">Man-hours</th><th class="n" v-if="canSeeCost()">Cost AED</th><th></th></tr></thead>
        <tbody>
          <tr v-for="(c, i) in dlg.crew" :key="i">
            <td><select v-model="c.grade_id"><option :value="null" disabled>Select grade…</option><option v-for="g in grades" :value="g.id">{{ g.name }}</option></select></td>
            <td><input type="number" min="1" step="1" v-model.number="c.workers"></td>
            <td><input type="number" min="0" step="0.25" v-model.number="c.hours"></td>
            <td><input type="number" min="0" step="0.25" v-model.number="c.ot"></td>
            <td class="n">{{ qty(lineHours(c)) }}</td>
            <td class="n" v-if="canSeeCost()">{{ money(lineCost(c)) }}</td>
            <td><button class="btn sm bad" v-if="dlg.crew.length > 1" @click="dlg.crew.splice(i, 1)">✕</button></td>
          </tr>
        </tbody>
        <tfoot><tr><td colspan="4"><button class="btn sm" @click="addCrew">+ Add grade</button></td><td class="n"><b>{{ qty(manHours()) }}</b></td>
          <td class="n" v-if="canSeeCost()"><b>{{ money(crewCost()) }}</b></td><td></td></tr></tfoot>
      </table></div>
      <label class="f full" style="margin-top:10px"><span>Notes / issues</span><textarea v-model="dlg.n"></textarea></label>
      <label class="row small" style="margin-top:8px;gap:6px"><input type="checkbox" v-model="dlg.f"> Stage finished — close it (the next stage becomes current)</label>
      <template #footer><button class="btn" @click="dlg = null">Cancel</button><button class="btn primary" :disabled="busy" @click="saveLog">Save log</button></template>
    </Modal>
  </div>`,
};

// ======================================================================
// DISPATCH NOTE (FG store -> site; project charged at dispatch)
// ======================================================================
async function loadWos() {
  const rows = must(await sb.from('production_orders').select('id,wo_no,project_id,item_id').eq('status', 'COMPLETED').order('wo_no', { ascending: false }).limit(1000));
  popts.wos = rows.map(r => ({ id: r.id, label: r.wo_no, item_id: r.item_id, project_id: r.project_id }));
}
async function fgAvail(ctx) {
  const rows = ctx.grids.lines;
  const ids = [...new Set(rows.map(r => r.item_id).filter(Boolean))];
  if (!ids.length) return;
  const lots = must(await sb.from('stock_lots').select('item_id,qty_on_hand,project_id,status').in('item_id', ids).eq('location_id', ctx.doc.from_location_id).gt('qty_on_hand', 0));
  const m = {};
  lots.forEach(l => { if (l.status === 'AVAILABLE' && (!l.project_id || l.project_id === ctx.doc.project_id)) m[l.item_id] = (m[l.item_id] || 0) + num(l.qty_on_hand); });
  rows.forEach(r => { r._avail = m[r.item_id] || 0; });
}
// everything reserved for the project at the "From" location: finished goods (by order) and bought-out items
async function loadFgForProject(ctx, woId = null) {
  if (!ctx.doc.project_id && !woId) throw new Error('Choose the project first');
  let q = sb.from('stock_lots').select('id,item_id,qty_on_hand,source_id,source_type,lot_no').eq('status', 'AVAILABLE').gt('qty_on_hand', 0);
  q = woId ? q.eq('source_type', 'PRODUCTION').eq('source_id', woId) : q.eq('project_id', ctx.doc.project_id);
  if (ctx.doc.from_location_id) q = q.eq('location_id', ctx.doc.from_location_id);
  const lots = must(await q.order('received_date'));
  if (!lots.length) throw new Error(woId ? 'Nothing from this order is left in the FG store' : 'No stock reserved for this project at this location (MTS / free stock can be added line by line)');
  const grnLines = lots.filter(l => l.source_type === 'GRN').map(l => l.source_id);
  const boqOf = grnLines.length ? Object.fromEntries(must(await sb.from('grn_lines').select('id,boq_line_id').in('id', grnLines)).map(g => [g.id, g.boq_line_id])) : {};
  const key = l => l.source_type === 'PRODUCTION' ? 'W' + l.source_id : 'I' + l.item_id;
  const have = new Set(ctx.grids.lines.map(l => l.production_order_id ? 'W' + l.production_order_id : 'I' + l.item_id));
  const add = {};
  for (const l of lots) {
    if (have.has(key(l))) continue;
    const r = add[key(l)] ||= { item_id: l.item_id, production_order_id: l.source_type === 'PRODUCTION' ? l.source_id : null, qty: 0,
                                boq_line_id: l.source_type === 'GRN' ? boqOf[l.source_id] || null : null, remarks: null };
    r.qty += num(l.qty_on_hand);
  }
  ctx.grids.lines.push(...Object.values(add));
  await fgAvail(ctx);
  ctx.dirty = true;
}
export const dsp = {
  key: 'dsp', title: 'Deliveries to Site', single: 'Delivery Note', table: 'dispatch_notes', noField: 'dispatch_no', dateField: 'dispatch_date',
  statuses: ['DRAFT', 'POSTED', 'DELIVERED', 'CANCELLED'], createRoles: ['stores', 'factory_manager', 'site_supervisor'],
  refs: ['items', 'projects', 'locations', 'profiles', 'boq_lines', 'employees', 'vendors'],
  list: { select: '*, projects(code,name)', columns: [{ k: r => r.projects ? `${r.projects.code} — ${r.projects.name}` : '', label: 'Project / site' },
    { k: 'vehicle_no', label: 'Vehicle' }, { k: 'driver_name', label: 'Driver' }, { k: 'received_by_name', label: 'Received at site' },
    { k: 'total_value', label: 'Value AED', fmt: 'money', cost: true, sum: true }] },
  defaults: () => ({ dispatch_date: today(), from_location_id: hasRole('stores', 'factory_manager') ? locId('FGS') : null }),
  async onNew(ctx, parts) {
    await loadWos();
    if (parts[0] === 'wo' && parts[1]) {
      const w = must(await sb.from('production_orders').select('project_id').eq('id', parts[1]).single());
      const p = refRow('projects', w.project_id);
      if (p?.project_type === 'PROJECT') ctx.doc.project_id = w.project_id;
      await loadFgForProject(ctx, parts[1]);
    }
    await setDspProject(ctx.doc.project_id);
  },
  async afterLoad(ctx) { await loadWos(); await setDspProject(ctx.doc.project_id); if (ctx.doc.status === 'DRAFT') await fgAvail(ctx); },
  header: [
    { k: 'project_id', label: 'Project / site', type: 'ref', ref: 'projects', required: true, wide: true, filter: r => r.status === 'OPEN' && r.project_type === 'PROJECT',
      onChange: (d, v) => setDspProject(v) },
    { k: 'from_location_id', label: 'From (FG store, factory store or site store)', type: 'ref', ref: 'locations', required: true,
      filter: r => r.is_active && r.is_stock && !['QUARANTINE', 'SCRAP_YARD'].includes(r.loc_type) && (hasRole('stores', 'factory_manager') || r.loc_type === 'SITE'),
      onChange: (d, v, ctx) => fgAvail(ctx) },
    { k: 'dispatch_date', label: 'Dispatch date', type: 'date', required: true },
    { k: 'delivery_address', label: 'Delivery address / unit', wide: true },
    { k: 'vehicle_no', label: 'Vehicle no.' },
    // our driver (employee) or a hired transporter (vendor master)
    { k: 'driver_name', label: 'Driver / transporter', ...namePick('employees', {
      refOptions: () => [...(state.refs.employees || []).filter(e => e.is_active).map(e => ({ id: e.name, label: e.name })),
        ...(state.refs.vendors || []).filter(v => v.status !== 'BLOCKED').map(v => ({ id: v.name, label: v.name + ' (hired)' }))] }) },
    { k: 'driver_phone', label: 'Driver phone' },
    { k: 'total_value', label: 'Value charged to project AED', type: 'ro', fmt: v => money(v), cost: true, show: d => ['POSTED', 'DELIVERED'].includes(d.status) },
    { k: 'received_by_name', label: 'Received at site by', type: 'ro', fmt: (v, d) => v ? `${v} · ${dt(d.delivered_at)}` : '', show: d => d.status === 'DELIVERED' },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  headerNote: () => 'Posting takes the goods out of the chosen store (oldest first) and <b>charges their full cost to the project</b>. Stock reserved for this project is used first, then free / MTS stock. ' +
    'Use it for finished goods from the FG store, bought-out items from the factory store, and to <b>hand over items delivered direct to the site store</b>.',
  grids: [{ key: 'lines', title: 'Goods dispatched / handed over', table: 'dispatch_lines', fk: 'dispatch_id', order: 'line_no',
    importers: [{ label: '⬇ Load project stock at this location', run: c => loadFgForProject(c) }],
    fields: [
      { k: 'item_id', label: 'Item / product', type: 'ref', ref: 'items', required: true, width: '240px',
        filter: r => r.is_active && r.item_classes?.tracking === 'LOT' && !['SRV'].includes(r.item_classes?.code) && !r.item_classes?.is_scrap, onChange: (r, v, ctx) => fgAvail(ctx) }, uomF(),
      { k: '_avail', label: 'Available', type: 'ro', virtual: true, fmt: v => qty(v ?? ''), show: d => d.status === 'DRAFT' },
      { k: 'production_order_id', label: 'Production order', type: 'ref', width: '150px', refOptions: () => popts.wos },
      { k: 'boq_line_id', label: 'BOQ line', type: 'ref', ref: 'boq_lines', width: '180px', filter: (r, row) => r.project_id === dspProject.id },
      { k: 'unit_id', label: 'Unit', type: 'ref', width: '110px', refOptions: () => dspProject.units },
      { k: 'qty', label: 'Qty', type: 'number', required: true }, { k: 'packages', label: 'Packages', type: 'number' },
      { k: 'value', label: 'Value', type: 'ro', fmt: v => money(v), cost: true, show: d => d.status !== 'DRAFT' },
      { k: 'remarks', label: 'Remarks' }] }],
  validate(ctx) { for (const r of ctx.grids.lines) if (r._avail !== undefined && num(r.qty) > num(r._avail)) throw new Error(`${itemName(r.item_id)}: only ${qty(r._avail)} in the FG store for this project`); },
  actions: ctx => {
    const s = ctx.doc.status;
    return [
      { label: '✔ Post', cls: 'ok', show: s === 'DRAFT' && hasRole('stores', 'factory_manager', 'site_supervisor'), done: 'Posted — cost charged to the project',
        confirm: 'Post this dispatch? Finished goods leave the FG store and their cost is charged to the project.', run: c => rpc('post_dispatch', { p_id: c.doc.id }) },
      { label: '✔ Confirm received at site', cls: 'ok', show: s === 'POSTED' && hasRole('stores', 'factory_manager', 'production_incharge', 'site_supervisor'),
        run: async c => { const v = await ask({ title: 'Delivered at site', fields: [{ k: 'n', label: 'Received by (name / site engineer)', required: true }], okText: 'Confirm' });
          if (v) return rpc('dispatch_delivered', { p_id: c.doc.id, p_received_by: v.n }); } },
      { label: '🖨 Delivery note', cls: 'primary', show: s !== 'CANCELLED', reload: false, run: c => makePdf({
          title: 'Delivery Note', no: c.doc.dispatch_no, date: c.doc.dispatch_date, subtitle: label(c.doc.status),
          meta: [['Project / site', refLabel('projects', c.doc.project_id)], ['Delivery address', c.doc.delivery_address || '-'], ['From', refLabel('locations', c.doc.from_location_id)],
                 ['Vehicle', c.doc.vehicle_no || '-'], ['Driver', [c.doc.driver_name, c.doc.driver_phone].filter(Boolean).join(' · ') || '-'], ['Remarks', c.doc.remarks || '-']],
          columns: [{ h: '#', k: r => c.grids.lines.indexOf(r) + 1, w: 8 }, { h: 'Product', k: r => itemCode(r.item_id) }, { h: 'Description', k: r => refRow('items', r.item_id)?.name },
                    { h: 'UoM', k: r => itemUom(r.item_id) }, { h: 'Qty', k: r => qty(r.qty), align: 'right' }, { h: 'Packages', k: r => r.packages ?? '', align: 'right' },
                    { h: 'Order', k: r => popts.wos.find(w => w.id === r.production_order_id)?.label || '' }, { h: 'Remarks', k: 'remarks' }],
          rows: c.grids.lines, notes: c.doc.received_by_name ? `Received at site by ${c.doc.received_by_name} on ${dt(c.doc.delivered_at)}` : 'Received the above in good condition.',
          signatures: [['Dispatched by', 'Stores'], ['Driver', c.doc.driver_name || ''], ['Received by', 'Site']] }) },
    ];
  },
};

// ======================================================================
// QC APPROVALS (Factory Manager): rejected units waiting for a decision
// ======================================================================
export const QcApprovals = {
  components: { Badge },
  data: () => ({ rows: [], done: [], loading: true, busy: false }),
  async mounted() { await this.reload(); },
  methods: {
    qty, dt, money, canSeeCost, hasRole, itemName,
    async reload() {
      this.loading = true;
      await run(async () => {
        await loadRefs(['items', 'projects']);
        const sel = '*, production_orders!wo_receipts_wo_id_fkey(id,wo_no,item_id,project_id,description)';
        this.rows = must(await sb.from('wo_receipts').select(sel).eq('qc_status', 'PENDING_FM').order('created_at'));
        this.done = must(await sb.from('wo_receipts').select(sel + ', profiles:qc_by(full_name)').eq('qc_status', 'APPROVED').order('qc_at', { ascending: false }).limit(30));
      });
      this.loading = false;
    },
    proj(id) { return refRow('projects', id)?.code || ''; },
    async decide(r) { this.busy = true; const ok = await run(() => qcDecide(r, r.production_orders.wo_no)); this.busy = false; if (ok) await this.reload(); },
    open(r) { go('d/wo/' + r.production_orders.id); },
  },
  template: `<div>
    <div class="card">
      <div class="hd"><h3>Waiting for Factory Manager</h3><span class="spacer"></span><button class="btn sm" @click="reload">↻ Refresh</button></div>
      <div class="tbl-wrap"><table class="t">
        <thead><tr><th>Receipt</th><th>Order</th><th>Project</th><th>Product</th><th class="n">Rework</th><th class="n">Scrap</th><th class="n" v-if="canSeeCost()">Value AED</th><th>QC reason</th><th></th></tr></thead>
        <tbody>
          <tr v-if="loading"><td colspan="9" class="empty">Loading…</td></tr>
          <tr v-else-if="!rows.length"><td colspan="9" class="empty">Nothing waiting</td></tr>
          <tr v-for="r in rows" :key="r.id">
            <td>{{ r.receipt_no }}<div class="small muted">{{ dt(r.receipt_date) }}</div></td>
            <td><a href="javascript:void 0" @click="open(r)"><b>{{ r.production_orders.wo_no }}</b></a><div class="small muted">{{ r.production_orders.description }}</div></td>
            <td>{{ proj(r.production_orders.project_id) }}</td><td>{{ itemName(r.production_orders.item_id) }}</td>
            <td class="n">{{ qty(r.rework_qty) }}</td><td class="n">{{ qty(r.scrap_qty) }}</td>
            <td class="n" v-if="canSeeCost()">{{ money(Number(r.rework_value) + Number(r.scrap_value)) }}</td>
            <td>{{ r.remarks }}</td>
            <td><button v-if="hasRole('factory_manager')" class="btn sm primary" :disabled="busy" @click="decide(r)">⚖ Decide</button></td>
          </tr>
        </tbody>
      </table></div>
    </div>
    <div class="card" v-if="done.length">
      <h3>Recent decisions</h3>
      <div class="tbl-wrap"><table class="t">
        <thead><tr><th>Receipt</th><th>Order</th><th class="n">Proposed rework / scrap</th><th class="n">Accepted</th><th class="n">Rework</th><th class="n">Scrap</th><th>Decided by</th><th>FM remarks</th></tr></thead>
        <tbody><tr v-for="r in done" :key="r.id">
          <td>{{ r.receipt_no }}</td><td><a href="javascript:void 0" @click="open(r)">{{ r.production_orders.wo_no }}</a></td>
          <td class="n">{{ qty(r.proposed_rework) }} / {{ qty(r.proposed_scrap) }}</td>
          <td class="n">{{ qty(Number(r.proposed_rework) + Number(r.proposed_scrap) - Number(r.rework_qty) - Number(r.scrap_qty)) }}</td>
          <td class="n">{{ qty(r.rework_qty) }}</td><td class="n">{{ qty(r.scrap_qty) }}</td>
          <td>{{ r.profiles?.full_name }}<div class="small muted">{{ dt(r.qc_at) }}</div></td><td>{{ r.qc_note }}</td>
        </tr></tbody>
      </table></div>
    </div>
  </div>`,
};

// ======================================================================
// WORK-CENTRE DOWNTIME (breakdowns, maintenance, stoppages)
// ======================================================================
const DOWN_KINDS = [{ v: 'BREAKDOWN', l: 'Breakdown' }, { v: 'PREVENTIVE_MAINTENANCE', l: 'Preventive maintenance (planned)' }, { v: 'SETUP_CHANGEOVER', l: 'Set-up / changeover' },
  { v: 'NO_OPERATOR', l: 'No operator' }, { v: 'POWER_FAILURE', l: 'Power failure' }, { v: 'MATERIAL_SHORTAGE', l: 'Waiting for material' }, { v: 'OTHER', l: 'Other' }];
const hoursBetween = (a, b) => a ? Math.round(((b ? new Date(b) : new Date()) - new Date(a)) / 36e5 * 100) / 100 : null;
export const down = {
  key: 'down', title: 'Machine Downtime', single: 'Downtime Entry', table: 'wc_downtime', noField: 'down_no', dateField: 'start_at',
  statuses: ['OPEN', 'PLANNED', 'CLOSED'], defaultTab: 'OPEN', createRoles: ['shop_floor', 'production_incharge', 'factory_manager', 'stores'],
  editStatuses: ['OPEN', 'PLANNED', 'DRAFT'], refs: ['work_centers', 'profiles'],
  list: { select: '*, work_centers(code,name)', columns: [{ k: r => r.work_centers ? `${r.work_centers.code} — ${r.work_centers.name}` : '', label: 'Work centre' },
    { k: 'kind', label: 'Reason', fmt: 'label' }, { k: 'end_at', label: 'Ended', fmt: 'datetime' }, { k: r => hoursBetween(r.start_at, r.end_at), label: 'Hours', n: true },
    { k: 'description', label: 'Description' }, { k: 'repair_cost', label: 'Repair cost', fmt: 'money', cost: true, sum: true }] },
  defaults: () => ({ kind: 'BREAKDOWN', start_at: new Date().toISOString() }),
  onNew(ctx, parts) { if (parts[0] === 'wc' && parts[1]) ctx.doc.work_center_id = parts[1]; },
  header: [
    { k: 'work_center_id', label: 'Work centre / machine', type: 'ref', ref: 'work_centers', required: true, wide: true, filter: r => r.is_active },
    { k: 'kind', label: 'Reason', type: 'select', required: true, options: DOWN_KINDS },
    { k: 'start_at', label: 'Stopped at', type: 'datetime', required: true },
    { k: 'end_at', label: 'Running again at (blank = still down)', type: 'datetime' },
    { k: '_hours', label: 'Downtime hours', type: 'ro', virtual: true, fmt: (v, d) => qty(hoursBetween(d.start_at, d.end_at)) },
    { k: 'description', label: 'What happened', type: 'textarea', full: true },
    { k: 'action_taken', label: 'Action taken / parts replaced', type: 'textarea', full: true },
    { k: 'repair_cost', label: 'Repair cost AED (spares, technician)', type: 'number', cost: true },
    { k: 'reported_by', label: 'Reported by', type: 'ro', fmt: v => refLabel('profiles', v), show: d => !!d.id },
  ],
  headerNote: () => 'Log every stoppage so the <b>Work centre load</b> report shows real capacity: open breakdowns flag the machine as down on the stage board, ' +
    'planned maintenance in the next 14 days reduces available hours, and the last 30 days give the availability %. Breakdowns notify the Factory Manager and Production In-charge.',
  actions: ctx => [
    { label: '✔ Machine running again', cls: 'ok', show: ctx.doc.status === 'OPEN' && !ctx.doc.end_at,
      run: async c => {
        const v = await ask({ title: 'Close downtime ' + c.doc.down_no, fields: [{ k: 'a', label: 'Action taken / parts replaced', type: 'textarea', default: c.doc.action_taken || '' },
          { k: 'r', label: 'Repair cost AED', type: 'number', default: c.doc.repair_cost }], okText: 'Close' });
        if (!v) return;
        must(await sb.from('wc_downtime').update({ end_at: new Date().toISOString(), action_taken: v.a || null, repair_cost: v.r === '' ? null : v.r }).eq('id', c.doc.id));
        toast('Downtime closed', 'ok');
      } },
    { label: 'Delete', cls: 'bad', show: ctx.doc.status === 'PLANNED' && hasRole('production_incharge', 'factory_manager'), reload: false, confirm: 'Delete this planned maintenance window?',
      run: async c => { must(await sb.from('wc_downtime').delete().eq('id', c.doc.id)); go('d/down'); } },
  ],
};

export const PROD_DOCS = { wo, bom, dsp, down };
