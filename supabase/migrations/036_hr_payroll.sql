-- =====================================================================
-- CitiCore - 036 HR & payroll (UAE)
--   employee profile + documents (expiry alerts), salary / bank (restricted to HR, Finance, admin),
--   attendance & overtime, leave (UAE accrual), salary advances, payroll runs (HR prepares,
--   Finance approves), payslips, WPS SIF data, gratuity (end of service) per UAE labour law
-- =====================================================================

create or replace function public.is_hr() returns boolean
language sql stable security definer set search_path = public as $$ select has_role('hr_officer','finance') $$;

-- ---------- employee profile (non-sensitive; readable by all active users) ----------
alter table employees
  add column nationality    text,
  add column gender         text check (gender in ('M','F')),
  add column date_of_birth  date,
  add column joining_date   date,
  add column mobile         text,
  add column email          text,
  add column work_location  text not null default 'FACTORY' check (work_location in ('FACTORY','SITE','OFFICE','CAMP')),
  add column accommodation  text,
  add column emp_status     text not null default 'ACTIVE' check (emp_status in ('ACTIVE','ON_LEAVE','RESIGNED','TERMINATED','ABSCONDED')),
  add column last_working_day date,
  add column profile_id     uuid references profiles(id);

-- HR can maintain employees too
drop policy write_roles on employees;
create policy write_roles on employees for all to authenticated
  using (public.has_role('hr_officer','stores','factory_manager','production_incharge'))
  with check (public.has_role('hr_officer','stores','factory_manager','production_incharge'));

-- ---------- salary & bank (sensitive) ----------
create table employee_pay (
  employee_id        uuid primary key references employees(id) on delete cascade,
  basic              numeric(12,2) not null default 0,
  housing            numeric(12,2) not null default 0,
  transport          numeric(12,2) not null default 0,
  food               numeric(12,2) not null default 0,
  other_allowance    numeric(12,2) not null default 0,
  ot_eligible        boolean not null default true,
  pay_mode           text not null default 'WPS_BANK' check (pay_mode in ('WPS_BANK','WPS_EXCHANGE','CASH','CHEQUE')),
  bank_name          text,
  iban               text,
  agent_routing_code text,                 -- WPS routing code (9 digits) of the employee's bank / exchange
  mol_person_id      text,                 -- 14-digit labour (MOHRE) personal number for WPS
  contract_type      text not null default 'LIMITED' check (contract_type in ('LIMITED','UNLIMITED')),
  contract_end       date,
  updated_at         timestamptz not null default now(),
  updated_by         uuid default auth.uid() references profiles(id)
);

-- ---------- documents ----------
create table employee_documents (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id) on delete cascade,
  doc_type    text not null check (doc_type in ('PASSPORT','RESIDENCE_VISA','EMIRATES_ID','LABOUR_CARD','WORK_PERMIT','MEDICAL_INSURANCE','DRIVING_LICENCE','HEALTH_CARD','CONTRACT','OTHER')),
  doc_no      text,
  issue_date  date,
  expiry_date date,
  file_path   text,                       -- storage bucket "hr-docs"
  remarks     text,
  created_by  uuid default auth.uid() references profiles(id),
  created_at  timestamptz not null default now()
);
create index employee_documents_emp_idx on employee_documents(employee_id);
create index employee_documents_exp_idx on employee_documents(expiry_date);

create or replace view v_document_expiry with (security_invoker = true) as
select d.id, d.employee_id, e.emp_code, e.name, e.department, e.emp_status, d.doc_type, d.doc_no, d.expiry_date,
       (d.expiry_date - current_date) days_left,
       case when d.expiry_date is null then 'NO_EXPIRY' when d.expiry_date < current_date then 'EXPIRED'
            when d.expiry_date <= current_date + 30 then 'DUE_30' when d.expiry_date <= current_date + 60 then 'DUE_60' else 'VALID' end expiry_status
  from employee_documents d join employees e on e.id = d.employee_id
 where e.emp_status in ('ACTIVE','ON_LEAVE');

-- ---------- attendance & overtime ----------
create table attendance (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references employees(id),
  att_date     date not null,
  status       text not null default 'PRESENT' check (status in ('PRESENT','ABSENT','HALF_DAY','LEAVE','WEEK_OFF','HOLIDAY','SICK')),
  work_location text check (work_location in ('FACTORY','SITE','OFFICE')),
  project_id   uuid references projects(id),
  normal_hours numeric(5,2) not null default 8 check (normal_hours >= 0),
  ot_hours     numeric(5,2) not null default 0 check (ot_hours >= 0),     -- normal overtime (125%)
  ot_hours_holiday numeric(5,2) not null default 0 check (ot_hours_holiday >= 0),   -- night / rest day / holiday (150%)
  remarks      text,
  entered_by   uuid default auth.uid() references profiles(id),
  entered_at   timestamptz not null default now(),
  unique (employee_id, att_date)
);
create index attendance_date_idx on attendance(att_date);

-- ---------- leave ----------
create table leave_types (
  code        text primary key,
  name        text not null,
  pay_pct     numeric(5,2) not null default 100,       -- 100 paid, 50 half paid, 0 unpaid
  annual_days numeric(6,2),                            -- entitlement per year (null = as per law / unlimited)
  counts_service boolean not null default true,        -- unpaid leave does not count for gratuity service
  sort_order  int not null default 50
);
insert into leave_types (code, name, pay_pct, annual_days, counts_service, sort_order) values
 ('ANNUAL','Annual leave',100,30,true,10), ('SICK_FULL','Sick leave (full pay, first 15 days)',100,15,true,20),
 ('SICK_HALF','Sick leave (half pay, next 30 days)',50,30,true,30), ('SICK_UNPAID','Sick leave (unpaid, next 45 days)',0,45,false,40),
 ('MATERNITY','Maternity leave',100,45,true,50), ('PARENTAL','Parental leave',100,5,true,60), ('BEREAVEMENT','Bereavement leave',100,5,true,70),
 ('HAJJ','Hajj / Umrah leave (unpaid)',0,30,false,80), ('UNPAID','Unpaid leave',0,null,false,90), ('EMERGENCY','Emergency leave',100,null,true,95);

create table leave_requests (
  id            uuid primary key default gen_random_uuid(),
  leave_no      text not null unique default next_doc_no('LV'),
  employee_id   uuid not null references employees(id),
  leave_type    text not null references leave_types(code),
  from_date     date not null,
  to_date       date not null,
  days          numeric(6,2) not null,
  reason        text,
  ticket_eligible boolean not null default false,
  status        text not null default 'DRAFT' check (status in ('DRAFT','PENDING','APPROVED','REJECTED','CANCELLED')),
  approved_by   uuid references profiles(id), approved_at timestamptz, approval_comments text,
  return_date   date,
  created_by    uuid default auth.uid() references profiles(id),
  created_at    timestamptz not null default now(),
  check (to_date >= from_date)
);
create index leave_requests_emp_idx on leave_requests(employee_id, from_date);

-- calendar days of approved leave of given pay types inside a period
create or replace function public.leave_days_in(p_emp uuid, p_from date, p_to date, p_types text[] default null) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(greatest(0, (least(r.to_date, p_to) - greatest(r.from_date, p_from)) + 1)), 0)
    from leave_requests r where r.employee_id = p_emp and r.status = 'APPROVED'
     and r.from_date <= p_to and r.to_date >= p_from and (p_types is null or r.leave_type = any(p_types))
$$;

-- UAE annual leave accrual: nothing before 6 months, 2 days / month in the first year, 30 days / year after
create or replace function public.annual_leave_accrued(p_emp uuid, p_as_of date default current_date) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare j date; m numeric;
begin
  select joining_date into j from employees where id = p_emp;
  if j is null or p_as_of < j then return 0; end if;
  m := (extract(year from age(p_as_of, j)) * 12 + extract(month from age(p_as_of, j)))::numeric;
  if m < 6 then return 0; elsif m < 12 then return 2 * m; else return round(30 + 2.5 * (m - 12), 2); end if;
end $$;

create or replace view v_leave_balance with (security_invoker = true) as
select e.id employee_id, e.emp_code, e.name, e.department, e.joining_date, e.emp_status,
       annual_leave_accrued(e.id) accrued,
       coalesce((select sum(days) from leave_requests r where r.employee_id = e.id and r.leave_type = 'ANNUAL' and r.status = 'APPROVED'), 0) taken,
       annual_leave_accrued(e.id) - coalesce((select sum(days) from leave_requests r where r.employee_id = e.id and r.leave_type = 'ANNUAL' and r.status = 'APPROVED'), 0) balance,
       coalesce((select sum(days) from leave_requests r where r.employee_id = e.id and r.leave_type like 'SICK%' and r.status = 'APPROVED'
                  and r.from_date >= date_trunc('year', current_date)), 0) sick_this_year
  from employees e where e.emp_status in ('ACTIVE','ON_LEAVE');

create or replace function public.leave_action(p_id uuid, p_action text, p_comments text default null) returns text
language plpgsql security definer set search_path = public as $$
declare r leave_requests%rowtype; v_bal numeric;
begin
  select * into r from leave_requests where id = p_id for update;
  if not found then raise exception 'Leave request not found'; end if;
  if p_action = 'SUBMIT' then
    if r.status not in ('DRAFT','REJECTED') then raise exception 'Leave is %', r.status; end if;
    if exists (select 1 from leave_requests x where x.employee_id = r.employee_id and x.id <> r.id and x.status in ('PENDING','APPROVED')
                and x.from_date <= r.to_date and x.to_date >= r.from_date) then raise exception 'Overlaps another leave of this employee'; end if;
    update leave_requests set status = 'PENDING' where id = p_id;
    perform notify('hr_officer', null, 'Leave ' || r.leave_no || ' for approval', (select name from employees where id = r.employee_id) || ': ' || r.days || ' day(s)', 'd/leave/' || p_id, 'leave', p_id);
    return 'PENDING';
  elsif p_action in ('APPROVE','REJECT') then
    if not has_role('hr_officer','factory_manager') then raise exception 'Only HR or the Factory Manager can approve leave'; end if;
    if r.status <> 'PENDING' then raise exception 'Leave is not pending'; end if;
    if p_action = 'APPROVE' and r.leave_type = 'ANNUAL' then
      select balance into v_bal from v_leave_balance where employee_id = r.employee_id;
      if coalesce(v_bal, 0) < r.days and coalesce(trim(p_comments), '') = '' then
        raise exception 'Annual leave balance is % day(s) — enter a comment to approve beyond the balance', coalesce(v_bal, 0);
      end if;
    end if;
    if p_action = 'REJECT' and coalesce(trim(p_comments), '') = '' then raise exception 'Give a reason'; end if;
    update leave_requests set status = case when p_action = 'APPROVE' then 'APPROVED' else 'REJECTED' end,
           approved_by = auth.uid(), approved_at = now(), approval_comments = p_comments where id = p_id;
    if p_action = 'APPROVE' then
      insert into attendance (employee_id, att_date, status, normal_hours, remarks)
      select r.employee_id, d::date, case when r.leave_type like 'SICK%' then 'SICK' else 'LEAVE' end, 0, r.leave_no
        from generate_series(r.from_date, r.to_date, interval '1 day') d
      on conflict (employee_id, att_date) do update set status = excluded.status, normal_hours = 0, ot_hours = 0, ot_hours_holiday = 0, remarks = excluded.remarks;
    end if;
    return case when p_action = 'APPROVE' then 'APPROVED' else 'REJECTED' end;
  elsif p_action = 'CANCEL' then
    if r.status not in ('DRAFT','PENDING','APPROVED') then raise exception 'Leave is %', r.status; end if;
    if r.status = 'APPROVED' and not has_role('hr_officer') then raise exception 'Only HR can cancel approved leave'; end if;
    if r.status = 'APPROVED' then delete from attendance where employee_id = r.employee_id and remarks = r.leave_no; end if;
    update leave_requests set status = 'CANCELLED' where id = p_id;
    return 'CANCELLED';
  end if;
  raise exception 'Unknown action %', p_action;
end $$;

-- ---------- salary advances / loans ----------
create table employee_advances (
  id           uuid primary key default gen_random_uuid(),
  adv_no       text not null unique default next_doc_no('ADV'),
  employee_id  uuid not null references employees(id),
  adv_date     date not null default current_date,
  amount       numeric(12,2) not null check (amount > 0),
  installment  numeric(12,2) not null check (installment > 0),
  recovered    numeric(12,2) not null default 0,
  reason       text,
  status       text not null default 'DRAFT' check (status in ('DRAFT','APPROVED','CLOSED','CANCELLED')),
  approved_by  uuid references profiles(id), approved_at timestamptz,
  created_by   uuid default auth.uid() references profiles(id),
  created_at   timestamptz not null default now()
);

create or replace function public.advance_action(p_id uuid, p_action text) returns text
language plpgsql security definer set search_path = public as $$
begin
  if p_action = 'APPROVE' then
    if not has_role('finance') then raise exception 'Finance approves salary advances'; end if;
    update employee_advances set status = 'APPROVED', approved_by = auth.uid(), approved_at = now() where id = p_id and status = 'DRAFT';
  elsif p_action = 'CANCEL' then
    if not has_role('hr_officer','finance') then raise exception 'Not allowed'; end if;
    update employee_advances set status = 'CANCELLED' where id = p_id and status = 'DRAFT';
  else raise exception 'Unknown action %', p_action; end if;
  if not found then raise exception 'Advance is not in a state for this action'; end if;
  return p_action;
end $$;

-- ---------- payroll ----------
alter table company_settings
  add column mol_establishment_id text,          -- 13-digit MOHRE establishment ID (WPS employer ID)
  add column wps_bank_routing     text,          -- employer bank routing code
  add column wps_employer_ref     text,
  add column ot_rate_normal_pct   numeric(6,2) not null default 125,
  add column ot_rate_holiday_pct  numeric(6,2) not null default 150,
  add column ot_basis             text not null default 'BASIC' check (ot_basis in ('BASIC','GROSS'));

create table payroll_runs (
  id           uuid primary key default gen_random_uuid(),
  run_no       text not null unique default next_doc_no('PAY'),
  period_month date not null unique,          -- first day of the month
  status       text not null default 'DRAFT' check (status in ('DRAFT','SUBMITTED','APPROVED','PAID','CANCELLED')),
  employees    int not null default 0,
  total_gross  numeric(16,2) not null default 0,
  total_deductions numeric(16,2) not null default 0,
  total_net    numeric(16,2) not null default 0,
  remarks      text,
  calculated_at timestamptz,
  submitted_by uuid references profiles(id), submitted_at timestamptz,
  approved_by  uuid references profiles(id), approved_at timestamptz, approval_comments text,
  paid_by      uuid references profiles(id), paid_at timestamptz, payment_ref text,
  created_by   uuid default auth.uid() references profiles(id),
  created_at   timestamptz not null default now(),
  check (period_month = date_trunc('month', period_month)::date)
);

create table payroll_lines (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references payroll_runs(id) on delete cascade,
  employee_id     uuid not null references employees(id),
  paid_days       numeric(6,2) not null default 30,
  unpaid_days     numeric(6,2) not null default 0,        -- absent + unpaid leave (+ unpaid share of half-pay sick)
  leave_days      numeric(6,2) not null default 0,        -- days on leave in the month (WPS)
  basic           numeric(12,2) not null default 0,
  allowances      numeric(12,2) not null default 0,
  fixed_earned    numeric(12,2) not null default 0,
  ot_hours        numeric(8,2) not null default 0,
  ot_hours_holiday numeric(8,2) not null default 0,
  ot_amount       numeric(12,2) not null default 0,
  additions       numeric(12,2) not null default 0,        -- bonus, arrears (entered by HR)
  addition_note   text,
  unpaid_deduction numeric(12,2) not null default 0,
  advance_recovery numeric(12,2) not null default 0,
  other_deductions numeric(12,2) not null default 0,       -- fines, damages (entered by HR)
  deduction_note  text,
  gross           numeric(12,2) not null default 0,
  net             numeric(12,2) not null default 0,
  pay_mode        text,
  unique (run_id, employee_id)
);

-- (re)calculate a draft run: keeps HR-entered additions / other deductions
create or replace function public.payroll_calculate(p_run uuid) returns int
language plpgsql security definer set search_path = public as $$
declare r payroll_runs%rowtype; s company_settings%rowtype; e record; v_from date; v_to date; n int := 0;
  v_days numeric; v_unpaid numeric; v_leave numeric; v_fixed numeric; v_basic numeric; v_allow numeric; v_ot_n numeric; v_ot_h numeric; v_hour numeric;
  v_ot numeric; v_unpaid_amt numeric; v_adv numeric; v_add numeric; v_oth numeric; v_absent numeric; v_half numeric;
begin
  if not has_role('hr_officer') then raise exception 'HR prepares the payroll'; end if;
  select * into r from payroll_runs where id = p_run for update;
  if r.status <> 'DRAFT' then raise exception 'Payroll is %', r.status; end if;
  select * into s from company_settings where id = 1;
  v_from := r.period_month; v_to := (r.period_month + interval '1 month - 1 day')::date;
  -- drop lines of employees no longer in scope
  delete from payroll_lines l where l.run_id = p_run and not exists (
    select 1 from employees em join employee_pay p on p.employee_id = em.id
     where em.id = l.employee_id and coalesce(em.joining_date, v_from) <= v_to and (em.last_working_day is null or em.last_working_day >= v_from));
  for e in select em.*, p.basic, p.housing, p.transport, p.food, p.other_allowance, p.ot_eligible, p.pay_mode
             from employees em join employee_pay p on p.employee_id = em.id
            where coalesce(em.joining_date, v_from) <= v_to and (em.last_working_day is null or em.last_working_day >= v_from)
              and em.emp_status <> 'ABSCONDED' loop
    -- employed days in the month on a 30-day basis
    v_days := least(30, (least(v_to, coalesce(e.last_working_day, v_to)) - greatest(v_from, coalesce(e.joining_date, v_from))) + 1);
    if v_to - v_from + 1 <> 30 and greatest(v_from, coalesce(e.joining_date, v_from)) = v_from and least(v_to, coalesce(e.last_working_day, v_to)) = v_to then v_days := 30; end if;
    v_absent := (select count(*) from attendance a where a.employee_id = e.id and a.att_date between v_from and v_to and a.status = 'ABSENT')
              + 0.5 * (select count(*) from attendance a where a.employee_id = e.id and a.att_date between v_from and v_to and a.status = 'HALF_DAY');
    v_half := leave_days_in(e.id, v_from, v_to, array(select code from leave_types where pay_pct > 0 and pay_pct < 100));
    v_unpaid := v_absent + leave_days_in(e.id, v_from, v_to, array(select code from leave_types where pay_pct = 0))
              + v_half * 0.5;
    v_leave := leave_days_in(e.id, v_from, v_to, null);
    v_basic := e.basic; v_allow := e.housing + e.transport + e.food + e.other_allowance;
    v_fixed := round((v_basic + v_allow) * v_days / 30, 2);
    v_unpaid_amt := round((v_basic + v_allow) / 30 * least(v_unpaid, v_days), 2);
    select coalesce(sum(ot_hours), 0), coalesce(sum(ot_hours_holiday), 0) into v_ot_n, v_ot_h
      from attendance a where a.employee_id = e.id and a.att_date between v_from and v_to;
    if not e.ot_eligible then v_ot_n := 0; v_ot_h := 0; end if;
    v_hour := (case when s.ot_basis = 'GROSS' then v_basic + v_allow else v_basic end) / 30 / 8;
    v_ot := round(v_hour * (v_ot_n * s.ot_rate_normal_pct + v_ot_h * s.ot_rate_holiday_pct) / 100, 2);
    select coalesce(sum(least(a.installment, a.amount - a.recovered)), 0) into v_adv
      from employee_advances a where a.employee_id = e.id and a.status = 'APPROVED' and a.amount > a.recovered and a.adv_date <= v_to;
    select coalesce(additions, 0), coalesce(other_deductions, 0) into v_add, v_oth from payroll_lines where run_id = p_run and employee_id = e.id;
    v_add := coalesce(v_add, 0); v_oth := coalesce(v_oth, 0);
    v_adv := least(v_adv, greatest(v_fixed + v_ot + v_add - v_unpaid_amt - v_oth, 0));
    insert into payroll_lines (run_id, employee_id, paid_days, unpaid_days, leave_days, basic, allowances, fixed_earned, ot_hours, ot_hours_holiday, ot_amount,
                               additions, unpaid_deduction, advance_recovery, other_deductions, gross, net, pay_mode)
    values (p_run, e.id, v_days, v_unpaid, v_leave, v_basic, v_allow, v_fixed, v_ot_n, v_ot_h, v_ot, v_add, v_unpaid_amt, v_adv, v_oth,
            v_fixed + v_ot + v_add, v_fixed + v_ot + v_add - v_unpaid_amt - v_adv - v_oth, e.pay_mode)
    on conflict (run_id, employee_id) do update set paid_days = excluded.paid_days, unpaid_days = excluded.unpaid_days, leave_days = excluded.leave_days,
       basic = excluded.basic, allowances = excluded.allowances, fixed_earned = excluded.fixed_earned, ot_hours = excluded.ot_hours,
       ot_hours_holiday = excluded.ot_hours_holiday, ot_amount = excluded.ot_amount, unpaid_deduction = excluded.unpaid_deduction,
       advance_recovery = excluded.advance_recovery, gross = excluded.gross, net = excluded.net, pay_mode = excluded.pay_mode;
    n := n + 1;
  end loop;
  update payroll_runs set calculated_at = now(), employees = n,
         total_gross = (select coalesce(sum(gross), 0) from payroll_lines where run_id = p_run),
         total_deductions = (select coalesce(sum(unpaid_deduction + advance_recovery + other_deductions), 0) from payroll_lines where run_id = p_run),
         total_net = (select coalesce(sum(net), 0) from payroll_lines where run_id = p_run)
   where id = p_run;
  return n;
end $$;

-- additions / other deductions edited by HR on a draft run: recompute that line's totals
create or replace function public.trg_payroll_line_totals() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.gross := new.fixed_earned + new.ot_amount + new.additions;
  new.net := new.gross - new.unpaid_deduction - new.advance_recovery - new.other_deductions;
  return new;
end $$;
create trigger payroll_line_totals before update of additions, other_deductions on payroll_lines for each row execute function trg_payroll_line_totals();
revoke execute on function public.trg_payroll_line_totals() from public, anon, authenticated;

create or replace function public.payroll_action(p_run uuid, p_action text, p_comments text default null) returns text
language plpgsql security definer set search_path = public as $$
declare r payroll_runs%rowtype; l record; v_left numeric; a record; v_take numeric;
begin
  select * into r from payroll_runs where id = p_run for update;
  if not found then raise exception 'Payroll run not found'; end if;
  if p_action = 'SUBMIT' then
    if not has_role('hr_officer') then raise exception 'HR submits the payroll'; end if;
    if r.status <> 'DRAFT' then raise exception 'Payroll is %', r.status; end if;
    if r.calculated_at is null or not exists (select 1 from payroll_lines where run_id = p_run) then raise exception 'Calculate the payroll first'; end if;
    if exists (select 1 from payroll_lines where run_id = p_run and net < 0) then raise exception 'Some employees have a negative net salary — review deductions'; end if;
    update payroll_runs set status = 'SUBMITTED', submitted_by = auth.uid(), submitted_at = now(),
           total_gross = (select coalesce(sum(gross), 0) from payroll_lines where run_id = p_run),
           total_deductions = (select coalesce(sum(unpaid_deduction + advance_recovery + other_deductions), 0) from payroll_lines where run_id = p_run),
           total_net = (select coalesce(sum(net), 0) from payroll_lines where run_id = p_run)
     where id = p_run;
    perform notify('finance', null, 'Payroll ' || to_char(r.period_month, 'Mon YYYY') || ' for approval', r.run_no, 'd/payroll/' || p_run, 'payroll', p_run);
    return 'SUBMITTED';
  elsif p_action = 'RETURN' then
    if not has_role('finance') then raise exception 'Finance returns the payroll'; end if;
    if r.status <> 'SUBMITTED' then raise exception 'Payroll is %', r.status; end if;
    if coalesce(trim(p_comments), '') = '' then raise exception 'Give a reason'; end if;
    update payroll_runs set status = 'DRAFT', approval_comments = p_comments where id = p_run;
    perform notify('hr_officer', null, 'Payroll ' || to_char(r.period_month, 'Mon YYYY') || ' returned', p_comments, 'd/payroll/' || p_run, 'payroll', p_run);
    return 'DRAFT';
  elsif p_action = 'APPROVE' then
    if not has_role('finance') then raise exception 'Finance approves the payroll'; end if;
    if r.status <> 'SUBMITTED' then raise exception 'Payroll is %', r.status; end if;
    update payroll_runs set status = 'APPROVED', approved_by = auth.uid(), approved_at = now(), approval_comments = p_comments where id = p_run;
    perform notify('hr_officer', null, 'Payroll ' || to_char(r.period_month, 'Mon YYYY') || ' approved', 'Generate the WPS file and pay', 'd/payroll/' || p_run, 'payroll', p_run);
    return 'APPROVED';
  elsif p_action = 'PAID' then
    if not has_role('finance') then raise exception 'Finance confirms payment'; end if;
    if r.status <> 'APPROVED' then raise exception 'Payroll is %', r.status; end if;
    -- recover advances, oldest first
    for l in select * from payroll_lines where run_id = p_run and advance_recovery > 0 loop
      v_left := l.advance_recovery;
      for a in select * from employee_advances where employee_id = l.employee_id and status = 'APPROVED' and amount > recovered order by adv_date, created_at for update loop
        exit when v_left <= 0;
        v_take := least(v_left, a.amount - a.recovered);
        update employee_advances set recovered = recovered + v_take, status = case when recovered + v_take >= amount - 0.005 then 'CLOSED' else status end where id = a.id;
        v_left := v_left - v_take;
      end loop;
    end loop;
    update payroll_runs set status = 'PAID', paid_by = auth.uid(), paid_at = now(), payment_ref = p_comments where id = p_run;
    return 'PAID';
  elsif p_action = 'CANCEL' then
    if not has_role('hr_officer','finance') then raise exception 'Not allowed'; end if;
    if r.status not in ('DRAFT','SUBMITTED') then raise exception 'Payroll is %', r.status; end if;
    update payroll_runs set status = 'CANCELLED', period_month = period_month where id = p_run;
    return 'CANCELLED';
  end if;
  raise exception 'Unknown action %', p_action;
end $$;
-- a cancelled run must not block a new run for the same month
alter table payroll_runs drop constraint payroll_runs_period_month_key;
create unique index payroll_runs_month_live on payroll_runs(period_month) where status <> 'CANCELLED';

-- WPS SIF rows (EDR per employee + SCR trailer) for an approved / paid run
create or replace function public.payroll_wps_sif(p_run uuid) returns table (line text)
language plpgsql security definer set search_path = public as $$
declare r payroll_runs%rowtype; s company_settings%rowtype; v_from date; v_to date; v_cnt int; v_total numeric; v_bad text;
begin
  if not has_role('hr_officer','finance') then raise exception 'Not allowed'; end if;
  select * into r from payroll_runs where id = p_run;
  if r.status not in ('APPROVED','PAID') then raise exception 'The WPS file is produced after Finance approval'; end if;
  select * into s from company_settings where id = 1;
  if coalesce(s.mol_establishment_id, '') = '' or coalesce(s.wps_bank_routing, '') = '' then raise exception 'Enter the MOHRE establishment ID and the employer bank routing code in Settings'; end if;
  select string_agg(e.emp_code, ', ') into v_bad from payroll_lines l join employees e on e.id = l.employee_id join employee_pay p on p.employee_id = e.id
   where l.run_id = p_run and l.net > 0 and l.pay_mode like 'WPS%' and (coalesce(p.mol_person_id, '') = '' or coalesce(p.agent_routing_code, '') = '' or coalesce(p.iban, '') = '');
  if v_bad is not null then raise exception 'Missing WPS details (labour personal no., routing code or IBAN) for: %', v_bad; end if;
  v_from := r.period_month; v_to := (r.period_month + interval '1 month - 1 day')::date;
  for line in
    select concat_ws(',', 'EDR', p.mol_person_id, p.agent_routing_code, replace(p.iban, ' ', ''), to_char(v_from, 'YYYY-MM-DD'), to_char(v_to, 'YYYY-MM-DD'),
                     (v_to - v_from + 1)::text, to_char(l.net - (l.ot_amount + l.additions), 'FM999999990.00'), to_char(l.ot_amount + l.additions, 'FM999999990.00'),
                     round(l.leave_days)::text)
      from payroll_lines l join employees e on e.id = l.employee_id join employee_pay p on p.employee_id = e.id
     where l.run_id = p_run and l.net > 0 and l.pay_mode like 'WPS%' order by e.emp_code
  loop return next; end loop;
  select count(*), coalesce(sum(net), 0) into v_cnt, v_total from payroll_lines where run_id = p_run and net > 0 and pay_mode like 'WPS%';
  line := concat_ws(',', 'SCR', s.mol_establishment_id, s.wps_bank_routing, to_char(now(), 'YYYY-MM-DD'), to_char(now(), 'HH24MI'), to_char(v_from, 'MMYYYY'),
                    v_cnt::text, to_char(v_total, 'FM999999990.00'), 'AED', coalesce(s.wps_employer_ref, ''));
  return next;
end $$;

-- ---------- gratuity (end of service) — UAE: 21 days' basic / year for 5 years, 30 days after; none under 1 year; cap 2 years' pay ----------
create or replace function public.gratuity_calc(p_emp uuid, p_last_day date default current_date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare e employees%rowtype; p employee_pay%rowtype; v_unpaid numeric; v_days numeric; v_years numeric; v_daily numeric; v_amt numeric; v_leave numeric;
begin
  if not has_role('hr_officer','finance') then raise exception 'Not allowed'; end if;
  select * into e from employees where id = p_emp; select * into p from employee_pay where employee_id = p_emp;
  if e.joining_date is null then raise exception 'Joining date missing for %', e.name; end if;
  v_unpaid := coalesce((select sum(days) from leave_requests r join leave_types t on t.code = r.leave_type where r.employee_id = p_emp and r.status = 'APPROVED' and not t.counts_service), 0)
            + coalesce((select count(*) from attendance where employee_id = p_emp and status = 'ABSENT'), 0);
  v_days := greatest(0, (p_last_day - e.joining_date) + 1 - v_unpaid);
  v_years := v_days / 365.0;
  v_daily := coalesce(p.basic, 0) / 30;
  v_amt := case when v_years < 1 then 0 else v_daily * 21 * least(v_years, 5) + v_daily * 30 * greatest(v_years - 5, 0) end;
  v_amt := least(v_amt, coalesce(p.basic, 0) * 24);
  select balance into v_leave from v_leave_balance where employee_id = p_emp;
  return jsonb_build_object('employee', e.name, 'joining_date', e.joining_date, 'last_day', p_last_day, 'unpaid_days_excluded', v_unpaid,
    'service_days', v_days, 'service_years', round(v_years, 3), 'basic', p.basic, 'daily_basic', round(v_daily, 2),
    'gratuity', round(v_amt, 2), 'leave_balance_days', round(coalesce(v_leave, 0), 2),
    'leave_encashment', round(greatest(coalesce(v_leave, 0), 0) * (coalesce(p.basic, 0) + coalesce(p.housing, 0) + coalesce(p.transport, 0) + coalesce(p.food, 0) + coalesce(p.other_allowance, 0)) / 30, 2),
    'advances_outstanding', (select coalesce(sum(amount - recovered), 0) from employee_advances where employee_id = p_emp and status = 'APPROVED'));
end $$;

create or replace view v_gratuity_provision with (security_invoker = true) as
select e.id employee_id, e.emp_code, e.name, e.department, e.joining_date, p.basic,
       (gratuity_calc(e.id) ->> 'service_years')::numeric service_years,
       (gratuity_calc(e.id) ->> 'gratuity')::numeric gratuity_provision,
       (gratuity_calc(e.id) ->> 'leave_encashment')::numeric leave_provision
  from employees e join employee_pay p on p.employee_id = e.id
 where e.emp_status in ('ACTIVE','ON_LEAVE') and e.joining_date is not null;

-- ---------- RLS ----------
alter table employee_pay enable row level security;
alter table employee_documents enable row level security;
alter table attendance enable row level security;
alter table leave_types enable row level security;
alter table leave_requests enable row level security;
alter table employee_advances enable row level security;
alter table payroll_runs enable row level security;
alter table payroll_lines enable row level security;
-- pay, documents, advances, payroll: HR + Finance (+ admin) only
create policy hr_read on employee_pay for select to authenticated using (public.is_hr());
create policy hr_write on employee_pay for all to authenticated using (public.has_role('hr_officer')) with check (public.has_role('hr_officer'));
create policy hr_read on employee_documents for select to authenticated using (public.is_hr());
create policy hr_write on employee_documents for all to authenticated using (public.has_role('hr_officer')) with check (public.has_role('hr_officer'));
create policy hr_read on employee_advances for select to authenticated using (public.is_hr());
create policy hr_write on employee_advances for all to authenticated using (public.has_role('hr_officer') and status = 'DRAFT') with check (public.has_role('hr_officer') and status = 'DRAFT');
create policy hr_read on payroll_runs for select to authenticated using (public.is_hr());
create policy hr_insert on payroll_runs for insert to authenticated with check (public.has_role('hr_officer') and status = 'DRAFT');
create policy hr_update on payroll_runs for update to authenticated using (public.has_role('hr_officer') and status = 'DRAFT') with check (status = 'DRAFT');
create policy hr_delete on payroll_runs for delete to authenticated using (public.has_role('hr_officer') and status = 'DRAFT');
create policy hr_read on payroll_lines for select to authenticated using (public.is_hr());
create policy hr_edit on payroll_lines for update to authenticated
  using (public.has_role('hr_officer') and exists (select 1 from payroll_runs r where r.id = payroll_lines.run_id and r.status = 'DRAFT'))
  with check (public.has_role('hr_officer') and exists (select 1 from payroll_runs r where r.id = payroll_lines.run_id and r.status = 'DRAFT'));
-- attendance: supervisors enter, HR maintains; no salary data in it
create policy read_active on attendance for select to authenticated using (public.is_active_user());
create policy att_write on attendance for all to authenticated
  using (public.has_role('hr_officer','site_supervisor','shop_floor','production_incharge','factory_manager'))
  with check (public.has_role('hr_officer','site_supervisor','shop_floor','production_incharge','factory_manager'));
-- leave: anyone in a supervising role can raise; HR / FM approve via leave_action
create policy read_active on leave_types for select to authenticated using (public.is_active_user());
create policy hr_write on leave_types for all to authenticated using (public.has_role('hr_officer')) with check (public.has_role('hr_officer'));
create policy read_active on leave_requests for select to authenticated using (public.is_active_user());
create policy lv_insert on leave_requests for insert to authenticated with check (public.is_active_user() and status = 'DRAFT');
create policy lv_update on leave_requests for update to authenticated using (status in ('DRAFT','REJECTED') and (created_by = auth.uid() or public.has_role('hr_officer')))
  with check (status in ('DRAFT','REJECTED'));
create policy lv_delete on leave_requests for delete to authenticated using (status = 'DRAFT' and (created_by = auth.uid() or public.has_role('hr_officer')));

-- private bucket for employee documents
insert into storage.buckets (id, name, public, file_size_limit) values ('hr-docs', 'hr-docs', false, 10485760) on conflict (id) do nothing;
create policy hr_docs_read on storage.objects for select to authenticated using (bucket_id = 'hr-docs' and public.is_hr());
create policy hr_docs_write on storage.objects for insert to authenticated with check (bucket_id = 'hr-docs' and public.has_role('hr_officer'));
create policy hr_docs_delete on storage.objects for delete to authenticated using (bucket_id = 'hr-docs' and public.has_role('hr_officer'));

-- ---------- daily document expiry alerts (30 / 15 / 7 days and on expiry) ----------
create or replace function public.hr_expiry_alerts() returns int
language plpgsql security definer set search_path = public as $$
declare d record; n int := 0;
begin
  for d in select * from v_document_expiry where days_left in (30, 15, 7, 0) loop
    perform notify('hr_officer', null, d.name || ': ' || replace(lower(d.doc_type), '_', ' ') || case when d.days_left = 0 then ' expires today' else ' expires in ' || d.days_left || ' days' end,
                   coalesce(d.doc_no, '') || ' · ' || to_char(d.expiry_date, 'DD Mon YYYY'), 'r/docexpiry', 'employee', d.employee_id);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.hr_expiry_alerts() from public, anon, authenticated;
select cron.schedule('hr-expiry-alerts', '0 4 * * *', $c$ select public.hr_expiry_alerts() $c$);

grant execute on function public.leave_action(uuid, text, text), public.advance_action(uuid, text), public.payroll_calculate(uuid),
  public.payroll_action(uuid, text, text), public.payroll_wps_sif(uuid), public.gratuity_calc(uuid, date), public.annual_leave_accrued(uuid, date),
  public.leave_days_in(uuid, date, date, text[]), public.is_hr() to authenticated;
revoke execute on function public.leave_action(uuid, text, text), public.advance_action(uuid, text), public.payroll_calculate(uuid),
  public.payroll_action(uuid, text, text), public.payroll_wps_sif(uuid), public.gratuity_calc(uuid, date), public.annual_leave_accrued(uuid, date),
  public.leave_days_in(uuid, date, date, text[]), public.is_hr() from anon;
