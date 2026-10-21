-- 041 Users customise their own dashboards: { home: <dashboard>, layouts: { <dashboard>: [section, ...] } }
-- Which dashboards a user may open stays with the administrator (profiles.dashboards); this only stores
-- the user's choice of landing dashboard and the sections / order on each.
alter table profiles add column dashboard_prefs jsonb;

create or replace function public.save_my_dashboard_prefs(p_prefs jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if p_prefs is not null and (jsonb_typeof(p_prefs) <> 'object' or length(p_prefs::text) > 8000) then raise exception 'Invalid dashboard settings'; end if;
  update profiles set dashboard_prefs = p_prefs where id = auth.uid();
end $$;
revoke execute on function public.save_my_dashboard_prefs(jsonb) from public, anon;
grant execute on function public.save_my_dashboard_prefs(jsonb) to authenticated;
