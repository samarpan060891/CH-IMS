-- =====================================================================
-- Citi Homes IMS - 022 FG batch valuation: a partial receipt is valued at the higher of
-- planned unit cost and cost-to-date per open unit (protects against plans without material prices)
-- =====================================================================

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
