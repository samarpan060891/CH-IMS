// Generic document list + editor driven by per-document configuration (see documents.js)
import { sb, state, must, run, hasRole, canSeeCost, go, route, loadRefs, label, money, toast, refreshPending, refRow } from './lib.js';
import { FieldInput, DataTable, Badge, confirmBox, todayIso } from './components.js';

// header dates that record something that already happened: never in the future (same list as migration 076)
const NO_FUTURE = {
  grns: ['grn_date', 'vendor_dn_date', 'vendor_invoice_date'], material_issues: ['issue_date'], material_returns: ['return_date'],
  stock_transfers: ['trf_date'], stock_adjustments: ['adj_date'], stock_counts: ['count_date'], scrap_notes: ['scrap_date'],
  scrap_disposals: ['disposal_date'], purchase_returns: ['return_date'], stock_releases: ['release_date'],
  dispatch_notes: ['dispatch_date'], install_logs: ['log_date'], snags: ['snag_date'],
  sales_invoices: ['invoice_date', 'cert_date'], customer_receipts: ['receipt_date'], vendor_invoices: ['invoice_date'],
  vendor_debit_notes: ['dn_date'], vendor_payments: ['payment_date'], journal_entries: ['je_date'], expenses: ['exp_date'],
  employee_advances: ['adv_date'],
};
import { pdfView } from './pdf.js';

const visible = (f, doc) => !(f.cost && !canSeeCost()) && !(f.show && !f.show(doc));
// documents whose screen has a 🖨 print action can be previewed straight from the list
const printable = cfg => !!cfg.actions && cfg.actions.toString().includes('🖨');

// Load a document the way its screen does (header, lines, afterLoad) without opening it, then run its 🖨 action:
// the PDF opens in the slide-in viewer.
export async function previewDoc(cfg, id, no) {
  if (pdfView.url) URL.revokeObjectURL(pdfView.url);
  Object.assign(pdfView, { open: true, url: null, pages: 0, rendering: true, title: `${cfg.single} ${no || ''}`.trim() });
  try {
    const ctx = { cfg, id, isNew: false, doc: null, grids: {}, extra: {}, removed: {}, info: [], dirty: false, busy: false, editable: false, headerEditable: false };
    await loadRefs(cfg.refs || []);
    ctx.doc = must(await sb.from(cfg.table).select('*').eq('id', id).single());
    for (const g of cfg.grids || []) ctx.grids[g.key] = must(await sb.from(g.table).select(g.select || '*').eq(g.fk, id).order(g.order || 'id'));
    if (cfg.afterLoad) await cfg.afterLoad(ctx);
    const a = (cfg.actions(ctx) || []).find(x => x.show !== false && String(x.label).includes('🖨'));
    if (!a) throw new Error(`No printable layout for this ${cfg.single.toLowerCase()} yet`);
    await a.run(ctx);
  } catch (e) {
    pdfView.open = false; pdfView.rendering = false;
    throw e;
  }
}

// ---------------- list ----------------
export const DocList = {
  components: { DataTable, Badge },
  props: { cfg: Object },
  data: () => ({ rows: [], loading: true, tab: 'ALL', notice: null }),
  computed: {
    sf() { return this.cfg.statusField || 'status'; },
    tabs() { return ['ALL', ...(this.cfg.statuses || [])]; },
    shown() { return this.tab === 'ALL' ? this.rows : this.rows.filter(r => r[this.sf] === this.tab); },
    canCreate() { return !this.cfg.noCreate && this.cfg.createRoles && hasRole(...this.cfg.createRoles); },
    columns() {
      return [
        { k: this.cfg.noField, label: 'No.' },
        { k: this.cfg.dateField, label: 'Date', fmt: 'date' },
        ...this.cfg.list.columns,
        { k: this.sf, label: this.cfg.statusLabel || 'Status', fmt: 'badge' },
        ...(printable(this.cfg) ? [{ k: () => '', label: '', icon: '👁', title: 'Preview / download PDF', action: r => this.preview(r) }] : []),
      ];
    },
  },
  watch: { cfg() { this.load(); } },
  async mounted() { await this.load(); },
  methods: {
    label,
    async load() {
      this.loading = true;
      await loadRefs(this.cfg.refs || []);
      await run(async () => {
        let q = sb.from(this.cfg.table).select(this.cfg.list.select || '*');
        if (this.cfg.list.filter) q = this.cfg.list.filter(q);
        this.rows = must(await q.order(this.cfg.dateField, { ascending: false }).order('created_at', { ascending: false }).limit(2000));
        // optional banner above the list (e.g. orders waiting to become projects)
        if (this.cfg.list.notice) this.notice = await this.cfg.list.notice();
      });
      if (this.cfg.defaultTab && this.rows.some(r => r[this.sf] === this.cfg.defaultTab)) this.tab = this.cfg.defaultTab;
      this.loading = false;
    },
    open(r) { go(`d/${this.cfg.key}/${r.id}`); },
    preview(r) { return run(() => previewDoc(this.cfg, r.id, r[this.cfg.noField])); },
  },
  template: `<div>
    <div class="row" style="margin-bottom:12px">
      <div class="tabs" style="margin:0;border:0">
        <a v-for="t in tabs" href="javascript:void 0" :class="{on: tab===t}" @click="tab=t">{{ t==='ALL' ? 'All' : label(t) }}
          <span class="muted small" v-if="t!=='ALL'">({{ rows.filter(r=>r[sf]===t).length }})</span></a>
      </div>
      <span class="spacer"></span>
      <button class="btn primary" v-if="canCreate" @click="create">+ New {{ cfg.single }}</button>
    </div>
    <div class="card" v-if="notice?.items?.length" style="margin-bottom:12px;border-left:4px solid var(--warn, #d97706)">
      <div class="small" style="margin-bottom:6px">{{ notice.text }}</div>
      <div class="row" style="flex-wrap:wrap;gap:6px"><a v-for="n in notice.items" :key="n.to" class="btn sm" :href="'#/' + n.to">{{ n.label }}</a></div>
    </div>
    <div class="card"><DataTable :columns="columns" :rows="shown" :loading="loading" clickable @row="open" :filename="cfg.key" /></div>
  </div>`,
};
DocList.methods.create = function () { go(`d/${this.cfg.key}/new`); };

// ---------------- editor ----------------
export const DocEditor = {
  components: { FieldInput, DataTable, Badge },
  props: { cfg: Object, id: String },
  data: () => ({ doc: null, grids: {}, removed: {}, extra: {}, info: [], busy: false, dirty: false, grpOpen: {} }),
  computed: {
    isNew() { return this.id === 'new'; },
    headerEditable() { return this.editable && (!this.cfg.headerEditable || this.cfg.headerEditable(this)); },
    editable() {
      if (!this.doc) return false;
      if (this.cfg.canEdit) return this.cfg.canEdit(this);
      const okStatus = (this.cfg.editStatuses || ['DRAFT']).includes(this.doc.status || 'DRAFT');
      return okStatus && hasRole(...(this.cfg.editRoles || this.cfg.createRoles || []));
    },
    headerFields() {
      const nf = NO_FUTURE[this.cfg.table] || [];
      return this.cfg.header.filter(f => visible(f, this.doc)).map(f => nf.includes(f.k) ? { ...f, noFuture: true } : f);
    },
    actions() {
      if (!this.doc || this.isNew) return [];
      return (this.cfg.actions ? this.cfg.actions(this) : []).filter(a => a.show !== false);
    },
    totals() { return this.cfg.totals && this.doc ? this.cfg.totals(this).filter(t => !(t.cost && !canSeeCost())) : []; },
  },
  watch: { id() { this.load(); } },
  async mounted() { await this.load(); },
  methods: {
    gridFields(g) { return g.fields.filter(f => !(f.cost && !canSeeCost()) && !(f.show && !f.show(this.doc))); },
    gridEditable(g) { return this.editable && !(g.readonly && g.readonly(this)); },
    async load() {
      this.busy = true;
      this.removed = {}; this.extra = {}; this.info = [];
      await loadRefs(this.cfg.refs || []);
      await run(async () => {
        if (this.isNew) {
          this.doc = { status: 'DRAFT', ...(this.cfg.defaults ? this.cfg.defaults() : {}) };
          this.grids = Object.fromEntries((this.cfg.grids || []).map(g => [g.key, []]));
          if (this.cfg.onNew) await this.cfg.onNew(this, route.parts.slice(3));
        } else {
          // lines first: the editor renders as soon as doc is set
          const doc = must(await sb.from(this.cfg.table).select('*').eq('id', this.id).single());
          const grids = {};
          for (const g of this.cfg.grids || []) {
            grids[g.key] = must(await sb.from(g.table).select(g.select || '*').eq(g.fk, this.id).order(g.order || 'id'));
          }
          this.grids = grids;
          this.doc = doc;
          if (this.cfg.afterLoad) await this.cfg.afterLoad(this);
          if (this.cfg.loadInfo) this.info = await this.cfg.loadInfo(this);
        }
      });
      this.dirty = false;
      this.busy = false;
    },
    async changed(f) {
      this.dirty = true;
      if (f.onChange) await run(() => f.onChange(this.doc, this.doc[f.k], this));
    },
    async lineChanged(g, f, row) {
      this.dirty = true;
      if (f.onChange) await run(() => f.onChange(row, row[f.k], this));
    },
    impShow(imp) { return !imp.show || imp.show(this); },
    runImp(imp) { return this.act({ ...imp, saveFirst: false, reload: false }); },
    headerNote() { return this.cfg.headerNote(this); },
    addRow(g) {
      const row = { ...(g.newRow ? g.newRow(this) : {}) };
      this.grids[g.key].push(row); this.dirty = true;
      if (g.groupBy) this.grpOpen[g.key + ':' + this.grpName(g, row)] = true;   // keep the new line visible
    },
    // grouped grids (groupBy): collapsible group rows, each opened / closed on its own or all at once
    grpName(g, r) { return String(g.groupBy(r) ?? '').trim() || '(none)'; },
    gridView(g) {
      const rows = this.grids[g.key] || [];
      if (!g.groupBy) return rows.map((r, i) => ({ r, i }));
      const groups = new Map();
      rows.forEach((r, i) => { const n = this.grpName(g, r); if (!groups.has(n)) groups.set(n, []); groups.get(n).push({ r, i }); });
      const names = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return names.flatMap(n => {
        const items = groups.get(n), open = !!this.grpOpen[g.key + ':' + n];
        return [{ grp: n, n: items.length, open, sum: g.groupSummary ? g.groupSummary(items.map(x => x.r)) : '' }, ...(open ? items : [])];
      });
    },
    toggleGrp(g, n) { const k = g.key + ':' + n; this.grpOpen[k] = !this.grpOpen[k]; },
    setAllGrps(g, open) { for (const r of this.grids[g.key] || []) this.grpOpen[g.key + ':' + this.grpName(g, r)] = open; },
    removeRow(g, i) {
      const r = this.grids[g.key][i];
      if (r.id) (this.removed[g.key] ||= []).push(r.id);
      this.grids[g.key].splice(i, 1);
      this.dirty = true;
    },
    validate() {
      // dates of things that already happened (the server enforces the same list)
      for (const k of NO_FUTURE[this.cfg.table] || []) {
        const v = this.doc[k];
        if (v && String(v).slice(0, 10) > todayIso()) {
          const f = this.cfg.header.find(x => x.k === k);
          throw new Error(`${f?.label || label(k)} cannot be in the future (${String(v).slice(0, 10)}) — today is ${todayIso()}`);
        }
      }
      for (const f of this.cfg.header) {
        if (f.required && visible(f, this.doc) && (this.doc[f.k] === null || this.doc[f.k] === undefined || this.doc[f.k] === '')) {
          throw new Error(`${f.label} is required`);
        }
      }
      for (const g of this.cfg.grids || []) {
        for (const [i, r] of this.grids[g.key].entries()) {
          for (const f of g.fields) {
            if (f.required && (r[f.k] === null || r[f.k] === undefined || r[f.k] === '')) {
              throw new Error(`${g.title} line ${i + 1}: ${f.label} is required`);
            }
            // quantity fields marked whole: no fractions for items counted in whole units (unit with 0 decimals), e.g. PCS, SHT, BDL
            if (f.whole && r.item_id && r[f.k] !== null && r[f.k] !== undefined && r[f.k] !== '' && !Number.isInteger(Number(r[f.k])) && !(g.wholeSkip && g.wholeSkip(r))) {
              const it = refRow('items', r.item_id), u = it && refRow('uoms', it.uom_id);
              if (u && Number(u.decimals) === 0 && !it.dim_tracking) throw new Error(`${g.title} line ${i + 1}: ${it.code} is counted in whole ${u.code} — ${f.label} cannot be ${r[f.k]}`);
            }
          }
        }
      }
      if (this.cfg.validate) this.cfg.validate(this);
    },
    pick(obj, keys) { const o = {}; keys.forEach(k => { if (obj[k] !== undefined) o[k] = obj[k]; }); return o; },
    headerKeys() {
      return [...new Set([...this.cfg.header.filter(f => f.type !== 'ro' && !f.virtual).map(f => f.k), ...(this.cfg.saveKeys || [])])];
    },
    async save(silent = false) {
      if (!this.editable) return true;
      const ok = await run(async () => {
        this.validate();
        const hdr = this.pick(this.doc, this.headerKeys());
        let id = this.doc.id;
        if (!id) {
          const ins = must(await sb.from(this.cfg.table).insert(hdr).select().single());
          id = ins.id; this.doc.id = id;
        } else if (this.headerEditable) {
          must(await sb.from(this.cfg.table).update(hdr).eq('id', id));
        }
        for (const g of this.cfg.grids || []) {
          const del = this.removed[g.key] || [];
          if (del.length) must(await sb.from(g.table).delete().in('id', del));
          const keys = [...new Set([...g.fields.filter(f => f.type !== 'ro' && !f.virtual).map(f => f.k), ...(g.saveKeys || [])])];
          for (const [i, r] of this.grids[g.key].entries()) {
            if (g.prepare) g.prepare(r, this);   // e.g. link to a row of a grid saved before this one
            const row = this.pick(r, keys);
            if (g.lineNo !== false) row.line_no = i + 1;
            if (r.id) must(await sb.from(g.table).update(row).eq('id', r.id));
            else { row[g.fk] = id; const ins = must(await sb.from(g.table).insert(row).select('id').single()); r.id = ins.id; }
          }
        }
        this.removed = {};
        if (this.cfg.afterSave) await this.cfg.afterSave(this);
      }, silent ? null : 'Saved');
      if (ok && this.isNew) { go(`d/${this.cfg.key}/${this.doc.id}`); return true; }
      if (ok) { this.dirty = false; await this.load(); }
      return !!ok;
    },
    async act(a) {
      if (a.confirm && !(await confirmBox(a.label, a.confirm, a.danger))) return;
      if (this.editable && this.dirty && a.saveFirst !== false) { if (!(await this.save(true))) return; }
      this.busy = true;
      const ok = await run(() => a.run(this), a.done || null);
      this.busy = false;
      if (ok && a.reload !== false) { await this.load(); refreshPending(); }
    },
    async remove() {
      if (!(await confirmBox('Delete draft', 'Delete this draft document permanently?', true))) return;
      const ok = await run(async () => must(await sb.from(this.cfg.table).delete().eq('id', this.doc.id)), 'Draft deleted');
      if (ok) go(`d/${this.cfg.key}`);
    },
    back() { go(`d/${this.cfg.key}`); },
    fmtTotal(t) { return t.fmt === 'qty' ? t.v : money(t.v); },
  },
  template: `<div v-if="doc">
    <div class="row" style="margin-bottom:12px">
      <button class="btn" @click="back">← {{ cfg.title }}</button>
      <h2 style="margin:0 8px;font-size:18px">{{ isNew ? 'New ' + cfg.single : doc[cfg.noField] }}</h2>
      <Badge :v="doc.status" />
      <span class="spacer"></span>
      <button v-if="editable" class="btn primary" :disabled="busy" @click="save()">💾 Save</button>
      <button v-for="a in actions" class="btn" :class="a.cls" :disabled="busy || a.disabled" @click="act(a)">{{ a.label }}</button>
      <button v-if="headerEditable && !isNew && doc.status === 'DRAFT'" class="btn bad" :disabled="busy" @click="remove">Delete</button>
    </div>

    <div class="card">
      <div class="grid">
        <FieldInput v-for="f in headerFields" :key="f.k" :f="f" :doc="doc" :disabled="!headerEditable" @changed="changed(f)" />
      </div>
      <div v-if="cfg.headerNote" class="small muted" style="margin-top:10px" v-html="headerNote()"></div>
    </div>

    <component v-if="cfg.panel && !isNew" :is="cfg.panel" :ctx="this" :key="'panel-' + doc.id" />

    <div class="card" v-for="g in (cfg.grids || [])" :key="g.key" v-show="!g.show || g.show(doc)">
      <div class="hd">
        <h3>{{ g.title }}</h3>
        <span class="spacer"></span>
        <template v-if="g.groupBy && (grids[g.key] || []).length">
          <button class="btn sm" @click="setAllGrps(g, true)">⊞ Expand all</button>
          <button class="btn sm" @click="setAllGrps(g, false)">⊟ Collapse all</button>
        </template>
        <template v-if="gridEditable(g)">
          <button v-for="imp in (g.importers || [])" class="btn sm" @click="runImp(imp)" v-show="impShow(imp)">{{ imp.label }}</button>
          <button v-if="g.addable !== false" class="btn sm" @click="addRow(g)">+ Add line</button>
        </template>
      </div>
      <div class="tbl-wrap">
        <table class="t lines">
          <thead><tr><th style="width:64px">Sr. No.</th><th v-for="f in gridFields(g)" :style="f.width ? 'min-width:'+f.width : ''">{{ f.label }}</th><th v-if="gridEditable(g)"></th></tr></thead>
          <tbody>
            <tr v-if="!(grids[g.key] || []).length"><td :colspan="gridFields(g).length + 2" class="empty">No lines</td></tr>
            <template v-for="v in gridView(g)" :key="v.grp !== undefined ? 'g:' + v.grp : (v.r.id || 'n' + v.i)">
              <tr v-if="v.grp !== undefined" class="grp-row" @click="toggleGrp(g, v.grp)" :aria-expanded="v.open">
                <td :colspan="gridFields(g).length + (gridEditable(g) ? 2 : 1)">
                  <span class="grp-chev">{{ v.open ? '▾' : '▸' }}</span> <b>{{ v.grp }}</b>
                  <span class="muted small"> · {{ v.n }} {{ g.groupNoun || 'lines' }}<template v-if="v.sum"> · {{ v.sum }}</template></span>
                </td>
              </tr>
              <tr v-else>
                <td class="muted">{{ v.i + 1 }}</td>
                <td v-for="f in gridFields(g)"><FieldInput bare :f="f" :doc="v.r" :disabled="!gridEditable(g) || (f.lockSaved && !!v.r.id)" @changed="lineChanged(g, f, v.r)" /></td>
                <td v-if="gridEditable(g)"><button class="btn sm bad" @click="removeRow(g, v.i)">✕</button></td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" v-if="totals.length">
      <div class="row" style="justify-content:flex-end;gap:28px">
        <div v-for="t in totals" style="text-align:right"><div class="muted small">{{ t.l }}</div><div style="font-size:18px;font-weight:700">{{ fmtTotal(t) }}</div></div>
      </div>
    </div>

    <div class="card" v-for="blk in info" :key="blk.title">
      <h3>{{ blk.title }}</h3>
      <DataTable :columns="blk.columns" :rows="blk.rows" :searchable="false" />
    </div>
  </div>
  <div v-else class="muted">Loading…</div>`,
};
