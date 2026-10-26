-- 098: v_sales_orders / v_so_lines run as the caller (security_invoker), like every other view.
-- Sales invoices are readable only by finance / FM / stores, so the invoiced totals the sales-order screens show
-- come from two definer helpers that return just the number (no invoice rows exposed).
create or replace function so_line_invoiced_qty(p_line uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select case when is_active_user() then coalesce((select sum(il.cum_qty - il.prev_qty)
    from sales_invoice_lines il join sales_invoices i on i.id = il.invoice_id
   where il.so_line_id = p_line and i.status <> 'CANCELLED'), 0) end
$$;
create or replace function project_advance_invoiced(p_project uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select case when is_active_user() then coalesce((select sum(i.taxable_amount) from sales_invoices i
   where i.project_id = p_project and i.inv_type = 'ADVANCE' and i.status = 'POSTED'), 0) end
$$;
revoke execute on function so_line_invoiced_qty(uuid), project_advance_invoiced(uuid) from public, anon;
grant execute on function so_line_invoiced_qty(uuid), project_advance_invoiced(uuid) to authenticated;

create or replace view v_so_lines with (security_invoker = true) as
 SELECT l.id, l.so_id, l.line_no, l.line_type, l.item_id, l.work_center_id, l.description, l.qty, l.uom, l.rate, l.discount_pct, l.amount,
    l.est_unit_cost, l.production_order_id, l.service_done_qty, l.remarks,
    o.so_no, o.so_type, o.status AS so_status, o.project_id,
    COALESCE(( SELECT sum(d.qty) FROM dispatch_lines d JOIN dispatch_notes n ON n.id = d.dispatch_id
          WHERE d.so_line_id = l.id AND n.status = ANY (ARRAY['POSTED'::text, 'DELIVERED'::text])), 0::numeric) AS delivered_qty,
    COALESCE(( SELECT sum(j.machine_hours) FROM so_job_logs j WHERE j.so_line_id = l.id), 0::numeric) AS hours_logged,
    COALESCE(( SELECT sum(j.cost) FROM so_job_logs j WHERE j.so_line_id = l.id), 0::numeric) AS job_cost,
    COALESCE(so_line_invoiced_qty(l.id), 0::numeric) AS invoiced_qty,
    w.wo_no, w.status AS wo_status, w.qty_completed AS wo_completed
   FROM sales_order_lines l
     JOIN sales_orders o ON o.id = l.so_id
     LEFT JOIN production_orders w ON w.id = l.production_order_id;

create or replace view v_sales_orders with (security_invoker = true) as
 SELECT o.id, o.so_no, o.so_date, o.so_type, o.customer_id, o.cost_center_id, o.quotation_id, o.title, o.customer_ref, o.delivery_date,
    o.delivery_address, o.advance_pct, o.payment_term_id, o.vat_rate, o.subtotal, o.vat_amount, o.total, o.est_cost, o.status, o.project_id,
    o.approval_comments, o.remarks, o.created_by, o.created_at, o.confirmed_by, o.confirmed_at,
    c.name AS customer_name,
    cc.code AS cost_center_code,
    round(COALESCE(x.delivered_value, 0::numeric), 2) AS delivered_value,
    round(COALESCE(x.invoiced_value, 0::numeric), 2) AS invoiced_value,
    COALESCE(project_advance_invoiced(o.project_id), 0::numeric) AS advance_invoiced,
    round(COALESCE(m.total_cost, 0::numeric) + COALESCE(x.job_cost, 0::numeric), 2) AS actual_cost,
        CASE WHEN o.so_type = 'CUSTOMER'::text THEN round(o.subtotal - COALESCE(m.total_cost, 0::numeric) - COALESCE(x.job_cost, 0::numeric), 2)
            ELSE NULL::numeric END AS margin,
        CASE WHEN o.so_type = 'CUSTOMER'::text AND o.subtotal > 0::numeric
            THEN round((o.subtotal - COALESCE(m.total_cost, 0::numeric) - COALESCE(x.job_cost, 0::numeric)) / o.subtotal * 100::numeric, 1)
            ELSE NULL::numeric END AS margin_pct,
        CASE WHEN o.subtotal > 0::numeric THEN round(COALESCE(x.delivered_value, 0::numeric) / o.subtotal * 100::numeric)
            ELSE 0::numeric END AS delivered_pct
   FROM sales_orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN cost_centers cc ON cc.id = o.cost_center_id
     LEFT JOIN v_project_margin m ON m.project_id = o.project_id
     LEFT JOIN LATERAL ( SELECT sum(
                CASE
                    WHEN l.line_type = ANY (ARRAY['MADE'::text, 'STOCK'::text]) THEN LEAST(l.delivered_qty, l.qty) / l.qty * l.amount
                    WHEN l.line_type = 'JOB_WORK'::text THEN LEAST(l.hours_logged, l.qty) / l.qty * l.amount
                    ELSE LEAST(GREATEST(l.service_done_qty, l.invoiced_qty), l.qty) / l.qty * l.amount
                END) AS delivered_value,
            sum(LEAST(l.invoiced_qty, l.qty) / l.qty * l.amount) AS invoiced_value,
            sum(l.job_cost) AS job_cost
           FROM v_so_lines l
          WHERE l.so_id = o.id) x ON true;

alter view v_so_lines set (security_invoker = true);
alter view v_sales_orders set (security_invoker = true);
