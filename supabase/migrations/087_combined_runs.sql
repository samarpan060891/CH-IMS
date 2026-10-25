-- 087 Combined runs: the Production In-charge groups open production orders to run together at one work centre —
-- the same product for several projects, or different products sharing a board / colour (CNC nesting, spray booth).
--   · orders stay separate (material requests, issues, FG receipts and cost per order / project)
--   · setup counts once for the run: kept on the order with the largest setup, taken off the planned hours of the others
--   · optional board nesting: sheets of the same board are worked out for all the orders together and shared out by
--     their parts area (only orders whose material has not been sent to Stores yet)
--   · the floor logs the run once; time is split over the orders by their planned hours at the stage
--   · an order returned to draft or cancelled leaves its run (its setup and sheets are put back)
create table if not exists wo_run_groups (
  id uuid primary key default gen_random_uuid(),
  run_no text unique,
  work_center_id uuid not null references work_centers(id),
  notes text,
  nested boolean not null default false,
  sheets_saved numeric not null default 0,
  setup_saved numeric not null default 0,
  status text not null default 'OPEN' check (status in ('OPEN', 'DONE', 'CANCELLED')),
  created_by uuid default auth.uid() references profiles(id),
  created_at timestamptz not null default now()
);
alter table wo_run_groups enable row level security;
drop policy if exists read_active on wo_run_groups;
create policy read_active on wo_run_groups for select using (is_active_user());
alter table wo_operations add column if not exists run_group_id uuid references wo_run_groups(id) on delete set null;
alter table wo_operations add column if not exists setup_removed numeric not null default 0;
alter table wo_materials add column if not exists req_before_nest numeric;

-- take one stage out of its run: put its setup and its own board sheets back (sheets only while its material is held)
create or replace function wo_run_leave(p_op uuid) returns void language plpgsql security definer set search_path = public as $$
declare o wo_operations%rowtype; w work_centers%rowtype; h production_orders%rowtype; g uuid;
begin
  select * into o from wo_operations where id = p_op for update;
  if o.run_group_id is null then return; end if;
  g := o.run_group_id;
  select * into w from work_centers where id = o.work_center_id;
  select * into h from production_orders where id = o.wo_id;
  if o.setup_removed > 0 and o.status = 'PENDING' then
    update wo_operations set setup_hours = o.setup_removed,
           planned_machine_hours = planned_machine_hours + case when w.kind = 'MACHINE' then o.setup_removed else 0 end,
           planned_labour_hours = planned_labour_hours + o.setup_removed * case when w.kind = 'MACHINE' then w.operators else 1 end
     where id = p_op;
  end if;
  if exists (select 1 from wo_runs_nested_orders where group_id = g and wo_id = o.wo_id)
     and (h.mr_id is null or exists (select 1 from material_requests where id = h.mr_id and status = 'DRAFT'))
     and not exists (select 1 from stock_ledger where production_order_id = o.wo_id) then
    perform set_config('app.mr_sys', 'on', true);
    update mr_lines l set requested_qty = l.requested_qty - m.required_qty + m.req_before_nest
      from wo_materials m, material_requests r
     where m.wo_id = o.wo_id and m.req_before_nest is not null and r.id = h.mr_id and r.status = 'DRAFT' and l.mr_id = r.id and l.item_id = m.item_id;
    perform set_config('app.mr_sys', 'off', true);
    update wo_materials set required_qty = req_before_nest, req_before_nest = null where wo_id = o.wo_id and req_before_nest is not null;
  end if;
  update wo_operations set run_group_id = null, setup_removed = 0 where id = p_op;
  -- a run of one is no run
  if (select count(*) from wo_operations where run_group_id = g) < 2 then
    perform wo_run_leave(id) from wo_operations where run_group_id = g;
    update wo_run_groups set status = 'CANCELLED' where id = g and status = 'OPEN';
  end if;
end $$;

-- orders whose boards were nested in a run (their sheets came from the run)
create or replace view wo_runs_nested_orders as
  select distinct o.run_group_id group_id, o.wo_id from wo_operations o join wo_run_groups g on g.id = o.run_group_id
   where g.nested and exists (select 1 from wo_materials m where m.wo_id = o.wo_id and m.req_before_nest is not null);

create or replace function run_group_create(p_wc uuid, p_wos uuid[], p_notes text, p_nest boolean) returns uuid
language plpgsql security definer set search_path = public as $$
declare g uuid; w work_centers%rowtype; n int; v_bad text; keep uuid; r record; it record; v_tot numeric; v_new int; v_saved numeric := 0; v_setup numeric := 0;
  v_bw numeric; v_left int;
begin
  if not has_role('production_incharge', 'factory_manager') then raise exception 'Only production planning can combine orders'; end if;
  select * into w from work_centers where id = p_wc;
  if not found or w.kind = 'UTILITY' then raise exception 'Choose a production work centre'; end if;
  if coalesce(array_length(p_wos, 1), 0) < 2 then raise exception 'Choose at least two production orders'; end if;
  select string_agg(h.wo_no || ' (' || h.status || ')', ', ') into v_bad from production_orders h
   where h.id = any(p_wos) and h.status not in ('PENDING_FM', 'APPROVED', 'RELEASED', 'IN_PROGRESS');
  if v_bad is not null then raise exception 'Only open orders (with the FM, approved, released or in progress) can be combined: %', v_bad; end if;
  -- each order's first stage at this work centre that has not started and is not in another run
  drop table if exists _ops;
  create temp table _ops on commit drop as
    select distinct on (o.wo_id) o.* from wo_operations o
     where o.wo_id = any(p_wos) and o.work_center_id = p_wc and o.status = 'PENDING' and o.run_group_id is null order by o.wo_id, o.seq;
  select string_agg(h.wo_no, ', ') into v_bad from production_orders h where h.id = any(p_wos) and not exists (select 1 from _ops where wo_id = h.id);
  if v_bad is not null then raise exception '% % no stage at % still to start (or it is already in a combined run)', v_bad,
    case when v_bad like '%,%' then 'have' else 'has' end, w.name; end if;

  insert into wo_run_groups (run_no, work_center_id, notes) values (next_doc_no('RUN', current_date), p_wc, nullif(trim(p_notes), '')) returning id into g;
  update wo_operations set run_group_id = g where id in (select id from _ops);
  -- setup once: the largest setup stays, the others come off the planned hours
  select id into keep from _ops order by setup_hours desc, seq limit 1;
  for r in select * from _ops where id <> keep and setup_hours > 0 loop
    update wo_operations set setup_removed = r.setup_hours, setup_hours = 0,
           planned_machine_hours = greatest(0, planned_machine_hours - case when w.kind = 'MACHINE' then r.setup_hours else 0 end),
           planned_labour_hours = greatest(0, planned_labour_hours - r.setup_hours * case when w.kind = 'MACHINE' then w.operators else 1 end)
     where id = r.id;
    v_setup := v_setup + r.setup_hours;
  end loop;

  -- board nesting: sheets for all the orders together, shared out by parts area (largest remainder)
  if p_nest then
    select board_waste_pct into v_bw from company_settings where id = 1;
    drop table if exists _nest;
    create temp table _nest on commit drop as
      select h.id wo_id from production_orders h left join material_requests m on m.id = h.mr_id
       where h.id = any(p_wos) and (h.mr_id is null or m.status = 'DRAFT')
         and not exists (select 1 from stock_ledger l where l.production_order_id = h.id);
    for it in select m.item_id from wo_materials m join items i on i.id = m.item_id join uoms u on u.id = i.uom_id
               where m.wo_id in (select wo_id from _nest) and m.source = 'CUTLIST' and u.code in ('SHT', 'NOS', 'PCS') and m.net_qty > 0
               group by m.item_id having count(distinct m.wo_id) > 1 loop
      select sum(m.net_qty * (1 + coalesce(h.board_waste_pct, v_bw) / 100)), sum(m.required_qty) into v_tot, n
        from wo_materials m join production_orders h on h.id = m.wo_id
       where m.wo_id in (select wo_id from _nest) and m.item_id = it.item_id and m.source = 'CUTLIST';
      v_new := ceil(v_tot - 1e-9);
      if v_new >= n then continue; end if;
      update wo_materials set req_before_nest = coalesce(req_before_nest, required_qty)
       where wo_id in (select wo_id from _nest) and item_id = it.item_id and source = 'CUTLIST';
      -- whole sheets by share: floor first, the remaining sheets to the largest remainders
      v_left := v_new;
      for r in select m.id, m.wo_id, m.net_qty * (1 + coalesce(h.board_waste_pct, v_bw) / 100) / v_tot * v_new share
                 from wo_materials m join production_orders h on h.id = m.wo_id
                where m.wo_id in (select wo_id from _nest) and m.item_id = it.item_id and m.source = 'CUTLIST' order by m.wo_id loop
        update wo_materials set required_qty = floor(r.share) where id = r.id;
        v_left := v_left - floor(r.share)::int;
      end loop;
      for r in select m.id from wo_materials m join production_orders h on h.id = m.wo_id
                where m.wo_id in (select wo_id from _nest) and m.item_id = it.item_id and m.source = 'CUTLIST'
                order by (m.net_qty * (1 + coalesce(h.board_waste_pct, v_bw) / 100) / v_tot * v_new) - floor(m.net_qty * (1 + coalesce(h.board_waste_pct, v_bw) / 100) / v_tot * v_new) desc
                limit greatest(v_left, 0) loop
        update wo_materials set required_qty = required_qty + 1 where id = r.id;
      end loop;
      v_saved := v_saved + (n - v_new);
      -- the held material requests follow
      perform set_config('app.mr_sys', 'on', true);
      update mr_lines l set requested_qty = l.requested_qty - m.req_before_nest + m.required_qty
        from wo_materials m join production_orders h on h.id = m.wo_id join material_requests q on q.id = h.mr_id
       where m.wo_id in (select wo_id from _nest) and m.item_id = it.item_id and m.source = 'CUTLIST' and q.status = 'DRAFT'
         and l.mr_id = q.id and l.item_id = it.item_id;
      perform set_config('app.mr_sys', 'off', true);
    end loop;
  end if;
  update wo_run_groups set nested = p_nest and v_saved > 0, sheets_saved = v_saved, setup_saved = v_setup where id = g;
  return g;
end $$;

create or replace function run_group_dissolve(p_group uuid) returns void language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if not has_role('production_incharge', 'factory_manager') then raise exception 'Only production planning can change combined runs'; end if;
  for o in select id from wo_operations where run_group_id = p_group loop perform wo_run_leave(o.id); end loop;
  update wo_run_groups set status = 'CANCELLED' where id = p_group and status = 'OPEN';
end $$;

create or replace function run_group_remove(p_op uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_role('production_incharge', 'factory_manager') then raise exception 'Only production planning can change combined runs'; end if;
  perform wo_run_leave(p_op);
end $$;

-- the floor: start the run / log it once — crew hours, machine hours split over the orders by planned hours
create or replace function run_group_start(p_group uuid) returns void language plpgsql security definer set search_path = public as $$
declare o record;
begin
  for o in select id from wo_operations where run_group_id = p_group and status = 'PENDING' loop perform wo_stage_action(o.id, 'START'); end loop;
end $$;

create or replace function run_group_log(p_group uuid, p_date date, p_crew jsonb, p_machine_hours numeric, p_qty jsonb, p_notes text, p_complete boolean) returns void
language plpgsql security definer set search_path = public as $$
declare g wo_run_groups%rowtype; o record; v_tot numeric; v_share numeric; v_crew jsonb;
begin
  select * into g from wo_run_groups where id = p_group for update;
  if g.status <> 'OPEN' then raise exception 'This combined run is %', lower(g.status); end if;
  select sum(greatest(planned_machine_hours, planned_labour_hours, 0.001)) into v_tot from wo_operations where run_group_id = p_group and status not in ('DONE', 'SKIPPED');
  if v_tot is null then raise exception 'All stages of this run are closed'; end if;
  for o in select * from wo_operations where run_group_id = p_group and status not in ('DONE', 'SKIPPED') order by seq loop
    v_share := greatest(o.planned_machine_hours, o.planned_labour_hours, 0.001) / v_tot;
    select jsonb_agg(jsonb_build_object('grade_id', e->>'grade_id', 'workers', (e->>'workers')::int,
             'hours', round(coalesce((e->>'hours')::numeric, 0) * v_share, 4), 'ot_hours', round(coalesce((e->>'ot_hours')::numeric, 0) * v_share, 4)))
      into v_crew from jsonb_array_elements(p_crew) e;
    perform wo_log_time(o.id, p_date, v_crew, case when p_machine_hours is null then null else round(p_machine_hours * v_share, 4) end,
                        coalesce((p_qty->>o.id::text)::numeric, 0), concat_ws(' · ', 'Combined run ' || g.run_no, nullif(p_notes, '')), p_complete);
  end loop;
  if p_complete then update wo_run_groups set status = 'DONE' where id = p_group; end if;
end $$;

-- an order sent back to draft or cancelled leaves its runs
create or replace function wo_leave_runs() returns trigger language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if new.status in ('DRAFT', 'CANCELLED') and old.status is distinct from new.status then
    for o in select id from wo_operations where wo_id = new.id and run_group_id is not null loop perform wo_run_leave(o.id); end loop;
  end if;
  return new;
end $$;
drop trigger if exists trg_wo_leave_runs on production_orders;
create trigger trg_wo_leave_runs after update of status on production_orders for each row execute function wo_leave_runs();
