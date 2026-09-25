-- =====================================================================
-- Citi Homes IMS - 017 Project material budget: 80% warning, FM approval above 100%
-- =====================================================================
alter table company_settings add column budget_warn_pct numeric(5,2) not null default 80;
alter table material_issues
  add column budget_approved_by   uuid references profiles(id),
  add column budget_approved_at   timestamptz,
  add column budget_note          text,
  add column budget_requested_at  timestamptz;

-- budget approval fields can only be set by issue_budget_approve / issue_budget_request (they run as owner)
create or replace function public.issue_budget_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated','anon') and (
       new.budget_approved_by is distinct from old.budget_approved_by or new.budget_approved_at is distinct from old.budget_approved_at
    or new.budget_note is distinct from old.budget_note or new.budget_requested_at is distinct from old.budget_requested_at) then
    raise exception 'Budget approval can only be given by the Factory Manager';
  end if;
  return new;
end $$;
create trigger issue_budget_guard before update on material_issues for each row execute function issue_budget_guard();

-- read-only FIFO estimate of what posting this issue would cost (same lot order as fifo_consume)
create or replace function public.issue_estimate_value(p_issue uuid) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare h material_issues%rowtype; l record; r record; v_need numeric; v_take numeric; v_total numeric := 0;
begin
  select * into h from material_issues where id = p_issue;
  for l in select * from issue_lines where issue_id = p_issue loop
    v_need := l.qty;
    for r in select s.id, s.qty_on_hand from stock_lots s
              where s.item_id = l.item_id and s.location_id = h.from_location_id and s.qty_on_hand > 0 and s.status = 'AVAILABLE'
                and (s.project_id is null or s.project_id = h.project_id)
              order by coalesce(s.project_id = h.project_id, false) desc, (s.project_id is not null) asc,
                       s.expiry_date nulls last, s.received_date, s.created_at loop
      exit when v_need <= 0;
      v_take := least(v_need, r.qty_on_hand);
      v_total := v_total + v_take * lot_issue_cost(r.id);
      v_need := v_need - v_take;
    end loop;
  end loop;
  return round(v_total, 2);
end $$;

-- budget position of the project behind an issue (for the issue screen)
create or replace function public.issue_budget_check(p_issue uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare h material_issues%rowtype; p projects%rowtype; v_used numeric; v_this numeric; v_warn numeric;
begin
  select * into h from material_issues where id = p_issue;
  if h.project_id is null then return null; end if;
  select * into p from projects where id = h.project_id;
  if coalesce(p.budget_material, 0) <= 0 then return jsonb_build_object('has_budget', false); end if;
  select net_consumption into v_used from v_project_consumption where project_id = h.project_id;
  v_this := case when h.status = 'DRAFT' then issue_estimate_value(p_issue) else h.total_value end;
  select budget_warn_pct into v_warn from company_settings;
  return jsonb_build_object('has_budget', true, 'budget', p.budget_material, 'used', coalesce(v_used, 0), 'this_issue', v_this,
    'projected', coalesce(v_used, 0) + case when h.status = 'DRAFT' then v_this else 0 end,
    'projected_pct', round(100 * (coalesce(v_used, 0) + case when h.status = 'DRAFT' then v_this else 0 end) / p.budget_material, 1),
    'warn_pct', v_warn, 'approved', h.budget_approved_by is not null, 'requested', h.budget_requested_at is not null);
end $$;
grant execute on function public.issue_budget_check(uuid) to authenticated;
revoke execute on function public.issue_budget_check(uuid) from anon;
revoke execute on function public.issue_estimate_value(uuid) from public, anon, authenticated;

-- Stores asks the FM to approve an over-budget issue
create or replace function public.issue_budget_request(p_issue uuid) returns void
language plpgsql security definer set search_path = public as $$
declare h material_issues%rowtype; b jsonb; v_proj text;
begin
  if not has_role('stores') then raise exception 'Only Stores can request budget approval'; end if;
  select * into h from material_issues where id = p_issue for update;
  if h.status <> 'DRAFT' then raise exception 'Issue is not a draft'; end if;
  b := issue_budget_check(p_issue);
  if b is null or not (b->>'has_budget')::boolean or (b->>'projected')::numeric <= (b->>'budget')::numeric then
    raise exception 'This issue stays within the project budget — no approval needed';
  end if;
  update material_issues set budget_requested_at = now() where id = p_issue;
  select code || ' — ' || name into v_proj from projects where id = h.project_id;
  perform notify('factory_manager', null, 'Over-budget issue ' || h.issue_no || ' needs your approval',
    v_proj || ': projected AED ' || to_char((b->>'projected')::numeric, 'FM999,999,990') || ' vs budget AED ' || to_char((b->>'budget')::numeric, 'FM999,999,990')
    || ' (' || (b->>'projected_pct') || '%)', 'd/issue/' || p_issue, 'issue', p_issue);
end $$;
grant execute on function public.issue_budget_request(uuid) to authenticated;
revoke execute on function public.issue_budget_request(uuid) from anon;

create or replace function public.issue_budget_approve(p_issue uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare h material_issues%rowtype;
begin
  if not has_role('factory_manager') then raise exception 'Only the Factory Manager can approve over-budget issues'; end if;
  if coalesce(p_note, '') = '' then raise exception 'Give a reason for exceeding the budget'; end if;
  select * into h from material_issues where id = p_issue for update;
  if h.status <> 'DRAFT' then raise exception 'Issue is not a draft'; end if;
  update material_issues set budget_approved_by = auth.uid(), budget_approved_at = now(), budget_note = p_note where id = p_issue;
  perform notify('stores', null, 'Over-budget issue ' || h.issue_no || ' approved by FM', p_note, 'd/issue/' || p_issue, 'issue', p_issue);
end $$;
grant execute on function public.issue_budget_approve(uuid, text) to authenticated;
revoke execute on function public.issue_budget_approve(uuid, text) from anon;

-- post_issue: block above 100% without FM approval; alert when crossing the warning level / 100%
create or replace function public.post_issue(p_issue uuid) returns void
language plpgsql security definer set search_path = public as $$
declare h material_issues%rowtype; l record; a record; v_mrl mr_lines%rowtype;
        v_line numeric; v_total numeric := 0; v_mr_status text;
        v_budget numeric; v_used numeric; v_warn numeric; v_proj text; v_before_pct numeric; v_after_pct numeric;
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
  if h.project_id is not null then
    select budget_material, code || ' — ' || name into v_budget, v_proj from projects where id = h.project_id;
    select coalesce(net_consumption, 0) into v_used from v_project_consumption where project_id = h.project_id;
    select budget_warn_pct into v_warn from company_settings;
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

  if coalesce(v_budget, 0) > 0 then
    if v_used + v_total > v_budget + 0.005 and h.budget_approved_by is null then
      raise exception '%', format('Project %s would reach AED %s against a material budget of AED %s (%s%%). Use "Request FM approval" first.',
        v_proj, to_char(v_used + v_total, 'FM999,999,990'), to_char(v_budget, 'FM999,999,990'), round(100 * (v_used + v_total) / v_budget, 1));
    end if;
    v_before_pct := 100 * v_used / v_budget;
    v_after_pct := 100 * (v_used + v_total) / v_budget;
    if v_before_pct < 100 and v_after_pct >= 100 then
      perform notify('factory_manager', null, 'Project ' || v_proj || ' has used its full material budget', round(v_after_pct, 1) || '% after ' || h.issue_no, 'r/projects', 'project', h.project_id);
      perform notify('finance', null, 'Project ' || v_proj || ' over material budget', round(v_after_pct, 1) || '% after ' || h.issue_no, 'r/projects', 'project', h.project_id);
    elsif v_before_pct < v_warn and v_after_pct >= v_warn then
      perform notify('factory_manager', null, 'Project ' || v_proj || ' at ' || round(v_after_pct) || '% of material budget', 'Warning level ' || v_warn || '% reached with ' || h.issue_no, 'r/projects', 'project', h.project_id);
      perform notify('production_incharge', null, 'Project ' || v_proj || ' at ' || round(v_after_pct) || '% of material budget', 'Warning level ' || v_warn || '% reached with ' || h.issue_no, 'r/projects', 'project', h.project_id);
      perform notify('stores', null, 'Project ' || v_proj || ' at ' || round(v_after_pct) || '% of material budget', 'Warning level ' || v_warn || '% reached with ' || h.issue_no, 'r/projects', 'project', h.project_id);
    end if;
  end if;

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
