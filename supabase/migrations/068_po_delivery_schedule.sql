-- 068 PO delivery schedule: a PO line split into dated deliveries (e.g. 26 bundles on 5 Nov, 26 on 19 Nov …).
-- The schedule quantities of a line add up to the line quantity; GRNs are still posted against the PO line.
create table po_line_schedule (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references purchase_orders(id) on delete cascade,
  po_line_id uuid not null references po_lines(id) on delete cascade,
  line_no int,
  delivery_date date not null,
  qty numeric not null check (qty > 0),
  remarks text
);
create index on po_line_schedule (po_id);
create index on po_line_schedule (po_line_id);
alter table po_line_schedule enable row level security;
create policy read_active on po_line_schedule for select using (is_active_user());
create policy po_sched_write on po_line_schedule for all
  using (has_role('purchase', 'factory_manager') and exists (select 1 from purchase_orders p where p.id = po_id and p.status in ('DRAFT', 'REJECTED')))
  with check (has_role('purchase', 'factory_manager') and exists (select 1 from purchase_orders p where p.id = po_id and p.status in ('DRAFT', 'REJECTED')));

-- each scheduled delivery with what has been received against its line so far (received fills the earliest deliveries first)
create view v_po_schedule with (security_invoker = true) as
select s.id, s.po_id, s.po_line_id, s.delivery_date, s.qty, s.remarks,
       po.po_no, po.status as po_status, po.vendor_id, l.item_id, l.project_id,
       greatest(0, least(s.qty, l.received_qty - coalesce(sum(s.qty) over (partition by s.po_line_id order by s.delivery_date, s.line_no
                                                                      rows between unbounded preceding and 1 preceding), 0))) as received_qty
  from po_line_schedule s
  join po_lines l on l.id = s.po_line_id
  join purchase_orders po on po.id = s.po_id;
