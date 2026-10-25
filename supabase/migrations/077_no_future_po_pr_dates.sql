-- 077 PO and requisition dates cannot be in the future either (no forward-dated orders). Back-dated entries stay allowed
-- (the team may enter a backlog); delivery / required dates remain free.
drop trigger if exists trg_no_future on purchase_orders;
create trigger trg_no_future before insert or update on purchase_orders for each row execute function no_future_dates('po_date');
drop trigger if exists trg_no_future on purchase_requisitions;
create trigger trg_no_future before insert or update on purchase_requisitions for each row execute function no_future_dates('pr_date');

-- readable field names in the message ("PO date", "Requisition date", …)
create or replace function no_future_dates() returns trigger language plpgsql set search_path = public as $$
declare j jsonb := to_jsonb(new); o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
        c text; v date; i int; v_today date := (now() at time zone 'Asia/Dubai')::date; v_lbl text;
begin
  for i in 0 .. tg_nargs - 1 loop
    c := tg_argv[i];
    if nullif(j->>c, '') is null then continue; end if;
    if o is not null and (o->>c) is not distinct from (j->>c) then continue; end if;
    v := left(j->>c, 10)::date;
    if v > v_today then
      v_lbl := case c when 'grn_date' then 'GRN date' when 'po_date' then 'PO date' when 'pr_date' then 'Requisition date'
                      when 'vendor_dn_date' then 'Delivery note date' when 'vendor_invoice_date' then 'Vendor invoice date'
                      when 'mfg_date' then 'Manufacturing date' when 'trf_date' then 'Transfer date' when 'adj_date' then 'Adjustment date'
                      when 'log_date' then 'Log date' when 'att_date' then 'Attendance date' when 'adv_date' then 'Advance date'
                      when 'je_date' then 'Journal date' when 'exp_date' then 'Expense date' when 'dn_date' then 'Debit note date'
                      when 'handed_over_at' then 'Handover date' when 'delivered_at' then 'Delivered date' when 'cert_date' then 'Certificate date'
                      else initcap(replace(c, '_', ' ')) end;
      raise exception '% cannot be in the future (% — today is %)', v_lbl, to_char(v, 'DD Mon YYYY'), to_char(v_today, 'DD Mon YYYY');
    end if;
  end loop;
  return new;
end $$;
