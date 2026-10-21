-- 049 Provisions & accruals — each automation is OFF until Finance switches it on.
-- Finance can run any of them for a month by hand (preview → post); with "Automate" ticked it also runs at month end.
-- * Accruals: month-end accrued expenses that reverse themselves on day 1 of the next month (suggested from recurring bills).
-- * Prepayments: a prepaid bill is spread over months (expense lines can say "spread over N months"); monthly release.
-- * True-up provisions (target balance vs current balance, like gratuity): doubtful debts (by age band), slow-moving
--   stock (by lot age), warranty / defects (% of contract revenue in the defects period less snag rework),
--   contract work done not yet billed (accrued revenue).

-- ---------- accounts ----------
insert into gl_accounts (code, name, acc_type, system_key) values
 ('1215','Allowance for doubtful debts','ASSET','ALLOW_DOUBTFUL'),
 ('1225','Contract work done, not yet billed','ASSET','ACCRUED_REV'),
 ('1315','Provision for slow-moving stock','ASSET','PROV_STOCK'),
 ('2320','Provision — warranty / defects liability','LIABILITY','PROV_WARRANTY'),
 ('5420','Slow-moving stock provision','EXPENSE','STOCK_PROV_EXP'),
 ('5430','Warranty / defects provision','EXPENSE','WARRANTY_EXP'),
 ('6910','Bad & doubtful debts','EXPENSE','BAD_DEBTS')
on conflict (code) do nothing;
update gl_accounts set system_key = 'PREPAID' where code = '1430' and system_key is null;
update gl_accounts c set parent_id = coalesce(
    (select g.id from gl_accounts g where g.is_group and g.code = left(c.code, 2) || '00' and g.id <> c.id),
    (select g.id from gl_accounts g where g.is_group and g.code = left(c.code, 1) || '000' and g.id <> c.id))
 where c.parent_id is null and c.code not like '_000';

-- balance of an account up to a date (debit − credit)
create or replace function public.gl_balance(p_acct uuid, p_to date) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(l.debit - l.credit), 0) from journal_lines l join journal_entries j on j.id = l.je_id
   where l.account_id = p_acct and j.status in ('POSTED','REVERSED') and j.je_date <= p_to
$$;

-- ---------- switches & parameters (Finance) ----------
create table provision_settings (
  key         text primary key check (key in ('ACCRUALS','PREPAYMENTS','DOUBTFUL','SLOW_STOCK','WARRANTY','ACCRUED_REVENUE')),
  automate    boolean not null default false,
  params      jsonb not null default '{}'::jsonb,
  updated_by  uuid references profiles(id),
  updated_at  timestamptz not null default now()
);
insert into provision_settings (key, params) values
 ('ACCRUALS', '{}'),
 ('PREPAYMENTS', '{}'),
 ('DOUBTFUL', '{"bands":[{"from":0,"pct":0},{"from":31,"pct":0},{"from":61,"pct":5},{"from":91,"pct":25},{"from":181,"pct":50},{"from":366,"pct":100}]}'),
 ('SLOW_STOCK', '{"bands":[{"from":0,"pct":0},{"from":181,"pct":10},{"from":366,"pct":50},{"from":731,"pct":100}]}'),
 ('WARRANTY', '{"pct":1,"months":12}'),
 ('ACCRUED_REVENUE', '{"pct":100}');

create table provision_runs (
  id          uuid primary key default gen_random_uuid(),
  key         text not null,
  period_month date not null,
  target      numeric(16,2),
  before      numeric(16,2),
  adjustment  numeric(16,2),
  je_id       uuid references journal_entries(id),
  detail      jsonb,
  run_by      uuid default auth.uid() references profiles(id),
  run_at      timestamptz not null default now(),
  automatic   boolean not null default false
);
create index provision_runs_key_idx on provision_runs(key, period_month);

-- band % for an age in days: the last band whose "from" is ≤ days
create or replace function public.prov_band_pct(p_bands jsonb, p_days int) returns numeric
language sql immutable as $$
  select coalesce((select (b->>'pct')::numeric from jsonb_array_elements(p_bands) b where (b->>'from')::int <= greatest(p_days, 0) order by (b->>'from')::int desc limit 1), 0)
$$;

-- target / current / adjustment for one true-up provision at a month end (nothing is posted)
create or replace function public.provision_calc(p_key text, p_month date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m date := date_trunc('month', p_month)::date; e date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  s provision_settings%rowtype; v_target numeric := 0; v_cur numeric := 0; v_detail jsonb := '[]'; v_rev numeric; v_snag numeric;
begin
  if not has_role('finance','factory_manager') then raise exception 'Finance runs provisions'; end if;
  select * into s from provision_settings where key = p_key;
  if p_key = 'DOUBTFUL' then
    -- open receivables by days overdue
    select coalesce(sum(round(b.balance * prov_band_pct(s.params->'bands', b.days_overdue) / 100, 2)), 0),
           coalesce(jsonb_agg(jsonb_build_object('label', b.customer_name, 'basis', b.balance, 'pct', prov_band_pct(s.params->'bands', b.days_overdue),
             'amount', round(b.balance * prov_band_pct(s.params->'bands', b.days_overdue) / 100, 2), 'note', b.inv_no || ' · ' || b.days_overdue || ' days overdue')
             order by b.days_overdue desc) filter (where prov_band_pct(s.params->'bands', b.days_overdue) > 0), '[]')
      into v_target, v_detail from v_sales_invoice_balance b where b.balance > 0;
    v_cur := -gl_balance(gl_acct('ALLOW_DOUBTFUL'), e);
  elsif p_key = 'SLOW_STOCK' then
    -- stock value by lot age (offcut pieces included at their value)
    select coalesce(sum(round(v.value * prov_band_pct(s.params->'bands', v.age_days) / 100, 2)), 0),
           coalesce(jsonb_agg(jsonb_build_object('label', v.item_code || ' — ' || v.item_name, 'basis', v.value, 'pct', prov_band_pct(s.params->'bands', v.age_days),
             'amount', round(v.value * prov_band_pct(s.params->'bands', v.age_days) / 100, 2), 'note', 'lot ' || v.lot_no || ' · ' || v.age_days || ' days old')
             order by v.age_days desc) filter (where prov_band_pct(s.params->'bands', v.age_days) > 0), '[]')
      into v_target, v_detail from v_lot_values v where v.valuation_method <> 'ASSET' and v.value > 0;
    v_cur := -gl_balance(gl_acct('PROV_STOCK'), e);
  elsif p_key = 'WARRANTY' then
    -- % of contract revenue recognised within the defects period, less snag rework already spent in that window
    select coalesce(sum(l.credit - l.debit), 0) into v_rev from journal_lines l join journal_entries j on j.id = l.je_id
     where l.account_id = gl_acct('REV_CONTRACT') and j.status in ('POSTED','REVERSED') and j.je_date > (e - make_interval(months => coalesce((s.params->>'months')::int, 12))) and j.je_date <= e;
    select coalesce(sum(c.amount), 0) into v_snag from project_costs c
     where c.source = 'SNAG_LABOUR' and c.cost_date > (e - make_interval(months => coalesce((s.params->>'months')::int, 12))) and c.cost_date <= e;
    v_snag := v_snag + coalesce((select sum(i.total_value) from material_issues i where i.snag_id is not null and i.status = 'POSTED'
      and i.issue_date > (e - make_interval(months => coalesce((s.params->>'months')::int, 12))) and i.issue_date <= e), 0);
    v_target := greatest(round(v_rev * coalesce((s.params->>'pct')::numeric, 0) / 100 - v_snag, 2), 0);
    v_detail := jsonb_build_array(jsonb_build_object('label', 'Contract revenue in the defects period (' || coalesce(s.params->>'months', '12') || ' months)', 'basis', v_rev, 'pct', (s.params->>'pct')::numeric,
                  'amount', round(v_rev * coalesce((s.params->>'pct')::numeric, 0) / 100, 2)),
                jsonb_build_object('label', 'Less snag rework already spent in the period', 'basis', v_snag, 'amount', -v_snag));
    v_cur := -gl_balance(gl_acct('PROV_WARRANTY'), e);
  elsif p_key = 'ACCRUED_REVENUE' then
    -- site progress earned but not yet certified on claims
    select coalesce(sum(round(greatest(b.earned_value - b.certified_to_date, 0) * coalesce((s.params->>'pct')::numeric, 100) / 100, 2)), 0),
           coalesce(jsonb_agg(jsonb_build_object('label', b.project_code || ' — ' || b.project_name, 'basis', greatest(b.earned_value - b.certified_to_date, 0),
             'pct', coalesce((s.params->>'pct')::numeric, 100), 'amount', round(greatest(b.earned_value - b.certified_to_date, 0) * coalesce((s.params->>'pct')::numeric, 100) / 100, 2),
             'note', 'earned ' || b.earned_value || ' · certified ' || b.certified_to_date)) filter (where b.earned_value > b.certified_to_date), '[]')
      into v_target, v_detail from v_project_billing b;
    v_cur := gl_balance(gl_acct('ACCRUED_REV'), e);
  else
    raise exception 'Unknown provision %', p_key;
  end if;
  return jsonb_build_object('key', p_key, 'month', m, 'target', v_target, 'current', v_cur, 'adjustment', round(v_target - v_cur, 2), 'detail', v_detail);
end $$;

-- post the true-up for a month end (posts only the difference, so re-running is safe)
create or replace function public.provision_post(p_key text, p_month date, p_auto boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c jsonb; a numeric; e date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date; v_je uuid; v_lines jsonb;
  v_name text := case p_key when 'DOUBTFUL' then 'Doubtful debts provision' when 'SLOW_STOCK' then 'Slow-moving stock provision'
                            when 'WARRANTY' then 'Warranty / defects provision' else 'Contract work not yet billed' end;
begin
  if not has_role('finance') then raise exception 'Finance posts provisions'; end if;
  c := provision_calc(p_key, p_month); a := (c->>'adjustment')::numeric;
  if abs(a) >= 0.01 then
    v_lines := case p_key
      when 'DOUBTFUL'   then jsonb_build_array(jsonb_build_object('acct', 'BAD_DEBTS', 'dr', a), jsonb_build_object('acct', 'ALLOW_DOUBTFUL', 'cr', a))
      when 'SLOW_STOCK' then jsonb_build_array(jsonb_build_object('acct', 'STOCK_PROV_EXP', 'dr', a), jsonb_build_object('acct', 'PROV_STOCK', 'cr', a))
      when 'WARRANTY'   then jsonb_build_array(jsonb_build_object('acct', 'WARRANTY_EXP', 'dr', a), jsonb_build_object('acct', 'PROV_WARRANTY', 'cr', a))
      else jsonb_build_array(jsonb_build_object('acct', 'ACCRUED_REV', 'dr', a), jsonb_build_object('acct', 'REV_CONTRACT', 'cr', a)) end;
    v_je := gl_post('PROVISION', null, e, p_key || ' ' || to_char(e, 'YYYY-MM'), v_name || ' — ' || to_char(e, 'Mon YYYY') || ' (to ' || to_char((c->>'target')::numeric, 'FM999,999,990.00') || ')', null, v_lines);
  end if;
  insert into provision_runs (key, period_month, target, before, adjustment, je_id, detail, automatic)
  values (p_key, date_trunc('month', p_month)::date, (c->>'target')::numeric, (c->>'current')::numeric, a, v_je, c->'detail', p_auto);
  return c || jsonb_build_object('journal', v_je);
end $$;

-- ---------- accruals that reverse themselves ----------
create table accruals (
  id             uuid primary key default gen_random_uuid(),
  acr_no         text not null unique default next_doc_no('ACR'),
  acr_date       date not null default current_date,
  period_month   date not null default date_trunc('month', current_date)::date check (period_month = date_trunc('month', period_month)::date),
  description    text not null,
  account_id     uuid not null references gl_accounts(id),
  cost_center_id uuid references cost_centers(id),
  project_id     uuid references projects(id),
  vendor_id      uuid references vendors(id),
  amount         numeric(14,2) not null check (amount > 0),
  template_id    uuid references expense_templates(id),
  status         text not null default 'DRAFT' check (status in ('DRAFT','POSTED','CANCELLED')),
  je_id          uuid references journal_entries(id),
  rev_je_id      uuid references journal_entries(id),
  created_by     uuid default auth.uid() references profiles(id),
  created_at     timestamptz not null default now(),
  posted_by      uuid references profiles(id), posted_at timestamptz
);

create or replace function public.accrual_action(p_id uuid, p_action text) returns text
language plpgsql security definer set search_path = public as $$
declare a accruals%rowtype; e date; v_je uuid; v_rev uuid;
begin
  if not has_role('finance') then raise exception 'Finance posts accruals'; end if;
  select * into a from accruals where id = p_id for update;
  if p_action = 'POST' then
    if a.status <> 'DRAFT' then raise exception 'Accrual is %', a.status; end if;
    e := (a.period_month + interval '1 month - 1 day')::date;
    v_je := gl_post('ACCRUAL', a.id, e, a.acr_no, 'Accrued: ' || a.description, a.project_id, jsonb_build_array(
      jsonb_build_object('acct', a.account_id::text, 'dr', a.amount, 'cost_center_id', a.cost_center_id, 'project_id', a.project_id, 'vendor_id', a.vendor_id),
      jsonb_build_object('acct', 'ACCRUED', 'cr', a.amount, 'vendor_id', a.vendor_id)));
    -- the reversal, dated the first day of the next month: the real bill then books the cost without double counting
    v_rev := gl_post('ACCRUAL_REVERSAL', a.id, e + 1, a.acr_no, 'Reversal of accrual: ' || a.description, a.project_id, jsonb_build_array(
      jsonb_build_object('acct', 'ACCRUED', 'dr', a.amount, 'vendor_id', a.vendor_id),
      jsonb_build_object('acct', a.account_id::text, 'cr', a.amount, 'cost_center_id', a.cost_center_id, 'project_id', a.project_id, 'vendor_id', a.vendor_id)));
    update accruals set status = 'POSTED', je_id = v_je, rev_je_id = v_rev, posted_by = auth.uid(), posted_at = now() where id = p_id;
    return 'POSTED';
  elsif p_action = 'CANCEL' then
    if a.status <> 'DRAFT' then raise exception 'Only draft accruals can be cancelled — reverse a posted one with a journal'; end if;
    update accruals set status = 'CANCELLED' where id = p_id;
    return 'CANCELLED';
  end if;
  raise exception 'Unknown action %', p_action;
end $$;

-- draft accruals for active recurring bills whose bill for the month has not been posted yet
create or replace function public.accrual_suggest(p_month date) returns int
language plpgsql security definer set search_path = public as $$
declare m date := date_trunc('month', p_month)::date; t record; n int := 0;
begin
  if not has_role('finance') and current_user not in ('postgres','supabase_admin') then raise exception 'Finance runs accruals'; end if;
  for t in select x.*, l.account_id, l.cost_center_id, l.project_id, l.amount, l.description line_desc
             from expense_templates x join expense_template_lines l on l.template_id = x.id
            where x.status = 'ACTIVE' and l.amount > 0
              and not exists (select 1 from expenses e where e.template_id = x.id and e.status in ('APPROVED','POSTED','REIMBURSED')
                                and date_trunc('month', e.exp_date)::date = m)
              and not exists (select 1 from accruals a where a.template_id = x.id and a.period_month = m and a.status <> 'CANCELLED' and a.account_id = l.account_id) loop
    insert into accruals (period_month, description, account_id, cost_center_id, project_id, vendor_id, amount, template_id)
    values (m, t.title || coalesce(' — ' || t.line_desc, '') || ' (' || to_char(m, 'Mon YYYY') || ', bill not yet posted)', t.account_id, t.cost_center_id, t.project_id, t.vendor_id, t.amount, t.id);
    n := n + 1;
  end loop;
  if n > 0 then perform notify('finance', null, n || ' accrual(s) suggested for ' || to_char(m, 'Mon YYYY'), 'Recurring bills not yet posted — check the amounts and post', 'd/acr', 'acr', null); end if;
  return n;
end $$;

-- ---------- prepayments spread over months ----------
create table prepayments (
  id                 uuid primary key default gen_random_uuid(),
  pp_no              text not null unique default next_doc_no('PPM'),
  pp_date            date not null default current_date,
  description        text not null,
  total              numeric(14,2) not null check (total > 0),
  start_month        date not null default date_trunc('month', current_date)::date check (start_month = date_trunc('month', start_month)::date),
  months             int not null check (months between 2 and 120),
  account_id         uuid not null references gl_accounts(id),
  cost_center_id     uuid references cost_centers(id),
  project_id         uuid references projects(id),
  prepaid_account_id uuid references gl_accounts(id),
  expense_line_id    uuid,
  released           numeric(14,2) not null default 0,
  status             text not null default 'ACTIVE' check (status in ('ACTIVE','DONE','CANCELLED')),
  remarks            text,
  created_by         uuid default auth.uid() references profiles(id),
  created_at         timestamptz not null default now()
);
create table prepayment_releases (
  id             uuid primary key default gen_random_uuid(),
  prepayment_id  uuid not null references prepayments(id) on delete cascade,
  period_month   date not null,
  amount         numeric(14,2) not null,
  je_id          uuid references journal_entries(id),
  created_at     timestamptz not null default now(),
  unique (prepayment_id, period_month)
);

-- releases every month that is due up to p_month (catches up schedules set up late)
create or replace function public.prepayment_release(p_month date, p_id uuid default null) returns int
language plpgsql security definer set search_path = public as $$
declare m date := date_trunc('month', p_month)::date; p record; k int; mm date; amt numeric; v_je uuid; n int := 0;
begin
  if not has_role('finance') then raise exception 'Finance releases prepayments'; end if;
  for p in select * from prepayments where status = 'ACTIVE' and (p_id is null or id = p_id) and start_month <= m for update loop
    for k in 0 .. p.months - 1 loop
      mm := (p.start_month + make_interval(months => k))::date;
      exit when mm > m;
      continue when exists (select 1 from prepayment_releases where prepayment_id = p.id and period_month = mm);
      amt := case when k = p.months - 1 then p.total - (select coalesce(sum(amount), 0) from prepayment_releases where prepayment_id = p.id) else round(p.total / p.months, 2) end;
      v_je := gl_post('PREPAYMENT', p.id, (mm + interval '1 month - 1 day')::date, p.pp_no, 'Prepayment released ' || (k + 1) || '/' || p.months || ': ' || p.description, p.project_id, jsonb_build_array(
        jsonb_build_object('acct', p.account_id::text, 'dr', amt, 'cost_center_id', p.cost_center_id, 'project_id', p.project_id),
        jsonb_build_object('acct', coalesce(p.prepaid_account_id, gl_acct('PREPAID'))::text, 'cr', amt)));
      insert into prepayment_releases (prepayment_id, period_month, amount, je_id) values (p.id, mm, amt, v_je);
      if p.project_id is not null then
        insert into project_costs (project_id, cost_date, source, source_id, doc_no, description, amount)
        values (p.project_id, (mm + interval '1 month - 1 day')::date, 'OTHER', p.id, p.pp_no, p.description || ' (' || (k + 1) || '/' || p.months || ')', amt);
      end if;
      n := n + 1;
    end loop;
    update prepayments set released = (select coalesce(sum(amount), 0) from prepayment_releases where prepayment_id = p.id),
           status = case when (select count(*) from prepayment_releases where prepayment_id = p.id) >= p.months then 'DONE' else status end where id = p.id;
  end loop;
  return n;
end $$;

-- expense lines can be spread: posted to Prepayments, then released monthly to the chosen expense head
alter table expense_lines add column spread_months int check (spread_months is null or spread_months between 2 and 120);
do $$
declare d text := pg_get_functiondef('public.expense_action(uuid,text,jsonb)'::regprocedure);
begin
  if position('select v_inv, coalesce(l.description, a.name), 1, l.amount, l.vat_rate, l.account_id, l.cost_center_id, l.project_id' in d) = 0
     or position('jsonb_build_object(''acct'', l.account_id::text, ''dr'', l.amount,' in d) = 0
     or position('from expense_lines l where l.expense_id = p_exp and l.project_id is not null;' in d) = 0
     or position('update expenses set status = ''POSTED'', posted_by = auth.uid(), posted_at = now() where id = p_exp;' in d) = 0 then raise exception 'expense_action anchors missing'; end if;
  d := replace(d, 'select v_inv, coalesce(l.description, a.name), 1, l.amount, l.vat_rate, l.account_id, l.cost_center_id, l.project_id',
                  'select v_inv, coalesce(l.description, a.name), 1, l.amount, l.vat_rate, case when coalesce(l.spread_months, 1) > 1 then gl_acct(''PREPAID'') else l.account_id end, l.cost_center_id, l.project_id');
  d := replace(d, 'jsonb_build_object(''acct'', l.account_id::text, ''dr'', l.amount,',
                  'jsonb_build_object(''acct'', case when coalesce(l.spread_months, 1) > 1 then gl_acct(''PREPAID'')::text else l.account_id::text end, ''dr'', l.amount,');
  d := replace(d, 'from expense_lines l where l.expense_id = p_exp and l.project_id is not null;',
                  'from expense_lines l where l.expense_id = p_exp and l.project_id is not null and coalesce(l.spread_months, 1) <= 1;');
  d := replace(d, 'update expenses set status = ''POSTED'', posted_by = auth.uid(), posted_at = now() where id = p_exp;',
                  '-- spread lines become prepayment schedules released monthly from the bill month' || chr(10) ||
                  '    insert into prepayments (pp_date, description, total, start_month, months, account_id, cost_center_id, project_id, prepaid_account_id, expense_line_id, remarks)' || chr(10) ||
                  '    select e.exp_date, coalesce(l.description, (select name from gl_accounts where id = l.account_id)) || '' — '' || e.exp_no, l.amount, date_trunc(''month'', e.exp_date)::date, l.spread_months,' || chr(10) ||
                  '           l.account_id, l.cost_center_id, l.project_id, gl_acct(''PREPAID''), l.id, ''From expense '' || e.exp_no' || chr(10) ||
                  '      from expense_lines l where l.expense_id = p_exp and coalesce(l.spread_months, 1) > 1;' || chr(10) ||
                  '    update expenses set status = ''POSTED'', posted_by = auth.uid(), posted_at = now() where id = p_exp;');
  execute d;
end $$;

-- ---------- month end runs whatever Finance has switched on ----------
create or replace function public.provisions_auto(p_month date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s record; out jsonb := '{}'; r jsonb;
begin
  if not has_role('finance') then raise exception 'Finance runs provisions'; end if;
  for s in select * from provision_settings where automate order by key loop
    if s.key = 'ACCRUALS' then out := out || jsonb_build_object('ACCRUALS', accrual_suggest(p_month));
    elsif s.key = 'PREPAYMENTS' then out := out || jsonb_build_object('PREPAYMENTS', prepayment_release(p_month));
    else r := provision_post(s.key, p_month, true); out := out || jsonb_build_object(s.key, r->'adjustment');
    end if;
  end loop;
  return out;
end $$;

do $$
declare d text := pg_get_functiondef('public.gl_month_end(date)'::regprocedure);
begin
  if position('return jsonb_build_object(''journal'', v_je, ''depreciation'', v_dep, ''gratuity_provision'', v_grat, ''leave_provision'', v_leave);' in d) = 0 then raise exception 'gl_month_end anchor missing'; end if;
  execute replace(d, 'return jsonb_build_object(''journal'', v_je, ''depreciation'', v_dep, ''gratuity_provision'', v_grat, ''leave_provision'', v_leave);',
    'return jsonb_build_object(''journal'', v_je, ''depreciation'', v_dep, ''gratuity_provision'', v_grat, ''leave_provision'', v_leave, ''automated'', provisions_auto(m));');
end $$;

-- ---------- access ----------
alter table provision_settings enable row level security;
alter table provision_runs enable row level security;
alter table accruals enable row level security;
alter table prepayments enable row level security;
alter table prepayment_releases enable row level security;
create policy fin_read on provision_settings for select to authenticated using (public.has_role('finance','factory_manager'));
create policy fin_write on provision_settings for update to authenticated using (public.is_finance()) with check (public.is_finance());
create policy fin_read on provision_runs for select to authenticated using (public.has_role('finance','factory_manager'));
create policy fin_read on accruals for select to authenticated using (public.has_role('finance','factory_manager'));
create policy fin_write on accruals for all to authenticated using (public.is_finance() and status = 'DRAFT') with check (public.is_finance() and status = 'DRAFT');
create policy fin_read on prepayments for select to authenticated using (public.has_role('finance','factory_manager'));
create policy fin_insert on prepayments for insert to authenticated with check (public.is_finance());
create policy fin_update on prepayments for update to authenticated using (public.is_finance() and released = 0) with check (public.is_finance());
create policy fin_delete on prepayments for delete to authenticated using (public.is_finance() and released = 0);
create policy fin_read on prepayment_releases for select to authenticated using (public.has_role('finance','factory_manager'));

grant execute on function public.provision_calc(text, date), public.provision_post(text, date, boolean), public.accrual_action(uuid, text), public.accrual_suggest(date),
  public.prepayment_release(date, uuid), public.provisions_auto(date), public.gl_balance(uuid, date) to authenticated;
revoke execute on function public.provision_calc(text, date), public.provision_post(text, date, boolean), public.accrual_action(uuid, text), public.accrual_suggest(date),
  public.prepayment_release(date, uuid), public.provisions_auto(date), public.gl_balance(uuid, date) from anon;
