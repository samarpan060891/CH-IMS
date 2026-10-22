-- 056 Cash position and cash forecast (rolling 13 weeks by week, 12 months by month).
-- Opening cash = cash in hand + bank accounts + petty cash floats. Expected flows come from the documents already in the system:
-- customer invoices (shifted by each customer's actual payment delay), cheques / PDCs, supplier invoices, issued PDCs, open POs,
-- sales-order and project advances / balances, unbilled project work, payroll, recurring bills, VAT, plus Finance's own items.
-- Finance sets a minimum cash balance; a daily check notifies Finance and the Factory Manager when a coming week dips below it.

alter table company_settings add column min_cash_balance numeric not null default 0,
  add column vat_quarter_start_month int not null default 1 check (vat_quarter_start_month between 1 and 3),
  add column cash_alert_week date, add column cash_alert_on date;

create table cash_forecast_items (
  id uuid primary key default gen_random_uuid(),
  item_date date not null,
  direction text not null check (direction in ('IN','OUT')),
  category text not null default 'OTHER' check (category in ('LOAN','CAPEX','OWNER','TAX','OTHER')),
  description text not null,
  amount numeric not null check (amount > 0),
  repeat_monthly boolean not null default false,
  repeat_until date,
  is_active boolean not null default true,
  created_by uuid default auth.uid() references profiles(id), created_at timestamptz not null default now()
);
alter table cash_forecast_items enable row level security;
create policy fin_read on cash_forecast_items for select to authenticated using (has_role('finance','factory_manager'));
create policy fin_write on cash_forecast_items for all to authenticated using (has_role('finance')) with check (has_role('finance'));

-- cash accounts and today's balances (cash, banks, petty floats; cheques in hand / PDCs issued shown separately)
create or replace function public.cash_position(p_to date default current_date)
returns table (kind text, account_id uuid, code text, name text, balance numeric)
language sql stable security definer set search_path = public as $$
  select case when a.system_key = 'CASH' then 'CASH' when f.id is not null then 'PETTY' when a.system_key = 'PDC_RECEIVED' then 'PDC_IN'
              when a.system_key = 'PDC_ISSUED' then 'PDC_OUT' else 'BANK' end,
         a.id, a.code, coalesce(f.name, a.name), gl_balance(a.id, p_to)
    from gl_accounts a left join petty_floats f on f.gl_account_id = a.id and f.is_active
   where not a.is_group and a.is_active and (a.is_bank or a.system_key in ('CASH','BANK','PDC_RECEIVED','PDC_ISSUED') or f.id is not null)
     and has_role('finance','factory_manager')
   order by 1, 3
$$;

-- every expected receipt (IN) and payment (OUT) from today to p_until (internal: also used by the daily alert)
create or replace function public.cash_forecast_internal(p_until date)
returns table (flow_date date, direction text, category text, doc_type text, doc_id uuid, doc_no text, party text, amount numeric, note text)
language plpgsql stable security definer set search_path = public as $$
declare d0 date := current_date; v_vat numeric := coalesce((select default_vat_rate from company_settings where id = 1), 5);
  v_q int := coalesce((select vat_quarter_start_month from company_settings where id = 1), 1);
  r record; m date; v_amt numeric; v_day int; v_due date; v_qs date; v_total numeric; v_cur numeric;
begin

  -- ---------- money in ----------
  -- open customer invoices: due date + the customer's average delay over the last year; overdue spread over the next 4 weeks
  for r in
    with delay as (
      select i.customer_id, greatest(round(sum((rc.receipt_date - i.due_date) * a.amount) / nullif(sum(a.amount), 0)), 0)::int days
        from receipt_allocations a join customer_receipts rc on rc.id = a.receipt_id join sales_invoices i on i.id = a.invoice_id
       where rc.status in ('POSTED','CLEARED') and rc.receipt_date > d0 - 365 and i.due_date is not null group by 1)
    select b.*, coalesce(dl.days, 0) days from v_sales_invoice_balance b left join delay dl on dl.customer_id = b.customer_id
     where b.balance > 0.005 and b.inv_type <> 'CREDIT_NOTE'
  loop
    v_due := coalesce(r.due_date, r.invoice_date) + r.days;
    if v_due >= d0 then
      return query select v_due, 'IN', 'Customer invoices', 'si', r.invoice_id, r.inv_no, r.customer_name, r.balance,
        case when r.days > 0 then 'due ' || to_char(r.due_date, 'DD Mon') || ' + ' || r.days || ' days usual delay' else 'due date' end;
    else
      return query select (d0 + g * 7)::date, 'IN', 'Customer invoices', 'si', r.invoice_id, r.inv_no, r.customer_name, round(r.balance / 4, 2),
        'overdue since ' || to_char(r.due_date, 'DD Mon') || ' — spread over 4 weeks' from generate_series(0, 3) g;
    end if;
  end loop;
  -- cheques / PDCs received, not yet cleared to the bank
  return query select greatest(coalesce(c.cheque_date, c.receipt_date), d0), 'IN', 'Cheques & PDCs in hand', 'rcv', c.id, c.receipt_no,
                      (select name from customers where id = c.customer_id), c.amount, 'cheque date ' || to_char(coalesce(c.cheque_date, c.receipt_date), 'DD Mon YYYY')
                 from customer_receipts c where c.status = 'POSTED' and c.mode in ('CHEQUE','PDC');
  -- advances not yet invoiced on confirmed sales orders and open projects (expected within a week)
  return query
    select d0 + 7, 'IN', 'Advances due (orders & projects)', case when p.project_type = 'PROJECT' then 'proj' else 'so' end,
           case when p.project_type = 'PROJECT' then p.id else p.sales_order_id end, p.code, c.name,
           round(x.adv - x.billed, 2), p.advance_pct || '% advance not yet invoiced'
      from projects p join customers c on c.id = p.customer_id
      cross join lateral (select round(coalesce(p.contract_value, 0) * p.advance_pct / 100 * (1 + v_vat / 100), 2) adv,
                                 coalesce((select sum(total_amount) from sales_invoices i where i.project_id = p.id and i.inv_type = 'ADVANCE' and i.status <> 'CANCELLED'), 0) billed) x
     where p.status = 'OPEN' and p.project_type in ('PROJECT','SALES') and p.advance_pct > 0 and x.adv - x.billed > 1
       and (p.project_type = 'PROJECT' or exists (select 1 from sales_orders o where o.id = p.sales_order_id and o.status = 'CONFIRMED'));
  -- sales orders: what is not yet invoiced, at delivery date + payment terms + the customer's usual delay
  return query
    with delay as (
      select i.customer_id, greatest(round(sum((rc.receipt_date - i.due_date) * a.amount) / nullif(sum(a.amount), 0)), 0)::int days
        from receipt_allocations a join customer_receipts rc on rc.id = a.receipt_id join sales_invoices i on i.id = a.invoice_id
       where rc.status in ('POSTED','CLEARED') and rc.receipt_date > d0 - 365 and i.due_date is not null group by 1)
    select greatest(coalesce(o.delivery_date, d0), d0) + coalesce(t.credit_days, 30) + coalesce(dl.days, 0), 'IN', 'Sales orders not yet invoiced', 'so', o.id, o.so_no, c.name,
           round(o.total - x.billed, 2), 'delivery ' || coalesce(to_char(o.delivery_date, 'DD Mon'), '—') || ' + ' || coalesce(t.credit_days, 30) || ' days terms'
      from sales_orders o join customers c on c.id = o.customer_id left join payment_terms t on t.id = o.payment_term_id left join delay dl on dl.customer_id = o.customer_id
      cross join lateral (select coalesce((select sum(total_amount) from sales_invoices i where i.project_id = o.project_id and i.inv_type in ('ADVANCE','SALES') and i.status <> 'CANCELLED'), 0) billed) x
     where o.so_type = 'CUSTOMER' and o.status = 'CONFIRMED' and o.total - x.billed > 1;
  -- projects: installed work not yet certified, claimed at month end (less advance recovery and retention, plus VAT)
  return query
    with delay as (
      select i.customer_id, greatest(round(sum((rc.receipt_date - i.due_date) * a.amount) / nullif(sum(a.amount), 0)), 0)::int days
        from receipt_allocations a join customer_receipts rc on rc.id = a.receipt_id join sales_invoices i on i.id = a.invoice_id
       where rc.status in ('POSTED','CLEARED') and rc.receipt_date > d0 - 365 and i.due_date is not null group by 1)
    select (date_trunc('month', d0) + interval '1 month - 1 day')::date + coalesce(t.credit_days, 30) + coalesce(dl.days, 0), 'IN', 'Project claims (work done, not billed)', 'proj',
           p.id, p.code, c.name,
           round((b.earned_value - b.certified_to_date) * (1 - coalesce(p.retention_pct, 0) / 100 - coalesce(p.advance_recovery_pct, p.advance_pct, 0) / 100) * (1 + v_vat / 100), 2),
           'unbilled work ' || to_char(b.earned_value - b.certified_to_date, 'FM999,999,990') || ' less retention / advance recovery'
      from v_project_billing b join projects p on p.id = b.project_id join customers c on c.id = p.customer_id
      left join payment_terms t on t.id = p.payment_term_id left join delay dl on dl.customer_id = p.customer_id
     where p.status = 'OPEN' and p.project_type = 'PROJECT' and b.earned_value - b.certified_to_date > 1;

  -- ---------- money out ----------
  -- supplier invoices by due date (overdue ones this week)
  return query select greatest(coalesce(b.due_date, b.invoice_date), d0), 'OUT', 'Supplier invoices', 'inv', b.id, coalesce(b.vendor_invoice_no, b.inv_no),
                      (select name from vendors where id = b.vendor_id), b.balance_aed,
                      case when b.due_date < d0 then 'overdue since ' || to_char(b.due_date, 'DD Mon') else 'due date' end
                 from v_invoice_balances b where b.balance_aed > 0.005;
  -- PDCs issued and not yet cleared (not ticked in the bank reconciliation)
  return query select greatest(coalesce(v.cheque_date, v.payment_date), d0), 'OUT', 'PDCs issued', 'pay', v.id, v.payment_no,
                      (select name from vendors where id = v.vendor_id), v.amount_aed, 'cheque date ' || to_char(coalesce(v.cheque_date, v.payment_date), 'DD Mon YYYY')
                 from vendor_payments v
                where v.status = 'POSTED' and v.mode = 'PDC'
                  and exists (select 1 from journal_lines l where l.je_id = v.gl_je_id and l.account_id = gl_acct('PDC_ISSUED') and not coalesce(l.reconciled, false));
  -- approved purchase orders: advance per payment terms (if not paid) now, the rest at delivery + credit days
  for r in
    select po.id, po.po_no, po.total_aed, po.delivery_date, po.status, vd.name vendor, coalesce(t.advance_pct, 0) adv_pct, coalesce(t.credit_days, 30) days, coalesce(t.basis, 'INVOICE') basis,
           coalesce((select sum(total_aed) from vendor_invoices i where i.po_id = po.id and i.status <> 'CANCELLED'), 0) invoiced,
           coalesce((select sum(amount_aed) from vendor_payments p where p.po_id = po.id and p.status = 'POSTED'), 0) advanced
      from purchase_orders po join vendors vd on vd.id = po.vendor_id left join payment_terms t on t.id = po.payment_term_id
     where po.status in ('APPROVED','RELEASED','PARTIALLY_RECEIVED','RECEIVED')
  loop
    v_amt := round(r.total_aed * r.adv_pct / 100 - r.advanced, 2);
    if v_amt > 1 and r.invoiced = 0 then
      return query select d0, 'OUT', 'Purchase orders — advances', 'po', r.id, r.po_no, r.vendor, v_amt, r.adv_pct || '% advance per payment terms';
    end if;
    v_amt := round(r.total_aed - r.invoiced - greatest(r.advanced, r.total_aed * r.adv_pct / 100), 2);
    if v_amt > 1 then
      v_due := greatest(coalesce(r.delivery_date, d0 + 14), d0);
      if r.basis = 'EOM' then v_due := (date_trunc('month', v_due) + interval '1 month - 1 day')::date; end if;
      return query select v_due + r.days, 'OUT', 'Purchase orders — on delivery', 'po', r.id, r.po_no, r.vendor, v_amt,
        'delivery ' || coalesce(to_char(r.delivery_date, 'DD Mon'), 'not set') || ' + ' || r.days || ' days terms';
    end if;
  end loop;
  -- payroll: runs not yet paid, then the last net payroll repeated each month (paid on the usual day of the next month)
  return query select d0 + 3, 'OUT', 'Payroll', 'payroll', p.id, p.run_no, to_char(p.period_month, 'Mon YYYY') || ' salaries', p.total_net, lower(p.status) || ' — not yet paid'
                 from payroll_runs p where p.status in ('SUBMITTED','APPROVED') and p.total_net > 0;
  select * into r from payroll_runs where status in ('APPROVED','PAID') and total_net > 0 order by period_month desc limit 1;
  if found then
    v_day := coalesce(extract(day from (select paid_at from payroll_runs where status = 'PAID' and paid_at is not null order by period_month desc limit 1))::int, 5);
    m := (date_trunc('month', r.period_month) + interval '1 month')::date;
    while true loop
      v_due := (date_trunc('month', m) + interval '1 month')::date + least(v_day, 28) - 1;
      exit when v_due > p_until;
      if v_due >= d0 and not exists (select 1 from payroll_runs where period_month = m and status <> 'CANCELLED') then
        return query select v_due, 'OUT', 'Payroll', 'payroll', null::uuid, null::text, to_char(m, 'Mon YYYY') || ' salaries (estimate)', r.total_net, 'as the last payroll ' || r.run_no;
      end if;
      m := (m + interval '1 month')::date;
    end loop;
  end if;
  -- recurring bills: each month on their bill day, plus the supplier's credit days for bills
  for r in
    select t.id, t.tpl_no, t.title, t.exp_type, t.next_date, t.day_of_month, t.end_date, vd.name vendor,
           case when t.exp_type = 'BILL' then coalesce(pt.credit_days, 30) else 0 end days,
           (select round(sum(l.amount * (1 + coalesce(l.vat_rate, 0) / 100)), 2) from expense_template_lines l where l.template_id = t.id) amt
      from expense_templates t left join vendors vd on vd.id = t.vendor_id left join payment_terms pt on pt.id = vd.payment_term_id
     where t.status = 'ACTIVE'
  loop
    continue when coalesce(r.amt, 0) <= 0;
    m := r.next_date;
    while m <= least(p_until, coalesce(r.end_date, p_until)) loop
      if m + r.days >= d0 and m + r.days <= p_until then
        return query select m + r.days, 'OUT', 'Recurring bills', 'rexp', r.id, r.tpl_no, coalesce(r.vendor, r.title), r.amt,
          r.title || case when r.days > 0 then ' (bill ' || to_char(m, 'DD Mon') || ' + ' || r.days || ' days)' else '' end;
      end if;
      m := (date_trunc('month', m) + interval '1 month')::date + least(r.day_of_month, 28) - 1;
    end loop;
  end loop;
  -- VAT (quarters starting in the company's first VAT month): this quarter's VAT so far from document journals is due on the
  -- 28th of the month after the quarter; whatever else the VAT accounts still owe is the previous return (due the 28th of this quarter's first month)
  v_qs := (date_trunc('month', d0) - make_interval(months => ((extract(month from d0)::int - v_q + 12) % 3)))::date;
  v_total := -(gl_balance(gl_acct('VAT_OUT'), d0) + gl_balance(gl_acct('VAT_IN'), d0));
  select coalesce(-sum(l.debit - l.credit), 0) into v_cur
    from journal_lines l join journal_entries j on j.id = l.je_id
   where l.account_id in (gl_acct('VAT_OUT'), gl_acct('VAT_IN')) and j.status in ('POSTED','REVERSED') and j.je_date between v_qs and d0
     and coalesce(j.source, 'MANUAL') not in ('MANUAL','REVERSAL');
  if v_total - v_cur > 1 then
    return query select greatest(v_qs + 27, d0), 'OUT', 'VAT', 'vat', null::uuid, null::text, 'FTA — return to ' || to_char(v_qs - 1, 'DD Mon YYYY'),
      round(v_total - v_cur, 2), case when v_qs + 27 < d0 then 'overdue — VAT accounts still show it owing' else 'previous quarter''s return' end;
  end if;
  v_due := (v_qs + interval '3 month')::date + 27;
  if v_cur > 1 and v_due <= p_until then
    return query select v_due, 'OUT', 'VAT', 'vat', null::uuid, null::text, 'FTA — quarter to ' || to_char((v_qs + interval '3 month - 1 day')::date, 'DD Mon YYYY') || ' (so far)',
      round(v_cur, 2), 'VAT accrued so far this quarter — grows as you invoice';
  end if;

  -- ---------- Finance's own items (loans, capex, owner drawings, other) ----------
  for r in select * from cash_forecast_items where is_active loop
    m := r.item_date;
    loop
      exit when m > p_until or (r.repeat_until is not null and m > r.repeat_until);
      if m >= d0 then
        return query select m, r.direction, case when r.direction = 'IN' then 'Other receipts' else 'Other payments' end, 'cfi', r.id, null::text,
          initcap(r.category), r.amount, r.description;
      end if;
      exit when not r.repeat_monthly;
      m := (m + interval '1 month')::date;
    end loop;
  end loop;
end $$;

create or replace function public.cash_forecast(p_until date default (current_date + interval '12 months')::date)
returns table (flow_date date, direction text, category text, doc_type text, doc_id uuid, doc_no text, party text, amount numeric, note text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_role('finance','factory_manager') then raise exception 'Finance and the Factory Manager see the cash forecast'; end if;
  return query select * from cash_forecast_internal(p_until) f where f.amount > 0 order by f.flow_date, f.direction, f.category;
end $$;
revoke execute on function public.cash_forecast_internal(date) from public, anon, authenticated;

-- daily check: the first coming week (of 13) whose closing cash falls below the minimum
create or replace function public.cash_forecast_alert() returns text language plpgsql security definer set search_path = public as $$
declare s company_settings%rowtype; v_open numeric; w record; v_close numeric; v_first date; v_low numeric; v_wk0 date := date_trunc('week', current_date)::date;
begin
  -- the scheduler runs it with no user; signed in, only Finance may run it
  if auth.uid() is not null and not has_role('finance') then raise exception 'Finance runs the cash check'; end if;
  select * into s from company_settings where id = 1;
  if coalesce(s.min_cash_balance, 0) <= 0 then return 'no minimum set'; end if;
  select coalesce(sum(gl_balance(a.id, current_date)), 0) into v_open
    from gl_accounts a where not a.is_group and a.is_active
     and (a.is_bank or a.system_key in ('CASH','BANK') or exists (select 1 from petty_floats f where f.gl_account_id = a.id and f.is_active));
  v_close := v_open;
  for w in
    with f as (select * from cash_forecast_internal((v_wk0 + 13 * 7)::date))
    select (v_wk0 + g * 7)::date wk, coalesce((select sum(case when f.direction = 'IN' then f.amount else -f.amount end) from f
                                                where f.flow_date >= v_wk0 + g * 7 and f.flow_date < v_wk0 + g * 7 + 7), 0) net
      from generate_series(0, 12) g order by 1
  loop
    v_close := v_close + w.net;
    if v_close < s.min_cash_balance and v_first is null then v_first := w.wk; v_low := v_close; end if;
  end loop;
  if v_first is null then update company_settings set cash_alert_week = null where id = 1; return 'ok'; end if;
  if s.cash_alert_week is distinct from v_first or s.cash_alert_on is null or s.cash_alert_on <= current_date - 7 then
    perform notify(x, null, 'Cash below minimum in week of ' || to_char(v_first, 'DD Mon'),
      'Forecast closing cash AED ' || to_char(v_low, 'FM999,999,990') || ' against a minimum of AED ' || to_char(s.min_cash_balance, 'FM999,999,990'), 'cashforecast', null, null)
      from unnest(array['finance','factory_manager']::app_role[]) x;
    update company_settings set cash_alert_week = v_first, cash_alert_on = current_date where id = 1;
  end if;
  return 'below minimum from ' || v_first;
end $$;
revoke execute on function public.cash_forecast_alert() from public, anon;
grant execute on function public.cash_forecast(date), public.cash_position(date), public.cash_forecast_alert() to authenticated;
select cron.schedule('cash-forecast-alert', '0 4 * * *', 'select public.cash_forecast_alert()');
