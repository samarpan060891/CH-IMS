// QR labels on A4 sticker sheets (3 x 8 = 24 labels of 70 x 37 mm) for lots, items (bins) and tools / assets
import { sb, state, must, run, toast, qty, dt, loadRefs } from './lib.js';
import { RefSelect } from './components.js';
import { qrText, qrMatrix } from './scan.js';

const COLS = 3, ROWS = 8, W = 70, H = 297 / 8;

async function drawQr(doc, text, x, y, size) {
  const m = await qrMatrix(text);
  const s = size / m.n;
  doc.setFillColor(0, 0, 0);
  for (let r = 0; r < m.n; r++) for (let c = 0; c < m.n; c++) if (m.dark(r, c)) doc.rect(x + c * s, y + r * s, s + 0.02, s + 0.02, 'F');
}

// labels: [{ qr, title, name, line1, line2 }]
export async function printLabels(labels, skip = 0, filename = 'labels.pdf', preview = false) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  let pos = skip;
  for (const l of labels) {
    if (pos > 0 && pos % (COLS * ROWS) === 0) doc.addPage();
    const i = pos % (COLS * ROWS);
    const x = (i % COLS) * W, y = Math.floor(i / COLS) * H;
    await drawQr(doc, l.qr, x + 3, y + 4, 29);
    const tx = x + 34.5, tw = W - 37;
    doc.setTextColor(20); doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
    doc.text(doc.splitTextToSize(l.title, tw)[0], tx, y + 8);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
    doc.text(doc.splitTextToSize(l.name || '', tw).slice(0, 3), tx, y + 12.5);
    doc.setFontSize(7.5); doc.setTextColor(60);
    if (l.line1) doc.text(doc.splitTextToSize(l.line1, tw)[0], tx, y + 25);
    if (l.line2) doc.text(doc.splitTextToSize(l.line2, tw)[0], tx, y + 29);
    doc.setFontSize(6); doc.setTextColor(120);
    doc.text('Citi Homes IMS', tx, y + 33.5);
    pos++;
  }
  if (preview) return doc.output('bloburl');
  doc.save(filename);
}

export const Labels = {
  components: { RefSelect },
  props: { mode: { type: String, default: 'lots' }, ref_id: String },
  data: () => ({ rows: [], loading: false, grn: null, loc: null, q: '', skip: 0, grns: [], busy: false }),
  computed: {
    tabs() { return [{ k: 'lots', t: 'Stock lots' }, { k: 'items', t: 'Items / bin labels' }, { k: 'assets', t: 'Tools & assets' }]; },
    shown() {
      const q = this.q.toLowerCase().trim();
      return this.rows.filter(r => !q || JSON.stringify([r.title, r.name, r.line1]).toLowerCase().includes(q));
    },
    selected() { return this.rows.filter(r => r._sel && r._copies > 0); },
    count() { return this.selected.reduce((s, r) => s + Number(r._copies || 0), 0); },
  },
  watch: { mode() { this.init(); } },
  async mounted() { await loadRefs(['locations', 'items']); await this.init(); },
  methods: {
    async init() {
      this.rows = []; this.q = '';
      if (this.mode === 'lots') {
        this.grns = must(await sb.from('grns').select('id,grn_no,grn_date,vendors(name)').eq('status', 'POSTED').order('grn_date', { ascending: false }).limit(300))
          .map(g => ({ id: g.id, label: `${g.grn_no} — ${g.vendors?.name || ''} (${dt(g.grn_date)})` }));
        if (this.ref_id) this.grn = this.ref_id;
      }
      await this.load();
    },
    async load() {
      this.loading = true;
      await run(async () => {
        if (this.mode === 'lots') {
          if (!this.grn && !this.loc) { this.rows = []; return; }
          let lots;
          if (this.grn) {
            const lines = must(await sb.from('grn_lines').select('id').eq('grn_id', this.grn)).map(l => l.id);
            lots = lines.length ? must(await sb.from('stock_lots').select('id,lot_no,batch_no,qty_in,qty_on_hand,received_date,expiry_date,items(code,name,uoms(code)),locations(code)').eq('source_type', 'GRN').in('source_id', lines)) : [];
          } else {
            lots = must(await sb.from('stock_lots').select('id,lot_no,batch_no,qty_in,qty_on_hand,received_date,expiry_date,items(code,name,uoms(code)),locations(code)').eq('location_id', this.loc).gt('qty_on_hand', 0).order('received_date'));
          }
          this.rows = lots.map(l => ({ key: l.id, qr: qrText.lot(l.id), title: l.items.code, name: l.items.name,
            line1: `Lot ${l.lot_no}${l.batch_no ? ' · B ' + l.batch_no : ''}`, line2: `Rcvd ${dt(l.received_date)} · ${qty(l.qty_in)} ${l.items.uoms?.code || ''}${l.expiry_date ? ' · Exp ' + dt(l.expiry_date) : ''}`,
            _sel: true, _copies: 1, loc: l.locations?.code }));
        } else if (this.mode === 'items') {
          this.rows = (state.refs.items || []).filter(i => i.is_active && i.item_classes?.tracking === 'LOT').map(i => ({ key: i.id, qr: qrText.item(i.code), title: i.code, name: i.name,
            line1: i.item_classes?.name || '', line2: `UoM ${i.uoms?.code || ''}`, _sel: false, _copies: 1 }));
        } else {
          const a = must(await sb.from('v_asset_register').select('asset_tag,item_name,serial_no,class_name,purchase_date,status').not('status', 'in', '(SCRAPPED,DISPOSED,LOST)').order('asset_tag'));
          this.rows = a.map(x => ({ key: x.asset_tag, qr: qrText.asset(x.asset_tag), title: x.asset_tag, name: x.item_name,
            line1: x.serial_no ? 'S/N ' + x.serial_no : x.class_name, line2: x.purchase_date ? 'Since ' + dt(x.purchase_date) : '', _sel: false, _copies: 1 }));
        }
      });
      this.loading = false;
    },
    toggleAll(v) { this.shown.forEach(r => { r._sel = v; }); },
    async print(preview = false) {
      if (!this.count) return toast('Tick at least one label', 'error');
      const out = [];
      this.selected.forEach(r => { for (let i = 0; i < Number(r._copies); i++) out.push(r); });
      this.busy = true;
      const url = await run(() => printLabels(out, Math.max(0, Math.min(23, Number(this.skip) || 0)), `labels-${this.mode}.pdf`, preview));
      this.busy = false;
      if (preview && typeof url === 'string') window.open(url, '_blank');
    },
  },
  template: `<div>
    <div class="tabs"><a v-for="t in tabs" :href="'#/labels/' + t.k" :class="{on: mode === t.k}">{{ t.t }}</a></div>
    <div class="card">
      <div class="row" style="margin-bottom:10px">
        <template v-if="mode === 'lots'">
          <div style="width:320px"><RefSelect v-model="grn" :options="grns" placeholder="Labels for a GRN…" @pick="loc = null; load()" /></div>
          <span class="muted small">or all stock at</span>
          <div style="width:220px"><RefSelect v-model="loc" refName="locations" :filter="r => r.is_stock" placeholder="Location…" @pick="grn = null; load()" /></div>
        </template>
        <input v-model="q" placeholder="Search" style="max-width:220px">
        <span class="spacer"></span>
        <label class="small row">Skip first <input type="number" v-model.number="skip" min="0" max="23" style="width:64px"> labels (used sheet)</label>
        <button class="btn" :disabled="busy" @click="print(true)">Preview</button>
        <button class="btn primary" :disabled="busy" @click="print(false)">🏷 Download {{ count }} label{{ count === 1 ? '' : 's' }} (A4, 3×8)</button>
      </div>
      <p class="small muted" style="margin-top:0">Prints on standard A4 sticker sheets with 24 labels (70 × 37 mm). Scan the QR with the 📷 button in the app (phone camera) or a USB scanner.</p>
      <div class="tbl-wrap"><table class="t lines">
        <thead><tr><th><input type="checkbox" @change="toggleAll($event.target.checked)"></th><th>Code</th><th>Description</th><th>Details</th><th v-if="mode === 'lots'">Location</th><th style="width:90px">Copies</th></tr></thead>
        <tbody>
          <tr v-if="loading"><td colspan="6" class="empty">Loading…</td></tr>
          <tr v-else-if="!shown.length"><td colspan="6" class="empty">{{ mode === 'lots' ? 'Choose a GRN or a location' : 'Nothing to show' }}</td></tr>
          <tr v-for="r in shown" :key="r.key">
            <td><input type="checkbox" v-model="r._sel"></td><td><b>{{ r.title }}</b></td><td>{{ r.name }}</td>
            <td class="small">{{ r.line1 }}<div class="muted">{{ r.line2 }}</div></td><td v-if="mode === 'lots'" class="small">{{ r.loc }}</td>
            <td><input type="number" min="0" v-model.number="r._copies"></td>
          </tr>
        </tbody>
      </table></div>
    </div>
  </div>`,
};
