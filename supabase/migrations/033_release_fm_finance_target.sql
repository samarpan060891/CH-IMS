-- =====================================================================
-- Citi Homes IMS - 033 Project-reserved stock: release only with Factory Manager AND Finance approval,
-- for exactly the requested lots / quantities, to general stock or to another project
-- =====================================================================

alter table stock_releases drop constraint stock_releases_status_check;
alter table stock_releases add constraint stock_releases_status_check check (status in ('DRAFT','PENDING_APPROVAL','PENDING_FINANCE','POSTED','REJECTED','CANCELLED'));
alter table stock_releases
  add column target_project_id uuid references projects(id),          -- null = general stock
  add column requested_by  uuid references profiles(id), add column submitted_at timestamptz,
  add column fm_approved_by uuid references profiles(id), add column fm_approved_at timestamptz, add column fm_comments text,
  add column fin_approved_by uuid references profiles(id), add column fin_approved_at timestamptz, add column fin_comments text;

create or replace function public.release_action(p_rel uuid, p_action text, p_comments text default null) returns text
language plpgsql security definer set search_path = public as $$
declare h stock_releases%rowtype; l record; lot stock_lots%rowtype; tp projects%rowtype; v_new uuid; v_cost numeric; v_total numeric := 0; v_to text;
begin
  select * into h from stock_releases where id = p_rel for update;
  if not found then raise exception 'Release not found'; end if;
  v_to := coalesce((select code from projects where id = h.target_project_id), 'general stock');

  if p_action = 'SUBMIT' then
    if not has_role('stores','production_incharge','purchase','factory_manager') then raise exception 'Not allowed'; end if;
    if h.status not in ('DRAFT','REJECTED') then raise exception 'Release is %', h.status; end if;
    if not exists (select 1 from release_lines where release_id = p_rel and qty > 0) then raise exception 'Release has no lines'; end if;
    if h.target_project_id = h.project_id then raise exception 'Choose a different project (or general stock) to release to'; end if;
    if h.target_project_id is not null then
      select * into tp from projects where id = h.target_project_id;
      if tp.status <> 'OPEN' then raise exception 'Project % is not open', tp.code; end if;
    end if;
    for l in select rl.*, s.project_id lot_proj, s.qty_on_hand, s.lot_no from release_lines rl join stock_lots s on s.id = rl.lot_id where rl.release_id = p_rel loop
      if l.lot_proj is distinct from h.project_id then raise exception 'Lot % is not reserved for this project', l.lot_no; end if;
      if l.qty > l.qty_on_hand + 0.0005 then raise exception 'Lot % has only % reserved', l.lot_no, l.qty_on_hand; end if;
    end loop;
    update stock_releases set status = 'PENDING_APPROVAL', requested_by = coalesce(requested_by, auth.uid()), submitted_at = now(),
           fm_approved_by = null, fm_approved_at = null, fm_comments = null, fin_approved_by = null, fin_approved_at = null, fin_comments = null,
           approved_by = null, approved_at = null, approval_comments = null
     where id = p_rel;
    return 'PENDING_APPROVAL';

  elsif p_action = 'CANCEL' then
    if not has_role('stores','production_incharge','purchase','factory_manager') then raise exception 'Not allowed'; end if;
    if h.status not in ('DRAFT','PENDING_APPROVAL','PENDING_FINANCE','REJECTED') then raise exception 'Release is %', h.status; end if;
    update stock_releases set status = 'CANCELLED' where id = p_rel;
    return 'CANCELLED';

  elsif p_action = 'REJECT' then
    if not ((h.status = 'PENDING_APPROVAL' and has_role('factory_manager')) or (h.status = 'PENDING_FINANCE' and has_role('finance'))) then
      raise exception 'Only the Factory Manager (first) or the Finance Manager (second) can reject this release';
    end if;
    if coalesce(trim(p_comments), '') = '' then raise exception 'Give a reason'; end if;
    update stock_releases set status = 'REJECTED', approved_by = auth.uid(), approved_at = now(), approval_comments = p_comments where id = p_rel;
    return 'REJECTED';

  elsif p_action <> 'APPROVE' then raise exception 'Unknown action %', p_action; end if;

  -- step 1: Factory Manager
  if h.status = 'PENDING_APPROVAL' then
    if not has_role('factory_manager') then raise exception 'The Factory Manager approves first'; end if;
    update stock_releases set status = 'PENDING_FINANCE', fm_approved_by = auth.uid(), fm_approved_at = now(), fm_comments = p_comments where id = p_rel;
    return 'PENDING_FINANCE';
  end if;

  -- step 2: Finance Manager -> stock moves
  if h.status <> 'PENDING_FINANCE' then raise exception 'Release is %', h.status; end if;
  if not has_role('finance') then raise exception 'The Finance Manager gives the final approval'; end if;
  if h.fm_approved_by is not null and h.fm_approved_by = auth.uid() and not has_role('admin') then
    raise exception 'The same person cannot give both approvals';
  end if;
  for l in select * from release_lines where release_id = p_rel and qty > 0 loop
    select * into lot from stock_lots where id = l.lot_id for update;
    if lot.project_id is distinct from h.project_id then raise exception 'Lot % is not reserved for this project any more', lot.lot_no; end if;
    if l.qty > lot.qty_on_hand + 0.0005 then raise exception 'Lot % has only % left — the request must be revised', lot.lot_no, lot.qty_on_hand; end if;
    v_cost := lot_issue_cost(lot.id);
    update stock_lots set qty_on_hand = qty_on_hand - l.qty where id = lot.id;
    insert into stock_lots (item_id, location_id, lot_no, batch_no, source_type, source_id, parent_lot_id, received_date,
                            mfg_date, expiry_date, unit_cost, qty_in, qty_on_hand, vendor_id, project_id, status)
    values (lot.item_id, lot.location_id, lot.lot_no, lot.batch_no, 'TRANSFER', l.id, lot.id, lot.received_date,
            lot.mfg_date, lot.expiry_date, lot.unit_cost, l.qty, l.qty, lot.vendor_id, h.target_project_id, lot.status)
    returning id into v_new;
    insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value, doc_type, doc_id, doc_no, doc_line_id, project_id, remarks)
    values (h.release_date, 'RELEASE_OUT', lot.item_id, lot.location_id, lot.id, -l.qty, v_cost, -round(l.qty * v_cost, 2), 'REL', h.id, h.release_no, l.id, h.project_id,
            'Released from project reservation to ' || v_to),
           (h.release_date, 'RELEASE_IN', lot.item_id, lot.location_id, v_new, l.qty, v_cost, round(l.qty * v_cost, 2), 'REL', h.id, h.release_no, l.id, h.target_project_id,
            case when h.target_project_id is null then 'Released to general stock' else 'Reserved for ' || v_to || ' (from another project)' end);
    update release_lines set value = round(l.qty * v_cost, 2) where id = l.id;
    v_total := v_total + round(l.qty * v_cost, 2);
  end loop;
  update stock_releases set status = 'POSTED', total_value = v_total, fin_approved_by = auth.uid(), fin_approved_at = now(), fin_comments = p_comments,
         approved_by = auth.uid(), approved_at = now(), approval_comments = coalesce(p_comments, approval_comments)
   where id = p_rel;
  return 'POSTED';
end $$;
grant execute on function public.release_action(uuid, text, text) to authenticated;
revoke execute on function public.release_action(uuid, text, text) from anon;

create or replace function public.trg_notify_release() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_proj text; v_to text;
begin
  if new.status is not distinct from old.status then return new; end if;
  select code || ' — ' || name into v_proj from projects where id = new.project_id;
  v_to := coalesce((select code from projects where id = new.target_project_id), 'general stock');
  if new.status = 'PENDING_APPROVAL' then
    perform notify('factory_manager', null, 'Stock release ' || new.release_no || ' awaits your approval', 'Reserved stock of ' || v_proj || ' → ' || v_to, 'd/rel/' || new.id, 'rel', new.id);
  elsif new.status = 'PENDING_FINANCE' then
    perform notify('finance', null, 'Stock release ' || new.release_no || ' awaits final approval', 'FM approved: ' || v_proj || ' → ' || v_to, 'd/rel/' || new.id, 'rel', new.id);
  elsif new.status in ('POSTED','REJECTED') then
    perform notify(null, coalesce(new.requested_by, new.created_by), 'Stock release ' || new.release_no || ' ' || lower(new.status), coalesce(new.approval_comments, v_proj || ' → ' || v_to), 'd/rel/' || new.id, 'rel', new.id);
  end if;
  return new;
end $$;

-- shortage message points to the release request
do $$ begin
  execute replace(pg_get_functiondef('public.fifo_consume(uuid, uuid, numeric, uuid, text, text, uuid, text, uuid, date, uuid, uuid, uuid, boolean)'::regprocedure),
    'reserved for other projects — ask the Factory Manager to release it', 'reserved for other projects — raise a Project stock release (Factory Manager + Finance approval)');
end $$;

-- requests can be raised by Stores, Production, Purchase and the Factory Manager
drop policy doc_insert on stock_releases; drop policy doc_update on stock_releases; drop policy doc_delete on stock_releases; drop policy line_write on release_lines;
create policy doc_insert on stock_releases for insert to authenticated
  with check (public.has_role('stores','production_incharge','purchase','factory_manager') and status in ('DRAFT','REJECTED'));
create policy doc_update on stock_releases for update to authenticated
  using (public.has_role('stores','production_incharge','purchase','factory_manager') and status in ('DRAFT','REJECTED'))
  with check (public.has_role('stores','production_incharge','purchase','factory_manager') and status in ('DRAFT','REJECTED'));
create policy doc_delete on stock_releases for delete to authenticated
  using (public.has_role('stores','production_incharge','purchase','factory_manager') and status in ('DRAFT','REJECTED'));
create policy line_write on release_lines for all to authenticated
  using (public.has_role('stores','production_incharge','purchase','factory_manager') and exists (select 1 from stock_releases h where h.id = release_lines.release_id and h.status in ('DRAFT','REJECTED')))
  with check (public.has_role('stores','production_incharge','purchase','factory_manager') and exists (select 1 from stock_releases h where h.id = release_lines.release_id and h.status in ('DRAFT','REJECTED')));
