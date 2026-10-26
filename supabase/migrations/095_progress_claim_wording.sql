-- 095 Wording: customer claims are "progress claims" (employee expense claims keep their name). The cash forecast's
-- inflow category for site work not yet billed is renamed to match.
do $$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p where p.proname = 'cash_forecast_internal' and p.pronamespace = 'public'::regnamespace;
  execute replace(d, 'Project claims (work done, not billed)', 'Project progress claims (work done, not billed)');
end $$;
