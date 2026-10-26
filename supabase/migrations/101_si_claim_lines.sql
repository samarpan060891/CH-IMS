-- 101: a progress claim shows every BOQ line of the project (or every unit, for unit-wise billing):
-- contract qty, rate, previously certified, dispatched to date (= default cumulative). Lines with nothing this
-- period stay on the claim (0), as on an interim payment application.
create or replace function si_claim_lines(p_project uuid, p_final boolean default false, p_inv uuid default null)
returns table (line_no int, boq_line_id uuid, unit_id uuid, description text, uom text, contract_qty numeric, rate numeric,
               prev_qty numeric, done_qty numeric, cum_qty numeric)
language plpgsql stable security definer set search_path = public as $$
declare p projects%rowtype;
begin
  if not has_role('finance', 'factory_manager', 'stores') then raise exception 'Finance or Stores prepares progress claims'; end if;
  select * into p from projects where id = p_project;
  if p.id is null then raise exception 'Choose the project'; end if;
  if p.billing_basis = 'UNIT' then
    return query
    select (row_number() over (order by u.unit_code))::int, null::uuid, u.unit_id, u.unit_code || coalesce(' · ' || u.unit_type, ''), '%'::text, 100::numeric,
           coalesce(nullif(u.sale_value, 0), u.boq_value) / 100, pv.q, least(round(u.progress_pct, 2), 100),
           case when p_final then 100::numeric else greatest(least(round(u.progress_pct, 2), 100), pv.q) end
      from v_unit_progress u
      cross join lateral (select coalesce(max(coalesce(l.cert_cum_qty, l.cum_qty)), 0) q from sales_invoice_lines l join sales_invoices h on h.id = l.invoice_id
                           where h.project_id = p.id and h.id is distinct from p_inv and h.status in ('CERTIFIED', 'POSTED') and h.inv_type in ('PROGRESS', 'FINAL')
                             and l.unit_id = u.unit_id) pv
     where u.project_id = p.id and coalesce(nullif(u.sale_value, 0), u.boq_value) > 0;
  else
    return query
    select b.line_no::int, b.boq_line_id, null::uuid, coalesce(b.boq_ref || ' ', '') || b.description, b.uom, b.qty, b.sell_rate, pv.q,
           least(round(b.earned_value / nullif(b.sell_rate, 0), 3), b.qty),
           case when p_final then b.qty else greatest(least(round(b.earned_value / nullif(b.sell_rate, 0), 3), b.qty), pv.q) end
      from v_boq_progress b
      cross join lateral (select coalesce(max(coalesce(l.cert_cum_qty, l.cum_qty)), 0) q from sales_invoice_lines l join sales_invoices h on h.id = l.invoice_id
                           where h.project_id = p.id and h.id is distinct from p_inv and h.status in ('CERTIFIED', 'POSTED') and h.inv_type in ('PROGRESS', 'FINAL')
                             and l.boq_line_id = b.boq_line_id) pv
     where b.project_id = p.id and b.sell_rate > 0
     order by b.line_no;
  end if;
end $$;
revoke execute on function si_claim_lines(uuid, boolean, uuid) from public, anon;
grant execute on function si_claim_lines(uuid, boolean, uuid) to authenticated, service_role;

create or replace function si_fill(p_inv uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare h sales_invoices%rowtype; p projects%rowtype; v_amt numeric;
begin
  select * into h from sales_invoices where id = p_inv for update;
  if not (has_role('finance','factory_manager') or (has_role('stores') and si_stores_type(h.inv_type))) then raise exception 'Finance prepares invoices'; end if;
  if h.status <> 'DRAFT' then raise exception 'Only draft invoices can be refilled'; end if;
  select * into p from projects where id = h.project_id;
  if h.inv_type in ('PROGRESS','FINAL') and p.id is null then raise exception 'Choose the project'; end if;
  delete from sales_invoice_lines where invoice_id = p_inv;
  if h.inv_type in ('PROGRESS','FINAL') then
    insert into sales_invoice_lines (invoice_id, line_no, boq_line_id, unit_id, description, uom, contract_qty, rate, prev_qty, cum_qty)
    select p_inv, c.line_no, c.boq_line_id, c.unit_id, c.description, c.uom, c.contract_qty, c.rate, c.prev_qty, c.cum_qty
      from si_claim_lines(p.id, h.inv_type = 'FINAL', p_inv) c;
  elsif h.inv_type = 'ADVANCE' then
    v_amt := round(coalesce(p.contract_value, 0) * p.advance_pct / 100, 2)
           - coalesce((select sum(taxable_amount) from sales_invoices where project_id = p.id and status = 'POSTED' and inv_type = 'ADVANCE' and id <> p_inv), 0);
    insert into sales_invoice_lines (invoice_id, description, uom, contract_qty, rate, cum_qty)
    values (p_inv, 'Advance payment ' || p.advance_pct || '% of contract value ' || to_char(p.contract_value, 'FM999,999,999,990.00'), 'LS', 1, greatest(v_amt, 0), 1);
  elsif h.inv_type = 'RETENTION_RELEASE' then
    insert into sales_invoice_lines (invoice_id, description, uom, contract_qty, rate, cum_qty)
    values (p_inv, 'Release of retention held', 'LS', 1, greatest(si_retention_balance(p.id, p_inv), 0), 1);
  end if;
  return (select count(*) from sales_invoice_lines where invoice_id = p_inv);
end $$;
