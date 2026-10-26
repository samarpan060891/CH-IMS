-- 094 Projects with billable progress: site progress earned but not yet claimed. Claimed = progress / final claims
-- submitted, certified or posted (certified value where recorded). A project with a claim already in draft shows it
-- (has_draft) so the Dispatch & invoicing badge does not count it twice with the draft-invoice badge.
create or replace view v_project_billable with (security_invoker = true) as
  select p.id project_id, p.code project_code, p.name project_name, c.name customer_name, p.contract_value, p.billing_basis,
         e.earned earned_value, coalesce(k.claimed, 0) claimed_to_date, round(e.earned - coalesce(k.claimed, 0), 2) billable,
         exists (select 1 from sales_invoices s where s.project_id = p.id and s.inv_type in ('PROGRESS', 'FINAL') and s.status = 'DRAFT') has_draft,
         k.last_claim
    from projects p
    left join customers c on c.id = p.customer_id
    cross join lateral (select coalesce(sum(b.earned_value), 0) earned from v_boq_progress b where b.project_id = p.id) e
    left join lateral (select sum(coalesce(s.certified_gross, s.gross_claimed)) claimed, max(s.invoice_date) last_claim
                         from sales_invoices s where s.project_id = p.id and s.inv_type in ('PROGRESS', 'FINAL') and s.status in ('SUBMITTED', 'CERTIFIED', 'POSTED')) k on true
   where p.project_type = 'PROJECT' and p.status = 'OPEN';
