-- =====================================================================
-- Citi Homes IMS - 013 One-click requisition for a material request's shortage
-- =====================================================================
alter table purchase_requisitions add column mr_id uuid references material_requests(id);
alter table pr_lines add column mr_line_id uuid references mr_lines(id);
create index pr_mr_idx on purchase_requisitions(mr_id) where mr_id is not null;

-- shortage per line = still to issue - usable stock (free + own project reserved)
--                     - open PO qty for the same purpose - open requisition qty for the same purpose
create or replace function public.mr_shortage(p_mr uuid)
returns table (mr_line_id uuid, item_id uuid, pending numeric, usable numeric, on_order numeric, requested numeric, shortage numeric)
language sql stable security definer set search_path = public as $$
  with m as (select id, case when purpose = 'PROJECT' then project_id end as proj from material_requests where id = p_mr),
  lines as (
    select ml.id, ml.item_id, greatest(coalesce(ml.approved_qty, ml.requested_qty) - ml.issued_qty, 0) pending, m.proj
      from mr_lines ml cross join m where ml.mr_id = p_mr)
  select l.id, l.item_id, l.pending,
         coalesce(u.q, 0), coalesce(o.q, 0), coalesce(r.q, 0),
         greatest(l.pending - coalesce(u.q, 0) - coalesce(o.q, 0) - coalesce(r.q, 0), 0)
    from lines l
    left join lateral (select sum(s.qty_on_hand) q from stock_lots s join locations lc on lc.id = s.location_id
                        where s.item_id = l.item_id and s.qty_on_hand > 0 and s.status = 'AVAILABLE'
                          and lc.is_stock and lc.loc_type not in ('QUARANTINE','SCRAP_YARD')
                          and (s.project_id is null or s.project_id = l.proj)) u on true
    left join lateral (select sum(pl.qty - pl.received_qty) q from po_lines pl join purchase_orders po on po.id = pl.po_id
                        where pl.item_id = l.item_id and pl.project_id is not distinct from l.proj and pl.qty > pl.received_qty
                          and po.status in ('DRAFT','PENDING_FM','PENDING_FINANCE','PENDING_TOP_MGMT','APPROVED','RELEASED','PARTIALLY_RECEIVED')) o on true
    left join lateral (select sum(pr.qty - pr.ordered_qty) q from pr_lines pr join purchase_requisitions h on h.id = pr.pr_id
                        where pr.item_id = l.item_id and pr.project_id is not distinct from l.proj and pr.qty > pr.ordered_qty
                          and h.status in ('DRAFT','SUBMITTED','PARTIAL_PO')) r on true
$$;

create or replace function public.mr_raise_pr(p_mr uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare m material_requests%rowtype; v_proj uuid; v_pr uuid; r record; v_n int := 0;
begin
  if not has_role('stores','production_incharge','factory_manager','purchase') then raise exception 'Not allowed'; end if;
  select * into m from material_requests where id = p_mr;
  if not found then raise exception 'Request not found'; end if;
  if m.status not in ('APPROVED','PARTIALLY_ISSUED') then
    raise exception 'The request must be approved first (status %)', m.status;
  end if;
  v_proj := case when m.purpose = 'PROJECT' then m.project_id end;
  for r in select s.*, ml.line_no from mr_shortage(p_mr) s join mr_lines ml on ml.id = s.mr_line_id
            where s.shortage > 0.0005 order by ml.line_no loop
    if v_pr is null then
      insert into purchase_requisitions (source, project_id, required_date, status, mr_id, remarks)
      values ('MATERIAL_REQUEST', v_proj, m.required_date, 'SUBMITTED', m.id, 'Shortage against material request ' || m.mr_no)
      returning id into v_pr;
    end if;
    v_n := v_n + 1;
    insert into pr_lines (pr_id, line_no, item_id, qty, project_id, required_date, mr_line_id, remarks)
    values (v_pr, v_n, r.item_id, round(r.shortage, 3), v_proj, m.required_date, r.mr_line_id, 'From ' || m.mr_no);
  end loop;
  if v_pr is null then
    raise exception 'Nothing to order — stock, open POs or open requisitions already cover this request';
  end if;
  return v_pr;
end $$;
grant execute on function public.mr_shortage(uuid) to authenticated;
grant execute on function public.mr_raise_pr(uuid) to authenticated;
revoke execute on function public.mr_shortage(uuid) from anon;
revoke execute on function public.mr_raise_pr(uuid) from anon;

-- notify Purchase whenever a requisition is submitted (new or edited)
create or replace function public.trg_notify_pr() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_proj text; v_mr text;
begin
  if new.status <> 'SUBMITTED' or (tg_op = 'UPDATE' and old.status = 'SUBMITTED') then return new; end if;
  select code || ' — ' || name into v_proj from projects where id = new.project_id;
  select mr_no into v_mr from material_requests where id = new.mr_id;
  perform notify('purchase', null, 'Requisition ' || new.pr_no || ' submitted',
                 concat_ws(' · ', coalesce(v_proj, 'General stock'), 'from ' || v_mr), 'd/pr/' || new.id, 'pr', new.id);
  return new;
end $$;
revoke execute on function public.trg_notify_pr() from public, anon, authenticated;
create trigger notify_pr after insert or update of status on purchase_requisitions for each row execute function trg_notify_pr();
