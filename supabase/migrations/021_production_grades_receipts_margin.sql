-- =====================================================================
-- Citi Homes IMS - 021 Production round 2:
--   * labour rates by worker grade (crew logged per grade)
--   * partial FG receipts (batches) with cost allocation
--   * QC rejects -> rework order (carries the cost of the rejected units) + scrap note
--   * contract value on projects / sale value on orders -> margin
-- =====================================================================

-- ---------- worker grades ----------
create table labour_grades (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  name          text not null,
  rate_per_hour numeric(10,2) not null default 0,
  sort_order    int not null default 50,
  is_active     boolean not null default true
);
insert into labour_grades (code, name, rate_per_hour, sort_order) values
 ('SUP','Supervisor / foreman',30,10), ('CNC','CNC / machine operator',22,20), ('CARP','Carpenter',18,30),
 ('SPR','Sprayer / painter',20,40), ('POL','Polisher / sander',15,50), ('HLP','Helper',11,60), ('PCK','Packer',11,70);

alter table employees    add column grade_id uuid references labour_grades(id);
alter table work_centers add column default_grade_id uuid references labour_grades(id);
update work_centers w set default_grade_id = g.id from labour_grades g
 where (w.code in ('CNCD','CNCR','CNCL','LATH','CUT','EDG','TSZ','PLT') and g.code = 'CNC')
    or (w.code = 'ASM' and g.code = 'CARP') or (w.code = 'SPR' and g.code = 'SPR')
    or (w.code = 'QC' and g.code = 'SUP') or (w.code = 'PCK' and g.code = 'PCK');

create table wo_time_log_crew (
  id       uuid primary key default gen_random_uuid(),
  log_id   uuid not null references wo_time_logs(id) on delete cascade,
  grade_id uuid not null references labour_grades(id),
  workers  int not null check (workers > 0),
  hours    numeric(10,2) not null check (hours >= 0),
  rate     numeric(10,2) not null
);
create index wo_time_log_crew_log_idx on wo_time_log_crew(log_id);

-- p_crew: [{"grade_id": uuid, "workers": n, "hours": h}, ...]
-- wo_time_logs keeps totals: labour_hours = man-hours, labour_rate = weighted average rate
drop function if exists public.wo_log_time(uuid, date, int, numeric, numeric, numeric, text, boolean);
create or replace function public.wo_log_time(p_op uuid, p_date date, p_crew jsonb,
  p_machine_hours numeric default null, p_qty_done numeric default 0, p_notes text default null, p_complete boolean default false)
returns uuid
language plpgsql security definer set search_path = public as $$
declare o wo_operations%rowtype; h production_orders%rowtype; wc work_centers%rowtype; v_id uuid; c record;
  v_workers int := 0; v_mh numeric := 0; v_cost numeric := 0; v_elapsed numeric := 0;
begin
  if not has_role('shop_floor','production_incharge','factory_manager') then raise exception 'Only floor supervisors can log production time'; end if;
  select * into o from wo_operations where id = p_op for update;
  select * into h from production_orders where id = o.wo_id for update;
  if h.status not in ('RELEASED','IN_PROGRESS') then raise exception 'Order % is %', h.wo_no, h.status; end if;
  if o.status in ('DONE','SKIPPED') then raise exception 'This stage is already closed'; end if;
  if p_date > current_date then raise exception 'Log date cannot be in the future'; end if;
  if jsonb_typeof(p_crew) <> 'array' or jsonb_array_length(p_crew) = 0 then raise exception 'Enter the crew (grade, workers, hours)'; end if;
  select * into wc from work_centers where id = o.work_center_id;

  insert into wo_time_logs (operation_id, wo_id, log_date, crew, labour_hours, machine_hours, labour_rate, machine_rate, qty_done, notes)
  values (p_op, o.wo_id, coalesce(p_date, current_date), 1, 0, 0, 0, wc.machine_rate_per_hour, coalesce(p_qty_done, 0), p_notes)
  returning id into v_id;
  for c in select (e->>'grade_id')::uuid grade_id, (e->>'workers')::int workers, (e->>'hours')::numeric hours from jsonb_array_elements(p_crew) e loop
    if c.grade_id is null or coalesce(c.workers, 0) < 1 or coalesce(c.hours, -1) < 0 then raise exception 'Each crew line needs a grade, workers and hours'; end if;
    insert into wo_time_log_crew (log_id, grade_id, workers, hours, rate)
    select v_id, g.id, c.workers, c.hours, g.rate_per_hour from labour_grades g where g.id = c.grade_id and g.is_active;
    if not found then raise exception 'Unknown or inactive worker grade'; end if;
    v_workers := v_workers + c.workers;
    v_mh := v_mh + c.workers * c.hours;
    v_cost := v_cost + c.workers * c.hours * (select rate_per_hour from labour_grades where id = c.grade_id);
    v_elapsed := greatest(v_elapsed, c.hours);
  end loop;
  update wo_time_logs set crew = v_workers, labour_hours = round(v_mh, 2),
         labour_rate = case when v_mh > 0 then round(v_cost / v_mh, 4) else 0 end,
         machine_hours = coalesce(p_machine_hours, case when wc.kind = 'MACHINE' then v_elapsed else 0 end)
   where id = v_id;
  update wo_operations set status = case when p_complete then 'DONE' else 'IN_PROGRESS' end,
         qty_done = qty_done + coalesce(p_qty_done, 0), started_at = coalesce(started_at, now()),
         completed_at = case when p_complete then now() end
   where id = p_op;
  update production_orders set status = 'IN_PROGRESS' where id = h.id and status = 'RELEASED';
  if p_complete and not exists (select 1 from wo_operations where wo_id = h.id and status not in ('DONE','SKIPPED')) then
    perform notify('production_incharge', null, h.wo_no || ' — all stages done', 'Ready for the final FG receipt', 'd/wo/' || h.id, 'wo', h.id);
  end if;
  return v_id;
end $$;
-- labour_rate is now a weighted average: widen its precision (dependent views are rebuilt below)
drop view if exists v_project_production;
drop view if exists v_wo_cost;
alter table wo_time_logs alter column labour_rate type numeric(12,4);

-- ---------- margin inputs ----------
alter table projects add column contract_value numeric(16,2);
alter table production_orders
  add column sale_value     numeric(16,2),                     -- optional: selling price of this order
  add column parent_wo_id   uuid references production_orders(id),
  add column is_rework      boolean not null default false,
  add column carry_in_cost  numeric(16,2) not null default 0,  -- cost of rejected units brought into a rework order
  add column cost_scrap     numeric(16,2) not null default 0;  -- cost of units scrapped at QC (written off)

-- ---------- FG receipts (batches) ----------
create table wo_receipts (
  id            uuid primary key default gen_random_uuid(),
  receipt_no    text not null unique default next_doc_no('FGR'),
  wo_id         uuid not null references production_orders(id),
  receipt_date  date not null default current_date,
  good_qty      numeric(14,3) not null check (good_qty >= 0),
  rework_qty    numeric(14,3) not null default 0 check (rework_qty >= 0),
  scrap_qty     numeric(14,3) not null default 0 check (scrap_qty >= 0),
  is_final      boolean not null default false,
  unit_cost     numeric(14,4) not null,
  value         numeric(16,2) not null,          -- good units into FG store
  rework_value  numeric(16,2) not null default 0, -- carried into the rework order
  scrap_value   numeric(16,2) not null default 0, -- written off
  lot_id        uuid references stock_lots(id),
  rework_wo_id  uuid references production_orders(id),
  scrap_id      uuid references scrap_notes(id),
  remarks       text,
  created_by    uuid default auth.uid() references profiles(id),
  created_at    timestamptz not null default now()
);
create index wo_receipts_wo_idx on wo_receipts(wo_id);
alter table scrap_notes add column production_order_id uuid references production_orders(id);

-- ---------- costing view (columns appended) ----------
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
         sum(o.planned_labour_hours * coalesce(w.labour_rate_per_hour, g.rate_per_hour, s.labour_rate_per_hour)) labour,
         sum(o.planned_machine_hours * w.machine_rate_per_hour) machine,
         count(*) stages, count(*) filter (where o.status in ('DONE','SKIPPED')) stages_done
    from wo_operations o join work_centers w on w.id = o.work_center_id
    left join labour_grades g on g.id = w.default_grade_id cross join company_settings s
   where s.id = 1 group by o.wo_id
), rc as (
  select wo_id, sum(value) received_value, sum(rework_value) rework_value, sum(scrap_value) scrap_value from wo_receipts group by wo_id
)
select h.id wo_id, h.wo_no, h.status, h.project_id, h.item_id, h.qty, h.qty_completed,
       coalesce(pops.stages, 0) stages, coalesce(pops.stages_done, 0) stages_done,
       round(coalesce(plan.material, 0), 2) plan_material,
       round(coalesce(pops.labour, 0), 2) plan_labour, round(coalesce(pops.machine, 0), 2) plan_machine,
       round((coalesce(pops.labour, 0) + coalesce(pops.machine, 0)) * s.overhead_pct / 100, 2) plan_overhead,
       round(h.carry_in_cost + coalesce(plan.material, 0) + (coalesce(pops.labour, 0) + coalesce(pops.machine, 0)) * (1 + s.overhead_pct / 100), 2) plan_total,
       coalesce(pops.labour_hours, 0) plan_labour_hours, coalesce(pops.machine_hours, 0) plan_machine_hours,
       coalesce(tl.labour_hours, 0) act_labour_hours, coalesce(tl.machine_hours, 0) act_machine_hours,
       coalesce(h.cost_material, round(coalesce(mat.material, 0), 2)) act_material,
       coalesce(h.cost_labour,   round(coalesce(tl.labour, 0), 2)) act_labour,
       coalesce(h.cost_machine,  round(coalesce(tl.machine, 0), 2)) act_machine,
       coalesce(h.cost_overhead, round((coalesce(tl.labour, 0) + coalesce(tl.machine, 0)) * s.overhead_pct / 100, 2)) act_overhead,
       coalesce(h.cost_total, round(h.carry_in_cost + coalesce(mat.material, 0) + (coalesce(tl.labour, 0) + coalesce(tl.machine, 0)) * (1 + s.overhead_pct / 100), 2)) act_total,
       h.carry_in_cost, h.is_rework, h.parent_wo_id, h.qty_rejected,
       coalesce(rc.received_value, 0) fg_value, coalesce(rc.rework_value, 0) rework_out_value, coalesce(rc.scrap_value, 0) scrap_value,
       h.sale_value,
       case when h.sale_value is not null then h.sale_value - coalesce(h.cost_total, round(h.carry_in_cost + coalesce(mat.material, 0) + (coalesce(tl.labour, 0) + coalesce(tl.machine, 0)) * (1 + s.overhead_pct / 100), 2)) end margin
  from production_orders h cross join company_settings s
  left join mat on mat.wo_id = h.id left join tl on tl.wo_id = h.id
  left join plan on plan.wo_id = h.id left join pops on pops.wo_id = h.id left join rc on rc.wo_id = h.id
 where s.id = 1;

-- ---------- FG receipt: batch or final ----------
-- Partial batches are valued at the higher of planned unit cost and cost-to-date per open unit;
-- the final receipt takes all remaining cost, so the order ends fully absorbed.
-- Rejected units (rework + scrap) carry the same unit cost: rework cost moves to a new rework order,
-- scrap cost is written off and a scrap note is raised for the physical waste.
drop function if exists public.wo_complete(uuid, numeric, numeric, text);
create or replace function public.wo_receive_fg(p_wo uuid, p_good numeric, p_rework numeric default 0, p_scrap numeric default 0,
  p_final boolean default false, p_remarks text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare h production_orders%rowtype; p projects%rowtype; c record; v_loc uuid; v_lot uuid; v_rid uuid; v_unit numeric;
  v_done numeric; v_open numeric; v_remaining numeric; v_n int; v_pending text; v_rw uuid; v_sc uuid; v_sf uuid;
  v_good numeric := coalesce(p_good, 0); v_rwq numeric := coalesce(p_rework, 0); v_scq numeric := coalesce(p_scrap, 0);
  v_val numeric; v_rwv numeric; v_scv numeric;
begin
  if not has_role('production_incharge','factory_manager') then raise exception 'Only the Production In-charge can receive finished goods'; end if;
  select * into h from production_orders where id = p_wo for update;
  if h.status not in ('RELEASED','IN_PROGRESS') then raise exception 'Order is %', h.status; end if;
  if v_good < 0 or v_rwq < 0 or v_scq < 0 or v_good + v_rwq + v_scq <= 0 then raise exception 'Enter the good, rework and scrap quantities'; end if;
  v_done := h.qty_completed + h.qty_rejected;
  if v_done + v_good + v_rwq + v_scq > h.qty * 1.1 then raise exception 'Quantity exceeds the order: % of % already received', v_done, h.qty; end if;
  if p_final then
    select string_agg(w.name, ', ' order by o.seq) into v_pending
      from wo_operations o join work_centers w on w.id = o.work_center_id where o.wo_id = p_wo and o.status not in ('DONE','SKIPPED');
    if v_pending is not null then raise exception 'Stages still open: %', v_pending; end if;
  end if;
  select * into p from projects where id = h.project_id;
  select id into v_loc from locations where loc_type = 'FG_STORE' and is_active order by code limit 1;
  if v_loc is null then raise exception 'Create a Finished Goods Store location first'; end if;

  select * into c from v_wo_cost where wo_id = p_wo;
  v_remaining := c.act_total - c.fg_value - c.rework_out_value - c.scrap_value;
  v_open := greatest(h.qty - v_done, v_good + v_rwq + v_scq);
  if p_final then
    v_unit := greatest(v_remaining, 0) / (v_good + v_rwq + v_scq);
  else
    -- higher of planned unit cost and cost-to-date per open unit, never more than what is left in WIP
    v_unit := least(greatest(c.plan_total / h.qty, greatest(v_remaining, 0) / v_open), greatest(v_remaining, 0) / (v_good + v_rwq + v_scq));
  end if;
  v_unit := round(v_unit, 4);
  v_rwv := round(v_unit * v_rwq, 2); v_scv := round(v_unit * v_scq, 2);
  v_val := case when p_final then round(greatest(v_remaining, 0) - v_rwv - v_scv, 2) else round(v_unit * v_good, 2) end;
  select count(*) + 1 into v_n from wo_receipts where wo_id = p_wo;

  if v_good > 0 then
    insert into stock_lots (item_id, location_id, lot_no, source_type, source_id, received_date, mfg_date, unit_cost, qty_in, qty_on_hand, project_id, status)
    values (h.item_id, v_loc, h.wo_no || case when v_n > 1 or not p_final then '/' || v_n else '' end, 'PRODUCTION', p_wo, current_date, current_date,
            round(v_val / v_good, 4), v_good, v_good, case when p.project_type = 'PROJECT' then h.project_id end, 'AVAILABLE')
    returning id into v_lot;
  end if;
  insert into wo_receipts (wo_id, good_qty, rework_qty, scrap_qty, is_final, unit_cost, value, rework_value, scrap_value, lot_id, remarks)
  values (p_wo, v_good, v_rwq, v_scq, p_final, v_unit, v_val, v_rwv, v_scv, v_lot, p_remarks) returning id into v_rid;
  if v_good > 0 then
    insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value, doc_type, doc_id, doc_no,
                              project_id, production_order_id, remarks)
    select current_date, 'PROD_RECEIPT', h.item_id, v_loc, v_lot, v_good, round(v_val / v_good, 4), v_val, 'WO', p_wo, r.receipt_no, h.project_id, p_wo, p_remarks
      from wo_receipts r where r.id = v_rid;
  end if;

  -- rework order: same product, carries the cost of the rejected units, route copied for the In-charge to trim
  if v_rwq > 0 then
    insert into production_orders (project_id, item_id, description, qty, due_date, priority, status, parent_wo_id, is_rework, carry_in_cost, remarks)
    values (h.project_id, h.item_id, 'REWORK of ' || h.wo_no || coalesce(' — ' || h.description, ''), v_rwq, h.due_date, 'URGENT', 'DRAFT', p_wo, true, v_rwv,
            coalesce('QC: ' || p_remarks, 'Rejected at QC'))
    returning id into v_rw;
    insert into wo_operations (wo_id, seq, work_center_id, planned_labour_hours, planned_machine_hours, instructions)
    select v_rw, seq, work_center_id, 0, 0, 'Rework — skip stages not needed' from wo_operations where wo_id = p_wo;
    update wo_receipts set rework_wo_id = v_rw where id = v_rid;
    perform notify('production_incharge', null, 'Rework order for ' || h.wo_no, v_rwq || ' unit(s) rejected at QC — review stages and release', 'd/wo/' || v_rw, 'wo', v_rw);
  end if;

  -- scrap note for units that cannot be reworked (Stores adds the scrap item / qty, FM approves as usual)
  if v_scq > 0 then
    select id into v_sf from locations where loc_type = 'SHOP_FLOOR' and is_active order by code limit 1;
    insert into scrap_notes (scrap_type, location_id, project_id, reason, status, production_order_id)
    values ('GENERATION', v_sf, h.project_id, format('Rejected at QC on %s: %s unit(s) scrapped, production cost AED %s written off%s',
            h.wo_no, v_scq, to_char(v_scv, 'FM999,999,990.00'), coalesce('. ' || p_remarks, '')), 'DRAFT', p_wo)
    returning id into v_sc;
    insert into scrap_lines (scrap_id, item_id, qty, remarks) values (v_sc, h.item_id, v_scq, 'Rejected units from ' || h.wo_no || ' — add the scrap item & qty recovered');
    update wo_receipts set scrap_id = v_sc where id = v_rid;
    perform notify('stores', null, 'Scrap note for ' || h.wo_no, v_scq || ' unit(s) scrapped at QC', 'd/scrap/' || v_sc, 'scrap', v_sc);
  end if;

  update production_orders set qty_completed = qty_completed + v_good, qty_rejected = qty_rejected + v_rwq + v_scq,
         cost_scrap = cost_scrap + v_scv, fg_lot_id = coalesce(v_lot, fg_lot_id),
         status = case when p_final then 'COMPLETED' else 'IN_PROGRESS' end
   where id = p_wo;
  if p_final then
    update production_orders set completed_at = now(), completed_by = auth.uid(),
           cost_material = c.act_material, cost_labour = c.act_labour, cost_machine = c.act_machine,
           cost_overhead = c.act_overhead, cost_total = c.act_total,
           remarks = coalesce(remarks || E'\n', '') || coalesce(p_remarks, '')
     where id = p_wo;
    update material_requests set status = 'CLOSED' where id = h.mr_id and status in ('APPROVED','PARTIALLY_ISSUED');
  end if;
  if v_good > 0 then
    perform notify('stores', null, h.wo_no || ': ' || v_good || ' unit(s) to FG store' || case when p_final then ' (final)' else ' (batch)' end,
                   coalesce(h.description, ''), 'd/wo/' || p_wo, 'wo', p_wo);
  end if;
  return v_rid;
end $$;

-- the original order can only be cancelled before anything was received
create or replace function public.wo_cancel(p_wo uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare h production_orders%rowtype;
begin
  if not has_role('production_incharge','factory_manager') then raise exception 'Not allowed'; end if;
  select * into h from production_orders where id = p_wo for update;
  if h.status not in ('DRAFT','RELEASED','IN_PROGRESS') then raise exception 'Order is %', h.status; end if;
  if exists (select 1 from wo_receipts where wo_id = p_wo) then raise exception 'Finished goods were already received — complete the order instead'; end if;
  if h.is_rework and h.carry_in_cost > 0 then raise exception 'A rework order carries the cost of rejected units — scrap them through the order instead of cancelling'; end if;
  if exists (select 1 from stock_ledger where production_order_id = p_wo group by production_order_id having sum(-value) > 0.01) then
    raise exception 'Material has been issued to this order — return it to store first';
  end if;
  if exists (select 1 from wo_time_logs where wo_id = p_wo) and not has_role('factory_manager') then
    raise exception 'Time is logged on this order — only the Factory Manager can cancel it';
  end if;
  update material_requests set status = 'CANCELLED' where id = h.mr_id and status in ('DRAFT','PENDING_APPROVAL','APPROVED');
  update production_orders set status = 'CANCELLED', remarks = coalesce(remarks || E'\n', '') || 'Cancelled: ' || coalesce(p_reason, '') where id = p_wo;
end $$;

-- rework orders may be released with no new material (route only)
create or replace function public.wo_release(p_wo uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare h production_orders%rowtype; p projects%rowtype; v_mr uuid;
begin
  if not has_role('production_incharge','factory_manager') then raise exception 'Only production planning can release orders'; end if;
  select * into h from production_orders where id = p_wo for update;
  if h.status <> 'DRAFT' then raise exception 'Order is %', h.status; end if;
  if not exists (select 1 from wo_operations where wo_id = p_wo) then raise exception 'Add the production route (stages) first'; end if;
  select * into p from projects where id = h.project_id;
  if p.status <> 'OPEN' then raise exception 'Project / MTS order is not open'; end if;
  if exists (select 1 from wo_materials where wo_id = p_wo and required_qty > 0) then
    insert into material_requests (purpose, project_id, required_date, priority, status, remarks, production_order_id)
    values (case when p.project_type = 'MTS' then 'MTS' else 'PROJECT' end, h.project_id, coalesce(h.due_date, current_date),
            h.priority, 'PENDING_APPROVAL', 'Materials for production order ' || h.wo_no || coalesce(' — ' || h.description, ''), p_wo)
    returning id into v_mr;
    insert into mr_lines (mr_id, line_no, item_id, requested_qty, remarks)
    select v_mr, row_number() over (order by i.code), m.item_id, round(sum(m.required_qty), 3), h.wo_no
      from wo_materials m join items i on i.id = m.item_id
     where m.wo_id = p_wo and m.required_qty > 0 group by m.item_id, i.code;
    perform notify('production_incharge', null, 'Approve materials for ' || h.wo_no, coalesce(h.description, ''), 'd/mr/' || v_mr, 'mr', v_mr);
  end if;
  update production_orders set status = 'RELEASED', released_at = now(), released_by = auth.uid(), mr_id = v_mr where id = p_wo;
  return v_mr;
end $$;

-- ---------- project margin (columns appended) ----------
create or replace view v_project_production with (security_invoker = true) as
select p.id project_id, p.code, p.name, p.project_type,
       (select count(*) from production_orders w where w.project_id = p.id and w.status <> 'CANCELLED') orders,
       (select count(*) from production_orders w where w.project_id = p.id and w.status in ('RELEASED','IN_PROGRESS')) wip_orders,
       coalesce((select sum(c.act_total - c.fg_value - c.rework_out_value - c.scrap_value) from v_wo_cost c
                  where c.project_id = p.id and c.status in ('RELEASED','IN_PROGRESS')), 0) wip_value,
       coalesce((select sum(l.qty_on_hand * l.unit_cost) from stock_lots l where l.source_type = 'PRODUCTION' and l.project_id = p.id), 0) fg_in_store,
       coalesce((select -sum(s.value) from stock_ledger s where s.txn_type = 'DISPATCH' and s.project_id = p.id), 0) dispatched_value,
       p.contract_value,
       coalesce((select sum(w.cost_scrap) from production_orders w where w.project_id = p.id), 0) scrap_written_off,
       coalesce((select -sum(s.value) from stock_ledger s where s.project_id = p.id and s.production_order_id is null
                  and s.txn_type in ('ISSUE','RETURN')), 0) site_material,
       coalesce((select sum(w.sale_value) from production_orders w where w.project_id = p.id and w.status <> 'CANCELLED'), 0) orders_sale_value
  from projects p;

-- total cost & margin on top of the view (kept separate so the view stays simple to extend)
create or replace view v_project_margin with (security_invoker = true) as
select v.*, round(v.wip_value + v.fg_in_store + v.dispatched_value + v.scrap_written_off + v.site_material, 2) total_cost,
       case when v.contract_value is not null then round(v.contract_value - (v.wip_value + v.fg_in_store + v.dispatched_value + v.scrap_written_off + v.site_material), 2) end margin,
       case when coalesce(v.contract_value, 0) > 0 then round((v.contract_value - (v.wip_value + v.fg_in_store + v.dispatched_value + v.scrap_written_off + v.site_material)) / v.contract_value * 100, 1) end margin_pct
  from v_project_production v;

-- ---------- RLS / grants ----------
alter table labour_grades enable row level security;
alter table wo_time_log_crew enable row level security;
alter table wo_receipts enable row level security;
create policy read_active on labour_grades for select to authenticated using (public.is_active_user());
create policy read_active on wo_time_log_crew for select to authenticated using (public.is_active_user());
create policy read_active on wo_receipts for select to authenticated using (public.is_active_user());
create policy write_roles on labour_grades for all to authenticated
  using (public.has_role('factory_manager','finance')) with check (public.has_role('factory_manager','finance'));

grant execute on function public.wo_log_time(uuid, date, jsonb, numeric, numeric, text, boolean),
  public.wo_receive_fg(uuid, numeric, numeric, numeric, boolean, text) to authenticated;
revoke execute on function public.wo_log_time(uuid, date, jsonb, numeric, numeric, text, boolean),
  public.wo_receive_fg(uuid, numeric, numeric, numeric, boolean, text) from anon;
