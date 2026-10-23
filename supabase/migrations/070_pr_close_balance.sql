-- 070 Close the unordered balance of a requisition (part ordered, the rest no longer needed / ordered elsewhere).
-- Closed requisitions no longer count as "on order" in material planning, so a real remaining need shows up again.
alter table purchase_requisitions drop constraint purchase_requisitions_status_check;
alter table purchase_requisitions add constraint purchase_requisitions_status_check
  check (status in ('DRAFT', 'SUBMITTED', 'PARTIAL_PO', 'PO_CREATED', 'CLOSED', 'CANCELLED'));

create or replace function pr_close_balance(p_pr uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare r purchase_requisitions%rowtype;
begin
  if not has_role('purchase', 'factory_manager') then raise exception 'Only Purchase or the Factory Manager can close a requisition'; end if;
  select * into r from purchase_requisitions where id = p_pr for update;
  if r.status <> 'PARTIAL_PO' then raise exception 'Only a partly ordered requisition can be closed (this one is %)', r.status; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'Give a reason'; end if;
  update purchase_requisitions set status = 'CLOSED',
         remarks = coalesce(remarks || E'\n', '') || 'Balance closed: ' || p_reason where id = p_pr;
end $$;
revoke execute on function pr_close_balance(uuid, text) from public, anon;

-- a closed requisition keeps its status when POs against it change
create or replace function pr_ordered_sync() returns trigger language plpgsql security definer set search_path = public as $$
declare v_pr_line uuid := coalesce(new.pr_line_id, old.pr_line_id); v_pr uuid;
begin
  if v_pr_line is null then return null; end if;
  update pr_lines pl set ordered_qty = coalesce((
      select sum(l.qty) from po_lines l join purchase_orders p on p.id = l.po_id
       where l.pr_line_id = pl.id and p.status not in ('CANCELLED')), 0)
   where pl.id = v_pr_line returning pr_id into v_pr;
  update purchase_requisitions r set status = case
      when not exists (select 1 from pr_lines where pr_id = r.id and ordered_qty < qty) then 'PO_CREATED'
      when exists (select 1 from pr_lines where pr_id = r.id and ordered_qty > 0) then 'PARTIAL_PO'
      else 'SUBMITTED' end
   where r.id = v_pr and r.status not in ('DRAFT', 'CANCELLED', 'CLOSED');
  return null;
end $$;
