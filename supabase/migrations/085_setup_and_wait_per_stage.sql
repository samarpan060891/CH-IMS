-- 085 Setup hours (once per batch) and wait days (after the stage) on each production stage.
--   · setup: tool change, program, first piece — occupies the work centre once per production order (batch);
--     planned machine hours += setup (machine stages), planned man-hours += setup × operators
--   · wait: drying / curing / moving / queue after the stage — the batch cannot go on, the work centre is free
--   · each work centre carries a typical default; new BOM stages take it; existing BOM routes are filled from it
alter table work_centers
  add column if not exists default_setup_hours numeric not null default 0,
  add column if not exists default_wait_days numeric not null default 0.5;
alter table bom_template_routing
  add column if not exists setup_hours numeric not null default 0,
  add column if not exists wait_days numeric not null default 0;
alter table wo_operations
  add column if not exists setup_hours numeric not null default 0,
  add column if not exists wait_days numeric not null default 0;

-- typical furniture-plant figures (adjust in Masters → Work centres)
update work_centers set default_setup_hours = case
    when code in ('MLD-F700', 'MLD-PONE') then 1
    when code like 'EDG-%' or code like 'JNT-%' or code = 'LTH-FM15030' or code = 'UPH' then 0.5
    when code = 'SPR-ROOMS' then 0.75
    when code like 'SND-%' then 0.15
    when code = 'QC' then 0
    when kind = 'UTILITY' then 0
    else 0.25 end,
  default_wait_days = case
    when code = 'SPR-ROOMS' then 1        -- top coat cures 24 h before handling
    when code = 'QC' then 0.25
    when code = 'PCK' then 0              -- last stage
    when kind = 'UTILITY' then 0
    else 0.5 end;
update bom_template_routing r set setup_hours = w.default_setup_hours, wait_days = w.default_wait_days
  from work_centers w where w.id = r.work_center_id and r.setup_hours = 0 and r.wait_days = 0;

-- the order's route = template hours × quantity + setup once
create or replace function wo_apply_template(p_wo uuid, p_template uuid) returns void language plpgsql security definer set search_path = public as $$
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
  insert into wo_operations (wo_id, seq, work_center_id, planned_labour_hours, planned_machine_hours, setup_hours, wait_days, instructions)
  select p_wo, r.seq, r.work_center_id,
         round(r.std_labour_hours * h.qty + r.setup_hours * case when w.kind = 'MACHINE' then w.operators else 1 end, 2),
         round(r.std_machine_hours * h.qty + case when w.kind = 'MACHINE' then r.setup_hours else 0 end, 2),
         r.setup_hours, r.wait_days, r.instructions
    from bom_template_routing r join work_centers w on w.id = r.work_center_id where r.template_id = p_template;
  update production_orders set template_id = p_template where id = p_wo;
  if exists (select 1 from wo_parts where wo_id = p_wo) then perform wo_compute_materials(p_wo); end if;
end $$;

-- BOM upload: optional setup_hours / wait_days columns (blank = the work centre default)
create or replace function bom_import(p_rows jsonb, p_file text default null) returns jsonb language plpgsql security definer set search_path = public as $$
declare p record; v_item uuid; v_name text; v_old uuid; v_ver int; v_new uuid; out jsonb := '[]';
begin
  if not has_role('production_incharge', 'factory_manager') then raise exception 'The Production In-charge or Factory Manager uploads BOMs'; end if;
  for p in select distinct x->>'product' code from jsonb_array_elements(p_rows) x order by 1 loop
    select id, name into v_item, v_name from items where code = p.code;
    if v_item is null then raise exception 'Product % not found', p.code; end if;
    select id into v_old from bom_templates where item_id = v_item and is_active order by version desc nulls last, created_at desc limit 1;
    select coalesce(max(version), 0) + 1 into v_ver from bom_templates where item_id = v_item;
    insert into bom_templates (item_id, name, version, is_active, remarks)
    values (v_item, v_name || ' — BOM v' || v_ver, v_ver, true, 'Uploaded from Excel' || coalesce(': ' || nullif(p_file, ''), ''))
    returning id into v_new;

    if exists (select 1 from jsonb_array_elements(p_rows) x where x->>'product' = p.code and x->>'sheet' = 'M') then
      insert into bom_template_materials (template_id, line_no, item_id, qty, notes)
      select v_new, row_number() over (order by (x->>'ord')::int), (select id from items where code = x->>'material'), (x->>'qty')::numeric, nullif(x->>'notes', '')
        from jsonb_array_elements(p_rows) x where x->>'product' = p.code and x->>'sheet' = 'M';
    elsif v_old is not null then
      insert into bom_template_materials (template_id, line_no, item_id, qty, notes)
      select v_new, line_no, item_id, qty, notes from bom_template_materials where template_id = v_old;
    end if;

    if exists (select 1 from jsonb_array_elements(p_rows) x where x->>'product' = p.code and x->>'sheet' = 'S') then
      insert into bom_template_routing (template_id, seq, work_center_id, std_labour_hours, std_machine_hours, setup_hours, wait_days, instructions)
      select v_new, coalesce((x->>'seq')::int, 10 * row_number() over (order by (x->>'ord')::int)), w.id,
             coalesce((x->>'labour')::numeric, 0), coalesce((x->>'machine')::numeric, 0),
             coalesce((x->>'setup')::numeric, w.default_setup_hours), coalesce((x->>'wait')::numeric, w.default_wait_days), nullif(x->>'notes', '')
        from jsonb_array_elements(p_rows) x join work_centers w on w.code = x->>'wc' where x->>'product' = p.code and x->>'sheet' = 'S';
    elsif v_old is not null then
      insert into bom_template_routing (template_id, seq, work_center_id, std_labour_hours, std_machine_hours, setup_hours, wait_days, instructions)
      select v_new, seq, work_center_id, std_labour_hours, std_machine_hours, setup_hours, wait_days, instructions from bom_template_routing where template_id = v_old;
    end if;

    if v_old is not null then
      insert into bom_template_parts (template_id, line_no, part_name, material_id, length_mm, width_mm, pieces, edge_item_id, edge_l1, edge_l2, edge_w1, edge_w2, grain, notes)
      select v_new, line_no, part_name, material_id, length_mm, width_mm, pieces, edge_item_id, edge_l1, edge_l2, edge_w1, edge_w2, grain, notes
        from bom_template_parts where template_id = v_old;
    end if;

    update bom_templates set is_active = false where item_id = v_item and id <> v_new and is_active;
    out := out || jsonb_build_object('product', p.code, 'version', v_ver);
  end loop;
  return out;
end $$;
