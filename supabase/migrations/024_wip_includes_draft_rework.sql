-- Citi Homes IMS - 024: project WIP also counts draft orders (a draft rework order already carries the cost of its rejected units)
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
                  where w.project_id = p.id and r.qc_status = 'PENDING_FM'), 0) qc_pending_value
  from projects p;
