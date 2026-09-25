// Excel import: download template -> fill -> upload -> validate -> import
// Items and vendors are upserted by code; opening stock becomes a DRAFT opening-stock GRN
import { sb, state, must, run, hasRole, loadRefs, loadRef, toast, go, today, num, qty } from './lib.js';
import { DataTable } from './components.js';

const XLSX_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
let xlsxLoading = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  xlsxLoading ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = XLSX_URL; s.onload = () => res(window.XLSX); s.onerror = () => rej(new Error('Could not load the Excel library'));
    document.head.appendChild(s);
  });
  return xlsxLoading;
}

// ---------- value helpers ----------
const str = v => (v === null || v === undefined) ? '' : String(v).trim();
const yes = v => ['y', 'yes', 'true', '1'].includes(str(v).toLowerCase());
const numOrNull = v => str(v) === '' ? null : (isNaN(Number(v)) ? NaN : Number(v));
function isoDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v)) return 'INVALID';
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const s = str(v);
  let y, mo, d, m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) [y, mo, d] = [m[1], m[2], m[3]];
  else if ((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/))) [y, mo, d] = [m[3], m[2], m[1]];   // dd/mm/yyyy (UAE format)
  else return 'INVALID';
  const dt = new Date(Number(y), Number(mo) - 1, Number(d));
  if (dt.getFullYear() !== Number(y) || dt.getMonth() !== Number(mo) - 1 || dt.getDate() !== Number(d)) return 'INVALID';
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}
const byCode = (name, key = 'code') => Object.fromEntries((state.refs[name] || []).map(r => [str(r[key]).toUpperCase(), r]));

async function nextCodes(table, prefix, n) {
  const rows = must(await sb.from(table).select('code').ilike('code', `${prefix}%`).limit(5000));
  let max = 0;
  rows.forEach(r => { const m = r.code.slice(prefix.length).match(/^(\d+)$/); if (m) max = Math.max(max, Number(m[1])); });
  return Array.from({ length: n }, (_, i) => prefix + String(max + i + 1).padStart(4, '0'));
}

// ---------- template definitions ----------
const EMIRATES = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'];
const TEMPLATES = {
  items: {
    title: 'Items', roles: ['stores', 'purchase'],
    help: 'One row per item. Existing item codes are updated; new codes are created. Put AUTO in item_code to number automatically by class (e.g. RM-0001).',
    cols: ['item_code', 'item_name', 'class_code', 'category_code', 'uom_code', 'brand', 'specification', 'length_mm', 'width_mm', 'thickness_mm',
           'vat_rate', 'has_expiry', 'shelf_life_days', 'buffer_target', 'safety_stock', 'reorder_level', 'reorder_qty', 'max_stock', 'moq', 'order_multiple',
           'lead_time_days', 'standard_cost', 'default_location_code', 'dbm_enabled', 'description'],
    required: ['item_code', 'item_name', 'class_code', 'uom_code'],
    example: ['AUTO', 'MDF 18mm 1220x2440 plain', 'RM', 'RM-BRD', 'SHT', 'Kronospan', 'E1 grade', 2440, 1220, 18, 5, 'N', '', 60, 10, '', '', 120, 20, 10, 14, 95, 'MS', 'Y', ''],
    refs: ['item_classes', 'item_categories', 'uoms', 'locations', 'items'],
    async validate(rows) {
      const cls = byCode('item_classes'), cat = byCode('item_categories'), uom = byCode('uoms'), loc = byCode('locations'), items = byCode('items');
      const autoCount = {};
      const out = rows.map(r => {
        const e = [];
        const c = cls[str(r.class_code).toUpperCase()];
        if (!c) e.push(`class "${r.class_code}" unknown`);
        const ct = str(r.category_code) ? cat[str(r.category_code).toUpperCase()] : null;
        if (str(r.category_code) && !ct) e.push(`category "${r.category_code}" unknown`);
        if (ct && c && ct.class_id !== c.id) e.push('category belongs to another class');
        const u = uom[str(r.uom_code).toUpperCase()];
        if (!u) e.push(`UoM "${r.uom_code}" unknown`);
        const dl = str(r.default_location_code) ? loc[str(r.default_location_code).toUpperCase()] : null;
        if (str(r.default_location_code) && !dl) e.push(`location "${r.default_location_code}" unknown`);
        const n = {};
        for (const k of ['length_mm', 'width_mm', 'thickness_mm', 'vat_rate', 'shelf_life_days', 'buffer_target', 'safety_stock', 'reorder_level', 'reorder_qty', 'max_stock', 'moq', 'order_multiple', 'lead_time_days', 'standard_cost']) {
          n[k] = numOrNull(r[k]); if (Number.isNaN(n[k])) e.push(`${k} is not a number`);
        }
        let code = str(r.item_code).toUpperCase() === 'AUTO' ? null : str(r.item_code);
        if (code === null && c) autoCount[c.code] = (autoCount[c.code] || 0) + 1;
        const row = {
          code, name: str(r.item_name), class_id: c?.id, category_id: ct?.id || null, uom_id: u?.id, brand: str(r.brand) || null, specification: str(r.specification) || null,
          length_mm: n.length_mm, width_mm: n.width_mm, thickness_mm: n.thickness_mm, vat_rate: n.vat_rate ?? 5, has_expiry: yes(r.has_expiry), shelf_life_days: n.shelf_life_days,
          buffer_target: n.buffer_target ?? 0, safety_stock: n.safety_stock ?? 0, reorder_level: n.reorder_level ?? 0, reorder_qty: n.reorder_qty ?? 0, max_stock: n.max_stock ?? 0,
          moq: n.moq ?? 0, order_multiple: n.order_multiple ?? 0, lead_time_days: n.lead_time_days ?? 0, standard_cost: n.standard_cost ?? 0,
          default_location_id: dl?.id || null, dbm_enabled: yes(r.dbm_enabled), description: str(r.description) || null, is_active: true,
        };
        return { row, _cls: c?.code, _action: code && items[code.toUpperCase()] ? 'UPDATE' : 'CREATE', _errors: e };
      });
      // assign AUTO codes per class
      for (const [clsCode, n] of Object.entries(autoCount)) {
        const codes = await nextCodes('items', clsCode + '-', n);
        out.filter(o => !o.row.code && o._cls === clsCode).forEach((o, i) => { o.row.code = codes[i]; });
      }
      const seen = {};
      out.forEach(o => { if (o.row.code) { const k = o.row.code.toUpperCase(); if (seen[k]) o._errors.push('duplicate code in file'); seen[k] = 1; } });
      return out;
    },
    async save(valid) {
      for (let i = 0; i < valid.length; i += 200) must(await sb.from('items').upsert(valid.slice(i, i + 200).map(v => v.row), { onConflict: 'code' }));
      await loadRef('items', true);
      return `${valid.length} items imported`;
    },
    lists: () => ({
      Classes: (state.refs.item_classes || []).map(r => ({ class_code: r.code, name: r.name, valuation: r.valuation_method, tracking: r.tracking })),
      Categories: (state.refs.item_categories || []).map(r => ({ category_code: r.code, name: r.name, class_code: (state.refs.item_classes || []).find(c => c.id === r.class_id)?.code })),
      UoM: (state.refs.uoms || []).map(r => ({ uom_code: r.code, name: r.name })),
      Locations: (state.refs.locations || []).map(r => ({ location_code: r.code, name: r.name, type: r.loc_type })),
    }),
  },

  vendors: {
    title: 'Vendors', roles: ['purchase', 'finance'],
    help: 'One row per vendor. Existing vendor codes are updated. Put AUTO in vendor_code to number automatically (V0001…). TRN must be 15 digits.',
    cols: ['vendor_code', 'vendor_name', 'vendor_type', 'vat_registered', 'trn', 'trade_license_no', 'trade_license_expiry', 'address', 'emirate', 'country',
           'contact_person', 'phone', 'email', 'currency', 'payment_term_code', 'credit_limit', 'bank_name', 'bank_account_name', 'iban', 'swift_code', 'supplies_classes', 'status'],
    required: ['vendor_code', 'vendor_name', 'payment_term_code'],
    example: ['AUTO', 'Al Noor Plywood Trading LLC', 'LOCAL', 'Y', '100123456700003', 'CN-1234567', '31/12/2027', 'Industrial Area 12, Sharjah', 'Sharjah', 'United Arab Emirates',
              'Mr. Rakesh', '+971 50 123 4567', 'sales@example.ae', 'AED', 'NET60', 50000, 'Emirates NBD', 'Al Noor Plywood Trading LLC', 'AE070331234567890123456', 'EBILAEAD', 'RM,CON', 'ACTIVE'],
    refs: ['payment_terms', 'vendors'],
    async validate(rows) {
      const pt = byCode('payment_terms'), vendors = byCode('vendors');
      let auto = rows.filter(r => str(r.vendor_code).toUpperCase() === 'AUTO').length;
      const codes = auto ? await nextCodes('vendors', 'V', auto) : [];
      const seen = {};
      return rows.map(r => {
        const e = [];
        const t = pt[str(r.payment_term_code).toUpperCase()];
        if (!t) e.push(`payment term "${r.payment_term_code}" unknown`);
        const type = str(r.vendor_type).toUpperCase() || 'LOCAL';
        if (!['LOCAL', 'IMPORT'].includes(type)) e.push('vendor_type must be LOCAL or IMPORT');
        const trn = str(r.trn).replace(/\s/g, '');
        if (trn && !/^\d{15}$/.test(trn)) e.push('TRN must be 15 digits');
        const exp = isoDate(r.trade_license_expiry);
        if (exp === 'INVALID') e.push('trade_license_expiry is not a date (use dd/mm/yyyy)');
        const status = str(r.status).toUpperCase() || 'ACTIVE';
        if (!['ACTIVE', 'ON_HOLD', 'BLOCKED'].includes(status)) e.push('status must be ACTIVE, ON_HOLD or BLOCKED');
        const em = str(r.emirate);
        if (em && !EMIRATES.map(x => x.toLowerCase()).includes(em.toLowerCase())) e.push(`emirate must be one of: ${EMIRATES.join(', ')}`);
        const cl = numOrNull(r.credit_limit); if (Number.isNaN(cl)) e.push('credit_limit is not a number');
        const code = str(r.vendor_code).toUpperCase() === 'AUTO' ? codes.shift() : str(r.vendor_code);
        if (seen[code.toUpperCase()]) e.push('duplicate code in file'); seen[code.toUpperCase()] = 1;
        const row = {
          code, name: str(r.vendor_name), vendor_type: type, vat_registered: str(r.vat_registered) === '' ? type === 'LOCAL' : yes(r.vat_registered), trn: trn || null,
          trade_license_no: str(r.trade_license_no) || null, trade_license_expiry: exp === 'INVALID' ? null : exp, address: str(r.address) || null,
          emirate: em ? EMIRATES.find(x => x.toLowerCase() === em.toLowerCase()) : null, country: str(r.country) || (type === 'LOCAL' ? 'United Arab Emirates' : ''),
          contact_person: str(r.contact_person) || null, phone: str(r.phone) || null, email: str(r.email) || null, currency: str(r.currency).toUpperCase() || 'AED',
          payment_term_id: t?.id, credit_limit: cl, bank_name: str(r.bank_name) || null, bank_account_name: str(r.bank_account_name) || null,
          iban: str(r.iban).replace(/\s/g, '') || null, swift_code: str(r.swift_code) || null,
          supplies_classes: str(r.supplies_classes) ? str(r.supplies_classes).split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : [], status,
        };
        return { row, _action: vendors[code.toUpperCase()] ? 'UPDATE' : 'CREATE', _errors: e };
      });
    },
    async save(valid) {
      for (let i = 0; i < valid.length; i += 200) must(await sb.from('vendors').upsert(valid.slice(i, i + 200).map(v => v.row), { onConflict: 'code' }));
      await loadRef('vendors', true);
      return `${valid.length} vendors imported`;
    },
    lists: () => ({ PaymentTerms: (state.refs.payment_terms || []).map(r => ({ payment_term_code: r.code, name: r.name, days: r.credit_days })), Emirates: EMIRATES.map(e => ({ emirate: e })) }),
  },

  opening: {
    title: 'Opening stock', roles: ['stores'],
    help: 'One row per lot. Creates a DRAFT opening-stock GRN that Stores reviews and posts. original_receipt_date drives the aging report. For tools/machines (serialised classes) qty must be whole and serial_nos may list the serial numbers separated by commas.',
    cols: ['item_code', 'location_code', 'qty', 'unit_cost', 'original_receipt_date', 'lot_no', 'batch_no', 'expiry_date', 'serial_nos', 'remarks'],
    required: ['item_code', 'location_code', 'qty', 'unit_cost', 'original_receipt_date'],
    example: ['RM-0001', 'MS', 40, 92.5, '15/06/2026', 'OPEN-001', '', '', '', 'Physical count 30-Sep'],
    refs: ['items', 'locations'],
    async validate(rows) {
      const items = byCode('items'), loc = byCode('locations');
      return rows.map(r => {
        const e = [];
        const it = items[str(r.item_code).toUpperCase()];
        if (!it) e.push(`item "${r.item_code}" not found — import items first`);
        const l = loc[str(r.location_code).toUpperCase()];
        if (!l) e.push(`location "${r.location_code}" unknown`); else if (!l.is_stock) e.push('location does not hold stock');
        const q = numOrNull(r.qty); if (!(q > 0)) e.push('qty must be > 0');
        const c = numOrNull(r.unit_cost); if (c === null || Number.isNaN(c) || c < 0) e.push('unit_cost must be ≥ 0');
        const rd = isoDate(r.original_receipt_date); if (!rd || rd === 'INVALID') e.push('original_receipt_date required (dd/mm/yyyy)');
        else if (rd > today()) e.push('original_receipt_date is in the future');
        const ex = isoDate(r.expiry_date); if (ex === 'INVALID') e.push('expiry_date is not a date');
        const serial = it?.item_classes?.tracking === 'SERIAL';
        const sn = str(r.serial_nos) ? str(r.serial_nos).split(',').map(s => s.trim()).filter(Boolean) : null;
        if (serial && q && q !== Math.trunc(q)) e.push('serialised item needs a whole qty');
        if (sn && sn.length !== q) e.push(`serial_nos lists ${sn.length} numbers but qty is ${q}`);
        return { row: { item_id: it?.id, location_id: l?.id, received_qty: q, accepted_qty: q, rate: c, vat_rate: 0, original_receipt_date: rd === 'INVALID' ? null : rd,
                        lot_no: str(r.lot_no) || null, batch_no: str(r.batch_no) || null, expiry_date: ex === 'INVALID' ? null : ex, serial_nos: sn, remarks: str(r.remarks) || null },
                 _action: 'OPENING', _errors: e };
      });
    },
    async save(valid) {
      const g = must(await sb.from('grns').insert({ receipt_type: 'OPENING', grn_date: today(), location_id: valid[0].row.location_id, remarks: `Opening stock imported from Excel (${valid.length} lines)` }).select().single());
      for (let i = 0; i < valid.length; i += 200) {
        must(await sb.from('grn_lines').insert(valid.slice(i, i + 200).map((v, j) => ({ ...v.row, grn_id: g.id, line_no: i + j + 1 }))));
      }
      setTimeout(() => go('d/grn/' + g.id), 800);
      return `Draft opening-stock GRN ${g.grn_no} created with ${valid.length} lines — review and post it`;
    },
    lists: () => ({ Items: (state.refs.items || []).map(r => ({ item_code: r.code, name: r.name, uom: r.uoms?.code, class: r.item_classes?.code })),
                    Locations: (state.refs.locations || []).filter(l => l.is_stock).map(r => ({ location_code: r.code, name: r.name })) }),
  },
};

export const Importer = {
  components: { DataTable },
  props: { tkey: String },
  data: () => ({ result: null, busy: false, fileName: '' }),
  computed: {
    tabs() { return Object.entries(TEMPLATES).map(([k, t]) => ({ k, t: t.title, ok: hasRole(...t.roles) })); },
    t() { return TEMPLATES[this.tkey] || TEMPLATES.items; },
    allowed() { return hasRole(...this.t.roles); },
    valid() { return (this.result || []).filter(r => !r._errors.length); },
    invalid() { return (this.result || []).filter(r => r._errors.length); },
    previewCols() {
      const base = this.tkey === 'opening'
        ? [{ k: r => r._src.item_code, label: 'Item' }, { k: r => r._src.location_code, label: 'Location' }, { k: r => r.row.received_qty, label: 'Qty', fmt: 'qty' }, { k: r => r.row.rate, label: 'Unit cost', fmt: 'money' }, { k: r => r.row.original_receipt_date, label: 'Receipt date', fmt: 'date' }]
        : [{ k: r => r.row.code, label: 'Code' }, { k: r => r.row.name, label: 'Name' }];
      return [{ k: '_line', label: 'Row', n: true }, ...base, { k: '_action', label: 'Action', fmt: 'badge' }, { k: r => r._errors.length ? 'ERROR' : 'OK', label: 'Check', fmt: 'badge' }, { k: r => r._errors.join('; '), label: 'Problems' }];
    },
  },
  watch: { tkey() { this.result = null; this.fileName = ''; } },
  async mounted() { await loadRefs(['item_classes', 'item_categories', 'uoms', 'locations', 'items', 'vendors', 'payment_terms']); },
  methods: {
    async template() {
      await run(async () => {
        const X = await loadXlsx();
        const wb = X.utils.book_new();
        const ws = X.utils.aoa_to_sheet([this.t.cols, this.t.example]);
        ws['!cols'] = this.t.cols.map(c => ({ wch: Math.max(12, c.length + 2) }));
        X.utils.book_append_sheet(wb, ws, this.t.title.replace(/\s/g, ''));
        const help = [['How to fill'], [this.t.help], [''], ['Required columns: ' + this.t.required.join(', ')], ['Yes/No columns: Y or N'], ['Dates: dd/mm/yyyy'], ['Delete the example row before uploading.']];
        X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(help), 'Instructions');
        for (const [name, rows] of Object.entries(this.t.lists())) if (rows.length) X.utils.book_append_sheet(wb, X.utils.json_to_sheet(rows), name);
        X.writeFile(wb, `CitiHomes_${this.tkey}_template.xlsx`);
      });
    },
    async upload(ev) {
      const f = ev.target.files[0]; ev.target.value = '';
      if (!f) return;
      this.fileName = f.name; this.result = null; this.busy = true;
      await run(async () => {
        await loadRefs(this.t.refs, true);
        const X = await loadXlsx();
        const wb = X.read(await f.arrayBuffer(), { cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw = X.utils.sheet_to_json(ws, { defval: '', raw: true });
        if (!raw.length) throw new Error('The first sheet has no data rows');
        const norm = raw.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.trim().toLowerCase().replace(/\s+/g, '_').replace(/\*$/, ''), v])));
        const missing = this.t.required.filter(c => !(c in norm[0]));
        if (missing.length) throw new Error('Missing columns: ' + missing.join(', ') + '. Download the template to see the expected headings.');
        const rows = norm.filter(r => Object.values(r).some(v => str(v) !== ''));
        rows.forEach(r => { for (const c of this.t.required) if (str(r[c]) === '') r.__missing = [...(r.__missing || []), c]; });
        const out = await this.t.validate(rows);
        out.forEach((o, i) => { o._line = i + 2; o._src = rows[i]; if (rows[i].__missing) o._errors.unshift('missing ' + rows[i].__missing.join(', ')); });
        this.result = out;
      });
      this.busy = false;
    },
    async doImport() {
      if (!this.valid.length) return;
      this.busy = true;
      const msg = await run(() => this.t.save(this.valid));
      this.busy = false;
      if (msg) { toast(msg, 'ok', 8000); this.result = null; this.fileName = ''; }
    },
  },
  template: `<div>
    <div class="tabs"><a v-for="x in tabs" :href="'#/import/' + x.k" :class="{on: (tkey || 'items') === x.k}">{{ x.t }}</a></div>
    <div class="card">
      <div class="hd"><h3>Import {{ t.title }} from Excel</h3></div>
      <p class="small muted" style="margin-top:0">{{ t.help }}</p>
      <div v-if="!allowed" class="muted">Your role cannot import {{ t.title.toLowerCase() }}.</div>
      <div v-else class="row">
        <button class="btn" @click="template">⬇ Download template</button>
        <label class="btn primary" style="cursor:pointer">⬆ Upload filled Excel<input type="file" accept=".xlsx,.xls,.csv" @change="upload" style="display:none"></label>
        <span class="muted small" v-if="fileName">{{ fileName }}</span>
        <span class="muted small" v-if="busy">Working…</span>
      </div>
    </div>
    <div class="card" v-if="result">
      <div class="hd"><h3>Check result: {{ valid.length }} ready, {{ invalid.length }} with problems</h3><span class="spacer"></span>
        <button class="btn primary" :disabled="busy || !valid.length" @click="doImport">Import {{ valid.length }} valid rows</button></div>
      <p class="small muted" style="margin-top:0" v-if="invalid.length">Rows with problems are skipped. Fix them in Excel and upload again — already imported rows are updated, not duplicated.</p>
      <DataTable :columns="previewCols" :rows="result" :searchable="true" filename="import_check" />
    </div>
  </div>`,
};
