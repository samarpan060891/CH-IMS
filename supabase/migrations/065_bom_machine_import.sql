-- 065 Excel uploads: BOM & man-hours, machine rates
-- bom_import: every product in the file gets a new BOM version that becomes the active one; older versions are kept,
-- inactive. A product with rows on only one sheet keeps the other part (materials or stages) and its cut list from the
-- current version, so hours can be updated without re-sending materials. All in one transaction.
create or replace function bom_import(p_rows jsonb, p_file text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
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
      insert into bom_template_routing (template_id, seq, work_center_id, std_labour_hours, std_machine_hours, instructions)
      select v_new, coalesce((x->>'seq')::int, 10 * row_number() over (order by (x->>'ord')::int)), (select id from work_centers where code = x->>'wc'),
             coalesce((x->>'labour')::numeric, 0), coalesce((x->>'machine')::numeric, 0), nullif(x->>'notes', '')
        from jsonb_array_elements(p_rows) x where x->>'product' = p.code and x->>'sheet' = 'S';
    elsif v_old is not null then
      insert into bom_template_routing (template_id, seq, work_center_id, std_labour_hours, std_machine_hours, instructions)
      select v_new, seq, work_center_id, std_labour_hours, std_machine_hours, instructions from bom_template_routing where template_id = v_old;
    end if;

    if v_old is not null then   -- the cut list is not in the upload: carried over
      insert into bom_template_parts (template_id, line_no, part_name, material_id, length_mm, width_mm, pieces, edge_item_id, edge_l1, edge_l2, edge_w1, edge_w2, grain, notes)
      select v_new, line_no, part_name, material_id, length_mm, width_mm, pieces, edge_item_id, edge_l1, edge_l2, edge_w1, edge_w2, grain, notes
        from bom_template_parts where template_id = v_old;
    end if;

    update bom_templates set is_active = false where item_id = v_item and id <> v_new and is_active;
    out := out || jsonb_build_object('product', p.code, 'version', v_ver);
  end loop;
  return out;
end $$;

-- work_center_import: calculator inputs per work centre; a machine rate that differs is applied through machine_rate_apply,
-- so it lands in the machine-rate history (basis MANUAL, the file name as the note)
create or replace function work_center_import(p_rows jsonb, p_file text default null) returns int
language plpgsql security definer set search_path = public as $$
declare r jsonb; w work_centers; n int := 0;
begin
  if not has_role('factory_manager', 'finance') then raise exception 'The Factory Manager or Finance uploads machine rates'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    select * into w from work_centers where code = r->>'code';
    if w.id is null then raise exception 'Work centre % not found', r->>'code'; end if;
    update work_centers set
      hours_per_day = coalesce((r->>'hours_per_day')::numeric, hours_per_day),
      power_kw = coalesce((r->>'power_kw')::numeric, power_kw),
      load_factor_pct = coalesce((r->>'load_factor_pct')::numeric, load_factor_pct),
      tooling_cost_per_year = coalesce((r->>'tooling_cost_per_year')::numeric, tooling_cost_per_year),
      working_days_per_year = coalesce((r->>'working_days_per_year')::numeric::int, working_days_per_year),
      utilisation_pct = coalesce((r->>'utilisation_pct')::numeric, utilisation_pct),
      labour_rate_per_hour = case when r ? 'labour_rate_per_hour' then (r->>'labour_rate_per_hour')::numeric else labour_rate_per_hour end,
      default_grade_id = coalesce((select id from labour_grades where code = r->>'grade'), default_grade_id)
     where id = w.id;
    if (r->>'rate') is not null and round((r->>'rate')::numeric, 2) is distinct from w.machine_rate_per_hour then
      perform machine_rate_apply(w.id, (r->>'rate')::numeric, 'MANUAL', current_date, current_date, null,
                                 'Excel import' || coalesce(': ' || nullif(p_file, ''), '') || coalesce(' — ' || nullif(r->>'notes', ''), ''));
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

grant execute on function bom_import(jsonb, text), work_center_import(jsonb, text) to authenticated;
