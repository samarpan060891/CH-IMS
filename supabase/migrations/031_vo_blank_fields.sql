-- Citi Homes IMS - 031: a CHANGE line treats empty text the same as "not changed"
do $$
declare d text := pg_get_functiondef('public.vo_action(uuid, text, text)'::regprocedure);
begin
  d := replace(d, 'description = coalesce(l.description, description)', 'description = coalesce(nullif(l.description, ''''), description)');
  d := replace(d, 'boq_ref = coalesce(l.boq_ref, boq_ref)', 'boq_ref = coalesce(nullif(l.boq_ref, ''''), boq_ref)');
  d := replace(d, 'uom = coalesce(l.uom, uom)', 'uom = coalesce(nullif(l.uom, ''''), uom)');
  d := replace(d, 'unit_type = coalesce(l.unit_type, unit_type)', 'unit_type = coalesce(nullif(l.unit_type, ''''), unit_type)');
  d := replace(d, 'unit_codes = coalesce(l.unit_codes, unit_codes)', 'unit_codes = coalesce(nullif(l.unit_codes, ''''), unit_codes)');
  execute d;
end $$;
create or replace view v_vo_lines with (security_invoker = true) as
with x as (
  select v.id, v.vo_id, v.line_no, v.change_type, v.boq_line_id, nullif(v.boq_ref, '') boq_ref, nullif(v.description, '') description,
         nullif(v.unit_type, '') unit_type, nullif(v.unit_codes, '') unit_codes, v.qty_per_unit, v.qty, v.sell_rate, v.est_unit_cost,
         v.old_qty, v.old_sell_rate, v.old_est_cost, v.applied_qty,
         h.project_id, h.status vo_status, b.qty b_qty, b.sell_rate b_rate, b.est_unit_cost b_cost, b.unit_type b_ut, b.unit_codes b_uc, b.qty_per_unit b_qpu,
         b.description b_desc, b.boq_ref b_ref
    from vo_lines v join variation_orders h on h.id = v.vo_id left join boq_lines b on b.id = v.boq_line_id
), y as (
  select x.*,
         case when x.vo_status = 'APPROVED' then x.old_qty else coalesce(x.b_qty, 0) end before_qty,
         case when x.vo_status = 'APPROVED' then x.old_sell_rate else coalesce(x.b_rate, 0) end before_rate,
         case when x.vo_status = 'APPROVED' then x.old_est_cost else coalesce(x.b_cost, 0) end before_cost,
         case when x.vo_status = 'APPROVED' then x.applied_qty
              when x.change_type = 'OMIT' then 0
              when coalesce(coalesce(x.unit_type, x.b_ut), '') <> '' or coalesce(coalesce(x.unit_codes, x.b_uc), '') <> ''
                then coalesce(x.qty_per_unit, x.b_qpu, 0) * boq_unit_count(x.project_id, coalesce(x.unit_type, x.b_ut), coalesce(x.unit_codes, x.b_uc))
              else coalesce(x.qty, x.b_qty, 0) end after_qty,
         coalesce(x.sell_rate, x.b_rate, 0) after_rate, coalesce(x.est_unit_cost, x.b_cost, 0) after_cost
    from x
)
select y.id, y.vo_id, y.line_no, y.change_type, y.boq_line_id, coalesce(y.boq_ref, y.b_ref) boq_ref, coalesce(y.description, y.b_desc) description,
       y.before_qty, y.after_qty, y.before_rate, y.after_rate,
       round(y.after_qty * y.after_rate - case when y.change_type = 'ADD' then 0 else y.before_qty * y.before_rate end, 2) value_change,
       round(y.after_qty * y.after_cost - case when y.change_type = 'ADD' then 0 else y.before_qty * y.before_cost end, 2) cost_change
  from y;
