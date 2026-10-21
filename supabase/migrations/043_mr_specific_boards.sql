-- 043 Material requests for specific boards / offcut pieces
-- A request line may name the stock lot (a board stack or one offcut piece). Offcuts are requested whole and only on one
-- open request at a time; the issue made from the request takes exactly that lot.

alter table mr_lines add column lot_id uuid references stock_lots(id);

create or replace function public.trg_mr_line_lot() returns trigger
language plpgsql security definer set search_path = public as $$
declare l stock_lots%rowtype; m material_requests%rowtype; v_other text;
begin
  if new.lot_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.lot_id is not distinct from old.lot_id and new.requested_qty is not distinct from old.requested_qty
     and new.approved_qty is not distinct from old.approved_qty then return new; end if;
  select * into l from stock_lots where id = new.lot_id;
  select * into m from material_requests where id = new.mr_id;
  if l.item_id <> new.item_id then raise exception 'The chosen board / offcut is a different item'; end if;
  if l.status <> 'AVAILABLE' or l.qty_on_hand <= 0 then raise exception 'Board / offcut % is not available', l.lot_no; end if;
  if l.project_id is not null and l.project_id is distinct from m.project_id then raise exception 'Board lot % is reserved for another project', l.lot_no; end if;
  if l.is_offcut then
    -- whole piece, one open request at a time
    new.requested_qty := l.qty_on_hand;
    if new.approved_qty is not null then new.approved_qty := l.qty_on_hand; end if;
    select r.mr_no into v_other from mr_lines x join material_requests r on r.id = x.mr_id
     where x.lot_id = new.lot_id and x.id <> new.id and r.status in ('DRAFT','PENDING_APPROVAL','APPROVED','PARTIALLY_ISSUED','REJECTED')
       and x.issued_qty < coalesce(x.approved_qty, x.requested_qty) limit 1;
    if v_other is not null then raise exception 'Offcut % is already requested on %', l.lot_no, v_other; end if;
  elsif coalesce(new.approved_qty, new.requested_qty) > l.qty_on_hand + 0.0005 then
    raise exception 'Board lot % has only % — split the line', l.lot_no, l.qty_on_hand;
  end if;
  return new;
end $$;
create trigger mr_line_lot before insert or update on mr_lines for each row execute function trg_mr_line_lot();

-- an issue line made from a request line takes the requested board / offcut
create or replace function public.trg_issue_line_mr_lot() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.mr_line_id is not null and new.lot_id is null then
    select lot_id into new.lot_id from mr_lines where id = new.mr_line_id;
  end if;
  return new;
end $$;
create trigger issue_line_mr_lot before insert on issue_lines for each row execute function trg_issue_line_mr_lot();
