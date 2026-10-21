-- 048 Running expenses: utilities, rent, telecom, fuel, repairs … booked to an expense head + cost centre (+ optional project)
-- * Expense voucher types: BILL (supplier bill, paid later through Payments), PAID (paid now from a bank / cash account),
--   PETTY (paid from a petty cash float), CLAIM (employee paid; reimbursed later).
-- * Above the approval limit the Factory Manager approves; Finance posts. BILL posting creates a posted supplier invoice
--   (so it appears in payables, payments and aging); the others post their own journal.
-- * Lines with a project add to the project's other costs (margin). Recurring bills create monthly drafts.
-- * Budgets per cost centre / expense head / month; factory overheads actual vs absorbed into production.

-- ---------- chart of accounts: expense heads, petty cash, claims payable ----------
alter table gl_accounts add column is_factory_overhead boolean not null default false;
insert into gl_accounts (code, name, acc_type, is_group, system_key, is_bank) values
 ('1115','Petty cash floats','ASSET',true,null,false),
 ('2160','Employee expense claims payable','LIABILITY',false,'EMP_CLAIMS',false),
 ('6210','Factory rent','EXPENSE',false,null,false),
 ('6310','Electricity & water — factory','EXPENSE',false,null,false),
 ('6320','Electricity & water — office / camp','EXPENSE',false,null,false),
 ('6330','Telephone & internet','EXPENSE',false,null,false),
 ('6410','Repairs & maintenance — machines','EXPENSE',false,null,false),
 ('6420','Repairs & maintenance — buildings','EXPENSE',false,null,false),
 ('6510','Vehicle fuel & maintenance','EXPENSE',false,null,false),
 ('6520','Printing & stationery','EXPENSE',false,null,false),
 ('6530','Insurance','EXPENSE',false,null,false),
 ('6540','Licences, visas & government fees','EXPENSE',false,null,false),
 ('6550','Professional & legal fees','EXPENSE',false,null,false),
 ('6560','Cleaning, security & waste','EXPENSE',false,null,false),
 ('6570','Staff welfare & accommodation','EXPENSE',false,null,false),
 ('6580','Travel & transport','EXPENSE',false,null,false),
 ('6590','Marketing & entertainment','EXPENSE',false,null,false),
 ('6595','Factory consumables & small tools','EXPENSE',false,null,false)
on conflict (code) do nothing;
update gl_accounts c set parent_id = coalesce(
    (select g.id from gl_accounts g where g.is_group and g.code = left(c.code, 2) || '00' and g.id <> c.id),
    (select g.id from gl_accounts g where g.is_group and g.code = left(c.code, 1) || '000' and g.id <> c.id))
 where c.parent_id is null and c.code not like '_000';
update gl_accounts set parent_id = (select id from gl_accounts where code = '1100') where code = '1115';
update gl_accounts set is_factory_overhead = true where code in ('6210','6310','6410','6595');

alter table cost_centers add column is_factory boolean not null default false;
alter table company_settings add column expense_approval_limit numeric(14,2) not null default 1000;

-- ---------- petty cash floats (each has its own ledger account under 1115) ----------
create table petty_floats (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,
  custodian_id   uuid references profiles(id),
  float_limit    numeric(14,2) not null default 0,
  gl_account_id  uuid references gl_accounts(id),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);
create or replace function public.trg_petty_float_account() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  if new.gl_account_id is null then
    select '1115' || lpad((count(*) + 1)::text, 2, '0') into v_code from gl_accounts where code like '1115__';
    insert into gl_accounts (code, name, acc_type, parent_id) values (v_code, 'Petty cash — ' || new.name, 'ASSET', (select id from gl_accounts where code = '1115'))
    returning id into new.gl_account_id;
  else
    update gl_accounts set name = 'Petty cash — ' || new.name where id = new.gl_account_id and tg_op = 'UPDATE' and new.name is distinct from old.name;
  end if;
  return new;
end $$;
create trigger petty_float_account before insert or update on petty_floats for each row execute function trg_petty_float_account();

-- ---------- expense vouchers ----------
create table expenses (
  id              uuid primary key default gen_random_uuid(),
  exp_no          text not null unique default next_doc_no('EXP'),
  exp_date        date not null default current_date,
  exp_type        text not null default 'BILL' check (exp_type in ('BILL','PAID','PETTY','CLAIM')),
  vendor_id       uuid references vendors(id),
  payee_name      text,
  employee_id     uuid references employees(id),
  petty_float_id  uuid references petty_floats(id),
  pay_account_id  uuid references gl_accounts(id),
  bill_no         text,
  due_date        date,
  subtotal        numeric(14,2) not null default 0,
  vat_amount      numeric(14,2) not null default 0,
  total           numeric(14,2) not null default 0,
  status          text not null default 'DRAFT' check (status in ('DRAFT','PENDING_FM','APPROVED','POSTED','REIMBURSED','REJECTED','CANCELLED')),
  attachments     jsonb not null default '[]'::jsonb,
  template_id     uuid,
  remarks         text,
  approval_comments text,
  vendor_invoice_id uuid references vendor_invoices(id),
  gl_je_id        uuid references journal_entries(id),
  reimb_je_id     uuid references journal_entries(id),
  reimb_account_id uuid references gl_accounts(id),
  reimb_ref       text,
  created_by      uuid default auth.uid() references profiles(id),
  created_at      timestamptz not null default now(),
  submitted_at    timestamptz,
  approved_by     uuid references profiles(id), approved_at timestamptz,
  posted_by       uuid references profiles(id), posted_at timestamptz
);
create index expenses_date_idx on expenses(exp_date);
create table expense_lines (
  id              uuid primary key default gen_random_uuid(),
  expense_id      uuid not null references expenses(id) on delete cascade,
  line_no         int not null default 1,
  account_id      uuid not null references gl_accounts(id),
  description     text,
  cost_center_id  uuid not null references cost_centers(id),
  project_id      uuid references projects(id),
  amount          numeric(14,2) not null check (amount >= 0),
  vat_rate        numeric(5,2) not null default 5,
  vat_amount      numeric(14,2) generated always as (round(amount * vat_rate / 100, 2)) stored
);
create index expense_lines_exp_idx on expense_lines(expense_id);

create or replace function public.trg_expense_totals() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_exp uuid := coalesce(new.expense_id, old.expense_id); v_st text;
begin
  select status into v_st from expenses where id = v_exp;
  if v_st in ('POSTED','REIMBURSED') then raise exception 'The expense is posted'; end if;
  update expenses e set subtotal = s.amt, vat_amount = s.vat, total = s.amt + s.vat
    from (select coalesce(sum(amount), 0) amt, coalesce(sum(vat_amount), 0) vat from expense_lines where expense_id = v_exp) s where e.id = v_exp;
  return null;
end $$;
create trigger expense_totals after insert or update or delete on expense_lines for each row execute function trg_expense_totals();

-- supplier invoice lines may carry an expense head, cost centre and project (expense bills, and non-stock lines keyed by hand)
alter table vendor_invoice_lines add column account_id uuid references gl_accounts(id),
  add column cost_center_id uuid references cost_centers(id), add column project_id uuid references projects(id);
alter table vendor_invoices add column expense_id uuid;

do $$
declare d text := pg_get_functiondef('public.gl_sync()'::regprocedure);
begin
  if position('''acct'', case when l.grn_line_id is not null' in d) = 0 or position('''vendor_id'', r.vendor_id, ''memo'', l.description)' in d) = 0 then raise exception 'gl_sync AP anchors missing'; end if;
  d := replace(d, '''acct'', case when l.grn_line_id is not null', '''acct'', case when l.account_id is not null then l.account_id::text when l.grn_line_id is not null');
  d := replace(d, '''vendor_id'', r.vendor_id, ''memo'', l.description)', '''vendor_id'', r.vendor_id, ''memo'', l.description, ''cost_center_id'', l.cost_center_id, ''project_id'', l.project_id)');
  execute d;
end $$;

-- ---------- workflow ----------
create or replace function public.expense_action(p_exp uuid, p_action text, p_data jsonb default '{}'::jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare e expenses%rowtype; v_limit numeric; v_lines jsonb; v_cr text; v_je uuid; v_inv uuid; v_due date; v_no text; v_acct uuid;
begin
  select * into e from expenses where id = p_exp for update;
  if not found then raise exception 'Expense not found'; end if;
  if p_action = 'SUBMIT' then
    if e.status not in ('DRAFT','REJECTED') then raise exception 'Expense is %', e.status; end if;
    if not (e.created_by = auth.uid() or has_role('finance')) then raise exception 'Only the person who raised it, or Finance, can submit'; end if;
    if not exists (select 1 from expense_lines where expense_id = p_exp) then raise exception 'Add the expense lines'; end if;
    if e.total <= 0 then raise exception 'The amount is zero'; end if;
    if e.exp_type in ('BILL') and e.vendor_id is null then raise exception 'Choose the supplier'; end if;
    if e.exp_type = 'PAID' and e.pay_account_id is null then raise exception 'Choose the bank / cash account it was paid from'; end if;
    if e.exp_type = 'PETTY' and e.petty_float_id is null then raise exception 'Choose the petty cash float'; end if;
    if e.exp_type = 'CLAIM' and e.employee_id is null then raise exception 'Choose the employee to reimburse'; end if;
    select expense_approval_limit into v_limit from company_settings where id = 1;
    update expenses set status = case when e.total > v_limit then 'PENDING_FM' else 'APPROVED' end, submitted_at = now(), approval_comments = null where id = p_exp;
    if e.total > v_limit then
      perform notify('factory_manager', null, 'Expense ' || e.exp_no || ' awaits approval', to_char(e.total, 'FM999,999,990.00') || ' AED · ' || coalesce(e.payee_name, (select name from vendors where id = e.vendor_id), ''), 'd/exp/' || p_exp, 'exp', p_exp);
      return 'PENDING_FM';
    end if;
    perform notify('finance', null, 'Expense ' || e.exp_no || ' ready to post', to_char(e.total, 'FM999,999,990.00') || ' AED', 'd/exp/' || p_exp, 'exp', p_exp);
    return 'APPROVED';
  elsif p_action in ('APPROVE','REJECT') then
    if not has_role('factory_manager') then raise exception 'The Factory Manager approves expenses above the limit'; end if;
    if e.status <> 'PENDING_FM' then raise exception 'Expense is %', e.status; end if;
    if p_action = 'REJECT' and nullif(trim(p_data->>'comments'), '') is null then raise exception 'Give the reason'; end if;
    update expenses set status = case when p_action = 'APPROVE' then 'APPROVED' else 'REJECTED' end, approved_by = auth.uid(), approved_at = now(),
           approval_comments = p_data->>'comments' where id = p_exp;
    if p_action = 'APPROVE' then perform notify('finance', null, 'Expense ' || e.exp_no || ' approved — ready to post', p_data->>'comments', 'd/exp/' || p_exp, 'exp', p_exp);
    else perform notify(null, e.created_by, 'Expense ' || e.exp_no || ' rejected', p_data->>'comments', 'd/exp/' || p_exp, 'exp', p_exp); end if;
    return case when p_action = 'APPROVE' then 'APPROVED' else 'REJECTED' end;
  elsif p_action = 'POST' then
    if not has_role('finance') then raise exception 'Finance posts expenses'; end if;
    if e.status <> 'APPROVED' then raise exception 'Submit (and get approval) first — expense is %', e.status; end if;
    if exists (select 1 from gl_periods where period_month = date_trunc('month', e.exp_date)::date and status = 'CLOSED') then raise exception 'The month of % is closed', e.exp_date; end if;
    if e.exp_type = 'BILL' then
      -- becomes a posted supplier invoice: payables, payments and aging handle it from here
      select e.exp_date + coalesce(t.credit_days, 30) into v_due from vendors v left join payment_terms t on t.id = v.payment_term_id where v.id = e.vendor_id;
      insert into vendor_invoices (vendor_invoice_no, invoice_date, vendor_id, currency, exchange_rate, due_date, status, remarks, expense_id, posted_by, posted_at)
      values (coalesce(nullif(e.bill_no, ''), e.exp_no), e.exp_date, e.vendor_id, 'AED', 1, coalesce(e.due_date, v_due), 'DRAFT', coalesce(e.remarks, 'Expense ' || e.exp_no), e.id, auth.uid(), now())
      returning id into v_inv;
      insert into vendor_invoice_lines (invoice_id, description, qty, rate, vat_rate, account_id, cost_center_id, project_id)
      select v_inv, coalesce(l.description, a.name), 1, l.amount, l.vat_rate, l.account_id, l.cost_center_id, l.project_id
        from expense_lines l join gl_accounts a on a.id = l.account_id where l.expense_id = p_exp order by l.line_no;
      update vendor_invoices set status = 'POSTED' where id = v_inv;
      update expenses set vendor_invoice_id = v_inv where id = p_exp;
      perform gl_sync();   -- journal now rather than at the next 15-minute sync
    else
      v_cr := case e.exp_type when 'PETTY' then (select gl_account_id::text from petty_floats where id = e.petty_float_id)
                              when 'CLAIM' then gl_acct('EMP_CLAIMS')::text else e.pay_account_id::text end;
      select jsonb_agg(x) into v_lines from (
        select jsonb_build_object('acct', l.account_id::text, 'dr', l.amount, 'cost_center_id', l.cost_center_id, 'project_id', l.project_id, 'vendor_id', e.vendor_id, 'memo', l.description) x
          from expense_lines l where l.expense_id = p_exp
        union all select jsonb_build_object('acct', 'VAT_IN', 'dr', e.vat_amount, 'vendor_id', e.vendor_id)
        union all select jsonb_build_object('acct', v_cr, 'cr', e.total, 'employee_id', e.employee_id, 'vendor_id', e.vendor_id)) q;
      v_je := gl_post('EXPENSE', e.id, e.exp_date, e.exp_no,
        initcap(lower(e.exp_type)) || ' expense ' || e.exp_no || coalesce(' — ' || coalesce(e.payee_name, (select name from vendors where id = e.vendor_id), (select name from employees where id = e.employee_id)), ''), null, v_lines);
      update expenses set gl_je_id = v_je where id = p_exp;
    end if;
    -- project-related lines count in the project's other costs (margin); not posted again to the ledger
    insert into project_costs (project_id, cost_date, source, source_id, doc_no, description, amount)
    select l.project_id, e.exp_date, 'OTHER', l.id, e.exp_no, coalesce(l.description, (select name from gl_accounts where id = l.account_id)), l.amount
      from expense_lines l where l.expense_id = p_exp and l.project_id is not null;
    update expenses set status = 'POSTED', posted_by = auth.uid(), posted_at = now() where id = p_exp;
    if e.exp_type = 'CLAIM' then perform notify(null, e.created_by, 'Claim ' || e.exp_no || ' posted', 'It will be reimbursed by Finance', 'd/exp/' || p_exp, 'exp', p_exp); end if;
    return 'POSTED';
  elsif p_action = 'REIMBURSE' then
    if not has_role('finance') then raise exception 'Finance reimburses claims'; end if;
    if e.exp_type <> 'CLAIM' or e.status <> 'POSTED' then raise exception 'Only posted employee claims are reimbursed'; end if;
    v_acct := nullif(p_data->>'account_id', '')::uuid;
    if v_acct is null then raise exception 'Choose the bank / cash account'; end if;
    v_je := gl_post('EXPENSE_REIMB', e.id, coalesce(nullif(p_data->>'date', '')::date, current_date), e.exp_no, 'Claim reimbursed ' || e.exp_no || coalesce(' · ' || nullif(p_data->>'ref', ''), ''), null,
      jsonb_build_array(jsonb_build_object('acct', 'EMP_CLAIMS', 'dr', e.total, 'employee_id', e.employee_id), jsonb_build_object('acct', v_acct::text, 'cr', e.total, 'employee_id', e.employee_id)));
    update expenses set status = 'REIMBURSED', reimb_je_id = v_je, reimb_account_id = v_acct, reimb_ref = p_data->>'ref' where id = p_exp;
    perform notify(null, e.created_by, 'Claim ' || e.exp_no || ' reimbursed', coalesce(p_data->>'ref', ''), 'd/exp/' || p_exp, 'exp', p_exp);
    return 'REIMBURSED';
  elsif p_action = 'CANCEL' then
    if e.status in ('POSTED','REIMBURSED','CANCELLED') then raise exception 'Expense is %', e.status; end if;
    if not (has_role('finance') or e.created_by = auth.uid()) then raise exception 'Only Finance or the person who raised it can cancel'; end if;
    update expenses set status = 'CANCELLED' where id = p_exp;
    return 'CANCELLED';
  end if;
  raise exception 'Unknown action %', p_action;
end $$;

-- petty cash top-up from a bank / cash account
create or replace function public.petty_topup(p_float uuid, p_amount numeric, p_from uuid, p_ref text default null, p_date date default current_date)
returns uuid language plpgsql security definer set search_path = public as $$
declare f petty_floats%rowtype;
begin
  if not has_role('finance') then raise exception 'Finance tops up petty cash'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Enter the amount'; end if;
  select * into f from petty_floats where id = p_float;
  return gl_post('PETTY_TOPUP', p_float, p_date, null, 'Petty cash top-up — ' || f.name || coalesce(' · ' || p_ref, ''), null,
    jsonb_build_array(jsonb_build_object('acct', f.gl_account_id::text, 'dr', p_amount), jsonb_build_object('acct', p_from::text, 'cr', p_amount)));
end $$;

create or replace view v_petty_floats with (security_invoker = true) as
select f.id, f.name, f.custodian_id, p.full_name custodian, f.float_limit, f.is_active, f.gl_account_id, a.code account_code,
       coalesce((select sum(l.debit - l.credit) from journal_lines l join journal_entries j on j.id = l.je_id where l.account_id = f.gl_account_id and j.status in ('POSTED','REVERSED')), 0) balance,
       (select coalesce(sum(total), 0) from expenses x where x.petty_float_id = f.id and x.status in ('DRAFT','PENDING_FM','APPROVED')) pending_spend
  from petty_floats f left join profiles p on p.id = f.custodian_id left join gl_accounts a on a.id = f.gl_account_id;

-- ---------- recurring bills ----------
create table expense_templates (
  id             uuid primary key default gen_random_uuid(),
  tpl_no         text not null unique default next_doc_no('RXP'),
  title          text not null,
  exp_type       text not null default 'BILL' check (exp_type in ('BILL','PAID','PETTY','CLAIM')),
  vendor_id      uuid references vendors(id),
  payee_name     text,
  pay_account_id uuid references gl_accounts(id),
  petty_float_id uuid references petty_floats(id),
  day_of_month   int not null default 1 check (day_of_month between 1 and 28),
  next_date      date not null default (date_trunc('month', current_date) + interval '1 month')::date,
  end_date       date,
  status         text not null default 'ACTIVE' check (status in ('ACTIVE','PAUSED')),
  remarks        text,
  created_by     uuid default auth.uid() references profiles(id),
  created_at     timestamptz not null default now(),
  tpl_date       date not null default current_date
);
create table expense_template_lines (
  id             uuid primary key default gen_random_uuid(),
  template_id    uuid not null references expense_templates(id) on delete cascade,
  line_no        int not null default 1,
  account_id     uuid not null references gl_accounts(id),
  description    text,
  cost_center_id uuid not null references cost_centers(id),
  project_id     uuid references projects(id),
  amount         numeric(14,2) not null default 0,
  vat_rate       numeric(5,2) not null default 5
);
alter table expenses add constraint expenses_template_fk foreign key (template_id) references expense_templates(id);

-- creates this month's drafts (amounts to be checked against the actual bill), then moves next_date on a month
create or replace function public.expense_recurring_run(p_template uuid default null) returns int
language plpgsql security definer set search_path = public as $$
declare t record; v_id uuid; n int := 0;
begin
  if p_template is not null and not has_role('finance') then raise exception 'Finance runs recurring bills'; end if;
  for t in select * from expense_templates where status = 'ACTIVE' and (p_template is null and next_date <= current_date or id = p_template)
             and (end_date is null or next_date <= end_date) for update loop
    insert into expenses (exp_date, exp_type, vendor_id, payee_name, pay_account_id, petty_float_id, template_id, remarks, created_by)
    values (t.next_date, t.exp_type, t.vendor_id, t.payee_name, t.pay_account_id, t.petty_float_id, t.id,
            t.title || ' — ' || to_char(t.next_date, 'Mon YYYY') || coalesce(' · ' || t.remarks, ''), t.created_by)
    returning id into v_id;
    insert into expense_lines (expense_id, line_no, account_id, description, cost_center_id, project_id, amount, vat_rate)
    select v_id, line_no, account_id, coalesce(description, t.title) || ' — ' || to_char(t.next_date, 'Mon YYYY'), cost_center_id, project_id, amount, vat_rate
      from expense_template_lines where template_id = t.id;
    update expense_templates set next_date = (date_trunc('month', next_date) + interval '1 month' + make_interval(days => day_of_month - 1))::date where id = t.id;
    perform notify('finance', null, 'Recurring bill drafted: ' || t.title, 'Check the amount against the actual bill, then submit', 'd/exp/' || v_id, 'exp', v_id);
    n := n + 1;
  end loop;
  return n;
end $$;
select cron.schedule('expense-recurring', '30 3 * * *', $c$ select public.expense_recurring_run(null) $c$);

-- ---------- budgets ----------
create table cc_budgets (
  id             uuid primary key default gen_random_uuid(),
  cost_center_id uuid not null references cost_centers(id),
  account_id     uuid references gl_accounts(id),
  period_month   date not null check (period_month = date_trunc('month', period_month)::date),
  amount         numeric(14,2) not null check (amount >= 0),
  remarks        text,
  unique (cost_center_id, account_id, period_month)
);
create unique index cc_budgets_all_heads on cc_budgets(cost_center_id, period_month) where account_id is null;

create or replace view v_budget_vs_actual with (security_invoker = true) as
with act as (
  select l.cost_center_id, l.account_id, date_trunc('month', j.je_date)::date period_month, sum(l.debit - l.credit) actual
    from journal_lines l join journal_entries j on j.id = l.je_id join gl_accounts a on a.id = l.account_id
   where j.status in ('POSTED','REVERSED') and a.acc_type = 'EXPENSE' and l.cost_center_id is not null
   group by 1, 2, 3),
keys as (
  select cost_center_id, account_id, period_month from cc_budgets
  union select cost_center_id, account_id, period_month from act
  union select cost_center_id, null, period_month from act)
select k.period_month, k.cost_center_id, c.code cost_center_code, c.name cost_center_name, k.account_id, a.code account_code, coalesce(a.name, 'All expense heads') account_name,
       coalesce((select b.amount from cc_budgets b where b.cost_center_id = k.cost_center_id and b.period_month = k.period_month and b.account_id is not distinct from k.account_id), 0) budget,
       coalesce((select sum(x.actual) from act x where x.cost_center_id = k.cost_center_id and x.period_month = k.period_month and (k.account_id is null or x.account_id = k.account_id)), 0) actual
  from keys k join cost_centers c on c.id = k.cost_center_id left join gl_accounts a on a.id = k.account_id;

-- ---------- factory overheads: actual vs absorbed into production ----------
create or replace view v_overhead_absorption with (security_invoker = true) as
with months as (
  select distinct date_trunc('month', j.je_date)::date m from journal_entries j where j.status in ('POSTED','REVERSED')
  union select distinct date_trunc('month', log_date)::date from wo_time_logs),
actual as (
  select date_trunc('month', j.je_date)::date m, sum(l.debit - l.credit) amt
    from journal_lines l join journal_entries j on j.id = l.je_id join gl_accounts a on a.id = l.account_id
    left join cost_centers c on c.id = l.cost_center_id
   where j.status in ('POSTED','REVERSED') and a.acc_type = 'EXPENSE' and coalesce(a.system_key, '') not in ('PROD_ABSORBED','LABOUR_ABSORBED')
     and (a.is_factory_overhead or coalesce(c.is_factory, false))
   group by 1),
absorbed as (
  select date_trunc('month', t.log_date)::date m,
         sum(t.labour_hours * t.labour_rate + t.machine_hours * t.machine_rate) base,
         sum((t.labour_hours * t.labour_rate + t.machine_hours * t.machine_rate) * s.overhead_pct / 100) ovh
    from wo_time_logs t cross join company_settings s group by 1)
select mo.m period_month, coalesce(a.amt, 0) actual_overhead, coalesce(b.ovh, 0) absorbed_overhead, coalesce(b.ovh, 0) - coalesce(a.amt, 0) over_under,
       coalesce(b.base, 0) labour_machine_base, (select overhead_pct from company_settings where id = 1) current_pct,
       case when coalesce(b.base, 0) > 0 then round(100 * coalesce(a.amt, 0) / b.base, 1) end suggested_pct
  from months mo left join actual a on a.m = mo.m left join absorbed b on b.m = mo.m
 where coalesce(a.amt, 0) <> 0 or coalesce(b.ovh, 0) <> 0;

-- ---------- attachments (bill photos / PDFs) ----------
insert into storage.buckets (id, name, public) values ('expenses', 'expenses', false) on conflict (id) do nothing;
create policy expenses_read on storage.objects for select to authenticated using (bucket_id = 'expenses' and public.is_active_user());
create policy expenses_write on storage.objects for insert to authenticated with check (bucket_id = 'expenses' and public.is_active_user());
create policy expenses_delete on storage.objects for delete to authenticated using (bucket_id = 'expenses' and public.has_role('finance'));

-- ---------- access ----------
alter table petty_floats enable row level security;
alter table expenses enable row level security;
alter table expense_lines enable row level security;
alter table expense_templates enable row level security;
alter table expense_template_lines enable row level security;
alter table cc_budgets enable row level security;
create policy read_active on petty_floats for select to authenticated using (public.is_active_user());
create policy fin_write on petty_floats for all to authenticated using (public.is_finance()) with check (public.is_finance());
-- staff see their own claims / petty spends; Finance, FM see all
create policy exp_read on expenses for select to authenticated using (public.has_role('finance','factory_manager') or created_by = auth.uid());
create policy exp_insert on expenses for insert to authenticated with check (public.is_active_user() and status = 'DRAFT' and (exp_type in ('CLAIM','PETTY') or public.has_role('finance','factory_manager','purchase','stores')));
create policy exp_update on expenses for update to authenticated using (status in ('DRAFT','REJECTED') and (created_by = auth.uid() or public.is_finance()))
  with check (status in ('DRAFT','REJECTED'));
create policy exp_delete on expenses for delete to authenticated using (status = 'DRAFT' and (created_by = auth.uid() or public.is_finance()));
create policy exp_lines_read on expense_lines for select to authenticated using (exists (select 1 from expenses e where e.id = expense_id));
create policy exp_lines_write on expense_lines for all to authenticated
  using (exists (select 1 from expenses e where e.id = expense_id and e.status in ('DRAFT','REJECTED') and (e.created_by = auth.uid() or public.is_finance())))
  with check (exists (select 1 from expenses e where e.id = expense_id and e.status in ('DRAFT','REJECTED') and (e.created_by = auth.uid() or public.is_finance())));
create policy fin_read on expense_templates for select to authenticated using (public.has_role('finance','factory_manager'));
create policy fin_write on expense_templates for all to authenticated using (public.is_finance()) with check (public.is_finance());
create policy fin_read on expense_template_lines for select to authenticated using (public.has_role('finance','factory_manager'));
create policy fin_write on expense_template_lines for all to authenticated using (public.is_finance()) with check (public.is_finance());
create policy fin_read on cc_budgets for select to authenticated using (public.has_role('finance','factory_manager'));
create policy fin_write on cc_budgets for all to authenticated using (public.is_finance()) with check (public.is_finance());

grant execute on function public.expense_action(uuid, text, jsonb), public.petty_topup(uuid, numeric, uuid, text, date), public.expense_recurring_run(uuid) to authenticated;
revoke execute on function public.expense_action(uuid, text, jsonb), public.petty_topup(uuid, numeric, uuid, text, date), public.expense_recurring_run(uuid) from anon;
