-- 097: progress claims bill on DISPATCHED quantities (dispatch first, then invoice)
-- earned_value = dispatched (capped at the BOQ qty) × sell rate; installed value kept as its own column
create or replace view v_boq_progress with (security_invoker = true) as
 WITH wo AS (
         SELECT w.boq_line_id,
            sum(w.qty) FILTER (WHERE NOT w.is_rework) AS wo_qty,
            sum(w.qty_completed) AS produced,
            sum(c.act_total - c.rework_out_value) AS cost
           FROM production_orders w
             JOIN v_wo_cost c ON c.wo_id = w.id
          WHERE w.boq_line_id IS NOT NULL AND w.status <> 'CANCELLED'::text
          GROUP BY w.boq_line_id
        ), po AS (
         SELECT pl.boq_line_id,
            sum(pl.qty) AS ordered
           FROM po_lines pl
             JOIN purchase_orders p_1 ON p_1.id = pl.po_id
          WHERE pl.boq_line_id IS NOT NULL AND (p_1.status <> ALL (ARRAY['CANCELLED'::text, 'REJECTED'::text]))
          GROUP BY pl.boq_line_id
        ), gr AS (
         SELECT gl.boq_line_id,
            sum(gl.accepted_qty) AS received,
            sum(gl.accepted_qty * gl.unit_cost_aed) AS value
           FROM grn_lines gl
             JOIN grns g ON g.id = gl.grn_id
          WHERE g.status = 'POSTED'::text AND gl.boq_line_id IS NOT NULL
          GROUP BY gl.boq_line_id
        ), dl AS (
         SELECT d.boq_line_id,
            sum(d.qty) AS delivered
           FROM dispatch_lines d
             JOIN dispatch_notes n ON n.id = d.dispatch_id
          WHERE (n.status = ANY (ARRAY['POSTED'::text, 'DELIVERED'::text])) AND d.boq_line_id IS NOT NULL
          GROUP BY d.boq_line_id
        ), ins AS (
         SELECT x.boq_line_id,
            sum(x.qty) AS installed
           FROM install_log_lines x
             JOIN install_logs y ON y.id = x.log_id
          WHERE y.status = 'POSTED'::text
          GROUP BY x.boq_line_id
        ), pc AS (
         SELECT project_costs.boq_line_id,
            sum(project_costs.amount) FILTER (WHERE project_costs.source = 'SERVICE_GRN'::text) AS service_cost,
            sum(project_costs.amount) FILTER (WHERE project_costs.source = 'INSTALL_LABOUR'::text) AS install_cost,
            sum(project_costs.amount) FILTER (WHERE project_costs.source = 'OTHER'::text) AS other_cost
           FROM project_costs
          WHERE project_costs.boq_line_id IS NOT NULL
          GROUP BY project_costs.boq_line_id
        )
 SELECT b.id AS boq_line_id,
    b.project_id,
    p.code AS project_code,
    p.name AS project_name,
    p.billing_basis,
    b.line_no,
    b.boq_ref,
    b.description,
    b.category,
    b.item_id,
    b.uom,
    b.qty,
    b.sell_rate,
    round(b.qty * b.sell_rate, 2) AS contract_value,
    round(b.qty * b.est_unit_cost, 2) AS est_cost,
    COALESCE(wo.wo_qty, 0::numeric) AS wo_qty,
    COALESCE(wo.produced, 0::numeric) AS produced_qty,
    COALESCE(po.ordered, 0::numeric) AS ordered_qty,
    COALESCE(gr.received, 0::numeric) AS received_qty,
    COALESCE(dl.delivered, 0::numeric) AS delivered_qty,
    COALESCE(ins.installed, 0::numeric) AS installed_qty,
        CASE
            WHEN b.qty > 0::numeric THEN round(LEAST(COALESCE(ins.installed, 0::numeric) / b.qty, 1::numeric) * 100::numeric, 1)
            ELSE NULL::numeric
        END AS installed_pct,
    round(COALESCE(dl.delivered, 0::numeric) * b.sell_rate, 2) AS delivered_value,
    round(LEAST(COALESCE(dl.delivered, 0::numeric), b.qty) * b.sell_rate, 2) AS earned_value,
    round(COALESCE(wo.cost, 0::numeric), 2) AS production_cost,
    round(
        CASE
            WHEN b.category = 'BOUGHT_OUT'::text THEN COALESCE(gr.value, 0::numeric)
            ELSE 0::numeric
        END, 2) AS purchase_cost,
    round(COALESCE(pc.service_cost, 0::numeric), 2) AS service_cost,
    round(COALESCE(pc.install_cost, 0::numeric), 2) AS install_cost,
    round(COALESCE(pc.other_cost, 0::numeric), 2) AS other_cost,
    round(COALESCE(wo.cost, 0::numeric) +
        CASE
            WHEN b.category = 'BOUGHT_OUT'::text THEN COALESCE(gr.value, 0::numeric)
            ELSE 0::numeric
        END + COALESCE(pc.service_cost, 0::numeric) + COALESCE(pc.install_cost, 0::numeric) + COALESCE(pc.other_cost, 0::numeric), 2) AS actual_cost,
    round(COALESCE(ins.installed, 0::numeric) * b.sell_rate, 2) AS installed_value
   FROM boq_lines b
     JOIN projects p ON p.id = b.project_id
     LEFT JOIN wo ON wo.boq_line_id = b.id
     LEFT JOIN po ON po.boq_line_id = b.id
     LEFT JOIN gr ON gr.boq_line_id = b.id
     LEFT JOIN dl ON dl.boq_line_id = b.id
     LEFT JOIN ins ON ins.boq_line_id = b.id
     LEFT JOIN pc ON pc.boq_line_id = b.id;

-- these lost security_invoker when replaced in 087 / 090 / 091
alter view v_boq_progress set (security_invoker = true);
alter view v_wo_cost set (security_invoker = true);
alter view wo_runs_nested_orders set (security_invoker = true);
