-- 038 Customer billing: customers, progress claims with payment certificates, advance & recovery, retention, receipts, VAT 201, AR aging

alter table company_settings add column emirate text default 'Ajman';

create table customers (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  name            text not null,
  trn             text,
  address         text,
  emirate         text,
  country         text default 'UAE',
  contact_person  text,
  phone           text,
  email           text,
  payment_term_id uuid references payment_terms(id),
  credit_limit    numeric(16,2),
  status          text not null default 'ACTIVE' check (status in ('ACTIVE','BLOCKED','INACTIVE')),
  remarks         text,
  created_by      uuid default auth.uid() references profiles(id),
  created_at      timestamptz not null default now()
);
alter table journal_lines add constraint journal_lines_customer_fk foreign key (customer_id) references customers(id);

alter table projects add column customer_id uuid references customers(id),
  add column advance_pct numeric(6,2) not null default 0,
  add column advance_recovery_pct numeric(6,2),
  add column retention_pct numeric(6,2) not null default 0,
  add column payment_term_id uuid references payment_terms(id);

create table sales_invoices (
  id               uuid primary key default gen_random_uuid(),
  inv_no           text not null unique default next_doc_no('SI'),
  inv_type         text not null default 'PROGRESS' check (inv_type in ('ADVANCE','PROGRESS','FINAL','RETENTION_RELEASE','GENERAL','CREDIT_NOTE')),
  customer_id      uuid not null references customers(id),
  project_id       uuid references projects(id),
  invoice_date     date not null default current_date,
  due_date         date,
  claim_no         int,
  period_to        date,
  customer_ref     text,
  credit_of        uuid references sales_invoices(id),
  status           text not null default 'DRAFT' check (status in ('DRAFT','SUBMITTED','CERTIFIED','POSTED','CANCELLED')),
  gross_claimed    numeric(16,2) not null default 0,
  cert_no          text,
  cert_date        date,
  certified_gross  numeric(16,2),
  retention_pct    numeric(6,2) not null default 0,
  retention_amount numeric(16,2) not null default 0,
  advance_recovery_pct numeric(6,2) not null default 0,
  advance_recovery numeric(16,2) not null default 0,
  taxable_amount   numeric(16,2) not null default 0,
  vat_rate         numeric(5,2) not null default 5,
  vat_amount       numeric(16,2) not null default 0,
  total_amount     numeric(16,2) not null default 0,
  remarks          text,
  gl_je_id         uuid references journal_entries(id),
  created_by       uuid default auth.uid() references profiles(id),
  created_at       timestamptz not null default now(),
  submitted_by     uuid references profiles(id), submitted_at timestamptz,
  certified_by     uuid references profiles(id), certified_at timestamptz,
  posted_by        uuid references profiles(id), posted_at timestamptz
);
create index sales_invoices_proj_idx on sales_invoices(project_id);
create index sales_invoices_cust_idx on sales_invoices(customer_id);

create table sales_invoice_lines (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references sales_invoices(id) on delete cascade,
  line_no       int not null default 1,
  boq_line_id   uuid references boq_lines(id),
  unit_id       uuid references project_units(id),
  description   text,
  uom           text,
  contract_qty  numeric(14,3),
  rate          numeric(16,4) not null default 0,
  prev_qty      numeric(14,3) not null default 0,
  cum_qty       numeric(14,3) not null default 0,
  cert_cum_qty  numeric(14,3),
  account_id    uuid references gl_accounts(id),
  amount        numeric(16,2) generated always as (round((cum_qty - prev_qty) * rate, 2)) stored,
  cert_amount   numeric(16,2) generated always as (round((coalesce(cert_cum_qty, cum_qty) - prev_qty) * rate, 2)) stored
);
create index sales_invoice_lines_inv_idx on sales_invoice_lines(invoice_id);

-- advance invoiced (posted) minus recovered so far on a project, excluding one invoice
create or replace function public.si_advance_balance(p_project uuid, p_exclude uuid default null) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(case when inv_type = 'ADVANCE' then taxable_amount else -advance_recovery end), 0)
    from sales_invoices where project_id = p_project and status = 'POSTED' and id is distinct from p_exclude
$$;
create or replace function public.si_retention_balance(p_project uuid, p_exclude uuid default null) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(case when inv_type = 'RETENTION_RELEASE' then -taxable_amount else retention_amount end), 0)
    from sales_invoices where project_id = p_project and status = 'POSTED' and id is distinct from p_exclude
$$;

create or replace function public.trg_si_amounts() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_base numeric;
begin
  if tg_op = 'INSERT' and new.project_id is not null then
    select coalesce(new.customer_id, customer_id) into new.customer_id from projects where id = new.project_id;
    if new.inv_type in ('PROGRESS','FINAL') then
      select retention_pct, coalesce(advance_recovery_pct, advance_pct) into new.retention_pct, new.advance_recovery_pct from projects where id = new.project_id;
      if new.claim_no is null then
        select coalesce(max(claim_no), 0) + 1 into new.claim_no from sales_invoices where project_id = new.project_id and inv_type in ('PROGRESS','FINAL') and status <> 'CANCELLED';
      end if;
    end if;
  end if;
  if tg_op = 'INSERT' and new.inv_type = 'RETENTION_RELEASE' then new.vat_rate := 0; end if;
  if tg_op = 'INSERT' and new.due_date is null then
    select new.invoice_date + coalesce(t.credit_days, 30) into new.due_date
      from (select 1) x left join payment_terms t on t.id = coalesce((select payment_term_id from projects where id = new.project_id), (select payment_term_id from customers where id = new.customer_id));
  end if;
  if tg_op = 'UPDATE' and old.status = 'POSTED' then return new; end if;
  v_base := coalesce(new.certified_gross, new.gross_claimed);
  if new.inv_type in ('PROGRESS','FINAL') then
    new.retention_amount := round(v_base * new.retention_pct / 100, 2);
    new.advance_recovery := greatest(least(round(v_base * new.advance_recovery_pct / 100, 2), si_advance_balance(new.project_id, new.id)), 0);
    if new.inv_type = 'FINAL' then new.advance_recovery := greatest(si_advance_balance(new.project_id, new.id), 0); end if;
  else
    new.retention_amount := 0; new.advance_recovery := 0;
  end if;
  new.taxable_amount := v_base - new.advance_recovery;
  new.vat_amount := round(new.taxable_amount * new.vat_rate / 100, 2);
  new.total_amount := new.taxable_amount + new.vat_amount - new.retention_amount;
  return new;
end $$;
create trigger si_amounts before insert or update on sales_invoices for each row execute function trg_si_amounts();

create or replace function public.trg_si_lines() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_inv uuid := coalesce(new.invoice_id, old.invoice_id); v_st text;
begin
  select status into v_st from sales_invoices where id = v_inv;
  if v_st in ('POSTED','CANCELLED') then raise exception 'The invoice is %', lower(v_st); end if;
  update sales_invoices set gross_claimed = coalesce((select sum(amount) from sales_invoice_lines where invoice_id = v_inv), 0),
         certified_gross = case when status = 'CERTIFIED' then coalesce((select sum(cert_amount) from sales_invoice_lines where invoice_id = v_inv), 0) end
   where id = v_inv;
  return null;
end $$;
create trigger si_lines after insert or update or delete on sales_invoice_lines for each row execute function trg_si_lines();

-- quantities already certified on earlier claims
create or replace function public.si_prev_qty(p_inv uuid, p_boq uuid, p_unit uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(max(coalesce(l.cert_cum_qty, l.cum_qty)), 0) from sales_invoice_lines l join sales_invoices h on h.id = l.invoice_id
   where h.id <> p_inv and h.status in ('CERTIFIED','POSTED') and h.inv_type in ('PROGRESS','FINAL')
     and h.project_id = (select project_id from sales_invoices where id = p_inv)
     and l.boq_line_id is not distinct from p_boq and l.unit_id is not distinct from p_unit
$$;

-- fill a claim from site progress (BOQ items or units, per the project's billing basis); advance / retention release get one line
create or replace function public.si_fill(p_inv uuid) returns int
language plpgsql security definer set search_path = public as $$
declare h sales_invoices%rowtype; p projects%rowtype; n int := 0; v_amt numeric;
begin
  if not has_role('finance','factory_manager') then raise exception 'Finance prepares invoices'; end if;
  select * into h from sales_invoices where id = p_inv for update;
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

create or replace function public.si_action(p_inv uuid, p_action text, p_data jsonb default '{}'::jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare h sales_invoices%rowtype; v_lbl text;
begin
  select * into h from sales_invoices where id = p_inv for update;
  if h.id is null then raise exception 'Invoice not found'; end if;
  v_lbl := case h.inv_type when 'CREDIT_NOTE' then 'Credit note ' else 'Invoice ' end || h.inv_no;
  if p_action = 'SUBMIT' then
    if not has_role('finance','factory_manager') then raise exception 'Finance submits claims'; end if;
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
    -- payment certificate from the client / consultant: cert no, date, optional certified cumulative qty per line
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
    if not has_role('finance') then raise exception 'Finance posts invoices'; end if;
    if h.inv_type in ('PROGRESS','FINAL') and h.status <> 'CERTIFIED' then raise exception 'Record the payment certificate before posting'; end if;
    if h.status not in ('DRAFT','SUBMITTED','CERTIFIED') then raise exception '% is %', v_lbl, h.status; end if;
    if coalesce(h.certified_gross, h.gross_claimed) <= 0 then raise exception 'The invoice value is zero'; end if;
    if h.inv_type = 'RETENTION_RELEASE' and h.gross_claimed > si_retention_balance(h.project_id, h.id) + 0.01 then raise exception 'Only % retention is held', si_retention_balance(h.project_id, h.id); end if;
    if h.inv_type = 'CREDIT_NOTE' and h.credit_of is not null and h.total_amount > (select total_amount from sales_invoices where id = h.credit_of) then raise exception 'Credit note exceeds the original invoice'; end if;
    update sales_invoices set status = 'POSTED', posted_by = auth.uid(), posted_at = now(), invoice_date = gl_open_date(invoice_date) where id = p_inv;
    perform gl_sync_sales(p_inv);
    return 'POSTED';
  elsif p_action = 'CANCEL' then
    if not has_role('finance') then raise exception 'Finance cancels invoices'; end if;
    if h.status = 'POSTED' then raise exception 'Posted invoices are corrected with a credit note'; end if;
    update sales_invoices set status = 'CANCELLED' where id = p_inv;
    return 'CANCELLED';
  end if;
  raise exception 'Unknown action %', p_action;
end $$;

create table customer_receipts (
  id            uuid primary key default gen_random_uuid(),
  receipt_no    text not null unique default next_doc_no('RV'),
  receipt_date  date not null default current_date,
  customer_id   uuid not null references customers(id),
  project_id    uuid references projects(id),
  mode          text not null default 'BANK_TRANSFER' check (mode in ('BANK_TRANSFER','CHEQUE','PDC','CASH')),
  bank_name     text,
  reference_no  text,
  cheque_date   date,
  amount        numeric(16,2) not null check (amount > 0),
  status        text not null default 'DRAFT' check (status in ('DRAFT','POSTED','CLEARED','BOUNCED','CANCELLED')),
  remarks       text,
  gl_je_id      uuid references journal_entries(id),
  gl_clear_je_id uuid references journal_entries(id),
  gl_bounce_je_id uuid references journal_entries(id),
  created_by    uuid default auth.uid() references profiles(id),
  created_at    timestamptz not null default now(),
  posted_by     uuid references profiles(id), posted_at timestamptz
);
create table receipt_allocations (
  id          uuid primary key default gen_random_uuid(),
  receipt_id  uuid not null references customer_receipts(id) on delete cascade,
  invoice_id  uuid not null references sales_invoices(id),
  amount      numeric(16,2) not null check (amount > 0)
);
create index receipt_allocations_inv_idx on receipt_allocations(invoice_id);

create or replace view v_sales_invoice_balance with (security_invoker = true) as
select h.id invoice_id, h.inv_no, h.inv_type, h.customer_id, c.name customer_name, h.project_id, p.code project_code, h.invoice_date, h.due_date,
       case when h.inv_type = 'CREDIT_NOTE' then -h.total_amount else h.total_amount end total_amount,
       coalesce(a.allocated, 0) allocated,
       case when h.inv_type = 'CREDIT_NOTE' then -h.total_amount else h.total_amount - coalesce(a.allocated, 0) end balance,
       greatest(current_date - h.due_date, 0) days_overdue
  from sales_invoices h join customers c on c.id = h.customer_id left join projects p on p.id = h.project_id
  left join (select ra.invoice_id, sum(ra.amount) allocated from receipt_allocations ra join customer_receipts r on r.id = ra.receipt_id
              where r.status in ('POSTED','CLEARED') group by ra.invoice_id) a on a.invoice_id = h.id
 where h.status = 'POSTED';

create or replace function public.receipt_action(p_rcpt uuid, p_action text) returns text
language plpgsql security definer set search_path = public as $$
declare r customer_receipts%rowtype; v_alloc numeric;
begin
  if not has_role('finance') then raise exception 'Finance handles receipts'; end if;
  select * into r from customer_receipts where id = p_rcpt for update;
  if p_action = 'POST' then
    if r.status <> 'DRAFT' then raise exception 'Receipt is %', r.status; end if;
    select coalesce(sum(amount), 0) into v_alloc from receipt_allocations where receipt_id = p_rcpt;
    if v_alloc > r.amount then raise exception 'Allocated % is more than the receipt %', v_alloc, r.amount; end if;
    if exists (select 1 from receipt_allocations a join v_sales_invoice_balance b on b.invoice_id = a.invoice_id
                where a.receipt_id = p_rcpt and a.amount > b.balance + 0.01) then raise exception 'An allocation is more than the invoice balance'; end if;
    if exists (select 1 from receipt_allocations a join sales_invoices s on s.id = a.invoice_id where a.receipt_id = p_rcpt and (s.customer_id <> r.customer_id or s.status <> 'POSTED' or s.inv_type = 'CREDIT_NOTE'))
      then raise exception 'Allocate only to this customer''s posted invoices'; end if;
    update customer_receipts set status = 'POSTED', posted_by = auth.uid(), posted_at = now(), receipt_date = gl_open_date(receipt_date) where id = p_rcpt;
  elsif p_action = 'CLEAR' then
    if r.status <> 'POSTED' or r.mode not in ('PDC','CHEQUE') then raise exception 'Only posted cheques / PDCs are cleared'; end if;
    update customer_receipts set status = 'CLEARED' where id = p_rcpt;
  elsif p_action = 'BOUNCE' then
    if r.status not in ('POSTED','CLEARED') or r.mode not in ('PDC','CHEQUE') then raise exception 'Only cheques / PDCs can bounce'; end if;
    update customer_receipts set status = 'BOUNCED' where id = p_rcpt;
  elsif p_action = 'CANCEL' then
    if r.status <> 'DRAFT' then raise exception 'Only draft receipts can be cancelled'; end if;
    update customer_receipts set status = 'CANCELLED' where id = p_rcpt;
  else raise exception 'Unknown action %', p_action;
  end if;
  perform gl_sync_sales(null);
  return (select status from customer_receipts where id = p_rcpt);
end $$;

-- journals for invoices and receipts (also run from gl_sync)
create or replace function public.gl_sync_sales(p_inv uuid default null) returns int
language plpgsql security definer set search_path = public as $$
declare h record; r record; v_je uuid; v_lines jsonb; n int := 0; v_rev text; v_cash text;
begin
  for h in select * from sales_invoices where status = 'POSTED' and gl_je_id is null and (p_inv is null or id = p_inv) loop
    v_rev := case when h.project_id is not null and (select project_type from projects where id = h.project_id) = 'PROJECT' then 'REV_CONTRACT' else 'REV_SALES' end;
    v_lines := case h.inv_type
      when 'ADVANCE' then jsonb_build_array(
        jsonb_build_object('acct', 'AR', 'dr', h.total_amount, 'customer_id', h.customer_id, 'project_id', h.project_id),
        jsonb_build_object('acct', 'CUST_ADV', 'cr', h.taxable_amount, 'customer_id', h.customer_id, 'project_id', h.project_id),
        jsonb_build_object('acct', 'VAT_OUT', 'cr', h.vat_amount, 'customer_id', h.customer_id))
      when 'RETENTION_RELEASE' then jsonb_build_array(
        jsonb_build_object('acct', 'AR', 'dr', h.total_amount, 'customer_id', h.customer_id, 'project_id', h.project_id),
        jsonb_build_object('acct', 'VAT_OUT', 'cr', h.vat_amount, 'customer_id', h.customer_id),
        jsonb_build_object('acct', 'RETENTION_AR', 'cr', h.taxable_amount, 'customer_id', h.customer_id, 'project_id', h.project_id))
      when 'CREDIT_NOTE' then (select jsonb_agg(x) from (
        select jsonb_build_object('acct', coalesce(l.account_id::text, v_rev), 'dr', sum(l.amount), 'customer_id', h.customer_id, 'project_id', h.project_id) x
          from sales_invoice_lines l where l.invoice_id = h.id group by l.account_id
        union all select jsonb_build_object('acct', 'VAT_OUT', 'dr', h.vat_amount, 'customer_id', h.customer_id)
        union all select jsonb_build_object('acct', 'AR', 'cr', h.total_amount, 'customer_id', h.customer_id, 'project_id', h.project_id)) q)
      when 'GENERAL' then (select jsonb_agg(x) from (
        select jsonb_build_object('acct', 'AR', 'dr', h.total_amount, 'customer_id', h.customer_id, 'project_id', h.project_id) x
        union all select jsonb_build_object('acct', coalesce(l.account_id::text, v_rev), 'cr', sum(l.amount), 'customer_id', h.customer_id, 'project_id', h.project_id)
          from sales_invoice_lines l where l.invoice_id = h.id group by l.account_id
        union all select jsonb_build_object('acct', 'VAT_OUT', 'cr', h.vat_amount, 'customer_id', h.customer_id)) q)
      else jsonb_build_array(
        jsonb_build_object('acct', 'AR', 'dr', h.total_amount, 'customer_id', h.customer_id, 'project_id', h.project_id),
        jsonb_build_object('acct', 'RETENTION_AR', 'dr', h.retention_amount, 'customer_id', h.customer_id, 'project_id', h.project_id),
        jsonb_build_object('acct', 'CUST_ADV', 'dr', h.advance_recovery, 'customer_id', h.customer_id, 'project_id', h.project_id),
        jsonb_build_object('acct', v_rev, 'cr', coalesce(h.certified_gross, h.gross_claimed), 'customer_id', h.customer_id, 'project_id', h.project_id),
        jsonb_build_object('acct', 'VAT_OUT', 'cr', h.vat_amount, 'customer_id', h.customer_id)) end;
    v_je := gl_post('AR_INVOICE', h.id, h.invoice_date, h.inv_no,
      initcap(replace(h.inv_type, '_', ' ')) || ' ' || h.inv_no || coalesce(' · cert ' || h.cert_no, '') || ' — ' || (select name from customers where id = h.customer_id), h.project_id, v_lines);
    update sales_invoices set gl_je_id = v_je where id = h.id;
    if v_je is not null then n := n + 1; end if;
  end loop;
  if p_inv is not null then return n; end if;

  for r in select * from customer_receipts where status in ('POSTED','CLEARED','BOUNCED') and gl_je_id is null loop
    v_cash := case r.mode when 'CASH' then 'CASH' when 'PDC' then 'PDC_RECEIVED' when 'CHEQUE' then 'PDC_RECEIVED' else 'BANK' end;
    v_je := gl_post('AR_RECEIPT', r.id, r.receipt_date, r.receipt_no, 'Receipt from ' || (select name from customers where id = r.customer_id) || coalesce(' · ' || r.reference_no, ''), r.project_id,
      jsonb_build_array(jsonb_build_object('acct', v_cash, 'dr', r.amount, 'customer_id', r.customer_id), jsonb_build_object('acct', 'AR', 'cr', r.amount, 'customer_id', r.customer_id, 'project_id', r.project_id)));
    update customer_receipts set gl_je_id = v_je where id = r.id;
    n := n + 1;
  end loop;
  for r in select * from customer_receipts where mode in ('PDC','CHEQUE') and gl_je_id is not null and gl_clear_je_id is null
             and status = 'CLEARED' loop
    v_je := gl_post('AR_CHEQUE_CLEAR', r.id, current_date, r.receipt_no, 'Cheque cleared ' || coalesce(r.reference_no, r.receipt_no), r.project_id,
      jsonb_build_array(jsonb_build_object('acct', 'BANK', 'dr', r.amount), jsonb_build_object('acct', 'PDC_RECEIVED', 'cr', r.amount)));
    update customer_receipts set gl_clear_je_id = v_je where id = r.id;
    n := n + 1;
  end loop;
  for r in select * from customer_receipts where status = 'BOUNCED' and gl_je_id is not null and gl_bounce_je_id is null loop
    v_je := gl_post('AR_CHEQUE_BOUNCE', r.id, current_date, r.receipt_no, 'Cheque returned ' || coalesce(r.reference_no, r.receipt_no), r.project_id,
      jsonb_build_array(jsonb_build_object('acct', 'AR', 'dr', r.amount, 'customer_id', r.customer_id, 'project_id', r.project_id),
                        jsonb_build_object('acct', case when r.gl_clear_je_id is not null then 'BANK' else 'PDC_RECEIVED' end, 'cr', r.amount)));
    update customer_receipts set gl_bounce_je_id = v_je where id = r.id;
    delete from receipt_allocations where receipt_id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.gl_sync_sales(uuid) from public, anon, authenticated;

-- hook sales into the periodic sync
do $$ begin
  if position('return n;' || chr(10) || 'end' in pg_get_functiondef('public.gl_sync()'::regprocedure)) = 0 then raise exception 'gl_sync anchor missing'; end if;
  execute replace(pg_get_functiondef('public.gl_sync()'::regprocedure), 'return n;' || chr(10) || 'end', 'n := n + gl_sync_sales(null);' || chr(10) || '  return n;' || chr(10) || 'end');
end $$;

-- project billing summary
create or replace view v_project_billing with (security_invoker = true) as
select p.id project_id, p.code project_code, p.name project_name, c.name customer_name, p.contract_value, p.billing_basis, p.advance_pct, p.retention_pct,
       coalesce(sum(coalesce(s.certified_gross, s.gross_claimed)) filter (where s.inv_type in ('PROGRESS','FINAL')), 0) certified_to_date,
       coalesce(sum(s.taxable_amount) filter (where s.inv_type = 'ADVANCE'), 0) advance_invoiced,
       coalesce(sum(s.advance_recovery), 0) advance_recovered,
       coalesce(sum(s.retention_amount), 0) - coalesce(sum(s.taxable_amount) filter (where s.inv_type = 'RETENTION_RELEASE'), 0) retention_held,
       coalesce(sum(case when s.inv_type = 'CREDIT_NOTE' then -s.total_amount else s.total_amount end), 0) invoiced_total,
       coalesce((select sum(b.allocated) from v_sales_invoice_balance b where b.project_id = p.id), 0) received,
       coalesce((select sum(b.balance) from v_sales_invoice_balance b where b.project_id = p.id), 0) outstanding,
       case when p.contract_value > 0 then round(100 * coalesce(sum(coalesce(s.certified_gross, s.gross_claimed)) filter (where s.inv_type in ('PROGRESS','FINAL')), 0) / p.contract_value, 1) end billed_pct,
       (select coalesce(sum(earned_value), 0) from v_boq_progress where project_id = p.id) earned_value
  from projects p left join customers c on c.id = p.customer_id
  left join sales_invoices s on s.project_id = p.id and s.status = 'POSTED'
 where p.project_type = 'PROJECT'
 group by p.id, c.name;

create or replace view v_ar_aging with (security_invoker = true) as
select customer_id, customer_name,
       sum(balance) balance,
       sum(balance) filter (where days_overdue = 0) not_due,
       sum(balance) filter (where days_overdue between 1 and 30) d1_30,
       sum(balance) filter (where days_overdue between 31 and 60) d31_60,
       sum(balance) filter (where days_overdue between 61 and 90) d61_90,
       sum(balance) filter (where days_overdue > 90) d90_plus,
       (select coalesce(sum(r.amount - coalesce((select sum(a.amount) from receipt_allocations a where a.receipt_id = r.id), 0)), 0)
          from customer_receipts r where r.customer_id = b.customer_id and r.status in ('POSTED','CLEARED')) unallocated_receipts
  from v_sales_invoice_balance b group by customer_id, customer_name having abs(sum(balance)) > 0.005;

-- customer statement
create or replace function public.customer_statement(p_customer uuid, p_from date, p_to date) returns table (txn_date date, doc_no text, doc_type text, details text, debit numeric, credit numeric, balance numeric)
language sql stable security definer set search_path = public as $$
  with t as (
    select j.je_date d, j.doc_no, j.source, j.narration, l.debit, l.credit, j.created_at, l.line_no
      from journal_lines l join journal_entries j on j.id = l.je_id
     where l.customer_id = p_customer and l.account_id = gl_acct('AR') and j.status in ('POSTED','REVERSED') and has_role('finance','factory_manager'))
  select p_from - 1, null, 'OPENING', 'Opening balance', null::numeric, null::numeric, coalesce((select sum(debit - credit) from t where d < p_from), 0)
  union all
  select * from (select d, doc_no, source, narration, debit, credit,
         coalesce((select sum(debit - credit) from t where d < p_from), 0) + sum(debit - credit) over (order by d, created_at, line_no rows unbounded preceding)
    from t where d between p_from and p_to order by d, created_at, line_no) x
$$;

-- VAT return (FTA VAT 201)
create or replace function public.vat_return(p_from date, p_to date) returns table (box text, description text, amount numeric, vat numeric, adjustment numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_em text; s_amt numeric; s_vat numeric; e_amt numeric; e_vat numeric; rc_amt numeric; rc_vat numeric; i int; v_emirates text[] := array['Abu Dhabi','Dubai','Sharjah','Ajman','Umm Al Quwain','Ras Al Khaimah','Fujairah'];
begin
  if not has_role('finance') then raise exception 'Finance prepares the VAT return'; end if;
  select coalesce(emirate, 'Ajman') into v_em from company_settings where id = 1;
  select coalesce(sum(case when inv_type = 'CREDIT_NOTE' then -taxable_amount else taxable_amount end) filter (where vat_rate > 0), 0),
         coalesce(sum(case when inv_type = 'CREDIT_NOTE' then -vat_amount else vat_amount end), 0)
    into s_amt, s_vat from sales_invoices where status = 'POSTED' and invoice_date between p_from and p_to and inv_type <> 'RETENTION_RELEASE';
  select s_amt + coalesce(sum(subtotal), 0), s_vat + coalesce(sum(vat_amount), 0) into s_amt, s_vat
    from scrap_disposals where status = 'POSTED' and disposal_date between p_from and p_to and coalesce(vat_amount, 0) > 0;
  -- imports / foreign suppliers: reverse charge on invoices from non-UAE vendors without VAT
  select coalesce(sum(round(v.subtotal * v.exchange_rate, 2)), 0) into rc_amt from vendor_invoices v join vendors d on d.id = v.vendor_id
   where v.status = 'POSTED' and v.invoice_date between p_from and p_to and coalesce(v.vat_amount, 0) = 0 and coalesce(upper(d.country), 'UAE') not in ('UAE','UNITED ARAB EMIRATES','AE');
  rc_vat := round(rc_amt * 0.05, 2);
  select coalesce(sum(round(v.subtotal * v.exchange_rate, 2)), 0), coalesce(sum(round(v.vat_amount * v.exchange_rate, 2)), 0) into e_amt, e_vat
    from vendor_invoices v where v.status = 'POSTED' and v.invoice_date between p_from and p_to and coalesce(v.vat_amount, 0) > 0;
  select e_amt - coalesce(sum(amount_aed), 0), e_vat - coalesce(sum(vat_amount), 0) into e_amt, e_vat
    from vendor_debit_notes where status = 'POSTED' and dn_date between p_from and p_to;
  for i in 1..7 loop
    box := '1' || chr(96 + i); description := 'Standard rated supplies in ' || v_emirates[i];
    amount := case when v_emirates[i] = v_em then s_amt else 0 end; vat := case when v_emirates[i] = v_em then s_vat else 0 end; adjustment := 0;
    return next;
  end loop;
  return query values
    ('2', 'Tax refunds provided to tourists', 0::numeric, 0::numeric, 0::numeric),
    ('3', 'Supplies subject to reverse charge', rc_amt, rc_vat, 0::numeric),
    ('4', 'Zero rated supplies', 0::numeric, 0::numeric, 0::numeric),
    ('5', 'Exempt supplies', 0::numeric, 0::numeric, 0::numeric),
    ('6', 'Goods imported into the UAE', 0::numeric, 0::numeric, 0::numeric),
    ('7', 'Adjustments to goods imported', 0::numeric, 0::numeric, 0::numeric),
    ('8', 'Totals (output)', s_amt + rc_amt, s_vat + rc_vat, 0::numeric),
    ('9', 'Standard rated expenses', e_amt + rc_amt, e_vat + rc_vat, 0::numeric),
    ('10', 'Supplies subject to reverse charge (recoverable, in box 9)', rc_amt, rc_vat, 0::numeric),
    ('11', 'Totals (input)', e_amt + rc_amt, e_vat + rc_vat, 0::numeric),
    ('12', 'Total value of due tax for the period', null::numeric, s_vat + rc_vat, 0::numeric),
    ('13', 'Total value of recoverable tax for the period', null::numeric, e_vat + rc_vat, 0::numeric),
    ('14', 'Payable tax for the period', null::numeric, (s_vat + rc_vat) - (e_vat + rc_vat), 0::numeric);
end $$;

alter table customers enable row level security;
alter table sales_invoices enable row level security;
alter table sales_invoice_lines enable row level security;
alter table customer_receipts enable row level security;
alter table receipt_allocations enable row level security;
create policy read_active on customers for select to authenticated using (public.is_active_user());
create policy fin_write on customers for all to authenticated using (public.has_role('finance','factory_manager')) with check (public.has_role('finance','factory_manager'));
create policy fin_read on sales_invoices for select to authenticated using (public.has_role('finance','factory_manager'));
create policy doc_insert on sales_invoices for insert to authenticated with check (public.has_role('finance','factory_manager') and status = 'DRAFT');
create policy doc_update on sales_invoices for update to authenticated using (public.has_role('finance','factory_manager') and status = 'DRAFT') with check (status = 'DRAFT');
create policy doc_delete on sales_invoices for delete to authenticated using (public.has_role('finance','factory_manager') and status = 'DRAFT');
create policy fin_read on sales_invoice_lines for select to authenticated using (public.has_role('finance','factory_manager'));
create policy line_write on sales_invoice_lines for all to authenticated
  using (public.has_role('finance','factory_manager') and exists (select 1 from sales_invoices h where h.id = invoice_id and h.status = 'DRAFT'))
  with check (public.has_role('finance','factory_manager') and exists (select 1 from sales_invoices h where h.id = invoice_id and h.status = 'DRAFT'));
create policy fin_read on customer_receipts for select to authenticated using (public.has_role('finance','factory_manager'));
create policy doc_insert on customer_receipts for insert to authenticated with check (public.is_finance() and status = 'DRAFT');
create policy doc_update on customer_receipts for update to authenticated using (public.is_finance() and status = 'DRAFT') with check (status = 'DRAFT');
create policy doc_delete on customer_receipts for delete to authenticated using (public.is_finance() and status = 'DRAFT');
create policy fin_read on receipt_allocations for select to authenticated using (public.has_role('finance','factory_manager'));
create policy line_write on receipt_allocations for all to authenticated
  using (public.is_finance() and exists (select 1 from customer_receipts r where r.id = receipt_id and r.status = 'DRAFT'))
  with check (public.is_finance() and exists (select 1 from customer_receipts r where r.id = receipt_id and r.status = 'DRAFT'));

create or replace function public.trg_notify_si() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is not distinct from old.status then return new; end if;
  if new.status = 'SUBMITTED' then
    perform notify('finance', null, 'Claim ' || new.inv_no || ' submitted to the client', 'Record the payment certificate when it arrives', 'd/si/' || new.id, 'si', new.id);
  elsif new.status = 'POSTED' and new.created_by is distinct from auth.uid() then
    perform notify(null, new.created_by, 'Invoice ' || new.inv_no || ' posted', to_char(new.total_amount, 'FM999,999,990.00') || ' AED', 'd/si/' || new.id, 'si', new.id);
  end if;
  return new;
end $$;
create trigger notify_si after update on sales_invoices for each row execute function trg_notify_si();

grant execute on function public.si_fill(uuid), public.si_action(uuid, text, jsonb), public.receipt_action(uuid, text), public.customer_statement(uuid, date, date),
  public.vat_return(date, date), public.si_advance_balance(uuid, uuid), public.si_retention_balance(uuid, uuid) to authenticated;
revoke execute on function public.si_fill(uuid), public.si_action(uuid, text, jsonb), public.receipt_action(uuid, text), public.customer_statement(uuid, date, date),
  public.vat_return(date, date), public.si_advance_balance(uuid, uuid), public.si_retention_balance(uuid, uuid), public.si_prev_qty(uuid, uuid, uuid) from anon;
