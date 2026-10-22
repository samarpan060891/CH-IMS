-- 060 Maintenance costing
-- * Cost centres: machine maintenance (MNT-MAC, the unused MNT renamed) and factory building & facilities (MNT-FAC), both factory
--   cost centres; General Factory Overhead marked factory too. Office maintenance stays on Administration.
-- * A machine (work centre) can be named on store requests / issues of spares and on recurring-bill lines (AMC); spares issued from
--   store (less returns) now count in that machine's rate, like repair bills and breakdowns already did.

update cost_centers set code = 'MNT-MAC', name = 'Maintenance — machines', is_factory = true where code = 'MNT';
insert into cost_centers (code, name, is_factory, is_active)
select 'MNT-MAC', 'Maintenance — machines', true, true where not exists (select 1 from cost_centers where code = 'MNT-MAC');
insert into cost_centers (code, name, is_factory, is_active)
select 'MNT-FAC', 'Maintenance — factory building & facilities', true, true where not exists (select 1 from cost_centers where code = 'MNT-FAC');
-- building repairs count as factory overhead through the factory cost centre (MNT-FAC / GEN); on ADM they stay office / admin
update cost_centers set is_factory = true where code = 'GEN';

alter table mr_lines add column work_center_id uuid references work_centers(id);
alter table issue_lines add column work_center_id uuid references work_centers(id);
alter table expense_template_lines add column work_center_id uuid references work_centers(id);

-- the machine named on a request line carries to its issue line
create or replace function public.trg_issue_line_machine() returns trigger language plpgsql as $$
begin
  if new.work_center_id is null and new.mr_line_id is not null then
    select work_center_id into new.work_center_id from mr_lines where id = new.mr_line_id;
  end if;
  return new;
end $$;
create trigger issue_line_machine before insert on issue_lines for each row execute function trg_issue_line_machine();

-- recurring bills: the machine goes onto the drafted expense line
do $$
declare v text;
begin
  v := pg_get_functiondef('public.expense_recurring_run'::regproc);
  v := replace(v, $a$insert into expense_lines (expense_id, line_no, account_id, description, cost_center_id, project_id, amount, vat_rate)
    select v_id, line_no, account_id, coalesce(description, t.title) || ' — ' || to_char(t.next_date, 'Mon YYYY'), cost_center_id, project_id, amount, vat_rate$a$,
                  $a$insert into expense_lines (expense_id, line_no, account_id, description, cost_center_id, project_id, amount, vat_rate, work_center_id)
    select v_id, line_no, account_id, coalesce(description, t.title) || ' — ' || to_char(t.next_date, 'Mon YYYY'), cost_center_id, project_id, amount, vat_rate, work_center_id$a$);
  if position('vat_rate, work_center_id' in v) = 0 then raise exception 'expense_recurring_run anchor not found'; end if;
  execute v;

  -- machine rate: + spares issued from store to the machine (net of returns)
  v := pg_get_functiondef('public.machine_rate_calc'::regproc);
  v := replace(v, $a$v_rep_exp numeric;$a$, $a$v_rep_exp numeric; v_spares numeric;$a$);
  v := replace(v, $a$  v_tool := round(w.tooling_cost_per_year * v_months / 12, 2);
  v_fixed := v_dep + v_rep_down + v_rep_exp + v_tool;$a$,
                  $a$  select coalesce(sum(il.value), 0) - coalesce((select sum(rl.value) from return_lines rl join material_returns r on r.id = rl.return_id
                                                     join issue_lines i2 on i2.id = rl.issue_line_id join material_issues h2 on h2.id = i2.issue_id
                                                    where i2.work_center_id = p_wc and r.status = 'POSTED' and h2.issue_date between f and t), 0)
    into v_spares from issue_lines il join material_issues h on h.id = il.issue_id
   where il.work_center_id = p_wc and h.status = 'POSTED' and h.issue_date between f and t;
  v_tool := round(w.tooling_cost_per_year * v_months / 12, 2);
  v_fixed := v_dep + v_rep_down + v_rep_exp + v_spares + v_tool;$a$);
  v := replace(v, $a$'repairs_expenses', v_rep_exp,$a$, $a$'repairs_expenses', v_rep_exp, 'spares_store', v_spares,$a$);
  if position('spares_store' in v) = 0 or position('v_rep_exp + v_spares' in v) = 0 then raise exception 'machine_rate_calc anchor not found'; end if;
  execute v;
end $$;
