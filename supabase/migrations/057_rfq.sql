-- 057 Requests for quotation: one RFQ (usually from a requisition) goes to several suppliers; their prices and lead times are entered,
-- compared side by side, each line is awarded to a supplier, and the awarded lines become draft POs (one per supplier, linked to the
-- requisition lines so they count as ordered). The vendor price list is updated with the winning prices.

create table rfqs (
  id uuid primary key default gen_random_uuid(),
  rfq_no text not null unique default next_doc_no('RFQ'),
  rfq_date date not null default current_date,
  title text not null,
  pr_id uuid references purchase_requisitions(id),
  required_date date,
  quote_due_date date default current_date + 5,
  delivery_location_id uuid references locations(id),
  status text not null default 'DRAFT' check (status in ('DRAFT','SENT','AWARDED','CLOSED','CANCELLED')),
  terms text, remarks text,
  created_by uuid default auth.uid() references profiles(id), created_at timestamptz not null default now(),
  sent_at timestamptz, awarded_by uuid references profiles(id), awarded_at timestamptz
);
create table rfq_vendors (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid not null references rfqs(id) on delete cascade,
  vendor_id uuid not null references vendors(id),
  status text not null default 'INVITED' check (status in ('INVITED','QUOTED','DECLINED')),
  quote_ref text, quote_date date, valid_until date,
  currency text not null default 'AED', exchange_rate numeric not null default 1,
  payment_term_id uuid references payment_terms(id),
  delivery_days int,
  remarks text,
  po_id uuid references purchase_orders(id),
  unique (rfq_id, vendor_id)
);
create table rfq_lines (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid not null references rfqs(id) on delete cascade,
  line_no int,
  item_id uuid not null references items(id),
  description text,
  qty numeric not null check (qty > 0),
  required_date date,
  project_id uuid references projects(id),
  pr_line_id uuid references pr_lines(id),
  remarks text,
  awarded_vendor_id uuid references rfq_vendors(id)
);
create table rfq_quotes (
  id uuid primary key default gen_random_uuid(),
  rfq_vendor_id uuid not null references rfq_vendors(id) on delete cascade,
  rfq_line_id uuid not null references rfq_lines(id) on delete cascade,
  rate numeric not null check (rate >= 0),
  lead_days int,
  remarks text,
  unique (rfq_vendor_id, rfq_line_id)
);

-- side-by-side comparison: every line × invited supplier, rates in AED, lowest price per line flagged
create or replace view v_rfq_compare with (security_invoker = true) as
select l.rfq_id, l.id rfq_line_id, l.line_no, l.item_id, l.qty, v.id rfq_vendor_id, v.vendor_id, d.name vendor_name, v.status vendor_status, v.currency, v.exchange_rate,
       q.rate, round(q.rate * v.exchange_rate, 4) rate_aed, round(l.qty * q.rate * v.exchange_rate, 2) amount_aed, coalesce(q.lead_days, v.delivery_days) lead_days, q.remarks,
       q.rate is not null and q.rate * v.exchange_rate = min(q.rate * v.exchange_rate) over (partition by l.id) is_lowest,
       l.awarded_vendor_id = v.id is_awarded
  from rfq_lines l join rfq_vendors v on v.rfq_id = l.rfq_id join vendors d on d.id = v.vendor_id
  left join rfq_quotes q on q.rfq_line_id = l.id and q.rfq_vendor_id = v.id;

-- an RFQ from the open quantities of a requisition, inviting the suppliers already known for those items
create or replace function public.rfq_from_pr(p_pr uuid) returns uuid language plpgsql security definer set search_path = public as $$
declare p purchase_requisitions%rowtype; v_id uuid;
begin
  if not has_role('purchase') then raise exception 'Purchase raises RFQs'; end if;
  select * into p from purchase_requisitions where id = p_pr;
  if not found then raise exception 'Requisition not found'; end if;
  if not exists (select 1 from pr_lines where pr_id = p_pr and qty > ordered_qty) then raise exception 'Everything on this requisition is already ordered'; end if;
  insert into rfqs (title, pr_id, required_date, remarks)
  values ('Quotation for ' || p.pr_no, p_pr, p.required_date, p.remarks) returning id into v_id;
  insert into rfq_lines (rfq_id, line_no, item_id, description, qty, required_date, project_id, pr_line_id, remarks)
    select v_id, row_number() over (order by l.line_no), l.item_id, i.name, l.qty - l.ordered_qty, l.required_date, l.project_id, l.id, l.remarks
      from pr_lines l join items i on i.id = l.item_id where l.pr_id = p_pr and l.qty > l.ordered_qty;
  insert into rfq_vendors (rfq_id, vendor_id, currency, payment_term_id)
    select distinct on (d.id) v_id, d.id, coalesce(d.currency, 'AED'), d.payment_term_id
      from item_vendors iv join vendors d on d.id = iv.vendor_id
     where iv.item_id in (select item_id from rfq_lines where rfq_id = v_id) and d.status = 'ACTIVE';
  return v_id;
end $$;

create or replace function public.rfq_action(p_rfq uuid, p_action text) returns text language plpgsql security definer set search_path = public as $$
declare r rfqs%rowtype;
begin
  if not has_role('purchase') then raise exception 'Purchase handles RFQs'; end if;
  select * into r from rfqs where id = p_rfq for update;
  if p_action = 'SEND' then
    if r.status not in ('DRAFT','SENT') then raise exception 'RFQ is %', r.status; end if;
    if not exists (select 1 from rfq_lines where rfq_id = p_rfq) then raise exception 'Add the items first'; end if;
    if not exists (select 1 from rfq_vendors where rfq_id = p_rfq) then raise exception 'Invite at least one supplier'; end if;
    update rfqs set status = 'SENT', sent_at = coalesce(sent_at, now()) where id = p_rfq;
    return 'SENT';
  elsif p_action = 'CANCEL' then
    if r.status not in ('DRAFT','SENT') then raise exception 'RFQ is %', r.status; end if;
    update rfqs set status = 'CANCELLED' where id = p_rfq; return 'CANCELLED';
  elsif p_action = 'CLOSE' then
    if r.status <> 'AWARDED' then raise exception 'RFQ is %', r.status; end if;
    update rfqs set status = 'CLOSED' where id = p_rfq; return 'CLOSED';
  end if;
  raise exception 'Unknown action %', p_action;
end $$;

-- award each line to a supplier ([{line, vendor}]; vendor null = not awarded) — only to suppliers who quoted that line
create or replace function public.rfq_award(p_rfq uuid, p_awards jsonb) returns int language plpgsql security definer set search_path = public as $$
declare a jsonb; n int := 0;
begin
  if not has_role('purchase') then raise exception 'Purchase awards RFQs'; end if;
  if (select status from rfqs where id = p_rfq) <> 'SENT' then raise exception 'Send the RFQ and enter the quotes first'; end if;
  for a in select * from jsonb_array_elements(p_awards) loop
    if nullif(a->>'vendor', '') is not null and not exists (select 1 from rfq_quotes q join rfq_vendors v on v.id = q.rfq_vendor_id
         where q.rfq_line_id = (a->>'line')::uuid and v.id = (a->>'vendor')::uuid and v.rfq_id = p_rfq) then
      raise exception 'A line can only be awarded to a supplier who quoted it';
    end if;
    update rfq_lines set awarded_vendor_id = nullif(a->>'vendor', '')::uuid where id = (a->>'line')::uuid and rfq_id = p_rfq;
    n := n + 1;
  end loop;
  return n;
end $$;

-- one draft PO per awarded supplier; requisition lines become ordered; price list updated with the winning prices
create or replace function public.rfq_make_pos(p_rfq uuid) returns int language plpgsql security definer set search_path = public as $$
declare r rfqs%rowtype; v record; v_po uuid; n int := 0; s company_settings%rowtype;
begin
  if not has_role('purchase') then raise exception 'Purchase creates POs'; end if;
  select * into r from rfqs where id = p_rfq for update;
  if r.status <> 'SENT' then raise exception 'RFQ is %', r.status; end if;
  if not exists (select 1 from rfq_lines where rfq_id = p_rfq and awarded_vendor_id is not null) then raise exception 'Award at least one line first'; end if;
  select * into s from company_settings where id = 1;
  for v in select rv.*, d.vendor_type, d.name vendor_name from rfq_vendors rv join vendors d on d.id = rv.vendor_id
            where rv.rfq_id = p_rfq and exists (select 1 from rfq_lines where awarded_vendor_id = rv.id) loop
    insert into purchase_orders (vendor_id, po_date, currency, exchange_rate, payment_term_id, po_type, delivery_date, delivery_location_id, project_id, quotation_ref, terms_conditions, remarks)
    values (v.vendor_id, current_date, v.currency, v.exchange_rate, coalesce(v.payment_term_id, (select payment_term_id from vendors where id = v.vendor_id)), v.vendor_type,
            coalesce(r.required_date, current_date + coalesce(v.delivery_days, 14)), r.delivery_location_id,
            (select case when count(distinct project_id) = 1 and count(*) = count(project_id) then min(project_id::text)::uuid end from rfq_lines where awarded_vendor_id = v.id),
            coalesce(v.quote_ref, r.rfq_no), s.po_terms_conditions, 'From ' || r.rfq_no || coalesce(' · quote ' || v.quote_ref, ''))
    returning id into v_po;
    insert into po_lines (po_id, line_no, item_id, description, qty, rate, vat_rate, required_date, pr_line_id, project_id)
      select v_po, row_number() over (order by l.line_no), l.item_id, coalesce(l.description, i.name), l.qty, q.rate,
             case when v.vendor_type = 'IMPORT' then 0 else coalesce(i.vat_rate, 5) end, l.required_date, l.pr_line_id, l.project_id
        from rfq_lines l join rfq_quotes q on q.rfq_line_id = l.id and q.rfq_vendor_id = v.id join items i on i.id = l.item_id
       where l.awarded_vendor_id = v.id;
    update rfq_vendors set po_id = v_po where id = v.id;
    -- the winning price goes on the vendor price list
    insert into item_vendors (item_id, vendor_id, price, currency, lead_time_days, valid_to)
      select l.item_id, v.vendor_id, q.rate, v.currency, coalesce(q.lead_days, v.delivery_days), v.valid_until
        from rfq_lines l join rfq_quotes q on q.rfq_line_id = l.id and q.rfq_vendor_id = v.id where l.awarded_vendor_id = v.id
      on conflict (item_id, vendor_id) do update set price = excluded.price, currency = excluded.currency,
        lead_time_days = coalesce(excluded.lead_time_days, item_vendors.lead_time_days), valid_to = coalesce(excluded.valid_to, item_vendors.valid_to);
    n := n + 1;
  end loop;
  update rfqs set status = 'AWARDED', awarded_by = auth.uid(), awarded_at = now() where id = p_rfq;
  return n;
end $$;

-- ---------- security ----------
alter table rfqs enable row level security;
alter table rfq_vendors enable row level security;
alter table rfq_lines enable row level security;
alter table rfq_quotes enable row level security;
create policy rfq_read on rfqs for select to authenticated using (has_role('purchase','finance','factory_manager','stores'));
create policy rfq_write on rfqs for all to authenticated using (has_role('purchase') and status in ('DRAFT','SENT')) with check (has_role('purchase') and status in ('DRAFT','SENT'));
create policy rfq_read on rfq_vendors for select to authenticated using (has_role('purchase','finance','factory_manager','stores'));
create policy rfq_write on rfq_vendors for all to authenticated
  using (has_role('purchase') and exists (select 1 from rfqs r where r.id = rfq_id and r.status in ('DRAFT','SENT')))
  with check (has_role('purchase') and exists (select 1 from rfqs r where r.id = rfq_id and r.status in ('DRAFT','SENT')));
create policy rfq_read on rfq_lines for select to authenticated using (has_role('purchase','finance','factory_manager','stores'));
create policy rfq_write on rfq_lines for all to authenticated
  using (has_role('purchase') and exists (select 1 from rfqs r where r.id = rfq_id and r.status in ('DRAFT','SENT')))
  with check (has_role('purchase') and exists (select 1 from rfqs r where r.id = rfq_id and r.status in ('DRAFT','SENT')));
create policy rfq_read on rfq_quotes for select to authenticated using (has_role('purchase','finance','factory_manager','stores'));
create policy rfq_write on rfq_quotes for all to authenticated
  using (has_role('purchase') and exists (select 1 from rfq_vendors v join rfqs r on r.id = v.rfq_id where v.id = rfq_vendor_id and r.status = 'SENT'))
  with check (has_role('purchase') and exists (select 1 from rfq_vendors v join rfqs r on r.id = v.rfq_id where v.id = rfq_vendor_id and r.status = 'SENT'));
grant execute on function public.rfq_from_pr(uuid), public.rfq_action(uuid, text), public.rfq_award(uuid, jsonb), public.rfq_make_pos(uuid) to authenticated;
