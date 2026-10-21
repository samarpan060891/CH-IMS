-- 040 Dashboards per user: the administrator picks which dashboards a user sees (null = the dashboard of the user's role)
alter table profiles add column dashboards text[];
alter table profiles add constraint profiles_dashboards_check
  check (dashboards is null or dashboards <@ array['management','finance','purchase','stores','production','hr','site']::text[]);
