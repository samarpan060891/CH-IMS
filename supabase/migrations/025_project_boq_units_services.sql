-- =====================================================================
-- Citi Homes IMS - 025 Projects: BOQ (made in-house / bought-out / services), unit codes,
-- services through PO -> work-done certificate (GRN) -> invoice, own installation team logs,
-- installation progress, BOQ / unit billing progress and project costs
-- =====================================================================

-- ---------- services as non-stock items ----------
alter table item_classes drop constraint item_classes_valuation_method_check;
alter table item_classes add constraint item_classes_valuation_method_check check (valuation_method in ('FIFO','WAVG','ASSET','EXPENSE'));
insert into item_classes (code, name, valuation_method, tracking, sort_order) values ('SRV', 'Services (non-stock)', 'EXPENSE', 'LOT', 13) on conflict (code) do nothing;
insert into item_categories (class_id, code, name)
select c.id, v.code, v.name from item_classes c
join (values ('SRV-INS','Installation subcontract'),('SRV-TRN','Transport / delivery hire'),('SRV-OTH','Other site services')) v(code, name) on true
where c.code = 'SRV' on conflict (code) do nothing;
insert into uoms (code, name, decimals) values ('TRIP','Trip',0), ('JOB','Job / lump sum',2), ('UNIT','Apartment / unit',0) on conflict (code) do nothing;

-- ---------- project structure ----------
alter table projects add column billing_basis text not null default 'BOQ_ITEM' check (billing_basis in ('BOQ_ITEM','UNIT'));

create table project_units (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references projects(id) on delete cascade,
  unit_code      text not null,
  unit_type      text,                       -- e.g. 2BR-A, Studio
  building       text,
  floor          text,
  description    text,
  sale_value     numeric(16,2),              -- unit price when billing unit-wise
  status         text not null default 'NOT_STARTED' check (status in ('NOT_STARTED','IN_PROGRESS','INSTALLED','SNAGGING','HANDED_OVER')),
  handed_over_at date,
  handed_over_to text,
  remarks        text,
  unique (project_id, unit_code)
);
create index project_units_project_idx on project_units(project_id);

create table boq_lines (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  line_no       int not null default 1,
  boq_ref       text,                         -- client / estimate reference
  description   text not null,
  category      text not null check (category in ('MANUFACTURED','BOUGHT_OUT','SERVICE')),
  item_id       uuid references items(id),    -- FG product / bought-out item / service item
  uom           text,
  unit_type     text,                         -- attach to every unit of this type ...
  unit_codes    text,                         -- ... or to listed unit codes (comma separated)
  qty_per_unit  numeric(14,3),
  qty           numeric(14,3) not null default 0 check (qty >= 0),
  sell_rate     numeric(16,2) not null default 0,
  est_unit_cost numeric(16,2) not null default 0,
  template_id   uuid references bom_templates(id),
  supply_mode   text check (supply_mode in ('FACTORY','DIRECT_TO_SITE')),
  service_mode  text check (service_mode in ('OWN_TEAM','SUBCONTRACT','HIRED')),
  remarks       text
);
create index boq_lines_project_idx on boq_lines(project_id, line_no);

create table boq_line_units (
  id          uuid primary key default gen_random_uuid(),
  boq_line_id uuid not null references boq_lines(id) on delete cascade,
  unit_id     uuid not null references project_units(id) on delete cascade,
  qty         numeric(14,3) not null check (qty > 0),
  unique (boq_line_id, unit_id)
);

-- rebuild unit allocations from unit_type / unit_codes x qty_per_unit, and set line qty
create or replace function public.boq_sync_units(p_project uuid) returns int
language plpgsql security definer set search_path = public as $$
declare l record; n int := 0; v_bad text;
begin
  if not has_role('factory_manager','production_incharge','finance') then raise exception 'Not allowed'; end if;
  for l in select * from boq_lines where project_id = p_project and (coalesce(unit_type, '') <> '' or coalesce(unit_codes, '') <> '') loop
    if coalesce(l.qty_per_unit, 0) <= 0 then raise exception 'BOQ line % (%): enter Qty per unit', l.line_no, coalesce(l.boq_ref, l.description); end if;
    select string_agg(c, ', ') into v_bad from unnest(string_to_array(coalesce(l.unit_codes, ''), ',')) c0(c0), lateral (select trim(c0) c) x
     where c <> '' and not exists (select 1 from project_units u where u.project_id = p_project and upper(u.unit_code) = upper(c));
    if v_bad is not null then raise exception 'BOQ line %: unknown unit code(s) %', l.line_no, v_bad; end if;
    delete from boq_line_units where boq_line_id = l.id;
    insert into boq_line_units (boq_line_id, unit_id, qty)
    select l.id, u.id, l.qty_per_unit from project_units u
     where u.project_id = p_project
       and ((coalesce(l.unit_type, '') <> '' and upper(u.unit_type) = upper(trim(l.unit_type)))
         or upper(u.unit_code) in (select upper(trim(c)) from unnest(string_to_array(coalesce(l.unit_codes, ''), ',')) c where trim(c) <> ''));
    update boq_lines set qty = coalesce((select sum(qty) from boq_line_units where boq_line_id = l.id), 0) where id = l.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- links from documents to BOQ lines ----------
alter table production_orders add column boq_line_id uuid references boq_lines(id);
alter table pr_lines          add column boq_line_id uuid references boq_lines(id);
alter table po_lines          add column boq_line_id uuid references boq_lines(id);
alter table grn_lines         add column boq_line_id uuid references boq_lines(id);
alter table dispatch_lines    add column boq_line_id uuid references boq_lines(id),
                              add column unit_id uuid references project_units(id);

-- shared by four tables: source columns are read through jsonb because each table has different ones
create or replace function public.trg_boq_inherit() returns trigger
language plpgsql security definer set search_path = public as $$
declare j jsonb := to_jsonb(new); v uuid;
begin
  if new.boq_line_id is null then
    if tg_table_name = 'po_lines' then
      select boq_line_id into v from pr_lines where id = (j->>'pr_line_id')::uuid;
    elsif tg_table_name = 'grn_lines' then
      select boq_line_id into v from po_lines where id = (j->>'po_line_id')::uuid;
    elsif tg_table_name = 'production_orders' then
      select boq_line_id into v from production_orders where id = (j->>'parent_wo_id')::uuid;
    elsif tg_table_name = 'dispatch_lines' then
      select boq_line_id into v from production_orders where id = (j->>'production_order_id')::uuid;
    end if;
    new.boq_line_id := v;
  end if;
  return new;
end $$;
create trigger boq_inherit before insert or update on po_lines for each row execute function trg_boq_inherit();
create trigger boq_inherit before insert or update on grn_lines for each row execute function trg_boq_inherit();
create trigger boq_inherit before insert on production_orders for each row execute function trg_boq_inherit();
create trigger boq_inherit before insert or update on dispatch_lines for each row execute function trg_boq_inherit();
revoke execute on function public.trg_boq_inherit() from public, anon, authenticated;

-- ---------- project cost entries (services, own installation labour, other) ----------
create table project_costs (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references projects(id),
  boq_line_id uuid references boq_lines(id),
  unit_id     uuid references project_units(id),
  cost_date   date not null default current_date,
  source      text not null check (source in ('SERVICE_GRN','INSTALL_LABOUR','OTHER')),
  source_id   uuid,
  doc_no      text,
  item_id     uuid references items(id),
  description text,
  qty         numeric(14,3),
  amount      numeric(16,2) not null,
  created_by  uuid default auth.uid() references profiles(id),
  created_at  timestamptz not null default now()
);
create index project_costs_project_idx on project_costs(project_id);

-- ---------- GRN: services (EXPENSE class) are not stocked; cost goes to the project ----------
create or replace function public.post_grn(p_grn uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  g grns%rowtype; l record; v_cls item_classes%rowtype; v_po purchase_orders%rowtype;
  v_tol numeric; v_goods_aed numeric; v_goods_qty numeric; v_chg_val numeric; v_chg_qty numeric;
  v_lc numeric; v_cost numeric; v_lot uuid; v_loc uuid; v_qa uuid; v_proj uuid; i int;
  v_dmg numeric; v_good numeric; v_bal numeric; v_acc numeric; v_exc numeric;
  v_prt uuid; v_prt_n int := 0; v_exc_total numeric := 0;
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
  end if;
  select grn_over_receipt_pct into v_tol from company_settings;
  select id into v_qa from locations where loc_type = 'QUARANTINE' order by created_at limit 1;

  select coalesce(sum(received_qty * rate),0) * g.exchange_rate, coalesce(sum(received_qty),0)
    into v_goods_aed, v_goods_qty from grn_lines where grn_id = p_grn;
  select coalesce(sum(amount_aed) filter (where alloc_basis = 'VALUE'),0),
         coalesce(sum(amount_aed) filter (where alloc_basis = 'QTY'),0)
    into v_chg_val, v_chg_qty from grn_charges where grn_id = p_grn;
  if v_chg_val > 0 and v_goods_aed = 0 then raise exception 'Cannot allocate value-based charges on zero-value receipt'; end if;

  for l in select gl.*, it.class_id, it.code item_code, it.name item_name, pl.project_id po_project
             from grn_lines gl join items it on it.id = gl.item_id
             left join po_lines pl on pl.id = gl.po_line_id
            where gl.grn_id = p_grn order by gl.line_no loop
    select * into v_cls from item_classes where id = l.class_id;
    v_dmg := case when v_cls.valuation_method = 'EXPENSE' then 0 else coalesce(l.damaged_qty, 0) end;
    v_good := l.received_qty - v_dmg;
    if l.po_line_id is not null then
      select greatest(qty * (1 + case when v_cls.valuation_method = 'EXPENSE' then 0 else v_tol end / 100) - received_qty, 0)
        into v_bal from po_lines where id = l.po_line_id for update;
      v_acc := least(v_good, v_bal);
    else
      v_acc := v_good;
    end if;
    v_exc := v_good - v_acc;
    if v_cls.valuation_method = 'EXPENSE' and v_exc > 0.0005 then
      raise exception 'Work done for % exceeds the PO balance — amend the PO first', l.item_code;
    end if;
    update grn_lines set accepted_qty = v_acc, excess_qty = v_exc where id = l.id;
    if l.po_line_id is not null and v_acc > 0 then
      update po_lines set received_qty = received_qty + v_acc where id = l.po_line_id;
    end if;
    continue when l.received_qty <= 0;

    v_proj := coalesce(l.po_project, l.project_id, case when g.receipt_type = 'CUSTOMER_SUPPLIED' then g.project_id end);
    v_lc := 0;
    if v_goods_aed > 0 then v_lc := v_lc + v_chg_val * (l.rate * g.exchange_rate) / v_goods_aed; end if;
    if v_goods_qty > 0 then v_lc := v_lc + v_chg_qty / v_goods_qty; end if;
    v_cost := round(l.rate * g.exchange_rate + v_lc, 4);
    update grn_lines set landed_cost_per_unit = round(v_lc,4), unit_cost_aed = v_cost, project_id = v_proj where id = l.id;

    v_loc := coalesce(l.location_id, g.location_id, (select id from locations where code = 'MS'));

    if v_cls.valuation_method = 'EXPENSE' then
      -- service / work-done certificate: no stock, cost straight to the project (and BOQ line)
      if v_acc > 0 then
        insert into project_costs (project_id, boq_line_id, cost_date, source, source_id, doc_no, item_id, description, qty, amount)
        values (coalesce(v_proj, g.project_id), l.boq_line_id, g.grn_date, 'SERVICE_GRN', l.id, g.grn_no, l.item_id,
                l.item_name || coalesce(' — ' || l.remarks, ''), v_acc, round(v_acc * v_cost, 2));
      end if;
    elsif v_cls.tracking = 'SERIAL' then
      if v_acc <> trunc(v_acc) then raise exception 'Serialised item % must be received in whole numbers', l.item_code; end if;
      for i in 1 .. v_acc::int loop
        insert into assets (asset_tag, item_id, serial_no, grn_line_id, purchase_date, purchase_cost, vendor_id, location_id, status, project_id)
        values (next_asset_tag(v_cls.code), l.item_id,
                case when coalesce(array_length(l.serial_nos,1),0) >= i then l.serial_nos[i] end,
                l.id, g.grn_date, v_cost, g.vendor_id, v_loc, 'IN_STORE', coalesce(v_proj, g.project_id));
      end loop;
      if v_acc > 0 then
        insert into stock_ledger (txn_date, txn_type, item_id, location_id, qty, unit_cost, value, doc_type, doc_id, doc_no, doc_line_id, project_id, remarks)
        values (g.grn_date, 'GRN', l.item_id, v_loc, v_acc, v_cost, round(v_acc * v_cost, 2), 'GRN', g.id, g.grn_no, l.id, coalesce(v_proj, g.project_id), 'Capitalised to asset register');
      end if;
    else
      if item_valuation(l.item_id) = 'WAVG' then perform wavg_receive(l.item_id, l.received_qty, v_cost); end if;
      if v_acc > 0 then
        insert into stock_lots (item_id, location_id, lot_no, batch_no, source_type, source_id, received_date, mfg_date, expiry_date,
                                unit_cost, qty_in, qty_on_hand, vendor_id, project_id)
        values (l.item_id, v_loc, coalesce(nullif(l.lot_no,''), g.grn_no || '-' || l.line_no), l.batch_no, 'GRN', l.id,
                coalesce(l.original_receipt_date, g.grn_date), l.mfg_date, l.expiry_date, v_cost, v_acc, v_acc, g.vendor_id, v_proj)
        returning id into v_lot;
        insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value, doc_type, doc_id, doc_no, doc_line_id, project_id, remarks)
        values (g.grn_date, 'GRN', l.item_id, v_loc, v_lot, v_acc, v_cost, round(v_acc * v_cost, 2), 'GRN', g.id, g.grn_no, l.id, v_proj,
                case when v_proj is not null then 'Reserved for project' end);
      end if;
      if v_dmg > 0 then
        insert into stock_lots (item_id, location_id, lot_no, batch_no, source_type, source_id, received_date, unit_cost, qty_in, qty_on_hand,
                                vendor_id, project_id, status, hold_reason)
        values (l.item_id, v_qa, g.grn_no || '-' || l.line_no || '-DMG', l.batch_no, 'GRN', l.id, g.grn_date, v_cost, v_dmg, v_dmg,
                g.vendor_id, v_proj, 'HOLD', 'DAMAGED')
        returning id into v_lot;
        insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value, doc_type, doc_id, doc_no, doc_line_id, project_id, remarks)
        values (g.grn_date, 'GRN', l.item_id, v_qa, v_lot, v_dmg, v_cost, round(v_dmg * v_cost, 2), 'GRN', g.id, g.grn_no, l.id, v_proj, 'Damaged on receipt — on hold');
      end if;
      if v_exc > 0 then
        insert into stock_lots (item_id, location_id, lot_no, batch_no, source_type, source_id, received_date, unit_cost, qty_in, qty_on_hand,
                                vendor_id, project_id, status, hold_reason)
        values (l.item_id, v_qa, g.grn_no || '-' || l.line_no || '-EXC', l.batch_no, 'GRN', l.id, g.grn_date, v_cost, v_exc, v_exc,
                g.vendor_id, v_proj, 'HOLD', 'EXCESS')
        returning id into v_lot;
        insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value, doc_type, doc_id, doc_no, doc_line_id, project_id, remarks)
        values (g.grn_date, 'GRN', l.item_id, v_qa, v_lot, v_exc, v_cost, round(v_exc * v_cost, 2), 'GRN', g.id, g.grn_no, l.id, v_proj, 'Excess over PO — awaiting Purchase decision');
      end if;
    end if;

    if l.rate > 0 then update items set last_purchase_rate = v_cost where id = l.item_id; end if;
    if g.receipt_type = 'PO' then
      insert into item_vendors (item_id, vendor_id, price, currency) values (l.item_id, g.vendor_id, l.rate, g.currency)
      on conflict (item_id, vendor_id) do update set price = excluded.price, currency = excluded.currency;
    end if;

    if v_dmg > 0 and g.vendor_id is not null then
      if v_prt is null then
        insert into purchase_returns (vendor_id, grn_id, return_type, status, reason)
        values (g.vendor_id, g.id, 'REJECTED_AT_GRN', 'DRAFT', 'Damaged on receipt — ' || g.grn_no)
        returning id into v_prt;
      end if;
      insert into prt_lines (prt_id, grn_line_id, item_id, qty, rate_aed, vat_rate) values (v_prt, l.id, l.item_id, v_dmg, v_cost, l.vat_rate);
      v_prt_n := v_prt_n + 1;
    end if;
    v_exc_total := v_exc_total + v_exc;
  end loop;

  if g.receipt_type = 'PO' then
    update purchase_orders set status = case
        when not exists (select 1 from po_lines where po_id = g.po_id and received_qty < qty) then 'RECEIVED'
        else 'PARTIALLY_RECEIVED' end
     where id = g.po_id;
  end if;
  update grns set status = 'POSTED', posted_at = now(), posted_by = auth.uid() where id = p_grn;
  insert into audit_log (entity, entity_id, action, details) values ('grn', p_grn, 'POSTED', jsonb_build_object('grn_no', g.grn_no));

  if v_prt is not null then
    perform notify('purchase', null, 'Damaged goods on ' || g.grn_no, v_prt_n || ' line(s) held in Quarantine — review the draft purchase return', 'd/prt/' || v_prt, 'prt', v_prt);
  end if;
  if v_exc_total > 0 then
    perform notify('purchase', null, 'Excess received on ' || g.grn_no, 'Accept it (PO amended) or return it to the supplier', 'holds', 'grn', g.id);
  end if;
end $$;

-- ---------- own installation team: daily site log ----------
create table install_logs (
  id          uuid primary key default gen_random_uuid(),
  log_no      text not null unique default next_doc_no('INS'),
  log_date    date not null default current_date,
  project_id  uuid not null references projects(id),
  team_leader text,
  status      text not null default 'DRAFT' check (status in ('DRAFT','POSTED')),
  notes       text,
  total_cost  numeric(16,2) not null default 0,
  created_by  uuid default auth.uid() references profiles(id),
  created_at  timestamptz not null default now(),
  posted_by   uuid references profiles(id),
  posted_at   timestamptz
);
create table install_log_crew (
  id       uuid primary key default gen_random_uuid(),
  log_id   uuid not null references install_logs(id) on delete cascade,
  grade_id uuid not null references labour_grades(id),
  workers  int not null default 1 check (workers > 0),
  hours    numeric(10,2) not null default 0 check (hours >= 0),
  ot_hours numeric(10,2) not null default 0 check (ot_hours >= 0),
  rate     numeric(10,2),
  ot_rate  numeric(10,2)
);
create table install_log_lines (
  id          uuid primary key default gen_random_uuid(),
  log_id      uuid not null references install_logs(id) on delete cascade,
  line_no     int not null default 1,
  boq_line_id uuid not null references boq_lines(id),
  unit_id     uuid references project_units(id),
  qty         numeric(14,3) not null check (qty > 0),
  remarks     text
);
create index install_log_lines_boq_idx on install_log_lines(boq_line_id);

create or replace function public.post_install_log(p_log uuid) returns void
language plpgsql security definer set search_path = public as $$
declare h install_logs%rowtype; l record; v_cost numeric := 0; v_w numeric; v_wsum numeric; v_n int; v_done numeric; v_alloc numeric; v_left numeric; v_i int := 0; v_amt numeric;
begin
  if not has_role('shop_floor','production_incharge','factory_manager') then raise exception 'Only site supervisors can post installation logs'; end if;
  select * into h from install_logs where id = p_log for update;
  if h.status <> 'DRAFT' then raise exception 'Log is %', h.status; end if;
  if h.log_date > current_date then raise exception 'Log date cannot be in the future'; end if;
  if not exists (select 1 from install_log_crew where log_id = p_log) and not exists (select 1 from install_log_lines where log_id = p_log) then
    raise exception 'Enter the crew and / or the quantities installed';
  end if;
  -- quantities: must belong to the project and stay within the BOQ / unit allocation
  for l in select il.*, b.project_id b_proj, b.qty b_qty, b.description from install_log_lines il join boq_lines b on b.id = il.boq_line_id where il.log_id = p_log loop
    if l.b_proj <> h.project_id then raise exception 'BOQ line "%" belongs to another project', l.description; end if;
    if l.unit_id is not null then
      select qty into v_alloc from boq_line_units where boq_line_id = l.boq_line_id and unit_id = l.unit_id;
      if v_alloc is null then raise exception '"%" is not attached to unit %', l.description, (select unit_code from project_units where id = l.unit_id); end if;
      select coalesce(sum(x.qty), 0) into v_done from install_log_lines x join install_logs y on y.id = x.log_id
       where y.status = 'POSTED' and x.boq_line_id = l.boq_line_id and x.unit_id = l.unit_id;
      if v_done + l.qty > v_alloc + 0.0005 then raise exception '"%" in unit %: % installed + % exceeds % allocated', l.description,
        (select unit_code from project_units where id = l.unit_id), v_done, l.qty, v_alloc; end if;
    else
      select coalesce(sum(x.qty), 0) into v_done from install_log_lines x join install_logs y on y.id = x.log_id
       where y.status = 'POSTED' and x.boq_line_id = l.boq_line_id;
      if v_done + l.qty > l.b_qty + 0.0005 then raise exception '"%": % installed + % exceeds BOQ qty %', l.description, v_done, l.qty, l.b_qty; end if;
    end if;
  end loop;
  -- crew cost at grade rates (normal + overtime)
  update install_log_crew c set rate = g.rate_per_hour, ot_rate = g.ot_rate_per_hour from labour_grades g where g.id = c.grade_id and c.log_id = p_log;
  select coalesce(sum(workers * (hours * rate + ot_hours * ot_rate)), 0) into v_cost from install_log_crew where log_id = p_log;
  v_cost := round(v_cost, 2);
  -- allocate the crew cost over the installed lines by contract value (equal split when unpriced)
  select count(*), coalesce(sum(il.qty * greatest(b.sell_rate, 0)), 0) into v_n, v_wsum
    from install_log_lines il join boq_lines b on b.id = il.boq_line_id where il.log_id = p_log;
  if v_cost > 0 then
    if v_n = 0 then
      insert into project_costs (project_id, cost_date, source, source_id, doc_no, description, amount)
      values (h.project_id, h.log_date, 'INSTALL_LABOUR', p_log, h.log_no, 'Installation team' || coalesce(' — ' || h.team_leader, ''), v_cost);
    else
      v_left := v_cost;
      for l in select il.*, b.sell_rate from install_log_lines il join boq_lines b on b.id = il.boq_line_id where il.log_id = p_log order by il.line_no loop
        v_i := v_i + 1;
        v_w := case when v_wsum > 0 then l.qty * greatest(l.sell_rate, 0) / v_wsum else 1.0 / v_n end;
        v_amt := case when v_i = v_n then v_left else round(v_cost * v_w, 2) end;
        v_left := v_left - v_amt;
        insert into project_costs (project_id, boq_line_id, unit_id, cost_date, source, source_id, doc_no, description, qty, amount)
        values (h.project_id, l.boq_line_id, l.unit_id, h.log_date, 'INSTALL_LABOUR', p_log, h.log_no, 'Own installation team' || coalesce(' — ' || h.team_leader, ''), l.qty, v_amt);
      end loop;
    end if;
  end if;
  update install_logs set status = 'POSTED', total_cost = v_cost, posted_by = auth.uid(), posted_at = now() where id = p_log;
  -- unit status: started / fully installed
  update project_units u set status = case
      when not exists (select 1 from boq_line_units a where a.unit_id = u.id
                        and a.qty > coalesce((select sum(x.qty) from install_log_lines x join install_logs y on y.id = x.log_id
                                              where y.status = 'POSTED' and x.boq_line_id = a.boq_line_id and x.unit_id = u.id), 0) + 0.0005)
      then 'INSTALLED' else 'IN_PROGRESS' end
   where u.id in (select unit_id from install_log_lines where log_id = p_log and unit_id is not null)
     and u.status in ('NOT_STARTED','IN_PROGRESS');
end $$;

-- unit snagging / handover
create or replace function public.unit_set_status(p_unit uuid, p_status text, p_handed_to text default null, p_remarks text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not has_role('production_incharge','factory_manager') then raise exception 'Only the Production In-charge / Factory Manager can change unit status'; end if;
  if p_status not in ('IN_PROGRESS','INSTALLED','SNAGGING','HANDED_OVER') then raise exception 'Unknown status %', p_status; end if;
  if p_status = 'HANDED_OVER' and coalesce(trim(p_handed_to), '') = '' then raise exception 'Enter who took the handover'; end if;
  update project_units set status = p_status,
         handed_over_at = case when p_status = 'HANDED_OVER' then current_date end,
         handed_over_to = case when p_status = 'HANDED_OVER' then p_handed_to end,
         remarks = coalesce(p_remarks, remarks)
   where id = p_unit;
end $$;

-- ---------- BOQ -> production order ----------
create or replace function public.boq_create_wo(p_line uuid, p_qty numeric, p_due date default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare b boq_lines%rowtype; v_tpl uuid; v_wo uuid;
begin
  if not has_role('production_incharge','factory_manager') then raise exception 'Only production planning can create production orders'; end if;
  select * into b from boq_lines where id = p_line;
  if b.category <> 'MANUFACTURED' then raise exception 'Only made in-house BOQ lines become production orders'; end if;
  if b.item_id is null then raise exception 'Set the product (FG item) on BOQ line %', coalesce(b.boq_ref, b.line_no::text); end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'Enter a quantity'; end if;
  v_tpl := coalesce(b.template_id, (select id from bom_templates where item_id = b.item_id and is_active order by version desc limit 1));
  insert into production_orders (project_id, item_id, qty, description, due_date, template_id, boq_line_id)
  values (b.project_id, b.item_id, p_qty, coalesce(b.boq_ref || ' — ', '') || b.description, p_due, v_tpl, b.id)
  returning id into v_wo;
  if v_tpl is not null then perform wo_apply_template(v_wo, v_tpl); end if;
  return v_wo;
end $$;

-- ---------- progress & cost views ----------
create or replace view v_boq_progress with (security_invoker = true) as
with wo as (
  select w.boq_line_id, sum(w.qty) filter (where not w.is_rework) wo_qty, sum(w.qty_completed) produced,
         sum(c.act_total - c.rework_out_value) cost
    from production_orders w join v_wo_cost c on c.wo_id = w.id
   where w.boq_line_id is not null and w.status <> 'CANCELLED' group by w.boq_line_id
), po as (
  select pl.boq_line_id, sum(pl.qty) ordered from po_lines pl join purchase_orders p on p.id = pl.po_id
   where pl.boq_line_id is not null and p.status not in ('CANCELLED','REJECTED') group by pl.boq_line_id
), gr as (
  select gl.boq_line_id, sum(gl.accepted_qty) received, sum(gl.accepted_qty * gl.unit_cost_aed) value
    from grn_lines gl join grns g on g.id = gl.grn_id where g.status = 'POSTED' and gl.boq_line_id is not null group by gl.boq_line_id
), dl as (
  select d.boq_line_id, sum(d.qty) delivered from dispatch_lines d join dispatch_notes n on n.id = d.dispatch_id
   where n.status in ('POSTED','DELIVERED') and d.boq_line_id is not null group by d.boq_line_id
), ins as (
  select x.boq_line_id, sum(x.qty) installed from install_log_lines x join install_logs y on y.id = x.log_id where y.status = 'POSTED' group by x.boq_line_id
), pc as (
  select boq_line_id, sum(amount) filter (where source = 'SERVICE_GRN') service_cost, sum(amount) filter (where source = 'INSTALL_LABOUR') install_cost,
         sum(amount) filter (where source = 'OTHER') other_cost
    from project_costs where boq_line_id is not null group by boq_line_id
)
select b.id boq_line_id, b.project_id, p.code project_code, p.name project_name, p.billing_basis, b.line_no, b.boq_ref, b.description, b.category, b.item_id, b.uom,
       b.qty, b.sell_rate, round(b.qty * b.sell_rate, 2) contract_value, round(b.qty * b.est_unit_cost, 2) est_cost,
       coalesce(wo.wo_qty, 0) wo_qty, coalesce(wo.produced, 0) produced_qty, coalesce(po.ordered, 0) ordered_qty, coalesce(gr.received, 0) received_qty,
       coalesce(dl.delivered, 0) delivered_qty, coalesce(ins.installed, 0) installed_qty,
       case when b.qty > 0 then round(least(coalesce(ins.installed, 0) / b.qty, 1) * 100, 1) end installed_pct,
       round(coalesce(dl.delivered, 0) * b.sell_rate, 2) delivered_value,
       round(coalesce(ins.installed, 0) * b.sell_rate, 2) earned_value,
       round(coalesce(wo.cost, 0), 2) production_cost, round(case when b.category = 'BOUGHT_OUT' then coalesce(gr.value, 0) else 0 end, 2) purchase_cost,
       round(coalesce(pc.service_cost, 0), 2) service_cost, round(coalesce(pc.install_cost, 0), 2) install_cost, round(coalesce(pc.other_cost, 0), 2) other_cost,
       round(coalesce(wo.cost, 0) + case when b.category = 'BOUGHT_OUT' then coalesce(gr.value, 0) else 0 end
             + coalesce(pc.service_cost, 0) + coalesce(pc.install_cost, 0) + coalesce(pc.other_cost, 0), 2) actual_cost
  from boq_lines b join projects p on p.id = b.project_id
  left join wo on wo.boq_line_id = b.id left join po on po.boq_line_id = b.id left join gr on gr.boq_line_id = b.id
  left join dl on dl.boq_line_id = b.id left join ins on ins.boq_line_id = b.id left join pc on pc.boq_line_id = b.id;

create or replace view v_unit_progress with (security_invoker = true) as
with a as (
  select u.id unit_id, sum(a.qty * b.sell_rate) alloc_value,
         sum(least(a.qty, coalesce((select sum(x.qty) from install_log_lines x join install_logs y on y.id = x.log_id
                                     where y.status = 'POSTED' and x.boq_line_id = a.boq_line_id and x.unit_id = u.id), 0)) * b.sell_rate) inst_value,
         count(*) lines,
         count(*) filter (where a.qty <= coalesce((select sum(x.qty) from install_log_lines x join install_logs y on y.id = x.log_id
                                     where y.status = 'POSTED' and x.boq_line_id = a.boq_line_id and x.unit_id = u.id), 0) + 0.0005) lines_done
    from project_units u join boq_line_units a on a.unit_id = u.id join boq_lines b on b.id = a.boq_line_id group by u.id
)
select u.id unit_id, u.project_id, p.code project_code, p.name project_name, p.billing_basis, u.unit_code, u.unit_type, u.building, u.floor, u.status,
       u.handed_over_at, u.handed_over_to, u.sale_value, coalesce(a.lines, 0) boq_lines, coalesce(a.lines_done, 0) lines_done,
       round(coalesce(a.alloc_value, 0), 2) boq_value,
       case when u.status = 'HANDED_OVER' then 100 when coalesce(a.alloc_value, 0) > 0 then round(a.inst_value / a.alloc_value * 100, 1)
            when a.lines > 0 then round(a.lines_done::numeric / a.lines * 100, 1) else 0 end progress_pct,
       round(case when u.status = 'HANDED_OVER' then coalesce(u.sale_value, a.alloc_value, 0)
                  when coalesce(a.alloc_value, 0) > 0 then coalesce(u.sale_value, a.alloc_value) * a.inst_value / a.alloc_value
                  else 0 end, 2) earned_value
  from project_units u join projects p on p.id = u.project_id left join a on a.unit_id = u.id;

-- project cost: add services / installation labour, other project costs and stock bought for the project
drop view if exists v_project_margin;
create or replace view v_project_production with (security_invoker = true) as
select p.id project_id, p.code, p.name, p.project_type,
       (select count(*) from production_orders w where w.project_id = p.id and w.status <> 'CANCELLED') orders,
       (select count(*) from production_orders w where w.project_id = p.id and w.status in ('RELEASED','IN_PROGRESS')) wip_orders,
       coalesce((select sum(c.act_total - c.fg_value - c.rework_out_value - c.scrap_value) from v_wo_cost c
                  where c.project_id = p.id and c.status in ('DRAFT','RELEASED','IN_PROGRESS')), 0) wip_value,
       coalesce((select sum(l.qty_on_hand * l.unit_cost) from stock_lots l where l.source_type = 'PRODUCTION' and l.project_id = p.id), 0) fg_in_store,
       coalesce((select -sum(s.value) from stock_ledger s where s.txn_type = 'DISPATCH' and s.project_id = p.id), 0) dispatched_value,
       p.contract_value,
       coalesce((select sum(w.cost_scrap) from production_orders w where w.project_id = p.id), 0) scrap_written_off,
       coalesce((select -sum(s.value) from stock_ledger s where s.project_id = p.id and s.production_order_id is null
                  and s.txn_type in ('ISSUE','RETURN')), 0) site_material,
       coalesce((select sum(w.sale_value) from production_orders w where w.project_id = p.id and w.status <> 'CANCELLED'), 0) orders_sale_value,
       coalesce((select sum(r.rework_value + r.scrap_value) from wo_receipts r join production_orders w on w.id = r.wo_id
                  where w.project_id = p.id and r.qc_status = 'PENDING_FM'), 0) qc_pending_value,
       coalesce((select sum(l.qty_on_hand * l.unit_cost) from stock_lots l where l.source_type <> 'PRODUCTION' and l.project_id = p.id and l.qty_on_hand > 0), 0) reserved_stock,
       coalesce((select sum(amount) from project_costs c where c.project_id = p.id and c.source = 'SERVICE_GRN'), 0) services_cost,
       coalesce((select sum(amount) from project_costs c where c.project_id = p.id and c.source = 'INSTALL_LABOUR'), 0) install_labour,
       coalesce((select sum(amount) from project_costs c where c.project_id = p.id and c.source = 'OTHER'), 0) other_costs,
       coalesce((select sum(qty * sell_rate) from boq_lines b where b.project_id = p.id), 0) boq_value,
       coalesce((select sum(qty * est_unit_cost) from boq_lines b where b.project_id = p.id), 0) boq_est_cost
  from projects p;
create view v_project_margin with (security_invoker = true) as
select v.*,
       round(v.wip_value + v.fg_in_store + v.dispatched_value + v.scrap_written_off + v.site_material + v.qc_pending_value
             + v.reserved_stock + v.services_cost + v.install_labour + v.other_costs, 2) total_cost,
       case when coalesce(v.contract_value, nullif(v.boq_value, 0)) is not null then round(coalesce(v.contract_value, v.boq_value) - (v.wip_value + v.fg_in_store + v.dispatched_value
             + v.scrap_written_off + v.site_material + v.qc_pending_value + v.reserved_stock + v.services_cost + v.install_labour + v.other_costs), 2) end margin,
       case when coalesce(v.contract_value, v.boq_value, 0) > 0 then round((coalesce(v.contract_value, v.boq_value) - (v.wip_value + v.fg_in_store + v.dispatched_value
             + v.scrap_written_off + v.site_material + v.qc_pending_value + v.reserved_stock + v.services_cost + v.install_labour + v.other_costs))
             / coalesce(v.contract_value, v.boq_value) * 100, 1) end margin_pct
  from v_project_production v;

-- ---------- RLS ----------
alter table project_units enable row level security;
alter table boq_lines enable row level security;
alter table boq_line_units enable row level security;
alter table project_costs enable row level security;
alter table install_logs enable row level security;
alter table install_log_crew enable row level security;
alter table install_log_lines enable row level security;
do $$
declare t text;
begin
  foreach t in array array['project_units','boq_lines','boq_line_units','project_costs','install_logs','install_log_crew','install_log_lines'] loop
    execute format('create policy read_active on public.%I for select to authenticated using (public.is_active_user())', t);
  end loop;
end $$;
create policy write_roles on project_units for all to authenticated
  using (public.has_role('factory_manager','production_incharge','finance')) with check (public.has_role('factory_manager','production_incharge','finance'));
create policy write_roles on boq_lines for all to authenticated
  using (public.has_role('factory_manager','production_incharge','finance')) with check (public.has_role('factory_manager','production_incharge','finance'));
create policy other_cost on project_costs for insert to authenticated with check (public.has_role('finance','factory_manager') and source = 'OTHER');
create policy other_cost_del on project_costs for delete to authenticated using (public.has_role('finance','factory_manager') and source = 'OTHER');
create policy doc_insert on install_logs for insert to authenticated with check (public.has_role('shop_floor','production_incharge','factory_manager') and status = 'DRAFT');
create policy doc_update on install_logs for update to authenticated
  using (public.has_role('shop_floor','production_incharge','factory_manager') and status = 'DRAFT') with check (status = 'DRAFT');
create policy doc_delete on install_logs for delete to authenticated using (public.has_role('shop_floor','production_incharge','factory_manager') and status = 'DRAFT');
create policy line_write on install_log_crew for all to authenticated
  using (public.has_role('shop_floor','production_incharge','factory_manager') and exists (select 1 from install_logs h where h.id = install_log_crew.log_id and h.status = 'DRAFT'))
  with check (public.has_role('shop_floor','production_incharge','factory_manager') and exists (select 1 from install_logs h where h.id = install_log_crew.log_id and h.status = 'DRAFT'));
create policy line_write on install_log_lines for all to authenticated
  using (public.has_role('shop_floor','production_incharge','factory_manager') and exists (select 1 from install_logs h where h.id = install_log_lines.log_id and h.status = 'DRAFT'))
  with check (public.has_role('shop_floor','production_incharge','factory_manager') and exists (select 1 from install_logs h where h.id = install_log_lines.log_id and h.status = 'DRAFT'));

grant execute on function public.boq_sync_units(uuid), public.post_install_log(uuid), public.unit_set_status(uuid, text, text, text),
  public.boq_create_wo(uuid, numeric, date) to authenticated;
revoke execute on function public.boq_sync_units(uuid), public.post_install_log(uuid), public.unit_set_status(uuid, text, text, text),
  public.boq_create_wo(uuid, numeric, date) from anon;
