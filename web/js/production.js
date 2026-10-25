// Production: BOM templates, production orders (cut list, materials, route), job cards,
// floor stage board with supervisor time logs, FG receipt and dispatch notes to site.
import { reactive } from 'vue';
import { sb, state, must, run, rpc, hasRole, canSeeCost, go, today, refRow, refLabel, money, qty, dt, label, num, loadRef, loadRefs, toast } from './lib.js';
import { ask, confirmBox, Badge, Icon, Modal, namePick } from './components.js';
import { makePdf, showPdf } from './pdf.js';
import { logoPng } from './logo.js';
import { qrMatrix, qrText } from './scan.js';
import { loadXlsx } from './importer.js';
import { weekOff, perDay, wcOps, stageHours, capOf, loadOpenWork, jobsFrom, schedule, dateAt, orderOutlook, OPEN_WO, FLAG, MAT } from './schedule.js';

const popts = reactive({ wos: [] });
const dspProject = reactive({ id: null, units: [], soLines: [] });   // project / sales order of the open dispatch note (BOQ line, unit or order line choices)
async function setDspProject(id) {
  dspProject.id = id || null;
  dspProject.units = id ? must(await sb.from('project_units').select('id,unit_code').eq('project_id', id).order('unit_code')).map(u => ({ id: u.id, label: u.unit_code })) : [];
  const so = id && refRow('projects', id)?.sales_order_id;
  dspProject.soLines = so ? must(await sb.from('v_so_lines').select('id,line_no,description,qty,delivered_qty,item_id,production_order_id').eq('so_id', so).in('line_type', ['MADE', 'STOCK']).order('line_no'))
    .map(l => ({ id: l.id, label: `${l.line_no}. ${l.description} (${qty(l.delivered_qty)} / ${qty(l.qty)} delivered)`, row: l })) : [];
}
// a delivery against a sales order: the order lines still to deliver (d/dsp/new/so/<order id>)
async function loadSoIntoDispatch(ctx, soId) {
  const o = must(await sb.from('sales_orders').select('id,so_no,project_id,delivery_address,status').eq('id', soId).single());
  if (o.status !== 'CONFIRMED') throw new Error(`Sales order ${o.so_no} is ${o.status.toLowerCase()}`);
  Object.assign(ctx.doc, { project_id: o.project_id, delivery_address: o.delivery_address || ctx.doc.delivery_address });
  await setDspProject(o.project_id);
  const todo = dspProject.soLines.map(x => x.row).filter(l => num(l.qty) > num(l.delivered_qty));
  if (!todo.length) throw new Error('Everything on this order has been delivered');
  if (!todo.some(l => l.production_order_id)) ctx.doc.from_location_id = locId('MS') || ctx.doc.from_location_id;
  ctx.grids.lines = todo.map(l => ({ so_line_id: l.id, item_id: l.item_id, production_order_id: l.production_order_id, qty: num(l.qty) - num(l.delivered_qty) }));
  await fgAvail(ctx);
}

// ---------- field helpers ----------
// a stage's typical setup and wait come from its work centre
const wcDefaults = r => { const w = refRow('work_centers', r.work_center_id); if (w) { r.setup_hours = num(w.default_setup_hours); r.wait_days = num(w.default_wait_days); } };
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

// utilities (compressors, dust collector) are maintained like machines but are never a production stage
const stageWc = w => w.is_active && w.kind !== 'UTILITY';

// add stages to a route grid from the work-centre master
async function addRoute(ctx, gridKey) {
  await loadRef('work_centers', true);
  const wcs = (state.refs.work_centers || []).filter(stageWc);
  const have = new Set(ctx.grids[gridKey].map(r => r.work_center_id));
  const v = await ask({ title: 'Add production stages', message: 'Tick the stages this product goes through. They are added in the standard route order; adjust Seq to change it.',
    fields: wcs.map(w => ({ k: w.id, label: `${w.name}${w.kind === 'MANUAL' ? ' (manual)' : ''}`, type: 'check', default: false, hint: have.has(w.id) ? 'already in route' : 'Include' })), okText: 'Add' });
  if (!v) return;
  wcs.filter(w => v[w.id] && !have.has(w.id)).forEach(w => ctx.grids[gridKey].push({ seq: w.sort_order, work_center_id: w.id, std_labour_hours: 0, std_machine_hours: 0, planned_labour_hours: 0, planned_machine_hours: 0,
    setup_hours: num(w.default_setup_hours), wait_days: num(w.default_wait_days) }));
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
  headerNote: () => 'All quantities are for <b>one unit</b>; a production order multiplies them by its quantity. Products are items of class <b>FG — Finished Goods</b> (add them in Masters → Items). ' +
    'On the route, <b>setup hours</b> count once per production order (batch) and <b>wait days</b> are drying / moving / queue time after the stage before the batch goes on.',
  grids: [
    { key: 'parts', title: 'Cut list (per unit)', table: 'bom_template_parts', fk: 'template_id', order: 'line_no', fields: partFields,
      importers: [{ label: '⬆ Import Excel / CSV', run: c => importCutList(c, 'parts') }, { label: 'Template', run: () => cutTemplate() }] },
    { key: 'materials', title: 'Hardware, finish & other materials (per unit)', table: 'bom_template_materials', fk: 'template_id', order: 'line_no', fields: [
      itemF(), uomF(), { k: 'qty', label: 'Qty per unit', type: 'number', required: true }, { k: 'notes', label: 'Notes' }] },
    { key: 'routing', title: 'Route — production stages', table: 'bom_template_routing', fk: 'template_id', order: 'seq', lineNo: false,
      newRow: c => ({ seq: Math.max(0, ...c.grids.routing.map(r => num(r.seq))) + 10 }),
      importers: [{ label: '+ Add stages', run: c => addRoute(c, 'routing') }],
      fields: [{ k: 'seq', label: 'Seq', type: 'number', required: true, width: '60px' },
        { k: 'work_center_id', label: 'Work centre', type: 'ref', ref: 'work_centers', required: true, width: '220px', filter: stageWc, onChange: wcDefaults },
        // a machine with operator + helper: man-hours = machine hours × operators (filled in, can be changed)
        { k: 'std_machine_hours', label: 'Machine hours / unit', type: 'number',
          onChange: r => { if (!num(r.std_labour_hours) || r._autoLh) { r.std_labour_hours = Math.round(num(r.std_machine_hours) * wcOps(r.work_center_id) * 1000) / 1000; r._autoLh = true; } } },
        { k: 'std_labour_hours', label: 'Man-hours / unit', type: 'number', onChange: r => { r._autoLh = false; } },
        { k: '_ops', label: 'Operators', type: 'ro', virtual: true, fmt: (v, r) => refRow('work_centers', r.work_center_id)?.kind === 'MACHINE' ? wcOps(r.work_center_id) : '' },
        { k: 'setup_hours', label: 'Setup h / batch', type: 'number' },
        { k: 'wait_days', label: 'Wait after (days)', type: 'number' },
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
// the project's made in-house BOQ products with the quantity not yet on production orders (this order excluded)
const woBoq = reactive({ project: null, lines: [] });
async function loadWoBoq(projectId, selfId = null) {
  woBoq.project = projectId; woBoq.lines = [];
  if (!projectId) return;
  const [lines, wos] = await Promise.all([
    sb.from('boq_lines').select('id,boq_ref,line_no,description,item_id,qty,template_id').eq('project_id', projectId).eq('category', 'MANUFACTURED').order('line_no'),
    sb.from('production_orders').select('id,boq_line_id,qty').eq('project_id', projectId).neq('status', 'CANCELLED').not('boq_line_id', 'is', null)]);
  const planned = {};
  for (const w of must(wos)) if (w.id !== selfId) planned[w.boq_line_id] = (planned[w.boq_line_id] || 0) + num(w.qty);
  woBoq.lines = must(lines).map(b => ({ ...b, left: Math.max(0, num(b.qty) - (planned[b.id] || 0)) }));
}
// the order's cut list, material requirement and route = BOM template × order quantity, filled on screen as soon as the
// product / template / quantity is set (same as Apply template on the server); saved with the order
async function tplFill(ctx) {
  const d = ctx.doc;
  if ((d.status && d.status !== 'DRAFT') || !d.template_id || !(num(d.qty) > 0)) return;
  const hasRows = ['parts', 'materials', 'ops'].some(k => (ctx.grids[k] || []).length);
  if (hasRows && !ctx._tplAuto && !(await confirmBox('Refresh from the BOM template',
    `Recalculate the cut list, materials and stage hours for ${qty(d.qty)} unit(s) from the BOM template? Lines changed by hand are replaced.`))) return;
  const [parts, mats, route] = await Promise.all([
    sb.from('bom_template_parts').select('*').eq('template_id', d.template_id).order('line_no'),
    sb.from('bom_template_materials').select('item_id,qty,notes,line_no').eq('template_id', d.template_id).order('line_no'),
    sb.from('bom_template_routing').select('seq,work_center_id,std_labour_hours,std_machine_hours,setup_hours,wait_days,instructions').eq('template_id', d.template_id).order('seq')]);
  const q = num(d.qty), r4 = v => Math.round(v * 10000) / 10000, r2 = v => Math.round(v * 100) / 100;
  for (const k of ['parts', 'materials', 'ops']) (ctx.grids[k] || []).forEach(r => { if (r.id) (ctx.removed[k] ||= []).push(r.id); });
  ctx.grids.parts = must(parts).map(p => ({ part_name: p.part_name, material_id: p.material_id, length_mm: p.length_mm, width_mm: p.width_mm, pieces: num(p.pieces) * q,
    edge_item_id: p.edge_item_id, edge_l1: p.edge_l1, edge_l2: p.edge_l2, edge_w1: p.edge_w1, edge_w2: p.edge_w2, grain: p.grain, notes: p.notes }));
  ctx.grids.materials = must(mats).map(m => ({ item_id: m.item_id, source: 'TEMPLATE', net_qty: r4(num(m.qty) * q), required_qty: r4(num(m.qty) * q), notes: m.notes }));
  // hours × quantity + setup once (setup keeps the machine and its operators busy)
  const isMc = id => refRow('work_centers', id)?.kind === 'MACHINE';
  ctx.grids.ops = must(route).map(o => ({ seq: o.seq, work_center_id: o.work_center_id,
    planned_labour_hours: r2(num(o.std_labour_hours) * q + num(o.setup_hours) * wcOps(o.work_center_id)),
    planned_machine_hours: r2(num(o.std_machine_hours) * q + (isMc(o.work_center_id) ? num(o.setup_hours) : 0)),
    setup_hours: num(o.setup_hours), wait_days: num(o.wait_days), instructions: o.instructions }));
  ctx._tplAuto = true; ctx.dirty = true;
}
// quantity typed digit by digit: recalculate once typing pauses
const tplFillSoon = ctx => { clearTimeout(ctx._tplTimer); ctx._tplTimer = setTimeout(() => run(() => tplFill(ctx)), 600); };
const latestTpl = itemId => (state.refs.bom_templates || []).filter(t => t.item_id === itemId && t.is_active).sort((x, y) => num(y.version) - num(x.version))[0]?.id || null;
const woBoqLabel = b => `${b.boq_ref || b.line_no} — ${b.description} · ${itemCode(b.item_id) || 'no product set'} · ${qty(b.left)} of ${qty(b.qty)} still to plan`;
export const wo = {
  key: 'wo', title: 'Production Orders', single: 'Production Order', table: 'production_orders', noField: 'wo_no', dateField: 'wo_date',
  statuses: ['DRAFT', 'PENDING_FM', 'APPROVED', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'], createRoles: ['production_incharge', 'factory_manager'],
  refs: ['items', 'projects', 'work_centers', 'bom_templates', 'profiles'],
  list: { select: '*, projects(code,name), items(code,name)', columns: [
    { k: r => r.projects ? `${r.projects.code} — ${r.projects.name}` : '', label: 'Project / MTS' }, { k: r => r.items ? `${r.items.code} — ${r.items.name}` : '', label: 'Product' },
    { k: r => (r.is_rework ? '↻ ' : '') + (r.description || ''), label: 'Description' }, { k: 'qty', label: 'Qty', fmt: 'qty' },
    { k: 'qty_completed', label: 'To FG', fmt: 'qty' }, { k: 'due_date', label: 'Due', fmt: 'date' }, { k: 'priority', label: 'Priority', fmt: 'badge' },
    { k: 'cost_total', label: 'Cost AED', fmt: 'money', cost: true, sum: true }] },
  defaults: () => ({ wo_date: today(), priority: 'NORMAL', qty: 1 }),
  async onNew(ctx, parts) {
    await loadRef('bom_templates', true);
    await loadWoBoq(null);
    // from a project: d/wo/new/proj/<project id>
    if (parts[0] === 'proj' && parts[1]) { ctx.doc.project_id = parts[1]; await loadWoBoq(parts[1]); }
    if (parts[0] === 'tpl' && parts[1]) {
      const t = refRow('bom_templates', parts[1]);
      if (t) { Object.assign(ctx.doc, { item_id: t.item_id, template_id: t.id }); setTimeout(() => tplFill(ctx), 0); }
    }
  },
  // not more than the BOQ line still has to plan (the server enforces the same; rework orders are outside the limit)
  validate(ctx) {
    const d = ctx.doc, b = d.boq_line_id && woBoq.lines.find(x => x.id === d.boq_line_id);
    if (b && !d.is_rework && num(d.qty) > b.left + 0.0005)
      throw new Error(`BOQ ${b.boq_ref || b.line_no} (${b.description}) has ${qty(b.left)} of ${qty(b.qty)} still to plan — the quantity cannot be ${qty(d.qty)}. For more, raise a variation order on the project.`);
  },
  // a cut list from the template still needs its sheets / edge banding worked out (server side, after the save)
  async afterSave(ctx) {
    if (ctx._tplAuto && ctx.grids.parts?.length && ctx.doc.status === 'DRAFT') await rpc('wo_compute_materials', { p_wo: ctx.doc.id });
    ctx._tplAuto = false;
  },
  header: [
    { k: 'project_id', label: 'Project / MTS order', type: 'ref', ref: 'projects', required: true, wide: true, filter: r => r.status === 'OPEN',
      onChange: (d, v) => { d.boq_line_id = null; return loadWoBoq(v); } },
    // picking a made in-house BOQ line fills the product, the quantity still to plan, the description and its BOM template
    { k: 'boq_line_id', label: 'In-house product from the project BOQ', type: 'ref', wide: true,
      show: d => !!d.project_id && (woBoq.lines.length > 0 || !!d.boq_line_id),
      refOptions: d => woBoq.lines.filter(b => b.left > 0.0005 || b.id === d.boq_line_id).map(b => ({ id: b.id, label: woBoqLabel(b) })),
      onChange: (d, v, ctx) => {
        const b = woBoq.lines.find(x => x.id === v); if (!b) return;
        if (!b.item_id) toast('Set the product (FG item) on this BOQ line in the project first', 'error');
        const tpl = b.template_id || latestTpl(b.item_id);
        Object.assign(d, { item_id: b.item_id, qty: b.left || d.qty, description: `${b.boq_ref ? b.boq_ref + ' — ' : ''}${b.description}`, template_id: tpl });
        return tplFill(ctx);
      } },
    { k: 'item_id', label: 'Product', type: 'ref', ref: 'items', required: true, wide: true, filter: isFG, ro: d => !!d.boq_line_id,
      onChange: (d, v, ctx) => { d.template_id = latestTpl(v); return tplFill(ctx); } },
    { k: 'description', label: 'Description (unit / type / drawing)', wide: true },
    { k: 'qty', label: 'Quantity', type: 'number', required: true, onChange: (d, v, ctx) => tplFillSoon(ctx) },
    { k: 'wo_date', label: 'Order date', type: 'date', required: true },
    { k: 'due_date', label: 'Due date', type: 'date' },
    { k: 'priority', label: 'Priority', type: 'select', required: true, options: ['NORMAL', 'URGENT'] },
    { k: 'template_id', label: 'Standard BOM template (optional)', type: 'ref', wide: true,
      refOptions: d => (state.refs.bom_templates || []).filter(t => t.item_id === d.item_id && t.is_active).map(t => ({ id: t.id, label: `${t.name} (v${t.version})` })),
      onChange: (d, v, ctx) => tplFill(ctx) },
    { k: 'board_waste_pct', label: 'Board waste % (blank = Settings default)', type: 'number' },
    { k: 'edge_waste_pct', label: 'Edge band waste % (blank = Settings default)', type: 'number' },
    { k: 'sale_value', label: 'Selling value of this order AED (optional, for margin)', type: 'number', cost: true },
    { k: 'parent_wo_id', label: 'Rework of order', type: 'ro', fmt: (v, d) => d._parentNo || '', show: d => d.is_rework },
    { k: 'carry_in_cost', label: 'Cost carried in from rejected units AED', type: 'ro', fmt: v => money(v), cost: true, show: d => d.is_rework },
    { k: 'qty_completed', label: 'Good qty to FG store', type: 'ro', fmt: v => qty(v), show: d => ['IN_PROGRESS', 'COMPLETED'].includes(d.status) },
    { k: 'qty_rejected', label: 'Rejected at QC (rework + scrap)', type: 'ro', fmt: v => qty(v), show: d => ['IN_PROGRESS', 'COMPLETED'].includes(d.status) },
    { k: 'cost_total', label: 'Total cost AED', type: 'ro', fmt: (v, d) => `${money(v)}  (unit ${money(num(v) / (num(d.qty_completed) || 1))})`, cost: true, show: d => d.status === 'COMPLETED' },
    { k: 'fm_approved_by', label: 'Approved by Factory Manager', type: 'ro', fmt: (v, d) => v ? `${refLabel('profiles', v)} · ${dt(d.fm_approved_at)}` : '', show: d => !!d.fm_approved_by },
    { k: 'fm_comments', label: 'Factory Manager comments', type: 'ro', show: d => !!d.fm_comments, wide: true },
    { k: 'released_by', label: 'Released', type: 'ro', fmt: (v, d) => v ? `${refLabel('profiles', v)} · ${dt(d.released_at)}` : '', show: d => !!d.released_by },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  headerNote: ctx => {
    const s = ctx.doc.status;
    if (ctx.doc.is_rework && s === 'DRAFT') return '<b>Rework order</b> created at QC (approved by the FM there). The original route was copied — delete the stages that are not needed (or skip them later), add any replacement material, then <b>Release</b>.';
    if (s === 'DRAFT' && ctx.doc.fm_comments) return `<b>Returned by the Factory Manager:</b> ${ctx.doc.fm_comments}. Correct the order, <b>Save</b> and <b>Send to Factory Manager</b> again.`;
    if (s === 'PENDING_FM') return 'Waiting for the <b>Factory Manager</b> to approve. After approval the Production In-charge releases it to the floor.';
    if (s === 'APPROVED') return 'Approved by the Factory Manager — <b>Release to floor</b> prepares the material request from the BOM and puts the stages on the stage board.';
    if (s !== 'DRAFT') return 'Stages are tracked on the <b>Stage board</b> (Production menu or scan the job card QR). The floor sends the prepared material request with <b>Request material</b> (no items or quantities to type); ' +
      'for process rejections use <b>Excess material</b> (this order\'s BOM items only, Factory Manager approves, cost charged to this order). ' +
      'Send finished units to the FG store in batches with <b>Receive batch</b>; the <b>Final receipt</b> closes the order and absorbs all remaining cost.';
    return 'Choosing the product (or BOQ line), BOM template and quantity fills the <b>cut list, material requirement and stage man-hours / machine hours</b> = template × quantity; ' +
      'they are recalculated when the quantity changes. Adjust or add lines if needed, <b>Save</b>, then <b>Send to Factory Manager</b> → FM approves → <b>Release</b>.';
  },
  grids: [
    { key: 'parts', title: 'Cut list (whole order)', table: 'wo_parts', fk: 'wo_id', order: 'line_no', fields: partFields,
      importers: [{ label: '⬆ Import Excel / CSV', run: c => importCutList(c, 'parts') }, { label: 'Template', run: () => cutTemplate() }] },
    { key: 'materials', title: 'Material requirement', table: 'wo_materials', fk: 'wo_id', order: 'line_no', saveKeys: ['source', 'net_qty'], fields: [
      itemF(), uomF(), { k: 'source', label: 'Source', type: 'ro', fmt: v => label(v || 'MANUAL') },
      { k: 'net_qty', label: 'Net (no waste)', type: 'ro', fmt: (v, r) => r.source === 'CUTLIST' ? qty(v) : '' },
      { k: 'required_qty', label: 'Required', type: 'number', required: true }, { k: 'notes', label: 'Notes', width: '200px' }] },
    { key: 'ops', title: 'Route — production stages', table: 'wo_operations', fk: 'wo_id', order: 'seq', lineNo: false,
      newRow: c => ({ seq: Math.max(0, ...c.grids.ops.map(r => num(r.seq))) + 10, planned_labour_hours: 0, planned_machine_hours: 0 }),
      importers: [{ label: '+ Add stages', run: c => addRoute(c, 'ops') }],
      fields: [{ k: 'seq', label: 'Seq', type: 'number', required: true, width: '60px' },
        { k: 'work_center_id', label: 'Work centre', type: 'ref', ref: 'work_centers', required: true, width: '220px', filter: stageWc },
        { k: 'planned_labour_hours', label: 'Planned man-hours (incl. setup)', type: 'number' }, { k: 'planned_machine_hours', label: 'Planned machine hours (incl. setup)', type: 'number' },
        { k: 'setup_hours', label: 'Setup h', type: 'number' }, { k: 'wait_days', label: 'Wait after (days)', type: 'number' },
        { k: 'instructions', label: 'Instructions', width: '200px' },
        { k: 'status', label: 'Status', type: 'ro', fmt: v => label(v || 'PENDING'), show: d => d.status !== 'DRAFT' },
        { k: 'qty_done', label: 'Qty done', type: 'ro', fmt: v => qty(v), show: d => d.status !== 'DRAFT' }] },
  ],
  async afterLoad(ctx) {
    await loadRef('bom_templates', true);
    const id = ctx.doc.id;
    await loadWoBoq(ctx.doc.project_id, id);
    ctx.extra.cost = must(await sb.from('v_wo_cost').select('*').eq('wo_id', id).maybeSingle());
    ctx.extra.logs = must(await sb.from('wo_time_logs').select('*, wo_operations(seq, work_centers(name)), profiles:logged_by(full_name), wo_time_log_crew(workers,hours,ot_hours,labour_grades(name))')
      .eq('wo_id', id).order('log_date').order('logged_at'));
    ctx.extra.mat = must(await sb.from('stock_ledger').select('txn_date,txn_type,doc_no,qty,value,item_id').eq('production_order_id', id).in('txn_type', ['ISSUE', 'RETURN']).order('txn_at'));
    ctx.extra.receipts = must(await sb.from('wo_receipts').select('*, rw:production_orders!wo_receipts_rework_wo_id_fkey(id,wo_no), scrap_notes(id,scrap_no,status)').eq('wo_id', id).order('created_at'));
    ctx.extra.reworks = must(await sb.from('production_orders').select('id,wo_no,status,qty').eq('parent_wo_id', id).order('created_at'));
    // open orders: their place in the factory schedule; drafts: as if sent to the Factory Manager now (route and
    // materials as they are on the order)
    const draft = ctx.doc.status === 'DRAFT' ? woDraft(ctx) : null;
    ctx.extra.outlook = OPEN_WO.includes(ctx.doc.status) || draft ? await orderOutlook(id, draft).catch(e => { console.warn('outlook', e); return null; }) : null;
    // this order's material: issued for it into the project WIP, consumed by its receipts, and the project pool now
    const byOrder = must(await sb.from('v_wip_by_order').select('*').eq('wo_id', id));
    const bomItems = [...new Set([...(ctx.grids.materials || []).map(m => m.item_id), ...byOrder.map(w => w.item_id)].filter(Boolean))];
    const pool = bomItems.length ? must(await sb.from('v_wip_stock').select('item_id,qty,value').eq('project_id', ctx.doc.project_id).in('item_id', bomItems)) : [];
    ctx.extra.wip = bomItems.filter(it => byOrder.some(w => w.item_id === it) || pool.some(p => p.item_id === it)).map(it => {
      const w = byOrder.find(x => x.item_id === it) || {}, p = pool.find(x => x.item_id === it) || {};
      return { item_id: it, issued: num(w.qty_issued), consumed: num(w.qty_consumed), consumed_value: num(w.value_consumed), returned: num(w.qty_returned), pool: num(p.qty), pool_value: num(p.value) };
    });
    ctx.extra.mrStatus = ctx.doc.mr_id ? must(await sb.from('material_requests').select('status').eq('id', ctx.doc.mr_id).single()).status : null;
    ctx.extra.excess = must(await sb.from('material_requests').select('id,mr_no,status').eq('production_order_id', id).eq('kind', 'EXCESS').order('created_at'));
    if (ctx.doc.parent_wo_id) ctx.doc._parentNo = must(await sb.from('production_orders').select('wo_no').eq('id', ctx.doc.parent_wo_id).single()).wo_no;
  },
  async loadInfo(ctx) {
    const out = [];
    // factory schedule: position, projected finish against the due date, and whether the materials are there in time
    const o = ctx.extra.outlook;
    if (o?.r) {
      const d = ctx.doc, a = o.a;
      out.push({ title: `📅 Factory schedule${o.draft ? ' (estimate — if sent to the Factory Manager now)' : ''} — #${o.pos} of ${o.total} · ${FLAG[o.r.flag]?.t || ''} · material ${MAT[a?.status]?.t || ''}` +
        (o.pushed.length ? ` · ⚠ would make ${o.pushed.join(', ')} late` : ''), rows: [{
        pos: `${o.pos} of ${o.total}`, due: d.due_date, fin: o.r.date, slack: o.r.slack, start: o.r.stages[0] ? dateAt(o.start, o.r.stages[0].start) : null,
        mat: MAT[a?.status]?.t || '', matDate: a && ['ON_PO', 'PO_LATE', 'PO_PENDING'].includes(a.status) ? a.matDate : null }],
        columns: [{ k: 'pos', label: 'Position in sequence' }, { k: 'start', label: 'Planned start', fmt: 'date' }, { k: 'fin', label: 'Projected finish', fmt: 'date' },
          { k: 'due', label: 'Due', fmt: 'date' }, { k: 'slack', label: 'Spare working days', n: true }, { k: 'mat', label: 'Material' }, { k: 'matDate', label: 'All material by', fmt: 'date' }] });
      if (a?.lines.length && a.status !== 'READY') out.push({ title: `Material availability (needed by ${dt(a.need) || '—'})`, rows: a.lines, columns: [
        { k: r => itemName(r.item), label: 'Material' }, { k: r => itemUom(r.item), label: 'UoM' }, { k: 'req', label: 'Still needed (open units)', fmt: 'qty' }, { k: 'issued', label: 'From project WIP', fmt: 'qty' },
        { k: 'stock', label: 'From stock', fmt: 'qty' },
        { k: r => [...r.pos.map(p => `${p.po_no} ${qty(p.qty)} due ${p.date ? dt(p.date) : '?'}`), ...r.tent.map(p => `${p.po_no} ${qty(p.qty)} awaiting approval`)].join(' · '), label: 'From POs' },
        { k: r => r.short ? Math.round(r.short * 1000) / 1000 : null, label: 'Short', fmt: 'qty' }, { k: r => r.short && r.pr ? r.pr : null, label: 'On requisition (no PO)', fmt: 'qty' }] });
    }
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
      // actual and variance only once work has started (material issued or time logged); before that the plan alone
      const started = ctx.doc.status === 'COMPLETED' || num(c.act_material) !== 0 || num(c.act_labour_hours) > 0 || num(c.act_machine_hours) > 0;
      const v = (p, a) => started ? { plan: num(p), act: num(a), var: num(a) - num(p) } : { plan: num(p), act: null, var: null };
      out.push({ title: started ? 'Job cost — planned vs actual (AED)' : 'Job cost — planned (AED) · not started: no material issued or time logged yet, so no actual cost or variance', rows: [
        { el: 'Material', ...v(c.plan_material, c.act_material) }, { el: `Labour (${qty(c.act_labour_hours)} of ${qty(c.plan_labour_hours)} man-h)`, ...v(c.plan_labour, c.act_labour) },
        { el: `Machine (${qty(c.act_machine_hours)} of ${qty(c.plan_machine_hours)} h)`, ...v(c.plan_machine, c.act_machine) },
        { el: `Overhead (${num(state.company?.overhead_pct)}% of labour + machine)`, ...v(c.plan_overhead, c.act_overhead) },
        ...(num(c.carry_in_cost) ? [{ el: 'Carried in from rejected units', ...v(c.carry_in_cost, c.carry_in_cost) }] : []),
        { el: 'TOTAL', ...v(c.plan_total, c.act_total) },
        ...(c.sale_value != null ? [{ el: 'Selling value', plan: num(c.sale_value), act: started ? num(c.sale_value) : null, var: started ? 0 : null }, { el: 'MARGIN', ...v(num(c.sale_value) - num(c.plan_total), c.margin) }] : [])],
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
    // material issued to this order: on the shop floor (WIP) until FG receipts consume it or it is returned
    if (ctx.extra.wip?.length) out.push({ title: `🏭 Material — project WIP (${refRow('projects', ctx.doc.project_id)?.code || 'project'}) and this order`, rows: ctx.extra.wip, columns: [
      { k: r => itemName(r.item_id), label: 'Material' }, { k: r => itemUom(r.item_id), label: 'UoM' }, { k: 'issued', label: 'Issued for this order', fmt: 'qty' },
      { k: r => Math.round(r.consumed * 1000) / 1000, label: 'Consumed by its receipts', fmt: 'qty' }, { k: 'consumed_value', label: 'Charged to this order AED', fmt: 'money', cost: true, sum: true },
      { k: 'returned', label: 'Returned / scrapped', fmt: 'qty' },
      { k: r => Math.round(r.pool * 1000) / 1000, label: 'In project WIP now', fmt: 'qty' }, { k: 'pool_value', label: 'Project WIP value AED', fmt: 'money', cost: true }] });
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
      { label: '📨 Send to Factory Manager', cls: 'primary', show: s === 'DRAFT' && plan && !ctx.doc.is_rework, done: 'Sent to the Factory Manager for approval',
        run: c => rpc('wo_submit', { p_wo: c.doc.id }) },
      { label: '✔ Approve (FM)', cls: 'ok', show: s === 'PENDING_FM' && hasRole('factory_manager'), done: 'Approved — the Production In-charge can release it',
        run: c => rpc('wo_fm_decide', { p_wo: c.doc.id, p_approve: true, p_comments: null }) },
      { label: '↩ Return (FM)', cls: 'bad', show: s === 'PENDING_FM' && hasRole('factory_manager'),
        run: async c => { const v = await ask({ title: 'Return ' + c.doc.wo_no, fields: [{ k: 'r', label: 'Reason / what to change', type: 'textarea', required: true }], okText: 'Return order' });
          if (v) return rpc('wo_fm_decide', { p_wo: c.doc.id, p_approve: false, p_comments: v.r }); } },
      { label: '🚀 Release to floor', cls: 'primary', show: (s === 'APPROVED' || (s === 'DRAFT' && ctx.doc.is_rework)) && plan,
        confirm: 'Release this order? The cut list and route are locked, the material request is prepared from the BOM (the floor sends it to Stores with "Request material") and the stages appear on the stage board.',
        run: async c => { const mr = await rpc('wo_release', { p_wo: c.doc.id }); toast(mr ? 'Released — material request prepared; the floor sends it with "Request material"' : 'Released', 'ok', 6000); } },
      { label: '📤 Request material', cls: 'primary', show: ['RELEASED', 'IN_PROGRESS'].includes(s) && ctx.extra.mrStatus === 'DRAFT' && hasRole('shop_floor', 'production_incharge', 'stores', 'factory_manager'),
        confirm: 'Send the material request for this order to Stores? Items and quantities are as per the BOM.', done: 'Material request sent to Stores',
        run: c => rpc('wo_request_material', { p_wo: c.doc.id }) },
      { label: '➕ Excess material', show: ['RELEASED', 'IN_PROGRESS'].includes(s) && hasRole('shop_floor', 'production_incharge', 'stores', 'factory_manager'),
        run: c => excessMaterial(c.doc) },
      { label: '🖨 Job card', show: s !== 'CANCELLED', reload: false, run: c => jobCard(c) },
      { label: '⏱ Stage board', show: ['RELEASED', 'IN_PROGRESS'].includes(s), reload: false, run: c => go('floor/' + c.doc.id) },
      { label: '📦 Material request', show: !!ctx.doc.mr_id, reload: false, run: c => go('d/mr/' + c.doc.mr_id) },
      ...(ctx.extra.excess || []).map(m => ({ label: `➕ ${m.mr_no} (${label(m.status)})`, reload: false, run: () => go('d/mr/' + m.id) })),
      { label: '📥 Receive batch to FG', show: ['RELEASED', 'IN_PROGRESS'].includes(s) && plan, run: c => receiveFg(c, false) },
      { label: '✔ Final receipt & complete', cls: 'ok', show: ['RELEASED', 'IN_PROGRESS'].includes(s) && plan, run: c => receiveFg(c, true) },
      ...(ctx.extra.receipts || []).filter(r => r.qc_status === 'PENDING_FM').map(r => ({ label: `⚖ QC decision ${r.receipt_no}`, cls: 'primary',
        show: hasRole('factory_manager'), run: () => qcDecide(r, ctx.doc.wo_no) })),
      { label: '↻ Parent order', show: !!ctx.doc.parent_wo_id, reload: false, run: c => go('d/wo/' + c.doc.parent_wo_id) },
      ...(ctx.extra.reworks || []).map(r => ({ label: `↻ ${r.wo_no} (${label(r.status)})`, reload: false, run: () => go('d/wo/' + r.id) })),
      { label: '🚚 Dispatch', cls: 'primary', show: s === 'COMPLETED' && hasRole('stores', 'factory_manager'), reload: false, run: c => go('d/dsp/new/wo/' + c.doc.id) },
      { label: 'Cancel order', show: ['PENDING_FM', 'APPROVED', 'RELEASED', 'IN_PROGRESS'].includes(s) && plan,
        run: async c => { const v = await ask({ title: 'Cancel ' + c.doc.wo_no, fields: [{ k: 'r', label: 'Reason', type: 'textarea', required: true }], okText: 'Cancel order', danger: true });
          if (v) return rpc('wo_cancel', { p_wo: c.doc.id, p_reason: v.r }); } },
    ];
  },
};

// a draft order for the factory schedule: its route and materials as they are on screen
function woDraft(ctx) {
  const d = ctx.doc;
  const ops = (ctx.grids.ops || []).filter(o => o.work_center_id).map((o, i) => ({ id: o.id || `draft-${i}`, wo_id: d.id, seq: num(o.seq), work_center_id: o.work_center_id,
    planned_labour_hours: num(o.planned_labour_hours), planned_machine_hours: num(o.planned_machine_hours), wait_days: num(o.wait_days), status: 'PENDING', qty_done: 0, run_group_id: null }));
  if (!ops.length) return null;
  return { wo: { ...d, status: 'DRAFT' }, ops,
    req: (ctx.grids.materials || []).filter(m => m.item_id && num(m.required_qty) > 0).map(m => ({ wo_id: d.id, item_id: m.item_id, required_qty: num(m.required_qty) })) };
}

// ---------- material check before FG receipts ----------
// material comes from the project's common WIP: each receipt consumes BOM per unit × units from it. Shown first:
// requests not sent / not issued, issues not received on the floor, more issued than plan, and the project pool short
// of what the order's open units need (those units would be costed without that material)
export async function materialGaps(d) {
  await loadRefs(['uoms']);
  const [mats, led, mrs, iss] = await Promise.all([
    sb.from('wo_materials').select('item_id,required_qty').eq('wo_id', d.id),
    sb.from('stock_ledger').select('item_id,qty').eq('production_order_id', d.id).in('txn_type', ['ISSUE', 'RETURN']),
    sb.from('material_requests').select('mr_no,kind,status,mr_lines(item_id,requested_qty,approved_qty,issued_qty)').eq('production_order_id', d.id).not('status', 'in', '(CANCELLED,REJECTED,CLOSED)'),
    sb.from('material_issues').select('issue_no').eq('production_order_id', d.id).eq('status', 'POSTED').eq('ack_status', 'PENDING')]);
  const by = {}, row = id => (by[id] ||= { item: id, plan: 0, excess: 0, issued: 0, open: 0, held: 0 });
  must(mats).forEach(m => { row(m.item_id).plan += num(m.required_qty); });
  must(led).forEach(l => { row(l.item_id).issued -= num(l.qty); });
  for (const m of must(mrs)) for (const l of m.mr_lines) {
    const r = row(l.item_id), left = Math.max(0, num(l.approved_qty ?? l.requested_qty) - num(l.issued_qty));
    if (m.kind === 'EXCESS' && ['APPROVED', 'PARTIALLY_ISSUED', 'ISSUED'].includes(m.status)) r.excess += num(l.approved_qty ?? l.requested_qty);
    if (m.status === 'DRAFT' || m.status === 'PENDING_APPROVAL') r.held += left; else if (['APPROVED', 'PARTIALLY_ISSUED'].includes(m.status)) r.open += left;
  }
  const lines = [], info = [], open = Math.max(0, num(d.qty) - num(d.qty_completed) - num(d.qty_rejected));
  const ids = Object.keys(by);
  const pool = Object.fromEntries((ids.length ? must(await sb.from('v_wip_stock').select('item_id,qty').eq('project_id', d.project_id).in('item_id', ids)) : []).map(p => [p.item_id, num(p.qty)]));
  // other open orders of the project still needing each item (what is left in the pool after this order is theirs)
  const others = must(await sb.from('production_orders').select('id').eq('project_id', d.project_id).in('status', OPEN_WO).neq('id', d.id));
  const usedLater = new Set(others.length && ids.length ? must(await sb.from('wo_materials').select('item_id').in('wo_id', others.map(o => o.id)).in('item_id', ids)).map(u => u.item_id) : []);
  for (const r of Object.values(by)) {
    // items counted in whole units (sheets, cans, rolls) are issued rounded up: 4 sheets for a plan of 3.08 is normal
    const whole = Number(refRow('uoms', refRow('items', r.item)?.uom_id)?.decimals ?? refRow('items', r.item)?.uoms?.decimals) === 0;
    const name = itemName(r.item), u = itemUom(r.item), allowed = (whole ? Math.ceil(r.plan - 1e-6) : r.plan) + r.excess;
    if (r.held > 1e-6) lines.push(`• ${name}: ${qty(r.held)} ${u} never sent to Stores (request not sent / awaiting approval)`);
    if (r.open > 1e-6) lines.push(`• ${name}: ${qty(r.open)} ${u} requested but not issued yet`);
    if (r.issued > allowed * 1.02 + 1e-6) lines.push(`• ${name}: issued ${qty(r.issued)} ${u}, more than plan${r.excess ? ' + approved excess' : ''} (${qty(allowed)})`);
    const need = r.plan / (num(d.qty) || 1) * open, have = pool[r.item] || 0;
    if (r.plan > 0 && have < need - 0.0005) lines.push(`• ${name}: only ${qty(Math.round(have * 1000) / 1000)} ${u} in project WIP, the ${qty(open)} open unit(s) need ${qty(Math.round(need * 1000) / 1000)}`);
    else if (r.plan > 0 && !usedLater.has(r.item) && have - need > 0.0005)
      info.push(`• ${name}: ${qty(Math.round((have - need) * 1000) / 1000)} ${u} will be left in project WIP — no other open order of the project uses it; return it to store`);
  }
  const unack = must(iss).map(i => i.issue_no);
  if (unack.length) lines.push(`• Issued but not yet received on the floor: ${unack.join(', ')}`);
  return { lines, info, pool, plan: Object.fromEntries(Object.values(by).map(r => [r.item, r.plan])) };
}

// ---------- FG receipt (batch or final) with QC outcome ----------
async function receiveFg(c, final) {
  const d = c.doc, open = Math.max(0, num(d.qty) - num(d.qty_completed) - num(d.qty_rejected));
  let override = '';
  const mg = await materialGaps(d);
  if (final && (mg.lines.length || mg.info.length)) {
    const w = await ask({ title: '⚠ Check material before completing ' + d.wo_no, danger: !!mg.lines.length,
      message: (mg.lines.length ? 'These units are costed with the material they consume from the project WIP, and what is still to issue on this order is closed:\n\n' + mg.lines.join('\n') +
        '\n\nIssue or return the material first (Material request → Issue material; Return to store & offcuts), or give the reason to complete anyway.' : '') +
        (mg.info.length ? (mg.lines.length ? '\n\n' : '') + mg.info.join('\n') : ''),
      fields: [{ k: 'r', label: mg.lines.length ? 'Reason to complete anyway (saved on the order)' : 'Remarks (optional)', type: 'textarea', required: !!mg.lines.length }],
      okText: mg.lines.length ? 'Complete anyway' : 'Continue' });
    if (!w) return;
    const notes = mg.lines.map(g => g.replace(/^• /, ''));
    if (notes.length || w.r) override = 'Material check: ' + notes.join('; ') + (w.r ? (notes.length ? ' — completed anyway: ' : ' — ') + w.r : '');
  }
  const v = await ask({
    title: (final ? 'Final receipt — ' : 'Receive batch — ') + d.wo_no,
    message: (final
      ? `All remaining cost goes to these units and the order closes. ${qty(open)} of ${qty(d.qty)} still open.`
      : `Send a batch to the Finished Goods Store; the order stays open. ${qty(open)} of ${qty(d.qty)} still open.`) +
      ' The BOM material for these units is consumed from the project WIP. Units rejected at QC are proposed for rework or scrap and go to the Factory Manager for approval; the FM may also accept some as good.',
    fields: [{ k: 'g', label: 'Good quantity → FG store', type: 'number', required: true, default: final ? open : null },
      { k: 'rw', label: 'Rejected — for rework', type: 'number', default: 0 }, { k: 'sc', label: 'Rejected — scrap', type: 'number', default: 0 },
      { k: 'm', label: 'QC remarks (reason for rejection)', type: 'textarea' }],
    okText: final ? 'Receive & complete' : 'Receive batch' });
  if (!v) return;
  if ((num(v.rw) || num(v.sc)) && !v.m) throw new Error('Enter the QC remarks for the rejected units');
  // a batch the project WIP cannot supply would go to FG without part of its material
  if (!final) {
    const units = num(v.g) + num(v.rw) + num(v.sc);
    const short = Object.entries(mg.plan).filter(([id, p]) => p > 0 && (mg.pool[id] || 0) < p / (num(d.qty) || 1) * units - 0.0005)
      .map(([id, p]) => `• ${itemName(id)}: ${qty(Math.round((mg.pool[id] || 0) * 1000) / 1000)} ${itemUom(id)} in project WIP, these ${qty(units)} unit(s) need ${qty(Math.round(p / num(d.qty) * units * 1000) / 1000)}`);
    if (short.length && !(await confirmBox('Project WIP is short', 'The batch would be costed without part of its material:\n\n' + short.join('\n') + '\n\nIssue the material first, or receive the batch anyway?', true))) return;
    if (short.length) override = 'Project WIP short: ' + short.map(s => s.replace(/^• /, '')).join('; ');
  }
  await rpc('wo_receive_fg', { p_wo: d.id, p_good: num(v.g), p_rework: num(v.rw), p_scrap: num(v.sc), p_final: final, p_remarks: [v.m, override].filter(Boolean).join(' · ') || null });
  const rej = num(v.rw) + num(v.sc);
  toast(`${final ? 'Order completed' : 'Batch received'} — ${qty(v.g)} to FG store${rej ? `; ${qty(rej)} rejected unit(s) sent to the Factory Manager for approval` : ''}`, 'ok', 7000);
}

// ---------- excess material for a process rejection: only this order's BOM items, reason required, FM approves ----------
export async function excessMaterial(d) {
  await loadRefs(['items']);
  const mats = must(await sb.from('wo_materials').select('item_id,required_qty').eq('wo_id', d.id));
  const by = {};
  mats.forEach(m => { by[m.item_id] = (by[m.item_id] || 0) + num(m.required_qty); });
  const ids = Object.keys(by).sort((a, b) => itemCode(a).localeCompare(itemCode(b)));
  if (!ids.length) throw new Error('This order has no BOM materials');
  const v = await ask({ title: 'Excess material — ' + d.wo_no,
    message: 'For parts rejected in a process (damage, wrong cut, defect). Only the materials of this order can be requested. The Factory Manager approves; the cost is charged to this order.',
    fields: [{ k: 'reason', label: 'Reason — which part / process was rejected', type: 'textarea', required: true },
      ...ids.map((id, i) => ({ k: 'q' + i, label: `${itemName(id)} (${itemUom(id)}) — BOM ${qty(by[id])}`, type: 'number' }))],
    okText: 'Send to Factory Manager' });
  if (!v) return;
  const lines = ids.map((id, i) => ({ item_id: id, qty: num(v['q' + i]) })).filter(l => l.qty > 0);
  if (!lines.length) throw new Error('Enter the quantity for at least one material');
  const id = await rpc('wo_excess_request', { p_wo: d.id, p_lines: lines, p_reason: v.reason });
  toast('Excess material request sent to the Factory Manager', 'ok');
  return id;
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
  if (c.grids.parts.length) tbl('Cut list', ['Sr. No.', 'Part', 'Material', 'L mm', 'W mm', 'Qty', 'Edge band', 'Edges', 'Grain', 'Notes'],
    c.grids.parts.map((p, i) => [i + 1, p.part_name, itemCode(p.material_id), qty(p.length_mm), qty(p.width_mm), qty(p.pieces), itemCode(p.edge_item_id), edges(p), p.grain ? 'Yes' : '', p.notes || '']));
  if (c.grids.materials.length) tbl('Materials', ['Sr. No.', 'Item', 'UoM', 'Required'],
    c.grids.materials.map((m, i) => [i + 1, itemName(m.item_id), itemUom(m.item_id), qty(m.required_qty)]), { columnStyles: { 3: { halign: 'right' } } });

  const sy = Math.min(Math.max(y + 12, H - 34), H - 20);
  if (sy > H - 20 || y > H - 30) { doc.addPage(); }
  const sigY = y > H - 30 ? H - 34 : sy;
  ['Production In-charge', 'QC', 'Received in FG store'].forEach((s, i) => { const w = (W - 28) / 3, x = 14 + i * w;
    doc.setDrawColor(150); doc.line(x + 3, sigY, x + w - 6, sigY); doc.setFontSize(8.5); doc.setTextColor(60); doc.text(s, x + 3, sigY + 4.5); });
  const pages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= pages; p++) { doc.setPage(p); doc.setFontSize(7.5); doc.setTextColor(140);
    doc.text(`${d.wo_no} · CitiCore`, 14, H - 8); doc.text(`Page ${p} of ${pages}`, W - 14, H - 8, { align: 'right' }); }
  showPdf(doc, `Job-card-${d.wo_no.replace(/[\/\\]/g, '-')}.pdf`, 'Job card · ' + d.wo_no);
}

// ======================================================================
// STAGE BOARD (supervisors log crew & hours per stage)
// ======================================================================
export const StageBoard = {
  components: { Badge, Icon, Modal },
  props: { woId: String },
  data: () => ({ rows: [], load: [], wc: '', busy: false, loading: true, dlg: null, onlyCurrent: false }),
  computed: {
    shown() { return this.rows.filter(r => (!this.wc || r.work_center_id === this.wc) && (!this.onlyCurrent || r.is_current)); },
    title() { return this.woId && this.rows[0] ? `${this.rows[0].wo_no} — open stages` : ''; },
    grades() { return (state.refs.labour_grades || []).filter(g => g.is_active); },
  },
  async mounted() {
    // on a phone or tablet start with the stages that can be worked on now; the choice is remembered
    try { const s = localStorage.getItem('cc.stage.current'); this.onlyCurrent = s === null ? innerWidth < 900 : s === '1'; } catch { this.onlyCurrent = innerWidth < 900; }
    await this.reload();
  },
  watch: { onlyCurrent(v) { try { localStorage.setItem('cc.stage.current', v ? '1' : '0'); } catch { /* storage unavailable */ } } },
  methods: {
    qty, dt, label, itemName, money, canSeeCost,
    over(r) { return num(r.planned_labour_hours) > 0 && num(r.act_labour_hours) > num(r.planned_labour_hours); },
    async reload() {
      this.loading = true;
      await run(async () => {
        await loadRefs(['items', 'work_centers', 'projects']);
        await loadRef('labour_grades', true);
        let q = sb.from('v_wo_stage_board').select('*');
        if (this.woId) q = q.eq('wo_id', this.woId);
        const rows = must(await q.order('due_date', { nullsFirst: false }).order('wo_no').order('seq'));
        this.load = must(await sb.from('v_work_center_load').select('*').order('sort_order'));
        // factory schedule: each stage in the order the work centre should take it, with its planned start
        const w = await loadOpenWork(), s = schedule(jobsFrom(w.orders, w.ops));
        const at = {};
        for (const r of s.res.values()) r.stages.forEach(x => { at[x.id] = x.start; });
        rows.forEach(r => { r._t = at[r.operation_id] ?? Infinity; r._start = at[r.operation_id] !== undefined ? dateAt(s.start, at[r.operation_id]) : null; });
        rows.sort((a, b) => a._t - b._t || String(a.wo_no).localeCompare(String(b.wo_no)) || a.seq - b.seq);
        const nAt = {};
        rows.forEach(r => { r._pos = (nAt[r.work_center_id] = (nAt[r.work_center_id] || 0) + 1); });
        // machine hours already logged per stage (to pre-fill what is still planned)
        const opIds = rows.map(r => r.operation_id);
        const mlog = opIds.length ? must(await sb.from('wo_time_logs').select('operation_id,machine_hours').in('operation_id', opIds)) : [];
        rows.forEach(r => { r._actMh = mlog.filter(l => l.operation_id === r.operation_id).reduce((s, l) => s + num(l.machine_hours), 0); });
        // combined runs: the stage carries its run and the other orders in it
        const grp = Object.fromEntries(w.ops.filter(o => o.run_group_id).map(o => [o.id, o.run_group_id]));
        const woNo = Object.fromEntries(w.orders.map(o => [o.id, o]));
        rows.forEach(r => {
          const g = grp[r.operation_id], run = g && w.runs.find(x => x.id === g);
          r._run = run ? { ...run, members: w.ops.filter(o => o.run_group_id === g && !['DONE', 'SKIPPED'].includes(o.status)).map(o => ({ op: o.id, wo_no: woNo[o.wo_id]?.wo_no, qty: num(woNo[o.wo_id]?.qty) - num(o.qty_done), status: o.status })) } : null;
        });
        this.rows = rows;
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
      // a combined run is logged once: quantity per order, the time split by their planned hours
      const run = r._run ? { ...r._run, qty: Object.fromEntries(r._run.members.map(m => [m.op, finish ? m.qty : 0])) } : null;
      // pre-filled from the plan: the man-hours still planned on the stage (all of the run's orders for a run), shared by
      // the machine's operators — the whole balance when finishing, at most one shift otherwise; the quantity left when finishing
      const stageRows = run ? this.rows.filter(x => run.members.some(m => m.op === x.operation_id)) : [r];
      const left = Math.max(0, stageRows.reduce((s, x) => s + num(x.planned_labour_hours) - num(x.act_labour_hours), 0));
      const workers = wcOps(r.work_center_id), shift = num(state.company?.plan_hours_per_day) || 8;
      const each = left > 0 ? Math.round((finish ? left / workers : Math.min(left / workers, shift)) * 100) / 100 : null;
      // machine stages: the machine hours still planned — the balance when finishing, at most one shift otherwise
      const mLeft = Math.max(0, stageRows.reduce((s, x) => s + num(x.planned_machine_hours) - num(x._actMh), 0));
      const mh = wc?.kind === 'MACHINE' && mLeft > 0 ? Math.round((finish ? mLeft : Math.min(mLeft, shift)) * 100) / 100 : null;
      this.dlg = { r, run, d: today(), crew: [{ grade_id: g, workers, hours: each, ot: 0, _auto: true, _left: left, _finish: finish, _shift: shift }],
        mh, q: finish && !run ? Math.max(0, num(r.qty) - num(r.qty_done)) : 0, n: '', f: finish, machine: wc?.kind === 'MACHINE' };
    },
    // a pre-filled line follows a change of the number of workers (until its hours are typed by hand)
    crewWorkers(c) {
      if (!c._auto || !(num(c.workers) > 0) || !(c._left > 0)) return;
      c.hours = Math.round((c._finish ? c._left / num(c.workers) : Math.min(c._left / num(c.workers), c._shift)) * 100) / 100;
    },
    async startRun(r) { this.busy = true; await run(() => rpc('run_group_start', { p_group: r._run.id }), 'Combined run started'); this.busy = false; await this.reload(); },
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
      if (v.run) {
        const ok = await run(() => rpc('run_group_log', { p_group: v.run.id, p_date: v.d,
          p_crew: crew.map(c => ({ grade_id: c.grade_id, workers: num(c.workers), hours: num(c.hours), ot_hours: num(c.ot) })),
          p_machine_hours: v.mh === null || v.mh === '' ? null : num(v.mh), p_qty: Object.fromEntries(Object.entries(v.run.qty).map(([k, q]) => [k, num(q)])),
          p_notes: v.n || null, p_complete: !!v.f }), v.f ? 'Combined run logged — stages closed' : 'Combined run logged');
        this.busy = false;
        if (ok) { this.dlg = null; await this.reload(); }
        return;
      }
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
    <div class="row" style="margin-bottom:8px;flex-wrap:wrap;gap:8px" v-if="woId">
      <button class="btn" @click="all">← All orders</button>
      <b v-if="title">{{ title }}</b>
    </div>
    <div class="row" style="margin-bottom:8px;gap:8px">
      <label class="row small" style="gap:6px;cursor:pointer"><input type="checkbox" v-model="onlyCurrent"> Current stages only</label>
      <span class="spacer"></span>
      <button class="btn sm" @click="reload" :disabled="loading">↻ Refresh</button>
    </div>
    <div class="stage-chips">
      <a href="javascript:void 0" class="chip" :class="{on: !wc}" @click="wc=''">All stages <span class="muted">({{ rows.length }})</span></a>
      <a v-for="w in load" :key="w.work_center_id" href="javascript:void 0" class="chip" :class="{on: wc===w.work_center_id}" @click="wc = w.work_center_id"
         :title="w.remaining_hours + ' h remaining · ' + (w.load_days || 0) + ' days load' + (w.is_down ? ' · MACHINE DOWN' : '')" :style="w.is_down ? 'border-color:#b91c1c' : ''">
        <span v-if="w.is_down" style="color:#b91c1c">⛔ </span>{{ w.name }} <span class="muted">({{ rows.filter(r=>r.work_center_id===w.work_center_id).length }}{{ w.load_days ? ' · ' + w.load_days + 'd' : '' }})</span></a>
    </div>

    <!-- phones / tablets: one card per stage with big buttons -->
    <div class="stage-cards">
      <div v-if="loading" class="card empty">Loading…</div>
      <div v-else-if="!shown.length" class="card empty">No open stages{{ wc ? ' at this work centre' : '' }}</div>
      <div v-for="r in shown" :key="'c' + r.operation_id" class="stage-card" :class="{waiting: !r.is_current, late: late(r)}">
        <div class="row" style="gap:6px;align-items:flex-start">
          <div style="flex:1;min-width:0">
            <a href="javascript:void 0" @click="openWo(r)"><b>{{ r.wo_no }}</b></a>
            <span class="muted small"> · {{ proj(r.project_id) }}</span>
            <div class="small">{{ r.description || itemName(r.item_id) }} · qty {{ qty(r.qty) }}</div>
          </div>
          <Badge v-if="r.priority==='URGENT'" v="URGENT" /><Badge :v="r.status" />
        </div>
        <div class="stage-line">
          <span><b>{{ r.seq }} · {{ r.wc_name }}</b> <Badge v-if="isDown(r.work_center_id)" v="DOWN" /></span>
          <span class="small" :class="late(r) ? 'bad-t' : 'muted'">Due {{ dt(r.due_date) || '—' }}</span>
        </div>
        <div class="small muted" v-if="!r.is_current">Waiting for an earlier stage</div>
        <div class="small" v-if="r._start">📅 Planned start {{ dt(r._start) }} · #{{ r._pos }} in the queue here</div>
        <div class="small" v-if="r._run" style="color:#1e40af">🔗 Combined run {{ r._run.run_no }}: {{ r._run.members.map(m => m.wo_no).join(' + ') }}<span v-if="r._run.notes"> · {{ r._run.notes }}</span></div>
        <div class="small" v-if="r.instructions">📝 {{ r.instructions }}</div>
        <div class="stage-nums">
          <div><span class="muted">Man-hours</span><b :class="{warn: over(r)}">{{ qty(r.act_labour_hours) }} / {{ qty(r.planned_labour_hours) }}</b></div>
          <div><span class="muted">Qty done</span><b>{{ qty(r.qty_done) }} / {{ qty(r.qty) }}</b></div>
        </div>
        <div class="stage-btns">
          <template v-if="r._run">
            <button v-if="r.status==='PENDING'" class="btn" :disabled="busy" @click="startRun(r)">▶ Start run</button>
            <button class="btn primary" :disabled="busy" @click="log(r)">⏱ Log run</button>
            <button class="btn ok" :disabled="busy" @click="log(r, true)">✔ Finish run</button>
          </template>
          <template v-else>
          <button v-if="r.status==='PENDING'" class="btn" :disabled="busy" @click="start(r)">▶ Start</button>
          <button class="btn primary" :disabled="busy" @click="log(r)">⏱ Log time</button>
          <button class="btn ok" :disabled="busy" @click="log(r, true)">✔ Finish</button>
          <button v-if="r.status==='IN_PROGRESS'" class="btn" :disabled="busy" @click="done(r)">Close</button>
          </template>
          <button v-if="!isDown(r.work_center_id)" class="btn tool" @click="reportDown(r)" title="Report a breakdown or stoppage" aria-label="Report a breakdown">🔧</button>
        </div>
      </div>
    </div>

    <div class="card stage-table">
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
              <div class="small muted">{{ r.is_current ? 'Current stage' : 'Waiting for earlier stage' }}<span v-if="r._start"> · planned {{ dt(r._start) }} · #{{ r._pos }} here</span></div>
              <div class="small" v-if="r._run" style="color:#1e40af">🔗 {{ r._run.run_no }}: {{ r._run.members.map(m => m.wo_no).join(' + ') }}</div>
              <div class="small" v-if="r.instructions">{{ r.instructions }}</div></td>
            <td><Badge :v="r.status" /></td>
            <td class="n">{{ qty(r.planned_labour_hours) }}</td>
            <td class="n" :style="Number(r.act_labour_hours) > Number(r.planned_labour_hours) && Number(r.planned_labour_hours) ? 'color:#b45309;font-weight:600' : ''">{{ qty(r.act_labour_hours) }}</td>
            <td class="n">{{ qty(r.qty_done) }}</td>
            <td style="white-space:nowrap">
              <template v-if="r._run">
                <button v-if="r.status==='PENDING'" class="btn sm" :disabled="busy" @click="startRun(r)">▶ Start run</button>
                <button class="btn sm primary" :disabled="busy" @click="log(r)">⏱ Log run</button>
                <button class="btn sm ok" :disabled="busy" @click="log(r, true)" title="Log the last session of the run and close its stages">✔ Finish run</button>
              </template>
              <template v-else>
              <button v-if="r.status==='PENDING'" class="btn sm" :disabled="busy" @click="start(r)">▶ Start</button>
              <button class="btn sm primary" :disabled="busy" @click="log(r)">⏱ Log time</button>
              <button class="btn sm ok" :disabled="busy" @click="log(r, true)" title="Log the last session and close the stage">✔ Finish</button>
              <button v-if="r.status==='IN_PROGRESS'" class="btn sm" :disabled="busy" @click="done(r)" title="Close without logging">Close</button>
              </template>
              <button v-if="!isDown(r.work_center_id)" class="btn sm" @click="reportDown(r)" title="Report a breakdown or stoppage at this work centre">🔧</button>
            </td>
          </tr>
        </tbody>
      </table></div>
    </div>
    <p class="small muted">Stages are listed in the <b>factory schedule</b> order (URGENT first, then earliest due date) — take them top to bottom at each work centre. Supervisors log the crew by <b>worker grade × workers × hours</b> for each stage; machine hours default to the longest crew line on machine stages. Scan the QR on the job card to open one order directly.</p>

    <Modal v-if="dlg" :title="(dlg.run ? '🔗 ' + dlg.run.run_no : dlg.r.wo_no) + ' · ' + dlg.r.wc_name" @close="dlg = null">
      <p class="small muted" style="margin-top:0" v-if="dlg.run">Combined run — log the whole crew and hours once; they are split over the orders by their planned hours. Enter the quantity done for each order.</p>
      <p class="small muted" style="margin-top:0" v-else>Planned {{ qty(dlg.r.planned_labour_hours) }} man-hours · logged so far {{ qty(dlg.r.act_labour_hours) }} · order qty {{ qty(dlg.r.qty) }}
        <span v-if="dlg.crew[0]?._left > 0"> · hours pre-filled from the plan ({{ dlg.f ? 'balance to finish' : 'up to one shift' }}) — change them to what was actually worked</span></p>
      <div class="grid" v-if="dlg.run" style="margin-bottom:6px">
        <label v-for="m in dlg.run.members" :key="m.op" class="f"><span>{{ m.wo_no }} — qty done ({{ qty(m.qty) }} open)</span><input type="number" step="any" v-model.number="dlg.run.qty[m.op]"></label>
      </div>
      <div class="grid">
        <label class="f"><span>Date <span class="req">*</span></span><input type="date" v-model="dlg.d"></label>
        <label class="f" v-if="!dlg.run"><span>Qty completed this session</span><input type="number" step="any" v-model.number="dlg.q"></label>
        <label class="f" v-if="dlg.machine"><span>Machine hours (pre-filled from the plan; blank = longest crew line)</span><input type="number" step="any" v-model.number="dlg.mh"></label>
      </div>
      <h3 style="margin:14px 0 6px">Crew</h3>
      <!-- one block per worker grade; fits a phone without sideways scrolling -->
      <div v-for="(c, i) in dlg.crew" :key="i" class="crew-line">
        <div class="row" style="gap:6px">
          <select v-model="c.grade_id" style="flex:1;min-width:0"><option :value="null" disabled>Select grade…</option><option v-for="g in grades" :value="g.id">{{ g.name }}</option></select>
          <button class="btn sm bad" v-if="dlg.crew.length > 1" @click="dlg.crew.splice(i, 1)" aria-label="Remove line">✕</button>
        </div>
        <div class="crew-nums">
          <label><span>Workers</span><input type="number" min="1" step="1" inputmode="numeric" v-model.number="c.workers" @input="crewWorkers(c)"></label>
          <label><span>Normal h each</span><input type="number" min="0" step="0.25" inputmode="decimal" v-model.number="c.hours" @input="c._auto = false"></label>
          <label><span>Overtime h each</span><input type="number" min="0" step="0.25" inputmode="decimal" v-model.number="c.ot"></label>
          <div class="crew-tot"><span>Man-hours</span><b>{{ qty(lineHours(c)) }}</b><span v-if="canSeeCost()" class="muted small">AED {{ money(lineCost(c)) }}</span></div>
        </div>
      </div>
      <div class="row" style="gap:8px;margin-top:6px">
        <button class="btn sm" @click="addCrew">+ Add grade</button><span class="spacer"></span>
        <span>Total <b>{{ qty(manHours()) }}</b> man-hours<span v-if="canSeeCost()"> · AED <b>{{ money(crewCost()) }}</b></span></span>
      </div>
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
    if (parts[0] === 'so' && parts[1]) return loadSoIntoDispatch(ctx, parts[1]);
    await setDspProject(ctx.doc.project_id);
  },
  async afterLoad(ctx) { await loadWos(); await setDspProject(ctx.doc.project_id); if (ctx.doc.status === 'DRAFT') await fgAvail(ctx); },
  header: [
    { k: 'project_id', label: 'Project / sales order', type: 'ref', ref: 'projects', required: true, wide: true, request: false,
      filter: r => r.status === 'OPEN' && ['PROJECT', 'SALES', 'INTERNAL'].includes(r.project_type), onChange: (d, v) => setDspProject(v) },
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
    importers: [{ label: '⬇ Load project stock at this location', run: c => loadFgForProject(c) },
      { label: '⬇ Load sales order lines', show: c => !!dspProject.soLines.length, run: c => loadSoIntoDispatch(c, refRow('projects', c.doc.project_id)?.sales_order_id) }],
    fields: [
      { k: 'so_line_id', label: 'Sales order line', type: 'ref', width: '220px', refOptions: () => dspProject.soLines, show: () => !!dspProject.soLines.length,
        onChange: (r, v, ctx) => { const l = dspProject.soLines.find(x => x.id === v)?.row; if (l) { r.item_id = l.item_id; r.production_order_id = l.production_order_id; } return fgAvail(ctx); } },
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
          title: 'Delivery Note', noLabel: 'DN No.', no: c.doc.dispatch_no, date: c.doc.dispatch_date, subtitle: label(c.doc.status),
          meta: [['Project / site', refLabel('projects', c.doc.project_id)], ['From', refLabel('locations', c.doc.from_location_id)],
                 ['Vehicle', c.doc.vehicle_no || ''], ['Driver', [c.doc.driver_name, c.doc.driver_phone].filter(Boolean).join(' · ') || '']],
          deliveryAddress: c.doc.delivery_address || '', notes: [c.doc.remarks, c.doc.received_by_name ? `Received at site by ${c.doc.received_by_name} on ${dt(c.doc.delivered_at)}` : ''].filter(Boolean).join('\n'),
          columns: [{ h: 'Sr. No.', k: r => c.grids.lines.indexOf(r) + 1, w: 15 }, { h: 'Product', k: r => itemCode(r.item_id) }, { h: 'Description', strong: true, k: r => refRow('items', r.item_id)?.name },
                    { h: 'UoM', k: r => itemUom(r.item_id) }, { h: 'Qty', k: r => qty(r.qty), align: 'right' }, { h: 'Packages', k: r => r.packages ?? '', align: 'right' },
                    { h: 'Order', k: r => popts.wos.find(w => w.id === r.production_order_id)?.label || '' }, { h: 'Remarks', k: 'remarks' }],
          rows: c.grids.lines,
          sign: { prepared: c.doc.created_by, checked: c.doc.status !== 'DRAFT' ? c.doc.posted_by : null, labels: ['Prepared By', 'Dispatched By', ''] },
          acceptance: refRow('projects', c.doc.project_id)?.customer || 'the customer' }) },
    ];
  },
};

// ======================================================================
// PRODUCTION PLANNER: project cards → in-house BOQ products → split into batches → production orders (to the FM)
// ======================================================================
const PLAN_OPEN = ['DRAFT', 'PENDING_FM', 'APPROVED'];
const PLAN_FLOOR = ['RELEASED', 'IN_PROGRESS'];
export const ProductionPlanner = {
  components: { Badge },
  props: { projectId: String, lineId: String },
  data: () => ({ loading: true, busy: false, projects: [], lines: [], orders: [], nb: 1, batches: [], route: [], work: null, useQueue: true, startDate: today(), showStages: false }),
  computed: {
    // capacity per work centre per day: hours × planning % × machines / people
    perDay: () => perDay(),
    holidays() { return this.work?.holidays || []; },
    capText() { const c = state.company || {}; return `Capacity: ${qty(this.perDay)} h per machine / person per day (${qty(c.plan_hours_per_day || 8)} h × ${qty(c.plan_efficiency_pct || 85)}%) · ${this.weekOffText} off` +
      ` · ${this.holAhead.length} public holiday(s) ahead skipped${this.holAhead.some(h => !h.confirmed) ? ' (some expected, not yet announced)' : ''} · change in Settings / Work centres / Public holidays`; },
    holAhead() { const s = this.startDate || today(); return this.holidays.filter(h => h.holiday_date >= s); },
    weekOffText() { return weekOff().map(d => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d]).join(', '); },
    existingJobs() { return this.work && this.useQueue ? jobsFrom(this.work.orders, this.work.ops) : []; },
    // flags of the open orders before these batches, to see which ones the batches would make late
    baseline() { const s = schedule(this.existingJobs, this.startDate || today()); return new Map([...s.res].map(([k, r]) => [k, r.flag])); },
    // the batches are put into the factory schedule with the open orders (URGENT first, then earliest due date; a batch
    // without a due date goes after the dated orders): each goes through the BOM route stage by stage — hours × qty plus
    // setup once, shared by the machines / people, then the wait after the stage
    plan() {
      if (!this.route.length || !this.work) return null;
      const cand = this.batches.map((b, i) => {
        const q = num(b.qty);
        return { id: 'new' + i, priority: 'NORMAL', due_date: b.due_date || null, rank: '~new' + String(i).padStart(3, '0'),
          ops: q > 0 ? this.route.map(r => {
            const su = num(r.setup_hours), mh = num(r.std_machine_hours) * q + (r.wc?.kind === 'MACHINE' ? su : 0), lh = num(r.std_labour_hours) * q + su * wcOps(r.work_center_id);
            return { id: `n${i}-${r.seq}`, seq: num(r.seq), wc: r.work_center_id, status: 'PENDING', wait: num(r.wait_days), mh, lh, h: stageHours(r.work_center_id, mh, lh) };
          }) : [] };
      });
      const s = schedule([...this.existingJobs, ...cand], this.startDate || today());
      const rows = cand.map(c => { const r = s.res.get(c.id);
        return { mh: c.ops.reduce((a, o) => a + o.mh, 0), lh: c.ops.reduce((a, o) => a + o.lh, 0), days: r.days, date: r.date, pos: s.sorted.indexOf(c) + 1 }; });
      const pushed = this.existingJobs.filter(j => this.baseline.get(j.id) !== 'LATE' && s.res.get(j.id)?.flag === 'LATE').map(j => j.wo.wo_no);
      const queued = {};
      this.existingJobs.forEach(j => j.ops.forEach(o => { queued[o.wc] = (queued[o.wc] || 0) + o.h; }));
      const stages = this.route.map(r => ({ ...r, cap: capOf(r.work_center_id),
        days: cand.reduce((a, c) => a + (c.ops.find(o => o.seq === num(r.seq))?.h || 0), 0) / capOf(r.work_center_id),
        queueDays: (queued[r.work_center_id] || 0) / capOf(r.work_center_id) }));
      const neck = stages.reduce((a, x) => (!a || x.days + x.queueDays > a.days + a.queueDays ? x : a), null);
      return { rows, stages, neck, pushed, total: s.sorted.length };
    },
    project() { return this.projects.find(p => p.id === this.projectId) || null; },
    line() { return this.lines.find(l => l.id === this.lineId) || null; },
    canPlan() { return hasRole('production_incharge', 'factory_manager'); },
    batchTotal() { return this.batches.reduce((s, b) => s + num(b.qty), 0); },
    remainder() { return this.line ? Math.max(0, Math.round(this.line.left - this.batchTotal)) : 0; },
    lineOrders() { return this.orders.filter(o => o.boq_line_id === this.lineId); },
  },
  watch: { projectId() { this.reload(); }, lineId() { this.reload(); } },
  async mounted() { await this.reload(); },
  methods: {
    qty, dt, label, itemName,
    async reload() {
      this.loading = true;
      await run(async () => {
        await loadRefs(['items', 'projects']);
        // made in-house BOQ lines of open projects, and the production orders against them (rework orders are outside the BOQ)
        const lines = must(await sb.from('boq_lines').select('id,project_id,boq_ref,line_no,description,item_id,qty,unit_type,template_id,projects!inner(id,code,name,status,customer)')
          .eq('category', 'MANUFACTURED').eq('projects.status', 'OPEN').order('line_no'));
        const pids = [...new Set(lines.map(l => l.project_id))];
        const orders = pids.length ? must(await sb.from('production_orders').select('id,wo_no,boq_line_id,project_id,qty,qty_completed,status,due_date,batch_label,fm_comments')
          .in('project_id', pids).neq('status', 'CANCELLED').eq('is_rework', false).not('boq_line_id', 'is', null).order('wo_no')) : [];
        const by = {};
        orders.forEach(o => { (by[o.boq_line_id] ||= []).push(o); });
        this.orders = orders;
        this.lines = lines.map(l => {
          const os = by[l.id] || [];
          const planned = os.reduce((s, o) => s + num(o.qty), 0);
          return { ...l, planned, left: Math.max(0, num(l.qty) - planned), done: os.reduce((s, o) => s + num(o.qty_completed), 0),
            nPending: os.filter(o => o.status === 'PENDING_FM').length, nFloor: os.filter(o => PLAN_FLOOR.includes(o.status)).length, nOrders: os.length };
        });
        const pm = {};
        this.lines.forEach(l => {
          const p = (pm[l.project_id] ||= { ...l.projects, items: 0, qty: 0, planned: 0, left: 0, done: 0, pending: 0, floor: 0 });
          p.items++; p.qty += num(l.qty); p.planned += l.planned; p.left += l.left; p.done += l.done; p.pending += l.nPending; p.floor += l.nFloor;
        });
        this.projects = Object.values(pm).sort((a, b) => a.code.localeCompare(b.code));
        if (this.projectId) this.lines = this.lines.filter(l => l.project_id === this.projectId);
        if (this.line) { this.split(1); await this.loadCapacity(); }
      });
      this.loading = false;
    },
    // the product's BOM route (hours per unit) and all open orders for the factory schedule
    async loadCapacity() {
      await loadRefs(['work_centers']);
      const l = this.line;
      const tpl = l.template_id || must(await sb.from('bom_templates').select('id').eq('item_id', l.item_id).eq('is_active', true).order('version', { ascending: false }).limit(1))[0]?.id;
      this.route = tpl ? must(await sb.from('bom_template_routing').select('seq,work_center_id,std_labour_hours,std_machine_hours,setup_hours,wait_days').eq('template_id', tpl).order('seq'))
        .map(r => ({ ...r, wc: refRow('work_centers', r.work_center_id) })) : [];
      this.work = await loadOpenWork();
    },
    d1: v => (Math.round(num(v) * 10) / 10).toFixed(1),
    useEstimates() { this.plan?.rows.forEach((r, i) => { if (r.date) this.batches[i].due_date = r.date; }); },
    pct(a, b) { return b ? Math.min(100, Math.round(100 * a / b)) : 0; },
    // split what is left into n batches of whole units (the first batches take the remainder)
    split(n) {
      const left = this.line?.left || 0;
      n = Math.max(1, Math.min(Math.floor(num(n)) || 1, Math.max(1, Math.ceil(left))));
      this.nb = n;
      const base = Math.floor(left / n), rem = Math.round(left - base * n);
      const old = this.batches;
      this.batches = Array.from({ length: n }, (_, i) => ({ qty: base + (i < rem ? 1 : 0), due_date: old[i]?.due_date || '', remarks: old[i]?.remarks || '' }));
    },
    // a changed batch keeps its quantity and only the batches after it share what is left (whole units, first ones take
    // the remainder); earlier batches never change. The last batch can be lowered (the rest stays to plan later) but
    // not raised above what the earlier batches leave.
    rebalance(i) {
      const left = Math.round(this.line?.left || 0), bs = this.batches;
      const before = bs.slice(0, i).reduce((s, b) => s + Math.max(0, Math.round(num(b.qty))), 0);
      const me = bs[i];
      me.qty = Math.min(Math.max(0, Math.round(num(me.qty))), Math.max(0, left - before));
      const n = bs.length - i - 1;
      if (n > 0) {
        const rest = left - before - me.qty, base = Math.floor(rest / n), rem = rest - base * n;
        bs.slice(i + 1).forEach((b, k) => { b.qty = base + (k < rem ? 1 : 0); });
      }
    },
    addRemainder() { this.batches.push({ qty: this.remainder, due_date: '', remarks: '' }); this.nb = this.batches.length; },
    async create() {
      const l = this.line, bs = this.batches.filter(b => num(b.qty) > 0);
      if (!bs.length) return toast('Enter a quantity for at least one batch', 'error');
      if (bs.some(b => !Number.isInteger(num(b.qty)))) return toast('Batch quantities must be whole units', 'error');
      if (this.batchTotal > l.left + 0.0005) return toast(`The batches add up to ${qty(this.batchTotal)} — only ${qty(l.left)} is left to plan on this BOQ line`, 'error');
      if (!(await confirmBox('Create production orders', `Create ${bs.length} production order(s) for ${qty(this.batchTotal)} × ${l.description} and send them to the Factory Manager for approval?`))) return;
      this.busy = true;
      const n = await run(() => rpc('wo_create_batches', { p_line: l.id, p_batches: bs.map(b => ({ qty: num(b.qty), due_date: b.due_date || null, remarks: b.remarks || null })) }));
      this.busy = false;
      if (n) { toast(`${n} production order(s) created and sent to the Factory Manager`, 'ok', 6000); await this.reload(); }
    },
    async fmAll() {
      const ps = this.lineOrders.filter(o => o.status === 'PENDING_FM');
      if (!(await confirmBox('Approve orders', `Approve ${ps.length} production order(s) for release?`))) return;
      this.busy = true;
      await run(async () => { for (const o of ps) await rpc('wo_fm_decide', { p_wo: o.id, p_approve: true, p_comments: null }); toast('Approved', 'ok'); });
      this.busy = false; await this.reload();
    },
    async releaseAll() {
      const ps = this.lineOrders.filter(o => o.status === 'APPROVED');
      if (!(await confirmBox('Release to floor', `Release ${ps.length} approved order(s) to the floor? Their material requests are prepared from the BOM.`))) return;
      this.busy = true;
      await run(async () => { for (const o of ps) await rpc('wo_release', { p_wo: o.id }); toast('Released to the floor', 'ok'); });
      this.busy = false; await this.reload();
    },
    hasRole, go,
  },
  template: `<div>
    <div class="row" style="gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
      <a v-if="projectId" class="btn sm" href="javascript:void 0" @click="go(lineId ? 'plan/' + projectId : 'plan')">← {{ lineId ? 'Back to products' : 'All projects' }}</a>
      <b v-if="project">{{ project.code }} — {{ project.name }}</b>
      <span v-if="line" class="muted">/ {{ line.boq_ref || line.line_no }} {{ line.description }}</span>
      <span class="spacer" style="flex:1"></span>
      <button class="btn sm" @click="go('d/wo')">☰ All production orders (list)</button>
      <button class="btn sm" @click="reload">↻ Refresh</button>
    </div>
    <div v-if="loading" class="card empty">Loading…</div>

    <!-- 1. project cards -->
    <template v-else-if="!projectId">
      <div v-if="!projects.length" class="card empty">No open project has made in-house products in its BOQ.</div>
      <div class="kpis">
        <div v-for="p in projects" :key="p.id" class="kpi" style="cursor:pointer" @click="go('plan/' + p.id)">
          <div class="l">{{ p.code }}<span v-if="p.customer"> · {{ p.customer }}</span></div>
          <div style="font-weight:700;font-size:16px;margin:4px 0">{{ p.name }}</div>
          <div class="s">{{ p.items }} in-house product(s) · {{ qty(p.qty) }} units in BOQ</div>
          <div style="height:6px;background:var(--line);border-radius:3px;margin:8px 0 4px"><div :style="{ width: pct(p.planned, p.qty) + '%', height: '6px', background: 'var(--brand)', borderRadius: '3px' }"></div></div>
          <div class="s">{{ qty(p.planned) }} on orders · <b>{{ qty(p.left) }} to plan</b> · {{ qty(p.done) }} to FG</div>
          <div class="s" v-if="p.pending || p.floor"><span v-if="p.pending">⏳ {{ p.pending }} with FM</span><span v-if="p.pending && p.floor"> · </span><span v-if="p.floor">🏭 {{ p.floor }} on floor</span></div>
        </div>
      </div>
    </template>

    <!-- 2. producible items of the project -->
    <template v-else-if="!lineId">
      <div class="card">
        <div class="hd"><h3>Made in-house products (BOQ)</h3></div>
        <div class="tbl-wrap"><table class="t">
          <thead><tr><th>BOQ</th><th>Description</th><th>Product</th><th class="n">BOQ qty</th><th class="n">On orders</th><th class="n">To plan</th><th class="n">To FG</th><th>Orders</th><th></th></tr></thead>
          <tbody>
            <tr v-if="!lines.length"><td colspan="9" class="empty">No made in-house BOQ lines</td></tr>
            <tr v-for="l in lines" :key="l.id" style="cursor:pointer" @click="go('plan/' + projectId + '/' + l.id)">
              <td>{{ l.boq_ref || l.line_no }}</td><td>{{ l.description }}<div class="small muted" v-if="l.unit_type">{{ l.unit_type }}</div></td>
              <td>{{ l.item_id ? itemName(l.item_id) : '⚠ product not set' }}</td>
              <td class="n">{{ qty(l.qty) }}</td><td class="n">{{ qty(l.planned) }}</td><td class="n"><b>{{ qty(l.left) }}</b></td><td class="n">{{ qty(l.done) }}</td>
              <td class="small">{{ l.nOrders || '' }}<span v-if="l.nPending"> · ⏳ {{ l.nPending }} with FM</span><span v-if="l.nFloor"> · 🏭 {{ l.nFloor }} on floor</span></td>
              <td><button class="btn sm primary" @click.stop="go('plan/' + projectId + '/' + l.id)">{{ l.left > 0 && canPlan ? 'Plan batches →' : 'Open →' }}</button></td>
            </tr>
          </tbody>
        </table></div>
      </div>
    </template>

    <!-- 3. split one product into batches -->
    <template v-else-if="line">
      <div class="kpis">
        <div class="kpi"><div class="l">Product</div><div style="font-weight:600;margin-top:4px">{{ line.item_id ? itemName(line.item_id) : '⚠ set the product on the BOQ line' }}</div></div>
        <div class="kpi"><div class="l">BOQ quantity</div><div class="v">{{ qty(line.qty) }}</div></div>
        <div class="kpi"><div class="l">Already on orders</div><div class="v">{{ qty(line.planned) }}</div></div>
        <div class="kpi" :class="line.left > 0 ? 'warn' : 'ok'"><div class="l">Left to plan</div><div class="v">{{ qty(line.left) }}</div></div>
      </div>
      <div class="card" v-if="line.left > 0 && canPlan && line.item_id">
        <div class="hd"><h3>Split into batches</h3></div>
        <div class="row" style="gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
          <label>Number of batches <input type="number" min="1" step="1" style="width:80px" v-model.number="nb" @change="split(nb)"></label>
          <button class="btn sm" @click="split(nb)">⇆ Split {{ qty(line.left) }} equally</button>
          <span class="small muted">Each batch becomes one production order with materials, man-hours and machine hours from the BOM × batch qty.</span>
        </div>
        <div class="row small" style="gap:14px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
          <label>Production starts <input type="date" v-model="startDate"></label>
          <label class="row" style="gap:4px"><input type="checkbox" v-model="useQueue"> schedule with the other open orders (URGENT first, then earliest due date)</label>
          <span class="muted">{{ capText }}</span>
        </div>
        <div v-if="!route.length" class="small" style="color:var(--warn);margin-bottom:8px">⚠ No BOM route (stages with hours) for this product — completion dates cannot be estimated.</div>
        <div class="tbl-wrap"><table class="t">
          <thead><tr><th>Batch</th><th class="n">Quantity</th><th class="n" v-if="plan">Machine h</th><th class="n" v-if="plan">Man-h</th><th v-if="plan">Est. completion</th><th>Due date</th><th>Remarks (units / floor / building)</th></tr></thead>
          <tbody>
            <tr v-for="(b, i) in batches" :key="i">
              <td>Batch {{ i + 1 }} of {{ batches.length }}</td>
              <td class="n"><input type="number" min="0" step="1" style="width:90px;text-align:right" v-model.number="b.qty" @change="rebalance(i)"></td>
              <td class="n" v-if="plan">{{ qty(plan.rows[i]?.mh) }}</td><td class="n" v-if="plan">{{ qty(plan.rows[i]?.lh) }}</td>
              <td v-if="plan"><template v-if="plan.rows[i]?.date"><b>{{ dt(plan.rows[i].date) }}</b><div class="small muted">working day {{ plan.rows[i].days }}<span v-if="useQueue"> · #{{ plan.rows[i].pos }} of {{ plan.total }} in schedule</span> · <a href="javascript:void 0" @click="b.due_date = plan.rows[i].date">use as due date</a></div></template></td>
              <td><input type="date" v-model="b.due_date"></td>
              <td><input style="width:100%" v-model="b.remarks"></td>
            </tr>
            <!-- what the batches leave on the BOQ line: stays to plan later, or becomes one more batch -->
            <tr v-if="remainder > 0" style="background:#fffbeb">
              <td class="muted">Not in a batch</td>
              <td class="n"><b>{{ qty(remainder) }}</b></td>
              <td :colspan="plan ? 5 : 2" class="small">stays on the BOQ line to plan later ·
                <button class="btn sm" @click="addRemainder">+ Add as batch {{ batches.length + 1 }}</button></td>
            </tr>
          </tbody>
          <tfoot><tr><th>Total</th><th class="n" :style="{ color: batchTotal > line.left + 0.0005 ? 'var(--bad)' : '' }">{{ qty(batchTotal) }} / {{ qty(line.left) }}</th>
            <th class="n" v-if="plan">{{ qty(plan.rows.reduce((s, r) => s + r.mh, 0)) }}</th><th class="n" v-if="plan">{{ qty(plan.rows.reduce((s, r) => s + r.lh, 0)) }}</th>
            <th v-if="plan"><button class="btn sm" @click="useEstimates">↓ Use all as due dates</button></th><th colspan="2"></th></tr></tfoot>
        </table></div>
        <div v-if="plan" class="small" style="margin-top:6px">
          Bottleneck: <b>{{ plan.neck?.wc?.name || '' }}</b> — {{ d1(plan.neck?.days) }} working days for these batches<span v-if="useQueue && plan.neck?.queueDays"> + {{ d1(plan.neck.queueDays) }} days of other orders</span>.
          <a href="javascript:void 0" @click="showStages = !showStages">{{ showStages ? 'Hide' : 'Show' }} stage load</a> ·
          <a href="javascript:void 0" @click="go('schedule')">Factory schedule</a>
        </div>
        <div v-if="plan && plan.pushed.length" class="small" style="margin-top:6px;padding:6px 8px;background:#fee2e2;color:#991b1b;border-radius:6px">
          ⚠ With these due dates the batches go ahead of other orders and <b>{{ plan.pushed.length }} order(s) would finish after their due date</b>: {{ plan.pushed.join(', ') }}.
          Give later due dates, or agree the priority with the Factory Manager.
        </div>
        <div v-if="plan && showStages" class="tbl-wrap" style="margin-top:6px"><table class="t">
          <thead><tr><th>Seq</th><th>Stage / work centre</th><th class="n">Machines / people</th><th class="n">Operators per machine</th><th class="n">Capacity h/day</th><th class="n">Machine h / unit</th><th class="n">Man-h / unit</th><th class="n">Setup h / batch</th><th class="n">Wait after (days)</th><th class="n">Days (these batches)</th><th class="n">Other open orders (days)</th></tr></thead>
          <tbody><tr v-for="s in plan.stages" :key="s.seq + s.work_center_id">
            <td>{{ s.seq }}</td><td>{{ s.wc?.name }}</td><td class="n">{{ s.wc?.crew_size || 1 }}</td><td class="n">{{ s.wc?.kind === 'MACHINE' ? (s.wc?.operators || 1) : '' }}</td><td class="n">{{ qty(s.cap) }}</td>
            <td class="n">{{ qty(s.std_machine_hours) }}</td><td class="n">{{ qty(s.std_labour_hours) }}</td><td class="n">{{ qty(s.setup_hours) }}</td><td class="n">{{ qty(s.wait_days) }}</td><td class="n">{{ d1(s.days) }}</td><td class="n">{{ d1(s.queueDays) }}</td>
          </tr></tbody>
        </table></div>
        <div style="margin-top:10px"><button class="btn primary" :disabled="busy || !batchTotal" @click="create">🏭 Create production orders → Factory Manager</button></div>
      </div>
      <div class="card">
        <div class="hd"><h3>Production orders for this product</h3><span class="spacer" style="flex:1"></span>
          <button v-if="hasRole('factory_manager') && lineOrders.some(o => o.status === 'PENDING_FM')" class="btn sm ok" :disabled="busy" @click="fmAll">✔ Approve all waiting (FM)</button>
          <button v-if="canPlan && lineOrders.some(o => o.status === 'APPROVED')" class="btn sm primary" :disabled="busy" @click="releaseAll">🚀 Release all approved</button>
        </div>
        <div class="tbl-wrap"><table class="t">
          <thead><tr><th>Order</th><th>Batch</th><th class="n">Qty</th><th class="n">To FG</th><th>Due</th><th>Status</th><th>FM comments</th></tr></thead>
          <tbody>
            <tr v-if="!lineOrders.length"><td colspan="7" class="empty">No production orders yet</td></tr>
            <tr v-for="o in lineOrders" :key="o.id" style="cursor:pointer" @click="go('d/wo/' + o.id)">
              <td><a href="javascript:void 0"><b>{{ o.wo_no }}</b></a></td><td>{{ o.batch_label || '' }}</td>
              <td class="n">{{ qty(o.qty) }}</td><td class="n">{{ qty(o.qty_completed) }}</td><td>{{ dt(o.due_date) }}</td>
              <td><Badge :v="o.status" /></td><td class="small">{{ o.fm_comments || '' }}</td>
            </tr>
          </tbody>
        </table></div>
      </div>
    </template>
    <div v-else class="card empty">This BOQ line is not a made in-house product of an open project.</div>
  </div>`,
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
