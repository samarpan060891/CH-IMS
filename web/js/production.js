// Production: BOM templates, production orders (cut list, materials, route), job cards,
// floor stage board with supervisor time logs, FG receipt and dispatch notes to site.
import { reactive } from 'vue';
import { sb, state, must, run, rpc, hasRole, canSeeCost, go, today, refRow, refLabel, money, qty, dt, label, num, loadRef, loadRefs, toast } from './lib.js';
import { ask, confirmBox, Badge, Icon } from './components.js';
import { makePdf } from './pdf.js';
import { logoPng } from './logo.js';
import { qrMatrix, qrText } from './scan.js';
import { loadXlsx } from './importer.js';

const popts = reactive({ wos: [] });

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
    { k: 'description', label: 'Description' }, { k: 'qty', label: 'Qty', fmt: 'qty' }, { k: 'due_date', label: 'Due', fmt: 'date' }, { k: 'priority', label: 'Priority', fmt: 'badge' },
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
    { k: 'qty_completed', label: 'Good qty to FG store', type: 'ro', fmt: v => qty(v), show: d => d.status === 'COMPLETED' },
    { k: 'qty_rejected', label: 'Rejected', type: 'ro', fmt: v => qty(v), show: d => d.status === 'COMPLETED' },
    { k: 'cost_total', label: 'Total cost AED', type: 'ro', fmt: (v, d) => `${money(v)}  (unit ${money(num(v) / (num(d.qty_completed) || 1))})`, cost: true, show: d => d.status === 'COMPLETED' },
    { k: 'released_by', label: 'Released', type: 'ro', fmt: (v, d) => v ? `${refLabel('profiles', v)} · ${dt(d.released_at)}` : '', show: d => !!d.released_by },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  headerNote: ctx => {
    if (ctx.doc.status !== 'DRAFT') return 'Stages are tracked on the <b>Stage board</b> (Production menu or scan the job card QR). Material comes through the linked material request.';
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
    ctx.extra.logs = must(await sb.from('wo_time_logs').select('*, wo_operations(seq, work_centers(name)), profiles:logged_by(full_name)').eq('wo_id', id).order('log_date').order('logged_at'));
    ctx.extra.mat = must(await sb.from('stock_ledger').select('txn_date,txn_type,doc_no,qty,value,item_id').eq('production_order_id', id).in('txn_type', ['ISSUE', 'RETURN']).order('txn_at'));
  },
  async loadInfo(ctx) {
    const out = [];
    const y = yieldRows(ctx);
    if (y.length) out.push({ title: 'Board yield / nesting', rows: y, columns: [{ k: 'material', label: 'Material' }, { k: 'uom', label: 'UoM' }, { k: 'area', label: 'Parts area m²', fmt: 'qty' },
      { k: 'net', label: 'Net qty', fmt: 'qty' }, { k: 'req', label: 'Planned qty (with waste)', fmt: 'qty' }, { k: 'yield', label: 'Yield %', n: true }] });
    const c = ctx.extra.cost;
    if (c && canSeeCost()) {
      const v = (p, a) => ({ plan: num(p), act: num(a), var: num(a) - num(p) });
      out.push({ title: 'Job cost — planned vs actual (AED)', rows: [
        { el: 'Material', ...v(c.plan_material, c.act_material) }, { el: `Labour (${qty(c.act_labour_hours)} of ${qty(c.plan_labour_hours)} man-h)`, ...v(c.plan_labour, c.act_labour) },
        { el: `Machine (${qty(c.act_machine_hours)} of ${qty(c.plan_machine_hours)} h)`, ...v(c.plan_machine, c.act_machine) },
        { el: `Overhead (${num(state.company?.overhead_pct)}% of labour + machine)`, ...v(c.plan_overhead, c.act_overhead) },
        { el: 'TOTAL', ...v(c.plan_total, c.act_total) }],
        columns: [{ k: 'el', label: 'Element' }, { k: 'plan', label: 'Planned', fmt: 'money' }, { k: 'act', label: 'Actual', fmt: 'money' }, { k: 'var', label: 'Variance', fmt: 'money' }] });
    }
    if (ctx.extra.logs?.length) out.push({ title: 'Stage time logs', rows: ctx.extra.logs, columns: [
      { k: 'log_date', label: 'Date', fmt: 'date' }, { k: r => `${r.wo_operations?.seq} · ${r.wo_operations?.work_centers?.name}`, label: 'Stage' }, { k: 'crew', label: 'Crew', n: true },
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
      { label: '✔ Complete → FG store', cls: 'ok', show: ['RELEASED', 'IN_PROGRESS'].includes(s) && plan,
        run: async c => {
          const v = await ask({ title: 'Complete ' + c.doc.wo_no, message: 'Good units go to the Finished Goods Store at full cost (material + labour + machine + overhead). Return any leftover material to store first.',
            fields: [{ k: 'g', label: 'Good quantity', type: 'number', required: true, default: num(c.doc.qty) }, { k: 'r', label: 'Rejected quantity', type: 'number', default: 0 },
                     { k: 'm', label: 'Remarks', type: 'textarea' }], okText: 'Complete' });
          if (!v) return;
          await rpc('wo_complete', { p_wo: c.doc.id, p_good: num(v.g), p_rejected: num(v.r), p_remarks: v.m || null });
          toast('Completed — finished goods received into the FG store', 'ok');
        } },
      { label: '🚚 Dispatch', cls: 'primary', show: s === 'COMPLETED' && hasRole('stores', 'factory_manager'), reload: false, run: c => go('d/dsp/new/wo/' + c.doc.id) },
      { label: 'Cancel order', show: ['RELEASED', 'IN_PROGRESS'].includes(s) && plan,
        run: async c => { const v = await ask({ title: 'Cancel ' + c.doc.wo_no, fields: [{ k: 'r', label: 'Reason', type: 'textarea', required: true }], okText: 'Cancel order', danger: true });
          if (v) return rpc('wo_cancel', { p_wo: c.doc.id, p_reason: v.r }); } },
    ];
  },
};

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
    doc.text(`${d.wo_no} · Citi Homes IMS`, 14, H - 8); doc.text(`Page ${p} of ${pages}`, W - 14, H - 8, { align: 'right' }); }
  doc.save(`Job-card-${d.wo_no.replace(/[\/\\]/g, '-')}.pdf`);
}

// ======================================================================
// STAGE BOARD (supervisors log crew & hours per stage)
// ======================================================================
export const StageBoard = {
  components: { Badge, Icon },
  props: { woId: String },
  data: () => ({ rows: [], load: [], wc: '', busy: false, loading: true }),
  computed: {
    shown() { return this.rows.filter(r => !this.wc || r.work_center_id === this.wc); },
    title() { return this.woId && this.rows[0] ? `${this.rows[0].wo_no} — open stages` : ''; },
  },
  async mounted() { await this.reload(); },
  methods: {
    qty, dt, label, itemName,
    async reload() {
      this.loading = true;
      await run(async () => {
        await loadRefs(['items', 'work_centers', 'projects']);
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
    async log(r, finish = false) {
      const v = await ask({ title: `${r.wo_no} · ${r.wc_name}`, message: `Planned ${qty(r.planned_labour_hours)} man-hours · logged so far ${qty(r.act_labour_hours)}. Order qty ${qty(r.qty)}.`,
        fields: [{ k: 'd', label: 'Date', type: 'date', required: true, default: today() }, { k: 'c', label: 'Crew (number of workers)', type: 'number', required: true, default: 1 },
          { k: 'h', label: 'Hours worked', type: 'number', required: true }, { k: 'mh', label: 'Machine hours (blank = same as hours worked)', type: 'number' },
          { k: 'q', label: 'Quantity completed in this session', type: 'number', default: 0 }, { k: 'n', label: 'Notes / issues', type: 'textarea' },
          { k: 'f', label: 'Stage finished', type: 'check', default: finish, hint: 'Close this stage (next stage becomes current)' }], okText: 'Save log' });
      if (!v) return;
      this.busy = true;
      await run(() => rpc('wo_log_time', { p_op: r.operation_id, p_date: v.d, p_crew: num(v.c), p_hours: num(v.h), p_machine_hours: v.mh === null || v.mh === '' ? null : num(v.mh),
        p_qty_done: num(v.q), p_notes: v.n || null, p_complete: !!v.f }), v.f ? 'Logged — stage closed' : 'Time logged');
      this.busy = false; await this.reload();
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
         :title="w.remaining_hours + ' h remaining · ' + (w.load_days || 0) + ' days load'">
        {{ w.name }} <span class="muted">({{ rows.filter(r=>r.work_center_id===w.work_center_id).length }}{{ w.load_days ? ' · ' + w.load_days + 'd' : '' }})</span></a>
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
            <td>{{ r.seq }} · <b>{{ r.wc_name }}</b><div class="small muted">{{ r.is_current ? 'Current stage' : 'Waiting for earlier stage' }}</div>
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
            </td>
          </tr>
        </tbody>
      </table></div>
    </div>
    <p class="small muted">Supervisors log <b>crew × hours</b> for each stage; machine hours default to the hours worked on machine stages. Scan the QR on the job card to open one order directly.</p>
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
async function loadFgForProject(ctx, woId = null) {
  if (!ctx.doc.project_id && !woId) throw new Error('Choose the project first');
  let q = sb.from('stock_lots').select('id,item_id,qty_on_hand,source_id,lot_no').eq('source_type', 'PRODUCTION').eq('status', 'AVAILABLE').gt('qty_on_hand', 0);
  q = woId ? q.eq('source_id', woId) : q.eq('project_id', ctx.doc.project_id);
  if (ctx.doc.from_location_id) q = q.eq('location_id', ctx.doc.from_location_id);
  const lots = must(await q.order('received_date'));
  if (!lots.length) throw new Error(woId ? 'Nothing from this order is left in the FG store' : 'No finished goods in the FG store for this project (MTS stock can be added line by line)');
  const have = new Set(ctx.grids.lines.map(l => l.production_order_id));
  lots.filter(l => !have.has(l.source_id)).forEach(l => ctx.grids.lines.push({ item_id: l.item_id, production_order_id: l.source_id, qty: num(l.qty_on_hand), remarks: null }));
  await fgAvail(ctx);
  ctx.dirty = true;
}
export const dsp = {
  key: 'dsp', title: 'Dispatch Notes', single: 'Dispatch Note', table: 'dispatch_notes', noField: 'dispatch_no', dateField: 'dispatch_date',
  statuses: ['DRAFT', 'POSTED', 'DELIVERED', 'CANCELLED'], createRoles: ['stores', 'factory_manager'],
  refs: ['items', 'projects', 'locations', 'profiles'],
  list: { select: '*, projects(code,name)', columns: [{ k: r => r.projects ? `${r.projects.code} — ${r.projects.name}` : '', label: 'Project / site' },
    { k: 'vehicle_no', label: 'Vehicle' }, { k: 'driver_name', label: 'Driver' }, { k: 'received_by_name', label: 'Received at site' },
    { k: 'total_value', label: 'Value AED', fmt: 'money', cost: true, sum: true }] },
  defaults: () => ({ dispatch_date: today(), from_location_id: locId('FGS') }),
  async onNew(ctx, parts) {
    await loadWos();
    if (parts[0] === 'wo' && parts[1]) {
      const w = must(await sb.from('production_orders').select('project_id').eq('id', parts[1]).single());
      const p = refRow('projects', w.project_id);
      if (p?.project_type === 'PROJECT') ctx.doc.project_id = w.project_id;
      await loadFgForProject(ctx, parts[1]);
    }
  },
  async afterLoad(ctx) { await loadWos(); if (ctx.doc.status === 'DRAFT') await fgAvail(ctx); },
  header: [
    { k: 'project_id', label: 'Project / site', type: 'ref', ref: 'projects', required: true, wide: true, filter: r => r.status === 'OPEN' && r.project_type === 'PROJECT' },
    { k: 'from_location_id', label: 'From', type: 'ref', ref: 'locations', required: true, filter: r => r.loc_type === 'FG_STORE' && r.is_active, onChange: (d, v, ctx) => fgAvail(ctx) },
    { k: 'dispatch_date', label: 'Dispatch date', type: 'date', required: true },
    { k: 'delivery_address', label: 'Delivery address / unit', wide: true },
    { k: 'vehicle_no', label: 'Vehicle no.' }, { k: 'driver_name', label: 'Driver' }, { k: 'driver_phone', label: 'Driver phone' },
    { k: 'total_value', label: 'Value charged to project AED', type: 'ro', fmt: v => money(v), cost: true, show: d => ['POSTED', 'DELIVERED'].includes(d.status) },
    { k: 'received_by_name', label: 'Received at site by', type: 'ro', fmt: (v, d) => v ? `${v} · ${dt(d.delivered_at)}` : '', show: d => d.status === 'DELIVERED' },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  headerNote: () => 'Posting takes the finished goods out of the FG store (oldest first) and <b>charges their full production cost to the project</b>. Stock made for this project is used first, then MTS stock.',
  grids: [{ key: 'lines', title: 'Finished goods dispatched', table: 'dispatch_lines', fk: 'dispatch_id', order: 'line_no',
    importers: [{ label: '⬇ Load FG for this project', run: c => loadFgForProject(c) }],
    fields: [
      { k: 'item_id', label: 'Product', type: 'ref', ref: 'items', required: true, width: '240px', filter: isFG, onChange: (r, v, ctx) => fgAvail(ctx) }, uomF(),
      { k: '_avail', label: 'In FG store', type: 'ro', virtual: true, fmt: v => qty(v ?? ''), show: d => d.status === 'DRAFT' },
      { k: 'production_order_id', label: 'Production order', type: 'ref', width: '150px', refOptions: () => popts.wos },
      { k: 'qty', label: 'Qty', type: 'number', required: true }, { k: 'packages', label: 'Packages', type: 'number' },
      { k: 'value', label: 'Value', type: 'ro', fmt: v => money(v), cost: true, show: d => d.status !== 'DRAFT' },
      { k: 'remarks', label: 'Remarks' }] }],
  validate(ctx) { for (const r of ctx.grids.lines) if (r._avail !== undefined && num(r.qty) > num(r._avail)) throw new Error(`${itemName(r.item_id)}: only ${qty(r._avail)} in the FG store for this project`); },
  actions: ctx => {
    const s = ctx.doc.status;
    return [
      { label: '✔ Post dispatch', cls: 'ok', show: s === 'DRAFT' && hasRole('stores', 'factory_manager'), done: 'Dispatched — cost charged to the project',
        confirm: 'Post this dispatch? Finished goods leave the FG store and their cost is charged to the project.', run: c => rpc('post_dispatch', { p_id: c.doc.id }) },
      { label: '✔ Mark delivered', cls: 'ok', show: s === 'POSTED' && hasRole('stores', 'factory_manager', 'production_incharge'),
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

export const PROD_DOCS = { wo, bom, dsp };
