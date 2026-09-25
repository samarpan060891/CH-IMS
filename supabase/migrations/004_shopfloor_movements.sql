-- =====================================================================
-- Citi Homes IMS - 004 Shop floor: requests, issues, returns, transfers,
-- adjustments, scrap, tool crib, purchase returns
-- =====================================================================

-- ---------- Core FIFO / FEFO consumption ----------
-- Consumes stock oldest-first (expiry first for dated items); project-reserved
-- (customer-supplied) lots are used first for their own project only.
create or replace function public.fifo_consume(
  p_item uuid, p_location uuid, p_qty numeric, p_project uuid,
  p_txn_type text, p_doc_type text, p_doc_id uuid, p_doc_no text, p_doc_line uuid, p_date date,
  p_ledger_project uuid default null, p_cost_center uuid default null,
  p_lot uuid default null, p_all_lots boolean default false)
returns table (lot_id uuid, qty numeric, unit_cost numeric)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare r record; v_need numeric := p_qty; v_take numeric; v_cost numeric; v_code text;
begin
  if p_qty <= 0 then return; end if;
  for r in select l.id, l.qty_on_hand from stock_lots l
            where l.item_id = p_item and l.location_id = p_location and l.qty_on_hand > 0
              and (p_lot is null or l.id = p_lot)
              and (p_all_lots or p_lot is not null or l.status = 'AVAILABLE')
              and (p_all_lots or l.project_id is null or l.project_id = p_project)
            order by (l.project_id is not null) desc, l.expiry_date nulls last, l.received_date, l.created_at
            for update
  loop
    exit when v_need <= 0;
    v_take := least(v_need, r.qty_on_hand);
    v_cost := lot_issue_cost(r.id);
    update stock_lots set qty_on_hand = qty_on_hand - v_take where id = r.id;
    insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value,
                              doc_type, doc_id, doc_no, doc_line_id, project_id, cost_center_id)
    values (p_date, p_txn_type, p_item, p_location, r.id, -v_take, v_cost, -round(v_take * v_cost, 2),
            p_doc_type, p_doc_id, p_doc_no, p_doc_line, p_ledger_project, p_cost_center);
    lot_id := r.id; qty := v_take; unit_cost := v_cost;
    return next;
    v_need := v_need - v_take;
  end loop;
  if v_need > 0.0005 then
    select code into v_code from items where id = p_item;
    raise exception 'Insufficient stock for % at this location: short by %', v_code, round(v_need, 3);
  end if;
end $$;

-- ---------- Material requests (floor -> store) ----------
create table material_requests (
  id               uuid primary key default gen_random_uuid(),
  mr_no            text not null unique default next_doc_no('MR'),
  mr_date          date not null default current_date,
  purpose          text not null check (purpose in ('PROJECT','MTS','COST_CENTER')),
  project_id       uuid references projects(id),
  cost_center_id   uuid references cost_centers(id),
  required_date    date,
  priority         text not null default 'NORMAL' check (priority in ('NORMAL','URGENT')),
  status           text not null default 'DRAFT' check (status in
                    ('DRAFT','PENDING_APPROVAL','APPROVED','PARTIALLY_ISSUED','ISSUED','REJECTED','CANCELLED','CLOSED')),
  remarks          text,
  requested_by     uuid default auth.uid() references profiles(id),
  approved_by      uuid references profiles(id),
  approved_at      timestamptz,
  approval_comments text,
  created_at       timestamptz not null default now(),
  constraint mr_target check (
    (purpose in ('PROJECT','MTS') and project_id is not null) or
    (purpose = 'COST_CENTER' and cost_center_id is not null))
);
create table mr_lines (
  id            uuid primary key default gen_random_uuid(),
  mr_id         uuid not null references material_requests(id) on delete cascade,
  line_no       int not null default 1,
  item_id       uuid not null references items(id),
  requested_qty numeric(14,3) not null check (requested_qty > 0),
  approved_qty  numeric(14,3),
  issued_qty    numeric(14,3) not null default 0,
  remarks       text
);
create index mr_lines_mr_idx on mr_lines(mr_id);

create or replace function public.mr_action(p_mr uuid, p_action text, p_comments text default null)
returns text language plpgsql security definer set search_path = public as $$
declare r material_requests%rowtype; v_new text;
begin
  select * into r from material_requests where id = p_mr for update;
  if not found then raise exception 'Request not found'; end if;
  if p_action = 'SUBMIT' then
    if not has_role('shop_floor','production_incharge','stores') then raise exception 'Not allowed'; end if;
    if r.status not in ('DRAFT','REJECTED') then raise exception 'Request is %', r.status; end if;
    if not exists (select 1 from mr_lines where mr_id = p_mr) then raise exception 'Request has no lines'; end if;
    v_new := 'PENDING_APPROVAL';
  elsif p_action in ('APPROVE','REJECT') then
    if not has_role('production_incharge') then raise exception 'Only the Production In-charge can approve requests'; end if;
    if r.status <> 'PENDING_APPROVAL' then raise exception 'Request is not pending approval'; end if;
    if p_action = 'REJECT' and coalesce(p_comments,'') = '' then raise exception 'Rejection reason is required'; end if;
    v_new := case when p_action = 'APPROVE' then 'APPROVED' else 'REJECTED' end;
    if p_action = 'APPROVE' then
      update mr_lines set approved_qty = coalesce(approved_qty, requested_qty) where mr_id = p_mr;
    end if;
    update material_requests set approved_by = auth.uid(), approved_at = now(), approval_comments = p_comments where id = p_mr;
  elsif p_action = 'CANCEL' then
    if r.status not in ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED') then raise exception 'Cannot cancel a % request', r.status; end if;
    if r.requested_by <> auth.uid() and not has_role('production_incharge','stores') then raise exception 'Not allowed'; end if;
    v_new := 'CANCELLED';
  elsif p_action = 'CLOSE' then  -- short close
    if not has_role('stores','production_incharge') then raise exception 'Not allowed'; end if;
    if r.status not in ('APPROVED','PARTIALLY_ISSUED') then raise exception 'Cannot close a % request', r.status; end if;
    v_new := 'CLOSED';
  else raise exception 'Unknown action %', p_action; end if;
  update material_requests set status = v_new where id = p_mr;
  return v_new;
end $$;

-- ---------- Material issues ----------
create table material_issues (
  id                       uuid primary key default gen_random_uuid(),
  issue_no                 text not null unique default next_doc_no('MIS'),
  issue_date               date not null default current_date,
  mr_id                    uuid references material_requests(id),
  purpose                  text not null check (purpose in ('PROJECT','MTS','COST_CENTER')),
  project_id               uuid references projects(id),
  cost_center_id           uuid references cost_centers(id),
  from_location_id         uuid not null references locations(id),
  received_by_employee_id  uuid references employees(id),
  received_by_name         text,
  status                   text not null default 'DRAFT' check (status in ('DRAFT','POSTED','CANCELLED')),
  total_value              numeric(16,2) not null default 0,
  remarks                  text,
  created_by               uuid default auth.uid() references profiles(id),
  created_at               timestamptz not null default now(),
  posted_by                uuid references profiles(id),
  posted_at                timestamptz,
  constraint issue_target check (
    (purpose in ('PROJECT','MTS') and project_id is not null) or
    (purpose = 'COST_CENTER' and cost_center_id is not null))
);
create table issue_lines (
  id           uuid primary key default gen_random_uuid(),
  issue_id     uuid not null references material_issues(id) on delete cascade,
  line_no      int not null default 1,
  mr_line_id   uuid references mr_lines(id),
  item_id      uuid not null references items(id),
  qty          numeric(14,3) not null check (qty > 0),
  value        numeric(16,2) not null default 0,
  returned_qty numeric(14,3) not null default 0,
  remarks      text
);
create index issue_lines_issue_idx on issue_lines(issue_id);
create table issue_line_lots (
  id            uuid primary key default gen_random_uuid(),
  seq           bigserial,
  issue_line_id uuid not null references issue_lines(id) on delete cascade,
  lot_id        uuid not null references stock_lots(id),
  qty           numeric(14,3) not null,
  unit_cost     numeric(14,4) not null,
  returned_qty  numeric(14,3) not null default 0
);
create index ill_line_idx on issue_line_lots(issue_line_id);

create or replace function public.post_issue(p_issue uuid) returns void
language plpgsql security definer set search_path = public as $$
declare h material_issues%rowtype; l record; a record; v_mrl mr_lines%rowtype;
        v_line numeric; v_total numeric := 0; v_mr_status text;
begin
  if not has_role('stores') then raise exception 'Only Stores can post an issue'; end if;
  select * into h from material_issues where id = p_issue for update;
  if not found then raise exception 'Issue not found'; end if;
  if h.status <> 'DRAFT' then raise exception 'Issue % is already %', h.issue_no, h.status; end if;
  if not exists (select 1 from issue_lines where issue_id = p_issue) then raise exception 'Issue has no lines'; end if;
  if h.project_id is not null and exists (select 1 from projects where id = h.project_id and status <> 'OPEN') then
    raise exception 'Project is not open';
  end if;
  if h.mr_id is not null then
    select status into v_mr_status from material_requests where id = h.mr_id for update;
    if v_mr_status not in ('APPROVED','PARTIALLY_ISSUED') then
      raise exception 'Material request is % - it must be approved before issue', v_mr_status;
    end if;
  end if;

  for l in select il.*, i.code, c.tracking from issue_lines il
             join items i on i.id = il.item_id join item_classes c on c.id = i.class_id
            where il.issue_id = p_issue order by il.line_no loop
    if l.tracking = 'SERIAL' then
      raise exception 'Item % is serialised - issue it from the Tool Crib / Asset register', l.code;
    end if;
    if l.mr_line_id is not null then
      select * into v_mrl from mr_lines where id = l.mr_line_id for update;
      if v_mrl.mr_id <> h.mr_id then raise exception 'Line does not belong to the linked request'; end if;
      if v_mrl.issued_qty + l.qty > coalesce(v_mrl.approved_qty, v_mrl.requested_qty) + 0.0005 then
        raise exception 'Issue of % exceeds approved qty (approved %, already issued %)',
          l.code, coalesce(v_mrl.approved_qty, v_mrl.requested_qty), v_mrl.issued_qty;
      end if;
      update mr_lines set issued_qty = issued_qty + l.qty where id = l.mr_line_id;
    end if;
    v_line := 0;
    for a in select * from fifo_consume(l.item_id, h.from_location_id, l.qty, h.project_id,
                                        'ISSUE', 'ISSUE', h.id, h.issue_no, l.id, h.issue_date,
                                        h.project_id, h.cost_center_id) loop
      insert into issue_line_lots (issue_line_id, lot_id, qty, unit_cost) values (l.id, a.lot_id, a.qty, a.unit_cost);
      v_line := v_line + round(a.qty * a.unit_cost, 2);
    end loop;
    update issue_lines set value = v_line where id = l.id;
    v_total := v_total + v_line;
  end loop;

  update material_issues set status = 'POSTED', total_value = v_total, posted_at = now(), posted_by = auth.uid()
   where id = p_issue;
  if h.mr_id is not null then
    update material_requests set status = case
        when not exists (select 1 from mr_lines where mr_id = h.mr_id
                          and issued_qty < coalesce(approved_qty, requested_qty)) then 'ISSUED'
        else 'PARTIALLY_ISSUED' end
     where id = h.mr_id;
  end if;
end $$;

-- ---------- Material returns (floor -> store) ----------
create table material_returns (
  id             uuid primary key default gen_random_uuid(),
  return_no      text not null unique default next_doc_no('MRN'),
  return_date    date not null default current_date,
  issue_id       uuid not null references material_issues(id),
  to_location_id uuid not null references locations(id),
  returned_by_name text,
  status         text not null default 'DRAFT' check (status in ('DRAFT','POSTED','CANCELLED')),
  total_value    numeric(16,2) not null default 0,
  remarks        text,
  created_by     uuid default auth.uid() references profiles(id),
  created_at     timestamptz not null default now(),
  posted_by      uuid references profiles(id),
  posted_at      timestamptz
);
create table return_lines (
  id             uuid primary key default gen_random_uuid(),
  return_id      uuid not null references material_returns(id) on delete cascade,
  issue_line_id  uuid not null references issue_lines(id),
  item_id        uuid not null references items(id),
  qty            numeric(14,3) not null check (qty > 0),
  condition      text not null default 'GOOD' check (condition in ('GOOD','DAMAGED')),  -- DAMAGED -> quarantine (HOLD)
  reason         text,
  value          numeric(16,2) not null default 0
);

create or replace function public.post_return(p_ret uuid) returns void
language plpgsql security definer set search_path = public as $$
declare h material_returns%rowtype; iss material_issues%rowtype; l record; a record; v_lot stock_lots%rowtype;
        v_loc uuid; v_left numeric; v_take numeric; v_val numeric; v_total numeric := 0; v_new uuid;
begin
  if not has_role('stores') then raise exception 'Only Stores can post a return'; end if;
  select * into h from material_returns where id = p_ret for update;
  if h.status <> 'DRAFT' then raise exception 'Return is already %', h.status; end if;
  select * into iss from material_issues where id = h.issue_id;
  if iss.status <> 'POSTED' then raise exception 'Source issue is not posted'; end if;

  for l in select rl.*, il.issue_id src_issue, il.qty issued_qty, il.returned_qty already
             from return_lines rl join issue_lines il on il.id = rl.issue_line_id
            where rl.return_id = p_ret for update of il loop
    if l.src_issue <> h.issue_id then raise exception 'Return line does not belong to issue %', iss.issue_no; end if;
    if l.qty > l.issued_qty - l.already + 0.0005 then
      raise exception 'Return qty % exceeds un-returned balance %', l.qty, l.issued_qty - l.already;
    end if;
    v_loc := case when l.condition = 'GOOD' then h.to_location_id
                  else (select id from locations where loc_type = 'QUARANTINE' order by created_at limit 1) end;
    v_left := l.qty; v_val := 0;
    for a in select * from issue_line_lots where issue_line_id = l.issue_line_id and qty > returned_qty
              order by seq desc for update loop
      exit when v_left <= 0.0005;
      v_take := least(v_left, a.qty - a.returned_qty);
      select * into v_lot from stock_lots where id = a.lot_id;
      if item_valuation(l.item_id) = 'WAVG' then perform wavg_receive(l.item_id, v_take, a.unit_cost); end if;
      if l.condition = 'GOOD' and v_lot.location_id = v_loc and v_lot.status = 'AVAILABLE' then
        update stock_lots set qty_on_hand = qty_on_hand + v_take where id = v_lot.id;
        v_new := v_lot.id;
      else
        insert into stock_lots (item_id, location_id, lot_no, batch_no, source_type, source_id, parent_lot_id,
                                received_date, mfg_date, expiry_date, unit_cost, qty_in, qty_on_hand,
                                vendor_id, project_id, status)
        values (l.item_id, v_loc, v_lot.lot_no, v_lot.batch_no, 'RETURN', l.id, v_lot.id, v_lot.received_date,
                v_lot.mfg_date, v_lot.expiry_date, a.unit_cost, v_take, v_take, v_lot.vendor_id, v_lot.project_id,
                case when l.condition = 'GOOD' then 'AVAILABLE' else 'HOLD' end)
        returning id into v_new;
      end if;
      update issue_line_lots set returned_qty = returned_qty + v_take where id = a.id;
      insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value,
                                doc_type, doc_id, doc_no, doc_line_id, project_id, cost_center_id, remarks)
      values (h.return_date, 'RETURN', l.item_id, v_loc, v_new, v_take, a.unit_cost, round(v_take * a.unit_cost, 2),
              'RETURN', h.id, h.return_no, l.id, iss.project_id, iss.cost_center_id, l.condition);
      v_val := v_val + round(v_take * a.unit_cost, 2);
      v_left := v_left - v_take;
    end loop;
    update issue_lines set returned_qty = returned_qty + l.qty where id = l.issue_line_id;
    update return_lines set value = v_val where id = l.id;
    v_total := v_total + v_val;
  end loop;
  update material_returns set status = 'POSTED', total_value = v_total, posted_at = now(), posted_by = auth.uid()
   where id = p_ret;
end $$;

-- ---------- Stock transfers ----------
create table stock_transfers (
  id               uuid primary key default gen_random_uuid(),
  trf_no           text not null unique default next_doc_no('TRF'),
  trf_date         date not null default current_date,
  from_location_id uuid not null references locations(id),
  to_location_id   uuid not null references locations(id),
  status           text not null default 'DRAFT' check (status in ('DRAFT','POSTED','CANCELLED')),
  remarks          text,
  created_by       uuid default auth.uid() references profiles(id),
  created_at       timestamptz not null default now(),
  posted_by        uuid references profiles(id),
  posted_at        timestamptz,
  constraint trf_diff check (from_location_id <> to_location_id)
);
create table transfer_lines (
  id          uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references stock_transfers(id) on delete cascade,
  line_no     int not null default 1,
  item_id     uuid not null references items(id),
  lot_id      uuid references stock_lots(id),     -- optional: move a specific lot
  qty         numeric(14,3) not null check (qty > 0)
);

create or replace function public.post_transfer(p_trf uuid) returns void
language plpgsql security definer set search_path = public as $$
declare h stock_transfers%rowtype; l record; a record; v_lot stock_lots%rowtype; v_new uuid; v_dest_type text;
begin
  if not has_role('stores') then raise exception 'Only Stores can post a transfer'; end if;
  select * into h from stock_transfers where id = p_trf for update;
  if h.status <> 'DRAFT' then raise exception 'Transfer is already %', h.status; end if;
  select loc_type into v_dest_type from locations where id = h.to_location_id;
  for l in select * from transfer_lines where transfer_id = p_trf order by line_no loop
    for a in select * from fifo_consume(l.item_id, h.from_location_id, l.qty, null, 'TRANSFER_OUT', 'TRF',
                                        h.id, h.trf_no, l.id, h.trf_date, null, null, l.lot_id, true) loop
      select * into v_lot from stock_lots where id = a.lot_id;
      insert into stock_lots (item_id, location_id, lot_no, batch_no, source_type, source_id, parent_lot_id,
                              received_date, mfg_date, expiry_date, unit_cost, qty_in, qty_on_hand,
                              vendor_id, project_id, status)
      values (l.item_id, h.to_location_id, v_lot.lot_no, v_lot.batch_no, 'TRANSFER', l.id, v_lot.id,
              v_lot.received_date, v_lot.mfg_date, v_lot.expiry_date, v_lot.unit_cost, a.qty, a.qty,
              v_lot.vendor_id, v_lot.project_id,
              case when v_dest_type = 'QUARANTINE' then 'HOLD' else 'AVAILABLE' end)
      returning id into v_new;
      insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value,
                                doc_type, doc_id, doc_no, doc_line_id)
      values (h.trf_date, 'TRANSFER_IN', l.item_id, h.to_location_id, v_new, a.qty, a.unit_cost,
              round(a.qty * a.unit_cost, 2), 'TRF', h.id, h.trf_no, l.id);
    end loop;
  end loop;
  update stock_transfers set status = 'POSTED', posted_at = now(), posted_by = auth.uid() where id = p_trf;
end $$;

-- ---------- Stock adjustments (physical count) - FM approval ----------
create table stock_adjustments (
  id                uuid primary key default gen_random_uuid(),
  adj_no            text not null unique default next_doc_no('ADJ'),
  adj_date          date not null default current_date,
  location_id       uuid not null references locations(id),
  reason            text not null check (reason in ('PHYSICAL_COUNT','DAMAGE','EXPIRY','FOUND','OTHER')),
  status            text not null default 'DRAFT' check (status in ('DRAFT','PENDING_APPROVAL','POSTED','REJECTED')),
  total_value       numeric(16,2) not null default 0,
  remarks           text,
  created_by        uuid default auth.uid() references profiles(id),
  created_at        timestamptz not null default now(),
  approved_by       uuid references profiles(id),
  approved_at       timestamptz,
  approval_comments text
);
create table adjustment_lines (
  id          uuid primary key default gen_random_uuid(),
  adj_id      uuid not null references stock_adjustments(id) on delete cascade,
  item_id     uuid not null references items(id),
  lot_id      uuid references stock_lots(id),
  system_qty  numeric(14,3) not null default 0,
  counted_qty numeric(14,3) not null default 0,
  diff_qty    numeric(14,3) generated always as (counted_qty - system_qty) stored,
  value       numeric(16,2) not null default 0,
  remarks     text
);

create or replace function public.adj_action(p_adj uuid, p_action text, p_comments text default null)
returns text language plpgsql security definer set search_path = public as $$
declare h stock_adjustments%rowtype; l record; a record; v_cost numeric; v_val numeric; v_total numeric := 0; v_lot uuid;
begin
  select * into h from stock_adjustments where id = p_adj for update;
  if p_action = 'SUBMIT' then
    if not has_role('stores') then raise exception 'Only Stores can submit adjustments'; end if;
    if h.status not in ('DRAFT','REJECTED') then raise exception 'Adjustment is %', h.status; end if;
    update stock_adjustments set status = 'PENDING_APPROVAL' where id = p_adj;
    return 'PENDING_APPROVAL';
  elsif p_action = 'REJECT' then
    if not has_role('factory_manager') then raise exception 'Only the Factory Manager can reject'; end if;
    if h.status <> 'PENDING_APPROVAL' then raise exception 'Not pending approval'; end if;
    update stock_adjustments set status = 'REJECTED', approved_by = auth.uid(), approved_at = now(), approval_comments = p_comments where id = p_adj;
    return 'REJECTED';
  elsif p_action <> 'APPROVE' then raise exception 'Unknown action %', p_action; end if;

  if not has_role('factory_manager') then raise exception 'Only the Factory Manager can approve adjustments'; end if;
  if h.status <> 'PENDING_APPROVAL' then raise exception 'Not pending approval'; end if;
  for l in select al.*, i.avg_cost, i.last_purchase_rate, i.standard_cost from adjustment_lines al
             join items i on i.id = al.item_id where al.adj_id = p_adj loop
    v_val := 0;
    if l.diff_qty < 0 then
      for a in select * from fifo_consume(l.item_id, h.location_id, -l.diff_qty, null, 'ADJ_OUT', 'ADJ',
                                          h.id, h.adj_no, l.id, h.adj_date, null, null, l.lot_id, true) loop
        v_val := v_val - round(a.qty * a.unit_cost, 2);
      end loop;
    elsif l.diff_qty > 0 then
      if l.lot_id is not null then
        v_cost := lot_issue_cost(l.lot_id);
        if item_valuation(l.item_id) = 'WAVG' then perform wavg_receive(l.item_id, l.diff_qty, v_cost); end if;
        update stock_lots set qty_on_hand = qty_on_hand + l.diff_qty where id = l.lot_id;
        v_lot := l.lot_id;
      else
        v_cost := coalesce(nullif(l.avg_cost,0), l.last_purchase_rate, l.standard_cost, 0);
        if item_valuation(l.item_id) = 'WAVG' then perform wavg_receive(l.item_id, l.diff_qty, v_cost); end if;
        insert into stock_lots (item_id, location_id, lot_no, source_type, source_id, received_date, unit_cost, qty_in, qty_on_hand)
        values (l.item_id, h.location_id, h.adj_no, 'ADJUSTMENT', l.id, h.adj_date, v_cost, l.diff_qty, l.diff_qty)
        returning id into v_lot;
      end if;
      insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value,
                                doc_type, doc_id, doc_no, doc_line_id)
      values (h.adj_date, 'ADJ_IN', l.item_id, h.location_id, v_lot, l.diff_qty, v_cost,
              round(l.diff_qty * v_cost, 2), 'ADJ', h.id, h.adj_no, l.id);
      v_val := round(l.diff_qty * v_cost, 2);
    end if;
    update adjustment_lines set value = v_val where id = l.id;
    v_total := v_total + v_val;
  end loop;
  update stock_adjustments set status = 'POSTED', total_value = v_total, approved_by = auth.uid(),
         approved_at = now(), approval_comments = p_comments where id = p_adj;
  return 'POSTED';
end $$;

-- ---------- Scrap: write-off & generation (FM approval) ----------
create table scrap_notes (
  id                uuid primary key default gen_random_uuid(),
  scrap_no          text not null unique default next_doc_no('SCR'),
  scrap_date        date not null default current_date,
  scrap_type        text not null check (scrap_type in ('WRITE_OFF','GENERATION')),
  location_id       uuid references locations(id),      -- source location for write-off
  project_id        uuid references projects(id),       -- project generating the scrap
  cost_center_id    uuid references cost_centers(id),
  status            text not null default 'DRAFT' check (status in ('DRAFT','PENDING_APPROVAL','POSTED','REJECTED')),
  reason            text,
  total_value       numeric(16,2) not null default 0,   -- inventory value written off
  created_by        uuid default auth.uid() references profiles(id),
  created_at        timestamptz not null default now(),
  approved_by       uuid references profiles(id),
  approved_at       timestamptz,
  approval_comments text
);
create table scrap_lines (
  id            uuid primary key default gen_random_uuid(),
  scrap_id      uuid not null references scrap_notes(id) on delete cascade,
  item_id       uuid references items(id),        -- inventory item written off (WRITE_OFF)
  lot_id        uuid references stock_lots(id),
  qty           numeric(14,3) not null default 0,
  value         numeric(16,2) not null default 0,
  scrap_item_id uuid references items(id),        -- scrap stock item it becomes (kg of offcuts ...)
  scrap_qty     numeric(14,3) not null default 0,
  remarks       text
);

create or replace function public.scrap_action(p_scr uuid, p_action text, p_comments text default null)
returns text language plpgsql security definer set search_path = public as $$
declare h scrap_notes%rowtype; l record; a record; v_val numeric; v_total numeric := 0; v_sy uuid; v_lot uuid;
begin
  select * into h from scrap_notes where id = p_scr for update;
  if p_action = 'SUBMIT' then
    if not has_role('stores','production_incharge') then raise exception 'Not allowed'; end if;
    if h.status not in ('DRAFT','REJECTED') then raise exception 'Scrap note is %', h.status; end if;
    update scrap_notes set status = 'PENDING_APPROVAL' where id = p_scr; return 'PENDING_APPROVAL';
  elsif p_action = 'REJECT' then
    if not has_role('factory_manager') then raise exception 'Only the Factory Manager can reject'; end if;
    update scrap_notes set status = 'REJECTED', approved_by = auth.uid(), approved_at = now(), approval_comments = p_comments where id = p_scr;
    return 'REJECTED';
  elsif p_action <> 'APPROVE' then raise exception 'Unknown action %', p_action; end if;

  if not has_role('factory_manager') then raise exception 'Only the Factory Manager can approve scrap'; end if;
  if h.status <> 'PENDING_APPROVAL' then raise exception 'Not pending approval'; end if;
  select id into v_sy from locations where loc_type = 'SCRAP_YARD' order by created_at limit 1;

  for l in select * from scrap_lines where scrap_id = p_scr loop
    v_val := 0;
    if h.scrap_type = 'WRITE_OFF' then
      if l.item_id is null or l.qty <= 0 then raise exception 'Write-off line needs item and qty'; end if;
      for a in select * from fifo_consume(l.item_id, h.location_id, l.qty, null, 'SCRAP_WRITE_OFF', 'SCRAP',
                                          h.id, h.scrap_no, l.id, h.scrap_date, h.project_id, h.cost_center_id,
                                          l.lot_id, true) loop
        v_val := v_val + round(a.qty * a.unit_cost, 2);
      end loop;
    end if;
    if l.scrap_item_id is not null and l.scrap_qty > 0 then
      insert into stock_lots (item_id, location_id, lot_no, source_type, source_id, received_date, unit_cost, qty_in, qty_on_hand)
      values (l.scrap_item_id, v_sy, h.scrap_no, 'SCRAP_GEN', l.id, h.scrap_date, 0, l.scrap_qty, l.scrap_qty)
      returning id into v_lot;
      insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value,
                                doc_type, doc_id, doc_no, doc_line_id, project_id)
      values (h.scrap_date, 'SCRAP_IN', l.scrap_item_id, v_sy, v_lot, l.scrap_qty, 0, 0, 'SCRAP', h.id, h.scrap_no, l.id, h.project_id);
    end if;
    update scrap_lines set value = v_val where id = l.id;
    v_total := v_total + v_val;
  end loop;
  update scrap_notes set status = 'POSTED', total_value = v_total, approved_by = auth.uid(), approved_at = now(),
         approval_comments = p_comments where id = p_scr;
  return 'POSTED';
end $$;

-- ---------- Scrap disposal (sale / disposal) - FM approval ----------
create table scrap_disposals (
  id                uuid primary key default gen_random_uuid(),
  disposal_no       text not null unique default next_doc_no('SDN'),
  disposal_date     date not null default current_date,
  method            text not null check (method in ('SALE','RECYCLE','FREE_DISPOSAL','LANDFILL')),
  buyer_name        text,
  buyer_trn         text,
  buyer_contact     text,
  gate_pass_no      text,
  vehicle_no        text,
  weighbridge_ticket text,
  location_id       uuid references locations(id),
  status            text not null default 'DRAFT' check (status in ('DRAFT','PENDING_APPROVAL','POSTED','REJECTED')),
  subtotal          numeric(14,2) not null default 0,
  vat_rate          numeric(5,2) not null default 5,
  vat_amount        numeric(14,2) generated always as (round(subtotal * vat_rate / 100, 2)) stored,
  total_amount      numeric(14,2) generated always as (subtotal + round(subtotal * vat_rate / 100, 2)) stored,
  payment_received  boolean not null default false,
  receipt_ref       text,
  remarks           text,
  created_by        uuid default auth.uid() references profiles(id),
  created_at        timestamptz not null default now(),
  approved_by       uuid references profiles(id),
  approved_at       timestamptz,
  approval_comments text
);
create table disposal_lines (
  id            uuid primary key default gen_random_uuid(),
  disposal_id   uuid not null references scrap_disposals(id) on delete cascade,
  scrap_item_id uuid not null references items(id),
  qty           numeric(14,3) not null check (qty > 0),
  rate          numeric(14,4) not null default 0,
  amount        numeric(14,2) generated always as (round(qty * rate, 2)) stored
);

create or replace function public.disposal_lines_recalc() returns trigger
language plpgsql security definer set search_path = public as $$
declare v uuid := coalesce(new.disposal_id, old.disposal_id);
begin
  update scrap_disposals set subtotal = coalesce((select sum(amount) from disposal_lines where disposal_id = v),0) where id = v;
  return null;
end $$;
create trigger disposal_lines_recalc after insert or update or delete on disposal_lines
  for each row execute function disposal_lines_recalc();

create or replace function public.disposal_action(p_d uuid, p_action text, p_comments text default null)
returns text language plpgsql security definer set search_path = public as $$
declare h scrap_disposals%rowtype; l record; v_loc uuid;
begin
  select * into h from scrap_disposals where id = p_d for update;
  if p_action = 'SUBMIT' then
    if not has_role('stores') then raise exception 'Only Stores can submit a disposal'; end if;
    if h.status not in ('DRAFT','REJECTED') then raise exception 'Disposal is %', h.status; end if;
    update scrap_disposals set status = 'PENDING_APPROVAL' where id = p_d; return 'PENDING_APPROVAL';
  elsif p_action = 'REJECT' then
    if not has_role('factory_manager') then raise exception 'Only the Factory Manager can reject'; end if;
    update scrap_disposals set status = 'REJECTED', approved_by = auth.uid(), approved_at = now(), approval_comments = p_comments where id = p_d;
    return 'REJECTED';
  elsif p_action <> 'APPROVE' then raise exception 'Unknown action %', p_action; end if;
  if not has_role('factory_manager') then raise exception 'Only the Factory Manager can approve a disposal'; end if;
  if h.status <> 'PENDING_APPROVAL' then raise exception 'Not pending approval'; end if;
  v_loc := coalesce(h.location_id, (select id from locations where loc_type = 'SCRAP_YARD' order by created_at limit 1));
  for l in select * from disposal_lines where disposal_id = p_d loop
    perform * from fifo_consume(l.scrap_item_id, v_loc, l.qty, null, 'SCRAP_DISPOSAL', 'DISPOSAL',
                                h.id, h.disposal_no, l.id, h.disposal_date, null, null, null, true);
  end loop;
  update scrap_disposals set status = 'POSTED', approved_by = auth.uid(), approved_at = now(), approval_comments = p_comments where id = p_d;
  return 'POSTED';
end $$;

-- ---------- Tool crib / asset custody ----------
create or replace function public.asset_move(
  p_asset uuid, p_type text, p_employee uuid default null, p_project uuid default null,
  p_cost_center uuid default null, p_to_location uuid default null, p_due_back date default null,
  p_condition text default null, p_remarks text default null)
returns text language plpgsql security definer set search_path = public as $$
declare a assets%rowtype; c item_classes%rowtype; v_status text; v_loc uuid; v_interval int; v_no text;
begin
  select * into a from assets where id = p_asset for update;
  if not found then raise exception 'Asset not found'; end if;
  select ic.* into c from items i join item_classes ic on ic.id = i.class_id where i.id = a.item_id;
  if p_type in ('LOST','SCRAP') then
    if not has_role('factory_manager') then raise exception 'Only the Factory Manager can mark assets lost/scrapped'; end if;
  elsif not has_role('stores') then raise exception 'Only Stores can move assets'; end if;

  v_loc := a.location_id; v_status := a.status;
  case p_type
    when 'ISSUE' then
      if a.status <> 'IN_STORE' then raise exception 'Asset % is % - not available', a.asset_tag, a.status; end if;
      if p_employee is null then raise exception 'Select the employee receiving the tool'; end if;
      v_status := 'ISSUED'; v_loc := coalesce(p_to_location, (select id from locations where loc_type = 'SHOP_FLOOR' order by created_at limit 1));
      update assets set custodian_employee_id = p_employee, project_id = p_project, cost_center_id = p_cost_center where id = p_asset;
    when 'RETURN' then
      if a.status not in ('ISSUED','INSTALLED') then raise exception 'Asset % is not issued', a.asset_tag; end if;
      v_status := case when p_condition in ('DAMAGED','NEEDS_REPAIR') then 'UNDER_REPAIR' else 'IN_STORE' end;
      v_loc := coalesce(p_to_location, (select id from locations where code = 'MS'));
      update assets set custodian_employee_id = null, project_id = null where id = p_asset;
    when 'INSTALL' then
      if a.status not in ('IN_STORE','INSTALLED') then raise exception 'Asset % is %', a.asset_tag, a.status; end if;
      if p_to_location is null then raise exception 'Select installation location'; end if;
      v_status := 'INSTALLED'; v_loc := p_to_location;
      update assets set custodian_employee_id = p_employee, cost_center_id = p_cost_center where id = p_asset;
    when 'TRANSFER' then
      if p_to_location is null then raise exception 'Select destination'; end if;
      v_loc := p_to_location;
    when 'REPAIR_OUT' then v_status := 'UNDER_REPAIR';
    when 'REPAIR_IN' then v_status := 'IN_STORE'; v_loc := coalesce(p_to_location, (select id from locations where code = 'MS'));
    when 'CALIBRATION' then
      select calibration_interval_days into v_interval from items where id = a.item_id;
      update assets set last_calibration_date = current_date,
             calibration_due_date = current_date + coalesce(v_interval, 365) where id = p_asset;
    when 'LOST' then v_status := 'LOST';
    when 'SCRAP' then v_status := 'SCRAPPED';
    else raise exception 'Unknown move type %', p_type;
  end case;

  insert into asset_movements (asset_id, move_type, from_location_id, to_location_id, employee_id, project_id,
                               cost_center_id, due_back, condition, remarks)
  values (p_asset, p_type, a.location_id, v_loc, coalesce(p_employee, a.custodian_employee_id), p_project,
          p_cost_center, p_due_back, p_condition, p_remarks)
  returning doc_no into v_no;
  update assets set status = v_status, location_id = v_loc where id = p_asset;
  return v_no;
end $$;

-- ---------- Purchase returns / debit notes ----------
create table purchase_returns (
  id                 uuid primary key default gen_random_uuid(),
  prt_no             text not null unique default next_doc_no('PRT'),
  return_date        date not null default current_date,
  vendor_id          uuid not null references vendors(id),
  grn_id             uuid not null references grns(id),
  return_type        text not null check (return_type in ('REJECTED_AT_GRN','FROM_STOCK')),
  replacement_required boolean not null default false,
  status             text not null default 'DRAFT' check (status in ('DRAFT','POSTED','CANCELLED')),
  reason             text,
  subtotal           numeric(14,2) not null default 0,
  vat_amount         numeric(14,2) not null default 0,
  total_amount       numeric(14,2) not null default 0,
  gate_pass_no       text,
  vehicle_no         text,
  created_by         uuid default auth.uid() references profiles(id),
  created_at         timestamptz not null default now(),
  posted_by          uuid references profiles(id),
  posted_at          timestamptz
);
create table prt_lines (
  id          uuid primary key default gen_random_uuid(),
  prt_id      uuid not null references purchase_returns(id) on delete cascade,
  grn_line_id uuid not null references grn_lines(id),
  item_id     uuid not null references items(id),
  qty         numeric(14,3) not null check (qty > 0),
  rate_aed    numeric(14,4) not null default 0,
  vat_rate    numeric(5,2) not null default 5,
  amount      numeric(14,2) generated always as (round(qty * rate_aed, 2)) stored
);

create or replace function public.post_purchase_return(p_prt uuid) returns void
language plpgsql security definer set search_path = public as $$
declare h purchase_returns%rowtype; g grns%rowtype; l record; v_done numeric; v_lot uuid; v_sub numeric := 0; v_vat numeric := 0;
begin
  if not has_role('stores','purchase') then raise exception 'Not allowed'; end if;
  select * into h from purchase_returns where id = p_prt for update;
  if h.status <> 'DRAFT' then raise exception 'Return is already %', h.status; end if;
  select * into g from grns where id = h.grn_id;
  if g.status <> 'POSTED' then raise exception 'GRN is not posted'; end if;

  for l in select pl.*, gl.grn_id src_grn, gl.rejected_qty, gl.accepted_qty, gl.po_line_id
             from prt_lines pl join grn_lines gl on gl.id = pl.grn_line_id where pl.prt_id = p_prt loop
    if l.src_grn <> h.grn_id then raise exception 'Line does not belong to GRN %', g.grn_no; end if;
    select coalesce(sum(x.qty),0) into v_done from prt_lines x join purchase_returns p on p.id = x.prt_id
     where x.grn_line_id = l.grn_line_id and p.status = 'POSTED' and p.return_type = h.return_type;
    if h.return_type = 'REJECTED_AT_GRN' then
      if l.qty + v_done > l.rejected_qty + 0.0005 then raise exception 'Return exceeds rejected qty'; end if;
    else
      if l.qty + v_done > l.accepted_qty + 0.0005 then raise exception 'Return exceeds accepted qty'; end if;
      select id into v_lot from stock_lots where source_type = 'GRN' and source_id = l.grn_line_id limit 1;
      if v_lot is null then raise exception 'Original GRN lot not found (serialised items are returned from the asset register)'; end if;
      perform * from fifo_consume(l.item_id, (select location_id from stock_lots where id = v_lot), l.qty, null,
                                  'PURCHASE_RETURN', 'PRT', h.id, h.prt_no, l.id, h.return_date, null, null, v_lot, true);
      if l.po_line_id is not null then
        update po_lines set returned_qty = returned_qty + l.qty,
               received_qty = received_qty - case when h.replacement_required then l.qty else 0 end
         where id = l.po_line_id;
      end if;
    end if;
    v_sub := v_sub + l.amount;
    v_vat := v_vat + round(l.amount * l.vat_rate / 100, 2);
  end loop;

  if h.return_type = 'FROM_STOCK' and h.replacement_required and g.po_id is not null then
    update purchase_orders set status = 'PARTIALLY_RECEIVED' where id = g.po_id and status in ('RECEIVED','CLOSED');
  end if;
  update purchase_returns set status = 'POSTED', subtotal = v_sub, vat_amount = v_vat, total_amount = v_sub + v_vat,
         posted_at = now(), posted_by = auth.uid() where id = p_prt;
end $$;
