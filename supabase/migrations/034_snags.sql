-- =====================================================================
-- CitiCore - 034 Snag list per unit
--   raise (with photos) -> site supervisor fixes (after-photo, crew by grade) -> Production In-charge / FM verifies
--   rework labour per snag + material issued against the snag are charged to the project;
--   a unit cannot be handed over while it has open snags
-- =====================================================================

create table snags (
  id             uuid primary key default gen_random_uuid(),
  snag_no        text not null unique default next_doc_no('SNG'),
  snag_date      date not null default current_date,
  project_id     uuid not null references projects(id),
  unit_id        uuid references project_units(id),
  boq_line_id    uuid references boq_lines(id),
  location_text  text,                                  -- e.g. kitchen, master bedroom wardrobe
  description    text not null,
  category       text not null default 'FINISH' check (category in ('FINISH','DAMAGE','ALIGNMENT','MISSING','HARDWARE','GAP_SEALANT','OTHER')),
  severity       text not null default 'MINOR' check (severity in ('MINOR','MAJOR','CRITICAL')),
  raised_by_party text not null default 'INTERNAL' check (raised_by_party in ('INTERNAL','CLIENT','CONSULTANT')),
  responsible    text not null default 'OWN_TEAM' check (responsible in ('OWN_TEAM','SUBCONTRACTOR','FACTORY')),
  vendor_id      uuid references vendors(id),           -- subcontractor responsible
  due_date       date,
  status         text not null default 'OPEN' check (status in ('OPEN','FIXED','CLOSED','CANCELLED')),
  reopen_count   int not null default 0,
  fix_notes      text, fixed_by uuid references profiles(id), fixed_at timestamptz,
  verify_notes   text, verified_by uuid references profiles(id), verified_at timestamptz,
  labour_cost    numeric(16,2) not null default 0,
  created_by     uuid default auth.uid() references profiles(id),
  created_at     timestamptz not null default now()
);
create index snags_project_idx on snags(project_id, status);
create index snags_unit_idx on snags(unit_id);

create table snag_photos (
  id         uuid primary key default gen_random_uuid(),
  snag_id    uuid not null references snags(id) on delete cascade,
  kind       text not null default 'BEFORE' check (kind in ('BEFORE','AFTER')),
  path       text not null,                            -- storage bucket "snags"
  created_by uuid default auth.uid() references profiles(id),
  created_at timestamptz not null default now()
);
create index snag_photos_snag_idx on snag_photos(snag_id);

create table snag_crew (
  id        uuid primary key default gen_random_uuid(),
  snag_id   uuid not null references snags(id) on delete cascade,
  grade_id  uuid not null references labour_grades(id),
  workers   int not null check (workers > 0),
  hours     numeric(10,2) not null default 0,
  ot_hours  numeric(10,2) not null default 0,
  rate      numeric(10,2) not null,
  ot_rate   numeric(10,2) not null,
  logged_by uuid default auth.uid() references profiles(id),
  logged_at timestamptz not null default now()
);

-- material issued for a snag is tagged (cost already reaches the project through the issue)
alter table material_issues add column snag_id uuid references snags(id);

alter table project_costs drop constraint project_costs_source_check;
alter table project_costs add constraint project_costs_source_check check (source in ('SERVICE_GRN','INSTALL_LABOUR','SNAG_LABOUR','OTHER'));

-- a new snag on an installed unit puts it into snagging
create or replace function public.trg_snag_unit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.unit_id is not null and new.status = 'OPEN' then
    update project_units set status = 'SNAGGING' where id = new.unit_id and status in ('INSTALLED','IN_PROGRESS');
  end if;
  if tg_op = 'INSERT' then
    perform notify('site_supervisor', null, 'Snag ' || new.snag_no || ' — ' || (select code from projects where id = new.project_id)
                   || coalesce(' / ' || (select unit_code from project_units where id = new.unit_id), ''), new.description, 'd/snag/' || new.id, 'snag', new.id);
  end if;
  return new;
end $$;
create trigger snag_unit after insert or update of status on snags for each row execute function trg_snag_unit();
revoke execute on function public.trg_snag_unit() from public, anon, authenticated;

-- site: mark fixed (optionally logging the rework crew)
create or replace function public.snag_fix(p_snag uuid, p_notes text, p_crew jsonb default '[]'::jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare s snags%rowtype; c record; g labour_grades%rowtype; v_cost numeric := 0;
begin
  if not has_role('site_supervisor','production_incharge','factory_manager') then raise exception 'Only the site supervisor can mark snags fixed'; end if;
  select * into s from snags where id = p_snag for update;
  if s.status <> 'OPEN' then raise exception 'Snag is %', s.status; end if;
  if coalesce(trim(p_notes), '') = '' then raise exception 'Describe the fix'; end if;
  for c in select (e->>'grade_id')::uuid grade_id, (e->>'workers')::int workers, coalesce((e->>'hours')::numeric, 0) hours,
                  coalesce((e->>'ot_hours')::numeric, 0) ot_hours from jsonb_array_elements(coalesce(p_crew, '[]'::jsonb)) e loop
    if c.grade_id is null or coalesce(c.workers, 0) < 1 or c.hours + c.ot_hours <= 0 then raise exception 'Each crew line needs a grade, workers and hours'; end if;
    select * into g from labour_grades where id = c.grade_id and is_active;
    if not found then raise exception 'Unknown worker grade'; end if;
    insert into snag_crew (snag_id, grade_id, workers, hours, ot_hours, rate, ot_rate) values (p_snag, g.id, c.workers, c.hours, c.ot_hours, g.rate_per_hour, g.ot_rate_per_hour);
    v_cost := v_cost + c.workers * (c.hours * g.rate_per_hour + c.ot_hours * g.ot_rate_per_hour);
  end loop;
  v_cost := round(v_cost, 2);
  if v_cost > 0 then
    insert into project_costs (project_id, boq_line_id, unit_id, cost_date, source, source_id, doc_no, description, amount)
    values (s.project_id, s.boq_line_id, s.unit_id, current_date, 'SNAG_LABOUR', p_snag, s.snag_no, 'Snag rework — ' || left(s.description, 80), v_cost);
  end if;
  update snags set status = 'FIXED', fix_notes = p_notes, fixed_by = auth.uid(), fixed_at = now(), labour_cost = labour_cost + v_cost where id = p_snag;
  perform notify('production_incharge', null, 'Snag ' || s.snag_no || ' fixed — verify', p_notes, 'd/snag/' || p_snag, 'snag', p_snag);
end $$;

-- Production In-charge / FM: accept (close) or reopen
create or replace function public.snag_verify(p_snag uuid, p_accept boolean, p_notes text default null) returns void
language plpgsql security definer set search_path = public as $$
declare s snags%rowtype;
begin
  if not has_role('production_incharge','factory_manager') then raise exception 'Only the Production In-charge or Factory Manager can verify snags'; end if;
  select * into s from snags where id = p_snag for update;
  if s.status <> 'FIXED' then raise exception 'Snag is %', s.status; end if;
  if not p_accept and coalesce(trim(p_notes), '') = '' then raise exception 'Say why the fix is not accepted'; end if;
  if p_accept then
    update snags set status = 'CLOSED', verified_by = auth.uid(), verified_at = now(), verify_notes = p_notes where id = p_snag;
    -- last snag of an installed unit closed -> unit back to installed (ready for handover)
    update project_units u set status = 'INSTALLED' where u.id = s.unit_id and u.status = 'SNAGGING'
       and not exists (select 1 from snags x where x.unit_id = u.id and x.status in ('OPEN','FIXED'));
  else
    update snags set status = 'OPEN', reopen_count = reopen_count + 1, verify_notes = p_notes where id = p_snag;
    perform notify('site_supervisor', null, 'Snag ' || s.snag_no || ' reopened', p_notes, 'd/snag/' || p_snag, 'snag', p_snag);
  end if;
end $$;

create or replace function public.snag_cancel(p_snag uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not has_role('production_incharge','factory_manager') then raise exception 'Not allowed'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason'; end if;
  update snags set status = 'CANCELLED', verify_notes = 'Cancelled: ' || p_reason, verified_by = auth.uid(), verified_at = now() where id = p_snag and status in ('OPEN','FIXED');
  if not found then raise exception 'Only open or fixed snags can be cancelled'; end if;
end $$;

-- no handover with open snags
do $$ begin
  execute replace(pg_get_functiondef('public.unit_set_status(uuid, text, text, text)'::regprocedure),
    $r$if p_status = 'HANDED_OVER' and coalesce(trim(p_handed_to), '') = '' then raise exception 'Enter who took the handover'; end if;$r$,
    $r$if p_status = 'HANDED_OVER' and coalesce(trim(p_handed_to), '') = '' then raise exception 'Enter who took the handover'; end if;
  if p_status = 'HANDED_OVER' and exists (select 1 from snags where unit_id = p_unit and status in ('OPEN','FIXED')) then
    raise exception 'This unit has % open snag(s) — close them before handover', (select count(*) from snags where unit_id = p_unit and status in ('OPEN','FIXED'));
  end if;$r$);
end $$;

-- snag register with ageing and rework cost
create or replace view v_snags with (security_invoker = true) as
select s.*, p.code project_code, u.unit_code, b.boq_ref, b.description boq_description, v.name vendor_name,
       (coalesce(s.verified_at::date, current_date) - s.snag_date) age_days,
       (s.status in ('OPEN','FIXED') and s.due_date < current_date) is_overdue,
       coalesce((select sum(-l.value) from stock_ledger l join material_issues i on i.id = l.doc_id
                  where l.doc_type = 'ISSUE' and i.snag_id = s.id), 0) material_cost,
       (select count(*) from snag_photos ph where ph.snag_id = s.id) photos
  from snags s join projects p on p.id = s.project_id left join project_units u on u.id = s.unit_id
  left join boq_lines b on b.id = s.boq_line_id left join vendors v on v.id = s.vendor_id;

-- project cost views: snag rework labour joins the total
drop view if exists v_project_overview;
drop view if exists v_project_margin;
create or replace view v_project_production with (security_invoker = true) as
select p.id project_id, p.code, p.name, p.project_type,
       (select count(*) from production_orders w where w.project_id = p.id and w.status <> 'CANCELLED') orders,
       (select count(*) from production_orders w where w.project_id = p.id and w.status in ('RELEASED','IN_PROGRESS')) wip_orders,
       coalesce((select sum(c.act_total - c.fg_value - c.rework_out_value - c.scrap_value) from v_wo_cost c
                  where c.project_id = p.id and c.status in ('DRAFT','RELEASED','IN_PROGRESS')), 0) wip_value,
       coalesce((select sum(l.qty_on_hand * l.unit_cost) from stock_lots l where l.source_type = 'PRODUCTION' and l.project_id = p.id), 0) fg_in_store,
       coalesce((select -sum(s.value) from stock_ledger s where s.txn_type = 'DISPATCH' and s.project_id = p.id), 0) dispatched_value,
       p.contract_value,
       coalesce((select sum(w.cost_scrap) from production_orders w where w.project_id = p.id), 0) scrap_written_off,
       coalesce((select -sum(s.value) from stock_ledger s where s.project_id = p.id and s.production_order_id is null
                  and s.txn_type in ('ISSUE','RETURN')), 0) site_material,
       coalesce((select sum(w.sale_value) from production_orders w where w.project_id = p.id and w.status <> 'CANCELLED'), 0) orders_sale_value,
       coalesce((select sum(r.rework_value + r.scrap_value) from wo_receipts r join production_orders w on w.id = r.wo_id
                  where w.project_id = p.id and r.qc_status = 'PENDING_FM'), 0) qc_pending_value,
       coalesce((select sum(l.qty_on_hand * l.unit_cost) from stock_lots l where l.source_type <> 'PRODUCTION' and l.project_id = p.id and l.qty_on_hand > 0), 0) reserved_stock,
       coalesce((select sum(amount) from project_costs c where c.project_id = p.id and c.source = 'SERVICE_GRN'), 0) services_cost,
       coalesce((select sum(amount) from project_costs c where c.project_id = p.id and c.source = 'INSTALL_LABOUR'), 0) install_labour,
       coalesce((select sum(amount) from project_costs c where c.project_id = p.id and c.source = 'OTHER'), 0) other_costs,
       coalesce((select sum(qty * sell_rate) from boq_lines b where b.project_id = p.id), 0) boq_value,
       coalesce((select sum(qty * est_unit_cost) from boq_lines b where b.project_id = p.id), 0) boq_est_cost,
       coalesce((select sum(amount) from project_costs c where c.project_id = p.id and c.source = 'SNAG_LABOUR'), 0) snag_labour,
       coalesce((select sum(-l.value) from stock_ledger l join material_issues i on i.id = l.doc_id
                  where l.doc_type = 'ISSUE' and i.snag_id is not null and i.project_id = p.id), 0) snag_material
  from projects p;
create view v_project_margin with (security_invoker = true) as
select v.*,
       round(v.wip_value + v.fg_in_store + v.dispatched_value + v.scrap_written_off + v.site_material + v.qc_pending_value
             + v.reserved_stock + v.services_cost + v.install_labour + v.other_costs + v.snag_labour, 2) total_cost,
       case when coalesce(v.contract_value, nullif(v.boq_value, 0)) is not null then round(coalesce(v.contract_value, v.boq_value) - (v.wip_value + v.fg_in_store + v.dispatched_value
             + v.scrap_written_off + v.site_material + v.qc_pending_value + v.reserved_stock + v.services_cost + v.install_labour + v.other_costs + v.snag_labour), 2) end margin,
       case when coalesce(v.contract_value, v.boq_value, 0) > 0 then round((coalesce(v.contract_value, v.boq_value) - (v.wip_value + v.fg_in_store + v.dispatched_value
             + v.scrap_written_off + v.site_material + v.qc_pending_value + v.reserved_stock + v.services_cost + v.install_labour + v.other_costs + v.snag_labour))
             / coalesce(v.contract_value, v.boq_value) * 100, 1) end margin_pct
  from v_project_production v;
create view v_project_overview with (security_invoker = true) as
select p.id project_id, p.code, p.name, p.customer, p.end_date, p.billing_basis, p.boq_locked,
       (p.end_date - current_date) days_left,
       coalesce(b.boq_value, 0) boq_value, coalesce(b.earned, 0) earned_value,
       case when coalesce(b.boq_value, 0) > 0 then round(b.earned / b.boq_value * 100, 1) else 0 end progress_pct,
       coalesce(u.total, 0) units_total, coalesce(u.handed, 0) units_handed, coalesce(u.snagging, 0) units_snagging, coalesce(u.installed, 0) units_installed,
       case when p.end_date < current_date then coalesce(u.total, 0) - coalesce(u.handed, 0) else 0 end units_overdue,
       coalesce(w.open_wo, 0) wo_open, coalesce(w.late_wo, 0) wo_late,
       coalesce(v.pending, 0) vo_pending, coalesce(v.approved_value, 0) vo_approved_value,
       m.total_cost, m.margin, m.margin_pct,
       coalesce(sn.open_snags, 0) open_snags, coalesce(sn.overdue_snags, 0) overdue_snags
  from projects p
  left join (select project_id, sum(contract_value) boq_value, sum(earned_value) earned from v_boq_progress group by project_id) b on b.project_id = p.id
  left join (select project_id, count(*) total, count(*) filter (where status = 'HANDED_OVER') handed, count(*) filter (where status = 'SNAGGING') snagging,
                    count(*) filter (where status = 'INSTALLED') installed from project_units group by project_id) u on u.project_id = p.id
  left join (select project_id, count(*) filter (where status in ('DRAFT','RELEASED','IN_PROGRESS')) open_wo,
                    count(*) filter (where status in ('DRAFT','RELEASED','IN_PROGRESS') and due_date < current_date) late_wo from production_orders group by project_id) w on w.project_id = p.id
  left join (select project_id, count(*) filter (where status = 'SUBMITTED') pending, sum(value_change) filter (where status = 'APPROVED') approved_value
               from variation_orders group by project_id) v on v.project_id = p.id
  left join (select project_id, count(*) filter (where status in ('OPEN','FIXED')) open_snags,
                    count(*) filter (where status in ('OPEN','FIXED') and due_date < current_date) overdue_snags from snags group by project_id) sn on sn.project_id = p.id
  left join v_project_margin m on m.project_id = p.id
 where p.status = 'OPEN' and p.project_type = 'PROJECT';

-- ---------- RLS ----------
alter table snags enable row level security;
alter table snag_photos enable row level security;
alter table snag_crew enable row level security;
create policy read_active on snags for select to authenticated using (public.is_active_user());
create policy read_active on snag_photos for select to authenticated using (public.is_active_user());
create policy read_active on snag_crew for select to authenticated using (public.is_active_user());
create policy doc_insert on snags for insert to authenticated
  with check (public.has_role('site_supervisor','production_incharge','factory_manager') and status = 'OPEN');
create policy doc_update on snags for update to authenticated
  using (public.has_role('site_supervisor','production_incharge','factory_manager') and status = 'OPEN')
  with check (public.has_role('site_supervisor','production_incharge','factory_manager') and status = 'OPEN');
create policy photo_insert on snag_photos for insert to authenticated
  with check (public.has_role('site_supervisor','production_incharge','factory_manager')
              and exists (select 1 from snags s where s.id = snag_photos.snag_id and s.status in ('OPEN','FIXED')));
create policy photo_delete on snag_photos for delete to authenticated
  using (created_by = auth.uid() and exists (select 1 from snags s where s.id = snag_photos.snag_id and s.status = 'OPEN'));

-- photo storage (private bucket, active users only)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('snags', 'snags', false, 10485760, array['image/jpeg','image/png','image/webp','image/heic'])
on conflict (id) do nothing;
create policy snag_photo_read on storage.objects for select to authenticated using (bucket_id = 'snags' and public.is_active_user());
create policy snag_photo_write on storage.objects for insert to authenticated
  with check (bucket_id = 'snags' and public.has_role('site_supervisor','production_incharge','factory_manager'));
create policy snag_photo_delete on storage.objects for delete to authenticated using (bucket_id = 'snags' and owner = auth.uid());

grant execute on function public.snag_fix(uuid, text, jsonb), public.snag_verify(uuid, boolean, text), public.snag_cancel(uuid, text) to authenticated;
revoke execute on function public.snag_fix(uuid, text, jsonb), public.snag_verify(uuid, boolean, text), public.snag_cancel(uuid, text) from anon;
