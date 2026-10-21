-- 046 "Count app" (phone screen for physical stock counts) can be given to users as a dashboard / landing screen
alter table profiles drop constraint profiles_dashboards_check;
alter table profiles add constraint profiles_dashboards_check
  check (dashboards is null or dashboards <@ array['management','finance','purchase','stores','production','hr','site','floor','approvals','counting']::text[]);
