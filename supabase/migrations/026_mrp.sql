-- =====================================================================
-- Citi Homes IMS - 026 Material planning (MRP) across all running projects
--   demand  = open production orders (still to issue) + made-in-house BOQ not yet on a production order
--             (x BOM template per unit) + bought-out BOQ not yet delivered + subcontract services not yet certified
--   supply  = project's own reserved stock + open project POs / requisitions,
--             then free stock + open stock POs allocated to projects by due date
-- =====================================================================

alter table purchase_requisitions drop constraint purchase_requisitions_source_check;
alter table purchase_requisitions add constraint purchase_requisitions_source_check check (source in ('MANUAL','BUFFER','MATERIAL_REQUEST','MRP'));

-- materials for ONE unit of a BOM template (cut list converted to sheets / m2 / m3 / m with waste + hardware)
create or replace view v_template_unit_materials with (security_invoker = true) as
with s as (select board_waste_pct bw, edge_waste_pct ew from company_settings where id = 1),
parts as (
  select p.template_id, i.id item_id,
         case when u.code = 'SQM' then sum(p.length_mm * p.width_mm * p.pieces) / 1e6
              when u.code = 'CBM' then sum(p.length_mm * p.width_mm * p.pieces) * max(i.thickness_mm) / 1e9
              when u.code = 'CFT' then sum(p.length_mm * p.width_mm * p.pieces) * max(i.thickness_mm) / 1e9 / 0.0283168
              when u.code in ('LM','MTR') then sum(p.length_mm * p.pieces) / 1000
              when coalesce(max(i.length_mm), 0) > 0 and coalesce(max(i.width_mm), 0) > 0
                then sum(p.length_mm * p.width_mm * p.pieces) / (max(i.length_mm) * max(i.width_mm)) end net
    from bom_template_parts p join items i on i.id = p.material_id join uoms u on u.id = i.uom_id
   group by p.template_id, i.id, u.code
), edge as (
  select template_id, edge_item_id item_id,
         sum(((case when edge_l1 then length_mm else 0 end) + (case when edge_l2 then length_mm else 0 end)
            + (case when edge_w1 then width_mm else 0 end) + (case when edge_w2 then width_mm else 0 end)) * pieces) / 1000 m
    from bom_template_parts where edge_item_id is not null group by template_id, edge_item_id
)
select template_id, item_id, round(sum(q), 4) qty_per_unit from (
  select template_id, item_id, net * (1 + s.bw / 100) q from parts, s where net is not null
  union all select template_id, item_id, m * (1 + s.ew / 100) from edge, s where m > 0
  union all select template_id, item_id, qty from bom_template_materials
) x group by template_id, item_id;

create or replace view v_mrp with (security_invoker = true) as
with live as (select id, code, project_type, end_date from projects where status = 'OPEN'),
issued as (
  select production_order_id wo_id, item_id, -sum(qty) qty from stock_ledger
   where production_order_id is not null and txn_type in ('ISSUE','RETURN') group by production_order_id, item_id
),
wo_demand as (    -- open production orders: still to be issued
  select w.project_id, m.item_id, greatest(sum(m.required_qty) - coalesce(max(i.qty), 0), 0) qty,
         coalesce(w.due_date, p.end_date) due, null::uuid boq_line_id, 'Production ' || w.wo_no src
    from production_orders w join live p on p.id = w.project_id join wo_materials m on m.wo_id = w.id
    left join issued i on i.wo_id = w.id and i.item_id = m.item_id
   where w.status in ('DRAFT','RELEASED','IN_PROGRESS')
   group by w.id, w.project_id, w.wo_no, w.due_date, p.end_date, m.item_id
),
boq_wo as (
  select boq_line_id, sum(qty) qty from production_orders where boq_line_id is not null and status <> 'CANCELLED' and not is_rework group by boq_line_id
),
mfg_demand as (   -- made in-house BOQ not yet on a production order x template materials per unit
  select b.project_id, t.item_id, (b.qty - coalesce(bw.qty, 0)) * t.qty_per_unit qty, p.end_date due, null::uuid boq_line_id,
         'BOQ ' || coalesce(b.boq_ref, b.line_no::text) || ' (to produce)' src
    from boq_lines b join live p on p.id = b.project_id left join boq_wo bw on bw.boq_line_id = b.id
    join v_template_unit_materials t on t.template_id = coalesce(b.template_id,
         (select id from bom_templates x where x.item_id = b.item_id and x.is_active order by version desc limit 1))
   where b.category = 'MANUFACTURED' and b.qty - coalesce(bw.qty, 0) > 0
),
dlv as (
  select d.boq_line_id, sum(d.qty) qty from dispatch_lines d join dispatch_notes n on n.id = d.dispatch_id
   where n.status in ('POSTED','DELIVERED') and d.boq_line_id is not null group by d.boq_line_id
),
cert as (
  select gl.boq_line_id, sum(gl.accepted_qty) qty from grn_lines gl join grns g on g.id = gl.grn_id
   where g.status = 'POSTED' and gl.boq_line_id is not null group by gl.boq_line_id
),
buy_demand as (   -- bought-out not yet delivered; subcontract / hired services not yet certified
  select b.project_id, b.item_id,
         greatest(b.qty - case when b.category = 'BOUGHT_OUT' then coalesce(dl.qty, 0) else coalesce(ce.qty, 0) end, 0) qty,
         p.end_date due, b.id boq_line_id, 'BOQ ' || coalesce(b.boq_ref, b.line_no::text) src
    from boq_lines b join live p on p.id = b.project_id left join dlv dl on dl.boq_line_id = b.id left join cert ce on ce.boq_line_id = b.id
   where b.item_id is not null and (b.category = 'BOUGHT_OUT' or (b.category = 'SERVICE' and coalesce(b.service_mode, 'SUBCONTRACT') <> 'OWN_TEAM'))
),
demand as (
  select project_id, item_id, sum(qty) gross, min(due) due, string_agg(distinct src, ', ') sources,
         case when count(*) = 1 then max(boq_line_id::text)::uuid end boq_line_id
    from (select * from wo_demand union all select * from mfg_demand union all select * from buy_demand) d
   where qty > 0.0005 group by project_id, item_id
),
pstock as (
  select l.project_id, l.item_id, sum(l.qty_on_hand) qty from stock_lots l join locations lc on lc.id = l.location_id
   where l.project_id is not null and l.status = 'AVAILABLE' and l.qty_on_hand > 0 and lc.loc_type not in ('QUARANTINE','SCRAP_YARD')
   group by l.project_id, l.item_id
),
ppo as (
  select pl.project_id, pl.item_id, sum(greatest(pl.qty - pl.received_qty, 0)) qty
    from po_lines pl join purchase_orders po on po.id = pl.po_id
   where po.status in ('DRAFT','PENDING_FM','PENDING_FINANCE','PENDING_TOP_MGMT','APPROVED','RELEASED','PARTIALLY_RECEIVED')
   group by pl.project_id, pl.item_id
),
ppr as (
  select l.project_id, l.item_id, sum(greatest(l.qty - l.ordered_qty, 0)) qty
    from pr_lines l join purchase_requisitions r on r.id = l.pr_id
   where r.status in ('DRAFT','SUBMITTED','PARTIAL_PO') group by l.project_id, l.item_id
),
free as (
  select i.id item_id,
         coalesce((select sum(l.qty_on_hand) from stock_lots l join locations lc on lc.id = l.location_id
                    where l.item_id = i.id and l.project_id is null and l.status = 'AVAILABLE' and lc.is_stock
                      and lc.loc_type not in ('QUARANTINE','SCRAP_YARD','FG_STORE')), 0)
       + coalesce((select sum(qty) from ppo where ppo.item_id = i.id and ppo.project_id is null), 0)
       + coalesce((select sum(qty) from ppr where ppr.item_id = i.id and ppr.project_id is null), 0) qty
    from items i where i.id in (select item_id from demand)
),
netted as (
  select d.*, p.code project_code, p.project_type,
         case when p.project_type = 'PROJECT' then coalesce(ps.qty, 0) else 0 end project_stock,
         coalesce(po.qty, 0) + coalesce(pr.qty, 0) project_on_order,
         greatest(d.gross - case when p.project_type = 'PROJECT' then coalesce(ps.qty, 0) else 0 end - coalesce(po.qty, 0) - coalesce(pr.qty, 0), 0) net
    from demand d join live p on p.id = d.project_id
    left join pstock ps on ps.project_id = d.project_id and ps.item_id = d.item_id
    left join ppo po on po.project_id = d.project_id and po.item_id = d.item_id
    left join ppr pr on pr.project_id = d.project_id and pr.item_id = d.item_id
),
alloc as (
  select n.*, f.qty free_supply,
         sum(n.net) over (partition by n.item_id order by n.due nulls last, n.project_code rows unbounded preceding) cum
    from netted n join free f on f.item_id = n.item_id
)
select a.project_id, a.project_code, a.project_type, a.item_id, i.code item_code, i.name item_name, u.code uom, c.code class_code,
       a.due due_date, round(a.gross, 3) gross_req, round(a.project_stock, 3) project_stock, round(a.project_on_order, 3) project_on_order,
       round(a.net, 3) net_req, round(a.free_supply, 3) free_supply,
       round(least(a.net, greatest(a.free_supply - (a.cum - a.net), 0)), 3) from_free,
       round(a.net - least(a.net, greatest(a.free_supply - (a.cum - a.net), 0)), 3) suggested_qty,
       i.moq, i.lead_time_days, a.boq_line_id, a.sources
  from alloc a join items i on i.id = a.item_id join uoms u on u.id = i.uom_id join item_classes c on c.id = i.class_id;

-- create requisitions from selected MRP rows: one per project (MTS demand goes to general stock)
-- p_lines: [{"project_id":..., "item_id":..., "qty":..., "required_date":..., "boq_line_id":...}]
create or replace function public.mrp_create_prs(p_lines jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare r record; v_pr uuid; v_n int := 0; v_prs int := 0; v_last uuid := '00000000-0000-0000-0000-000000000000'; v_proj uuid;
begin
  if not has_role('purchase','stores','production_incharge','factory_manager') then raise exception 'Not allowed'; end if;
  for r in select (e->>'project_id')::uuid project_id, (e->>'item_id')::uuid item_id, (e->>'qty')::numeric qty,
                  nullif(e->>'required_date', '')::date required_date, nullif(e->>'boq_line_id', '')::uuid boq_line_id, p.project_type, p.code
             from jsonb_array_elements(p_lines) e join projects p on p.id = (e->>'project_id')::uuid
            where (e->>'qty')::numeric > 0
            order by (e->>'project_id'), (e->>'item_id') loop
    if r.project_id <> v_last then
      v_proj := case when r.project_type = 'PROJECT' then r.project_id end;
      insert into purchase_requisitions (source, project_id, required_date, status, remarks)
      values ('MRP', v_proj, r.required_date, 'SUBMITTED', 'Material planning for ' || r.code)
      returning id into v_pr;
      v_prs := v_prs + 1; v_n := 0; v_last := r.project_id;
    end if;
    v_n := v_n + 1;
    insert into pr_lines (pr_id, line_no, item_id, qty, project_id, required_date, boq_line_id, remarks)
    values (v_pr, v_n, r.item_id, round(r.qty, 3), v_proj, r.required_date, r.boq_line_id, 'MRP — ' || r.code);
    update purchase_requisitions set required_date = least(coalesce(required_date, r.required_date), coalesce(r.required_date, required_date)) where id = v_pr;
  end loop;
  if v_prs = 0 then raise exception 'Select at least one line with a quantity'; end if;
  perform notify('purchase', null, v_prs || ' requisition(s) from material planning', 'Project materials to order', 'd/pr', 'pr', null);
  return v_prs;
end $$;
grant execute on function public.mrp_create_prs(jsonb) to authenticated;
revoke execute on function public.mrp_create_prs(jsonb) from anon;
