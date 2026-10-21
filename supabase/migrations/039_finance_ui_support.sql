-- 039 Finance UI support: account order follows its code; Finance may maintain project billing terms

create or replace function public.trg_gl_account_sort() returns trigger
language plpgsql as $$
begin
  new.sort_order := coalesce(nullif(regexp_replace(left(new.code, 4), '\D', '', 'g'), '')::int, 0);
  return new;
end $$;
create trigger gl_account_sort before insert or update of code on gl_accounts for each row execute function trg_gl_account_sort();

drop policy write_roles on projects;
create policy write_roles on projects for all to authenticated
  using (public.has_role('factory_manager','production_incharge','finance'))
  with check (public.has_role('factory_manager','production_incharge','finance'));

-- system accounts cannot be deleted (automatic postings depend on them)
create or replace function public.trg_gl_account_guard() returns trigger
language plpgsql as $$
begin
  if old.system_key is not null then raise exception 'Account % is used by automatic postings and cannot be deleted', old.code; end if;
  return old;
end $$;
create trigger gl_account_guard before delete on gl_accounts for each row execute function trg_gl_account_guard();
