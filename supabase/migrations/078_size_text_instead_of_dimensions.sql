-- 078 Timber size as text, no dimension maths: the GRN records a free-text size / spec (e.g. "50 × 100 × 2500 mm") and
-- the pieces counted; the quantity (CBM, bundles…) is entered as received. Each lot keeps the size text and its pieces
-- per unit (pieces ÷ quantity), so requests and issues still show pieces next to the quantity.
alter table grn_lines add column if not exists size_text text;
alter table stock_lots add column if not exists size_text text;

create or replace function stock_lot_dims() returns trigger language plpgsql security definer set search_path = public as $$
declare g grn_lines%rowtype; p stock_lots%rowtype; v_dim boolean;
begin
  select i.dim_tracking into v_dim from items i where i.id = new.item_id;
  if not coalesce(v_dim, false) then return new; end if;
  if new.source_type = 'GRN' and new.source_id is not null and new.pcs_per_unit is null then
    select * into g from grn_lines where id = new.source_id;
    if found then
      if coalesce(g.pcs, 0) <= 0 then
        raise exception 'Enter the number of pieces for % on the GRN', (select code from items where id = new.item_id);
      end if;
      new.size_text := nullif(trim(g.size_text), '');
      new.thickness_mm := nullif(g.thickness_mm, 0); new.width_mm := nullif(g.width_mm, 0); new.length_mm := nullif(g.length_mm, 0);
      new.pcs_per_unit := g.pcs / nullif(g.received_qty, 0);
    end if;
  elsif new.parent_lot_id is not null and new.pcs_per_unit is null and not coalesce(new.is_offcut, false) then
    select * into p from stock_lots where id = new.parent_lot_id;
    if found then
      new.size_text := p.size_text; new.thickness_mm := p.thickness_mm; new.width_mm := coalesce(new.width_mm, p.width_mm);
      new.length_mm := coalesce(new.length_mm, p.length_mm); new.pcs_per_unit := p.pcs_per_unit;
    end if;
  end if;
  return new;
end $$;

-- existing lots: their size written as text once
update stock_lots set size_text = trim(to_char(thickness_mm, 'FM9999.##')) || ' × ' || trim(to_char(width_mm, 'FM9999.##')) || ' × ' || trim(to_char(length_mm, 'FM99999.##')) || ' mm'
 where size_text is null and thickness_mm is not null;
update grn_lines g set size_text = l.size_text from stock_lots l where l.source_type = 'GRN' and l.source_id = g.id and g.size_text is null and l.size_text is not null;

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
    COALESCE(nullif(l.size_text, ''),
      CASE WHEN l.pcs_per_unit IS NOT NULL THEN trim_scale(round(l.pcs_per_unit, 2))::text || ' pcs / ' || u.code END) AS size_text
   FROM stock_lots l
     JOIN items i ON i.id = l.item_id
     JOIN item_classes c ON c.id = i.class_id
     JOIN uoms u ON u.id = i.uom_id
     JOIN locations loc ON loc.id = l.location_id
     LEFT JOIN item_categories cat ON cat.id = i.category_id
  WHERE l.qty_on_hand > 0;
