-- 044 "Floor app" (phone screen for material requests) can be given to users as a dashboard
alter table profiles drop constraint profiles_dashboards_check;
alter table profiles add constraint profiles_dashboards_check
  check (dashboards is null or dashboards <@ array['management','finance','purchase','stores','production','hr','site','floor']::text[]);
