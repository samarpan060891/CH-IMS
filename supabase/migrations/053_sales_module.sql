-- 053 Sales module: quotation â†’ sales order (customer or internal) â†’ production / stock / services / job work â†’ delivery â†’ invoice.
-- Each confirmed sales order gets a cost-collecting job in `projects` (type SALES or INTERNAL, code = SO number) so that material
-- requests, issues, production orders, deliveries, invoices and the margin report all work through the existing project link.
-- Internal orders (mock-ups, internal use) are approved by the Factory Manager and charged to a cost centre.

-- ---------- jobs ----------
alter table projects drop constraint projects_project_type_check;
alter table projects add constraint projects_project_type_check check (project_type in ('PROJECT','MTS','SALES','INTERNAL'));
alter table projects add column cost_center_id uuid references cost_centers(id);

-- material requests / issues: for a customer sales order (general free stock) or an internal order (cost centre + its job)
alter table material_requests drop constraint material_requests_purpose_check, drop constraint mr_target;
alter table material_requests add constraint material_requests_purpose_check check (purpose in ('PROJECT','MTS','SALES','INTERNAL','COST_CENTER')),
  add constraint mr_target check ((purpose in ('PROJECT','MTS','SALES') and project_id is not null) or (purpose = 'COST_CENTER' and cost_center_id is not null)
                                  or (purpose = 'INTERNAL' and project_id is not null and cost_center_id is not null));
alter table material_issues drop constraint material_issues_purpose_check, drop constraint issue_target;
alter table material_issues add constraint material_issues_purpose_check check (purpose in ('PROJECT','MTS','SALES','INTERNAL','COST_CENTER')),
  add constraint issue_target check ((purpose in ('PROJECT','MTS','SALES') and project_id is not null) or (purpose = 'COST_CENTER' and cost_center_id is not null)
                                     or (purpose = 'INTERNAL' and project_id is not null and cost_center_id is not null));

-- ---------- quotations ----------
create table quotations (
  id uuid primary key default gen_random_uuid(),
  qt_no text not null unique default next_doc_no('QT'),
  qt_date date not null default current_date,
  revision int not null default 0,
  revised_from uuid references quotations(id),
  customer_id uuid not null references customers(id),
  title text not null,
  customer_ref text,
  valid_until date default current_date + 30,
  delivery_weeks numeric,
  advance_pct numeric not null default 0,
  payment_term_id uuid references payment_terms(id),
  vat_rate numeric not null default 5,
  subtotal numeric not null default 0, vat_amount numeric not null default 0, total numeric not null default 0, est_cost numeric not null default 0,
  terms text, remarks text,
  status text not null default 'DRAFT' check (status in ('DRAFT','SENT','ACCEPTED','LOST','REVISED','CANCELLED')),
  lost_reason text,
  sales_order_id uuid,
  created_by uuid default auth.uid() references profiles(id), created_at timestamptz not null default now(),
  sent_at timestamptz
);
create table quotation_lines (
  id uuid primary key default gen_random_uuid(),
  qt_id uuid not null references quotations(id) on delete cascade,
  line_no int,
  line_type text not null default 'MADE' check (line_type in ('MADE','STOCK','SERVICE','JOB_WORK')),
  item_id uuid references items(id),
  work_center_id uuid references work_centers(id),
  description text not null,
  qty numeric not null default 1 check (qty > 0),
  uom text,
  rate numeric not null default 0,
  discount_pct numeric not null default 0 check (discount_pct between 0 and 100),
  amount numeric generated always as (round(qty * rate * (1 - discount_pct / 100), 2)) stored,
  est_unit_cost numeric not null default 0,
  remarks text
);

-- ---------- sales orders ----------
create table sales_orders (
  id uuid primary key default gen_random_uuid(),
  so_no text not null unique default next_doc_no('SO'),
  so_date date not null default current_date,
  so_type text not null default 'CUSTOMER' check (so_type in ('CUSTOMER','INTERNAL')),
  customer_id uuid references customers(id),
  cost_center_id uuid references cost_centers(id),
  quotation_id uuid references quotations(id),
  title text not null,
  customer_ref text,
  delivery_date date,
  delivery_address text,
  advance_pct numeric not null default 0,
  payment_term_id uuid references payment_terms(id),
  vat_rate numeric not null default 5,
  subtotal numeric not null default 0, vat_amount numeric not null default 0, total numeric not null default 0, est_cost numeric not null default 0,
  status text not null default 'DRAFT' check (status in ('DRAFT','PENDING_FM','REJECTED','CONFIRMED','CLOSED','CANCELLED')),
  project_id uuid references projects(id),
  approval_comments text,
  remarks text,
  created_by uuid default auth.uid() references profiles(id), created_at timestamptz not null default now(),
  confirmed_by uuid references profiles(id), confirmed_at timestamptz,
  constraint so_party check ((so_type = 'CUSTOMER' and customer_id is not null) or (so_type = 'INTERNAL' and cost_center_id is not null))
);
alter table quotations add constraint quotations_so_fk foreign key (sales_order_id) references sales_orders(id);
alter table projects add column sales_order_id uuid references sales_orders(id);
create table sales_order_lines (
  id uuid primary key default gen_random_uuid(),
  so_id uuid not null references sales_orders(id) on delete cascade,
  line_no int,
  line_type text not null default 'MADE' check (line_type in ('MADE','STOCK','SERVICE','JOB_WORK')),
  item_id uuid references items(id),
  work_center_id uuid references work_centers(id),
  description text not null,
  qty numeric not null default 1 check (qty > 0),
  uom text,
  rate numeric not null default 0,
  discount_pct numeric not null default 0 check (discount_pct between 0 and 100),
  amount numeric generated always as (round(qty * rate * (1 - discount_pct / 100), 2)) stored,
  est_unit_cost numeric not null default 0,
  production_order_id uuid references production_orders(id),
  service_done_qty numeric not null default 0,
  remarks text,
  constraint sol_kind check ((line_type in ('MADE','STOCK') and item_id is not null) or (line_type = 'JOB_WORK' and work_center_id is not null) or line_type = 'SERVICE')
);
-- machine hours sold (job work / work-centre hire): logged against the order line, costed at the work centre's rates
create table so_job_logs (
  id uuid primary key default gen_random_uuid(),
  so_line_id uuid not null references sales_order_lines(id),
  log_date date not null default current_date,
  machine_hours numeric not null default 0 check (machine_hours >= 0),
  labour_hours numeric not null default 0 check (labour_hours >= 0),
  machine_rate numeric not null default 0, labour_rate numeric not null default 0,
  cost numeric not null default 0,
  notes text,
  project_cost_id uuid,
  created_by uuid default auth.uid() references profiles(id), created_at timestamptz not null default now()
);

alter table dispatch_lines add column so_line_id uuid references sales_order_lines(id);
alter table sales_invoice_lines add column so_line_id uuid references sales_order_lines(id);
alter table sales_invoices drop constraint sales_invoices_inv_type_check;
alter table sales_invoices add constraint sales_invoices_inv_type_check check (inv_type in ('ADVANCE','PROGRESS','FINAL','RETENTION_RELEASE','GENERAL','CREDIT_NOTE','SALES'));
alter table project_costs drop constraint project_costs_source_check;
alter table project_costs add constraint project_costs_source_check check (source in ('SERVICE_GRN','INSTALL_LABOUR','SNAG_LABOUR','OTHER','JOB_WORK'));

-- ---------- totals ----------
create or replace function public.trg_qt_totals() returns trigger language plpgsql security definer set search_path = public as $$
declare v_id uuid := coalesce(new.qt_id, old.qt_id);
begin
  update quotations q set subtotal = s.sub, est_cost = s.cost, vat_amount = round(s.sub * q.vat_rate / 100, 2), total = s.sub + round(s.sub * q.vat_rate / 100, 2)
    from (select coalesce(sum(amount), 0) sub, coalesce(sum(qty * est_unit_cost), 0) cost from quotation_lines where qt_id = v_id) s where q.id = v_id;
  return null;
end $$;
create trigger qt_lines_totals after insert or update or delete on quotation_lines for each row execute function trg_qt_totals();
create or replace function public.trg_so_totals() returns trigger language plpgsql security definer set search_path = public as $$
declare v_id uuid := coalesce(new.so_id, old.so_id);
begin
  update sales_orders o set subtotal = s.sub, est_cost = s.cost, vat_amount = round(s.sub * o.vat_rate / 100, 2), total = s.sub + round(s.sub * o.vat_rate / 100, 2)
    from (select coalesce(sum(amount), 0) sub, coalesce(sum(qty * est_unit_cost), 0) cost from sales_order_lines where so_id = v_id) s where o.id = v_id;
  return null;
end $$;
create trigger so_lines_totals after insert or update or delete on sales_order_lines for each row execute function trg_so_totals();
-- VAT rate change on the header re-totals
create or replace function public.trg_sales_hdr_vat() returns trigger language plpgsql as $$
begin
  if new.vat_rate is distinct from old.vat_rate then new.vat_amount := round(new.subtotal * new.vat_rate / 100, 2); new.total := new.subtotal + new.vat_amount; end if;
  return new;
end $$;
create trigger qt_vat before update on quotations for each row execute function trg_sales_hdr_vat();
create trigger so_vat before update on sales_orders for each row execute function trg_sales_hdr_vat();
-- confirmed orders keep their lines (changes = new order / credit)
create or replace function public.trg_so_lines_lock() returns trigger language plpgsql security definer set search_path = public as $$
declare v_st text;
begin
  select status into v_st from sales_orders where id = coalesce(new.so_id, old.so_id);
  if v_st not in ('DRAFT','REJECTED') and current_setting('app.so_system', true) is distinct from 'on' then
    raise exception 'The sales order is %, its lines can no longer change', lower(v_st);
  end if;
  return coalesce(new, old);
end $$;
create trigger so_lines_lock before insert or update or delete on sales_order_lines for each row execute function trg_so_lines_lock();

-- ---------- progress per order line ----------
create or replace view v_so_lines as
select l.*, o.so_no, o.so_type, o.status so_status, o.project_id,
       coalesce((select sum(d.qty) from dispatch_lines d join dispatch_notes n on n.id = d.dispatch_id where d.so_line_id = l.id and n.status in ('POSTED','DELIVERED')), 0) delivered_qty,
       coalesce((select sum(j.machine_hours) from so_job_logs j where j.so_line_id = l.id), 0) hours_logged,
       coalesce((select sum(j.cost) from so_job_logs j where j.so_line_id = l.id), 0) job_cost,
       coalesce((select sum(il.cum_qty - il.prev_qty) from sales_invoice_lines il join sales_invoices i on i.id = il.invoice_id where il.so_line_id = l.id and i.status <> 'CANCELLED'), 0) invoiced_qty,
       w.wo_no, w.status wo_status, w.qty_completed wo_completed
  from sales_order_lines l join sales_orders o on o.id = l.so_id left join production_orders w on w.id = l.production_order_id;

-- what can be invoiced now: delivered goods, services done (or ordered), job-work hours logged
create or replace function public.so_line_billable(l v_so_lines) returns numeric language sql stable as $$
  select greatest(case l.line_type
    when 'SERVICE' then greatest(l.service_done_qty, case when l.service_done_qty = 0 then l.qty else 0 end)
    when 'JOB_WORK' then l.hours_logged
    else l.delivered_qty end - l.invoiced_qty, 0)
$$;

create or replace view v_sales_orders as
select o.*, c.name customer_name, cc.code cost_center_code,
       round(coalesce(x.delivered_value, 0), 2) delivered_value, round(coalesce(x.invoiced_value, 0), 2) invoiced_value,
       coalesce((select sum(taxable_amount) from sales_invoices i where i.project_id = o.project_id and i.inv_type = 'ADVANCE' and i.status = 'POSTED'), 0) advance_invoiced,
       round(coalesce(m.total_cost, 0) + coalesce(x.job_cost, 0), 2) actual_cost,
       case when o.so_type = 'CUSTOMER' then round(o.subtotal - coalesce(m.total_cost, 0) - coalesce(x.job_cost, 0), 2) end margin,
       case when o.so_type = 'CUSTOMER' and o.subtotal > 0 then round((o.subtotal - coalesce(m.total_cost, 0) - coalesce(x.job_cost, 0)) / o.subtotal * 100, 1) end margin_pct,
       case when o.subtotal > 0 then round(coalesce(x.delivered_value, 0) / o.subtotal * 100) else 0 end delivered_pct
  from sales_orders o
  left join customers c on c.id = o.customer_id
  left join cost_centers cc on cc.id = o.cost_center_id
  left join v_project_margin m on m.project_id = o.project_id
  left join lateral (select sum(case when l.line_type in ('MADE','STOCK') then least(l.delivered_qty, l.qty) / l.qty * l.amount
                                     when l.line_type = 'JOB_WORK' then least(l.hours_logged, l.qty) / l.qty * l.amount
                                     else least(greatest(l.service_done_qty, l.invoiced_qty), l.qty) / l.qty * l.amount end) delivered_value,
                            sum(least(l.invoiced_qty, l.qty) / l.qty * l.amount) invoiced_value, sum(l.job_cost) job_cost
                       from v_so_lines l where l.so_id = o.id) x on true;

-- ---------- quotation actions ----------
create or replace function public.quotation_action(p_qt uuid, p_action text, p_comments text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare q quotations%rowtype; v_new uuid; v_no text;
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
    insert into quotations (qt_no, revision, revised_from, customer_id, title, customer_ref, valid_until, delivery_weeks, advance_pct, payment_term_id, vat_rate, terms, remarks)
    values (regexp_replace(q.qt_no, '-R\d+$', '') || '-R' || (q.revision + 1), q.revision + 1, q.id, q.customer_id, q.title, q.customer_ref, current_date + 30, q.delivery_weeks,
            q.advance_pct, q.payment_term_id, q.vat_rate, q.terms, q.remarks) returning id into v_new;
    insert into quotation_lines (qt_id, line_no, line_type, item_id, work_center_id, description, qty, uom, rate, discount_pct, est_unit_cost, remarks)
      select v_new, line_no, line_type, item_id, work_center_id, description, qty, uom, rate, discount_pct, est_unit_cost, remarks from quotation_lines where qt_id = p_qt;
    update quotations set status = 'REVISED' where id = p_qt;
    return v_new;
  elsif p_action = 'ACCEPT' then
    if q.status not in ('DRAFT','SENT') then raise exception 'Quotation is %', q.status; end if;
    if not exists (select 1 from quotation_lines where qt_id = p_qt) then raise exception 'The quotation has no lines'; end if;
    insert into sales_orders (so_type, customer_id, quotation_id, title, customer_ref, delivery_date, advance_pct, payment_term_id, vat_rate, remarks)
    values ('CUSTOMER', q.customer_id, q.id, q.title, coalesce(p_comments, q.customer_ref), current_date + coalesce(round(q.delivery_weeks * 7)::int, 28), q.advance_pct,
            q.payment_term_id, q.vat_rate, q.remarks) returning id into v_new;
    insert into sales_order_lines (so_id, line_no, line_type, item_id, work_center_id, description, qty, uom, rate, discount_pct, est_unit_cost, remarks)
      select v_new, line_no, line_type, item_id, work_center_id, description, qty, uom, rate, discount_pct, est_unit_cost, remarks from quotation_lines where qt_id = p_qt;
    update quotations set status = 'ACCEPTED', sales_order_id = v_new where id = p_qt;
    return v_new;
  elsif p_action = 'LOST' then
    if q.status not in ('DRAFT','SENT') then raise exception 'Quotation is %', q.status; end if;
    if nullif(trim(p_comments), '') is null then raise exception 'Say why it was lost (price, time, competitorâ€¦)'; end if;
    update quotations set status = 'LOST', lost_reason = p_comments where id = p_qt;
    return p_qt;
  elsif p_action = 'CANCEL' then
    if q.status not in ('DRAFT','SENT') then raise exception 'Quotation is %', q.status; end if;
    update quotations set status = 'CANCELLED' where id = p_qt;
    return p_qt;
  end if;
  raise exception 'Unknown action %', p_action;
end $$;

-- ---------- sales order actions ----------
-- confirm: open the cost-collecting job and a draft production order for every made-in-house line
create or replace function public.so_confirm(p_so uuid) returns void language plpgsql security definer set search_path = public as $$
declare o sales_orders%rowtype; v_job uuid; l record; v_wo uuid; n int := 0;
begin
  select * into o from sales_orders where id = p_so;
  insert into projects (code, name, project_type, customer, customer_id, contract_value, advance_pct, payment_term_id, cost_center_id, end_date, start_date, status, sales_order_id, created_by)
  values (o.so_no, left(coalesce((select name from customers where id = o.customer_id) || ' â€” ', 'Internal â€” ') || o.title, 200),
          case when o.so_type = 'INTERNAL' then 'INTERNAL' else 'SALES' end, (select name from customers where id = o.customer_id), o.customer_id,
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
    perform notify('production_incharge', null, n || ' production order(s) for ' || o.so_no, o.title || ' â€” choose the BOM and route, then release', 'd/so/' || p_so, 'so', p_so);
  end if;
  perform notify('stores', null, 'Sales order ' || o.so_no || ' confirmed', o.title, 'd/so/' || p_so, 'so', p_so);
end $$;

create or replace function public.so_action(p_so uuid, p_action text, p_comments text default null)
returns text language plpgsql security definer set search_path = public as $$
declare o sales_orders%rowtype;
begin
  select * into o from sales_orders where id = p_so for update;
  if not found then raise exception 'Sales order not found'; end if;
  if p_action = 'SUBMIT' then
    if o.status not in ('DRAFT','REJECTED') then raise exception 'Order is %', o.status; end if;
    if not exists (select 1 from sales_order_lines where so_id = p_so) then raise exception 'Add the lines first'; end if;
    if o.so_type = 'INTERNAL' then
      if not (o.created_by = auth.uid() or has_role('sales','factory_manager','finance','production_incharge','stores')) then raise exception 'Not allowed'; end if;
      update sales_orders set status = 'PENDING_FM' where id = p_so;
      perform notify('factory_manager', null, 'Approve internal order ' || o.so_no, o.title || ' â€” charged to ' || (select code || ' ' || name from cost_centers where id = o.cost_center_id), 'd/so/' || p_so, 'so', p_so);
      return 'PENDING_FM';
    end if;
    if not has_role('sales','factory_manager','finance') then raise exception 'Only Sales / Finance / Factory Manager confirm customer orders'; end if;
    perform so_confirm(p_so);
    return 'CONFIRMED';
  elsif p_action in ('APPROVE','REJECT') then
    if not has_role('factory_manager') then raise exception 'The Factory Manager approves internal orders'; end if;
    if o.status <> 'PENDING_FM' then raise exception 'Order is %', o.status; end if;
    if p_action = 'REJECT' then
      if nullif(trim(p_comments), '') is null then raise exception 'Give a reason'; end if;
      update sales_orders set status = 'REJECTED', approval_comments = p_comments where id = p_so;
      perform notify(null, o.created_by, 'Internal order ' || o.so_no || ' rejected', p_comments, 'd/so/' || p_so, 'so', p_so);
      return 'REJECTED';
    end if;
    update sales_orders set approval_comments = p_comments where id = p_so;
    perform so_confirm(p_so);
    perform notify(null, o.created_by, 'Internal order ' || o.so_no || ' approved', 'Material can now be requested against it', 'd/so/' || p_so, 'so', p_so);
    return 'CONFIRMED';
  elsif p_action = 'CLOSE' then
    if not has_role('sales','factory_manager','finance') then raise exception 'Not allowed'; end if;
    if o.status <> 'CONFIRMED' then raise exception 'Order is %', o.status; end if;
    update sales_orders set status = 'CLOSED', remarks = coalesce(remarks || E'\n', '') || coalesce('Closed: ' || p_comments, '') where id = p_so;
    update projects set status = 'CLOSED' where id = o.project_id;
    return 'CLOSED';
  elsif p_action = 'CANCEL' then
    if not (has_role('sales','factory_manager','finance') or (o.created_by = auth.uid() and o.status in ('DRAFT','REJECTED'))) then raise exception 'Not allowed'; end if;
    if o.status in ('CLOSED','CANCELLED') then raise exception 'Order is %', o.status; end if;
    if o.project_id is not null and (exists (select 1 from stock_ledger where project_id = o.project_id)
         or exists (select 1 from sales_invoices where project_id = o.project_id and status <> 'CANCELLED')
         or exists (select 1 from production_orders where project_id = o.project_id and status not in ('DRAFT','CANCELLED'))) then
      raise exception 'Material, production or invoices already exist for this order â€” close it instead';
    end if;
    update production_orders set status = 'CANCELLED' where project_id = o.project_id and status = 'DRAFT';
    update projects set status = 'CLOSED' where id = o.project_id;
    update sales_orders set status = 'CANCELLED', remarks = coalesce(remarks || E'\n', '') || coalesce('Cancelled: ' || p_comments, '') where id = p_so;
    return 'CANCELLED';
  end if;
  raise exception 'Unknown action %', p_action;
end $$;

-- services done (part-billing of services)
create or replace function public.so_service_done(p_line uuid, p_qty numeric) returns void language plpgsql security definer set search_path = public as $$
declare l sales_order_lines%rowtype;
begin
  if not has_role('sales','factory_manager','finance','production_incharge','site_supervisor') then raise exception 'Not allowed'; end if;
  select * into l from sales_order_lines where id = p_line;
  if l.line_type <> 'SERVICE' then raise exception 'Only service lines'; end if;
  if p_qty < 0 or p_qty > l.qty then raise exception 'Done must be between 0 and %', l.qty; end if;
  perform set_config('app.so_system', 'on', true);
  update sales_order_lines set service_done_qty = p_qty where id = p_line;
  perform set_config('app.so_system', 'off', true);
end $$;

-- job work: machine (and operator) hours on the order line, costed at the work centre's rates + factory overhead %
create or replace function public.so_job_log(p_line uuid, p_date date, p_machine_hours numeric, p_labour_hours numeric, p_notes text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare l v_so_lines%rowtype; w work_centers%rowtype; v_lr numeric; v_cost numeric; v_id uuid; v_pc uuid; s company_settings%rowtype;
begin
  if not has_role('production_incharge','factory_manager','shop_floor') then raise exception 'Production logs job-work hours'; end if;
  select * into l from v_so_lines where id = p_line;
  if l.line_type <> 'JOB_WORK' then raise exception 'Only job-work lines'; end if;
  if l.so_status <> 'CONFIRMED' then raise exception 'The order is %', lower(l.so_status); end if;
  if coalesce(p_machine_hours, 0) <= 0 and coalesce(p_labour_hours, 0) <= 0 then raise exception 'Enter the hours'; end if;
  select * into w from work_centers where id = l.work_center_id;
  select * into s from company_settings where id = 1;
  v_lr := coalesce(w.labour_rate_per_hour, (select rate_per_hour from labour_grades where id = w.default_grade_id), 0);
  v_cost := round((coalesce(p_machine_hours, 0) * coalesce(w.machine_rate_per_hour, 0) + coalesce(p_labour_hours, 0) * v_lr) * (1 + coalesce(s.overhead_pct, 0) / 100), 2);
  insert into project_costs (project_id, cost_date, source, doc_no, description, qty, amount)
  values (l.project_id, coalesce(p_date, current_date), 'JOB_WORK', l.so_no, 'Job work â€” ' || w.name || ' ' || coalesce(p_machine_hours, 0) || ' h', p_machine_hours, v_cost)
  returning id into v_pc;
  insert into so_job_logs (so_line_id, log_date, machine_hours, labour_hours, machine_rate, labour_rate, cost, notes, project_cost_id)
  values (p_line, coalesce(p_date, current_date), coalesce(p_machine_hours, 0), coalesce(p_labour_hours, 0), coalesce(w.machine_rate_per_hour, 0), v_lr, v_cost, p_notes, v_pc)
  returning id into v_id;
  return v_id;
end $$;

-- invoice: a draft tax invoice for everything billable and not yet invoiced (advance recovered pro rata, the rest on the last invoice)
create or replace function public.so_invoice(p_so uuid) returns uuid language plpgsql security definer set search_path = public as $$
declare o sales_orders%rowtype; v_inv uuid; n int;
begin
  if not has_role('finance','factory_manager') then raise exception 'Finance prepares invoices'; end if;
  select * into o from sales_orders where id = p_so;
  if o.so_type <> 'CUSTOMER' then raise exception 'Internal orders are not invoiced'; end if;
  if o.status not in ('CONFIRMED','CLOSED') then raise exception 'Confirm the order first'; end if;
  if exists (select 1 from sales_invoices where project_id = o.project_id and inv_type = 'SALES' and status = 'DRAFT') then
    raise exception 'A draft invoice for this order already exists â€” post or cancel it first';
  end if;
  insert into sales_invoices (inv_type, customer_id, project_id, invoice_date, customer_ref, vat_rate, status)
  values ('SALES', o.customer_id, o.project_id, current_date, coalesce(o.customer_ref, o.so_no), o.vat_rate, 'DRAFT') returning id into v_inv;
  insert into sales_invoice_lines (invoice_id, line_no, so_line_id, description, uom, contract_qty, rate, prev_qty, cum_qty)
  select v_inv, l.line_no, l.id, l.description, l.uom, l.qty, round(l.rate * (1 - l.discount_pct / 100), 4), 0, so_line_billable(l)
    from v_so_lines l where l.so_id = p_so and so_line_billable(l) > 0;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'Nothing to invoice yet â€” deliver goods, mark services done or log job-work hours first'; end if;
  return v_inv;
end $$;

-- invoice amounts: sales invoices recover the advance like claims (pro rata, the full balance on the last invoice)
do $$
declare v text;
begin
  v := pg_get_functiondef('public.trg_si_amounts'::regproc);
  if position('''SALES''' in v) > 0 then return; end if;
  v := replace(v, $a$    if new.inv_type in ('PROGRESS','FINAL') then
      select retention_pct,$a$, $a$    if new.inv_type = 'SALES' then
      select advance_pct into new.advance_recovery_pct from projects where id = new.project_id;
      new.retention_pct := 0;
    end if;
    if new.inv_type in ('PROGRESS','FINAL') then
      select retention_pct,$a$);
  v := replace(v, $a$  else
    new.retention_amount := 0; new.advance_recovery := 0;
  end if;$a$, $a$  elsif new.inv_type = 'SALES' then
    new.retention_amount := 0;
    new.advance_recovery := greatest(least(round(v_base * coalesce(new.advance_recovery_pct, 0) / 100, 2), si_advance_balance(new.project_id, new.id)), 0);
    -- the invoice that completes the order recovers whatever advance is left
    if (select coalesce(sum(contract_value), 0) from projects where id = new.project_id) <= coalesce((select sum(gross_claimed) from sales_invoices
          where project_id = new.project_id and inv_type = 'SALES' and status <> 'CANCELLED' and id <> new.id), 0) + v_base + 0.01 then
      new.advance_recovery := greatest(si_advance_balance(new.project_id, new.id), 0);
    end if;
  else
    new.retention_amount := 0; new.advance_recovery := 0;
  end if;$a$);
  if position('advance_pct into new.advance_recovery_pct' in v) = 0 or position('the invoice that completes' in v) = 0 then raise exception 'trg_si_amounts anchor not found'; end if;
  execute v;
end $$;

-- production for internal orders draws material against the cost centre; finished goods made for an order belong to it
do $$
declare v text;
begin
  v := pg_get_functiondef('public.wo_release'::regproc);
  v := replace(v, $a$insert into material_requests (purpose, project_id, required_date, priority, status, remarks, production_order_id)
    values (case when p.project_type = 'MTS' then 'MTS' else 'PROJECT' end, h.project_id,$a$,
                  $a$insert into material_requests (purpose, project_id, cost_center_id, required_date, priority, status, remarks, production_order_id)
    values (case p.project_type when 'MTS' then 'MTS' when 'SALES' then 'SALES' when 'INTERNAL' then 'INTERNAL' else 'PROJECT' end, h.project_id,
            case when p.project_type = 'INTERNAL' then p.cost_center_id end,$a$);
  if position('INTERNAL' in v) = 0 then raise exception 'wo_release anchor not found'; end if;
  execute v;
  v := pg_get_functiondef('public.wo_fg_in'::regproc);
  v := replace(v, $a$case when p.project_type = 'PROJECT' then h.project_id end$a$, $a$case when p.project_type in ('PROJECT','SALES','INTERNAL') then h.project_id end$a$);
  if position('''SALES''' in v) = 0 then raise exception 'wo_fg_in anchor not found'; end if;
  execute v;
  -- deliveries for internal orders are charged to the order's cost centre
  v := pg_get_functiondef('public.post_dispatch'::regproc);
  v := replace(v, $a$h.dispatch_no, l.id, h.dispatch_date, h.project_id, null, null, false)$a$,
                  $a$h.dispatch_no, l.id, h.dispatch_date, h.project_id, (select cost_center_id from projects where id = h.project_id), null, false)$a$);
  if position('cost_center_id from projects' in v) = 0 then raise exception 'post_dispatch anchor not found'; end if;
  execute v;
  -- job-work hours post like installation labour (absorbed labour / machine cost into the order)
  v := pg_get_functiondef('public.gl_sync'::regproc);
  v := replace(v, $a$c.source in ('SERVICE_GRN','INSTALL_LABOUR','SNAG_LABOUR')$a$, $a$c.source in ('SERVICE_GRN','INSTALL_LABOUR','SNAG_LABOUR','JOB_WORK')$a$);
  if position('''JOB_WORK''' in v) = 0 then raise exception 'gl_sync anchor not found'; end if;
  execute v;
end $$;

-- ---------- security ----------
alter table quotations enable row level security;
alter table quotation_lines enable row level security;
alter table sales_orders enable row level security;
alter table sales_order_lines enable row level security;
alter table so_job_logs enable row level security;
create policy read_sales on quotations for select to authenticated using (has_role('sales','finance','factory_manager'));
create policy write_sales on quotations for all to authenticated using (has_role('sales','finance','factory_manager') and status in ('DRAFT','SENT'))
  with check (has_role('sales','finance','factory_manager') and status in ('DRAFT','SENT'));
create policy read_sales on quotation_lines for select to authenticated using (has_role('sales','finance','factory_manager'));
create policy write_sales on quotation_lines for all to authenticated
  using (has_role('sales','finance','factory_manager') and exists (select 1 from quotations q where q.id = qt_id and q.status in ('DRAFT','SENT')))
  with check (has_role('sales','finance','factory_manager') and exists (select 1 from quotations q where q.id = qt_id and q.status in ('DRAFT','SENT')));
-- every active user can see orders (to request material against them); internal drafts by their author, customer orders by Sales
create policy read_active on sales_orders for select to authenticated using (is_active_user());
create policy so_insert on sales_orders for insert to authenticated with check (status = 'DRAFT' and is_active_user() and (so_type = 'INTERNAL' or has_role('sales','finance','factory_manager')));
create policy so_update on sales_orders for update to authenticated
  using (status in ('DRAFT','REJECTED') and (has_role('sales','finance','factory_manager') or created_by = auth.uid()))
  with check (status in ('DRAFT','REJECTED') and (so_type = 'INTERNAL' or has_role('sales','finance','factory_manager')));
create policy so_delete on sales_orders for delete to authenticated using (status = 'DRAFT' and (has_role('sales','finance','factory_manager') or created_by = auth.uid()));
create policy read_active on sales_order_lines for select to authenticated using (is_active_user());
create policy sol_write on sales_order_lines for all to authenticated
  using (exists (select 1 from sales_orders o where o.id = so_id and o.status in ('DRAFT','REJECTED') and (has_role('sales','finance','factory_manager') or o.created_by = auth.uid())))
  with check (exists (select 1 from sales_orders o where o.id = so_id and o.status in ('DRAFT','REJECTED') and (has_role('sales','finance','factory_manager') or o.created_by = auth.uid())));
create policy read_active on so_job_logs for select to authenticated using (is_active_user());

-- Sales also keeps customers
drop policy fin_write on customers;
create policy fin_write on customers for all to authenticated using (has_role('finance','factory_manager','sales')) with check (has_role('finance','factory_manager','sales'));
create or replace function public.master_owner_roles(p_kind text, p_list text default null) returns app_role[]
language sql immutable as $$
  select case p_kind
    when 'VENDOR' then array['purchase','finance']::app_role[]
    when 'CUSTOMER' then array['sales','finance','factory_manager']::app_role[]
    when 'GL_ACCOUNT' then array['finance']::app_role[]
    when 'COST_CENTER' then array['finance','factory_manager']::app_role[]
    when 'ITEM' then array['stores','purchase']::app_role[]
    when 'UOM' then array['stores','purchase']::app_role[]
    when 'PROJECT' then array['factory_manager','finance']::app_role[]
    when 'EMPLOYEE' then array['hr_officer','factory_manager']::app_role[]
    when 'WORK_CENTER' then array['factory_manager','finance']::app_role[]
    when 'LOOKUP' then case p_list when 'BANK' then array['finance']::app_role[] when 'BRAND' then array['stores','purchase']::app_role[]
                                   when 'UNIT_TYPE' then array['factory_manager']::app_role[] when 'ROOM' then array['factory_manager','production_incharge']::app_role[]
                                   else array['hr_officer']::app_role[] end
    else array['admin']::app_role[] end
$$;

grant execute on function public.quotation_action(uuid, text, text), public.so_action(uuid, text, text), public.so_service_done(uuid, numeric),
  public.so_job_log(uuid, date, numeric, numeric, text), public.so_invoice(uuid) to authenticated;
revoke execute on function public.so_confirm(uuid) from public, anon, authenticated;
