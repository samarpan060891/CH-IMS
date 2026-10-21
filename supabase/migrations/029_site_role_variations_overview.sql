-- =====================================================================
-- Citi Homes IMS - 029
--   * site supervisor: installation logs, unit status / handover, site-store receipts and handovers,
--     confirm deliveries, material requests / acknowledgements for the site
--   * BOQ baseline lock + numbered variation orders (add / change / omit) approved by the Factory Manager
--   * projects overview for the dashboard
-- =====================================================================

-- ---------- site supervisor ----------
create or replace function public.is_site_location(p_loc uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select loc_type = 'SITE' from locations where id = p_loc), false)
$$;
create or replace function public.grn_is_site(p_grn uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_site_location(g.location_id)
     and not exists (select 1 from grn_lines l where l.grn_id = g.id and l.location_id is not null and not is_site_location(l.location_id))
    from grns g where g.id = p_grn
$$;

-- GRNs: Stores everywhere; site supervisor for receipts into a site store
drop policy doc_insert on grns; drop policy doc_update on grns; drop policy doc_delete on grns;
create policy doc_insert on grns for insert to authenticated
  with check (status = 'DRAFT' and (public.has_role('stores') or (public.has_role('site_supervisor') and public.is_site_location(location_id))));
create policy doc_update on grns for update to authenticated
  using (status = 'DRAFT' and (public.has_role('stores') or (public.has_role('site_supervisor') and public.is_site_location(location_id))))
  with check (status = 'DRAFT' and (public.has_role('stores') or (public.has_role('site_supervisor') and public.is_site_location(location_id))));
create policy doc_delete on grns for delete to authenticated
  using (status = 'DRAFT' and (public.has_role('stores') or (public.has_role('site_supervisor') and public.is_site_location(location_id))));
drop policy line_write on grn_lines;
create policy line_write on grn_lines for all to authenticated
  using (exists (select 1 from grns h where h.id = grn_lines.grn_id and h.status = 'DRAFT'
                  and (public.has_role('stores') or (public.has_role('site_supervisor') and public.is_site_location(h.location_id)))))
  with check (exists (select 1 from grns h where h.id = grn_lines.grn_id and h.status = 'DRAFT'
                  and (public.has_role('stores') or (public.has_role('site_supervisor') and public.is_site_location(h.location_id)))));
do $$ begin
  execute replace(replace(pg_get_functiondef('public.post_grn(uuid)'::regprocedure),
    $r$if not has_role('stores') then raise exception 'Only Stores can post a GRN'; end if;$r$, ''),
    $r$if not found then raise exception 'GRN not found'; end if;$r$,
    $r$if not found then raise exception 'GRN not found'; end if;
  if not (has_role('stores') or (has_role('site_supervisor') and grn_is_site(p_grn))) then
    raise exception 'Only Stores can post a GRN (the site supervisor only for deliveries into a site store)';
  end if;$r$);
end $$;

-- deliveries: site supervisor hands over from the site store and confirms deliveries from the factory
drop policy doc_insert on dispatch_notes; drop policy doc_update on dispatch_notes; drop policy doc_delete on dispatch_notes;
create policy doc_insert on dispatch_notes for insert to authenticated
  with check (status = 'DRAFT' and (public.has_role('stores','factory_manager') or (public.has_role('site_supervisor') and public.is_site_location(from_location_id))));
create policy doc_update on dispatch_notes for update to authenticated
  using (status = 'DRAFT' and (public.has_role('stores','factory_manager') or (public.has_role('site_supervisor') and public.is_site_location(from_location_id))))
  with check (status = 'DRAFT' and (public.has_role('stores','factory_manager') or (public.has_role('site_supervisor') and public.is_site_location(from_location_id))));
create policy doc_delete on dispatch_notes for delete to authenticated
  using (status = 'DRAFT' and (public.has_role('stores','factory_manager') or (public.has_role('site_supervisor') and public.is_site_location(from_location_id))));
drop policy line_write on dispatch_lines;
create policy line_write on dispatch_lines for all to authenticated
  using (exists (select 1 from dispatch_notes h where h.id = dispatch_lines.dispatch_id and h.status = 'DRAFT'
                  and (public.has_role('stores','factory_manager') or (public.has_role('site_supervisor') and public.is_site_location(h.from_location_id)))))
  with check (exists (select 1 from dispatch_notes h where h.id = dispatch_lines.dispatch_id and h.status = 'DRAFT'
                  and (public.has_role('stores','factory_manager') or (public.has_role('site_supervisor') and public.is_site_location(h.from_location_id)))));

create or replace function public.post_dispatch(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare h dispatch_notes%rowtype; l record; r record; v_val numeric; v_total numeric := 0; v_site boolean;
begin
  select * into h from dispatch_notes where id = p_id for update;
  v_site := is_site_location(h.from_location_id);
  if not (has_role('stores','factory_manager') or (has_role('site_supervisor') and v_site)) then
    raise exception 'Only Stores can post deliveries (the site supervisor only for handovers from a site store)';
  end if;
  if h.status <> 'DRAFT' then raise exception 'Delivery note is %', h.status; end if;
  if not exists (select 1 from dispatch_lines where dispatch_id = p_id) then raise exception 'Add at least one line'; end if;
  for l in select * from dispatch_lines where dispatch_id = p_id order by line_no loop
    v_val := 0;
    for r in select * from fifo_consume(l.item_id, h.from_location_id, l.qty, h.project_id, 'DISPATCH', 'DISPATCH', p_id,
                                        h.dispatch_no, l.id, h.dispatch_date, h.project_id, null, null, false) loop
      v_val := v_val + round(r.qty * r.unit_cost, 2);
    end loop;
    update stock_ledger set production_order_id = l.production_order_id where doc_line_id = l.id and l.production_order_id is not null;
    update dispatch_lines set value = v_val where id = l.id;
    v_total := v_total + v_val;
  end loop;
  -- a handover from the site store is complete on posting; factory deliveries wait for site confirmation
  update dispatch_notes set status = case when v_site then 'DELIVERED' else 'POSTED' end, total_value = v_total, posted_by = auth.uid(), posted_at = now(),
         delivered_at = case when v_site then now() end, received_by_name = case when v_site then coalesce(received_by_name, 'Site handover') end
   where id = p_id;
  if not v_site then
    perform notify('site_supervisor', null, 'Delivery ' || h.dispatch_no || ' on the way', coalesce(h.vehicle_no, '') || coalesce(' · ' || h.driver_name, ''),
                   'd/dsp/' || p_id, 'dsp', p_id);
  end if;
end $$;

create or replace function public.dispatch_delivered(p_id uuid, p_received_by text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not has_role('stores','factory_manager','production_incharge','site_supervisor') then raise exception 'Not allowed'; end if;
  if coalesce(trim(p_received_by), '') = '' then raise exception 'Enter who received the goods at site'; end if;
  update dispatch_notes set status = 'DELIVERED', received_by_name = p_received_by, delivered_at = now()
   where id = p_id and status = 'POSTED';
  if not found then raise exception 'Only posted delivery notes can be marked delivered'; end if;
end $$;

-- installation logs
drop policy doc_insert on install_logs; drop policy doc_update on install_logs; drop policy doc_delete on install_logs;
drop policy line_write on install_log_crew; drop policy line_write on install_log_lines;
create policy doc_insert on install_logs for insert to authenticated with check (public.has_role('shop_floor','production_incharge','factory_manager','site_supervisor') and status = 'DRAFT');
create policy doc_update on install_logs for update to authenticated
  using (public.has_role('shop_floor','production_incharge','factory_manager','site_supervisor') and status = 'DRAFT') with check (status = 'DRAFT');
create policy doc_delete on install_logs for delete to authenticated using (public.has_role('shop_floor','production_incharge','factory_manager','site_supervisor') and status = 'DRAFT');
create policy line_write on install_log_crew for all to authenticated
  using (public.has_role('shop_floor','production_incharge','factory_manager','site_supervisor') and exists (select 1 from install_logs h where h.id = install_log_crew.log_id and h.status = 'DRAFT'))
  with check (public.has_role('shop_floor','production_incharge','factory_manager','site_supervisor') and exists (select 1 from install_logs h where h.id = install_log_crew.log_id and h.status = 'DRAFT'));
create policy line_write on install_log_lines for all to authenticated
  using (public.has_role('shop_floor','production_incharge','factory_manager','site_supervisor') and exists (select 1 from install_logs h where h.id = install_log_lines.log_id and h.status = 'DRAFT'))
  with check (public.has_role('shop_floor','production_incharge','factory_manager','site_supervisor') and exists (select 1 from install_logs h where h.id = install_log_lines.log_id and h.status = 'DRAFT'));
do $$ begin
  execute replace(pg_get_functiondef('public.post_install_log(uuid)'::regprocedure),
    $r$has_role('shop_floor','production_incharge','factory_manager')$r$, $r$has_role('shop_floor','production_incharge','factory_manager','site_supervisor')$r$);
end $$;

create or replace function public.unit_set_status(p_unit uuid, p_status text, p_handed_to text default null, p_remarks text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not has_role('production_incharge','factory_manager','site_supervisor') then raise exception 'Only the site supervisor / Production In-charge can change unit status'; end if;
  if p_status not in ('IN_PROGRESS','INSTALLED','SNAGGING','HANDED_OVER') then raise exception 'Unknown status %', p_status; end if;
  if p_status = 'HANDED_OVER' and coalesce(trim(p_handed_to), '') = '' then raise exception 'Enter who took the handover'; end if;
  update project_units set status = p_status,
         handed_over_at = case when p_status = 'HANDED_OVER' then current_date end,
         handed_over_to = case when p_status = 'HANDED_OVER' then p_handed_to end,
         remarks = coalesce(p_remarks, remarks)
   where id = p_unit;
end $$;

-- material requests from site, acknowledgement and returns
drop policy doc_insert on material_requests; drop policy doc_update on material_requests; drop policy doc_delete on material_requests; drop policy line_write on mr_lines;
create policy doc_insert on material_requests for insert to authenticated
  with check (public.has_role('shop_floor','production_incharge','stores','site_supervisor') and status in ('DRAFT','REJECTED'));
create policy doc_update on material_requests for update to authenticated
  using (public.has_role('shop_floor','production_incharge','stores','site_supervisor') and status in ('DRAFT','REJECTED'))
  with check (public.has_role('shop_floor','production_incharge','stores','site_supervisor') and status in ('DRAFT','REJECTED'));
create policy doc_delete on material_requests for delete to authenticated
  using (public.has_role('shop_floor','production_incharge','stores','site_supervisor') and status in ('DRAFT','REJECTED'));
create policy line_write on mr_lines for all to authenticated
  using (public.has_role('shop_floor','production_incharge','stores','site_supervisor') and exists (select 1 from material_requests h where h.id = mr_lines.mr_id and h.status in ('DRAFT','REJECTED','PENDING_APPROVAL')))
  with check (public.has_role('shop_floor','production_incharge','stores','site_supervisor') and exists (select 1 from material_requests h where h.id = mr_lines.mr_id and h.status in ('DRAFT','REJECTED','PENDING_APPROVAL')));
do $$ begin
  execute replace(pg_get_functiondef('public.mr_action(uuid, text, text)'::regprocedure),
    $r$has_role('shop_floor','production_incharge','stores')$r$, $r$has_role('shop_floor','production_incharge','stores','site_supervisor')$r$);
  execute replace(pg_get_functiondef('public.issue_acknowledge(uuid, jsonb, text)'::regprocedure),
    $r$has_role('shop_floor','production_incharge')$r$, $r$has_role('shop_floor','production_incharge','site_supervisor')$r$);
  execute replace(pg_get_functiondef('public.return_action(uuid, text)'::regprocedure),
    $r$has_role('shop_floor','production_incharge','stores')$r$, $r$has_role('shop_floor','production_incharge','stores','site_supervisor')$r$);
end $$;

-- ---------- BOQ baseline lock ----------
alter table projects add column boq_locked boolean not null default false,
                     add column boq_locked_at timestamptz, add column boq_locked_by uuid references profiles(id);

create or replace function public.project_lock_boq(p_project uuid, p_lock boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not has_role('factory_manager') then raise exception 'Only the Factory Manager can lock or unlock the BOQ baseline'; end if;
  update projects set boq_locked = p_lock, boq_locked_at = case when p_lock then now() end, boq_locked_by = case when p_lock then auth.uid() end where id = p_project;
  insert into audit_log (entity, entity_id, action, details) values ('project', p_project, case when p_lock then 'BOQ_LOCKED' else 'BOQ_UNLOCKED' end, '{}'::jsonb);
end $$;

drop policy write_roles on boq_lines;
create policy write_roles on boq_lines for all to authenticated
  using (public.has_role('factory_manager','production_incharge','finance') and not exists (select 1 from projects p where p.id = boq_lines.project_id and p.boq_locked))
  with check (public.has_role('factory_manager','production_incharge','finance') and not exists (select 1 from projects p where p.id = boq_lines.project_id and p.boq_locked));

-- unit allocation core (internal); the public sync does nothing once the baseline is locked
create or replace function public.boq_sync_core(p_project uuid, p_line uuid) returns int
language plpgsql security definer set search_path = public as $$
declare l record; n int := 0; v_bad text;
begin
  for l in select * from boq_lines where project_id = p_project and (p_line is null or id = p_line)
             and (coalesce(unit_type, '') <> '' or coalesce(unit_codes, '') <> '') loop
    if coalesce(l.qty_per_unit, 0) <= 0 then raise exception 'BOQ line % (%): enter Qty per unit', l.line_no, coalesce(l.boq_ref, l.description); end if;
    select string_agg(c, ', ') into v_bad from unnest(string_to_array(coalesce(l.unit_codes, ''), ',')) c0(c0), lateral (select trim(c0) c) x
     where c <> '' and not exists (select 1 from project_units u where u.project_id = p_project and upper(u.unit_code) = upper(c));
    if v_bad is not null then raise exception 'BOQ line %: unknown unit code(s) %', l.line_no, v_bad; end if;
    delete from boq_line_units where boq_line_id = l.id;
    insert into boq_line_units (boq_line_id, unit_id, qty)
    select l.id, u.id, l.qty_per_unit from project_units u
     where u.project_id = p_project
       and ((coalesce(l.unit_type, '') <> '' and upper(u.unit_type) = upper(trim(l.unit_type)))
         or upper(u.unit_code) in (select upper(trim(c)) from unnest(string_to_array(coalesce(l.unit_codes, ''), ',')) c where trim(c) <> ''));
    update boq_lines set qty = coalesce((select sum(qty) from boq_line_units where boq_line_id = l.id), 0) where id = l.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.boq_sync_core(uuid, uuid) from public, anon, authenticated;
create or replace function public.boq_sync_units(p_project uuid) returns int
language plpgsql security definer set search_path = public as $$
begin
  if not has_role('factory_manager','production_incharge','finance') then raise exception 'Not allowed'; end if;
  if (select boq_locked from projects where id = p_project) then return 0; end if;
  return boq_sync_core(p_project, null);
end $$;

-- units matching a unit type / list of codes
create or replace function public.boq_unit_count(p_project uuid, p_unit_type text, p_unit_codes text) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from project_units u where u.project_id = p_project
     and ((coalesce(p_unit_type, '') <> '' and upper(u.unit_type) = upper(trim(p_unit_type)))
       or upper(u.unit_code) in (select upper(trim(c)) from unnest(string_to_array(coalesce(p_unit_codes, ''), ',')) c where trim(c) <> ''))
$$;

-- ---------- variation orders ----------
alter table boq_lines add column vo_id uuid;   -- set when the line was added by a variation order

create table variation_orders (
  id                uuid primary key default gen_random_uuid(),
  vo_no             text not null unique default next_doc_no('VO'),
  vo_date           date not null default current_date,
  project_id        uuid not null references projects(id),
  title             text not null,
  client_ref        text,                         -- client instruction / site instruction no.
  reason            text,
  status            text not null default 'DRAFT' check (status in ('DRAFT','SUBMITTED','APPROVED','REJECTED','CANCELLED')),
  value_change      numeric(16,2) not null default 0,
  cost_change       numeric(16,2) not null default 0,
  submitted_by      uuid references profiles(id), submitted_at timestamptz,
  approved_by       uuid references profiles(id), approved_at timestamptz,
  approval_comments text,
  created_by        uuid default auth.uid() references profiles(id),
  created_at        timestamptz not null default now()
);
alter table boq_lines add constraint boq_lines_vo_fk foreign key (vo_id) references variation_orders(id);

create table vo_lines (
  id            uuid primary key default gen_random_uuid(),
  vo_id         uuid not null references variation_orders(id) on delete cascade,
  line_no       int not null default 1,
  change_type   text not null check (change_type in ('ADD','CHANGE','OMIT')),
  boq_line_id   uuid references boq_lines(id),     -- CHANGE / OMIT
  boq_ref       text,
  description   text,
  category      text check (category in ('MANUFACTURED','BOUGHT_OUT','SERVICE')),
  item_id       uuid references items(id),
  uom           text,
  unit_type     text,
  unit_codes    text,
  qty_per_unit  numeric(14,3),
  qty           numeric(14,3),
  sell_rate     numeric(16,2),
  est_unit_cost numeric(16,2),
  supply_mode   text check (supply_mode in ('FACTORY','DIRECT_TO_SITE')),
  service_mode  text check (service_mode in ('OWN_TEAM','SUBCONTRACT','HIRED')),
  remarks       text,
  old_qty numeric(14,3), old_sell_rate numeric(16,2), old_est_cost numeric(16,2), applied_qty numeric(14,3), applied_line_id uuid references boq_lines(id),
  check (change_type = 'ADD' or boq_line_id is not null)
);
create index vo_lines_vo_idx on vo_lines(vo_id);

-- preview of every line: before / after quantity, rate and value
create or replace view v_vo_lines with (security_invoker = true) as
with x as (
  select v.*, h.project_id, h.status vo_status, b.qty b_qty, b.sell_rate b_rate, b.est_unit_cost b_cost, b.unit_type b_ut, b.unit_codes b_uc, b.qty_per_unit b_qpu,
         b.description b_desc, b.boq_ref b_ref
    from vo_lines v join variation_orders h on h.id = v.vo_id left join boq_lines b on b.id = v.boq_line_id
), y as (
  select x.*,
         case when x.vo_status = 'APPROVED' then x.old_qty else coalesce(x.b_qty, 0) end before_qty,
         case when x.vo_status = 'APPROVED' then x.old_sell_rate else coalesce(x.b_rate, 0) end before_rate,
         case when x.vo_status = 'APPROVED' then x.old_est_cost else coalesce(x.b_cost, 0) end before_cost,
         case when x.vo_status = 'APPROVED' then x.applied_qty
              when x.change_type = 'OMIT' then 0
              when coalesce(coalesce(x.unit_type, x.b_ut), '') <> '' or coalesce(coalesce(x.unit_codes, x.b_uc), '') <> ''
                then coalesce(x.qty_per_unit, x.b_qpu, 0) * boq_unit_count(x.project_id, coalesce(x.unit_type, x.b_ut), coalesce(x.unit_codes, x.b_uc))
              else coalesce(x.qty, x.b_qty, 0) end after_qty,
         coalesce(x.sell_rate, x.b_rate, 0) after_rate, coalesce(x.est_unit_cost, x.b_cost, 0) after_cost
    from x
)
select y.id, y.vo_id, y.line_no, y.change_type, y.boq_line_id, coalesce(y.boq_ref, y.b_ref) boq_ref, coalesce(y.description, y.b_desc) description,
       y.before_qty, y.after_qty, y.before_rate, y.after_rate,
       round(y.after_qty * y.after_rate - case when y.change_type = 'ADD' then 0 else y.before_qty * y.before_rate end, 2) value_change,
       round(y.after_qty * y.after_cost - case when y.change_type = 'ADD' then 0 else y.before_qty * y.before_cost end, 2) cost_change
  from y;

-- quantity already committed on a BOQ line (cannot be reduced below it)
create or replace function public.boq_committed_qty(p_line uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select greatest(coalesce(wo_qty, 0), coalesce(delivered_qty, 0), coalesce(installed_qty, 0),
                  case when category in ('BOUGHT_OUT','SERVICE') then coalesce(ordered_qty, 0) else 0 end)
    from v_boq_progress where boq_line_id = p_line
$$;

create or replace function public.vo_action(p_vo uuid, p_action text, p_comments text default null) returns text
language plpgsql security definer set search_path = public as $$
declare h variation_orders%rowtype; l record; b boq_lines%rowtype; v_val numeric; v_cost numeric; v_new uuid; v_qty numeric; v_commit numeric; v_no int;
begin
  select * into h from variation_orders where id = p_vo for update;
  if not found then raise exception 'Variation order not found'; end if;
  if p_action = 'SUBMIT' then
    if not has_role('factory_manager','production_incharge','finance') then raise exception 'Not allowed'; end if;
    if h.status not in ('DRAFT','REJECTED') then raise exception 'Variation is %', h.status; end if;
    if not exists (select 1 from vo_lines where vo_id = p_vo) then raise exception 'Add at least one change'; end if;
    select coalesce(sum(value_change), 0), coalesce(sum(cost_change), 0) into v_val, v_cost from v_vo_lines where vo_id = p_vo;
    update variation_orders set status = 'SUBMITTED', value_change = v_val, cost_change = v_cost, submitted_by = auth.uid(), submitted_at = now() where id = p_vo;
    perform notify('factory_manager', null, 'Variation ' || h.vo_no || ' for approval', h.title || format(' — value %s AED', to_char(v_val, 'FMS999,999,990.00')), 'd/vo/' || p_vo, 'vo', p_vo);
    return 'SUBMITTED';
  elsif p_action = 'REJECT' then
    if not has_role('factory_manager') then raise exception 'Only the Factory Manager can reject variations'; end if;
    if h.status <> 'SUBMITTED' then raise exception 'Variation is not submitted'; end if;
    if coalesce(trim(p_comments), '') = '' then raise exception 'Give a reason'; end if;
    update variation_orders set status = 'REJECTED', approved_by = auth.uid(), approved_at = now(), approval_comments = p_comments where id = p_vo;
    perform notify('production_incharge', null, 'Variation ' || h.vo_no || ' rejected', p_comments, 'd/vo/' || p_vo, 'vo', p_vo);
    return 'REJECTED';
  elsif p_action = 'CANCEL' then
    if not has_role('factory_manager','production_incharge','finance') then raise exception 'Not allowed'; end if;
    if h.status not in ('DRAFT','SUBMITTED','REJECTED') then raise exception 'Variation is %', h.status; end if;
    update variation_orders set status = 'CANCELLED' where id = p_vo;
    return 'CANCELLED';
  elsif p_action <> 'APPROVE' then raise exception 'Unknown action %', p_action; end if;

  if not has_role('factory_manager') then raise exception 'Only the Factory Manager can approve variations'; end if;
  if h.status <> 'SUBMITTED' then raise exception 'Variation is not submitted'; end if;
  select coalesce(max(line_no), 0) into v_no from boq_lines where project_id = h.project_id;
  for l in select * from vo_lines where vo_id = p_vo order by line_no loop
    if l.change_type = 'ADD' then
      if coalesce(l.description, '') = '' or l.category is null then raise exception 'Variation line %: description and category are required', l.line_no; end if;
      v_no := v_no + 1;
      insert into boq_lines (project_id, line_no, boq_ref, description, category, item_id, uom, unit_type, unit_codes, qty_per_unit, qty, sell_rate, est_unit_cost,
                             supply_mode, service_mode, remarks, vo_id)
      values (h.project_id, v_no, l.boq_ref, l.description, l.category, l.item_id, l.uom, l.unit_type, l.unit_codes, l.qty_per_unit, coalesce(l.qty, 0),
              coalesce(l.sell_rate, 0), coalesce(l.est_unit_cost, 0), l.supply_mode, l.service_mode, coalesce(l.remarks, h.vo_no), p_vo)
      returning id into v_new;
      perform boq_sync_core(h.project_id, v_new);
      update vo_lines set applied_line_id = v_new, old_qty = 0, old_sell_rate = 0, old_est_cost = 0,
             applied_qty = (select qty from boq_lines where id = v_new) where id = l.id;
    else
      select * into b from boq_lines where id = l.boq_line_id for update;
      if b.project_id <> h.project_id then raise exception 'Variation line %: BOQ line belongs to another project', l.line_no; end if;
      v_commit := boq_committed_qty(b.id);
      if l.change_type = 'OMIT' then
        if v_commit > 0.0005 then raise exception 'Cannot omit "%": % already ordered / in production / delivered / installed — use CHANGE to reduce it to that', b.description, v_commit; end if;
        delete from boq_line_units where boq_line_id = b.id;
        update boq_lines set qty = 0, unit_type = null, unit_codes = null, qty_per_unit = null,
               remarks = coalesce(remarks || ' · ', '') || 'Omitted by ' || h.vo_no where id = b.id;
      else
        update boq_lines set description = coalesce(l.description, description), boq_ref = coalesce(l.boq_ref, boq_ref), item_id = coalesce(l.item_id, item_id),
               uom = coalesce(l.uom, uom), unit_type = coalesce(l.unit_type, unit_type), unit_codes = coalesce(l.unit_codes, unit_codes),
               qty_per_unit = coalesce(l.qty_per_unit, qty_per_unit), qty = coalesce(l.qty, qty), sell_rate = coalesce(l.sell_rate, sell_rate),
               est_unit_cost = coalesce(l.est_unit_cost, est_unit_cost), supply_mode = coalesce(l.supply_mode, supply_mode), service_mode = coalesce(l.service_mode, service_mode)
         where id = b.id;
        perform boq_sync_core(h.project_id, b.id);
        select qty into v_qty from boq_lines where id = b.id;
        if v_qty < v_commit - 0.0005 then raise exception '"%" cannot go below % (already ordered / in production / delivered / installed)', b.description, v_commit; end if;
      end if;
      update vo_lines set old_qty = b.qty, old_sell_rate = b.sell_rate, old_est_cost = b.est_unit_cost, applied_line_id = b.id,
             applied_qty = (select qty from boq_lines where id = b.id) where id = l.id;
    end if;
  end loop;
  update variation_orders set status = 'APPROVED' where id = p_vo;   -- v_vo_lines reads the stored before / after values once approved
  select coalesce(sum(value_change), 0), coalesce(sum(cost_change), 0) into v_val, v_cost from v_vo_lines where vo_id = p_vo;
  update variation_orders set status = 'APPROVED', value_change = v_val, cost_change = v_cost, approved_by = auth.uid(), approved_at = now(), approval_comments = p_comments where id = p_vo;
  update projects set contract_value = contract_value + v_val where id = h.project_id and contract_value is not null;
  perform notify('production_incharge', null, 'Variation ' || h.vo_no || ' approved', h.title, 'd/vo/' || p_vo, 'vo', p_vo);
  perform notify('finance', null, 'Variation ' || h.vo_no || ' approved', h.title || format(' — value %s AED', to_char(v_val, 'FMS999,999,990.00')), 'd/vo/' || p_vo, 'vo', p_vo);
  return 'APPROVED';
end $$;

alter table variation_orders enable row level security;
alter table vo_lines enable row level security;
create policy read_active on variation_orders for select to authenticated using (public.is_active_user());
create policy read_active on vo_lines for select to authenticated using (public.is_active_user());
create policy doc_insert on variation_orders for insert to authenticated with check (public.has_role('factory_manager','production_incharge','finance') and status = 'DRAFT');
create policy doc_update on variation_orders for update to authenticated
  using (public.has_role('factory_manager','production_incharge','finance') and status in ('DRAFT','REJECTED'))
  with check (public.has_role('factory_manager','production_incharge','finance') and status in ('DRAFT','REJECTED'));
create policy doc_delete on variation_orders for delete to authenticated using (public.has_role('factory_manager','production_incharge','finance') and status = 'DRAFT');
create policy line_write on vo_lines for all to authenticated
  using (public.has_role('factory_manager','production_incharge','finance') and exists (select 1 from variation_orders h where h.id = vo_lines.vo_id and h.status in ('DRAFT','REJECTED')))
  with check (public.has_role('factory_manager','production_incharge','finance') and exists (select 1 from variation_orders h where h.id = vo_lines.vo_id and h.status in ('DRAFT','REJECTED')));

-- ---------- projects overview (dashboard) ----------
create or replace view v_project_overview with (security_invoker = true) as
select p.id project_id, p.code, p.name, p.customer, p.end_date, p.billing_basis, p.boq_locked,
       (p.end_date - current_date) days_left,
       coalesce(b.boq_value, 0) boq_value, coalesce(b.earned, 0) earned_value,
       case when coalesce(b.boq_value, 0) > 0 then round(b.earned / b.boq_value * 100, 1) else 0 end progress_pct,
       coalesce(u.total, 0) units_total, coalesce(u.handed, 0) units_handed, coalesce(u.snagging, 0) units_snagging, coalesce(u.installed, 0) units_installed,
       case when p.end_date < current_date then coalesce(u.total, 0) - coalesce(u.handed, 0) else 0 end units_overdue,
       coalesce(w.open_wo, 0) wo_open, coalesce(w.late_wo, 0) wo_late,
       coalesce(v.pending, 0) vo_pending, coalesce(v.approved_value, 0) vo_approved_value,
       m.total_cost, m.margin, m.margin_pct
  from projects p
  left join (select project_id, sum(contract_value) boq_value, sum(earned_value) earned from v_boq_progress group by project_id) b on b.project_id = p.id
  left join (select project_id, count(*) total, count(*) filter (where status = 'HANDED_OVER') handed, count(*) filter (where status = 'SNAGGING') snagging,
                    count(*) filter (where status = 'INSTALLED') installed from project_units group by project_id) u on u.project_id = p.id
  left join (select project_id, count(*) filter (where status in ('DRAFT','RELEASED','IN_PROGRESS')) open_wo,
                    count(*) filter (where status in ('DRAFT','RELEASED','IN_PROGRESS') and due_date < current_date) late_wo from production_orders group by project_id) w on w.project_id = p.id
  left join (select project_id, count(*) filter (where status = 'SUBMITTED') pending, sum(value_change) filter (where status = 'APPROVED') approved_value
               from variation_orders group by project_id) v on v.project_id = p.id
  left join v_project_margin m on m.project_id = p.id
 where p.status = 'OPEN' and p.project_type = 'PROJECT';

grant execute on function public.project_lock_boq(uuid, boolean), public.vo_action(uuid, text, text), public.boq_sync_units(uuid) to authenticated;
revoke execute on function public.project_lock_boq(uuid, boolean), public.vo_action(uuid, text, text), public.boq_sync_units(uuid) from anon;
revoke execute on function public.boq_unit_count(uuid, text, text), public.boq_committed_qty(uuid), public.is_site_location(uuid), public.grn_is_site(uuid) from anon;
