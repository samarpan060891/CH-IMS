// Site app: phone-first screen for site supervisors — deliveries to confirm, units (status, handover, log work),
// snags with camera photos. Uses the same server functions as the full screens.
import { sb, state, must, run, rpc, hasRole, today, num, qty, dt, label, loadRef, toast, go } from './lib.js';
import { ask, confirmBox, Badge } from './components.js';
import { addSnagPhotos, pickPhotos, snagFixDialog, snagVerifyDialog, SnagPhotos } from './projects.js';

const KEY = 'cc.site.project';
const STATUS_NEXT = [{ v: 'IN_PROGRESS', l: 'In progress' }, { v: 'INSTALLED', l: 'Installed' }, { v: 'SNAGGING', l: 'Snagging' }, { v: 'HANDED_OVER', l: 'Handed over' }];

export const SiteApp = {
  components: { Badge, SnagPhotos },
  data: () => ({ projects: [], projectId: '', tab: 'units', loading: false, deliveries: [], units: [], snags: [], unit: null, unitLines: [], q: '',
                 work: null, openSnag: null }),
  computed: {
    shownUnits() { const q = this.q.trim().toLowerCase(); return this.units.filter(u => !q || `${u.unit_code} ${u.unit_type || ''} ${u.building || ''}`.toLowerCase().includes(q)); },
    openSnags() { return this.snags.filter(s => ['OPEN', 'FIXED'].includes(s.status)); },
    canVerify() { return hasRole('production_incharge', 'factory_manager'); },
    grades() { return (state.refs.labour_grades || []).filter(g => g.is_active); },
  },
  async mounted() {
    await run(async () => {
      await loadRef('labour_grades');
      this.projects = must(await sb.from('projects').select('id,code,name').eq('status', 'OPEN').eq('project_type', 'PROJECT').order('code'));
      let saved = ''; try { saved = localStorage.getItem(KEY) || ''; } catch { /* storage unavailable */ }
      this.projectId = this.projects.some(p => p.id === saved) ? saved : (this.projects[0]?.id || '');
    });
    await this.load();
  },
  watch: { projectId(v) { try { localStorage.setItem(KEY, v); } catch { /* storage unavailable */ } this.unit = null; this.load(); } },
  methods: {
    qty, dt, label, num,
    async load() {
      if (!this.projectId) return;
      this.loading = true;
      await run(async () => {
        const [d, u, s] = await Promise.all([
          sb.from('dispatch_notes').select('id,dispatch_no,dispatch_date,status,vehicle_no,driver_name,driver_phone,delivery_address,dispatch_lines(qty,items(code,name))')
            .eq('project_id', this.projectId).in('status', ['POSTED', 'DELIVERED']).order('dispatch_date', { ascending: false }).limit(30),
          sb.from('v_unit_progress').select('*').eq('project_id', this.projectId).order('unit_code'),
          sb.from('v_snags').select('*').eq('project_id', this.projectId).in('status', ['OPEN', 'FIXED']).order('snag_date')]);
        this.deliveries = must(d); this.units = must(u); this.snags = must(s);
      });
      this.loading = false;
    },
    snagsOf(u) { return this.snags.filter(s => s.unit_id === u.unit_id).length; },
    // ---------- deliveries ----------
    async confirm(d) {
      const v = await ask({ title: 'Received ' + d.dispatch_no, fields: [{ k: 'n', label: 'Received by (name)', required: true, default: state.profile?.full_name || '' }], okText: 'Confirm received' });
      if (!v) return;
      if (await run(() => rpc('dispatch_delivered', { p_id: d.id, p_received_by: v.n }), 'Delivery confirmed')) await this.load();
    },
    // ---------- units ----------
    async openUnit(u) {
      this.unit = u;
      await run(async () => {
        const alloc = must(await sb.from('boq_line_units').select('qty,boq_line_id,boq_lines(boq_ref,description,uom,category)').eq('unit_id', u.unit_id));
        const done = must(await sb.from('install_log_lines').select('boq_line_id,qty,install_logs!inner(status)').eq('unit_id', u.unit_id).eq('install_logs.status', 'POSTED'));
        this.unitLines = alloc.map(a => {
          const inst = done.filter(x => x.boq_line_id === a.boq_line_id).reduce((t, x) => t + num(x.qty), 0);
          return { boq_line_id: a.boq_line_id, ref: a.boq_lines?.boq_ref, desc: a.boq_lines?.description, uom: a.boq_lines?.uom, alloc: num(a.qty), inst, left: Math.max(0, num(a.qty) - inst) };
        });
      });
    },
    async setStatus(u) {
      const v = await ask({ title: 'Unit ' + u.unit_code, fields: [{ k: 's', label: 'Status', type: 'select', required: true, options: STATUS_NEXT, default: u.status === 'NOT_STARTED' ? 'IN_PROGRESS' : u.status },
        { k: 'h', label: 'Handed over to (client representative)' }, { k: 'r', label: 'Remarks', type: 'textarea' }], okText: 'Update' });
      if (!v) return;
      if (await run(() => rpc('unit_set_status', { p_unit: u.unit_id, p_status: v.s, p_handed_to: v.h || null, p_remarks: v.r || null }), 'Unit updated')) {
        await this.load(); this.unit = this.units.find(x => x.unit_id === u.unit_id) || null;
      }
    },
    startWork() {
      this.work = { date: today(), leader: state.profile?.full_name || '', crew: [{ grade_id: this.grades[0]?.id || null, workers: 1, hours: 8, ot: 0 }],
        lines: this.unitLines.filter(l => l.left > 0).map(l => ({ ...l, qty: null })), notes: '' };
    },
    async saveWork() {
      const w = this.work, u = this.unit;
      const lines = w.lines.filter(l => num(l.qty) > 0);
      for (const l of lines) if (num(l.qty) > l.left + 0.0005) return toast(`${l.desc}: only ${qty(l.left)} left to install in ${u.unit_code}`, 'error');
      const crew = w.crew.filter(c => c.grade_id && num(c.workers) > 0 && num(c.hours) + num(c.ot) > 0);
      if (!lines.length && !crew.length) return toast('Enter the quantities installed and / or the crew', 'error');
      const ok = await run(async () => {
        const h = must(await sb.from('install_logs').insert({ project_id: this.projectId, log_date: w.date, team_leader: w.leader || null, notes: w.notes || null }).select('id').single());
        if (crew.length) must(await sb.from('install_log_crew').insert(crew.map(c => ({ log_id: h.id, grade_id: c.grade_id, workers: num(c.workers), hours: num(c.hours), ot_hours: num(c.ot) }))));
        if (lines.length) must(await sb.from('install_log_lines').insert(lines.map((l, i) => ({ log_id: h.id, line_no: i + 1, boq_line_id: l.boq_line_id, unit_id: u.unit_id, qty: num(l.qty) }))));
        await rpc('post_install_log', { p_log: h.id });
      }, 'Work logged');
      if (ok) { this.work = null; await this.load(); const nu = this.units.find(x => x.unit_id === u.unit_id); if (nu) await this.openUnit(nu); }
    },
    // ---------- snags ----------
    async raiseSnag(u) {
      const v = await ask({ title: 'New snag' + (u ? ' — ' + u.unit_code : ''), message: 'You can take photos right after saving.',
        fields: [{ k: 'd', label: 'What is wrong', type: 'textarea', required: true }, { k: 'l', label: 'Where (kitchen, master wardrobe …)' },
          { k: 'c', label: 'Category', type: 'select', required: true, default: 'FINISH', options: ['FINISH', 'DAMAGE', 'ALIGNMENT', 'MISSING', 'HARDWARE', 'GAP_SEALANT', 'OTHER'] },
          { k: 's', label: 'Severity', type: 'select', required: true, default: 'MINOR', options: ['MINOR', 'MAJOR', 'CRITICAL'] },
          { k: 'r', label: 'Raised by', type: 'select', required: true, default: 'INTERNAL', options: [{ v: 'INTERNAL', l: 'Our inspection' }, { v: 'CLIENT', l: 'Client' }, { v: 'CONSULTANT', l: 'Consultant' }] },
          { k: 'due', label: 'Fix by', type: 'date' }], okText: 'Save snag' });
      if (!v) return;
      const s = await run(async () => must(await sb.from('snags').insert({ project_id: this.projectId, unit_id: u?.unit_id || null, description: v.d, location_text: v.l || null,
        category: v.c, severity: v.s, raised_by_party: v.r, due_date: v.due || null }).select('*').single()));
      if (!s) return;
      if (await confirmBox('Snag ' + s.snag_no + ' saved', 'Take photos of the snag now?')) {
        const files = await pickPhotos();
        if (files.length) await run(() => addSnagPhotos(s, 'BEFORE', files), 'Photos added');
      }
      await this.load();
    },
    async fix(s) {
      if (!(await run(() => snagFixDialog(s)))) return;
      toast('Marked fixed — sent for verification', 'ok');
      if (await confirmBox('After-fix photo', 'Take a photo of the fixed work now?')) {
        const files = await pickPhotos();
        if (files.length) await run(() => addSnagPhotos({ ...s }, 'AFTER', files), 'Photo added');
      }
      await this.load();
    },
    async verify(s, accept) { if (await run(() => snagVerifyDialog(s, accept))) { toast(accept ? 'Snag closed' : 'Snag reopened', 'ok'); await this.load(); } },
    full(path) { go(path); },
  },
  template: `<div class="site">
    <div class="site-top">
      <select v-model="projectId" class="site-proj"><option v-for="p in projects" :value="p.id">{{ p.code }} — {{ p.name }}</option></select>
      <button class="btn sm" @click="load" :disabled="loading">↻</button>
    </div>
    <div v-if="!projects.length" class="card empty">No open projects</div>
    <div class="site-tabs">
      <a :class="{on: tab==='units'}" @click="tab='units'; unit=null">🏠 Units</a>
      <a :class="{on: tab==='snags'}" @click="tab='snags'">⚠ Snags <span class="badge" v-if="openSnags.length">{{ openSnags.length }}</span></a>
      <a :class="{on: tab==='dlv'}" @click="tab='dlv'">🚚 Deliveries <span class="badge" v-if="deliveries.filter(d=>d.status==='POSTED').length">{{ deliveries.filter(d=>d.status==='POSTED').length }}</span></a>
    </div>

    <!-- ===== units ===== -->
    <template v-if="tab==='units' && !unit">
      <input v-model="q" placeholder="Search unit…" class="site-search">
      <div v-if="!shownUnits.length" class="card empty">{{ loading ? 'Loading…' : 'No units in this project' }}</div>
      <div v-for="u in shownUnits" :key="u.unit_id" class="site-card" @click="openUnit(u)">
        <div class="row"><b style="font-size:16px">{{ u.unit_code }}</b><span class="muted small">{{ u.unit_type }}{{ u.building ? ' · ' + u.building : '' }}{{ u.floor ? ' · F' + u.floor : '' }}</span>
          <span class="spacer"></span><Badge :v="u.status" /></div>
        <div class="site-bar"><div :style="{width: Math.min(u.progress_pct,100)+'%'}"></div></div>
        <div class="small muted">{{ u.progress_pct }}% · {{ u.lines_done }}/{{ u.boq_lines }} items done<span v-if="snagsOf(u)" style="color:#b91c1c"> · {{ snagsOf(u) }} open snag(s)</span></div>
      </div>
    </template>
    <template v-if="tab==='units' && unit && !work">
      <div class="row" style="margin:6px 0"><button class="btn sm" @click="unit=null">← Units</button><b style="font-size:17px;margin-left:6px">{{ unit.unit_code }}</b>
        <span class="spacer"></span><Badge :v="unit.status" /></div>
      <div class="site-actions">
        <button class="btn primary" @click="startWork" :disabled="!unitLines.some(l=>l.left>0)">🔧 Log work</button>
        <button class="btn" @click="raiseSnag(unit)">⚠ Raise snag</button>
        <button class="btn" @click="setStatus(unit)">🏁 Status / handover</button>
      </div>
      <div class="site-card" v-for="l in unitLines" :key="l.boq_line_id">
        <div class="row"><b>{{ l.ref }}</b>&nbsp;{{ l.desc }}<span class="spacer"></span><span :style="l.left ? '' : 'color:#15803d;font-weight:600'">{{ l.left ? qty(l.inst) + ' / ' + qty(l.alloc) : '✔ done' }}</span></div>
      </div>
      <div v-if="!unitLines.length" class="card empty">No BOQ lines attached to this unit</div>
      <h4 style="margin:12px 0 6px" v-if="snags.some(s=>s.unit_id===unit.unit_id)">Open snags</h4>
      <div class="site-card" v-for="s in snags.filter(s=>s.unit_id===unit.unit_id)" :key="s.id">
        <div class="row"><b>{{ s.snag_no }}</b><span class="spacer"></span><Badge :v="s.status" /></div>
        <div>{{ s.description }}</div>
      </div>
    </template>

    <!-- ===== log work for a unit ===== -->
    <div v-if="tab==='units' && unit && work" class="card">
      <div class="row"><button class="btn sm" @click="work=null">← Back</button><b style="margin-left:6px">Log work — {{ unit.unit_code }}</b></div>
      <label class="f"><span>Date</span><input type="date" v-model="work.date"></label>
      <label class="f"><span>Team leader / subcontractor</span><input v-model="work.leader"></label>
      <h4 style="margin:10px 0 4px">Installed today</h4>
      <div v-for="l in work.lines" :key="l.boq_line_id" class="row" style="gap:8px;margin-bottom:6px">
        <div style="flex:1"><b>{{ l.ref }}</b> {{ l.desc }}<div class="small muted">{{ qty(l.left) }} {{ l.uom }} left</div></div>
        <input type="number" step="any" min="0" v-model.number="l.qty" placeholder="0" style="width:84px">
      </div>
      <h4 style="margin:10px 0 4px">Own crew (leave empty for subcontractor work)</h4>
      <div v-for="(c, i) in work.crew" :key="i" class="site-crew">
        <select v-model="c.grade_id"><option :value="null">— grade —</option><option v-for="g in grades" :value="g.id">{{ g.name }}</option></select>
        <input type="number" min="1" v-model.number="c.workers" title="Workers"><span class="small">×</span>
        <input type="number" min="0" step="0.5" v-model.number="c.hours" title="Normal hours"><span class="small">h</span>
        <input type="number" min="0" step="0.5" v-model.number="c.ot" title="Overtime hours"><span class="small">OT</span>
        <button class="btn sm bad" @click="work.crew.splice(i,1)">✕</button>
      </div>
      <button class="btn sm" @click="work.crew.push({ grade_id: null, workers: 1, hours: 8, ot: 0 })">+ Grade</button>
      <label class="f" style="margin-top:8px"><span>Notes / issues</span><textarea v-model="work.notes"></textarea></label>
      <button class="btn primary" style="width:100%;justify-content:center;margin-top:10px" @click="saveWork">Save & post</button>
    </div>

    <!-- ===== snags ===== -->
    <template v-if="tab==='snags'">
      <button class="btn primary" style="width:100%;justify-content:center;margin-bottom:8px" @click="raiseSnag(null)">⚠ Raise snag (no unit)</button>
      <div v-if="!openSnags.length" class="card empty">No open snags 🎉</div>
      <div v-for="s in openSnags" :key="s.id" class="site-card">
        <div class="row"><b>{{ s.snag_no }}</b>&nbsp;<span class="muted small">{{ s.unit_code || 'No unit' }}{{ s.location_text ? ' · ' + s.location_text : '' }}</span>
          <span class="spacer"></span><Badge :v="s.severity" /> <Badge :v="s.status" /></div>
        <div style="margin:4px 0">{{ s.description }}</div>
        <div class="small" :style="s.is_overdue ? 'color:#b91c1c;font-weight:600' : 'color:var(--muted)'">{{ s.due_date ? 'Fix by ' + dt(s.due_date) : 'No due date' }} · {{ s.age_days }} days old{{ s.reopen_count ? ' · reopened ' + s.reopen_count + '×' : '' }}</div>
        <div v-if="openSnag===s.id" style="margin-top:6px"><SnagPhotos :snag="s" compact /></div>
        <div class="site-actions" style="margin-top:6px">
          <button class="btn sm" @click="openSnag = openSnag===s.id ? null : s.id">📷 Photos ({{ s.photos }})</button>
          <button class="btn sm" v-if="s.status==='OPEN'" @click="pickPhotos().then(f => f.length && run(() => addSnagPhotos(s, 'BEFORE', f), 'Photos added').then(load))">+ Photo</button>
          <button class="btn sm primary" v-if="s.status==='OPEN'" @click="fix(s)">🔧 Fixed</button>
          <template v-if="s.status==='FIXED' && canVerify"><button class="btn sm ok" @click="verify(s, true)">✔ Accept</button><button class="btn sm bad" @click="verify(s, false)">↺ Reopen</button></template>
          <span v-if="s.status==='FIXED' && !canVerify" class="small muted">Waiting for verification</span>
          <button class="btn sm" @click="full('d/snag/' + s.id)">Details</button>
        </div>
      </div>
    </template>

    <!-- ===== deliveries ===== -->
    <template v-if="tab==='dlv'">
      <div v-if="!deliveries.length" class="card empty">No deliveries</div>
      <div v-for="d in deliveries" :key="d.id" class="site-card">
        <div class="row"><b>{{ d.dispatch_no }}</b>&nbsp;<span class="small muted">{{ dt(d.dispatch_date) }}</span><span class="spacer"></span><Badge :v="d.status" /></div>
        <div class="small muted">{{ [d.vehicle_no, d.driver_name, d.driver_phone].filter(Boolean).join(' · ') }}</div>
        <div v-for="l in d.dispatch_lines" class="small">• {{ qty(l.qty) }} × {{ l.items?.code }} {{ l.items?.name }}</div>
        <button v-if="d.status==='POSTED'" class="btn primary" style="width:100%;justify-content:center;margin-top:8px" @click="confirm(d)">✔ Confirm received</button>
      </div>
    </template>
  </div>`,
};
// helpers used directly from the template
SiteApp.methods.pickPhotos = pickPhotos;
SiteApp.methods.addSnagPhotos = addSnagPhotos;
SiteApp.methods.run = run;
