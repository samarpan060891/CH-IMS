-- =====================================================================
-- Citi Homes IMS - 008 Scrap disposal 2-step approval (FM -> Finance), notifications
-- =====================================================================

-- ---------- Scrap disposal: FM then Finance ----------
alter table scrap_disposals drop constraint scrap_disposals_status_check;
alter table scrap_disposals add constraint scrap_disposals_status_check
  check (status in ('DRAFT','PENDING_APPROVAL','PENDING_FINANCE','POSTED','REJECTED'));
alter table scrap_disposals
  add column fm_approved_by      uuid references profiles(id),
  add column fm_approved_at      timestamptz,
  add column finance_approved_by uuid references profiles(id),
  add column finance_approved_at timestamptz;

create or replace function public.disposal_action(p_d uuid, p_action text, p_comments text default null)
returns text language plpgsql security definer set search_path = public as $$
declare h scrap_disposals%rowtype; l record; v_loc uuid;
begin
  select * into h from scrap_disposals where id = p_d for update;
  if not found then raise exception 'Disposal not found'; end if;

  if p_action = 'SUBMIT' then
    if not has_role('stores') then raise exception 'Only Stores can submit a disposal'; end if;
    if h.status not in ('DRAFT','REJECTED') then raise exception 'Disposal is %', h.status; end if;
    if not exists (select 1 from disposal_lines where disposal_id = p_d) then raise exception 'Disposal has no lines'; end if;
    update scrap_disposals set status = 'PENDING_APPROVAL' where id = p_d;
    return 'PENDING_APPROVAL';
  end if;

  if p_action not in ('APPROVE','REJECT') then raise exception 'Unknown action %', p_action; end if;

  if h.status = 'PENDING_APPROVAL' then
    if not has_role('factory_manager') then raise exception 'Awaiting Factory Manager approval'; end if;
    if p_action = 'REJECT' then
      if coalesce(p_comments,'') = '' then raise exception 'Rejection reason is required'; end if;
      update scrap_disposals set status = 'REJECTED', approved_by = auth.uid(), approved_at = now(), approval_comments = p_comments where id = p_d;
      return 'REJECTED';
    end if;
    update scrap_disposals set status = 'PENDING_FINANCE', fm_approved_by = auth.uid(), fm_approved_at = now(),
           approval_comments = p_comments where id = p_d;
    return 'PENDING_FINANCE';

  elsif h.status = 'PENDING_FINANCE' then
    if not has_role('finance') then raise exception 'Awaiting Finance approval'; end if;
    if p_action = 'REJECT' then
      if coalesce(p_comments,'') = '' then raise exception 'Rejection reason is required'; end if;
      update scrap_disposals set status = 'REJECTED', approved_by = auth.uid(), approved_at = now(), approval_comments = p_comments where id = p_d;
      return 'REJECTED';
    end if;
    if h.method = 'SALE' and exists (select 1 from disposal_lines where disposal_id = p_d and rate <= 0) then
      raise exception 'Every line of a scrap sale needs a sale rate';
    end if;
    v_loc := coalesce(h.location_id, (select id from locations where loc_type = 'SCRAP_YARD' order by created_at limit 1));
    for l in select * from disposal_lines where disposal_id = p_d loop
      perform * from fifo_consume(l.scrap_item_id, v_loc, l.qty, null, 'SCRAP_DISPOSAL', 'DISPOSAL',
                                  h.id, h.disposal_no, l.id, h.disposal_date, null, null, null, true);
    end loop;
    update scrap_disposals set status = 'POSTED', finance_approved_by = auth.uid(), finance_approved_at = now(),
           approved_by = auth.uid(), approved_at = now(),
           approval_comments = coalesce(p_comments, approval_comments) where id = p_d;
    return 'POSTED';
  else
    raise exception 'Disposal is not pending approval (status %)', h.status;
  end if;
end $$;

-- Finance may confirm rates / receipt while PENDING_FINANCE, and record receipt after posting
create policy finance_update on scrap_disposals for update to authenticated
  using (public.has_role('finance') and status in ('PENDING_FINANCE','POSTED'))
  with check (public.has_role('finance') and status in ('PENDING_FINANCE','POSTED'));
create policy finance_lines on disposal_lines for update to authenticated
  using (public.has_role('finance') and exists (select 1 from scrap_disposals h where h.id = disposal_lines.disposal_id and h.status = 'PENDING_FINANCE'))
  with check (public.has_role('finance') and exists (select 1 from scrap_disposals h where h.id = disposal_lines.disposal_id and h.status = 'PENDING_FINANCE'));

-- after posting, only the receipt fields may change
create or replace function public.disposal_posted_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated','anon') and old.status = 'POSTED' then
    if (to_jsonb(new) - 'payment_received' - 'receipt_ref' - 'remarks') is distinct from (to_jsonb(old) - 'payment_received' - 'receipt_ref' - 'remarks') then
      raise exception 'A posted disposal can only have its payment receipt updated';
    end if;
  end if;
  return new;
end $$;
create trigger disposal_posted_guard before update on scrap_disposals for each row execute function disposal_posted_guard();

-- ---------- Notifications ----------
create table notifications (
  id           bigserial primary key,
  created_at   timestamptz not null default now(),
  target_role  app_role,
  target_user  uuid references profiles(id) on delete cascade,
  title        text not null,
  body         text,
  link         text,
  doc_type     text,
  doc_id       uuid,
  emailed_at   timestamptz,
  constraint notif_target check (target_role is not null or target_user is not null)
);
create index notifications_created_idx on notifications(created_at desc);

create table notification_reads (
  notification_id bigint not null references notifications(id) on delete cascade,
  user_id         uuid not null default auth.uid() references profiles(id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (notification_id, user_id)
);

alter table notifications enable row level security;
alter table notification_reads enable row level security;
create policy mine on notifications for select to authenticated
  using (public.is_active_user() and (target_user = auth.uid() or (target_role is not null and public.has_role(target_role))));
create policy mine on notification_reads for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.notify(p_role app_role, p_user uuid, p_title text, p_body text, p_link text, p_doc_type text, p_doc_id uuid)
returns void language sql security definer set search_path = public as $$
  insert into notifications (target_role, target_user, title, body, link, doc_type, doc_id)
  select p_role, p_user, p_title, p_body, p_link, p_doc_type, p_doc_id
   where p_role is not null or p_user is not null
$$;
revoke execute on function public.notify(app_role, uuid, text, text, text, text, uuid) from public, anon, authenticated;

create or replace function public.trg_notify_status() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_vendor text; v_proj text; v_owner uuid;
begin
  if new.status is not distinct from old.status then return new; end if;

  if tg_table_name = 'purchase_orders' then
    select name into v_vendor from vendors where id = new.vendor_id;
    case new.status
      when 'PENDING_FM' then perform notify('factory_manager', null, 'PO ' || new.po_no || ' awaits your approval',
            v_vendor || ' — ' || new.currency || ' ' || to_char(new.total_amount, 'FM999,999,990.00'), 'd/po/' || new.id, 'po', new.id);
      when 'PENDING_FINANCE' then perform notify('finance', null, 'PO ' || new.po_no || ' awaits Finance approval',
            v_vendor || ' — ' || new.currency || ' ' || to_char(new.total_amount, 'FM999,999,990.00'), 'd/po/' || new.id, 'po', new.id);
      when 'PENDING_TOP_MGMT' then perform notify('purchase', null, 'PO ' || new.po_no || ': get top-management approval',
            'Approved by FM and Finance. Record the parent-system reference.', 'd/po/' || new.id, 'po', new.id);
      when 'APPROVED' then perform notify('purchase', null, 'PO ' || new.po_no || ' fully approved', 'Release it to ' || v_vendor, 'd/po/' || new.id, 'po', new.id);
      when 'RELEASED' then perform notify('stores', null, 'PO ' || new.po_no || ' released', 'Expect delivery from ' || v_vendor ||
            coalesce(' on ' || to_char(new.delivery_date, 'DD Mon YYYY'), ''), 'd/po/' || new.id, 'po', new.id);
      when 'REJECTED' then perform notify(null, new.created_by, 'PO ' || new.po_no || ' was rejected', 'Open the PO to see the reason and revise.', 'd/po/' || new.id, 'po', new.id);
      else null;
    end case;

  elsif tg_table_name = 'material_requests' then
    select code || ' — ' || name into v_proj from projects where id = new.project_id;
    v_proj := coalesce(v_proj, (select code from cost_centers where id = new.cost_center_id));
    case new.status
      when 'PENDING_APPROVAL' then perform notify('production_incharge', null, 'Material request ' || new.mr_no || ' awaits approval',
            coalesce(v_proj, '') || case when new.priority = 'URGENT' then ' — URGENT' else '' end, 'd/mr/' || new.id, 'mr', new.id);
      when 'APPROVED' then
        perform notify('stores', null, 'Issue material: ' || new.mr_no, coalesce(v_proj, '') || case when new.priority = 'URGENT' then ' — URGENT' else '' end, 'd/mr/' || new.id, 'mr', new.id);
        perform notify(null, new.requested_by, 'Your request ' || new.mr_no || ' was approved', 'Stores will issue the material.', 'd/mr/' || new.id, 'mr', new.id);
      when 'REJECTED' then perform notify(null, new.requested_by, 'Your request ' || new.mr_no || ' was rejected', new.approval_comments, 'd/mr/' || new.id, 'mr', new.id);
      when 'ISSUED' then perform notify(null, new.requested_by, 'Material issued for ' || new.mr_no, coalesce(v_proj, ''), 'd/mr/' || new.id, 'mr', new.id);
      else null;
    end case;

  elsif tg_table_name = 'stock_adjustments' then
    case new.status
      when 'PENDING_APPROVAL' then perform notify('factory_manager', null, 'Stock adjustment ' || new.adj_no || ' awaits approval', initcap(replace(new.reason, '_', ' ')), 'd/adj/' || new.id, 'adj', new.id);
      when 'POSTED' then perform notify(null, new.created_by, 'Adjustment ' || new.adj_no || ' approved and posted', null, 'd/adj/' || new.id, 'adj', new.id);
      when 'REJECTED' then perform notify(null, new.created_by, 'Adjustment ' || new.adj_no || ' rejected', new.approval_comments, 'd/adj/' || new.id, 'adj', new.id);
      else null;
    end case;

  elsif tg_table_name = 'scrap_notes' then
    case new.status
      when 'PENDING_APPROVAL' then perform notify('factory_manager', null, 'Scrap note ' || new.scrap_no || ' awaits approval', new.reason, 'd/scrap/' || new.id, 'scrap', new.id);
      when 'REJECTED' then perform notify(null, new.created_by, 'Scrap note ' || new.scrap_no || ' rejected', new.approval_comments, 'd/scrap/' || new.id, 'scrap', new.id);
      else null;
    end case;

  elsif tg_table_name = 'scrap_disposals' then
    case new.status
      when 'PENDING_APPROVAL' then perform notify('factory_manager', null, 'Scrap disposal ' || new.disposal_no || ' awaits approval', coalesce(new.buyer_name, ''), 'd/disposal/' || new.id, 'disposal', new.id);
      when 'PENDING_FINANCE' then perform notify('finance', null, 'Scrap disposal ' || new.disposal_no || ': confirm rate & receipt', coalesce(new.buyer_name, ''), 'd/disposal/' || new.id, 'disposal', new.id);
      when 'POSTED' then perform notify(null, new.created_by, 'Scrap disposal ' || new.disposal_no || ' approved', 'Stock released — gate pass can be printed.', 'd/disposal/' || new.id, 'disposal', new.id);
      when 'REJECTED' then perform notify(null, new.created_by, 'Scrap disposal ' || new.disposal_no || ' rejected', new.approval_comments, 'd/disposal/' || new.id, 'disposal', new.id);
      else null;
    end case;
  end if;
  return new;
end $$;
revoke execute on function public.trg_notify_status() from public, anon, authenticated;

create trigger notify_status after update of status on purchase_orders   for each row execute function trg_notify_status();
create trigger notify_status after update of status on material_requests for each row execute function trg_notify_status();
create trigger notify_status after update of status on stock_adjustments for each row execute function trg_notify_status();
create trigger notify_status after update of status on scrap_notes       for each row execute function trg_notify_status();
create trigger notify_status after update of status on scrap_disposals   for each row execute function trg_notify_status();
