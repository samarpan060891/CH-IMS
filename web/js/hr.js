// HR: employees (profile, pay & bank, documents with files, end-of-service), attendance sheet,
// leave requests, salary advances, payroll runs (payslips, WPS SIF). Pay data is readable only by HR, Finance and admin.
import { reactive } from 'vue';
import { sb, state, must, run, rpc, hasRole, go, today, refRow, refLabel, money, qty, dt, label, num, loadRef, loadRefs, toast } from './lib.js';
import { ask, confirmBox, Badge } from './components.js';
import { makePdf } from './pdf.js';
import { logoPng } from './logo.js';

const isHR = () => hasRole('hr_officer');
const empLabel = id => { const e = refRow('employees', id); return e ? `${e.name} (${e.emp_code})` : ''; };
const DOC_TYPES = ['PASSPORT', 'RESIDENCE_VISA', 'EMIRATES_ID', 'LABOUR_CARD', 'WORK_PERMIT', 'MEDICAL_INSURANCE', 'DRIVING_LICENCE', 'HEALTH_CARD', 'CONTRACT', 'OTHER'];
const EMP_STATUSES = ['ACTIVE', 'ON_LEAVE', 'RESIGNED', 'TERMINATED', 'ABSCONDED'];

// ======================================================================
// EMPLOYEE (HR view)
// ======================================================================
const PAY_FIELDS = [
  { k: 'basic', label: 'Basic', type: 'number' }, { k: 'housing', label: 'Housing', type: 'number' }, { k: 'transport', label: 'Transport', type: 'number' },
  { k: 'food', label: 'Food', type: 'number' }, { k: 'other_allowance', label: 'Other allowance', type: 'number' },
];
export const EmpHrPanel = {
  components: { Badge },
  props: { ctx: Object },
  data: () => ({ pay: null, exists: false, grat: null, docs: [], busy: false }),
  computed: {
    e() { return this.ctx.doc; },
    gross() { return PAY_FIELDS.reduce((s, f) => s + num(this.pay?.[f.k]), 0); },
    canEdit() { return isHR(); },
  },
  async mounted() { await this.load(); },
  methods: {
    money, dt, label, PAY_FIELDS,
    async load() {
      await run(async () => {
        const p = must(await sb.from('employee_pay').select('*').eq('employee_id', this.e.id).maybeSingle());
        this.exists = !!p;
        this.pay = p || { employee_id: this.e.id, basic: 0, housing: 0, transport: 0, food: 0, other_allowance: 0, ot_eligible: true, pay_mode: 'WPS_BANK', contract_type: 'LIMITED' };
        this.docs = must(await sb.from('employee_documents').select('*').eq('employee_id', this.e.id).order('doc_type'));
        if (this.e.joining_date && this.exists) this.grat = must(await sb.rpc('gratuity_calc', { p_emp: this.e.id }));
      });
    },
    async savePay() {
      this.busy = true;
      const row = { ...this.pay }; delete row.updated_at; row.updated_by = state.profile?.id;
      const ok = await run(async () => must(await sb.from('employee_pay').upsert(row, { onConflict: 'employee_id' })), 'Salary & bank details saved');
      this.busy = false; if (ok) await this.load();
    },
    async attach(d) {
      const f = await new Promise(res => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*,application/pdf'; i.onchange = () => res(i.files[0] || null); i.click(); });
      if (!f) return;
      const path = `${this.e.id}/${d.doc_type.toLowerCase()}-${Date.now()}.${(f.name.split('.').pop() || 'pdf').toLowerCase()}`;
      const ok = await run(async () => {
        must(await sb.storage.from('hr-docs').upload(path, f, { contentType: f.type }));
        must(await sb.from('employee_documents').update({ file_path: path }).eq('id', d.id));
      }, 'File attached');
      if (ok) await this.load();
    },
    async view(d) {
      const r = await run(async () => must(await sb.storage.from('hr-docs').createSignedUrl(d.file_path, 300)));
      if (r?.signedUrl) window.open(r.signedUrl, '_blank');
    },
    expiryClass(d) { if (!d.expiry_date) return ''; const days = (new Date(d.expiry_date) - new Date()) / 864e5; return days < 0 ? 'color:#b91c1c;font-weight:600' : days < 30 ? 'color:#b45309;font-weight:600' : ''; },
  },
  template: `<div>
    <div class="card" v-if="pay">
      <div class="hd"><h3>Salary & bank (visible to HR, Finance and admin only)</h3><span class="spacer"></span>
        <button v-if="canEdit" class="btn primary sm" :disabled="busy" @click="savePay">💾 Save salary & bank</button></div>
      <div class="grid">
        <label class="f" v-for="f in PAY_FIELDS" :key="f.k"><span>{{ f.label }} AED / month</span><input type="number" step="any" v-model.number="pay[f.k]" :disabled="!canEdit"></label>
        <label class="f"><span>Gross monthly</span><input :value="money(gross)" readonly></label>
        <label class="f"><span>Overtime eligible</span><select v-model="pay.ot_eligible" :disabled="!canEdit"><option :value="true">Yes</option><option :value="false">No (management / staff)</option></select></label>
        <label class="f"><span>Pay mode</span><select v-model="pay.pay_mode" :disabled="!canEdit"><option value="WPS_BANK">WPS — bank account</option><option value="WPS_EXCHANGE">WPS — exchange house / card</option><option value="CASH">Cash</option><option value="CHEQUE">Cheque</option></select></label>
        <label class="f"><span>Bank / exchange</span><input v-model="pay.bank_name" :disabled="!canEdit"></label>
        <label class="f wide"><span>IBAN / card no.</span><input v-model="pay.iban" :disabled="!canEdit"></label>
        <label class="f"><span>Agent routing code (9 digits)</span><input v-model="pay.agent_routing_code" :disabled="!canEdit"></label>
        <label class="f"><span>MOHRE personal no. (14 digits)</span><input v-model="pay.mol_person_id" :disabled="!canEdit"></label>
        <label class="f"><span>Contract</span><select v-model="pay.contract_type" :disabled="!canEdit"><option value="LIMITED">Limited (fixed term)</option><option value="UNLIMITED">Unlimited (old contracts)</option></select></label>
        <label class="f"><span>Contract end</span><input type="date" v-model="pay.contract_end" :disabled="!canEdit"></label>
      </div>
      <div v-if="grat" class="small" style="margin-top:10px;padding:8px 10px;background:#f8fafc;border:1px solid var(--line);border-radius:6px">
        <b>End of service to date:</b> {{ grat.service_years }} years of service ({{ grat.unpaid_days_excluded }} unpaid days excluded) ·
        gratuity <b>AED {{ money(grat.gratuity) }}</b> · annual leave balance {{ grat.leave_balance_days }} days (AED {{ money(grat.leave_encashment) }}) ·
        advances outstanding AED {{ money(grat.advances_outstanding) }}
      </div>
    </div>
    <div class="card" v-if="docs.length">
      <h3>Document files</h3>
      <table class="t"><thead><tr><th>Document</th><th>No.</th><th>Expiry</th><th>File</th><th></th></tr></thead>
        <tbody><tr v-for="d in docs" :key="d.id"><td>{{ label(d.doc_type) }}</td><td>{{ d.doc_no }}</td><td :style="expiryClass(d)">{{ dt(d.expiry_date) }}</td>
          <td>{{ d.file_path ? '📎 attached' : '—' }}</td>
          <td style="white-space:nowrap"><button v-if="d.file_path" class="btn sm" @click="view(d)">View</button>
            <button v-if="canEdit" class="btn sm" @click="attach(d)">{{ d.file_path ? 'Replace' : 'Attach' }}</button></td></tr></tbody></table>
    </div>
  </div>`,
};

async function eosDialog(c) {
  const v = await ask({ title: 'End of service — ' + c.doc.name, fields: [{ k: 'd', label: 'Last working day', type: 'date', required: true, default: c.doc.last_working_day || today() }], okText: 'Calculate' });
  if (!v) return false;
  const g = await rpc('gratuity_calc', { p_emp: c.doc.id, p_last_day: v.d });
  const total = num(g.gratuity) + num(g.leave_encashment) - num(g.advances_outstanding);
  await makePdf({ title: 'End of Service Settlement (draft)', no: c.doc.emp_code, date: v.d,
    meta: [['Employee', `${g.employee} (${c.doc.emp_code})`], ['Joining date', dt(g.joining_date)], ['Last working day', dt(g.last_day)],
           ['Service', `${g.service_years} years (${g.service_days} days; ${g.unpaid_days_excluded} unpaid days excluded)`], ['Basic salary', 'AED ' + money(g.basic)], ['Daily basic', 'AED ' + money(g.daily_basic)]],
    columns: [{ h: 'Component', k: 'c' }, { h: 'Basis', k: 'b' }, { h: 'AED', k: 'a', align: 'right' }],
    rows: [{ c: 'Gratuity', b: '21 days basic / year (first 5 years), 30 days after; capped at 2 years pay; none under 1 year', a: money(g.gratuity) },
           { c: 'Leave encashment', b: `${g.leave_balance_days} days unused annual leave × gross / 30`, a: money(g.leave_encashment) },
           { c: 'Less: advances outstanding', b: '', a: '-' + money(g.advances_outstanding) }],
    totals: [['Total due (excl. final month salary)', money(total)]],
    notes: 'Draft per UAE Federal Decree-Law 33 of 2021. Add the salary for the final month (payroll) and any other dues or deductions before final settlement.',
    signatures: ['Prepared by HR', 'Finance Manager', 'Employee'] });
  return false;
}

export const emp = {
  key: 'emp', title: 'Employees (HR)', single: 'Employee', table: 'employees', noField: 'emp_code', dateField: 'joining_date',
  statusField: 'emp_status', statuses: EMP_STATUSES, defaultTab: 'ACTIVE', createRoles: ['hr_officer'], canEdit: () => isHR(),
  refs: ['labour_grades', 'projects'], panel: EmpHrPanel,
  list: { select: '*', columns: [{ k: 'name', label: 'Name' }, { k: 'department', label: 'Department' }, { k: 'designation', label: 'Designation' },
    { k: 'nationality', label: 'Nationality' }, { k: r => refRow('labour_grades', r.grade_id)?.name, label: 'Grade' }, { k: 'work_location', label: 'Works at', fmt: 'label' }, { k: 'mobile', label: 'Mobile' }] },
  defaults: () => ({ emp_status: 'ACTIVE', work_location: 'FACTORY', joining_date: today(), is_active: true }),
  header: [
    { k: 'emp_code', label: 'Employee code', required: true }, { k: 'name', label: 'Full name (as passport)', required: true, wide: true },
    { k: 'department', label: 'Department', type: 'lookup', list: 'DEPARTMENT' }, { k: 'designation', label: 'Designation', type: 'lookup', list: 'DESIGNATION' },
    { k: 'grade_id', label: 'Worker grade (costing)', type: 'ref', ref: 'labour_grades' },
    { k: 'nationality', label: 'Nationality', type: 'lookup', list: 'NATIONALITY' }, { k: 'gender', label: 'Gender', type: 'select', options: [{ v: 'M', l: 'Male' }, { v: 'F', l: 'Female' }] },
    { k: 'date_of_birth', label: 'Date of birth', type: 'date' }, { k: 'joining_date', label: 'Joining date', type: 'date', required: true },
    { k: 'mobile', label: 'Mobile' }, { k: 'email', label: 'Email' },
    { k: 'work_location', label: 'Works at', type: 'select', required: true, options: ['FACTORY', 'SITE', 'OFFICE', 'CAMP'] },
    { k: 'accommodation', label: 'Accommodation (camp / room)', type: 'lookup', list: 'ACCOMMODATION' },
    { k: 'emp_status', label: 'Status', type: 'select', required: true, options: EMP_STATUSES },
    { k: 'last_working_day', label: 'Last working day', type: 'date', show: d => ['RESIGNED', 'TERMINATED', 'ABSCONDED'].includes(d.emp_status) },
    { k: 'is_active', label: 'Active', type: 'check' },
  ],
  headerNote: () => 'Profile details are visible to supervisors; <b>salary, bank and documents</b> only to HR, Finance and the administrator. Documents expiring within 30 / 15 / 7 days alert HR every morning.',
  grids: [{ key: 'docs', title: 'Documents', table: 'employee_documents', fk: 'employee_id', order: 'doc_type', lineNo: false,
    fields: [{ k: 'doc_type', label: 'Document', type: 'select', required: true, options: DOC_TYPES, width: '150px' }, { k: 'doc_no', label: 'Number', width: '150px' },
      { k: 'issue_date', label: 'Issued', type: 'date' }, { k: 'expiry_date', label: 'Expiry', type: 'date' }, { k: 'remarks', label: 'Remarks', width: '160px' }] }],
  actions: ctx => [
    { label: '🧾 End of service calculation', show: hasRole('hr_officer', 'finance') && !!ctx.doc.joining_date, reload: false, run: c => eosDialog(c) },
    { label: '🏖 New leave request', show: hasRole('hr_officer'), reload: false, run: c => go('d/leave/new/emp/' + c.doc.id) },
  ],
};

// ======================================================================
// ATTENDANCE SHEET (daily, by location)
// ======================================================================
export const AttendanceSheet = {
  components: { Badge },
  data: () => ({ date: today(), loc: '', rows: [], loading: false, busy: false, q: '' }),
  computed: {
    shown() { const q = this.q.toLowerCase(); return this.rows.filter(r => (!this.loc || r.work_location === this.loc) && (!q || `${r.name} ${r.emp_code}`.toLowerCase().includes(q))); },
    canEdit() { return hasRole('hr_officer', 'site_supervisor', 'shop_floor', 'production_incharge', 'factory_manager'); },
    summary() { const s = {}; this.shown.forEach(r => { s[r.status] = (s[r.status] || 0) + 1; }); return s; },
  },
  async mounted() { await loadRefs(['projects']); await this.load(); },
  watch: { date() { this.load(); } },
  methods: {
    label, qty,
    async load() {
      this.loading = true;
      await run(async () => {
        const emps = must(await sb.from('employees').select('id,emp_code,name,department,work_location,emp_status').in('emp_status', ['ACTIVE', 'ON_LEAVE']).order('name'));
        const att = must(await sb.from('attendance').select('*').eq('att_date', this.date));
        this.rows = emps.map(e => {
          const a = att.find(x => x.employee_id === e.id);
          return { ...e, att_id: a?.id, status: a?.status || 'PRESENT', normal_hours: a ? num(a.normal_hours) : 8, ot_hours: a ? num(a.ot_hours) : 0,
                   ot_hours_holiday: a ? num(a.ot_hours_holiday) : 0, project_id: a?.project_id || null, remarks: a?.remarks || '', saved: !!a, locked: ['LEAVE', 'SICK'].includes(a?.status) && !!a?.remarks };
        });
      });
      this.loading = false;
    },
    setAll(status) { this.shown.filter(r => !r.locked).forEach(r => { r.status = status; r.normal_hours = status === 'PRESENT' ? 8 : status === 'HALF_DAY' ? 4 : 0; if (status !== 'PRESENT') { r.ot_hours = 0; } }); },
    onStatus(r) { r.normal_hours = r.status === 'PRESENT' ? 8 : r.status === 'HALF_DAY' ? 4 : 0; if (!['PRESENT', 'HALF_DAY', 'WEEK_OFF', 'HOLIDAY'].includes(r.status)) { r.ot_hours = 0; r.ot_hours_holiday = 0; } },
    async save() {
      this.busy = true;
      const rows = this.shown.filter(r => !r.locked).map(r => ({ employee_id: r.id, att_date: this.date, status: r.status, work_location: r.work_location === 'CAMP' ? null : r.work_location,
        project_id: r.project_id || null, normal_hours: num(r.normal_hours), ot_hours: num(r.ot_hours), ot_hours_holiday: num(r.ot_hours_holiday), remarks: r.remarks || null }));
      const ok = await run(async () => { for (let i = 0; i < rows.length; i += 200) must(await sb.from('attendance').upsert(rows.slice(i, i + 200), { onConflict: 'employee_id,att_date' })); },
        `Attendance saved for ${rows.length} employee(s)`);
      this.busy = false; if (ok) await this.load();
    },
  },
  template: `<div>
    <div class="card"><div class="row" style="flex-wrap:wrap;gap:10px">
      <label class="f"><span>Date</span><input type="date" v-model="date"></label>
      <label class="f"><span>Location</span><select v-model="loc"><option value="">All</option><option value="FACTORY">Factory</option><option value="SITE">Site</option><option value="OFFICE">Office</option></select></label>
      <label class="f" style="min-width:180px"><span>Search</span><input v-model="q" placeholder="Name or code"></label>
      <span class="spacer"></span>
      <template v-if="canEdit"><button class="btn sm" @click="setAll('PRESENT')">All present</button><button class="btn sm" @click="setAll('WEEK_OFF')">All week-off</button>
        <button class="btn sm" @click="setAll('HOLIDAY')">All holiday</button><button class="btn primary" :disabled="busy" @click="save">💾 Save attendance</button></template>
    </div>
    <div class="small muted" style="margin-top:6px">{{ Object.entries(summary).map(([k, v]) => label(k) + ' ' + v).join(' · ') }} — overtime at 125% (normal) and 150% (night / rest day / holiday) is paid in payroll. Leave days come from approved leave requests.</div></div>
    <div class="card"><div class="tbl-wrap"><table class="t lines">
      <thead><tr><th>Employee</th><th>Status</th><th style="width:80px">Hours</th><th style="width:80px">OT 125%</th><th style="width:80px">OT 150%</th><th>Project (site)</th><th>Remarks</th></tr></thead>
      <tbody>
        <tr v-if="loading"><td colspan="7" class="empty">Loading…</td></tr>
        <tr v-for="r in shown" :key="r.id">
          <td><b>{{ r.name }}</b><div class="small muted">{{ r.emp_code }} · {{ r.department }}{{ r.saved ? '' : ' · not saved' }}</div></td>
          <td><select v-model="r.status" @change="onStatus(r)" :disabled="!canEdit || r.locked">
            <option v-for="s in ['PRESENT','ABSENT','HALF_DAY','WEEK_OFF','HOLIDAY','LEAVE','SICK']" :value="s">{{ label(s) }}</option></select></td>
          <td><input type="number" step="0.5" min="0" v-model.number="r.normal_hours" :disabled="!canEdit || r.locked"></td>
          <td><input type="number" step="0.5" min="0" v-model.number="r.ot_hours" :disabled="!canEdit || r.locked"></td>
          <td><input type="number" step="0.5" min="0" v-model.number="r.ot_hours_holiday" :disabled="!canEdit || r.locked"></td>
          <td><select v-model="r.project_id" :disabled="!canEdit || r.locked"><option :value="null">—</option>
            <option v-for="p in (state.refs.projects || []).filter(p => p.status === 'OPEN' && p.project_type === 'PROJECT')" :value="p.id">{{ p.code }}</option></select></td>
          <td><input v-model="r.remarks" :disabled="!canEdit || r.locked"></td>
        </tr>
      </tbody></table></div></div>
  </div>`,
};
AttendanceSheet.data = (orig => function () { return { ...orig(), state }; })(AttendanceSheet.data);

// ======================================================================
// LEAVE REQUEST
// ======================================================================
const dayCount = (a, b) => a && b ? Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5) + 1 : null;
export const leave = {
  key: 'leave', title: 'Leave Requests', single: 'Leave Request', table: 'leave_requests', noField: 'leave_no', dateField: 'from_date',
  statuses: ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'], createRoles: ['hr_officer', 'factory_manager', 'production_incharge', 'site_supervisor', 'shop_floor', 'stores'],
  editStatuses: ['DRAFT', 'REJECTED'], refs: ['employees', 'profiles'],
  list: { select: '*, employees(name,emp_code)', columns: [{ k: r => r.employees ? `${r.employees.name} (${r.employees.emp_code})` : '', label: 'Employee' },
    { k: 'leave_type', label: 'Type', fmt: 'label' }, { k: 'to_date', label: 'To', fmt: 'date' }, { k: 'days', label: 'Days', n: true }, { k: 'reason', label: 'Reason' }] },
  defaults: () => ({ leave_type: 'ANNUAL', from_date: today(), to_date: today(), days: 1 }),
  async onNew(ctx, parts) { if (parts[0] === 'emp' && parts[1]) ctx.doc.employee_id = parts[1]; await loadRef('employees', true); await leaveInfo(ctx); },
  async afterLoad(ctx) { await leaveInfo(ctx); },
  header: [
    { k: 'employee_id', label: 'Employee', type: 'ref', ref: 'employees', required: true, wide: true, filter: r => r.is_active, onChange: (d, v, ctx) => leaveInfo(ctx) },
    { k: 'leave_type', label: 'Leave type', type: 'select', required: true, options: [{ v: 'ANNUAL', l: 'Annual leave' }, { v: 'SICK_FULL', l: 'Sick — full pay (first 15 days)' },
      { v: 'SICK_HALF', l: 'Sick — half pay (next 30 days)' }, { v: 'SICK_UNPAID', l: 'Sick — unpaid (next 45 days)' }, { v: 'MATERNITY', l: 'Maternity' }, { v: 'PARENTAL', l: 'Parental' },
      { v: 'BEREAVEMENT', l: 'Bereavement' }, { v: 'HAJJ', l: 'Hajj / Umrah (unpaid)' }, { v: 'UNPAID', l: 'Unpaid leave' }, { v: 'EMERGENCY', l: 'Emergency leave' }] },
    { k: 'from_date', label: 'From', type: 'date', required: true, onChange: d => { d.days = dayCount(d.from_date, d.to_date); } },
    { k: 'to_date', label: 'To', type: 'date', required: true, onChange: d => { d.days = dayCount(d.from_date, d.to_date); } },
    { k: 'days', label: 'Days (calendar)', type: 'number', required: true },
    { k: 'ticket_eligible', label: 'Air ticket due', type: 'check' },
    { k: 'return_date', label: 'Actual return date', type: 'date', show: d => d.status === 'APPROVED' },
    { k: 'approved_by', label: 'Approved / rejected by', type: 'ro', fmt: (v, d) => v ? `${refLabel('profiles', v)} · ${dt(d.approved_at)}${d.approval_comments ? ' — ' + d.approval_comments : ''}` : '', show: d => !!d.approved_by, wide: true },
    { k: 'reason', label: 'Reason / remarks', type: 'textarea', full: true },
  ],
  headerNote: ctx => ctx.extra.bal ? `Annual leave balance: <b>${qty(ctx.extra.bal.balance)} days</b> (accrued ${qty(ctx.extra.bal.accrued)}, taken ${qty(ctx.extra.bal.taken)}) · sick leave this year: ${qty(ctx.extra.bal.sick_this_year)} days. ` +
    'UAE: annual leave accrues 2 days / month after 6 months, 30 days a year after the first year. Approved leave is written into attendance and paid / deducted in payroll.' : '',
  validate(ctx) { if (ctx.doc.to_date < ctx.doc.from_date) throw new Error('To date is before from date'); },
  actions: ctx => {
    const s = ctx.doc.status;
    return [
      { label: 'Submit', cls: 'primary', show: ['DRAFT', 'REJECTED'].includes(s), done: 'Sent to HR', run: c => rpc('leave_action', { p_id: c.doc.id, p_action: 'SUBMIT' }) },
      { label: '✔ Approve', cls: 'ok', show: s === 'PENDING' && hasRole('hr_officer', 'factory_manager'), done: 'Leave approved',
        run: async c => { const v = await ask({ title: 'Approve leave', fields: [{ k: 'c', label: 'Comments (needed when beyond the balance)', type: 'textarea' }], okText: 'Approve' });
          if (!v) return false; return rpc('leave_action', { p_id: c.doc.id, p_action: 'APPROVE', p_comments: v.c || null }); } },
      { label: '✖ Reject', cls: 'bad', show: s === 'PENDING' && hasRole('hr_officer', 'factory_manager'), done: 'Leave rejected',
        run: async c => { const v = await ask({ title: 'Reject leave', fields: [{ k: 'c', label: 'Reason', type: 'textarea', required: true }], okText: 'Reject', danger: true });
          if (!v) return false; return rpc('leave_action', { p_id: c.doc.id, p_action: 'REJECT', p_comments: v.c }); } },
      { label: 'Cancel', show: ['DRAFT', 'PENDING'].includes(s) || (s === 'APPROVED' && hasRole('hr_officer')), confirm: 'Cancel this leave?', done: 'Cancelled',
        run: c => rpc('leave_action', { p_id: c.doc.id, p_action: 'CANCEL' }) },
    ];
  },
};
async function leaveInfo(ctx) {
  ctx.extra.bal = ctx.doc.employee_id ? must(await sb.from('v_leave_balance').select('*').eq('employee_id', ctx.doc.employee_id).maybeSingle()) : null;
}

// ======================================================================
// SALARY ADVANCE
// ======================================================================
export const adv = {
  key: 'adv', title: 'Salary Advances', single: 'Salary Advance', table: 'employee_advances', noField: 'adv_no', dateField: 'adv_date',
  statuses: ['DRAFT', 'APPROVED', 'CLOSED', 'CANCELLED'], createRoles: ['hr_officer'], refs: ['employees', 'profiles'],
  list: { select: '*, employees(name,emp_code)', columns: [{ k: r => r.employees ? `${r.employees.name} (${r.employees.emp_code})` : '', label: 'Employee' },
    { k: 'amount', label: 'Amount', fmt: 'money', sum: true }, { k: 'installment', label: 'Monthly recovery', fmt: 'money' }, { k: 'recovered', label: 'Recovered', fmt: 'money', sum: true },
    { k: r => num(r.amount) - num(r.recovered), label: 'Balance', fmt: 'money', sum: true }] },
  defaults: () => ({ adv_date: today() }),
  header: [
    { k: 'employee_id', label: 'Employee', type: 'ref', ref: 'employees', required: true, wide: true, filter: r => r.is_active },
    { k: 'adv_date', label: 'Date', type: 'date', required: true },
    { k: 'amount', label: 'Amount AED', type: 'number', required: true }, { k: 'installment', label: 'Recover per month AED', type: 'number', required: true },
    { k: 'recovered', label: 'Recovered so far', type: 'ro', fmt: v => money(v), show: d => !!d.id },
    { k: 'approved_by', label: 'Approved by (Finance)', type: 'ro', fmt: (v, d) => v ? `${refLabel('profiles', v)} · ${dt(d.approved_at)}` : '', show: d => !!d.approved_by },
    { k: 'reason', label: 'Reason', type: 'textarea', full: true },
  ],
  headerNote: () => 'HR records the advance; <b>Finance approves</b>. The monthly instalment is deducted in payroll until the advance is fully recovered.',
  actions: ctx => [
    { label: '✔ Approve (Finance)', cls: 'ok', show: ctx.doc.status === 'DRAFT' && hasRole('finance'), done: 'Advance approved', run: c => rpc('advance_action', { p_id: c.doc.id, p_action: 'APPROVE' }) },
    { label: 'Cancel', show: ctx.doc.status === 'DRAFT' && hasRole('hr_officer', 'finance'), confirm: 'Cancel this advance?', run: c => rpc('advance_action', { p_id: c.doc.id, p_action: 'CANCEL' }) },
  ],
};

// ======================================================================
// PAYROLL RUN
// ======================================================================
const monthStart = v => v ? v.slice(0, 7) + '-01' : v;
export const payroll = {
  key: 'payroll', title: 'Payroll', single: 'Payroll Run', table: 'payroll_runs', noField: 'run_no', dateField: 'period_month',
  statuses: ['DRAFT', 'SUBMITTED', 'APPROVED', 'PAID', 'CANCELLED'], createRoles: ['hr_officer'], refs: ['employees', 'profiles'],
  list: { select: '*', columns: [{ k: r => new Date(r.period_month + 'T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), label: 'Month' },
    { k: 'employees', label: 'Employees', n: true }, { k: 'total_gross', label: 'Gross', fmt: 'money', sum: true }, { k: 'total_deductions', label: 'Deductions', fmt: 'money', sum: true },
    { k: 'total_net', label: 'Net pay', fmt: 'money', sum: true }] },
  defaults: () => ({ period_month: monthStart(today()) }),
  header: [
    { k: 'period_month', label: 'Salary month (any date in the month)', type: 'date', required: true },
    { k: 'employees', label: 'Employees', type: 'ro', show: d => !!d.id }, { k: 'total_gross', label: 'Gross AED', type: 'ro', fmt: v => money(v), show: d => !!d.id },
    { k: 'total_deductions', label: 'Deductions AED', type: 'ro', fmt: v => money(v), show: d => !!d.id }, { k: 'total_net', label: 'Net pay AED', type: 'ro', fmt: v => money(v), show: d => !!d.id },
    { k: 'calculated_at', label: 'Calculated', type: 'ro', fmt: v => v ? new Date(v).toLocaleString('en-GB') : 'not yet', show: d => !!d.id },
    { k: 'approved_by', label: 'Approved (Finance)', type: 'ro', fmt: (v, d) => v ? `${refLabel('profiles', v)} · ${dt(d.approved_at)}` : '', show: d => !!d.approved_by },
    { k: 'approval_comments', label: 'Finance comments', type: 'ro', wide: true, show: d => !!d.approval_comments },
    { k: 'payment_ref', label: 'Payment reference', type: 'ro', show: d => !!d.payment_ref },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  headerNote: () => 'HR <b>calculates</b> from salary, attendance (absent, overtime), approved leave (unpaid / half-pay) and advances, adds bonuses or deductions, then <b>submits</b>. ' +
    '<b>Finance approves</b>; then download the <b>WPS SIF</b> file for the bank and mark the run paid (advances are recovered). Salary basis: 30 days; overtime on basic ÷ 30 ÷ 8.',
  validate(ctx) { ctx.doc.period_month = monthStart(ctx.doc.period_month); },
  grids: [{ key: 'lines', title: 'Employees', table: 'payroll_lines', fk: 'run_id', order: 'id', lineNo: false, addable: false,
    readonly: ctx => ctx.doc.status !== 'DRAFT' || !isHR(),
    fields: [
      { k: 'employee_id', label: 'Employee', type: 'ro', fmt: v => empLabel(v), width: '190px' },
      { k: 'paid_days', label: 'Days', type: 'ro', fmt: v => qty(v) }, { k: 'unpaid_days', label: 'Unpaid', type: 'ro', fmt: v => num(v) ? qty(v) : '' },
      { k: 'fixed_earned', label: 'Salary', type: 'ro', fmt: v => money(v) },
      { k: 'ot_amount', label: 'Overtime', type: 'ro', fmt: (v, r) => num(v) ? `${money(v)} (${qty(r.ot_hours)}+${qty(r.ot_hours_holiday)}h)` : '' },
      { k: 'additions', label: 'Bonus / additions', type: 'number' }, { k: 'addition_note', label: 'Note', width: '110px' },
      { k: 'unpaid_deduction', label: 'Unpaid ded.', type: 'ro', fmt: v => num(v) ? money(v) : '' },
      { k: 'advance_recovery', label: 'Advance', type: 'ro', fmt: v => num(v) ? money(v) : '' },
      { k: 'other_deductions', label: 'Other ded.', type: 'number' }, { k: 'deduction_note', label: 'Note', width: '110px' },
      { k: 'net', label: 'Net pay', type: 'ro', fmt: v => money(v) }, { k: 'pay_mode', label: 'Mode', type: 'ro', fmt: v => label(v || '') }] }],
  totals: ctx => [{ l: 'Gross', v: ctx.grids.lines.reduce((s, r) => s + num(r.fixed_earned) + num(r.ot_amount) + num(r.additions), 0) },
    { l: 'Deductions', v: ctx.grids.lines.reduce((s, r) => s + num(r.unpaid_deduction) + num(r.advance_recovery) + num(r.other_deductions), 0) },
    { l: 'Net pay', v: ctx.grids.lines.reduce((s, r) => s + num(r.net), 0) }],
  async afterLoad() { await loadRef('employees', true); },
  actions: ctx => {
    const s = ctx.doc.status;
    return [
      { label: '🧮 Calculate', cls: 'primary', show: s === 'DRAFT' && isHR(), done: 'Payroll calculated', run: c => rpc('payroll_calculate', { p_run: c.doc.id }) },
      { label: 'Submit to Finance', show: s === 'DRAFT' && isHR() && !!ctx.doc.calculated_at, confirm: 'Submit this payroll to Finance for approval?', done: 'Sent to Finance',
        run: c => rpc('payroll_action', { p_run: c.doc.id, p_action: 'SUBMIT' }) },
      { label: '✔ Approve (Finance)', cls: 'ok', show: s === 'SUBMITTED' && hasRole('finance'), done: 'Payroll approved',
        run: async c => { const v = await ask({ title: 'Approve payroll', fields: [{ k: 'c', label: 'Comments (optional)', type: 'textarea' }], okText: 'Approve' });
          if (!v) return false; return rpc('payroll_action', { p_run: c.doc.id, p_action: 'APPROVE', p_comments: v.c || null }); } },
      { label: '↩ Return to HR', cls: 'bad', show: s === 'SUBMITTED' && hasRole('finance'), done: 'Returned to HR',
        run: async c => { const v = await ask({ title: 'Return payroll', fields: [{ k: 'c', label: 'What must be corrected?', type: 'textarea', required: true }], okText: 'Return' });
          if (!v) return false; return rpc('payroll_action', { p_run: c.doc.id, p_action: 'RETURN', p_comments: v.c }); } },
      { label: '🏦 WPS file (SIF)', show: ['APPROVED', 'PAID'].includes(s) && hasRole('hr_officer', 'finance'), reload: false, run: c => wpsFile(c) },
      { label: '✔ Mark paid', cls: 'ok', show: s === 'APPROVED' && hasRole('finance'), done: 'Payroll marked paid — advances recovered',
        run: async c => { const v = await ask({ title: 'Salaries paid', fields: [{ k: 'r', label: 'Bank / WPS payment reference', required: true }], okText: 'Mark paid' });
          if (!v) return false; return rpc('payroll_action', { p_run: c.doc.id, p_action: 'PAID', p_comments: v.r }); } },
      { label: '🖨 Payslips', show: !!ctx.doc.calculated_at, reload: false, run: c => payslips(c) },
      { label: 'Cancel run', show: ['DRAFT', 'SUBMITTED'].includes(s) && hasRole('hr_officer', 'finance'), confirm: 'Cancel this payroll run?', run: c => rpc('payroll_action', { p_run: c.doc.id, p_action: 'CANCEL' }) },
    ];
  },
};

async function wpsFile(c) {
  const rows = must(await sb.rpc('payroll_wps_sif', { p_run: c.doc.id }));
  const text = rows.map(r => r.line).join('\r\n') + '\r\n';
  const now = new Date(); const p = n => String(n).padStart(2, '0');
  const name = `${state.company?.mol_establishment_id || 'WPS'}${String(now.getFullYear()).slice(2)}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.SIF`;
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = name; a.click(); URL.revokeObjectURL(a.href);
  toast(`${name} downloaded — ${rows.length - 1} salary record(s). Upload it to the bank / exchange WPS portal.`, 'ok', 8000);
}

async function payslips(c) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const logo = await logoPng().catch(() => null);
  const month = new Date(c.doc.period_month + 'T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const pays = Object.fromEntries(must(await sb.from('employee_pay').select('employee_id,basic,housing,transport,food,other_allowance,bank_name,iban')).map(p => [p.employee_id, p]));
  const emps = Object.fromEntries(must(await sb.from('employees').select('id,emp_code,name,designation,department,joining_date')).map(e => [e.id, e]));
  c.grids.lines.forEach((l, i) => {
    if (i) doc.addPage();
    const e = emps[l.employee_id] || {}, p = pays[l.employee_id] || {};
    doc.setFillColor(27, 58, 107); doc.rect(0, 0, W, 3, 'F');
    if (logo) doc.addImage(logo, 'PNG', 12, 6, 20, 20);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(40); doc.text(state.company?.company_name || 'Citi Homes', 36, 13);
    doc.setFontSize(14); doc.setTextColor(27, 58, 107); doc.text('PAYSLIP — ' + month.toUpperCase(), 36, 21);
    doc.setFontSize(9); doc.setTextColor(30); doc.setFont('helvetica', 'normal');
    [['Employee', `${e.name || ''} (${e.emp_code || ''})`], ['Designation', e.designation || '-'], ['Department', e.department || '-'], ['Joining date', dt(e.joining_date)],
     ['Paid days', `${qty(l.paid_days)}${num(l.unpaid_days) ? ' (unpaid ' + qty(l.unpaid_days) + ')' : ''}`], ['Bank', `${p.bank_name || ''} ${p.iban ? '· ' + p.iban : ''}`]]
      .forEach(([k, v], j) => { const x = j % 2 ? W / 2 + 2 : 14, y = 34 + Math.floor(j / 2) * 6; doc.setFont('helvetica', 'bold'); doc.text(k + ':', x, y); doc.setFont('helvetica', 'normal'); doc.text(String(v), x + 26, y); });
    const earn = [['Basic', p.basic], ['Housing', p.housing], ['Transport', p.transport], ['Food', p.food], ['Other allowance', p.other_allowance]].filter(x => num(x[1]))
      .map(([k, v]) => [k, money(num(v) * num(l.paid_days) / 30)]);
    if (num(l.ot_amount)) earn.push([`Overtime (${qty(l.ot_hours)} h @125%, ${qty(l.ot_hours_holiday)} h @150%)`, money(l.ot_amount)]);
    if (num(l.additions)) earn.push([l.addition_note || 'Additions', money(l.additions)]);
    const ded = [];
    if (num(l.unpaid_deduction)) ded.push([`Unpaid days (${qty(l.unpaid_days)})`, money(l.unpaid_deduction)]);
    if (num(l.advance_recovery)) ded.push(['Advance recovery', money(l.advance_recovery)]);
    if (num(l.other_deductions)) ded.push([l.deduction_note || 'Other deductions', money(l.other_deductions)]);
    const n = Math.max(earn.length, ded.length);
    doc.autoTable({ startY: 56, head: [['Earnings', 'AED', 'Deductions', 'AED']],
      body: Array.from({ length: n }, (_, k) => [earn[k]?.[0] || '', earn[k]?.[1] || '', ded[k]?.[0] || '', ded[k]?.[1] || '']),
      foot: [['Gross', money(num(l.fixed_earned) + num(l.ot_amount) + num(l.additions)), 'Total deductions', money(num(l.unpaid_deduction) + num(l.advance_recovery) + num(l.other_deductions))]],
      styles: { fontSize: 9 }, headStyles: { fillColor: [27, 58, 107] }, footStyles: { fillColor: [238, 240, 243], textColor: 30 },
      columnStyles: { 1: { halign: 'right' }, 3: { halign: 'right' } }, margin: { left: 14, right: 14 } });
    const y = doc.lastAutoTable.finalY + 10;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text(`NET PAY: AED ${money(l.net)}`, W - 14, y, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(120);
    doc.text('Computer-generated payslip · CitiCore', 14, y + 14);
  });
  doc.save(`Payslips-${c.doc.period_month.slice(0, 7)}.pdf`);
}

export const HR_DOCS = { emp, leave, adv, payroll };
