// Master data: generic list + modal form, and per-master configuration
import { sb, state, must, run, hasRole, loadRefs, loadRef, refRow, refLabel, money, qty, label, num, LOOKUP_LISTS } from './lib.js';
import { FieldInput, DataTable, Modal, CURRENCIES } from './components.js';

const LOOKUP_KEEPERS = [...new Set(Object.values(LOOKUP_LISTS).flatMap(l => l.owners))];

const EMIRATES = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'];

async function nextCode(table, prefix, width = 4) {
  const rows = must(await sb.from(table).select('code').ilike('code', `${prefix}%`).order('code', { ascending: false }).limit(200));
  let max = 0;
  rows.forEach(r => { const m = r.code.slice(prefix.length).match(/^(\d+)$/); if (m) max = Math.max(max, Number(m[1])); });
  return prefix + String(max + 1).padStart(width, '0');
}

// batch / expiry apply to stocked lot items (not serialised assets or non-stock services)
const YES_NO = [{ v: true, l: 'Yes' }, { v: false, l: 'No' }];
const isStockItem = d => { const c = refRow('item_classes', d.class_id); return !!c && c.tracking === 'LOT' && c.valuation_method !== 'EXPENSE'; };
const itemUsed = d => !!d.id && (d.stock_ledger?.[0]?.count || 0) > 0;

export const MASTERS = {
  items: {
    title: 'Item Master', single: 'Item', table: 'items', order: 'code', editRoles: ['stores', 'purchase'],
    refs: ['item_classes', 'item_categories', 'uoms', 'locations'],
    // stock_ledger(count) tells whether the item has been used (batch / expiry answers are then frozen)
    select: '*, item_classes(code,name), item_categories(name), uoms(code), stock_ledger(count)',
    columns: [
      { k: 'code', label: 'Code' }, { k: 'name', label: 'Name' }, { k: r => r.item_classes?.code, label: 'Class' }, { k: r => r.item_categories?.name, label: 'Category' },
      { k: r => r.uoms?.code, label: 'UoM' }, { k: 'brand', label: 'Brand' },
      { k: r => r.batch_controlled ? 'Yes' : '', label: 'Batch' }, { k: r => r.has_expiry ? (r.shelf_life_days ? `${r.shelf_life_days} d` : 'Yes') : '', label: 'Expiry' },
      { k: 'buffer_target', label: 'Buffer', fmt: 'qty' }, { k: 'moq', label: 'MOQ', fmt: 'qty' },
      { k: 'lead_time_days', label: 'Lead days', n: true }, { k: 'last_purchase_rate', label: 'Last rate', fmt: 'money', cost: true }, { k: 'is_active', label: 'Active', fmt: 'bool' },
    ],
    defaults: () => ({ is_active: true, vat_rate: 5, safety_stock: 0, reorder_level: 0, reorder_qty: 0, max_stock: 0, moq: 0, order_multiple: 0, lead_time_days: 0, buffer_target: 0, standard_cost: 0, dbm_enabled: false }),
    validate(d) {
      const toBool = v => v === true || v === 'true';
      if (!isStockItem(d)) { d.batch_controlled = false; d.has_expiry = false; d.shelf_life_days = null; return; }
      if (d.batch_controlled === undefined || d.batch_controlled === null || d.batch_controlled === '') throw new Error('Answer "Batch control required?" (Yes / No)');
      if (d.has_expiry === undefined || d.has_expiry === null || d.has_expiry === '') throw new Error('Answer "Has expiry date?" (Yes / No)');
      d.batch_controlled = toBool(d.batch_controlled); d.has_expiry = toBool(d.has_expiry);
      if (!d.has_expiry) d.shelf_life_days = null;
    },
    sections: [
      { title: 'Identification', fields: [
        { k: 'class_id', label: 'Item class', type: 'ref', ref: 'item_classes', required: true,
          onChange: async (d, v) => { d.category_id = null; const c = refRow('item_classes', v); if (c && !d.id) d.code = await nextCode('items', c.code + '-'); } },
        { k: 'category_id', label: 'Category', type: 'ref', ref: 'item_categories', filter: (r, d) => r.class_id === d.class_id && r.is_active },
        { k: 'code', label: 'Item code', required: true },
        { k: 'name', label: 'Item name', required: true, wide: true },
        { k: 'uom_id', label: 'Stock UoM', type: 'ref', ref: 'uoms', required: true },
        { k: 'brand', label: 'Brand / make', type: 'lookup', list: 'BRAND' },
        { k: 'specification', label: 'Specification (grade, finish, colour)', wide: true },
        { k: 'length_mm', label: 'Length mm (full sheet / length — needed for offcuts)', type: 'number' }, { k: 'width_mm', label: 'Width mm (panels; blank for timber)', type: 'number' }, { k: 'thickness_mm', label: 'Thickness mm', type: 'number' },
        { k: 'description', label: 'Description', type: 'textarea', full: true },
        { k: 'is_active', label: 'Active', type: 'check' },
      ] },
      { title: 'Control & valuation', fields: [
        { k: 'valuation_override', label: 'Valuation (blank = class default)', type: 'select', options: [{ v: 'FIFO', l: 'FIFO' }, { v: 'WAVG', l: 'Weighted average' }],
          show: d => refRow('item_classes', d.class_id)?.valuation_method !== 'ASSET' },
        { k: '_classval', label: 'Class default', type: 'ro', virtual: true, fmt: (v, d) => label(refRow('item_classes', d.class_id)?.valuation_method || '') },
        { k: 'batch_controlled', label: 'Batch control required? * (supplier batch no. mandatory at GRN)', type: 'select', wide: true, options: YES_NO,
          show: isStockItem, ro: itemUsed },
        { k: 'has_expiry', label: 'Has expiry date? * (expiry mandatory at GRN, issued earliest-expiry first)', type: 'select', wide: true, options: YES_NO,
          show: isStockItem, ro: itemUsed },
        { k: 'shelf_life_days', label: 'Shelf life (days) — fills the expiry at GRN from mfg / receipt date', type: 'number', wide: true,
          show: d => isStockItem(d) && (d.has_expiry === true || d.has_expiry === 'true') },
        { k: '_frozen', label: 'Batch / expiry setting', type: 'ro', virtual: true, wide: true, show: d => isStockItem(d) && itemUsed(d),
          fmt: () => '🔒 Fixed — this item already has receipts or stock' },
        { k: 'vat_rate', label: 'VAT %', type: 'number' },
        { k: 'default_location_id', label: 'Default store location', type: 'ref', ref: 'locations', filter: r => r.is_stock },
        { k: 'calibration_interval_days', label: 'Calibration interval (days)', type: 'number', show: d => refRow('item_classes', d.class_id)?.needs_calibration },
      ] },
      { title: 'Buffer (TOC), MOQ & re-ordering', fields: [
        { k: 'buffer_target', label: 'TOC buffer target qty', type: 'number' },
        { k: 'dbm_enabled', label: 'Dynamic buffer mgmt', type: 'check' },
        { k: 'safety_stock', label: 'Safety stock', type: 'number' },
        { k: 'reorder_level', label: 'Re-order level (if no buffer)', type: 'number' },
        { k: 'reorder_qty', label: 'Re-order qty', type: 'number' },
        { k: 'max_stock', label: 'Maximum stock', type: 'number' },
        { k: 'moq', label: 'MOQ', type: 'number' },
        { k: 'order_multiple', label: 'Order multiple (pack size)', type: 'number' },
        { k: 'lead_time_days', label: 'Lead time (days)', type: 'number' },
      ] },
      { title: 'Costing', cost: true, fields: [
        { k: 'standard_cost', label: 'Standard / estimated cost', type: 'number' },
        { k: 'avg_cost', label: 'Weighted avg cost (system)', type: 'ro', fmt: v => money(v) },
        { k: 'last_purchase_rate', label: 'Last landed rate (system)', type: 'ro', fmt: v => money(v) },
      ] },
    ],
    note: 'Buffer zones: stock position ≤ ⅓ of target = RED (order urgently), ≤ ⅔ = YELLOW (order), ≤ target = GREEN, above = BLUE (overstock). Suggested order qty tops up to the target, respecting MOQ and order multiple.',
    afterSave: () => loadRef('items', true),
  },
  vendors: {
    title: 'Vendors', single: 'Vendor', table: 'vendors', order: 'name', editRoles: ['purchase', 'finance'], refs: ['payment_terms', 'item_classes'],
    select: '*, payment_terms(name)',
    columns: [{ k: 'code', label: 'Code' }, { k: 'name', label: 'Name' }, { k: 'vendor_type', label: 'Type', fmt: 'label' }, { k: 'trn', label: 'TRN' }, { k: 'emirate', label: 'Emirate' },
              { k: 'contact_person', label: 'Contact' }, { k: 'phone', label: 'Phone' }, { k: r => r.payment_terms?.name, label: 'Payment terms' }, { k: 'trade_license_expiry', label: 'Licence expiry', fmt: 'date' }, { k: 'status', label: 'Status', fmt: 'badge' }],
    defaults: () => ({ vendor_type: 'LOCAL', vat_registered: true, country: 'United Arab Emirates', currency: 'AED', status: 'ACTIVE', supplies_classes: [] }),
    async onNew(d) { d.code = await nextCode('vendors', 'V', 4); },
    sections: [
      { title: 'Vendor', fields: [
        { k: 'code', label: 'Vendor code', required: true }, { k: 'name', label: 'Legal name', required: true, wide: true },
        { k: 'vendor_type', label: 'Type', type: 'select', required: true, options: [{ v: 'LOCAL', l: 'Local (UAE)' }, { v: 'IMPORT', l: 'Import (overseas)' }],
          onChange: (d, v) => { if (v === 'IMPORT') { d.vat_registered = false; d.country = ''; } } },
        { k: 'status', label: 'Status', type: 'select', required: true, options: ['ACTIVE', 'ON_HOLD', 'BLOCKED'] },
        { k: 'rating', label: 'Rating (1-5)', type: 'number' },
        { k: 'supplies_classes', label: 'Supplies classes (RM, CON…)', type: 'tags', wide: true },
      ] },
      { title: 'UAE tax & licence', fields: [
        { k: 'vat_registered', label: 'VAT registered', type: 'check' },
        { k: 'trn', label: 'TRN (15 digits)', show: d => d.vat_registered },
        { k: 'trade_license_no', label: 'Trade licence no.' }, { k: 'trade_license_expiry', label: 'Licence expiry', type: 'date' },
      ] },
      { title: 'Contact', fields: [
        { k: 'contact_person', label: 'Contact person' }, { k: 'phone', label: 'Phone' }, { k: 'email', label: 'Email' },
        { k: 'emirate', label: 'Emirate', type: 'select', options: EMIRATES, show: d => d.vendor_type === 'LOCAL' },
        { k: 'country', label: 'Country' }, { k: 'address', label: 'Address', type: 'textarea', full: true },
      ] },
      { title: 'Commercial & bank', fields: [
        { k: 'currency', label: 'Currency', type: 'select', required: true, options: CURRENCIES }, { k: 'payment_term_id', label: 'Payment terms', type: 'ref', ref: 'payment_terms', required: true },
        { k: 'credit_limit', label: 'Credit limit AED', type: 'number' },
        { k: 'bank_name', label: 'Bank', type: 'lookup', list: 'BANK' }, { k: 'bank_account_name', label: 'Account name' }, { k: 'iban', label: 'IBAN', wide: true }, { k: 'swift_code', label: 'SWIFT' },
        { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
      ] },
    ],
    validate: d => { if (d.trn && !/^\d{15}$/.test(d.trn)) throw new Error('TRN must be exactly 15 digits'); },
    afterSave: () => loadRef('vendors', true),
  },
  customers: {
    title: 'Customers', single: 'Customer', table: 'customers', order: 'name', editRoles: ['finance', 'factory_manager'], refs: ['payment_terms'],
    select: '*, payment_terms(name)',
    columns: [{ k: 'code', label: 'Code' }, { k: 'name', label: 'Name' }, { k: 'trn', label: 'TRN' }, { k: 'emirate', label: 'Emirate' }, { k: 'contact_person', label: 'Contact' },
              { k: 'phone', label: 'Phone' }, { k: r => r.payment_terms?.name, label: 'Payment terms' }, { k: 'credit_limit', label: 'Credit limit', fmt: 'money', cost: true }, { k: 'status', label: 'Status', fmt: 'badge' }],
    defaults: () => ({ country: 'UAE', status: 'ACTIVE' }),
    async onNew(d) { d.code = await nextCode('customers', 'C', 4); },
    sections: [
      { title: 'Customer', fields: [
        { k: 'code', label: 'Customer code', required: true }, { k: 'name', label: 'Legal name (as on tax invoice)', required: true, wide: true },
        { k: 'trn', label: 'TRN (15 digits)' }, { k: 'status', label: 'Status', type: 'select', required: true, options: ['ACTIVE', 'BLOCKED', 'INACTIVE'] },
        { k: 'payment_term_id', label: 'Payment terms', type: 'ref', ref: 'payment_terms' }, { k: 'credit_limit', label: 'Credit limit AED', type: 'number' } ] },
      { title: 'Contact', fields: [
        { k: 'contact_person', label: 'Contact person' }, { k: 'phone', label: 'Phone' }, { k: 'email', label: 'Email' },
        { k: 'emirate', label: 'Emirate', type: 'select', options: EMIRATES }, { k: 'country', label: 'Country' },
        { k: 'address', label: 'Address', type: 'textarea', full: true }, { k: 'remarks', label: 'Remarks', type: 'textarea', full: true } ] },
    ],
    validate: d => { if (d.trn && !/^\d{15}$/.test(d.trn)) throw new Error('TRN must be exactly 15 digits'); },
    afterSave: () => loadRef('customers', true),
  },
  gl_accounts: {
    title: 'Chart of Accounts', single: 'Account', table: 'gl_accounts', order: 'sort_order', editRoles: ['finance'], refs: ['gl_accounts'],
    select: '*, parent:parent_id(code,name)',
    columns: [{ k: 'code', label: 'Code' }, { k: r => (r.is_group ? '' : '    ') + r.name, label: 'Account' }, { k: 'acc_type', label: 'Type', fmt: 'label' },
              { k: r => r.parent ? `${r.parent.code} ${r.parent.name}` : '', label: 'Under' }, { k: 'is_group', label: 'Heading', fmt: 'bool' },
              { k: 'system_key', label: 'Used by system for' }, { k: 'is_bank', label: 'Bank', fmt: 'bool' }, { k: 'is_active', label: 'Active', fmt: 'bool' }],
    defaults: () => ({ acc_type: 'EXPENSE', is_group: false, is_bank: false, is_active: true }),
    sections: [{ title: 'Account', fields: [
      { k: 'code', label: 'Code (4 digits)', required: true }, { k: 'name', label: 'Name', required: true, wide: true },
      { k: 'acc_type', label: 'Type', type: 'select', required: true, options: ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'] },
      { k: 'parent_id', label: 'Under heading', type: 'ref', ref: 'gl_accounts', filter: (r, d) => r.is_group && r.id !== d.id },
      { k: 'is_group', label: 'Heading (no postings)', type: 'check' }, { k: 'is_bank', label: 'Bank account (reconcile)', type: 'check' }, { k: 'is_active', label: 'Active', type: 'check' },
      { k: 'is_factory_overhead', label: 'Factory overhead (counts in actual vs absorbed)', type: 'check', show: d => d.acc_type === 'EXPENSE' },
      { k: 'system_key', label: 'Used by system for', type: 'ro' }] }],
    note: 'Accounts with a "used by system" key receive the automatic postings from stores, production, purchasing, payroll and billing — rename them freely, but do not delete them. Add more bank accounts, expense heads etc. as needed; the code decides the order.',
    validate: d => { if (!/^\d{4,6}$/.test(d.code || '')) throw new Error('Code must be 4–6 digits'); },
    afterSave: () => loadRef('gl_accounts', true),
  },
  cc_budgets: {
    title: 'Expense Budgets', single: 'Budget', table: 'cc_budgets', order: 'period_month', editRoles: ['finance'], refs: ['cost_centers', 'gl_accounts'],
    select: '*, cost_centers(code,name), gl_accounts(code,name)',
    columns: [{ k: r => new Date(r.period_month + 'T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }), label: 'Month' },
      { k: r => `${r.cost_centers?.code} — ${r.cost_centers?.name}`, label: 'Cost centre' }, { k: r => r.gl_accounts ? `${r.gl_accounts.code} ${r.gl_accounts.name}` : '— all expense heads —', label: 'Expense head' },
      { k: 'amount', label: 'Budget AED', fmt: 'money', sum: true }, { k: 'remarks', label: 'Remarks' }],
    defaults: () => ({ period_month: new Date().toISOString().slice(0, 8) + '01' }),
    sections: [{ title: 'Monthly budget', fields: [
      { k: 'cost_center_id', label: 'Cost centre', type: 'ref', ref: 'cost_centers', required: true, wide: true },
      { k: 'account_id', label: 'Expense head (blank = all heads of the cost centre)', type: 'ref', ref: 'gl_accounts', wide: true, filter: r => !r.is_group && r.acc_type === 'EXPENSE' },
      { k: 'period_month', label: 'Month (any date in it)', type: 'date', required: true }, { k: 'amount', label: 'Budget AED', type: 'number', required: true },
      { k: 'remarks', label: 'Remarks', wide: true }] }],
    note: 'Set a monthly budget per cost centre — for all its expenses, or per expense head. Compare in Finance → Budget vs actual.',
    validate: d => { if (d.period_month) d.period_month = d.period_month.slice(0, 8) + '01'; },
  },
  item_vendors: {
    title: 'Vendor Price List', single: 'Price', table: 'item_vendors', order: 'item_id', editRoles: ['purchase', 'stores'], refs: ['items', 'vendors'],
    select: '*, items(code,name), vendors(name)',
    columns: [{ k: r => r.items?.code, label: 'Item' }, { k: r => r.items?.name, label: 'Name' }, { k: r => r.vendors?.name, label: 'Vendor' }, { k: 'vendor_item_code', label: 'Vendor code' },
              { k: 'price', label: 'Price', fmt: 'money', cost: true }, { k: 'currency', label: 'Cur' }, { k: 'moq', label: 'MOQ', fmt: 'qty' }, { k: 'lead_time_days', label: 'Lead days', n: true }, { k: 'is_preferred', label: 'Preferred', fmt: 'bool' }, { k: 'valid_to', label: 'Valid to', fmt: 'date' }],
    defaults: () => ({ currency: 'AED', is_preferred: false }),
    sections: [{ title: 'Price', fields: [
      { k: 'item_id', label: 'Item', type: 'ref', ref: 'items', required: true, wide: true }, { k: 'vendor_id', label: 'Vendor', type: 'ref', ref: 'vendors', required: true, wide: true },
      { k: 'vendor_item_code', label: 'Vendor item code' }, { k: 'price', label: 'Price', type: 'number' }, { k: 'currency', label: 'Currency', type: 'select', options: CURRENCIES },
      { k: 'moq', label: 'Vendor MOQ', type: 'number' }, { k: 'lead_time_days', label: 'Lead time days', type: 'number' }, { k: 'is_preferred', label: 'Preferred vendor', type: 'check' }, { k: 'valid_to', label: 'Valid to', type: 'date' }] }],
  },
  locations: {
    title: 'Store Locations', single: 'Location', table: 'locations', order: 'code', editRoles: ['stores'], refs: ['locations'],
    select: '*, parent:parent_id(code)',
    columns: [{ k: 'code', label: 'Code' }, { k: 'name', label: 'Name' }, { k: 'loc_type', label: 'Type', fmt: 'label' }, { k: r => r.parent?.code, label: 'Parent' }, { k: 'is_stock', label: 'Holds stock', fmt: 'bool' }, { k: 'is_active', label: 'Active', fmt: 'bool' }],
    defaults: () => ({ loc_type: 'RACK', is_stock: true, is_active: true }),
    sections: [{ title: 'Location', fields: [
      { k: 'code', label: 'Code (e.g. MS-A-01)', required: true }, { k: 'name', label: 'Name', required: true, wide: true },
      { k: 'loc_type', label: 'Type', type: 'select', required: true, options: ['WAREHOUSE', 'ZONE', 'RACK', 'BIN', 'SHOP_FLOOR', 'QUARANTINE', 'SCRAP_YARD', 'LABOUR_CAMP', 'OFFICE', 'SITE'] },
      { k: 'parent_id', label: 'Parent location', type: 'ref', ref: 'locations' },
      { k: 'is_stock', label: 'Holds store stock', type: 'check' }, { k: 'is_active', label: 'Active', type: 'check' }] }],
    note: 'Build a hierarchy: Warehouse → Zone → Rack → Bin. Only "holds stock" locations appear in GRN / issue.',
    afterSave: () => loadRef('locations', true),
  },
  projects: {
    title: 'Projects & MTS Orders', single: 'Project', table: 'projects', order: 'code', editRoles: ['factory_manager', 'production_incharge', 'finance'], refs: ['customers', 'payment_terms'],
    select: '*, customers(name)',
    columns: [{ k: 'code', label: 'Code' }, { k: 'name', label: 'Name' }, { k: 'project_type', label: 'Type', fmt: 'label' }, { k: r => r.customers?.name || r.customer, label: 'Customer' },
              { k: 'start_date', label: 'Start', fmt: 'date' }, { k: 'end_date', label: 'End', fmt: 'date' }, { k: 'budget_material', label: 'Material budget', fmt: 'money', cost: true },
              { k: 'contract_value', label: 'Contract value', fmt: 'money', cost: true }, { k: 'status', label: 'Status', fmt: 'badge' }],
    defaults: () => ({ project_type: 'PROJECT', status: 'OPEN', advance_pct: 0, retention_pct: 0 }),
    async onNew(d) { d.code = await nextCode('projects', 'PRJ-', 4); },
    sections: [{ title: 'Project', fields: [
      { k: 'project_type', label: 'Type', type: 'select', required: true, options: [{ v: 'PROJECT', l: 'Customer project' }, { v: 'MTS', l: 'Make-to-stock order' }],
        onChange: async (d, v) => { if (!d.id) d.code = await nextCode('projects', v === 'MTS' ? 'MTS-' : 'PRJ-', 4); } },
      { k: 'code', label: 'Code', required: true }, { k: 'name', label: 'Name', required: true, wide: true },
      { k: 'customer_id', label: 'Customer (for invoicing)', type: 'ref', ref: 'customers', show: d => d.project_type === 'PROJECT', wide: true,
        onChange: (d, v) => { const c = refRow('customers', v); if (c) { d.customer = c.name; if (!d.payment_term_id) d.payment_term_id = c.payment_term_id; } } },
      { k: 'site_address', label: 'Site address', show: d => d.project_type === 'PROJECT', wide: true },
      { k: 'start_date', label: 'Start', type: 'date' }, { k: 'end_date', label: 'End', type: 'date' },
      { k: 'budget_material', label: 'Material budget AED', type: 'number', cost: true },
      { k: 'contract_value', label: 'Contract / selling value AED (for margin)', type: 'number', cost: true },
      { k: 'status', label: 'Status', type: 'select', required: true, options: ['OPEN', 'ON_HOLD', 'CLOSED'] }] },
      { title: 'Contract billing terms', cost: true, fields: [
        { k: 'advance_pct', label: 'Advance payment % of contract', type: 'number', show: d => d.project_type === 'PROJECT' },
        { k: 'advance_recovery_pct', label: 'Advance recovery % per claim (blank = same as advance %)', type: 'number', wide: true, show: d => d.project_type === 'PROJECT' },
        { k: 'retention_pct', label: 'Retention % per claim', type: 'number', show: d => d.project_type === 'PROJECT' },
        { k: 'payment_term_id', label: 'Payment terms (invoice due date)', type: 'ref', ref: 'payment_terms' }] }],
    validate: d => { d.advance_pct = num(d.advance_pct); d.retention_pct = num(d.retention_pct); },
    afterSave: () => loadRef('projects', true),
  },
  employees: {
    title: 'Employees', single: 'Employee', table: 'employees', order: 'name', editRoles: ['stores', 'factory_manager', 'production_incharge'], refs: ['labour_grades'],
    columns: [{ k: 'emp_code', label: 'Code' }, { k: 'name', label: 'Name' }, { k: 'department', label: 'Department' }, { k: 'designation', label: 'Designation' },
      { k: r => refRow('labour_grades', r.grade_id)?.name, label: 'Worker grade' }, { k: 'is_active', label: 'Active', fmt: 'bool' }],
    defaults: () => ({ is_active: true }),
    sections: [{ title: 'Employee', fields: [{ k: 'emp_code', label: 'Employee code', required: true }, { k: 'name', label: 'Name', required: true, wide: true },
      { k: 'department', label: 'Department', type: 'lookup', list: 'DEPARTMENT' }, { k: 'designation', label: 'Designation', type: 'lookup', list: 'DESIGNATION' },
      { k: 'grade_id', label: 'Worker grade (production)', type: 'ref', ref: 'labour_grades' }, { k: 'is_active', label: 'Active', type: 'check' }] }],
    afterSave: () => loadRef('employees', true),
  },
  cost_centers: {
    title: 'Cost Centres', single: 'Cost Centre', table: 'cost_centers', order: 'code', editRoles: ['factory_manager', 'finance'],
    columns: [{ k: 'code', label: 'Code' }, { k: 'name', label: 'Name' }, { k: 'is_factory', label: 'Factory overhead', fmt: 'bool' }, { k: 'is_active', label: 'Active', fmt: 'bool' }],
    defaults: () => ({ is_active: true, is_factory: false }),
    sections: [{ title: 'Cost centre', fields: [{ k: 'code', label: 'Code', required: true }, { k: 'name', label: 'Name', required: true, wide: true },
      { k: 'is_factory', label: 'Factory cost centre (its expenses count as factory overheads)', type: 'check' }, { k: 'is_active', label: 'Active', type: 'check' }] }],
    afterSave: () => loadRef('cost_centers', true),
  },
  work_centers: {
    title: 'Work Centres', single: 'Work Centre', table: 'work_centers', order: 'sort_order', editRoles: ['factory_manager', 'finance'], refs: ['labour_grades'],
    columns: [{ k: 'code', label: 'Code' }, { k: 'name', label: 'Name' }, { k: 'kind', label: 'Type', fmt: 'label' },
      { k: 'machine_rate_per_hour', label: 'Machine AED/h', n: true, cost: true }, { k: r => refRow('labour_grades', r.default_grade_id)?.name, label: 'Usual grade' },
      { k: 'hours_per_day', label: 'Hours/day', n: true }, { k: 'sort_order', label: 'Route order', n: true }, { k: 'is_active', label: 'Active', fmt: 'bool' }],
    defaults: () => ({ kind: 'MACHINE', machine_rate_per_hour: 0, hours_per_day: 9, sort_order: 50, is_active: true }),
    sections: [{ title: 'Work centre / stage', fields: [{ k: 'code', label: 'Code', required: true }, { k: 'name', label: 'Name', required: true, wide: true },
      { k: 'kind', label: 'Type', type: 'select', required: true, options: [{ v: 'MACHINE', l: 'Machine (machine hours charged)' }, { v: 'MANUAL', l: 'Manual (labour only)' }] },
      { k: 'machine_rate_per_hour', label: 'Machine rate AED / hour', type: 'number', cost: true },
      { k: 'default_grade_id', label: 'Usual worker grade (planning rate + default crew line)', type: 'ref', ref: 'labour_grades' },
      { k: 'labour_rate_per_hour', label: 'Planning labour rate override AED / man-hour (blank = grade rate)', type: 'number', cost: true },
      { k: 'hours_per_day', label: 'Available hours per day', type: 'number' },
      { k: 'sort_order', label: 'Default route order', type: 'number' }, { k: 'is_active', label: 'Active', type: 'check' }] },
      { title: 'Machine-rate calculator inputs (machines only)', cost: true, fields: [
        { k: 'power_kw', label: 'Connected power kW', type: 'number', show: d => d.kind === 'MACHINE' },
        { k: 'load_factor_pct', label: 'Average load while running %', type: 'number', show: d => d.kind === 'MACHINE' },
        { k: 'tooling_cost_per_year', label: 'Tooling & consumables per year AED', type: 'number', show: d => d.kind === 'MACHINE' },
        { k: 'working_days_per_year', label: 'Working days per year', type: 'number', show: d => d.kind === 'MACHINE' },
        { k: 'utilisation_pct', label: 'Expected utilisation %', type: 'number', show: d => d.kind === 'MACHINE' }] }],
    note: 'Machine rates can be worked out from real costs in Production → Machine-rate calculator.',
    afterSave: () => loadRef('work_centers', true),
  },
  labour_grades: {
    title: 'Worker Grades & Rates', single: 'Worker Grade', table: 'labour_grades', order: 'sort_order', editRoles: ['factory_manager', 'finance'],
    columns: [{ k: 'code', label: 'Code' }, { k: 'name', label: 'Grade' }, { k: 'rate_per_hour', label: 'Normal AED / hour', fmt: 'money', cost: true },
      { k: 'ot_rate_per_hour', label: 'Overtime AED / hour', fmt: 'money', cost: true }, { k: 'sort_order', label: 'Order', n: true }, { k: 'is_active', label: 'Active', fmt: 'bool' }],
    defaults: () => ({ rate_per_hour: 0, ot_rate_per_hour: 0, sort_order: 50, is_active: true }),
    sections: [{ title: 'Worker grade', fields: [{ k: 'code', label: 'Code', required: true }, { k: 'name', label: 'Grade name', required: true, wide: true },
      { k: 'rate_per_hour', label: 'Normal cost rate AED / hour (salary + allowances + accommodation, per working hour)', type: 'number', required: true, cost: true, wide: true,
        onChange: (d, v) => { if (!num(d.ot_rate_per_hour)) d.ot_rate_per_hour = Math.round(num(v) * 125) / 100; } },
      { k: 'ot_rate_per_hour', label: 'Overtime rate AED / hour (UAE: 125% of normal; 150% nights / rest days)', type: 'number', required: true, cost: true, wide: true },
      { k: 'sort_order', label: 'Display order', type: 'number' }, { k: 'is_active', label: 'Active', type: 'check' }] }],
    afterSave: () => loadRef('labour_grades', true),
  },
  payment_terms: {
    title: 'Payment Terms', single: 'Payment Term', table: 'payment_terms', order: 'code', editRoles: ['purchase', 'finance'],
    columns: [{ k: 'code', label: 'Code' }, { k: 'name', label: 'Name' }, { k: 'credit_days', label: 'Credit days', n: true }, { k: 'basis', label: 'From', fmt: 'label' }, { k: 'advance_pct', label: 'Advance %', n: true }, { k: 'is_active', label: 'Active', fmt: 'bool' }],
    defaults: () => ({ credit_days: 30, basis: 'INVOICE', advance_pct: 0, is_active: true }),
    sections: [{ title: 'Payment term', fields: [{ k: 'code', label: 'Code', required: true }, { k: 'name', label: 'Description', required: true, wide: true },
      { k: 'credit_days', label: 'Credit days', type: 'number', required: true },
      { k: 'basis', label: 'Days counted from', type: 'select', required: true, options: [{ v: 'INVOICE', l: 'Invoice date' }, { v: 'GRN', l: 'Goods receipt date' }, { v: 'EOM', l: 'End of invoice month' }] },
      { k: 'advance_pct', label: 'Advance %', type: 'number' }, { k: 'is_active', label: 'Active', type: 'check' }] }],
    afterSave: () => loadRef('payment_terms', true),
  },
  item_categories: {
    title: 'Item Categories', single: 'Category', table: 'item_categories', order: 'code', editRoles: ['stores', 'purchase'], refs: ['item_classes'],
    select: '*, item_classes(code,name)',
    columns: [{ k: r => r.item_classes?.code, label: 'Class' }, { k: 'code', label: 'Code' }, { k: 'name', label: 'Name' }, { k: 'is_active', label: 'Active', fmt: 'bool' }],
    defaults: () => ({ is_active: true }),
    sections: [{ title: 'Category', fields: [{ k: 'class_id', label: 'Class', type: 'ref', ref: 'item_classes', required: true }, { k: 'code', label: 'Code', required: true },
      { k: 'name', label: 'Name', required: true, wide: true }, { k: 'is_active', label: 'Active', type: 'check' }] }],
    afterSave: () => loadRef('item_categories', true),
  },
  item_classes: {
    title: 'Item Classes', single: 'Class', table: 'item_classes', order: 'sort_order', editRoles: [],
    columns: [{ k: 'code', label: 'Code' }, { k: 'name', label: 'Name' }, { k: 'valuation_method', label: 'Valuation', fmt: 'label' }, { k: 'tracking', label: 'Tracking', fmt: 'label' },
              { k: 'is_returnable', label: 'Returnable (tool crib)', fmt: 'bool' }, { k: 'needs_calibration', label: 'Calibration', fmt: 'bool' }, { k: 'is_scrap', label: 'Scrap', fmt: 'bool' }],
    defaults: () => ({ valuation_method: 'WAVG', tracking: 'LOT', is_active: true, sort_order: 50 }),
    sections: [{ title: 'Class', fields: [{ k: 'code', label: 'Code', required: true }, { k: 'name', label: 'Name', required: true, wide: true },
      { k: 'valuation_method', label: 'Valuation', type: 'select', required: true, options: [{ v: 'FIFO', l: 'FIFO' }, { v: 'WAVG', l: 'Weighted average' }, { v: 'ASSET', l: 'Fixed asset (cost)' }] },
      { k: 'tracking', label: 'Tracking', type: 'select', required: true, options: [{ v: 'LOT', l: 'Quantity in lots' }, { v: 'SERIAL', l: 'Serial / asset tag per unit' }] },
      { k: 'is_returnable', label: 'Returnable tool crib', type: 'check' }, { k: 'needs_calibration', label: 'Needs calibration', type: 'check' }, { k: 'is_scrap', label: 'Scrap class', type: 'check' },
      { k: 'sort_order', label: 'Sort order', type: 'number' }] }],
    note: 'Only the administrator can change classes. Valuation cannot change for items that already have transactions.',
    afterSave: () => loadRef('item_classes', true),
  },
  lookups: {
    title: 'Drop-down Lists', single: 'List Value', table: 'lookup_values', order: 'list_key', editRoles: LOOKUP_KEEPERS,
    columns: [{ k: r => LOOKUP_LISTS[r.list_key]?.noun || r.list_key, label: 'List', fmt: 'label' }, { k: 'value', label: 'Value' },
      { k: 'sort_order', label: 'Order', n: true }, { k: 'is_active', label: 'Active', fmt: 'bool' }],
    defaults: () => ({ sort_order: 50, is_active: true }),
    sections: [{ title: 'List value', fields: [
      { k: 'list_key', label: 'List', type: 'select', required: true, ro: d => !!d.id,
        options: () => Object.entries(LOOKUP_LISTS).filter(([, l]) => hasRole(...l.owners)).map(([k, l]) => ({ v: k, l: label(l.noun) })) },
      { k: 'value', label: 'Value (what people pick)', required: true, wide: true },
      { k: 'sort_order', label: 'Order in the list', type: 'number' }, { k: 'is_active', label: 'Active (untick to stop it being picked)', type: 'check' }] }],
    note: 'Departments, designations, nationalities, accommodation (HR) · banks (Finance) · brands (Stores / Purchase) · unit types and rooms / areas (Factory Manager). Everyone picks from these lists; missing values are requested and added here.',
    validate: d => { d.value = (d.value || '').trim(); },
    afterSave: () => loadRef('lookups', true),
  },
  uoms: {
    title: 'Units of Measure', single: 'UoM', table: 'uoms', order: 'code', editRoles: ['stores', 'purchase'],
    columns: [{ k: 'code', label: 'Code' }, { k: 'name', label: 'Name' }, { k: 'decimals', label: 'Decimals', n: true }],
    defaults: () => ({ decimals: 2 }),
    sections: [{ title: 'UoM', fields: [{ k: 'code', label: 'Code', required: true }, { k: 'name', label: 'Name', required: true }, { k: 'decimals', label: 'Decimals', type: 'number' }] }],
    afterSave: () => loadRef('uoms', true),
  },
};

export const MasterPage = {
  components: { DataTable, Modal, FieldInput },
  props: { cfg: Object },
  data: () => ({ rows: [], loading: true, edit: null, busy: false }),
  computed: {
    canEdit() { return hasRole(...this.cfg.editRoles); },
    sections() { return this.cfg.sections.filter(s => !(s.cost && !['admin', 'stores', 'purchase', 'finance', 'factory_manager'].includes(state.profile?.role))); },
  },
  watch: { cfg() { this.load(); } },
  mounted() { this.load(); },
  methods: {
    async load() {
      this.loading = true;
      await run(async () => {
        await loadRefs(this.cfg.refs || []);
        this.rows = must(await sb.from(this.cfg.table).select(this.cfg.select || '*').order(this.cfg.order).limit(10000));
      });
      this.loading = false;
    },
    fields(s) { return s.fields.filter(f => !(f.show && !f.show(this.edit))); },
    async open(r) {
      if (r) { this.edit = { ...r }; Object.keys(this.edit).forEach(k => { if (this.edit[k] && typeof this.edit[k] === 'object' && !Array.isArray(this.edit[k])) delete this.edit[k]; }); }
      else { this.edit = this.cfg.defaults ? this.cfg.defaults() : {}; if (this.cfg.onNew) await run(() => this.cfg.onNew(this.edit)); }
    },
    async changed(f) { if (f.onChange) await run(() => f.onChange(this.edit, this.edit[f.k])); },
    async save() {
      const all = this.cfg.sections.flatMap(s => s.fields);
      this.busy = true;
      const ok = await run(async () => {
        for (const f of all) if (f.required && !(f.show && !f.show(this.edit)) && (this.edit[f.k] === null || this.edit[f.k] === undefined || this.edit[f.k] === '')) throw new Error(`${f.label} is required`);
        if (this.cfg.validate) this.cfg.validate(this.edit);
        const row = {};
        all.filter(f => f.type !== 'ro' && !f.virtual).forEach(f => { if (this.edit[f.k] !== undefined) row[f.k] = this.edit[f.k] === '' ? null : this.edit[f.k]; });
        if (this.edit.id) must(await sb.from(this.cfg.table).update(row).eq('id', this.edit.id));
        else must(await sb.from(this.cfg.table).insert(row));
      }, `${this.cfg.single} saved`);
      this.busy = false;
      if (ok) { this.edit = null; if (this.cfg.afterSave) await this.cfg.afterSave(); await this.load(); }
    },
  },
  template: `<div>
    <div class="row" style="margin-bottom:12px">
      <span class="muted small" v-if="cfg.note" style="max-width:900px">{{ cfg.note }}</span>
      <span class="spacer"></span>
      <button v-if="canEdit" class="btn primary" @click="open(null)">+ New {{ cfg.single }}</button>
    </div>
    <div class="card"><DataTable :columns="cfg.columns" :rows="rows" :loading="loading" clickable @row="open" :filename="cfg.table" /></div>
    <Modal v-if="edit" :title="(edit.id ? 'Edit ' : 'New ') + cfg.single" @close="edit=null">
      <div v-for="s in sections" style="margin-bottom:16px">
        <h3 style="font-size:13px;margin:0 0 8px;color:var(--brand)">{{ s.title }}</h3>
        <div class="grid"><FieldInput v-for="f in fields(s)" :key="f.k" :f="f" :doc="edit" :disabled="!canEdit" @changed="changed(f)" /></div>
      </div>
      <template #footer>
        <button class="btn" @click="edit=null">Close</button>
        <button v-if="canEdit" class="btn primary" :disabled="busy" @click="save">Save</button>
      </template>
    </Modal>
  </div>`,
};
