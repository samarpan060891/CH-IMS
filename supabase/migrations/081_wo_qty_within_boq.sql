-- 081 Production orders cannot exceed the project BOQ: the orders on a made in-house BOQ line (not cancelled, not rework)
-- add up to at most the BOQ quantity. An order for a project product that matches exactly one in-house BOQ line is
-- linked to it automatically, so the limit cannot be bypassed by leaving the BOQ line blank. Rework orders (QC rejects)
-- are outside the limit; more than the BOQ needs a variation order on the project first.
create or replace function wo_within_boq() returns trigger language plpgsql security definer set search_path = public as $$
declare b boq_lines%rowtype; v_other numeric; v_ptype text; v_n int;
begin
  if new.status = 'CANCELLED' or coalesce(new.is_rework, false) then return new; end if;
  select project_type into v_ptype from projects where id = new.project_id;
  -- link to the BOQ line when the product appears on exactly one made in-house line of the project
  if new.boq_line_id is null and v_ptype = 'PROJECT' then
    select count(*) into v_n from boq_lines where project_id = new.project_id and item_id = new.item_id and category = 'MANUFACTURED';
    if v_n = 1 then
      select id into new.boq_line_id from boq_lines where project_id = new.project_id and item_id = new.item_id and category = 'MANUFACTURED';
    elsif v_n > 1 then
      raise exception 'This product is on % BOQ lines of the project — choose the BOQ line on the production order', v_n;
    end if;
  end if;
  if new.boq_line_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.qty = old.qty and new.boq_line_id is not distinct from old.boq_line_id and new.status = old.status then return new; end if;
  select * into b from boq_lines where id = new.boq_line_id;
  select coalesce(sum(qty), 0) into v_other from production_orders
   where boq_line_id = new.boq_line_id and id <> new.id and status <> 'CANCELLED' and not is_rework;
  if v_other + new.qty > b.qty + 0.0005 then
    raise exception 'BOQ % (%) is % — % already on other production orders, so at most % can be ordered now (not %). For more, raise a variation order on the project.',
      coalesce(b.boq_ref, b.line_no::text), b.description, trim_scale(b.qty), trim_scale(v_other), trim_scale(greatest(b.qty - v_other, 0)), trim_scale(new.qty);
  end if;
  return new;
end $$;
drop trigger if exists trg_wo_within_boq on production_orders;
create trigger trg_wo_within_boq before insert or update on production_orders for each row execute function wo_within_boq();
