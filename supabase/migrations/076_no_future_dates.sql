-- 076 Dates of things that have already happened cannot be in the future (UAE date): receipts, issues, stock moves and
-- counts, production and site records, HR attendance, and accounting documents. Planning dates stay free (delivery /
-- required / due dates, schedules, validity, PDC cheque dates, planned stops, leave, PM due dates, project end dates).
-- Checked when the row is created or the date is changed, so older rows are untouched.
create or replace function no_future_dates() returns trigger language plpgsql set search_path = public as $$
declare j jsonb := to_jsonb(new); o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
        c text; v date; i int; v_today date := (now() at time zone 'Asia/Dubai')::date;
begin
  for i in 0 .. tg_nargs - 1 loop
    c := tg_argv[i];
    if nullif(j->>c, '') is null then continue; end if;
    if o is not null and (o->>c) is not distinct from (j->>c) then continue; end if;
    v := left(j->>c, 10)::date;
    if v > v_today then
      raise exception '% cannot be in the future (% — today is %)', initcap(replace(c, '_', ' ')), to_char(v, 'DD Mon YYYY'), to_char(v_today, 'DD Mon YYYY');
    end if;
  end loop;
  return new;
end $$;

do $$ declare r record;
begin
  for r in select * from (values
    -- stores
    ('grns', 'grn_date, vendor_dn_date, vendor_invoice_date'), ('grn_lines', 'mfg_date'),
    ('material_issues', 'issue_date'), ('material_returns', 'return_date'), ('stock_transfers', 'trf_date'),
    ('stock_adjustments', 'adj_date'), ('stock_counts', 'count_date'), ('scrap_notes', 'scrap_date'),
    ('scrap_disposals', 'disposal_date'), ('purchase_returns', 'return_date'), ('stock_releases', 'release_date'),
    -- production & site
    ('wo_time_logs', 'log_date'), ('wo_receipts', 'receipt_date'), ('dispatch_notes', 'dispatch_date, delivered_at'),
    ('install_logs', 'log_date'), ('project_units', 'handed_over_at'), ('snags', 'snag_date'), ('so_job_logs', 'log_date'),
    -- HR
    ('attendance', 'att_date'), ('employee_advances', 'adv_date'),
    -- finance
    ('sales_invoices', 'invoice_date, cert_date'), ('customer_receipts', 'receipt_date'), ('vendor_invoices', 'invoice_date'),
    ('vendor_debit_notes', 'dn_date'), ('vendor_payments', 'payment_date'), ('journal_entries', 'je_date'), ('expenses', 'exp_date')
  ) t(tbl, cols) loop
    execute format('drop trigger if exists trg_no_future on %I', r.tbl);
    execute format('create trigger trg_no_future before insert or update on %I for each row execute function no_future_dates(%s)',
                   r.tbl, (select string_agg(quote_literal(trim(x)), ', ') from unnest(string_to_array(r.cols, ',')) x));
  end loop;
end $$;
