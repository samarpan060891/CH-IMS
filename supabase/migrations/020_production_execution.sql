-- =====================================================================
-- Citi Homes IMS - 020 Production execution: stage logs (crew/hours), job costing,
-- FG receipt into the FG store, dispatch notes to site
-- =====================================================================

-- ---------- supervisor stage log ----------
-- p_hours = elapsed hours on the stage; man-hours = crew x hours; machine hours default to elapsed hours on machines
create or replace function public.wo_log_time(p_op uuid, p_date date, p_crew int, p_hours numeric,
  p_machine_hours numeric default null, p_qty_done numeric default 0, p_notes text default null, p_complete boolean default false)
returns uuid
language plpgsql security definer set search_path = public as $$
declare o wo_operations%rowtype; h production_orders%rowtype; wc work_centers%rowtype; s company_settings%rowtype; v_id uuid;
begin
  if not has_role('shop_floor','production_incharge','factory_manager') then raise exception 'Only floor supervisors can log production time'; end if;
  select * into o from wo_operations where id = p_op for update;
  select * into h from production_orders where id = o.wo_id for update;
  if h.status not in ('RELEASED','IN_PROGRESS') then raise exception 'Order % is %', h.wo_no, h.status; end if;
  if o.status in ('DONE','SKIPPED') then raise exception 'This stage is already closed'; end if;
  if coalesce(p_crew, 0) < 1 or coalesce(p_hours, 0) < 0 then raise exception 'Enter crew and hours'; end if;
  if p_date > current_date then raise exception 'Log date cannot be in the future'; end if;
  select * into wc from work_centers where id = o.work_center_id;
  select * into s from company_settings where id = 1;
  insert into wo_time_logs (operation_id, wo_id, log_date, crew, labour_hours, machine_hours, labour_rate, machine_rate, qty_done, notes)
  values (p_op, o.wo_id, coalesce(p_date, current_date), p_crew, round(p_crew * p_hours, 2),
          coalesce(p_machine_hours, case when wc.kind = 'MACHINE' then p_hours else 0 end),
          coalesce(wc.labour_rate_per_hour, s.labour_rate_per_hour), wc.machine_rate_per_hour, coalesce(p_qty_done, 0), p_notes)
  returning id into v_id;
  update wo_operations set status = case when p_complete then 'DONE' else 'IN_PROGRESS' end,
         qty_done = qty_done + coalesce(p_qty_done, 0), started_at = coalesce(started_at, now()),
         completed_at = case when p_complete then now() end
   where id = p_op;
  update production_orders set status = 'IN_PROGRESS' where id = h.id and status = 'RELEASED';
  if p_complete and not exists (select 1 from wo_operations where wo_id = h.id and status not in ('DONE','SKIPPED')) then
    perform notify('production_incharge', null, h.wo_no || ' — all stages done', 'Ready for FG receipt', 'd/wo/' || h.id, 'wo', h.id);
  end if;
  return v_id;
end $$;

-- start / close / skip a stage without logging time
create or replace function public.wo_stage_action(p_op uuid, p_action text) returns void
language plpgsql security definer set search_path = public as $$
declare o wo_operations%rowtype; h production_orders%rowtype;
begin
  if not has_role('shop_floor','production_incharge','factory_manager') then raise exception 'Not allowed'; end if;
  select * into o from wo_operations where id = p_op for update;
  select * into h from production_orders where id = o.wo_id for update;
  if h.status not in ('RELEASED','IN_PROGRESS') then raise exception 'Order % is %', h.wo_no, h.status; end if;
  if p_action = 'START' then
    if o.status <> 'PENDING' then raise exception 'Stage already started'; end if;
    update wo_operations set status = 'IN_PROGRESS', started_at = now() where id = p_op;
  elsif p_action = 'DONE' then
    update wo_operations set status = 'DONE', started_at = coalesce(started_at, now()), completed_at = now() where id = p_op;
  elsif p_action = 'SKIP' then
    if not has_role('production_incharge','factory_manager') then raise exception 'Only the Production In-charge can skip a stage'; end if;
    if exists (select 1 from wo_time_logs where operation_id = p_op) then raise exception 'Time is logged on this stage; close it instead'; end if;
    update wo_operations set status = 'SKIPPED', completed_at = now() where id = p_op;
  elsif p_action = 'REOPEN' then
    if not has_role('production_incharge','factory_manager') then raise exception 'Only the Production In-charge can reopen a stage'; end if;
    update wo_operations set status = case when started_at is null then 'PENDING' else 'IN_PROGRESS' end, completed_at = null where id = p_op;
  else raise exception 'Unknown action %', p_action; end if;
  update production_orders set status = 'IN_PROGRESS' where id = h.id and status = 'RELEASED' and p_action <> 'REOPEN';
end $$;

-- ---------- job costing ----------
create or replace view v_wo_cost with (security_invoker = true) as
with mat as (
  select production_order_id wo_id, -sum(value) filter (where txn_type in ('ISSUE','RETURN')) material
    from stock_ledger where production_order_id is not null group by production_order_id
), tl as (
  select wo_id, sum(labour_hours) labour_hours, sum(machine_hours) machine_hours,
         sum(labour_hours * labour_rate) labour, sum(machine_hours * machine_rate) machine
    from wo_time_logs group by wo_id
), plan as (
  select m.wo_id, sum(m.required_qty * coalesce(nullif(i.avg_cost, 0), nullif(i.last_purchase_rate, 0), i.standard_cost, 0)) material
    from wo_materials m join items i on i.id = m.item_id group by m.wo_id
), pops as (
  select o.wo_id, sum(o.planned_labour_hours) labour_hours, sum(o.planned_machine_hours) machine_hours,
         sum(o.planned_labour_hours * coalesce(w.labour_rate_per_hour, s.labour_rate_per_hour)) labour,
         sum(o.planned_machine_hours * w.machine_rate_per_hour) machine,
         count(*) stages, count(*) filter (where o.status in ('DONE','SKIPPED')) stages_done
    from wo_operations o join work_centers w on w.id = o.work_center_id cross join company_settings s
   where s.id = 1 group by o.wo_id
)
select h.id wo_id, h.wo_no, h.status, h.project_id, h.item_id, h.qty, h.qty_completed,
       coalesce(pops.stages, 0) stages, coalesce(pops.stages_done, 0) stages_done,
       round(coalesce(plan.material, 0), 2) plan_material,
       round(coalesce(pops.labour, 0), 2) plan_labour, round(coalesce(pops.machine, 0), 2) plan_machine,
       round((coalesce(pops.labour, 0) + coalesce(pops.machine, 0)) * s.overhead_pct / 100, 2) plan_overhead,
       round(coalesce(plan.material, 0) + (coalesce(pops.labour, 0) + coalesce(pops.machine, 0)) * (1 + s.overhead_pct / 100), 2) plan_total,
       coalesce(pops.labour_hours, 0) plan_labour_hours, coalesce(pops.machine_hours, 0) plan_machine_hours,
       coalesce(tl.labour_hours, 0) act_labour_hours, coalesce(tl.machine_hours, 0) act_machine_hours,
       coalesce(h.cost_material, round(coalesce(mat.material, 0), 2)) act_material,
       coalesce(h.cost_labour,   round(coalesce(tl.labour, 0), 2)) act_labour,
       coalesce(h.cost_machine,  round(coalesce(tl.machine, 0), 2)) act_machine,
       coalesce(h.cost_overhead, round((coalesce(tl.labour, 0) + coalesce(tl.machine, 0)) * s.overhead_pct / 100, 2)) act_overhead,
       coalesce(h.cost_total, round(coalesce(mat.material, 0) + (coalesce(tl.labour, 0) + coalesce(tl.machine, 0)) * (1 + s.overhead_pct / 100), 2)) act_total
  from production_orders h cross join company_settings s
  left join mat on mat.wo_id = h.id left join tl on tl.wo_id = h.id
  left join plan on plan.wo_id = h.id left join pops on pops.wo_id = h.id
 where s.id = 1;

-- open stages for the floor board
create or replace view v_wo_stage_board with (security_invoker = true) as
select o.id operation_id, o.wo_id, h.wo_no, h.description, h.priority, h.due_date, h.qty, h.status wo_status,
       h.project_id, h.item_id, o.seq, o.work_center_id, w.code wc_code, w.name wc_name, o.status,
       o.planned_labour_hours, o.planned_machine_hours, o.qty_done, o.started_at, o.instructions,
       coalesce((select sum(t.labour_hours) from wo_time_logs t where t.operation_id = o.id), 0) act_labour_hours,
       (select min(p.seq) from wo_operations p where p.wo_id = o.wo_id and p.status in ('PENDING','IN_PROGRESS')) = o.seq is_current
  from wo_operations o join production_orders h on h.id = o.wo_id join work_centers w on w.id = o.work_center_id
 where h.status in ('RELEASED','IN_PROGRESS') and o.status in ('PENDING','IN_PROGRESS');

-- work-centre load: remaining planned hours on open orders
create or replace view v_work_center_load with (security_invoker = true) as
select w.id work_center_id, w.code, w.name, w.kind, w.hours_per_day, w.sort_order,
       count(o.id) filter (where o.id is not null) open_stages,
       count(o.id) filter (where o.status = 'IN_PROGRESS') running,
       round(coalesce(sum(greatest(case when w.kind = 'MACHINE' then o.planned_machine_hours else o.planned_labour_hours end
              - coalesce((select sum(case when w.kind = 'MACHINE' then t.machine_hours else t.labour_hours end)
                            from wo_time_logs t where t.operation_id = o.id), 0), 0)), 0), 1) remaining_hours,
       round(coalesce(sum(greatest(case when w.kind = 'MACHINE' then o.planned_machine_hours else o.planned_labour_hours end
              - coalesce((select sum(case when w.kind = 'MACHINE' then t.machine_hours else t.labour_hours end)
                            from wo_time_logs t where t.operation_id = o.id), 0), 0)), 0) / nullif(w.hours_per_day, 0), 1) load_days
  from work_centers w
  left join (wo_operations o join production_orders h on h.id = o.wo_id and h.status in ('RELEASED','IN_PROGRESS'))
         on o.work_center_id = w.id and o.status in ('PENDING','IN_PROGRESS')
 where w.is_active
 group by w.id;

-- ---------- completion: FG receipt at full cost ----------
create or replace function public.wo_complete(p_wo uuid, p_good numeric, p_rejected numeric default 0, p_remarks text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare h production_orders%rowtype; p projects%rowtype; c record; v_loc uuid; v_lot uuid; v_unit numeric; v_pending text;
begin
  if not has_role('production_incharge','factory_manager') then raise exception 'Only the Production In-charge can complete orders'; end if;
  select * into h from production_orders where id = p_wo for update;
  if h.status not in ('RELEASED','IN_PROGRESS') then raise exception 'Order is %', h.status; end if;
  if coalesce(p_good, 0) <= 0 then raise exception 'Enter the good quantity produced'; end if;
  if p_good + coalesce(p_rejected, 0) > h.qty * 1.1 then raise exception 'Quantity exceeds the order quantity %', h.qty; end if;
  select string_agg(w.name, ', ' order by o.seq) into v_pending
    from wo_operations o join work_centers w on w.id = o.work_center_id where o.wo_id = p_wo and o.status not in ('DONE','SKIPPED');
  if v_pending is not null then raise exception 'Stages still open: %', v_pending; end if;
  select * into p from projects where id = h.project_id;
  select id into v_loc from locations where loc_type = 'FG_STORE' and is_active order by code limit 1;
  if v_loc is null then raise exception 'Create a Finished Goods Store location first'; end if;

  select * into c from v_wo_cost where wo_id = p_wo;
  v_unit := round(c.act_total / p_good, 4);
  insert into stock_lots (item_id, location_id, lot_no, source_type, source_id, received_date, mfg_date, unit_cost, qty_in, qty_on_hand, project_id, status)
  values (h.item_id, v_loc, h.wo_no, 'PRODUCTION', p_wo, current_date, current_date, v_unit, p_good, p_good,
          case when p.project_type = 'PROJECT' then h.project_id end, 'AVAILABLE')
  returning id into v_lot;
  insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value, doc_type, doc_id, doc_no,
                            project_id, production_order_id, remarks)
  values (current_date, 'PROD_RECEIPT', h.item_id, v_loc, v_lot, p_good, v_unit, c.act_total, 'WO', p_wo, h.wo_no,
          h.project_id, p_wo, p_remarks);
  update production_orders set status = 'COMPLETED', qty_completed = p_good, qty_rejected = coalesce(p_rejected, 0),
         completed_at = now(), completed_by = auth.uid(), fg_lot_id = v_lot,
         cost_material = c.act_material, cost_labour = c.act_labour, cost_machine = c.act_machine,
         cost_overhead = c.act_overhead, cost_total = c.act_total,
         remarks = coalesce(remarks || E'\n', '') || coalesce(p_remarks, '')
   where id = p_wo;
  -- close the material request so leftovers come back as returns, not further issues
  update material_requests set status = 'CLOSED' where id = h.mr_id and status in ('APPROVED','PARTIALLY_ISSUED');
  perform notify('stores', null, h.wo_no || ' completed — ' || p_good || ' to FG store', coalesce(h.description, ''), 'd/wo/' || p_wo, 'wo', p_wo);
  return v_lot;
end $$;

create or replace function public.wo_cancel(p_wo uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare h production_orders%rowtype;
begin
  if not has_role('production_incharge','factory_manager') then raise exception 'Not allowed'; end if;
  select * into h from production_orders where id = p_wo for update;
  if h.status not in ('DRAFT','RELEASED','IN_PROGRESS') then raise exception 'Order is %', h.status; end if;
  if exists (select 1 from stock_ledger where production_order_id = p_wo group by production_order_id having sum(-value) > 0.01) then
    raise exception 'Material has been issued to this order — return it to store first';
  end if;
  if exists (select 1 from wo_time_logs where wo_id = p_wo) and not has_role('factory_manager') then
    raise exception 'Time is logged on this order — only the Factory Manager can cancel it';
  end if;
  update material_requests set status = 'CANCELLED' where id = h.mr_id and status in ('DRAFT','PENDING_APPROVAL','APPROVED');
  update production_orders set status = 'CANCELLED', remarks = coalesce(remarks || E'\n', '') || 'Cancelled: ' || coalesce(p_reason, '') where id = p_wo;
end $$;

-- ---------- dispatch to site ----------
create table dispatch_notes (
  id               uuid primary key default gen_random_uuid(),
  dispatch_no      text not null unique default next_doc_no('DSP'),
  dispatch_date    date not null default current_date,
  project_id       uuid not null references projects(id),
  from_location_id uuid not null references locations(id),
  delivery_address text,
  vehicle_no       text,
  driver_name      text,
  driver_phone     text,
  status           text not null default 'DRAFT' check (status in ('DRAFT','POSTED','DELIVERED','CANCELLED')),
  total_value      numeric(16,2) not null default 0,
  remarks          text,
  received_by_name text,
  delivered_at     timestamptz,
  created_by       uuid default auth.uid() references profiles(id),
  created_at       timestamptz not null default now(),
  posted_by        uuid references profiles(id),
  posted_at        timestamptz
);
create table dispatch_lines (
  id                  uuid primary key default gen_random_uuid(),
  dispatch_id         uuid not null references dispatch_notes(id) on delete cascade,
  line_no             int not null default 1,
  item_id             uuid not null references items(id),
  production_order_id uuid references production_orders(id),
  qty                 numeric(14,3) not null check (qty > 0),
  packages            int,
  value               numeric(16,2) not null default 0,
  remarks             text
);
create index dispatch_lines_dispatch_idx on dispatch_lines(dispatch_id);

create or replace function public.post_dispatch(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare h dispatch_notes%rowtype; l record; r record; v_val numeric; v_total numeric := 0;
begin
  if not has_role('stores','factory_manager') then raise exception 'Only Stores can post dispatch notes'; end if;
  select * into h from dispatch_notes where id = p_id for update;
  if h.status <> 'DRAFT' then raise exception 'Dispatch note is %', h.status; end if;
  if not exists (select 1 from dispatch_lines where dispatch_id = p_id) then raise exception 'Add at least one line'; end if;
  for l in select * from dispatch_lines where dispatch_id = p_id order by line_no loop
    v_val := 0;
    for r in select * from fifo_consume(l.item_id, h.from_location_id, l.qty, h.project_id, 'DISPATCH', 'DISPATCH', p_id,
                                        h.dispatch_no, l.id, h.dispatch_date, h.project_id, null, null, false) loop
      v_val := v_val + round(r.qty * r.unit_cost, 2);
    end loop;
    update stock_ledger set production_order_id = l.production_order_id where doc_line_id = l.id and l.production_order_id is not null;
    update dispatch_lines set value = v_val where id = l.id;
    v_total := v_total + v_val;
  end loop;
  update dispatch_notes set status = 'POSTED', total_value = v_total, posted_by = auth.uid(), posted_at = now() where id = p_id;
end $$;

create or replace function public.dispatch_delivered(p_id uuid, p_received_by text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not has_role('stores','factory_manager','production_incharge') then raise exception 'Not allowed'; end if;
  if coalesce(trim(p_received_by), '') = '' then raise exception 'Enter who received the goods at site'; end if;
  update dispatch_notes set status = 'DELIVERED', received_by_name = p_received_by, delivered_at = now()
   where id = p_id and status = 'POSTED';
  if not found then raise exception 'Only posted dispatch notes can be marked delivered'; end if;
end $$;

-- project production cost: FG dispatched to the project at full cost (material + labour + machine + overhead)
create or replace view v_project_production with (security_invoker = true) as
select p.id project_id, p.code, p.name, p.project_type,
       (select count(*) from production_orders w where w.project_id = p.id and w.status <> 'CANCELLED') orders,
       (select count(*) from production_orders w where w.project_id = p.id and w.status in ('RELEASED','IN_PROGRESS')) wip_orders,
       coalesce((select sum(c.act_total) from v_wo_cost c where c.project_id = p.id and c.status in ('RELEASED','IN_PROGRESS')), 0) wip_value,
       coalesce((select sum(l.qty_on_hand * l.unit_cost) from stock_lots l where l.source_type = 'PRODUCTION' and l.project_id = p.id), 0) fg_in_store,
       coalesce((select -sum(s.value) from stock_ledger s where s.txn_type = 'DISPATCH' and s.project_id = p.id), 0) dispatched_value
  from projects p;

-- ---------- RLS ----------
alter table dispatch_notes enable row level security;
alter table dispatch_lines enable row level security;
create policy read_active on dispatch_notes for select to authenticated using (public.is_active_user());
create policy read_active on dispatch_lines for select to authenticated using (public.is_active_user());
create policy doc_insert on dispatch_notes for insert to authenticated with check (public.has_role('stores','factory_manager') and status = 'DRAFT');
create policy doc_update on dispatch_notes for update to authenticated
  using (public.has_role('stores','factory_manager') and status = 'DRAFT') with check (public.has_role('stores','factory_manager') and status = 'DRAFT');
create policy doc_delete on dispatch_notes for delete to authenticated using (public.has_role('stores','factory_manager') and status = 'DRAFT');
create policy line_write on dispatch_lines for all to authenticated
  using (public.has_role('stores','factory_manager') and exists (select 1 from public.dispatch_notes h where h.id = dispatch_lines.dispatch_id and h.status = 'DRAFT'))
  with check (public.has_role('stores','factory_manager') and exists (select 1 from public.dispatch_notes h where h.id = dispatch_lines.dispatch_id and h.status = 'DRAFT'));

grant execute on function public.wo_log_time(uuid, date, int, numeric, numeric, numeric, text, boolean), public.wo_stage_action(uuid, text),
  public.wo_complete(uuid, numeric, numeric, text), public.wo_cancel(uuid, text), public.post_dispatch(uuid), public.dispatch_delivered(uuid, text) to authenticated;
revoke execute on function public.wo_log_time(uuid, date, int, numeric, numeric, numeric, text, boolean), public.wo_stage_action(uuid, text),
  public.wo_complete(uuid, numeric, numeric, text), public.wo_cancel(uuid, text), public.post_dispatch(uuid), public.dispatch_delivered(uuid, text) from anon;
