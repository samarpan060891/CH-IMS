-- 090 Carry WIP forward: material left in an order's WIP at its final receipt (whole sheets / cans / rolls rounded up,
-- part-used packs â€¦) can move to another open order of the same project that uses it â€” typically the next batch of the
-- same BOQ line â€” instead of being consumed into the finished units. The quantity and its cost move with it; the next
-- order's material request is reduced by what it receives, so Stores does not issue it again. At the last batch the
-- remainder is returned to store (or consumed).
alter table wip_moves drop constraint if exists wip_moves_move_type_check;
alter table wip_moves add constraint wip_moves_move_type_check check (move_type in ('IN', 'CONSUME', 'RETURN', 'SCRAP', 'XFER_OUT', 'XFER_IN'));
alter table wip_moves add column if not exists other_wo_id uuid references production_orders(id);

create or replace function wip_carry_forward(p_from uuid, p_lines jsonb) returns void language plpgsql security definer set search_path = public as $$
declare f production_orders%rowtype; t production_orders%rowtype; e jsonb; l record; v_item uuid; v_left numeric; v_take numeric; v_new uuid; v_mr uuid; v_x numeric; m record;
begin
  if not has_role('production_incharge', 'factory_manager') then raise exception 'Only production planning can move WIP between orders'; end if;
  select * into f from production_orders where id = p_from for update;
  if f.status not in ('RELEASED', 'IN_PROGRESS') then raise exception 'Order % is %', f.wo_no, f.status; end if;
  for e in select * from jsonb_array_elements(p_lines) loop
    v_item := (e->>'item_id')::uuid; v_left := coalesce((e->>'qty')::numeric, 0);
    continue when v_left <= 0.00005;
    select * into t from production_orders where id = (e->>'to_wo')::uuid for update;
    if not found or t.id = f.id then raise exception 'Choose the order to carry the material to'; end if;
    if t.project_id is distinct from f.project_id then raise exception 'WIP can only move to an order of the same project (% is for another project)', t.wo_no; end if;
    if t.status not in ('PENDING_FM', 'APPROVED', 'RELEASED', 'IN_PROGRESS') then raise exception 'Order % is %', t.wo_no, t.status; end if;
    if (select coalesce(sum(qty_left), 0) from wip_lots where wo_id = f.id and item_id = v_item) < v_left - 0.0005 then
      raise exception 'Only % of this material is in WIP for %', (select trim_scale(sum(qty_left)) from wip_lots where wo_id = f.id and item_id = v_item), f.wo_no;
    end if;
    v_x := v_left;
    for l in select * from wip_lots where wo_id = f.id and item_id = v_item and qty_left > 0 order by created_at for update loop
      exit when v_left <= 0.00005;
      v_take := least(v_left, l.qty_left);
      update wip_lots set qty_left = qty_left - v_take where id = l.id;
      insert into wip_moves (wip_lot_id, wo_id, item_id, move_type, qty, value, doc_no, other_wo_id) values (l.id, f.id, v_item, 'XFER_OUT', v_take, round(v_take * l.unit_cost, 2), t.wo_no, t.id);
      insert into wip_lots (wo_id, project_id, item_id, issue_line_id, src_lot_id, qty_in, qty_left, unit_cost, issued_date)
      values (t.id, t.project_id, v_item, l.issue_line_id, l.src_lot_id, v_take, v_take, l.unit_cost, current_date) returning id into v_new;
      insert into wip_moves (wip_lot_id, wo_id, item_id, move_type, qty, value, doc_no, other_wo_id) values (v_new, t.id, v_item, 'XFER_IN', v_take, round(v_take * l.unit_cost, 2), f.wo_no, f.id);
      v_left := v_left - v_take;
    end loop;
    -- the receiving order needs that much less from Stores (its production request, while not yet fully issued)
    select id into v_mr from material_requests where id = t.mr_id and status in ('DRAFT', 'APPROVED', 'PARTIALLY_ISSUED');
    if v_mr is not null then
      perform set_config('app.mr_sys', 'on', true);
      for m in select * from mr_lines where mr_id = v_mr and item_id = v_item order by line_no for update loop
        exit when v_x <= 0.00005;
        v_take := least(v_x, greatest(coalesce(m.approved_qty, m.requested_qty) - m.issued_qty, 0));
        continue when v_take <= 0;
        update mr_lines set requested_qty = greatest(m.requested_qty - v_take, m.issued_qty),
               approved_qty = case when m.approved_qty is null then null else greatest(m.approved_qty - v_take, m.issued_qty) end,
               remarks = concat_ws(' Â· ', nullif(m.remarks, ''), trim_scale(round(v_take, 3)) || ' carried from ' || f.wo_no)
         where id = m.id;
        v_x := v_x - v_take;
      end loop;
      perform set_config('app.mr_sys', 'off', true);
      update material_requests set status = 'ISSUED' where id = v_mr and status in ('APPROVED', 'PARTIALLY_ISSUED')
         and not exists (select 1 from mr_lines where mr_id = v_mr and issued_qty < coalesce(approved_qty, requested_qty) - 0.0005)
         and exists (select 1 from mr_lines where mr_id = v_mr and issued_qty > 0);
    end if;
  end loop;
end $$;

-- in / out of WIP including material carried between orders
create or replace view v_wip_by_order with (security_invoker = true) as
  select m.wo_id, m.item_id,
         sum(m.qty) filter (where m.move_type in ('IN', 'XFER_IN')) qty_in,
         coalesce(sum(m.qty) filter (where m.move_type = 'CONSUME'), 0) qty_consumed,
         coalesce(sum(m.qty) filter (where m.move_type in ('RETURN', 'SCRAP', 'XFER_OUT')), 0) qty_returned,
         sum(case when m.move_type in ('IN', 'XFER_IN') then m.qty else -m.qty end) qty_wip,
         sum(case when m.move_type in ('IN', 'XFER_IN') then m.value else -m.value end) value_wip
    from wip_moves m group by m.wo_id, m.item_id;

-- order cost: material issued (net of returns) plus material carried in from other orders, minus material carried out
create or replace view v_wo_cost as
 WITH mat AS (
         SELECT x.wo_id, sum(x.material) AS material FROM (
           SELECT stock_ledger.production_order_id AS wo_id, - sum(stock_ledger.value) FILTER (WHERE stock_ledger.txn_type = ANY (ARRAY['ISSUE'::text, 'RETURN'::text])) AS material
             FROM stock_ledger WHERE stock_ledger.production_order_id IS NOT NULL GROUP BY stock_ledger.production_order_id
           UNION ALL
           SELECT wip_moves.wo_id, sum(CASE WHEN wip_moves.move_type = 'XFER_IN' THEN wip_moves.value ELSE - wip_moves.value END)
             FROM wip_moves WHERE wip_moves.move_type = ANY (ARRAY['XFER_IN'::text, 'XFER_OUT'::text]) GROUP BY wip_moves.wo_id) x
          GROUP BY x.wo_id
        ), tl AS (
         SELECT wo_time_logs.wo_id,
            sum(wo_time_logs.labour_hours) AS labour_hours,
            sum(wo_time_logs.machine_hours) AS machine_hours,
            sum(wo_time_logs.labour_hours * wo_time_logs.labour_rate) AS labour,
            sum(wo_time_logs.machine_hours * wo_time_logs.machine_rate) AS machine
           FROM wo_time_logs
          GROUP BY wo_time_logs.wo_id
        ), plan AS (
         SELECT m.wo_id,
            sum(m.required_qty * COALESCE(NULLIF(i.avg_cost, 0::numeric), NULLIF(i.last_purchase_rate, 0::numeric), i.standard_cost, 0::numeric)) AS material
           FROM wo_materials m
             JOIN items i ON i.id = m.item_id
          GROUP BY m.wo_id
        ), pops AS (
         SELECT o.wo_id,
            sum(o.planned_labour_hours) AS labour_hours,
            sum(o.planned_machine_hours) AS machine_hours,
            sum(o.planned_labour_hours * COALESCE(w.labour_rate_per_hour, g.rate_per_hour, s_1.labour_rate_per_hour)) AS labour,
            sum(o.planned_machine_hours * w.machine_rate_per_hour) AS machine,
            count(*) AS stages,
            count(*) FILTER (WHERE o.status = ANY (ARRAY['DONE'::text, 'SKIPPED'::text])) AS stages_done
           FROM wo_operations o
             JOIN work_centers w ON w.id = o.work_center_id
             LEFT JOIN labour_grades g ON g.id = w.default_grade_id
             CROSS JOIN company_settings s_1
          WHERE s_1.id = 1
          GROUP BY o.wo_id
        ), rc AS (
         SELECT wo_receipts.wo_id,
            sum(wo_receipts.value) AS received_value,
            sum(wo_receipts.rework_value) AS rework_value,
            sum(wo_receipts.scrap_value) AS scrap_value
           FROM wo_receipts
          GROUP BY wo_receipts.wo_id
        )
 SELECT h.id AS wo_id,
    h.wo_no,
    h.status,
    h.project_id,
    h.item_id,
    h.qty,
    h.qty_completed,
    COALESCE(pops.stages, 0::bigint) AS stages,
    COALESCE(pops.stages_done, 0::bigint) AS stages_done,
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
    h.carry_in_cost,
    h.is_rework,
    h.parent_wo_id,
    h.qty_rejected,
    COALESCE(rc.received_value, 0::numeric) AS fg_value,
    COALESCE(rc.rework_value, 0::numeric) AS rework_out_value,
    COALESCE(rc.scrap_value, 0::numeric) AS scrap_value,
    h.sale_value,
        CASE
            WHEN h.sale_value IS NOT NULL THEN h.sale_value - COALESCE(h.cost_total, round(h.carry_in_cost + COALESCE(mat.material, 0::numeric) + (COALESCE(tl.labour, 0::numeric) + COALESCE(tl.machine, 0::numeric)) * (1::numeric + s.overhead_pct / 100::numeric), 2))
            ELSE NULL::numeric
        END AS margin
   FROM production_orders h
     CROSS JOIN company_settings s
     LEFT JOIN mat ON mat.wo_id = h.id
     LEFT JOIN tl ON tl.wo_id = h.id
     LEFT JOIN plan ON plan.wo_id = h.id
     LEFT JOIN pops ON pops.wo_id = h.id
     LEFT JOIN rc ON rc.wo_id = h.id
  WHERE s.id = 1;

-- release: the material request asks Stores only for what is not already in the order's WIP (carried forward)
create or replace function wo_release(p_wo uuid) returns uuid language plpgsql security definer set search_path = public as $$
declare h production_orders%rowtype; p projects%rowtype; v_mr uuid;
begin
  if not has_role('production_incharge', 'factory_manager') then raise exception 'Only production planning can release orders'; end if;
  select * into h from production_orders where id = p_wo for update;
  if h.status <> 'APPROVED' and not (h.is_rework and h.status = 'DRAFT') then raise exception 'Order is % — the Factory Manager approves it before release', h.status; end if;
  if not exists (select 1 from wo_operations where wo_id = p_wo) then raise exception 'Add the production route (stages) first'; end if;
  select * into p from projects where id = h.project_id;
  if p.status <> 'OPEN' then raise exception 'Project / MTS order is not open'; end if;
  if exists (select 1 from wo_materials m where m.wo_id = p_wo and m.required_qty > 0
              and m.required_qty > coalesce((select sum(qty_left) from wip_lots w where w.wo_id = p_wo and w.item_id = m.item_id), 0) + 0.0005) then
    perform set_config('app.mr_sys', 'on', true);
    insert into material_requests (purpose, project_id, cost_center_id, required_date, priority, status, remarks, production_order_id, kind)
    values (case p.project_type when 'MTS' then 'MTS' when 'SALES' then 'SALES' when 'INTERNAL' then 'INTERNAL' else 'PROJECT' end, h.project_id,
            case when p.project_type = 'INTERNAL' then p.cost_center_id end, coalesce(h.due_date, current_date),
            h.priority, 'DRAFT', 'Materials for production order ' || h.wo_no || coalesce(' — ' || h.description, ''), p_wo, 'PRODUCTION')
    returning id into v_mr;
    insert into mr_lines (mr_id, line_no, item_id, requested_qty, remarks)
    select v_mr, row_number() over (order by code), item_id, need, h.wo_no || case when wip > 0 then ' · ' || trim_scale(round(wip, 3)) || ' already in WIP' else '' end
      from (select m.item_id, i.code, round(sum(m.required_qty), 3) - coalesce((select sum(qty_left) from wip_lots w where w.wo_id = p_wo and w.item_id = m.item_id), 0) need,
                   coalesce((select sum(qty_left) from wip_lots w where w.wo_id = p_wo and w.item_id = m.item_id), 0) wip
              from wo_materials m join items i on i.id = m.item_id where m.wo_id = p_wo and m.required_qty > 0 group by m.item_id, i.code) x
     where need > 0.0005;
    perform set_config('app.mr_sys', 'off', true);
  end if;
  update production_orders set status = 'RELEASED', released_at = now(), released_by = auth.uid(), mr_id = v_mr where id = p_wo;
  return v_mr;
end $$;