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
