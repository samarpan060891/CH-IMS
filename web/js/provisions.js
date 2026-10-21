// Provisions & accruals. Every automation is off until Finance switches it on: Finance can preview and post any of them for a
// month by hand, and "Automate at month end" makes Month end run it. Plus the accruals and prepayment-schedule documents.
import { sb, state, must, run, rpc, hasRole, go, today, refRow, refLabel, money, qty, dt, label, num, loadRefs, toast } from './lib.js';
import { ask, confirmBox, Badge, DataTable } from './components.js';

const isFin = () => hasRole('finance');
const monthStart = d => (d || today()).slice(0, 8) + '01';
const monthName = m => new Date(m + 'T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
const isHead = r => !r.is_group && r.is_active && r.acc_type === 'EXPENSE' && !['PROD_ABSORBED', 'LABOUR_ABSORBED', 'MAT_CONSUMED', 'COGS', 'DEPRECIATION'].includes(r.system_key);

const PCT_STEPS = [0, 5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 100];
const PCT_SMALL = [0, 0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10];
const MONTH_STEPS = [3, 6, 9, 12, 18, 24, 36];

// what each automation does, in the order shown
const ITEMS = [
  { key: 'ACCRUALS', title: 'Accruals for bills not yet received', kind: 'doc',
    what: 'At month end, suggests a draft accrual for every recurring bill whose bill for the month is not posted yet. Posting an accrual books the cost at month end and reverses it automatically on day 1 of the next month, so the real bill does not double count.',
    run: 'Suggest from recurring bills', link: 'd/acr' },
  { key: 'PREPAYMENTS', title: 'Prepayments spread over months', kind: 'doc',
    what: 'Releases each prepaid bill (insurance, rent in advance, licences…) to its expense head month by month. Schedules come from expense lines with “Spread over months”, or are added by hand.',
    run: 'Release due months', link: 'd/ppm' },
  { key: 'DOUBTFUL', title: 'Doubtful debts provision', kind: 'trueup', params: 'bands', basis: 'days overdue',
    what: 'Provides a % of every open customer invoice by how many days it is overdue, and adjusts the provision to that total each month (Dr Bad & doubtful debts / Cr Allowance).' },
  { key: 'SLOW_STOCK', title: 'Slow-moving stock provision', kind: 'trueup', params: 'bands', basis: 'days in stock',
    what: 'Provides a % of the value of stock lots by how long they have been in stock, adjusted each month (Dr Slow-moving stock provision / Cr Provision against stock).' },
  { key: 'WARRANTY', title: 'Warranty / defects liability provision', kind: 'trueup', params: 'pct_months',
    what: 'Keeps a provision of a % of contract revenue invoiced within the defects-liability period, less snag rework already spent in that period; older revenue drops out automatically (Dr Warranty provision / Cr Provision – warranty).' },
  { key: 'ACCRUED_REVENUE', title: 'Contract work done, not yet billed', kind: 'trueup', params: 'pct',
    what: 'Recognises site progress (earned value) not yet certified on a claim as revenue, adjusted each month; it falls away as claims are certified and posted (Dr Contract work not yet billed / Cr Contract revenue).' },
];

export const Provisions = {
  components: { DataTable, Badge },
  data: () => ({ month: monthStart(today()), settings: {}, preview: {}, runs: [], busy: null, loading: false }),
  computed: { ITEMS: () => ITEMS, isFin },
  async mounted() { await this.load(); },
  methods: {
    money, monthName, num,
    async load() {
      this.loading = true;
      await run(async () => {
        this.settings = Object.fromEntries(must(await sb.from('provision_settings').select('*')).map(s => [s.key, s]));
        this.runs = must(await sb.from('provision_runs').select('key,period_month,target,before,adjustment,automatic,run_at,je_id').order('run_at', { ascending: false }).limit(30));
      });
      this.loading = false;
    },
    async setAuto(it, v) {
      const s = this.settings[it.key];
      if (await run(async () => must(await sb.from('provision_settings').update({ automate: v, updated_by: state.profile?.id, updated_at: new Date().toISOString() }).eq('key', it.key)),
        v ? `${it.title}: will run at every month end` : `${it.title}: automation off`)) s.automate = v; else s.automate = !v;
    },
    async editParams(it) {
      const p = this.settings[it.key].params || {};
      let fields, toParams;
      // percentages and periods are picked from set steps, not typed
      const pick = (k, lbl, list, cur, unit) => ({ k, label: lbl, type: 'select', required: true, default: num(cur),
        options: [...new Set([...list, num(cur)])].sort((a, b) => a - b).map(x => ({ v: x, l: x + unit })) });
      if (it.params === 'bands') {
        const b = p.bands || [];
        fields = b.map((x, i) => pick('b' + i, `From ${x.from} ${it.basis}`, PCT_STEPS, x.pct, '%'));
        toParams = v => ({ bands: b.map((x, i) => ({ from: x.from, pct: num(v['b' + i]) })) });
      } else if (it.params === 'pct_months') {
        fields = [pick('p', '% of contract revenue', PCT_SMALL, p.pct, '%'), pick('m', 'Defects-liability period', MONTH_STEPS, p.months, ' months')];
        toParams = v => ({ pct: num(v.p), months: Math.max(1, Math.round(num(v.m))) });
      } else {
        fields = [pick('p', 'Share of unbilled earned value to recognise (100% = all)', PCT_STEPS, p.pct, '%')];
        toParams = v => ({ pct: num(v.p) });
      }
      const v = await ask({ title: it.title + ' — settings', fields, okText: 'Save' });
      if (!v) return;
      const params = toParams(v);
      if (await run(async () => must(await sb.from('provision_settings').update({ params, updated_by: state.profile?.id, updated_at: new Date().toISOString() }).eq('key', it.key)), 'Settings saved')) {
        this.settings[it.key].params = params; delete this.preview[it.key];
      }
    },
    paramText(it) {
      const p = this.settings[it.key]?.params || {};
      if (it.params === 'bands') return (p.bands || []).filter(b => num(b.pct)).map(b => `${b.from}+ ${it.basis.split(' ')[0]}: ${b.pct}%`).join(' · ') || 'no %';
      if (it.params === 'pct_months') return `${p.pct}% of revenue · ${p.months}-month defects period`;
      if (it.params === 'pct') return `${p.pct}% of unbilled earned value`;
      return '';
    },
    async doPreview(it) {
      this.busy = it.key;
      const r = await run(async () => must(await sb.rpc('provision_calc', { p_key: it.key, p_month: this.month })));
      if (r) this.preview = { ...this.preview, [it.key]: r };
      this.busy = null;
    },
    async doPost(it) {
      const p = this.preview[it.key];
      if (!(await confirmBox('Post ' + it.title, `Adjust the provision to AED ${money(p.target)} at the end of ${monthName(this.month)} — a journal of AED ${money(p.adjustment)}?`))) return;
      this.busy = it.key;
      const r = await run(async () => must(await sb.rpc('provision_post', { p_key: it.key, p_month: this.month, p_auto: false })), 'Posted');
      this.busy = null;
      if (r) { delete this.preview[it.key]; await this.load(); }
    },
    async runDoc(it) {
      this.busy = it.key;
      const n = await run(() => rpc(it.key === 'ACCRUALS' ? 'accrual_suggest' : 'prepayment_release', { p_month: this.month }));
      this.busy = null;
      if (n !== undefined && n !== null) toast(it.key === 'ACCRUALS' ? `${n} draft accrual(s) suggested — review and post them` : `${n} monthly release(s) posted`, 'ok', 6000);
    },
    lastRun(key) { return this.runs.find(r => r.key === key); },
  },
  template: `<div>
    <div class="card">
      <div class="row" style="flex-wrap:wrap;gap:10px;align-items:flex-end">
        <label class="f"><span>Month</span><input type="month" :value="month.slice(0,7)" @change="month = $event.target.value + '-01'; preview = {}"></label>
        <span class="muted small" style="max-width:640px">Nothing here posts by itself until you tick <b>Automate at month end</b>. Untick to stop. You can always preview and post any item for the chosen month by hand. Gratuity, leave salary and depreciation are always part of Month end.</span>
        <span class="spacer"></span><button class="btn" @click="go('books/periods')">Month end & period close →</button>
      </div>
    </div>
    <div v-for="it in ITEMS" :key="it.key" class="card prov">
      <div class="row" style="align-items:flex-start;gap:12px">
        <div style="flex:1;min-width:0">
          <h3 style="margin:0 0 4px">{{ it.title }}</h3>
          <div class="small muted">{{ it.what }}</div>
          <div class="small" v-if="it.params" style="margin-top:4px">Settings: <b>{{ paramText(it) }}</b>
            <a v-if="isFin" href="javascript:void 0" @click="editParams(it)" style="margin-left:6px">change</a></div>
          <div class="small muted" v-if="lastRun(it.key)" style="margin-top:2px">Last run: {{ monthName(lastRun(it.key).period_month) }} · to AED {{ money(lastRun(it.key).target) }} ({{ lastRun(it.key).automatic ? 'month end' : 'by hand' }})</div>
        </div>
        <label class="prov-auto" :class="{on: settings[it.key]?.automate}">
          <input type="checkbox" :checked="settings[it.key]?.automate" :disabled="!isFin" @change="setAuto(it, $event.target.checked)"> Automate at month end</label>
      </div>
      <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap" v-if="isFin">
        <template v-if="it.kind === 'trueup'">
          <button class="btn sm" :disabled="busy===it.key" @click="doPreview(it)">🔍 Preview for {{ monthName(month) }}</button>
          <button class="btn sm ok" v-if="preview[it.key] && Math.abs(num(preview[it.key].adjustment)) >= 0.01" :disabled="busy===it.key" @click="doPost(it)">✔ Post adjustment</button>
        </template>
        <template v-else>
          <button class="btn sm" :disabled="busy===it.key" @click="runDoc(it)">{{ it.run }} — {{ monthName(month) }}</button>
          <button class="btn sm" @click="go(it.link)">Open list</button>
        </template>
      </div>
      <div v-if="preview[it.key]" class="prov-prev">
        <div class="row" style="gap:18px;flex-wrap:wrap">
          <div><div class="muted small">Provision needed</div><b>AED {{ money(preview[it.key].target) }}</b></div>
          <div><div class="muted small">Already provided</div><b>AED {{ money(preview[it.key].current) }}</b></div>
          <div><div class="muted small">Adjustment to post</div><b :style="{color: num(preview[it.key].adjustment) < 0 ? '#15803d' : ''}">AED {{ money(preview[it.key].adjustment) }}</b></div>
        </div>
        <DataTable v-if="preview[it.key].detail?.length" :searchable="false" :limit="50" :rows="preview[it.key].detail"
          :columns="[{k:'label',label:'Basis'},{k:'note',label:''},{k:'basis',label:'Amount',fmt:'money'},{k:'pct',label:'%',n:true},{k:'amount',label:'Provision',fmt:'money',sum:true}]" />
        <div v-else class="small muted" style="margin-top:6px">Nothing to provide for this month.</div>
      </div>
    </div>
  </div>`,
  setup() { return { go }; },
};

// ======================================================================
// ACCRUALS (post → reverses itself on day 1 of the next month)
// ======================================================================
export const acr = {
  key: 'acr', title: 'Accruals', single: 'Accrual', table: 'accruals', noField: 'acr_no', dateField: 'acr_date',
  statuses: ['DRAFT', 'POSTED', 'CANCELLED'], createRoles: ['finance'], refs: ['gl_accounts', 'cost_centers', 'projects', 'vendors'],
  list: { select: '*, gl_accounts(code,name), cost_centers(code)', columns: [{ k: r => monthName(r.period_month), label: 'Month' }, { k: 'description', label: 'Description' },
    { k: r => `${r.gl_accounts?.code} ${r.gl_accounts?.name}`, label: 'Expense head' }, { k: r => r.cost_centers?.code, label: 'Cost centre' }, { k: 'amount', label: 'Amount', fmt: 'money', sum: true }] },
  defaults: () => ({ acr_date: today(), period_month: monthStart(today()) }),
  header: [
    { k: 'period_month', label: 'Accrue in month (any date in it)', type: 'date', required: true },
    { k: 'description', label: 'What for (e.g. October electricity — bill not received)', required: true, wide: true },
    { k: 'account_id', label: 'Expense head', type: 'ref', ref: 'gl_accounts', required: true, filter: isHead },
    { k: 'amount', label: 'Estimated amount (excl. VAT)', type: 'number', required: true },
    { k: 'cost_center_id', label: 'Cost centre', type: 'ref', ref: 'cost_centers' },
    { k: 'project_id', label: 'Project', type: 'ref', ref: 'projects' },
    { k: 'vendor_id', label: 'Supplier', type: 'ref', ref: 'vendors' },
  ],
  validate(ctx) { ctx.doc.period_month = monthStart(ctx.doc.period_month); },
  headerNote: () => 'Posting books the cost on the last day of the month (Dr expense / Cr Accrued expenses) and, at the same time, a reversal dated the 1st of the next month — when the real bill is posted the month carries only the actual cost.',
  actions: ctx => [
    { label: '✔ Post (auto-reverses next month)', cls: 'ok', show: ctx.doc.status === 'DRAFT' && isFin(), confirm: 'Post this accrual and its reversal on the 1st of next month?', done: 'Posted', run: c => rpc('accrual_action', { p_id: c.doc.id, p_action: 'POST' }) },
    { label: '📒 Journal', show: !!ctx.doc.je_id, reload: false, run: c => go('d/jv/' + c.doc.je_id) },
    { label: '📒 Reversal', show: !!ctx.doc.rev_je_id, reload: false, run: c => go('d/jv/' + c.doc.rev_je_id) },
    { label: 'Cancel', show: ctx.doc.status === 'DRAFT' && isFin(), confirm: 'Cancel this accrual?', run: c => rpc('accrual_action', { p_id: c.doc.id, p_action: 'CANCEL' }) },
  ],
};

// ======================================================================
// PREPAYMENT SCHEDULES
// ======================================================================
export const ppm = {
  key: 'ppm', title: 'Prepayments', single: 'Prepayment Schedule', table: 'prepayments', noField: 'pp_no', dateField: 'pp_date',
  statuses: ['ACTIVE', 'DONE', 'CANCELLED'], createRoles: ['finance'], editStatuses: ['ACTIVE'], refs: ['gl_accounts', 'cost_centers', 'projects'],
  canEdit: ctx => isFin() && (ctx.doc.status || 'ACTIVE') === 'ACTIVE' && !num(ctx.doc.released),
  list: { select: '*, gl_accounts!prepayments_account_id_fkey(code,name)', columns: [{ k: 'description', label: 'Prepaid' }, { k: r => `${r.gl_accounts?.code} ${r.gl_accounts?.name}`, label: 'Released to' },
    { k: r => `${monthName(r.start_month)} · ${r.months} months`, label: 'Period' }, { k: 'total', label: 'Total', fmt: 'money', sum: true },
    { k: 'released', label: 'Released', fmt: 'money', sum: true }, { k: r => num(r.total) - num(r.released), label: 'Still prepaid', fmt: 'money', sum: true }] },
  defaults: () => ({ pp_date: today(), start_month: monthStart(today()), months: 12, status: 'ACTIVE' }),
  header: [
    { k: 'description', label: 'What was prepaid (e.g. Factory insurance 2026–27)', required: true, wide: true },
    { k: 'total', label: 'Total prepaid (excl. VAT)', type: 'number', required: true },
    { k: 'start_month', label: 'First month', type: 'date', required: true },
    { k: 'months', label: 'Over how many months', type: 'number', required: true },
    { k: 'account_id', label: 'Release to expense head', type: 'ref', ref: 'gl_accounts', required: true, filter: isHead },
    { k: 'cost_center_id', label: 'Cost centre', type: 'ref', ref: 'cost_centers' },
    { k: 'project_id', label: 'Project', type: 'ref', ref: 'projects' },
    { k: 'released', label: 'Released so far', type: 'ro', fmt: v => money(v), show: d => !!d.id },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  validate(ctx) { ctx.doc.start_month = monthStart(ctx.doc.start_month); },
  headerNote: () => 'The bill itself must already sit in <b>Prepayments</b> (1430) — expense lines with “Spread over months” do that and create this schedule automatically. Each month the share moves to the expense head.',
  async loadInfo(ctx) {
    if (!ctx.doc.id) return [];
    const r = must(await sb.from('prepayment_releases').select('period_month,amount,je_id').eq('prepayment_id', ctx.doc.id).order('period_month'));
    return [{ title: 'Monthly releases', rows: r, columns: [{ k: r => monthName(r.period_month), label: 'Month' }, { k: 'amount', label: 'Released', fmt: 'money', sum: true }] }];
  },
  actions: ctx => [
    { label: '⏩ Release due months now', cls: 'primary', show: ctx.doc.status === 'ACTIVE' && isFin(), done: 'Released',
      run: async c => { const n = await rpc('prepayment_release', { p_month: today(), p_id: c.doc.id }); if (!n) toast('Nothing due yet', 'info'); } },
  ],
};

export const PROV_DOCS = { acr, ppm };
