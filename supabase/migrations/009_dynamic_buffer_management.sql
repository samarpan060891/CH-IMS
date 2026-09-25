-- =====================================================================
-- Citi Homes IMS - 009 Dynamic Buffer Management (suggest -> Purchase/FM approves)
-- =====================================================================
create extension if not exists pg_cron;

alter table company_settings
  add column dbm_min_red_days   int not null default 3,      -- RED run needed = max(lead time, this)
  add column dbm_min_green_days int not null default 14,     -- GREEN run needed = max(2 x lead time, this)
  add column dbm_step_pct       numeric(5,2) not null default 33.33;
alter table items add column buffer_reviewed_at date;       -- last time a suggestion was rejected

-- daily zone history (drives "too long in red / green")
create table buffer_zone_log (
  item_id           uuid not null references items(id) on delete cascade,
  log_date          date not null,
  zone              text,
  net_flow_position numeric(14,3),
  buffer_target     numeric(14,3),
  primary key (item_id, log_date)
);

-- suggestions + full history of buffer target changes
create table buffer_suggestions (
  id               uuid primary key default gen_random_uuid(),
  item_id          uuid not null references items(id) on delete cascade,
  created_at       timestamptz not null default now(),
  source           text not null default 'DBM' check (source in ('DBM','MANUAL')),
  direction        text not null check (direction in ('INCREASE','DECREASE')),
  current_target   numeric(14,3) not null,
  suggested_target numeric(14,3) not null,
  days_in_zone     int,
  reason           text,
  status           text not null default 'PENDING' check (status in ('PENDING','ACCEPTED','REJECTED','SUPERSEDED')),
  applied_target   numeric(14,3),
  decided_by       uuid references profiles(id),
  decided_at       timestamptz,
  comments         text
);
create unique index buffer_suggestions_one_pending on buffer_suggestions(item_id) where status = 'PENDING';
create index buffer_suggestions_item_idx on buffer_suggestions(item_id, created_at desc);

alter table buffer_zone_log enable row level security;
alter table buffer_suggestions enable row level security;
create policy read_active on buffer_zone_log for select to authenticated using (public.is_active_user());
create policy read_active on buffer_suggestions for select to authenticated using (public.is_active_user());

-- round a target to the item's order multiple / UoM decimals, never below MOQ
create or replace function public.dbm_round(p_item uuid, p_qty numeric, p_up boolean) returns numeric
language sql stable set search_path = public as $$
  select greatest(
           case when i.order_multiple > 0
                then (case when p_up then ceil(p_qty / i.order_multiple) else round(p_qty / i.order_multiple) end) * i.order_multiple
                else (case when p_up then ceil(p_qty * power(10, u.decimals)) / power(10, u.decimals) else round(p_qty, u.decimals) end) end,
           i.moq, case when i.order_multiple > 0 then i.order_multiple else 0 end)
    from items i join uoms u on u.id = i.uom_id where i.id = p_item
$$;

-- nightly run (also callable by Purchase / FM from the Buffer review screen)
create or replace function public.dbm_run() returns int
language plpgsql security definer set search_path = public as $$
declare
  s company_settings%rowtype; r record; v_need int; v_since date; v_run int; v_new numeric; v_dir text; v_count int := 0;
begin
  if auth.uid() is not null and not has_role('purchase','factory_manager') then raise exception 'Not allowed'; end if;
  select * into s from company_settings where id = 1;

  insert into buffer_zone_log (item_id, log_date, zone, net_flow_position, buffer_target)
  select item_id, current_date, buffer_zone, net_flow_position, buffer_target
    from v_item_stock where buffer_target > 0 and is_active
  on conflict (item_id, log_date) do update
     set zone = excluded.zone, net_flow_position = excluded.net_flow_position, buffer_target = excluded.buffer_target;

  for r in select i.id, i.code, i.buffer_target, i.lead_time_days, l.zone,
                  greatest(coalesce(i.buffer_adjusted_at, '1900-01-01'), coalesce(i.buffer_reviewed_at, '1900-01-01')) as last_touch
             from items i join buffer_zone_log l on l.item_id = i.id and l.log_date = current_date
            where i.dbm_enabled and i.is_active and i.buffer_target > 0
              and not exists (select 1 from buffer_suggestions b where b.item_id = i.id and b.status = 'PENDING') loop
    -- cool-down: one replenishment time after the last change / review
    continue when r.last_touch > current_date - greatest(r.lead_time_days, s.dbm_min_red_days);

    if r.zone in ('RED','BLACK') then
      v_dir := 'INCREASE'; v_need := greatest(r.lead_time_days, s.dbm_min_red_days);
      select max(log_date) into v_since from buffer_zone_log where item_id = r.id and zone not in ('RED','BLACK');
      select count(*) into v_run from buffer_zone_log
       where item_id = r.id and zone in ('RED','BLACK') and log_date > greatest(coalesce(v_since, '1900-01-01'), r.last_touch);
    elsif r.zone in ('GREEN','BLUE') then
      v_dir := 'DECREASE'; v_need := greatest(2 * r.lead_time_days, s.dbm_min_green_days);
      select max(log_date) into v_since from buffer_zone_log where item_id = r.id and zone not in ('GREEN','BLUE');
      select count(*) into v_run from buffer_zone_log
       where item_id = r.id and zone in ('GREEN','BLUE') and log_date > greatest(coalesce(v_since, '1900-01-01'), r.last_touch);
    else
      continue;
    end if;
    continue when v_run < v_need;

    if v_dir = 'INCREASE' then
      v_new := dbm_round(r.id, r.buffer_target * (1 + s.dbm_step_pct / 100), true);
    else
      v_new := dbm_round(r.id, r.buffer_target * (1 - s.dbm_step_pct / 100), false);
    end if;
    continue when v_new = r.buffer_target;

    insert into buffer_suggestions (item_id, direction, current_target, suggested_target, days_in_zone, reason)
    values (r.id, v_dir, r.buffer_target, v_new, v_run,
            case when v_dir = 'INCREASE'
                 then format('In RED %s days (limit %s). Too little protection — raise buffer.', v_run, v_need)
                 else format('In GREEN/above %s days (limit %s). Excess stock — lower buffer.', v_run, v_need) end);
    v_count := v_count + 1;
  end loop;

  if v_count > 0 then
    perform notify('purchase', null, v_count || ' buffer adjustment suggestion(s)', 'Review TOC buffer targets', 'buffers', null, null);
    perform notify('factory_manager', null, v_count || ' buffer adjustment suggestion(s)', 'Review TOC buffer targets', 'buffers', null, null);
  end if;
  return v_count;
end $$;

-- accept (optionally with an edited target) or reject
create or replace function public.dbm_decide(p_id uuid, p_action text, p_target numeric default null, p_comments text default null)
returns void language plpgsql security definer set search_path = public as $$
declare b buffer_suggestions%rowtype;
begin
  if not has_role('purchase','factory_manager') then raise exception 'Only Purchase or the Factory Manager can decide buffer changes'; end if;
  select * into b from buffer_suggestions where id = p_id for update;
  if not found or b.status <> 'PENDING' then raise exception 'Suggestion is no longer pending'; end if;
  perform set_config('ims.dbm_decide', '1', true);
  if p_action = 'ACCEPT' then
    if coalesce(p_target, b.suggested_target) <= 0 then raise exception 'Target must be greater than zero'; end if;
    update buffer_suggestions set status = 'ACCEPTED', applied_target = coalesce(p_target, b.suggested_target),
           decided_by = auth.uid(), decided_at = now(), comments = p_comments where id = p_id;
    update items set buffer_target = coalesce(p_target, b.suggested_target), buffer_adjusted_at = current_date where id = b.item_id;
  elsif p_action = 'REJECT' then
    update buffer_suggestions set status = 'REJECTED', decided_by = auth.uid(), decided_at = now(), comments = p_comments where id = p_id;
    update items set buffer_reviewed_at = current_date where id = b.item_id;
  else
    raise exception 'Unknown action %', p_action;
  end if;
end $$;

-- manual target edits in the item master: stamp the date, supersede pending suggestion, log history
create or replace function public.items_buffer_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.buffer_target is distinct from old.buffer_target then
    new.buffer_adjusted_at := current_date;
    if coalesce(current_setting('ims.dbm_decide', true), '') <> '1' then   -- not coming from dbm_decide
      update buffer_suggestions set status = 'SUPERSEDED', decided_at = now(), decided_by = auth.uid(),
             comments = 'Target changed manually in item master' where item_id = new.id and status = 'PENDING';
      if coalesce(old.buffer_target, 0) > 0 and coalesce(new.buffer_target, 0) > 0 then
        insert into buffer_suggestions (item_id, source, direction, current_target, suggested_target, status, applied_target, decided_by, decided_at, reason)
        values (new.id, 'MANUAL', case when new.buffer_target > old.buffer_target then 'INCREASE' else 'DECREASE' end,
                old.buffer_target, new.buffer_target, 'ACCEPTED', new.buffer_target, auth.uid(), now(), 'Manual change in item master');
      end if;
    end if;
  end if;
  return new;
end $$;
create trigger items_buffer_log before update of buffer_target on items for each row execute function items_buffer_log();

revoke execute on function public.dbm_round(uuid, numeric, boolean) from public, anon;
revoke execute on function public.items_buffer_log() from public, anon, authenticated;
grant execute on function public.dbm_run() to authenticated;
grant execute on function public.dbm_decide(uuid, text, numeric, text) to authenticated;
revoke execute on function public.dbm_run() from anon;
revoke execute on function public.dbm_decide(uuid, text, numeric, text) from anon;

-- 21:00 UTC = 01:00 UAE
select cron.schedule('dbm-nightly', '0 21 * * *', $$select public.dbm_run()$$);
