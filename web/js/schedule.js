// Factory schedule: every open production order sequenced through the work centres with the capacity rules of the
// batch planner — hours per day × planning %, machines / people per work centre, operators per machine, setup (already
// in the order's planned hours), wait after each stage, weekly off day and public holidays.
// Sequence: URGENT first, then the earliest due date (no due date last), then order number. Stages already running hold
// their work centre from today; the rest follow route order, each starting when the order has left the previous stage
// (plus its wait) at the first time the work centre is free long enough — orders ahead in the sequence book first, a
// later order can use a gap between them but never delays them.
import { sb, state, must, run, num, qty, dt, today, refRow, loadRefs, go, label } from './lib.js';
import { Badge } from './components.js';

export const OPEN_WO = ['PENDING_FM', 'APPROVED', 'RELEASED', 'IN_PROGRESS'];

// ---------- working-day calendar ----------
export const weekOff = () => state.company?.plan_week_off?.length ? state.company.plan_week_off : [0];
let HOLIDAYS = new Set();
export const setHolidays = dates => { HOLIDAYS = new Set(dates); };
export const isoDate = d => d.toISOString().slice(0, 10);
export const parseIso = s => new Date(s + 'T00:00:00Z');
const isOff = d => weekOff().includes(d.getUTCDay()) || HOLIDAYS.has(isoDate(d));
export function workday(s) { const d = parseIso(s); while (isOff(d)) d.setUTCDate(d.getUTCDate() + 1); return isoDate(d); }
export function addWorkdays(s, n) {
  const d = parseIso(workday(s));
  for (let i = 0; i < n; i++) { d.setUTCDate(d.getUTCDate() + 1); while (isOff(d)) d.setUTCDate(d.getUTCDate() + 1); }
  return isoDate(d);
}
// working days from a to b (negative when b is before a)
export function workdaysBetween(a, b) {
  if (a === b) return 0;
  const sign = b > a ? 1 : -1, d = parseIso(sign > 0 ? a : b), end = sign > 0 ? b : a;
  let n = 0;
  while (isoDate(d) < end && n < 2000) { d.setUTCDate(d.getUTCDate() + 1); if (!isOff(d)) n++; }
  return sign * n;
}

// ---------- capacity ----------
export const perDay = () => { const c = state.company || {}; return num(c.plan_hours_per_day || 8) * num(c.plan_efficiency_pct || 85) / 100; };
// people working together at one machine while it runs (operator + helper = 2); 1 for manual stages
export const wcOps = id => { const w = refRow('work_centers', id); return w?.kind === 'MACHINE' ? Math.max(1, num(w.operators) || 1) : 1; };
// hours a stage occupies its work centre: the machine run, or the man-hours shared by the operators at it
export const stageHours = (wcId, mh, lh) => Math.max(num(mh), num(lh) / wcOps(wcId));
// work-centre hours per day: machines in parallel / people
export const capOf = wcId => perDay() * Math.max(1, num(refRow('work_centers', wcId)?.crew_size) || 1);

// ---------- open work ----------
export async function loadOpenWork() {
  await loadRefs(['work_centers', 'projects', 'items']);
  const orders = must(await sb.from('production_orders').select('id,wo_no,description,qty,qty_completed,status,priority,due_date,project_id,item_id,is_rework,batch_label,boq_line_id')
    .in('status', OPEN_WO).order('wo_no'));
  const ids = orders.map(o => o.id);
  const ops = ids.length ? must(await sb.from('wo_operations').select('id,wo_id,seq,work_center_id,planned_labour_hours,planned_machine_hours,wait_days,status,qty_done')
    .in('wo_id', ids).order('seq')) : [];
  const holidays = must(await sb.from('public_holidays').select('holiday_date,name,confirmed').order('holiday_date'));
  setHolidays(holidays.map(h => h.holiday_date));
  return { orders, ops, holidays };
}
// orders → schedule jobs with the hours still to do on each stage
export function jobsFrom(orders, ops) {
  const by = {};
  ops.forEach(o => { (by[o.wo_id] ||= []).push(o); });
  return orders.map(w => ({
    id: w.id, wo: w, priority: w.priority, due_date: w.due_date, rank: w.wo_no,
    ops: (by[w.id] || []).filter(o => ['PENDING', 'IN_PROGRESS'].includes(o.status)).map(o => {
      const f = o.status === 'IN_PROGRESS' ? Math.max(0, 1 - num(o.qty_done) / (num(w.qty) || 1)) : 1;
      return { id: o.id, seq: num(o.seq), wc: o.work_center_id, status: o.status, wait: num(o.wait_days),
               h: stageHours(o.work_center_id, num(o.planned_machine_hours) * f, num(o.planned_labour_hours) * f) };
    }),
  }));
}

const cmp = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };
export const seqKey = j => [j.priority === 'URGENT' ? 0 : 1, j.due_date || '9999-12-31', j.rank || ''];

// times are in working days from the start date (0 = start of the first working day)
export function schedule(jobs, startIso = today()) {
  const busy = {}, res = new Map();
  // book the earliest free slot of the work centre from `ready` that is long enough (a later order may use a gap
  // left by the orders ahead of it, without delaying them)
  const book = (wc, ready, d) => {
    const ivs = (busy[wc] ||= []);
    let t = ready;
    for (const iv of ivs) { if (t + d <= iv.start + 1e-9) break; if (iv.end > t) t = iv.end; }
    ivs.push({ start: t, end: t + d }); ivs.sort((a, b) => a.start - b.start);
    return t;
  };
  const sorted = [...jobs].sort((a, b) => cmp(seqKey(a), seqKey(b)));
  // stages already running keep their work centre from today
  for (const j of sorted) {
    const r = { job: j, stages: [], t: 0 };
    res.set(j.id, r);
    for (const s of j.ops.filter(s => s.status === 'IN_PROGRESS')) {
      const d = s.h / capOf(s.wc), st = book(s.wc, 0, d);
      r.stages.push({ ...s, start: st, end: st + d }); r.t = Math.max(r.t, st + d + s.wait);
    }
  }
  // the rest in route order, order by order in sequence
  for (const j of sorted) {
    const r = res.get(j.id);
    for (const s of [...j.ops].sort((a, b) => a.seq - b.seq)) {
      if (s.status !== 'PENDING') continue;
      const d = s.h / capOf(s.wc), st = book(s.wc, r.t, d);
      r.stages.push({ ...s, start: st, end: st + d }); r.t = st + d + s.wait;
    }
    r.stages.sort((a, b) => a.seq - b.seq);
    r.days = Math.ceil(r.t - 1e-9);
    r.date = r.stages.length ? addWorkdays(startIso, Math.max(r.days - 1, 0)) : null;
    r.slack = j.due_date && r.date ? workdaysBetween(r.date, j.due_date) : null;
    r.flag = !r.date ? 'DONE' : !j.due_date ? 'NO_DUE' : r.date > j.due_date ? 'LATE' : r.slack < 2 ? 'TIGHT' : 'OK';
  }
  return { sorted, res, start: startIso };
}
export const dateAt = (startIso, t) => addWorkdays(startIso, Math.floor(t + 1e-9));
export const FLAG = { LATE: { t: '🔴 Late', c: 'OVERDUE' }, TIGHT: { t: '🟠 Tight', c: 'WARNING' }, OK: { t: '🟢 On time', c: 'OK' }, NO_DUE: { t: 'No due date', c: 'DRAFT' }, DONE: { t: 'Stages done', c: 'COMPLETED' } };

// ======================================================================
// FACTORY SCHEDULE page
// ======================================================================
const WEEKS = 8;
export const FactorySchedule = {
  components: { Badge },
  data: () => ({ loading: true, data: null, sch: null, proj: '', flag: '', openId: null, startDate: today() }),
  computed: {
    rows() {
      if (!this.sch) return [];
      return this.sch.sorted.map((j, i) => ({ n: i + 1, j, r: this.sch.res.get(j.id) }))
        .filter(x => (!this.proj || x.j.wo.project_id === this.proj) && (!this.flag || x.r.flag === this.flag));
    },
    counts() {
      const c = { LATE: 0, TIGHT: 0, OK: 0, NO_DUE: 0 };
      this.sch?.sorted.forEach(j => { const f = this.sch.res.get(j.id).flag; if (c[f] !== undefined) c[f]++; });
      return c;
    },
    projects() { const ids = new Set((this.data?.orders || []).map(o => o.project_id)); return (state.refs.projects || []).filter(p => ids.has(p.id)); },
    // utilisation per work centre per week (Mon–Sat) for the next weeks
    weeks() {
      if (!this.sch) return [];
      const s = parseIso(workday(this.startDate || today())), mon = new Date(s); mon.setUTCDate(s.getUTCDate() - ((s.getUTCDay() + 6) % 7));
      return Array.from({ length: WEEKS }, (_, i) => { const d = new Date(mon); d.setUTCDate(mon.getUTCDate() + 7 * i); return isoDate(d); });
    },
    load() {
      if (!this.sch) return [];
      const start = this.sch.start, weekOf = iso => { const d = parseIso(iso); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return isoDate(d); };
      const days = {}, by = {};
      const dayDate = i => (days[i] ||= addWorkdays(start, i));
      for (const r of this.sch.res.values()) for (const s of r.stages) {
        for (let i = Math.floor(s.start); i < Math.ceil(s.end - 1e-9) && i < 400; i++) {
          const ov = Math.min(s.end, i + 1) - Math.max(s.start, i);
          if (ov <= 0) continue;
          const w = weekOf(dayDate(i)); const m = (by[s.wc] ||= { busy: {}, total: 0 });
          m.busy[w] = (m.busy[w] || 0) + ov; m.total += ov;
        }
      }
      // working days in each week (holidays and the off day excluded)
      const wd = Object.fromEntries(this.weeks.map(w => { let n = 0; const d = parseIso(w); for (let k = 0; k < 7; k++) { if (!isOff(d)) n++; d.setUTCDate(d.getUTCDate() + 1); } return [w, n]; }));
      return Object.entries(by).map(([wc, m]) => ({ wc, w: refRow('work_centers', wc), total: m.total,
          cells: this.weeks.map(w => (wd[w] ? Math.round(100 * (m.busy[w] || 0) / wd[w]) : null)) }))
        .sort((a, b) => num(a.w?.sort_order) - num(b.w?.sort_order));
    },
    neck() { return this.load.reduce((a, x) => (!a || x.total > a.total ? x : a), null); },
  },
  async mounted() { await this.reload(); },
  methods: {
    qty, dt, label, num,
    async reload() {
      this.loading = true;
      await run(async () => { this.data = await loadOpenWork(); this.plan(); });
      this.loading = false;
    },
    plan() { if (this.data) this.sch = schedule(jobsFrom(this.data.orders, this.data.ops), this.startDate || today()); },
    at(t) { return dt(dateAt(this.sch.start, t)); },
    endAt(t) { return dt(addWorkdays(this.sch.start, Math.max(Math.ceil(t - 1e-9) - 1, 0))); },
    wcName(id) { return refRow('work_centers', id)?.name || ''; },
    projCode(id) { return refRow('projects', id)?.code || ''; },
    itemName(id) { const i = refRow('items', id); return i ? `${i.code} — ${i.name}` : ''; },
    cur(r) { const s = r.stages.find(x => x.status === 'IN_PROGRESS') || r.stages[0]; return s ? `${s.seq} · ${this.wcName(s.wc)}` : '—'; },
    heat(p) { return p === null ? '' : p >= 95 ? 'background:#fee2e2;color:#991b1b;font-weight:600' : p >= 75 ? 'background:#fef3c7;color:#92400e' : p > 0 ? 'background:#dcfce7;color:#166534' : 'color:#9ca3af'; },
    FLAG: f => FLAG[f] || { t: f, c: '' },
    go,
  },
  template: `<div>
    <div class="row" style="gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
      <label class="small">From <input type="date" v-model="startDate" @change="plan"></label>
      <select v-model="proj" style="padding:6px"><option value="">All projects</option><option v-for="p in projects" :key="p.id" :value="p.id">{{ p.code }} — {{ p.name }}</option></select>
      <span class="spacer" style="flex:1"></span>
      <button class="btn sm" @click="reload" :disabled="loading">↻ Recalculate</button>
    </div>
    <div v-if="loading" class="card empty">Scheduling…</div>
    <template v-else-if="sch">
      <div class="kpis">
        <div class="kpi" style="cursor:pointer" @click="flag = ''"><div class="l">Open production orders</div><div class="v">{{ sch.sorted.length }}</div><div class="s">with FM, approved, released, in progress</div></div>
        <div class="kpi bad" style="cursor:pointer" @click="flag = flag === 'LATE' ? '' : 'LATE'"><div class="l">🔴 Projected late</div><div class="v">{{ counts.LATE }}</div><div class="s">finish after the due date</div></div>
        <div class="kpi warn" style="cursor:pointer" @click="flag = flag === 'TIGHT' ? '' : 'TIGHT'"><div class="l">🟠 Tight</div><div class="v">{{ counts.TIGHT }}</div><div class="s">less than 2 working days to spare</div></div>
        <div class="kpi ok" style="cursor:pointer" @click="flag = flag === 'OK' ? '' : 'OK'"><div class="l">🟢 On time</div><div class="v">{{ counts.OK }}</div><div class="s">{{ counts.NO_DUE }} without a due date</div></div>
        <div class="kpi" v-if="neck"><div class="l">Bottleneck</div><div style="font-weight:700;margin-top:4px">{{ neck.w?.name }}</div><div class="s">{{ qty(Math.round(neck.total * 10) / 10) }} working days of work queued</div></div>
      </div>
      <div class="card">
        <div class="hd"><h3>Sequence — URGENT first, then earliest due date</h3><span class="spacer" style="flex:1"></span>
          <span class="small muted" v-if="flag">showing {{ FLAG(flag).t }} · <a href="javascript:void 0" @click="flag = ''">show all</a></span></div>
        <div class="tbl-wrap"><table class="t">
          <thead><tr><th class="n">#</th><th>Order</th><th>Project</th><th>Product</th><th class="n">Qty</th><th>Status</th><th>Due</th><th>Projected finish</th><th class="n">Spare days</th><th>Flag</th><th>Next stage</th></tr></thead>
          <tbody>
            <tr v-if="!rows.length"><td colspan="11" class="empty">No open production orders</td></tr>
            <template v-for="x in rows" :key="x.j.id">
              <tr style="cursor:pointer" @click="openId = openId === x.j.id ? null : x.j.id">
                <td class="n">{{ x.n }}</td>
                <td><a href="javascript:void 0" @click.stop="go('d/wo/' + x.j.id)"><b>{{ x.j.wo.wo_no }}</b></a><Badge v-if="x.j.priority === 'URGENT'" v="URGENT" style="margin-left:4px" />
                  <div class="small muted">{{ x.j.wo.batch_label || (x.j.wo.is_rework ? 'Rework' : '') }}</div></td>
                <td>{{ projCode(x.j.wo.project_id) }}</td>
                <td>{{ x.j.wo.description || itemName(x.j.wo.item_id) }}</td>
                <td class="n">{{ qty(x.j.wo.qty) }}</td>
                <td><Badge :v="x.j.wo.status" /></td>
                <td>{{ dt(x.j.due_date) || '—' }}</td>
                <td><b>{{ dt(x.r.date) || '—' }}</b><div class="small muted" v-if="x.r.date">working day {{ x.r.days }}</div></td>
                <td class="n" :style="x.r.slack !== null && x.r.slack < 0 ? 'color:#b91c1c;font-weight:600' : ''">{{ x.r.slack === null ? '' : x.r.slack }}</td>
                <td><span class="b" :class="FLAG(x.r.flag).c">{{ FLAG(x.r.flag).t }}</span></td>
                <td class="small">{{ cur(x.r) }}<div class="muted" v-if="x.r.stages[0]">from {{ at(x.r.stages[0].start) }}</div></td>
              </tr>
              <tr v-if="openId === x.j.id"><td></td><td colspan="10">
                <table class="t" style="margin:4px 0"><thead><tr><th>Stage</th><th>Work centre</th><th>Status</th><th class="n">Hours left</th><th>Starts</th><th>Ends</th><th class="n">Wait after (days)</th></tr></thead>
                  <tbody><tr v-for="s in x.r.stages" :key="s.id"><td>{{ s.seq }}</td><td>{{ wcName(s.wc) }}</td><td><Badge :v="s.status" /></td><td class="n">{{ qty(Math.round(s.h * 10) / 10) }}</td>
                    <td>{{ at(s.start) }}</td><td>{{ endAt(s.end) }}</td><td class="n">{{ qty(s.wait) }}</td></tr></tbody></table>
              </td></tr>
            </template>
          </tbody>
        </table></div>
        <p class="small muted" style="margin:8px 0 0">Click a row for its stages. Finish dates are recalculated from what is still open each time this page opens — logged quantities and closed stages bring them forward,
          new urgent or earlier-due orders push others back. Draft orders are not scheduled until they are sent to the Factory Manager.</p>
      </div>
      <div class="card" v-if="load.length">
        <div class="hd"><h3>Work centre load by week (% of capacity)</h3></div>
        <div class="tbl-wrap"><table class="t">
          <thead><tr><th>Work centre</th><th class="n">Machines / people</th><th v-for="w in weeks" :key="w" class="n">w/c {{ dt(w).slice(0, 6) }}</th><th class="n">Total days</th></tr></thead>
          <tbody><tr v-for="x in load" :key="x.wc"><td>{{ x.w?.name }}</td><td class="n">{{ x.w?.crew_size || 1 }}</td>
            <td v-for="(p, i) in x.cells" :key="i" class="n" :style="heat(p)">{{ p === null ? '—' : p + '%' }}</td><td class="n">{{ qty(Math.round(x.total * 10) / 10) }}</td></tr></tbody>
        </table></div>
        <p class="small muted" style="margin:8px 0 0">Red = fully booked (95 %+, orders behind it wait), amber 75–95 %, green below 75 % (spare capacity for new or urgent orders). Capacity: {{ qty(Math.round(perDayV * 100) / 100) }} h per machine / person per day.</p>
      </div>
    </template>
  </div>`,
  setup() { return { perDayV: perDay() }; },
};
