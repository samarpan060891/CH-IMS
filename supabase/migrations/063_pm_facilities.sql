-- 063 Preventive maintenance for building & facility assets
-- A PM schedule now targets a machine (work centre), a facility asset from the asset register (AC unit, compressor, fire
-- extinguisher…) or a building area from the FACILITY_AREA drop-down (roof, washrooms, fire system…). Facility PM is
-- calendar-only, books no machine stop, and charges its cost centre (MNT-FAC by default, ADM for the office); spares go
-- to that cost centre. Report: PM job costs (labour + spares issued) per machine / asset / area.

-- ---------- drop-down list of building areas (kept by FM / Production In-charge) ----------
alter table lookup_values drop constraint if exists lookup_values_list_key_check;
alter table lookup_values add constraint lookup_values_list_key_check
  check (list_key in ('DEPARTMENT','DESIGNATION','NATIONALITY','BANK','BRAND','UNIT_TYPE','ROOM','ACCOMMODATION','FACILITY_AREA'));
alter table master_requests drop constraint if exists master_requests_list_chk;
alter table master_requests add constraint master_requests_list_chk
  check (kind <> 'LOOKUP' or list_key in ('DEPARTMENT','DESIGNATION','NATIONALITY','BANK','BRAND','UNIT_TYPE','ROOM','ACCOMMODATION','FACILITY_AREA'));
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
                                   when 'UNIT_TYPE' then array['factory_manager']::app_role[]
                                   when 'ROOM' then array['factory_manager','production_incharge']::app_role[]
                                   when 'FACILITY_AREA' then array['factory_manager','production_incharge']::app_role[]
                                   else array['hr_officer']::app_role[] end
    else array['admin']::app_role[] end
$$;
insert into lookup_values (list_key, value, sort_order)
select 'FACILITY_AREA', v, n from unnest(array['Factory roof & structure','Factory floor','Washrooms','Fire safety system','Electrical distribution (DB / MDB)',
  'Lighting','Air conditioning & ventilation','Compressed air lines','Dust extraction ducting','Water tanks & plumbing','Yard, gates & fencing',
  'Office','Pantry','Labour camp']) with ordinality t(v, n)
on conflict (list_key, value) do nothing;

-- ---------- schedule & job targets ----------
alter table pm_schedules alter column work_center_id drop not null;
alter table pm_schedules
  add column target_kind text not null default 'MACHINE' check (target_kind in ('MACHINE', 'ASSET', 'AREA')),
  add column asset_id uuid references assets(id),
  add column facility_area text,
  add column cost_center_id uuid references cost_centers(id),
  add constraint pm_s_target check (
       (target_kind = 'MACHINE' and work_center_id is not null and asset_id is null and facility_area is null)
    or (target_kind = 'ASSET' and asset_id is not null and work_center_id is null and facility_area is null)
    or (target_kind = 'AREA' and facility_area is not null and work_center_id is null and asset_id is null)),
  add constraint pm_s_hours_machine check (every_hours is null or target_kind = 'MACHINE');

alter table pm_jobs alter column work_center_id drop not null;
alter table pm_jobs
  add column target_kind text not null default 'MACHINE' check (target_kind in ('MACHINE', 'ASSET', 'AREA')),
  add column asset_id uuid references assets(id),
  add column facility_area text,
  add column cost_center_id uuid references cost_centers(id);
update pm_jobs j set cost_center_id = (select id from cost_centers where code = 'MNT-MAC') where cost_center_id is null;
update pm_schedules set cost_center_id = (select id from cost_centers where code = 'MNT-MAC') where cost_center_id is null;
create index on pm_schedules (asset_id);
create index on pm_jobs (asset_id);

-- what the schedule / job is for, in words
create or replace function pm_target_label(p_wc uuid, p_asset uuid, p_area text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select code || ' — ' || name from work_centers where id = p_wc),
                  (select a.asset_tag || ' — ' || i.name from assets a join items i on i.id = a.item_id where a.id = p_asset),
                  p_area)
$$;
grant execute on function pm_target_label(uuid, uuid, text) to authenticated;

create or replace function trg_pm_schedule_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.target_kind = 'MACHINE' then
    new.cost_center_id := (select id from cost_centers where code = 'MNT-MAC');
    if new.last_done_hours is null or (tg_op = 'UPDATE' and new.work_center_id is distinct from old.work_center_id) then
      new.last_done_hours := wc_run_hours(new.work_center_id);
    end if;
  else
    new.every_hours := null; new.last_done_hours := null;
    if new.cost_center_id is null and new.asset_id is not null then
      new.cost_center_id := (select cost_center_id from assets where id = new.asset_id);
    end if;
    if new.cost_center_id is null then new.cost_center_id := (select id from cost_centers where code = 'MNT-FAC'); end if;
    if new.every_days is null then raise exception 'Building and facility PM runs on the calendar — enter every … days'; end if;
  end if;
  if new.every_days is not null and new.next_due is null then new.next_due := coalesce(new.last_done_date, current_date) + new.every_days; end if;
  if new.every_days is null then new.next_due := null; end if;
  if new.done_by = 'IN_HOUSE' then new.vendor_id := null; end if;
  return new;
end $$;

-- ---------- create a job: machine stop only for machines ----------
create or replace function pm_create_job_internal(p_schedule uuid, p_trigger text) returns uuid
language plpgsql security definer set search_path = public as $$
declare s pm_schedules; j uuid; v_no text; v_due date; v_start timestamptz; v_dt uuid; v_what text;
begin
  select * into s from pm_schedules where id = p_schedule;
  if s.id is null then raise exception 'PM schedule not found'; end if;
  if exists (select 1 from pm_jobs where schedule_id = s.id and status in ('OPEN', 'IN_PROGRESS')) then
    raise exception 'This schedule already has an open PM job';
  end if;
  v_due := case when p_trigger = 'CALENDAR' then s.next_due else current_date end;
  v_what := pm_target_label(s.work_center_id, s.asset_id, s.facility_area);

  perform set_config('app.pm_fn', '1', true);
  insert into pm_jobs (schedule_id, target_kind, work_center_id, asset_id, facility_area, cost_center_id, title, due_date, trigger_kind, run_hours, by_vendor, vendor_id)
  values (s.id, s.target_kind, s.work_center_id, s.asset_id, s.facility_area, s.cost_center_id, s.title, v_due, p_trigger,
          case when s.work_center_id is not null then wc_run_hours(s.work_center_id) end, s.done_by = 'VENDOR', s.vendor_id)
  returning id, pm_no into j, v_no;
  if s.work_center_id is not null then
    -- planned stop: 08:00 Dubai on the due date, or tomorrow if that is not in the future
    v_start := (greatest(v_due, current_date + 1)::timestamp + interval '8 hours') at time zone 'Asia/Dubai';
    insert into wc_downtime (work_center_id, kind, start_at, end_at, description)
    values (s.work_center_id, 'PREVENTIVE_MAINTENANCE', v_start, v_start + make_interval(mins => (s.stop_hours * 60)::int), 'PM ' || v_no || ': ' || s.title)
    returning id into v_dt;
    update pm_jobs set downtime_id = v_dt where id = j;
  end if;
  insert into pm_job_tasks (job_id, line_no, task) select j, row_number() over (order by line_no, id), task from pm_schedule_tasks where schedule_id = s.id;
  insert into pm_job_spares (job_id, line_no, item_id, qty) select j, row_number() over (order by line_no, id), item_id, qty from pm_schedule_spares where schedule_id = s.id;
  perform set_config('app.pm_fn', '', true);

  perform notify('production_incharge', null, 'PM due: ' || v_what, v_no || ' · ' || s.title || ' · due ' || to_char(v_due, 'DD Mon'), 'd/pm/' || j, 'pm', j);
  perform notify('factory_manager', null, 'PM due: ' || v_what, v_no || ' · ' || s.title || ' · due ' || to_char(v_due, 'DD Mon'), 'd/pm/' || j, 'pm', j);
  return j;
end $$;
revoke all on function pm_create_job_internal(uuid, text) from public, anon, authenticated;

create or replace function pm_start(p_job uuid) returns void
language plpgsql security definer set search_path = public as $$
declare j pm_jobs;
begin
  if not has_role('shop_floor', 'production_incharge', 'factory_manager', 'stores') then raise exception 'Not allowed'; end if;
  select * into j from pm_jobs where id = p_job for update;
  if j.status <> 'OPEN' then raise exception 'Only an open PM job can be started'; end if;
  perform set_config('app.pm_fn', '1', true);
  update pm_jobs set status = 'IN_PROGRESS', started_at = now() where id = p_job;
  if j.work_center_id is not null then
    -- the machine stops now: the planned window becomes an open stop
    update wc_downtime set start_at = now(), end_at = null where id = j.downtime_id and status <> 'CLOSED';
    if j.downtime_id is null or not found then
      insert into wc_downtime (work_center_id, kind, start_at, description)
      values (j.work_center_id, 'PREVENTIVE_MAINTENANCE', now(), 'PM ' || j.pm_no || ': ' || coalesce(j.title, ''))
      returning id into j.downtime_id;
      update pm_jobs set downtime_id = j.downtime_id where id = p_job;
    end if;
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
  v_cc := case when j.work_center_id is not null then (select id from cost_centers where code = 'MNT-MAC') else j.cost_center_id end;
  if v_cc is null then raise exception 'No cost centre for this PM job'; end if;
  insert into material_requests (purpose, cost_center_id, required_date, remarks, requested_by)
  values ('COST_CENTER', v_cc, greatest(j.due_date, current_date),
          'Spares for PM job ' || j.pm_no || ' — ' || pm_target_label(j.work_center_id, j.asset_id, j.facility_area), auth.uid())
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
declare j pm_jobs; s pm_schedules; v_open int; v_hrs numeric;
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
  -- machines: close the stop (started → ends now; never started → the actual hours up to now)
  update wc_downtime set start_at = case when j.started_at is null then now() - make_interval(mins => greatest((v_hrs * 60)::int, 1)) else start_at end,
         end_at = greatest(now(), start_at + interval '1 minute'), action_taken = coalesce(action_taken, 'PM ' || j.pm_no || ' done')
   where id = j.downtime_id;
  perform set_config('app.pm_fn', '', true);

  update pm_schedules set last_done_date = current_date,
         last_done_hours = case when work_center_id is not null then wc_run_hours(work_center_id) end,
         next_due = case when every_days is not null then current_date + every_days end
   where id = j.schedule_id;
  perform notify('factory_manager', null, 'PM done: ' || pm_target_label(j.work_center_id, j.asset_id, j.facility_area),
                 j.pm_no || ' · ' || coalesce(j.title, ''), 'd/pm/' || j.id, 'pm', j.id);
end $$;

-- ---------- due list: machines, assets and areas ----------
create or replace view v_pm_due with (security_invoker = true) as
select s.id, s.pm_code, s.title, s.status, s.work_center_id, w.code wc_code, w.name wc_name, s.every_days, s.every_hours, s.lead_days, s.stop_hours,
       s.done_by, v.name vendor_name, s.last_done_date, s.next_due,
       s.next_due - current_date days_left,
       case when s.work_center_id is not null then round(wc_run_hours(s.work_center_id) - coalesce(s.last_done_hours, 0), 1) end hours_run,
       case when s.every_hours is not null then round(s.every_hours - (wc_run_hours(s.work_center_id) - coalesce(s.last_done_hours, 0)), 1) end hours_left,
       case when s.work_center_id is not null then round(wc_run_hours(s.work_center_id, current_date - 30) / 30, 2) end hours_per_day,
       j.id job_id, j.pm_no job_no, j.status job_status, j.due_date job_due,
       case when j.id is not null then 'JOB_OPEN'
            when (s.next_due is not null and s.next_due < current_date)
              or (s.every_hours is not null and wc_run_hours(s.work_center_id) - coalesce(s.last_done_hours, 0) >= s.every_hours) then 'OVERDUE'
            when (s.next_due is not null and s.next_due - s.lead_days <= current_date)
              or (s.every_hours is not null and s.every_hours - (wc_run_hours(s.work_center_id) - coalesce(s.last_done_hours, 0))
                    <= wc_run_hours(s.work_center_id, current_date - 30) / 30 * s.lead_days) then 'DUE_SOON'
            else 'OK' end due_state,
       s.target_kind, pm_target_label(s.work_center_id, s.asset_id, s.facility_area) target_label, s.asset_id, s.facility_area,
       s.cost_center_id, c.code cc_code
  from pm_schedules s left join work_centers w on w.id = s.work_center_id
  left join cost_centers c on c.id = s.cost_center_id
  left join vendors v on v.id = s.vendor_id
  left join pm_jobs j on j.schedule_id = s.id and j.status in ('OPEN', 'IN_PROGRESS');

-- ---------- PM job costs: labour + spares issued against the job's request ----------
create or replace view v_pm_job_costs with (security_invoker = true) as
select j.id, j.pm_no, j.title, j.status, j.target_kind, pm_target_label(j.work_center_id, j.asset_id, j.facility_area) target_label,
       j.work_center_id, j.asset_id, j.facility_area, c.code cc_code, c.name cc_name, j.due_date, j.completed_at,
       date_trunc('month', coalesce(j.completed_at, j.due_date::timestamptz))::date period_month,
       j.by_vendor, v.name vendor_name, j.service_report,
       coalesce(l.hours, 0) labour_hours, coalesce(l.cost, 0) labour_cost, coalesce(sp.value, 0) spares_value,
       coalesce(l.cost, 0) + coalesce(sp.value, 0) total_cost
  from pm_jobs j
  left join cost_centers c on c.id = j.cost_center_id
  left join vendors v on v.id = j.vendor_id
  left join lateral (select sum(hours) hours, sum(cost) cost from pm_job_labour where job_id = j.id) l on true
  left join lateral (select sum(il.value) - coalesce(sum(rl.value), 0) value
                       from material_issues mi join issue_lines il on il.issue_id = mi.id
                       left join lateral (select sum(r.value) value from return_lines r join material_returns rt on rt.id = r.return_id
                                           where r.issue_line_id = il.id and rt.status = 'POSTED') rl on true
                      where mi.mr_id = j.mr_id and mi.status = 'POSTED') sp on true;
