-- 062 Preventive maintenance (PM)
-- A schedule per machine falls due every N days and/or every N running hours (machine hours logged on production orders and
-- job-work orders), whichever comes first. A few days ahead a PM job is created with its task checklist and spares list, and a
-- planned stop (wc_downtime PREVENTIVE_MAINTENANCE) is booked so load & availability see it. The team ticks tasks, logs who did
-- it and the hours (costed at the worker's grade rate), raises the spares request to MNT-MAC for the machine, or marks it as an
-- AMC / vendor visit. The Production In-charge (or FM) closes the job; the schedule rolls forward.

-- ---------- running hours of a machine ----------
create or replace function wc_run_hours(p_wc uuid, p_from date default null) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select sum(t.machine_hours) from wo_time_logs t join wo_operations o on o.id = t.operation_id
                    where o.work_center_id = p_wc and (p_from is null or t.log_date >= p_from)), 0)
       + coalesce((select sum(j.machine_hours) from so_job_logs j join sales_order_lines l on l.id = j.so_line_id
                    where l.work_center_id = p_wc and (p_from is null or j.log_date >= p_from)), 0)
$$;
grant execute on function wc_run_hours(uuid, date) to authenticated;

-- ---------- schedules ----------
create table pm_schedules (
  id uuid primary key default gen_random_uuid(),
  pm_code text not null unique default next_doc_no('PMS'),
  title text not null,
  work_center_id uuid not null references work_centers(id),
  every_days int check (every_days > 0),
  every_hours numeric check (every_hours > 0),
  next_due date,                                   -- calendar schedules: the next due date
  lead_days int not null default 3 check (lead_days between 0 and 30),
  stop_hours numeric not null default 2 check (stop_hours > 0),
  done_by text not null default 'IN_HOUSE' check (done_by in ('IN_HOUSE', 'VENDOR')),
  vendor_id uuid references vendors(id),
  last_done_date date,
  last_done_hours numeric,                         -- running-hours counter when last done (baseline for hour schedules)
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'PAUSED')),
  remarks text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  check (every_days is not null or every_hours is not null),
  check (done_by = 'IN_HOUSE' or vendor_id is not null)
);
create table pm_schedule_tasks (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references pm_schedules(id) on delete cascade,
  line_no int, task text not null
);
create table pm_schedule_spares (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references pm_schedules(id) on delete cascade,
  line_no int, item_id uuid not null references items(id), qty numeric not null check (qty > 0)
);
create index on pm_schedule_tasks (schedule_id);
create index on pm_schedule_spares (schedule_id);

create or replace function trg_pm_schedule_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.last_done_hours is null or (tg_op = 'UPDATE' and new.work_center_id <> old.work_center_id) then
    new.last_done_hours := wc_run_hours(new.work_center_id);
  end if;
  if new.every_days is not null and new.next_due is null then new.next_due := coalesce(new.last_done_date, current_date) + new.every_days; end if;
  if new.every_days is null then new.next_due := null; end if;
  if new.done_by = 'IN_HOUSE' then new.vendor_id := null; end if;
  return new;
end $$;
create trigger pm_schedule_defaults before insert or update on pm_schedules for each row execute function trg_pm_schedule_defaults();

-- ---------- jobs ----------
create table pm_jobs (
  id uuid primary key default gen_random_uuid(),
  pm_no text not null unique default next_doc_no('PM'),
  job_date date not null default current_date,
  schedule_id uuid not null references pm_schedules(id),
  work_center_id uuid not null references work_centers(id),
  title text,
  due_date date not null,
  trigger_kind text not null check (trigger_kind in ('CALENDAR', 'HOURS', 'MANUAL')),
  run_hours numeric,                               -- machine running hours when the job was raised
  status text not null default 'OPEN' check (status in ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED')),
  downtime_id uuid references wc_downtime(id) on delete set null,
  mr_id uuid references material_requests(id) on delete set null,
  by_vendor boolean not null default false,
  vendor_id uuid references vendors(id),
  service_report text,                             -- vendor's service report no. / link
  started_at timestamptz, completed_at timestamptz,
  remarks text,
  closed_by uuid,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create unique index pm_jobs_one_open on pm_jobs (schedule_id) where status in ('OPEN', 'IN_PROGRESS');
create table pm_job_tasks (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references pm_jobs(id) on delete cascade,
  line_no int, task text not null, done boolean not null default false, remarks text
);
create table pm_job_spares (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references pm_jobs(id) on delete cascade,
  line_no int, item_id uuid not null references items(id), qty numeric not null check (qty > 0)
);
create table pm_job_labour (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references pm_jobs(id) on delete cascade,
  line_no int, employee_id uuid not null references employees(id),
  hours numeric not null check (hours > 0),
  rate numeric,
  cost numeric generated always as (round(hours * coalesce(rate, 0), 2)) stored
);
create index on pm_job_tasks (job_id);
create index on pm_job_spares (job_id);
create index on pm_job_labour (job_id);

-- status and links change only through the pm_* functions
create or replace function trg_pm_job_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('app.pm_fn', true), '') <> '1' and
     (new.status is distinct from old.status or new.downtime_id is distinct from old.downtime_id or new.mr_id is distinct from old.mr_id
      or new.schedule_id is distinct from old.schedule_id or new.work_center_id is distinct from old.work_center_id
      or new.completed_at is distinct from old.completed_at or new.started_at is distinct from old.started_at) then
    raise exception 'Use the buttons on the PM job to start, complete or cancel it';
  end if;
  if not new.by_vendor then new.vendor_id := null; end if;
  return new;
end $$;
create trigger pm_job_guard before update on pm_jobs for each row execute function trg_pm_job_guard();

-- labour rate from the worker's grade
create or replace function trg_pm_labour_rate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.employee_id <> old.employee_id or new.rate is null then
    new.rate := (select g.rate_per_hour from employees e join labour_grades g on g.id = e.grade_id where e.id = new.employee_id);
  end if;
  return new;
end $$;
create trigger pm_labour_rate before insert or update on pm_job_labour for each row execute function trg_pm_labour_rate();

create or replace function pm_job_editable(p_job uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from pm_jobs where id = p_job and status in ('OPEN', 'IN_PROGRESS'))
$$;

-- ---------- create a job (internal) ----------
create or replace function pm_create_job_internal(p_schedule uuid, p_trigger text) returns uuid
language plpgsql security definer set search_path = public as $$
declare s pm_schedules; j uuid; v_no text; v_due date; v_start timestamptz; v_dt uuid; v_wc text;
begin
  select * into s from pm_schedules where id = p_schedule;
  if s.id is null then raise exception 'PM schedule not found'; end if;
  if exists (select 1 from pm_jobs where schedule_id = s.id and status in ('OPEN', 'IN_PROGRESS')) then
    raise exception 'This schedule already has an open PM job';
  end if;
  v_due := case when p_trigger = 'CALENDAR' then s.next_due else current_date end;
  -- planned stop: 08:00 Dubai on the due date, or tomorrow if that is not in the future
  v_start := (greatest(v_due, current_date + 1)::timestamp + interval '8 hours') at time zone 'Asia/Dubai';
  select code || ' — ' || name into v_wc from work_centers where id = s.work_center_id;

  perform set_config('app.pm_fn', '1', true);
  insert into pm_jobs (schedule_id, work_center_id, title, due_date, trigger_kind, run_hours, by_vendor, vendor_id)
  values (s.id, s.work_center_id, s.title, v_due, p_trigger, wc_run_hours(s.work_center_id), s.done_by = 'VENDOR', s.vendor_id)
  returning id, pm_no into j, v_no;
  insert into wc_downtime (work_center_id, kind, start_at, end_at, description)
  values (s.work_center_id, 'PREVENTIVE_MAINTENANCE', v_start, v_start + make_interval(mins => (s.stop_hours * 60)::int), 'PM ' || v_no || ': ' || s.title)
  returning id into v_dt;
  update pm_jobs set downtime_id = v_dt where id = j;
  insert into pm_job_tasks (job_id, line_no, task) select j, row_number() over (order by line_no, id), task from pm_schedule_tasks where schedule_id = s.id;
  insert into pm_job_spares (job_id, line_no, item_id, qty) select j, row_number() over (order by line_no, id), item_id, qty from pm_schedule_spares where schedule_id = s.id;
  perform set_config('app.pm_fn', '', true);

  perform notify('production_incharge', null, 'PM due: ' || v_wc, v_no || ' · ' || s.title || ' · due ' || to_char(v_due, 'DD Mon'), 'd/pm/' || j, 'pm', j);
  perform notify('factory_manager', null, 'PM due: ' || v_wc, v_no || ' · ' || s.title || ' · due ' || to_char(v_due, 'DD Mon'), 'd/pm/' || j, 'pm', j);
  return j;
end $$;
revoke all on function pm_create_job_internal(uuid, text) from public, anon, authenticated;

-- "Create PM job now" from a schedule
create or replace function pm_job_new(p_schedule uuid) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  if not has_role('production_incharge', 'factory_manager') then raise exception 'Only the Production In-charge or Factory Manager can raise a PM job'; end if;
  return pm_create_job_internal(p_schedule, 'MANUAL');
end $$;

-- ---------- due list ----------
create or replace view v_pm_due with (security_invoker = true) as
select s.id, s.pm_code, s.title, s.status, s.work_center_id, w.code wc_code, w.name wc_name, s.every_days, s.every_hours, s.lead_days, s.stop_hours,
       s.done_by, v.name vendor_name, s.last_done_date, s.next_due,
       s.next_due - current_date days_left,
       round(wc_run_hours(s.work_center_id) - coalesce(s.last_done_hours, 0), 1) hours_run,
       case when s.every_hours is not null then round(s.every_hours - (wc_run_hours(s.work_center_id) - coalesce(s.last_done_hours, 0)), 1) end hours_left,
       round(wc_run_hours(s.work_center_id, current_date - 30) / 30, 2) hours_per_day,
       j.id job_id, j.pm_no job_no, j.status job_status, j.due_date job_due,
       case when j.id is not null then 'JOB_OPEN'
            when (s.next_due is not null and s.next_due < current_date)
              or (s.every_hours is not null and wc_run_hours(s.work_center_id) - coalesce(s.last_done_hours, 0) >= s.every_hours) then 'OVERDUE'
            when (s.next_due is not null and s.next_due - s.lead_days <= current_date)
              or (s.every_hours is not null and s.every_hours - (wc_run_hours(s.work_center_id) - coalesce(s.last_done_hours, 0))
                    <= wc_run_hours(s.work_center_id, current_date - 30) / 30 * s.lead_days) then 'DUE_SOON'
            else 'OK' end due_state
  from pm_schedules s join work_centers w on w.id = s.work_center_id
  left join vendors v on v.id = s.vendor_id
  left join pm_jobs j on j.schedule_id = s.id and j.status in ('OPEN', 'IN_PROGRESS');

-- ---------- daily generator (cron, or PI / FM "check now") ----------
create or replace function pm_generate() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if auth.uid() is not null and not has_role('production_incharge', 'factory_manager') then raise exception 'Not allowed'; end if;
  for r in
    select s.id, case when s.next_due is not null and s.next_due - s.lead_days <= current_date then 'CALENDAR' else 'HOURS' end trig
      from pm_schedules s
     where s.status = 'ACTIVE'
       and not exists (select 1 from pm_jobs j where j.schedule_id = s.id and j.status in ('OPEN', 'IN_PROGRESS'))
       and ((s.next_due is not null and s.next_due - s.lead_days <= current_date)
            or (s.every_hours is not null and s.every_hours - (wc_run_hours(s.work_center_id) - coalesce(s.last_done_hours, 0))
                  <= wc_run_hours(s.work_center_id, current_date - 30) / 30 * s.lead_days))
  loop
    perform pm_create_job_internal(r.id, r.trig);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- start / spares / complete / cancel ----------
create or replace function pm_start(p_job uuid) returns void
language plpgsql security definer set search_path = public as $$
declare j pm_jobs;
begin
  if not has_role('shop_floor', 'production_incharge', 'factory_manager', 'stores') then raise exception 'Not allowed'; end if;
  select * into j from pm_jobs where id = p_job for update;
  if j.status <> 'OPEN' then raise exception 'Only an open PM job can be started'; end if;
  perform set_config('app.pm_fn', '1', true);
  update pm_jobs set status = 'IN_PROGRESS', started_at = now() where id = p_job;
  -- the machine stops now: the planned window becomes an open stop
  update wc_downtime set start_at = now(), end_at = null where id = j.downtime_id and status <> 'CLOSED';
  if j.downtime_id is null or not found then
    insert into wc_downtime (work_center_id, kind, start_at, description)
    values (j.work_center_id, 'PREVENTIVE_MAINTENANCE', now(), 'PM ' || j.pm_no || ': ' || coalesce(j.title, ''))
    returning id into j.downtime_id;
    update pm_jobs set downtime_id = j.downtime_id where id = p_job;
  end if;
  perform set_config('app.pm_fn', '', true);
end $$;

create or replace function pm_request_spares(p_job uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare j pm_jobs; v_cc uuid; v_mr uuid;
begin
  if not has_role('shop_floor', 'production_incharge', 'factory_manager', 'stores') then raise exception 'Not allowed'; end if;
  select * into j from pm_jobs where id = p_job for update;
  if j.status not in ('OPEN', 'IN_PROGRESS') then raise exception 'The PM job is closed'; end if;
  if j.mr_id is not null and exists (select 1 from material_requests where id = j.mr_id and status not in ('CANCELLED', 'REJECTED')) then
    raise exception 'Spares were already requested on this job';
  end if;
  if not exists (select 1 from pm_job_spares where job_id = p_job) then raise exception 'Add the spares needed first'; end if;
  select id into v_cc from cost_centers where code = 'MNT-MAC';
  if v_cc is null then raise exception 'Cost centre MNT-MAC (Maintenance — machines) is missing'; end if;
  insert into material_requests (purpose, cost_center_id, required_date, remarks, requested_by)
  values ('COST_CENTER', v_cc, greatest(j.due_date, current_date), 'Spares for PM job ' || j.pm_no || ' — ' || coalesce(j.title, ''), auth.uid())
  returning id into v_mr;
  insert into mr_lines (mr_id, line_no, item_id, requested_qty, work_center_id, remarks)
  select v_mr, row_number() over (order by line_no, id), item_id, qty, j.work_center_id, 'PM ' || j.pm_no from pm_job_spares where job_id = p_job;
  perform set_config('app.pm_fn', '1', true);
  update pm_jobs set mr_id = v_mr where id = p_job;
  perform set_config('app.pm_fn', '', true);
  return v_mr;
end $$;

create or replace function pm_complete(p_job uuid, p_remarks text default null) returns void
language plpgsql security definer set search_path = public as $$
declare j pm_jobs; s pm_schedules; v_open int; v_hrs numeric; v_wc text;
begin
  if not has_role('production_incharge', 'factory_manager') then raise exception 'Only the Production In-charge or Factory Manager can close a PM job'; end if;
  select * into j from pm_jobs where id = p_job for update;
  if j.status not in ('OPEN', 'IN_PROGRESS') then raise exception 'This PM job is already closed'; end if;
  select count(*) into v_open from pm_job_tasks where job_id = p_job and not done;
  if v_open > 0 then raise exception '% checklist task(s) are not ticked yet', v_open; end if;
  if j.by_vendor and j.vendor_id is null then raise exception 'Select the AMC / service vendor'; end if;
  if not j.by_vendor and not exists (select 1 from pm_job_labour where job_id = p_job) then raise exception 'Enter who did the work and the hours'; end if;
  select * into s from pm_schedules where id = j.schedule_id;
  select coalesce(max(hours), s.stop_hours) into v_hrs from pm_job_labour where job_id = p_job;

  perform set_config('app.pm_fn', '1', true);
  update pm_jobs set status = 'DONE', completed_at = now(), closed_by = auth.uid(),
         remarks = coalesce(nullif(p_remarks, ''), remarks) where id = p_job;
  -- close the stop: started → ends now; never started → the actual hours up to now
  update wc_downtime set start_at = case when j.started_at is null then now() - make_interval(mins => greatest((v_hrs * 60)::int, 1)) else start_at end,
         end_at = greatest(now(), start_at + interval '1 minute'), action_taken = coalesce(action_taken, 'PM ' || j.pm_no || ' done')
   where id = j.downtime_id;
  perform set_config('app.pm_fn', '', true);

  update pm_schedules set last_done_date = current_date, last_done_hours = wc_run_hours(j.work_center_id),
         next_due = case when every_days is not null then current_date + every_days end
   where id = j.schedule_id;
  select code || ' — ' || name into v_wc from work_centers where id = j.work_center_id;
  perform notify('factory_manager', null, 'PM done: ' || v_wc, j.pm_no || ' · ' || coalesce(j.title, ''), 'd/pm/' || j.id, 'pm', j.id);
end $$;

create or replace function pm_cancel(p_job uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare j pm_jobs;
begin
  if not has_role('production_incharge', 'factory_manager') then raise exception 'Not allowed'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason'; end if;
  select * into j from pm_jobs where id = p_job for update;
  if j.status not in ('OPEN', 'IN_PROGRESS') then raise exception 'This PM job is already closed'; end if;
  perform set_config('app.pm_fn', '1', true);
  update pm_jobs set status = 'CANCELLED', completed_at = now(), closed_by = auth.uid(),
         remarks = trim(coalesce(remarks || E'\n', '') || 'Cancelled: ' || p_reason) where id = p_job;
  delete from wc_downtime where id = j.downtime_id and status = 'PLANNED';
  update wc_downtime set end_at = now() where id = j.downtime_id and status = 'OPEN';
  perform set_config('app.pm_fn', '', true);
  -- skip this cycle: the schedule rolls on to the next one
  update pm_schedules set next_due = case when every_days is not null then greatest(next_due, current_date) + every_days end,
         last_done_hours = case when every_hours is not null then wc_run_hours(work_center_id) else last_done_hours end
   where id = j.schedule_id;
end $$;

grant execute on function pm_job_new(uuid), pm_generate(), pm_start(uuid), pm_request_spares(uuid), pm_complete(uuid, text), pm_cancel(uuid, text) to authenticated;

-- ---------- RLS ----------
alter table pm_schedules enable row level security;
alter table pm_schedule_tasks enable row level security;
alter table pm_schedule_spares enable row level security;
alter table pm_jobs enable row level security;
alter table pm_job_tasks enable row level security;
alter table pm_job_spares enable row level security;
alter table pm_job_labour enable row level security;

create policy read_active on pm_schedules for select using (is_active_user());
create policy pm_s_write on pm_schedules for all using (has_role('production_incharge', 'factory_manager')) with check (has_role('production_incharge', 'factory_manager'));
create policy read_active on pm_schedule_tasks for select using (is_active_user());
create policy pm_st_write on pm_schedule_tasks for all using (has_role('production_incharge', 'factory_manager')) with check (has_role('production_incharge', 'factory_manager'));
create policy read_active on pm_schedule_spares for select using (is_active_user());
create policy pm_ss_write on pm_schedule_spares for all using (has_role('production_incharge', 'factory_manager')) with check (has_role('production_incharge', 'factory_manager'));

create policy read_active on pm_jobs for select using (is_active_user());
create policy pm_j_update on pm_jobs for update using (has_role('shop_floor', 'production_incharge', 'factory_manager', 'stores') and status in ('OPEN', 'IN_PROGRESS'))
  with check (has_role('shop_floor', 'production_incharge', 'factory_manager', 'stores'));
create policy read_active on pm_job_tasks for select using (is_active_user());
create policy pm_jt_write on pm_job_tasks for all using (has_role('shop_floor', 'production_incharge', 'factory_manager', 'stores') and pm_job_editable(job_id))
  with check (has_role('shop_floor', 'production_incharge', 'factory_manager', 'stores') and pm_job_editable(job_id));
create policy read_active on pm_job_spares for select using (is_active_user());
create policy pm_js_write on pm_job_spares for all using (has_role('shop_floor', 'production_incharge', 'factory_manager', 'stores') and pm_job_editable(job_id))
  with check (has_role('shop_floor', 'production_incharge', 'factory_manager', 'stores') and pm_job_editable(job_id));
create policy read_active on pm_job_labour for select using (is_active_user());
create policy pm_jl_write on pm_job_labour for all using (has_role('shop_floor', 'production_incharge', 'factory_manager', 'stores') and pm_job_editable(job_id))
  with check (has_role('shop_floor', 'production_incharge', 'factory_manager', 'stores') and pm_job_editable(job_id));

-- ---------- maintenance cost report: breakdowns vs PM, in-house PM labour ----------
drop view if exists v_machine_maintenance;
create view v_machine_maintenance with (security_invoker = true) as
with d as (select work_center_id wc, date_trunc('month', start_at)::date m,
                  count(*) filter (where kind = 'BREAKDOWN') breakdowns,
                  round(sum(extract(epoch from (coalesce(end_at, now()) - start_at)) / 3600) filter (where kind = 'BREAKDOWN')::numeric, 1) down_hours,
                  round(sum(extract(epoch from (coalesce(end_at, now()) - start_at)) / 3600) filter (where kind = 'PREVENTIVE_MAINTENANCE')::numeric, 1) pm_hours,
                  coalesce(sum(repair_cost), 0) repairs
             from wc_downtime where start_at <= now() group by 1, 2),
     p as (select j.work_center_id wc, date_trunc('month', j.completed_at)::date m, count(distinct j.id) pm_done, coalesce(sum(l.cost), 0) pm_labour
             from pm_jobs j left join pm_job_labour l on l.job_id = j.id where j.status = 'DONE' group by 1, 2),
     e as (select l.work_center_id wc, date_trunc('month', x.exp_date)::date m, sum(l.amount) bills
             from expense_lines l join expenses x on x.id = l.expense_id
            where l.work_center_id is not null and x.status in ('POSTED','REIMBURSED') group by 1, 2),
     s as (select il.work_center_id wc, date_trunc('month', h.issue_date)::date m, sum(il.value) spares
             from issue_lines il join material_issues h on h.id = il.issue_id
            where il.work_center_id is not null and h.status = 'POSTED' group by 1, 2),
     r as (select i2.work_center_id wc, date_trunc('month', rt.return_date)::date m, sum(rl.value) returned
             from return_lines rl join material_returns rt on rt.id = rl.return_id join issue_lines i2 on i2.id = rl.issue_line_id
            where i2.work_center_id is not null and rt.status = 'POSTED' group by 1, 2),
     k as (select wc, m from d union select wc, m from p union select wc, m from e union select wc, m from s union select wc, m from r)
select k.m period_month, w.id work_center_id, w.code, w.name, w.kind,
       coalesce(d.breakdowns, 0) breakdowns, coalesce(d.down_hours, 0) down_hours, coalesce(p.pm_done, 0) pm_done, coalesce(d.pm_hours, 0) pm_hours,
       coalesce(d.repairs, 0) breakdown_repairs, coalesce(p.pm_labour, 0) pm_labour,
       coalesce(e.bills, 0) bills_amc, coalesce(s.spares, 0) - coalesce(r.returned, 0) store_spares,
       coalesce(d.repairs, 0) + coalesce(p.pm_labour, 0) + coalesce(e.bills, 0) + coalesce(s.spares, 0) - coalesce(r.returned, 0) total_cost
  from k join work_centers w on w.id = k.wc
  left join d on d.wc = k.wc and d.m = k.m left join p on p.wc = k.wc and p.m = k.m left join e on e.wc = k.wc and e.m = k.m
  left join s on s.wc = k.wc and s.m = k.m left join r on r.wc = k.wc and r.m = k.m;

-- daily at 07:00 Dubai
select cron.schedule('pm-generate', '0 3 * * *', $$select pm_generate()$$);
