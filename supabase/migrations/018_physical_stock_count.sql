-- =====================================================================
-- Citi Homes IMS - 018 Physical stock count (blind count on phone -> FM-approved adjustment)
-- =====================================================================
create table stock_counts (
  id           uuid primary key default gen_random_uuid(),
  count_no     text not null unique default next_doc_no('CNT'),
  count_date   date not null default current_date,
  location_id  uuid not null references locations(id),
  class_id     uuid references item_classes(id),          -- optional: count one class only
  blind        boolean not null default true,              -- counters do not see system qty
  status       text not null default 'DRAFT' check (status in ('DRAFT','COUNTING','SUBMITTED','CLOSED','CANCELLED')),
  remarks      text,
  started_at   timestamptz,
  submitted_at timestamptz,
  adj_id       uuid references stock_adjustments(id),
  created_by   uuid default auth.uid() references profiles(id),
  created_at   timestamptz not null default now()
);
create table stock_count_lines (
  id          uuid primary key default gen_random_uuid(),
  count_id    uuid not null references stock_counts(id) on delete cascade,
  item_id     uuid not null references items(id),
  lot_id      uuid references stock_lots(id),               -- null = item found that the system did not have here
  lot_no      text,
  system_qty  numeric(14,3) not null default 0,            -- snapshot when counting started
  counted_qty numeric(14,3),
  counted_by  uuid references profiles(id),
  counted_at  timestamptz,
  note        text,
  found       boolean not null default false
);
create index stock_count_lines_count_idx on stock_count_lines(count_id);

alter table stock_counts enable row level security;
alter table stock_count_lines enable row level security;
create policy read_active on stock_counts for select to authenticated using (public.is_active_user());
create policy read_active on stock_count_lines for select to authenticated using (public.is_active_user());
create policy doc_insert on stock_counts for insert to authenticated with check (public.has_role('stores') and status = 'DRAFT');
create policy doc_update on stock_counts for update to authenticated
  using (public.has_role('stores') and status = 'DRAFT') with check (public.has_role('stores') and status = 'DRAFT');
create policy doc_delete on stock_counts for delete to authenticated using (public.has_role('stores') and status = 'DRAFT');

-- start: snapshot every lot at the location (optionally one class)
create or replace function public.count_start(p_count uuid) returns int
language plpgsql security definer set search_path = public as $$
declare h stock_counts%rowtype; n int;
begin
  if not has_role('stores') then raise exception 'Only Stores can start a count'; end if;
  select * into h from stock_counts where id = p_count for update;
  if h.status <> 'DRAFT' then raise exception 'Count is %', h.status; end if;
  insert into stock_count_lines (count_id, item_id, lot_id, lot_no, system_qty)
  select p_count, l.item_id, l.id, l.lot_no, l.qty_on_hand
    from stock_lots l join items i on i.id = l.item_id
   where l.location_id = h.location_id and l.qty_on_hand > 0 and (h.class_id is null or i.class_id = h.class_id)
   order by i.code, l.received_date;
  get diagnostics n = row_count;
  update stock_counts set status = 'COUNTING', started_at = now() where id = p_count;
  return n;
end $$;

create or replace function public.count_record(p_line uuid, p_qty numeric, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  if not has_role('stores') then raise exception 'Only Stores can record counts'; end if;
  select c.status into v_status from stock_count_lines l join stock_counts c on c.id = l.count_id where l.id = p_line;
  if v_status is distinct from 'COUNTING' then raise exception 'Count is not in progress'; end if;
  if p_qty is not null and p_qty < 0 then raise exception 'Counted qty cannot be negative'; end if;
  update stock_count_lines set counted_qty = p_qty, note = coalesce(p_note, note),
         counted_by = case when p_qty is null then null else auth.uid() end, counted_at = case when p_qty is null then null else now() end
   where id = p_line;
end $$;

create or replace function public.count_add_found(p_count uuid, p_item uuid, p_qty numeric, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_status text; v_id uuid;
begin
  if not has_role('stores') then raise exception 'Only Stores can record counts'; end if;
  select status into v_status from stock_counts where id = p_count;
  if v_status <> 'COUNTING' then raise exception 'Count is not in progress'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Enter the quantity found'; end if;
  if exists (select 1 from items i join item_classes c on c.id = i.class_id where i.id = p_item and c.tracking = 'SERIAL') then
    raise exception 'Tools and machines are counted in the asset register, not here';
  end if;
  insert into stock_count_lines (count_id, item_id, system_qty, counted_qty, counted_by, counted_at, note, found)
  values (p_count, p_item, 0, p_qty, auth.uid(), now(), coalesce(p_note, 'Found — not in system at this location'), true)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.count_submit(p_count uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare h stock_counts%rowtype; v_total int; v_counted int;
begin
  if not has_role('stores') then raise exception 'Only Stores can submit a count'; end if;
  select * into h from stock_counts where id = p_count for update;
  if h.status <> 'COUNTING' then raise exception 'Count is %', h.status; end if;
  select count(*), count(counted_qty) into v_total, v_counted from stock_count_lines where count_id = p_count;
  if v_counted = 0 then raise exception 'Nothing has been counted yet'; end if;
  update stock_counts set status = 'SUBMITTED', submitted_at = now() where id = p_count;
  return jsonb_build_object('lines', v_total, 'counted', v_counted, 'uncounted', v_total - v_counted);
end $$;

-- variances -> stock adjustment (pending FM approval); uncounted lines are left untouched
create or replace function public.count_to_adjustment(p_count uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare h stock_counts%rowtype; v_adj uuid; n int;
begin
  if not has_role('stores') then raise exception 'Only Stores can post a count'; end if;
  select * into h from stock_counts where id = p_count for update;
  if h.status <> 'SUBMITTED' then raise exception 'Submit the count first'; end if;
  insert into stock_adjustments (location_id, reason, adj_date, remarks)
  values (h.location_id, 'PHYSICAL_COUNT', current_date, 'Physical count ' || h.count_no) returning id into v_adj;
  insert into adjustment_lines (adj_id, item_id, lot_id, system_qty, counted_qty, remarks)
  select v_adj, l.item_id, l.lot_id, l.system_qty, l.counted_qty, coalesce(l.note, 'Count ' || h.count_no)
    from stock_count_lines l
   where l.count_id = p_count and l.counted_qty is not null and abs(l.counted_qty - l.system_qty) > 0.0005;
  get diagnostics n = row_count;
  if n = 0 then
    delete from stock_adjustments where id = v_adj;
    update stock_counts set status = 'CLOSED' where id = p_count;
    return null;                                   -- count matched the system: nothing to adjust
  end if;
  perform adj_action(v_adj, 'SUBMIT');             -- goes to the Factory Manager for approval
  update stock_counts set status = 'CLOSED', adj_id = v_adj where id = p_count;
  return v_adj;
end $$;

create or replace function public.count_cancel(p_count uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not has_role('stores') then raise exception 'Not allowed'; end if;
  update stock_counts set status = 'CANCELLED' where id = p_count and status in ('DRAFT','COUNTING','SUBMITTED');
  if not found then raise exception 'Count cannot be cancelled'; end if;
end $$;

grant execute on function public.count_start(uuid), public.count_record(uuid, numeric, text), public.count_add_found(uuid, uuid, numeric, text),
  public.count_submit(uuid), public.count_to_adjustment(uuid), public.count_cancel(uuid) to authenticated;
revoke execute on function public.count_start(uuid), public.count_record(uuid, numeric, text), public.count_add_found(uuid, uuid, numeric, text),
  public.count_submit(uuid), public.count_to_adjustment(uuid), public.count_cancel(uuid) from anon;

create or replace view public.v_count_variance with (security_invoker = true) as
select l.id line_id, l.count_id, c.count_no, c.status count_status, l.item_id, i.code item_code, i.name item_name, u.code uom,
       l.lot_id, l.lot_no, l.system_qty, l.counted_qty, l.found,
       case when l.counted_qty is null then null else l.counted_qty - l.system_qty end variance,
       case when l.counted_qty is null then null
            else round((l.counted_qty - l.system_qty) * coalesce(case when coalesce(i.valuation_override, cl.valuation_method) = 'WAVG' then i.avg_cost end,
                                                                   s.unit_cost, nullif(i.avg_cost, 0), i.last_purchase_rate, 0), 2) end variance_value,
       l.note, l.counted_at, p.full_name counted_by_name
  from stock_count_lines l
  join stock_counts c on c.id = l.count_id
  join items i on i.id = l.item_id join item_classes cl on cl.id = i.class_id join uoms u on u.id = i.uom_id
  left join stock_lots s on s.id = l.lot_id
  left join profiles p on p.id = l.counted_by;

-- notify FM is already done by adj_action SUBMIT (trigger on stock_adjustments)
