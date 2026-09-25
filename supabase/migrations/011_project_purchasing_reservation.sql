-- =====================================================================
-- Citi Homes IMS - 011 Project-specific purchasing & reserved stock
--   * PR / PO / GRN lines carry an optional project (blank = general stock)
--   * GRN of a project line creates a lot reserved for that project
--   * reserved lots can only be issued to their project
--   * leftover reserved stock is released to general stock via FM-approved release
--   * buffers / re-order use free stock and stock POs only
-- =====================================================================

alter table pr_lines  add column project_id uuid references projects(id);
alter table po_lines  add column project_id uuid references projects(id);
alter table grn_lines add column project_id uuid references projects(id);
create index po_lines_project_idx on po_lines(project_id) where project_id is not null;
create index stock_lots_project_idx on stock_lots(project_id, item_id) where project_id is not null and qty_on_hand > 0;

alter table stock_ledger drop constraint stock_ledger_txn_type_check;
alter table stock_ledger add constraint stock_ledger_txn_type_check check (txn_type in
  ('GRN','ISSUE','RETURN','TRANSFER_OUT','TRANSFER_IN','ADJ_IN','ADJ_OUT','SCRAP_WRITE_OFF','SCRAP_IN',
   'SCRAP_DISPOSAL','PURCHASE_RETURN','REVALUATION','RELEASE_OUT','RELEASE_IN'));

-- ---------- FIFO: own project first, then free stock; other projects' stock only for all-lot operations, and last ----------
create or replace function public.fifo_consume(
  p_item uuid, p_location uuid, p_qty numeric, p_project uuid,
  p_txn_type text, p_doc_type text, p_doc_id uuid, p_doc_no text, p_doc_line uuid, p_date date,
  p_ledger_project uuid default null, p_cost_center uuid default null,
  p_lot uuid default null, p_all_lots boolean default false)
returns table (lot_id uuid, qty numeric, unit_cost numeric)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare r record; v_need numeric := p_qty; v_take numeric; v_cost numeric; v_code text; v_reserved numeric;
begin
  if p_qty <= 0 then return; end if;
  for r in select l.id, l.qty_on_hand from stock_lots l
            where l.item_id = p_item and l.location_id = p_location and l.qty_on_hand > 0
              and (p_lot is null or l.id = p_lot)
              and (p_all_lots or p_lot is not null or l.status = 'AVAILABLE')
              and (p_all_lots or l.project_id is null or l.project_id = p_project)
            order by (p_project is not null and l.project_id = p_project) desc,   -- own reserved stock first
                     (l.project_id is not null) asc,                            -- then free stock, other projects last
                     l.expiry_date nulls last, l.received_date, l.created_at
            for update
  loop
    exit when v_need <= 0;
    v_take := least(v_need, r.qty_on_hand);
    v_cost := lot_issue_cost(r.id);
    update stock_lots set qty_on_hand = qty_on_hand - v_take where id = r.id;
    insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value,
                              doc_type, doc_id, doc_no, doc_line_id, project_id, cost_center_id)
    values (p_date, p_txn_type, p_item, p_location, r.id, -v_take, v_cost, -round(v_take * v_cost, 2),
            p_doc_type, p_doc_id, p_doc_no, p_doc_line, p_ledger_project, p_cost_center);
    lot_id := r.id; qty := v_take; unit_cost := v_cost;
    return next;
    v_need := v_need - v_take;
  end loop;
  if v_need > 0.0005 then
    select code into v_code from items where id = p_item;
    select coalesce(sum(l.qty_on_hand), 0) into v_reserved from stock_lots l
     where l.item_id = p_item and l.location_id = p_location and l.qty_on_hand > 0
       and l.project_id is not null and l.project_id is distinct from p_project;
    raise exception '%', format('Insufficient stock for %s at this location: short by %s%s', v_code, round(v_need, 3),
      case when v_reserved > 0 and not p_all_lots
           then format(' (%s more is reserved for other projects — ask the Factory Manager to release it)', round(v_reserved, 3))
           else '' end);
  end if;
end $$;
revoke execute on function public.fifo_consume(uuid,uuid,numeric,uuid,text,text,uuid,text,uuid,date,uuid,uuid,uuid,boolean) from public, anon, authenticated;

-- ---------- GRN: lots of project lines are reserved for that project ----------
create or replace function public.post_grn(p_grn uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  g grns%rowtype; l record; v_cls item_classes%rowtype; v_po purchase_orders%rowtype;
  v_tol numeric; v_goods_aed numeric; v_goods_qty numeric; v_chg_val numeric; v_chg_qty numeric;
  v_lc numeric; v_cost numeric; v_lot uuid; v_loc uuid; v_proj uuid; i int;
begin
  if not has_role('stores') then raise exception 'Only Stores can post a GRN'; end if;
  select * into g from grns where id = p_grn for update;
  if not found then raise exception 'GRN not found'; end if;
  if g.status <> 'DRAFT' then raise exception 'GRN % is already %', g.grn_no, g.status; end if;
  if not exists (select 1 from grn_lines where grn_id = p_grn and received_qty > 0) then
    raise exception 'GRN has no received quantities';
  end if;

  if g.receipt_type = 'PO' then
    select * into v_po from purchase_orders where id = g.po_id for update;
    if v_po.status not in ('RELEASED','PARTIALLY_RECEIVED') then
      raise exception 'PO % is not released (status %)', v_po.po_no, v_po.status;
    end if;
    if exists (select 1 from grn_lines gl left join po_lines pl on pl.id = gl.po_line_id
                where gl.grn_id = p_grn and (pl.id is null or pl.po_id <> g.po_id)) then
      raise exception 'Every GRN line must reference a line of PO %', v_po.po_no;
    end if;
    select grn_over_receipt_pct into v_tol from company_settings;
    for l in select gl.accepted_qty, pl.qty, pl.received_qty, i.code
               from grn_lines gl join po_lines pl on pl.id = gl.po_line_id join items i on i.id = gl.item_id
              where gl.grn_id = p_grn loop
      if l.accepted_qty + l.received_qty > l.qty * (1 + v_tol/100) + 0.0005 then
        raise exception 'Over-receipt on % : PO qty %, already received %, now %', l.code, l.qty, l.received_qty, l.accepted_qty;
      end if;
    end loop;
  end if;

  select coalesce(sum(accepted_qty * rate),0) * g.exchange_rate, coalesce(sum(accepted_qty),0)
    into v_goods_aed, v_goods_qty from grn_lines where grn_id = p_grn;
  select coalesce(sum(amount_aed) filter (where alloc_basis = 'VALUE'),0),
         coalesce(sum(amount_aed) filter (where alloc_basis = 'QTY'),0)
    into v_chg_val, v_chg_qty from grn_charges where grn_id = p_grn;
  if v_chg_val > 0 and v_goods_aed = 0 then raise exception 'Cannot allocate value-based charges on zero-value receipt'; end if;

  for l in select gl.*, it.class_id, it.code item_code, pl.project_id po_project
             from grn_lines gl join items it on it.id = gl.item_id
             left join po_lines pl on pl.id = gl.po_line_id
            where gl.grn_id = p_grn order by gl.line_no loop
    if l.po_line_id is not null then
      update po_lines set received_qty = received_qty + l.accepted_qty where id = l.po_line_id;
    end if;
    continue when l.accepted_qty <= 0;

    -- reservation: PO line project > GRN line project > customer-supplied header project
    v_proj := coalesce(l.po_project, l.project_id, case when g.receipt_type = 'CUSTOMER_SUPPLIED' then g.project_id end);
    if l.project_id is distinct from v_proj then update grn_lines set project_id = v_proj where id = l.id; end if;

    v_lc := 0;
    if v_goods_aed > 0 then v_lc := v_lc + v_chg_val * (l.rate * g.exchange_rate) / v_goods_aed; end if;
    if v_goods_qty > 0 then v_lc := v_lc + v_chg_qty / v_goods_qty; end if;
    v_cost := round(l.rate * g.exchange_rate + v_lc, 4);
    update grn_lines set landed_cost_per_unit = round(v_lc,4), unit_cost_aed = v_cost where id = l.id;

    select * into v_cls from item_classes where id = l.class_id;
    v_loc := coalesce(l.location_id, g.location_id, (select id from locations where code = 'MS'));

    if v_cls.tracking = 'SERIAL' then
      if l.accepted_qty <> trunc(l.accepted_qty) then
        raise exception 'Serialised item % must be received in whole numbers', l.item_code;
      end if;
      for i in 1 .. l.accepted_qty::int loop
        insert into assets (asset_tag, item_id, serial_no, grn_line_id, purchase_date, purchase_cost,
                            vendor_id, location_id, status, project_id)
        values (next_asset_tag(v_cls.code), l.item_id,
                case when coalesce(array_length(l.serial_nos,1),0) >= i then l.serial_nos[i] end,
                l.id, g.grn_date, v_cost, g.vendor_id, v_loc, 'IN_STORE', coalesce(v_proj, g.project_id));
      end loop;
      insert into stock_ledger (txn_date, txn_type, item_id, location_id, qty, unit_cost, value,
                                doc_type, doc_id, doc_no, doc_line_id, project_id, remarks)
      values (g.grn_date, 'GRN', l.item_id, v_loc, l.accepted_qty, v_cost, round(l.accepted_qty * v_cost, 2),
              'GRN', g.id, g.grn_no, l.id, coalesce(v_proj, g.project_id), 'Capitalised to asset register');
    else
      if item_valuation(l.item_id) = 'WAVG' then perform wavg_receive(l.item_id, l.accepted_qty, v_cost); end if;
      insert into stock_lots (item_id, location_id, lot_no, batch_no, source_type, source_id, received_date,
                              mfg_date, expiry_date, unit_cost, qty_in, qty_on_hand, vendor_id, project_id)
      values (l.item_id, v_loc, coalesce(nullif(l.lot_no,''), g.grn_no || '-' || l.line_no), l.batch_no,
              'GRN', l.id, coalesce(l.original_receipt_date, g.grn_date), l.mfg_date, l.expiry_date,
              v_cost, l.accepted_qty, l.accepted_qty, g.vendor_id, v_proj)
      returning id into v_lot;
      insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value,
                                doc_type, doc_id, doc_no, doc_line_id, project_id, remarks)
      values (g.grn_date, 'GRN', l.item_id, v_loc, v_lot, l.accepted_qty, v_cost,
              round(l.accepted_qty * v_cost, 2), 'GRN', g.id, g.grn_no, l.id, v_proj,
              case when v_proj is not null then 'Reserved for project' end);
    end if;

    if l.rate > 0 then update items set last_purchase_rate = v_cost where id = l.item_id; end if;
    if g.receipt_type = 'PO' then
      insert into item_vendors (item_id, vendor_id, price, currency)
      values (l.item_id, g.vendor_id, l.rate, g.currency)
      on conflict (item_id, vendor_id) do update set price = excluded.price, currency = excluded.currency;
    end if;
  end loop;

  if g.receipt_type = 'PO' then
    update purchase_orders set status = case
        when not exists (select 1 from po_lines where po_id = g.po_id and received_qty < qty) then 'RECEIVED'
        else 'PARTIALLY_RECEIVED' end
     where id = g.po_id;
  end if;

  update grns set status = 'POSTED', posted_at = now(), posted_by = auth.uid() where id = p_grn;
  insert into audit_log (entity, entity_id, action, details)
  values ('grn', p_grn, 'POSTED', jsonb_build_object('grn_no', g.grn_no));
end $$;

-- ---------- Release reserved stock to general stock (FM approval) ----------
create table stock_releases (
  id                uuid primary key default gen_random_uuid(),
  release_no        text not null unique default next_doc_no('REL'),
  release_date      date not null default current_date,
  project_id        uuid not null references projects(id),
  status            text not null default 'DRAFT' check (status in ('DRAFT','PENDING_APPROVAL','POSTED','REJECTED')),
  reason            text,
  total_value       numeric(16,2) not null default 0,
  created_by        uuid default auth.uid() references profiles(id),
  created_at        timestamptz not null default now(),
  approved_by       uuid references profiles(id),
  approved_at       timestamptz,
  approval_comments text
);
create table release_lines (
  id          uuid primary key default gen_random_uuid(),
  release_id  uuid not null references stock_releases(id) on delete cascade,
  lot_id      uuid not null references stock_lots(id),
  item_id     uuid not null references items(id),
  qty         numeric(14,3) not null check (qty > 0),
  value       numeric(16,2) not null default 0
);

create or replace function public.release_action(p_rel uuid, p_action text, p_comments text default null)
returns text language plpgsql security definer set search_path = public as $$
declare h stock_releases%rowtype; l record; lot stock_lots%rowtype; v_new uuid; v_cost numeric; v_total numeric := 0;
begin
  select * into h from stock_releases where id = p_rel for update;
  if not found then raise exception 'Release not found'; end if;
  if p_action = 'SUBMIT' then
    if not has_role('stores','production_incharge') then raise exception 'Not allowed'; end if;
    if h.status not in ('DRAFT','REJECTED') then raise exception 'Release is %', h.status; end if;
    if not exists (select 1 from release_lines where release_id = p_rel) then raise exception 'Release has no lines'; end if;
    update stock_releases set status = 'PENDING_APPROVAL' where id = p_rel; return 'PENDING_APPROVAL';
  elsif p_action = 'REJECT' then
    if not has_role('factory_manager') then raise exception 'Only the Factory Manager can reject'; end if;
    if h.status <> 'PENDING_APPROVAL' then raise exception 'Not pending approval'; end if;
    update stock_releases set status = 'REJECTED', approved_by = auth.uid(), approved_at = now(), approval_comments = p_comments where id = p_rel;
    return 'REJECTED';
  elsif p_action <> 'APPROVE' then raise exception 'Unknown action %', p_action; end if;

  if not has_role('factory_manager') then raise exception 'Only the Factory Manager can approve a release'; end if;
  if h.status <> 'PENDING_APPROVAL' then raise exception 'Not pending approval'; end if;
  for l in select * from release_lines where release_id = p_rel loop
    select * into lot from stock_lots where id = l.lot_id for update;
    if lot.project_id is distinct from h.project_id then raise exception 'Lot % is not reserved for this project', lot.lot_no; end if;
    if l.qty > lot.qty_on_hand + 0.0005 then raise exception 'Lot % has only % left', lot.lot_no, lot.qty_on_hand; end if;
    v_cost := lot_issue_cost(lot.id);
    update stock_lots set qty_on_hand = qty_on_hand - l.qty where id = lot.id;
    insert into stock_lots (item_id, location_id, lot_no, batch_no, source_type, source_id, parent_lot_id, received_date,
                            mfg_date, expiry_date, unit_cost, qty_in, qty_on_hand, vendor_id, project_id, status)
    values (lot.item_id, lot.location_id, lot.lot_no, lot.batch_no, 'TRANSFER', l.id, lot.id, lot.received_date,
            lot.mfg_date, lot.expiry_date, lot.unit_cost, l.qty, l.qty, lot.vendor_id, null, lot.status)
    returning id into v_new;
    insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value, doc_type, doc_id, doc_no, doc_line_id, project_id, remarks)
    values (h.release_date, 'RELEASE_OUT', lot.item_id, lot.location_id, lot.id, -l.qty, v_cost, -round(l.qty * v_cost, 2), 'REL', h.id, h.release_no, l.id, h.project_id, 'Released from project reservation'),
           (h.release_date, 'RELEASE_IN',  lot.item_id, lot.location_id, v_new,  l.qty, v_cost,  round(l.qty * v_cost, 2), 'REL', h.id, h.release_no, l.id, null, 'Released to general stock');
    update release_lines set value = round(l.qty * v_cost, 2) where id = l.id;
    v_total := v_total + round(l.qty * v_cost, 2);
  end loop;
  update stock_releases set status = 'POSTED', total_value = v_total, approved_by = auth.uid(), approved_at = now(), approval_comments = p_comments where id = p_rel;
  return 'POSTED';
end $$;
grant execute on function public.release_action(uuid, text, text) to authenticated;
revoke execute on function public.release_action(uuid, text, text) from anon;

alter table stock_releases enable row level security;
alter table release_lines enable row level security;
create policy read_active on stock_releases for select to authenticated using (public.is_active_user());
create policy read_active on release_lines for select to authenticated using (public.is_active_user());
create policy doc_insert on stock_releases for insert to authenticated
  with check (public.has_role('stores','production_incharge') and status in ('DRAFT','REJECTED'));
create policy doc_update on stock_releases for update to authenticated
  using (public.has_role('stores','production_incharge') and status in ('DRAFT','REJECTED'))
  with check (public.has_role('stores','production_incharge') and status in ('DRAFT','REJECTED'));
create policy doc_delete on stock_releases for delete to authenticated
  using (public.has_role('stores','production_incharge') and status in ('DRAFT','REJECTED'));
create policy line_write on release_lines for all to authenticated
  using (public.has_role('stores','production_incharge') and exists (select 1 from stock_releases h where h.id = release_lines.release_id and h.status in ('DRAFT','REJECTED')))
  with check (public.has_role('stores','production_incharge') and exists (select 1 from stock_releases h where h.id = release_lines.release_id and h.status in ('DRAFT','REJECTED')));

-- ---------- notifications: release approvals; project closed with reserved stock ----------
create or replace function public.trg_notify_release() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_proj text;
begin
  if new.status is not distinct from old.status then return new; end if;
  select code || ' — ' || name into v_proj from projects where id = new.project_id;
  if new.status = 'PENDING_APPROVAL' then
    perform notify('factory_manager', null, 'Stock release ' || new.release_no || ' awaits approval', 'Reserved stock of ' || v_proj || ' back to general stock', 'd/rel/' || new.id, 'rel', new.id);
  elsif new.status in ('POSTED','REJECTED') then
    perform notify(null, new.created_by, 'Stock release ' || new.release_no || ' ' || lower(new.status), coalesce(new.approval_comments, v_proj), 'd/rel/' || new.id, 'rel', new.id);
  end if;
  return new;
end $$;
revoke execute on function public.trg_notify_release() from public, anon, authenticated;
create trigger notify_status after update of status on stock_releases for each row execute function trg_notify_release();

create or replace function public.trg_project_closed() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_qty numeric; v_val numeric;
begin
  if new.status = 'CLOSED' and old.status <> 'CLOSED' then
    select coalesce(sum(l.qty_on_hand), 0), coalesce(sum(v.value), 0) into v_qty, v_val
      from stock_lots l join v_lot_values v on v.lot_id = l.id
     where l.project_id = new.id and l.qty_on_hand > 0;
    if v_qty > 0 then
      perform notify('stores', null, 'Project ' || new.code || ' closed with reserved stock', 'Raise a stock release so leftovers return to general stock', 'r/reserved', 'project', new.id);
      perform notify('factory_manager', null, 'Project ' || new.code || ' closed with reserved stock', 'AED ' || to_char(v_val, 'FM999,999,990.00') || ' still reserved', 'r/reserved', 'project', new.id);
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.trg_project_closed() from public, anon, authenticated;
create trigger project_closed after update of status on projects for each row execute function trg_project_closed();

-- ---------- reserved stock report ----------
create or replace view public.v_project_reserved with (security_invoker = true) as
select v.project_id, p.code project_code, p.name project_name, p.status project_status, p.project_type,
       v.item_id, v.item_code, v.item_name, v.uom, v.class_code, v.location_code, v.lot_id, v.lot_no, v.received_date, v.age_days,
       v.qty_on_hand, v.value_rate, v.value
  from v_lot_values v join projects p on p.id = v.project_id;

-- ---------- item stock: buffers / re-order on FREE stock and STOCK POs only ----------
drop view if exists public.v_item_stock;
create view public.v_item_stock with (security_invoker = true) as
with oh as (
  select item_id, sum(qty_on_hand) on_hand,
         sum(qty_on_hand) filter (where lot_status = 'AVAILABLE' and loc_type <> 'QUARANTINE' and project_id is null) available,
         sum(qty_on_hand) filter (where project_id is not null) reserved,
         sum(value) stock_value, sum(value) filter (where project_id is not null) reserved_value,
         min(received_date) oldest_receipt
    from v_lot_values group by item_id),
res_proj as (   -- reserved qty per project & item, to net project demand
  select item_id, project_id, sum(qty_on_hand) q from v_lot_values where project_id is not null group by item_id, project_id),
ast as (
  select item_id, count(*) filter (where status = 'IN_STORE') in_store,
         count(*) filter (where status not in ('SCRAPPED','DISPOSED','LOST')) total_units,
         sum(purchase_cost) filter (where status not in ('SCRAPPED','DISPOSED','LOST')) asset_value
    from assets group by item_id),
oo as (
  select pl.item_id,
         sum(pl.qty - pl.received_qty) filter (where pl.project_id is null) on_order,
         sum(pl.qty - pl.received_qty) filter (where pl.project_id is not null) on_order_projects
    from po_lines pl join purchase_orders po on po.id = pl.po_id
   where po.status in ('PENDING_FM','PENDING_FINANCE','PENDING_TOP_MGMT','APPROVED','RELEASED','PARTIALLY_RECEIVED')
     and pl.qty > pl.received_qty
   group by pl.item_id),
dem as (        -- open request demand not already covered by the project's own reserved stock
  select d.item_id, sum(greatest(d.q - coalesce(r.q, 0), 0)) demand
    from (select ml.item_id, m.project_id, sum(greatest(coalesce(ml.approved_qty, ml.requested_qty) - ml.issued_qty, 0)) q
            from mr_lines ml join material_requests m on m.id = ml.mr_id
           where m.status in ('PENDING_APPROVAL','APPROVED','PARTIALLY_ISSUED')
           group by ml.item_id, m.project_id) d
    left join res_proj r on r.item_id = d.item_id and r.project_id = d.project_id
   group by d.item_id),
cons as (
  select item_id, -sum(qty) qty90 from stock_ledger
   where txn_type in ('ISSUE','RETURN') and txn_date > current_date - 90 group by item_id),
lm as (
  select item_id, max(txn_date) filter (where txn_type = 'ISSUE') last_issue,
         max(txn_date) filter (where txn_type = 'GRN') last_receipt
    from stock_ledger group by item_id),
base as (
  select i.id item_id, i.code, i.name, i.is_active, c.code class_code, c.name class_name, c.tracking,
         cat.name category_name, u.code uom,
         case when c.tracking = 'SERIAL' then coalesce(ast.in_store,0) else coalesce(oh.on_hand,0) end on_hand,
         case when c.tracking = 'SERIAL' then coalesce(ast.in_store,0) else coalesce(oh.available,0) end available,
         coalesce(oh.reserved,0) reserved_qty,
         case when c.tracking = 'SERIAL' then coalesce(ast.asset_value,0) else coalesce(oh.stock_value,0) end stock_value,
         coalesce(oh.reserved_value,0) reserved_value,
         coalesce(ast.total_units,0) asset_units,
         coalesce(oo.on_order,0) on_order, coalesce(oo.on_order_projects,0) on_order_projects, coalesce(dem.demand,0) open_demand,
         i.buffer_target, i.safety_stock, i.reorder_level, i.reorder_qty, i.max_stock, i.moq, i.order_multiple,
         i.lead_time_days, i.avg_cost, i.last_purchase_rate,
         round(greatest(coalesce(cons.qty90,0),0) / 90.0, 4) avg_daily_consumption,
         oh.oldest_receipt, lm.last_issue, lm.last_receipt, s.overstock_months
    from items i
    join item_classes c on c.id = i.class_id
    join uoms u on u.id = i.uom_id
    left join item_categories cat on cat.id = i.category_id
    left join oh on oh.item_id = i.id
    left join ast on ast.item_id = i.id
    left join oo on oo.item_id = i.id
    left join dem on dem.item_id = i.id
    left join cons on cons.item_id = i.id
    left join lm on lm.item_id = i.id
    cross join company_settings s),
calc as (
  select b.*,
         b.available + b.on_order - b.open_demand as net_flow_position,
         case when b.avg_daily_consumption > 0 then round((b.on_hand - b.reserved_qty) / b.avg_daily_consumption, 1) end stock_cover_days
    from base b)
select c.*,
       case when c.buffer_target > 0 then
         case when c.available <= 0 then 'BLACK'
              when c.net_flow_position <= c.buffer_target / 3.0 then 'RED'
              when c.net_flow_position <= c.buffer_target * 2 / 3.0 then 'YELLOW'
              when c.net_flow_position <= c.buffer_target then 'GREEN'
              else 'BLUE' end
       end as buffer_zone,
       case when c.buffer_target > 0
            then round(100 * (c.buffer_target - c.net_flow_position) / c.buffer_target, 1) end as buffer_penetration_pct,
       case
         when c.available <= 0 and (c.buffer_target > 0 or c.reorder_level > 0 or c.safety_stock > 0 or c.avg_daily_consumption > 0)
              then 'STOCK_OUT'
         when c.safety_stock > 0 and c.available < c.safety_stock then 'BELOW_SAFETY'
         when c.buffer_target = 0 and c.reorder_level > 0 and c.net_flow_position <= c.reorder_level then 'REORDER'
         when (c.max_stock > 0 and c.on_hand - c.reserved_qty > c.max_stock)
           or (c.buffer_target > 0 and c.net_flow_position > c.buffer_target and c.available > c.buffer_target)
           or (c.stock_cover_days is not null and c.stock_cover_days > c.overstock_months * 30)
              then 'OVERSTOCK'
         when c.on_hand > 0 and c.avg_daily_consumption = 0 and c.last_issue is null
              and c.oldest_receipt < current_date - 180 then 'NON_MOVING'
         else 'OK' end as stock_status,
       (select case when q.base_qty <= 0 then 0
                    when c.order_multiple > 0 then ceil(greatest(q.base_qty, c.moq) / c.order_multiple) * c.order_multiple
                    else greatest(q.base_qty, c.moq) end
          from (select case
                  when c.buffer_target > 0 and (c.available <= 0 or c.net_flow_position <= c.buffer_target * 2 / 3.0)
                       then c.buffer_target - c.net_flow_position
                  when c.buffer_target = 0 and c.reorder_level > 0 and c.net_flow_position <= c.reorder_level
                       then greatest(c.reorder_qty, c.max_stock - c.net_flow_position)
                  else 0 end as base_qty) q) as suggested_order_qty
  from calc c;
