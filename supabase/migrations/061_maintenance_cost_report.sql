-- 061 Maintenance cost by machine and month: breakdowns (count, hours, repair cost), repair / spares / AMC bills tagged to the machine,
-- and spares issued from store to it (less returns). Read with the caller's permissions.
create or replace view v_machine_maintenance with (security_invoker = true) as
with d as (select work_center_id wc, date_trunc('month', start_at)::date m, count(*) breakdowns,
                  round(sum(extract(epoch from (coalesce(end_at, now()) - start_at)) / 3600)::numeric, 1) down_hours, coalesce(sum(repair_cost), 0) repairs
             from wc_downtime group by 1, 2),
     e as (select l.work_center_id wc, date_trunc('month', x.exp_date)::date m, sum(l.amount) bills
             from expense_lines l join expenses x on x.id = l.expense_id
            where l.work_center_id is not null and x.status in ('POSTED','REIMBURSED') group by 1, 2),
     s as (select il.work_center_id wc, date_trunc('month', h.issue_date)::date m, sum(il.value) spares
             from issue_lines il join material_issues h on h.id = il.issue_id
            where il.work_center_id is not null and h.status = 'POSTED' group by 1, 2),
     r as (select i2.work_center_id wc, date_trunc('month', rt.return_date)::date m, sum(rl.value) returned
             from return_lines rl join material_returns rt on rt.id = rl.return_id join issue_lines i2 on i2.id = rl.issue_line_id
            where i2.work_center_id is not null and rt.status = 'POSTED' group by 1, 2),
     k as (select wc, m from d union select wc, m from e union select wc, m from s union select wc, m from r)
select k.m period_month, w.id work_center_id, w.code, w.name, w.kind,
       coalesce(d.breakdowns, 0) breakdowns, coalesce(d.down_hours, 0) down_hours, coalesce(d.repairs, 0) breakdown_repairs,
       coalesce(e.bills, 0) bills_amc, coalesce(s.spares, 0) - coalesce(r.returned, 0) store_spares,
       coalesce(d.repairs, 0) + coalesce(e.bills, 0) + coalesce(s.spares, 0) - coalesce(r.returned, 0) total_cost
  from k join work_centers w on w.id = k.wc
  left join d on d.wc = k.wc and d.m = k.m left join e on e.wc = k.wc and e.m = k.m
  left join s on s.wc = k.wc and s.m = k.m left join r on r.wc = k.wc and r.m = k.m;
