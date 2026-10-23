-- 072 Timber requested and issued in pieces as well as CBM: the line names the batch (size), the pieces are stored,
-- and the CBM quantity is pieces ÷ pieces-per-CBM of that batch.
alter table mr_lines add column if not exists pcs numeric;
alter table issue_lines add column if not exists pcs numeric;
