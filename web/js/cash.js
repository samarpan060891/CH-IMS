// Cash position & forecast: today's cash and bank, then every expected receipt and payment from the documents in the system
// (customer / supplier invoices, PDCs, open POs, sales orders, project claims, payroll, recurring bills, VAT) plus Finance's own
// items, laid out by week (13) or month (12). Weeks / months that close below the minimum cash balance are flagged.
import { sb, state, must, run, rpc, hasRole, go, today, money, dt, num, downloadCSV, toast } from './lib.js';
import { ask, confirmBox } from './components.js';

const IN_CATS = ['Customer invoices', 'Cheques & PDCs in hand', 'Advances due (orders & projects)', 'Sales orders not yet invoiced', 'Project progress claims (work done, not billed)', 'Other receipts'];
const OUT_CATS = ['Supplier invoices', 'PDCs issued', 'Purchase orders — advances', 'Purchase orders — on delivery', 'Payroll', 'Recurring bills', 'VAT', 'Other payments'];
const ITEM_CATS = [{ v: 'LOAN', l: 'Loan / finance' }, { v: 'CAPEX', l: 'Capital purchase' }, { v: 'OWNER', l: 'Owner / partner' }, { v: 'TAX', l: 'Tax / government' }, { v: 'OTHER', l: 'Other' }];
// where a forecast line opens
const LINK = { si: 'd/si/', rcv: 'd/rcv/', so: 'd/so/', proj: 'd/proj/', inv: 'd/inv/', pay: 'd/pay/', po: 'd/po/', payroll: 'd/payroll/', rexp: 'd/rexp/' };
// local calendar dates (toISOString would shift a day in UAE time)
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return iso(d); };
const monday = s => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); };
const monthStart = (s, k = 0) => { const d = new Date(s.slice(0, 8) + '01T00:00:00'); d.setMonth(d.getMonth() + k); return iso(d); };

export const CashForecast = {
  data: () => ({ view: 'W', pos: [], flows: [], items: [], minCash: 0, loading: true, sel: null }),
  computed: {
    isFin: () => hasRole('finance'),
    cash() { return this.pos.filter(p => ['CASH', 'BANK', 'PETTY'].includes(p.kind)); },
    opening() { return this.cash.reduce((s, p) => s + num(p.balance), 0); },
    pdcIn() { return this.pos.filter(p => p.kind === 'PDC_IN').reduce((s, p) => s + num(p.balance), 0); },
    pdcOut() { return -this.pos.filter(p => p.kind === 'PDC_OUT').reduce((s, p) => s + num(p.balance), 0); },
    // buckets: 13 weeks from this Monday, or 12 months from this month
    buckets() {
      const t = today();
      if (this.view === 'W') {
        const w0 = monday(t);
        return Array.from({ length: 13 }, (_, i) => { const from = addDays(w0, i * 7); return { from, to: addDays(from, 6), label: i === 0 ? 'This week' : 'w/c ' + dt(from).slice(0, 6) }; });
      }
      return Array.from({ length: 12 }, (_, i) => { const from = monthStart(t, i), to = addDays(monthStart(t, i + 1), -1);
        return { from, to, label: new Date(from + 'T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }) }; });
    },
    // amounts per category per bucket, running opening / closing balance
    grid() {
      const b = this.buckets, at = f => b.findIndex(x => f.flow_date >= x.from && f.flow_date <= x.to);
      const cell = {}; const add = (cat, i, a) => { (cell[cat] ||= Array(b.length).fill(0))[i] += a; };
      this.flows.forEach(f => { const i = at(f); if (i >= 0) add(f.category, i, num(f.amount)); });
      const sum = cats => b.map((_, i) => cats.reduce((s, c) => s + (cell[c]?.[i] || 0), 0));
      const tin = sum(IN_CATS), tout = sum(OUT_CATS), net = b.map((_, i) => tin[i] - tout[i]);
      const open = [], close = [];
      let run = this.opening;
      b.forEach((_, i) => { open.push(run); run += net[i]; close.push(run); });
      return { cell, tin, tout, net, open, close };
    },
    inRows() { return IN_CATS.filter(c => this.grid.cell[c]); },
    outRows() { return OUT_CATS.filter(c => this.grid.cell[c]); },
    lowest() { const c = this.grid.close; let k = 0; c.forEach((v, i) => { if (v < c[k]) k = i; }); return c.length ? { v: c[k], b: this.buckets[k] } : null; },
    firstShort() { const i = this.grid.close.findIndex(v => v < num(this.minCash)); return i < 0 ? null : this.buckets[i]; },
    detail() {
      if (!this.sel) return [];
      const { cat, i } = this.sel, b = this.buckets[i];
      return this.flows.filter(f => f.flow_date >= b.from && f.flow_date <= b.to && (!cat || (cat === 'IN' ? f.direction === 'IN' : cat === 'OUT' ? f.direction === 'OUT' : f.category === cat)));
    },
  },
  async mounted() { await this.load(); },
  methods: {
    money, dt, num,
    async load() {
      this.loading = true;
      await run(async () => {
        const until = addDays(monthStart(today(), 12), -1);
        const [p, f, s, it] = await Promise.all([sb.rpc('cash_position'), sb.rpc('cash_forecast', { p_until: until }),
          sb.from('company_settings').select('min_cash_balance').eq('id', 1).single(), sb.from('cash_forecast_items').select('*').order('item_date')]);
        this.pos = must(p); this.flows = must(f); this.minCash = num(must(s)?.min_cash_balance); this.items = must(it);
      });
      this.loading = false;
    },
    short(i) { return num(this.minCash) > 0 && this.grid.close[i] < num(this.minCash); },
    pick(cat, i) { this.sel = this.sel && this.sel.cat === cat && this.sel.i === i ? null : { cat, i }; },
    selTitle() { const b = this.buckets[this.sel.i]; const c = this.sel.cat === 'IN' ? 'All receipts' : this.sel.cat === 'OUT' ? 'All payments' : this.sel.cat; return `${c} — ${dt(b.from)} to ${dt(b.to)}`; },
    open(f) { if (f.doc_type === 'cfi') return this.editItem(this.items.find(x => x.id === f.doc_id)); if (LINK[f.doc_type] && f.doc_id) go(LINK[f.doc_type] + f.doc_id); },
    async setMin() {
      const v = await ask({ title: 'Minimum cash balance', message: 'Weeks / months that close below this are highlighted, and Finance and the Factory Manager are notified each morning when a coming week dips below it.',
        fields: [{ k: 'm', label: 'Minimum cash & bank AED', type: 'number', required: true, default: this.minCash }], okText: 'Save' });
      if (!v) return;
      if (await run(async () => must(await sb.from('company_settings').update({ min_cash_balance: num(v.m), cash_alert_week: null }).eq('id', 1)), 'Minimum saved')) this.minCash = num(v.m);
    },
    async editItem(it) {
      if (!this.isFin) return;
      const v = await ask({ title: it ? 'Edit forecast item' : 'Add a receipt or payment', message: 'For flows the system cannot see: loan instalments, capital purchases, owner drawings or injections, large expected receipts.',
        fields: [{ k: 'direction', label: 'Type', type: 'select', required: true, default: it?.direction || 'OUT', options: [{ v: 'OUT', l: 'Payment (money out)' }, { v: 'IN', l: 'Receipt (money in)' }] },
          { k: 'category', label: 'Category', type: 'select', required: true, default: it?.category || 'OTHER', options: ITEM_CATS },
          { k: 'description', label: 'Description', required: true, default: it?.description || '' },
          { k: 'amount', label: 'Amount AED', type: 'number', required: true, default: it?.amount ?? null },
          { k: 'item_date', label: 'Date', type: 'date', required: true, default: it?.item_date || today() },
          { k: 'repeat_monthly', label: 'Repeats every month', type: 'check', default: !!it?.repeat_monthly },
          { k: 'repeat_until', label: 'Repeat until (blank = forecast end)', type: 'date', default: it?.repeat_until || null }],
        okText: 'Save' });
      if (!v) return;
      const row = { direction: v.direction, category: v.category, description: v.description, amount: num(v.amount), item_date: v.item_date,
                    repeat_monthly: !!v.repeat_monthly, repeat_until: v.repeat_monthly ? v.repeat_until || null : null };
      if (await run(async () => must(it ? await sb.from('cash_forecast_items').update(row).eq('id', it.id) : await sb.from('cash_forecast_items').insert(row)), 'Saved')) await this.load();
    },
    async delItem(it) {
      if (!(await confirmBox('Remove item', `Remove "${it.description}" from the forecast?`, true))) return;
      if (await run(async () => must(await sb.from('cash_forecast_items').delete().eq('id', it.id)), 'Removed')) await this.load();
    },
    async check() {
      const r = await run(() => rpc('cash_forecast_alert'));
      if (r) toast(r === 'ok' ? 'All coming weeks stay above the minimum' : r === 'no minimum set' ? 'Set a minimum cash balance first' : 'Cash falls below the minimum — Finance and the Factory Manager notified', r === 'ok' ? 'ok' : 'info', 6000);
    },
    csv() {
      const b = this.buckets, g = this.grid, rows = [['Opening cash', ...g.open]];
      this.inRows.forEach(c => rows.push([c, ...g.cell[c]])); rows.push(['Total receipts', ...g.tin]);
      this.outRows.forEach(c => rows.push([c, ...g.cell[c].map(x => -x)])); rows.push(['Total payments', ...g.tout.map(x => -x)]);
      rows.push(['Net cash flow', ...g.net], ['Closing cash', ...g.close]);
      const cols = [{ k: 0, label: '' }, ...b.map((x, i) => ({ k: i + 1, label: x.from }))];
      downloadCSV(`cash-forecast-${this.view === 'W' ? 'weekly' : 'monthly'}-${today()}.csv`, cols, rows.map(r => Object.fromEntries(r.map((v, i) => [i, typeof v === 'number' ? Math.round(v * 100) / 100 : v]))));
    },
  },
  template: `<div>
    <div class="kpis">
      <div class="kpi"><div class="l">Cash & bank today</div><div class="v">AED {{ money(opening) }}</div>
        <div class="s"><span v-for="p in cash" :key="p.account_id" style="display:block">{{ p.name }}: {{ money(p.balance) }}</span></div></div>
      <div class="kpi"><div class="l">Cheques in hand</div><div class="v">AED {{ money(pdcIn) }}</div><div class="s">received, not yet cleared</div></div>
      <div class="kpi"><div class="l">PDCs issued</div><div class="v">AED {{ money(pdcOut) }}</div><div class="s">not yet presented</div></div>
      <div class="kpi" :class="{bad: lowest && lowest.v < minCash}"><div class="l">Lowest forecast balance</div><div class="v">AED {{ lowest ? money(lowest.v) : '—' }}</div>
        <div class="s">{{ lowest ? (view === 'W' ? 'week of ' : '') + dt(lowest.b.from) : '' }}</div></div>
      <div class="kpi" :class="{bad: !!firstShort, ok: minCash > 0 && !firstShort}"><div class="l">Minimum cash</div><div class="v">AED {{ money(minCash) }}</div>
        <div class="s">{{ firstShort ? 'below from ' + dt(firstShort.from) : minCash > 0 ? 'never below in this view' : 'not set' }}
          <a v-if="isFin" href="javascript:void 0" @click="setMin"> change</a></div></div>
    </div>

    <div class="card">
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <a href="javascript:void 0" class="chip" :class="{on: view==='W'}" @click="view='W'; sel=null">13 weeks</a>
        <a href="javascript:void 0" class="chip" :class="{on: view==='M'}" @click="view='M'; sel=null">12 months</a>
        <span class="spacer"></span>
        <button class="btn sm" v-if="isFin" @click="check">🔔 Check minimum now</button>
        <button class="btn sm" @click="csv">⬇ Excel / CSV</button>
        <button class="btn sm" :disabled="loading" @click="load">↻ Refresh</button>
      </div>
      <div v-if="loading" class="muted">Loading…</div>
      <div v-else class="tbl-wrap"><table class="t cashf">
        <thead><tr><th></th><th v-for="(b, i) in buckets" :key="i" class="n">{{ b.label }}</th></tr></thead>
        <tbody>
          <tr class="sub"><td>Opening cash</td><td v-for="(v, i) in grid.open" :key="i" class="n">{{ money(v) }}</td></tr>
          <tr class="h"><td colspan="99">Money in</td></tr>
          <tr v-for="c in inRows" :key="c"><td>{{ c }}</td>
            <td v-for="(v, i) in grid.cell[c]" :key="i" class="n clk" :class="{on: sel && sel.cat===c && sel.i===i}" @click="v && pick(c, i)">{{ v ? money(v) : '' }}</td></tr>
          <tr class="sub"><td>Total receipts</td><td v-for="(v, i) in grid.tin" :key="i" class="n clk" @click="v && pick('IN', i)">{{ money(v) }}</td></tr>
          <tr class="h"><td colspan="99">Money out</td></tr>
          <tr v-for="c in outRows" :key="c"><td>{{ c }}</td>
            <td v-for="(v, i) in grid.cell[c]" :key="i" class="n clk" :class="{on: sel && sel.cat===c && sel.i===i}" @click="v && pick(c, i)">{{ v ? '(' + money(v) + ')' : '' }}</td></tr>
          <tr class="sub"><td>Total payments</td><td v-for="(v, i) in grid.tout" :key="i" class="n clk" @click="v && pick('OUT', i)">({{ money(v) }})</td></tr>
          <tr class="sub"><td>Net cash flow</td><td v-for="(v, i) in grid.net" :key="i" class="n" :class="{neg: v < 0}">{{ money(v) }}</td></tr>
          <tr class="tot"><td>Closing cash</td><td v-for="(v, i) in grid.close" :key="i" class="n" :class="{short: short(i), neg: v < 0}">{{ money(v) }}</td></tr>
        </tbody>
      </table></div>
      <p class="small muted" style="margin:8px 0 0">Click an amount to see the documents behind it. Customer receipts are shifted by each customer's average days late over the last year
        (overdue invoices spread over the next 4 weeks); open POs pay their advance now and the balance at delivery + payment terms; payroll repeats the last net payroll;
        VAT is due on the 28th after each quarter. <span v-if="minCash > 0">Red = closing below the minimum of AED {{ money(minCash) }}.</span></p>
    </div>

    <div class="card" v-if="sel">
      <div class="hd"><h3>{{ selTitle() }}</h3><span class="spacer"></span><button class="btn sm" @click="sel=null">✕</button></div>
      <div class="tbl-wrap"><table class="t">
        <thead><tr><th>Date</th><th>Flow</th><th>Document</th><th>Party</th><th class="n">Amount AED</th><th>Basis</th></tr></thead>
        <tbody><tr v-for="(f, k) in detail" :key="k">
          <td>{{ dt(f.flow_date) }}</td><td>{{ f.category }}</td>
          <td><a v-if="f.doc_id && (f.doc_type === 'cfi' || f.doc_type in LINK)" href="javascript:void 0" @click="open(f)">{{ f.doc_no || 'open' }}</a><span v-else>{{ f.doc_no || '' }}</span></td>
          <td>{{ f.party }}</td><td class="n" :class="{neg: f.direction==='OUT'}">{{ f.direction === 'OUT' ? '(' + money(f.amount) + ')' : money(f.amount) }}</td>
          <td class="small muted">{{ f.note }}</td></tr></tbody>
      </table></div>
    </div>

    <div class="card">
      <div class="hd"><h3>Finance's own forecast items</h3><span class="spacer"></span><button v-if="isFin" class="btn sm primary" @click="editItem(null)">+ Add receipt / payment</button></div>
      <div v-if="!items.length" class="small muted">Loan instalments, capital purchases, owner drawings or injections and other flows the system cannot see.</div>
      <div v-else class="tbl-wrap"><table class="t">
        <thead><tr><th>Date</th><th>Type</th><th>Category</th><th>Description</th><th class="n">Amount AED</th><th>Repeats</th><th></th></tr></thead>
        <tbody><tr v-for="it in items" :key="it.id">
          <td>{{ dt(it.item_date) }}</td><td>{{ it.direction === 'IN' ? 'Receipt' : 'Payment' }}</td><td>{{ (ITEM_CATS.find(c => c.v === it.category) || {}).l }}</td>
          <td>{{ it.description }}</td><td class="n">{{ money(it.amount) }}</td><td>{{ it.repeat_monthly ? 'Monthly' + (it.repeat_until ? ' to ' + dt(it.repeat_until) : '') : '—' }}</td>
          <td style="white-space:nowrap"><template v-if="isFin"><button class="btn sm" @click="editItem(it)">Edit</button> <button class="btn sm bad" @click="delItem(it)">✕</button></template></td></tr></tbody>
      </table></div>
    </div>
  </div>`,
  setup() { return { LINK, ITEM_CATS }; },
};
