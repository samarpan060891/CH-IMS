-- 069 Which BOQ lines a requisitioned material is for. A material planned for a project (e.g. softwood) is usually
-- needed by several BOQ lines; material planning now records the split on each requisition line (shown on the
-- requisition and the PO). A line for a single BOQ line also keeps pr_lines.boq_line_id as before.
create table pr_line_boq (
  id uuid primary key default gen_random_uuid(),
  pr_line_id uuid not null references pr_lines(id) on delete cascade,
  boq_line_id uuid not null references boq_lines(id) on delete cascade,
  qty numeric not null
);
create index on pr_line_boq (pr_line_id);
create index on pr_line_boq (boq_line_id);
alter table pr_line_boq enable row level security;
create policy read_active on pr_line_boq for select using (is_active_user());

-- the project's demand for one material, per BOQ line (same basis as material planning):
-- made in-house lines not yet on production orders × BOM, open production orders' materials, bought-out lines
create or replace function mrp_boq_split(p_project uuid, p_item uuid)
returns table (boq_line_id uuid, qty numeric) language sql stable security definer set search_path = public as $$
  select x.boq_line_id, sum(x.qty) from (
    select b.id as boq_line_id, (b.qty - coalesce((select sum(w.qty) from production_orders w where w.boq_line_id = b.id and w.status <> 'CANCELLED' and not w.is_rework), 0)) * t.qty_per_unit as qty
      from boq_lines b
      join v_template_unit_materials t on t.template_id = coalesce(b.template_id,
             (select x.id from bom_templates x where x.item_id = b.item_id and x.is_active order by x.version desc limit 1))
     where b.project_id = p_project and b.category = 'MANUFACTURED' and t.item_id = p_item
    union all
    select w.boq_line_id, m.required_qty
      from production_orders w join wo_materials m on m.wo_id = w.id
     where w.project_id = p_project and w.boq_line_id is not null and m.item_id = p_item and w.status in ('DRAFT', 'RELEASED', 'IN_PROGRESS')
    union all
    select b.id, b.qty from boq_lines b
     where b.project_id = p_project and b.item_id = p_item and b.category in ('BOUGHT_OUT', 'SERVICE')
  ) x where x.qty > 0
  group by x.boq_line_id
$$;

-- record the split on a requisition line, scaled to the requisitioned quantity
create or replace function pr_line_split_boq(p_line uuid) returns int language plpgsql security definer set search_path = public as $$
declare l pr_lines%rowtype; v_tot numeric; v_n int;
begin
  select * into l from pr_lines where id = p_line;
  if l.project_id is null then return 0; end if;
  delete from pr_line_boq where pr_line_id = p_line;
  select sum(s.qty) into v_tot from mrp_boq_split(l.project_id, l.item_id) s;
  if coalesce(v_tot, 0) <= 0 then return 0; end if;
  insert into pr_line_boq (pr_line_id, boq_line_id, qty)
  select p_line, s.boq_line_id, round(s.qty / v_tot * l.qty, 3) from mrp_boq_split(l.project_id, l.item_id) s;
  get diagnostics v_n = row_count;
  -- a single BOQ line: link it directly as well
  if v_n = 1 and l.boq_line_id is null then
    update pr_lines set boq_line_id = (select boq_line_id from pr_line_boq where pr_line_id = p_line) where id = p_line;
  end if;
  return v_n;
end $$;
revoke execute on function pr_line_split_boq(uuid) from public, anon, authenticated;
revoke execute on function mrp_boq_split(uuid, uuid) from public, anon;

-- material planning: each requisition line gets its BOQ split
create or replace function mrp_create_prs(p_lines jsonb) returns integer language plpgsql security definer set search_path = public as $$
declare r record; v_pr uuid; v_n int := 0; v_prs int := 0; v_last uuid := '00000000-0000-0000-0000-000000000000'; v_proj uuid; v_line uuid;
begin
  if not has_role('purchase','stores','production_incharge','factory_manager') then raise exception 'Not allowed'; end if;
  for r in select (e->>'project_id')::uuid project_id, (e->>'item_id')::uuid item_id, (e->>'qty')::numeric qty,
                  nullif(e->>'required_date', '')::date required_date, nullif(e->>'boq_line_id', '')::uuid boq_line_id, p.project_type, p.code
             from jsonb_array_elements(p_lines) e join projects p on p.id = (e->>'project_id')::uuid
            where (e->>'qty')::numeric > 0
            order by (e->>'project_id'), (e->>'item_id') loop
    if r.project_id <> v_last then
      v_proj := case when r.project_type = 'PROJECT' then r.project_id end;
      insert into purchase_requisitions (source, project_id, required_date, status, remarks)
      values ('MRP', v_proj, r.required_date, 'SUBMITTED', 'Material planning for ' || r.code)
      returning id into v_pr;
      v_prs := v_prs + 1; v_n := 0; v_last := r.project_id;
    end if;
    v_n := v_n + 1;
    insert into pr_lines (pr_id, line_no, item_id, qty, project_id, required_date, boq_line_id, remarks)
    values (v_pr, v_n, r.item_id, round(r.qty, 3), v_proj, r.required_date, r.boq_line_id, 'MRP — ' || r.code)
    returning id into v_line;
    perform pr_line_split_boq(v_line);
    update purchase_requisitions set required_date = least(coalesce(required_date, r.required_date), coalesce(r.required_date, required_date)) where id = v_pr;
  end loop;
  if v_prs = 0 then raise exception 'Select at least one line with a quantity'; end if;
  perform notify('purchase', null, v_prs || ' requisition(s) from material planning', 'Project materials to order', 'd/pr', 'pr', null);
  return v_prs;
end $$;

-- requisition lines already raised by material planning get their split now
select pr_line_split_boq(l.id) from pr_lines l join purchase_requisitions r on r.id = l.pr_id
 where r.source = 'MRP' and l.project_id is not null and not exists (select 1 from pr_line_boq x where x.pr_line_id = l.id);
