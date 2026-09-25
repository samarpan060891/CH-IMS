-- =====================================================================
-- Citi Homes IMS - 014 Shop-floor acknowledgement of material received
-- =====================================================================
alter table material_issues
  add column ack_status  text check (ack_status in ('PENDING','ACKNOWLEDGED','DISCREPANCY')),
  add column ack_by      uuid references profiles(id),
  add column ack_at      timestamptz,
  add column ack_remarks text;
alter table issue_lines add column received_qty numeric(14,3);
create index material_issues_ack_idx on material_issues(ack_status) where ack_status = 'PENDING';

-- posting an issue opens the acknowledgement
create or replace function public.trg_issue_posted() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'POSTED' and old.status is distinct from 'POSTED' then
    new.ack_status := 'PENDING';
  end if;
  return new;
end $$;
create trigger issue_posted before update of status on material_issues for each row execute function trg_issue_posted();

create or replace function public.trg_issue_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_req uuid; v_mr text; v_for text;
begin
  select m.requested_by, m.mr_no into v_req, v_mr from material_requests m where m.id = new.mr_id;
  v_for := coalesce((select code || ' — ' || name from projects where id = new.project_id), (select code from cost_centers where id = new.cost_center_id), '');
  if new.status = 'POSTED' and old.status is distinct from 'POSTED' then
    perform notify(null, v_req, 'Material issued: ' || new.issue_no || ' — please acknowledge receipt', concat_ws(' · ', v_for, v_mr), 'd/ack/' || new.id, 'issue', new.id);
    perform notify('production_incharge', null, 'Acknowledge receipt: ' || new.issue_no, concat_ws(' · ', v_for, v_mr), 'd/ack/' || new.id, 'issue', new.id);
  elsif new.ack_status = 'DISCREPANCY' and old.ack_status is distinct from 'DISCREPANCY' then
    perform notify('stores', null, 'Receipt discrepancy on ' || new.issue_no, coalesce(new.ack_remarks, v_for), 'd/issue/' || new.id, 'issue', new.id);
    perform notify('factory_manager', null, 'Receipt discrepancy on ' || new.issue_no, coalesce(new.ack_remarks, v_for), 'd/issue/' || new.id, 'issue', new.id);
  end if;
  return new;
end $$;
create trigger issue_notify after update on material_issues for each row execute function trg_issue_notify();
revoke execute on function public.trg_issue_posted() from public, anon, authenticated;
revoke execute on function public.trg_issue_notify() from public, anon, authenticated;

-- p_lines: [{"line_id": "...", "received_qty": 12}]; lines not listed are taken as fully received
create or replace function public.issue_acknowledge(p_issue uuid, p_lines jsonb default '[]', p_remarks text default null)
returns text language plpgsql security definer set search_path = public as $$
declare h material_issues%rowtype; l record; v_rcv numeric; v_short boolean := false; v_over boolean := false;
begin
  if not has_role('shop_floor','production_incharge') then raise exception 'Only shop-floor users can acknowledge receipt'; end if;
  select * into h from material_issues where id = p_issue for update;
  if not found then raise exception 'Issue not found'; end if;
  if h.status <> 'POSTED' then raise exception 'Issue is not posted yet'; end if;
  if h.ack_status is distinct from 'PENDING' then raise exception 'Receipt already %', lower(coalesce(h.ack_status, 'n/a')); end if;
  for l in select * from issue_lines where issue_id = p_issue loop
    select (x->>'received_qty')::numeric into v_rcv from jsonb_array_elements(coalesce(p_lines, '[]')) x where (x->>'line_id')::uuid = l.id;
    v_rcv := coalesce(v_rcv, l.qty);
    if v_rcv < 0 then raise exception 'Received qty cannot be negative'; end if;
    if v_rcv < l.qty - 0.0005 then v_short := true; end if;
    if v_rcv > l.qty + 0.0005 then v_over := true; end if;
    update issue_lines set received_qty = v_rcv where id = l.id;
  end loop;
  if (v_short or v_over) and coalesce(p_remarks, '') = '' then
    raise exception 'Explain the difference in the remarks';
  end if;
  update material_issues set ack_status = case when v_short or v_over then 'DISCREPANCY' else 'ACKNOWLEDGED' end,
         ack_by = auth.uid(), ack_at = now(), ack_remarks = p_remarks
   where id = p_issue;
  return case when v_short or v_over then 'DISCREPANCY' else 'ACKNOWLEDGED' end;
end $$;
grant execute on function public.issue_acknowledge(uuid, jsonb, text) to authenticated;
revoke execute on function public.issue_acknowledge(uuid, jsonb, text) from anon;

-- Stores / FM close a discrepancy after investigating (return, adjustment or explanation)
create or replace function public.issue_resolve_discrepancy(p_issue uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_role('stores','factory_manager') then raise exception 'Only Stores or the Factory Manager can resolve'; end if;
  if coalesce(p_note, '') = '' then raise exception 'Describe how the discrepancy was resolved'; end if;
  update material_issues set ack_status = 'ACKNOWLEDGED',
         ack_remarks = coalesce(ack_remarks, '') || E'\nResolved: ' || p_note
   where id = p_issue and ack_status = 'DISCREPANCY';
  if not found then raise exception 'Issue has no open discrepancy'; end if;
end $$;
grant execute on function public.issue_resolve_discrepancy(uuid, text) to authenticated;
revoke execute on function public.issue_resolve_discrepancy(uuid, text) from anon;
