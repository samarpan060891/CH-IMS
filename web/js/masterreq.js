// Requests for new master entries. Users can't type a supplier, account, cost centre, list value… that isn't set up:
// they request it here (or from the bottom of any drop-down), the people who keep that master create it and mark the
// request done, and the requester is notified that it can now be selected.
import { state, rpc, hasRole, today, refLabel, loadRef, ROLES, REQ_KIND, LOOKUP_LISTS, reqOwners, reqNoun, reqRoute } from './lib.js';
import { ask } from './components.js';

const KIND_OPTS = [...Object.values(REQ_KIND).filter(k => k.kind !== 'LOOKUP').map(k => ({ v: k.kind, l: k.noun[0].toUpperCase() + k.noun.slice(1) })),
  { v: 'LOOKUP', l: 'Drop-down list value (department, bank, brand, room…)' }];
const LIST_OPTS = Object.entries(LOOKUP_LISTS).map(([k, l]) => ({ v: k, l: l.noun[0].toUpperCase() + l.noun.slice(1) }));
const isOwner = d => hasRole(...reqOwners(d.kind, d.list_key));
const kindText = r => { const n = reqNoun(r.kind, r.list_key); return n[0].toUpperCase() + n.slice(1); };

export async function markCreated(c) {
  const d = c.doc;
  if (d.kind === 'LOOKUP') {
    const v = await ask({ title: `Add "${d.name}" to the ${reqNoun(d.kind, d.list_key)} list`, message: 'Correct the spelling if needed — this is what everyone will pick.',
      fields: [{ k: 'value', label: 'Value', required: true, default: d.name }, { k: 'comments', label: 'Note to the requester' }], okText: 'Add & notify' });
    if (!v) return false;
    await rpc('master_request_resolve', { p_id: d.id, p_action: 'CREATED', p_value: v.value.trim(), p_comments: v.comments || null });
    await loadRef('lookups', true);
    return;
  }
  const k = REQ_KIND[d.kind];
  await loadRef(k.ref, true);
  const v = await ask({ title: `Which ${k.noun} did you create for "${d.name}"?`,
    message: `Create it first in its master (button “Open ${k.noun} master”), then pick it here. Pick an existing one if it was already set up under another name.`,
    fields: [{ k: 'ref', label: k.noun[0].toUpperCase() + k.noun.slice(1), type: 'ref', ref: k.ref, required: true, request: false }, { k: 'comments', label: 'Note to the requester' }], okText: 'Mark done & notify' });
  if (!v) return false;
  await rpc('master_request_resolve', { p_id: d.id, p_action: 'CREATED', p_ref: v.ref, p_value: refLabel(k.ref, v.ref), p_comments: v.comments || null });
}

export const mdr = {
  key: 'mdr', title: 'Requests for new entries', single: 'Request', table: 'master_requests', noField: 'req_no', dateField: 'req_date',
  statuses: ['PENDING', 'CREATED', 'REJECTED', 'CANCELLED'], defaultTab: 'PENDING', createRoles: Object.keys(ROLES), refs: ['profiles'],
  canEdit: ctx => ctx.isNew,
  list: { columns: [{ k: kindText, label: 'New' }, { k: 'name', label: 'Name' }, { k: 'context', label: 'Needed for' },
    { k: r => refLabel('profiles', r.requested_by), label: 'Requested by' }, { k: 'created_value', label: 'Created as' }] },
  defaults: () => ({ req_date: today(), kind: 'VENDOR' }),
  header: [
    { k: 'kind', label: 'What is missing', type: 'select', required: true, options: KIND_OPTS, wide: true },
    { k: 'list_key', label: 'Which list', type: 'select', required: true, options: LIST_OPTS, show: d => d.kind === 'LOOKUP' },
    { k: 'name', label: 'Name', required: true, wide: true },
    { k: 'details', label: 'Details (TRN, phone, contact, what it is for…)', type: 'textarea', full: true },
    { k: 'context', label: 'Needed for', type: 'ro', show: d => !!d.id },
    { k: 'requested_by', label: 'Requested by', type: 'ro', show: d => !!d.id, fmt: v => refLabel('profiles', v) },
    { k: 'created_value', label: 'Created as', type: 'ro', show: d => d.status === 'CREATED' },
    { k: 'comments', label: 'Comments', type: 'ro', show: d => !!d.comments },
    { k: 'handled_by', label: 'Handled by', type: 'ro', show: d => !!d.handled_by, fmt: v => refLabel('profiles', v) },
  ],
  validate(ctx) { if (ctx.doc.kind !== 'LOOKUP') ctx.doc.list_key = null; },
  headerNote: ctx => ctx.doc.id ? `Kept by <b>${reqOwners(ctx.doc.kind, ctx.doc.list_key).map(r => ROLES[r]).join(' / ')}</b>. The requester is notified when it is created or not approved.`
    : 'Only entries that are set up can be selected anywhere in CitiCore. Save to send this request to the people who keep that list — you are notified when it is ready. You can also request from the bottom of any drop-down.',
  actions: ctx => {
    const d = ctx.doc, own = isOwner(d), pending = d.status === 'PENDING', to = reqRoute(d.kind);
    return [
      { label: `Open ${reqNoun(d.kind, d.list_key)} master ↗`, show: pending && own && !!to, reload: false, run: () => { window.open(location.pathname + '#/' + to, '_blank'); } },
      { label: d.kind === 'LOOKUP' ? '✔ Add to the list' : '✔ Mark created', cls: 'ok', show: pending && own, done: 'Done — the requester has been notified', run: markCreated },
      { label: '✖ Not approved', cls: 'bad', show: pending && own, done: 'Requester notified',
        run: async c => {
          const v = await ask({ title: 'Not approved', fields: [{ k: 'why', label: 'Why (e.g. already exists as …)', required: true }], okText: 'Send' });
          if (!v) return false;
          await rpc('master_request_resolve', { p_id: c.doc.id, p_action: 'REJECTED', p_comments: v.why });
        } },
      { label: 'Withdraw', show: pending && d.requested_by === state.profile?.id && !own, confirm: 'Withdraw this request?', run: c => rpc('master_request_resolve', { p_id: c.doc.id, p_action: 'CANCEL' }) },
    ];
  },
};

export const MDR_DOCS = { mdr };
