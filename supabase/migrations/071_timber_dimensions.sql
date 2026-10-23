-- 071 Timber by batch: section (thickness × width), length and number of pieces recorded at the GRN for items with
-- piece dimensions (solid timber in CBM). Each stock lot keeps its size and pieces per unit, so stock shows pieces
-- next to CBM, batch by batch. CBM = pieces × thickness × width × length / 1e9.
alter table items add column if not exists dim_tracking boolean not null default false;
comment on column items.dim_tracking is 'Received in pieces of a given section and length (timber); GRN asks for size + pieces';
update items i set dim_tracking = true
  from uoms u, item_categories c
 where u.id = i.uom_id and c.id = i.category_id and u.code = 'CBM' and c.code = 'RM-SWD';

alter table grn_lines
  add column if not exists thickness_mm numeric,
  add column if not exists width_mm numeric,
  add column if not exists length_mm numeric,
  add column if not exists pcs numeric;
alter table stock_lots
  add column if not exists thickness_mm numeric,
  add column if not exists pcs_per_unit numeric;   -- pieces per stock unit (per CBM for timber); pieces on hand = qty_on_hand × pcs_per_unit

-- a new lot takes its size from its GRN line, or from the lot it was split from (transfer, project release, return)
create or replace function stock_lot_dims() returns trigger language plpgsql security definer set search_path = public as $$
declare g grn_lines%rowtype; p stock_lots%rowtype; v_dim boolean;
begin
  select dim_tracking into v_dim from items where id = new.item_id;
  if not coalesce(v_dim, false) then return new; end if;
  if new.source_type = 'GRN' and new.source_id is not null and new.thickness_mm is null then
    select * into g from grn_lines where id = new.source_id;
    if found then
      if coalesce(g.pcs, 0) <= 0 or coalesce(g.thickness_mm, 0) <= 0 or coalesce(g.width_mm, 0) <= 0 or coalesce(g.length_mm, 0) <= 0 then
        raise exception 'Enter thickness, width, length and number of pieces for % on the GRN', (select code from items where id = new.item_id);
      end if;
      new.thickness_mm := g.thickness_mm; new.width_mm := g.width_mm; new.length_mm := g.length_mm;
      new.pcs_per_unit := g.pcs / nullif(g.received_qty, 0);
    end if;
  elsif new.parent_lot_id is not null and new.thickness_mm is null and not coalesce(new.is_offcut, false) then
    select * into p from stock_lots where id = new.parent_lot_id;
    if found then
      new.thickness_mm := p.thickness_mm; new.width_mm := coalesce(new.width_mm, p.width_mm);
      new.length_mm := coalesce(new.length_mm, p.length_mm); new.pcs_per_unit := p.pcs_per_unit;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_stock_lot_dims on stock_lots;
create trigger trg_stock_lot_dims before insert on stock_lots for each row execute function stock_lot_dims();

-- lot values with size and pieces (columns added at the end)
create or replace view v_lot_values with (security_invoker = true) as
 SELECT l.id AS lot_id, l.item_id, l.location_id, l.lot_no, l.batch_no, l.received_date, l.expiry_date, l.status AS lot_status, l.qty_on_hand, l.unit_cost,
    l.vendor_id, l.project_id, i.code AS item_code, i.name AS item_name, u.code AS uom, c.id AS class_id, c.code AS class_code, c.name AS class_name,
    cat.id AS category_id, cat.code AS category_code, cat.name AS category_name, loc.code AS location_code, loc.name AS location_name, loc.loc_type,
    COALESCE(i.valuation_override, c.valuation_method) AS valuation_method,
    CASE WHEN COALESCE(i.valuation_override, c.valuation_method) = 'WAVG' THEN i.avg_cost ELSE l.unit_cost END AS value_rate,
    round(l.qty_on_hand * CASE WHEN COALESCE(i.valuation_override, c.valuation_method) = 'WAVG' THEN i.avg_cost ELSE l.unit_cost END, 2) AS value,
    (CURRENT_DATE - l.received_date) AS age_days,
    CASE WHEN (CURRENT_DATE - l.received_date) <= 30 THEN '0-30' WHEN (CURRENT_DATE - l.received_date) <= 60 THEN '31-60'
         WHEN (CURRENT_DATE - l.received_date) <= 90 THEN '61-90' WHEN (CURRENT_DATE - l.received_date) <= 180 THEN '91-180'
         WHEN (CURRENT_DATE - l.received_date) <= 365 THEN '181-365' ELSE '365+' END AS age_bucket,
    l.is_offcut, l.length_mm, l.width_mm,
    l.thickness_mm,
    round(l.qty_on_hand * l.pcs_per_unit, 1) AS pcs_on_hand,
    CASE WHEN l.thickness_mm IS NOT NULL THEN trim(to_char(l.thickness_mm, 'FM9999.##')) || ' × ' || trim(to_char(l.width_mm, 'FM9999.##')) || ' × ' || trim(to_char(l.length_mm, 'FM99999.##')) || ' mm' END AS size_text
   FROM stock_lots l
     JOIN items i ON i.id = l.item_id
     JOIN item_classes c ON c.id = i.class_id
     JOIN uoms u ON u.id = i.uom_id
     JOIN locations loc ON loc.id = l.location_id
     LEFT JOIN item_categories cat ON cat.id = i.category_id
  WHERE l.qty_on_hand > 0;

-- pieces in stock per item (for the stock-in-hand report)
create or replace view v_item_pieces with (security_invoker = true) as
select l.item_id, round(sum(l.qty_on_hand * l.pcs_per_unit), 1) as pcs_on_hand, count(*) as lots
  from stock_lots l join locations loc on loc.id = l.location_id
 where l.qty_on_hand > 0 and l.pcs_per_unit is not null and loc.loc_type not in ('SCRAP_YARD')
 group by l.item_id;
