// User-defined KPI cards: a user picks a measure from this catalogue, a period, an optional project and a goal.
// Measures are fixed queries (no free SQL); each belongs to dashboards — a user can only use measures of the
// dashboards granted to them, and money measures only when they may see costs. Row-level security still applies.
import { sb, must, canSeeCost, today, num } from './lib.js';

export const PERIODS = [
  { v: 'today', l: 'Today' }, { v: 'week', l: 'This week' }, { v: 'month', l: 'This month' }, { v: 'quarter', l: 'This quarter' },
  { v: 'year', l: 'This year' }, { v: 'd30', l: 'Last 30 days' }, { v: 'all', l: 'All time' },
];
const iso = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
// [from, to] of the period and of the period before it (for the comparison)
export function range(p, prev = false) {
  const t = new Date(today() + 'T00:00:00'), y = t.getFullYear(), m = t.getMonth();
  let a, b = t;
  if (p === 'today') a = t;
  else if (p === 'week') { a = new Date(t); a.setDate(t.getDate() - ((t.getDay() + 6) % 7)); }
  else if (p === 'month') a = new Date(y, m, 1);
  else if (p === 'quarter') a = new Date(y, m - (m % 3), 1);
  else if (p === 'year') a = new Date(y, 0, 1);
  else if (p === 'd30') { a = new Date(t); a.setDate(t.getDate() - 29); }
  else return null;
  if (prev) {
    if (['month', 'quarter', 'year'].includes(p)) {
      const n = p === 'month' ? 1 : p === 'quarter' ? 3 : 12;
      const pa = new Date(a.getFullYear(), a.getMonth() - n, 1), pb = new Date(pa.getFullYear(), pa.getMonth(), pa.getDate() + (b - a) / 864e5);
      return [iso(pa), iso(pb)];   // same number of days into the previous period
    }
    if (p === 'week') { const pa = new Date(a), pb = new Date(b); pa.setDate(a.getDate() - 7); pb.setDate(b.getDate() - 7); return [iso(pa), iso(pb)]; }   // same weekdays last week
    const len = Math.round((b - a) / 864e5) + 1, pb = new Date(a); pb.setDate(a.getDate() - 1);
    const pa = new Date(pb); pa.setDate(pb.getDate() - len + 1);
    return [iso(pa), iso(pb)];
  }
  return [iso(a), iso(b)];
}

// query helpers: c = { from, to, project }
const cnt = async q => { const { count, error } = await q; if (error) throw error; return count || 0; };
const head = t => sb.from(t).select('id', { count: 'exact', head: true });
const total = async (q, col, f = v => v) => must(await q.limit(20000)).reduce((s, r) => s + num(f(r[col], r)), 0);
const per = (q, col, c) => c.from ? q.gte(col, c.from).lte(col, c.to) : q;
const perTs = (q, col, c) => c.from ? q.gte(col, c.from + 'T00:00:00').lte(col, c.to + 'T23:59:59') : q;
const proj = (q, c, col = 'project_id') => c.project ? q.eq(col, c.project) : q;

// dash: dashboards whose users may use the measure; period / project: which options apply
export const METRICS = {
  // stores & purchasing
  stock_value:   { l: 'Inventory value (stock)', g: 'Stores', dash: ['stores', 'management', 'finance'], fmt: 'money', cost: true,
    run: () => total(sb.from('v_item_stock').select('stock_value'), 'stock_value') },
  stock_outs:    { l: 'Items out of stock', g: 'Stores', dash: ['stores', 'purchase', 'management'], fmt: 'count',
    run: () => cnt(sb.from('v_item_stock').select('item_id', { count: 'exact', head: true }).eq('stock_status', 'STOCK_OUT').eq('is_active', true)) },
  red_buffers:   { l: 'Items in red buffer', g: 'Stores', dash: ['stores', 'purchase', 'management'], fmt: 'count',
    run: () => cnt(sb.from('v_item_stock').select('item_id', { count: 'exact', head: true }).in('buffer_zone', ['RED', 'BLACK']).eq('is_active', true)) },
  to_order:      { l: 'Items to order', g: 'Purchase', dash: ['purchase', 'stores', 'management'], fmt: 'count',
    run: () => cnt(sb.from('v_item_stock').select('item_id', { count: 'exact', head: true }).gt('suggested_order_qty', 0).eq('is_active', true)) },
  offcut_value:  { l: 'Offcut stock (value)', g: 'Stores', dash: ['stores', 'production', 'management', 'finance'], fmt: 'money', cost: true,
    run: () => total(sb.from('v_offcuts').select('value').eq('lot_status', 'AVAILABLE'), 'value') },
  offcut_pieces: { l: 'Offcut pieces in stock', g: 'Stores', dash: ['stores', 'production', 'management'], fmt: 'count',
    run: () => cnt(sb.from('v_offcuts').select('lot_id', { count: 'exact', head: true }).eq('lot_status', 'AVAILABLE')) },
  grns:          { l: 'Goods receipts posted', g: 'Stores', dash: ['stores', 'purchase', 'management'], fmt: 'count', period: true, project: true,
    run: c => cnt(proj(per(head('grns').eq('status', 'POSTED'), 'grn_date', c), c)) },
  issues_value:  { l: 'Material issued (value)', g: 'Stores', dash: ['stores', 'management', 'finance'], fmt: 'money', cost: true, period: true, project: true,
    run: c => total(proj(per(sb.from('material_issues').select('total_value').eq('status', 'POSTED'), 'issue_date', c), c), 'total_value') },
  po_value:      { l: 'Purchase orders raised (value)', g: 'Purchase', dash: ['purchase', 'management', 'finance'], fmt: 'money', cost: true, period: true, project: true,
    run: c => total(proj(per(sb.from('purchase_orders').select('total_aed').not('status', 'in', '(DRAFT,CANCELLED,REJECTED)'), 'po_date', c), c), 'total_aed') },
  po_open:       { l: 'Open purchase orders', g: 'Purchase', dash: ['purchase', 'management'], fmt: 'count', project: true,
    run: c => cnt(proj(head('purchase_orders').not('status', 'in', '(CLOSED,CANCELLED,RECEIVED,REJECTED,DRAFT)'), c)) },
  po_late:       { l: 'Late PO deliveries', g: 'Purchase', dash: ['purchase', 'management'], fmt: 'count', project: true, lowerBetter: true,
    run: c => cnt(proj(head('purchase_orders').in('status', ['RELEASED', 'PARTIALLY_RECEIVED']).lt('delivery_date', today()), c)) },
  // production
  wo_open:       { l: 'Open production orders', g: 'Production', dash: ['production', 'management'], fmt: 'count', project: true,
    run: c => cnt(proj(head('production_orders').in('status', ['RELEASED', 'IN_PROGRESS']), c)) },
  wo_late:       { l: 'Late production orders', g: 'Production', dash: ['production', 'management'], fmt: 'count', project: true, lowerBetter: true,
    run: c => cnt(proj(head('production_orders').in('status', ['RELEASED', 'IN_PROGRESS']).lt('due_date', today()), c)) },
  wo_done:       { l: 'Production orders completed', g: 'Production', dash: ['production', 'management'], fmt: 'count', period: true, project: true,
    run: c => cnt(proj(perTs(head('production_orders').eq('status', 'COMPLETED'), 'completed_at', c), c)) },
  fg_value:      { l: 'Finished goods produced (value)', g: 'Production', dash: ['production', 'management', 'finance'], fmt: 'money', cost: true, period: true,
    run: c => total(per(sb.from('wo_receipts').select('value').in('qc_status', ['NONE', 'APPROVED']), 'receipt_date', c), 'value') },
  downtime:      { l: 'Machine downtime (hours)', g: 'Production', dash: ['production', 'management'], fmt: 'hours', period: true, lowerBetter: true,
    run: c => total(perTs(sb.from('v_downtime_summary').select('hours'), 'start_at', c), 'hours') },
  // projects & site
  snags_open:    { l: 'Open snags', g: 'Projects', dash: ['production', 'management', 'site'], fmt: 'count', project: true, lowerBetter: true,
    run: c => cnt(proj(head('snags').in('status', ['OPEN', 'FIXED']), c)) },
  snags_late:    { l: 'Overdue snags', g: 'Projects', dash: ['production', 'management', 'site'], fmt: 'count', project: true, lowerBetter: true,
    run: c => cnt(proj(head('snags').in('status', ['OPEN', 'FIXED']).lt('due_date', today()), c)) },
  units_handed:  { l: 'Units handed over', g: 'Projects', dash: ['production', 'management', 'site'], fmt: 'count', period: true, project: true,
    run: c => cnt(proj(per(head('project_units').eq('status', 'HANDED_OVER'), 'handed_over_at', c), c)) },
  deliveries:    { l: 'Deliveries to site', g: 'Projects', dash: ['stores', 'production', 'management', 'site'], fmt: 'count', period: true, project: true,
    run: c => cnt(proj(per(head('dispatch_notes').in('status', ['POSTED', 'DELIVERED']), 'dispatch_date', c), c)) },
  vo_pending:    { l: 'Variation orders awaiting approval', g: 'Projects', dash: ['management', 'production', 'finance'], fmt: 'count', project: true,
    run: c => cnt(proj(head('variation_orders').eq('status', 'SUBMITTED'), c)) },
  vo_value:      { l: 'Approved variations (value)', g: 'Projects', dash: ['management', 'finance'], fmt: 'money', cost: true, period: true, project: true,
    run: c => total(proj(perTs(sb.from('variation_orders').select('value_change').eq('status', 'APPROVED'), 'approved_at', c), c), 'value_change') },
  // finance
  revenue:       { l: 'Revenue invoiced (excl. VAT)', g: 'Finance', dash: ['finance', 'management'], fmt: 'money', cost: true, period: true, project: true,
    run: c => total(proj(per(sb.from('sales_invoices').select('taxable_amount,advance_recovery,inv_type').eq('status', 'POSTED').not('inv_type', 'in', '(ADVANCE,RETENTION_RELEASE)'), 'invoice_date', c), c),
      'taxable_amount', (v, r) => r.inv_type === 'CREDIT_NOTE' ? -num(v) : num(v) + num(r.advance_recovery)) },
  collections:   { l: 'Customer receipts', g: 'Finance', dash: ['finance', 'management'], fmt: 'money', cost: true, period: true, project: true,
    run: c => total(proj(per(sb.from('customer_receipts').select('amount').in('status', ['POSTED', 'CLEARED']), 'receipt_date', c), c), 'amount') },
  receivables:   { l: 'Receivables outstanding', g: 'Finance', dash: ['finance', 'management'], fmt: 'money', cost: true, project: true,
    run: c => total(proj(sb.from('v_sales_invoice_balance').select('balance'), c), 'balance') },
  receivables_overdue: { l: 'Receivables overdue', g: 'Finance', dash: ['finance', 'management'], fmt: 'money', cost: true, project: true, lowerBetter: true,
    run: c => total(proj(sb.from('v_sales_invoice_balance').select('balance').gt('days_overdue', 0), c), 'balance') },
  payables:      { l: 'Net payables', g: 'Finance', dash: ['finance', 'management', 'purchase'], fmt: 'money', cost: true,
    run: () => total(sb.from('v_vendor_payables').select('net_payable_aed'), 'net_payable_aed') },
  payments:      { l: 'Supplier payments', g: 'Finance', dash: ['finance', 'management'], fmt: 'money', cost: true, period: true,
    run: c => total(per(sb.from('vendor_payments').select('amount_aed').eq('status', 'POSTED'), 'payment_date', c), 'amount_aed') },
  claims_pending:{ l: 'Claims awaiting payment certificate', g: 'Finance', dash: ['finance', 'management'], fmt: 'count', project: true, lowerBetter: true,
    run: c => cnt(proj(head('sales_invoices').eq('status', 'SUBMITTED'), c)) },
  // HR
  headcount:     { l: 'Active employees', g: 'HR', dash: ['hr', 'management'], fmt: 'count',
    run: () => cnt(head('employees').eq('is_active', true)) },
  present:       { l: 'Present today', g: 'HR', dash: ['hr', 'management', 'production', 'site'], fmt: 'count',
    run: () => cnt(head('attendance').eq('att_date', today()).in('status', ['PRESENT', 'HALF_DAY'])) },
  absent:        { l: 'Absent today', g: 'HR', dash: ['hr', 'management', 'production', 'site'], fmt: 'count', lowerBetter: true,
    run: () => cnt(head('attendance').eq('att_date', today()).eq('status', 'ABSENT')) },
  overtime:      { l: 'Overtime hours', g: 'HR', dash: ['hr', 'management', 'production'], fmt: 'hours', period: true, project: true, lowerBetter: true,
    run: c => total(proj(per(sb.from('attendance').select('ot_hours,ot_hours_holiday'), 'att_date', c), c), 'ot_hours', (v, r) => num(v) + num(r.ot_hours_holiday)) },
  leave_pending: { l: 'Leave requests pending', g: 'HR', dash: ['hr', 'management'], fmt: 'count', lowerBetter: true,
    run: () => cnt(head('leave_requests').eq('status', 'PENDING')) },
  docs_expiring: { l: 'Employee documents expiring in 30 days', g: 'HR', dash: ['hr'], fmt: 'count', lowerBetter: true,
    run: () => cnt(sb.from('v_document_expiry').select('id', { count: 'exact', head: true }).lte('days_left', 30)) },
};

// measures this user may put on a card
export function userMetrics(dashKeys) {
  return Object.entries(METRICS).filter(([, m]) => m.dash.some(d => dashKeys.includes(d)) && !(m.cost && !canSeeCost()))
    .map(([v, m]) => ({ v, l: `${m.g} — ${m.l}` }));
}

// value now and for the previous period (null when the measure has no period)
export async function computeKpi(card) {
  const m = METRICS[card.metric];
  if (!m) throw new Error('Measure no longer available');
  const r = m.period ? range(card.period || 'month') : null;
  const v = await m.run({ from: r?.[0], to: r?.[1], project: m.project ? card.project_id || null : null });
  let prev = null;
  if (m.period && card.period !== 'all') { const p = range(card.period || 'month', true); prev = await m.run({ from: p[0], to: p[1], project: m.project ? card.project_id || null : null }); }
  return { v, prev };
}
