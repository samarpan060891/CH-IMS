// Floor app: phone-first screen for the shop floor — raise a material request (search or scan items, name boards /
// offcuts), follow my requests, approve them (Production In-charge) and confirm material received. Same server rules as the full screens.
import { sb, state, must, run, rpc, hasRole, today, num, qty, dt, label, loadRefs, refRow, toast, go } from './lib.js';
import { ask, confirmBox, Badge } from './components.js';
import { Scanner, parseCode } from './scan.js';

const KEY = 'cc.floor.for';
const OPEN_MR = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_ISSUED', 'REJECTED'];
const isLotItem = r => r.is_active && r.item_classes?.tracking === 'LOT' && !r.item_classes?.is_scrap && r.item_classes?.code !== 'SRV';
const blank = () => ({ target: '', required_date: '', urgent: false, remarks: '', lines: [] });
// offcut share of a full sheet (L × W) or length (L); the server recomputes on save
function offcutQty(item, l, w, pcs) {
  if (!item || !num(item.length_mm) || !num(l)) return 0;
  const f = num(item.width_mm) > 0 ? num(l) * num(w) / (num(item.length_mm) * num(item.width_mm)) : num(l) / num(item.length_mm);
  return Math.round(f * Math.max(num(pcs) || 1, 1) * 10000) / 10000;
}
const sizeText = r => `${qty(r.offcut_length_mm)}${r.offcut_width_mm ? ' × ' + qty(r.offcut_width_mm) : ''} mm × ${r.pieces || 1}`;

export const FloorApp = {
  components: { Badge, Scanner },
  data: () => ({ tab: 'new', loading: false, busy: false, wos: [], projects: [], ccs: [], f: blank(), q: '', avail: {}, scanning: false,
                 mine: [], pending: [], receive: [], openId: null, fits: [],
                 issues: [], iq: '', rt: null, myReturns: [], ocPI: [], ocFM: [] }),
  computed: {
    isPI: () => hasRole('production_incharge'),
    isFM: () => hasRole('factory_manager'),
    canReturn: () => hasRole('shop_floor', 'production_incharge', 'stores'),
    approvals() { return this.pending.length + this.ocPI.length + this.ocFM.length; },
    shownIssues() {
      const q = this.iq.trim().toLowerCase();
      return this.issues.filter(i => !q || `${i.issue_no} ${i.projects?.code || ''} ${i.cost_centers?.code || ''} ${i.material_requests?.mr_no || ''}`.toLowerCase().includes(q));
    },
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
  watch: {
    'f.target'(v) { try { localStorage.setItem(KEY, v); } catch { /* storage unavailable */ } this.loadFits(); },
    tab(v) { if (v === 'ret' && !this.issues.length) run(() => this.loadIssues()); },
  },
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
        const ret = 'id,return_no,return_date,status,returned_by_name,offcut_comments,material_issues(issue_no,projects(code),cost_centers(code)),' +
                    'return_lines(id,item_id,qty,condition,offcut_length_mm,offcut_width_mm,pieces,offcut_action,reason)';
        jobs.push(sb.from('material_returns').select(ret).eq('requested_by', me).order('created_at', { ascending: false }).limit(30));
        jobs.push(this.isPI ? sb.from('material_returns').select(ret).eq('status', 'PENDING_PI').order('created_at') : Promise.resolve({ data: [] }));
        jobs.push(this.isFM ? sb.from('material_returns').select(ret).eq('status', 'PENDING_FM').order('created_at') : Promise.resolve({ data: [] }));
        if (this.isPI) jobs.push(sb.from('material_requests').select('id,mr_no,mr_date,status,priority,required_date,profiles:requested_by(full_name),projects(code),cost_centers(code),production_orders!material_requests_production_order_id_fkey(wo_no),mr_lines(id,item_id,requested_qty,approved_qty,lot_id,remarks)')
          .eq('status', 'PENDING_APPROVAL').order('created_at'));
        const [m, r, mr, pi, fm, p] = await Promise.all(jobs);
        this.mine = must(m); this.receive = must(r); this.myReturns = must(mr); this.pending = p ? must(p) : [];
        // offcut decisions: each line keeps the In-charge's choice while editing
        this.ocPI = must(pi).map(x => ({ ...x, return_lines: x.return_lines.map(l => ({ ...l, _act: l.offcut_action || 'KEEP' })) }));
        this.ocFM = must(fm);
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
    // ---------- return to store (whole items and offcuts) ----------
    async loadIssues() {
      const since = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
      const rows = must(await sb.from('material_issues').select('id,issue_no,issue_date,from_location_id,projects(code),cost_centers(code),material_requests(mr_no),issue_lines(id,item_id,qty,returned_qty)')
        .eq('status', 'POSTED').gte('issue_date', since).order('issue_date', { ascending: false }).limit(150));
      this.issues = rows.filter(i => i.issue_lines.some(l => num(l.qty) > num(l.returned_qty)));
    },
    startReturn(i) {
      this.rt = { issue: i, to: i.from_location_id, by: state.profile?.full_name || '', remarks: '',
        lines: i.issue_lines.filter(l => num(l.qty) > num(l.returned_qty)).map(l => ({ issue_line_id: l.id, item_id: l.item_id, bal: num(l.qty) - num(l.returned_qty), qty: null, condition: 'GOOD', reason: '' })),
        offcuts: [] };
    },
    sheet(id) { const i = refRow('items', id); return i && num(i.length_mm) > 0 ? i : null; },
    async addOffcut(l) {
      const i = this.sheet(l.item_id);
      const v = await ask({ title: 'Offcut — ' + this.itemName(l.item_id), okText: 'Add',
        message: `Full ${num(i.width_mm) ? 'sheet' : 'length'}: ${qty(i.length_mm)}${num(i.width_mm) ? ' × ' + qty(i.width_mm) : ''} mm. Measure the piece coming back.`,
        fields: [{ k: 'l', label: 'Length mm', type: 'number', required: true }, ...(num(i.width_mm) ? [{ k: 'w', label: 'Width mm', type: 'number', required: true }] : []),
                 { k: 'p', label: 'Pieces of this size', type: 'number', default: 1 },
                 ...(this.isPI ? [{ k: 'a', label: 'Keep or scrap', type: 'select', required: true, options: [{ v: 'KEEP', l: 'Keep as offcut' }, { v: 'SCRAP', l: 'Scrap' }], default: 'KEEP' }] : [])] });
      if (!v) return;
      const big = Math.max(num(v.l), num(v.w)), small = Math.min(num(v.l), num(v.w) || num(v.l));
      if (num(i.width_mm) ? (big > Math.max(i.length_mm, i.width_mm) || small > Math.min(i.length_mm, i.width_mm)) : num(v.l) > num(i.length_mm)) return toast('Bigger than a full sheet / length', 'error');
      this.rt.offcuts.push({ issue_line_id: l.issue_line_id, item_id: l.item_id, condition: 'OFFCUT', offcut_length_mm: num(v.l), offcut_width_mm: num(i.width_mm) ? num(v.w) : null,
        pieces: Math.max(num(v.p) || 1, 1), offcut_action: v.a || null, qty: offcutQty(i, v.l, v.w, v.p) });
    },
    usedOf(l) { return num(l.qty) + this.rt.offcuts.filter(o => o.issue_line_id === l.issue_line_id).reduce((s, o) => s + o.qty, 0); },
    async sendReturn() {
      const r = this.rt;
      const whole = r.lines.filter(l => num(l.qty) > 0);
      if (!whole.length && !r.offcuts.length) return toast('Enter a quantity or add an offcut', 'error');
      for (const l of r.lines) if (this.usedOf(l) > l.bal + 0.0005) return toast(`${this.itemName(l.item_id)}: only ${qty(l.bal)} can be returned (items + offcuts)`, 'error');
      this.busy = true;
      const ok = await run(async () => {
        const h = must(await sb.from('material_returns').insert({ issue_id: r.issue.id, to_location_id: r.to, return_date: today(), returned_by_name: r.by || null, remarks: r.remarks || null })
          .select('id,return_no').single());
        try {
          const rows = [...whole.map(l => ({ return_id: h.id, issue_line_id: l.issue_line_id, item_id: l.item_id, qty: num(l.qty), condition: l.condition, reason: l.reason || null })),
                        ...r.offcuts.map(o => ({ return_id: h.id, issue_line_id: o.issue_line_id, item_id: o.item_id, qty: o.qty, condition: 'OFFCUT', offcut_length_mm: o.offcut_length_mm,
                                                 offcut_width_mm: o.offcut_width_mm, pieces: o.pieces, offcut_action: o.offcut_action, reason: 'Offcut' }))];
          must(await sb.from('return_lines').insert(rows));
          const st = await rpc('return_action', { p_ret: h.id, p_action: 'SUBMIT' });
          toast(`${h.return_no} sent — ${st === 'SUBMITTED' ? 'Stores will receive it' : st === 'PENDING_FM' ? 'offcuts go to the Factory Manager' : 'offcuts go to the Production In-charge'}`, 'ok', 7000);
        } catch (e) { await sb.from('material_returns').delete().eq('id', h.id); throw e; }   // don't leave a half-made draft
      });
      this.busy = false;
      if (ok) { this.rt = null; await this.loadIssues(); await this.load(); }
    },
    // ---------- offcut keep / scrap (In-charge proposes, Factory Manager approves) ----------
    ocLines(x) { return x.return_lines.filter(l => l.condition === 'OFFCUT'); },
    async propose(x) {
      const lines = this.ocLines(x).map(l => ({ id: l.id, action: l._act }));
      if (await run(() => rpc('return_offcut_action', { p_ret: x.id, p_action: 'PROPOSE', p_lines: lines, p_comments: x._c || null }), 'Sent to the Factory Manager')) await this.load();
    },
    async fmApprove(x) {
      if (await run(() => rpc('return_offcut_action', { p_ret: x.id, p_action: 'APPROVE', p_comments: null }), 'Approved — Stores can receive')) await this.load();
    },
    async fmBack(x) {
      const v = await ask({ title: 'Send back ' + x.return_no, fields: [{ k: 'c', label: 'What should change?', type: 'textarea', required: true }], okText: 'Send back', danger: true });
      if (v && await run(() => rpc('return_offcut_action', { p_ret: x.id, p_action: 'SEND_BACK', p_comments: v.c }), 'Sent back to the In-charge')) await this.load();
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
    <div class="site-tabs floor-tabs">
      <a :class="{on: tab==='new'}" @click="tab='new'">➕<br>Request</a>
      <a v-if="canReturn" :class="{on: tab==='ret'}" @click="tab='ret'">↩<br>Return</a>
      <a :class="{on: tab==='mine'}" @click="tab='mine'">📋<br>Mine</a>
      <a v-if="isPI || isFM" :class="{on: tab==='ok'}" @click="tab='ok'">✔<br>Approve <span class="badge" v-if="approvals">{{ approvals }}</span></a>
      <a :class="{on: tab==='rcv'}" @click="tab='rcv'">📦<br>Receive <span class="badge" v-if="toReceive">{{ toReceive }}</span></a>
    </div>

    <!-- ===== return to store ===== -->
    <template v-if="tab==='ret' && !rt">
      <input v-model="iq" placeholder="Search issue slip, project or request…" class="site-search">
      <div v-if="!shownIssues.length" class="card empty">{{ loading ? 'Loading…' : 'No issues with material left to return (last 120 days)' }}</div>
      <div v-for="i in shownIssues" :key="i.id" class="site-card" @click="startReturn(i)">
        <div class="row"><b>{{ i.issue_no }}</b>&nbsp;<span class="muted small">{{ i.projects?.code || i.cost_centers?.code }}{{ i.material_requests ? ' · ' + i.material_requests.mr_no : '' }} · {{ dt(i.issue_date) }}</span></div>
        <div class="small muted">{{ i.issue_lines.filter(l => Number(l.qty) > Number(l.returned_qty)).map(l => itemName(l.item_id).split(' — ')[0]).join(', ') }}</div>
      </div>
    </template>
    <template v-if="tab==='ret' && rt">
      <div class="row" style="margin:6px 0"><button class="btn sm" @click="rt = null">← Issues</button><b style="margin-left:6px">Return against {{ rt.issue.issue_no }}</b></div>
      <div v-for="l in rt.lines" :key="l.issue_line_id" class="site-card floor-line">
        <div><b>{{ itemName(l.item_id) }}</b><div class="small muted">{{ qty(l.bal) }} {{ uom(l.item_id) }} can come back{{ usedOf(l) ? ' · entered ' + qty(usedOf(l)) : '' }}</div></div>
        <div class="row floor-qty">
          <span class="small" style="width:52px">Whole</span>
          <input type="number" step="any" min="0" v-model.number="l.qty" placeholder="0">
          <select v-model="l.condition" style="flex:1;min-width:110px;padding:8px"><option value="GOOD">Good</option><option value="DAMAGED">Damaged</option></select>
        </div>
        <input v-if="l.condition==='DAMAGED'" v-model="l.reason" placeholder="What is damaged?" class="floor-note" style="width:100%;margin-top:6px">
        <div v-for="(o, k) in rt.offcuts.filter(o => o.issue_line_id === l.issue_line_id)" :key="k" class="row small floor-oc">
          <span style="flex:1">✂ {{ sizeText(o) }} = {{ qty(o.qty) }} {{ uom(l.item_id) }}<span v-if="o.offcut_action"> · {{ o.offcut_action === 'KEEP' ? 'keep' : 'scrap' }}</span></span>
          <button class="btn sm bad" @click="rt.offcuts.splice(rt.offcuts.indexOf(o), 1)">✕</button>
        </div>
        <button v-if="sheet(l.item_id)" class="btn sm" style="margin-top:6px" @click="addOffcut(l)">✂ Add offcut piece</button>
      </div>
      <label class="f"><span>Returned by</span><input v-model="rt.by"></label>
      <textarea v-model="rt.remarks" placeholder="Remarks (optional)" style="width:100%;margin:6px 0 8px"></textarea>
      <div class="small muted" v-if="rt.offcuts.length" style="margin-bottom:6px">Offcuts go to the Production In-charge (keep / scrap) and the Factory Manager before Stores receives them.</div>
      <button class="btn primary" style="width:100%;justify-content:center;padding:12px" :disabled="busy" @click="sendReturn">↩ Send return</button>
    </template>

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

    <!-- ===== my requests & returns ===== -->
    <template v-if="tab==='mine'">
      <template v-if="myReturns.length">
        <h4 style="margin:4px 0 6px">My returns</h4>
        <div v-for="x in myReturns.slice(0, 10)" :key="x.id" class="site-card" @click="go('d/ret/' + x.id)">
          <div class="row"><b>{{ x.return_no }}</b>&nbsp;<span class="muted small">{{ x.material_issues?.issue_no }} · {{ dt(x.return_date) }}</span><span class="spacer"></span><Badge :v="x.status" /></div>
          <div class="small muted">{{ x.return_lines.filter(l => l.condition !== 'OFFCUT').length }} item(s){{ ocLines(x).length ? ' · ' + ocLines(x).length + ' offcut line(s)' : '' }}</div>
        </div>
        <h4 style="margin:10px 0 6px">My requests</h4>
      </template>
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
      <div v-if="!approvals" class="card empty">Nothing waiting for approval 🎉</div>
      <!-- offcuts: In-charge decides keep / scrap -->
      <div v-for="x in ocPI" :key="x.id" class="site-card" style="cursor:default;border-color:#fde68a">
        <div class="row"><b>✂ {{ x.return_no }}</b>&nbsp;<span class="muted small">{{ x.material_issues?.issue_no }} · {{ x.returned_by_name }}</span><span class="spacer"></span><Badge :v="x.status" /></div>
        <div v-if="x.offcut_comments" class="small" style="color:#b45309">FM: {{ x.offcut_comments }}</div>
        <div v-for="l in ocLines(x)" :key="l.id" class="row small" style="margin-top:6px;gap:6px">
          <span style="flex:1">{{ itemName(l.item_id).split(' — ')[0] }} {{ sizeText(l) }}</span>
          <a href="javascript:void 0" class="chip" :class="{on: l._act==='KEEP'}" @click="l._act='KEEP'">Keep</a>
          <a href="javascript:void 0" class="chip" :class="{on: l._act==='SCRAP'}" @click="l._act='SCRAP'">Scrap</a>
        </div>
        <input v-model="x._c" placeholder="Comment for the FM (optional)" class="floor-note" style="width:100%;margin-top:8px">
        <button class="btn primary" style="margin-top:8px" @click="propose(x)">Send to Factory Manager</button>
      </div>
      <!-- offcuts: Factory Manager approves -->
      <div v-for="x in ocFM" :key="x.id" class="site-card" style="cursor:default;border-color:#fde68a">
        <div class="row"><b>✂ {{ x.return_no }}</b>&nbsp;<span class="muted small">{{ x.material_issues?.issue_no }} · {{ x.material_issues?.projects?.code || x.material_issues?.cost_centers?.code }}</span></div>
        <div v-for="l in ocLines(x)" :key="l.id" class="row small" style="margin-top:4px">
          <span style="flex:1">{{ itemName(l.item_id).split(' — ')[0] }} {{ sizeText(l) }}</span><Badge :v="l.offcut_action" />
        </div>
        <div v-if="x.offcut_comments" class="small muted" style="margin-top:4px">In-charge: {{ x.offcut_comments }}</div>
        <div class="site-actions" style="margin-top:8px">
          <button class="btn ok" @click="fmApprove(x)">✔ Approve</button>
          <button class="btn bad" @click="fmBack(x)">↩ Send back</button>
        </div>
      </div>
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
  setup() { return { go, sizeText }; },
};
