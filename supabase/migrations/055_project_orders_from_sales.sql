-- 055 Customer projects start in Sales: quotation (order type Project) → sales order of type PROJECT → on confirmation the project is
-- created with its contract terms and its BOQ from the order lines. Billing then stays project billing (advance, progress claims,
-- payment certificates, retention) in the project; the sales order is not invoiced itself.

alter table quotations add column order_type text not null default 'SALES' check (order_type in ('SALES','PROJECT')),
  add column retention_pct numeric not null default 0, add column advance_recovery_pct numeric,
  add column billing_basis text not null default 'BOQ_ITEM' check (billing_basis in ('BOQ_ITEM','UNIT')), add column site_address text;
alter table sales_orders drop constraint sales_orders_so_type_check, drop constraint so_party;
alter table sales_orders add constraint sales_orders_so_type_check check (so_type in ('CUSTOMER','INTERNAL','PROJECT')),
  add constraint so_party check ((so_type in ('CUSTOMER','PROJECT') and customer_id is not null) or (so_type = 'INTERNAL' and cost_center_id is not null));
alter table sales_orders add column retention_pct numeric not null default 0, add column advance_recovery_pct numeric,
  add column billing_basis text not null default 'BOQ_ITEM' check (billing_basis in ('BOQ_ITEM','UNIT'));
-- BOQ details carried on quotation / order lines of project orders
alter table quotation_lines add column boq_ref text, add column unit_type text, add column unit_codes text, add column qty_per_unit numeric,
  add column supply_mode text check (supply_mode in ('FACTORY','DIRECT_TO_SITE')), add column service_mode text check (service_mode in ('OWN_TEAM','SUBCONTRACT','HIRED'));
alter table sales_order_lines add column boq_ref text, add column unit_type text, add column unit_codes text, add column qty_per_unit numeric,
  add column supply_mode text check (supply_mode in ('FACTORY','DIRECT_TO_SITE')), add column service_mode text check (service_mode in ('OWN_TEAM','SUBCONTRACT','HIRED'));

-- next free PRJ-nnnn code
create or replace function public.next_project_code() returns text language sql stable set search_path = public as $$
  select 'PRJ-' || lpad((coalesce(max((substring(code from '^PRJ-(\d+)$'))::int), 0) + 1)::text, 4, '0') from projects where code ~ '^PRJ-\d+$'
$$;

-- quotation actions: accepting a project quotation creates a PROJECT sales order; revisions keep the project terms and BOQ details
create or replace function public.quotation_action(p_qt uuid, p_action text, p_comments text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare q quotations%rowtype; v_new uuid;
begin
  if not has_role('sales','factory_manager','finance') then raise exception 'Only Sales / Finance / Factory Manager handle quotations'; end if;
  select * into q from quotations where id = p_qt for update;
  if not found then raise exception 'Quotation not found'; end if;
  if p_action = 'SEND' then
    if q.status not in ('DRAFT','SENT') then raise exception 'Quotation is %', q.status; end if;
    if not exists (select 1 from quotation_lines where qt_id = p_qt) then raise exception 'Add the lines first'; end if;
    update quotations set status = 'SENT', sent_at = now() where id = p_qt;
    return p_qt;
  elsif p_action = 'REVISE' then
    if q.status not in ('DRAFT','SENT') then raise exception 'Quotation is %', q.status; end if;
    insert into quotations (qt_no, revision, revised_from, customer_id, title, customer_ref, valid_until, delivery_weeks, advance_pct, payment_term_id, vat_rate, terms, remarks,
                            order_type, retention_pct, advance_recovery_pct, billing_basis, site_address)
    values (regexp_replace(q.qt_no, '-R\d+$', '') || '-R' || (q.revision + 1), q.revision + 1, q.id, q.customer_id, q.title, q.customer_ref, current_date + 30, q.delivery_weeks,
            q.advance_pct, q.payment_term_id, q.vat_rate, q.terms, q.remarks, q.order_type, q.retention_pct, q.advance_recovery_pct, q.billing_basis, q.site_address) returning id into v_new;
    insert into quotation_lines (qt_id, line_no, line_type, item_id, work_center_id, description, qty, uom, rate, discount_pct, est_unit_cost, remarks,
                                 boq_ref, unit_type, unit_codes, qty_per_unit, supply_mode, service_mode)
      select v_new, line_no, line_type, item_id, work_center_id, description, qty, uom, rate, discount_pct, est_unit_cost, remarks,
             boq_ref, unit_type, unit_codes, qty_per_unit, supply_mode, service_mode from quotation_lines where qt_id = p_qt;
    update quotations set status = 'REVISED' where id = p_qt;
    return v_new;
  elsif p_action = 'ACCEPT' then
    if q.status not in ('DRAFT','SENT') then raise exception 'Quotation is %', q.status; end if;
    if not exists (select 1 from quotation_lines where qt_id = p_qt) then raise exception 'The quotation has no lines'; end if;
    insert into sales_orders (so_type, customer_id, quotation_id, title, customer_ref, delivery_date, delivery_address, advance_pct, payment_term_id, vat_rate, remarks,
                              retention_pct, advance_recovery_pct, billing_basis)
    values (case when q.order_type = 'PROJECT' then 'PROJECT' else 'CUSTOMER' end, q.customer_id, q.id, q.title, coalesce(p_comments, q.customer_ref),
            current_date + coalesce(round(q.delivery_weeks * 7)::int, 28), q.site_address, q.advance_pct, q.payment_term_id, q.vat_rate, q.remarks,
            q.retention_pct, q.advance_recovery_pct, q.billing_basis) returning id into v_new;
    insert into sales_order_lines (so_id, line_no, line_type, item_id, work_center_id, description, qty, uom, rate, discount_pct, est_unit_cost, remarks,
                                   boq_ref, unit_type, unit_codes, qty_per_unit, supply_mode, service_mode)
      select v_new, line_no, line_type, item_id, work_center_id, description, qty, uom, rate, discount_pct, est_unit_cost, remarks,
             boq_ref, unit_type, unit_codes, qty_per_unit, supply_mode, service_mode from quotation_lines where qt_id = p_qt;
    update quotations set status = 'ACCEPTED', sales_order_id = v_new where id = p_qt;
    return v_new;
  elsif p_action = 'LOST' then
    if q.status not in ('DRAFT','SENT') then raise exception 'Quotation is %', q.status; end if;
    if nullif(trim(p_comments), '') is null then raise exception 'Say why it was lost (price, time, competitor…)'; end if;
    update quotations set status = 'LOST', lost_reason = p_comments where id = p_qt;
    return p_qt;
  elsif p_action = 'CANCEL' then
    if q.status not in ('DRAFT','SENT') then raise exception 'Quotation is %', q.status; end if;
    update quotations set status = 'CANCELLED' where id = p_qt;
    return p_qt;
  end if;
  raise exception 'Unknown action %', p_action;
end $$;

-- confirming a PROJECT order creates the customer project with its contract terms and BOQ (production orders are then planned from the BOQ)
create or replace function public.so_confirm(p_so uuid) returns void language plpgsql security definer set search_path = public as $$
declare o sales_orders%rowtype; v_job uuid; l record; v_wo uuid; n int := 0; v_cust text;
begin
  select * into o from sales_orders where id = p_so;
  select name into v_cust from customers where id = o.customer_id;
  if o.so_type = 'PROJECT' then
    if exists (select 1 from sales_order_lines where so_id = p_so and line_type = 'JOB_WORK') then raise exception 'Job-work lines are not part of a project BOQ — sell them on a normal sales order'; end if;
    insert into projects (code, name, project_type, customer, customer_id, site_address, contract_value, advance_pct, advance_recovery_pct, retention_pct, payment_term_id,
                          billing_basis, start_date, end_date, status, sales_order_id, created_by)
    values (next_project_code(), left(o.title, 200), 'PROJECT', v_cust, o.customer_id, o.delivery_address, o.subtotal, o.advance_pct, o.advance_recovery_pct, o.retention_pct,
            o.payment_term_id, o.billing_basis, current_date, o.delivery_date, 'OPEN', o.id, auth.uid())
    returning id into v_job;
    insert into boq_lines (project_id, line_no, boq_ref, description, category, item_id, uom, unit_type, unit_codes, qty_per_unit, qty, sell_rate, est_unit_cost, supply_mode, service_mode, remarks)
      select v_job, row_number() over (order by line_no), coalesce(boq_ref, line_no::text), description,
             case line_type when 'MADE' then 'MANUFACTURED' when 'STOCK' then 'BOUGHT_OUT' else 'SERVICE' end, item_id, uom, unit_type, unit_codes, qty_per_unit, qty,
             round(rate * (1 - discount_pct / 100), 4), est_unit_cost,
             case when line_type = 'STOCK' then coalesce(supply_mode, 'FACTORY') end, case when line_type = 'SERVICE' then coalesce(service_mode, 'SUBCONTRACT') end, remarks
        from sales_order_lines where so_id = p_so;
    update sales_orders set status = 'CONFIRMED', project_id = v_job, confirmed_by = auth.uid(), confirmed_at = now() where id = p_so;
    perform notify('factory_manager', null, 'New project from ' || o.so_no || ': ' || o.title, coalesce(v_cust, '') || ' — add units, plan production and lock the BOQ baseline', 'd/proj/' || v_job, 'project', v_job);
    perform notify('production_incharge', null, 'New project from ' || o.so_no || ': ' || o.title, 'Plan production orders from the BOQ', 'd/proj/' || v_job, 'project', v_job);
    return;
  end if;
  insert into projects (code, name, project_type, customer, customer_id, contract_value, advance_pct, payment_term_id, cost_center_id, end_date, start_date, status, sales_order_id, created_by)
  values (o.so_no, left(coalesce(v_cust || ' — ', 'Internal — ') || o.title, 200),
          case when o.so_type = 'INTERNAL' then 'INTERNAL' else 'SALES' end, v_cust, o.customer_id,
          case when o.so_type = 'CUSTOMER' then o.subtotal end, o.advance_pct, o.payment_term_id, o.cost_center_id, o.delivery_date, current_date, 'OPEN', o.id, auth.uid())
  returning id into v_job;
  perform set_config('app.so_system', 'on', true);
  for l in select * from sales_order_lines where so_id = p_so and line_type = 'MADE' order by line_no loop
    insert into production_orders (project_id, item_id, description, qty, due_date, priority, sale_value, remarks)
    values (v_job, l.item_id, l.description, l.qty, o.delivery_date, 'NORMAL', l.amount, 'Sales order ' || o.so_no)
    returning id into v_wo;
    update sales_order_lines set production_order_id = v_wo where id = l.id;
    n := n + 1;
  end loop;
  perform set_config('app.so_system', 'off', true);
  update sales_orders set status = 'CONFIRMED', project_id = v_job, confirmed_by = auth.uid(), confirmed_at = now() where id = p_so;
  if n > 0 then
    perform notify('production_incharge', null, n || ' production order(s) for ' || o.so_no, o.title || ' — choose the BOM and route, then release', 'd/so/' || p_so, 'so', p_so);
  end if;
  perform notify('stores', null, 'Sales order ' || o.so_no || ' confirmed', o.title, 'd/so/' || p_so, 'so', p_so);
end $$;
revoke execute on function public.so_confirm(uuid) from public, anon, authenticated;

-- project orders are billed in the project (advance, progress claims, retention), not from the sales order
do $$
declare v text;
begin
  v := pg_get_functiondef('public.so_invoice'::regproc);
  v := replace(v, $a$if o.so_type <> 'CUSTOMER' then raise exception 'Internal orders are not invoiced'; end if;$a$,
                  $a$if o.so_type = 'PROJECT' then raise exception 'Project orders are billed in the project: advance invoice, progress claims and retention'; end if;
  if o.so_type <> 'CUSTOMER' then raise exception 'Internal orders are not invoiced'; end if;$a$);
  if position('billed in the project' in v) = 0 then raise exception 'so_invoice anchor not found'; end if;
  execute v;
end $$;
