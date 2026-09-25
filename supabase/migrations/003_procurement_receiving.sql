-- =====================================================================
-- Citi Homes IMS - 003 Procurement, Receiving, Lots, Ledger, Assets
-- =====================================================================

-- ---------- TOC buffer & misc item columns ----------
alter table items
  add column buffer_target            numeric(14,3) not null default 0,  -- TOC buffer (red/yellow/green thirds)
  add column dbm_enabled              boolean not null default false,    -- dynamic buffer management
  add column buffer_adjusted_at       date,
  add column calibration_interval_days int;

alter table company_settings
  add column grn_over_receipt_pct numeric(5,2) not null default 0,
  add column po_terms_conditions  text;

-- ---------- Purchase requisitions ----------
create table purchase_requisitions (
  id            uuid primary key default gen_random_uuid(),
  pr_no         text not null unique default next_doc_no('PR'),
  pr_date       date not null default current_date,
  source        text not null default 'MANUAL' check (source in ('MANUAL','BUFFER','MATERIAL_REQUEST')),
  project_id    uuid references projects(id),
  required_date date,
  status        text not null default 'DRAFT'
                check (status in ('DRAFT','SUBMITTED','PARTIAL_PO','PO_CREATED','CANCELLED')),
  remarks       text,
  requested_by  uuid default auth.uid() references profiles(id),
  created_at    timestamptz not null default now()
);
create table pr_lines (
  id            uuid primary key default gen_random_uuid(),
  pr_id         uuid not null references purchase_requisitions(id) on delete cascade,
  line_no       int not null default 1,
  item_id       uuid not null references items(id),
  qty           numeric(14,3) not null check (qty > 0),
  ordered_qty   numeric(14,3) not null default 0,
  required_date date,
  remarks       text
);

-- ---------- Purchase orders ----------
create table purchase_orders (
  id                   uuid primary key default gen_random_uuid(),
  po_no                text not null unique default next_doc_no('PO'),
  po_date              date not null default current_date,
  vendor_id            uuid not null references vendors(id),
  po_type              text not null default 'LOCAL' check (po_type in ('LOCAL','IMPORT')),
  currency             text not null default 'AED',
  exchange_rate        numeric(12,6) not null default 1 check (exchange_rate > 0),
  payment_term_id      uuid references payment_terms(id),
  delivery_date        date,
  delivery_location_id uuid references locations(id),
  project_id           uuid references projects(id),
  incoterms            text,
  quotation_ref        text,
  subtotal             numeric(14,2) not null default 0,
  vat_amount           numeric(14,2) not null default 0,
  total_amount         numeric(14,2) not null default 0,
  total_aed            numeric(14,2) generated always as (round(total_amount * exchange_rate, 2)) stored,
  status               text not null default 'DRAFT' check (status in
                        ('DRAFT','PENDING_FM','PENDING_FINANCE','PENDING_TOP_MGMT','APPROVED',
                         'RELEASED','PARTIALLY_RECEIVED','RECEIVED','CLOSED','CANCELLED','REJECTED')),
  top_mgmt_ref_no      text,
  top_mgmt_ref_date    date,
  top_mgmt_doc_url     text,
  terms_conditions     text,
  remarks              text,
  created_by           uuid default auth.uid() references profiles(id),
  created_at           timestamptz not null default now(),
  submitted_at         timestamptz,
  approved_at          timestamptz,
  released_at          timestamptz,
  closed_at            timestamptz,
  updated_at           timestamptz not null default now()
);
create index po_vendor_idx on purchase_orders(vendor_id);
create index po_status_idx on purchase_orders(status);
create trigger po_touch before update on purchase_orders for each row execute function touch_updated_at();

create table po_lines (
  id            uuid primary key default gen_random_uuid(),
  po_id         uuid not null references purchase_orders(id) on delete cascade,
  line_no       int not null default 1,
  item_id       uuid not null references items(id),
  description   text,
  qty           numeric(14,3) not null check (qty > 0),
  rate          numeric(14,4) not null check (rate >= 0),
  discount_pct  numeric(5,2) not null default 0,
  vat_rate      numeric(5,2) not null default 5,
  line_amount   numeric(14,2) generated always as (round(qty * rate * (1 - discount_pct/100), 2)) stored,
  vat_amount    numeric(14,2) generated always as (round(qty * rate * (1 - discount_pct/100) * vat_rate/100, 2)) stored,
  received_qty  numeric(14,3) not null default 0,
  returned_qty  numeric(14,3) not null default 0,
  required_date date,
  pr_line_id    uuid references pr_lines(id)
);
create index po_lines_po_idx on po_lines(po_id);

create or replace function public.po_lines_recalc() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_po uuid := coalesce(new.po_id, old.po_id);
begin
  update purchase_orders po
     set subtotal = s.amt, vat_amount = s.vat, total_amount = s.amt + s.vat
    from (select coalesce(sum(line_amount),0) amt, coalesce(sum(vat_amount),0) vat
            from po_lines where po_id = v_po) s
   where po.id = v_po;
  return null;
end $$;
create trigger po_lines_recalc after insert or update or delete on po_lines
  for each row execute function po_lines_recalc();

-- keep PR ordered_qty in sync with PO lines
create or replace function public.pr_ordered_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_pr_line uuid := coalesce(new.pr_line_id, old.pr_line_id); v_pr uuid;
begin
  if v_pr_line is null then return null; end if;
  update pr_lines pl set ordered_qty = coalesce((
      select sum(l.qty) from po_lines l join purchase_orders p on p.id = l.po_id
       where l.pr_line_id = pl.id and p.status not in ('CANCELLED')), 0)
   where pl.id = v_pr_line returning pr_id into v_pr;
  update purchase_requisitions r set status = case
      when not exists (select 1 from pr_lines where pr_id = r.id and ordered_qty < qty) then 'PO_CREATED'
      when exists (select 1 from pr_lines where pr_id = r.id and ordered_qty > 0) then 'PARTIAL_PO'
      else 'SUBMITTED' end
   where r.id = v_pr and r.status not in ('DRAFT','CANCELLED');
  return null;
end $$;
create trigger po_lines_pr_sync after insert or update or delete on po_lines
  for each row execute function pr_ordered_sync();

create table po_approvals (
  id        uuid primary key default gen_random_uuid(),
  po_id     uuid not null references purchase_orders(id) on delete cascade,
  stage     text not null check (stage in ('SUBMIT','FM','FINANCE','TOP_MGMT','RELEASE','CLOSE','CANCEL')),
  action    text not null check (action in ('SUBMITTED','APPROVED','REJECTED','RELEASED','CLOSED','CANCELLED')),
  acted_by  uuid default auth.uid() references profiles(id),
  acted_at  timestamptz not null default now(),
  comments  text,
  ref_no    text
);

-- PO workflow: DRAFT -> PENDING_FM -> PENDING_FINANCE -> PENDING_TOP_MGMT -> APPROVED -> RELEASED
create or replace function public.po_action(
  p_po uuid, p_action text, p_comments text default null,
  p_ref_no text default null, p_ref_date date default null, p_doc_url text default null)
returns text language plpgsql security definer set search_path = public as $$
declare r purchase_orders%rowtype; v_new text; v_stage text; v_act text;
begin
  select * into r from purchase_orders where id = p_po for update;
  if not found then raise exception 'PO not found'; end if;

  if p_action = 'SUBMIT' then
    if not has_role('purchase') then raise exception 'Only Purchase can submit a PO'; end if;
    if r.status not in ('DRAFT','REJECTED') then raise exception 'PO % is %', r.po_no, r.status; end if;
    if not exists (select 1 from po_lines where po_id = p_po) then raise exception 'PO has no lines'; end if;
    v_new := 'PENDING_FM'; v_stage := 'SUBMIT'; v_act := 'SUBMITTED';
    update purchase_orders set submitted_at = now() where id = p_po;

  elsif p_action in ('APPROVE','REJECT') then
    if r.status = 'PENDING_FM' then
      if not has_role('factory_manager') then raise exception 'Awaiting Factory Manager approval'; end if;
      v_stage := 'FM'; v_new := case when p_action = 'APPROVE' then 'PENDING_FINANCE' else 'REJECTED' end;
    elsif r.status = 'PENDING_FINANCE' then
      if not has_role('finance') then raise exception 'Awaiting Finance approval'; end if;
      v_stage := 'FINANCE'; v_new := case when p_action = 'APPROVE' then 'PENDING_TOP_MGMT' else 'REJECTED' end;
    elsif r.status = 'PENDING_TOP_MGMT' then
      if not has_role('purchase','finance') then raise exception 'Only Purchase/Finance can record top management decision'; end if;
      if p_action = 'APPROVE' and coalesce(p_ref_no,'') = '' then
        raise exception 'Top management approval reference number is required';
      end if;
      v_stage := 'TOP_MGMT'; v_new := case when p_action = 'APPROVE' then 'APPROVED' else 'REJECTED' end;
      update purchase_orders set top_mgmt_ref_no = p_ref_no, top_mgmt_ref_date = coalesce(p_ref_date, current_date),
             top_mgmt_doc_url = coalesce(p_doc_url, top_mgmt_doc_url),
             approved_at = case when p_action = 'APPROVE' then now() end
       where id = p_po;
    else
      raise exception 'PO % is not pending approval (status %)', r.po_no, r.status;
    end if;
    if p_action = 'REJECT' and coalesce(p_comments,'') = '' then raise exception 'Rejection reason is required'; end if;
    v_act := case when p_action = 'APPROVE' then 'APPROVED' else 'REJECTED' end;

  elsif p_action = 'RELEASE' then
    if not has_role('purchase') then raise exception 'Only Purchase can release a PO'; end if;
    if r.status <> 'APPROVED' then raise exception 'Only fully approved POs can be released'; end if;
    v_new := 'RELEASED'; v_stage := 'RELEASE'; v_act := 'RELEASED';
    update purchase_orders set released_at = now() where id = p_po;

  elsif p_action = 'CLOSE' then   -- short close balance qty
    if not has_role('purchase','factory_manager') then raise exception 'Not allowed'; end if;
    if r.status not in ('RELEASED','PARTIALLY_RECEIVED') then raise exception 'Cannot close a % PO', r.status; end if;
    v_new := 'CLOSED'; v_stage := 'CLOSE'; v_act := 'CLOSED';
    update purchase_orders set closed_at = now() where id = p_po;

  elsif p_action = 'CANCEL' then
    if not has_role('purchase','factory_manager') then raise exception 'Not allowed'; end if;
    if exists (select 1 from po_lines where po_id = p_po and received_qty > 0) then
      raise exception 'PO has receipts; use CLOSE instead';
    end if;
    if r.status in ('CLOSED','CANCELLED','RECEIVED') then raise exception 'PO already %', r.status; end if;
    v_new := 'CANCELLED'; v_stage := 'CANCEL'; v_act := 'CANCELLED';
  else
    raise exception 'Unknown action %', p_action;
  end if;

  update purchase_orders set status = v_new where id = p_po;
  insert into po_approvals (po_id, stage, action, comments, ref_no) values (p_po, v_stage, v_act, p_comments, p_ref_no);
  -- a cancelled PO frees PR quantities
  if v_new = 'CANCELLED' then update po_lines set pr_line_id = pr_line_id where po_id = p_po; end if;
  return v_new;
end $$;

-- ---------- GRN / stock receipts ----------
create table grns (
  id                  uuid primary key default gen_random_uuid(),
  grn_no              text not null unique default next_doc_no('GRN'),
  grn_date            date not null default current_date,
  receipt_type        text not null default 'PO'
                      check (receipt_type in ('PO','NON_PO','OPENING','CUSTOMER_SUPPLIED','SAMPLE')),
  po_id               uuid references purchase_orders(id),
  vendor_id           uuid references vendors(id),
  project_id          uuid references projects(id),
  vendor_dn_no        text,
  vendor_dn_date      date,
  vendor_invoice_no   text,
  vendor_invoice_date date,
  currency            text not null default 'AED',
  exchange_rate       numeric(12,6) not null default 1 check (exchange_rate > 0),
  vehicle_no          text,
  location_id         uuid references locations(id),
  status              text not null default 'DRAFT' check (status in ('DRAFT','POSTED','CANCELLED')),
  remarks             text,
  created_by          uuid default auth.uid() references profiles(id),
  created_at          timestamptz not null default now(),
  posted_by           uuid references profiles(id),
  posted_at           timestamptz,
  constraint grn_po_required check (receipt_type <> 'PO' or po_id is not null)
);
create index grns_po_idx on grns(po_id);

create table grn_lines (
  id                     uuid primary key default gen_random_uuid(),
  grn_id                 uuid not null references grns(id) on delete cascade,
  line_no                int not null default 1,
  po_line_id             uuid references po_lines(id),
  item_id                uuid not null references items(id),
  received_qty           numeric(14,3) not null default 0 check (received_qty >= 0),
  accepted_qty           numeric(14,3) not null default 0 check (accepted_qty >= 0),
  rejected_qty           numeric(14,3) generated always as (received_qty - accepted_qty) stored,
  rejection_reason       text,
  rate                   numeric(14,4) not null default 0,       -- in GRN currency, excl. VAT
  vat_rate               numeric(5,2) not null default 5,
  landed_cost_per_unit   numeric(14,4) not null default 0,       -- AED, allocated at posting
  unit_cost_aed          numeric(14,4),                          -- rate*fx + landed, set at posting
  lot_no                 text,
  batch_no               text,
  mfg_date               date,
  expiry_date            date,
  original_receipt_date  date,                                   -- opening stock aging
  location_id            uuid references locations(id),
  serial_nos             text[],
  remarks                text,
  constraint accepted_le_received check (accepted_qty <= received_qty)
);
create index grn_lines_grn_idx on grn_lines(grn_id);

-- landed cost charges (freight, customs duty, clearing ...)
create table grn_charges (
  id           uuid primary key default gen_random_uuid(),
  grn_id       uuid not null references grns(id) on delete cascade,
  charge_type  text not null check (charge_type in ('FREIGHT','CUSTOMS_DUTY','CLEARING','INSURANCE','HANDLING','OTHER')),
  vendor_id    uuid references vendors(id),      -- service provider to be paid (payables)
  reference    text,
  amount_aed   numeric(14,2) not null check (amount_aed >= 0),
  vat_amount   numeric(14,2) not null default 0,
  alloc_basis  text not null default 'VALUE' check (alloc_basis in ('VALUE','QTY'))
);

-- ---------- Stock lots (FIFO layers) ----------
create table stock_lots (
  id             uuid primary key default gen_random_uuid(),
  item_id        uuid not null references items(id),
  location_id    uuid not null references locations(id),
  lot_no         text not null,
  batch_no       text,
  source_type    text not null check (source_type in ('GRN','RETURN','TRANSFER','ADJUSTMENT','SCRAP_GEN')),
  source_id      uuid,
  parent_lot_id  uuid references stock_lots(id),
  received_date  date not null,          -- aging anchor, preserved across transfers & returns
  mfg_date       date,
  expiry_date    date,
  unit_cost      numeric(14,4) not null default 0,
  qty_in         numeric(14,3) not null,
  qty_on_hand    numeric(14,3) not null check (qty_on_hand >= 0),
  vendor_id      uuid references vendors(id),
  project_id     uuid references projects(id),   -- customer-supplied / reserved for project
  status         text not null default 'AVAILABLE' check (status in ('AVAILABLE','HOLD')),
  created_at     timestamptz not null default now()
);
create index stock_lots_item_idx on stock_lots(item_id, location_id) where qty_on_hand > 0;

create table stock_ledger (
  id             bigserial primary key,
  txn_at         timestamptz not null default now(),
  txn_date       date not null default current_date,
  txn_type       text not null check (txn_type in
                  ('GRN','ISSUE','RETURN','TRANSFER_OUT','TRANSFER_IN','ADJ_IN','ADJ_OUT',
                   'SCRAP_WRITE_OFF','SCRAP_IN','SCRAP_DISPOSAL','PURCHASE_RETURN','REVALUATION')),
  item_id        uuid not null references items(id),
  location_id    uuid references locations(id),
  lot_id         uuid references stock_lots(id),
  qty            numeric(14,3) not null,           -- signed
  unit_cost      numeric(14,4) not null default 0,
  value          numeric(16,2) not null default 0, -- signed
  doc_type       text not null,
  doc_id         uuid,
  doc_no         text,
  doc_line_id    uuid,
  project_id     uuid references projects(id),
  cost_center_id uuid references cost_centers(id),
  remarks        text,
  created_by     uuid default auth.uid()
);
create index stock_ledger_item_idx on stock_ledger(item_id, txn_date);
create index stock_ledger_doc_idx on stock_ledger(doc_id);
create index stock_ledger_project_idx on stock_ledger(project_id);

-- ---------- Asset register (machines, tools, office & camp equipment) ----------
create table assets (
  id                        uuid primary key default gen_random_uuid(),
  asset_tag                 text not null unique,
  item_id                   uuid not null references items(id),
  serial_no                 text,
  grn_line_id               uuid references grn_lines(id),
  purchase_date             date,
  purchase_cost             numeric(14,2) not null default 0,
  vendor_id                 uuid references vendors(id),
  location_id               uuid references locations(id),
  status                    text not null default 'IN_STORE' check (status in
                             ('IN_STORE','ISSUED','INSTALLED','UNDER_REPAIR','AT_CALIBRATION','LOST','SCRAPPED','DISPOSED')),
  custodian_employee_id     uuid references employees(id),
  cost_center_id            uuid references cost_centers(id),
  project_id                uuid references projects(id),
  warranty_expiry           date,
  last_calibration_date     date,
  calibration_due_date      date,
  useful_life_years         numeric(5,2),
  remarks                   text,
  created_at                timestamptz not null default now()
);
create index assets_item_idx on assets(item_id);

create table asset_movements (
  id              uuid primary key default gen_random_uuid(),
  doc_no          text not null default next_doc_no('TIS'),
  asset_id        uuid not null references assets(id),
  move_type       text not null check (move_type in
                   ('ISSUE','RETURN','TRANSFER','INSTALL','REPAIR_OUT','REPAIR_IN','CALIBRATION','LOST','SCRAP')),
  from_location_id uuid references locations(id),
  to_location_id   uuid references locations(id),
  employee_id     uuid references employees(id),
  project_id      uuid references projects(id),
  cost_center_id  uuid references cost_centers(id),
  moved_at        timestamptz not null default now(),
  due_back        date,
  condition       text check (condition in ('GOOD','DAMAGED','NEEDS_REPAIR')),
  remarks         text,
  created_by      uuid default auth.uid() references profiles(id)
);
create index asset_mov_asset_idx on asset_movements(asset_id, moved_at desc);

create or replace function public.next_asset_tag(p_class text) returns text
language plpgsql security definer set search_path = public as $$
declare v_no int;
begin
  insert into doc_sequences (doc_type, yr) values ('AST-' || p_class, 0) on conflict do nothing;
  update doc_sequences set next_no = next_no + 1 where doc_type = 'AST-' || p_class and yr = 0
  returning next_no - 1 into v_no;
  return p_class || '-' || lpad(v_no::text, 5, '0');
end $$;

-- ---------- Weighted average maintenance ----------
create or replace function public.wavg_receive(p_item uuid, p_qty numeric, p_cost numeric) returns void
language plpgsql security definer set search_path = public as $$
declare v_q numeric; v_avg numeric;
begin
  select avg_cost into v_avg from items where id = p_item for update;
  select coalesce(sum(qty_on_hand),0) into v_q from stock_lots where item_id = p_item;
  if v_q <= 0 then v_avg := p_cost;
  else v_avg := (v_q * v_avg + p_qty * p_cost) / (v_q + p_qty); end if;
  update items set avg_cost = round(v_avg, 4) where id = p_item;
end $$;

-- cost used when stock leaves a lot
create or replace function public.lot_issue_cost(p_lot uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select case when item_valuation(l.item_id) = 'WAVG' then i.avg_cost else l.unit_cost end
    from stock_lots l join items i on i.id = l.item_id where l.id = p_lot
$$;

-- ---------- Post GRN ----------
create or replace function public.post_grn(p_grn uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  g grns%rowtype; l record; v_cls item_classes%rowtype; v_po purchase_orders%rowtype;
  v_tol numeric; v_goods_aed numeric; v_goods_qty numeric; v_chg_val numeric; v_chg_qty numeric;
  v_lc numeric; v_cost numeric; v_lot uuid; v_loc uuid; i int;
begin
  if not has_role('stores') then raise exception 'Only Stores can post a GRN'; end if;
  select * into g from grns where id = p_grn for update;
  if not found then raise exception 'GRN not found'; end if;
  if g.status <> 'DRAFT' then raise exception 'GRN % is already %', g.grn_no, g.status; end if;
  if not exists (select 1 from grn_lines where grn_id = p_grn and received_qty > 0) then
    raise exception 'GRN has no received quantities';
  end if;

  if g.receipt_type = 'PO' then
    select * into v_po from purchase_orders where id = g.po_id for update;
    if v_po.status not in ('RELEASED','PARTIALLY_RECEIVED') then
      raise exception 'PO % is not released (status %)', v_po.po_no, v_po.status;
    end if;
    if exists (select 1 from grn_lines gl left join po_lines pl on pl.id = gl.po_line_id
                where gl.grn_id = p_grn and (pl.id is null or pl.po_id <> g.po_id)) then
      raise exception 'Every GRN line must reference a line of PO %', v_po.po_no;
    end if;
    select grn_over_receipt_pct into v_tol from company_settings;
    for l in select gl.accepted_qty, pl.qty, pl.received_qty, i.code
               from grn_lines gl join po_lines pl on pl.id = gl.po_line_id join items i on i.id = gl.item_id
              where gl.grn_id = p_grn loop
      if l.accepted_qty + l.received_qty > l.qty * (1 + v_tol/100) + 0.0005 then
        raise exception 'Over-receipt on % : PO qty %, already received %, now %', l.code, l.qty, l.received_qty, l.accepted_qty;
      end if;
    end loop;
  end if;

  -- landed-cost allocation base
  select coalesce(sum(accepted_qty * rate),0) * g.exchange_rate, coalesce(sum(accepted_qty),0)
    into v_goods_aed, v_goods_qty from grn_lines where grn_id = p_grn;
  select coalesce(sum(amount_aed) filter (where alloc_basis = 'VALUE'),0),
         coalesce(sum(amount_aed) filter (where alloc_basis = 'QTY'),0)
    into v_chg_val, v_chg_qty from grn_charges where grn_id = p_grn;
  if v_chg_val > 0 and v_goods_aed = 0 then raise exception 'Cannot allocate value-based charges on zero-value receipt'; end if;

  for l in select gl.*, it.class_id, it.code item_code
             from grn_lines gl join items it on it.id = gl.item_id
            where gl.grn_id = p_grn order by gl.line_no loop
    if l.po_line_id is not null then
      update po_lines set received_qty = received_qty + l.accepted_qty where id = l.po_line_id;
    end if;
    continue when l.accepted_qty <= 0;

    v_lc := 0;
    if v_goods_aed > 0 then v_lc := v_lc + v_chg_val * (l.rate * g.exchange_rate) / v_goods_aed; end if;
    if v_goods_qty > 0 then v_lc := v_lc + v_chg_qty / v_goods_qty; end if;
    v_cost := round(l.rate * g.exchange_rate + v_lc, 4);
    update grn_lines set landed_cost_per_unit = round(v_lc,4), unit_cost_aed = v_cost where id = l.id;

    select * into v_cls from item_classes where id = l.class_id;
    v_loc := coalesce(l.location_id, g.location_id, (select id from locations where code = 'MS'));

    if v_cls.tracking = 'SERIAL' then
      if l.accepted_qty <> trunc(l.accepted_qty) then
        raise exception 'Serialised item % must be received in whole numbers', l.item_code;
      end if;
      for i in 1 .. l.accepted_qty::int loop
        insert into assets (asset_tag, item_id, serial_no, grn_line_id, purchase_date, purchase_cost,
                            vendor_id, location_id, status, project_id)
        values (next_asset_tag(v_cls.code), l.item_id,
                case when coalesce(array_length(l.serial_nos,1),0) >= i then l.serial_nos[i] end,
                l.id, g.grn_date, v_cost, g.vendor_id, v_loc, 'IN_STORE', g.project_id);
      end loop;
      insert into stock_ledger (txn_date, txn_type, item_id, location_id, qty, unit_cost, value,
                                doc_type, doc_id, doc_no, doc_line_id, project_id, remarks)
      values (g.grn_date, 'GRN', l.item_id, v_loc, l.accepted_qty, v_cost, round(l.accepted_qty * v_cost, 2),
              'GRN', g.id, g.grn_no, l.id, g.project_id, 'Capitalised to asset register');
    else
      if item_valuation(l.item_id) = 'WAVG' then perform wavg_receive(l.item_id, l.accepted_qty, v_cost); end if;
      insert into stock_lots (item_id, location_id, lot_no, batch_no, source_type, source_id, received_date,
                              mfg_date, expiry_date, unit_cost, qty_in, qty_on_hand, vendor_id, project_id)
      values (l.item_id, v_loc, coalesce(nullif(l.lot_no,''), g.grn_no || '-' || l.line_no), l.batch_no,
              'GRN', l.id, coalesce(l.original_receipt_date, g.grn_date), l.mfg_date, l.expiry_date,
              v_cost, l.accepted_qty, l.accepted_qty, g.vendor_id,
              case when g.receipt_type = 'CUSTOMER_SUPPLIED' then g.project_id end)
      returning id into v_lot;
      insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value,
                                doc_type, doc_id, doc_no, doc_line_id, project_id)
      values (g.grn_date, 'GRN', l.item_id, v_loc, v_lot, l.accepted_qty, v_cost,
              round(l.accepted_qty * v_cost, 2), 'GRN', g.id, g.grn_no, l.id, g.project_id);
    end if;

    if l.rate > 0 then update items set last_purchase_rate = v_cost where id = l.item_id; end if;
    if g.receipt_type = 'PO' then
      insert into item_vendors (item_id, vendor_id, price, currency)
      values (l.item_id, g.vendor_id, l.rate, g.currency)
      on conflict (item_id, vendor_id) do update set price = excluded.price, currency = excluded.currency;
    end if;
  end loop;

  if g.receipt_type = 'PO' then
    update purchase_orders set status = case
        when not exists (select 1 from po_lines where po_id = g.po_id and received_qty < qty) then 'RECEIVED'
        else 'PARTIALLY_RECEIVED' end
     where id = g.po_id;
  end if;

  update grns set status = 'POSTED', posted_at = now(), posted_by = auth.uid() where id = p_grn;
  insert into audit_log (entity, entity_id, action, details)
  values ('grn', p_grn, 'POSTED', jsonb_build_object('grn_no', g.grn_no));
end $$;
