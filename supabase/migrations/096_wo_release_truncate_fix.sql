-- 096 Fix: Release to floor failed with "DELETE requires a WHERE clause" — the database refuses DELETE without WHERE
-- (safe-update rule), even on wo_release's temporary work table. It is now emptied with TRUNCATE.
do $$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p where p.proname = 'wo_release' and p.pronamespace = 'public'::regnamespace;
  execute replace(d, 'delete from _need;', 'truncate _need;');
end $$;