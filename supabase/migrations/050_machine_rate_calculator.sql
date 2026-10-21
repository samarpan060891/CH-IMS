-- 050 Machine-rate calculator
-- Suggests each work centre's machine rate per hour from its real running costs over a period:
--   fixed costs  = depreciation of the machines linked to it + repairs (breakdown repair costs + expenses tagged to it)
--                  + tooling / consumables allowance
--   ÷ hours      = machine hours actually logged on production orders, or planned capacity hours (hours/day × working days × utilisation)
--   + power      = kW × load % × electricity tariff, per running hour
-- The rate is only changed when the Factory Manager / Finance applies it (stage logs from then on); every change is kept.

alter table work_centers add column power_kw numeric(8,2) not null default 0,
  add column load_factor_pct numeric(5,2) not null default 70,
  add column tooling_cost_per_year numeric(12,2) not null default 0,
  add column working_days_per_year int not null default 300,
  add column utilisation_pct numeric(5,2) not null default 75;
alter table company_settings add column power_tariff_aed_kwh numeric(8,4) not null default 0.38;
-- link machines (assets) and machine-specific expenses (repairs, spares, service contracts) to a work centre
alter table assets add column work_center_id uuid references work_centers(id);
alter table expense_lines add column work_center_id uuid references work_centers(id);

create table machine_rate_reviews (
  id             uuid primary key default gen_random_uuid(),
  work_center_id uuid not null references work_centers(id),
  period_from    date not null,
  period_to      date not null,
  basis          text not null check (basis in ('ACTUAL','CAPACITY','MANUAL')),
  old_rate       numeric(12,2),
  new_rate       numeric(12,2) not null,
  components     jsonb,
  notes          text,
  applied_by     uuid default auth.uid() references profiles(id),
  applied_at     timestamptz not null default now()
);

create or replace function public.machine_rate_calc(p_wc uuid, p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare w work_centers%rowtype; f date := coalesce(p_from, (current_date - interval '12 months')::date + 1); t date := coalesce(p_to, current_date);
  v_months numeric; v_dep numeric := 0; v_rep_down numeric; v_rep_exp numeric; v_tool numeric; v_hours numeric; v_cap numeric; v_power numeric; v_fixed numeric;
  v_assets jsonb; v_tariff numeric;
begin
  if not has_role('factory_manager','finance','production_incharge') then raise exception 'Not allowed'; end if;
  select * into w from work_centers where id = p_wc;
  if not found then raise exception 'Work centre not found'; end if;
  if t < f then raise exception 'The period end is before its start'; end if;
  v_months := round(((t - f) + 1) / 30.4375, 2);
  select power_tariff_aed_kwh into v_tariff from company_settings where id = 1;

  -- depreciation of linked machines for the months they were in service inside the period (straight line, as month end posts it)
  select coalesce(sum(round(a.purchase_cost / (coalesce(a.useful_life_years, c.useful_life_years, 10) * 12)
           * greatest(0, least(t, (a.purchase_date + make_interval(months => (coalesce(a.useful_life_years, c.useful_life_years, 10) * 12)::int))::date)
                          - greatest(f, a.purchase_date) + 1) / 30.4375, 2)), 0),
         coalesce(jsonb_agg(jsonb_build_object('tag', a.asset_tag, 'item', i.name, 'cost', a.purchase_cost, 'life_years', coalesce(a.useful_life_years, c.useful_life_years, 10),
           'since', a.purchase_date)), '[]')
    into v_dep, v_assets
    from assets a join items i on i.id = a.item_id join item_classes c on c.id = i.class_id
   where a.work_center_id = p_wc and coalesce(a.purchase_cost, 0) > 0 and a.status not in ('SCRAPPED','DISPOSED','LOST') and a.purchase_date <= t;

  select coalesce(sum(repair_cost), 0) into v_rep_down from wc_downtime where work_center_id = p_wc and start_at::date between f and t;
  select coalesce(sum(l.amount), 0) into v_rep_exp from expense_lines l join expenses e on e.id = l.expense_id
   where l.work_center_id = p_wc and e.status in ('POSTED','REIMBURSED') and e.exp_date between f and t;
  v_tool := round(w.tooling_cost_per_year * v_months / 12, 2);
  v_fixed := v_dep + v_rep_down + v_rep_exp + v_tool;

  select coalesce(sum(machine_hours), 0) into v_hours from wo_time_logs l join wo_operations o on o.id = l.operation_id
   where o.work_center_id = p_wc and l.log_date between f and t;
  v_cap := round(w.hours_per_day * w.working_days_per_year * w.utilisation_pct / 100 * v_months / 12, 1);
  v_power := round(w.power_kw * w.load_factor_pct / 100 * v_tariff, 2);

  return jsonb_build_object(
    'work_center', w.code || ' — ' || w.name, 'kind', w.kind, 'from', f, 'to', t, 'months', v_months, 'current_rate', w.machine_rate_per_hour,
    'depreciation', v_dep, 'assets', v_assets, 'repairs_breakdowns', v_rep_down, 'repairs_expenses', v_rep_exp, 'tooling', v_tool, 'fixed_total', v_fixed,
    'logged_hours', v_hours, 'capacity_hours', v_cap, 'power_per_hour', v_power, 'power_kw', w.power_kw, 'load_pct', w.load_factor_pct, 'tariff', v_tariff,
    'rate_actual', case when v_hours > 0 then round(v_fixed / v_hours + v_power, 2) end,
    'rate_capacity', case when v_cap > 0 then round(v_fixed / v_cap + v_power, 2) end);
end $$;

create or replace function public.machine_rate_apply(p_wc uuid, p_rate numeric, p_basis text, p_from date, p_to date, p_components jsonb default null, p_notes text default null)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_old numeric;
begin
  if not has_role('factory_manager','finance') then raise exception 'The Factory Manager or Finance sets machine rates'; end if;
  if coalesce(p_rate, -1) < 0 then raise exception 'Enter a valid rate'; end if;
  select machine_rate_per_hour into v_old from work_centers where id = p_wc for update;
  update work_centers set machine_rate_per_hour = round(p_rate, 2) where id = p_wc;
  insert into machine_rate_reviews (work_center_id, period_from, period_to, basis, old_rate, new_rate, components, notes)
  values (p_wc, p_from, p_to, p_basis, v_old, round(p_rate, 2), p_components, p_notes);
  return round(p_rate, 2);
end $$;

-- link / unlink a machine (asset) to a work centre from the calculator
create or replace function public.machine_link_asset(p_asset uuid, p_wc uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not has_role('factory_manager','finance','stores') then raise exception 'The Factory Manager, Finance or Stores links machines'; end if;
  update assets set work_center_id = p_wc where id = p_asset;
end $$;
grant execute on function public.machine_link_asset(uuid, uuid) to authenticated;
revoke execute on function public.machine_link_asset(uuid, uuid) from anon;

alter table machine_rate_reviews enable row level security;
create policy read_mgmt on machine_rate_reviews for select to authenticated using (public.has_role('factory_manager','finance','production_incharge'));

grant execute on function public.machine_rate_calc(uuid, date, date), public.machine_rate_apply(uuid, numeric, text, date, date, jsonb, text) to authenticated;
revoke execute on function public.machine_rate_calc(uuid, date, date), public.machine_rate_apply(uuid, numeric, text, date, date, jsonb, text) from anon;
