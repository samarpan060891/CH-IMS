// Mobile counting screen for a physical stock count (blind by default)
import { sb, state, must, run, rpc, hasRole, go, toast, qty, refRow, loadRefs } from './lib.js';
import { RefSelect, Badge, confirmBox } from './components.js';
import { Scanner, parseCode } from './scan.js';

export const CountSheet = {
  components: { RefSelect, Badge, Scanner },
  props: { id: String },
  data: () => ({ h: null, lines: [], q: '', scanning: false, found: { item: null, qty: null, note: '' }, hi: null, busy: false }),
  computed: {
    blind() { return this.h?.blind && this.h?.status === 'COUNTING'; },
    counted() { return this.lines.filter(l => l.counted_qty !== null && l.counted_qty !== '').length; },
    shown() {
      const q = this.q.toLowerCase().trim();
      return this.lines.filter(l => !q || `${l.items.code} ${l.items.name} ${l.lot_no || ''}`.toLowerCase().includes(q));
    },
    canCount() { return this.h?.status === 'COUNTING' && hasRole('stores'); },
  },
  async mounted() { await loadRefs(['items', 'locations']); await this.load(); },
  methods: {
    qty,
    async load() {
      await run(async () => {
        this.h = must(await sb.from('stock_counts').select('*, locations(code,name), item_classes(code)').eq('id', this.id).single());
        this.lines = must(await sb.from('stock_count_lines').select('id,item_id,lot_id,lot_no,system_qty,counted_qty,note,found,items(code,name,uoms(code))')
          .eq('count_id', this.id).order('found').order('lot_no'));
      });
    },
    async save(l) {
      const v = l.counted_qty === '' || l.counted_qty === null ? null : Number(l.counted_qty);
      if (v !== null && (isNaN(v) || v < 0)) return toast('Enter a valid quantity', 'error');
      await run(() => rpc('count_record', { p_line: l.id, p_qty: v, p_note: l.note || null }));
      l._saved = true; setTimeout(() => { l._saved = false; }, 1200);
    },
    async onScan(code) {
      this.scanning = false;
      const c = parseCode(code);
      let hit = null;
      if (c.kind === 'lot') hit = this.lines.find(l => l.lot_id === c.value);
      else hit = this.lines.find(l => l.items.code.toLowerCase() === c.value.toLowerCase());
      if (hit) {
        this.q = ''; this.hi = hit.id;
        this.$nextTick(() => { const el = document.getElementById('cnt-' + hit.id); el?.scrollIntoView({ block: 'center' }); el?.focus(); el?.select?.(); });
        return;
      }
      const item = c.kind === 'lot'
        ? must(await sb.from('stock_lots').select('item_id').eq('id', c.value).maybeSingle())?.item_id
        : (state.refs.items || []).find(i => i.code.toLowerCase() === c.value.toLowerCase())?.id;
      if (!item) return toast('Label not recognised', 'error');
      this.found.item = item;
      toast('Not expected at this location — enter the quantity found below', 'info', 6000);
    },
    async addFound() {
      if (!this.found.item || !(Number(this.found.qty) > 0)) return toast('Choose the item and enter the quantity found', 'error');
      this.busy = true;
      const ok = await run(() => rpc('count_add_found', { p_count: this.id, p_item: this.found.item, p_qty: Number(this.found.qty), p_note: this.found.note || null }), 'Found item added');
      this.busy = false;
      if (ok) { this.found = { item: null, qty: null, note: '' }; await this.load(); }
    },
    async submit() {
      const left = this.lines.length - this.counted;
      if (left && !(await confirmBox('Submit count', `${left} line(s) are not counted. They will be left unchanged. Submit anyway?`))) return;
      this.busy = true;
      const r = await run(() => rpc('count_submit', { p_count: this.id }));
      this.busy = false;
      if (r) { toast(`Submitted: ${r.counted} of ${r.lines} lines counted`, 'ok'); go('d/cnt/' + this.id); }
    },
  },
  template: `<div v-if="h" style="max-width:760px">
    <div class="card" style="position:sticky;top:56px;z-index:4">
      <div class="row">
        <div><b>{{ h.count_no }}</b> · {{ h.locations?.code }} — {{ h.locations?.name }}<span v-if="h.item_classes"> · {{ h.item_classes.code }}</span></div>
        <Badge :v="h.status" /><span class="spacer"></span>
        <span class="small muted">{{ counted }} / {{ lines.length }} counted</span>
      </div>
      <div style="height:6px;background:#e5e7eb;border-radius:3px;margin:8px 0"><div :style="{height:'6px',borderRadius:'3px',background:'var(--brand)',width:(lines.length ? 100*counted/lines.length : 0)+'%'}"></div></div>
      <div class="row">
        <input v-model="q" placeholder="Search item / lot" style="flex:1;min-width:160px">
        <button class="btn primary" v-if="canCount" @click="scanning = true">📷 Scan</button>
        <button class="btn" @click="go('d/cnt/' + id)">Count details</button>
      </div>
    </div>
    <div class="card" v-if="h.status !== 'COUNTING'"><span class="muted">This count is {{ h.status.toLowerCase() }}.</span></div>
    <div v-for="l in shown" :key="l.id" class="card" :style="{padding:'12px', borderColor: hi===l.id ? 'var(--brand)' : '', borderWidth: hi===l.id ? '2px' : ''}">
      <div class="row" style="align-items:flex-start">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600">{{ l.items.code }} <span v-if="l.found" class="b WARNING">found</span></div>
          <div class="small">{{ l.items.name }}</div>
          <div class="small muted">Lot {{ l.lot_no || '—' }}<span v-if="!blind"> · system {{ qty(l.system_qty) }} {{ l.items.uoms?.code }}</span></div>
        </div>
        <div style="width:130px">
          <input :id="'cnt-' + l.id" type="number" inputmode="decimal" v-model="l.counted_qty" :disabled="!canCount" @change="save(l)"
                 :placeholder="l.items.uoms?.code" style="font-size:18px;text-align:right;padding:10px">
          <div class="small" style="text-align:right;color:var(--ok)" v-if="l._saved">saved ✓</div>
        </div>
      </div>
      <input v-if="canCount" v-model="l.note" placeholder="Note (optional)" @change="save(l)" style="margin-top:6px;font-size:13px">
    </div>
    <div class="card" v-if="canCount">
      <h3>Found something not on the list?</h3>
      <div class="grid">
        <label class="f wide">Item<RefSelect v-model="found.item" refName="items" :filter="r => r.is_active && r.item_classes?.tracking === 'LOT'" /></label>
        <label class="f">Qty found<input type="number" v-model="found.qty"></label>
        <label class="f wide">Note<input v-model="found.note" placeholder="e.g. behind rack A-03"></label>
      </div>
      <div class="row" style="margin-top:10px"><button class="btn" :disabled="busy" @click="addFound">+ Add found item</button></div>
    </div>
    <div class="row" v-if="canCount" style="margin-bottom:24px"><span class="spacer"></span><button class="btn ok" :disabled="busy" @click="submit">✔ Submit count</button></div>
    <Scanner v-if="scanning" title="Scan lot or item label" @code="onScan" @close="scanning = false" />
  </div>
  <div v-else class="muted">Loading…</div>`,
  setup() { return { go }; },
};

// ======================================================================
// Count app: phone-first — pick a count in progress, then count line by line (scan jumps to the line,
// − / + steppers, next-uncounted, offcut pieces as here / missing), add found items, submit.
// Saves each line as it is entered with the same server functions as the count sheet.
// ======================================================================
const ocSize = l => l.stock_lots?.is_offcut ? `✂ ${qty(l.stock_lots.length_mm)}${l.stock_lots.width_mm ? ' × ' + qty(l.stock_lots.width_mm) : ''} mm` : '';
const isCounted = l => l.counted_qty !== null && l.counted_qty !== '' && l.counted_qty !== undefined;

export const CountApp = {
  components: { RefSelect, Badge, Scanner },
  props: { id: String },
  data: () => ({ counts: [], h: null, lines: [], q: '', view: 'todo', scanning: false, hi: null, busy: false, found: null, loading: false }),
  computed: {
    canCount() { return this.h?.status === 'COUNTING' && hasRole('stores'); },
    blind() { return this.h?.blind && this.h?.status === 'COUNTING'; },
    counted() { return this.lines.filter(isCounted).length; },
    shown() {
      const q = this.q.toLowerCase().trim();
      return this.lines.filter(l => (this.view === 'all' || (this.view === 'todo') === !isCounted(l))
        && (!q || `${l.items.code} ${l.items.name} ${l.lot_no || ''}`.toLowerCase().includes(q)));
    },
  },
  watch: { id() { this.open(); } },
  async mounted() { await loadRefs(['items']); await this.open(); },
  methods: {
    qty, ocSize, isCounted,
    async open() {
      this.loading = true; this.h = null; this.lines = []; this.q = ''; this.hi = null; this.found = null;
      await run(async () => {
        if (!this.id) {
          // counts in progress, with how far each has got
          this.counts = must(await sb.from('stock_counts').select('id,count_no,count_date,blind,status,locations(code,name),item_classes(code),stock_count_lines(counted_qty)')
            .eq('status', 'COUNTING').order('count_date'));
          return;
        }
        this.h = must(await sb.from('stock_counts').select('*, locations(code,name), item_classes(code)').eq('id', this.id).single());
        this.lines = must(await sb.from('stock_count_lines').select('id,item_id,lot_id,lot_no,system_qty,counted_qty,note,found,items(code,name,uoms(code)),stock_lots(is_offcut,length_mm,width_mm)')
          .eq('count_id', this.id).order('found').order('lot_no'));
        this.view = this.counted < this.lines.length ? 'todo' : 'all';
      });
      this.loading = false;
    },
    progress(c) { const l = c.stock_count_lines || [], n = l.length; return n ? Math.round(100 * l.filter(isCounted).length / n) : 0; },
    async save(l, v) {
      if (v !== undefined) l.counted_qty = v;
      const val = isCounted(l) ? Number(l.counted_qty) : null;
      if (val !== null && (isNaN(val) || val < 0)) return toast('Enter a valid quantity', 'error');
      if (await run(() => rpc('count_record', { p_line: l.id, p_qty: val, p_note: l.note || null }))) { l._saved = true; setTimeout(() => { l._saved = false; }, 1200); }
    },
    step(l, d) { this.save(l, Math.max(0, Math.round((Number(l.counted_qty) || 0) * 1000 + d * 1000) / 1000)); },
    // an offcut is one piece: it is either here (its own quantity) or missing
    piece(l, here) { this.save(l, here ? Number(l.system_qty) : 0); },
    focus(l) {
      this.hi = l.id;
      this.$nextTick(() => { const el = document.getElementById('cq-' + l.id); el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); if (!l.stock_lots?.is_offcut) { el?.focus(); el?.select?.(); } });
    },
    nextTodo() {
      const i = this.lines.findIndex(l => l.id === this.hi);
      const n = [...this.lines.slice(i + 1), ...this.lines.slice(0, i + 1)].find(l => !isCounted(l));
      if (!n) return toast('Every line is counted 🎉', 'ok');
      this.view = 'todo'; this.q = ''; this.focus(n);
    },
    async onScan(code) {
      this.scanning = false;
      const c = parseCode(code);
      const hit = c.kind === 'lot' ? this.lines.find(l => l.lot_id === c.value) : this.lines.find(l => l.items.code.toLowerCase() === c.value.toLowerCase());
      if (hit) { this.view = 'all'; this.q = ''; this.focus(hit); return; }
      const item = c.kind === 'lot'
        ? must(await sb.from('stock_lots').select('item_id').eq('id', c.value).maybeSingle())?.item_id
        : (state.refs.items || []).find(i => i.code.toLowerCase() === c.value.toLowerCase())?.id;
      if (!item) return toast('Label not recognised', 'error');
      this.found = { item, qty: null, note: '' };
      toast('Not expected here — enter the quantity found', 'info', 6000);
    },
    async addFound() {
      const f = this.found;
      if (!f.item || !(Number(f.qty) > 0)) return toast('Choose the item and enter the quantity found', 'error');
      this.busy = true;
      const ok = await run(() => rpc('count_add_found', { p_count: this.id, p_item: f.item, p_qty: Number(f.qty), p_note: f.note || null }), 'Found item added');
      this.busy = false;
      if (ok) { this.found = null; await this.open(); }
    },
    async submit() {
      const left = this.lines.length - this.counted;
      if (left && !(await confirmBox('Submit count', `${left} line(s) are not counted. They will be left unchanged. Submit anyway?`))) return;
      this.busy = true;
      const r = await run(() => rpc('count_submit', { p_count: this.id }));
      this.busy = false;
      if (r) { toast(`Submitted: ${r.counted} of ${r.lines} lines counted — the Factory Manager reviews the differences`, 'ok', 7000); go('countapp'); }
    },
  },
  template: `<div class="site cnt">
    <!-- ===== counts in progress ===== -->
    <template v-if="!id">
      <div class="row" style="margin-bottom:8px"><b style="font-size:17px">📋 Stock counts</b><span class="spacer"></span><button class="btn sm" @click="open" :disabled="loading">↻</button></div>
      <div v-if="!loading && !counts.length" class="card empty">No count in progress. Start one on the desktop: Inventory → Stock counts → New, then Start counting.</div>
      <div v-for="c in counts" :key="c.id" class="site-card" @click="go('countapp/' + c.id)">
        <div class="row"><b>{{ c.count_no }}</b>&nbsp;<span class="muted small">{{ c.locations?.code }} — {{ c.locations?.name }}{{ c.item_classes ? ' · ' + c.item_classes.code : '' }}</span>
          <span class="spacer"></span><span v-if="c.blind" class="chip" style="padding:2px 8px">blind</span></div>
        <div class="site-bar"><div :style="{width: progress(c) + '%'}"></div></div>
        <div class="small muted">{{ c.stock_count_lines.filter(isCounted).length }} of {{ c.stock_count_lines.length }} lines counted · {{ progress(c) }}%</div>
      </div>
    </template>

    <!-- ===== counting ===== -->
    <template v-else-if="h">
      <div class="cnt-top">
        <div class="row"><button class="btn sm" @click="go('countapp')">←</button>
          <b style="margin-left:6px">{{ h.count_no }}</b>&nbsp;<span class="muted small">{{ h.locations?.code }}</span><span class="spacer"></span>
          <b>{{ counted }}</b><span class="muted small">&nbsp;/ {{ lines.length }}</span></div>
        <div class="site-bar"><div :style="{width: (lines.length ? 100 * counted / lines.length : 0) + '%'}"></div></div>
        <div class="row" style="gap:6px">
          <input v-model="q" placeholder="Search item / lot…" style="flex:1;min-width:0;padding:9px">
          <button class="btn primary" v-if="canCount" @click="scanning = true" title="Scan a lot, offcut or item label">📷</button>
          <button class="btn" v-if="canCount" @click="nextTodo" title="Next line not counted">⏭</button>
        </div>
        <div class="row" style="gap:6px;margin-top:6px">
          <a class="chip" :class="{on: view==='todo'}" @click="view='todo'">To count {{ lines.length - counted }}</a>
          <a class="chip" :class="{on: view==='done'}" @click="view='done'">Counted {{ counted }}</a>
          <a class="chip" :class="{on: view==='all'}" @click="view='all'">All {{ lines.length }}</a>
        </div>
      </div>
      <div v-if="h.status !== 'COUNTING'" class="card empty">This count is {{ h.status.toLowerCase() }}.</div>
      <div v-if="!shown.length && h.status === 'COUNTING'" class="card empty">{{ view === 'todo' ? 'Everything is counted — submit below 🎉' : 'Nothing here' }}</div>
      <div v-for="l in shown" :key="l.id" class="site-card cnt-line" :class="{hi: hi === l.id, done: isCounted(l)}">
        <div class="row" style="align-items:flex-start">
          <div style="flex:1;min-width:0">
            <b>{{ l.items.code }}</b> <span v-if="l.found" class="b WARNING">found</span>
            <div class="small">{{ l.items.name }}</div>
            <div class="small" :style="ocSize(l) ? 'color:#1e40af' : 'color:var(--muted)'">{{ ocSize(l) || ('Lot ' + (l.lot_no || '—')) }}{{ ocSize(l) ? ' · ' + l.lot_no : '' }}
              <span v-if="!blind" class="muted"> · system {{ qty(l.system_qty) }} {{ l.items.uoms?.code }}</span></div>
          </div>
          <span v-if="l._saved" class="small" style="color:var(--ok)">saved ✓</span>
        </div>
        <!-- offcut piece: here / missing -->
        <div v-if="l.stock_lots?.is_offcut" class="row" style="gap:6px;margin-top:8px">
          <button :id="'cq-' + l.id" class="btn" style="flex:1;justify-content:center" :class="{ok: isCounted(l) && Number(l.counted_qty) > 0}" :disabled="!canCount" @click="piece(l, true)">✔ Piece is here</button>
          <button class="btn" style="flex:1;justify-content:center" :class="{bad: isCounted(l) && Number(l.counted_qty) === 0}" :disabled="!canCount" @click="piece(l, false)">✖ Missing</button>
        </div>
        <div v-else class="row floor-qty">
          <button class="btn" :disabled="!canCount" @click="step(l, -1)">−</button>
          <input :id="'cq-' + l.id" type="number" inputmode="decimal" step="any" min="0" v-model="l.counted_qty" :disabled="!canCount" @change="save(l)" :placeholder="l.items.uoms?.code">
          <button class="btn" :disabled="!canCount" @click="step(l, 1)">+</button>
          <span class="muted">{{ l.items.uoms?.code }}</span>
          <input v-if="canCount" v-model="l.note" placeholder="note" class="floor-note" @change="save(l)">
        </div>
      </div>
      <template v-if="canCount">
        <div v-if="found" class="site-card" style="cursor:default;border-color:#fde68a">
          <b>Found — not on the list</b>
          <label class="f" style="margin-top:6px"><span>Item</span><RefSelect v-model="found.item" refName="items" :filter="r => r.is_active && r.item_classes?.tracking === 'LOT'" /></label>
          <div class="row" style="gap:6px;margin-top:6px">
            <input type="number" inputmode="decimal" v-model="found.qty" placeholder="Qty found" style="width:110px;padding:9px">
            <input v-model="found.note" placeholder="where / note" class="floor-note">
          </div>
          <div class="row" style="gap:6px;margin-top:8px"><button class="btn primary" :disabled="busy" @click="addFound">+ Add found item</button><button class="btn" @click="found = null">Cancel</button></div>
        </div>
        <button v-else class="btn" style="width:100%;justify-content:center;margin-bottom:8px" @click="found = { item: null, qty: null, note: '' }">+ Found something not on the list</button>
        <button class="btn ok" style="width:100%;justify-content:center;padding:12px;margin-bottom:24px" :disabled="busy" @click="submit">✔ Submit count ({{ counted }} / {{ lines.length }})</button>
      </template>
    </template>
    <div v-else class="muted">Loading…</div>
    <Scanner v-if="scanning" title="Scan lot, offcut or item label" @code="onScan" @close="scanning = false" />
  </div>`,
  setup() { return { go }; },
};
