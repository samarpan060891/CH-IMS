// Machine-rate calculator: suggests each machine work centre's rate per hour from its real running costs
// (depreciation of linked machines + repairs + tooling) ÷ hours (logged or capacity) + power per running hour.
// Nothing changes until the Factory Manager / Finance clicks Apply; new rates apply to stage logs from then on.
import { sb, state, must, run, rpc, hasRole, today, money, qty, dt, num, loadRefs, toast } from './lib.js';
import { ask, confirmBox, DataTable } from './components.js';

const yearAgo = () => { const d = new Date(); d.setFullYear(d.getFullYear() - 1); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); };

export const MachineRates = {
  components: { DataTable },
  data: () => ({ from: yearAgo(), to: today(), rows: [], loading: false, sel: null, calc: null, history: [], machines: [], free: [] }),
  computed: {
    canApply: () => hasRole('factory_manager', 'finance'),
    canLink: () => hasRole('factory_manager', 'finance', 'stores'),
  },
  async mounted() { await this.load(); },
  methods: {
    money, qty, dt, num,
    async load() {
      this.loading = true;
      await run(async () => {
        const wcs = must(await sb.from('work_centers').select('id,code,name,kind,machine_rate_per_hour,is_active').eq('kind', 'MACHINE').eq('is_active', true).order('sort_order'));
        // every machine work centre with its suggestion for the period
        const out = [];
        for (const w of wcs) {
          const c = must(await sb.rpc('machine_rate_calc', { p_wc: w.id, p_from: this.from, p_to: this.to }));
          out.push({ ...w, c });
        }
        this.rows = out;
      });
      this.loading = false;
      if (this.sel) this.open(this.rows.find(r => r.id === this.sel.id));
    },
    async open(r) {
      if (!r) return;
      this.sel = r; this.calc = r.c;
      await run(async () => {
        this.history = must(await sb.from('machine_rate_reviews').select('*, profiles:applied_by(full_name)').eq('work_center_id', r.id).order('applied_at', { ascending: false }).limit(20));
        // machines registered as assets (machine class), linked here or not linked anywhere yet
        const a = must(await sb.from('assets').select('id,asset_tag,purchase_cost,purchase_date,work_center_id,items!inner(name,item_classes!inner(code))').eq('items.item_classes.code', 'MAC').not('status', 'in', '(SCRAPPED,DISPOSED,LOST)').order('asset_tag'));
        this.machines = a.filter(x => x.work_center_id === r.id);
        this.free = a.filter(x => !x.work_center_id);
      });
    },
    async link(a, on) {
      if (await run(() => rpc('machine_link_asset', { p_asset: a.id, p_wc: on ? this.sel.id : null }), on ? `${a.asset_tag} linked` : `${a.asset_tag} unlinked`)) await this.load();
    },
    async addMachine() {
      if (!this.free.length) return toast('No unlinked machines in the asset register (machine class)', 'info');
      const v = await ask({ title: 'Link a machine to ' + this.sel.name, fields: [{ k: 'a', label: 'Machine (asset)', type: 'select', required: true,
        options: this.free.map(a => ({ v: a.id, l: `${a.asset_tag} — ${a.items.name} · ${money(a.purchase_cost)} (${dt(a.purchase_date)})` })) }], okText: 'Link' });
      if (v) await this.link(this.free.find(a => a.id === v.a), true);
    },
    async editInputs() {
      const w = must(await sb.from('work_centers').select('power_kw,load_factor_pct,tooling_cost_per_year,hours_per_day,working_days_per_year,utilisation_pct').eq('id', this.sel.id).single());
      const v = await ask({ title: 'Inputs — ' + this.sel.name, okText: 'Save', fields: [
        { k: 'power_kw', label: 'Connected power (kW)', type: 'number', default: w.power_kw },
        { k: 'load_factor_pct', label: 'Average load while running (%)', type: 'number', default: w.load_factor_pct },
        { k: 'tooling_cost_per_year', label: 'Tooling & consumables per year (blades, bits, belts…) AED', type: 'number', default: w.tooling_cost_per_year },
        { k: 'hours_per_day', label: 'Available hours per day', type: 'number', default: w.hours_per_day },
        { k: 'working_days_per_year', label: 'Working days per year', type: 'number', default: w.working_days_per_year },
        { k: 'utilisation_pct', label: 'Expected utilisation (%) — for the capacity basis', type: 'number', default: w.utilisation_pct }] });
      if (!v) return;
      const patch = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, num(x)]));
      if (await run(async () => must(await sb.from('work_centers').update(patch).eq('id', this.sel.id)), 'Inputs saved')) await this.load();
    },
    async apply(basis) {
      const c = this.calc;
      let rate = basis === 'ACTUAL' ? c.rate_actual : basis === 'CAPACITY' ? c.rate_capacity : null;
      const v = await ask({ title: 'Set machine rate — ' + this.sel.name, okText: 'Apply',
        message: `Current AED ${money(c.current_rate)}/h. The new rate applies to stage logs from now on; jobs already logged keep their rate.`,
        fields: [{ k: 'r', label: 'New rate AED per machine hour', type: 'number', required: true, default: rate }, { k: 'n', label: 'Note (why)', type: 'textarea' }] });
      if (!v) return;
      const b = basis === 'MANUAL' || num(v.r) !== num(rate) ? 'MANUAL' : basis;
      if (await run(() => rpc('machine_rate_apply', { p_wc: this.sel.id, p_rate: num(v.r), p_basis: b, p_from: c.from, p_to: c.to, p_components: c, p_notes: v.n || null }), 'Machine rate updated')) {
        await loadRefs(['work_centers'], true); await this.load();
      }
    },
    diff(r) { const s = r.c.rate_actual ?? r.c.rate_capacity; return s == null ? null : Math.round((s - num(r.machine_rate_per_hour)) * 100) / 100; },
  },
  template: `<div>
    <div class="card">
      <div class="row" style="flex-wrap:wrap;gap:10px;align-items:flex-end">
        <label class="f"><span>From</span><input type="date" v-model="from"></label>
        <label class="f"><span>To</span><input type="date" v-model="to"></label>
        <button class="btn primary" @click="load" :disabled="loading">Calculate</button>
        <span class="muted small" style="max-width:640px">Suggested rate = (depreciation of the machines linked to the work centre + breakdown repairs + repair / spares expenses tagged to it + tooling) ÷ machine hours, + power per running hour (kW × load × tariff in Settings).
          <b>On actual</b> divides by hours logged on production orders; <b>on capacity</b> by planned hours (hours/day × working days × utilisation) — better while few hours are logged.</span>
      </div>
    </div>
    <div class="card">
      <DataTable :rows="rows" :loading="loading" clickable @row="open" :searchable="false" :columns="[{k:'code',label:'Code'},{k:'name',label:'Machine work centre'},
        {k:'machine_rate_per_hour',label:'Current AED/h',fmt:'money'},{k: r => r.c.logged_hours, label:'Hours logged', fmt:'qty'},{k: r => r.c.fixed_total, label:'Fixed costs', fmt:'money'},
        {k: r => r.c.power_per_hour, label:'Power AED/h', fmt:'money'},{k: r => r.c.rate_actual, label:'Suggested (actual)', fmt:'money'},{k: r => r.c.rate_capacity, label:'Suggested (capacity)', fmt:'money'},
        {k: diff, label:'Difference', fmt:'money'}]" />
      <p class="small muted" v-if="rows.length">Click a work centre for the breakdown, its machines and to apply a rate.</p>
      <p class="small muted" v-else-if="!loading">No active work centres of type Machine (Production → Work centres).</p>
    </div>
    <div class="card" v-if="sel && calc">
      <div class="hd"><h3>{{ calc.work_center }} · {{ dt(calc.from) }} – {{ dt(calc.to) }} ({{ calc.months }} months)</h3><span class="spacer"></span>
        <button class="btn sm" v-if="canApply" @click="editInputs">⚙ Inputs (kW, tooling, capacity)</button></div>
      <table class="t fin" style="max-width:640px">
        <tr class="h"><td colspan="2">Fixed costs in the period</td></tr>
        <tr><td>Depreciation of linked machines</td><td class="n">{{ money(calc.depreciation) }}</td></tr>
        <tr><td>Breakdown repair costs (downtime log)</td><td class="n">{{ money(calc.repairs_breakdowns) }}</td></tr>
        <tr><td>Repair / spares / service expenses tagged to this machine</td><td class="n">{{ money(calc.repairs_expenses) }}</td></tr>
        <tr><td>Tooling & consumables allowance</td><td class="n">{{ money(calc.tooling) }}</td></tr>
        <tr class="s"><td>Total fixed costs</td><td class="n">{{ money(calc.fixed_total) }}</td></tr>
        <tr class="h"><td colspan="2">Hours</td></tr>
        <tr><td>Machine hours logged on production orders</td><td class="n">{{ qty(calc.logged_hours) }}</td></tr>
        <tr><td>Capacity hours (hours/day × working days × utilisation)</td><td class="n">{{ qty(calc.capacity_hours) }}</td></tr>
        <tr class="h"><td colspan="2">Power per running hour</td></tr>
        <tr><td>{{ qty(calc.power_kw) }} kW × {{ qty(calc.load_pct) }}% load × AED {{ calc.tariff }}/kWh</td><td class="n">{{ money(calc.power_per_hour) }}</td></tr>
        <tr class="g"><td>Suggested rate — on hours logged</td><td class="n">{{ calc.rate_actual != null ? money(calc.rate_actual) : 'no hours logged' }}</td></tr>
        <tr class="g"><td>Suggested rate — on capacity</td><td class="n">{{ calc.rate_capacity != null ? money(calc.rate_capacity) : '—' }}</td></tr>
        <tr><td>Current rate</td><td class="n">{{ money(calc.current_rate) }}</td></tr>
      </table>
      <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap" v-if="canApply">
        <button class="btn ok" v-if="calc.rate_actual != null" @click="apply('ACTUAL')">Apply actual-hours rate</button>
        <button class="btn ok" v-if="calc.rate_capacity != null" @click="apply('CAPACITY')">Apply capacity rate</button>
        <button class="btn" @click="apply('MANUAL')">Set another rate…</button>
      </div>
      <h3 style="font-size:13px;margin-top:16px">Machines linked (their depreciation counts here)</h3>
      <div v-if="!machines.length" class="small muted">None linked — link the machine(s) from the asset register so their depreciation is included.</div>
      <div v-for="a in machines" :key="a.id" class="row small" style="gap:8px;margin:4px 0">
        <b>{{ a.asset_tag }}</b> {{ a.items.name }} · AED {{ money(a.purchase_cost) }} · since {{ dt(a.purchase_date) }}
        <button v-if="canLink" class="btn sm" @click="link(a, false)">Unlink</button>
      </div>
      <button v-if="canLink" class="btn sm" style="margin-top:6px" @click="addMachine">+ Link a machine</button>
      <p class="small muted" style="margin-top:8px">Tag repair, spares and service bills to this machine with the <b>Machine</b> column on expense lines; breakdown repair costs come from Machine downtime.</p>
      <template v-if="history.length">
        <h3 style="font-size:13px;margin-top:16px">Rate history</h3>
        <DataTable :searchable="false" :rows="history" :columns="[{k:'applied_at',label:'When',fmt:'datetime'},{k: r => r.profiles?.full_name, label:'By'},{k:'basis',label:'Basis',fmt:'label'},
          {k:'old_rate',label:'Old',fmt:'money'},{k:'new_rate',label:'New',fmt:'money'},{k: r => dt(r.period_from) + ' – ' + dt(r.period_to), label:'Costs from'},{k:'notes',label:'Note'}]" />
      </template>
    </div>
  </div>`,
};
