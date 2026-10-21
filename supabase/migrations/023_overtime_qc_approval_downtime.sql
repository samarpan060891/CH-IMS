-- =====================================================================
-- Citi Homes IMS - 023 Production round 3:
--   * overtime rate per worker grade; crew lines log normal + overtime hours
--   * QC rejects (rework / scrap) wait for Factory Manager approval; FM may reclassify
--   * work-centre downtime log (breakdowns, maintenance ...) feeding capacity / load
-- =====================================================================

-- ---------- overtime ----------
alter table labour_grades add column ot_rate_per_hour numeric(10,2);
update labour_grades set ot_rate_per_hour = round(rate_per_hour * 1.25, 2);   -- UAE: overtime at 125% (150% nights / rest days)
alter table labour_grades alter column ot_rate_per_hour set not null;
alter table labour_grades alter column ot_rate_per_hour set default 0;
alter table wo_time_log_crew add column ot_hours numeric(10,2) not null default 0 check (ot_hours >= 0),
                             add column ot_rate  numeric(10,2) not null default 0;

-- crew element: {"grade_id": uuid, "workers": n, "hours": normal h, "ot_hours": overtime h}
create or replace function public.wo_log_time(p_op uuid, p_date date, p_crew jsonb,
  p_machine_hours numeric default null, p_qty_done numeric default 0, p_notes text default null, p_complete boolean default false)
returns uuid
language plpgsql security definer set search_path = public as $$
declare o wo_operations%rowtype; h production_orders%rowtype; wc work_centers%rowtype; g labour_grades%rowtype; v_id uuid; c record;
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
  for c in select (e->>'grade_id')::uuid grade_id, (e->>'workers')::int workers, coalesce((e->>'hours')::numeric, 0) hours,
                  coalesce((e->>'ot_hours')::numeric, 0) ot_hours from jsonb_array_elements(p_crew) e loop
    if c.grade_id is null or coalesce(c.workers, 0) < 1 or c.hours < 0 or c.ot_hours < 0 or c.hours + c.ot_hours <= 0 then
      raise exception 'Each crew line needs a grade, workers and normal and/or overtime hours';
    end if;
    select * into g from labour_grades where id = c.grade_id and is_active;
    if not found then raise exception 'Unknown or inactive worker grade'; end if;
    insert into wo_time_log_crew (log_id, grade_id, workers, hours, rate, ot_hours, ot_rate)
    values (v_id, g.id, c.workers, c.hours, g.rate_per_hour, c.ot_hours, g.ot_rate_per_hour);
    v_workers := v_workers + c.workers;
    v_mh := v_mh + c.workers * (c.hours + c.ot_hours);
    v_cost := v_cost + c.workers * (c.hours * g.rate_per_hour + c.ot_hours * g.ot_rate_per_hour);
    v_elapsed := greatest(v_elapsed, c.hours + c.ot_hours);
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

-- ---------- QC rejects need Factory Manager approval ----------
alter table wo_receipts add column qc_status text not null default 'NONE' check (qc_status in ('NONE','PENDING_FM','APPROVED')),
                        add column qc_by uuid references profiles(id), add column qc_at timestamptz, add column qc_note text,
                        add column proposed_rework numeric(14,3), add column proposed_scrap numeric(14,3);

-- internal: FG lot + ledger for good units of an order
create or replace function public.wo_fg_in(p_wo uuid, p_qty numeric, p_value numeric, p_lot_no text, p_doc_no text, p_remarks text) returns uuid
language plpgsql security definer set search_path = public as $$
declare h production_orders%rowtype; p projects%rowtype; v_loc uuid; v_lot uuid;
begin
  select * into h from production_orders where id = p_wo;
  select * into p from projects where id = h.project_id;
  select id into v_loc from locations where loc_type = 'FG_STORE' and is_active order by code limit 1;
  if v_loc is null then raise exception 'Create a Finished Goods Store location first'; end if;
  insert into stock_lots (item_id, location_id, lot_no, source_type, source_id, received_date, mfg_date, unit_cost, qty_in, qty_on_hand, project_id, status)
  values (h.item_id, v_loc, p_lot_no, 'PRODUCTION', p_wo, current_date, current_date, round(p_value / p_qty, 4), p_qty, p_qty,
          case when p.project_type = 'PROJECT' then h.project_id end, 'AVAILABLE')
  returning id into v_lot;
  insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value, doc_type, doc_id, doc_no, project_id, production_order_id, remarks)
  values (current_date, 'PROD_RECEIPT', h.item_id, v_loc, v_lot, p_qty, round(p_value / p_qty, 4), p_value, 'WO', p_wo, p_doc_no, h.project_id, p_wo, p_remarks);
  return v_lot;
end $$;
revoke execute on function public.wo_fg_in(uuid, numeric, numeric, text, text, text) from public, anon, authenticated;

-- FG receipt: good units go to the FG store now; rejected units are valued and held for FM approval
create or replace function public.wo_receive_fg(p_wo uuid, p_good numeric, p_rework numeric default 0, p_scrap numeric default 0,
  p_final boolean default false, p_remarks text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare h production_orders%rowtype; c record; v_lot uuid; v_rid uuid; v_unit numeric; v_no text;
  v_done numeric; v_open numeric; v_remaining numeric; v_n int; v_pending text;
  v_good numeric := coalesce(p_good, 0); v_rwq numeric := coalesce(p_rework, 0); v_scq numeric := coalesce(p_scrap, 0);
  v_val numeric; v_rwv numeric; v_scv numeric;
begin
  if not has_role('production_incharge','factory_manager') then raise exception 'Only the Production In-charge can receive finished goods'; end if;
  select * into h from production_orders where id = p_wo for update;
  if h.status not in ('RELEASED','IN_PROGRESS') then raise exception 'Order is %', h.status; end if;
  if v_good < 0 or v_rwq < 0 or v_scq < 0 or v_good + v_rwq + v_scq <= 0 then raise exception 'Enter the good, rework and scrap quantities'; end if;
  if v_rwq + v_scq > 0 and coalesce(trim(p_remarks), '') = '' then raise exception 'Enter the QC reason for the rejected units'; end if;
  v_done := h.qty_completed + h.qty_rejected;
  if v_done + v_good + v_rwq + v_scq > h.qty * 1.1 then raise exception 'Quantity exceeds the order: % of % already received', v_done, h.qty; end if;
  if p_final then
    select string_agg(w.name, ', ' order by o.seq) into v_pending
      from wo_operations o join work_centers w on w.id = o.work_center_id where o.wo_id = p_wo and o.status not in ('DONE','SKIPPED');
    if v_pending is not null then raise exception 'Stages still open: %', v_pending; end if;
  end if;

  select * into c from v_wo_cost where wo_id = p_wo;
  v_remaining := greatest(c.act_total - c.fg_value - c.rework_out_value - c.scrap_value, 0);
  v_open := greatest(h.qty - v_done, v_good + v_rwq + v_scq);
  if p_final then
    v_unit := v_remaining / (v_good + v_rwq + v_scq);
  else
    v_unit := least(greatest(c.plan_total / h.qty, v_remaining / v_open), v_remaining / (v_good + v_rwq + v_scq));
  end if;
  v_unit := round(v_unit, 4);
  v_rwv := round(v_unit * v_rwq, 2); v_scv := round(v_unit * v_scq, 2);
  if not p_final then v_val := round(v_unit * v_good, 2);
  elsif v_good > 0 then v_val := round(v_remaining - v_rwv - v_scv, 2);
  elsif v_scq > 0 then v_val := 0; v_scv := round(v_remaining - v_rwv, 2);
  else v_val := 0; v_rwv := round(v_remaining, 2); end if;

  select count(*) + 1 into v_n from wo_receipts where wo_id = p_wo;
  v_no := next_doc_no('FGR');
  if v_good > 0 then
    v_lot := wo_fg_in(p_wo, v_good, v_val, h.wo_no || case when v_n > 1 or not p_final then '/' || v_n else '' end, v_no, p_remarks);
  end if;
  insert into wo_receipts (receipt_no, wo_id, good_qty, rework_qty, scrap_qty, is_final, unit_cost, value, rework_value, scrap_value, lot_id, remarks,
                           qc_status, proposed_rework, proposed_scrap)
  values (v_no, p_wo, v_good, v_rwq, v_scq, p_final, v_unit, v_val, v_rwv, v_scv, v_lot, p_remarks,
          case when v_rwq + v_scq > 0 then 'PENDING_FM' else 'NONE' end, v_rwq, v_scq)
  returning id into v_rid;

  update production_orders set qty_completed = qty_completed + v_good, qty_rejected = qty_rejected + v_rwq + v_scq,
         fg_lot_id = coalesce(v_lot, fg_lot_id), status = case when p_final then 'COMPLETED' else 'IN_PROGRESS' end
   where id = p_wo;
  if p_final then
    update production_orders set completed_at = now(), completed_by = auth.uid(),
           cost_material = c.act_material, cost_labour = c.act_labour, cost_machine = c.act_machine,
           cost_overhead = c.act_overhead, cost_total = c.act_total,
           remarks = coalesce(remarks || E'\n', '') || coalesce(p_remarks, '')
     where id = p_wo;
    update material_requests set status = 'CLOSED' where id = h.mr_id and status in ('APPROVED','PARTIALLY_ISSUED');
  end if;
  if v_rwq + v_scq > 0 then
    perform notify('factory_manager', null, 'QC rejects on ' || h.wo_no || ' need approval',
                   format('%s for rework, %s scrap — AED %s. %s', v_rwq, v_scq, to_char(v_rwv + v_scv, 'FM999,999,990.00'), p_remarks), 'qc', 'wo', p_wo);
  end if;
  if v_good > 0 then
    perform notify('stores', null, h.wo_no || ': ' || v_good || ' unit(s) to FG store' || case when p_final then ' (final)' else ' (batch)' end,
                   coalesce(h.description, ''), 'd/wo/' || p_wo, 'wo', p_wo);
  end if;
  return v_rid;
end $$;

-- FM decision on rejected units: split between accept-as-good, rework and scrap (total unchanged, same unit cost)
create or replace function public.wo_qc_decide(p_receipt uuid, p_good numeric, p_rework numeric, p_scrap numeric, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r wo_receipts%rowtype; h production_orders%rowtype; v_total numeric; v_gv numeric; v_rwv numeric; v_scv numeric; v_rw uuid; v_sc uuid; v_sf uuid;
  v_g numeric := coalesce(p_good, 0); v_r numeric := coalesce(p_rework, 0); v_s numeric := coalesce(p_scrap, 0);
begin
  if not has_role('factory_manager') then raise exception 'Only the Factory Manager can approve QC rejects'; end if;
  select * into r from wo_receipts where id = p_receipt for update;
  if r.qc_status <> 'PENDING_FM' then raise exception 'This receipt has no QC decision pending'; end if;
  select * into h from production_orders where id = r.wo_id for update;
  v_total := r.rework_qty + r.scrap_qty;
  if v_g < 0 or v_r < 0 or v_s < 0 or abs(v_g + v_r + v_s - v_total) > 0.0005 then
    raise exception 'Accepted + rework + scrap must equal the % rejected unit(s)', v_total;
  end if;
  v_gv := round(r.unit_cost * v_g, 2); v_rwv := round(r.unit_cost * v_r, 2);
  v_scv := round(r.rework_value + r.scrap_value - v_gv - v_rwv, 2);          -- keeps the total exact
  if v_s = 0 then v_rwv := v_rwv + v_scv; v_scv := 0; end if;
  if v_g > 0 and v_r = 0 and v_s = 0 then v_gv := r.rework_value + r.scrap_value; v_rwv := 0; end if;

  if v_g > 0 then
    perform wo_fg_in(h.id, v_g, v_gv, h.wo_no || '/QC', r.receipt_no, 'Accepted by FM after QC: ' || coalesce(p_note, ''));
    update production_orders set qty_completed = qty_completed + v_g, qty_rejected = qty_rejected - v_g where id = h.id;
  end if;
  if v_r > 0 then
    insert into production_orders (project_id, item_id, description, qty, due_date, priority, status, parent_wo_id, is_rework, carry_in_cost, remarks)
    values (h.project_id, h.item_id, 'REWORK of ' || h.wo_no || coalesce(' — ' || h.description, ''), v_r, h.due_date, 'URGENT', 'DRAFT', h.id, true, v_rwv,
            'QC: ' || coalesce(r.remarks, '') || coalesce(' · FM: ' || p_note, ''))
    returning id into v_rw;
    insert into wo_operations (wo_id, seq, work_center_id, planned_labour_hours, planned_machine_hours, instructions)
    select v_rw, seq, work_center_id, 0, 0, 'Rework — skip stages not needed' from wo_operations where wo_id = h.id;
    perform notify('production_incharge', null, 'Rework order for ' || h.wo_no, v_r || ' unit(s) approved for rework — review stages and release', 'd/wo/' || v_rw, 'wo', v_rw);
  end if;
  if v_s > 0 then
    select id into v_sf from locations where loc_type = 'SHOP_FLOOR' and is_active order by code limit 1;
    insert into scrap_notes (scrap_type, location_id, project_id, reason, status, production_order_id)
    values ('GENERATION', v_sf, h.project_id, format('Rejected at QC on %s (%s): %s unit(s) scrapped, production cost AED %s written off. FM approved%s',
            h.wo_no, r.receipt_no, v_s, to_char(v_scv, 'FM999,999,990.00'), coalesce(': ' || p_note, '')), 'DRAFT', h.id)
    returning id into v_sc;
    insert into scrap_lines (scrap_id, item_id, qty, remarks) values (v_sc, h.item_id, v_s, 'Rejected units from ' || h.wo_no || ' — add the scrap item & qty recovered');
    update production_orders set cost_scrap = cost_scrap + v_scv where id = h.id;
    perform notify('stores', null, 'Scrap note for ' || h.wo_no, v_s || ' unit(s) scrapped at QC (FM approved)', 'd/scrap/' || v_sc, 'scrap', v_sc);
  end if;
  update wo_receipts set good_qty = good_qty + v_g, value = value + v_gv, rework_qty = v_r, scrap_qty = v_s, rework_value = v_rwv, scrap_value = v_scv,
         rework_wo_id = v_rw, scrap_id = v_sc, qc_status = 'APPROVED', qc_by = auth.uid(), qc_at = now(), qc_note = p_note
   where id = p_receipt;
  perform notify('production_incharge', null, 'QC decision on ' || h.wo_no,
                 format('Accepted %s, rework %s, scrap %s%s', v_g, v_r, v_s, coalesce(' — ' || p_note, '')), 'd/wo/' || h.id, 'wo', h.id);
end $$;

-- ---------- work-centre downtime ----------
create table wc_downtime (
  id             uuid primary key default gen_random_uuid(),
  down_no        text not null unique default next_doc_no('DT'),
  work_center_id uuid not null references work_centers(id),
  kind           text not null check (kind in ('BREAKDOWN','PREVENTIVE_MAINTENANCE','SETUP_CHANGEOVER','NO_OPERATOR','POWER_FAILURE','MATERIAL_SHORTAGE','OTHER')),
  start_at       timestamptz not null default now(),
  end_at         timestamptz,
  status         text not null default 'OPEN' check (status in ('PLANNED','OPEN','CLOSED')),
  description    text,
  action_taken   text,
  repair_cost    numeric(16,2),
  reported_by    uuid default auth.uid() references profiles(id),
  closed_by      uuid references profiles(id),
  created_at     timestamptz not null default now(),
  check (end_at is null or end_at > start_at)
);
create index wc_downtime_wc_idx on wc_downtime(work_center_id, start_at);

create or replace function public.trg_downtime_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.status := case when new.start_at > now() then 'PLANNED' when new.end_at is null or new.end_at > now() then 'OPEN' else 'CLOSED' end;
  if tg_op = 'INSERT' and new.kind = 'BREAKDOWN' and new.status = 'OPEN' then
    perform notify('factory_manager', null, 'Breakdown: ' || (select name from work_centers where id = new.work_center_id), coalesce(new.description, ''), 'd/down', 'down', new.id);
    perform notify('production_incharge', null, 'Breakdown: ' || (select name from work_centers where id = new.work_center_id), coalesce(new.description, ''), 'd/down', 'down', new.id);
  end if;
  if new.status = 'CLOSED' and new.closed_by is null then new.closed_by := auth.uid(); end if;
  return new;
end $$;
create trigger downtime_status before insert or update on wc_downtime for each row execute function trg_downtime_status();
revoke execute on function public.trg_downtime_status() from public, anon, authenticated;

-- planned windows start / finish over time
select cron.schedule('downtime-status', '*/15 * * * *', $c$
  update public.wc_downtime set status = case when start_at > now() then 'PLANNED' when end_at is null or end_at > now() then 'OPEN' else 'CLOSED' end
   where status <> case when start_at > now() then 'PLANNED' when end_at is null or end_at > now() then 'OPEN' else 'CLOSED' end $c$);

alter table wc_downtime enable row level security;
create policy read_active on wc_downtime for select to authenticated using (public.is_active_user());
create policy dt_insert on wc_downtime for insert to authenticated
  with check (public.has_role('shop_floor','production_incharge','factory_manager','stores'));
create policy dt_update on wc_downtime for update to authenticated
  using (public.has_role('shop_floor','production_incharge','factory_manager','stores') and status <> 'CLOSED' or public.has_role('factory_manager'))
  with check (public.has_role('shop_floor','production_incharge','factory_manager','stores'));
create policy dt_delete on wc_downtime for delete to authenticated
  using (public.has_role('production_incharge','factory_manager') and status = 'PLANNED');

-- load with capacity: 26 working days a month, 12 in the next 14 days
create or replace view v_work_center_load with (security_invoker = true) as
with rem as (
  select o.work_center_id, count(*) open_stages, count(*) filter (where o.status = 'IN_PROGRESS') running,
         sum(greatest(case when w.kind = 'MACHINE' then o.planned_machine_hours else o.planned_labour_hours end
               - coalesce((select sum(case when w.kind = 'MACHINE' then t.machine_hours else t.labour_hours end)
                             from wo_time_logs t where t.operation_id = o.id), 0), 0)) hours
    from wo_operations o join production_orders h on h.id = o.wo_id and h.status in ('RELEASED','IN_PROGRESS')
    join work_centers w on w.id = o.work_center_id
   where o.status in ('PENDING','IN_PROGRESS') group by o.work_center_id
), dt as (
  select work_center_id,
         bool_or(status = 'OPEN' and kind in ('BREAKDOWN','POWER_FAILURE')) is_down,
         sum(extract(epoch from (least(coalesce(end_at, now()), now()) - greatest(start_at, now() - interval '30 days'))) / 3600)
           filter (where start_at < now() and coalesce(end_at, now()) > now() - interval '30 days') past_hours,
         sum(extract(epoch from (least(end_at, now() + interval '14 days') - greatest(start_at, now()))) / 3600)
           filter (where end_at > now() and start_at < now() + interval '14 days') planned_hours
    from wc_downtime group by work_center_id
)
select w.id work_center_id, w.code, w.name, w.kind, w.hours_per_day, w.sort_order,
       coalesce(rem.open_stages, 0) open_stages, coalesce(rem.running, 0) running,
       round(coalesce(rem.hours, 0), 1) remaining_hours,
       round(coalesce(rem.hours, 0) / greatest(w.hours_per_day - coalesce(dt.planned_hours, 0) / 12, 0.5), 1) load_days,
       coalesce(dt.is_down, false) is_down,
       round(coalesce(dt.past_hours, 0), 1) downtime_hours_30d,
       round(greatest(0, 100 - coalesce(dt.past_hours, 0) / nullif(w.hours_per_day * 26, 0) * 100), 1) availability_pct_30d,
       round(coalesce(dt.planned_hours, 0), 1) planned_down_hours_14d
  from work_centers w left join rem on rem.work_center_id = w.id left join dt on dt.work_center_id = w.id
 where w.is_active;

-- downtime analysis by work centre and reason
create or replace view v_downtime_summary with (security_invoker = true) as
select d.id, d.down_no, d.work_center_id, w.code wc_code, w.name wc_name, d.kind, d.status, d.start_at, d.end_at,
       round(extract(epoch from (coalesce(d.end_at, now()) - d.start_at)) / 3600, 2) hours, d.description, d.action_taken, d.repair_cost
  from wc_downtime d join work_centers w on w.id = d.work_center_id;

-- project margin: include rejects still waiting for FM
drop view if exists v_project_margin;
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
       coalesce((select sum(w.sale_value) from production_orders w where w.project_id = p.id and w.status <> 'CANCELLED'), 0) orders_sale_value,
       coalesce((select sum(r.rework_value + r.scrap_value) from wo_receipts r join production_orders w on w.id = r.wo_id
                  where w.project_id = p.id and r.qc_status = 'PENDING_FM'), 0) qc_pending_value
  from projects p;
create view v_project_margin with (security_invoker = true) as
select v.*, round(v.wip_value + v.fg_in_store + v.dispatched_value + v.scrap_written_off + v.site_material + v.qc_pending_value, 2) total_cost,
       case when v.contract_value is not null then round(v.contract_value - (v.wip_value + v.fg_in_store + v.dispatched_value + v.scrap_written_off + v.site_material + v.qc_pending_value), 2) end margin,
       case when coalesce(v.contract_value, 0) > 0 then round((v.contract_value - (v.wip_value + v.fg_in_store + v.dispatched_value + v.scrap_written_off + v.site_material + v.qc_pending_value)) / v.contract_value * 100, 1) end margin_pct
  from v_project_production v;

grant execute on function public.wo_qc_decide(uuid, numeric, numeric, numeric, text) to authenticated;
revoke execute on function public.wo_qc_decide(uuid, numeric, numeric, numeric, text) from anon;
