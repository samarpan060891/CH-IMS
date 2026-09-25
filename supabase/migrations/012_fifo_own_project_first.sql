-- fifo_consume: own-project lots must sort first. (l.project_id = p_project) is NULL for free lots and
-- NULLs sort first in DESC order, so coalesce the comparison to false.
create or replace function public.fifo_consume(
  p_item uuid, p_location uuid, p_qty numeric, p_project uuid,
  p_txn_type text, p_doc_type text, p_doc_id uuid, p_doc_no text, p_doc_line uuid, p_date date,
  p_ledger_project uuid default null, p_cost_center uuid default null,
  p_lot uuid default null, p_all_lots boolean default false)
returns table (lot_id uuid, qty numeric, unit_cost numeric)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare r record; v_need numeric := p_qty; v_take numeric; v_cost numeric; v_code text; v_reserved numeric;
begin
  if p_qty <= 0 then return; end if;
  for r in select l.id, l.qty_on_hand from stock_lots l
            where l.item_id = p_item and l.location_id = p_location and l.qty_on_hand > 0
              and (p_lot is null or l.id = p_lot)
              and (p_all_lots or p_lot is not null or l.status = 'AVAILABLE')
              and (p_all_lots or l.project_id is null or l.project_id = p_project)
            order by coalesce(l.project_id = p_project, false) desc,   -- own reserved stock first
                     (l.project_id is not null) asc,                     -- then free stock, other projects last
                     l.expiry_date nulls last, l.received_date, l.created_at
            for update
  loop
    exit when v_need <= 0;
    v_take := least(v_need, r.qty_on_hand);
    v_cost := lot_issue_cost(r.id);
    update stock_lots set qty_on_hand = qty_on_hand - v_take where id = r.id;
    insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value,
                              doc_type, doc_id, doc_no, doc_line_id, project_id, cost_center_id)
    values (p_date, p_txn_type, p_item, p_location, r.id, -v_take, v_cost, -round(v_take * v_cost, 2),
            p_doc_type, p_doc_id, p_doc_no, p_doc_line, p_ledger_project, p_cost_center);
    lot_id := r.id; qty := v_take; unit_cost := v_cost;
    return next;
    v_need := v_need - v_take;
  end loop;
  if v_need > 0.0005 then
    select code into v_code from items where id = p_item;
    select coalesce(sum(l.qty_on_hand), 0) into v_reserved from stock_lots l
     where l.item_id = p_item and l.location_id = p_location and l.qty_on_hand > 0
       and l.project_id is not null and l.project_id is distinct from p_project;
    raise exception '%', format('Insufficient stock for %s at this location: short by %s%s', v_code, round(v_need, 3),
      case when v_reserved > 0 and not p_all_lots
           then format(' (%s more is reserved for other projects — ask the Factory Manager to release it)', round(v_reserved, 3))
           else '' end);
  end if;
end $$;
revoke execute on function public.fifo_consume(uuid,uuid,numeric,uuid,text,text,uuid,text,uuid,date,uuid,uuid,uuid,boolean) from public, anon, authenticated;
