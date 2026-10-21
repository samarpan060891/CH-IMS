-- =====================================================================
-- Citi Homes IMS - 032 Batch & expiry control
--   * item master: batch control / expiry are decided at creation and frozen once the item is used
--   * GRN posting: batch no. mandatory for batch-controlled items, expiry mandatory for expiry items
--     (auto-filled from mfg / receipt date + shelf life); expired goods cannot be received;
--     damaged / excess lots keep the expiry date
--   * material issue: optional chosen batch (lot) per line, otherwise FIFO / FEFO as before
-- =====================================================================

-- ---------- freeze batch / expiry once the item has any transaction ----------
create or replace function public.trg_item_control_lock() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.batch_controlled is distinct from old.batch_controlled or new.has_expiry is distinct from old.has_expiry)
     and (exists (select 1 from stock_ledger where item_id = old.id) or exists (select 1 from grn_lines where item_id = old.id)
          or exists (select 1 from stock_lots where item_id = old.id)) then
    raise exception 'Batch control and expiry of % are fixed once the item has receipts or stock — create a new item code instead', old.code;
  end if;
  return new;
end $$;
create trigger item_control_lock before update of batch_controlled, has_expiry on items for each row execute function trg_item_control_lock();
revoke execute on function public.trg_item_control_lock() from public, anon, authenticated;

-- non-stock and serialised items carry no batch / expiry
update items i set batch_controlled = false, has_expiry = false
  from item_classes c where c.id = i.class_id and (c.tracking <> 'LOT' or c.valuation_method = 'EXPENSE')
   and (i.batch_controlled or i.has_expiry)
   and not exists (select 1 from stock_ledger where item_id = i.id) and not exists (select 1 from grn_lines where item_id = i.id);

-- ---------- GRN: enforce batch / expiry from the item master ----------
do $$
declare d text := pg_get_functiondef('public.post_grn(uuid)'::regprocedure);
begin
  if position('Batch no. is required' in d) > 0 then return; end if;
  d := replace(d, 'v_prt uuid; v_prt_n int := 0; v_exc_total numeric := 0;', 'v_prt uuid; v_prt_n int := 0; v_exc_total numeric := 0; v_bad text;');
  d := replace(d, $r$raise exception 'Only Stores can post a GRN (the site supervisor only for deliveries into a site store)';
  end if;$r$, $r$raise exception 'Only Stores can post a GRN (the site supervisor only for deliveries into a site store)';
  end if;
  -- batch / expiry control from the item master
  update grn_lines gl set expiry_date = coalesce(gl.mfg_date, gl.original_receipt_date, g.grn_date) + i.shelf_life_days
    from items i where gl.grn_id = p_grn and i.id = gl.item_id and i.has_expiry and gl.expiry_date is null and coalesce(i.shelf_life_days, 0) > 0;
  select string_agg(i.code, ', ' order by gl.line_no) into v_bad
    from grn_lines gl join items i on i.id = gl.item_id join item_classes c on c.id = i.class_id
   where gl.grn_id = p_grn and gl.received_qty > 0 and c.tracking = 'LOT' and c.valuation_method <> 'EXPENSE'
     and i.batch_controlled and coalesce(trim(gl.batch_no), '') = '';
  if v_bad is not null then raise exception 'Batch no. is required for batch-controlled item(s): %', v_bad; end if;
  select string_agg(i.code, ', ' order by gl.line_no) into v_bad
    from grn_lines gl join items i on i.id = gl.item_id
   where gl.grn_id = p_grn and gl.received_qty > 0 and i.has_expiry and gl.expiry_date is null;
  if v_bad is not null then raise exception 'Expiry date is required for item(s) with expiry: % (or set a shelf life in the item master)', v_bad; end if;
  select string_agg(i.code || ' (' || to_char(gl.expiry_date, 'DD-Mon-YYYY') || ')', ', ' order by gl.line_no) into v_bad
    from grn_lines gl join items i on i.id = gl.item_id
   where gl.grn_id = p_grn and gl.received_qty > 0 and gl.expiry_date is not null and gl.expiry_date <= g.grn_date and g.receipt_type <> 'OPENING';
  if v_bad is not null then raise exception 'Expired goods cannot be received: %', v_bad; end if;$r$);
  -- held lots (damaged / excess) keep the expiry date
  d := replace(d, 'source_id, received_date, unit_cost, qty_in, qty_on_hand,', 'source_id, received_date, expiry_date, unit_cost, qty_in, qty_on_hand,');
  d := replace(d, $r$'GRN', l.id, g.grn_date, v_cost, v_dmg, v_dmg,$r$, $r$'GRN', l.id, g.grn_date, l.expiry_date, v_cost, v_dmg, v_dmg,$r$);
  d := replace(d, $r$'GRN', l.id, g.grn_date, v_cost, v_exc, v_exc,$r$, $r$'GRN', l.id, g.grn_date, l.expiry_date, v_cost, v_exc, v_exc,$r$);
  if position('Batch no. is required' in d) = 0 then raise exception 'post_grn patch anchor not found'; end if;
  execute d;
end $$;

-- ---------- material issue: chosen batch ----------
alter table issue_lines add column lot_id uuid references stock_lots(id);
do $$
declare d text := pg_get_functiondef('public.post_issue(uuid)'::regprocedure);
begin
  if position('chosen batch' in d) > 0 then return; end if;
  d := replace(d, E'    v_line := 0;\n    for a in select * from fifo_consume(', E'    if l.lot_id is not null and not exists (select 1 from stock_lots s where s.id = l.lot_id and s.item_id = l.item_id\n        and s.location_id = h.from_location_id and s.status = ''AVAILABLE'' and (s.project_id is null or s.project_id is not distinct from h.project_id)) then\n      raise exception ''The chosen batch for % is not available at this location for this project'', l.code;\n    end if;\n    v_line := 0;\n    for a in select * from fifo_consume(');
  d := replace(d, E'h.project_id, h.cost_center_id) loop', E'h.project_id, h.cost_center_id, l.lot_id, false) loop');
  if position('chosen batch' in d) = 0 or position('l.lot_id, false) loop' in d) = 0 then raise exception 'post_issue patch anchor not found'; end if;
  execute d;
end $$;
