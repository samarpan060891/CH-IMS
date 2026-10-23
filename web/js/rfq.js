// Requests for quotation: one RFQ to several suppliers → their quotes entered side by side → each line awarded (lowest suggested)
// → draft POs per supplier, linked to the requisition lines; the vendor price list keeps the winning prices.
import { sb, state, must, run, rpc, hasRole, go, today, refRow, refLabel, money, qty, dt, label, num, toast } from './lib.js';
import { CURRENCIES } from './components.js';
import { makePdf, partyOf } from './pdf.js';

const isBuyer = () => hasRole('purchase');
const itemName = id => { const r = refRow('items', id); return r ? `${r.code} — ${r.name}` : ''; };
const itemUom = id => refRow('items', id)?.uoms?.code || '';

// the RFQ as sent to one supplier (or a general copy): items and quantities with blank rate / lead-time columns
function rfqPdf(c, rv) {
  const d = c.doc, v = rv ? refRow('vendors', rv.vendor_id) || {} : null;
  const meta = [['Quote by', dt(d.quote_due_date) || ''], ['Required on site / store', dt(d.required_date) || ''], ['Deliver to', refLabel('locations', d.delivery_location_id) || 'Our factory store']];
  return makePdf({ title: 'Request for Quotation', noLabel: 'RFQ No.', no: d.rfq_no, date: d.rfq_date, subject: d.title || '', meta, party: v ? partyOf(v) : null,
    columns: [{ h: 'Sr. No.', k: r => c.grids.lines.indexOf(r) + 1, w: 15 }, { h: 'Item', strong: true, k: r => itemName(r.item_id) + (r.description && r.description !== refRow('items', r.item_id)?.name ? '\n' + r.description : '') },
      { h: 'Qty', k: r => qty(r.qty), align: 'right' }, { h: 'UoM', k: r => itemUom(r.item_id) }, { h: 'Needed by', k: r => dt(r.required_date || d.required_date) },
      { h: 'Unit rate (excl. VAT)', k: () => '' }, { h: 'Lead time (days)', k: () => '' }],
    rows: c.grids.lines,
    notes: [d.terms, 'Please quote unit rates excluding VAT, your delivery lead time, payment terms and the validity of your offer. Mention our reference ' + d.rfq_no + '.'].filter(Boolean).join('\n'),
    sign: { prepared: d.created_by, labels: ['Prepared By', '', ''] }, signatures: [], filename: `${d.rfq_no.replace(/[\/\\]/g, '-')}${v ? '-' + v.name.replace(/[^\w]+/g, '-') : ''}.pdf` });
}

// quotes entry and comparison: one row per item, one column per supplier
export const RfqCompare = {
  props: { ctx: Object },
  data: () => ({ rows: [], q: {}, award: {}, busy: false, loaded: false }),
  computed: {
    d() { return this.ctx.doc; },
    lines() { return this.ctx.grids.lines.filter(l => l.id); },
    vendors() { return this.ctx.grids.vendors.filter(v => v.id); },
    canEdit() { return isBuyer() && this.d.status === 'SENT'; },
    // lowest AED rate per line among the quotes on screen
    lowest() {
      const out = {};
      this.lines.forEach(l => { let best = null; this.vendors.forEach(v => { const x = this.aed(l, v); if (x !== null && (best === null || x < best.x)) best = { x, v: v.id }; }); out[l.id] = best?.v || null; });
      return out;
    },
  },
  // reload when the RFQ is saved (its lines / suppliers are re-read)
  watch: { 'ctx.doc.id': { immediate: true, handler() { this.load(); } }, 'ctx.grids.vendors'() { this.load(); }, 'ctx.grids.lines'() { this.load(); } },
  methods: {
    money, qty, itemName, itemUom, num,
    key(l, v) { return l.id + '|' + v.id; },
    async load() {
      if (!this.d?.id) return;
      const rows = must(await sb.from('v_rfq_compare').select('*').eq('rfq_id', this.d.id));
      const q = {}, award = {};
      rows.forEach(r => { q[r.rfq_line_id + '|' + r.rfq_vendor_id] = { rate: r.rate, lead: r.lead_days, remarks: r.remarks }; if (r.is_awarded) award[r.rfq_line_id] = r.rfq_vendor_id; });
      // an entry for every item × supplier so the inputs bind to something
      this.lines.forEach(l => this.vendors.forEach(v => { q[this.key(l, v)] ||= { rate: null, lead: null }; }));
      this.lines.forEach(l => { if (!(l.id in award)) award[l.id] = null; });
      this.q = q; this.award = award; this.loaded = true;
    },
    cell(l, v) { return this.q[this.key(l, v)] || { rate: null, lead: null }; },
    aed(l, v) { const r = this.q[this.key(l, v)]?.rate; return r === null || r === undefined || r === '' ? null : num(r) * num(v.exchange_rate || 1); },
    total(v) { return this.lines.reduce((s, l) => s + (this.aed(l, v) ?? 0) * num(l.qty), 0); },
    quoted(v) { return this.lines.filter(l => this.aed(l, v) !== null).length; },
    awardedTotal() { return this.lines.reduce((s, l) => { const v = this.vendors.find(x => x.id === this.award[l.id]); return s + (v ? (this.aed(l, v) ?? 0) * num(l.qty) : 0); }, 0); },
    awardLowest() { this.lines.forEach(l => { if (this.lowest[l.id]) this.award[l.id] = this.lowest[l.id]; }); },
    pdf(v) { return run(() => rfqPdf(this.ctx, v)); },
    async save(makePos = false) {
      this.busy = true;
      const ok = await run(async () => {
        const up = [], del = [];
        this.lines.forEach(l => this.vendors.forEach(v => {
          const c = this.q[this.key(l, v)]; const has = c && c.rate !== null && c.rate !== undefined && c.rate !== '';
          if (has) up.push({ rfq_vendor_id: v.id, rfq_line_id: l.id, rate: num(c.rate), lead_days: c.lead === '' || c.lead === null || c.lead === undefined ? null : Math.round(num(c.lead)), remarks: c.remarks || null });
          else del.push([v.id, l.id]);
        }));
        if (up.length) must(await sb.from('rfq_quotes').upsert(up, { onConflict: 'rfq_vendor_id,rfq_line_id' }));
        for (const [vid, lid] of del) must(await sb.from('rfq_quotes').delete().eq('rfq_vendor_id', vid).eq('rfq_line_id', lid));
        // a supplier with any price entered has quoted
        for (const v of this.vendors) if (v.status !== 'DECLINED') {
          const st = this.quoted(v) ? 'QUOTED' : 'INVITED';
          if (st !== v.status) { must(await sb.from('rfq_vendors').update({ status: st }).eq('id', v.id)); v.status = st; }
        }
        // awards only where that supplier has a price
        const awards = this.lines.map(l => ({ line: l.id, vendor: this.award[l.id] && this.aed(l, this.vendors.find(v => v.id === this.award[l.id]) || {}) !== null ? this.award[l.id] : null }));
        await rpc('rfq_award', { p_rfq: this.d.id, p_awards: awards });
        if (makePos) {
          const n = await rpc('rfq_make_pos', { p_rfq: this.d.id });
          toast(`${n} draft PO${n === 1 ? '' : 's'} created — review and submit them for approval`, 'ok', 7000);
        }
      }, makePos ? null : 'Quotes and awards saved');
      this.busy = false;
      if (ok) { await this.ctx.load(); await this.load(); }
    },
  },
  template: `<div class="card" v-if="d.id && d.status !== 'DRAFT' && d.status !== 'CANCELLED'">
    <div class="hd"><h3>Supplier quotes & comparison</h3><span class="spacer"></span>
      <template v-if="canEdit">
        <button class="btn sm" @click="awardLowest" title="Award every line to its cheapest quote">⇩ Award lowest</button>
        <button class="btn sm primary" :disabled="busy" @click="save(false)">💾 Save quotes</button>
        <button class="btn sm ok" :disabled="busy || !Object.values(award).some(Boolean)" @click="save(true)">🧾 Create POs from awards</button>
      </template>
    </div>
    <div v-if="!vendors.length" class="small muted">Invite suppliers in the list below first.</div>
    <div v-else class="tbl-wrap"><table class="t rfqc">
      <thead>
        <tr><th>Item</th><th class="n">Qty</th>
          <th v-for="v in vendors" :key="v.id" class="rfqv">
            <div>{{ refLabel('vendors', v.vendor_id).replace(/ \\(.*\\)$/, '') }}</div>
            <div class="small muted">{{ v.currency }}{{ num(v.exchange_rate) !== 1 ? ' @ ' + v.exchange_rate : '' }} · {{ label(v.status) }}{{ v.quote_ref ? ' · ' + v.quote_ref : '' }}</div>
            <a href="javascript:void 0" class="small" @click="pdf(v)">🖨 RFQ for this supplier</a>
          </th></tr>
      </thead>
      <tbody>
        <tr v-for="l in lines" :key="l.id">
          <td>{{ itemName(l.item_id) }}<div class="small muted" v-if="l.description">{{ l.description }}</div></td>
          <td class="n">{{ qty(l.qty) }} {{ itemUom(l.item_id) }}</td>
          <td v-for="v in vendors" :key="v.id" class="rfqcell" :class="{low: lowest[l.id] === v.id, won: award[l.id] === v.id}">
            <template v-if="canEdit">
              <div class="row" style="gap:4px"><input type="number" step="any" min="0" v-model="cell(l, v).rate" placeholder="rate" class="rfqin">
                <input type="number" step="1" min="0" v-model="cell(l, v).lead" placeholder="days" class="rfqin days" title="Lead time (days)"></div>
              <label class="small row" style="gap:4px;margin-top:3px" v-if="aed(l, v) !== null"><input type="radio" :name="'aw' + l.id" :value="v.id" v-model="award[l.id]"> award</label>
            </template>
            <template v-else>
              <b v-if="aed(l, v) !== null">{{ money(cell(l, v).rate) }}</b><span v-else class="muted">—</span>
              <span class="small muted" v-if="cell(l, v).lead"> · {{ cell(l, v).lead }} d</span>
              <div class="small" v-if="award[l.id] === v.id">✔ awarded</div>
            </template>
            <div class="small muted" v-if="aed(l, v) !== null">AED {{ money(aed(l, v) * num(l.qty)) }}</div>
          </td>
        </tr>
      </tbody>
      <tfoot><tr><td colspan="2"><b>Total if all lines from this supplier</b><div class="small muted">Awarded so far: AED {{ money(awardedTotal()) }}</div></td>
        <td v-for="v in vendors" :key="v.id" class="n"><b>AED {{ money(total(v)) }}</b><div class="small muted">{{ quoted(v) }} of {{ lines.length }} quoted</div></td></tr></tfoot>
    </table></div>
    <p class="small muted" style="margin:8px 0 0">Green = lowest price for the line (in AED). Enter rates excluding VAT as quoted; pick who wins each line (a dearer but faster supplier is fine), then <b>Create POs</b> — one draft PO per supplier, linked to the requisition.</p>
  </div>`,
  setup() { return { refLabel, label }; },
};

export const rfq = {
  key: 'rfq', title: 'Requests for Quotation', single: 'RFQ', table: 'rfqs', noField: 'rfq_no', dateField: 'rfq_date',
  statuses: ['DRAFT', 'SENT', 'AWARDED', 'CLOSED', 'CANCELLED'], createRoles: ['purchase'], editStatuses: ['DRAFT', 'SENT'],
  refs: ['items', 'vendors', 'projects', 'locations', 'payment_terms'], panel: RfqCompare,
  list: { select: '*, purchase_requisitions(pr_no), rfq_vendors(count)', columns: [{ k: 'title', label: 'Title' }, { k: r => r.purchase_requisitions?.pr_no, label: 'Requisition' },
    { k: r => r.rfq_vendors?.[0]?.count || 0, label: 'Suppliers', n: true }, { k: 'quote_due_date', label: 'Quotes due', fmt: 'date' }, { k: 'required_date', label: 'Required', fmt: 'date' }] },
  defaults: () => ({ rfq_date: today(), quote_due_date: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10), status: 'DRAFT' }),
  async afterLoad(ctx) {
    if (ctx.doc.pr_id) ctx.doc._pr_no = must(await sb.from('purchase_requisitions').select('pr_no').eq('id', ctx.doc.pr_id).single()).pr_no;
    ctx.extra.pos = must(await sb.from('rfq_vendors').select('purchase_orders(id,po_no)').eq('rfq_id', ctx.doc.id).not('po_id', 'is', null)).map(r => r.purchase_orders).filter(Boolean);
  },
  header: [
    { k: 'title', label: 'Title (what is being bought)', required: true, wide: true },
    { k: '_pr_no', label: 'From requisition', type: 'ro', virtual: true, show: d => !!d.pr_id },
    { k: 'rfq_date', label: 'Date', type: 'date', required: true },
    { k: 'quote_due_date', label: 'Quotes due by', type: 'date' },
    { k: 'required_date', label: 'Material needed by', type: 'date' },
    { k: 'delivery_location_id', label: 'Deliver to', type: 'ref', ref: 'locations', filter: r => r.is_active && r.is_stock, request: false },
    { k: 'terms', label: 'Terms printed on the RFQ', type: 'textarea', full: true },
    { k: 'remarks', label: 'Internal remarks', type: 'textarea', full: true },
  ],
  headerNote: ctx => ctx.doc.status === 'DRAFT'
    ? 'Add the items and invite suppliers, then <b>Mark sent</b> and print / email the RFQ to each supplier (🖨). When the quotes come back, enter them in <b>Supplier quotes & comparison</b>.'
    : 'Enter each supplier\'s rates and lead times below, award each line, then <b>Create POs from awards</b>. Suppliers can still be added while the RFQ is open.',
  grids: [
    { key: 'lines', title: 'Items', table: 'rfq_lines', fk: 'rfq_id', order: 'line_no', saveKeys: ['pr_line_id'],
      readonly: ctx => ctx.doc.status !== 'DRAFT',
      fields: [{ k: 'item_id', label: 'Item', type: 'ref', ref: 'items', required: true, width: '250px', filter: r => r.is_active,
                 onChange: (r, v) => { const it = refRow('items', v); if (it && !r.description) r.description = it.name; } },
        { k: 'description', label: 'Description / specification', width: '220px' }, { k: '_uom', label: 'UoM', type: 'ro', virtual: true, fmt: (v, r) => itemUom(r.item_id) },
        { k: 'qty', label: 'Qty', type: 'number', required: true }, { k: 'required_date', label: 'Needed by', type: 'date' },
        { k: 'project_id', label: 'For project (blank = stock)', type: 'ref', ref: 'projects', width: '170px', request: false, filter: r => r.status === 'OPEN' },
        { k: 'remarks', label: 'Remarks', width: '140px' }] },
    { key: 'vendors', title: 'Suppliers invited', table: 'rfq_vendors', fk: 'rfq_id', lineNo: false,
      newRow: () => ({ currency: 'AED', exchange_rate: 1, status: 'INVITED' }),
      fields: [{ k: 'vendor_id', label: 'Supplier', type: 'ref', ref: 'vendors', required: true, width: '220px', filter: r => r.status === 'ACTIVE',
                 onChange: (r, v) => { const vd = refRow('vendors', v); if (vd) { r.currency = vd.currency || 'AED'; r.payment_term_id ||= vd.payment_term_id; if (r.currency === 'AED') r.exchange_rate = 1; } } },
        { k: 'status', label: 'Status', type: 'select', required: true, options: ['INVITED', 'QUOTED', 'DECLINED'] },
        { k: 'quote_ref', label: 'Their quote no.' }, { k: 'quote_date', label: 'Quote date', type: 'date' }, { k: 'valid_until', label: 'Valid until', type: 'date' },
        { k: 'currency', label: 'Currency', type: 'select', required: true, options: CURRENCIES }, { k: 'exchange_rate', label: 'Rate to AED', type: 'number', required: true },
        { k: 'payment_term_id', label: 'Payment terms', type: 'ref', ref: 'payment_terms', width: '150px' }, { k: 'delivery_days', label: 'Delivery days', type: 'number' },
        { k: 'remarks', label: 'Remarks', width: '140px' }] },
  ],
  validate(ctx) {
    const ids = ctx.grids.vendors.map(v => v.vendor_id).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw new Error('A supplier is listed twice');
  },
  async loadInfo(ctx) {
    const pos = must(await sb.from('rfq_vendors').select('po_id, vendors(name), purchase_orders(po_no,status,total_aed)').eq('rfq_id', ctx.doc.id).not('po_id', 'is', null));
    return pos.length ? [{ title: 'Purchase orders created', rows: pos, columns: [{ k: r => r.purchase_orders?.po_no, label: 'PO' }, { k: r => r.vendors?.name, label: 'Supplier' },
      { k: r => r.purchase_orders?.total_aed, label: 'Total AED', fmt: 'money', cost: true }, { k: r => r.purchase_orders?.status, label: 'Status', fmt: 'badge' }] }] : [];
  },
  actions: ctx => {
    const s = ctx.doc.status;
    return [
      { label: '📨 Mark sent to suppliers', cls: 'primary', show: s === 'DRAFT' && isBuyer(), confirm: 'Mark this RFQ as sent? Then print / email it to each supplier and enter their quotes when they reply.',
        done: 'Marked as sent', run: c => rpc('rfq_action', { p_rfq: c.doc.id, p_action: 'SEND' }) },
      { label: '🖨 RFQ PDF', reload: false, run: c => rfqPdf(c, null) },
      ...(ctx.extra.pos || []).map(p => ({ label: '➜ ' + p.po_no, reload: false, run: () => go('d/po/' + p.id) })),
      { label: 'Close', show: s === 'AWARDED' && isBuyer(), done: 'Closed', run: c => rpc('rfq_action', { p_rfq: c.doc.id, p_action: 'CLOSE' }) },
      { label: 'Cancel', show: ['DRAFT', 'SENT'].includes(s) && isBuyer(), confirm: 'Cancel this RFQ?', run: c => rpc('rfq_action', { p_rfq: c.doc.id, p_action: 'CANCEL' }) },
    ];
  },
};

export const RFQ_DOCS = { rfq };
