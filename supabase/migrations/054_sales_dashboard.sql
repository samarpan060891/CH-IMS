-- 054 Sales dashboard can be granted to users
alter table profiles drop constraint profiles_dashboards_check;
alter table profiles add constraint profiles_dashboards_check check (dashboards is null or dashboards <@ array['management','finance','purchase','stores','production','hr','site','floor','approvals','counting','receiving','sales']);
