// Master data: generic list + modal form, and per-master configuration
import { sb, state, must, run, hasRole, loadRefs, loadRef, refRow, refLabel, money, qty, label } from './lib.js';
import { FieldInput, DataTable, Modal } from './components.js';

const EMIRATES = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'];

async function nextCode(table, prefix, width = 4) {
  const rows = must(await sb.from(table).select('code').ilike('code', `${prefix}%`).order('code', { ascending: false }).limit(200));
  let max = 0;
  rows.forEach(r => { const m = r.code.slice(prefix.length).match(/^(\d+)$/); if (m) max = Math.max(max, Number(m[1])); });
  return prefix + String(max + 1).padStart(width, '0');
}

export const MASTERS = {
  items: {
    title: 'Item Master', single: 'Item', table: 'items', order: 'code', editRoles: ['stores', 'purchase'],
    refs: ['item_classes', 'item_categories', 'uoms', 'locations'],
    select: '*, item_classes(code,name), item_categories(name), uoms(code)',
    columns: [
      { k: 'code', label: 'Code' }, { k: 'name', label: 'Name' }, { k: r => r.item_classes?.code, label: 'Class' }, { k: r => r.item_categories?.name, label: 'Category' },
      { k: r => r.uoms?.code, label: 'UoM' }, { k: 'brand', label: 'Brand' }, { k: 'buffer_target', label: 'Buffer', fmt: 'qty' }, { k: 'moq', label: 'MOQ', fmt: 'qty' },
      { k: 'lead_time_days', label: 'Lead days', n: true }, { k: 'last_purchase_rate', label: 'Last rate', fmt: 'money', cost: true }, { k: 'is_active', label: 'Active', fmt: 'bool' },
    ],
    defaults: () => ({ is_active: true, batch_controlled: true, has_expiry: false, vat_rate: 5, safety_stock: 0, reorder_level: 0, reorder_qty: 0, max_stock: 0, moq: 0, order_multiple: 0, lead_time_days: 0, buffer_target: 0, standard_cost: 0, dbm_enabled: false }),
    sections: [
      { title: 'Identification', fields: [
        { k: 'class_id', label: 'Item class', type: 'ref', ref: 'item_classes', required: true,
          onChange: async (d, v) => { d.category_id = null; const c = refRow('item_classes', v); if (c && !d.id) d.code = await nextCode('items', c.code + '-'); } },
        { k: 'category_id', label: 'Category', type: 'ref', ref: 'item_categories', filter: (r, d) => r.class_id === d.class_id && r.is_active },
        { k: 'code', label: 'Item code', required: true },
        { k: 'name', label: 'Item name', required: true, wide: true },
        { k: 'uom_id', label: 'Stock UoM', type: 'ref', ref: 'uoms', required: true },
        { k: 'brand', label: 'Brand / make' },
        { k: 'specification', label: 'Specification (grade, finish, colour)', wide: true },
        { k: 'length_mm', label: 'Length mm', type: 'number' }, { k: 'width_mm', label: 'Width mm', type: 'number' }, { k: 'thickness_mm', label: 'Thickness mm', type: 'number' },
        { k: 'description', label: 'Description', type: 'textarea', full: true },
        { k: 'is_active', label: 'Active', type: 'check' },
      ] },
      { title: 'Control & valuation', fields: [
        { k: 'valuation_override', label: 'Valuation (blank = class default)', type: 'select', options: [{ v: 'FIFO', l: 'FIFO' }, { v: 'WAVG', l: 'Weighted average' }],
          show: d => refRow('item_classes', d.class_id)?.valuation_method !== 'ASSET' },
        { k: '_classval', label: 'Class default', type: 'ro', virtual: true, fmt: (v, d) => label(refRow('item_classes', d.class_id)?.valuation_method || '') },
        { k: 'batch_controlled', label: 'Batch / lot numbers', type: 'check' },
        { k: 'has_expiry', label: 'Has expiry (FEFO)', type: 'check' },
        { k: 'shelf_life_days', label: 'Shelf life (days)', type: 'number', show: d => d.has_expiry },
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
        { k: 'currency', label: 'Currency', required: true }, { k: 'payment_term_id', label: 'Payment terms', type: 'ref', ref: 'payment_terms', required: true },
        { k: 'credit_limit', label: 'Credit limit AED', type: 'number' },
        { k: 'bank_name', label: 'Bank' }, { k: 'bank_account_name', label: 'Account name' }, { k: 'iban', label: 'IBAN', wide: true }, { k: 'swift_code', label: 'SWIFT' },
        { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
      ] },
    ],
    validate: d => { if (d.trn && !/^\d{15}$/.test(d.trn)) throw new Error('TRN must be exactly 15 digits'); },
    afterSave: () => loadRef('vendors', true),
  },
  item_vendors: {
    title: 'Vendor Price List', single: 'Price', table: 'item_vendors', order: 'item_id', editRoles: ['purchase', 'stores'], refs: ['items', 'vendors'],
    select: '*, items(code,name), vendors(name)',
    columns: [{ k: r => r.items?.code, label: 'Item' }, { k: r => r.items?.name, label: 'Name' }, { k: r => r.vendors?.name, label: 'Vendor' }, { k: 'vendor_item_code', label: 'Vendor code' },
              { k: 'price', label: 'Price', fmt: 'money', cost: true }, { k: 'currency', label: 'Cur' }, { k: 'moq', label: 'MOQ', fmt: 'qty' }, { k: 'lead_time_days', label: 'Lead days', n: true }, { k: 'is_preferred', label: 'Preferred', fmt: 'bool' }, { k: 'valid_to', label: 'Valid to', fmt: 'date' }],
    defaults: () => ({ currency: 'AED', is_preferred: false }),
    sections: [{ title: 'Price', fields: [
      { k: 'item_id', label: 'Item', type: 'ref', ref: 'items', required: true, wide: true }, { k: 'vendor_id', label: 'Vendor', type: 'ref', ref: 'vendors', required: true, wide: true },
      { k: 'vendor_item_code', label: 'Vendor item code' }, { k: 'price', label: 'Price', type: 'number' }, { k: 'currency', label: 'Currency' },
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
    title: 'Projects & MTS Orders', single: 'Project', table: 'projects', order: 'code', editRoles: ['factory_manager', 'production_incharge'],
    select: '*',
    columns: [{ k: 'code', label: 'Code' }, { k: 'name', label: 'Name' }, { k: 'project_type', label: 'Type', fmt: 'label' }, { k: 'customer', label: 'Customer' },
              { k: 'start_date', label: 'Start', fmt: 'date' }, { k: 'end_date', label: 'End', fmt: 'date' }, { k: 'budget_material', label: 'Material budget', fmt: 'money', cost: true }, { k: 'status', label: 'Status', fmt: 'badge' }],
    defaults: () => ({ project_type: 'PROJECT', status: 'OPEN' }),
    async onNew(d) { d.code = await nextCode('projects', 'PRJ-', 4); },
    sections: [{ title: 'Project', fields: [
      { k: 'project_type', label: 'Type', type: 'select', required: true, options: [{ v: 'PROJECT', l: 'Customer project' }, { v: 'MTS', l: 'Make-to-stock order' }],
        onChange: async (d, v) => { if (!d.id) d.code = await nextCode('projects', v === 'MTS' ? 'MTS-' : 'PRJ-', 4); } },
      { k: 'code', label: 'Code', required: true }, { k: 'name', label: 'Name', required: true, wide: true },
      { k: 'customer', label: 'Customer', show: d => d.project_type === 'PROJECT' }, { k: 'site_address', label: 'Site address', show: d => d.project_type === 'PROJECT', wide: true },
      { k: 'start_date', label: 'Start', type: 'date' }, { k: 'end_date', label: 'End', type: 'date' },
      { k: 'budget_material', label: 'Material budget AED', type: 'number', cost: true },
      { k: 'status', label: 'Status', type: 'select', required: true, options: ['OPEN', 'ON_HOLD', 'CLOSED'] }] }],
    afterSave: () => loadRef('projects', true),
  },
  employees: {
    title: 'Employees', single: 'Employee', table: 'employees', order: 'name', editRoles: ['stores', 'factory_manager', 'production_incharge'],
    columns: [{ k: 'emp_code', label: 'Code' }, { k: 'name', label: 'Name' }, { k: 'department', label: 'Department' }, { k: 'designation', label: 'Designation' }, { k: 'is_active', label: 'Active', fmt: 'bool' }],
    defaults: () => ({ is_active: true }),
    sections: [{ title: 'Employee', fields: [{ k: 'emp_code', label: 'Employee code', required: true }, { k: 'name', label: 'Name', required: true, wide: true },
      { k: 'department', label: 'Department' }, { k: 'designation', label: 'Designation' }, { k: 'is_active', label: 'Active', type: 'check' }] }],
    afterSave: () => loadRef('employees', true),
  },
  cost_centers: {
    title: 'Cost Centres', single: 'Cost Centre', table: 'cost_centers', order: 'code', editRoles: ['factory_manager', 'finance'],
    columns: [{ k: 'code', label: 'Code' }, { k: 'name', label: 'Name' }, { k: 'is_active', label: 'Active', fmt: 'bool' }],
    defaults: () => ({ is_active: true }),
    sections: [{ title: 'Cost centre', fields: [{ k: 'code', label: 'Code', required: true }, { k: 'name', label: 'Name', required: true, wide: true }, { k: 'is_active', label: 'Active', type: 'check' }] }],
    afterSave: () => loadRef('cost_centers', true),
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
        <h3 style="font-size:13px;margin:0 0 8px;color:#8a5a2b">{{ s.title }}</h3>
        <div class="grid"><FieldInput v-for="f in fields(s)" :key="f.k" :f="f" :doc="edit" :disabled="!canEdit" @changed="changed(f)" /></div>
      </div>
      <template #footer>
        <button class="btn" @click="edit=null">Close</button>
        <button v-if="canEdit" class="btn primary" :disabled="busy" @click="save">Save</button>
      </template>
    </Modal>
  </div>`,
};
