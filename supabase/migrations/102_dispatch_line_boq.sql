-- 102: a delivery line for a production order's finished goods always carries that order's BOQ line,
-- so the quantity counts as dispatched (billable) on the BOQ line whichever screen created it.
create or replace function trg_dispatch_line_boq() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.boq_line_id is null and new.production_order_id is not null then
    select boq_line_id into new.boq_line_id from production_orders where id = new.production_order_id;
  end if;
  return new;
end $$;
revoke execute on function trg_dispatch_line_boq() from public, anon, authenticated;
drop trigger if exists dispatch_line_boq on dispatch_lines;
create trigger dispatch_line_boq before insert or update of production_order_id, boq_line_id on dispatch_lines
  for each row execute function trg_dispatch_line_boq();
