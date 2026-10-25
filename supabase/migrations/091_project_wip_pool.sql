-- 091 Common WIP per project. Material issued to a production order goes into its project's WIP pool (batch, cost and the
-- order it was issued for are kept). Every FG receipt — batch or final — consumes BOM per unit × units received from the
-- project pool (oldest first) before the receipt is valued; the order's material cost is what its receipts consumed.
-- Leftovers stay in the pool for the next batch of the project (no carry-forward step) and are returned to store at the
-- end of the project's BOQ. Excess material (process rejections) is charged to its order when issued.
-- A new order's material request asks Stores only for what the project pool cannot cover after the remaining needs of the
-- project's other running orders.

-- take from the project's pool (oldest first; lots of one issue line first when given). p_wo: the order charged (consume)
-- or the order of the returned issue
create or replace function wip_take_project(p_project uuid, p_item uuid, p_qty numeric, p_type text, p_doc text, p_wo uuid, p_issue_line uuid default null)
returns numeric language plpgsql security definer set search_path = public as $$
declare l record; v_left numeric := p_qty; v_t numeric; v_done numeric := 0;
begin
  for l in select * from wip_lots where project_id is not distinct from p_project and item_id = p_item and qty_left > 0
           order by (issue_line_id is not distinct from p_issue_line) desc, created_at for update loop
    exit when v_left <= 0.00005;
    v_t := least(v_left, l.qty_left);
    update wip_lots set qty_left = qty_left - v_t where id = l.id;
    insert into wip_moves (wip_lot_id, wo_id, item_id, move_type, qty, value, doc_no) values (l.id, p_wo, p_item, p_type, v_t, round(v_t * l.unit_cost, 2), p_doc);
    v_left := v_left - v_t; v_done := v_done + v_t;
  end loop;
  return v_done;
end $$;

-- FG receipt: consume BOM per unit × units from the project pool, charged to the order
create or replace function wip_consume(p_wo uuid, p_units numeric, p_doc text) returns void language plpgsql security definer set search_path = public as $$
declare h production_orders%rowtype; m record;
begin
  select * into h from production_orders where id = p_wo;
  if coalesce(p_units, 0) <= 0 or coalesce(h.qty, 0) <= 0 then return; end if;
  for m in select item_id, sum(required_qty) q from wo_materials where wo_id = p_wo group by item_id loop
    perform wip_take_project(h.project_id, m.item_id, m.q / h.qty * p_units, 'CONSUME', p_doc, p_wo);
  end loop;
end $$;

-- issue posted: into the project pool; excess material is used at once by its order
create or replace function wip_on_issue() returns trigger language plpgsql security definer set search_path = public as $$
declare a record; v_id uuid; v_kind text;
begin
  if new.status = 'POSTED' and old.status is distinct from 'POSTED' and new.production_order_id is not null then
    select kind into v_kind from material_requests where id = new.mr_id;
    for a in select ill.*, il.item_id from issue_line_lots ill join issue_lines il on il.id = ill.issue_line_id where il.issue_id = new.id and ill.qty > 0 loop
      insert into wip_lots (wo_id, project_id, item_id, issue_line_id, src_lot_id, qty_in, qty_left, unit_cost, issued_date)
      values (new.production_order_id, coalesce(new.project_id, (select project_id from production_orders where id = new.production_order_id)), a.item_id, a.issue_line_id, a.lot_id, a.qty, a.qty, a.unit_cost, new.issue_date)
      returning id into v_id;
      insert into wip_moves (wip_lot_id, wo_id, item_id, move_type, qty, value, doc_no) values (v_id, new.production_order_id, a.item_id, 'IN', a.qty, round(a.qty * a.unit_cost, 2), new.issue_no);
      if v_kind = 'EXCESS' then
        update wip_lots set qty_left = 0 where id = v_id;
        insert into wip_moves (wip_lot_id, wo_id, item_id, move_type, qty, value, doc_no) values (v_id, new.production_order_id, a.item_id, 'CONSUME', a.qty, round(a.qty * a.unit_cost, 2), new.issue_no || ' (excess)');
      end if;
    end loop;
  end if;
  return new;
end $$;

-- return posted: out of the project pool (the returned issue's own lots first)
create or replace function wip_on_return() returns trigger language plpgsql security definer set search_path = public as $$
declare l record; v_wo uuid; v_proj uuid;
begin
  if new.status = 'POSTED' and old.status is distinct from 'POSTED' then
    select i.production_order_id, coalesce(i.project_id, h.project_id) into v_wo, v_proj from material_issues i left join production_orders h on h.id = i.production_order_id where i.id = new.issue_id;
    if v_wo is null then return new; end if;
    for l in select rl.*, il.item_id from return_lines rl join issue_lines il on il.id = rl.issue_line_id where rl.return_id = new.id and rl.qty > 0 loop
      perform wip_take_project(v_proj, l.item_id, l.qty, case when l.condition = 'OFFCUT' and l.offcut_action = 'SCRAP' then 'SCRAP' else 'RETURN' end, new.return_no, v_wo, l.issue_line_id);
    end loop;
  end if;
  return new;
end $$;

-- consumption now happens inside the FG receipt, before it is valued
drop trigger if exists trg_wip_on_receipt on wo_receipts;

create or replace function wo_receive_fg(p_wo uuid, p_good numeric, p_rework numeric default 0, p_scrap numeric default 0, p_final boolean default false, p_remarks text default null) returns uuid
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

  v_no := next_doc_no('FGR', current_date);
  -- the material of these units comes out of the project's WIP pool first, so the receipt carries its own material
  perform wip_consume(p_wo, v_good + v_rwq + v_scq, v_no);

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

-- the project's pool now
drop view if exists v_wip_stock;
create view v_wip_stock with (security_invoker = true) as
  select w.project_id, p.code project_code, p.name project_name, w.item_id, i.code item_code, i.name item_name, u.code uom,
         sum(w.qty_left) qty, round(sum(w.qty_left * w.unit_cost), 2) value, min(w.issued_date) first_issued, max(w.issued_date) last_issued,
         string_agg(distinct h.wo_no, ', ') issued_for
    from wip_lots w join items i on i.id = w.item_id left join uoms u on u.id = i.uom_id left join projects p on p.id = w.project_id
    left join production_orders h on h.id = w.wo_id
   where w.qty_left > 0.00005
   group by w.project_id, p.code, p.name, w.item_id, i.code, i.name, u.code;

-- per order: issued for it (into the pool) and consumed by its receipts (its material cost)
drop view if exists v_wip_by_order;
create view v_wip_by_order with (security_invoker = true) as
  select m.wo_id, m.item_id,
         coalesce(sum(m.qty) filter (where m.move_type = 'IN'), 0) qty_issued,
         coalesce(sum(m.qty) filter (where m.move_type = 'CONSUME'), 0) qty_consumed,
         coalesce(sum(m.value) filter (where m.move_type = 'CONSUME'), 0) value_consumed,
         coalesce(sum(m.qty) filter (where m.move_type in ('RETURN', 'SCRAP')), 0) qty_returned
    from wip_moves m group by m.wo_id, m.item_id;

-- order cost: material = what its receipts consumed from the project pool (and excess material it used); orders whose
-- material was issued before the pool (no WIP moves) keep the issued value
create or replace view v_wo_cost as
 WITH mat AS (
         SELECT h0.id AS wo_id,
            CASE WHEN EXISTS (SELECT 1 FROM wip_moves x WHERE x.wo_id = h0.id)
                 THEN (SELECT COALESCE(sum(x.value), 0) FROM wip_moves x WHERE x.wo_id = h0.id AND x.move_type = 'CONSUME')
                 ELSE (SELECT - COALESCE(sum(l.value), 0) FROM stock_ledger l WHERE l.production_order_id = h0.id AND l.txn_type = ANY (ARRAY['ISSUE'::text, 'RETURN'::text])) END AS material
           FROM production_orders h0
        ), tl AS (
         SELECT wo_time_logs.wo_id, sum(wo_time_logs.labour_hours) AS labour_hours, sum(wo_time_logs.machine_hours) AS machine_hours,
            sum(wo_time_logs.labour_hours * wo_time_logs.labour_rate) AS labour, sum(wo_time_logs.machine_hours * wo_time_logs.machine_rate) AS machine
           FROM wo_time_logs GROUP BY wo_time_logs.wo_id
        ), plan AS (
         SELECT m.wo_id, sum(m.required_qty * COALESCE(NULLIF(i.avg_cost, 0::numeric), NULLIF(i.last_purchase_rate, 0::numeric), i.standard_cost, 0::numeric)) AS material
           FROM wo_materials m JOIN items i ON i.id = m.item_id GROUP BY m.wo_id
        ), pops AS (
         SELECT o.wo_id, sum(o.planned_labour_hours) AS labour_hours, sum(o.planned_machine_hours) AS machine_hours,
            sum(o.planned_labour_hours * COALESCE(w.labour_rate_per_hour, g.rate_per_hour, s_1.labour_rate_per_hour)) AS labour,
            sum(o.planned_machine_hours * w.machine_rate_per_hour) AS machine, count(*) AS stages,
            count(*) FILTER (WHERE o.status = ANY (ARRAY['DONE'::text, 'SKIPPED'::text])) AS stages_done
           FROM wo_operations o JOIN work_centers w ON w.id = o.work_center_id LEFT JOIN labour_grades g ON g.id = w.default_grade_id CROSS JOIN company_settings s_1
          WHERE s_1.id = 1 GROUP BY o.wo_id
        ), rc AS (
         SELECT wo_receipts.wo_id, sum(wo_receipts.value) AS received_value, sum(wo_receipts.rework_value) AS rework_value, sum(wo_receipts.scrap_value) AS scrap_value
           FROM wo_receipts GROUP BY wo_receipts.wo_id
        )
 SELECT h.id AS wo_id, h.wo_no, h.status, h.project_id, h.item_id, h.qty, h.qty_completed,
    COALESCE(pops.stages, 0::bigint) AS stages, COALESCE(pops.stages_done, 0::bigint) AS stages_done,
    round(COALESCE(plan.material, 0::numeric), 2) AS plan_material,
    round(COALESCE(pops.labour, 0::numeric), 2) AS plan_labour,
    round(COALESCE(pops.machine, 0::numeric), 2) AS plan_machine,
    round((COALESCE(pops.labour, 0::numeric) + COALESCE(pops.machine, 0::numeric)) * s.overhead_pct / 100::numeric, 2) AS plan_overhead,
    round(h.carry_in_cost + COALESCE(plan.material, 0::numeric) + (COALESCE(pops.labour, 0::numeric) + COALESCE(pops.machine, 0::numeric)) * (1::numeric + s.overhead_pct / 100::numeric), 2) AS plan_total,
    COALESCE(pops.labour_hours, 0::numeric) AS plan_labour_hours,
    COALESCE(pops.machine_hours, 0::numeric) AS plan_machine_hours,
    COALESCE(tl.labour_hours, 0::numeric) AS act_labour_hours,
    COALESCE(tl.machine_hours, 0::numeric) AS act_machine_hours,
    COALESCE(h.cost_material, round(COALESCE(mat.material, 0::numeric), 2)) AS act_material,
    COALESCE(h.cost_labour, round(COALESCE(tl.labour, 0::numeric), 2)) AS act_labour,
    COALESCE(h.cost_machine, round(COALESCE(tl.machine, 0::numeric), 2)) AS act_machine,
    COALESCE(h.cost_overhead, round((COALESCE(tl.labour, 0::numeric) + COALESCE(tl.machine, 0::numeric)) * s.overhead_pct / 100::numeric, 2)) AS act_overhead,
    COALESCE(h.cost_total, round(h.carry_in_cost + COALESCE(mat.material, 0::numeric) + (COALESCE(tl.labour, 0::numeric) + COALESCE(tl.machine, 0::numeric)) * (1::numeric + s.overhead_pct / 100::numeric), 2)) AS act_total,
    h.carry_in_cost, h.is_rework, h.parent_wo_id, h.qty_rejected,
    COALESCE(rc.received_value, 0::numeric) AS fg_value,
    COALESCE(rc.rework_value, 0::numeric) AS rework_out_value,
    COALESCE(rc.scrap_value, 0::numeric) AS scrap_value,
    h.sale_value,
        CASE WHEN h.sale_value IS NOT NULL THEN h.sale_value - COALESCE(h.cost_total, round(h.carry_in_cost + COALESCE(mat.material, 0::numeric) + (COALESCE(tl.labour, 0::numeric) + COALESCE(tl.machine, 0::numeric)) * (1::numeric + s.overhead_pct / 100::numeric), 2))
            ELSE NULL::numeric END AS margin
   FROM production_orders h CROSS JOIN company_settings s
     LEFT JOIN mat ON mat.wo_id = h.id LEFT JOIN tl ON tl.wo_id = h.id LEFT JOIN plan ON plan.wo_id = h.id LEFT JOIN pops ON pops.wo_id = h.id LEFT JOIN rc ON rc.wo_id = h.id
  WHERE s.id = 1;

-- release: ask Stores only for what the project pool cannot cover after the other running orders' remaining needs
create or replace function wo_release(p_wo uuid) returns uuid language plpgsql security definer set search_path = public as $$
declare h production_orders%rowtype; p projects%rowtype; v_mr uuid;
begin
  if not has_role('production_incharge', 'factory_manager') then raise exception 'Only production planning can release orders'; end if;
  select * into h from production_orders where id = p_wo for update;
  if h.status <> 'APPROVED' and not (h.is_rework and h.status = 'DRAFT') then raise exception 'Order is % — the Factory Manager approves it before release', h.status; end if;
  if not exists (select 1 from wo_operations where wo_id = p_wo) then raise exception 'Add the production route (stages) first'; end if;
  select * into p from projects where id = h.project_id;
  if p.status <> 'OPEN' then raise exception 'Project / MTS order is not open'; end if;
  create temp table if not exists _need (item_id uuid, code text, req numeric, spare numeric) on commit drop;
  delete from _need;
  insert into _need
    select m.item_id, i.code, round(sum(m.required_qty), 3),
           greatest(coalesce((select sum(qty_left) from wip_lots w where w.project_id = h.project_id and w.item_id = m.item_id), 0)
                  - coalesce((select sum(om.required_qty * greatest(o.qty - o.qty_completed - o.qty_rejected, 0) / nullif(o.qty, 0))
                                from production_orders o join wo_materials om on om.wo_id = o.id
                               where o.project_id = h.project_id and o.id <> p_wo and o.status in ('RELEASED', 'IN_PROGRESS') and om.item_id = m.item_id), 0), 0)
      from wo_materials m join items i on i.id = m.item_id where m.wo_id = p_wo and m.required_qty > 0 group by m.item_id, i.code;
  if exists (select 1 from _need where req > spare + 0.0005) then
    perform set_config('app.mr_sys', 'on', true);
    insert into material_requests (purpose, project_id, cost_center_id, required_date, priority, status, remarks, production_order_id, kind)
    values (case p.project_type when 'MTS' then 'MTS' when 'SALES' then 'SALES' when 'INTERNAL' then 'INTERNAL' else 'PROJECT' end, h.project_id,
            case when p.project_type = 'INTERNAL' then p.cost_center_id end, coalesce(h.due_date, current_date),
            h.priority, 'DRAFT', 'Materials for production order ' || h.wo_no || coalesce(' — ' || h.description, ''), p_wo, 'PRODUCTION')
    returning id into v_mr;
    insert into mr_lines (mr_id, line_no, item_id, requested_qty, remarks)
    select v_mr, row_number() over (order by code), item_id, req - least(spare, req),
           h.wo_no || case when spare > 0.0005 then ' · ' || trim_scale(round(least(spare, req), 3)) || ' from project WIP' else '' end
      from _need where req > spare + 0.0005;
    perform set_config('app.mr_sys', 'off', true);
  end if;
  update production_orders set status = 'RELEASED', released_at = now(), released_by = auth.uid(), mr_id = v_mr where id = p_wo;
  return v_mr;
end $$;

-- cancelling: material issued for the order stays in the project pool, so only orders from before the pool (material
-- charged at issue) must return it first
create or replace function wo_cancel(p_wo uuid, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare h production_orders%rowtype;
begin
  if not has_role('production_incharge','factory_manager') then raise exception 'Not allowed'; end if;
  select * into h from production_orders where id = p_wo for update;
  if h.status not in ('DRAFT','PENDING_FM','APPROVED','RELEASED','IN_PROGRESS') then raise exception 'Order is %', h.status; end if;
  if exists (select 1 from wo_receipts where wo_id = p_wo) then raise exception 'Finished goods were already received — complete the order instead'; end if;
  if h.is_rework and h.carry_in_cost > 0 then raise exception 'A rework order carries the cost of rejected units — scrap them through the order instead of cancelling'; end if;
  if not exists (select 1 from wip_moves where wo_id = p_wo)
     and exists (select 1 from stock_ledger where production_order_id = p_wo group by production_order_id having sum(-value) > 0.01) then
    raise exception 'Material has been issued to this order — return it to store first';
  end if;
  if exists (select 1 from wip_moves where wo_id = p_wo and move_type = 'CONSUME') then
    raise exception 'Excess material was used on this order — it cannot be cancelled';
  end if;
  if exists (select 1 from wo_time_logs where wo_id = p_wo) and not has_role('factory_manager') then
    raise exception 'Time is logged on this order — only the Factory Manager can cancel it';
  end if;
  update material_requests set status = 'CANCELLED' where production_order_id = p_wo and status in ('DRAFT','PENDING_APPROVAL','APPROVED');
  update production_orders set status = 'CANCELLED', remarks = coalesce(remarks || E'\n', '') || 'Cancelled: ' || coalesce(p_reason, '') where id = p_wo;
end $$;