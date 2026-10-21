-- =====================================================================
-- CitiCore - 037 General ledger
--   chart of accounts (UAE manufacturing / contracting), journals, periods (lock), and the posting engine
--   gl_sync(): every finished document becomes a balanced journal exactly once (stock movements, production,
--   services & site labour, supplier invoices / debit notes / payments, payroll, advances, scrap sales)
--   gl_month_end(): depreciation, gratuity & leave provisions
-- =====================================================================

create or replace function public.is_finance() returns boolean
language sql stable security definer set search_path = public as $$ select has_role('finance') $$;

create table gl_accounts (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null,
  acc_type    text not null check (acc_type in ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE')),
  parent_id   uuid references gl_accounts(id),
  is_group    boolean not null default false,
  system_key  text unique,                      -- used by automatic posting
  is_bank     boolean not null default false,
  is_active   boolean not null default true,
  sort_order  int not null default 0
);

insert into gl_accounts (code, name, acc_type, is_group, system_key, is_bank) values
 ('1000','ASSETS','ASSET',true,null,false),
 ('1100','Cash & bank','ASSET',true,null,false),
 ('1110','Cash in hand','ASSET',false,'CASH',false),
 ('1120','Bank — current account','ASSET',false,'BANK',true),
 ('1130','Cheques / PDC received','ASSET',false,'PDC_RECEIVED',false),
 ('1200','Receivables','ASSET',true,null,false),
 ('1210','Trade receivables','ASSET',false,'AR',false),
 ('1220','Retention receivable','ASSET',false,'RETENTION_AR',false),
 ('1230','Other receivables','ASSET',false,'OTHER_AR',false),
 ('1300','Inventory','ASSET',true,null,false),
 ('1310','Raw materials & consumables','ASSET',false,'INV_RM',false),
 ('1320','Work in progress','ASSET',false,'WIP',false),
 ('1330','Finished goods','ASSET',false,'INV_FG',false),
 ('1400','Advances & prepayments','ASSET',true,null,false),
 ('1410','Advances to suppliers','ASSET',false,'SUPPLIER_ADV',false),
 ('1420','Employee advances','ASSET',false,'EMP_ADV',false),
 ('1430','Prepayments & deposits','ASSET',false,null,false),
 ('1450','VAT recoverable (input)','ASSET',false,'VAT_IN',false),
 ('1500','Fixed assets','ASSET',true,null,false),
 ('1510','Plant & machinery','ASSET',false,'FA_MACHINERY',false),
 ('1520','Tools & equipment','ASSET',false,'FA_TOOLS',false),
 ('1530','Office equipment & furniture','ASSET',false,'FA_OFFICE',false),
 ('1540','Labour camp equipment','ASSET',false,'FA_CAMP',false),
 ('1590','Accumulated depreciation','ASSET',false,'ACC_DEP',false),
 ('2000','LIABILITIES','LIABILITY',true,null,false),
 ('2100','Trade payables','LIABILITY',false,'AP',false),
 ('2110','Goods / services received not invoiced','LIABILITY',false,'GRNI',false),
 ('2120','Accrued expenses','LIABILITY',false,'ACCRUED',false),
 ('2130','Salaries payable','LIABILITY',false,'SALARY_PAYABLE',false),
 ('2140','Customer advances','LIABILITY',false,'CUST_ADV',false),
 ('2150','PDC issued','LIABILITY',false,'PDC_ISSUED',false),
 ('2200','VAT payable (output)','LIABILITY',false,'VAT_OUT',false),
 ('2300','Provision — end of service gratuity','LIABILITY',false,'PROV_GRATUITY',false),
 ('2310','Provision — leave salary','LIABILITY',false,'PROV_LEAVE',false),
 ('3000','EQUITY','EQUITY',true,null,false),
 ('3100','Share capital','EQUITY',false,'CAPITAL',false),
 ('3200','Retained earnings','EQUITY',false,'RETAINED',false),
 ('3300','Opening balance equity','EQUITY',false,'OPENING',false),
 ('4000','INCOME','INCOME',true,null,false),
 ('4100','Contract revenue — projects','INCOME',false,'REV_CONTRACT',false),
 ('4200','Sales — products / MTS','INCOME',false,'REV_SALES',false),
 ('4300','Scrap sales','INCOME',false,'REV_SCRAP',false),
 ('4900','Other income (incl. salary deductions)','INCOME',false,'OTHER_INCOME',false),
 ('5000','COST OF SALES','EXPENSE',true,null,false),
 ('5100','Material consumed — projects & cost centres','EXPENSE',false,'MAT_CONSUMED',false),
 ('5110','Cost of goods delivered','EXPENSE',false,'COGS',false),
 ('5200','Direct labour — installation & rework','EXPENSE',false,'DIRECT_LABOUR',false),
 ('5300','Subcontract & installation services','EXPENSE',false,'SUBCONTRACT',false),
 ('5310','Transport & delivery','EXPENSE',false,'TRANSPORT',false),
 ('5400','Inventory adjustments & revaluation','EXPENSE',false,'INV_ADJ',false),
 ('5410','Scrap & production rejects written off','EXPENSE',false,'SCRAP_EXP',false),
 ('5500','Production labour & overhead absorbed (credit)','EXPENSE',false,'PROD_ABSORBED',false),
 ('6000','OPERATING EXPENSES','EXPENSE',true,null,false),
 ('6100','Salaries & allowances','EXPENSE',false,'SALARIES',false),
 ('6110','Overtime & bonuses','EXPENSE',false,'OVERTIME',false),
 ('6120','Gratuity expense','EXPENSE',false,'GRATUITY_EXP',false),
 ('6130','Leave salary expense','EXPENSE',false,'LEAVE_EXP',false),
 ('6190','Site labour absorbed to projects (credit)','EXPENSE',false,'LABOUR_ABSORBED',false),
 ('6200','Rent','EXPENSE',false,null,false),
 ('6300','Utilities','EXPENSE',false,null,false),
 ('6400','Depreciation','EXPENSE',false,'DEPRECIATION',false),
 ('6500','Bank charges','EXPENSE',false,'BANK_CHARGES',false),
 ('6900','Other expenses','EXPENSE',false,'OTHER_EXP',false);
update gl_accounts c set parent_id = coalesce(
    (select g.id from gl_accounts g where g.is_group and g.code = left(c.code, 2) || '00' and g.id <> c.id),
    (select g.id from gl_accounts g where g.is_group and g.code = left(c.code, 1) || '000' and g.id <> c.id))
 where c.code not like '_000';
update gl_accounts set sort_order = code::int;

-- account of each item class / category (inventory or capitalisation; services = expense)
alter table item_classes add column gl_account_id uuid references gl_accounts(id);
alter table item_categories add column gl_account_id uuid references gl_accounts(id);
update item_classes c set gl_account_id = a.id from gl_accounts a where a.system_key = case
  when c.code in ('RM','CON','PKG','SPR','SCR') then 'INV_RM' when c.code = 'FG' then 'INV_FG' when c.code = 'MAC' then 'FA_MACHINERY'
  when c.code in ('PWT','HNT','MST') then 'FA_TOOLS' when c.code = 'OFE' then 'FA_OFFICE' when c.code = 'LAE' then 'FA_CAMP' when c.code = 'SRV' then 'SUBCONTRACT' end;
update item_categories t set gl_account_id = a.id from gl_accounts a where a.system_key = 'TRANSPORT' and t.code = 'SRV-TRN';

create or replace function public.gl_acct(p_key text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v uuid;
begin
  select id into v from gl_accounts where system_key = p_key;
  if v is null then raise exception 'No ledger account is mapped to %', p_key; end if;
  return v;
end $$;
create or replace function public.gl_item_acct(p_item uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(t.gl_account_id, c.gl_account_id, gl_acct('INV_RM')) from items i join item_classes c on c.id = i.class_id
    left join item_categories t on t.id = i.category_id where i.id = p_item
$$;

-- ---------- periods ----------
create table gl_periods (
  period_month date primary key check (period_month = date_trunc('month', period_month)::date),
  status       text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
  closed_by    uuid references profiles(id), closed_at timestamptz,
  month_end_done boolean not null default false
);
-- documents dated in a closed month post on the first day of the next open month
create or replace function public.gl_open_date(p_date date) returns date
language sql stable security definer set search_path = public as $$
  select greatest(p_date, coalesce((select (max(period_month) + interval '1 month')::date from gl_periods where status = 'CLOSED'), p_date))
$$;

-- ---------- journals ----------
create table journal_entries (
  id          uuid primary key default gen_random_uuid(),
  je_no       text not null unique default next_doc_no('JV'),
  je_date     date not null default current_date,
  source      text not null default 'MANUAL',
  source_id   uuid,
  doc_no      text,
  narration   text,
  project_id  uuid references projects(id),
  status      text not null default 'DRAFT' check (status in ('DRAFT','POSTED','REVERSED')),
  total       numeric(16,2) not null default 0,
  reversal_of uuid references journal_entries(id),
  created_by  uuid default auth.uid() references profiles(id),
  created_at  timestamptz not null default now(),
  posted_by   uuid references profiles(id), posted_at timestamptz
);
create index journal_entries_date_idx on journal_entries(je_date);
create index journal_entries_source_idx on journal_entries(source, source_id);

create table journal_lines (
  id          uuid primary key default gen_random_uuid(),
  je_id       uuid not null references journal_entries(id) on delete cascade,
  line_no     int not null default 1,
  account_id  uuid not null references gl_accounts(id),
  debit       numeric(16,2) not null default 0 check (debit >= 0),
  credit      numeric(16,2) not null default 0 check (credit >= 0),
  project_id  uuid references projects(id),
  cost_center_id uuid references cost_centers(id),
  vendor_id   uuid references vendors(id),
  employee_id uuid references employees(id),
  customer_id uuid,                                 -- FK added with the customers table
  memo        text,
  reconciled  boolean not null default false,
  reconciled_on date,
  check (debit = 0 or credit = 0)
);
create index journal_lines_acct_idx on journal_lines(account_id);
create index journal_lines_je_idx on journal_lines(je_id);

-- create + post a balanced journal. p_lines: [{"acct": "<system key or account uuid>", "dr": n, "cr": n, "project_id", "cost_center_id", "vendor_id", "employee_id", "customer_id", "memo"}]
-- negative amounts are flipped to the other side; zero lines are dropped; a journal with no lines is not created
create or replace function public.gl_post(p_source text, p_source_id uuid, p_date date, p_doc_no text, p_narration text, p_project uuid, p_lines jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_je uuid; l jsonb; v_acct uuid; v_dr numeric; v_cr numeric; v_amt numeric; v_n int := 0; v_tdr numeric := 0; v_tcr numeric := 0;
begin
  if p_lines is null or jsonb_array_length(p_lines) = 0 then return null; end if;
  insert into journal_entries (je_date, source, source_id, doc_no, narration, project_id, status, posted_at)
  values (gl_open_date(p_date), p_source, p_source_id, p_doc_no, p_narration, p_project, 'POSTED', now()) returning id into v_je;
  for l in select * from jsonb_array_elements(p_lines) loop
    v_amt := round(coalesce((l->>'dr')::numeric, 0) - coalesce((l->>'cr')::numeric, 0), 2);
    continue when v_amt = 0;
    v_acct := case when (l->>'acct') ~ '^[0-9a-f-]{36}$' then (l->>'acct')::uuid else gl_acct(l->>'acct') end;
    v_dr := greatest(v_amt, 0); v_cr := greatest(-v_amt, 0);
    v_n := v_n + 1;
    insert into journal_lines (je_id, line_no, account_id, debit, credit, project_id, cost_center_id, vendor_id, employee_id, customer_id, memo)
    values (v_je, v_n, v_acct, v_dr, v_cr, nullif(l->>'project_id', '')::uuid, nullif(l->>'cost_center_id', '')::uuid, nullif(l->>'vendor_id', '')::uuid,
            nullif(l->>'employee_id', '')::uuid, nullif(l->>'customer_id', '')::uuid, l->>'memo');
    v_tdr := v_tdr + v_dr; v_tcr := v_tcr + v_cr;
  end loop;
  if v_n = 0 then delete from journal_entries where id = v_je; return null; end if;
  if abs(v_tdr - v_tcr) > 0.02 then raise exception 'Journal for % % does not balance (Dr % / Cr %)', p_source, p_doc_no, v_tdr, v_tcr; end if;
  if v_tdr <> v_tcr then   -- absorb rounding (max 2 fils) on the largest line
    update journal_lines set debit = debit + (v_tcr - v_tdr) where id = (select id from journal_lines where je_id = v_je and debit > 0 order by debit desc limit 1);
  end if;
  update journal_entries set total = greatest(v_tdr, v_tcr) where id = v_je;
  return v_je;
end $$;
revoke execute on function public.gl_post(text, uuid, date, text, text, uuid, jsonb) from public, anon, authenticated;

-- ---------- "already posted" markers on source documents ----------
alter table stock_ledger      add column gl_je_id uuid references journal_entries(id);
alter table wo_time_logs      add column gl_je_id uuid references journal_entries(id);
alter table wo_receipts       add column gl_je_id uuid references journal_entries(id);
alter table project_costs     add column gl_je_id uuid references journal_entries(id);
alter table vendor_invoices   add column gl_je_id uuid references journal_entries(id);
alter table vendor_debit_notes add column gl_je_id uuid references journal_entries(id);
alter table vendor_payments   add column gl_je_id uuid references journal_entries(id), add column gl_bounce_je_id uuid references journal_entries(id);
alter table scrap_disposals   add column gl_je_id uuid references journal_entries(id);
alter table employee_advances add column gl_je_id uuid references journal_entries(id);
alter table payroll_runs      add column gl_je_id uuid references journal_entries(id), add column gl_paid_je_id uuid references journal_entries(id);
create index stock_ledger_unposted on stock_ledger(doc_id) where gl_je_id is null;

-- counter account of a stock movement (the inventory side is the item's class account)
create or replace function public.gl_stock_counter(p_txn text, p_wo uuid) returns text
language sql immutable as $$
  select case p_txn
    when 'GRN' then 'GRNI' when 'PURCHASE_RETURN' then 'GRNI'
    when 'ISSUE' then case when p_wo is not null then 'WIP' else 'MAT_CONSUMED' end
    when 'RETURN' then case when p_wo is not null then 'WIP' else 'MAT_CONSUMED' end
    when 'ADJ_IN' then 'INV_ADJ' when 'ADJ_OUT' then 'INV_ADJ' when 'REVALUATION' then 'INV_ADJ'
    when 'SCRAP_WRITE_OFF' then 'SCRAP_EXP' when 'PROD_RECEIPT' then 'WIP' when 'DISPATCH' then 'COGS'
    else null end      -- transfers, releases, scrap in / disposal: no value change
$$;

create or replace function public.gl_sync() returns int
language plpgsql security definer set search_path = public as $$
declare d record; r record; v_je uuid; v_lines jsonb; n int := 0; s company_settings%rowtype; v_amt numeric; v_acct text;
begin
  if not (has_role('finance') or current_user in ('postgres','supabase_admin') or auth.uid() is null) then raise exception 'Finance runs the ledger sync'; end if;
  select * into s from company_settings where id = 1;

  -- 1. stock movements, one journal per document and date
  for d in select doc_type, doc_id, doc_no, txn_date, min(project_id::text)::uuid project_id from stock_ledger
            where gl_je_id is null and value <> 0 and gl_stock_counter(txn_type, production_order_id) is not null
            group by doc_type, doc_id, doc_no, txn_date order by txn_date loop
    select jsonb_agg(x) into v_lines from (
      select jsonb_build_object('acct', gl_item_acct(item_id)::text, 'dr', sum(value), 'project_id', project_id, 'cost_center_id', cost_center_id) x
        from stock_ledger where doc_type = d.doc_type and doc_id = d.doc_id and txn_date = d.txn_date and gl_je_id is null and gl_stock_counter(txn_type, production_order_id) is not null
       group by gl_item_acct(item_id), project_id, cost_center_id
      union all
      select jsonb_build_object('acct', gl_stock_counter(txn_type, production_order_id), 'cr', sum(value), 'project_id', project_id, 'cost_center_id', cost_center_id)
        from stock_ledger where doc_type = d.doc_type and doc_id = d.doc_id and txn_date = d.txn_date and gl_je_id is null and gl_stock_counter(txn_type, production_order_id) is not null
       group by gl_stock_counter(txn_type, production_order_id), project_id, cost_center_id) q;
    v_je := gl_post('STOCK:' || d.doc_type, d.doc_id, d.txn_date, d.doc_no, 'Stock ' || lower(d.doc_type) || ' ' || coalesce(d.doc_no, ''), d.project_id, v_lines);
    update stock_ledger set gl_je_id = coalesce(v_je, gl_je_id) where doc_type = d.doc_type and doc_id = d.doc_id and txn_date = d.txn_date and gl_je_id is null;
    if v_je is not null then n := n + 1; end if;
  end loop;

  -- 2. production labour, machine & overhead absorbed into WIP (per stage log)
  for r in select t.*, h.wo_no, h.project_id from wo_time_logs t join production_orders h on h.id = t.wo_id where t.gl_je_id is null loop
    v_amt := round((r.labour_hours * r.labour_rate + r.machine_hours * r.machine_rate) * (1 + s.overhead_pct / 100), 2);
    v_je := gl_post('WO_LOG', r.id, r.log_date, r.wo_no, 'Labour, machine & overhead absorbed — ' || r.wo_no, r.project_id,
      jsonb_build_array(jsonb_build_object('acct', 'WIP', 'dr', v_amt, 'project_id', r.project_id), jsonb_build_object('acct', 'PROD_ABSORBED', 'cr', v_amt, 'project_id', r.project_id)));
    update wo_time_logs set gl_je_id = v_je where id = r.id;
    if v_je is not null then n := n + 1; end if;
  end loop;

  -- 3. QC scrap written off from WIP (after FM decision, or immediately when no rejects)
  for r in select x.*, h.wo_no, h.project_id from wo_receipts x join production_orders h on h.id = x.wo_id
            where x.gl_je_id is null and x.qc_status in ('NONE','APPROVED') and x.scrap_value > 0 loop
    v_je := gl_post('WO_SCRAP', r.id, r.receipt_date, r.receipt_no, 'Production rejects scrapped — ' || r.wo_no, r.project_id,
      jsonb_build_array(jsonb_build_object('acct', 'SCRAP_EXP', 'dr', r.scrap_value, 'project_id', r.project_id), jsonb_build_object('acct', 'WIP', 'cr', r.scrap_value, 'project_id', r.project_id)));
    update wo_receipts set gl_je_id = v_je where id = r.id;
    if v_je is not null then n := n + 1; end if;
  end loop;

  -- 4. services received (work-done certificates) and site labour absorbed to projects
  for r in select c.*, coalesce(gl_item_acct(c.item_id), gl_acct('SUBCONTRACT')) svc_acct from project_costs c where c.gl_je_id is null and c.source in ('SERVICE_GRN','INSTALL_LABOUR','SNAG_LABOUR') loop
    v_lines := case when r.source = 'SERVICE_GRN' then
        jsonb_build_array(jsonb_build_object('acct', r.svc_acct::text, 'dr', r.amount, 'project_id', r.project_id), jsonb_build_object('acct', 'GRNI', 'cr', r.amount, 'project_id', r.project_id))
      else jsonb_build_array(jsonb_build_object('acct', 'DIRECT_LABOUR', 'dr', r.amount, 'project_id', r.project_id), jsonb_build_object('acct', 'LABOUR_ABSORBED', 'cr', r.amount, 'project_id', r.project_id)) end;
    v_je := gl_post('PROJECT_COST', r.id, r.cost_date, r.doc_no, coalesce(r.description, r.source), r.project_id, v_lines);
    update project_costs set gl_je_id = v_je where id = r.id;
    if v_je is not null then n := n + 1; end if;
  end loop;

  -- 5. supplier invoices: clear GRNI (or expense non-GRN lines), VAT input, credit the supplier
  for r in select * from vendor_invoices where status = 'POSTED' and gl_je_id is null loop
    select jsonb_agg(x) into v_lines from (
      select jsonb_build_object('acct', case when l.grn_line_id is not null or l.grn_charge_id is not null then gl_acct('GRNI')::text
                                             when l.item_id is not null then gl_item_acct(l.item_id)::text else gl_acct('OTHER_EXP')::text end,
                                'dr', round(l.amount * r.exchange_rate, 2), 'vendor_id', r.vendor_id, 'memo', l.description) x
        from vendor_invoice_lines l where l.invoice_id = r.id
      union all select jsonb_build_object('acct', 'VAT_IN', 'dr', round(r.vat_amount * r.exchange_rate, 2), 'vendor_id', r.vendor_id)
      union all select jsonb_build_object('acct', 'AP', 'cr', (select sum(round(l.amount * r.exchange_rate, 2)) from vendor_invoice_lines l where l.invoice_id = r.id) + round(r.vat_amount * r.exchange_rate, 2),
                                          'vendor_id', r.vendor_id)) q;
    v_je := gl_post('AP_INVOICE', r.id, r.invoice_date, r.inv_no, 'Supplier invoice ' || coalesce(r.vendor_invoice_no, '') || ' — ' || (select name from vendors where id = r.vendor_id), null, v_lines);
    update vendor_invoices set gl_je_id = v_je where id = r.id;
    if v_je is not null then n := n + 1; end if;
  end loop;

  -- 6. debit notes: debit the supplier, credit GRNI (returns / over-billing claims) and VAT input
  for r in select * from vendor_debit_notes where status = 'POSTED' and gl_je_id is null loop
    v_je := gl_post('AP_DEBIT_NOTE', r.id, r.dn_date, r.dn_no, 'Debit note — ' || (select name from vendors where id = r.vendor_id), null, jsonb_build_array(
      jsonb_build_object('acct', 'AP', 'dr', r.total_aed, 'vendor_id', r.vendor_id), jsonb_build_object('acct', 'GRNI', 'cr', r.amount_aed, 'vendor_id', r.vendor_id),
      jsonb_build_object('acct', 'VAT_IN', 'cr', r.vat_amount, 'vendor_id', r.vendor_id)));
    update vendor_debit_notes set gl_je_id = v_je where id = r.id;
    if v_je is not null then n := n + 1; end if;
  end loop;

  -- 7. supplier payments (and bounced cheques)
  for r in select * from vendor_payments where status in ('POSTED','BOUNCED') and gl_je_id is null loop
    v_acct := case r.mode when 'CASH' then 'CASH' when 'PDC' then 'PDC_ISSUED' else 'BANK' end;
    v_je := gl_post('AP_PAYMENT', r.id, r.payment_date, r.payment_no, 'Payment to ' || (select name from vendors where id = r.vendor_id) || coalesce(' · ' || r.reference_no, ''), null,
      jsonb_build_array(jsonb_build_object('acct', 'AP', 'dr', r.amount_aed, 'vendor_id', r.vendor_id), jsonb_build_object('acct', v_acct, 'cr', r.amount_aed, 'vendor_id', r.vendor_id)));
    update vendor_payments set gl_je_id = v_je where id = r.id;
    if v_je is not null then n := n + 1; end if;
  end loop;
  for r in select * from vendor_payments where status = 'BOUNCED' and gl_je_id is not null and gl_bounce_je_id is null loop
    v_acct := case r.mode when 'CASH' then 'CASH' when 'PDC' then 'PDC_ISSUED' else 'BANK' end;
    v_je := gl_post('AP_PAYMENT_BOUNCE', r.id, current_date, r.payment_no, 'Cheque returned — ' || r.payment_no, null,
      jsonb_build_array(jsonb_build_object('acct', v_acct, 'dr', r.amount_aed, 'vendor_id', r.vendor_id), jsonb_build_object('acct', 'AP', 'cr', r.amount_aed, 'vendor_id', r.vendor_id)));
    update vendor_payments set gl_bounce_je_id = v_je where id = r.id;
    if v_je is not null then n := n + 1; end if;
  end loop;

  -- 8. scrap sales
  for r in select * from scrap_disposals where status = 'POSTED' and gl_je_id is null and coalesce(total_amount, 0) > 0 loop
    v_je := gl_post('SCRAP_SALE', r.id, r.disposal_date, r.disposal_no, 'Scrap sale — ' || coalesce(r.buyer_name, ''), null, jsonb_build_array(
      jsonb_build_object('acct', case when r.payment_received then 'CASH' else 'OTHER_AR' end, 'dr', r.total_amount),
      jsonb_build_object('acct', 'REV_SCRAP', 'cr', r.subtotal), jsonb_build_object('acct', 'VAT_OUT', 'cr', r.vat_amount)));
    update scrap_disposals set gl_je_id = v_je where id = r.id;
    if v_je is not null then n := n + 1; end if;
  end loop;

  -- 9. employee advances paid
  for r in select * from employee_advances where status in ('APPROVED','CLOSED') and gl_je_id is null loop
    v_je := gl_post('EMP_ADVANCE', r.id, coalesce(r.approved_at::date, r.adv_date), r.adv_no, 'Salary advance — ' || (select name from employees where id = r.employee_id), null,
      jsonb_build_array(jsonb_build_object('acct', 'EMP_ADV', 'dr', r.amount, 'employee_id', r.employee_id), jsonb_build_object('acct', 'BANK', 'cr', r.amount, 'employee_id', r.employee_id)));
    update employee_advances set gl_je_id = v_je where id = r.id;
    if v_je is not null then n := n + 1; end if;
  end loop;

  -- 10. payroll: accrue on approval, pay on payment
  for r in select * from payroll_runs where status in ('APPROVED','PAID') and gl_je_id is null loop
    select jsonb_build_array(
      jsonb_build_object('acct', 'SALARIES', 'dr', sum(fixed_earned - unpaid_deduction)), jsonb_build_object('acct', 'OVERTIME', 'dr', sum(ot_amount + additions)),
      jsonb_build_object('acct', 'SALARY_PAYABLE', 'cr', sum(net)), jsonb_build_object('acct', 'EMP_ADV', 'cr', sum(advance_recovery)),
      jsonb_build_object('acct', 'OTHER_INCOME', 'cr', sum(other_deductions))) into v_lines from payroll_lines where run_id = r.id;
    v_je := gl_post('PAYROLL', r.id, (r.period_month + interval '1 month - 1 day')::date, r.run_no, 'Payroll ' || to_char(r.period_month, 'Mon YYYY'), null, v_lines);
    update payroll_runs set gl_je_id = v_je where id = r.id;
    if v_je is not null then n := n + 1; end if;
  end loop;
  for r in select * from payroll_runs where status = 'PAID' and gl_je_id is not null and gl_paid_je_id is null loop
    v_je := gl_post('PAYROLL_PAID', r.id, coalesce(r.paid_at::date, current_date), r.run_no, 'Salaries paid ' || to_char(r.period_month, 'Mon YYYY') || coalesce(' · ' || r.payment_ref, ''), null,
      jsonb_build_array(jsonb_build_object('acct', 'SALARY_PAYABLE', 'dr', r.total_net), jsonb_build_object('acct', 'BANK', 'cr', r.total_net)));
    update payroll_runs set gl_paid_je_id = v_je where id = r.id;
    if v_je is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- month end: depreciation (straight line on asset useful life) + gratuity / leave provision true-up
alter table item_classes add column useful_life_years numeric(5,2);
update item_classes set useful_life_years = case code when 'MAC' then 10 when 'PWT' then 3 when 'HNT' then 2 when 'MST' then 3 when 'OFE' then 5 when 'LAE' then 5 end
 where valuation_method = 'ASSET';

create or replace function public.gl_month_end(p_month date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m date := date_trunc('month', p_month)::date; e date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_dep numeric := 0; v_grat numeric; v_leave numeric; v_bal numeric; v_je uuid; r record; v_lines jsonb := '[]'::jsonb;
begin
  if not has_role('finance') then raise exception 'Finance runs month end'; end if;
  if exists (select 1 from gl_periods where period_month = m and status = 'CLOSED') then raise exception 'The month is closed'; end if;
  if exists (select 1 from journal_entries where source = 'MONTH_END' and je_date = e and status = 'POSTED') then raise exception 'Month end already run for %', to_char(m, 'Mon YYYY'); end if;
  -- depreciation per asset class
  for r in select c.gl_account_id fa_acct, sum(round(a.purchase_cost / (coalesce(a.useful_life_years, c.useful_life_years, 5) * 12), 2)) dep
             from assets a join items i on i.id = a.item_id join item_classes c on c.id = i.class_id
            where a.purchase_date <= e and a.status not in ('SCRAPPED','LOST','DISPOSED') and coalesce(a.purchase_cost, 0) > 0
              and a.purchase_date > e - make_interval(months => (coalesce(a.useful_life_years, c.useful_life_years, 5) * 12)::int)
            group by c.gl_account_id loop
    v_dep := v_dep + r.dep;
  end loop;
  if v_dep > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_object('acct', 'DEPRECIATION', 'dr', v_dep, 'memo', 'Depreciation'), jsonb_build_object('acct', 'ACC_DEP', 'cr', v_dep)); end if;
  -- provisions: bring the balance to the calculated liability
  select coalesce(sum(gratuity_provision), 0), coalesce(sum(leave_provision), 0) into v_grat, v_leave from v_gratuity_provision;
  select coalesce(sum(credit - debit), 0) into v_bal from journal_lines l join journal_entries j on j.id = l.je_id where j.status = 'POSTED' and l.account_id = gl_acct('PROV_GRATUITY');
  if round(v_grat - v_bal, 2) <> 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_object('acct', 'GRATUITY_EXP', 'dr', v_grat - v_bal, 'memo', 'Gratuity provision'), jsonb_build_object('acct', 'PROV_GRATUITY', 'cr', v_grat - v_bal)); end if;
  select coalesce(sum(credit - debit), 0) into v_bal from journal_lines l join journal_entries j on j.id = l.je_id where j.status = 'POSTED' and l.account_id = gl_acct('PROV_LEAVE');
  if round(v_leave - v_bal, 2) <> 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_object('acct', 'LEAVE_EXP', 'dr', v_leave - v_bal, 'memo', 'Leave salary provision'), jsonb_build_object('acct', 'PROV_LEAVE', 'cr', v_leave - v_bal)); end if;
  v_je := gl_post('MONTH_END', null, e, to_char(m, 'YYYY-MM'), 'Month end ' || to_char(m, 'Mon YYYY') || ': depreciation & provisions', null, v_lines);
  insert into gl_periods (period_month, month_end_done) values (m, true) on conflict (period_month) do update set month_end_done = true;
  return jsonb_build_object('journal', v_je, 'depreciation', v_dep, 'gratuity_provision', v_grat, 'leave_provision', v_leave);
end $$;

create or replace function public.gl_close_period(p_month date, p_close boolean) returns void
language plpgsql security definer set search_path = public as $$
declare m date := date_trunc('month', p_month)::date;
begin
  if not has_role('finance') then raise exception 'Finance closes periods'; end if;
  if p_close then
    perform gl_sync();
    insert into gl_periods (period_month, status, closed_by, closed_at) values (m, 'CLOSED', auth.uid(), now())
    on conflict (period_month) do update set status = 'CLOSED', closed_by = auth.uid(), closed_at = now();
  else
    if exists (select 1 from gl_periods where period_month > m and status = 'CLOSED') then raise exception 'Reopen the later months first'; end if;
    update gl_periods set status = 'OPEN', closed_by = null, closed_at = null where period_month = m;
  end if;
end $$;

-- manual journal: post / reverse
create or replace function public.jv_action(p_je uuid, p_action text) returns text
language plpgsql security definer set search_path = public as $$
declare j journal_entries%rowtype; v_dr numeric; v_cr numeric; v_new uuid;
begin
  if not has_role('finance') then raise exception 'Finance posts journals'; end if;
  select * into j from journal_entries where id = p_je for update;
  if p_action = 'POST' then
    if j.status <> 'DRAFT' then raise exception 'Journal is %', j.status; end if;
    if exists (select 1 from gl_periods where period_month = date_trunc('month', j.je_date)::date and status = 'CLOSED') then raise exception 'The month of % is closed', j.je_date; end if;
    select coalesce(sum(debit), 0), coalesce(sum(credit), 0) into v_dr, v_cr from journal_lines where je_id = p_je;
    if v_dr = 0 then raise exception 'Enter the journal lines'; end if;
    if v_dr <> v_cr then raise exception 'Debits (%) and credits (%) must be equal', v_dr, v_cr; end if;
    if exists (select 1 from journal_lines l join gl_accounts a on a.id = l.account_id where l.je_id = p_je and a.is_group) then raise exception 'Post to detail accounts, not group headings'; end if;
    update journal_entries set status = 'POSTED', total = v_dr, posted_by = auth.uid(), posted_at = now() where id = p_je;
    return 'POSTED';
  elsif p_action = 'REVERSE' then
    if j.status <> 'POSTED' then raise exception 'Only posted journals can be reversed'; end if;
    insert into journal_entries (je_date, source, source_id, doc_no, narration, project_id, status, total, reversal_of, posted_by, posted_at)
    values (gl_open_date(current_date), 'REVERSAL', j.id, j.je_no, 'Reversal of ' || j.je_no || coalesce(' — ' || j.narration, ''), j.project_id, 'POSTED', j.total, j.id, auth.uid(), now())
    returning id into v_new;
    insert into journal_lines (je_id, line_no, account_id, debit, credit, project_id, cost_center_id, vendor_id, employee_id, customer_id, memo)
    select v_new, line_no, account_id, credit, debit, project_id, cost_center_id, vendor_id, employee_id, customer_id, memo from journal_lines where je_id = p_je;
    update journal_entries set status = 'REVERSED' where id = p_je;
    return 'REVERSED';
  end if;
  raise exception 'Unknown action %', p_action;
end $$;

-- ---------- reporting functions ----------
create or replace function public.gl_trial_balance(p_from date, p_to date) returns table (account_id uuid, code text, name text, acc_type text,
  opening numeric, debit numeric, credit numeric, closing numeric)
language sql stable security definer set search_path = public as $$
  select a.id, a.code, a.name, a.acc_type,
         coalesce(sum(l.debit - l.credit) filter (where j.je_date < p_from), 0),
         coalesce(sum(l.debit) filter (where j.je_date between p_from and p_to), 0),
         coalesce(sum(l.credit) filter (where j.je_date between p_from and p_to), 0),
         coalesce(sum(l.debit - l.credit) filter (where j.je_date <= p_to), 0)
    from gl_accounts a left join journal_lines l on l.account_id = a.id
    left join journal_entries j on j.id = l.je_id and j.status in ('POSTED','REVERSED')
   where not a.is_group and (has_role('finance','factory_manager'))
   group by a.id having coalesce(sum(abs(l.debit) + abs(l.credit)) filter (where j.je_date <= p_to), 0) <> 0
   order by a.code
$$;

create or replace function public.gl_ledger(p_account uuid, p_from date, p_to date, p_project uuid default null) returns table (je_id uuid, je_no text, je_date date, source text,
  doc_no text, narration text, memo text, debit numeric, credit numeric, balance numeric, line_id uuid, reconciled boolean, project_code text)
language sql stable security definer set search_path = public as $$
  with o as (select coalesce(sum(l.debit - l.credit), 0) ob from journal_lines l join journal_entries j on j.id = l.je_id
              where l.account_id = p_account and j.status in ('POSTED','REVERSED') and j.je_date < p_from and (p_project is null or l.project_id = p_project))
  select null::uuid, null, p_from - 1, 'OPENING', null, 'Opening balance', null, null::numeric, null::numeric, (select ob from o), null::uuid, null::boolean, null
   where has_role('finance','factory_manager')
  union all
  select * from (
    select j.id, j.je_no, j.je_date, j.source, j.doc_no, j.narration, l.memo, l.debit, l.credit,
           (select ob from o) + sum(l.debit - l.credit) over (order by j.je_date, j.created_at, l.line_no rows unbounded preceding), l.id, l.reconciled, p.code
      from journal_lines l join journal_entries j on j.id = l.je_id left join projects p on p.id = l.project_id
     where l.account_id = p_account and j.status in ('POSTED','REVERSED') and j.je_date between p_from and p_to and (p_project is null or l.project_id = p_project)
       and has_role('finance','factory_manager')
     order by j.je_date, j.created_at, l.line_no) x
$$;

-- ---------- RLS ----------
alter table gl_accounts enable row level security;
alter table gl_periods enable row level security;
alter table journal_entries enable row level security;
alter table journal_lines enable row level security;
create policy read_active on gl_accounts for select to authenticated using (public.is_active_user());
create policy fin_write on gl_accounts for all to authenticated using (public.is_finance()) with check (public.is_finance());
create policy fin_read on gl_periods for select to authenticated using (public.has_role('finance','factory_manager'));
create policy fin_read on journal_entries for select to authenticated using (public.has_role('finance','factory_manager'));
create policy jv_insert on journal_entries for insert to authenticated with check (public.is_finance() and status = 'DRAFT' and source = 'MANUAL');
create policy jv_update on journal_entries for update to authenticated using (public.is_finance() and status = 'DRAFT') with check (status = 'DRAFT');
create policy jv_delete on journal_entries for delete to authenticated using (public.is_finance() and status = 'DRAFT');
create policy fin_read on journal_lines for select to authenticated using (public.has_role('finance','factory_manager'));
create policy jv_lines on journal_lines for all to authenticated
  using (public.is_finance() and exists (select 1 from journal_entries j where j.id = journal_lines.je_id and j.status = 'DRAFT'))
  with check (public.is_finance() and exists (select 1 from journal_entries j where j.id = journal_lines.je_id and j.status = 'DRAFT'));
-- bank reconciliation ticks on posted lines
create or replace function public.gl_reconcile(p_lines uuid[], p_reconciled boolean, p_date date default current_date) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not has_role('finance') then raise exception 'Finance reconciles bank accounts'; end if;
  update journal_lines set reconciled = p_reconciled, reconciled_on = case when p_reconciled then p_date end
   where id = any(p_lines) and account_id in (select id from gl_accounts where is_bank or system_key in ('CASH','PDC_RECEIVED','PDC_ISSUED'));
  get diagnostics n = row_count;
  return n;
end $$;

-- automatic posting every 15 minutes (documents also post when Finance presses "Post now")
select cron.schedule('gl-sync', '*/15 * * * *', $c$ select public.gl_sync() $c$);

grant execute on function public.gl_sync(), public.gl_month_end(date), public.gl_close_period(date, boolean), public.jv_action(uuid, text),
  public.gl_trial_balance(date, date), public.gl_ledger(uuid, date, date, uuid), public.gl_reconcile(uuid[], boolean, date), public.is_finance() to authenticated;
revoke execute on function public.gl_sync(), public.gl_month_end(date), public.gl_close_period(date, boolean), public.jv_action(uuid, text),
  public.gl_trial_balance(date, date), public.gl_ledger(uuid, date, date, uuid), public.gl_reconcile(uuid[], boolean, date), public.is_finance() from anon;
revoke execute on function public.gl_acct(text), public.gl_item_acct(uuid), public.gl_open_date(date) from anon;
