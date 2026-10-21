// Approvals app: phone-first inbox of everything waiting for the signed-in person's decision, across modules.
// Each queue reuses the same server action as its full screen; "Open" goes to the full document for details or edits.
import { sb, must, run, rpc, hasRole, canSeeCost, today, num, qty, money, dt, label, go, toast } from './lib.js';
import { ask, confirmBox, Badge } from './components.js';
import { qcDecide } from './production.js';

const ago = d => { const n = Math.floor((Date.now() - new Date(d).getTime()) / 864e5); return n <= 0 ? 'today' : n === 1 ? '1 day' : n + ' days'; };
const reason = async title => (await ask({ title, fields: [{ k: 'r', label: 'Reason', type: 'textarea', required: true }], okText: 'Send', danger: true }))?.r;
const comment = async (title, ok = 'Approve') => ask({ title, fields: [{ k: 'c', label: 'Comments (optional)', type: 'textarea' }], okText: ok });
const approveReject = (fn, idKey, rejectWord = 'REJECT') => [
  { label: '✔ Approve', cls: 'ok', run: async r => { const v = await comment('Approve ' + r.no); if (!v) return false; return rpc(fn, { [idKey]: r.id, p_action: 'APPROVE', p_comments: v.c || null }); } },
  { label: '✖ Reject', cls: 'bad', run: async r => { const x = await reason('Reject ' + r.no); if (!x) return false; return rpc(fn, { [idKey]: r.id, p_action: rejectWord, p_comments: x }); } }];

// queue: who sees it, how to load it (rows mapped to cards) and the decisions on a card
const QUEUES = [
  { k: 'po', t: 'Purchase orders', roles: ['factory_manager', 'finance'],
    load: async () => {
      const st = [hasRole('factory_manager') && 'PENDING_FM', hasRole('finance') && 'PENDING_FINANCE'].filter(Boolean);
      return must(await sb.from('purchase_orders').select('id,po_no,status,total_aed,currency,total_amount,submitted_at,created_at,vendors(name),projects(code),po_lines(count)').in('status', st).order('submitted_at'))
        .map(p => ({ id: p.id, no: p.po_no, title: p.vendors?.name, sub: `${p.projects?.code || 'Stock'} · ${p.po_lines?.[0]?.count || 0} line(s) · ${label(p.status)}`,
                     amount: p.total_aed, at: p.submitted_at || p.created_at, link: 'd/po/' + p.id }));
    }, actions: approveReject('po_action', 'p_po') },
  { k: 'potop', t: 'POs: top-management approval', roles: ['purchase', 'finance'],
    load: async () => must(await sb.from('purchase_orders').select('id,po_no,total_aed,created_at,vendors(name),projects(code)').eq('status', 'PENDING_TOP_MGMT').order('created_at'))
      .map(p => ({ id: p.id, no: p.po_no, title: p.vendors?.name, sub: (p.projects?.code || 'Stock') + ' · record the parent-system approval', amount: p.total_aed, at: p.created_at, link: 'd/po/' + p.id })),
    actions: [
      { label: '✔ Record approval', cls: 'ok', run: async r => {
        const v = await ask({ title: 'Top management approval — ' + r.no, fields: [{ k: 'ref', label: 'Approval reference no.', required: true }, { k: 'date', label: 'Approval date', type: 'date', default: today() }, { k: 'c', label: 'Comments', type: 'textarea' }] });
        if (!v) return false; return rpc('po_action', { p_po: r.id, p_action: 'APPROVE', p_comments: v.c || null, p_ref_no: v.ref, p_ref_date: v.date || null, p_doc_url: null }); } },
      { label: '✖ Rejected', cls: 'bad', run: async r => { const x = await reason('Top management rejected ' + r.no); if (!x) return false; return rpc('po_action', { p_po: r.id, p_action: 'REJECT', p_comments: x }); } }] },
  { k: 'mr', t: 'Material requests', roles: ['production_incharge'],
    load: async () => must(await sb.from('material_requests').select('id,mr_no,priority,created_at,profiles:requested_by(full_name),projects(code),cost_centers(code),mr_lines(item_id,requested_qty,items(code,uoms(code)))').eq('status', 'PENDING_APPROVAL').order('created_at'))
      .map(m => ({ id: m.id, no: m.mr_no, title: m.profiles?.full_name || '', sub: m.projects?.code || m.cost_centers?.code, urgent: m.priority === 'URGENT', at: m.created_at, link: 'd/mr/' + m.id,
                   lines: m.mr_lines.map(l => `${l.items?.code} × ${qty(l.requested_qty)} ${l.items?.uoms?.code || ''}`) })),
    actions: approveReject('mr_action', 'p_mr').map(a => a.cls === 'ok' ? { ...a, run: r => rpc('mr_action', { p_mr: r.id, p_action: 'APPROVE' }) } : a) },
  { k: 'budget', t: 'Issues over project budget', roles: ['factory_manager'],
    load: async () => must(await sb.from('material_issues').select('id,issue_no,created_at,budget_requested_at,projects(code,name)').eq('status', 'DRAFT').not('budget_requested_at', 'is', null).is('budget_approved_by', null).order('budget_requested_at'))
      .map(i => ({ id: i.id, no: i.issue_no, title: i.projects ? `${i.projects.code} — ${i.projects.name}` : '', sub: 'Material issue above the project material budget', at: i.budget_requested_at, link: 'd/issue/' + i.id })),
    actions: [{ label: '✔ Allow', cls: 'ok', run: async r => { const x = await reason('Why allow the over-budget issue ' + r.no + '?'); if (!x) return false; return rpc('issue_budget_approve', { p_issue: r.id, p_note: x }); } }] },
  { k: 'adj', t: 'Stock adjustments', roles: ['factory_manager'],
    load: async () => must(await sb.from('stock_adjustments').select('id,adj_no,reason,total_value,created_at,locations(code)').eq('status', 'PENDING_APPROVAL').order('created_at'))
      .map(a => ({ id: a.id, no: a.adj_no, title: label(a.reason), sub: a.locations?.code, amount: a.total_value, at: a.created_at, link: 'd/adj/' + a.id })),
    actions: approveReject('adj_action', 'p_adj').map(a => a.cls === 'ok' ? { ...a, run: r => rpc('adj_action', { p_adj: r.id, p_action: 'APPROVE' }) } : a) },
  { k: 'scrap', t: 'Scrap notes', roles: ['factory_manager'],
    load: async () => must(await sb.from('scrap_notes').select('id,scrap_no,scrap_type,reason,total_value,created_at,projects(code)').eq('status', 'PENDING_APPROVAL').order('created_at'))
      .map(s => ({ id: s.id, no: s.scrap_no, title: label(s.scrap_type), sub: [s.projects?.code, s.reason].filter(Boolean).join(' · '), amount: s.total_value, at: s.created_at, link: 'd/scrap/' + s.id })),
    actions: approveReject('scrap_action', 'p_scr').map(a => a.cls === 'ok' ? { ...a, run: r => rpc('scrap_action', { p_scr: r.id, p_action: 'APPROVE' }) } : a) },
  { k: 'qc', t: 'QC rejects', roles: ['factory_manager'],
    load: async () => must(await sb.from('wo_receipts').select('*, production_orders!wo_receipts_wo_id_fkey(wo_no,description)').eq('qc_status', 'PENDING_FM').order('created_at'))
      .map(x => ({ id: x.id, no: x.receipt_no, title: `${x.production_orders?.wo_no} — ${x.production_orders?.description || ''}`, sub: `proposed ${qty(x.rework_qty)} rework, ${qty(x.scrap_qty)} scrap${x.remarks ? ' · ' + x.remarks : ''}`,
                   amount: num(x.rework_value) + num(x.scrap_value), at: x.created_at, link: 'd/wo/' + x.wo_id, raw: x })),
    actions: [{ label: '⚖ Decide', cls: 'ok', run: r => qcDecide(r.raw, r.raw.production_orders?.wo_no) }] },
  { k: 'offcut', t: 'Offcuts keep / scrap', roles: ['production_incharge', 'factory_manager'],
    load: async () => {
      const st = [hasRole('production_incharge') && 'PENDING_PI', hasRole('factory_manager') && 'PENDING_FM'].filter(Boolean);
      return must(await sb.from('material_returns').select('id,return_no,status,returned_by_name,offcut_comments,created_at,return_lines(id,condition,offcut_length_mm,offcut_width_mm,pieces,offcut_action,items(code))').in('status', st).order('created_at'))
        .map(x => ({ id: x.id, no: x.return_no, title: x.returned_by_name || '', sub: (x.status === 'PENDING_PI' ? 'Choose keep or scrap' : 'In-charge proposed') + (x.offcut_comments ? ' · ' + x.offcut_comments : ''), at: x.created_at, link: 'd/ret/' + x.id,
                     status: x.status, oc: x.return_lines.filter(l => l.condition === 'OFFCUT').map(l => ({ ...l, _act: l.offcut_action || 'KEEP' })) }));
    },
    actions: [
      { label: '✔ Send to FM', cls: 'ok', show: r => r.status === 'PENDING_PI', run: r => rpc('return_offcut_action', { p_ret: r.id, p_action: 'PROPOSE', p_lines: r.oc.map(l => ({ id: l.id, action: l._act })), p_comments: null }) },
      { label: '✔ Approve', cls: 'ok', show: r => r.status === 'PENDING_FM', run: r => rpc('return_offcut_action', { p_ret: r.id, p_action: 'APPROVE', p_comments: null }) },
      { label: '↩ Send back', cls: 'bad', show: r => r.status === 'PENDING_FM', run: async r => { const x = await reason('Send back ' + r.no); if (!x) return false; return rpc('return_offcut_action', { p_ret: r.id, p_action: 'SEND_BACK', p_comments: x }); } }] },
  { k: 'rel', t: 'Project stock releases', roles: ['factory_manager', 'finance'],
    load: async () => {
      const st = [hasRole('factory_manager') && 'PENDING_APPROVAL', hasRole('finance') && 'PENDING_FINANCE'].filter(Boolean);
      return must(await sb.from('stock_releases').select('id,release_no,status,reason,total_value,submitted_at,created_at,p:projects!stock_releases_project_id_fkey(code),t:projects!stock_releases_target_project_id_fkey(code)').in('status', st).order('created_at'))
        .map(x => ({ id: x.id, no: x.release_no, title: `${x.p?.code} → ${x.t?.code || 'general stock'}`, sub: (x.status === 'PENDING_FINANCE' ? 'FM approved · final approval' : '') + (x.reason ? ' ' + x.reason : ''), amount: x.total_value, at: x.submitted_at || x.created_at, link: 'd/rel/' + x.id }));
    }, actions: approveReject('release_action', 'p_rel') },
  { k: 'vo', t: 'Variation orders', roles: ['factory_manager'],
    load: async () => must(await sb.from('variation_orders').select('id,vo_no,title,value_change,submitted_at,created_at,projects(code)').eq('status', 'SUBMITTED').order('submitted_at'))
      .map(v => ({ id: v.id, no: v.vo_no, title: v.title, sub: v.projects?.code, amount: v.value_change, at: v.submitted_at || v.created_at, link: 'd/vo/' + v.id })),
    actions: [{ label: '✔ Approve', cls: 'ok', run: r => rpc('vo_action', { p_vo: r.id, p_action: 'APPROVE' }) },
              { label: '✖ Reject', cls: 'bad', run: async r => { const x = await reason('Reject ' + r.no); if (!x) return false; return rpc('vo_action', { p_vo: r.id, p_action: 'REJECT', p_comments: x }); } }] },
  { k: 'snag', t: 'Snags fixed — verify', roles: ['production_incharge', 'factory_manager'],
    load: async () => must(await sb.from('v_snags').select('id,snag_no,description,project_code,unit_code,fix_notes,fixed_at,photos').eq('status', 'FIXED').order('fixed_at'))
      .map(s => ({ id: s.id, no: s.snag_no, title: s.description, sub: `${s.project_code} · ${s.unit_code || 'no unit'}${s.fix_notes ? ' · ' + s.fix_notes : ''} · ${s.photos} photo(s)`, at: s.fixed_at, link: 'd/snag/' + s.id })),
    actions: [{ label: '✔ Accept', cls: 'ok', run: r => rpc('snag_verify', { p_snag: r.id, p_accept: true, p_notes: null }) },
              { label: '↺ Reopen', cls: 'bad', run: async r => { const x = await reason('Why reopen ' + r.no + '?'); if (!x) return false; return rpc('snag_verify', { p_snag: r.id, p_accept: false, p_notes: x }); } }] },
  { k: 'disposal', t: 'Scrap disposals', roles: ['factory_manager', 'finance'],
    load: async () => {
      const st = [hasRole('factory_manager') && 'PENDING_APPROVAL', hasRole('finance') && 'PENDING_FINANCE'].filter(Boolean);
      return must(await sb.from('scrap_disposals').select('id,disposal_no,status,method,buyer_name,total_amount,created_at').in('status', st).order('created_at'))
        .map(x => ({ id: x.id, no: x.disposal_no, title: `${label(x.method)}${x.buyer_name ? ' · ' + x.buyer_name : ''}`, sub: x.status === 'PENDING_FINANCE' ? 'Confirm sale rates & post' : 'Factory Manager approval', amount: x.total_amount, at: x.created_at, link: 'd/disposal/' + x.id }));
    },
    actions: [{ label: '✔ Approve', cls: 'ok', run: async r => { if (!(await confirmBox('Approve ' + r.no, r.sub === 'Confirm sale rates & post' ? 'Rates checked? Posting releases the scrap for the gate pass.' : 'Approve this disposal?'))) return false; return rpc('disposal_action', { p_d: r.id, p_action: 'APPROVE' }); } },
              { label: '✖ Reject', cls: 'bad', run: async r => { const x = await reason('Reject ' + r.no); if (!x) return false; return rpc('disposal_action', { p_d: r.id, p_action: 'REJECT', p_comments: x }); } }] },
  { k: 'leave', t: 'Leave requests', roles: ['hr_officer', 'factory_manager'],
    load: async () => must(await sb.from('leave_requests').select('id,leave_no,leave_type,from_date,to_date,days,reason,created_at,employees(name,emp_code)').eq('status', 'PENDING').order('from_date'))
      .map(l => ({ id: l.id, no: l.leave_no, title: `${l.employees?.name} (${l.employees?.emp_code})`, sub: `${label(l.leave_type)} · ${dt(l.from_date)} – ${dt(l.to_date)} · ${qty(l.days)} day(s)${l.reason ? ' · ' + l.reason : ''}`, at: l.created_at, link: 'd/leave/' + l.id })),
    actions: approveReject('leave_action', 'p_id') },
  { k: 'adv', t: 'Salary advances', roles: ['finance'],
    load: async () => must(await sb.from('employee_advances').select('id,adv_no,amount,installment,reason,created_at,employees(name,emp_code)').eq('status', 'DRAFT').order('created_at'))
      .map(a => ({ id: a.id, no: a.adv_no, title: `${a.employees?.name} (${a.employees?.emp_code})`, sub: `${money(a.installment)} / month${a.reason ? ' · ' + a.reason : ''}`, amount: a.amount, at: a.created_at, link: 'd/adv/' + a.id })),
    actions: [{ label: '✔ Approve & pay', cls: 'ok', run: async r => { if (!(await confirmBox('Approve ' + r.no, 'Approve this advance? It is recovered from salary in instalments.'))) return false; return rpc('advance_action', { p_id: r.id, p_action: 'APPROVE' }); } },
              { label: '✖ Cancel', cls: 'bad', run: async r => { if (!(await confirmBox('Cancel ' + r.no, 'Cancel this advance request?', true))) return false; return rpc('advance_action', { p_id: r.id, p_action: 'CANCEL' }); } }] },
  { k: 'payroll', t: 'Payroll', roles: ['finance'],
    load: async () => must(await sb.from('payroll_runs').select('id,run_no,period_month,employees,total_net,submitted_at,created_at').eq('status', 'SUBMITTED').order('period_month'))
      .map(p => ({ id: p.id, no: p.run_no, title: new Date(p.period_month + 'T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), sub: `${p.employees} employee(s) · net pay`, amount: p.total_net, at: p.submitted_at || p.created_at, link: 'd/payroll/' + p.id })),
    actions: [{ label: '✔ Approve', cls: 'ok', run: async r => { const v = await comment('Approve payroll ' + r.title); if (!v) return false; return rpc('payroll_action', { p_run: r.id, p_action: 'APPROVE', p_comments: v.c || null }); } },
              { label: '↩ Return to HR', cls: 'bad', run: async r => { const x = await reason('What must HR correct?'); if (!x) return false; return rpc('payroll_action', { p_run: r.id, p_action: 'RETURN', p_comments: x }); } }] },
];

export const myQueues = () => QUEUES.filter(q => hasRole(...q.roles));

export const ApprovalsApp = {
  components: { Badge },
  data: () => ({ rows: {}, filter: 'ALL', loading: false, busyId: null, openId: null, errors: {} }),
  computed: {
    queues() { return myQueues(); },
    total() { return Object.values(this.rows).reduce((s, r) => s + r.length, 0); },
    shown() { return this.queues.filter(q => (this.filter === 'ALL' || this.filter === q.k) && (this.rows[q.k] || []).length); },
    cost: () => canSeeCost(),
  },
  async mounted() { await this.load(); },
  methods: {
    money, qty, dt, ago,
    async load() {
      this.loading = true; this.errors = {};
      // each queue on its own: one failing list must not hide the others
      // (await first, then merge — merging before the await would let the slowest list overwrite the others)
      await Promise.all(this.queues.map(async q => {
        let rows = [];
        try { rows = await q.load(); }
        catch (e) { this.errors = { ...this.errors, [q.k]: e.message || String(e) }; }
        this.rows = { ...this.rows, [q.k]: rows };
      }));
      this.loading = false;
    },
    acts(q, r) { return q.actions.filter(a => !a.show || a.show(r)); },
    async act(q, r, a) {
      this.busyId = r.id;
      const ok = await run(async () => { const res = await a.run(r); if (res === false) return false; toast(`${r.no}: done`, 'ok'); return true; });
      this.busyId = null;
      if (ok) { this.rows = { ...this.rows, [q.k]: this.rows[q.k].filter(x => x.id !== r.id) }; this.load(); }
    },
  },
  template: `<div class="site appr">
    <div class="row" style="margin-bottom:8px">
      <b style="font-size:17px">✔ Approvals</b><span class="muted small" style="margin-left:6px">{{ loading ? 'loading…' : total + ' waiting' }}</span>
      <span class="spacer"></span><button class="btn sm" @click="load" :disabled="loading">↻</button>
    </div>
    <div class="appr-chips">
      <a class="chip" :class="{on: filter==='ALL'}" @click="filter='ALL'">All <span class="muted">{{ total }}</span></a>
      <a v-for="q in queues.filter(q => (rows[q.k] || []).length)" :key="q.k" class="chip" :class="{on: filter===q.k}" @click="filter=q.k">{{ q.t }} <span class="muted">{{ rows[q.k].length }}</span></a>
    </div>
    <div v-for="(e, k) in errors" :key="k" class="small" style="color:#b91c1c;margin-bottom:6px">{{ queues.find(q => q.k === k)?.t }}: {{ e }}</div>
    <div v-if="!loading && !total" class="card empty">Nothing waiting for you 🎉</div>
    <template v-for="q in shown" :key="q.k">
      <h4 class="appr-h">{{ q.t }} <span class="muted small">{{ rows[q.k].length }}</span></h4>
      <div v-for="r in rows[q.k]" :key="r.id" class="site-card appr-card" :class="{urgent: r.urgent}">
        <div class="row" @click="openId = openId === r.id ? null : r.id">
          <div style="flex:1;min-width:0"><b>{{ r.no }}</b> <span class="muted small">· {{ ago(r.at) }}</span><Badge v-if="r.urgent" v="URGENT" style="margin-left:4px" />
            <div class="appr-title">{{ r.title }}</div><div class="small muted">{{ r.sub }}</div></div>
          <div v-if="cost && r.amount != null" class="appr-amt">{{ money(r.amount) }}</div>
        </div>
        <div v-if="r.lines && openId === r.id" class="small" style="margin-top:6px"><div v-for="l in r.lines">• {{ l }}</div></div>
        <div v-if="r.oc" style="margin-top:6px">
          <div v-for="l in r.oc" :key="l.id" class="row small" style="gap:6px;margin-top:4px">
            <span style="flex:1">✂ {{ l.items?.code }} {{ qty(l.offcut_length_mm) }}{{ l.offcut_width_mm ? ' × ' + qty(l.offcut_width_mm) : '' }} mm × {{ l.pieces }}</span>
            <template v-if="r.status==='PENDING_PI'">
              <a href="javascript:void 0" class="chip" :class="{on: l._act==='KEEP'}" @click="l._act='KEEP'">Keep</a>
              <a href="javascript:void 0" class="chip" :class="{on: l._act==='SCRAP'}" @click="l._act='SCRAP'">Scrap</a>
            </template>
            <Badge v-else :v="l.offcut_action" />
          </div>
        </div>
        <div class="site-actions" style="margin:8px 0 0">
          <button v-for="a in acts(q, r)" class="btn" :class="a.cls" :disabled="busyId === r.id" @click="act(q, r, a)">{{ a.label }}</button>
          <button class="btn" @click="go(r.link)">Open</button>
        </div>
      </div>
    </template>
  </div>`,
  setup() { return { go }; },
};
