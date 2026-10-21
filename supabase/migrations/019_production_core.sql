-- =====================================================================
-- Citi Homes IMS - 019 Production: work centres, products (FG), BOM templates,
-- production (work) orders with cut list, materials, routing; release to material request
-- =====================================================================

-- ---------- settings ----------
alter table company_settings
  add column labour_rate_per_hour numeric(10,2) not null default 15,
  add column overhead_pct         numeric(6,2)  not null default 30,   -- on labour + machine cost
  add column board_waste_pct      numeric(6,2)  not null default 15,   -- cut-list board yield allowance
  add column edge_waste_pct       numeric(6,2)  not null default 10;

-- ---------- finished goods class, FG store ----------
insert into item_classes (code, name, valuation_method, tracking, sort_order)
values ('FG', 'Finished Goods', 'FIFO', 'LOT', 12) on conflict (code) do nothing;
insert into item_categories (class_id, code, name)
select c.id, v.code, v.name from item_classes c
join (values ('FG-KIT','Kitchens'),('FG-WAR','Wardrobes'),('FG-VAN','Vanities'),('FG-DOR','Doors & frames'),
             ('FG-TV','TV units & cladding'),('FG-FUR','Loose furniture'),('FG-GEN','Other products')) v(code, name) on true
where c.code = 'FG' on conflict (code) do nothing;

alter table locations drop constraint locations_loc_type_check;
alter table locations add constraint locations_loc_type_check check (loc_type in
  ('WAREHOUSE','ZONE','RACK','BIN','SHOP_FLOOR','QUARANTINE','SCRAP_YARD','LABOUR_CAMP','OFFICE','SITE','FG_STORE'));
insert into locations (code, name, loc_type, is_stock) values ('FGS', 'Finished Goods Store', 'FG_STORE', true) on conflict (code) do nothing;

alter table stock_lots drop constraint stock_lots_source_type_check;
alter table stock_lots add constraint stock_lots_source_type_check check (source_type in ('GRN','RETURN','TRANSFER','ADJUSTMENT','SCRAP_GEN','PRODUCTION'));

alter table stock_ledger drop constraint stock_ledger_txn_type_check;
alter table stock_ledger add constraint stock_ledger_txn_type_check check (txn_type in
  ('GRN','ISSUE','RETURN','TRANSFER_OUT','TRANSFER_IN','ADJ_IN','ADJ_OUT','SCRAP_WRITE_OFF','SCRAP_IN','SCRAP_DISPOSAL',
   'PURCHASE_RETURN','REVALUATION','RELEASE_OUT','RELEASE_IN','PROD_RECEIPT','DISPATCH'));

-- ---------- work centres (extendable master) ----------
create table work_centers (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null unique,
  name                 text not null,
  kind                 text not null default 'MACHINE' check (kind in ('MACHINE','MANUAL')),
  machine_rate_per_hour numeric(10,2) not null default 0,
  labour_rate_per_hour  numeric(10,2),                       -- blank = company default
  hours_per_day        numeric(5,2) not null default 9,
  sort_order           int not null default 50,
  is_active            boolean not null default true
);
insert into work_centers (code, name, kind, machine_rate_per_hour, sort_order) values
 ('TSZ','Timber sizing','MACHINE',20,10), ('PLT','Planing & thicknessing','MACHINE',25,20),
 ('CUT','Panel / beam saw cutting','MACHINE',40,30), ('EDG','Edge banding','MACHINE',45,40),
 ('CNCD','CNC drilling / boring','MACHINE',60,50), ('CNCR','CNC router','MACHINE',70,60),
 ('CNCL','CNC door lock & hinge','MACHINE',50,70), ('LATH','CNC lathe','MACHINE',55,80),
 ('ASM','Assembly','MANUAL',0,90), ('SPR','Spray / finishing','MACHINE',35,100),
 ('QC','Quality check','MANUAL',0,110), ('PCK','Packing','MANUAL',0,120);

-- ---------- BOM templates for standard products ----------
create table bom_templates (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references items(id),          -- FG product
  name        text not null,
  version     int not null default 1,
  is_active   boolean not null default true,
  remarks     text,
  created_by  uuid default auth.uid() references profiles(id),
  created_at  timestamptz not null default now()
);
create table bom_template_parts (          -- cut list per ONE unit
  id            uuid primary key default gen_random_uuid(),
  template_id   uuid not null references bom_templates(id) on delete cascade,
  line_no       int not null default 1,
  part_name     text not null,
  material_id   uuid not null references items(id),      -- board / timber
  length_mm     numeric(10,1) not null,
  width_mm      numeric(10,1) not null,
  pieces        numeric(10,2) not null default 1,
  edge_item_id  uuid references items(id),
  edge_l1 boolean not null default false, edge_l2 boolean not null default false,
  edge_w1 boolean not null default false, edge_w2 boolean not null default false,
  grain         boolean not null default false,
  notes         text
);
create table bom_template_materials (      -- hardware / finish / consumables per ONE unit
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references bom_templates(id) on delete cascade,
  line_no     int not null default 1,
  item_id     uuid not null references items(id),
  qty         numeric(14,4) not null check (qty > 0),
  notes       text
);
create table bom_template_routing (
  id             uuid primary key default gen_random_uuid(),
  template_id    uuid not null references bom_templates(id) on delete cascade,
  seq            int not null,
  work_center_id uuid not null references work_centers(id),
  std_labour_hours  numeric(10,2) not null default 0,     -- per ONE unit
  std_machine_hours numeric(10,2) not null default 0,
  instructions   text
);

-- ---------- production (work) orders ----------
create table production_orders (
  id              uuid primary key default gen_random_uuid(),
  wo_no           text not null unique default next_doc_no('WO'),
  wo_date         date not null default current_date,
  project_id      uuid not null references projects(id),   -- customer project or MTS order
  item_id         uuid not null references items(id),      -- FG product
  description     text,                                    -- e.g. "Kitchen – Unit 1204, Type B"
  qty             numeric(14,3) not null check (qty > 0),
  due_date        date,
  priority        text not null default 'NORMAL' check (priority in ('NORMAL','URGENT')),
  template_id     uuid references bom_templates(id),
  board_waste_pct numeric(6,2),
  edge_waste_pct  numeric(6,2),
  status          text not null default 'DRAFT' check (status in ('DRAFT','RELEASED','IN_PROGRESS','COMPLETED','CANCELLED')),
  qty_completed   numeric(14,3) not null default 0,
  qty_rejected    numeric(14,3) not null default 0,
  mr_id           uuid references material_requests(id),
  remarks         text,
  released_at     timestamptz, released_by uuid references profiles(id),
  completed_at    timestamptz, completed_by uuid references profiles(id),
  -- costing snapshot at completion
  cost_material   numeric(16,2), cost_labour numeric(16,2), cost_machine numeric(16,2), cost_overhead numeric(16,2), cost_total numeric(16,2),
  fg_lot_id       uuid references stock_lots(id),
  created_by      uuid default auth.uid() references profiles(id),
  created_at      timestamptz not null default now()
);
create index production_orders_project_idx on production_orders(project_id);

create table wo_parts (                    -- cut list for the whole order
  id            uuid primary key default gen_random_uuid(),
  wo_id         uuid not null references production_orders(id) on delete cascade,
  line_no       int not null default 1,
  part_name     text not null,
  material_id   uuid not null references items(id),
  length_mm     numeric(10,1) not null,
  width_mm      numeric(10,1) not null,
  pieces        numeric(10,2) not null default 1,
  edge_item_id  uuid references items(id),
  edge_l1 boolean not null default false, edge_l2 boolean not null default false,
  edge_w1 boolean not null default false, edge_w2 boolean not null default false,
  grain         boolean not null default false,
  notes         text
);
create index wo_parts_wo_idx on wo_parts(wo_id);

create table wo_materials (                -- material requirement (calculated from parts + manual / template lines)
  id           uuid primary key default gen_random_uuid(),
  wo_id        uuid not null references production_orders(id) on delete cascade,
  line_no      int not null default 1,
  item_id      uuid not null references items(id),
  source       text not null default 'MANUAL' check (source in ('CUTLIST','MANUAL','TEMPLATE')),
  net_qty      numeric(14,4) not null default 0,     -- before waste (cut list) / as entered
  required_qty numeric(14,4) not null check (required_qty >= 0),
  notes        text
);
create index wo_materials_wo_idx on wo_materials(wo_id);

create table wo_operations (
  id                uuid primary key default gen_random_uuid(),
  wo_id             uuid not null references production_orders(id) on delete cascade,
  seq               int not null,
  work_center_id    uuid not null references work_centers(id),
  planned_labour_hours  numeric(10,2) not null default 0,
  planned_machine_hours numeric(10,2) not null default 0,
  instructions      text,
  status            text not null default 'PENDING' check (status in ('PENDING','IN_PROGRESS','DONE','SKIPPED')),
  qty_done          numeric(14,3) not null default 0,
  started_at        timestamptz,
  completed_at      timestamptz
);
create index wo_operations_wo_idx on wo_operations(wo_id, seq);

create table wo_time_logs (                -- supervisor logs per stage
  id             uuid primary key default gen_random_uuid(),
  operation_id   uuid not null references wo_operations(id) on delete cascade,
  wo_id          uuid not null references production_orders(id) on delete cascade,
  log_date       date not null default current_date,
  crew           int not null default 1 check (crew > 0),
  labour_hours   numeric(10,2) not null default 0 check (labour_hours >= 0),   -- total man-hours
  machine_hours  numeric(10,2) not null default 0 check (machine_hours >= 0),
  labour_rate    numeric(10,2) not null,
  machine_rate   numeric(10,2) not null,
  qty_done       numeric(14,3) not null default 0,
  notes          text,
  logged_by      uuid default auth.uid() references profiles(id),
  logged_at      timestamptz not null default now()
);
create index wo_time_logs_wo_idx on wo_time_logs(wo_id);

-- link material requests / issues and ledger to the production order
alter table material_requests add column production_order_id uuid references production_orders(id);
alter table material_issues   add column production_order_id uuid references production_orders(id);
alter table stock_ledger      add column production_order_id uuid references production_orders(id);
create index stock_ledger_wo_idx on stock_ledger(production_order_id) where production_order_id is not null;

-- ledger rows of issues / returns carry the production order automatically
create or replace function public.trg_ledger_wo() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.production_order_id is null then
    if new.doc_type = 'ISSUE' then
      select production_order_id into new.production_order_id from material_issues where id = new.doc_id;
    elsif new.doc_type = 'RETURN' then
      select i.production_order_id into new.production_order_id
        from material_returns r join material_issues i on i.id = r.issue_id where r.id = new.doc_id;
    end if;
  end if;
  return new;
end $$;
create trigger ledger_wo before insert on stock_ledger for each row execute function trg_ledger_wo();
revoke execute on function public.trg_ledger_wo() from public, anon, authenticated;

-- issues created from a production-order request inherit the order
create or replace function public.trg_issue_wo() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.production_order_id is null and new.mr_id is not null then
    select production_order_id into new.production_order_id from material_requests where id = new.mr_id;
  end if;
  return new;
end $$;
create trigger issue_wo before insert or update of mr_id on material_issues for each row execute function trg_issue_wo();
revoke execute on function public.trg_issue_wo() from public, anon, authenticated;

-- ---------- material requirement from the cut list ----------
-- boards: sum(part area x pieces) / sheet area x (1 + waste) in the board's UoM (sheets or m2)
-- edge band: sum(banded edge length x pieces) in metres x (1 + waste)
create or replace function public.wo_compute_materials(p_wo uuid) returns int
language plpgsql security definer set search_path = public as $$
declare h production_orders%rowtype; s company_settings%rowtype; v_bw numeric; v_ew numeric; n int; v_bad text;
begin
  if not has_role('production_incharge','factory_manager') then raise exception 'Only production planning can calculate materials'; end if;
  select * into h from production_orders where id = p_wo for update;
  if h.status <> 'DRAFT' then raise exception 'Materials can only be recalculated on a draft order'; end if;
  select * into s from company_settings where id = 1;
  v_bw := coalesce(h.board_waste_pct, s.board_waste_pct); v_ew := coalesce(h.edge_waste_pct, s.edge_waste_pct);

  select string_agg(distinct i.code, ', ') into v_bad
    from wo_parts p join items i on i.id = p.material_id join uoms u on u.id = i.uom_id
   where p.wo_id = p_wo and (
         (u.code in ('CBM','CFT') and coalesce(i.thickness_mm, 0) = 0)
      or (u.code not in ('SQM','CBM','CFT','LM','MTR') and (coalesce(i.length_mm, 0) = 0 or coalesce(i.width_mm, 0) = 0)));
  if v_bad is not null then raise exception 'Set the sheet length x width (or thickness for timber in CBM/CFT) in the item master for: %', v_bad; end if;

  -- boards in sheets/pcs: area / sheet area; SQM: area; timber CBM/CFT: area x thickness; LM/MTR: running length
  delete from wo_materials where wo_id = p_wo and source = 'CUTLIST';
  insert into wo_materials (wo_id, line_no, item_id, source, net_qty, required_qty, notes)
  select p_wo, 100 + row_number() over (order by code), item_id, 'CUTLIST', round(net, 4),
         case when uom in ('SHT','NOS','PCS') then ceil(net * (1 + v_bw / 100)) else round(net * (1 + v_bw / 100), 3) end,
         'From cut list: ' || round(area, 2) || ' m² of parts'
    from (select i.id item_id, i.code, u.code uom, sum(p.length_mm * p.width_mm * p.pieces) / 1e6 area,
                 case when u.code = 'SQM' then sum(p.length_mm * p.width_mm * p.pieces) / 1e6
                      when u.code = 'CBM' then sum(p.length_mm * p.width_mm * p.pieces) * max(i.thickness_mm) / 1e9
                      when u.code = 'CFT' then sum(p.length_mm * p.width_mm * p.pieces) * max(i.thickness_mm) / 1e9 / 0.0283168
                      when u.code in ('LM','MTR') then sum(p.length_mm * p.pieces) / 1000
                      else sum(p.length_mm * p.width_mm * p.pieces) / (max(i.length_mm) * max(i.width_mm)) end net
            from wo_parts p join items i on i.id = p.material_id join uoms u on u.id = i.uom_id
           where p.wo_id = p_wo group by i.id, i.code, u.code) b;
  insert into wo_materials (wo_id, line_no, item_id, source, net_qty, required_qty, notes)
  select p_wo, 200 + row_number() over (order by i.code), i.id, 'CUTLIST', round(e.m, 4), round(e.m * (1 + v_ew / 100), 2), 'Edge banding from cut list'
    from (select edge_item_id, sum(((case when edge_l1 then length_mm else 0 end) + (case when edge_l2 then length_mm else 0 end)
                                  + (case when edge_w1 then width_mm else 0 end) + (case when edge_w2 then width_mm else 0 end)) * pieces) / 1000 m
            from wo_parts where wo_id = p_wo and edge_item_id is not null group by edge_item_id) e
    join items i on i.id = e.edge_item_id where e.m > 0;
  select count(*) into n from wo_materials where wo_id = p_wo;
  return n;
end $$;

-- copy a standard product template into an order (parts x qty, materials x qty, routing x qty)
create or replace function public.wo_apply_template(p_wo uuid, p_template uuid) returns void
language plpgsql security definer set search_path = public as $$
declare h production_orders%rowtype; t bom_templates%rowtype;
begin
  if not has_role('production_incharge','factory_manager') then raise exception 'Not allowed'; end if;
  select * into h from production_orders where id = p_wo for update;
  if h.status <> 'DRAFT' then raise exception 'Order is not a draft'; end if;
  select * into t from bom_templates where id = p_template;
  if t.item_id <> h.item_id then raise exception 'Template belongs to another product'; end if;
  delete from wo_parts where wo_id = p_wo;
  delete from wo_materials where wo_id = p_wo;
  delete from wo_operations where wo_id = p_wo;
  insert into wo_parts (wo_id, line_no, part_name, material_id, length_mm, width_mm, pieces, edge_item_id, edge_l1, edge_l2, edge_w1, edge_w2, grain, notes)
  select p_wo, line_no, part_name, material_id, length_mm, width_mm, pieces * h.qty, edge_item_id, edge_l1, edge_l2, edge_w1, edge_w2, grain, notes
    from bom_template_parts where template_id = p_template;
  insert into wo_materials (wo_id, line_no, item_id, source, net_qty, required_qty, notes)
  select p_wo, line_no, item_id, 'TEMPLATE', qty * h.qty, qty * h.qty, notes from bom_template_materials where template_id = p_template;
  insert into wo_operations (wo_id, seq, work_center_id, planned_labour_hours, planned_machine_hours, instructions)
  select p_wo, seq, work_center_id, std_labour_hours * h.qty, std_machine_hours * h.qty, instructions from bom_template_routing where template_id = p_template;
  update production_orders set template_id = p_template where id = p_wo;
  if exists (select 1 from wo_parts where wo_id = p_wo) then perform wo_compute_materials(p_wo); end if;
end $$;

-- release: materials go to the Production In-charge as a material request; job card can be printed
create or replace function public.wo_release(p_wo uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare h production_orders%rowtype; p projects%rowtype; v_mr uuid;
begin
  if not has_role('production_incharge','factory_manager') then raise exception 'Only production planning can release orders'; end if;
  select * into h from production_orders where id = p_wo for update;
  if h.status <> 'DRAFT' then raise exception 'Order is %', h.status; end if;
  if not exists (select 1 from wo_operations where wo_id = p_wo) then raise exception 'Add the production route (stages) first'; end if;
  select * into p from projects where id = h.project_id;
  if p.status <> 'OPEN' then raise exception 'Project / MTS order is not open'; end if;
  if exists (select 1 from wo_materials where wo_id = p_wo and required_qty > 0) then
    insert into material_requests (purpose, project_id, required_date, priority, status, remarks, production_order_id)
    values (case when p.project_type = 'MTS' then 'MTS' else 'PROJECT' end, h.project_id, coalesce(h.due_date, current_date),
            h.priority, 'PENDING_APPROVAL', 'Materials for production order ' || h.wo_no || coalesce(' — ' || h.description, ''), p_wo)
    returning id into v_mr;
    insert into mr_lines (mr_id, line_no, item_id, requested_qty, remarks)
    select v_mr, row_number() over (order by i.code), m.item_id, round(sum(m.required_qty), 3), h.wo_no
      from wo_materials m join items i on i.id = m.item_id
     where m.wo_id = p_wo and m.required_qty > 0 group by m.item_id, i.code;
    perform notify('production_incharge', null, 'Approve materials for ' || h.wo_no, coalesce(h.description, ''), 'd/mr/' || v_mr, 'mr', v_mr);
  end if;
  update production_orders set status = 'RELEASED', released_at = now(), released_by = auth.uid(), mr_id = v_mr where id = p_wo;
  return v_mr;
end $$;

grant execute on function public.wo_compute_materials(uuid), public.wo_apply_template(uuid, uuid), public.wo_release(uuid) to authenticated;
revoke execute on function public.wo_compute_materials(uuid), public.wo_apply_template(uuid, uuid), public.wo_release(uuid) from anon;

-- ---------- RLS ----------
alter table work_centers enable row level security;
alter table bom_templates enable row level security;
alter table bom_template_parts enable row level security;
alter table bom_template_materials enable row level security;
alter table bom_template_routing enable row level security;
alter table production_orders enable row level security;
alter table wo_parts enable row level security;
alter table wo_materials enable row level security;
alter table wo_operations enable row level security;
alter table wo_time_logs enable row level security;
do $$
declare t text;
begin
  foreach t in array array['work_centers','bom_templates','bom_template_parts','bom_template_materials','bom_template_routing',
                           'production_orders','wo_parts','wo_materials','wo_operations','wo_time_logs'] loop
    execute format('create policy read_active on public.%I for select to authenticated using (public.is_active_user())', t);
  end loop;
end $$;
create policy write_roles on work_centers for all to authenticated
  using (public.has_role('factory_manager','finance')) with check (public.has_role('factory_manager','finance'));
do $$
declare t text;
begin
  foreach t in array array['bom_templates','bom_template_parts','bom_template_materials','bom_template_routing'] loop
    execute format('create policy write_roles on public.%I for all to authenticated
                      using (public.has_role(''production_incharge'',''factory_manager''))
                      with check (public.has_role(''production_incharge'',''factory_manager''))', t);
  end loop;
end $$;
create policy doc_insert on production_orders for insert to authenticated
  with check (public.has_role('production_incharge','factory_manager') and status = 'DRAFT');
create policy doc_update on production_orders for update to authenticated
  using (public.has_role('production_incharge','factory_manager') and status = 'DRAFT')
  with check (public.has_role('production_incharge','factory_manager') and status = 'DRAFT');
create policy doc_delete on production_orders for delete to authenticated
  using (public.has_role('production_incharge','factory_manager') and status = 'DRAFT');
do $$
declare t text;
begin
  foreach t in array array['wo_parts','wo_materials','wo_operations'] loop
    execute format('create policy line_write on public.%I for all to authenticated
                      using (public.has_role(''production_incharge'',''factory_manager'')
                             and exists (select 1 from public.production_orders h where h.id = %I.wo_id and h.status = ''DRAFT''))
                      with check (public.has_role(''production_incharge'',''factory_manager'')
                             and exists (select 1 from public.production_orders h where h.id = %I.wo_id and h.status = ''DRAFT''))', t, t, t);
  end loop;
end $$;
-- time logs are written only through wo_log_time (next migration)
