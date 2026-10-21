// Receive app: phone-first goods receipt at the gate / dock — open POs, count what arrived (DN qty, received, damaged),
// batch / expiry where the item requires it, then save a draft (landed costs on the desktop) or post straight away.
// Same tables and posting function as the full GRN screen; posting rules (excess / damaged to quarantine, short vs DN) are the server's.
import { sb, state, must, run, rpc, hasRole, today, num, qty, dt, refRow, loadRefs, toast, go } from './lib.js';
import { confirmBox, Badge } from './components.js';
import { Scanner, parseCode } from './scan.js';

const stockLot = it => !!it && it.item_classes?.tracking === 'LOT' && it.item_classes?.code !== 'SRV';
const needsBatch = id => { const it = refRow('items', id); return stockLot(it) && !!it.batch_controlled; };
const needsExpiry = id => !!refRow('items', id)?.has_expiry;
const isSerial = id => refRow('items', id)?.item_classes?.tracking === 'SERIAL';
// expiry from mfg date (or the receipt date) + shelf life, when the item master has one
function fillExpiry(l, grnDate) {
  const it = refRow('items', l.item_id);
  if (l.expiry_date || !it?.has_expiry || !num(it.shelf_life_days)) return;
  const d = new Date((l.mfg_date || grnDate || today()) + 'T00:00:00'); d.setDate(d.getDate() + num(it.shelf_life_days));
  l.expiry_date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// what posting will do with a line: good = received - damaged; into stock up to the PO balance; the rest is excess
function split(l) {
  const good = Math.max(num(l.received_qty) - num(l.damaged_qty), 0), acc = Math.min(good, Math.max(l.bal, 0));
  return { good, acc, exc: good - acc, short: l.dn_qty != null && l.dn_qty !== '' ? Math.max(num(l.dn_qty) - num(l.received_qty), 0) : 0 };
}

export const ReceiveApp = {
  components: { Badge, Scanner },
  data: () => ({ tab: 'po', pos: [], drafts: [], q: '', loading: false, busy: false, f: null, scanning: false, last: null }),
  computed: {
    siteOnly: () => hasRole('site_supervisor') && !hasRole('stores'),
    locations() { return (state.refs.locations || []).filter(r => r.is_stock && r.is_active && (!this.siteOnly || r.loc_type === 'SITE')); },
    shownPos() {
      const q = this.q.trim().toLowerCase();
      return this.pos.filter(p => !q || `${p.po_no} ${p.vendors?.name || ''} ${p.projects?.code || ''}`.toLowerCase().includes(q));
    },
  },
  async mounted() { await loadRefs(['items', 'locations']); await this.load(); },
  methods: {
    qty, dt, num, split, needsBatch, needsExpiry, isSerial,
    itemName(id) { const i = refRow('items', id); return i ? `${i.code} — ${i.name}` : ''; },
    uom(id) { return refRow('items', id)?.uoms?.code || ''; },
    late: p => p.delivery_date && p.delivery_date < today(),
    fillExp(l) { fillExpiry(l, this.f.grn_date); },
    async load() {
      this.loading = true;
      await run(async () => {
        const [p, d] = await Promise.all([
          sb.from('purchase_orders').select('id,po_no,po_date,delivery_date,status,vendor_id,project_id,currency,exchange_rate,delivery_location_id,vendors(name),projects(code),po_lines(id,item_id,qty,received_qty)')
            .in('status', ['RELEASED', 'PARTIALLY_RECEIVED']).order('delivery_date', { nullsFirst: false }),
          sb.from('grns').select('id,grn_no,grn_date,vendor_dn_no,purchase_orders(po_no),vendors(name),grn_lines(count)').eq('status', 'DRAFT').order('created_at', { ascending: false }).limit(30)]);
        this.pos = must(p).filter(x => x.po_lines.some(l => num(l.qty) > num(l.received_qty)));
        this.drafts = must(d);
      });
      this.loading = false;
    },
    // ---------- receive against a PO ----------
    async start(p) {
      await run(async () => {
        const lines = must(await sb.from('po_lines').select('id,item_id,qty,received_qty,rate,discount_pct,vat_rate,project_id').eq('po_id', p.id).order('line_no'));
        const loc = this.locations.find(l => l.id === p.delivery_location_id)?.id || (this.siteOnly ? this.locations[0]?.id : this.locations.find(l => l.code === 'MS')?.id) || this.locations[0]?.id || null;
        this.f = { po: p, location_id: loc, grn_date: today(), dn_no: '', dn_date: today(), vehicle: '', remarks: '',
          lines: lines.filter(l => num(l.qty) > num(l.received_qty)).map(l => {
            const bal = num(l.qty) - num(l.received_qty);
            const r = { po_line_id: l.id, item_id: l.item_id, project_id: l.project_id, bal, dn_qty: bal, received_qty: bal, damaged_qty: 0, reason: '',
                        rate: num(l.rate) * (1 - num(l.discount_pct) / 100), vat_rate: l.vat_rate, batch_no: '', mfg_date: '', expiry_date: '', skip: false };
            fillExpiry(r, today());
            return r;
          }) };
      });
    },
    step(l, k, d) { l[k] = Math.max(0, Math.round((num(l[k]) + d) * 1000) / 1000); if (k === 'received_qty' && num(l.damaged_qty) > num(l.received_qty)) l.damaged_qty = l.received_qty; },
    // scanning an item label (supplier or our own) jumps to that item's line
    onScan(code) {
      this.scanning = false;
      const c = parseCode(code);
      const it = (state.refs.items || []).find(i => i.code.toLowerCase() === String(c.value).toLowerCase());
      const l = it && this.f.lines.find(x => x.item_id === it.id);
      if (!l) return toast('That item is not on this PO', 'error');
      l.skip = false;
      this.$nextTick(() => document.getElementById('rl-' + l.po_line_id)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    },
    validate() {
      const f = this.f, lines = f.lines.filter(l => !l.skip && num(l.received_qty) > 0);
      if (!f.location_id) throw new Error('Choose where the goods are received');
      if (!lines.length) throw new Error('Nothing received — enter a quantity or untick "not delivered"');
      for (const l of lines) {
        const n = this.itemName(l.item_id);
        fillExpiry(l, f.grn_date);
        if (num(l.damaged_qty) < 0 || num(l.damaged_qty) > num(l.received_qty)) throw new Error(`${n}: damaged must be between 0 and the received qty`);
        if ((num(l.damaged_qty) > 0 || split(l).short > 0) && !String(l.reason).trim()) throw new Error(`${n}: say what is damaged / short`);
        if (needsBatch(l.item_id) && !String(l.batch_no).trim()) throw new Error(`${n}: batch no. is required`);
        if (needsExpiry(l.item_id) && !l.expiry_date) throw new Error(`${n}: expiry date is required (or the mfg date)`);
        if (l.expiry_date && l.expiry_date <= f.grn_date) throw new Error(`${n}: already expired (${dt(l.expiry_date)}) — do not receive`);
      }
      return lines;
    },
    async save(post) {
      const f = this.f, p = f.po;
      let lines; try { lines = this.validate(); } catch (e) { return toast(e.message, 'error'); }
      if (post) {
        const exc = lines.reduce((s, l) => s + split(l).exc, 0), dmg = lines.reduce((s, l) => s + num(l.damaged_qty), 0);
        const msg = `Post this receipt now? Stock lots are created and ${p.po_no} is updated — it cannot be undone.` +
          (dmg || exc ? ` Damaged (${qty(dmg)}) and excess (${qty(exc)}) go to Quarantine on hold.` : '') +
          ' If freight / customs / clearing charges are expected, save a draft instead and add them on the desktop first.';
        if (!(await confirmBox('Receive & post', msg))) return;
      }
      this.busy = true;
      const ok = await run(async () => {
        const g = must(await sb.from('grns').insert({ receipt_type: 'PO', po_id: p.id, vendor_id: p.vendor_id, project_id: p.project_id, currency: p.currency || 'AED', exchange_rate: p.exchange_rate || 1,
          location_id: f.location_id, grn_date: f.grn_date, vendor_dn_no: f.dn_no || null, vendor_dn_date: f.dn_date || null, vehicle_no: f.vehicle || null, remarks: f.remarks || null }).select('id,grn_no').single());
        try {
          must(await sb.from('grn_lines').insert(lines.map((l, i) => ({ grn_id: g.id, line_no: i + 1, po_line_id: l.po_line_id, item_id: l.item_id, project_id: l.project_id,
            dn_qty: l.dn_qty === '' || l.dn_qty == null ? null : num(l.dn_qty), received_qty: num(l.received_qty), damaged_qty: num(l.damaged_qty), rejection_reason: l.reason || null,
            rate: l.rate, vat_rate: l.vat_rate, batch_no: l.batch_no || null, mfg_date: l.mfg_date || null, expiry_date: l.expiry_date || null }))));
          if (post) await rpc('post_grn', { p_grn: g.id });
        } catch (e) {
          // a failed post leaves a complete draft to fix on the desktop; a failed save leaves nothing behind
          if (post && (await sb.from('grn_lines').select('id', { count: 'exact', head: true }).eq('grn_id', g.id)).count) throw new Error(`${g.grn_no} saved as a draft but not posted: ${e.message}`);
          await sb.from('grns').delete().eq('id', g.id); throw e;
        }
        toast(post ? `${g.grn_no} posted — stock updated` : `${g.grn_no} saved as a draft — add landed costs and post on the desktop`, 'ok', 7000);
        this.last = { id: g.id, no: g.grn_no, posted: post };
      });
      this.busy = false;
      if (ok) { this.f = null; this.tab = 'done'; await this.load(); }
    },
    // ---------- drafts ----------
    async postDraft(d) {
      if (!(await confirmBox('Post ' + d.grn_no, 'Post this draft receipt? Stock lots are created and the PO updated — it cannot be undone.'))) return;
      if (await run(() => rpc('post_grn', { p_grn: d.id }), `${d.grn_no} posted`)) await this.load();
    },
  },
  template: `<div class="site rcv">
    <template v-if="!f">
      <div class="site-tabs">
        <a :class="{on: tab==='po' || tab==='done'}" @click="tab='po'">🚚 Open POs <span class="badge" v-if="pos.length">{{ pos.length }}</span></a>
        <a :class="{on: tab==='draft'}" @click="tab='draft'">📝 Drafts <span class="badge" v-if="drafts.length">{{ drafts.length }}</span></a>
      </div>
      <div v-if="tab==='done' && last" class="site-card" style="cursor:default;border-color:#bbf7d0;background:#f0fdf4">
        <b>{{ last.posted ? '✔ ' + last.no + ' posted' : '📝 ' + last.no + ' saved as draft' }}</b>
        <div class="site-actions" style="margin-top:8px">
          <button class="btn" @click="go('d/grn/' + last.id)">Open GRN</button>
          <button class="btn" v-if="last.posted" @click="go('labels/lots/' + last.id)">🏷 Lot labels</button>
          <button class="btn" @click="tab='po'; last=null">OK</button>
        </div>
      </div>
      <template v-if="tab!=='draft'">
        <div class="row" style="gap:6px;margin-bottom:8px">
          <input v-model="q" placeholder="Search PO, vendor or project…" class="site-search" style="margin:0;flex:1">
          <button class="btn sm" @click="load" :disabled="loading">↻</button>
        </div>
        <div v-if="!shownPos.length" class="card empty">{{ loading ? 'Loading…' : 'No released purchase orders waiting for delivery' }}</div>
        <div v-for="p in shownPos" :key="p.id" class="site-card" @click="start(p)">
          <div class="row"><b>{{ p.po_no }}</b>&nbsp;<span class="muted small">{{ p.projects?.code || 'Stock' }}</span><span class="spacer"></span>
            <span v-if="late(p)" class="b OVERDUE">late</span><Badge v-else :v="p.status" /></div>
          <div style="font-weight:600">{{ p.vendors?.name }}</div>
          <div class="small muted">{{ p.po_lines.filter(l => num(l.qty) > num(l.received_qty)).length }} line(s) to receive{{ p.delivery_date ? ' · due ' + dt(p.delivery_date) : '' }}</div>
        </div>
      </template>
      <template v-if="tab==='draft'">
        <div v-if="!drafts.length" class="card empty">No draft receipts</div>
        <div v-for="d in drafts" :key="d.id" class="site-card" style="cursor:default">
          <div class="row"><b>{{ d.grn_no }}</b>&nbsp;<span class="muted small">{{ d.purchase_orders?.po_no || '' }} · {{ dt(d.grn_date) }}</span></div>
          <div class="small">{{ d.vendors?.name }} · {{ d.grn_lines?.[0]?.count || 0 }} line(s){{ d.vendor_dn_no ? ' · DN ' + d.vendor_dn_no : '' }}</div>
          <div class="site-actions" style="margin-top:8px"><button class="btn ok" @click="postDraft(d)">✔ Post</button><button class="btn" @click="go('d/grn/' + d.id)">Open (landed costs)</button></div>
        </div>
      </template>
    </template>

    <!-- ===== receive form ===== -->
    <template v-else>
      <div class="row" style="margin:4px 0 8px"><button class="btn sm" @click="f = null">←</button>
        <div style="margin-left:6px;min-width:0"><b>{{ f.po.po_no }}</b> <span class="muted small">{{ f.po.projects?.code || 'Stock' }}</span><div class="small">{{ f.po.vendors?.name }}</div></div>
        <span class="spacer"></span><button class="btn sm primary" @click="scanning = true" title="Scan an item label">📷</button></div>
      <div class="site-card" style="cursor:default">
        <label class="f"><span>Received into</span><select v-model="f.location_id" style="padding:9px"><option v-for="l in locations" :value="l.id">{{ l.code }} — {{ l.name }}</option></select></label>
        <div class="row" style="gap:6px;margin-top:6px">
          <label class="f" style="flex:1"><span>Delivery note no.</span><input v-model="f.dn_no" placeholder="DN no."></label>
          <label class="f" style="width:140px"><span>DN date</span><input type="date" v-model="f.dn_date"></label>
        </div>
        <label class="f" style="margin-top:6px"><span>Vehicle no.</span><input v-model="f.vehicle"></label>
      </div>
      <div v-for="l in f.lines" :key="l.po_line_id" :id="'rl-' + l.po_line_id" class="site-card rcv-line" :class="{skip: l.skip}">
        <div class="row" style="align-items:flex-start"><div style="flex:1;min-width:0"><b>{{ itemName(l.item_id) }}</b>
          <div class="small muted">ordered, not yet received: {{ qty(l.bal) }} {{ uom(l.item_id) }}</div></div>
          <label class="row small" style="gap:4px;white-space:nowrap"><input type="checkbox" v-model="l.skip"> not delivered</label></div>
        <template v-if="!l.skip">
          <div class="rcv-grid">
            <span class="small">DN qty</span>
            <div class="row floor-qty" style="margin:0"><input type="number" inputmode="decimal" step="any" min="0" v-model.number="l.dn_qty"></div>
            <span class="small">Received</span>
            <div class="row floor-qty" style="margin:0"><button class="btn" @click="step(l, 'received_qty', -1)">−</button><input type="number" inputmode="decimal" step="any" min="0" v-model.number="l.received_qty"><button class="btn" @click="step(l, 'received_qty', 1)">+</button></div>
            <span class="small">Damaged</span>
            <div class="row floor-qty" style="margin:0"><button class="btn" @click="step(l, 'damaged_qty', -1)">−</button><input type="number" inputmode="decimal" step="any" min="0" v-model.number="l.damaged_qty"><button class="btn" @click="step(l, 'damaged_qty', 1)">+</button></div>
          </div>
          <div class="small" style="margin-top:6px">
            → <b style="color:#15803d">{{ qty(split(l).acc) }}</b> into stock
            <span v-if="num(l.damaged_qty)" style="color:#b91c1c"> · {{ qty(l.damaged_qty) }} damaged → quarantine</span>
            <span v-if="split(l).exc" style="color:#b45309"> · {{ qty(split(l).exc) }} excess → quarantine</span>
            <span v-if="split(l).short" style="color:#b45309"> · {{ qty(split(l).short) }} short vs DN</span>
          </div>
          <input v-if="num(l.damaged_qty) || split(l).short" v-model="l.reason" placeholder="What is damaged / short? (required)" class="floor-note" style="width:100%;margin-top:6px">
          <div v-if="needsBatch(l.item_id) || needsExpiry(l.item_id)" class="row" style="gap:6px;margin-top:6px;flex-wrap:wrap">
            <input v-if="needsBatch(l.item_id)" v-model="l.batch_no" placeholder="Batch no. (required)" class="floor-note">
            <template v-if="needsExpiry(l.item_id)">
              <label class="f" style="width:140px"><span>Mfg date</span><input type="date" v-model="l.mfg_date" @change="l.expiry_date=''; fillExp(l)"></label>
              <label class="f" style="width:140px"><span>Expiry *</span><input type="date" v-model="l.expiry_date"></label>
            </template>
          </div>
          <div v-if="isSerial(l.item_id)" class="small muted" style="margin-top:6px">Tools / assets: serial numbers can be added on the desktop GRN (save as draft).</div>
        </template>
      </div>
      <textarea v-model="f.remarks" placeholder="Remarks (optional)" style="width:100%;margin:4px 0 8px"></textarea>
      <div class="row" style="gap:8px;margin-bottom:24px">
        <button class="btn" style="flex:1;justify-content:center;padding:12px" :disabled="busy" @click="save(false)">💾 Save draft</button>
        <button class="btn ok" style="flex:1;justify-content:center;padding:12px" :disabled="busy" @click="save(true)">✔ Receive & post</button>
      </div>
    </template>
    <Scanner v-if="scanning" title="Scan an item label" @code="onScan" @close="scanning = false" />
  </div>`,
  setup() { return { go }; },
};
