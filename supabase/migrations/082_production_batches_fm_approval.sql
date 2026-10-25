-- 082 Production orders in batches with Factory Manager approval; material requests made by the system.
--   · Production In-charge splits a BOQ product into batches → one production order per batch (BOM applied), sent to the FM
--   · FM approves (or returns with a reason) → In-charge releases to the floor
--   · at release the material request is prepared from the BOM × quantity and held; the floor presses "Request material"
--     and it goes straight to Stores (no item picking, no typed quantities; lines cannot be changed)
--   · process rejections: excess material against the order — only that order's BOM items, quantity + reason, FM approves
alter table production_orders drop constraint production_orders_status_check;
alter table production_orders add constraint production_orders_status_check
  check (status in ('DRAFT', 'PENDING_FM', 'APPROVED', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'));
alter table production_orders
  add column if not exists fm_approved_by uuid references profiles(id),
  add column if not exists fm_approved_at timestamptz,
  add column if not exists fm_comments text,
  add column if not exists batch_label text;

alter table material_requests add column if not exists kind text not null default 'MANUAL';
alter table material_requests drop constraint if exists material_requests_kind_check;
alter table material_requests add constraint material_requests_kind_check check (kind in ('MANUAL', 'PRODUCTION', 'EXCESS'));
alter table material_requests add column if not exists excess_reason text;
-- existing requests raised at release were production requests
update material_requests m set kind = 'PRODUCTION' from production_orders w where w.mr_id = m.id and m.kind = 'MANUAL';

-- ---------- batches from a BOQ line ----------
create or replace function wo_create_batches(p_line uuid, p_batches jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare b jsonb; v_wo uuid; n int := 0; v_line boq_lines%rowtype; v_total int := jsonb_array_length(p_batches);
begin
  if not has_role('production_incharge', 'factory_manager') then raise exception 'Only production planning can create production orders'; end if;
  select * into v_line from boq_lines where id = p_line;
  if v_total = 0 then raise exception 'Add at least one batch'; end if;
  for b in select * from jsonb_array_elements(p_batches) loop
    if coalesce((b->>'qty')::numeric, 0) <= 0 then continue; end if;
    n := n + 1;
    v_wo := boq_create_wo(p_line, (b->>'qty')::numeric, nullif(b->>'due_date', '')::date);   -- BOM template applied; BOQ limit checked
    update production_orders set batch_label = 'Batch ' || n || ' of ' || v_total,
           description = coalesce(v_line.boq_ref || ' — ', '') || v_line.description || ' · Batch ' || n || ' of ' || v_total,
           remarks = nullif(b->>'remarks', ''), status = 'PENDING_FM'
     where id = v_wo;
  end loop;
  if n = 0 then raise exception 'Enter a quantity for at least one batch'; end if;
  perform notify('factory_manager', null, n || ' production order(s) to approve', coalesce(v_line.boq_ref || ' ', '') || v_line.description, 'd/wo', 'wo', null);
  return n;
end $$;

-- ---------- submit / FM decision ----------
create or replace function wo_submit(p_wo uuid) returns void language plpgsql security definer set search_path = public as $$
declare h production_orders%rowtype;
begin
  if not has_role('production_incharge', 'factory_manager') then raise exception 'Only production planning can submit orders'; end if;
  select * into h from production_orders where id = p_wo for update;
  if h.status <> 'DRAFT' then raise exception 'Order is %', h.status; end if;
  if not exists (select 1 from wo_operations where wo_id = p_wo) then raise exception 'Add the production route (stages) first'; end if;
  update production_orders set status = 'PENDING_FM', fm_comments = null where id = p_wo;
  perform notify('factory_manager', null, 'Approve production order ' || h.wo_no, coalesce(h.description, ''), 'd/wo/' || p_wo, 'wo', p_wo);
end $$;

create or replace function wo_fm_decide(p_wo uuid, p_approve boolean, p_comments text) returns void
language plpgsql security definer set search_path = public as $$
declare h production_orders%rowtype;
begin
  if not has_role('factory_manager') then raise exception 'Only the Factory Manager approves production orders'; end if;
  select * into h from production_orders where id = p_wo for update;
  if h.status <> 'PENDING_FM' then raise exception 'Order is %', h.status; end if;
  if not p_approve and nullif(trim(p_comments), '') is null then raise exception 'Give a reason for returning the order'; end if;
  update production_orders set status = case when p_approve then 'APPROVED' else 'DRAFT' end,
         fm_approved_by = case when p_approve then auth.uid() end, fm_approved_at = case when p_approve then now() end, fm_comments = p_comments
   where id = p_wo;
  perform notify('production_incharge', null, 'Production order ' || h.wo_no || case when p_approve then ' approved — release when ready' else ' returned' end,
                 coalesce(p_comments, h.description, ''), 'd/wo/' || p_wo, 'wo', p_wo);
end $$;

-- ---------- release: approved orders only; the material request is prepared and held for the floor ----------
create or replace function wo_release(p_wo uuid) returns uuid language plpgsql security definer set search_path = public as $$
declare h production_orders%rowtype; p projects%rowtype; v_mr uuid;
begin
  if not has_role('production_incharge', 'factory_manager') then raise exception 'Only production planning can release orders'; end if;
  select * into h from production_orders where id = p_wo for update;
  -- rework orders from QC were approved by the FM there
  if h.status <> 'APPROVED' and not (h.is_rework and h.status = 'DRAFT') then raise exception 'Order is % — the Factory Manager approves it before release', h.status; end if;
  if not exists (select 1 from wo_operations where wo_id = p_wo) then raise exception 'Add the production route (stages) first'; end if;
  select * into p from projects where id = h.project_id;
  if p.status <> 'OPEN' then raise exception 'Project / MTS order is not open'; end if;
  if exists (select 1 from wo_materials where wo_id = p_wo and required_qty > 0) then
    perform set_config('app.mr_sys', 'on', true);
    insert into material_requests (purpose, project_id, cost_center_id, required_date, priority, status, remarks, production_order_id, kind)
    values (case p.project_type when 'MTS' then 'MTS' when 'SALES' then 'SALES' when 'INTERNAL' then 'INTERNAL' else 'PROJECT' end, h.project_id,
            case when p.project_type = 'INTERNAL' then p.cost_center_id end, coalesce(h.due_date, current_date),
            h.priority, 'DRAFT', 'Materials for production order ' || h.wo_no || coalesce(' — ' || h.description, ''), p_wo, 'PRODUCTION')
    returning id into v_mr;
    insert into mr_lines (mr_id, line_no, item_id, requested_qty, remarks)
    select v_mr, row_number() over (order by i.code), m.item_id, round(sum(m.required_qty), 3), h.wo_no
      from wo_materials m join items i on i.id = m.item_id
     where m.wo_id = p_wo and m.required_qty > 0 group by m.item_id, i.code;
    perform set_config('app.mr_sys', 'off', true);
  end if;
  update production_orders set status = 'RELEASED', released_at = now(), released_by = auth.uid(), mr_id = v_mr where id = p_wo;
  return v_mr;
end $$;

-- ---------- the floor's one button: send the prepared request to Stores ----------
create or replace function wo_request_material(p_wo uuid) returns uuid language plpgsql security definer set search_path = public as $$
declare h production_orders%rowtype; m material_requests%rowtype;
begin
  if not has_role('shop_floor', 'production_incharge', 'stores', 'factory_manager') then raise exception 'Not allowed'; end if;
  select * into h from production_orders where id = p_wo;
  if h.status not in ('RELEASED', 'IN_PROGRESS') then raise exception 'Order % is %', h.wo_no, h.status; end if;
  select * into m from material_requests where id = h.mr_id for update;
  if not found then raise exception 'This order needs no material from the store'; end if;
  if m.status <> 'DRAFT' then raise exception 'Material for % is already requested (%)', h.wo_no, m.mr_no; end if;
  perform set_config('app.mr_sys', 'on', true);
  update mr_lines set approved_qty = requested_qty where mr_id = m.id;
  perform set_config('app.mr_sys', 'off', true);
  update material_requests set status = 'APPROVED', requested_by = auth.uid(), approved_by = auth.uid(), approved_at = now(),
         approval_comments = 'Production order ' || h.wo_no || ' (approved by the Factory Manager)', mr_date = current_date
   where id = m.id;
  perform notify('stores', null, 'Issue material for ' || h.wo_no, m.mr_no || coalesce(' — ' || h.description, ''), 'd/mr/' || m.id, 'mr', m.id);
  return m.id;
end $$;

-- ---------- excess material for process rejections ----------
create or replace function wo_excess_request(p_wo uuid, p_lines jsonb, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare h production_orders%rowtype; p projects%rowtype; v_mr uuid; v_bad text;
begin
  if not has_role('shop_floor', 'production_incharge', 'stores', 'factory_manager') then raise exception 'Not allowed'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'Give the reason (which part / process was rejected)'; end if;
  select * into h from production_orders where id = p_wo;
  if h.status not in ('RELEASED', 'IN_PROGRESS') then raise exception 'Order % is %', h.wo_no, h.status; end if;
  select string_agg(coalesce(i.code, e->>'item_id'), ', ') into v_bad
    from jsonb_array_elements(p_lines) e left join items i on i.id = (e->>'item_id')::uuid
   where coalesce((e->>'qty')::numeric, 0) > 0 and not exists (select 1 from wo_materials m where m.wo_id = p_wo and m.item_id = (e->>'item_id')::uuid);
  if v_bad is not null then raise exception 'Only materials of order % can be requested as excess (%)', h.wo_no, v_bad; end if;
  if not exists (select 1 from jsonb_array_elements(p_lines) e where coalesce((e->>'qty')::numeric, 0) > 0) then raise exception 'Enter a quantity'; end if;
  select * into p from projects where id = h.project_id;
  perform set_config('app.mr_sys', 'on', true);
  insert into material_requests (purpose, project_id, cost_center_id, required_date, priority, status, remarks, production_order_id, kind, excess_reason, requested_by)
  values (case p.project_type when 'MTS' then 'MTS' when 'SALES' then 'SALES' when 'INTERNAL' then 'INTERNAL' else 'PROJECT' end, h.project_id,
          case when p.project_type = 'INTERNAL' then p.cost_center_id end, current_date, 'URGENT', 'PENDING_APPROVAL',
          'Excess material for production order ' || h.wo_no || ' — ' || p_reason, p_wo, 'EXCESS', p_reason, auth.uid())
  returning id into v_mr;
  insert into mr_lines (mr_id, line_no, item_id, requested_qty, remarks)
  select v_mr, row_number() over (), (e->>'item_id')::uuid, (e->>'qty')::numeric, 'Excess — ' || p_reason
    from jsonb_array_elements(p_lines) e where coalesce((e->>'qty')::numeric, 0) > 0;
  perform set_config('app.mr_sys', 'off', true);
  perform notify('factory_manager', null, 'Approve excess material for ' || h.wo_no, p_reason, 'd/mr/' || v_mr, 'mr', v_mr);
  return v_mr;
end $$;

-- ---------- material request approvals: excess → Factory Manager; production requests are not approved again ----------
create or replace function mr_action(p_mr uuid, p_action text, p_comments text default null) returns text
language plpgsql security definer set search_path = public as $$
declare r material_requests%rowtype; v_new text;
begin
  select * into r from material_requests where id = p_mr for update;
  if not found then raise exception 'Request not found'; end if;
  if p_action = 'SUBMIT' then
    if r.kind = 'PRODUCTION' then raise exception 'Use "Request material" on the production order'; end if;
    if not has_role('shop_floor','production_incharge','stores','site_supervisor') then raise exception 'Not allowed'; end if;
    if r.status not in ('DRAFT','REJECTED') then raise exception 'Request is %', r.status; end if;
    if not exists (select 1 from mr_lines where mr_id = p_mr) then raise exception 'Request has no lines'; end if;
    v_new := 'PENDING_APPROVAL';
  elsif p_action in ('APPROVE','REJECT') then
    if r.kind = 'EXCESS' then
      if not has_role('factory_manager') then raise exception 'The Factory Manager approves excess material'; end if;
    elsif not has_role('production_incharge') then raise exception 'Only the Production In-charge can approve requests'; end if;
    if r.status <> 'PENDING_APPROVAL' then raise exception 'Request is not pending approval'; end if;
    if p_action = 'REJECT' and coalesce(p_comments,'') = '' then raise exception 'Rejection reason is required'; end if;
    v_new := case when p_action = 'APPROVE' then 'APPROVED' else 'REJECTED' end;
    if p_action = 'APPROVE' then
      perform set_config('app.mr_sys', 'on', true);
      update mr_lines set approved_qty = coalesce(approved_qty, requested_qty) where mr_id = p_mr;
      perform set_config('app.mr_sys', 'off', true);
      if r.kind = 'EXCESS' then perform notify('stores', null, 'Issue excess material', r.mr_no || ' — ' || coalesce(r.excess_reason, ''), 'd/mr/' || p_mr, 'mr', p_mr); end if;
    end if;
    update material_requests set approved_by = auth.uid(), approved_at = now(), approval_comments = p_comments where id = p_mr;
  elsif p_action = 'CANCEL' then
    if r.status not in ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED') then raise exception 'Cannot cancel a % request', r.status; end if;
    if r.kind = 'PRODUCTION' and not has_role('production_incharge', 'factory_manager') then raise exception 'Production requests are cancelled with the production order'; end if;
    if r.requested_by <> auth.uid() and not has_role('production_incharge','stores') then raise exception 'Not allowed'; end if;
    v_new := 'CANCELLED';
  elsif p_action = 'CLOSE' then
    if not has_role('stores','production_incharge') then raise exception 'Not allowed'; end if;
    if r.status not in ('APPROVED','PARTIALLY_ISSUED') then raise exception 'Cannot close a % request', r.status; end if;
    v_new := 'CLOSED';
  else raise exception 'Unknown action %', p_action; end if;
  update material_requests set status = v_new where id = p_mr;
  return v_new;
end $$;

-- ---------- production / excess request lines are fixed: no items added, removed or re-quantified by hand ----------
-- (the batch / size of a timber line and the issued quantity can still change)
create or replace function mr_lines_locked() returns trigger language plpgsql set search_path = public as $$
declare v_kind text;
begin
  if current_setting('app.mr_sys', true) = 'on' then return coalesce(new, old); end if;
  select kind into v_kind from material_requests where id = coalesce(new.mr_id, old.mr_id);
  if coalesce(v_kind, 'MANUAL') not in ('PRODUCTION', 'EXCESS') then return coalesce(new, old); end if;
  if tg_op in ('INSERT', 'DELETE') then raise exception 'Lines of a production / excess material request cannot be added or removed'; end if;
  if new.item_id is distinct from old.item_id or new.requested_qty is distinct from old.requested_qty or new.approved_qty is distinct from old.approved_qty then
    raise exception 'Items and quantities of a production / excess material request come from the production order and cannot be changed';
  end if;
  return new;
end $$;
drop trigger if exists trg_mr_lines_locked on mr_lines;
create trigger trg_mr_lines_locked before insert or update or delete on mr_lines for each row execute function mr_lines_locked();

-- a request for a production order is only made by the system (release / excess)
create or replace function mr_no_manual_wo() returns trigger language plpgsql set search_path = public as $$
begin
  if new.production_order_id is not null and new.kind = 'MANUAL' and coalesce(current_setting('app.mr_sys', true), '') <> 'on'
     and (tg_op = 'INSERT' or new.production_order_id is distinct from old.production_order_id) then
    raise exception 'Material for a production order is requested with "Request material" on the order (and "Excess material" for rejections)';
  end if;
  return new;
end $$;
drop trigger if exists trg_mr_no_manual_wo on material_requests;
create trigger trg_mr_no_manual_wo before insert or update on material_requests for each row execute function mr_no_manual_wo();

-- cancelling covers orders waiting for / approved by the FM, and drops open excess requests too
create or replace function wo_cancel(p_wo uuid, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare h production_orders%rowtype;
begin
  if not has_role('production_incharge','factory_manager') then raise exception 'Not allowed'; end if;
  select * into h from production_orders where id = p_wo for update;
  if h.status not in ('DRAFT','PENDING_FM','APPROVED','RELEASED','IN_PROGRESS') then raise exception 'Order is %', h.status; end if;
  if exists (select 1 from wo_receipts where wo_id = p_wo) then raise exception 'Finished goods were already received — complete the order instead'; end if;
  if h.is_rework and h.carry_in_cost > 0 then raise exception 'A rework order carries the cost of rejected units — scrap them through the order instead of cancelling'; end if;
  if exists (select 1 from stock_ledger where production_order_id = p_wo group by production_order_id having sum(-value) > 0.01) then
    raise exception 'Material has been issued to this order — return it to store first';
  end if;
  if exists (select 1 from wo_time_logs where wo_id = p_wo) and not has_role('factory_manager') then
    raise exception 'Time is logged on this order — only the Factory Manager can cancel it';
  end if;
  update material_requests set status = 'CANCELLED' where production_order_id = p_wo and status in ('DRAFT','PENDING_APPROVAL','APPROVED');
  update production_orders set status = 'CANCELLED', remarks = coalesce(remarks || E'\n', '') || 'Cancelled: ' || coalesce(p_reason, '') where id = p_wo;
end $$;
