-- =====================================================================
-- Citi Homes IMS - 006 Reporting views, row-level security, guards
-- =====================================================================

-- ---------- Lot-level valuation & aging ----------
create or replace view public.v_lot_values with (security_invoker = true) as
select l.id lot_id, l.item_id, l.location_id, l.lot_no, l.batch_no, l.received_date, l.expiry_date, l.status lot_status,
       l.qty_on_hand, l.unit_cost, l.vendor_id, l.project_id,
       i.code item_code, i.name item_name, u.code uom,
       c.id class_id, c.code class_code, c.name class_name,
       cat.id category_id, cat.code category_code, cat.name category_name,
       loc.code location_code, loc.name location_name, loc.loc_type,
       coalesce(i.valuation_override, c.valuation_method) valuation_method,
       case when coalesce(i.valuation_override, c.valuation_method) = 'WAVG' then i.avg_cost else l.unit_cost end value_rate,
       round(l.qty_on_hand * case when coalesce(i.valuation_override, c.valuation_method) = 'WAVG'
                                  then i.avg_cost else l.unit_cost end, 2) as value,
       current_date - l.received_date as age_days,
       case when current_date - l.received_date <= 30  then '0-30'
            when current_date - l.received_date <= 60  then '31-60'
            when current_date - l.received_date <= 90  then '61-90'
            when current_date - l.received_date <= 180 then '91-180'
            when current_date - l.received_date <= 365 then '181-365'
            else '365+' end as age_bucket
  from stock_lots l
  join items i on i.id = l.item_id
  join item_classes c on c.id = i.class_id
  join uoms u on u.id = i.uom_id
  join locations loc on loc.id = l.location_id
  left join item_categories cat on cat.id = i.category_id
 where l.qty_on_hand > 0;

-- ---------- Item stock status, TOC buffer zones, reorder suggestions ----------
create or replace view public.v_item_stock with (security_invoker = true) as
with oh as (
  select item_id, sum(qty_on_hand) on_hand,
         sum(qty_on_hand) filter (where lot_status = 'AVAILABLE' and loc_type <> 'QUARANTINE') available,
         sum(value) stock_value, min(received_date) oldest_receipt
    from v_lot_values group by item_id),
ast as (
  select item_id, count(*) filter (where status = 'IN_STORE') in_store,
         count(*) filter (where status not in ('SCRAPPED','DISPOSED','LOST')) total_units,
         sum(purchase_cost) filter (where status not in ('SCRAPPED','DISPOSED','LOST')) asset_value
    from assets group by item_id),
oo as (
  select pl.item_id, sum(pl.qty - pl.received_qty) on_order
    from po_lines pl join purchase_orders po on po.id = pl.po_id
   where po.status in ('PENDING_FM','PENDING_FINANCE','PENDING_TOP_MGMT','APPROVED','RELEASED','PARTIALLY_RECEIVED')
     and pl.qty > pl.received_qty
   group by pl.item_id),
dem as (
  select ml.item_id, sum(greatest(coalesce(ml.approved_qty, ml.requested_qty) - ml.issued_qty, 0)) demand
    from mr_lines ml join material_requests m on m.id = ml.mr_id
   where m.status in ('PENDING_APPROVAL','APPROVED','PARTIALLY_ISSUED')
   group by ml.item_id),
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
         case when c.tracking = 'SERIAL' then coalesce(ast.asset_value,0) else coalesce(oh.stock_value,0) end stock_value,
         coalesce(ast.total_units,0) asset_units,
         coalesce(oo.on_order,0) on_order, coalesce(dem.demand,0) open_demand,
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
         case when b.avg_daily_consumption > 0 then round(b.on_hand / b.avg_daily_consumption, 1) end stock_cover_days
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
         when (c.max_stock > 0 and c.on_hand > c.max_stock)
           or (c.buffer_target > 0 and c.net_flow_position > c.buffer_target and c.on_hand > c.buffer_target)
           or (c.stock_cover_days is not null and c.stock_cover_days > c.overstock_months * 30)
              then 'OVERSTOCK'
         when c.on_hand > 0 and c.avg_daily_consumption = 0 and c.last_issue is null
              and c.oldest_receipt < current_date - 180 then 'NON_MOVING'
         else 'OK' end as stock_status,
       -- replenishment suggestion honouring MOQ and order multiple
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

-- ---------- Valuation summaries (stock + fixed assets) ----------
create or replace view public.v_valuation_by_category with (security_invoker = true) as
select class_code, class_name, category_code, category_name, 'STOCK' as kind,
       count(distinct item_id) items, sum(qty_on_hand) qty, sum(value) value
  from v_lot_values group by class_code, class_name, category_code, category_name
union all
select c.code, c.name, cat.code, cat.name, 'ASSET', count(distinct a.item_id), count(*), sum(a.purchase_cost)
  from assets a join items i on i.id = a.item_id join item_classes c on c.id = i.class_id
  left join item_categories cat on cat.id = i.category_id
 where a.status not in ('SCRAPPED','DISPOSED','LOST')
 group by c.code, c.name, cat.code, cat.name;

create or replace view public.v_aging_summary with (security_invoker = true) as
select class_code, class_name, age_bucket, sum(qty_on_hand) qty, sum(value) value, count(*) lots
  from v_lot_values where loc_type <> 'SCRAP_YARD'
 group by class_code, class_name, age_bucket;

-- ---------- ABC analysis on last-12-month consumption value ----------
create or replace view public.v_abc_analysis with (security_invoker = true) as
with cons as (
  select item_id, -sum(qty) annual_qty, -sum(value) annual_value
    from stock_ledger where txn_type in ('ISSUE','RETURN') and txn_date > current_date - 365
   group by item_id having -sum(value) > 0),
ranked as (
  select c.*, sum(annual_value) over (order by annual_value desc, item_id rows between unbounded preceding and current row) cum,
         sum(annual_value) over () total, row_number() over (order by annual_value desc, item_id) rnk
    from cons c)
select r.item_id, i.code, i.name, cl.code class_code, u.code uom, r.annual_qty, r.annual_value, r.rnk as rank,
       round(100 * r.annual_value / r.total, 2) value_pct,
       round(100 * r.cum / r.total, 2) cumulative_pct,
       case when 100 * (r.cum - r.annual_value) / r.total < s.abc_a_pct then 'A'
            when 100 * (r.cum - r.annual_value) / r.total < s.abc_b_pct then 'B'
            else 'C' end as abc_class
  from ranked r join items i on i.id = r.item_id join item_classes cl on cl.id = i.class_id
  join uoms u on u.id = i.uom_id cross join company_settings s;

-- ---------- Project / MTS material consumption ----------
create or replace view public.v_project_consumption with (security_invoker = true) as
select p.id project_id, p.code, p.name, p.project_type, p.status, p.budget_material,
       coalesce(-sum(sl.value) filter (where sl.txn_type = 'ISSUE'), 0)  issued_value,
       coalesce(sum(sl.value) filter (where sl.txn_type = 'RETURN'), 0)  returned_value,
       coalesce(-sum(sl.value) filter (where sl.txn_type in ('ISSUE','RETURN')), 0) net_consumption,
       max(sl.txn_date) last_movement
  from projects p left join stock_ledger sl on sl.project_id = p.id
 group by p.id;

-- ---------- Asset register with custody / calibration flags ----------
create or replace view public.v_asset_register with (security_invoker = true) as
select a.*, i.code item_code, i.name item_name, c.code class_code, c.name class_name, c.is_returnable,
       loc.name location_name, e.name custodian_name, e.emp_code custodian_code,
       lastmv.due_back, lastmv.moved_at last_moved_at,
       (a.status = 'ISSUED' and lastmv.due_back is not null and lastmv.due_back < current_date) as is_overdue,
       case when a.calibration_due_date is null then null
            when a.calibration_due_date < current_date then 'OVERDUE'
            when a.calibration_due_date <= current_date + 30 then 'DUE_SOON'
            else 'OK' end as calibration_status
  from assets a
  join items i on i.id = a.item_id
  join item_classes c on c.id = i.class_id
  left join locations loc on loc.id = a.location_id
  left join employees e on e.id = a.custodian_employee_id
  left join lateral (select m.due_back, m.moved_at from asset_movements m
                      where m.asset_id = a.id and m.move_type = 'ISSUE' order by m.moved_at desc limit 1) lastmv on true;

-- =====================================================================
-- Guards: block direct edits of system-maintained columns from the API
-- (posting functions run as the table owner, so they pass)
-- =====================================================================
create or replace function public.items_guard() returns trigger
language plpgsql as $$
begin
  if current_user in ('authenticated','anon') then
    if new.avg_cost is distinct from old.avg_cost or new.last_purchase_rate is distinct from old.last_purchase_rate then
      raise exception 'Average cost and last purchase rate are system maintained';
    end if;
    if new.class_id is distinct from old.class_id or new.valuation_override is distinct from old.valuation_override
       or new.uom_id is distinct from old.uom_id then
      if exists (select 1 from stock_ledger where item_id = old.id) then
        raise exception 'Class, valuation method and UoM cannot change once the item has transactions';
      end if;
    end if;
  end if;
  return new;
end $$;
create trigger items_guard before update on items for each row execute function items_guard();

create or replace function public.assets_guard() returns trigger
language plpgsql as $$
begin
  if current_user in ('authenticated','anon') and (
       new.status is distinct from old.status or new.location_id is distinct from old.location_id
    or new.custodian_employee_id is distinct from old.custodian_employee_id
    or new.purchase_cost is distinct from old.purchase_cost or new.item_id is distinct from old.item_id
    or new.calibration_due_date is distinct from old.calibration_due_date) then
    raise exception 'Use asset movements to change status, location, custodian or calibration';
  end if;
  return new;
end $$;
create trigger assets_guard before update on assets for each row execute function assets_guard();

create or replace function public.profiles_guard() returns trigger
language plpgsql as $$
begin
  if current_user in ('authenticated','anon') and old.id = auth.uid()
     and (new.role is distinct from old.role or new.is_active is distinct from old.is_active) then
    raise exception 'You cannot change your own role or activation';
  end if;
  return new;
end $$;
create trigger profiles_guard before update on profiles for each row execute function profiles_guard();

-- =====================================================================
-- Row level security
-- =====================================================================
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    if t not in ('doc_sequences') then
      execute format('create policy read_active on public.%I for select to authenticated using (public.is_active_user())', t);
    end if;
  end loop;
end $$;

create policy read_self on profiles for select to authenticated using (id = auth.uid());
create policy admin_update on profiles for update to authenticated
  using (public.has_role(variadic '{}'::app_role[])) with check (public.has_role(variadic '{}'::app_role[]));

-- master data: full write for given roles (admin always)
do $$
declare r record;
begin
  for r in select * from (values
      ('items','{stores,purchase}'), ('item_categories','{stores,purchase}'), ('item_vendors','{stores,purchase}'),
      ('uoms','{stores,purchase}'), ('locations','{stores}'), ('vendors','{purchase,finance}'),
      ('payment_terms','{purchase,finance}'), ('item_classes','{}'), ('company_settings','{}'),
      ('projects','{factory_manager,production_incharge}'), ('employees','{stores,factory_manager,production_incharge}'),
      ('cost_centers','{factory_manager,finance}')
    ) as v(tbl, roles) loop
    execute format('create policy write_roles on public.%I for all to authenticated
                      using (public.has_role(variadic %L::app_role[]))
                      with check (public.has_role(variadic %L::app_role[]))', r.tbl, r.roles, r.roles);
  end loop;
end $$;
create policy stores_update on assets for update to authenticated
  using (public.has_role('stores')) with check (public.has_role('stores'));

-- document headers: editable only while in an editable status
do $$
declare r record;
begin
  for r in select * from (values
      ('purchase_requisitions','{stores,purchase,production_incharge,factory_manager}','{DRAFT,SUBMITTED,CANCELLED}'),
      ('purchase_orders','{purchase}','{DRAFT,REJECTED}'),
      ('grns','{stores}','{DRAFT}'),
      ('material_requests','{shop_floor,production_incharge,stores}','{DRAFT,REJECTED}'),
      ('material_issues','{stores}','{DRAFT}'),
      ('material_returns','{stores}','{DRAFT}'),
      ('stock_transfers','{stores}','{DRAFT}'),
      ('stock_adjustments','{stores}','{DRAFT,REJECTED}'),
      ('scrap_notes','{stores,production_incharge}','{DRAFT,REJECTED}'),
      ('scrap_disposals','{stores}','{DRAFT,REJECTED}'),
      ('purchase_returns','{stores,purchase}','{DRAFT}'),
      ('vendor_invoices','{finance}','{DRAFT}'),
      ('vendor_debit_notes','{finance}','{DRAFT}'),
      ('vendor_payments','{finance}','{DRAFT}')
    ) as v(tbl, roles, sts) loop
    execute format('create policy doc_insert on public.%I for insert to authenticated
                      with check (public.has_role(variadic %L::app_role[]) and status = any(%L::text[]))', r.tbl, r.roles, r.sts);
    execute format('create policy doc_update on public.%I for update to authenticated
                      using (public.has_role(variadic %L::app_role[]) and status = any(%L::text[]))
                      with check (public.has_role(variadic %L::app_role[]) and status = any(%L::text[]))',
                   r.tbl, r.roles, r.sts, r.roles, r.sts);
    execute format('create policy doc_delete on public.%I for delete to authenticated
                      using (public.has_role(variadic %L::app_role[]) and status = any(%L::text[]))', r.tbl, r.roles, r.sts);
  end loop;
end $$;

-- document lines: editable only while the parent is editable
do $$
declare r record;
begin
  for r in select * from (values
      ('pr_lines','pr_id','purchase_requisitions','{stores,purchase,production_incharge,factory_manager}','{DRAFT,SUBMITTED}'),
      ('po_lines','po_id','purchase_orders','{purchase}','{DRAFT,REJECTED}'),
      ('grn_lines','grn_id','grns','{stores}','{DRAFT}'),
      ('grn_charges','grn_id','grns','{stores,purchase,finance}','{DRAFT}'),
      ('mr_lines','mr_id','material_requests','{shop_floor,production_incharge,stores}','{DRAFT,REJECTED,PENDING_APPROVAL}'),
      ('issue_lines','issue_id','material_issues','{stores}','{DRAFT}'),
      ('return_lines','return_id','material_returns','{stores}','{DRAFT}'),
      ('transfer_lines','transfer_id','stock_transfers','{stores}','{DRAFT}'),
      ('adjustment_lines','adj_id','stock_adjustments','{stores}','{DRAFT,REJECTED}'),
      ('scrap_lines','scrap_id','scrap_notes','{stores,production_incharge}','{DRAFT,REJECTED}'),
      ('disposal_lines','disposal_id','scrap_disposals','{stores}','{DRAFT,REJECTED}'),
      ('prt_lines','prt_id','purchase_returns','{stores,purchase}','{DRAFT}'),
      ('vendor_invoice_lines','invoice_id','vendor_invoices','{finance}','{DRAFT}'),
      ('payment_allocations','payment_id','vendor_payments','{finance}','{DRAFT}')
    ) as v(tbl, fk, parent, roles, sts) loop
    execute format('create policy line_write on public.%I for all to authenticated
                      using (public.has_role(variadic %L::app_role[])
                             and exists (select 1 from public.%I h where h.id = %I.%I and h.status = any(%L::text[])))
                      with check (public.has_role(variadic %L::app_role[])
                             and exists (select 1 from public.%I h where h.id = %I.%I and h.status = any(%L::text[])))',
                   r.tbl, r.roles, r.parent, r.tbl, r.fk, r.sts, r.roles, r.parent, r.tbl, r.fk, r.sts);
  end loop;
end $$;

-- =====================================================================
-- Function privileges: nothing callable anonymously
-- =====================================================================
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
alter default privileges in schema public revoke execute on functions from public, anon;
