-- 092 Dispatch & invoicing by Stores / warehouse; Finance controls.
--   Stores: creates, fills, submits, cancels (draft / submitted) and posts SALES invoices and PROGRESS / FINAL claims;
--           a progress / final claim is posted after Finance has recorded the client's payment certificate
--   Finance: payment certificates, returning claims, ADVANCE and RETENTION_RELEASE invoices, CREDIT_NOTE and GENERAL
--           invoices, cancelling anything not posted, customer receipts and the accounts
create or replace function si_stores_type(t text) returns boolean language sql immutable as $$ select t in ('SALES', 'PROGRESS', 'FINAL') $$;

create or replace function si_action(p_inv uuid, p_action text, p_data jsonb default '{}') returns text language plpgsql security definer set search_path = public as $$
declare h sales_invoices%rowtype; v_lbl text; v_st boolean;
begin
  select * into h from sales_invoices where id = p_inv for update;
  if h.id is null then raise exception 'Invoice not found'; end if;
  v_lbl := case h.inv_type when 'CREDIT_NOTE' then 'Credit note ' else 'Invoice ' end || h.inv_no;
  -- Stores / warehouse may act on sales invoices and progress / final claims
  v_st := has_role('stores') and si_stores_type(h.inv_type);
  if p_action = 'SUBMIT' then
    if not (has_role('finance','factory_manager') or v_st) then raise exception 'Stores (sales invoices, claims) or Finance submit invoices'; end if;
    if h.status <> 'DRAFT' then raise exception '% is %', v_lbl, h.status; end if;
    if h.gross_claimed <= 0 then raise exception 'Nothing to claim — the lines total zero'; end if;
    update sales_invoices set status = 'SUBMITTED', submitted_by = auth.uid(), submitted_at = now() where id = p_inv;
    return 'SUBMITTED';
  elsif p_action = 'RETURN' then
    if not has_role('finance') then raise exception 'Finance returns claims'; end if;
    if h.status not in ('SUBMITTED','CERTIFIED') then raise exception '% is %', v_lbl, h.status; end if;
    update sales_invoice_lines set cert_cum_qty = null where invoice_id = p_inv;
    update sales_invoices set status = 'DRAFT', certified_gross = null, cert_no = null, cert_date = null, certified_by = null, certified_at = null where id = p_inv;
    return 'DRAFT';
  elsif p_action = 'CERTIFY' then
    if not has_role('finance') then raise exception 'Finance records payment certificates'; end if;
    if h.inv_type not in ('PROGRESS','FINAL') then raise exception 'Only progress claims are certified'; end if;
    if h.status <> 'SUBMITTED' then raise exception 'Submit the claim first'; end if;
    if nullif(p_data->>'cert_no', '') is null then raise exception 'Enter the payment certificate number'; end if;
    if p_data ? 'lines' then
      update sales_invoice_lines l set cert_cum_qty = (x->>'cert_cum_qty')::numeric
        from jsonb_array_elements(p_data->'lines') x where l.invoice_id = p_inv and l.id = (x->>'id')::uuid;
    end if;
    if exists (select 1 from sales_invoice_lines where invoice_id = p_inv and cert_cum_qty < prev_qty) then raise exception 'Certified quantity cannot be below the previous certificate'; end if;
    update sales_invoices set status = 'CERTIFIED', cert_no = p_data->>'cert_no', cert_date = coalesce(nullif(p_data->>'cert_date', '')::date, current_date),
           certified_gross = coalesce((select sum(cert_amount) from sales_invoice_lines where invoice_id = p_inv), 0), certified_by = auth.uid(), certified_at = now()
     where id = p_inv;
    return 'CERTIFIED';
  elsif p_action = 'POST' then
    if not (has_role('finance') or v_st) then raise exception 'Stores (sales invoices, certified claims) or Finance post invoices'; end if;
    if h.inv_type in ('PROGRESS','FINAL') and h.status <> 'CERTIFIED' then raise exception 'Record the payment certificate before posting'; end if;
    if h.status not in ('DRAFT','SUBMITTED','CERTIFIED') then raise exception '% is %', v_lbl, h.status; end if;
    if coalesce(h.certified_gross, h.gross_claimed) <= 0 then raise exception 'The invoice value is zero'; end if;
    if h.inv_type = 'RETENTION_RELEASE' and h.gross_claimed > si_retention_balance(h.project_id, h.id) + 0.01 then raise exception 'Only % retention is held', si_retention_balance(h.project_id, h.id); end if;
    if h.inv_type = 'CREDIT_NOTE' and h.credit_of is not null and h.total_amount > (select total_amount from sales_invoices where id = h.credit_of) then raise exception 'Credit note exceeds the original invoice'; end if;
    update sales_invoices set status = 'POSTED', posted_by = auth.uid(), posted_at = now(), invoice_date = gl_open_date(invoice_date) where id = p_inv;
    perform gl_sync_sales(p_inv);
    return 'POSTED';
  elsif p_action = 'CANCEL' then
    if not (has_role('finance') or (v_st and h.status in ('DRAFT', 'SUBMITTED'))) then raise exception 'Finance cancels invoices'; end if;
    if h.status = 'POSTED' then raise exception 'Posted invoices are corrected with a credit note'; end if;
    update sales_invoices set status = 'CANCELLED' where id = p_inv;
    return 'CANCELLED';
  end if;
  raise exception 'Unknown action %', p_action;
end $$;

create or replace function si_fill(p_inv uuid) returns int language plpgsql security definer set search_path = public as $$
declare h sales_invoices%rowtype; p projects%rowtype; n int := 0; v_amt numeric;
begin
  select * into h from sales_invoices where id = p_inv for update;
  if not (has_role('finance','factory_manager') or (has_role('stores') and si_stores_type(h.inv_type))) then raise exception 'Finance prepares invoices'; end if;
  if h.status <> 'DRAFT' then raise exception 'Only draft invoices can be refilled'; end if;
  select * into p from projects where id = h.project_id;
  if h.inv_type in ('PROGRESS','FINAL') and p.id is null then raise exception 'Choose the project'; end if;
  delete from sales_invoice_lines where invoice_id = p_inv;
  if h.inv_type in ('PROGRESS','FINAL') and p.billing_basis = 'UNIT' then
    insert into sales_invoice_lines (invoice_id, line_no, unit_id, description, uom, contract_qty, rate, prev_qty, cum_qty)
    select p_inv, row_number() over (order by u.unit_code), u.unit_id, u.unit_code || coalesce(' · ' || u.unit_type, ''), '%', 100,
           coalesce(nullif(u.sale_value, 0), u.boq_value) / 100, si_prev_qty(p_inv, null, u.unit_id),
           case when h.inv_type = 'FINAL' then 100 else least(round(u.progress_pct, 2), 100) end
      from v_unit_progress u where u.project_id = p.id and coalesce(nullif(u.sale_value, 0), u.boq_value) > 0;
  elsif h.inv_type in ('PROGRESS','FINAL') then
    insert into sales_invoice_lines (invoice_id, line_no, boq_line_id, description, uom, contract_qty, rate, prev_qty, cum_qty)
    select p_inv, b.line_no, b.boq_line_id, coalesce(b.boq_ref || ' ', '') || b.description, b.uom, b.qty, b.sell_rate, si_prev_qty(p_inv, b.boq_line_id, null),
           case when h.inv_type = 'FINAL' then b.qty else least(round(b.earned_value / nullif(b.sell_rate, 0), 3), b.qty) end
      from v_boq_progress b where b.project_id = p.id and b.sell_rate > 0;
  elsif h.inv_type = 'ADVANCE' then
    v_amt := round(coalesce(p.contract_value, 0) * p.advance_pct / 100, 2)
           - coalesce((select sum(taxable_amount) from sales_invoices where project_id = p.id and status = 'POSTED' and inv_type = 'ADVANCE' and id <> p_inv), 0);
    insert into sales_invoice_lines (invoice_id, description, uom, contract_qty, rate, cum_qty)
    values (p_inv, 'Advance payment ' || p.advance_pct || '% of contract value ' || to_char(p.contract_value, 'FM999,999,999,990.00'), 'LS', 1, greatest(v_amt, 0), 1);
  elsif h.inv_type = 'RETENTION_RELEASE' then
    insert into sales_invoice_lines (invoice_id, description, uom, contract_qty, rate, cum_qty)
    values (p_inv, 'Release of retention held', 'LS', 1, greatest(si_retention_balance(p.id, p_inv), 0), 1);
  end if;
  if h.inv_type in ('PROGRESS','FINAL') then delete from sales_invoice_lines where invoice_id = p_inv and amount = 0; end if;
  return (select count(*) from sales_invoice_lines where invoice_id = p_inv);
end $$;

create or replace function so_invoice(p_so uuid) returns uuid language plpgsql security definer set search_path = public as $$
declare o sales_orders%rowtype; v_inv uuid; n int;
begin
  if not has_role('finance','factory_manager','stores') then raise exception 'Stores or Finance prepare invoices'; end if;
  select * into o from sales_orders where id = p_so;
  if o.so_type = 'PROJECT' then raise exception 'Project orders are billed in the project: advance invoice, progress claims and retention'; end if;
  if o.so_type <> 'CUSTOMER' then raise exception 'Internal orders are not invoiced'; end if;
  if o.status not in ('CONFIRMED','CLOSED') then raise exception 'Confirm the order first'; end if;
  if exists (select 1 from sales_invoices where project_id = o.project_id and inv_type = 'SALES' and status = 'DRAFT') then
    raise exception 'A draft invoice for this order already exists — post or cancel it first';
  end if;
  insert into sales_invoices (inv_type, customer_id, project_id, invoice_date, customer_ref, vat_rate, status)
  values ('SALES', o.customer_id, o.project_id, current_date, coalesce(o.customer_ref, o.so_no), o.vat_rate, 'DRAFT') returning id into v_inv;
  insert into sales_invoice_lines (invoice_id, line_no, so_line_id, description, uom, contract_qty, rate, prev_qty, cum_qty)
  select v_inv, l.line_no, l.id, l.description, l.uom, l.qty, round(l.rate * (1 - l.discount_pct / 100), 4), 0, so_line_billable(l)
    from v_so_lines l where l.so_id = p_so and so_line_billable(l) > 0;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'Nothing to invoice yet — deliver goods, mark services done or log job-work hours first'; end if;
  return v_inv;
end $$;

-- table access: Stores reads all invoices and edits drafts of sales invoices / claims
drop policy if exists fin_read on sales_invoices;
create policy fin_read on sales_invoices for select using (has_role('finance', 'factory_manager', 'stores'));
drop policy if exists doc_insert on sales_invoices;
create policy doc_insert on sales_invoices for insert with check (status = 'DRAFT' and (has_role('finance', 'factory_manager') or (has_role('stores') and si_stores_type(inv_type))));
drop policy if exists doc_update on sales_invoices;
create policy doc_update on sales_invoices for update using (status = 'DRAFT' and (has_role('finance', 'factory_manager') or (has_role('stores') and si_stores_type(inv_type))))
  with check (status = 'DRAFT' and (has_role('finance', 'factory_manager') or (has_role('stores') and si_stores_type(inv_type))));
drop policy if exists doc_delete on sales_invoices;
create policy doc_delete on sales_invoices for delete using (status = 'DRAFT' and (has_role('finance', 'factory_manager') or (has_role('stores') and si_stores_type(inv_type))));
drop policy if exists fin_read on sales_invoice_lines;
create policy fin_read on sales_invoice_lines for select using (has_role('finance', 'factory_manager', 'stores'));
drop policy if exists line_write on sales_invoice_lines;
create policy line_write on sales_invoice_lines for all
  using (exists (select 1 from sales_invoices h where h.id = sales_invoice_lines.invoice_id and h.status = 'DRAFT'
                  and (has_role('finance', 'factory_manager') or (has_role('stores') and si_stores_type(h.inv_type)))))
  with check (exists (select 1 from sales_invoices h where h.id = sales_invoice_lines.invoice_id and h.status = 'DRAFT'
                  and (has_role('finance', 'factory_manager') or (has_role('stores') and si_stores_type(h.inv_type)))));
