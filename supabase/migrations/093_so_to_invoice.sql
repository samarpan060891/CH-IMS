-- 093 Customer sales orders delivered (or services done / job-work hours logged) but not yet invoiced — for the
-- Dispatch & invoicing badge and list. An order whose invoice is already drafted shows it (has_draft) so it is not
-- counted twice with the draft-invoice badge.
create or replace view v_so_to_invoice with (security_invoker = true) as
  select o.id so_id, o.so_no, o.so_date, o.customer_id, c.name customer_name, o.project_id, o.delivery_date, o.status,
         count(*) lines_to_invoice,
         round(sum(x.billable * l.rate * (1 - coalesce(l.discount_pct, 0) / 100)), 2) value_to_invoice,
         exists (select 1 from sales_invoices s where s.project_id = o.project_id and s.inv_type = 'SALES' and s.status = 'DRAFT') has_draft,
         max(d.last_delivery) last_delivery
    from sales_orders o
    join customers c on c.id = o.customer_id
    join v_so_lines l on l.so_id = o.id
    cross join lateral (select greatest(case l.line_type when 'SERVICE' then l.service_done_qty when 'JOB_WORK' then l.hours_logged else l.delivered_qty end
                                        - l.invoiced_qty, 0) billable) x
    left join lateral (select max(n.dispatch_date) last_delivery from dispatch_notes n where n.project_id = o.project_id and n.status in ('POSTED', 'DELIVERED')) d on true
   where o.so_type = 'CUSTOMER' and o.status in ('CONFIRMED', 'CLOSED') and x.billable > 0.0005
   group by o.id, o.so_no, o.so_date, o.customer_id, c.name, o.project_id, o.delivery_date, o.status;
