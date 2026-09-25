-- =====================================================================
-- Citi Homes IMS - 005 Finance: vendor invoices, payments, debit notes, payables
-- =====================================================================

create table vendor_invoices (
  id                uuid primary key default gen_random_uuid(),
  inv_no            text not null unique default next_doc_no('PIV'),
  vendor_invoice_no text not null,
  invoice_date      date not null,
  vendor_id         uuid not null references vendors(id),
  po_id             uuid references purchase_orders(id),
  currency          text not null default 'AED',
  exchange_rate     numeric(12,6) not null default 1 check (exchange_rate > 0),
  payment_term_id   uuid references payment_terms(id),
  subtotal          numeric(14,2) not null default 0,
  vat_amount        numeric(14,2) not null default 0,
  total_amount      numeric(14,2) not null default 0,
  total_aed         numeric(14,2) generated always as (round(total_amount * exchange_rate, 2)) stored,
  due_date          date,
  has_variance      boolean not null default false,   -- price/qty differs from PO / GRN
  status            text not null default 'DRAFT' check (status in ('DRAFT','POSTED','CANCELLED')),
  attachment_url    text,
  remarks           text,
  created_by        uuid default auth.uid() references profiles(id),
  created_at        timestamptz not null default now(),
  posted_by         uuid references profiles(id),
  posted_at         timestamptz,
  unique (vendor_id, vendor_invoice_no)
);

create table vendor_invoice_lines (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references vendor_invoices(id) on delete cascade,
  grn_line_id   uuid references grn_lines(id),
  grn_charge_id uuid references grn_charges(id),   -- freight / customs / clearing bills
  item_id       uuid references items(id),
  description   text,
  qty           numeric(14,3) not null default 1,
  rate          numeric(14,4) not null default 0,
  vat_rate      numeric(5,2) not null default 5,
  amount        numeric(14,2) generated always as (round(qty * rate, 2)) stored,
  vat_amount    numeric(14,2) generated always as (round(qty * rate * vat_rate / 100, 2)) stored
);
create index vil_invoice_idx on vendor_invoice_lines(invoice_id);
create index vil_grn_line_idx on vendor_invoice_lines(grn_line_id);

create or replace function public.vil_recalc() returns trigger
language plpgsql security definer set search_path = public as $$
declare v uuid := coalesce(new.invoice_id, old.invoice_id);
begin
  update vendor_invoices vi set subtotal = s.amt, vat_amount = s.vat, total_amount = s.amt + s.vat
    from (select coalesce(sum(amount),0) amt, coalesce(sum(vat_amount),0) vat
            from vendor_invoice_lines where invoice_id = v) s
   where vi.id = v;
  return null;
end $$;
create trigger vil_recalc after insert or update or delete on vendor_invoice_lines
  for each row execute function vil_recalc();

create or replace function public.compute_due_date(p_term uuid, p_invoice_date date, p_grn_date date)
returns date language sql stable set search_path = public as $$
  select case t.basis
           when 'GRN' then coalesce(p_grn_date, p_invoice_date) + t.credit_days
           when 'EOM' then (date_trunc('month', p_invoice_date) + interval '1 month - 1 day')::date + t.credit_days
           else p_invoice_date + t.credit_days end
    from payment_terms t where t.id = p_term
$$;

create or replace function public.post_vendor_invoice(p_inv uuid) returns void
language plpgsql security definer set search_path = public as $$
declare h vendor_invoices%rowtype; l record; v_billed numeric; v_term uuid; v_grn_date date; v_var boolean := false;
begin
  if not has_role('finance') then raise exception 'Only Finance can post vendor invoices'; end if;
  select * into h from vendor_invoices where id = p_inv for update;
  if h.status <> 'DRAFT' then raise exception 'Invoice already %', h.status; end if;
  if not exists (select 1 from vendor_invoice_lines where invoice_id = p_inv) then raise exception 'Invoice has no lines'; end if;

  for l in select vil.*, gl.accepted_qty, gl.rate grn_rate, gl.grn_id, g.vendor_id grn_vendor, g.status grn_status, pl.rate po_rate
             from vendor_invoice_lines vil
             left join grn_lines gl on gl.id = vil.grn_line_id
             left join grns g on g.id = gl.grn_id
             left join po_lines pl on pl.id = gl.po_line_id
            where vil.invoice_id = p_inv loop
    if l.grn_line_id is not null then
      if l.grn_status <> 'POSTED' then raise exception 'GRN line is not posted'; end if;
      if l.grn_vendor <> h.vendor_id then raise exception 'GRN belongs to another vendor'; end if;
      select coalesce(sum(x.qty),0) into v_billed from vendor_invoice_lines x join vendor_invoices i on i.id = x.invoice_id
       where x.grn_line_id = l.grn_line_id and i.status = 'POSTED';
      if v_billed + l.qty > l.accepted_qty + 0.0005 then
        raise exception 'Invoiced qty exceeds GRN accepted qty (accepted %, already invoiced %)', l.accepted_qty, v_billed;
      end if;
      if abs(l.rate - coalesce(l.po_rate, l.grn_rate)) > 0.0001 then v_var := true; end if;
    end if;
    if l.grn_charge_id is not null and exists (
         select 1 from vendor_invoice_lines x join vendor_invoices i on i.id = x.invoice_id
          where x.grn_charge_id = l.grn_charge_id and i.status = 'POSTED') then
      raise exception 'This landed-cost charge is already invoiced';
    end if;
  end loop;

  select coalesce(h.payment_term_id, po.payment_term_id, v.payment_term_id) into v_term
    from vendors v left join purchase_orders po on po.id = h.po_id where v.id = h.vendor_id;
  select max(g.grn_date) into v_grn_date from vendor_invoice_lines x
    join grn_lines gl on gl.id = x.grn_line_id join grns g on g.id = gl.grn_id where x.invoice_id = p_inv;

  update vendor_invoices set status = 'POSTED', posted_at = now(), posted_by = auth.uid(), has_variance = v_var,
         payment_term_id = v_term,
         due_date = coalesce(due_date, compute_due_date(v_term, h.invoice_date, v_grn_date), h.invoice_date)
   where id = p_inv;
end $$;

-- ---------- Debit notes (from purchase returns or price claims) ----------
create table vendor_debit_notes (
  id            uuid primary key default gen_random_uuid(),
  dn_no         text not null unique default next_doc_no('DN'),
  dn_date       date not null default current_date,
  vendor_id     uuid not null references vendors(id),
  prt_id        uuid references purchase_returns(id),
  invoice_id    uuid references vendor_invoices(id),
  reason        text not null,
  amount_aed    numeric(14,2) not null check (amount_aed >= 0),
  vat_amount    numeric(14,2) not null default 0,
  total_aed     numeric(14,2) generated always as (amount_aed + vat_amount) stored,
  status        text not null default 'DRAFT' check (status in ('DRAFT','POSTED','CANCELLED')),
  created_by    uuid default auth.uid() references profiles(id),
  created_at    timestamptz not null default now(),
  posted_at     timestamptz
);

create or replace function public.post_debit_note(p_dn uuid) returns void
language plpgsql security definer set search_path = public as $$
declare h vendor_debit_notes%rowtype;
begin
  if not has_role('finance') then raise exception 'Only Finance can post debit notes'; end if;
  select * into h from vendor_debit_notes where id = p_dn for update;
  if h.status <> 'DRAFT' then raise exception 'Debit note already %', h.status; end if;
  if h.prt_id is not null and exists (select 1 from vendor_debit_notes where prt_id = h.prt_id and status = 'POSTED') then
    raise exception 'A debit note is already posted for this purchase return';
  end if;
  update vendor_debit_notes set status = 'POSTED', posted_at = now() where id = p_dn;
end $$;

-- ---------- Payment vouchers ----------
create table vendor_payments (
  id             uuid primary key default gen_random_uuid(),
  payment_no     text not null unique default next_doc_no('PAY'),
  payment_date   date not null default current_date,
  vendor_id      uuid not null references vendors(id),
  mode           text not null check (mode in ('BANK_TRANSFER','CHEQUE','PDC','CASH','LC')),
  bank_name      text,
  reference_no   text,          -- cheque / transfer reference
  cheque_date    date,          -- PDC maturity date
  amount_aed     numeric(14,2) not null check (amount_aed > 0),
  currency       text not null default 'AED',
  fc_amount      numeric(14,2),
  po_id          uuid references purchase_orders(id),   -- advance against PO
  status         text not null default 'DRAFT' check (status in ('DRAFT','POSTED','CANCELLED','BOUNCED')),
  remarks        text,
  created_by     uuid default auth.uid() references profiles(id),
  created_at     timestamptz not null default now(),
  posted_by      uuid references profiles(id),
  posted_at      timestamptz
);
create table payment_allocations (
  id          uuid primary key default gen_random_uuid(),
  payment_id  uuid not null references vendor_payments(id) on delete cascade,
  invoice_id  uuid not null references vendor_invoices(id),
  amount_aed  numeric(14,2) not null check (amount_aed > 0),
  unique (payment_id, invoice_id)
);

create or replace view public.v_invoice_balances with (security_invoker = true) as
select i.id, i.inv_no, i.vendor_invoice_no, i.invoice_date, i.due_date, i.vendor_id, i.po_id, i.total_aed,
       coalesce(pa.paid,0) as paid_aed,
       coalesce(dn.dn,0) as dn_aed,
       i.total_aed - coalesce(pa.paid,0) - coalesce(dn.dn,0) as balance_aed,
       greatest(current_date - i.due_date, 0) as days_overdue,
       case when i.total_aed - coalesce(pa.paid,0) - coalesce(dn.dn,0) <= 0.005 then 'PAID'
            when current_date <= i.due_date then 'NOT_DUE'
            when current_date - i.due_date <= 30 then '1-30'
            when current_date - i.due_date <= 60 then '31-60'
            when current_date - i.due_date <= 90 then '61-90'
            else '90+' end as aging_bucket
  from vendor_invoices i
  left join (select a.invoice_id, sum(a.amount_aed) paid from payment_allocations a
               join vendor_payments p on p.id = a.payment_id and p.status = 'POSTED' group by a.invoice_id) pa on pa.invoice_id = i.id
  left join (select invoice_id, sum(total_aed) dn from vendor_debit_notes where status = 'POSTED' and invoice_id is not null
              group by invoice_id) dn on dn.invoice_id = i.id
 where i.status = 'POSTED';

create or replace function public.post_payment(p_pay uuid) returns void
language plpgsql security definer set search_path = public as $$
declare h vendor_payments%rowtype; v_alloc numeric; l record;
begin
  if not has_role('finance') then raise exception 'Only Finance can post payments'; end if;
  select * into h from vendor_payments where id = p_pay for update;
  if h.status <> 'DRAFT' then raise exception 'Payment already %', h.status; end if;
  select coalesce(sum(amount_aed),0) into v_alloc from payment_allocations where payment_id = p_pay;
  if v_alloc > h.amount_aed + 0.005 then raise exception 'Allocated amount exceeds payment amount'; end if;
  for l in select a.amount_aed, b.balance_aed, b.inv_no, b.vendor_id from payment_allocations a
             join v_invoice_balances b on b.id = a.invoice_id where a.payment_id = p_pay loop
    if l.vendor_id <> h.vendor_id then raise exception 'Invoice % belongs to another vendor', l.inv_no; end if;
    if l.amount_aed > l.balance_aed + 0.005 then raise exception 'Allocation exceeds balance of invoice %', l.inv_no; end if;
  end loop;
  update vendor_payments set status = 'POSTED', posted_at = now(), posted_by = auth.uid() where id = p_pay;
end $$;

-- allocate an existing (advance / unallocated) posted payment to an invoice later
create or replace function public.allocate_payment(p_pay uuid, p_invoice uuid, p_amount numeric) returns void
language plpgsql security definer set search_path = public as $$
declare h vendor_payments%rowtype; v_used numeric; v_bal numeric; v_vendor uuid;
begin
  if not has_role('finance') then raise exception 'Only Finance can allocate payments'; end if;
  select * into h from vendor_payments where id = p_pay for update;
  if h.status <> 'POSTED' then raise exception 'Payment is not posted'; end if;
  select coalesce(sum(amount_aed),0) into v_used from payment_allocations where payment_id = p_pay;
  if v_used + p_amount > h.amount_aed + 0.005 then raise exception 'Only % unallocated on this payment', h.amount_aed - v_used; end if;
  select balance_aed, vendor_id into v_bal, v_vendor from v_invoice_balances where id = p_invoice;
  if v_vendor <> h.vendor_id then raise exception 'Invoice belongs to another vendor'; end if;
  if p_amount > v_bal + 0.005 then raise exception 'Invoice balance is only %', v_bal; end if;
  insert into payment_allocations (payment_id, invoice_id, amount_aed) values (p_pay, p_invoice, p_amount)
  on conflict (payment_id, invoice_id) do update set amount_aed = payment_allocations.amount_aed + excluded.amount_aed;
end $$;

-- ---------- Net payables per vendor ----------
create or replace view public.v_vendor_payables with (security_invoker = true) as
with inv as (
  select vendor_id, sum(total_aed) invoiced, sum(balance_aed) inv_balance,
         sum(balance_aed) filter (where aging_bucket = 'NOT_DUE') not_due,
         sum(balance_aed) filter (where aging_bucket = '1-30')   d1_30,
         sum(balance_aed) filter (where aging_bucket = '31-60')  d31_60,
         sum(balance_aed) filter (where aging_bucket = '61-90')  d61_90,
         sum(balance_aed) filter (where aging_bucket = '90+')    d90p
    from v_invoice_balances group by vendor_id),
pay as (
  select p.vendor_id, sum(p.amount_aed) paid,
         sum(p.amount_aed - coalesce(a.alloc,0)) unallocated,
         sum(p.amount_aed) filter (where p.mode = 'PDC' and p.cheque_date > current_date) pdc_not_matured
    from vendor_payments p
    left join (select payment_id, sum(amount_aed) alloc from payment_allocations group by payment_id) a on a.payment_id = p.id
   where p.status = 'POSTED' group by p.vendor_id),
dn as (
  select vendor_id, sum(total_aed) dn_total, sum(total_aed) filter (where invoice_id is null) dn_unallocated
    from vendor_debit_notes where status = 'POSTED' group by vendor_id)
select v.id vendor_id, v.code, v.name, pt.name payment_term,
       coalesce(inv.invoiced,0) invoiced_aed,
       coalesce(pay.paid,0) paid_aed,
       coalesce(dn.dn_total,0) debit_notes_aed,
       coalesce(pay.unallocated,0) advances_unallocated_aed,
       coalesce(pay.pdc_not_matured,0) pdc_not_matured_aed,
       coalesce(inv.inv_balance,0) - coalesce(pay.unallocated,0) - coalesce(dn.dn_unallocated,0) as net_payable_aed,
       coalesce(inv.not_due,0) not_due_aed, coalesce(inv.d1_30,0) overdue_1_30_aed, coalesce(inv.d31_60,0) overdue_31_60_aed,
       coalesce(inv.d61_90,0) overdue_61_90_aed, coalesce(inv.d90p,0) overdue_90_plus_aed
  from vendors v
  left join payment_terms pt on pt.id = v.payment_term_id
  left join inv on inv.vendor_id = v.id
  left join pay on pay.vendor_id = v.id
  left join dn on dn.vendor_id = v.id
 where inv.vendor_id is not null or pay.vendor_id is not null or dn.vendor_id is not null;

-- ---------- Goods received not invoiced (accrual) ----------
create or replace view public.v_grn_not_invoiced with (security_invoker = true) as
select g.id grn_id, g.grn_no, g.grn_date, g.vendor_id, v.name vendor_name, gl.id grn_line_id, i.code item_code, i.name item_name,
       gl.accepted_qty, coalesce(b.billed,0) invoiced_qty, gl.accepted_qty - coalesce(b.billed,0) pending_qty,
       gl.unit_cost_aed, round((gl.accepted_qty - coalesce(b.billed,0)) * gl.rate * g.exchange_rate, 2) pending_value_aed
  from grn_lines gl join grns g on g.id = gl.grn_id and g.status = 'POSTED'
  join items i on i.id = gl.item_id
  left join vendors v on v.id = g.vendor_id
  left join (select x.grn_line_id, sum(x.qty) billed from vendor_invoice_lines x join vendor_invoices vi on vi.id = x.invoice_id
              where vi.status = 'POSTED' group by x.grn_line_id) b on b.grn_line_id = gl.id
 where g.receipt_type = 'PO' and gl.accepted_qty - coalesce(b.billed,0) > 0.0005;
