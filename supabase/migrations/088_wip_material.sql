-- 088 WIP — material on the shop floor. Material issued to a production order leaves the store (as before) and is held
-- in WIP for that order, by source batch and unit cost, until finished goods come out:
--   · each FG receipt (batch or final) consumes BOM per unit × units received (good + rework + scrap) from the order's WIP;
--     the final receipt consumes everything still in WIP for the order
--   · a return to store (good, damaged, offcut kept or scrapped) takes the quantity out of WIP
-- WIP is kept apart from store stock, so stock on hand, MRP and shortages stay "usable stock in the stores"; the order's
-- cost is unchanged (material issued to it).
create table if not exists wip_lots (
  id uuid primary key default gen_random_uuid(),
  wo_id uuid not null references production_orders(id),
  project_id uuid references projects(id),
  item_id uuid not null references items(id),
  issue_line_id uuid references issue_lines(id),
  src_lot_id uuid references stock_lots(id),
  qty_in numeric not null,
  qty_left numeric not null check (qty_left >= 0),
  unit_cost numeric not null default 0,
  issued_date date not null default current_date,
  created_at timestamptz not null default now()
);
create index if not exists wip_lots_wo on wip_lots (wo_id) where qty_left > 0;
create table if not exists wip_moves (
  id uuid primary key default gen_random_uuid(),
  wip_lot_id uuid not null references wip_lots(id),
  wo_id uuid not null references production_orders(id),
  item_id uuid not null references items(id),
  move_type text not null check (move_type in ('IN', 'CONSUME', 'RETURN', 'SCRAP')),
  qty numeric not null,
  value numeric not null default 0,
  doc_no text,
  moved_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
alter table wip_lots enable row level security;
alter table wip_moves enable row level security;
drop policy if exists read_active on wip_lots;
create policy read_active on wip_lots for select using (is_active_user());
drop policy if exists read_active on wip_moves;
create policy read_active on wip_moves for select using (is_active_user());

-- take qty of an item out of an order's WIP (oldest first; optionally only lots of one issue line)
create or replace function wip_take(p_wo uuid, p_item uuid, p_qty numeric, p_type text, p_doc text, p_issue_line uuid default null) returns numeric
language plpgsql security definer set search_path = public as $$
declare l record; v_left numeric := p_qty; v_t numeric; v_done numeric := 0;
begin
  for l in select * from wip_lots where wo_id = p_wo and item_id = p_item and qty_left > 0 and (p_issue_line is null or issue_line_id = p_issue_line)
           order by created_at for update loop
    exit when v_left <= 0.00005;
    v_t := least(v_left, l.qty_left);
    update wip_lots set qty_left = qty_left - v_t where id = l.id;
    insert into wip_moves (wip_lot_id, wo_id, item_id, move_type, qty, value, doc_no) values (l.id, p_wo, p_item, p_type, v_t, round(v_t * l.unit_cost, 2), p_doc);
    v_left := v_left - v_t; v_done := v_done + v_t;
  end loop;
  return v_done;
end $$;

-- an issue to a production order is posted → its batches go into the order's WIP
create or replace function wip_on_issue() returns trigger language plpgsql security definer set search_path = public as $$
declare a record; v_id uuid;
begin
  if new.status = 'POSTED' and old.status is distinct from 'POSTED' and new.production_order_id is not null then
    for a in select ill.*, il.item_id from issue_line_lots ill join issue_lines il on il.id = ill.issue_line_id where il.issue_id = new.id and ill.qty > 0 loop
      insert into wip_lots (wo_id, project_id, item_id, issue_line_id, src_lot_id, qty_in, qty_left, unit_cost, issued_date)
      values (new.production_order_id, new.project_id, a.item_id, a.issue_line_id, a.lot_id, a.qty, a.qty, a.unit_cost, new.issue_date)
      returning id into v_id;
      insert into wip_moves (wip_lot_id, wo_id, item_id, move_type, qty, value, doc_no) values (v_id, new.production_order_id, a.item_id, 'IN', a.qty, round(a.qty * a.unit_cost, 2), new.issue_no);
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists trg_wip_on_issue on material_issues;
create trigger trg_wip_on_issue after update of status on material_issues for each row execute function wip_on_issue();

-- a return of material issued to a production order is posted → out of the order's WIP
create or replace function wip_on_return() returns trigger language plpgsql security definer set search_path = public as $$
declare l record; v_wo uuid;
begin
  if new.status = 'POSTED' and old.status is distinct from 'POSTED' then
    select production_order_id into v_wo from material_issues where id = new.issue_id;
    if v_wo is null then return new; end if;
    for l in select rl.*, il.item_id from return_lines rl join issue_lines il on il.id = rl.issue_line_id where rl.return_id = new.id and rl.qty > 0 loop
      perform wip_take(v_wo, l.item_id, l.qty, case when l.condition = 'OFFCUT' and l.offcut_action = 'SCRAP' then 'SCRAP' else 'RETURN' end, new.return_no, l.issue_line_id);
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists trg_wip_on_return on material_returns;
create trigger trg_wip_on_return after update of status on material_returns for each row execute function wip_on_return();

-- finished goods received → consume BOM per unit × units from the order's WIP; the final receipt takes all that is left
create or replace function wip_on_receipt() returns trigger language plpgsql security definer set search_path = public as $$
declare h production_orders%rowtype; m record; v_units numeric := new.good_qty + new.rework_qty + new.scrap_qty;
begin
  select * into h from production_orders where id = new.wo_id;
  if new.is_final then
    for m in select item_id, sum(qty_left) q from wip_lots where wo_id = new.wo_id and qty_left > 0 group by item_id loop
      perform wip_take(new.wo_id, m.item_id, m.q, 'CONSUME', new.receipt_no);
    end loop;
  elsif v_units > 0 and h.qty > 0 then
    for m in select item_id, sum(required_qty) q from wo_materials where wo_id = new.wo_id group by item_id loop
      perform wip_take(new.wo_id, m.item_id, m.q / h.qty * v_units, 'CONSUME', new.receipt_no);
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists trg_wip_on_receipt on wo_receipts;
create trigger trg_wip_on_receipt after insert on wo_receipts for each row execute function wip_on_receipt();

-- material on the shop floor now
create or replace view v_wip_stock with (security_invoker = true) as
  select w.wo_id, h.wo_no, h.status wo_status, h.description wo_description, w.project_id, p.code project_code, w.item_id, i.code item_code, i.name item_name,
         u.code uom, sum(w.qty_left) qty, round(sum(w.qty_left * w.unit_cost), 2) value, min(w.issued_date) first_issued, max(w.issued_date) last_issued
    from wip_lots w join production_orders h on h.id = w.wo_id join items i on i.id = w.item_id left join uoms u on u.id = i.uom_id left join projects p on p.id = w.project_id
   where w.qty_left > 0.00005
   group by w.wo_id, h.wo_no, h.status, h.description, w.project_id, p.code, w.item_id, i.code, i.name, u.code;

-- per order and item: issued into WIP, consumed, returned / scrapped, still in WIP
create or replace view v_wip_by_order with (security_invoker = true) as
  select m.wo_id, m.item_id,
         sum(m.qty) filter (where m.move_type = 'IN') qty_in,
         coalesce(sum(m.qty) filter (where m.move_type = 'CONSUME'), 0) qty_consumed,
         coalesce(sum(m.qty) filter (where m.move_type in ('RETURN', 'SCRAP')), 0) qty_returned,
         sum(case when m.move_type = 'IN' then m.qty else -m.qty end) qty_wip,
         sum(case when m.move_type = 'IN' then m.value else -m.value end) value_wip
    from wip_moves m group by m.wo_id, m.item_id;

-- issues already posted to open orders: put what is not yet returned into WIP (nothing consumed yet unless FG received)
do $$
declare a record; v_id uuid;
begin
  for a in select ill.*, il.item_id, i.production_order_id wo, i.project_id, i.issue_date, i.issue_no
             from issue_line_lots ill join issue_lines il on il.id = ill.issue_line_id join material_issues i on i.id = il.issue_id
             join production_orders h on h.id = i.production_order_id
            where i.status = 'POSTED' and h.status in ('RELEASED', 'IN_PROGRESS') and ill.qty - ill.returned_qty > 0
              and not exists (select 1 from wip_lots w where w.issue_line_id = ill.issue_line_id and w.src_lot_id = ill.lot_id) loop
    insert into wip_lots (wo_id, project_id, item_id, issue_line_id, src_lot_id, qty_in, qty_left, unit_cost, issued_date)
    values (a.wo, a.project_id, a.item_id, a.issue_line_id, a.lot_id, a.qty - a.returned_qty, a.qty - a.returned_qty, a.unit_cost, a.issue_date) returning id into v_id;
    insert into wip_moves (wip_lot_id, wo_id, item_id, move_type, qty, value, doc_no) values (v_id, a.wo, a.item_id, 'IN', a.qty - a.returned_qty, round((a.qty - a.returned_qty) * a.unit_cost, 2), a.issue_no);
  end loop;
end $$;
