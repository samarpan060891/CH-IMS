// Reports, replenishment, tool crib / assets, users, settings (dashboards are in dashboards.js)
import { sb, state, must, run, rpc, hasRole, canSeeCost, go, loadRefs, loadRef, refRow, refLabel, money, qty, aed, dt, label, num, today, toast, ROLES, loadCompany, refreshPending } from './lib.js';
import { DataTable, Modal, FieldInput, RefSelect, Badge, ask } from './components.js';
import { DASHBOARDS, userDashboards } from './dashboards.js';

const AGE_ORDER = ['0-30', '31-60', '61-90', '91-180', '181-365', '365+'];

// ======================================================================
// REPORTS
// ======================================================================
// stock-level (buffer) zone: Red / Yellow / Green against the buffer target — not a storage location
const Z = { k: 'buffer_zone', label: 'Buffer zone', fmt: 'badge' };
export const REPORTS = {
  stock: { title: 'Stock in hand', src: 'v_item_stock', filter: q => q.gt('on_hand', 0), columns: [
    { k: 'code', label: 'Code' }, { k: 'name', label: 'Item' }, { k: 'class_code', label: 'Class' }, { k: 'category_name', label: 'Category' }, { k: 'uom', label: 'UoM' },
    { k: 'on_hand', label: 'On hand', fmt: 'qty' }, { k: r => r._pcs, label: 'Pieces', fmt: 'qty' }, { k: 'available', label: 'Free stock', fmt: 'qty' }, { k: r => r._pcsFree, label: 'Free pcs', fmt: 'qty' },
    { k: 'reserved_qty', label: 'Reserved for projects', fmt: 'qty' }, { k: r => r._pcsRes, label: 'Reserved pcs', fmt: 'qty' },
    { k: 'on_order', label: 'On order (stock)', fmt: 'qty' }, { k: 'on_order_projects', label: 'On order (projects)', fmt: 'qty' }, { k: 'open_demand', label: 'Open requests', fmt: 'qty' },
    { k: 'stock_value', label: 'Value AED', fmt: 'money', cost: true, sum: true }, { k: 'avg_daily_consumption', label: 'Avg/day', fmt: 'qty' }, { k: 'stock_cover_days', label: 'Cover days', n: true },
    { k: 'last_receipt', label: 'Last receipt', fmt: 'date' }, { k: 'last_issue', label: 'Last issue', fmt: 'date' }, { k: 'stock_status', label: 'Status', fmt: 'badge' }, Z],
    // pieces in stock for items received in pieces (timber); batch-wise detail is in "Stock by lot & location"
    async after(rows) {
      const m = Object.fromEntries(must(await sb.from('v_item_pieces').select('item_id,pcs_on_hand,pcs_free,pcs_reserved')).map(x => [x.item_id, x]));
      rows.forEach(r => { const p = m[r.item_id]; r._pcs = p?.pcs_on_hand ?? null; r._pcsFree = p ? p.pcs_free : null; r._pcsRes = p ? p.pcs_reserved : null; });
    } },
  offcuts: { title: 'Offcut stock (panels & timber pieces)', src: 'v_offcuts', order: 'item_code', columns: [
    { k: 'item_code', label: 'Item' }, { k: 'item_name', label: 'Description' }, { k: 'kind', label: 'Type', fmt: 'label' }, { k: 'thickness_mm', label: 'Thk mm', n: true },
    { k: 'length_mm', label: 'Length mm', n: true }, { k: 'width_mm', label: 'Width mm', n: true }, { k: 'area_m2', label: 'Area m²', fmt: 'qty', sum: true },
    { k: 'qty_on_hand', label: 'Share of unit', fmt: 'qty' }, { k: 'uom', label: 'UoM' }, { k: 'lot_no', label: 'Piece' }, { k: 'location_code', label: 'Location' },
    { k: 'return_no', label: 'From return' }, { k: 'received_date', label: 'Returned', fmt: 'date' }, { k: 'age_days', label: 'Age days', n: true },
    { k: 'value', label: 'Value AED', fmt: 'money', cost: true, sum: true }] },
  reserved: { title: 'Reserved stock by project', src: 'v_project_reserved', order: 'project_code', columns: [
    { k: 'project_code', label: 'Project' }, { k: 'project_name', label: 'Name' }, { k: 'project_status', label: 'Status', fmt: 'badge' },
    { k: 'item_code', label: 'Item' }, { k: 'item_name', label: 'Description' }, { k: 'class_code', label: 'Class' }, { k: 'location_code', label: 'Location' }, { k: 'lot_no', label: 'Lot' },
    { k: 'received_date', label: 'Received', fmt: 'date' }, { k: 'age_days', label: 'Age days', n: true }, { k: 'qty_on_hand', label: 'Qty', fmt: 'qty' }, { k: 'uom', label: 'UoM' },
    { k: 'value', label: 'Value AED', fmt: 'money', cost: true, sum: true }] },
  lots: { title: 'Stock by lot & location', src: 'v_lot_values', order: 'item_code', columns: [
    { k: 'item_code', label: 'Code' }, { k: 'item_name', label: 'Item' }, { k: 'class_code', label: 'Class' }, { k: 'location_code', label: 'Location' }, { k: 'lot_no', label: 'Lot' }, { k: 'batch_no', label: 'Batch' },
    { k: r => r.project_id ? (refRow('projects', r.project_id)?.code || 'Project') : 'Free', label: 'Reserved for' },
    // timber batches: size (thickness × width × length) and pieces in stock, next to the CBM
    { k: 'size_text', label: 'Size / spec' }, { k: 'pcs_on_hand', label: 'Pieces', fmt: 'qty', sum: true },
    { k: 'received_date', label: 'Received', fmt: 'date' }, { k: 'expiry_date', label: 'Expiry', fmt: 'date' }, { k: 'qty_on_hand', label: 'Qty', fmt: 'qty' }, { k: 'uom', label: 'UoM' },
    { k: 'value_rate', label: 'Rate', fmt: 'money', cost: true }, { k: 'value', label: 'Value', fmt: 'money', cost: true, sum: true }, { k: 'age_days', label: 'Age (days)', n: true }, { k: 'lot_status', label: 'Status', fmt: 'badge' }] },
  stockout: { title: 'Stock-out & below safety', src: 'v_item_stock', filter: q => q.in('stock_status', ['STOCK_OUT', 'BELOW_SAFETY', 'REORDER']).eq('is_active', true), columns: [
    { k: 'code', label: 'Code' }, { k: 'name', label: 'Item' }, { k: 'class_code', label: 'Class' }, { k: 'uom', label: 'UoM' }, { k: 'available', label: 'Available', fmt: 'qty' }, { k: 'safety_stock', label: 'Safety', fmt: 'qty' },
    { k: 'reorder_level', label: 'ROL', fmt: 'qty' }, { k: 'on_order', label: 'On order', fmt: 'qty' }, { k: 'open_demand', label: 'Open requests', fmt: 'qty' }, { k: 'suggested_order_qty', label: 'Suggested order', fmt: 'qty' },
    { k: 'lead_time_days', label: 'Lead days', n: true }, { k: 'stock_status', label: 'Status', fmt: 'badge' }, Z] },
  overstock: { title: 'Overstock & non-moving', src: 'v_item_stock', filter: q => q.in('stock_status', ['OVERSTOCK', 'NON_MOVING']), columns: [
    { k: 'code', label: 'Code' }, { k: 'name', label: 'Item' }, { k: 'class_code', label: 'Class' }, { k: 'uom', label: 'UoM' }, { k: 'on_hand', label: 'On hand', fmt: 'qty' },
    { k: r => num(r.max_stock) || num(r.buffer_target) || null, label: 'Max / target', fmt: 'qty' },
    { k: r => Math.max(0, num(r.on_hand) - (num(r.max_stock) || num(r.buffer_target) || Math.round(num(r.avg_daily_consumption) * num(r.overstock_months) * 30))), label: 'Excess qty', fmt: 'qty' },
    { k: 'stock_cover_days', label: 'Cover days', n: true }, { k: 'stock_value', label: 'Value AED', fmt: 'money', cost: true, sum: true }, { k: 'last_issue', label: 'Last issue', fmt: 'date' }, { k: 'stock_status', label: 'Status', fmt: 'badge' }] },
  buffer: { title: 'TOC buffer status', src: 'v_item_stock', filter: q => q.gt('buffer_target', 0), columns: [
    { k: 'code', label: 'Code' }, { k: 'name', label: 'Item' }, { k: 'uom', label: 'UoM' }, { k: 'buffer_target', label: 'Target', fmt: 'qty' }, { k: 'available', label: 'Available', fmt: 'qty' },
    { k: 'on_order', label: 'On order', fmt: 'qty' }, { k: 'open_demand', label: 'Demand', fmt: 'qty' }, { k: 'net_flow_position', label: 'Net position', fmt: 'qty' },
    { k: 'buffer_penetration_pct', label: 'Penetration %', n: true }, Z, { k: 'suggested_order_qty', label: 'Order qty', fmt: 'qty' }, { k: 'moq', label: 'MOQ', fmt: 'qty' }] },
  aging: { title: 'Inventory aging', src: 'v_lot_values', filter: q => q.neq('loc_type', 'SCRAP_YARD'), pivot: true, columns: [
    { k: 'item_code', label: 'Code' }, { k: 'item_name', label: 'Item' }, { k: 'class_name', label: 'Class' }, { k: 'category_name', label: 'Category' }, { k: 'location_code', label: 'Location' }, { k: 'lot_no', label: 'Lot' },
    { k: 'received_date', label: 'Received', fmt: 'date' }, { k: 'age_days', label: 'Age days', n: true }, { k: 'age_bucket', label: 'Bucket' }, { k: 'qty_on_hand', label: 'Qty', fmt: 'qty' }, { k: 'value', label: 'Value AED', fmt: 'money', cost: true, sum: true }] },
  abc: { title: 'ABC analysis (12-month consumption value)', src: 'v_abc_analysis', order: 'rank', cost: true, columns: [
    { k: 'rank', label: 'Sr. No.', n: true }, { k: 'code', label: 'Code' }, { k: 'name', label: 'Item' }, { k: 'class_code', label: 'Class' }, { k: 'uom', label: 'UoM' }, { k: 'annual_qty', label: 'Annual qty', fmt: 'qty' },
    { k: 'annual_value', label: 'Annual value AED', fmt: 'money', sum: true }, { k: 'value_pct', label: '% value', n: true }, { k: 'cumulative_pct', label: 'Cumulative %', n: true }, { k: 'abc_class', label: 'ABC', fmt: 'badge' }] },
  valuation: { title: 'Valuation by category', src: 'v_valuation_by_category', cost: true, columns: [
    { k: 'kind', label: 'Kind', fmt: 'label' }, { k: 'class_code', label: 'Class' }, { k: 'class_name', label: 'Class name' }, { k: 'category_name', label: 'Category' }, { k: 'items', label: 'Items', n: true },
    { k: 'qty', label: 'Qty', fmt: 'qty' }, { k: 'value', label: 'Value AED', fmt: 'money', sum: true }] },
  projects: { title: 'Project / MTS consumption', src: 'v_project_consumption', order: 'code', cost: true, columns: [
    { k: 'code', label: 'Code' }, { k: 'name', label: 'Project' }, { k: 'project_type', label: 'Type', fmt: 'label' }, { k: 'status', label: 'Status', fmt: 'badge' },
    { k: 'issued_value', label: 'Issued', fmt: 'money', sum: true }, { k: 'returned_value', label: 'Returned', fmt: 'money', sum: true }, { k: 'net_consumption', label: 'Net consumption', fmt: 'money', sum: true },
    { k: 'budget_material', label: 'Budget', fmt: 'money' }, { k: r => r.budget_material ? Math.round(num(r.net_consumption) / num(r.budget_material) * 1000) / 10 : null, label: '% of budget', n: true }, { k: 'last_movement', label: 'Last movement', fmt: 'date' }] },
  expiry: { title: 'Expiring stock (next 90 days)', src: 'v_lot_values', filter: q => q.not('expiry_date', 'is', null).lte('expiry_date', new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10)), order: 'expiry_date', columns: [
    { k: 'item_code', label: 'Code' }, { k: 'item_name', label: 'Item' }, { k: 'lot_no', label: 'Lot' }, { k: 'batch_no', label: 'Batch' }, { k: 'location_code', label: 'Location' },
    { k: 'expiry_date', label: 'Expiry', fmt: 'date' }, { k: 'qty_on_hand', label: 'Qty', fmt: 'qty' }, { k: 'value', label: 'Value', fmt: 'money', cost: true, sum: true }] },
  payables: { title: 'Vendor payables (net)', src: 'v_vendor_payables', order: 'name', roles: ['finance', 'factory_manager', 'purchase'], columns: [
    { k: 'code', label: 'Code' }, { k: 'name', label: 'Vendor' }, { k: 'payment_term', label: 'Terms' }, { k: 'invoiced_aed', label: 'Invoiced', fmt: 'money', sum: true }, { k: 'paid_aed', label: 'Paid', fmt: 'money', sum: true },
    { k: 'debit_notes_aed', label: 'Debit notes', fmt: 'money', sum: true }, { k: 'advances_unallocated_aed', label: 'Advances', fmt: 'money', sum: true }, { k: 'net_payable_aed', label: 'NET PAYABLE', fmt: 'money', sum: true },
    { k: 'not_due_aed', label: 'Not due', fmt: 'money', sum: true }, { k: 'overdue_1_30_aed', label: '1-30', fmt: 'money', sum: true }, { k: 'overdue_31_60_aed', label: '31-60', fmt: 'money', sum: true },
    { k: 'overdue_61_90_aed', label: '61-90', fmt: 'money', sum: true }, { k: 'overdue_90_plus_aed', label: '90+', fmt: 'money', sum: true }, { k: 'pdc_not_matured_aed', label: 'PDC not matured', fmt: 'money', sum: true }] },
  invoices: { title: 'Open invoices & due dates', src: 'v_invoice_balances', filter: q => q.gt('balance_aed', 0.005), order: 'due_date', roles: ['finance', 'factory_manager', 'purchase'], columns: [
    { k: r => refLabel('vendors', r.vendor_id), label: 'Vendor' }, { k: 'vendor_invoice_no', label: 'Invoice' }, { k: 'inv_no', label: 'Our ref' }, { k: 'invoice_date', label: 'Date', fmt: 'date' }, { k: 'due_date', label: 'Due', fmt: 'date' },
    { k: 'total_aed', label: 'Total', fmt: 'money', sum: true }, { k: 'paid_aed', label: 'Paid', fmt: 'money', sum: true }, { k: 'balance_aed', label: 'Balance', fmt: 'money', sum: true }, { k: 'days_overdue', label: 'Days overdue', n: true }, { k: 'aging_bucket', label: 'Aging', fmt: 'badge' }] },
  grni: { title: 'Goods received not invoiced', src: 'v_grn_not_invoiced', order: 'grn_date', roles: ['finance', 'factory_manager', 'purchase', 'stores'], cost: true, columns: [
    { k: 'grn_no', label: 'GRN' }, { k: 'grn_date', label: 'Date', fmt: 'date' }, { k: 'vendor_name', label: 'Vendor' }, { k: 'item_code', label: 'Item' }, { k: 'item_name', label: 'Name' },
    { k: 'accepted_qty', label: 'Received', fmt: 'qty' }, { k: 'invoiced_qty', label: 'Invoiced', fmt: 'qty' }, { k: 'pending_qty', label: 'Pending', fmt: 'qty' }, { k: 'pending_value_aed', label: 'Accrual AED', fmt: 'money', sum: true }] },
  tools: { title: 'Tools with workers / overdue', src: 'v_asset_register', filter: q => q.eq('status', 'ISSUED'), order: 'due_back', columns: [
    { k: 'asset_tag', label: 'Tag' }, { k: 'item_name', label: 'Tool' }, { k: 'serial_no', label: 'Serial' }, { k: 'custodian_name', label: 'With' }, { k: 'last_moved_at', label: 'Issued', fmt: 'datetime' },
    { k: 'due_back', label: 'Due back', fmt: 'date' }, { k: r => r.is_overdue ? 'OVERDUE' : 'OK', label: 'Status', fmt: 'badge' }] },
  calibration: { title: 'Calibration due', src: 'v_asset_register', filter: q => q.not('calibration_due_date', 'is', null), order: 'calibration_due_date', columns: [
    { k: 'asset_tag', label: 'Tag' }, { k: 'item_name', label: 'Instrument' }, { k: 'serial_no', label: 'Serial' }, { k: 'last_calibration_date', label: 'Last', fmt: 'date' }, { k: 'calibration_due_date', label: 'Due', fmt: 'date' }, { k: 'calibration_status', label: 'Status', fmt: 'badge' }] },
  jobcost: { title: 'Job costing — planned vs actual', src: 'v_wo_cost', filter: q => q.neq('status', 'CANCELLED'), order: 'wo_no', cost: true,
    roles: ['production_incharge', 'factory_manager', 'finance'], columns: [
    { k: 'wo_no', label: 'Order' }, { k: r => refRow('projects', r.project_id)?.code, label: 'Project' }, { k: r => refRow('items', r.item_id)?.code, label: 'Product' },
    { k: 'qty', label: 'Qty', fmt: 'qty' }, { k: 'status', label: 'Status', fmt: 'badge' }, { k: r => `${r.stages_done}/${r.stages}`, label: 'Stages' },
    { k: 'plan_total', label: 'Planned AED', fmt: 'money', sum: true }, { k: 'act_material', label: 'Material', fmt: 'money', sum: true }, { k: 'act_labour', label: 'Labour', fmt: 'money', sum: true },
    { k: 'act_machine', label: 'Machine', fmt: 'money', sum: true }, { k: 'act_overhead', label: 'Overhead', fmt: 'money', sum: true }, { k: 'act_total', label: 'Actual AED', fmt: 'money', sum: true },
    { k: r => num(r.plan_total) ? Math.round((num(r.act_total) / num(r.plan_total) - 1) * 1000) / 10 : null, label: 'Variance %', n: true },
    { k: r => num(r.qty_completed) ? num(r.fg_value) / num(r.qty_completed) : null, label: 'Unit cost (FG)', fmt: 'money' },
    { k: 'qty_rejected', label: 'Rejected', fmt: 'qty' }, { k: 'scrap_value', label: 'Scrap written off', fmt: 'money', sum: true },
    { k: 'sale_value', label: 'Selling value', fmt: 'money', sum: true }, { k: 'margin', label: 'Margin', fmt: 'money', sum: true },
    { k: r => num(r.sale_value) ? Math.round(num(r.margin) / num(r.sale_value) * 1000) / 10 : null, label: 'Margin %', n: true },
    { k: 'plan_labour_hours', label: 'Plan man-h', n: true }, { k: 'act_labour_hours', label: 'Actual man-h', n: true }] },
  wcload: { title: 'Work centre load & availability', src: 'v_work_center_load', order: 'sort_order', columns: [
    { k: 'code', label: 'Code' }, { k: 'name', label: 'Work centre' }, { k: 'kind', label: 'Type', fmt: 'label' }, { k: r => r.is_down ? 'DOWN' : 'RUNNING', label: 'Now', fmt: 'badge' },
    { k: 'open_stages', label: 'Open stages', n: true }, { k: 'running', label: 'Running', n: true }, { k: 'remaining_hours', label: 'Remaining hours', n: true },
    { k: 'hours_per_day', label: 'Hours/day', n: true }, { k: 'planned_down_hours_14d', label: 'Planned stops next 14d (h)', n: true },
    { k: 'load_days', label: 'Load (days, net of planned stops)', n: true }, { k: 'downtime_hours_30d', label: 'Downtime last 30d (h)', n: true },
    { k: 'availability_pct_30d', label: 'Availability % (30d)', n: true }] },
  downtime: { title: 'Downtime analysis', src: 'v_downtime_summary', order: 'start_at', columns: [
    { k: 'down_no', label: 'No.' }, { k: 'wc_code', label: 'Code' }, { k: 'wc_name', label: 'Work centre' }, { k: 'kind', label: 'Reason', fmt: 'label' },
    { k: 'status', label: 'Status', fmt: 'badge' }, { k: 'start_at', label: 'Stopped', fmt: 'datetime' }, { k: 'end_at', label: 'Restarted', fmt: 'datetime' },
    { k: 'hours', label: 'Hours', n: true, sum: true }, { k: 'description', label: 'What happened' }, { k: 'action_taken', label: 'Action taken' },
    { k: 'repair_cost', label: 'Repair cost', fmt: 'money', cost: true, sum: true }] },
  mntcost: { title: 'Maintenance cost by machine and month', src: 'v_machine_maintenance', order: 'period_month', cost: true,
    roles: ['factory_manager', 'finance', 'production_incharge'], columns: [
    { k: 'period_month', label: 'Month', fmt: 'date' }, { k: 'code', label: 'Code' }, { k: 'name', label: 'Machine / work centre' },
    { k: 'breakdowns', label: 'Breakdowns', n: true, sum: true }, { k: 'down_hours', label: 'Breakdown hours', n: true, sum: true },
    { k: 'pm_done', label: 'PM jobs done', n: true, sum: true }, { k: 'pm_hours', label: 'PM stop hours', n: true, sum: true },
    { k: 'breakdown_repairs', label: 'Repairs on breakdowns', fmt: 'money', sum: true }, { k: 'pm_labour', label: 'In-house PM labour', fmt: 'money', sum: true },
    { k: 'bills_amc', label: 'Repair & AMC bills', fmt: 'money', sum: true },
    { k: 'store_spares', label: 'Spares from store (net)', fmt: 'money', sum: true }, { k: 'total_cost', label: 'Total', fmt: 'money', sum: true }] },
  pmcost: { title: 'PM job costs — machines, facility assets & building areas', src: 'v_pm_job_costs', filter: q => q.eq('status', 'DONE'), order: 'completed_at', cost: true,
    roles: ['factory_manager', 'finance', 'production_incharge'], columns: [
    { k: 'period_month', label: 'Month', fmt: 'date' }, { k: 'pm_no', label: 'Job' }, { k: 'target_kind', label: 'For', fmt: 'label' },
    { k: 'target_label', label: 'Machine / asset / area' }, { k: 'cc_code', label: 'Cost centre' }, { k: 'title', label: 'Maintenance' },
    { k: r => r.by_vendor ? 'AMC · ' + (r.vendor_name || '') : 'In-house', label: 'Done by' }, { k: 'completed_at', label: 'Closed', fmt: 'date' },
    { k: 'labour_hours', label: 'Hours', n: true, sum: true }, { k: 'labour_cost', label: 'Labour', fmt: 'money', sum: true },
    { k: 'spares_value', label: 'Spares issued (net)', fmt: 'money', sum: true }, { k: 'total_cost', label: 'Total', fmt: 'money', sum: true }] },
  pmdue: { title: 'Preventive maintenance — due list', src: 'v_pm_due', filter: q => q.eq('status', 'ACTIVE'), order: 'next_due', columns: [
    { k: 'due_state', label: 'State', fmt: 'badge' }, { k: 'target_kind', label: 'For', fmt: 'label' }, { k: 'target_label', label: 'Machine / asset / area' },
    { k: 'cc_code', label: 'Cost centre' }, { k: 'title', label: 'Maintenance' },
    { k: r => [r.every_days && r.every_days + ' d', r.every_hours && r.every_hours + ' h'].filter(Boolean).join(' / '), label: 'Every' },
    { k: 'next_due', label: 'Next due', fmt: 'date' }, { k: 'days_left', label: 'Days left', n: true }, { k: 'hours_left', label: 'Running h left', n: true },
    { k: 'hours_per_day', label: 'Avg h / day', n: true }, { k: r => r.done_by === 'VENDOR' ? 'AMC · ' + (r.vendor_name || '') : 'In-house', label: 'Done by' },
    { k: 'last_done_date', label: 'Last done', fmt: 'date' }, { k: 'job_no', label: 'Open job' }, { k: 'job_status', label: 'Job status', fmt: 'badge' }] },
  fg: { title: 'Finished goods in store', src: 'v_lot_values', filter: q => q.eq('class_code', 'FG'), order: 'received_date', columns: [
    { k: 'item_code', label: 'Product' }, { k: 'item_name', label: 'Description' }, { k: 'lot_no', label: 'Order / lot' }, { k: 'location_code', label: 'Location' },
    { k: r => r.project_id ? (refRow('projects', r.project_id)?.code || 'Project') : 'MTS stock', label: 'For' },
    { k: 'received_date', label: 'Completed', fmt: 'date' }, { k: 'age_days', label: 'Age days', n: true }, { k: 'qty_on_hand', label: 'Qty', fmt: 'qty' },
    { k: 'value_rate', label: 'Unit cost', fmt: 'money', cost: true }, { k: 'value', label: 'Value AED', fmt: 'money', cost: true, sum: true }] },
  projprod: { title: 'Project production, cost & margin', src: 'v_project_margin', filter: q => q.or('orders.gt.0,contract_value.not.is.null'), order: 'code', cost: true, columns: [
    { k: 'code', label: 'Code' }, { k: 'name', label: 'Project' }, { k: 'project_type', label: 'Type', fmt: 'label' }, { k: 'orders', label: 'Orders', n: true }, { k: 'wip_orders', label: 'In WIP', n: true },
    { k: 'contract_value', label: 'Contract value', fmt: 'money', sum: true },
    { k: 'wip_value', label: 'WIP', fmt: 'money', sum: true }, { k: 'fg_in_store', label: 'FG in store', fmt: 'money', sum: true }, { k: 'dispatched_value', label: 'Dispatched', fmt: 'money', sum: true },
    { k: 'reserved_stock', label: 'Bought, not delivered', fmt: 'money', sum: true }, { k: 'services_cost', label: 'Subcontract / hire', fmt: 'money', sum: true },
    { k: 'install_labour', label: 'Own installation', fmt: 'money', sum: true },
    { k: 'scrap_written_off', label: 'Scrap written off', fmt: 'money', sum: true }, { k: 'site_material', label: 'Other material issued', fmt: 'money', sum: true },
    { k: 'total_cost', label: 'Total cost', fmt: 'money', sum: true }, { k: 'margin', label: 'Margin', fmt: 'money', sum: true }, { k: 'margin_pct', label: 'Margin %', n: true }] },
  somargin: { title: 'Sales orders — delivery, billing & margin', src: 'v_sales_orders', filter: q => q.not('status', 'in', '(DRAFT,CANCELLED)'), order: 'so_no', cost: true,
    roles: ['sales', 'finance', 'factory_manager'], columns: [
    { k: 'so_no', label: 'Order' }, { k: r => r.so_type === 'INTERNAL' ? 'Internal · ' + (r.cost_center_code || '') : r.customer_name, label: 'Customer / cost centre' }, { k: 'title', label: 'Title' },
    { k: 'status', label: 'Status', fmt: 'badge' }, { k: 'delivery_date', label: 'Due', fmt: 'date' }, { k: 'subtotal', label: 'Order value', fmt: 'money', sum: true },
    { k: 'delivered_pct', label: '% delivered', n: true }, { k: 'advance_invoiced', label: 'Advance billed', fmt: 'money', sum: true }, { k: 'invoiced_value', label: 'Invoiced', fmt: 'money', sum: true },
    { k: 'est_cost', label: 'Est. cost', fmt: 'money', sum: true }, { k: 'actual_cost', label: 'Actual cost', fmt: 'money', sum: true },
    { k: 'margin', label: 'Margin', fmt: 'money', sum: true }, { k: 'margin_pct', label: 'Margin %', n: true }] },
  boqprog: { title: 'BOQ progress & billing (per BOQ item)', src: 'v_boq_progress', order: 'project_code', columns: [
    { k: 'project_code', label: 'Project' }, { k: r => r.billing_basis === 'UNIT' ? 'Unit-wise' : 'BOQ item', label: 'Billing' }, { k: 'boq_ref', label: 'Ref' },
    { k: 'description', label: 'Description' }, { k: 'category', label: 'Category', fmt: 'label' }, { k: 'uom', label: 'UoM' }, { k: 'qty', label: 'BOQ qty', fmt: 'qty' },
    { k: 'sell_rate', label: 'Rate', fmt: 'money', cost: true }, { k: 'contract_value', label: 'Contract value', fmt: 'money', cost: true, sum: true },
    { k: 'wo_qty', label: 'On production', fmt: 'qty' }, { k: 'produced_qty', label: 'Produced', fmt: 'qty' }, { k: 'ordered_qty', label: 'Ordered', fmt: 'qty' }, { k: 'received_qty', label: 'Received / certified', fmt: 'qty' },
    { k: 'delivered_qty', label: 'Delivered', fmt: 'qty' }, { k: 'installed_qty', label: 'Installed', fmt: 'qty' }, { k: 'installed_pct', label: '% installed', n: true },
    { k: 'delivered_value', label: 'Delivered value', fmt: 'money', cost: true, sum: true }, { k: 'earned_value', label: 'Installed value (billable)', fmt: 'money', cost: true, sum: true },
    { k: 'est_cost', label: 'Est. cost', fmt: 'money', cost: true, sum: true }, { k: 'actual_cost', label: 'Actual cost', fmt: 'money', cost: true, sum: true }] },
  leavebal: { title: 'Leave balances (annual leave, UAE accrual)', src: 'v_leave_balance', order: 'name', roles: ['hr_officer', 'finance', 'factory_manager'], columns: [
    { k: 'emp_code', label: 'Code' }, { k: 'name', label: 'Employee' }, { k: 'department', label: 'Department' }, { k: 'joining_date', label: 'Joined', fmt: 'date' },
    { k: 'accrued', label: 'Accrued days', fmt: 'qty' }, { k: 'taken', label: 'Taken', fmt: 'qty' }, { k: 'balance', label: 'Balance', fmt: 'qty' },
    { k: 'sick_this_year', label: 'Sick days this year', fmt: 'qty' }, { k: 'emp_status', label: 'Status', fmt: 'badge' }] },
  docexpiry: { title: 'Employee document expiry', src: 'v_document_expiry', order: 'expiry_date', roles: ['hr_officer', 'finance'], columns: [
    { k: 'emp_code', label: 'Code' }, { k: 'name', label: 'Employee' }, { k: 'department', label: 'Department' }, { k: 'doc_type', label: 'Document', fmt: 'label' },
    { k: 'doc_no', label: 'Number' }, { k: 'expiry_date', label: 'Expiry', fmt: 'date' }, { k: 'days_left', label: 'Days left', n: true }, { k: 'expiry_status', label: 'Status', fmt: 'badge' }] },
  gratuity: { title: 'Gratuity & leave provision (end of service to date)', src: 'v_gratuity_provision', order: 'name', roles: ['hr_officer', 'finance'], columns: [
    { k: 'emp_code', label: 'Code' }, { k: 'name', label: 'Employee' }, { k: 'department', label: 'Department' }, { k: 'joining_date', label: 'Joined', fmt: 'date' },
    { k: 'basic', label: 'Basic', fmt: 'money' }, { k: 'service_years', label: 'Service (years)', n: true },
    { k: 'gratuity_provision', label: 'Gratuity provision', fmt: 'money', sum: true }, { k: 'leave_provision', label: 'Leave provision', fmt: 'money', sum: true }] },
  attmonth: { title: 'Attendance (by day)', src: 'attendance', select: '*, employees(emp_code,name,department), projects(code)', order: 'att_date', roles: ['hr_officer', 'finance', 'factory_manager', 'production_incharge'], columns: [
    { k: 'att_date', label: 'Date', fmt: 'date' }, { k: r => r.employees?.emp_code, label: 'Code' }, { k: r => r.employees?.name, label: 'Employee' }, { k: r => r.employees?.department, label: 'Department' },
    { k: 'status', label: 'Status', fmt: 'badge' }, { k: 'normal_hours', label: 'Hours', n: true, sum: true }, { k: 'ot_hours', label: 'OT 125%', n: true, sum: true },
    { k: 'ot_hours_holiday', label: 'OT 150%', n: true, sum: true }, { k: r => r.projects?.code, label: 'Project' }, { k: 'remarks', label: 'Remarks' }] },
  snags: { title: 'Snag register', src: 'v_snags', order: 'snag_date', columns: [
    { k: 'snag_no', label: 'Snag' }, { k: 'snag_date', label: 'Raised', fmt: 'date' }, { k: 'project_code', label: 'Project' }, { k: 'unit_code', label: 'Unit' },
    { k: 'location_text', label: 'Location' }, { k: 'description', label: 'Description' }, { k: 'category', label: 'Category', fmt: 'label' }, { k: 'severity', label: 'Severity', fmt: 'badge' },
    { k: 'raised_by_party', label: 'Raised by', fmt: 'label' }, { k: 'responsible', label: 'Fix by', fmt: 'label' }, { k: 'vendor_name', label: 'Subcontractor' },
    { k: 'due_date', label: 'Due', fmt: 'date' }, { k: r => r.is_overdue ? 'OVERDUE' : '', label: '', fmt: 'badge' }, { k: 'status', label: 'Status', fmt: 'badge' },
    { k: 'age_days', label: 'Age (days)', n: true }, { k: 'reopen_count', label: 'Reopened', n: true }, { k: 'photos', label: 'Photos', n: true },
    { k: 'labour_cost', label: 'Rework labour', fmt: 'money', cost: true, sum: true }, { k: 'material_cost', label: 'Rework material', fmt: 'money', cost: true, sum: true }] },
  // ---------- running expenses (Finance menu) ----------
  expreg: { title: 'Expense register (posted)', src: 'expense_lines', order: 'line_no', roles: ['finance', 'factory_manager'],
    select: '*, expenses!inner(exp_no,exp_date,exp_type,status,payee_name,bill_no,vendors(name),employees(name)), gl_accounts(code,name), cost_centers(code,name), projects(code)',
    filter: q => q.in('expenses.status', ['POSTED', 'REIMBURSED']), columns: [
    { k: r => r.expenses.exp_date, label: 'Date', fmt: 'date' }, { k: r => r.expenses.exp_no, label: 'Expense' }, { k: r => label(r.expenses.exp_type), label: 'Type' },
    { k: r => r.expenses.vendors?.name || r.expenses.employees?.name || r.expenses.payee_name, label: 'Paid to' }, { k: r => r.expenses.bill_no, label: 'Bill no.' },
    { k: r => `${r.gl_accounts?.code} ${r.gl_accounts?.name}`, label: 'Expense head' }, { k: 'description', label: 'Description' },
    { k: r => r.cost_centers?.code, label: 'Cost centre' }, { k: r => r.projects?.code, label: 'Project' },
    { k: 'amount', label: 'Amount', fmt: 'money', sum: true }, { k: 'vat_amount', label: 'VAT', fmt: 'money', sum: true }] },
  budget: { title: 'Budget vs actual by cost centre', src: 'v_budget_vs_actual', order: 'period_month', roles: ['finance', 'factory_manager'], columns: [
    { k: r => new Date(r.period_month + 'T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }), label: 'Month' },
    { k: r => `${r.cost_center_code} — ${r.cost_center_name}`, label: 'Cost centre' }, { k: r => r.account_code ? `${r.account_code} ${r.account_name}` : '— all heads —', label: 'Expense head' },
    { k: 'budget', label: 'Budget', fmt: 'money' }, { k: 'actual', label: 'Actual', fmt: 'money' }, { k: r => num(r.actual) - num(r.budget), label: 'Over / (under)', fmt: 'money' },
    { k: r => num(r.budget) ? Math.round(100 * num(r.actual) / num(r.budget)) : null, label: '% used', n: true },
    { k: r => num(r.budget) && num(r.actual) > num(r.budget) ? 'OVER' : '', label: '', fmt: 'badge' }] },
  overhead: { title: 'Factory overheads: actual vs absorbed into production', src: 'v_overhead_absorption', order: 'period_month', roles: ['finance', 'factory_manager'], columns: [
    { k: r => new Date(r.period_month + 'T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }), label: 'Month' },
    { k: 'actual_overhead', label: 'Actual factory overheads', fmt: 'money', sum: true }, { k: 'absorbed_overhead', label: 'Absorbed into jobs', fmt: 'money', sum: true },
    { k: 'over_under', label: 'Over / (under) absorbed', fmt: 'money', sum: true }, { k: 'labour_machine_base', label: 'Labour + machine cost', fmt: 'money', sum: true },
    { k: 'current_pct', label: 'Overhead % used', n: true }, { k: 'suggested_pct', label: 'Overhead % that would cover actual', n: true }] },
  unitprog: { title: 'Unit progress & billing (unit-wise)', src: 'v_unit_progress', order: 'project_code', columns: [
    { k: 'project_code', label: 'Project' }, { k: r => r.billing_basis === 'UNIT' ? 'Unit-wise' : 'BOQ item', label: 'Billing' }, { k: 'unit_code', label: 'Unit' },
    { k: 'unit_type', label: 'Type' }, { k: 'building', label: 'Building' }, { k: 'floor', label: 'Floor' }, { k: 'status', label: 'Status', fmt: 'badge' },
    { k: r => `${r.lines_done}/${r.boq_lines}`, label: 'BOQ lines done' }, { k: 'progress_pct', label: 'Progress %', n: true },
    { k: 'sale_value', label: 'Unit price', fmt: 'money', cost: true, sum: true }, { k: 'boq_value', label: 'BOQ value', fmt: 'money', cost: true, sum: true },
    { k: 'earned_value', label: 'Earned (billable)', fmt: 'money', cost: true, sum: true }, { k: 'handed_over_at', label: 'Handed over', fmt: 'date' }, { k: 'handed_over_to', label: 'To' }] },
};

export const Reports = {
  components: { DataTable, RefSelect },
  props: { rkey: String },
  data: () => ({ rows: [], loading: false, cls: '', ledger: { item_id: null, from: '', to: today(), location_id: null } }),
  computed: {
    list() { return Object.entries(REPORTS).filter(([k, r]) => !(r.cost && !canSeeCost()) && !(r.roles && !hasRole(...r.roles))).map(([k, r]) => ({ k, t: r.title })).concat([{ k: 'ledger', t: 'Stock ledger / item card' }]); },
    rep() { return REPORTS[this.rkey]; },
    classes() { return [...new Set(this.rows.map(r => r.class_code || r.class_name).filter(Boolean))].sort(); },
    shown() { return this.cls ? this.rows.filter(r => (r.class_code || r.class_name) === this.cls) : this.rows; },
    pivot() {
      if (!this.rep?.pivot) return null;
      const cls = [...new Set(this.shown.map(r => r.class_name))].sort();
      return cls.map(c => { const o = { class_name: c }; AGE_ORDER.forEach(b => { o[b] = this.shown.filter(r => r.class_name === c && r.age_bucket === b).reduce((s, r) => s + num(canSeeCost() ? r.value : r.qty_on_hand), 0); }); o.total = AGE_ORDER.reduce((s, b) => s + o[b], 0); return o; });
    },
    pivotCols() { const f = canSeeCost() ? 'money' : 'qty'; return [{ k: 'class_name', label: 'Class' }, ...AGE_ORDER.map(b => ({ k: b, label: b + ' days', fmt: f, sum: true })), { k: 'total', label: 'Total', fmt: f, sum: true }]; },
    abcSummary() {
      if (this.rkey !== 'abc') return null;
      return ['A', 'B', 'C'].map(c => { const r = this.rows.filter(x => x.abc_class === c); return { abc: c, items: r.length, value: r.reduce((s, x) => s + num(x.annual_value), 0) }; });
    },
    ledgerCols() {
      return [{ k: 'txn_date', label: 'Date', fmt: 'date' }, { k: 'txn_type', label: 'Type', fmt: 'label' }, { k: 'doc_no', label: 'Document' }, { k: r => r.locations?.code, label: 'Loc' }, { k: r => r.stock_lots?.lot_no, label: 'Lot' },
        { k: r => r.projects?.code || r.cost_centers?.code, label: 'Project / CC' }, { k: r => num(r.qty) > 0 ? r.qty : null, label: 'In', fmt: 'qty' }, { k: r => num(r.qty) < 0 ? -r.qty : null, label: 'Out', fmt: 'qty' },
        { k: 'balance', label: 'Balance', fmt: 'qty' }, { k: 'unit_cost', label: 'Rate', fmt: 'money', cost: true }, { k: 'value', label: 'Value', fmt: 'money', cost: true }];
    },
  },
  watch: { rkey() { this.load(); } },
  async mounted() { await loadRefs(['items', 'locations', 'vendors']); this.load(); },
  methods: {
    pick(k) { go('r/' + k); },
    async load() {
      this.rows = []; this.cls = '';
      if (this.rkey === 'ledger' || !this.rep) return;
      this.loading = true;
      await run(async () => {
        let q = sb.from(this.rep.src).select(this.rep.select || '*');
        if (this.rep.filter) q = this.rep.filter(q);
        if (this.rep.order) q = q.order(this.rep.order);
        const rows = must(await q.limit(20000));
        if (this.rep.after) await this.rep.after(rows);
        this.rows = rows;
      });
      this.loading = false;
    },
    async loadLedger() {
      const l = this.ledger;
      if (!l.item_id) return toast('Select an item', 'error');
      this.loading = true;
      await run(async () => {
        let q = sb.from('stock_ledger').select('*, locations(code), stock_lots(lot_no), projects(code), cost_centers(code)').eq('item_id', l.item_id).order('txn_date').order('id');
        if (l.location_id) q = q.eq('location_id', l.location_id);
        const all = must(await q.limit(20000));
        let bal = 0;
        all.forEach(r => { bal += num(r.qty); r.balance = bal; });
        this.rows = all.filter(r => (!l.from || r.txn_date >= l.from) && (!l.to || r.txn_date <= l.to));
      });
      this.loading = false;
    },
  },
  template: `<div>
    <div v-if="rkey==='ledger'" class="card">
      <div class="grid" style="margin-bottom:12px">
        <label class="f wide">Item<RefSelect v-model="ledger.item_id" refName="items" /></label>
        <label class="f">Location (optional)<RefSelect v-model="ledger.location_id" refName="locations" /></label>
        <label class="f">From<input type="date" v-model="ledger.from"></label>
        <label class="f">To<input type="date" v-model="ledger.to"></label>
        <label class="f">&nbsp;<button class="btn primary" @click="loadLedger">Show</button></label>
      </div>
      <DataTable :columns="ledgerCols" :rows="rows" :loading="loading" filename="stock_ledger" />
    </div>
    <template v-else-if="rep">
      <div class="card" v-if="pivot">
        <h3>Aging summary by class ({{ canSeeCost() ? 'AED' : 'qty' }})</h3>
        <DataTable :columns="pivotCols" :rows="pivot" :searchable="false" />
      </div>
      <div class="card" v-if="abcSummary">
        <h3>ABC summary</h3>
        <DataTable :columns="[{k:'abc',label:'Class',fmt:'badge'},{k:'items',label:'Items',n:true},{k:'value',label:'Annual value AED',fmt:'money',sum:true}]" :rows="abcSummary" :searchable="false" />
        <div class="small muted" style="margin-top:6px">A = top {{ $root.company?.abc_a_pct ?? 70 }}% of consumption value, B = up to {{ $root.company?.abc_b_pct ?? 90 }}%, C = the rest. Thresholds are set in Settings.</div>
      </div>
      <div class="card">
        <div class="hd"><h3>{{ rep.title }}</h3><span class="spacer"></span>
          <select v-if="classes.length > 1" v-model="cls" style="max-width:200px"><option value="">All classes</option><option v-for="c in classes" :value="c">{{ c }}</option></select>
          <button class="btn sm" @click="load">↻ Refresh</button>
        </div>
        <DataTable :columns="rep.columns" :rows="shown" :loading="loading" :filename="rkey" />
      </div>
    </template>
  </div>`,
  setup() { return { canSeeCost }; },
};

// ======================================================================
// REPLENISHMENT (buffer / re-order suggestions -> PR or draft POs)
// ======================================================================
export const Replenishment = {
  components: { DataTable, RefSelect, Badge },
  data: () => ({ rows: [], loading: true, busy: false }),
  computed: { vendorsOpts() { return (state.refs.vendors || []).filter(v => v.status === 'ACTIVE'); } },
  async mounted() { await loadRefs(['items', 'vendors']); await this.load(); },
  methods: {
    qty, money, label,
    async load() {
      this.loading = true;
      await run(async () => {
        const rows = must(await sb.from('v_item_stock').select('*').gt('suggested_order_qty', 0).eq('is_active', true).order('buffer_penetration_pct', { ascending: false, nullsFirst: false }));
        const iv = rows.length ? must(await sb.from('item_vendors').select('item_id,vendor_id,price,is_preferred').in('item_id', rows.map(r => r.item_id))) : [];
        rows.forEach(r => {
          const cands = iv.filter(x => x.item_id === r.item_id).sort((a, b) => (b.is_preferred ? 1 : 0) - (a.is_preferred ? 1 : 0));
          r._sel = ['BLACK', 'RED'].includes(r.buffer_zone) || r.stock_status === 'STOCK_OUT';
          r._vendor = cands[0]?.vendor_id || null;
          r._price = cands[0]?.price ?? r.last_purchase_rate ?? 0;
          r._qty = num(r.suggested_order_qty);
        });
        this.rows = rows;
      });
      this.loading = false;
    },
    async createPR() {
      const sel = this.rows.filter(r => r._sel && r._qty > 0);
      if (!sel.length) return toast('Select at least one item', 'error');
      this.busy = true;
      const id = await run(async () => {
        const pr = must(await sb.from('purchase_requisitions').insert({ source: 'BUFFER', remarks: 'Generated from buffer / re-order suggestions' }).select().single());
        must(await sb.from('pr_lines').insert(sel.map((r, i) => ({ pr_id: pr.id, line_no: i + 1, item_id: r.item_id, qty: r._qty }))));
        return pr.id;
      }, 'Requisition created');
      this.busy = false;
      if (id) go('d/pr/' + id);
    },
    async createPOs() {
      const sel = this.rows.filter(r => r._sel && r._qty > 0);
      if (!sel.length) return toast('Select at least one item', 'error');
      if (sel.some(r => !r._vendor)) return toast('Choose a vendor for every selected item', 'error');
      this.busy = true;
      const n = await run(async () => {
        const byVendor = {};
        sel.forEach(r => (byVendor[r._vendor] ||= []).push(r));
        let count = 0;
        for (const [vid, lines] of Object.entries(byVendor)) {
          const v = refRow('vendors', vid);
          const po = must(await sb.from('purchase_orders').insert({ vendor_id: vid, currency: v.currency, payment_term_id: v.payment_term_id, po_type: v.vendor_type, terms_conditions: state.company?.po_terms_conditions || null, remarks: 'Generated from buffer / re-order suggestions' }).select().single());
          must(await sb.from('po_lines').insert(lines.map((r, i) => ({ po_id: po.id, line_no: i + 1, item_id: r.item_id, description: r.name, qty: r._qty, rate: num(r._price), vat_rate: v.vendor_type === 'IMPORT' ? 0 : num(refRow('items', r.item_id)?.vat_rate ?? 5) }))));
          count++;
        }
        return count;
      });
      this.busy = false;
      if (n) { toast(`${n} draft PO(s) created — review and submit them for approval`, 'ok'); go('d/po'); }
    },
  },
  template: `<div>
    <div class="card">
      <div class="hd"><h3>Replenishment suggestions</h3><span class="spacer"></span>
        <button class="btn" @click="load">↻ Refresh</button>
        <button class="btn" :disabled="busy" @click="createPR" v-if="$root.hasRole('stores','purchase','factory_manager','production_incharge')">Create requisition</button>
        <button class="btn primary" :disabled="busy" @click="createPOs" v-if="$root.hasRole('purchase')">Create draft POs (grouped by vendor)</button>
      </div>
      <p class="small muted" style="margin-top:0">Items in RED / YELLOW buffer zone or below re-order level. Qty tops up to the buffer target (or max stock), rounded up to MOQ and order multiple. Stock position = available + on order − open requests.</p>
      <div class="tbl-wrap">
        <table class="t lines">
          <thead><tr><th></th><th>Item</th><th>Zone</th><th class="n">Available</th><th class="n">On order</th><th class="n">Demand</th><th class="n">Target / ROL</th><th class="n">MOQ</th><th>Order qty</th><th>Vendor</th><th v-if="$root.canSeeCost()">Rate</th></tr></thead>
          <tbody>
            <tr v-if="loading"><td colspan="11" class="empty">Loading…</td></tr>
            <tr v-else-if="!rows.length"><td colspan="11" class="empty">Nothing to replenish 🎉</td></tr>
            <tr v-for="r in rows" :key="r.item_id">
              <td><input type="checkbox" v-model="r._sel"></td>
              <td>{{ r.code }} — {{ r.name }} <span class="muted small">({{ r.uom }})</span></td>
              <td><Badge :v="r.buffer_zone || r.stock_status" /></td>
              <td class="n">{{ qty(r.available) }}</td><td class="n">{{ qty(r.on_order) }}</td><td class="n">{{ qty(r.open_demand) }}</td>
              <td class="n">{{ qty(r.buffer_target || r.reorder_level) }}</td><td class="n">{{ qty(r.moq) }}</td>
              <td style="width:110px"><input type="number" v-model.number="r._qty"></td>
              <td style="min-width:240px"><RefSelect v-model="r._vendor" :options="vendorsOpts.map(v => ({ id: v.id, label: v.name }))" /></td>
              <td v-if="$root.canSeeCost()" style="width:110px"><input type="number" v-model.number="r._price"></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>`,
};

// ======================================================================
// CONSOLIDATE REQUISITIONS -> one draft PO per vendor
// ======================================================================
export const ConsolidatePR = {
  components: { RefSelect, Badge },
  data: () => ({ rows: [], iv: [], loading: true, busy: false, q: '', proj: '', bulkVendor: null, appendDraft: true }),
  computed: {
    vendorOpts() { return (state.refs.vendors || []).filter(v => v.status === 'ACTIVE').map(v => ({ id: v.id, label: v.name })); },
    projects() { return [...new Map(this.rows.filter(r => r.project_id).map(r => [r.project_id, r.project_code])).entries()]; },
    shown() {
      const q = this.q.toLowerCase().trim();
      return this.rows.filter(r => (!this.proj || (this.proj === 'STOCK' ? !r.project_id : r.project_id === this.proj))
        && (!q || `${r.item_code} ${r.item_name} ${r.pr_no} ${r.mr_no || ''} ${r.project_code || ''}`.toLowerCase().includes(q)));
    },
    selected() { return this.rows.filter(r => r._sel && num(r._qty) > 0); },
    // combined qty per vendor + item, checked against the vendor MOQ (or item MOQ)
    groups() {
      const g = {};
      for (const r of this.selected) {
        const k = `${r._vendor || '-'}|${r.item_id}`;
        (g[k] ||= { vendor: r._vendor, item_id: r.item_id, qty: 0, moq: this.moq(r) });
        g[k].qty += num(r._qty);
      }
      return g;
    },
    summary() {
      const s = {};
      for (const r of this.selected) {
        if (!r._vendor) continue;
        (s[r._vendor] ||= { vendor: r._vendor, lines: 0, value: 0 });
        s[r._vendor].lines++; s[r._vendor].value += num(r._qty) * num(r._rate);
      }
      return Object.values(s);
    },
    missingVendor() { return this.selected.filter(r => !r._vendor).length; },
  },
  async mounted() { await loadRefs(['items', 'vendors', 'projects']); await this.load(); },
  methods: {
    qty, money, dt,
    moq(r) { const v = this.iv.find(x => x.item_id === r.item_id && x.vendor_id === r._vendor); return num(v?.moq) || num(refRow('items', r.item_id)?.moq); },
    belowMoq(r) { const g = this.groups[`${r._vendor || '-'}|${r.item_id}`]; return r._sel && g && g.moq > 0 && g.qty < g.moq; },
    async load() {
      this.loading = true;
      await run(async () => {
        const lines = must(await sb.from('pr_lines')
          .select('id,pr_id,item_id,qty,ordered_qty,project_id,required_date,remarks,purchase_requisitions!inner(pr_no,pr_date,status,material_requests(mr_no)),items(code,name,moq,last_purchase_rate,vat_rate,uoms(code)),projects(code)')
          .in('purchase_requisitions.status', ['SUBMITTED', 'PARTIAL_PO']));
        const open = lines.filter(l => num(l.qty) > num(l.ordered_qty));
        this.iv = open.length ? must(await sb.from('item_vendors').select('item_id,vendor_id,price,moq,is_preferred').in('item_id', [...new Set(open.map(l => l.item_id))])) : [];
        this.rows = open.map(l => {
          const cands = this.iv.filter(x => x.item_id === l.item_id).sort((a, b) => (b.is_preferred ? 1 : 0) - (a.is_preferred ? 1 : 0));
          const r = {
            id: l.id, pr_id: l.pr_id, item_id: l.item_id, item_code: l.items.code, item_name: l.items.name, uom: l.items.uoms?.code,
            project_id: l.project_id, project_code: l.projects?.code, required_date: l.required_date,
            pr_no: l.purchase_requisitions.pr_no, mr_no: l.purchase_requisitions.material_requests?.mr_no,
            balance: num(l.qty) - num(l.ordered_qty), _sel: true, _qty: num(l.qty) - num(l.ordered_qty), _vendor: cands[0]?.vendor_id || null,
          };
          r._rate = this.rateFor(r);
          return r;
        }).sort((a, b) => a.item_code.localeCompare(b.item_code) || String(a.required_date || '').localeCompare(String(b.required_date || '')));
      });
      this.loading = false;
    },
    rateFor(r) {
      const v = this.iv.find(x => x.item_id === r.item_id && x.vendor_id === r._vendor);
      return num(v?.price ?? refRow('items', r.item_id)?.last_purchase_rate ?? 0);
    },
    vendorChanged(r) { r._rate = this.rateFor(r); },
    applyBulk() {
      if (!this.bulkVendor) return toast('Choose a vendor first', 'error');
      this.shown.filter(r => r._sel).forEach(r => { r._vendor = this.bulkVendor; r._rate = this.rateFor(r); });
    },
    toggleAll(v) { this.shown.forEach(r => { r._sel = v; }); },
    vname(id) { return refRow('vendors', id)?.name || ''; },
    async create() {
      const sel = this.selected;
      if (!sel.length) return toast('Tick at least one line', 'error');
      if (this.missingVendor) return toast(`Choose a vendor for ${this.missingVendor} ticked line(s)`, 'error');
      this.busy = true;
      const made = await run(async () => {
        const byVendor = {};
        sel.forEach(r => (byVendor[r._vendor] ||= []).push(r));
        const result = [];
        for (const [vid, lines] of Object.entries(byVendor)) {
          const v = refRow('vendors', vid);
          let po = null, start = 0;
          if (this.appendDraft) {
            po = must(await sb.from('purchase_orders').select('id,po_no').eq('vendor_id', vid).eq('status', 'DRAFT').order('created_at', { ascending: false }).limit(1).maybeSingle());
            if (po) start = must(await sb.from('po_lines').select('line_no').eq('po_id', po.id).order('line_no', { ascending: false }).limit(1)).at(0)?.line_no || 0;
          }
          if (!po) {
            const dates = lines.map(l => l.required_date).filter(Boolean).sort();
            po = must(await sb.from('purchase_orders').insert({
              vendor_id: vid, currency: v.currency, payment_term_id: v.payment_term_id, po_type: v.vendor_type,
              delivery_date: dates[0] || null, terms_conditions: state.company?.po_terms_conditions || null,
              remarks: 'Consolidated from requisitions ' + [...new Set(lines.map(l => l.pr_no))].join(', '),
            }).select('id,po_no').single());
          }
          must(await sb.from('po_lines').insert(lines.map((l, i) => ({
            po_id: po.id, line_no: start + i + 1, item_id: l.item_id, description: l.item_name, qty: num(l._qty), rate: num(l._rate),
            vat_rate: v.vendor_type === 'IMPORT' ? 0 : num(refRow('items', l.item_id)?.vat_rate ?? 5),
            project_id: l.project_id || null, pr_line_id: l.id, required_date: l.required_date || null,
          }))));
          result.push({ po, n: lines.length, appended: start > 0 });
        }
        return result;
      });
      this.busy = false;
      if (made) {
        toast(made.map(m => `${m.po.po_no}: ${m.n} line(s)${m.appended ? ' added' : ''}`).join(' · '), 'ok', 9000);
        made.length === 1 ? go('d/po/' + made[0].po.id) : go('d/po');
      }
    },
  },
  template: `<div>
    <div class="card">
      <div class="hd"><h3>Open requisition lines</h3><span class="spacer"></span>
        <input v-model="q" placeholder="Search item, PR, request, project" style="max-width:260px">
        <select v-model="proj" style="max-width:180px"><option value="">All purposes</option><option value="STOCK">General stock</option>
          <option v-for="[id, code] in projects" :value="id">Project {{ code }}</option></select>
        <button class="btn" @click="load">↻ Refresh</button>
      </div>
      <p class="small muted" style="margin-top:0">Tick the lines to order, check the vendor and rate, then create one draft PO per vendor. Project lines stay marked for their project so the goods arrive reserved.</p>
      <div class="row" style="margin-bottom:10px">
        <span class="small muted">Set vendor for ticked lines:</span>
        <div style="width:260px"><RefSelect v-model="bulkVendor" :options="vendorOpts" /></div>
        <button class="btn sm" @click="applyBulk">Apply</button>
        <span class="spacer"></span>
        <label class="small row"><input type="checkbox" v-model="appendDraft"> Add to the vendor's existing draft PO if there is one</label>
      </div>
      <div class="tbl-wrap">
        <table class="t lines">
          <thead><tr><th><input type="checkbox" @change="toggleAll($event.target.checked)" checked></th><th>Item</th><th>For</th><th>Requisition</th><th>Required</th>
            <th class="n">Balance</th><th>Order qty</th><th>Vendor</th><th v-if="$root.canSeeCost()">Rate</th><th></th></tr></thead>
          <tbody>
            <tr v-if="loading"><td colspan="10" class="empty">Loading…</td></tr>
            <tr v-else-if="!shown.length"><td colspan="10" class="empty">No open requisition lines</td></tr>
            <tr v-for="r in shown" :key="r.id">
              <td><input type="checkbox" v-model="r._sel"></td>
              <td>{{ r.item_code }} — {{ r.item_name }} <span class="muted small">({{ r.uom }})</span></td>
              <td><span class="b" :class="r.project_id ? 'INSTALLED' : 'OK'">{{ r.project_id ? r.project_code : 'Stock' }}</span></td>
              <td class="small">{{ r.pr_no }}<div class="muted" v-if="r.mr_no">{{ r.mr_no }}</div></td>
              <td class="small">{{ dt(r.required_date) }}</td>
              <td class="n">{{ qty(r.balance) }}</td>
              <td style="width:100px"><input type="number" v-model.number="r._qty"></td>
              <td style="min-width:230px"><RefSelect v-model="r._vendor" :options="vendorOpts" @pick="vendorChanged(r)" /></td>
              <td v-if="$root.canSeeCost()" style="width:100px"><input type="number" v-model.number="r._rate"></td>
              <td class="small" style="white-space:nowrap"><span v-if="belowMoq(r)" style="color:var(--warn)" :title="'Combined qty for this vendor is below MOQ ' + qty(groups[(r._vendor || '-') + '|' + r.item_id].moq)">⚠ below MOQ</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div class="card" v-if="selected.length">
      <div class="hd"><h3>Will create</h3><span class="spacer"></span>
        <span class="small" style="color:var(--bad)" v-if="missingVendor">{{ missingVendor }} ticked line(s) without vendor</span>
        <button class="btn primary" :disabled="busy" @click="create">Create {{ summary.length }} draft PO{{ summary.length === 1 ? '' : 's' }}</button></div>
      <div class="row" style="gap:12px">
        <div v-for="s in summary" class="kpi" style="min-width:220px">
          <div class="l">{{ vname(s.vendor) }}</div><div class="v" style="font-size:18px">{{ s.lines }} line{{ s.lines === 1 ? '' : 's' }}</div>
          <div class="s" v-if="$root.canSeeCost()">≈ {{ money(s.value) }} excl. VAT</div>
        </div>
      </div>
    </div>
  </div>`,
};

// ======================================================================
// QUARANTINE & EXCEPTIONS: excess / damaged held stock and supplier receipt exceptions
// ======================================================================
const HOLD_LABEL = { EXCESS: 'Excess from supplier', DAMAGED: 'Damaged at supplier receipt', RETURN_DAMAGED: 'Damaged — returned from floor' };
export const Holds = {
  components: { DataTable, Badge },
  data: () => ({ holds: [], exc: [], loading: true, busy: false }),
  computed: {
    groups() { return ['EXCESS', 'DAMAGED', 'RETURN_DAMAGED'].map(k => ({ k, t: HOLD_LABEL[k], rows: this.holds.filter(h => h.hold_reason === k) })).filter(g => g.rows.length); },
    excCols() {
      return [{ k: 'grn_no', label: 'GRN' }, { k: 'grn_date', label: 'Date', fmt: 'date' }, { k: 'vendor_name', label: 'Supplier' }, { k: 'po_no', label: 'PO' }, { k: 'vendor_dn_no', label: 'DN' },
        { k: 'item_code', label: 'Item' }, { k: 'item_name', label: 'Description' }, { k: 'dn_qty', label: 'DN qty', fmt: 'qty' }, { k: 'received_qty', label: 'Received', fmt: 'qty' },
        { k: 'damaged_qty', label: 'Damaged', fmt: 'qty' }, { k: 'accepted_qty', label: 'Accepted', fmt: 'qty' }, { k: 'excess_qty', label: 'Excess open', fmt: 'qty' }, { k: 'short_qty', label: 'Short vs DN', fmt: 'qty' },
        { k: r => num(r.short_qty) * num(r.unit_cost_aed), label: 'Short value (claim)', fmt: 'money', cost: true, sum: true }, { k: 'rejection_reason', label: 'Remarks' }];
    },
  },
  async mounted() { await this.load(); },
  methods: {
    qty, money, dt,
    async load() {
      this.loading = true;
      await run(async () => {
        this.holds = must(await sb.from('v_hold_stock').select('*').order('created_at'));
        this.exc = must(await sb.from('v_grn_exceptions').select('*').order('grn_date', { ascending: false }).limit(1000));
      });
      this.loading = false;
    },
    async decide(h, action) {
      if (action === 'ACCEPT' && !(await ask({ title: 'Accept excess', message: `Accept ${qty(h.qty_on_hand)} ${h.uom} of ${h.item_code} into stock? PO ${h.po_no} will be increased by this quantity and the Factory Manager informed.`, okText: 'Accept excess' }))) return;
      this.busy = true;
      const r = await run(() => rpc('grn_excess_decide', { p_lot: h.lot_id, p_action: action }));
      this.busy = false;
      if (r === 'ACCEPTED') { toast('Excess accepted into stock — PO amended', 'ok'); this.load(); }
      else if (r) { toast('Draft purchase return created — post it when the goods leave', 'ok'); go('d/prt/' + r); }
    },
    async openReturn(h) {
      const prt = must(await sb.from('purchase_returns').select('id').eq('grn_id', h.grn_id).eq('status', 'DRAFT').limit(1).maybeSingle());
      go(prt ? 'd/prt/' + prt.id : 'd/prt/new/grn/' + h.grn_id);
    },
    can(...r) { return hasRole(...r); },
  },
  template: `<div>
    <div class="card" v-if="!loading && !groups.length"><div class="empty">Nothing on hold in Quarantine</div></div>
    <div class="card" v-for="g in groups" :key="g.k">
      <div class="hd"><h3>{{ g.t }} ({{ g.rows.length }})</h3><span class="spacer"></span><button class="btn sm" @click="load">↻ Refresh</button></div>
      <div class="tbl-wrap"><table class="t lines">
        <thead><tr><th>Item</th><th>Lot</th><th>Source</th><th>For</th><th class="n">Qty</th><th class="n" v-if="$root.canSeeCost()">Value</th><th class="n">Days</th><th></th></tr></thead>
        <tbody><tr v-for="h in g.rows" :key="h.lot_id">
          <td>{{ h.item_code }} — {{ h.item_name }}</td><td class="small">{{ h.lot_no }}</td>
          <td class="small">{{ h.grn_no ? h.grn_no + (h.po_no ? ' / ' + h.po_no : '') : 'Floor return' }}<div class="muted">{{ h.vendor_name }}</div></td>
          <td class="small">{{ h.project_code || 'Stock' }}</td>
          <td class="n">{{ qty(h.qty_on_hand) }} {{ h.uom }}</td><td class="n" v-if="$root.canSeeCost()">{{ money(h.value) }}</td><td class="n">{{ h.age_days }}</td>
          <td style="white-space:nowrap">
            <template v-if="g.k === 'EXCESS'">
              <button class="btn sm ok" v-if="can('purchase') && h.po_no" :disabled="busy" @click="decide(h, 'ACCEPT')">Accept (amend PO)</button>
              <button class="btn sm" v-if="can('purchase', 'stores')" :disabled="busy" @click="decide(h, 'RETURN')">Return to supplier</button>
            </template>
            <template v-else-if="g.k === 'DAMAGED'">
              <button class="btn sm" v-if="can('purchase', 'stores')" @click="openReturn(h)">Purchase return</button>
              <button class="btn sm" v-if="can('stores')" @click="$root.nav('d/trf/new/lot/' + h.lot_id)">Usable — release to stock</button>
            </template>
            <template v-else>
              <button class="btn sm" v-if="can('stores')" @click="$root.nav('d/trf/new/lot/' + h.lot_id)">Repaired / usable — release</button>
              <button class="btn sm bad" v-if="can('stores', 'production_incharge')" @click="$root.nav('d/scrap/new/lot/' + h.lot_id)">Scrap</button>
            </template>
          </td>
        </tr></tbody>
      </table></div>
    </div>
    <div class="card">
      <h3>Supplier receipt exceptions (short vs DN, damaged, excess)</h3>
      <DataTable :columns="excCols" :rows="exc" :loading="loading" filename="grn_exceptions" />
    </div>
  </div>`,
};

// ======================================================================
// BUFFER REVIEW (dynamic buffer management suggestions)
// ======================================================================
export const BufferReview = {
  components: { DataTable, Badge },
  data: () => ({ tab: 'pending', pending: [], history: [], loading: true, busy: false, dbmItems: 0 }),
  computed: {
    canDecide() { return hasRole('purchase', 'factory_manager'); },
    histCols() {
      return [{ k: 'created_at', label: 'Suggested', fmt: 'datetime' }, { k: r => r.items?.code, label: 'Item' }, { k: r => r.items?.name, label: 'Name' },
        { k: 'source', label: 'Source', fmt: 'label' }, { k: 'direction', label: 'Direction', fmt: 'label' }, { k: 'current_target', label: 'From', fmt: 'qty' },
        { k: r => r.applied_target ?? r.suggested_target, label: 'To', fmt: 'qty' }, { k: 'status', label: 'Status', fmt: 'badge' },
        { k: r => r.profiles?.full_name || r.profiles?.email, label: 'Decided by' }, { k: 'decided_at', label: 'When', fmt: 'datetime' }, { k: r => r.comments || r.reason, label: 'Reason / comments' }];
    },
  },
  async mounted() { await this.load(); },
  methods: {
    qty, label,
    async load() {
      this.loading = true;
      await run(async () => {
        const sel = '*, items(code,name,lead_time_days,moq,order_multiple,uoms(code)), profiles:decided_by(full_name,email)';
        const p = must(await sb.from('buffer_suggestions').select(sel).eq('status', 'PENDING').order('created_at'));
        const zones = p.length ? must(await sb.from('v_item_stock').select('item_id,buffer_zone,available,on_order,net_flow_position').in('item_id', p.map(x => x.item_id))) : [];
        p.forEach(x => { const z = zones.find(q => q.item_id === x.item_id) || {}; Object.assign(x, { _zone: z.buffer_zone, _nfp: z.net_flow_position, _target: Number(x.suggested_target) }); });
        this.pending = p;
        this.history = must(await sb.from('buffer_suggestions').select(sel).neq('status', 'PENDING').order('created_at', { ascending: false }).limit(1000));
        const { count } = await sb.from('items').select('id', { count: 'exact', head: true }).eq('dbm_enabled', true).gt('buffer_target', 0);
        this.dbmItems = count || 0;
      });
      this.loading = false;
    },
    async runNow() {
      this.busy = true;
      const n = await run(() => rpc('dbm_run'));
      this.busy = false;
      if (n !== undefined) { toast(`${n} new suggestion(s)`, n ? 'ok' : 'info'); await this.load(); refreshPendingSafe(); }
    },
    async decide(x, action) {
      let comments = null;
      if (action === 'REJECT') {
        const v = await ask({ title: 'Reject suggestion for ' + x.items.code, fields: [{ k: 'c', label: 'Reason', type: 'textarea' }], okText: 'Reject' });
        if (!v) return; comments = v.c || null;
      }
      this.busy = true;
      const ok = await run(() => rpc('dbm_decide', { p_id: x.id, p_action: action, p_target: action === 'ACCEPT' ? Number(x._target) : null, p_comments: comments }),
        action === 'ACCEPT' ? `Buffer for ${x.items.code} set to ${qty(x._target)}` : 'Suggestion rejected');
      this.busy = false;
      if (ok) { await this.load(); refreshPendingSafe(); }
    },
  },
  template: `<div>
    <div class="tabs">
      <a href="javascript:void 0" :class="{on: tab==='pending'}" @click="tab='pending'">Pending suggestions ({{ pending.length }})</a>
      <a href="javascript:void 0" :class="{on: tab==='history'}" @click="tab='history'">History</a>
    </div>
    <div class="card" v-if="tab==='pending'">
      <div class="hd"><h3>Dynamic buffer management</h3><span class="spacer"></span>
        <span class="muted small">{{ dbmItems }} items have DBM switched on</span>
        <button class="btn" v-if="canDecide" :disabled="busy" @click="runNow">↻ Run check now</button></div>
      <p class="small muted" style="margin-top:0">Checked every night at 01:00. Too long in <b>RED</b> (longer than the lead time) → raise the buffer by ⅓. Too long in <b>GREEN/above</b> (longer than 2 × lead time) → lower it by ⅓, never below MOQ.
        Switch DBM on per item in the Item master. You can edit the new target before accepting.</p>
      <div class="tbl-wrap">
        <table class="t lines">
          <thead><tr><th>Item</th><th>Zone now</th><th class="n">Days</th><th>Why</th><th class="n">Current</th><th>New target</th><th v-if="canDecide"></th></tr></thead>
          <tbody>
            <tr v-if="loading"><td colspan="7" class="empty">Loading…</td></tr>
            <tr v-else-if="!pending.length"><td colspan="7" class="empty">No pending suggestions</td></tr>
            <tr v-for="x in pending" :key="x.id">
              <td>{{ x.items.code }} — {{ x.items.name }} <span class="muted small">({{ x.items.uoms?.code }}, lead {{ x.items.lead_time_days }} d)</span></td>
              <td><Badge :v="x._zone" /></td>
              <td class="n">{{ x.days_in_zone }}</td>
              <td class="small">{{ x.reason }}</td>
              <td class="n">{{ qty(x.current_target) }}</td>
              <td style="width:120px"><input type="number" v-model.number="x._target" :disabled="!canDecide"> <span class="small" :style="{color: x.direction==='INCREASE' ? '#b91c1c' : '#15803d'}">{{ x.direction==='INCREASE' ? '▲' : '▼' }}</span></td>
              <td v-if="canDecide" style="white-space:nowrap"><button class="btn sm ok" :disabled="busy" @click="decide(x,'ACCEPT')">Accept</button> <button class="btn sm bad" :disabled="busy" @click="decide(x,'REJECT')">Reject</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div class="card" v-else><DataTable :columns="histCols" :rows="history" :loading="loading" filename="buffer_history" /></div>
  </div>`,
};
function refreshPendingSafe() { refreshPending().catch(() => {}); }

// ======================================================================
// TOOL CRIB & ASSET REGISTER
// ======================================================================
const MOVES = [
  { t: 'ISSUE', l: 'Issue to worker', st: ['IN_STORE'], roles: ['stores'] },
  { t: 'RETURN', l: 'Return to store', st: ['ISSUED', 'INSTALLED'], roles: ['stores'] },
  { t: 'INSTALL', l: 'Install / assign', st: ['IN_STORE', 'INSTALLED'], roles: ['stores'] },
  { t: 'TRANSFER', l: 'Transfer location', st: ['IN_STORE', 'INSTALLED', 'ISSUED'], roles: ['stores'] },
  { t: 'REPAIR_OUT', l: 'Send for repair', st: ['IN_STORE', 'INSTALLED', 'ISSUED'], roles: ['stores'] },
  { t: 'REPAIR_IN', l: 'Back from repair', st: ['UNDER_REPAIR'], roles: ['stores'] },
  { t: 'CALIBRATION', l: 'Record calibration', st: ['IN_STORE', 'INSTALLED', 'ISSUED', 'AT_CALIBRATION'], roles: ['stores'] },
  { t: 'LOST', l: 'Mark lost', st: ['IN_STORE', 'INSTALLED', 'ISSUED', 'UNDER_REPAIR'], roles: ['factory_manager'] },
  { t: 'SCRAP', l: 'Scrap asset', st: ['IN_STORE', 'INSTALLED', 'UNDER_REPAIR'], roles: ['factory_manager'] },
];
export const Assets = {
  components: { DataTable, Modal, FieldInput, Badge },
  props: { tag: String },     // opened from a scanned tool label
  data: () => ({ rows: [], loading: true, sel: null, hist: [], cls: '', st: '', edit: null }),
  computed: {
    cols() { return [{ k: 'asset_tag', label: 'Tag' }, { k: 'item_name', label: 'Item' }, { k: 'class_code', label: 'Class' }, { k: 'serial_no', label: 'Serial' }, { k: 'location_name', label: 'Location' },
      { k: 'custodian_name', label: 'Custodian' }, { k: 'due_back', label: 'Due back', fmt: 'date' }, { k: 'purchase_date', label: 'Purchased', fmt: 'date' }, { k: 'purchase_cost', label: 'Cost', fmt: 'money', cost: true, sum: true },
      { k: 'calibration_due_date', label: 'Calib. due', fmt: 'date' }, { k: r => r.is_overdue ? 'OVERDUE' : r.status, label: 'Status', fmt: 'badge' }]; },
    classes() { return [...new Set(this.rows.map(r => r.class_code))].sort(); },
    shown() { return this.rows.filter(r => (!this.cls || r.class_code === this.cls) && (!this.st || r.status === this.st)); },
    moves() { return this.sel ? MOVES.filter(m => m.st.includes(this.sel.status) && hasRole(...m.roles)) : []; },
  },
  async mounted() {
    await loadRefs(['employees', 'locations', 'projects', 'cost_centers']); await this.load();
    if (this.tag) { const r = this.rows.find(x => x.asset_tag === this.tag); if (r) this.open(r); }
  },
  methods: {
    label,
    async load() { this.loading = true; await run(async () => { this.rows = must(await sb.from('v_asset_register').select('*').order('asset_tag')); }); this.loading = false; },
    async open(r) {
      this.sel = r;
      this.edit = { serial_no: r.serial_no, warranty_expiry: r.warranty_expiry, useful_life_years: r.useful_life_years, remarks: r.remarks };
      this.hist = must(await sb.from('asset_movements').select('*, employees(name), f:from_location_id(code), t:to_location_id(code), projects(code)').eq('asset_id', r.id).order('moved_at', { ascending: false }));
    },
    async move(m) {
      const fields = [];
      if (['ISSUE', 'INSTALL'].includes(m.t)) fields.push({ k: 'emp', label: m.t === 'ISSUE' ? 'Employee' : 'Custodian (optional)', type: 'ref', ref: 'employees', required: m.t === 'ISSUE' });
      if (m.t === 'ISSUE') fields.push({ k: 'proj', label: 'Project (optional)', type: 'ref', ref: 'projects' }, { k: 'due', label: 'Due back', type: 'date', default: today() });
      if (['INSTALL', 'TRANSFER', 'RETURN', 'REPAIR_IN'].includes(m.t)) fields.push({ k: 'loc', label: 'Location', type: 'ref', ref: 'locations', required: ['INSTALL', 'TRANSFER'].includes(m.t) });
      if (m.t === 'INSTALL') fields.push({ k: 'cc', label: 'Cost centre', type: 'ref', ref: 'cost_centers' });
      if (m.t === 'RETURN') fields.push({ k: 'cond', label: 'Condition', type: 'select', required: true, options: ['GOOD', 'DAMAGED', 'NEEDS_REPAIR'], default: 'GOOD' });
      fields.push({ k: 'rem', label: 'Remarks', type: 'textarea' });
      const v = await ask({ title: `${m.l} — ${this.sel.asset_tag}`, fields, okText: m.l });
      if (!v) return;
      const no = await run(() => rpc('asset_move', { p_asset: this.sel.id, p_type: m.t, p_employee: v.emp || null, p_project: v.proj || null, p_cost_center: v.cc || null,
        p_to_location: v.loc || null, p_due_back: v.due || null, p_condition: v.cond || null, p_remarks: v.rem || null }));
      if (no) { toast(`${m.l}: ${no}`, 'ok'); await this.load(); await this.open(this.rows.find(r => r.id === this.sel.id)); }
    },
    async saveDetails() {
      const ok = await run(async () => must(await sb.from('assets').update(this.edit).eq('id', this.sel.id)), 'Saved');
      if (ok) await this.load();
    },
  },
  template: `<div>
    <div class="card">
      <div class="hd"><h3>Asset register & tool crib</h3><span class="spacer"></span>
        <select v-model="cls" style="max-width:160px"><option value="">All classes</option><option v-for="c in classes">{{ c }}</option></select>
        <button class="btn sm" @click="$root.nav('labels/assets')">🏷 Print tool labels</button>
        <select v-model="st" style="max-width:160px"><option value="">All statuses</option><option v-for="s in ['IN_STORE','ISSUED','INSTALLED','UNDER_REPAIR','LOST','SCRAPPED']" :value="s">{{ label(s) }}</option></select>
      </div>
      <p class="small muted" style="margin-top:0">Machines, tools, office & camp equipment are registered automatically (one asset tag per unit) when their GRN is posted.</p>
      <DataTable :columns="cols" :rows="shown" :loading="loading" clickable @row="open" filename="asset_register" />
    </div>
    <Modal v-if="sel" :title="sel.asset_tag + ' — ' + sel.item_name" @close="sel=null">
      <div class="row" style="margin-bottom:12px"><Badge :v="sel.status" /><span class="muted">{{ sel.class_name }} · {{ sel.location_name }}</span><span v-if="sel.custodian_name">· with <b>{{ sel.custodian_name }}</b></span></div>
      <div class="row" style="margin-bottom:14px"><button v-for="m in moves" class="btn" @click="move(m)">{{ m.l }}</button></div>
      <div class="grid" style="margin-bottom:12px">
        <label class="f">Serial no.<input v-model="edit.serial_no"></label>
        <label class="f">Warranty expiry<input type="date" v-model="edit.warranty_expiry"></label>
        <label class="f">Useful life (years)<input type="number" v-model.number="edit.useful_life_years"></label>
        <label class="f wide">Remarks<input v-model="edit.remarks"></label>
        <label class="f">&nbsp;<button class="btn" v-if="$root.hasRole('stores')" @click="saveDetails">Save details</button></label>
      </div>
      <h3 style="font-size:13px">Movement history</h3>
      <DataTable :searchable="false" :rows="hist" :columns="[{k:'moved_at',label:'When',fmt:'datetime'},{k:'doc_no',label:'Doc'},{k:'move_type',label:'Move',fmt:'label'},{k:r=>r.employees?.name,label:'Employee'},{k:r=>r.f?.code,label:'From'},{k:r=>r.t?.code,label:'To'},{k:r=>r.projects?.code,label:'Project'},{k:'due_back',label:'Due back',fmt:'date'},{k:'condition',label:'Condition',fmt:'label'},{k:'remarks',label:'Remarks'}]" />
    </Modal>
  </div>`,
};

// ======================================================================
// SIGNATURES — one image per user, printed on documents once that person's step is done
// ======================================================================
// trims the white / transparent margin and scales to at most 600 x 200, returned as a PNG data URL
function cleanSignature(src) {
  const W = src.width, H = src.height, px = src.getContext('2d').getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (px[i + 3] > 20 && (px[i] < 200 || px[i + 1] < 200 || px[i + 2] < 200)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) throw new Error('The signature is empty');
  const w = x1 - x0 + 1, h = y1 - y0 + 1, s = Math.min(1, 600 / w, 200 / h);
  const out = document.createElement('canvas'); out.width = Math.round(w * s); out.height = Math.round(h * s);
  const g = out.getContext('2d');
  g.drawImage(src, x0, y0, w, h, 0, 0, out.width, out.height);
  // white paper → transparent, so the signature sits cleanly on the printed page
  const d = g.getImageData(0, 0, out.width, out.height);
  for (let i = 0; i < d.data.length; i += 4) if (d.data[i] > 220 && d.data[i + 1] > 220 && d.data[i + 2] > 220) d.data[i + 3] = 0;
  g.putImageData(d, 0, 0);
  return out.toDataURL('image/png');
}
export const SignatureBox = {
  props: { userId: { type: String, required: true } },
  data: () => ({ image: null, drawing: false, mode: 'view', busy: false }),
  async mounted() { await this.load(); },
  methods: {
    async load() { await run(async () => { this.image = must(await sb.from('user_signatures').select('image').eq('user_id', this.userId).maybeSingle())?.image || null; }); },
    startDraw() {
      this.mode = 'draw';
      this.$nextTick(() => { const c = this.$refs.pad, g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.lineWidth = 2.6; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#0b2a6b'; });
    },
    pos(e) { const r = this.$refs.pad.getBoundingClientRect(); return [(e.clientX - r.left) * this.$refs.pad.width / r.width, (e.clientY - r.top) * this.$refs.pad.height / r.height]; },
    down(e) { this.drawing = true; this.$refs.pad.setPointerCapture(e.pointerId); const g = this.$refs.pad.getContext('2d'); g.beginPath(); g.moveTo(...this.pos(e)); },
    move(e) { if (!this.drawing) return; const g = this.$refs.pad.getContext('2d'); g.lineTo(...this.pos(e)); g.stroke(); },
    up() { this.drawing = false; },
    clearPad() { this.startDraw(); },
    async saveDrawn() { await this.store(() => cleanSignature(this.$refs.pad)); },
    async upload(e) {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      await this.store(async () => {
        const img = new Image(); img.src = URL.createObjectURL(f);
        await img.decode().catch(() => { throw new Error('Choose a PNG or JPG image of the signature'); });
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0);
        return cleanSignature(c);
      });
    },
    async store(make) {
      this.busy = true;
      const ok = await run(async () => {
        const image = await make();
        must(await sb.from('user_signatures').upsert({ user_id: this.userId, image, updated_at: new Date().toISOString() }));
        this.image = image;
      }, 'Signature saved');
      this.busy = false;
      if (ok) this.mode = 'view';
    },
    async remove() {
      if (!await ask({ title: 'Remove signature?', message: 'Documents will print a blank signature line until a new one is stored.', fields: [], okText: 'Remove', danger: true })) return;
      if (await run(async () => must(await sb.from('user_signatures').delete().eq('user_id', this.userId)), 'Signature removed')) this.image = null;
    },
  },
  template: `<div>
    <div v-if="mode==='view'" class="row" style="align-items:center;gap:12px;flex-wrap:wrap">
      <div style="width:240px;height:84px;border:1px dashed var(--line);border-radius:6px;display:flex;align-items:center;justify-content:center;background:#fff">
        <img v-if="image" :src="image" alt="Stored signature" style="max-width:228px;max-height:76px">
        <span v-else class="small muted">No signature stored</span>
      </div>
      <button class="btn sm" @click="startDraw">✍ Draw</button>
      <label class="btn sm" style="cursor:pointer">⬆ Upload image<input type="file" accept="image/png,image/jpeg" style="display:none" @change="upload"></label>
      <button class="btn sm bad" v-if="image" @click="remove">Remove</button>
    </div>
    <div v-else>
      <canvas ref="pad" width="720" height="240" style="width:100%;max-width:480px;aspect-ratio:3/1;border:1px solid var(--line);border-radius:6px;background:#fff;touch-action:none;cursor:crosshair"
        @pointerdown="down" @pointermove="move" @pointerup="up" @pointerleave="up"></canvas>
      <div class="row" style="margin-top:6px;gap:8px"><span class="small muted">Sign inside the box with the mouse, a finger or a stylus.</span><span class="spacer"></span>
        <button class="btn sm" @click="clearPad">Clear</button><button class="btn sm" @click="mode='view'">Cancel</button><button class="btn sm primary" :disabled="busy" @click="saveDrawn">Save signature</button></div>
    </div>
  </div>`,
};
// every user: their own signature (printed on the documents they prepare, check or authorise)
export const MySignature = {
  components: { SignatureBox },
  computed: { me: () => state.profile },
  template: `<div class="card" style="max-width:640px">
    <h3 style="margin-top:0">My signature</h3>
    <p class="small muted" style="margin-top:0">Stored once and printed on the documents you prepare, check or authorise — only after your step is done.
      Draw it here or upload a scan / photo of your signature on white paper (the background is removed automatically).</p>
    <SignatureBox :user-id="me.id" />
    <p class="small" style="margin-bottom:0">Printed as: <b>{{ me.full_name || me.email }}</b> · {{ me.job_title || $root.ROLES[me.role] }}
      <span class="muted">(the job title is set by the administrator in Users &amp; roles)</span></p>
  </div>`,
};

// ======================================================================
// USERS (admin)
// ======================================================================
export const Users = {
  components: { DataTable, Modal, SignatureBox },
  data: () => ({ rows: [], loading: true, edit: null, nu: null, busy: false }),
  computed: {
    roles() { return Object.entries(ROLES).map(([v, l]) => ({ v, l })); },
    dashKeys: () => Object.keys(DASHBOARDS),
  },
  async mounted() { await this.load(); },
  methods: {
    DASHBOARDS,
    async load() { this.loading = true; await run(async () => { this.rows = must(await sb.from('profiles').select('*').order('created_at')); }); this.loading = false; },
    // ticked = the dashboards the user sees; none ticked = the role's default
    open(r) { this.edit = { ...r, _dash: [...(r.dashboards || [])] }; },
    dashText(r) { return userDashboards(r).map(k => DASHBOARDS[k].title).join(', ') + (r.dashboards?.length ? '' : ' (default)'); },
    defaultDash(role) { return userDashboards({ role }).map(k => DASHBOARDS[k].title).join(', '); },
    async save() {
      const e = this.edit;
      const dashboards = e._dash.length ? this.dashKeys.filter(k => e._dash.includes(k)) : null;
      const ok = await run(async () => must(await sb.from('profiles').update({ full_name: e.full_name, job_title: e.job_title || null, role: e.role, is_active: e.is_active, employee_code: e.employee_code, dashboards }).eq('id', e.id)), 'User updated');
      if (ok) {
        if (e.id === state.profile?.id) state.profile.dashboards = dashboards;
        this.edit = null; this.load(); loadRef('profiles', true);
      }
    },
    async create() {
      const u = this.nu;
      if (!u.email || !u.password || u.password.length < 8) return toast('Email and a password of at least 8 characters are required', 'error');
      this.busy = true;
      const ok = await run(async () => {
        const { data, error } = await sb.functions.invoke('admin-users', { body: { action: 'create', ...u } });
        if (error) throw new Error((await error.context?.json?.())?.error || error.message);
        if (data?.error) throw new Error(data.error);
      }, 'User created — share the email and temporary password with them');
      this.busy = false;
      if (ok) { this.nu = null; this.load(); }
    },
    async resetPw(r) {
      const v = await ask({ title: 'Set new password for ' + r.email, fields: [{ k: 'pw', label: 'New password (min 8 chars)', required: true }] });
      if (!v) return;
      await run(async () => {
        const { data, error } = await sb.functions.invoke('admin-users', { body: { action: 'reset_password', user_id: r.id, password: v.pw } });
        if (error) throw new Error((await error.context?.json?.())?.error || error.message);
        if (data?.error) throw new Error(data.error);
      }, 'Password updated');
    },
  },
  template: `<div>
    <div class="row" style="margin-bottom:12px"><span class="muted small">Create each user here with a temporary password and role — they can sign in straight away (no email needed). Use Reset password when someone forgets theirs.</span><span class="spacer"></span>
      <button class="btn primary" @click="nu={email:'',password:'',full_name:'',role:'shop_floor'}">+ Create user</button></div>
    <div class="card"><DataTable :rows="rows" :loading="loading" clickable @row="open" filename="users"
      :columns="[{k:'full_name',label:'Name'},{k:'email',label:'Email'},{k:r=>$root.ROLES[r.role],label:'Role'},{k:'employee_code',label:'Emp code'},{k:dashText,label:'Dashboards'},{k:r=>r.is_active?'ACTIVE':'BLOCKED',label:'Status',fmt:'badge'},{k:'created_at',label:'Created',fmt:'date'}]" /></div>
    <Modal v-if="edit" :title="'User — ' + edit.email" small @close="edit=null">
      <div class="grid">
        <label class="f full">Full name<input v-model="edit.full_name"></label>
        <label class="f full">Job title (printed under the signature; blank = role name)<input v-model="edit.job_title" placeholder="e.g. Procurement Associate"></label>
        <label class="f">Role<select v-model="edit.role"><option v-for="r in roles" :value="r.v">{{ r.l }}</option></select></label>
        <label class="f">Employee code<input v-model="edit.employee_code"></label>
        <label class="f">Active<span class="row"><input type="checkbox" v-model="edit.is_active"> can log in</span></label>
        <div class="f full"><span>Dashboards this user sees</span>
          <div class="row" style="flex-wrap:wrap;gap:6px 14px;margin-top:4px">
            <label v-for="k in dashKeys" :key="k" class="row small" style="gap:4px"><input type="checkbox" :value="k" v-model="edit._dash">{{ DASHBOARDS[k].title }}</label>
          </div>
          <span class="small muted">None ticked = the role's default ({{ defaultDash(edit.role) }}). With more than one, the user gets a Dashboards menu; the first ticked (in this order) opens at sign-in.</span>
        </div>
        <div class="f full"><span>Signature (printed on documents)</span><SignatureBox :user-id="edit.id" :key="edit.id" /></div>
      </div>
      <template #footer><button class="btn" @click="resetPw(edit)">Reset password</button><span class="spacer"></span><button class="btn" @click="edit=null">Close</button><button class="btn primary" @click="save">Save</button></template>
    </Modal>
    <Modal v-if="nu" title="Create user" small @close="nu=null">
      <div class="grid">
        <label class="f full">Full name<input v-model="nu.full_name"></label>
        <label class="f full">Email (login)<input v-model="nu.email" type="email"></label>
        <label class="f full">Temporary password<input v-model="nu.password"></label>
        <label class="f full">Role<select v-model="nu.role"><option v-for="r in roles" :value="r.v">{{ r.l }}</option></select></label>
      </div>
      <template #footer><button class="btn" @click="nu=null">Cancel</button><button class="btn primary" :disabled="busy" @click="create">Create</button></template>
    </Modal>
  </div>`,
};

// ======================================================================
// SETTINGS (admin)
// ======================================================================
export const Settings = {
  components: { FieldInput },
  data: () => ({ c: null }),
  computed: {
    fields() {
      return [
        { k: 'company_name', label: 'Company name', required: true, full: true }, { k: 'trn', label: 'Company TRN' }, { k: 'phone', label: 'Phone' }, { k: 'email', label: 'Email' },
        { k: 'trade_license_no', label: 'Trade licence no. (printed on documents)' }, { k: 'trade_license_authority', label: 'Licence issued by', wide: true },
        { k: 'address', label: 'Address', type: 'textarea', full: true },
        { k: 'emirate', label: 'Emirate (VAT return box 1)', type: 'select', options: ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'].map(v => ({ v, l: v })) },
        { k: 'expense_approval_limit', label: 'Expenses above AED … need Factory Manager approval', type: 'number' },
        { k: 'default_vat_rate', label: 'Default VAT %', type: 'number' },
        // FTA assigns each business a quarterly stagger; the cash forecast puts VAT on the 28th after each quarter
        { k: 'vat_quarter_start_month', label: 'VAT quarters (as on your FTA tax certificate)', type: 'select', required: true,
          options: [{ v: 1, l: 'Jan–Mar, Apr–Jun, Jul–Sep, Oct–Dec' }, { v: 2, l: 'Feb–Apr, May–Jul, Aug–Oct, Nov–Jan' }, { v: 3, l: 'Mar–May, Jun–Aug, Sep–Nov, Dec–Feb' }] },
        { k: 'grn_over_receipt_pct', label: 'Allowed over-receipt vs PO %', type: 'number' },
        { k: 'overstock_months', label: 'Overstock if cover > months', type: 'number' },
        { k: 'budget_warn_pct', label: 'Project budget warning at %', type: 'number' },
        { k: 'dbm_min_red_days', label: 'DBM: min days in RED before raising', type: 'number' },
        { k: 'dbm_min_green_days', label: 'DBM: min days in GREEN before lowering', type: 'number' },
        { k: 'dbm_step_pct', label: 'DBM: adjustment step %', type: 'number' }, { k: 'abc_a_pct', label: 'ABC: A up to cumulative %', type: 'number' }, { k: 'abc_b_pct', label: 'ABC: B up to cumulative %', type: 'number' },
        { k: 'mol_establishment_id', label: 'WPS: MOHRE establishment ID (13 digits)' }, { k: 'wps_bank_routing', label: 'WPS: employer bank routing code' },
        { k: 'wps_employer_ref', label: 'WPS: employer reference' },
        { k: 'ot_rate_normal_pct', label: 'Overtime % (normal)', type: 'number' }, { k: 'ot_rate_holiday_pct', label: 'Overtime % (night / rest day / holiday)', type: 'number' },
        { k: 'ot_basis', label: 'Overtime based on', type: 'select', options: [{ v: 'BASIC', l: 'Basic salary' }, { v: 'GROSS', l: 'Gross salary' }] },
        { k: 'labour_rate_per_hour', label: 'Production: labour rate AED / man-hour', type: 'number' },
        { k: 'power_tariff_aed_kwh', label: 'Electricity tariff AED / kWh (machine-rate calculator)', type: 'number' },
        { k: 'overhead_pct', label: 'Production: overhead % on labour + machine', type: 'number' },
        { k: 'board_waste_pct', label: 'Production: board waste % (cut list)', type: 'number' },
        { k: 'edge_waste_pct', label: 'Production: edge band waste %', type: 'number' },
        // estimated completion of production batches
        { k: 'plan_hours_per_day', label: 'Planning: hours per day per machine / person', type: 'number' },
        { k: 'plan_efficiency_pct', label: 'Planning: plan at % of that capacity', type: 'number' },
        { k: '_week_off', label: 'Planning: weekly off day', type: 'select',
          options: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((l, v) => ({ v, l })) },
        // printed documents (house style)
        { k: 'doc_company_code', label: 'Document numbers: company code (PO-CH26-10-001)', required: true },
        { k: 'auth_sign_name', label: 'Approved & Authorized Signatory — name', required: true },
        { k: 'auth_sign_title', label: 'Authorized Signatory — title', required: true },
        { k: 'auth_sign_user_id', label: 'Authorized Signatory — CitiCore user (their stored signature prints)', type: 'select',
          options: [{ v: '', l: '— none (blank signature line) —' }, ...(state.refs.profiles || []).map(p => ({ v: p.id, l: p.full_name || p.email }))] },
        { k: '_terms_goods', label: 'PO standard terms — Goods (one per line; {delivery_days} and {company} are filled in)', type: 'textarea', full: true },
        { k: '_terms_works', label: 'PO standard terms — Works / contractor (one per line)', type: 'textarea', full: true },
      ];
    },
  },
  mounted() { const c = state.company || {}; this.c = { ...c, auth_sign_user_id: c.auth_sign_user_id || '', _terms_goods: (c.po_terms_goods || []).join('\n'), _terms_works: (c.po_terms_works || []).join('\n'), _week_off: (c.plan_week_off || [5])[0] }; },
  methods: {
    async save() {
      const row = {}; this.fields.filter(f => !f.k.startsWith('_')).forEach(f => { row[f.k] = this.c[f.k]; });
      const lines = t => String(t || '').split('\n').map(s => s.trim()).filter(Boolean);
      row.po_terms_goods = lines(this.c._terms_goods); row.po_terms_works = lines(this.c._terms_works);
      row.auth_sign_user_id = row.auth_sign_user_id || null;
      row.plan_week_off = [Number(this.c._week_off ?? 5)];
      row.doc_company_code = String(row.doc_company_code || '').trim().toUpperCase();
      row.vat_quarter_start_month = Number(row.vat_quarter_start_month) || 1;
      const ok = await run(async () => must(await sb.from('company_settings').update(row).eq('id', 1)), 'Settings saved');
      if (ok) await loadCompany();
    },
  },
  template: `<div class="card" v-if="c">
    <div class="grid"><FieldInput v-for="f in fields" :key="f.k" :f="f" :doc="c" :disabled="!$root.hasRole()" /></div>
    <div class="row" style="margin-top:14px"><span class="spacer"></span><button class="btn primary" v-if="$root.hasRole()" @click="save">Save settings</button></div>
  </div>`,
};
