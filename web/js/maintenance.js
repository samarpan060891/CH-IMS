// Preventive maintenance: schedules per machine (every N days and / or N running hours) → PM jobs raised a few days ahead with a
// planned stop on the machine → checklist, spares request to MNT-MAC, who did it & hours (or AMC vendor visit) → In-charge closes.
import { sb, must, rpc, hasRole, go, refRow, refLabel, qty, dt, dtm, label, toast } from './lib.js';
import { ask } from './components.js';
import { makePdf } from './pdf.js';
import { ccItem } from './documents.js';

const isLead = () => hasRole('production_incharge', 'factory_manager');
const TEAM = ['shop_floor', 'production_incharge', 'factory_manager', 'stores'];
const wcLabel = id => refLabel('work_centers', id);
const itemName = id => { const r = refRow('items', id); return r ? `${r.code} — ${r.name}` : ''; };
const every = r => [r.every_days && `${r.every_days} days`, r.every_hours && `${qty(r.every_hours)} running h`].filter(Boolean).join(' or ');
const TRIGGERS = { CALENDAR: 'Calendar', HOURS: 'Running hours', MANUAL: 'Raised by hand' };

// ======================================================================
// PM SCHEDULES
// ======================================================================
export const pms = {
  key: 'pms', title: 'PM Schedules', single: 'PM Schedule', table: 'pm_schedules', noField: 'pm_code', dateField: 'created_at',
  statuses: ['ACTIVE', 'PAUSED'], defaultTab: 'ACTIVE', createRoles: ['production_incharge', 'factory_manager'], editStatuses: ['ACTIVE', 'PAUSED'],
  refs: ['work_centers', 'vendors', 'items'],
  list: { select: '*, work_centers(code,name), vendors(name)', columns: [
    { k: r => r.work_centers ? `${r.work_centers.code} — ${r.work_centers.name}` : '', label: 'Machine' }, { k: 'title', label: 'Maintenance' },
    { k: every, label: 'Every' }, { k: r => r.done_by === 'VENDOR' ? 'AMC · ' + (r.vendors?.name || '') : 'In-house', label: 'Done by' },
    { k: 'last_done_date', label: 'Last done', fmt: 'date' }, { k: 'next_due', label: 'Next due (calendar)', fmt: 'date' }] },
  defaults: () => ({ status: 'ACTIVE', done_by: 'IN_HOUSE', every_days: 30, lead_days: 3, stop_hours: 2 }),
  header: [
    { k: 'work_center_id', label: 'Machine / work centre', type: 'ref', ref: 'work_centers', required: true, wide: true, filter: r => r.is_active },
    { k: 'title', label: 'Maintenance (e.g. Monthly service, 500 h belt change)', required: true, wide: true },
    { k: 'every_days', label: 'Every … days (calendar)', type: 'number' },
    { k: 'every_hours', label: 'Every … running hours', type: 'number' },
    { k: 'next_due', label: 'Next due date', type: 'date', show: d => !!d.every_days },
    { k: 'lead_days', label: 'Raise the job … days ahead', type: 'number', required: true },
    { k: 'stop_hours', label: 'Machine stop needed (hours)', type: 'number', required: true },
    { k: 'done_by', label: 'Done by', type: 'select', required: true, options: [{ v: 'IN_HOUSE', l: 'Our maintenance team' }, { v: 'VENDOR', l: 'AMC / service vendor' }] },
    { k: 'vendor_id', label: 'AMC / service vendor', type: 'ref', ref: 'vendors', required: true, wide: true, filter: r => r.status !== 'BLOCKED', show: d => d.done_by === 'VENDOR' },
    { k: 'status', label: 'Status', type: 'select', required: true, options: ['ACTIVE', 'PAUSED'] },
    { k: 'last_done_date', label: 'Last done', type: 'ro', fmt: v => dt(v) || 'Not yet', show: d => !!d.id },
    { k: 'remarks', label: 'Remarks', type: 'textarea', full: true },
  ],
  headerNote: () => 'Fill <b>days</b>, <b>running hours</b> or both — whichever comes first. Running hours are the machine hours logged on production and job-work orders. ' +
    'The job is raised automatically each morning when the machine is due within the lead days (for hours, using the last 30 days\' usage); it books a planned stop ' +
    'so the work-centre load shows it, and notifies the Production In-charge and Factory Manager.',
  validate(c) { if (!c.doc.every_days && !c.doc.every_hours) throw new Error('Enter every … days or every … running hours'); },
  grids: [
    { key: 'tasks', title: 'Checklist', table: 'pm_schedule_tasks', fk: 'schedule_id', order: 'line_no',
      fields: [{ k: 'task', label: 'Task (e.g. Grease the rails, Check belt tension)', required: true, width: '420px' }] },
    { key: 'spares', title: 'Spares needed each time', table: 'pm_schedule_spares', fk: 'schedule_id', order: 'line_no',
      fields: [{ k: 'item_id', label: 'Spare / consumable', type: 'ref', ref: 'items', required: true, width: '320px', filter: ccItem },
        { k: 'qty', label: 'Qty', type: 'number', required: true }] },
  ],
  // a schedule that is already due gets its job straight away
  async afterSave() { const n = await rpc('pm_generate'); if (n) toast('PM job raised — it is due', 'ok'); },
  async afterLoad(c) { c.extra.due = must(await sb.from('v_pm_due').select('*').eq('id', c.doc.id).maybeSingle()); },
  async loadInfo(c) {
    const d = c.extra.due;
    const jobs = must(await sb.from('pm_jobs').select('id,pm_no,due_date,trigger_kind,status,completed_at,by_vendor').eq('schedule_id', c.doc.id).order('due_date', { ascending: false }).limit(50));
    return [
      ...(d ? [{ title: 'Due status', columns: [{ k: 'due_state', label: 'State', fmt: 'badge' }, { k: 'next_due', label: 'Next due date', fmt: 'date' }, { k: 'days_left', label: 'Days left', n: true },
        { k: 'hours_run', label: 'Hours run since last', n: true }, { k: 'hours_left', label: 'Hours left', n: true }, { k: 'hours_per_day', label: 'Avg h / day (30 d)', n: true },
        { k: 'job_no', label: 'Open job' }], rows: [d] }] : []),
      { title: 'PM history', columns: [{ k: 'pm_no', label: 'Job' }, { k: 'due_date', label: 'Due', fmt: 'date' }, { k: r => TRIGGERS[r.trigger_kind], label: 'Raised by' },
        { k: r => r.by_vendor ? 'AMC vendor' : 'In-house', label: 'Done by' }, { k: 'status', label: 'Status', fmt: 'badge' }, { k: 'completed_at', label: 'Closed', fmt: 'datetime' },
        { k: () => '', label: '', icon: '↗', title: 'Open job', action: r => go('d/pm/' + r.id) }], rows: jobs },
    ];
  },
  actions: ctx => [
    { label: '↗ Open PM job ' + (ctx.extra.due?.job_no || ''), show: !!ctx.extra.due?.job_id, reload: false, run: c => go('d/pm/' + c.extra.due.job_id) },
    { label: '⚡ Raise PM job now', cls: 'primary', show: isLead() && ctx.doc.status === 'ACTIVE' && !ctx.extra.due?.job_id, reload: false,
      confirm: 'Raise a PM job for this machine now and book a stop for tomorrow morning?',
      run: async c => { const id = await rpc('pm_job_new', { p_schedule: c.doc.id }); go('d/pm/' + id); } },
  ],
};

// ======================================================================
// PM JOBS
// ======================================================================
function pmPdf(c) {
  const d = c.doc;
  const tasks = c.grids.tasks.map(t => ({ ...t, kind: 'Task' }));
  const spares = c.grids.spares.map(s => ({ kind: 'Spare', task: `${itemName(s.item_id)} × ${qty(s.qty)}` }));
  return makePdf({ title: 'Preventive Maintenance Job', no: d.pm_no, date: d.due_date, subtitle: `${wcLabel(d.work_center_id)} · ${d.title || ''}`,
    meta: [['Machine', wcLabel(d.work_center_id)], ['Due', dt(d.due_date)], ['Raised by', TRIGGERS[d.trigger_kind]],
      ['Done by', d.by_vendor ? 'AMC / vendor · ' + (refLabel('vendors', d.vendor_id) || '') : 'Our maintenance team'],
      ['Machine hours at raise', qty(d.run_hours)], ['Spares request', c.extra.mr ? c.extra.mr.mr_no : '-']],
    columns: [{ h: '#', k: r => [...tasks, ...spares].indexOf(r) + 1, w: 8 }, { h: '', k: r => r.kind, w: 16 }, { h: 'Task / spare', k: r => r.task },
      { h: 'Done', k: r => r.kind === 'Task' ? (r.done ? 'Yes' : '[   ]') : '', w: 14, align: 'center' }, { h: 'Remarks', k: r => r.remarks || '' }],
    rows: [...tasks, ...spares],
    notes: ['Stop the machine and isolate power before starting. Tick each task, note anything found, and return unused spares to the store.', d.remarks].filter(Boolean).join('\n'),
    signatures: ['Done by', 'Production In-charge'], filename: d.pm_no.replace(/[\/\\]/g, '-') + '.pdf' });
}

export const pm = {
  key: 'pm', title: 'PM Jobs', single: 'PM Job', table: 'pm_jobs', noField: 'pm_no', dateField: 'due_date',
  statuses: ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'], defaultTab: 'OPEN', noCreate: true, editRoles: TEAM, editStatuses: ['OPEN', 'IN_PROGRESS'],
  refs: ['work_centers', 'vendors', 'items', 'employees'],
  list: { select: '*, work_centers(code,name)', columns: [
    { k: r => r.work_centers ? `${r.work_centers.code} — ${r.work_centers.name}` : '', label: 'Machine' }, { k: 'title', label: 'Maintenance' },
    { k: r => TRIGGERS[r.trigger_kind], label: 'Raised by' }, { k: r => r.by_vendor ? 'AMC vendor' : 'In-house', label: 'Done by' },
    { k: 'completed_at', label: 'Closed', fmt: 'datetime' }] },
  header: [
    { k: 'work_center_id', label: 'Machine', type: 'ro', fmt: v => wcLabel(v), wide: true },
    { k: 'title', label: 'Maintenance', type: 'ro', wide: true },
    { k: 'due_date', label: 'Due', type: 'ro', fmt: v => dt(v) },
    { k: 'trigger_kind', label: 'Raised by', type: 'ro', fmt: v => TRIGGERS[v] },
    { k: 'run_hours', label: 'Machine hours at raise', type: 'ro', fmt: v => qty(v) },
    { k: '_stop', label: 'Machine stop', type: 'ro', virtual: true, fmt: (v, d) => d._stop || '-' },
    { k: 'by_vendor', label: 'Done by the AMC / service vendor', type: 'check' },
    { k: 'vendor_id', label: 'AMC / service vendor', type: 'ref', ref: 'vendors', wide: true, filter: r => r.status !== 'BLOCKED', show: d => d.by_vendor },
    { k: 'service_report', label: 'Vendor service report no. / link', wide: true, show: d => d.by_vendor },
    { k: '_mr', label: 'Spares request', type: 'ro', virtual: true, fmt: (v, d) => d._mr || 'Not requested', show: d => !!d.mr_id },
    { k: 'remarks', label: 'Findings / remarks', type: 'textarea', full: true },
  ],
  headerNote: c => c.doc.status === 'OPEN' ? 'Press <b>Start</b> when the machine is stopped for the work — the planned stop becomes the actual stop. ' +
    'Tick each task, request the spares, enter who did it and the hours; the Production In-charge closes the job.' : '',
  grids: [
    { key: 'tasks', title: 'Checklist', table: 'pm_job_tasks', fk: 'job_id', order: 'line_no',
      fields: [{ k: 'task', label: 'Task', required: true, width: '360px', lockSaved: true }, { k: 'done', label: 'Done', type: 'check' },
        { k: 'remarks', label: 'Remarks / found', width: '260px' }] },
    { key: 'spares', title: 'Spares', table: 'pm_job_spares', fk: 'job_id', order: 'line_no', readonly: c => !!c.doc.mr_id && c.extra.mr?.status !== 'CANCELLED',
      fields: [{ k: 'item_id', label: 'Spare / consumable', type: 'ref', ref: 'items', required: true, width: '320px', filter: ccItem },
        { k: 'qty', label: 'Qty', type: 'number', required: true }] },
    { key: 'labour', title: 'Done by (in-house)', table: 'pm_job_labour', fk: 'job_id', order: 'line_no', show: d => !d.by_vendor,
      fields: [{ k: 'employee_id', label: 'Worker', type: 'ref', ref: 'employees', required: true, width: '240px', filter: r => r.is_active },
        { k: 'hours', label: 'Hours', type: 'number', required: true },
        { k: 'rate', label: 'Rate / h', type: 'ro', cost: true, fmt: v => qty(v) }, { k: 'cost', label: 'Cost AED', type: 'ro', cost: true, fmt: v => qty(v) }] },
  ],
  async afterLoad(c) {
    const d = c.doc;
    if (d.downtime_id) {
      const s = must(await sb.from('wc_downtime').select('down_no,start_at,end_at,status').eq('id', d.downtime_id).maybeSingle());
      if (s) d._stop = `${s.down_no} · ${label(s.status)} · ${dtm(s.start_at)} → ${s.end_at ? dtm(s.end_at) : 'running'}`;
    }
    c.extra.mr = d.mr_id ? must(await sb.from('material_requests').select('id,mr_no,status').eq('id', d.mr_id).maybeSingle()) : null;
    if (c.extra.mr) d._mr = `${c.extra.mr.mr_no} · ${label(c.extra.mr.status)}`;
  },
  actions: ctx => {
    const st = ctx.doc.status, open = ['OPEN', 'IN_PROGRESS'].includes(st), mr = ctx.extra.mr;
    return [
      { label: '▶ Start — machine stopped', cls: 'primary', show: st === 'OPEN' && hasRole(...TEAM), done: 'Started — machine shown as down',
        run: c => rpc('pm_start', { p_job: c.doc.id }) },
      { label: '📦 Request spares', show: open && hasRole(...TEAM) && (!mr || ['CANCELLED', 'REJECTED'].includes(mr.status)), reload: false,
        run: async c => { const id = await rpc('pm_request_spares', { p_job: c.doc.id }); toast('Spares request created — check and submit it', 'ok'); go('d/mr/' + id); } },
      { label: '↗ Spares request ' + (mr?.mr_no || ''), show: !!mr, reload: false, saveFirst: false, run: c => go('d/mr/' + c.doc.mr_id) },
      { label: '✔ Complete', cls: 'ok', show: open && isLead(),
        run: async c => {
          const v = await ask({ title: 'Close ' + c.doc.pm_no, message: 'All tasks must be ticked. The machine stop ends now and the next due date is set from today.',
            fields: [{ k: 'r', label: 'Findings / remarks', type: 'textarea', default: c.doc.remarks || '' }], okText: 'Close job' });
          if (!v) return;
          await rpc('pm_complete', { p_job: c.doc.id, p_remarks: v.r || null });
          toast('PM job closed — schedule moved on', 'ok');
        } },
      { label: 'Cancel / skip', cls: 'bad', show: open && isLead(),
        run: async c => {
          const v = await ask({ title: 'Skip ' + c.doc.pm_no, fields: [{ k: 'r', label: 'Reason', type: 'textarea', required: true }], okText: 'Skip this cycle', danger: true });
          if (!v) return;
          await rpc('pm_cancel', { p_job: c.doc.id, p_reason: v.r });
          toast('Skipped — the schedule rolls on to the next cycle', 'ok');
        } },
      { label: '↗ Schedule', reload: false, saveFirst: false, run: c => go('d/pms/' + c.doc.schedule_id) },
      { label: '🖨 Job card', reload: false, run: c => pmPdf(c) },
    ];
  },
};

export const PM_DOCS = { pms, pm };
