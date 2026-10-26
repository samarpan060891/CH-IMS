-- 100: performance advisor fixes
-- 1) RLS policies evaluate auth.uid() once per query instead of once per row: auth.uid() → (select auth.uid())
do $$ declare p record; q text; c text; begin
  for p in select tablename, policyname, qual, with_check from pg_policies
            where schemaname = 'public' and (coalesce(qual, '') || coalesce(with_check, '')) ~ 'auth\.uid\(\)'
              and (coalesce(qual, '') || coalesce(with_check, '')) !~* 'select auth\.uid\(\)' loop
    q := regexp_replace(p.qual, 'auth\.uid\(\)', '(select auth.uid())', 'g');
    c := regexp_replace(p.with_check, 'auth\.uid\(\)', '(select auth.uid())', 'g');
    execute format('alter policy %I on public.%I', p.policyname, p.tablename)
         || case when q is not null then format(' using (%s)', q) else '' end
         || case when c is not null then format(' with check (%s)', c) else '' end;
  end loop;
end $$;

-- 2) indexes on foreign keys used for joins / filters (line → header, item, project, location, lot, order ...).
--    Audit columns (*_by), journal links, lookup masters (uom, grade, account, payment term) and rarely searched
--    back-references are left unindexed to keep saves cheap.
do $$ declare f record; begin
  for f in select c.conrelid::regclass tbl, cl.relname tname, a.attname col
             from pg_constraint c
             join pg_class cl on cl.oid = c.conrelid
             join pg_namespace n on n.oid = c.connamespace
             join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
            where c.contype = 'f' and n.nspname = 'public' and array_length(c.conkey, 1) = 1
              and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])
              and a.attname !~ '(_by|je_id|payment_term_id|grade_id|account_id|uom_id|currency_id)$'
              and a.attname not in ('auth_sign_user_id', 'credit_of', 'reversal_of', 'revised_from', 'received_by_employee_id',
                                    'default_location_id', 'edge_item_id', 'scrap_item_id', 'awarded_vendor_id', 'custodian_employee_id', 'custodian_id') loop
    execute format('create index if not exists %I on %s (%I)', left(f.tname || '_' || f.col || '_fk', 63), f.tbl, f.col);
  end loop;
end $$;
