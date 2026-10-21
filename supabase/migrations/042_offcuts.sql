-- 042 Offcuts of panels and timber
-- * A part-used sheet / length comes back on a material return as an OFFCUT line: size (L × W, or L for timber) and pieces.
--   Its quantity (in the item's unit) and value are pro-rata to the full sheet / length; the value is credited back to the job.
-- * The Production In-charge proposes KEEP (offcut stock) or SCRAP for each offcut line, the Factory Manager approves,
--   then Stores posts. Kept pieces become individual stock lots (one per piece, own size and QR label).
-- * Offcut lots are never picked automatically when issuing; they are chosen explicitly and issued whole.
--   Free stock / replenishment ignore them. Matching offcuts are suggested for cut-list parts (suggest only).

alter table stock_lots add column is_offcut boolean not null default false,
  add column length_mm numeric(10,1), add column width_mm numeric(10,1);
create index stock_lots_offcut_idx on stock_lots(item_id) where is_offcut and qty_on_hand > 0;

alter table return_lines drop constraint return_lines_condition_check;
alter table return_lines add constraint return_lines_condition_check check (condition in ('GOOD','DAMAGED','OFFCUT'));
alter table return_lines add column offcut_length_mm numeric(10,1), add column offcut_width_mm numeric(10,1),
  add column pieces int, add column offcut_action text check (offcut_action in ('KEEP','SCRAP'));

alter table material_returns drop constraint material_returns_status_check;
alter table material_returns add constraint material_returns_status_check check (status in ('DRAFT','PENDING_PI','PENDING_FM','SUBMITTED','POSTED','CANCELLED'));
alter table material_returns add column offcut_pi_by uuid references profiles(id), add column offcut_pi_at timestamptz,
  add column offcut_fm_by uuid references profiles(id), add column offcut_fm_at timestamptz, add column offcut_comments text;

-- offcut line: quantity from the piece size; size frozen once proposed / approved
create or replace function public.trg_return_offcut() returns trigger
language plpgsql security definer set search_path = public as $$
declare i items%rowtype; v_st text; v_frac numeric;
begin
  select status into v_st from material_returns where id = coalesce(new.return_id, old.return_id);
  if tg_op = 'UPDATE' and (old.condition = 'OFFCUT' or new.condition = 'OFFCUT') and v_st not in ('DRAFT','PENDING_PI')
     and (new.condition, new.offcut_length_mm, new.offcut_width_mm, new.pieces, new.offcut_action, new.qty)
         is distinct from (old.condition, old.offcut_length_mm, old.offcut_width_mm, old.pieces, old.offcut_action, old.qty)
     and coalesce(current_setting('app.offcut_ok', true), '') <> '1' then
    raise exception 'Offcut lines cannot be changed after the Production In-charge proposal';
  end if;
  if tg_op = 'INSERT' and new.condition = 'OFFCUT' and v_st not in ('DRAFT','PENDING_PI') then raise exception 'Add offcut lines while the return is a draft'; end if;
  if new.condition <> 'OFFCUT' then new.offcut_length_mm := null; new.offcut_width_mm := null; new.pieces := null; new.offcut_action := null; return new; end if;
  select * into i from items where id = new.item_id;
  if coalesce(i.length_mm, 0) <= 0 then raise exception 'Item % has no standard length / sheet size — set it in the item master to return offcuts', i.code; end if;
  if coalesce(new.offcut_length_mm, 0) <= 0 then raise exception 'Enter the offcut length (mm)'; end if;
  new.pieces := greatest(coalesce(new.pieces, 1), 1);
  if coalesce(i.width_mm, 0) > 0 then
    -- panel: area share of a full sheet (piece may be turned)
    if coalesce(new.offcut_width_mm, 0) <= 0 then raise exception 'Enter the offcut width (mm) for %', i.code; end if;
    if greatest(new.offcut_length_mm, new.offcut_width_mm) > greatest(i.length_mm, i.width_mm) + 0.5
       or least(new.offcut_length_mm, new.offcut_width_mm) > least(i.length_mm, i.width_mm) + 0.5 then
      raise exception 'Offcut % × % mm is larger than a full sheet (% × % mm)', new.offcut_length_mm, new.offcut_width_mm, i.length_mm, i.width_mm;
    end if;
    v_frac := (new.offcut_length_mm * new.offcut_width_mm) / (i.length_mm * i.width_mm);
  else
    -- timber / profiles: length share
    if new.offcut_length_mm > i.length_mm + 0.5 then raise exception 'Offcut % mm is longer than a full length (% mm)', new.offcut_length_mm, i.length_mm; end if;
    new.offcut_width_mm := null;
    v_frac := new.offcut_length_mm / i.length_mm;
  end if;
  new.qty := round(v_frac * new.pieces, 4);
  return new;
end $$;
create trigger return_offcut before insert or update on return_lines for each row execute function trg_return_offcut();

-- submit: returns with offcut lines go to the Production In-charge (or straight to the FM when the In-charge submits with every line proposed)
create or replace function public.return_action(p_ret uuid, p_action text)
returns text language plpgsql security definer set search_path = public as $$
declare h material_returns%rowtype; v_issue text; v_oc boolean; v_next text;
begin
  select * into h from material_returns where id = p_ret for update;
  if not found then raise exception 'Return not found'; end if;
  if p_action = 'SUBMIT' then
    if not has_role('shop_floor','production_incharge','stores','site_supervisor') then raise exception 'Not allowed'; end if;
    if h.status <> 'DRAFT' then raise exception 'Return is %', h.status; end if;
    if not exists (select 1 from return_lines where return_id = p_ret and qty > 0) then raise exception 'Enter at least one return quantity'; end if;
    update return_lines set requested_qty = qty where return_id = p_ret;
    select issue_no into v_issue from material_issues where id = h.issue_id;
    v_oc := exists (select 1 from return_lines where return_id = p_ret and condition = 'OFFCUT');
    v_next := case when not v_oc then 'SUBMITTED'
                   when has_role('production_incharge') and not exists (select 1 from return_lines where return_id = p_ret and condition = 'OFFCUT' and offcut_action is null) then 'PENDING_FM'
                   else 'PENDING_PI' end;
    update material_returns set status = v_next, submitted_at = now(), requested_by = coalesce(requested_by, auth.uid()),
           offcut_pi_by = case when v_next = 'PENDING_FM' then auth.uid() end, offcut_pi_at = case when v_next = 'PENDING_FM' then now() end
     where id = p_ret;
    if v_next = 'SUBMITTED' then
      perform notify('stores', null, 'Material return ' || h.return_no || ' from the floor', 'Verify and receive · against ' || v_issue, 'd/ret/' || p_ret, 'ret', p_ret);
    elsif v_next = 'PENDING_PI' then
      perform notify('production_incharge', null, 'Offcuts on return ' || h.return_no, 'Propose keep or scrap for each offcut', 'd/ret/' || p_ret, 'ret', p_ret);
    else
      perform notify('factory_manager', null, 'Offcuts on return ' || h.return_no || ' await approval', 'Production In-charge proposed keep / scrap', 'd/ret/' || p_ret, 'ret', p_ret);
    end if;
    return v_next;
  elsif p_action = 'CANCEL' then
    if h.status not in ('DRAFT','SUBMITTED','PENDING_PI','PENDING_FM') then raise exception 'Return is %', h.status; end if;
    update material_returns set status = 'CANCELLED' where id = p_ret;
    return 'CANCELLED';
  end if;
  raise exception 'Unknown action %', p_action;
end $$;

-- In-charge proposes, Factory Manager approves / sends back
create or replace function public.return_offcut_action(p_ret uuid, p_action text, p_lines jsonb default null, p_comments text default null)
returns text language plpgsql security definer set search_path = public as $$
declare h material_returns%rowtype; x jsonb;
begin
  select * into h from material_returns where id = p_ret for update;
  if not found then raise exception 'Return not found'; end if;
  perform set_config('app.offcut_ok', '1', true);
  if p_action = 'PROPOSE' then
    if not has_role('production_incharge') then raise exception 'The Production In-charge proposes keep / scrap'; end if;
    if h.status <> 'PENDING_PI' then raise exception 'Return is %', h.status; end if;
    for x in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
      update return_lines set offcut_action = x->>'action' where id = (x->>'id')::uuid and return_id = p_ret and condition = 'OFFCUT';
    end loop;
    if exists (select 1 from return_lines where return_id = p_ret and condition = 'OFFCUT' and offcut_action is null) then raise exception 'Choose keep or scrap for every offcut'; end if;
    update material_returns set status = 'PENDING_FM', offcut_pi_by = auth.uid(), offcut_pi_at = now(), offcut_comments = coalesce(p_comments, offcut_comments) where id = p_ret;
    perform notify('factory_manager', null, 'Offcuts on return ' || h.return_no || ' await approval', coalesce(p_comments, 'Production In-charge proposed keep / scrap'), 'd/ret/' || p_ret, 'ret', p_ret);
    return 'PENDING_FM';
  elsif p_action = 'APPROVE' then
    if not has_role('factory_manager') then raise exception 'The Factory Manager approves offcuts'; end if;
    if h.status <> 'PENDING_FM' then raise exception 'Return is %', h.status; end if;
    update material_returns set status = 'SUBMITTED', offcut_fm_by = auth.uid(), offcut_fm_at = now(), offcut_comments = coalesce(p_comments, offcut_comments) where id = p_ret;
    perform notify('stores', null, 'Return ' || h.return_no || ': offcuts approved', 'Receive kept offcuts into offcut stock; scrap pieces go to the scrap yard', 'd/ret/' || p_ret, 'ret', p_ret);
    return 'SUBMITTED';
  elsif p_action = 'SEND_BACK' then
    if not has_role('factory_manager') then raise exception 'The Factory Manager approves offcuts'; end if;
    if h.status <> 'PENDING_FM' then raise exception 'Return is %', h.status; end if;
    if nullif(trim(p_comments), '') is null then raise exception 'Say what should change'; end if;
    update material_returns set status = 'PENDING_PI', offcut_comments = p_comments where id = p_ret;
    perform notify('production_incharge', null, 'Offcuts on return ' || h.return_no || ' sent back', p_comments, 'd/ret/' || p_ret, 'ret', p_ret);
    return 'PENDING_PI';
  end if;
  raise exception 'Unknown action %', p_action;
end $$;

-- posting: kept offcut pieces become their own lots at pro-rata cost; scrapped offcuts stay charged to the job
create or replace function public.post_return_core(p_ret uuid)
returns void language plpgsql security definer set search_path = public as $$
declare h material_returns%rowtype; iss material_issues%rowtype; l record; a record; v_lot stock_lots%rowtype;
        v_loc uuid; v_left numeric; v_take numeric; v_val numeric; v_total numeric := 0; v_new uuid;
        v_piece numeric; v_pval numeric; v_pleft numeric; v_parent uuid; v_n int := 0; k int;
begin
  select * into h from material_returns where id = p_ret for update;
  if h.status not in ('DRAFT','SUBMITTED') then raise exception 'Return is already %', h.status; end if;
  if h.status = 'DRAFT' and exists (select 1 from return_lines where return_id = p_ret and condition = 'OFFCUT') then
    raise exception 'Offcuts need the Production In-charge proposal and Factory Manager approval — submit the return first';
  end if;
  select * into iss from material_issues where id = h.issue_id;
  if iss.status <> 'POSTED' then raise exception 'Source issue is not posted'; end if;
  perform set_config('app.offcut_ok', '1', true);

  for l in select rl.*, il.issue_id src_issue, il.qty issued_qty, il.returned_qty already
             from return_lines rl join issue_lines il on il.id = rl.issue_line_id
            where rl.return_id = p_ret for update of il loop
    if l.src_issue <> h.issue_id then raise exception 'Return line does not belong to issue %', iss.issue_no; end if;
    continue when l.qty <= 0;
    if l.qty > l.issued_qty - l.already + 0.0005 then
      raise exception 'Return qty % exceeds un-returned balance %', l.qty, l.issued_qty - l.already;
    end if;

    if l.condition = 'OFFCUT' then
      -- scrapped offcut: nothing comes into stock, the cost stays with the job
      if l.offcut_action = 'SCRAP' then update return_lines set value = 0 where id = l.id; continue; end if;
      if l.offcut_action is distinct from 'KEEP' then raise exception 'Offcut line has no approved decision'; end if;
      v_piece := round(l.qty / l.pieces, 4); v_val := 0;
      for k in 1 .. l.pieces loop
        v_pleft := case when k = l.pieces then l.qty - v_piece * (l.pieces - 1) else v_piece end;
        v_pval := 0; v_parent := null;
        for a in select * from issue_line_lots where issue_line_id = l.issue_line_id and qty > returned_qty order by seq desc for update loop
          exit when v_pleft <= 0.00005;
          v_take := least(v_pleft, a.qty - a.returned_qty);
          if item_valuation(l.item_id) = 'WAVG' then perform wavg_receive(l.item_id, v_take, a.unit_cost); end if;
          update issue_line_lots set returned_qty = returned_qty + v_take where id = a.id;
          v_pval := v_pval + v_take * a.unit_cost; v_parent := coalesce(v_parent, a.lot_id);
          v_pleft := v_pleft - v_take;
        end loop;
        v_take := case when k = l.pieces then l.qty - v_piece * (l.pieces - 1) else v_piece end;
        select * into v_lot from stock_lots where id = v_parent;
        v_n := v_n + 1;
        insert into stock_lots (item_id, location_id, lot_no, batch_no, source_type, source_id, parent_lot_id, received_date,
                                unit_cost, qty_in, qty_on_hand, vendor_id, project_id, status, is_offcut, length_mm, width_mm)
        values (l.item_id, h.to_location_id, 'OC-' || h.return_no || '-' || v_n,
                v_lot.batch_no, 'RETURN', l.id, v_parent, h.return_date,
                round(v_pval / v_take, 4), v_take, v_take, v_lot.vendor_id, null, 'AVAILABLE', true, l.offcut_length_mm, l.offcut_width_mm)
        returning id into v_new;
        insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value,
                                  doc_type, doc_id, doc_no, doc_line_id, project_id, cost_center_id, remarks)
        values (h.return_date, 'RETURN', l.item_id, h.to_location_id, v_new, v_take, round(v_pval / v_take, 4), round(v_pval, 2),
                'RETURN', h.id, h.return_no, l.id, iss.project_id, iss.cost_center_id,
                'OFFCUT ' || l.offcut_length_mm || coalesce(' × ' || l.offcut_width_mm, '') || ' mm');
        v_val := v_val + round(v_pval, 2);
      end loop;
      update issue_lines set returned_qty = returned_qty + l.qty where id = l.issue_line_id;
      update return_lines set value = v_val where id = l.id;
      v_total := v_total + v_val;
      continue;
    end if;

    v_loc := case when l.condition = 'GOOD' then h.to_location_id
                  else (select id from locations where loc_type = 'QUARANTINE' order by created_at limit 1) end;
    v_left := l.qty; v_val := 0;
    for a in select * from issue_line_lots where issue_line_id = l.issue_line_id and qty > returned_qty order by seq desc for update loop
      exit when v_left <= 0.0005;
      v_take := least(v_left, a.qty - a.returned_qty);
      select * into v_lot from stock_lots where id = a.lot_id;
      if item_valuation(l.item_id) = 'WAVG' then perform wavg_receive(l.item_id, v_take, a.unit_cost); end if;
      if l.condition = 'GOOD' and v_lot.location_id = v_loc and v_lot.status = 'AVAILABLE' and not v_lot.is_offcut then
        update stock_lots set qty_on_hand = qty_on_hand + v_take where id = v_lot.id;
        v_new := v_lot.id;
      else
        insert into stock_lots (item_id, location_id, lot_no, batch_no, source_type, source_id, parent_lot_id,
                                received_date, mfg_date, expiry_date, unit_cost, qty_in, qty_on_hand, vendor_id, project_id, status, hold_reason)
        values (l.item_id, v_loc, v_lot.lot_no, v_lot.batch_no, 'RETURN', l.id, v_lot.id, v_lot.received_date,
                v_lot.mfg_date, v_lot.expiry_date, a.unit_cost, v_take, v_take, v_lot.vendor_id, v_lot.project_id,
                case when l.condition = 'GOOD' then 'AVAILABLE' else 'HOLD' end,
                case when l.condition = 'GOOD' then null else 'RETURN_DAMAGED' end)
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
  update material_returns set status = 'POSTED', total_value = v_total, posted_at = now(), posted_by = auth.uid() where id = p_ret;
end $$;

-- automatic picking skips offcut pieces; a chosen offcut is issued whole
do $$
declare d text := pg_get_functiondef('public.fifo_consume(uuid,uuid,numeric,uuid,text,text,uuid,text,uuid,date,uuid,uuid,uuid,boolean)'::regprocedure);
begin
  if position('and (p_lot is null or l.id = p_lot)' in d) = 0 or position('v_take := least(v_need, r.qty_on_hand);' in d) = 0 then raise exception 'fifo_consume anchors missing'; end if;
  d := replace(d, 'and (p_lot is null or l.id = p_lot)', 'and (p_lot is null or l.id = p_lot) and (p_lot is not null or not l.is_offcut)');
  d := replace(d, 'select l.id, l.qty_on_hand from stock_lots l', 'select l.id, l.qty_on_hand, l.is_offcut, l.lot_no from stock_lots l');
  d := replace(d, 'v_take := least(v_need, r.qty_on_hand);',
    'v_take := least(v_need, r.qty_on_hand);' || chr(10) ||
    '    if r.is_offcut and v_take < r.qty_on_hand - 0.0005 then raise exception ''Offcut % is issued as a whole piece (% of the unit) — enter that quantity'', r.lot_no, round(r.qty_on_hand, 4); end if;');
  execute d;
end $$;

-- lot values carry the offcut size; free stock (replenishment, buffers) excludes offcut pieces
create or replace view v_lot_values with (security_invoker = true) as
 SELECT l.id AS lot_id, l.item_id, l.location_id, l.lot_no, l.batch_no, l.received_date, l.expiry_date, l.status AS lot_status, l.qty_on_hand, l.unit_cost,
    l.vendor_id, l.project_id, i.code AS item_code, i.name AS item_name, u.code AS uom, c.id AS class_id, c.code AS class_code, c.name AS class_name,
    cat.id AS category_id, cat.code AS category_code, cat.name AS category_name, loc.code AS location_code, loc.name AS location_name, loc.loc_type,
    COALESCE(i.valuation_override, c.valuation_method) AS valuation_method,
    CASE WHEN COALESCE(i.valuation_override, c.valuation_method) = 'WAVG' THEN i.avg_cost ELSE l.unit_cost END AS value_rate,
    round(l.qty_on_hand * CASE WHEN COALESCE(i.valuation_override, c.valuation_method) = 'WAVG' THEN i.avg_cost ELSE l.unit_cost END, 2) AS value,
    CURRENT_DATE - l.received_date AS age_days,
    CASE WHEN CURRENT_DATE - l.received_date <= 30 THEN '0-30' WHEN CURRENT_DATE - l.received_date <= 60 THEN '31-60'
         WHEN CURRENT_DATE - l.received_date <= 90 THEN '61-90' WHEN CURRENT_DATE - l.received_date <= 180 THEN '91-180'
         WHEN CURRENT_DATE - l.received_date <= 365 THEN '181-365' ELSE '365+' END AS age_bucket,
    l.is_offcut, l.length_mm, l.width_mm
   FROM stock_lots l JOIN items i ON i.id = l.item_id JOIN item_classes c ON c.id = i.class_id JOIN uoms u ON u.id = i.uom_id
   JOIN locations loc ON loc.id = l.location_id LEFT JOIN item_categories cat ON cat.id = i.category_id
  WHERE l.qty_on_hand > 0;

do $$
declare d text := pg_get_viewdef('v_item_stock'::regclass);
begin
  if position('(v_lot_values.project_id IS NULL))) AS available' in d) = 0 then raise exception 'v_item_stock anchor missing'; end if;
  d := replace(d, '(v_lot_values.project_id IS NULL))) AS available', '(v_lot_values.project_id IS NULL) AND (NOT v_lot_values.is_offcut))) AS available');
  execute 'create or replace view v_item_stock with (security_invoker = true) as ' || d;
end $$;

-- offcut stock register
create or replace view v_offcuts with (security_invoker = true) as
select v.lot_id, v.lot_no, v.item_id, v.item_code, v.item_name, i.thickness_mm, v.length_mm, v.width_mm,
       case when v.width_mm is not null then round(v.length_mm * v.width_mm / 1e6, 3) end area_m2,
       case when coalesce(i.width_mm, 0) > 0 then 'PANEL' else 'TIMBER' end kind,
       v.qty_on_hand, v.uom, v.value, v.location_id, v.location_code, v.received_date, v.age_days, v.lot_status, v.loc_type,
       (select h.return_no from return_lines rl join material_returns h on h.id = rl.return_id join stock_lots s on s.source_id = rl.id where s.id = v.lot_id) return_no
  from v_lot_values v join items i on i.id = v.item_id
 where v.is_offcut;

-- suggest offcuts that fit cut-list parts (same board; panel parts may turn when they have no grain; best fit first)
create or replace function public.offcut_matches(p_wo uuid default null)
returns table (wo_id uuid, wo_no text, part_id uuid, part_name text, part_length numeric, part_width numeric, pieces numeric, grain boolean,
               lot_id uuid, lot_no text, item_code text, offcut_length numeric, offcut_width numeric, location_code text, value numeric, waste_pct numeric, age_days int)
language sql stable security definer set search_path = public as $$
  select wo_id, wo_no, part_id, part_name, part_length, part_width, pieces, grain, lot_id, lot_no, item_code, offcut_length, offcut_width, location_code, value, waste, age_days from (
    select w.id wo_id, w.wo_no, p.id part_id, p.part_name, p.length_mm part_length, p.width_mm part_width, p.pieces, p.grain,
           o.lot_id, o.lot_no, o.item_code, o.length_mm offcut_length, o.width_mm offcut_width, o.location_code, o.value,
           round(100 * (1 - case when o.width_mm is null then p.length_mm / o.length_mm else (p.length_mm * coalesce(p.width_mm, 0)) / (o.length_mm * o.width_mm) end), 1) waste,
           o.age_days,
           row_number() over (partition by p.id order by case when o.width_mm is null then o.length_mm else o.length_mm * o.width_mm end, o.age_days desc) rn
      from production_orders w
      join wo_parts p on p.wo_id = w.id
      join v_offcuts o on o.item_id = p.material_id and o.lot_status = 'AVAILABLE' and o.loc_type <> 'QUARANTINE'
     where ((p_wo is null and w.status in ('DRAFT','RELEASED','IN_PROGRESS')) or w.id = p_wo)
       and is_active_user()
       and ((o.width_mm is null and p.length_mm <= o.length_mm)
         or (o.width_mm is not null and ((p.length_mm <= o.length_mm and coalesce(p.width_mm, 0) <= o.width_mm)
                                       or (not coalesce(p.grain, false) and p.length_mm <= o.width_mm and coalesce(p.width_mm, 0) <= o.length_mm))))
  ) x where rn <= 5
  order by wo_no, part_name, waste
$$;

grant execute on function public.return_offcut_action(uuid, text, jsonb, text), public.offcut_matches(uuid) to authenticated;
revoke execute on function public.return_offcut_action(uuid, text, jsonb, text), public.offcut_matches(uuid) from anon;
