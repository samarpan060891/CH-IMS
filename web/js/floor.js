// Floor app: phone-first screen for the shop floor — raise a material request (search or scan items, name boards /
// offcuts), follow my requests, approve them (Production In-charge) and confirm material received. Same server rules as the full screens.
import { sb, state, must, run, rpc, hasRole, today, num, qty, dt, label, loadRefs, refRow, toast, go } from './lib.js';
import { ask, confirmBox, Badge } from './components.js';
import { Scanner, parseCode } from './scan.js';

const KEY = 'cc.floor.for';
const OPEN_MR = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_ISSUED', 'REJECTED'];
const isLotItem = r => r.is_active && r.item_classes?.tracking === 'LOT' && !r.item_classes?.is_scrap && r.item_classes?.code !== 'SRV';
const blank = () => ({ target: '', required_date: '', urgent: false, remarks: '', lines: [] });

export const FloorApp = {
  components: { Badge, Scanner },
  data: () => ({ tab: 'new', loading: false, busy: false, wos: [], projects: [], ccs: [], f: blank(), q: '', avail: {}, scanning: false,
                 mine: [], pending: [], receive: [], openId: null, fits: [] }),
  computed: {
    isPI: () => hasRole('production_incharge'),
    items() { return (state.refs.items || []).filter(isLotItem); },
    found() {
      const q = this.q.trim().toLowerCase(); if (q.length < 2) return [];
      return this.items.filter(i => `${i.code} ${i.name}`.toLowerCase().includes(q)).slice(0, 25);
    },
    // where the material goes: a production order (its project), a project, an MTS order or a cost centre
    targets() {
      return [...this.wos.map(w => ({ v: 'wo:' + w.id, l: `🛠 ${w.wo_no} — ${w.description || ''}${w.projects ? ' · ' + w.projects.code : ''}` })),
              ...this.projects.map(p => ({ v: 'pr:' + p.id, l: `${p.project_type === 'MTS' ? '📦' : '🏗'} ${p.code} — ${p.name}` })),
              ...this.ccs.map(c => ({ v: 'cc:' + c.id, l: `🔧 ${c.code} — ${c.name}` }))];
    },
    wo() { return this.f.target.startsWith('wo:') ? this.wos.find(w => w.id === this.f.target.slice(3)) : null; },
    toReceive() { return this.receive.length; },
  },
  watch: { 'f.target'(v) { try { localStorage.setItem(KEY, v); } catch { /* storage unavailable */ } this.loadFits(); } },
  async mounted() {
    await run(async () => {
      await loadRefs(['items', 'locations']);
      const [w, p, c] = await Promise.all([
        sb.from('production_orders').select('id,wo_no,description,project_id,status,projects(code,project_type)').in('status', ['RELEASED', 'IN_PROGRESS']).order('wo_no'),
        sb.from('projects').select('id,code,name,project_type').eq('status', 'OPEN').order('code'),
        sb.from('cost_centers').select('id,code,name').eq('is_active', true).order('code')]);
      this.wos = must(w); this.projects = must(p); this.ccs = must(c);
      let saved = ''; try { saved = localStorage.getItem(KEY) || ''; } catch { /* storage unavailable */ }
      if (this.targets.some(t => t.v === saved)) this.f.target = saved;
    });
    await this.load();
  },
  methods: {
    qty, dt, label, num,
    async load() {
      this.loading = true;
      await run(async () => {
        const me = state.profile?.id;
        const jobs = [
          sb.from('material_requests').select('id,mr_no,mr_date,status,priority,required_date,approval_comments,projects(code),cost_centers(code),production_orders!material_requests_production_order_id_fkey(wo_no),mr_lines(id,item_id,requested_qty,approved_qty,issued_qty,lot_id,remarks)')
            .eq('requested_by', me).order('created_at', { ascending: false }).limit(40),
          sb.from('material_issues').select('id,issue_no,issue_date,ack_status,projects(code),cost_centers(code),material_requests(mr_no),issue_lines(id,item_id,qty)')
            .eq('status', 'POSTED').eq('ack_status', 'PENDING').order('issue_date', { ascending: false }).limit(40)];
        if (this.isPI) jobs.push(sb.from('material_requests').select('id,mr_no,mr_date,status,priority,required_date,profiles:requested_by(full_name),projects(code),cost_centers(code),production_orders!material_requests_production_order_id_fkey(wo_no),mr_lines(id,item_id,requested_qty,approved_qty,lot_id,remarks)')
          .eq('status', 'PENDING_APPROVAL').order('created_at'));
        const [m, r, p] = await Promise.all(jobs);
        this.mine = must(m); this.receive = must(r); this.pending = p ? must(p) : [];
      });
      this.loading = false;
    },
    itemName(id) { const i = refRow('items', id); return i ? `${i.code} — ${i.name}` : ''; },
    uom(id) { return refRow('items', id)?.uoms?.code || ''; },
    forText(m) { return m.production_orders?.wo_no || m.projects?.code || m.cost_centers?.code || ''; },
    // ---------- new request ----------
    async addItem(i, lot = null) {
      if (lot) {
        if (this.f.lines.some(l => l.lot_id === lot.id)) return toast('That piece is already on the request', 'info');
        this.f.lines.push({ item_id: i.id, qty: num(lot.qty_on_hand), lot_id: lot.id, lot: lot.is_offcut ? `✂ ${qty(lot.length_mm)}${lot.width_mm ? ' × ' + qty(lot.width_mm) : ''} mm · ${lot.lot_no}` : `Lot ${lot.lot_no}`, offcut: lot.is_offcut });
      } else {
        const ex = this.f.lines.find(l => l.item_id === i.id && !l.lot_id);
        if (ex) ex.qty = num(ex.qty) + 1; else this.f.lines.push({ item_id: i.id, qty: 1 });
      }
      this.q = '';
      if (this.avail[i.id] === undefined) {
        const s = must(await sb.from('v_item_stock').select('available').eq('item_id', i.id));
        this.avail = { ...this.avail, [i.id]: num(s[0]?.available) };
      }
    },
    step(l, d) { if (l.offcut) return; l.qty = Math.max(0, Math.round((num(l.qty) + d) * 1000) / 1000); },
    async onScan(code) {
      this.scanning = false;
      const c = parseCode(code);
      await run(async () => {
        if (c.kind === 'lot') {
          const lot = must(await sb.from('stock_lots').select('id,item_id,lot_no,qty_on_hand,status,is_offcut,length_mm,width_mm').eq('id', c.value).maybeSingle());
          if (!lot) throw new Error('Label not found');
          const i = refRow('items', lot.item_id);
          // an offcut label requests that piece; a board / lot label requests the item
          if (lot.is_offcut && lot.status === 'AVAILABLE' && num(lot.qty_on_hand) > 0) await this.addItem(i, lot); else await this.addItem(i);
        } else {
          const i = this.items.find(x => x.code.toLowerCase() === c.value.toLowerCase());
          if (!i) throw new Error(`No item with code ${c.value}`);
          await this.addItem(i);
        }
      });
    },
    // offcuts in stock that fit the chosen production order
    async loadFits() {
      this.fits = [];
      if (!this.wo) return;
      const m = must(await sb.rpc('offcut_matches', { p_wo: this.wo.id }));
      const by = {};
      m.forEach(x => { (by[x.lot_id] ||= { ...x, parts: new Set() }).parts.add(x.part_name); });
      this.fits = Object.values(by).map(x => ({ ...x, parts: [...x.parts].join(', ') }));
    },
    async addFit(x) {
      const lot = must(await sb.from('stock_lots').select('id,item_id,lot_no,qty_on_hand,is_offcut,length_mm,width_mm').eq('id', x.lot_id).single());
      await this.addItem(refRow('items', lot.item_id), lot);
    },
    async submit() {
      const f = this.f, lines = f.lines.filter(l => num(l.qty) > 0);
      if (!f.target) return toast('Choose what the material is for', 'error');
      if (!lines.length) return toast('Add at least one item', 'error');
      const [k, id] = f.target.split(':');
      const hdr = { mr_date: today(), required_date: f.required_date || null, priority: f.urgent ? 'URGENT' : 'NORMAL', remarks: f.remarks || null };
      if (k === 'wo') { const w = this.wo; Object.assign(hdr, { production_order_id: w.id, project_id: w.project_id, purpose: w.projects?.project_type === 'MTS' ? 'MTS' : 'PROJECT' }); }
      else if (k === 'pr') { const p = this.projects.find(x => x.id === id); Object.assign(hdr, { project_id: id, purpose: p?.project_type === 'MTS' ? 'MTS' : 'PROJECT' }); }
      else Object.assign(hdr, { cost_center_id: id, purpose: 'COST_CENTER' });
      this.busy = true;
      const ok = await run(async () => {
        const m = must(await sb.from('material_requests').insert(hdr).select('id,mr_no').single());
        try {
          must(await sb.from('mr_lines').insert(lines.map((l, i) => ({ mr_id: m.id, line_no: i + 1, item_id: l.item_id, requested_qty: num(l.qty), lot_id: l.lot_id || null, remarks: l.note || null }))));
          await rpc('mr_action', { p_mr: m.id, p_action: 'SUBMIT' });
        } catch (e) { await sb.from('material_requests').delete().eq('id', m.id); throw e; }   // don't leave a half-made draft
        toast(`${m.mr_no} sent to the Production In-charge`, 'ok', 6000);
      });
      this.busy = false;
      if (ok) { const t = f.target; this.f = blank(); this.f.target = t; this.tab = 'mine'; await this.load(); }
    },
    // ---------- my requests ----------
    async cancel(m) {
      if (!(await confirmBox('Cancel request', `Cancel ${m.mr_no}?`, true))) return;
      if (await run(() => rpc('mr_action', { p_mr: m.id, p_action: 'CANCEL' }), 'Request cancelled')) await this.load();
    },
    // ---------- approvals (Production In-charge) ----------
    async approve(m) {
      if (await run(() => rpc('mr_action', { p_mr: m.id, p_action: 'APPROVE' }), `${m.mr_no} approved — Stores can issue`)) await this.load();
    },
    async reject(m) {
      const v = await ask({ title: 'Reject ' + m.mr_no, fields: [{ k: 'r', label: 'Reason', type: 'textarea', required: true }], okText: 'Reject', danger: true });
      if (v && await run(() => rpc('mr_action', { p_mr: m.id, p_action: 'REJECT', p_comments: v.r }), 'Request rejected')) await this.load();
    },
    // ---------- receive material ----------
    async allOk(i) {
      const payload = i.issue_lines.map(l => ({ line_id: l.id, received_qty: num(l.qty), damaged_qty: 0 }));
      if (await run(() => rpc('issue_acknowledge', { p_issue: i.id, p_lines: payload, p_remarks: null }), `${i.issue_no} received`)) await this.load();
    },
    async problem(i) {
      const fields = [];
      i.issue_lines.forEach(l => {
        fields.push({ k: l.id + '_g', label: `${this.itemName(l.item_id)} — issued ${qty(l.qty)} ${this.uom(l.item_id)}: good`, type: 'number', required: true, default: num(l.qty) });
        fields.push({ k: l.id + '_d', label: '… damaged', type: 'number', default: 0 });
      });
      fields.push({ k: '_rem', label: 'What is wrong? (required)', type: 'textarea', required: true });
      const v = await ask({ title: 'Problem with ' + i.issue_no, message: 'Enter what actually arrived. Damaged goes back to Stores; short or excess alerts Stores and the Factory Manager.', fields, okText: 'Send' });
      if (!v) return;
      const payload = i.issue_lines.map(l => ({ line_id: l.id, received_qty: num(v[l.id + '_g']), damaged_qty: num(v[l.id + '_d']) }));
      if (await run(() => rpc('issue_acknowledge', { p_issue: i.id, p_lines: payload, p_remarks: v._rem }), 'Recorded — Stores alerted')) await this.load();
    },
  },
  template: `<div class="site floor">
    <div class="site-tabs">
      <a :class="{on: tab==='new'}" @click="tab='new'">➕ Request</a>
      <a :class="{on: tab==='mine'}" @click="tab='mine'">📋 Mine</a>
      <a v-if="isPI" :class="{on: tab==='ok'}" @click="tab='ok'">✔ Approve <span class="badge" v-if="pending.length">{{ pending.length }}</span></a>
      <a :class="{on: tab==='rcv'}" @click="tab='rcv'">📦 Receive <span class="badge" v-if="toReceive">{{ toReceive }}</span></a>
    </div>

    <!-- ===== new request ===== -->
    <template v-if="tab==='new'">
      <select v-model="f.target" class="site-proj" style="width:100%;margin-bottom:8px">
        <option value="">— Material for… —</option>
        <option v-for="t in targets" :key="t.v" :value="t.v">{{ t.l }}</option>
      </select>
      <div class="row" style="gap:6px;margin-bottom:8px">
        <input v-model="q" placeholder="Search item code or name…" class="site-search" style="margin:0;flex:1">
        <button class="btn primary" @click="scanning = true" title="Scan item, board or offcut label">📷</button>
      </div>
      <div v-if="found.length" class="floor-found">
        <div v-for="i in found" :key="i.id" class="floor-hit" @click="addItem(i)"><b>{{ i.code }}</b> {{ i.name }} <span class="muted small">{{ i.uoms?.code }}</span></div>
      </div>
      <div v-if="fits.length" class="site-card" style="cursor:default;background:#fffbeb;border-color:#fde68a">
        <b>✂ Offcuts that fit {{ wo.wo_no }}</b> <span class="small muted">— use these before cutting new sheets</span>
        <div v-for="x in fits" :key="x.lot_id" class="row" style="margin-top:6px;gap:6px">
          <div style="flex:1" class="small"><b>{{ x.item_code }}</b> {{ qty(x.offcut_length) }}{{ x.offcut_width ? ' × ' + qty(x.offcut_width) : '' }} mm · {{ x.location_code }}<div class="muted">fits: {{ x.parts }}</div></div>
          <button class="btn sm" :disabled="f.lines.some(l => l.lot_id === x.lot_id)" @click="addFit(x)">{{ f.lines.some(l => l.lot_id === x.lot_id) ? '✔ Added' : '+ Add' }}</button>
        </div>
      </div>
      <div v-if="!f.lines.length" class="card empty">Search or scan to add items</div>
      <div v-for="(l, i) in f.lines" :key="i" class="site-card floor-line">
        <div class="row"><div style="flex:1"><b>{{ itemName(l.item_id) }}</b>
          <div class="small" v-if="l.lot" style="color:#1e40af">{{ l.lot }}{{ l.offcut ? ' — whole piece' : '' }}</div>
          <div class="small muted" v-else-if="avail[l.item_id] !== undefined">{{ qty(avail[l.item_id]) }} {{ uom(l.item_id) }} free in store</div></div>
          <button class="btn sm bad" @click="f.lines.splice(i, 1)">✕</button></div>
        <div class="row floor-qty">
          <button class="btn" @click="step(l, -1)" :disabled="l.offcut">−</button>
          <input type="number" step="any" min="0" v-model.number="l.qty" :readonly="l.offcut">
          <button class="btn" @click="step(l, 1)" :disabled="l.offcut">+</button>
          <span class="muted">{{ uom(l.item_id) }}</span>
          <input v-model="l.note" placeholder="drawing / note" class="floor-note">
        </div>
      </div>
      <template v-if="f.lines.length">
        <div class="row" style="gap:8px;margin:6px 0">
          <label class="f" style="flex:1"><span>Needed by</span><input type="date" v-model="f.required_date"></label>
          <label class="row small" style="gap:6px;margin-top:16px"><input type="checkbox" v-model="f.urgent"> Urgent</label>
        </div>
        <textarea v-model="f.remarks" placeholder="Remarks (optional)" style="width:100%;margin-bottom:8px"></textarea>
        <button class="btn primary" style="width:100%;justify-content:center;padding:12px" :disabled="busy" @click="submit">📤 Send request ({{ f.lines.length }} item{{ f.lines.length > 1 ? 's' : '' }})</button>
      </template>
    </template>

    <!-- ===== my requests ===== -->
    <template v-if="tab==='mine'">
      <div v-if="!mine.length" class="card empty">{{ loading ? 'Loading…' : 'No requests yet' }}</div>
      <div v-for="m in mine" :key="m.id" class="site-card" @click="openId = openId === m.id ? null : m.id">
        <div class="row"><b>{{ m.mr_no }}</b>&nbsp;<span class="muted small">{{ forText(m) }} · {{ dt(m.mr_date) }}</span><span class="spacer"></span>
          <Badge v-if="m.priority==='URGENT'" v="URGENT" />&nbsp;<Badge :v="m.status" /></div>
        <div class="small muted">{{ m.mr_lines.length }} item(s){{ m.required_date ? ' · needed ' + dt(m.required_date) : '' }}</div>
        <div v-if="m.status==='REJECTED' && m.approval_comments" class="small" style="color:#b91c1c">Rejected: {{ m.approval_comments }}</div>
        <template v-if="openId===m.id">
          <div v-for="l in m.mr_lines" :key="l.id" class="row small" style="margin-top:4px">
            <span style="flex:1">{{ itemName(l.item_id) }}{{ l.lot_id ? ' (named piece)' : '' }}</span>
            <span>{{ qty(l.issued_qty) }} / {{ qty(l.approved_qty ?? l.requested_qty) }} {{ uom(l.item_id) }}</span>
          </div>
          <div class="site-actions" style="margin-top:6px" @click.stop>
            <button class="btn sm" @click="go('d/mr/' + m.id)">Open full screen</button>
            <button class="btn sm bad" v-if="['DRAFT','PENDING_APPROVAL','REJECTED'].includes(m.status)" @click="cancel(m)">Cancel</button>
          </div>
        </template>
      </div>
    </template>

    <!-- ===== approvals ===== -->
    <template v-if="tab==='ok'">
      <div v-if="!pending.length" class="card empty">Nothing waiting for approval 🎉</div>
      <div v-for="m in pending" :key="m.id" class="site-card" style="cursor:default">
        <div class="row"><b>{{ m.mr_no }}</b>&nbsp;<span class="muted small">{{ forText(m) }} · {{ m.profiles?.full_name }}</span><span class="spacer"></span><Badge v-if="m.priority==='URGENT'" v="URGENT" /></div>
        <div v-for="l in m.mr_lines" :key="l.id" class="row small" style="margin-top:4px">
          <span style="flex:1">{{ itemName(l.item_id) }}{{ l.lot_id ? ' (named piece)' : '' }}{{ l.remarks ? ' · ' + l.remarks : '' }}</span><b>{{ qty(l.requested_qty) }} {{ uom(l.item_id) }}</b>
        </div>
        <div class="site-actions" style="margin-top:8px">
          <button class="btn ok" @click="approve(m)">✔ Approve</button>
          <button class="btn bad" @click="reject(m)">✖ Reject</button>
          <button class="btn" @click="go('d/mr/' + m.id)">Change qty…</button>
        </div>
      </div>
    </template>

    <!-- ===== receive ===== -->
    <template v-if="tab==='rcv'">
      <div v-if="!receive.length" class="card empty">No material waiting to be received</div>
      <div v-for="i in receive" :key="i.id" class="site-card" style="cursor:default">
        <div class="row"><b>{{ i.issue_no }}</b>&nbsp;<span class="muted small">{{ i.material_requests?.mr_no || '' }} · {{ i.projects?.code || i.cost_centers?.code }} · {{ dt(i.issue_date) }}</span></div>
        <div v-for="l in i.issue_lines" :key="l.id" class="row small" style="margin-top:4px"><span style="flex:1">{{ itemName(l.item_id) }}</span><b>{{ qty(l.qty) }} {{ uom(l.item_id) }}</b></div>
        <div class="site-actions" style="margin-top:8px">
          <button class="btn ok" @click="allOk(i)">✔ All received OK</button>
          <button class="btn bad" @click="problem(i)">⚠ Short / damaged</button>
        </div>
      </div>
    </template>
    <Scanner v-if="scanning" title="Scan item, board or offcut label" @code="onScan" @close="scanning = false" />
  </div>`,
  setup() { return { go }; },
};
