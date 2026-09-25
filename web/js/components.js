// Reusable UI components: searchable reference select, field input, data table, modal, dialogs
import { reactive } from 'vue';
import { state, REF, money, qty, dt, dtm, label, downloadCSV, canSeeCost } from './lib.js';

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

// ---------- searchable reference select ----------
export const RefSelect = {
  props: { modelValue: null, refName: String, filter: Function, disabled: Boolean, placeholder: String, options: Array },
  emits: ['update:modelValue', 'pick'],
  data: () => ({ open: false, q: '', hi: 0 }),
  computed: {
    source() { return this.options || state.refs[this.refName] || []; },
    all() { return this.filter ? this.source.filter(this.filter) : this.source; },
    current() {
      if (!this.modelValue) return '';
      const r = this.source.find(r => r.id === this.modelValue);
      return r ? this.lab(r) : '…';
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
    roText() {
      const v = this.doc[this.f.k];
      if (this.f.fmt) return this.f.fmt(v, this.doc);
      if (this.f.type === 'date') return dt(v);
      if (this.f.type === 'number') return qty(v);
      return v ?? '';
    },
    tagText() { return (this.doc[this.f.k] || []).join(', '); },
  },
  methods: {
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
    <RefSelect v-else-if="f.type==='ref'" :modelValue="doc[f.k]" :refName="f.ref" :options="refOpts" :filter="refFilter" :disabled="ro" @update:modelValue="set" />
    <select v-else-if="f.type==='select'" :value="doc[f.k] ?? ''" @change="set($event.target.value)" :disabled="ro">
      <option v-if="!f.required" value=""></option>
      <option v-for="o in opts" :value="o.v">{{ o.l }}</option>
    </select>
    <textarea v-else-if="f.type==='textarea'" :value="doc[f.k] ?? ''" @input="set($event.target.value)" :disabled="ro"></textarea>
    <span v-else-if="f.type==='check'" class="row"><input type="checkbox" :checked="!!doc[f.k]" @change="set($event.target.checked)" :disabled="ro"> <span class="small">{{ f.hint || 'Yes' }}</span></span>
    <input v-else-if="f.type==='tags'" :value="tagText" @change="set($event.target.value)" :disabled="ro" placeholder="comma separated">
    <input v-else-if="f.type==='number'" type="number" :step="f.step || 'any'" :value="doc[f.k] ?? ''" @input="set($event.target.value)" :disabled="ro">
    <input v-else-if="f.type==='date'" type="date" :value="doc[f.k] ?? ''" @input="set($event.target.value)" :disabled="ro">
    <input v-else :value="doc[f.k] ?? ''" @input="set($event.target.value)" :disabled="ro" :placeholder="f.placeholder || ''">
  </label>
  <template v-else>
    <input v-if="f.type==='ro'" :value="roText" readonly>
    <RefSelect v-else-if="f.type==='ref'" :modelValue="doc[f.k]" :refName="f.ref" :options="refOpts" :filter="refFilter" :disabled="ro" @update:modelValue="set" />
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
    csv() { downloadCSV((this.filename || 'export') + '.csv', this.cols.map(c => ({ label: c.label, raw: r => cellText(c, r) })), this.filtered); },
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
            <td v-for="c in cols" :class="{n: isNum(c)}">
              <span v-if="c.fmt==='badge'" class="b" :class="cellValue(c,r)">{{ label(cellValue(c,r)) }}</span>
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
  'layout-dashboard': '<path d="M5 4h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1"/><path d="M5 16h4a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1"/><path d="M15 12h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1"/><path d="M15 4h4a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1"/>',
  'shopping-cart': '<path d="M4 19a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M15 19a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M17 17h-11v-14h-2"/><path d="M6 5l14 1l-1 7h-13"/>',
  'building-warehouse': '<path d="M3 21v-13l9 -4l9 4v13"/><path d="M13 13h4v8h-10v-6h6"/><path d="M13 21v-9a1 1 0 0 0 -1 -1h-2a1 1 0 0 0 -1 1v3"/>',
  'report-money': '<path d="M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2"/><path d="M9 5a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z"/><path d="M14 11h-2.5a1.5 1.5 0 0 0 0 3h1a1.5 1.5 0 0 1 0 3h-2.5"/><path d="M12 17v1m0 -8v1"/>',
  'settings': '<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/>',
  'chevron-down': '<path d="M6 9l6 6l6 -6"/>',
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
