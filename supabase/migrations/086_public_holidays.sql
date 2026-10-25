-- 086 Public holidays: skipped by the production planning calendar (with the weekly off day).
-- UAE holidays 2026–2027 loaded; Islamic holidays follow the moon sighting, so their dates are the expected ones —
-- correct them when the government announces the official dates.
create table if not exists public_holidays (
  id uuid primary key default gen_random_uuid(),
  holiday_date date not null unique,
  name text not null,
  confirmed boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public_holidays enable row level security;
drop policy if exists read_active on public_holidays;
create policy read_active on public_holidays for select using (is_active_user());
drop policy if exists write_roles on public_holidays;
create policy write_roles on public_holidays for all using (has_role('factory_manager', 'hr_officer')) with check (has_role('factory_manager', 'hr_officer'));

insert into public_holidays (holiday_date, name, confirmed) values
  ('2026-01-01', 'New Year''s Day', true),
  ('2026-03-20', 'Eid al-Fitr (expected)', false),
  ('2026-03-21', 'Eid al-Fitr (expected)', false),
  ('2026-03-22', 'Eid al-Fitr (expected)', false),
  ('2026-05-26', 'Arafat Day (expected)', false),
  ('2026-05-27', 'Eid al-Adha (expected)', false),
  ('2026-05-28', 'Eid al-Adha (expected)', false),
  ('2026-05-29', 'Eid al-Adha (expected)', false),
  ('2026-06-16', 'Islamic New Year (expected)', false),
  ('2026-08-25', 'Prophet Muhammad''s Birthday (expected)', false),
  ('2026-12-01', 'Commemoration Day', true),
  ('2026-12-02', 'National Day', true),
  ('2026-12-03', 'National Day', true),
  ('2027-01-01', 'New Year''s Day', true),
  ('2027-03-09', 'Eid al-Fitr (expected)', false),
  ('2027-03-10', 'Eid al-Fitr (expected)', false),
  ('2027-03-11', 'Eid al-Fitr (expected)', false),
  ('2027-05-15', 'Arafat Day (expected)', false),
  ('2027-05-16', 'Eid al-Adha (expected)', false),
  ('2027-05-17', 'Eid al-Adha (expected)', false),
  ('2027-05-18', 'Eid al-Adha (expected)', false),
  ('2027-06-06', 'Islamic New Year (expected)', false),
  ('2027-08-15', 'Prophet Muhammad''s Birthday (expected)', false),
  ('2027-12-01', 'Commemoration Day', true),
  ('2027-12-02', 'National Day', true),
  ('2027-12-03', 'National Day', true)
on conflict (holiday_date) do nothing;
