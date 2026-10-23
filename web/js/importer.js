// Excel import: download template -> fill -> upload -> validate -> import
// Items and vendors are upserted by code; opening stock becomes a DRAFT opening-stock GRN
import { sb, state, must, run, rpc, hasRole, loadRefs, loadRef, toast, go, today, num, qty } from './lib.js';
import { DataTable } from './components.js';

const XLSX_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
let xlsxLoading = null;
export function loadXlsx() {
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
    help: 'One row per item. Existing item codes are updated; new codes are created. Put AUTO in item_code to number automatically by class (e.g. RM-0001). ' +
      'batch_controlled and has_expiry (Y / N) must be answered for every stocked item; they cannot be changed once the item has receipts.',
    cols: ['item_code', 'item_name', 'class_code', 'category_code', 'uom_code', 'brand', 'specification', 'length_mm', 'width_mm', 'thickness_mm',
           'vat_rate', 'batch_controlled', 'has_expiry', 'shelf_life_days', 'buffer_target', 'safety_stock', 'reorder_level', 'reorder_qty', 'max_stock', 'moq', 'order_multiple',
           'lead_time_days', 'standard_cost', 'default_location_code', 'dbm_enabled', 'description'],
    required: ['item_code', 'item_name', 'class_code', 'uom_code'],
    example: ['AUTO', 'MDF 18mm 1220x2440 plain', 'RM', 'RM-BRD', 'SHT', 'Kronospan', 'E1 grade', 2440, 1220, 18, 5, 'Y', 'N', '', 60, 10, '', '', 120, 20, 10, 14, 95, 'MS', 'Y', ''],
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
        // batch / expiry: required Y / N for stocked lot items; not applicable to assets and services
        const stocked = c && c.tracking === 'LOT' && c.valuation_method !== 'EXPENSE';
        const yn = v => ['y', 'yes', 'true', '1'].includes(str(v).toLowerCase()) ? true : ['n', 'no', 'false', '0'].includes(str(v).toLowerCase()) ? false : null;
        const bc = stocked ? yn(r.batch_controlled) : false, he = stocked ? yn(r.has_expiry) : false;
        if (stocked && bc === null) e.push('batch_controlled must be Y or N');
        if (stocked && he === null) e.push('has_expiry must be Y or N');
        let code = str(r.item_code).toUpperCase() === 'AUTO' ? null : str(r.item_code);
        if (code === null && c) autoCount[c.code] = (autoCount[c.code] || 0) + 1;
        const row = {
          code, name: str(r.item_name), class_id: c?.id, category_id: ct?.id || null, uom_id: u?.id, brand: str(r.brand) || null, specification: str(r.specification) || null,
          length_mm: n.length_mm, width_mm: n.width_mm, thickness_mm: n.thickness_mm, vat_rate: n.vat_rate ?? 5, batch_controlled: !!bc, has_expiry: !!he, shelf_life_days: he ? n.shelf_life_days : null,
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
    help: 'One row per vendor. New vendors: put AUTO in vendor_code to number automatically (V0001…); payment_term_code is required. ' +
      'Existing vendor codes are updated, and a blank cell keeps the current value, so you can fill in only what is missing. TRN must be 15 digits. ' +
      'The download contains all your current vendors.',
    cols: ['vendor_code', 'vendor_name', 'vendor_type', 'vat_registered', 'trn', 'trade_license_no', 'trade_license_expiry', 'address', 'emirate', 'country',
           'contact_person', 'phone', 'email', 'currency', 'payment_term_code', 'credit_limit', 'bank_name', 'bank_account_name', 'iban', 'swift_code', 'supplies_classes', 'status'],
    required: ['vendor_code', 'vendor_name'],
    async prefill() {
      const vs = must(await sb.from('vendors').select('*, payment_terms(code)').order('code'));
      const d = v => v ? v.split('-').reverse().join('/') : '';
      return { Vendors: vs.map(v => [v.code, v.name, v.vendor_type, v.vat_registered ? 'Y' : 'N', v.trn || '', v.trade_license_no || '', d(v.trade_license_expiry), v.address || '',
        v.emirate || '', v.country || '', v.contact_person || '', v.phone || '', v.email || '', v.currency, v.payment_terms?.code || '', v.credit_limit ?? '',
        v.bank_name || '', v.bank_account_name || '', v.iban || '', v.swift_code || '', (v.supplies_classes || []).join(','), v.status]) };
    },
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
        const isNew = str(r.vendor_code).toUpperCase() === 'AUTO' || !vendors[str(r.vendor_code).toUpperCase()];
        const t = pt[str(r.payment_term_code).toUpperCase()];
        if (str(r.payment_term_code) === '') { if (isNew) e.push('payment_term_code is required for a new vendor'); }
        else if (!t) e.push(`payment term "${r.payment_term_code}" unknown`);
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
        // an existing vendor: blank cells keep what is on file (only filled-in columns are changed)
        if (!isNew) {
          const src = { name: 'vendor_name', payment_term_id: 'payment_term_code' };
          for (const k of Object.keys(row)) if (k !== 'code' && str(r[src[k] || k]) === '') delete row[k];
        }
        return { row, _action: isNew ? 'CREATE' : 'UPDATE', _errors: e };
      });
    },
    async save(valid) {
      const adds = valid.filter(v => v._action === 'CREATE').map(v => v.row), upds = valid.filter(v => v._action === 'UPDATE');
      for (let i = 0; i < adds.length; i += 200) must(await sb.from('vendors').insert(adds.slice(i, i + 200)));
      // updates one by one, each with only the columns filled in the file
      for (const v of upds) { const { code, ...set } = v.row; if (Object.keys(set).length) must(await sb.from('vendors').update(set).eq('code', code)); }
      await loadRef('vendors', true);
      return `${adds.length} vendor${adds.length === 1 ? '' : 's'} created, ${upds.length} updated`;
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

  // BOM & man-hours: two sheets; each product in the file becomes a new active BOM version (bom_import)
  bom: {
    title: 'BOM & man-hours', roles: ['production_incharge', 'factory_manager'],
    help: 'Sheet "Materials": one row per material of a product, quantity per piece. Sheet "Stages": one row per production stage — work centre, labour and machine hours per piece. ' +
      'Each product in the file gets a new BOM version that becomes the active one; the previous version is kept for history. A product listed on only one sheet keeps the other part ' +
      '(and its cut list) from its current BOM, so hours can be updated on their own. The download contains your current BOMs, ready to edit.',
    sheets: [
      { name: 'Materials', cols: ['product_code', 'material_code', 'qty_per_piece', 'notes'], required: ['product_code', 'material_code', 'qty_per_piece'], example: ['FG-0001', 'RM-0003', 0.38, ''] },
      { name: 'Stages', cols: ['product_code', 'seq', 'work_center_code', 'labour_hours', 'machine_hours', 'instructions'], required: ['product_code', 'work_center_code'],
        example: ['FG-0001', 10, 'CNC-NCG2812', 1.5, 1.5, 'Cutting / CNC'] },
    ],
    refs: ['items', 'work_centers', 'item_classes'],
    async prefill() {
      const ts = must(await sb.from('bom_templates').select('id, items(code), bom_template_materials(line_no, qty, notes, items(code)), bom_template_routing(seq, std_labour_hours, std_machine_hours, instructions, work_centers(code))').eq('is_active', true));
      const byProd = [...ts].sort((a, b) => str(a.items?.code).localeCompare(str(b.items?.code)));
      return {
        Materials: byProd.flatMap(t => [...t.bom_template_materials].sort((a, b) => a.line_no - b.line_no).map(m => [t.items?.code, m.items?.code, Number(m.qty), m.notes || ''])),
        Stages: byProd.flatMap(t => [...t.bom_template_routing].sort((a, b) => a.seq - b.seq).map(r => [t.items?.code, r.seq, r.work_centers?.code, Number(r.std_labour_hours), Number(r.std_machine_hours), r.instructions || ''])),
      };
    },
    async validate(rows) {
      const items = byCode('items'), wcs = byCode('work_centers');
      const out = rows.map((r, i) => {
        const e = [], m = r.__sheet === 'Materials';
        const p = items[str(r.product_code).toUpperCase()];
        if (!p) e.push(`product "${r.product_code}" not in the item master`); else if (p.item_classes?.code !== 'FG') e.push(`"${r.product_code}" is not a finished-goods item`);
        const row = { sheet: m ? 'M' : 'S', product: p?.code || str(r.product_code), ord: i + 1, notes: str(m ? r.notes : r.instructions) };
        if (m) {
          const it = items[str(r.material_code).toUpperCase()];
          if (!it) e.push(`material "${r.material_code}" not in the item master`);
          else if (['SRV'].includes(it.item_classes?.code) || it.item_classes?.tracking === 'SERIAL') e.push(`"${r.material_code}" is a service or asset, not a material`);
          const q = numOrNull(r.qty_per_piece); if (!(q > 0)) e.push('qty_per_piece must be more than 0');
          Object.assign(row, { material: it?.code || str(r.material_code), qty: q });
        } else {
          const w = wcs[str(r.work_center_code).toUpperCase()];
          if (!w) e.push(`work centre "${r.work_center_code}" not found`); else if (w.kind === 'UTILITY') e.push(`"${r.work_center_code}" is a utility, not a production stage`);
          const s = numOrNull(r.seq), l = numOrNull(r.labour_hours), h = numOrNull(r.machine_hours);
          if (Number.isNaN(s) || (s !== null && !Number.isInteger(s))) e.push('seq must be a whole number');
          if (Number.isNaN(l) || l < 0) e.push('labour_hours must be 0 or more');
          if (Number.isNaN(h) || h < 0) e.push('machine_hours must be 0 or more');
          if (w && w.kind !== 'MACHINE' && h > 0) e.push('machine hours only on a machine work centre');
          Object.assign(row, { wc: w?.code || str(r.work_center_code), seq: s, labour: l ?? 0, machine: h ?? 0 });
        }
        return { row, _errors: e };
      });
      // a product is loaded whole or not at all
      const bad = new Set(out.filter(o => o._errors.length).map(o => o.row.product));
      out.forEach(o => { if (!o._errors.length && bad.has(o.row.product)) o._errors.push('another row of this product has a problem — fix it to load this product'); });
      const ver = {};
      (await sb.from('bom_templates').select('item_id, version')).data?.forEach(t => { ver[t.item_id] = Math.max(ver[t.item_id] || 0, t.version || 1); });
      out.forEach(o => { const it = items[o.row.product.toUpperCase()]; o._action = 'NEW VERSION v' + ((ver[it?.id] || 0) + 1); });
      return out;
    },
    preview: [{ k: '_sheet', label: 'Sheet' }, { k: r => r.row.product, label: 'Product' }, { k: r => r.row.sheet === 'M' ? r.row.material : r.row.wc, label: 'Material / work centre' },
      { k: r => r.row.sheet === 'M' ? qty(r.row.qty) : `${qty(r.row.labour)} h labour · ${qty(r.row.machine)} h machine`, label: 'Qty / hours per piece' }],
    async save(valid, file) {
      const res = await rpc('bom_import', { p_rows: valid.map(v => v.row), p_file: file || null });
      await loadRef('items', true);
      return `${res.length} BOM${res.length === 1 ? '' : 's'} saved as new versions: ` + res.map(r => `${r.product} v${r.version}`).join(', ');
    },
    lists: () => ({ 'Product list': (state.refs.items || []).filter(r => r.item_classes?.code === 'FG' && r.is_active).map(r => ({ product_code: r.code, name: r.name })),
                    'Material list': (state.refs.items || []).filter(r => r.is_active && !['FG', 'SRV'].includes(r.item_classes?.code) && r.item_classes?.tracking !== 'SERIAL').map(r => ({ material_code: r.code, name: r.name, uom: r.uoms?.code })),
                    'Work centre list': (state.refs.work_centers || []).filter(w => w.is_active && w.kind !== 'UTILITY').map(w => ({ work_center_code: w.code, name: w.name, kind: w.kind })) }),
  },

  // machine rates & calculator inputs per work centre (work_center_import → machine_rate_apply for rate changes)
  machines: {
    title: 'Machine rates', roles: ['factory_manager', 'finance'],
    help: 'One row per work centre (existing codes only). Blank cells keep the current value. A machine rate that differs from today\'s is applied and recorded in the machine-rate history ' +
      'as a manual rate with this file\'s name. Rates apply to machines only; manual stages use the worker grade or the labour-rate override. The download contains every work centre with its current values.',
    cols: ['work_center_code', 'name', 'kind', 'machine_rate_per_hour', 'hours_per_day', 'power_kw', 'load_factor_pct', 'tooling_cost_per_year', 'working_days_per_year', 'utilisation_pct',
           'default_grade_code', 'labour_rate_per_hour', 'notes'],
    required: ['work_center_code'],
    example: ['CNC-NCG2812', 'NCG2812E CNC router', 'MACHINE', 45, 9, 24, 70, 12000, 312, 85, 'CNC', '', 'Supplier quote Oct-26'],
    refs: ['work_centers', 'labour_grades'],
    async prefill() {
      const ws = must(await sb.from('work_centers').select('code,name,kind,machine_rate_per_hour,hours_per_day,power_kw,load_factor_pct,tooling_cost_per_year,working_days_per_year,utilisation_pct,labour_rate_per_hour,labour_grades(code)').order('sort_order'));
      return { [this.title.replace(/\s/g, '')]: ws.map(w => [w.code, w.name, w.kind, w.kind === 'MACHINE' ? Number(w.machine_rate_per_hour) : '', Number(w.hours_per_day), Number(w.power_kw), Number(w.load_factor_pct),
        Number(w.tooling_cost_per_year), w.working_days_per_year, Number(w.utilisation_pct), w.labour_grades?.code || '', w.labour_rate_per_hour ?? '', '']) };
    },
    async validate(rows) {
      const wcs = byCode('work_centers'), grades = byCode('labour_grades');
      return rows.map(r => {
        const e = [], w = wcs[str(r.work_center_code).toUpperCase()];
        if (!w) e.push(`work centre "${r.work_center_code}" not found — add it in Masters → Work centres first`);
        const row = { code: w?.code || str(r.work_center_code), name: w?.name || str(r.name) };
        for (const k of ['machine_rate_per_hour', 'hours_per_day', 'power_kw', 'load_factor_pct', 'tooling_cost_per_year', 'working_days_per_year', 'utilisation_pct', 'labour_rate_per_hour']) {
          const v = numOrNull(r[k]);
          if (Number.isNaN(v) || v < 0) { e.push(`${k} must be a number, 0 or more`); continue; }
          if (v !== null) row[k === 'machine_rate_per_hour' ? 'rate' : k] = v;
        }
        if (row.hours_per_day > 24 && w?.kind === 'MACHINE') e.push('hours_per_day over 24 for a single machine');
        for (const k of ['load_factor_pct', 'utilisation_pct']) if (row[k] > 100) e.push(`${k} over 100`);
        if (row.working_days_per_year > 366) e.push('working_days_per_year over 366');
        if (row.rate !== undefined && w && w.kind !== 'MACHINE' && row.rate > 0) e.push('a machine rate only applies to a machine work centre');
        if (row.rate !== undefined && w && w.kind !== 'MACHINE') delete row.rate;
        const g = str(r.default_grade_code);
        if (g && !grades[g.toUpperCase()]) e.push(`grade "${g}" not found`); else if (g) row.grade = grades[g.toUpperCase()].code;
        if (str(r.notes)) row.notes = str(r.notes);
        const rateChange = row.rate !== undefined && Math.round(row.rate * 100) !== Math.round(num(w?.machine_rate_per_hour) * 100);
        return { row, _action: rateChange ? 'RATE ' + num(w?.machine_rate_per_hour) + ' → ' + row.rate : 'UPDATE', _errors: e };
      });
    },
    async save(valid, file) {
      const n = await rpc('work_center_import', { p_rows: valid.map(v => v.row), p_file: file || null });
      await loadRef('work_centers', true);
      return `${n} work centres updated; changed machine rates are in the machine-rate history`;
    },
    lists: () => ({ 'Grade list': (state.refs.labour_grades || []).map(g => ({ default_grade_code: g.code, name: g.name, rate_per_hour: g.rate_per_hour })) }),
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
    // a template is one sheet (cols / required / example) or several named sheets
    sheetDefs() { return this.t.sheets || [{ name: null, cols: this.t.cols, required: this.t.required, example: this.t.example }]; },
    previewCols() {
      if (this.t.preview) return [{ k: '_line', label: 'Row', n: true }, ...this.t.preview, { k: '_action', label: 'Action', fmt: 'badge' },
        { k: r => r._errors.length ? 'ERROR' : 'OK', label: 'Check', fmt: 'badge' }, { k: r => r._errors.join('; '), label: 'Problems' }];
      const base = this.tkey === 'opening'
        ? [{ k: r => r._src.item_code, label: 'Item' }, { k: r => r._src.location_code, label: 'Location' }, { k: r => r.row.received_qty, label: 'Qty', fmt: 'qty' }, { k: r => r.row.rate, label: 'Unit cost', fmt: 'money' }, { k: r => r.row.original_receipt_date, label: 'Receipt date', fmt: 'date' }]
        : [{ k: r => r.row.code, label: 'Code' }, { k: r => r.row.name, label: 'Name' }];
      return [{ k: '_line', label: 'Row', n: true }, ...base, { k: '_action', label: 'Action', fmt: 'badge' }, { k: r => r._errors.length ? 'ERROR' : 'OK', label: 'Check', fmt: 'badge' }, { k: r => r._errors.join('; '), label: 'Problems' }];
    },
  },
  watch: { tkey() { this.result = null; this.fileName = ''; } },
  async mounted() { await loadRefs(['item_classes', 'item_categories', 'uoms', 'locations', 'items', 'vendors', 'payment_terms', 'work_centers', 'labour_grades']); },
  methods: {
    async template() {
      await run(async () => {
        const X = await loadXlsx();
        await loadRefs(this.t.refs || [], true);
        const wb = X.utils.book_new();
        // templates that edit existing data come pre-filled with it (current BOMs, work centres)
        const pre = this.t.prefill ? await this.t.prefill() : null;
        for (const d of this.sheetDefs) {
          const name = d.name || this.t.title.replace(/\s/g, '');
          const rows = pre?.[name]?.length ? pre[name] : [d.example];
          const ws = X.utils.aoa_to_sheet([d.cols, ...rows]);
          ws['!cols'] = d.cols.map(c => ({ wch: Math.max(12, c.length + 2) }));
          X.utils.book_append_sheet(wb, ws, name);
        }
        const req = this.sheetDefs.map(d => (d.name ? d.name + ': ' : '') + d.required.join(', '));
        const help = [['How to fill'], [this.t.help], [''], ['Required columns — ' + req.join(' · ')], ['Yes/No columns: Y or N'], ['Dates: dd/mm/yyyy'],
          [pre ? 'The rows are your current data: change what you need and upload.' : 'Delete the example row before uploading.']];
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
        const rows = [];
        for (const d of this.sheetDefs) {
          const sn = d.name ? wb.SheetNames.find(n => n.trim().toLowerCase() === d.name.toLowerCase()) : wb.SheetNames[0];
          if (!sn) continue;
          const raw = X.utils.sheet_to_json(wb.Sheets[sn], { defval: '', raw: true, blankrows: true });
          const norm = raw.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.trim().toLowerCase().replace(/\s+/g, '_').replace(/\*$/, ''), v])));
          const filled = norm.map((r, i) => ({ r, line: i + 2 })).filter(x => Object.values(x.r).some(v => str(v) !== ''));
          if (!filled.length) continue;
          const missing = d.required.filter(c => !(c in filled[0].r));
          if (missing.length) throw new Error(`${d.name ? 'Sheet "' + d.name + '": m' : 'M'}issing columns: ${missing.join(', ')}. Download the template to see the expected headings.`);
          filled.forEach(({ r, line }) => {
            r.__sheet = d.name; r.__line = line;
            for (const c of d.required) if (str(r[c]) === '') r.__missing = [...(r.__missing || []), c];
            rows.push(r);
          });
        }
        if (!rows.length) throw new Error(this.t.sheets ? `No rows found on the ${this.t.sheets.map(d => '"' + d.name + '"').join(' / ')} sheet(s)` : 'The first sheet has no data rows');
        const out = await this.t.validate(rows);
        out.forEach((o, i) => { o._line = rows[i].__line; o._sheet = rows[i].__sheet; o._src = rows[i]; if (rows[i].__missing) o._errors.unshift('missing ' + rows[i].__missing.join(', ')); });
        this.result = out;
      });
      this.busy = false;
    },
    async doImport() {
      if (!this.valid.length) return;
      this.busy = true;
      const msg = await run(() => this.t.save(this.valid, this.fileName));
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
