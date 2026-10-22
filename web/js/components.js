// Reusable UI components: searchable reference select, field input, data table, modal, dialogs
import { reactive } from 'vue';
import { sb, state, REF, money, qty, dt, dtm, label, downloadCSV, canSeeCost, hasRole, run, rpc, must, toast, loadRef, ROLES, MASTER_REQ, reqRoute, reqOwners, reqNoun } from './lib.js';

// ---------- global dialog (confirm / prompt with fields) ----------
export const dialog = reactive({ open: false, title: '', message: '', fields: [], values: {}, resolve: null, okText: 'OK', danger: false });
export function ask({ title, message = '', fields = [], okText = 'OK', danger = false }) {
  return new Promise(resolve => {
    const values = {};
    fields.forEach(f => { values[f.k] = f.default ?? (f.type === 'number' ? null : ''); });
    Object.assign(dialog, { open: true, title, message, fields, values, resolve, okText, danger });
  });
}
export const confirmBox = (title, message, danger = false) => ask({ title, message, danger, okText: 'Yes, continue' }).then(v => !!v);

// Ask the keepers of a master to create a missing entry. Works from inside another dialog too (it is put back afterwards).
export async function requestMaster({ kind, list, name = '', context = '' }) {
  const noun = reqNoun(kind, list);
  const owners = reqOwners(kind, list).map(r => ROLES[r]).join(' / ') || 'the administrator';
  const outer = dialog.open ? { ...dialog, values: { ...dialog.values } } : null;
  const v = await ask({
    title: `Request a new ${noun}`,
    message: `Only entries that are set up can be selected. ${owners} will be asked to create it; you are notified when it is ready to pick.`,
    fields: [{ k: 'name', label: `Name of the ${noun}`, required: true, default: name },
      { k: 'details', label: kind === 'VENDOR' || kind === 'CUSTOMER' ? 'Details (TRN, phone, contact, what they supply…)' : 'Details / why it is needed', type: 'textarea' }],
    okText: 'Send request',
  });
  if (outer) Object.assign(dialog, outer);
  if (!v) return null;
  const no = await run(() => rpc('master_request_create', { p_kind: kind, p_name: v.name, p_details: v.details || null, p_list: list || null, p_context: context || null }));
  if (no && no !== true) toast(`Request ${no} sent to ${owners}. You will be told when "${v.name.trim()}" can be selected.`, 'ok', 7000);
  return no;
}

// Fields that store a name / code as text but must still be picked from a master (e.g. driver, unit of measure)
export const namePick = (ref, more = {}) => ({ type: 'ref', request: { kind: MASTER_REQ[ref].kind },
  refOptions: () => (state.refs[ref] || []).filter(r => r.is_active !== false && r.status !== 'BLOCKED').map(r => ({ id: r.name, label: r.name })), ...more });
export const uomPick = (more = {}) => ({ type: 'ref', request: { kind: 'UOM' }, refOptions: () => (state.refs.uoms || []).map(u => ({ id: u.code, label: u.code })), ...more });
export const CURRENCIES = ['AED', 'USD', 'EUR', 'GBP', 'CNY', 'INR', 'SAR', 'TRY', 'JPY'].map(v => ({ v, l: v }));

// ---------- searchable reference select ----------
// Missing entries can't be typed in: the bottom row requests one (or, for the people who keep that master, opens it to add one).
export const RefSelect = {
  props: { modelValue: null, refName: String, filter: Function, disabled: Boolean, placeholder: String, options: Array, request: { type: [Object, Boolean], default: null }, context: String },
  emits: ['update:modelValue', 'pick'],
  data: () => ({ open: false, q: '', hi: 0 }),
  computed: {
    req() {
      if (this.request === false) return null;
      if (this.request) return this.request;
      if (this.options) return null;   // a document's own picks (lots, open invoices…), not a master
      const m = MASTER_REQ[this.refName];
      return m ? { kind: m.kind } : null;
    },
    reqText() {
      if (!this.req) return '';
      const noun = reqNoun(this.req.kind, this.req.list);
      return this.isOwner ? `➕ Add a new ${noun}${this.req.kind === 'LOOKUP' ? '' : ' (opens in a new tab)'}` : `➕ Not listed? Request a new ${noun}`;
    },
    isOwner() { return !!this.req && hasRole(...reqOwners(this.req.kind, this.req.list)); },
    source() { return this.options || state.refs[this.refName] || []; },
    all() { return this.filter ? this.source.filter(this.filter) : this.source; },
    current() {
      if (!this.modelValue) return '';
      const r = this.source.find(r => r.id === this.modelValue);
      if (r) return this.lab(r);
      // an old typed-in name kept on a record, not in the master
      return this.options && typeof this.modelValue === 'string' && !/^[0-9a-f-]{36}$/.test(this.modelValue) ? this.modelValue + ' (not in the list)' : '…';
    },
    list() {
      const q = this.q.toLowerCase().trim();
      const out = [];
      for (const r of this.all) {
        if (!q || this.lab(r).toLowerCase().includes(q)) { out.push(r); if (out.length >= 80) break; }
      }
      return out;
    },
  },
  methods: {
    lab(r) { return this.options ? r.label : REF[this.refName].label(r); },
    focus() { if (this.disabled) return; this.open = true; this.q = ''; this.hi = 0; },
    blur() { setTimeout(() => { this.open = false; this.q = ''; }, 150); },
    pick(r) { this.$emit('update:modelValue', r ? r.id : null); this.$emit('pick', r); this.open = false; this.q = ''; },
    async doRequest() {
      const q = this.q.trim(), req = this.req;
      this.open = false; this.q = '';
      if (this.isOwner && req.kind === 'LOOKUP') {
        // keepers of a list add the value straight away and it is picked
        const v = await ask({ title: `Add a ${reqNoun(req.kind, req.list)}`, fields: [{ k: 'value', label: 'Value', required: true, default: q }], okText: 'Add' });
        if (!v) return;
        const row = await run(async () => must(await sb.from('lookup_values').upsert({ list_key: req.list, value: v.value.trim(), is_active: true }, { onConflict: 'list_key,value' }).select().single()), 'Added to the list');
        if (row && row !== true) { await loadRef('lookups', true); this.$emit('update:modelValue', row.value); }
        return;
      }
      if (this.isOwner) {
        const to = reqRoute(req.kind);
        if (to) {
          window.open(location.pathname + '#/' + to, '_blank');
          // the list is re-read when the user comes back to this tab
          const ref = this.refName;
          window.addEventListener('focus', () => { if (ref) loadRef(ref, true); }, { once: true });
          return;
        }
      }
      await requestMaster({ kind: req.kind, list: req.list, name: q, context: [this.context, location.hash.replace(/^#\//, '')].filter(Boolean).join(' · ') });
    },
    key(e) {
      if (e.key === 'ArrowDown') { this.hi = Math.min(this.hi + 1, this.list.length - 1); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { this.hi = Math.max(this.hi - 1, 0); e.preventDefault(); }
      else if (e.key === 'Enter') { if (this.list[this.hi]) this.pick(this.list[this.hi]); e.preventDefault(); }
      else if (e.key === 'Escape') { this.open = false; }
    },
  },
  template: `<div class="combo">
    <input :value="open ? q : current" @input="q=$event.target.value; hi=0" @focus="focus" @blur="blur" @keydown="key"
           :disabled="disabled" :placeholder="placeholder || 'Search…'" autocomplete="off" :title="current">
    <div class="dd" v-if="open && !disabled">
      <div v-if="modelValue" class="muted" @mousedown.prevent="pick(null)">— clear —</div>
      <div v-for="(r,i) in list" :key="r.id" :class="{hi: i===hi}" @mousedown.prevent="pick(r)">{{ lab(r) }}</div>
      <div v-if="!list.length" class="muted">No matches</div>
      <div v-if="req" class="dd-req" @mousedown.prevent="doRequest">{{ reqText }}<span v-if="q.trim()"> “{{ q.trim() }}”</span></div>
    </div>
  </div>`,
};

// ---------- field input ----------
// field spec: { k, label, type, options, ref, filter(row, doc), required, ro, show, wide, full, cost, fmt }
export const FieldInput = {
  components: { RefSelect },
  props: { f: Object, doc: Object, disabled: Boolean, bare: Boolean },
  emits: ['changed'],
  computed: {
    ro() { return this.disabled || this.f.type === 'ro' || (typeof this.f.ro === 'function' ? this.f.ro(this.doc) : !!this.f.ro); },
    opts() {
      const o = typeof this.f.options === 'function' ? this.f.options(this.doc) : this.f.options;
      return (o || []).map(x => typeof x === 'string' ? { v: x, l: label(x) } : x);
    },
    refOpts() { return typeof this.f.refOptions === 'function' ? this.f.refOptions(this.doc) : null; },
    refFilter() { return this.f.filter ? (r => this.f.filter(r, this.doc)) : null; },
    // type 'lookup': a defined drop-down list (f.list); the text value is stored. An old typed-in value still shows, marked.
    lookupOpts() {
      const rows = (state.refs.lookups || []).filter(r => r.list_key === this.f.list && r.is_active).map(r => ({ id: r.value, label: r.value }));
      const cur = this.doc[this.f.k];
      if (cur && !rows.some(r => r.id === cur)) rows.unshift({ id: cur, label: cur + ' (not in the list)' });
      return rows;
    },
    lookupReq() { return { kind: 'LOOKUP', list: this.f.list }; },
    roText() {
      const v = this.doc[this.f.k];
      if (this.f.fmt) return this.f.fmt(v, this.doc);
      if (this.f.type === 'date') return dt(v);
      if (this.f.type === 'datetime') return dtm(v);
      if (this.f.type === 'number') return qty(v);
      return v ?? '';
    },
    tagText() { return (this.doc[this.f.k] || []).join(', '); },
  },
  methods: {
    // timestamptz <-> <input type="datetime-local"> (local time, minutes)
    toLocal(v) {
      if (!v) return '';
      const d = new Date(v);
      return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    },
    setLocal(v) { this.set(v ? new Date(v).toISOString() : null); },
    set(v) {
      const f = this.f;
      if (f.type === 'number') v = (v === '' || v === null) ? null : Number(v);
      if (f.type === 'tags') v = v.split(',').map(s => s.trim()).filter(Boolean);
      if ((f.type === 'date' || f.type === 'select') && v === '') v = null;
      this.doc[f.k] = v;
      this.$emit('changed', f.k, v);
    },
  },
  template: `
  <label v-if="!bare" class="f" :class="{wide: f.wide, full: f.full}">
    <span>{{ f.label }} <span v-if="f.required" class="req">*</span></span>
    <template v-if="f.type==='ro'"><input :value="roText" readonly></template>
    <RefSelect v-else-if="f.type==='ref'" :modelValue="doc[f.k]" :refName="f.ref" :options="refOpts" :filter="refFilter" :disabled="ro" :request="f.request" :context="f.label" @update:modelValue="set" />
    <RefSelect v-else-if="f.type==='lookup'" :modelValue="doc[f.k]" refName="lookups" :options="lookupOpts" :disabled="ro" :request="lookupReq" :context="f.label" placeholder="Select…" @update:modelValue="set" />
    <select v-else-if="f.type==='select'" :value="doc[f.k] ?? ''" @change="set($event.target.value)" :disabled="ro">
      <option v-if="!f.required" value=""></option>
      <option v-for="o in opts" :value="o.v">{{ o.l }}</option>
    </select>
    <textarea v-else-if="f.type==='textarea'" :value="doc[f.k] ?? ''" @input="set($event.target.value)" :disabled="ro"></textarea>
    <span v-else-if="f.type==='check'" class="row"><input type="checkbox" :checked="!!doc[f.k]" @change="set($event.target.checked)" :disabled="ro"> <span class="small">{{ f.hint || 'Yes' }}</span></span>
    <input v-else-if="f.type==='tags'" :value="tagText" @change="set($event.target.value)" :disabled="ro" placeholder="comma separated">
    <input v-else-if="f.type==='number'" type="number" :step="f.step || 'any'" :value="doc[f.k] ?? ''" @input="set($event.target.value)" :disabled="ro">
    <input v-else-if="f.type==='date'" type="date" :value="doc[f.k] ?? ''" @input="set($event.target.value)" :disabled="ro">
    <input v-else-if="f.type==='datetime'" type="datetime-local" :value="toLocal(doc[f.k])" @change="setLocal($event.target.value)" :disabled="ro">
    <input v-else :value="doc[f.k] ?? ''" @input="set($event.target.value)" :disabled="ro" :placeholder="f.placeholder || ''">
  </label>
  <template v-else>
    <input v-if="f.type==='ro'" :value="roText" readonly>
    <RefSelect v-else-if="f.type==='ref'" :modelValue="doc[f.k]" :refName="f.ref" :options="refOpts" :filter="refFilter" :disabled="ro" :request="f.request" :context="f.label" @update:modelValue="set" />
    <RefSelect v-else-if="f.type==='lookup'" :modelValue="doc[f.k]" refName="lookups" :options="lookupOpts" :disabled="ro" :request="lookupReq" :context="f.label" placeholder="Select…" @update:modelValue="set" />
    <select v-else-if="f.type==='select'" :value="doc[f.k] ?? ''" @change="set($event.target.value)" :disabled="ro">
      <option v-if="!f.required" value=""></option>
      <option v-for="o in opts" :value="o.v">{{ o.l }}</option>
    </select>
    <input v-else-if="f.type==='check'" type="checkbox" :checked="!!doc[f.k]" @change="set($event.target.checked)" :disabled="ro">
    <input v-else-if="f.type==='tags'" :value="tagText" @change="set($event.target.value)" :disabled="ro" placeholder="comma separated">
    <input v-else-if="f.type==='number'" type="number" :step="f.step || 'any'" :value="doc[f.k] ?? ''" @input="set($event.target.value)" :disabled="ro">
    <input v-else-if="f.type==='date'" type="date" :value="doc[f.k] ?? ''" @input="set($event.target.value)" :disabled="ro">
    <input v-else :value="doc[f.k] ?? ''" @input="set($event.target.value)" :disabled="ro">
  </template>`,
};

// ---------- cell formatting ----------
export function cellValue(c, r) {
  return typeof c.k === 'function' ? c.k(r) : r[c.k];
}
export function cellText(c, r) {
  const v = cellValue(c, r);
  if (typeof c.fmt === 'function') return c.fmt(v, r);
  switch (c.fmt) {
    case 'money': return money(v);
    case 'qty': return qty(v);
    case 'date': return dt(v);
    case 'datetime': return dtm(v);
    case 'label': return label(v);
    case 'bool': return v ? 'Yes' : '';
    default: return v ?? '';
  }
}
const isNum = c => c.n || c.fmt === 'money' || c.fmt === 'qty';

// ---------- data table ----------
export const DataTable = {
  props: {
    columns: Array, rows: Array, clickable: Boolean, filename: String,
    searchable: { type: Boolean, default: true }, loading: Boolean, limit: { type: Number, default: 500 },
  },
  emits: ['row'],
  data: () => ({ q: '', sortK: null, sortDir: 1, shown: 500 }),
  computed: {
    cols() { return this.columns.filter(c => !(c.cost && !canSeeCost()) && !c.hidden); },
    filtered() {
      const q = this.q.toLowerCase().trim();
      let rows = this.rows || [];
      if (q) rows = rows.filter(r => this.cols.some(c => String(cellText(c, r)).toLowerCase().includes(q)));
      if (this.sortK !== null) {
        const c = this.cols[this.sortK];
        rows = [...rows].sort((a, b) => {
          let x = cellValue(c, a), y = cellValue(c, b);
          if (isNum(c)) { x = Number(x) || 0; y = Number(y) || 0; }
          else { x = (x ?? '').toString().toLowerCase(); y = (y ?? '').toString().toLowerCase(); }
          return x < y ? -this.sortDir : x > y ? this.sortDir : 0;
        });
      }
      return rows;
    },
    visible() { return this.filtered.slice(0, this.shown); },
    hasTotals() { return this.cols.some(c => c.sum); },
  },
  created() { this.shown = this.limit; },
  methods: {
    text: cellText, isNum, cellValue,
    sort(i) { if (this.sortK === i) this.sortDir = -this.sortDir; else { this.sortK = i; this.sortDir = 1; } },
    total(c) { return this.filtered.reduce((s, r) => s + (Number(cellValue(c, r)) || 0), 0); },
    fmtTotal(c) { return c.fmt === 'qty' ? qty(this.total(c)) : money(this.total(c)); },
    csv() { downloadCSV((this.filename || 'export') + '.csv', this.cols.filter(c => !c.action).map(c => ({ label: c.label, raw: r => cellText(c, r) })), this.filtered); },
  },
  template: `<div>
    <div class="row" style="margin-bottom:8px" v-if="searchable">
      <input v-model="q" placeholder="Search…" style="max-width:280px">
      <span class="muted small">{{ filtered.length }} rows</span>
      <span class="spacer"></span>
      <slot name="tools"></slot>
      <button class="btn sm" @click="csv">⬇ Excel / CSV</button>
    </div>
    <div class="tbl-wrap">
      <table class="t">
        <thead><tr><th v-for="(c,i) in cols" :class="{n: isNum(c)}" @click="sort(i)">{{ c.label }}<span v-if="sortK===i">{{ sortDir>0?' ▲':' ▼' }}</span></th></tr></thead>
        <tbody>
          <tr v-if="loading"><td :colspan="cols.length" class="empty">Loading…</td></tr>
          <tr v-else-if="!filtered.length"><td :colspan="cols.length" class="empty">No records</td></tr>
          <tr v-for="r in visible" :class="{click: clickable}" @click="clickable && $emit('row', r)">
            <td v-for="c in cols" :class="{n: isNum(c)}" :style="c.action ? 'width:1%;white-space:nowrap' : ''">
              <button v-if="c.action" class="btn sm eye" :title="c.title || ''" :aria-label="c.title || ''" @click.stop="c.action(r)">{{ c.icon }}</button>
              <span v-else-if="c.fmt==='badge'" class="b" :class="cellValue(c,r)">{{ label(cellValue(c,r)) }}</span>
              <template v-else>{{ text(c, r) }}</template>
            </td>
          </tr>
        </tbody>
        <tfoot v-if="hasTotals && filtered.length"><tr><td v-for="(c,i) in cols" :class="{n: isNum(c)}">{{ c.sum ? fmtTotal(c) : (i===0 ? 'Total' : '') }}</td></tr></tfoot>
      </table>
    </div>
    <div v-if="filtered.length > shown" class="row" style="margin-top:8px"><button class="btn sm" @click="shown += 500">Show more ({{ filtered.length - shown }} remaining)</button></div>
  </div>`,
  setup() { return { label }; },
};

// ---------- modal ----------
export const Modal = {
  props: { title: String, small: Boolean },
  emits: ['close'],
  template: `<div class="modal-bg" @mousedown.self="$emit('close')">
    <div class="modal" :class="{sm: small}">
      <div class="mh">{{ title }}<span class="spacer"></span><button class="btn sm" @click="$emit('close')">✕</button></div>
      <div class="mb"><slot></slot></div>
      <div class="mf" v-if="$slots.footer"><slot name="footer"></slot></div>
    </div>
  </div>`,
};

// ---------- inline line icons (Tabler outline, MIT) — no external font needed ----------
const ICONS = {
  checkbox: '<path d="M9 11l3 3l8 -8"/><path d="M20 12v6a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h9"/>',
  'layout-dashboard': '<path d="M5 4h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1"/><path d="M5 16h4a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1"/><path d="M15 12h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1"/><path d="M15 4h4a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1"/>',
  'shopping-cart': '<path d="M4 19a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M15 19a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M17 17h-11v-14h-2"/><path d="M6 5l14 1l-1 7h-13"/>',
  'building-warehouse': '<path d="M3 21v-13l9 -4l9 4v13"/><path d="M13 13h4v8h-10v-6h6"/><path d="M13 21v-9a1 1 0 0 0 -1 -1h-2a1 1 0 0 0 -1 1v3"/>',
  'report-money': '<path d="M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2"/><path d="M9 5a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z"/><path d="M14 11h-2.5a1.5 1.5 0 0 0 0 3h1a1.5 1.5 0 0 1 0 3h-2.5"/><path d="M12 17v1m0 -8v1"/>',
  'settings': '<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/>',
  'chevron-down': '<path d="M6 9l6 6l6 -6"/>',
  'tag': '<path d="M7.5 7.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M3 6v5.172a2 2 0 0 0 .586 1.414l7.71 7.71a2.41 2.41 0 0 0 3.408 0l5.592 -5.592a2.41 2.41 0 0 0 0 -3.408l-7.71 -7.71a2 2 0 0 0 -1.414 -.586h-5.172a3 3 0 0 0 -3 3z"/>',
  'users': '<path d="M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0 -3 -3.85"/>',
  'building-community': '<path d="M8 9l5 5v7h-5v-4m0 4h-5v-7l5 -5m1 1v-6a1 1 0 0 1 1 -1h10a1 1 0 0 1 1 1v17h-8"/><path d="M13 7l0 .01"/><path d="M17 7l0 .01"/><path d="M17 11l0 .01"/><path d="M17 15l0 .01"/>',
  'building-factory': '<path d="M3 21h18"/><path d="M5 21v-12l5 4v-4l5 4h4"/><path d="M19 21v-8l-1.436 -9.574a.5 .5 0 0 0 -.495 -.426h-1.145a.5 .5 0 0 0 -.494 .418l-1.43 8.582"/><path d="M9 17h1"/><path d="M14 17h1"/>',
  'chart-bar': '<path d="M3 13a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M15 9a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M9 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M4 20h14"/>',
  'database': '<path d="M4 6a8 3 0 1 0 16 0a8 3 0 1 0 -16 0"/><path d="M4 6v6a8 3 0 0 0 16 0v-6"/><path d="M4 12v6a8 3 0 0 0 16 0v-6"/>',
  'hammer': '<path d="M11.414 10l-7.383 7.418a2.091 2.091 0 0 0 0 2.967a2.11 2.11 0 0 0 2.976 0l7.407 -7.385"/><path d="M18.121 15.293l2.586 -2.586a1 1 0 0 0 0 -1.414l-7.586 -7.586a1 1 0 0 0 -1.414 0l-2.586 2.586a1 1 0 0 0 0 1.414l7.586 7.586a1 1 0 0 0 1.414 0z"/>',
  'bell': '<path d="M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6"/><path d="M9 17v1a3 3 0 0 0 6 0v-1"/>',
  'menu-2': '<path d="M4 6l16 0"/><path d="M4 12l16 0"/><path d="M4 18l16 0"/>',
};
export const Icon = {
  props: { name: String, size: { type: Number, default: 18 } },
  computed: { paths() { return ICONS[this.name] || ''; } },
  template: `<svg class="ico" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" v-html="paths"></svg>`,
};

export const Badge = {
  props: { v: String },
  template: `<span class="b" :class="v">{{ lbl }}</span>`,
  computed: { lbl() { return label(this.v); } },
};
