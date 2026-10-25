// Factory schedule: every open production order sequenced through the work centres with the capacity rules of the
// batch planner — hours per day × planning %, machines / people per work centre, operators per machine, setup (already
// in the order's planned hours), wait after each stage, weekly off day and public holidays.
// Sequence: URGENT first, then the earliest due date (no due date last), then order number. Stages already running hold
// their work centre from today; the rest follow route order, each starting when the order has left the previous stage
// (plus its wait) at the first time the work centre is free long enough — orders ahead in the sequence book first, a
// later order can use a gap between them but never delays them.
import { sb, state, must, run, rpc, num, qty, dt, today, refRow, loadRefs, go, label, hasRole, toast } from './lib.js';
import { Badge, ask, confirmBox } from './components.js';

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
  const orders = must(await sb.from('production_orders').select('id,wo_no,description,qty,qty_completed,qty_rejected,status,priority,due_date,project_id,item_id,is_rework,batch_label,boq_line_id')
    .in('status', OPEN_WO).order('wo_no'));
  const ids = orders.map(o => o.id);
  const ops = ids.length ? must(await sb.from('wo_operations').select('id,wo_id,seq,work_center_id,planned_labour_hours,planned_machine_hours,wait_days,status,qty_done,run_group_id')
    .in('wo_id', ids).order('seq')) : [];
  const holidays = must(await sb.from('public_holidays').select('holiday_date,name,confirmed').order('holiday_date'));
  setHolidays(holidays.map(h => h.holiday_date));
  const runs = must(await sb.from('wo_run_groups').select('id,run_no,work_center_id,notes,nested,sheets_saved,setup_saved,status,created_at').eq('status', 'OPEN').order('created_at'));
  return { orders, ops, holidays, runs };
}
// ---------- material availability ----------
// stock usable for production: available lots in the stores (not quarantine, scrap, shop floor or FG store)
const STOCK_LOC = ['WAREHOUSE', 'ZONE'];
const FIRM_PO = ['APPROVED', 'RELEASED', 'PARTIALLY_RECEIVED'];
const PENDING_PO = ['PENDING_FM', 'PENDING_FINANCE', 'PENDING_TOP_MGMT'];
// extra: requirements of an order not saved that way yet (a draft as it is on screen) — replace its saved lines
export async function loadMaterials(orders, extra = null) {
  const ids = orders.map(o => o.id);
  const empty = { req: [], issued: {}, lots: [], po: [], pr: {} };
  if (!ids.length) return empty;
  const saved = ids.filter(id => !extra || id !== extra.wo_id);
  let req = saved.length ? must(await sb.from('wo_materials').select('wo_id,item_id,required_qty').in('wo_id', saved).gt('required_qty', 0)) : [];
  if (extra) req = [...req, ...extra.req];
  // what each order still needs: BOM × units not yet received (material for received units was consumed from WIP)
  const ord = Object.fromEntries(orders.map(o => [o.id, o]));
  req = req.map(r => { const o = ord[r.wo_id] || {}, q = num(o.qty);
    return { ...r, required_qty: q > 0 ? num(r.required_qty) * Math.max(0, q - num(o.qty_completed) - num(o.qty_rejected)) / q : num(r.required_qty) }; });
  const items = [...new Set(req.map(r => r.item_id))];
  if (!items.length) return { ...empty, req };
  const [wip, lots, sched, lines, prl] = await Promise.all([
    sb.from('v_wip_stock').select('project_id,item_id,qty').in('item_id', items),
    sb.from('v_lot_values').select('item_id,qty_on_hand,project_id').in('item_id', items).eq('lot_status', 'AVAILABLE').in('loc_type', STOCK_LOC).gt('qty_on_hand', 0),
    sb.from('v_po_schedule').select('po_line_id,delivery_date,qty,received_qty').in('item_id', items).in('po_status', [...FIRM_PO, ...PENDING_PO]),
    sb.from('po_lines').select('id,item_id,qty,received_qty,required_date,project_id,purchase_orders!inner(po_no,status,delivery_date,project_id)')
      .in('item_id', items).in('purchase_orders.status', [...FIRM_PO, ...PENDING_PO]),
    sb.from('pr_lines').select('item_id,qty,ordered_qty,purchase_requisitions!inner(status)').in('item_id', items).in('purchase_requisitions.status', ['SUBMITTED', 'PARTIAL_PO'])]);
  // the projects' common WIP: material already on the floor, shared by the project's orders
  const issued = {};
  must(wip).forEach(w => { const k = w.project_id + '|' + w.item_id; issued[k] = (issued[k] || 0) + num(w.qty); });
  // open PO quantity by delivery date: the PO delivery schedule where there is one, else the line's required / PO date
  const sch = {};
  must(sched).forEach(s => { (sch[s.po_line_id] ||= []).push(s); });
  const po = [];
  must(lines).forEach(l => {
    const h = l.purchase_orders, base = { item_id: l.item_id, project_id: l.project_id || h.project_id || null, po_no: h.po_no, firm: FIRM_PO.includes(h.status) };
    if (sch[l.id]?.length) sch[l.id].forEach(s => { const q = num(s.qty) - num(s.received_qty); if (q > 1e-9) po.push({ ...base, date: s.delivery_date, qty: q }); });
    else { const q = num(l.qty) - num(l.received_qty); if (q > 1e-9) po.push({ ...base, date: l.required_date || h.delivery_date || null, qty: q }); }
  });
  po.sort((a, b) => (a.date || '9999-12-31').localeCompare(b.date || '9999-12-31'));
  const pr = {};
  must(prl).forEach(p => { pr[p.item_id] = (pr[p.item_id] || 0) + Math.max(0, num(p.qty) - num(p.ordered_qty)); });
  return { req, issued, lots: must(lots), po, pr };
}
// share stock and open POs between the orders in schedule sequence (earlier orders first): the project's own stock,
// then free stock, then approved POs by delivery date, then POs still waiting for approval (tentative)
export const MAT = {
  READY: { t: '✅ In stock', c: 'OK' }, ON_PO: { t: '🕒 On PO in time', c: 'BLUE' }, PO_LATE: { t: '⚠ PO after start', c: 'WARNING' },
  PO_PENDING: { t: '⏳ PO awaiting approval', c: 'PENDING' }, SHORT: { t: '❌ Short', c: 'OVERDUE' }, NO_BOM: { t: 'No materials', c: 'DRAFT' },
};
export function allocate(sorted, mat, needOf) {
  const proj = {}, free = {};
  mat.lots.forEach(l => { if (l.project_id) { const k = l.project_id + '|' + l.item_id; proj[k] = (proj[k] || 0) + num(l.qty_on_hand); } else free[l.item_id] = (free[l.item_id] || 0) + num(l.qty_on_hand); });
  const po = mat.po.map(p => ({ ...p, left: p.qty })), wip = { ...mat.issued };
  const reqBy = {};
  mat.req.forEach(r => { const m = (reqBy[r.wo_id] ||= {}); m[r.item_id] = (m[r.item_id] || 0) + num(r.required_qty); });
  const out = new Map();
  for (const j of sorted) {
    const w = j.wo, need = needOf(j), lines = [];
    for (const [item, rq] of Object.entries(reqBy[j.id] || {})) {
      let n = rq;
      const take = (pool, k) => { const t = Math.min(n, pool[k] || 0); if (t > 0) { pool[k] -= t; n -= t; } return t; };
      // the project's WIP first (already on the floor), then the project's stock, then free stock
      const issued = take(wip, w.project_id + '|' + item);
      const stock = take(proj, w.project_id + '|' + item) + take(free, item);
      const fromPo = firm => {
        const used = [];
        for (const p of po) {
          if (n <= 1e-9) break;
          if (p.firm !== firm || p.item_id !== item || p.left <= 1e-9 || (p.project_id && p.project_id !== w.project_id)) continue;
          const t = Math.min(n, p.left); p.left -= t; n -= t; used.push({ po_no: p.po_no, date: p.date, qty: t });
        }
        return used;
      };
      const pos = fromPo(true), tent = fromPo(false);
      lines.push({ item, req: rq, issued, stock, pos, tent, short: n > 1e-6 ? n : 0, pr: mat.pr[item] || 0 });
    }
    const dates = lines.flatMap(l => [...l.pos, ...l.tent]).map(p => p.date);
    const matDate = dates.length ? (dates.some(d => !d) ? null : dates.reduce((a, b) => (a > b ? a : b))) : today();
    const status = !lines.length ? 'NO_BOM' : lines.some(l => l.short) ? 'SHORT' : lines.some(l => l.tent.length) ? 'PO_PENDING'
      : lines.some(l => l.pos.some(p => !p.date || (need && p.date > need))) ? 'PO_LATE' : lines.some(l => l.pos.length) ? 'ON_PO' : 'READY';
    out.set(j.id, { status, lines, need, matDate, shortItems: lines.filter(l => l.short).length });
  }
  return out;
}
// whole schedule with materials: sequence → share the materials (needed by each order's first stage) → optionally
// hold each order's start until its material arrives (orders short of material keep their unconstrained start)
export function scheduleWithMaterials(jobs, mat, startIso = today(), waitMat = false) {
  const s0 = schedule(jobs, startIso);
  const needOf = s => j => { const r = s.res.get(j.id); return r?.stages.length ? dateAt(startIso, r.stages[0].start) : null; };
  let alloc = allocate(s0.sorted, mat, needOf(s0));
  if (!waitMat) return { ...s0, alloc };
  const first = workday(startIso);
  const held = jobs.map(j => {
    const a = alloc.get(j.id), started = j.ops.some(o => o.status === 'IN_PROGRESS');
    return a && !started && a.status !== 'SHORT' && a.matDate && a.matDate > first ? { ...j, ready: Math.max(0, workdaysBetween(first, workday(a.matDate))) } : j;
  });
  const s = schedule(held, startIso);
  alloc = allocate(s.sorted, mat, needOf(s));
  return { ...s, alloc };
}

// one order's place in the factory schedule, projected finish and material position (production order screen).
// draft: { wo, ops, req } — a draft order as it is on screen, scheduled as if it were sent to the Factory Manager now;
// the result also names the open orders it would push past their due date
export async function orderOutlook(woId, draft = null) {
  const w = await loadOpenWork();
  let orders = w.orders, ops = w.ops;
  if (draft) {
    orders = [...orders.filter(o => o.id !== woId), draft.wo];
    ops = [...ops.filter(o => o.wo_id !== woId), ...draft.ops];
  }
  if (!orders.some(o => o.id === woId)) return null;
  const mat = await loadMaterials(orders, draft ? { wo_id: woId, req: draft.req } : null);
  const s = scheduleWithMaterials(jobsFrom(orders, ops), mat);
  let pushed = [];
  if (draft) {
    const base = schedule(jobsFrom(w.orders.filter(o => o.id !== woId), w.ops.filter(o => o.wo_id !== woId)));
    pushed = [...base.res.values()].filter(r => r.flag !== 'LATE' && s.res.get(r.job.id)?.flag === 'LATE').map(r => r.job.wo.wo_no);
  }
  return { r: s.res.get(woId), a: s.alloc.get(woId), pos: s.sorted.findIndex(j => j.id === woId) + 1, total: s.sorted.length, start: s.start, draft: !!draft, pushed };
}

// orders → schedule jobs with the hours still to do on each stage
export function jobsFrom(orders, ops) {
  const by = {};
  ops.forEach(o => { (by[o.wo_id] ||= []).push(o); });
  return orders.map(w => ({
    id: w.id, wo: w, priority: w.priority, due_date: w.due_date, rank: w.wo_no,
    ops: (by[w.id] || []).filter(o => ['PENDING', 'IN_PROGRESS'].includes(o.status)).map(o => {
      const f = o.status === 'IN_PROGRESS' ? Math.max(0, 1 - num(o.qty_done) / (num(w.qty) || 1)) : 1;
      return { id: o.id, seq: num(o.seq), wc: o.work_center_id, status: o.status, wait: num(o.wait_days), group: o.run_group_id || null,
               h: stageHours(o.work_center_id, num(o.planned_machine_hours) * f, num(o.planned_labour_hours) * f) };
    }),
  }));
}

const cmp = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };
export const seqKey = j => [j.priority === 'URGENT' ? 0 : 1, j.due_date || '9999-12-31', j.rank || ''];

// times are in working days from the start date (0 = start of the first working day)
// a combined run is one block at its work centre: all its orders' hours together, starting when the last of them is
// ready for that stage (found by a first pass without runs); every order of the run leaves the stage when the block ends
export function schedule(jobs, startIso = today()) {
  if (!jobs.some(j => j.ops.some(o => o.group && o.status === 'PENDING'))) return scheduleRuns(jobs, startIso, null);
  const first = scheduleRuns(jobs, startIso, null), ready = {}, hours = {};
  for (const r of first.res.values()) r.stages.forEach(s => { if (s.group && s.status === 'PENDING') ready[s.group] = Math.max(ready[s.group] || 0, s.ready || 0); });
  jobs.forEach(j => j.ops.forEach(o => { if (o.group && o.status === 'PENDING') hours[o.group] = (hours[o.group] || 0) + o.h; }));
  return scheduleRuns(jobs, startIso, { ready, hours, blocks: {} });
}
function scheduleRuns(jobs, startIso, runs) {
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
  // the rest in route order, order by order in sequence (not before the order's material arrives, if held)
  for (const j of sorted) {
    const r = res.get(j.id);
    r.t = Math.max(r.t, num(j.ready));
    for (const s of [...j.ops].sort((a, b) => a.seq - b.seq)) {
      if (s.status !== 'PENDING') continue;
      if (runs && s.group) {
        // the first order of the run in the sequence books the whole run
        const b = runs.blocks[s.group] ||= (() => { const d = runs.hours[s.group] / capOf(s.wc), st = book(s.wc, Math.max(r.t, runs.ready[s.group] || 0), d); return { start: st, end: st + d }; })();
        r.stages.push({ ...s, ready: r.t, start: b.start, end: b.end }); r.t = Math.max(r.t, b.end) + s.wait;
        continue;
      }
      const d = s.h / capOf(s.wc), st = book(s.wc, r.t, d);
      r.stages.push({ ...s, ready: r.t, start: st, end: st + d }); r.t = st + d + s.wait;
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
  data: () => ({ loading: true, data: null, mat: null, sch: null, proj: '', flag: '', matF: '', openId: null, startDate: today(), waitMat: false, sel: {}, busy: false }),
  computed: {
    rows() {
      if (!this.sch) return [];
      return this.sch.sorted.map((j, i) => ({ n: i + 1, j, r: this.sch.res.get(j.id) }))
        .filter(x => (!this.proj || x.j.wo.project_id === this.proj) && (!this.flag || x.r.flag === this.flag) && (!this.matF || this.matOf(x.j).status === this.matF));
    },
    counts() {
      const c = { LATE: 0, TIGHT: 0, OK: 0, NO_DUE: 0 };
      this.sch?.sorted.forEach(j => { const f = this.sch.res.get(j.id).flag; if (c[f] !== undefined) c[f]++; });
      c.SHORT = this.sch ? this.sch.sorted.filter(j => ['SHORT', 'PO_PENDING'].includes(this.matOf(j).status)).length : 0;
      c.PO_LATE = this.sch ? this.sch.sorted.filter(j => this.matOf(j).status === 'PO_LATE').length : 0;
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
      const days = {}, by = {}, seen = new Set();
      const dayDate = i => (days[i] ||= addWorkdays(start, i));
      for (const r of this.sch.res.values()) for (const s of r.stages) {
        // a combined run is one block — count it once
        if (s.group) { const k = s.group + '|' + s.start; if (seen.has(k)) continue; seen.add(k); }
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
    canPlan: () => hasRole('production_incharge', 'factory_manager'),
    selected() { return (this.sch?.sorted || []).filter(j => this.sel[j.id]); },
    // combined runs with their orders
    runs() {
      if (!this.data) return [];
      const wo = Object.fromEntries(this.data.orders.map(o => [o.id, o]));
      return this.data.runs.map(g => ({ ...g, ops: this.data.ops.filter(o => o.run_group_id === g.id).map(o => ({ ...o, wo: wo[o.wo_id] })) })).filter(g => g.ops.length);
    },
  },
  async mounted() { await this.reload(); },
  methods: {
    qty, dt, label, num,
    async reload() {
      this.loading = true;
      await run(async () => { this.data = await loadOpenWork(); this.mat = await loadMaterials(this.data.orders); this.plan(); });
      this.loading = false;
    },
    plan() { if (this.data) this.sch = scheduleWithMaterials(jobsFrom(this.data.orders, this.data.ops), this.mat, this.startDate || today(), this.waitMat); },
    matOf(j) { return this.sch?.alloc?.get(j.id) || { status: 'NO_BOM', lines: [] }; },
    MAT: s => MAT[s] || { t: s, c: '' },
    poText(l) { return [...l.pos.map(p => `${p.po_no} ${qty(p.qty)} due ${p.date ? dt(p.date) : '?'}`), ...l.tent.map(p => `${p.po_no} ${qty(p.qty)} (awaiting approval) due ${p.date ? dt(p.date) : '?'}`)].join(' · '); },
    uom(id) { return refRow('items', id)?.uoms?.code || ''; },
    at(t) { return dt(dateAt(this.sch.start, t)); },
    endAt(t) { return dt(addWorkdays(this.sch.start, Math.max(Math.ceil(t - 1e-9) - 1, 0))); },
    wcName(id) { return refRow('work_centers', id)?.name || ''; },
    runNo(id) { return this.data?.runs.find(g => g.id === id)?.run_no || 'run'; },
    runsOf(r) { return [...new Set(r.stages.filter(s => s.group).map(s => s.group))]; },
    // combine the ticked orders at a work centre where each of them has a stage still to start
    async combine() {
      const js = this.selected;
      const free = j => new Set(this.data.ops.filter(o => o.wo_id === j.id && o.status === 'PENDING' && !o.run_group_id).map(o => o.work_center_id));
      const common = [...js.map(free).reduce((a, b) => new Set([...a].filter(x => b.has(x))))];
      if (!common.length) return toast('These orders have no stage still to start at the same work centre', 'error');
      const v = await ask({ title: `Combine ${js.length} orders`, message: js.map(j => `${j.wo.wo_no} — ${j.wo.description || ''}`).join(' · '),
        fields: [{ k: 'wc', label: 'Run together at', type: 'select', required: true, options: common.map(id => ({ v: id, l: this.wcName(id) })) },
          { k: 'nest', label: 'Nest boards together', type: 'check', hint: 'Sheets of the same board for all the orders worked out together (orders whose material is not yet sent to Stores)' },
          { k: 'notes', label: 'Notes for the floor (board / colour / why combined)', type: 'textarea' }], okText: 'Combine' });
      if (!v) return;
      this.busy = true;
      const ok = await run(async () => {
        const id = await rpc('run_group_create', { p_wc: v.wc, p_wos: js.map(j => j.id), p_notes: v.notes || null, p_nest: !!v.nest });
        const g = must(await sb.from('wo_run_groups').select('run_no,setup_saved,sheets_saved').eq('id', id).single());
        toast(`${g.run_no}: setup counted once (saves ${qty(g.setup_saved)} h)${num(g.sheets_saved) ? `, ${qty(g.sheets_saved)} sheet(s) saved by nesting` : ''}`, 'ok', 7000);
        return true;
      });
      this.busy = false;
      if (ok) { this.sel = {}; await this.reload(); }
    },
    async dissolve(g) {
      if (!(await confirmBox('Ungroup ' + g.run_no, 'Run these orders separately again? Each gets its own setup back (and its own board sheets, while its material is not yet sent to Stores).'))) return;
      if (await run(() => rpc('run_group_dissolve', { p_group: g.id }), 'Ungrouped')) await this.reload();
    },
    async leave(g, o) {
      if (!(await confirmBox('Take out ' + o.wo?.wo_no, `Take ${o.wo?.wo_no} out of ${g.run_no}?`))) return;
      if (await run(() => rpc('run_group_remove', { p_op: o.id }), 'Taken out of the run')) await this.reload();
    },
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
      <label class="small row" style="gap:4px" title="Hold each order's start until its material is in stock or due on a PO"><input type="checkbox" v-model="waitMat" @change="plan"> Wait for material</label>
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
        <div class="kpi bad" style="cursor:pointer" @click="matF = matF === 'SHORT' ? '' : 'SHORT'"><div class="l">❌ Material short</div><div class="v">{{ counts.SHORT }}</div><div class="s">{{ counts.PO_LATE }} more with a PO due after the start</div></div>
        <div class="kpi" v-if="neck"><div class="l">Bottleneck</div><div style="font-weight:700;margin-top:4px">{{ neck.w?.name }}</div><div class="s">{{ qty(Math.round(neck.total * 10) / 10) }} working days of work queued</div></div>
      </div>
      <div class="card">
        <div class="hd"><h3>Sequence — URGENT first, then earliest due date</h3><span class="spacer" style="flex:1"></span>
          <button v-if="canPlan && selected.length >= 2" class="btn sm primary" :disabled="busy" @click="combine">🔗 Combine {{ selected.length }} orders…</button>
          <span v-else-if="canPlan" class="small muted" style="margin-right:8px">tick orders to run together</span>
          <span class="small muted" v-if="flag || matF">showing {{ flag ? FLAG(flag).t : '' }} {{ matF ? MAT(matF).t : '' }} · <a href="javascript:void 0" @click="flag = ''; matF = ''">show all</a></span></div>
        <div class="tbl-wrap"><table class="t">
          <thead><tr><th v-if="canPlan"></th><th class="n">#</th><th>Order</th><th>Project</th><th>Product</th><th class="n">Qty</th><th>Status</th><th>Due</th><th>Projected finish</th><th class="n">Spare days</th><th>Flag</th><th>Material</th><th>Next stage</th></tr></thead>
          <tbody>
            <tr v-if="!rows.length"><td colspan="13" class="empty">No open production orders</td></tr>
            <template v-for="x in rows" :key="x.j.id">
              <tr style="cursor:pointer" @click="openId = openId === x.j.id ? null : x.j.id">
                <td v-if="canPlan" @click.stop><input type="checkbox" v-model="sel[x.j.id]"></td>
                <td class="n">{{ x.n }}</td>
                <td><a href="javascript:void 0" @click.stop="go('d/wo/' + x.j.id)"><b>{{ x.j.wo.wo_no }}</b></a><Badge v-if="x.j.priority === 'URGENT'" v="URGENT" style="margin-left:4px" />
                  <span v-for="g in runsOf(x.r)" :key="g" class="b BLUE" style="margin-left:4px" title="Combined run">🔗 {{ runNo(g) }}</span>
                  <div class="small muted">{{ x.j.wo.batch_label || (x.j.wo.is_rework ? 'Rework' : '') }}</div></td>
                <td>{{ projCode(x.j.wo.project_id) }}</td>
                <td>{{ x.j.wo.description || itemName(x.j.wo.item_id) }}</td>
                <td class="n">{{ qty(x.j.wo.qty) }}</td>
                <td><Badge :v="x.j.wo.status" /></td>
                <td>{{ dt(x.j.due_date) || '—' }}</td>
                <td><b>{{ dt(x.r.date) || '—' }}</b><div class="small muted" v-if="x.r.date">working day {{ x.r.days }}</div></td>
                <td class="n" :style="x.r.slack !== null && x.r.slack < 0 ? 'color:#b91c1c;font-weight:600' : ''">{{ x.r.slack === null ? '' : x.r.slack }}</td>
                <td><span class="b" :class="FLAG(x.r.flag).c">{{ FLAG(x.r.flag).t }}</span></td>
                <td><span class="b" :class="MAT(matOf(x.j).status).c">{{ MAT(matOf(x.j).status).t }}</span>
                  <div class="small muted" v-if="matOf(x.j).status === 'SHORT'">{{ matOf(x.j).shortItems }} item(s)</div>
                  <div class="small muted" v-else-if="['ON_PO', 'PO_LATE', 'PO_PENDING'].includes(matOf(x.j).status)">all by {{ matOf(x.j).matDate ? dt(matOf(x.j).matDate) : '?' }}</div></td>
                <td class="small">{{ cur(x.r) }}<div class="muted" v-if="x.r.stages[0]">from {{ at(x.r.stages[0].start) }}</div></td>
              </tr>
              <tr v-if="openId === x.j.id"><td :colspan="canPlan ? 2 : 1"></td><td colspan="11">
                <table class="t" style="margin:4px 0"><thead><tr><th>Stage</th><th>Work centre</th><th>Status</th><th class="n">Hours left</th><th>Starts</th><th>Ends</th><th class="n">Wait after (days)</th></tr></thead>
                  <tbody><tr v-for="s in x.r.stages" :key="s.id"><td>{{ s.seq }}</td><td>{{ wcName(s.wc) }}<span v-if="s.group" class="b BLUE" style="margin-left:4px">🔗 {{ runNo(s.group) }}</span></td><td><Badge :v="s.status" /></td><td class="n">{{ qty(Math.round(s.h * 10) / 10) }}</td>
                    <td>{{ at(s.start) }}</td><td>{{ endAt(s.end) }}</td><td class="n">{{ qty(s.wait) }}</td></tr></tbody></table>
                <table class="t" style="margin:4px 0" v-if="matOf(x.j).lines.length"><thead><tr><th>Material (needed by {{ dt(matOf(x.j).need) || '—' }})</th><th class="n">Required</th><th class="n">From project WIP</th><th class="n">From stock</th><th>From POs</th><th class="n">Short</th><th class="n">On requisition (no PO)</th></tr></thead>
                  <tbody><tr v-for="l in matOf(x.j).lines" :key="l.item" :style="l.short ? 'background:#fef2f2' : ''"><td>{{ itemName(l.item) }} <span class="muted small">{{ uom(l.item) }}</span></td>
                    <td class="n">{{ qty(l.req) }}</td><td class="n">{{ qty(l.issued) }}</td><td class="n">{{ qty(l.stock) }}</td><td class="small">{{ poText(l) }}</td>
                    <td class="n" :style="l.short ? 'color:#b91c1c;font-weight:600' : ''">{{ l.short ? qty(Math.round(l.short * 1000) / 1000) : '' }}</td><td class="n">{{ l.short && l.pr ? qty(l.pr) : '' }}</td></tr></tbody></table>
              </td></tr>
            </template>
          </tbody>
        </table></div>
        <p class="small muted" style="margin:8px 0 0">Click a row for its stages. Finish dates are recalculated from what is still open each time this page opens — logged quantities and closed stages bring them forward,
          new urgent or earlier-due orders push others back. Draft orders are not scheduled until they are sent to the Factory Manager.<br>Material: what each order's open units still need by the BOM is shared out in this sequence — the project's WIP (material already on the floor), then the project's own stock, then free stock in the stores, then approved POs by delivery date (POs awaiting approval shown separately); needed by the start of the order's first stage. Tick <b>Wait for material</b> to hold each order's start until its material is due.</p>
      </div>
      <div class="card" v-if="runs.length">
        <div class="hd"><h3>🔗 Combined runs</h3></div>
        <div class="tbl-wrap"><table class="t">
          <thead><tr><th>Run</th><th>Work centre</th><th>Orders</th><th class="n">Setup saved (h)</th><th class="n">Sheets saved</th><th>Notes</th><th></th></tr></thead>
          <tbody><tr v-for="g in runs" :key="g.id">
            <td><b>{{ g.run_no }}</b></td><td>{{ wcName(g.work_center_id) }}</td>
            <td><span v-for="o in g.ops" :key="o.id" class="chip" style="margin:2px">{{ o.wo?.wo_no }} · {{ projCode(o.wo?.project_id) }} · {{ qty(o.wo?.qty) }}
              <a v-if="canPlan && o.status === 'PENDING'" href="javascript:void 0" @click="leave(g, o)" title="Take out of the run"> ✕</a></span></td>
            <td class="n">{{ qty(g.setup_saved) }}</td><td class="n">{{ g.nested ? qty(g.sheets_saved) : '' }}</td><td class="small">{{ g.notes }}</td>
            <td><button v-if="canPlan" class="btn sm" @click="dissolve(g)">Ungroup</button></td></tr></tbody>
        </table></div>
        <p class="small muted" style="margin:8px 0 0">A combined run is scheduled as one block at its work centre (setup once) and logged once on the stage board — the time is split over the orders by their planned hours. Material, cost and FG stay per order.</p>
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
