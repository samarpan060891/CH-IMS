-- 099: hardening from the Supabase security advisor
-- 1) SECURITY DEFINER functions are callable by logged-in users only (not anon). They reached anon through the
--    built-in EXECUTE-to-PUBLIC grant; logged-in access is kept by granting authenticated explicitly first.
do $$ declare f record; begin
  for f in select p.oid::regprocedure sig, has_function_privilege('authenticated', p.oid, 'execute') auth
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')
              and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') loop
    if f.auth then execute format('grant execute on function %s to authenticated, service_role', f.sig); end if;
    execute format('revoke execute on function %s from public, anon', f.sig);
  end loop;
end $$;
-- new functions no longer get EXECUTE for PUBLIC (the public-schema default still grants authenticated + service_role)
alter default privileges for role postgres revoke execute on functions from public;

-- 2) fixed search_path on the functions that did not set one
do $$ declare f record; begin
  for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('gl_stock_counter', 'trg_gl_account_sort', 'trg_gl_account_guard', 'prov_band_pct',
                  'trg_sales_hdr_vat', 'so_line_billable', 'trg_issue_line_machine', 'master_owner_roles', 'doc_ref_norm', 'si_stores_type')
              and p.proconfig is null loop
    execute format('alter function %s set search_path = public', f.sig);
  end loop;
end $$;
