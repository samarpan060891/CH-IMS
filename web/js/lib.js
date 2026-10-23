// Core: Supabase client, global state, reference-data cache, formatting helpers
import { reactive } from 'vue';
import { createClient } from '@supabase/supabase-js';
import { CONFIG } from './config.js';

export const sb = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export const state = reactive({
  session: null,
  profile: null,
  company: null,
  refs: {},
  toasts: [],
  pending: {},       // approval counters for the menu
  notifs: [],        // latest in-app notifications for this user / role
});

export const ROLES = {
  admin: 'Administrator',
  purchase: 'Purchase',
  stores: 'Stores',
  shop_floor: 'Shop Floor',
  production_incharge: 'Production In-charge',
  site_supervisor: 'Site Supervisor',
  hr_officer: 'HR Officer',
  factory_manager: 'Factory Manager',
  finance: 'Finance Manager',
  sales: 'Sales',
};

export const role = () => state.profile?.role;
export function hasRole(...roles) {
  const r = role();
  return !!r && (r === 'admin' || roles.includes(r));
}
// Shop floor, production, site and HR see inventory / project quantities only (salaries are protected separately)
export const canSeeCost = () => !['shop_floor', 'production_incharge', 'site_supervisor', 'hr_officer'].includes(role());

// ---------- notifications ----------
let toastId = 0;
export function toast(msg, type = 'info', ms = 4500) {
  const id = ++toastId;
  state.toasts.push({ id, msg, type });
  setTimeout(() => { const i = state.toasts.findIndex(t => t.id === id); if (i >= 0) state.toasts.splice(i, 1); }, ms);
}
export function errMsg(e) {
  if (!e) return 'Unknown error';
  return e.message || e.error_description || e.details || String(e);
}
// run an async action, report failures as toasts, return result or undefined
export async function run(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg && r !== false) toast(okMsg, 'ok');   // false = the user cancelled a dialog
    return r ?? true;
  } catch (e) {
    console.error(e);
    toast(errMsg(e), 'error', 8000);
    return undefined;
  }
}
// throw on supabase error
export function must({ data, error }) {
  if (error) throw error;
  return data;
}
export async function rpc(name, args) {
  return must(await sb.rpc(name, args));
}

// ---------- reference data ----------
export const REF = {
  items: {
    table: 'items', order: 'code',
    select: 'id,code,name,class_id,category_id,uom_id,vat_rate,is_active,avg_cost,last_purchase_rate,standard_cost,moq,has_expiry,shelf_life_days,batch_controlled,calibration_interval_days,length_mm,width_mm,thickness_mm,default_location_id,dim_tracking,item_classes(code,name,tracking,is_returnable,is_scrap,cost_centre_issue),uoms(code)',
    label: r => `${r.code} — ${r.name}`,
  },
  vendors: { table: 'vendors', order: 'name', select: 'id,code,name,currency,payment_term_id,vendor_type,status,trn,vat_registered,address,emirate,country,contact_person', label: r => `${r.name} (${r.code})` },
  locations: { table: 'locations', order: 'code', select: 'id,code,name,loc_type,is_stock,is_active,parent_id', label: r => `${r.code} — ${r.name}` },
  projects: { table: 'projects', order: 'code', select: 'id,code,name,project_type,status,customer,customer_id,cost_center_id,sales_order_id', label: r => `${r.code} — ${r.name}` },
  customers: { table: 'customers', order: 'name', select: 'id,code,name,trn,address,emirate,country,contact_person,payment_term_id,status', label: r => `${r.name} (${r.code})` },
  gl_accounts: { table: 'gl_accounts', order: 'code', select: 'id,code,name,acc_type,is_group,system_key,is_bank,is_active,parent_id', label: r => `${r.code} — ${r.name}` },
  cost_centers: { table: 'cost_centers', order: 'code', select: 'id,code,name,is_active', label: r => `${r.code} — ${r.name}` },
  employees: { table: 'employees', order: 'name', select: 'id,emp_code,name,department,is_active', label: r => `${r.name} (${r.emp_code})` },
  uoms: { table: 'uoms', order: 'code', select: 'id,code,name,decimals', label: r => r.code },
  item_classes: { table: 'item_classes', order: 'sort_order', select: '*', label: r => `${r.code} — ${r.name}` },
  item_categories: { table: 'item_categories', order: 'code', select: 'id,code,name,class_id,parent_id,is_active',
    label: r => { const p = r.parent_id && refRow('item_categories', r.parent_id); return p ? `${p.name} › ${r.name}` : `${r.code} — ${r.name}`; } },
  payment_terms: { table: 'payment_terms', order: 'code', select: 'id,code,name,credit_days,basis,advance_pct', label: r => r.name },
  profiles: { table: 'profiles', order: 'full_name', select: 'id,full_name,email,role', label: r => r.full_name || r.email },
  work_centers: { table: 'work_centers', order: 'sort_order', select: 'id,code,name,kind,machine_rate_per_hour,labour_rate_per_hour,default_grade_id,sort_order,is_active', label: r => `${r.code} — ${r.name}` },
  boq_lines: { table: 'boq_lines', order: 'line_no', select: 'id,project_id,line_no,boq_ref,description,category,item_id,qty,uom', label: r => `${r.boq_ref || r.line_no} — ${r.description}` },
  labour_grades: { table: 'labour_grades', order: 'sort_order', select: 'id,code,name,rate_per_hour,ot_rate_per_hour,is_active', label: r => r.name },
  bom_templates: { table: 'bom_templates', order: 'name', select: 'id,item_id,name,version,is_active', label: r => `${r.name} (v${r.version})` },
  sales_orders: { table: 'sales_orders', order: 'so_no', select: 'id,so_no,so_type,title,customer_id,cost_center_id,project_id,status,delivery_date', label: r => `${r.so_no} — ${r.title}` },
  lookups: { table: 'lookup_values', order: 'sort_order', select: 'id,list_key,value,sort_order,is_active', label: r => r.value },
  assets: { table: 'assets', order: 'asset_tag', select: 'id,asset_tag,status,cost_center_id,work_center_id,items(name)', label: r => `${r.asset_tag} — ${r.items?.name || ''}` },
};

// No typed-in parameters: a missing supplier, account, list value… is requested from the people who keep that master
// (same roles as master_owner_roles in the database). `to` is where an owner adds it.
export const MASTER_REQ = {
  vendors: { kind: 'VENDOR', noun: 'supplier', owners: ['purchase', 'finance'], to: 'm/vendors' },
  customers: { kind: 'CUSTOMER', noun: 'customer', owners: ['sales', 'finance', 'factory_manager'], to: 'm/customers' },
  gl_accounts: { kind: 'GL_ACCOUNT', noun: 'account / cost head', owners: ['finance'], to: 'm/gl_accounts' },
  cost_centers: { kind: 'COST_CENTER', noun: 'cost centre', owners: ['finance', 'factory_manager'], to: 'm/cost_centers' },
  items: { kind: 'ITEM', noun: 'item', owners: ['stores', 'purchase'], to: 'm/items' },
  uoms: { kind: 'UOM', noun: 'unit of measure', owners: ['stores', 'purchase'], to: 'm/uoms' },
  projects: { kind: 'PROJECT', noun: 'project', owners: ['factory_manager', 'finance'], to: 'm/projects' },
  employees: { kind: 'EMPLOYEE', noun: 'employee', owners: ['hr_officer', 'factory_manager'], to: () => hasRole('hr_officer') ? 'd/emp/new' : 'm/employees' },
  work_centers: { kind: 'WORK_CENTER', noun: 'work centre', owners: ['factory_manager', 'finance'], to: 'm/work_centers' },
};
export const LOOKUP_LISTS = {
  DEPARTMENT: { noun: 'department', owners: ['hr_officer'] },
  DESIGNATION: { noun: 'designation', owners: ['hr_officer'] },
  NATIONALITY: { noun: 'nationality', owners: ['hr_officer'] },
  ACCOMMODATION: { noun: 'accommodation', owners: ['hr_officer'] },
  BANK: { noun: 'bank', owners: ['finance'] },
  BRAND: { noun: 'brand', owners: ['stores', 'purchase'] },
  UNIT_TYPE: { noun: 'unit type', owners: ['factory_manager'] },
  ROOM: { noun: 'room / area', owners: ['factory_manager', 'production_incharge'] },
  FACILITY_AREA: { noun: 'building / facility area', owners: ['factory_manager', 'production_incharge'] },
};
export const REQ_KIND = Object.fromEntries([...Object.entries(MASTER_REQ).map(([ref, m]) => [m.kind, { ...m, ref }]), ['LOOKUP', { kind: 'LOOKUP', noun: 'list value' }]]);
export const reqOwners = (kind, list) => kind === 'LOOKUP' ? LOOKUP_LISTS[list]?.owners || [] : REQ_KIND[kind]?.owners || [];
export const reqRoute = kind => { const t = REQ_KIND[kind]?.to; return typeof t === 'function' ? t() : t; };
export const reqNoun =(kind, list) => kind === 'LOOKUP' ? LOOKUP_LISTS[list]?.noun || 'list value' : REQ_KIND[kind]?.noun || kind;

// Usable stock by item for a material request: free stock, stock reserved for this project / order, and stock reserved for
// other projects (shown, not usable). Offcuts, quarantine and scrap-yard stock are left out.
export async function stockSplit(itemIds, projectId = null) {
  const out = {};
  if (!itemIds.length) return out;
  const rows = must(await sb.from('v_lot_values').select('item_id,qty_on_hand,lot_status,loc_type,project_id,is_offcut').in('item_id', itemIds).gt('qty_on_hand', 0));
  rows.forEach(r => {
    if (r.lot_status !== 'AVAILABLE' || ['QUARANTINE', 'SCRAP_YARD'].includes(r.loc_type) || r.is_offcut) return;
    const o = out[r.item_id] ||= { free: 0, mine: 0, reserved: 0 };
    const q = Number(r.qty_on_hand);
    if (!r.project_id) o.free += q; else if (r.project_id === projectId) o.mine += q; else o.reserved += q;
  });
  return out;
}

export async function loadRef(name, force = false) {
  if (state.refs[name] && !force) return state.refs[name];
  const d = REF[name];
  const rows = must(await sb.from(d.table).select(d.select).order(d.order).limit(10000));
  state.refs[name] = rows;
  return rows;
}
export async function loadRefs(names, force = false) {
  await Promise.all(names.map(n => loadRef(n, force)));
}
export function refRow(name, id) {
  return (state.refs[name] || []).find(r => r.id === id);
}
export function refLabel(name, id) {
  if (!id) return '';
  const r = refRow(name, id);
  return r ? REF[name].label(r) : '…';
}

// ---------- formatting ----------
const nf2 = new Intl.NumberFormat('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfq = new Intl.NumberFormat('en-AE', { maximumFractionDigits: 3 });
export const money = v => (v === null || v === undefined || v === '') ? '' : nf2.format(Number(v));
export const qty = v => (v === null || v === undefined || v === '') ? '' : nfq.format(Number(v));
export const aed = v => (v === null || v === undefined) ? '' : 'AED ' + nf2.format(Number(v));
export function dt(v) {
  if (!v) return '';
  const d = new Date(v.length === 10 ? v + 'T00:00:00' : v);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
export function dtm(v) {
  if (!v) return '';
  return new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export const today = () => new Date().toISOString().slice(0, 10);
export const label = s => (s || '').toString().replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
export const num = v => (v === '' || v === null || v === undefined || isNaN(Number(v))) ? 0 : Number(v);

// ---------- CSV export ----------
export function downloadCSV(filename, columns, rows) {
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [columns.map(c => esc(c.label)).join(',')];
  for (const r of rows) lines.push(columns.map(c => esc(c.raw ? c.raw(r) : (typeof c.k === 'function' ? c.k(r) : r[c.k]))).join(','));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- router ----------
export const route = reactive({ path: '', parts: [] });
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '') || 'dashboard';
  route.path = h;
  route.parts = h.split('/');
}
window.addEventListener('hashchange', parseHash);
parseHash();
export const go = p => { location.hash = '#/' + p; };

// ---------- company ----------
export async function loadCompany() {
  state.company = must(await sb.from('company_settings').select('*').eq('id', 1).single());
}

// ---------- approval counters ----------
export async function refreshPending() {
  const r = role();
  const count = async (table, filter) => {
    let q = sb.from(table).select('id', { count: 'exact', head: true });
    q = filter(q);
    const { count: c } = await q;
    return c || 0;
  };
  const p = {};
  if (hasRole('factory_manager')) {
    p.po = await count('purchase_orders', q => q.eq('status', 'PENDING_FM'));
    p.adj = await count('stock_adjustments', q => q.eq('status', 'PENDING_APPROVAL'));
    p.scrap = await count('scrap_notes', q => q.eq('status', 'PENDING_APPROVAL'));
    p.disposal = await count('scrap_disposals', q => q.eq('status', 'PENDING_APPROVAL'));
    p.rel = await count('stock_releases', q => q.eq('status', 'PENDING_APPROVAL'));
  }
  if (hasRole('finance')) {
    p.po = (p.po || 0) + await count('purchase_orders', q => q.eq('status', 'PENDING_FINANCE'));
    p.disposal = (p.disposal || 0) + await count('scrap_disposals', q => q.eq('status', 'PENDING_FINANCE'));
    p.rel = (p.rel || 0) + await count('stock_releases', q => q.eq('status', 'PENDING_FINANCE'));
  }
  if (hasRole('purchase')) p.po = (p.po || 0) + await count('purchase_orders', q => q.in('status', ['PENDING_TOP_MGMT', 'APPROVED']));
  if (hasRole('purchase', 'factory_manager')) p.dbm = await count('buffer_suggestions', q => q.eq('status', 'PENDING'));
  if (hasRole('purchase')) p.prOpen = await count('purchase_requisitions', q => q.in('status', ['SUBMITTED', 'PARTIAL_PO']));
  if (hasRole('production_incharge')) p.mr = await count('material_requests', q => q.eq('status', 'PENDING_APPROVAL'));
  if (hasRole('stores')) p.issue = await count('material_requests', q => q.in('status', ['APPROVED', 'PARTIALLY_ISSUED']));
  if (hasRole('stores', 'purchase')) p.holds = await count('stock_lots', q => q.eq('status', 'HOLD').gt('qty_on_hand', 0).not('hold_reason', 'is', null));
  if (hasRole('stores')) p.ret = await count('material_returns', q => q.eq('status', 'SUBMITTED'));
  // offcut keep / scrap: In-charge proposes, Factory Manager approves
  if (hasRole('production_incharge')) p.ret = (p.ret || 0) + await count('material_returns', q => q.eq('status', 'PENDING_PI'));
  if (hasRole('factory_manager')) p.ret = (p.ret || 0) + await count('material_returns', q => q.eq('status', 'PENDING_FM'));
  if (hasRole('shop_floor', 'production_incharge', 'site_supervisor')) p.ack = await count('material_issues', q => q.eq('status', 'POSTED').eq('ack_status', 'PENDING'));
  if (hasRole('stores', 'factory_manager')) p.ack = (p.ack || 0) + await count('material_issues', q => q.eq('ack_status', 'DISCREPANCY'));
  if (hasRole('production_incharge', 'factory_manager')) p.wo = await count('production_orders', q => q.eq('status', 'DRAFT'));
  if (hasRole('shop_floor', 'production_incharge', 'factory_manager', 'stores')) p.pm = await count('pm_jobs', q => q.in('status', ['OPEN', 'IN_PROGRESS']).lte('due_date', today()));
  if (hasRole('shop_floor', 'production_incharge')) p.stages =await count('wo_operations', q => q.eq('status', 'IN_PROGRESS'));
  if (hasRole('stores')) p.dsp = await count('dispatch_notes', q => q.eq('status', 'DRAFT'));
  if (hasRole('factory_manager')) p.qc = await count('wo_receipts', q => q.eq('qc_status', 'PENDING_FM'));
  if (hasRole('factory_manager')) p.vo = await count('variation_orders', q => q.eq('status', 'SUBMITTED'));
  if (hasRole('site_supervisor')) p.snag = await count('snags', q => q.eq('status', 'OPEN'));
  if (hasRole('hr_officer', 'factory_manager')) p.leave = await count('leave_requests', q => q.eq('status', 'PENDING'));
  if (hasRole('finance')) p.adv = await count('employee_advances', q => q.eq('status', 'DRAFT'));
  if (hasRole('finance')) {
    p.payroll = await count('payroll_runs', q => q.eq('status', 'SUBMITTED'));
    // claims waiting for the client's payment certificate; cheques / PDCs due to bank
    p.siCert = await count('sales_invoices', q => q.eq('status', 'SUBMITTED'));
    p.pdc = await count('customer_receipts', q => q.eq('status', 'POSTED').in('mode', ['CHEQUE', 'PDC']).lte('cheque_date', today()));
  }
  if (hasRole('hr_officer')) p.payroll = (p.payroll || 0) + await count('payroll_runs', q => q.eq('status', 'APPROVED'));
  // expenses: FM approves above the limit; Finance posts and reimburses claims
  if (hasRole('factory_manager')) p.exp = await count('expenses', q => q.eq('status', 'PENDING_FM'));
  if (hasRole('finance')) p.exp = (p.exp || 0) + await count('expenses', q => q.or('status.eq.APPROVED,and(status.eq.POSTED,exp_type.eq.CLAIM)'));
  if (hasRole('production_incharge', 'factory_manager')) p.snagVerify = await count('snags', q => q.eq('status', 'FIXED'));
  if (hasRole('site_supervisor') && !hasRole('stores')) p.dsp = await count('dispatch_notes', q => q.eq('status', 'POSTED'));
  if (hasRole('factory_manager', 'production_incharge', 'shop_floor')) p.down = await count('wc_downtime', q => q.eq('status', 'OPEN'));
  // internal orders waiting for the Factory Manager
  if (hasRole('factory_manager')) p.so = await count('sales_orders', q => q.eq('status', 'PENDING_FM'));
  // requests for new suppliers, accounts, list values… that this user's role keeps (they only see those, plus their own)
  if (r !== 'shop_floor' && r !== 'site_supervisor') p.mdr = await count('master_requests', q => q.eq('status', 'PENDING').neq('requested_by', state.profile.id));
  state.pending = p;
  try { await loadNotifications(); } catch (e) { console.warn('notifications', e); }
}

// ---------- in-app notifications ----------
export async function loadNotifications() {
  const rows = must(await sb.from('notifications').select('*').order('created_at', { ascending: false }).limit(40));
  const reads = rows.length ? must(await sb.from('notification_reads').select('notification_id').in('notification_id', rows.map(r => r.id))) : [];
  const read = new Set(reads.map(r => r.notification_id));
  rows.forEach(r => { r.read = read.has(r.id); });
  state.notifs = rows;
}
export async function markRead(ids) {
  const todo = ids.filter(id => !state.notifs.find(n => n.id === id)?.read);
  if (!todo.length) return;
  must(await sb.from('notification_reads').upsert(todo.map(id => ({ notification_id: id })), { onConflict: 'notification_id,user_id', ignoreDuplicates: true }));
  state.notifs.forEach(n => { if (todo.includes(n.id)) n.read = true; });
}
