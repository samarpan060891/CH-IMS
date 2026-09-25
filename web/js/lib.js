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
  factory_manager: 'Factory Manager',
  finance: 'Finance Manager',
};

export const role = () => state.profile?.role;
export function hasRole(...roles) {
  const r = role();
  return !!r && (r === 'admin' || roles.includes(r));
}
// Shop floor & production see quantities only
export const canSeeCost = () => !['shop_floor', 'production_incharge'].includes(role());

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
    if (okMsg) toast(okMsg, 'ok');
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
    select: 'id,code,name,class_id,category_id,uom_id,vat_rate,is_active,avg_cost,last_purchase_rate,standard_cost,moq,has_expiry,batch_controlled,calibration_interval_days,item_classes(code,name,tracking,is_returnable,is_scrap),uoms(code)',
    label: r => `${r.code} — ${r.name}`,
  },
  vendors: { table: 'vendors', order: 'name', select: 'id,code,name,currency,payment_term_id,vendor_type,status,trn,vat_registered', label: r => `${r.name} (${r.code})` },
  locations: { table: 'locations', order: 'code', select: 'id,code,name,loc_type,is_stock,is_active,parent_id', label: r => `${r.code} — ${r.name}` },
  projects: { table: 'projects', order: 'code', select: 'id,code,name,project_type,status,customer', label: r => `${r.code} — ${r.name}` },
  cost_centers: { table: 'cost_centers', order: 'code', select: 'id,code,name,is_active', label: r => `${r.code} — ${r.name}` },
  employees: { table: 'employees', order: 'name', select: 'id,emp_code,name,department,is_active', label: r => `${r.name} (${r.emp_code})` },
  uoms: { table: 'uoms', order: 'code', select: 'id,code,name,decimals', label: r => r.code },
  item_classes: { table: 'item_classes', order: 'sort_order', select: '*', label: r => `${r.code} — ${r.name}` },
  item_categories: { table: 'item_categories', order: 'code', select: 'id,code,name,class_id,is_active', label: r => `${r.code} — ${r.name}` },
  payment_terms: { table: 'payment_terms', order: 'code', select: 'id,code,name,credit_days,basis,advance_pct', label: r => r.name },
  profiles: { table: 'profiles', order: 'full_name', select: 'id,full_name,email,role', label: r => r.full_name || r.email },
};

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
  }
  if (hasRole('purchase')) p.po = (p.po || 0) + await count('purchase_orders', q => q.in('status', ['PENDING_TOP_MGMT', 'APPROVED']));
  if (hasRole('purchase', 'factory_manager')) p.dbm = await count('buffer_suggestions', q => q.eq('status', 'PENDING'));
  if (hasRole('purchase')) p.prOpen = await count('purchase_requisitions', q => q.in('status', ['SUBMITTED', 'PARTIAL_PO']));
  if (hasRole('production_incharge')) p.mr = await count('material_requests', q => q.eq('status', 'PENDING_APPROVAL'));
  if (hasRole('stores')) p.issue = await count('material_requests', q => q.in('status', ['APPROVED', 'PARTIALLY_ISSUED']));
  if (hasRole('stores', 'purchase')) p.holds = await count('stock_lots', q => q.eq('status', 'HOLD').gt('qty_on_hand', 0).not('hold_reason', 'is', null));
  if (hasRole('stores')) p.ret = await count('material_returns', q => q.eq('status', 'SUBMITTED'));
  if (hasRole('shop_floor', 'production_incharge')) p.ack =await count('material_issues', q => q.eq('status', 'POSTED').eq('ack_status', 'PENDING'));
  if (hasRole('stores', 'factory_manager')) p.ack = (p.ack || 0) + await count('material_issues', q => q.eq('ack_status', 'DISCREPANCY'));
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
