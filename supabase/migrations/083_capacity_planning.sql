-- 083 Capacity basis for estimated completion dates of production batches.
--   · planning day: 8 hours per machine / per person, planned at 85 % of that (6.8 effective hours); weekly off day(s)
--   · crew size per work centre: machines in parallel (machine centres) or people (manual centres such as Assembly);
--     manual centres are filled from their existing daily hours (hours per day ÷ 9 h ÷ 85 %)
alter table company_settings
  add column if not exists plan_hours_per_day numeric not null default 8,
  add column if not exists plan_efficiency_pct numeric not null default 85,
  add column if not exists plan_week_off int[] not null default '{0}';   -- 0 = Sunday (weekly off) … 6 = Saturday
alter table work_centers add column if not exists crew_size int not null default 1;
alter table work_centers drop constraint if exists work_centers_crew_size_check;
alter table work_centers add constraint work_centers_crew_size_check check (crew_size >= 1);
update work_centers set crew_size = greatest(1, round(hours_per_day / (9 * 0.85)))::int where kind = 'MANUAL' and crew_size = 1;
