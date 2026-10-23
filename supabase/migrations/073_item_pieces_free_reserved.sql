-- 073 Pieces split like the stock quantities: free (available, not quarantined, not reserved, not offcut) and reserved for projects
create or replace view v_item_pieces with (security_invoker = true) as
select l.item_id,
       round(sum(l.qty_on_hand * l.pcs_per_unit), 1) as pcs_on_hand,
       count(*) as lots,
       round(coalesce(sum(l.qty_on_hand * l.pcs_per_unit) filter (where l.status = 'AVAILABLE' and loc.loc_type <> 'QUARANTINE' and l.project_id is null and not l.is_offcut), 0), 1) as pcs_free,
       round(coalesce(sum(l.qty_on_hand * l.pcs_per_unit) filter (where l.project_id is not null), 0), 1) as pcs_reserved
  from stock_lots l join locations loc on loc.id = l.location_id
 where l.qty_on_hand > 0 and l.pcs_per_unit is not null and loc.loc_type not in ('SCRAP_YARD')
 group by l.item_id;
