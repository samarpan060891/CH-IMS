-- 080 No duplicate supplier documents or payment references. Numbers are compared ignoring spaces, dashes, slashes and
-- capitals ("MIH-130122" = "mih 130122"); cancelled (and bounced) documents do not count.
--   · a supplier invoice is booked once per vendor (vendor invoices)
--   · a supplier delivery note / invoice number is received once per vendor (GRNs)
--   · a cheque / transfer reference is used once per vendor (payments) and per customer (receipts); cash is not checked
-- Document numbers (PO-…, GRN-…, INV-…) were already unique; re-invoicing received goods and over-paying an invoice are
-- refused when posting (post_vendor_invoice / post_payment).
create or replace function doc_ref_norm(t text) returns text language sql immutable as $$
  select nullif(upper(regexp_replace(coalesce(t, ''), '[^A-Za-z0-9]', '', 'g')), '')
$$;

create or replace function no_duplicate_refs() returns trigger language plpgsql security definer set search_path = public as $$
declare v_doc text;
begin
  -- each branch only reads its own table's columns
  if tg_table_name = 'vendor_invoices' then
    if new.status <> 'CANCELLED' and doc_ref_norm(new.vendor_invoice_no) is not null then
      select inv_no into v_doc from vendor_invoices where vendor_id = new.vendor_id and id <> new.id and status <> 'CANCELLED'
         and doc_ref_norm(vendor_invoice_no) = doc_ref_norm(new.vendor_invoice_no) limit 1;
      if found then raise exception 'Supplier invoice % from % is already booked (%)', new.vendor_invoice_no, (select name from vendors where id = new.vendor_id), v_doc; end if;
    end if;
  elsif tg_table_name = 'grns' then
    if new.status <> 'CANCELLED' and new.vendor_id is not null then
      if doc_ref_norm(new.vendor_dn_no) is not null then
        select grn_no into v_doc from grns where vendor_id = new.vendor_id and id <> new.id and status <> 'CANCELLED'
           and doc_ref_norm(vendor_dn_no) = doc_ref_norm(new.vendor_dn_no) limit 1;
        if found then raise exception 'Delivery note % from this supplier is already received on %', new.vendor_dn_no, v_doc; end if;
      end if;
      if doc_ref_norm(new.vendor_invoice_no) is not null then
        select grn_no into v_doc from grns where vendor_id = new.vendor_id and id <> new.id and status <> 'CANCELLED'
           and doc_ref_norm(vendor_invoice_no) = doc_ref_norm(new.vendor_invoice_no) limit 1;
        if found then raise exception 'Supplier invoice % is already recorded on %', new.vendor_invoice_no, v_doc; end if;
      end if;
    end if;
  elsif tg_table_name = 'vendor_payments' then
    if new.status not in ('CANCELLED', 'BOUNCED') and new.mode <> 'CASH' and doc_ref_norm(new.reference_no) is not null then
      select payment_no into v_doc from vendor_payments where vendor_id = new.vendor_id and id <> new.id and status not in ('CANCELLED', 'BOUNCED')
         and doc_ref_norm(reference_no) = doc_ref_norm(new.reference_no) limit 1;
      if found then raise exception 'Payment reference % for this vendor is already used on %', new.reference_no, v_doc; end if;
    end if;
  elsif tg_table_name = 'customer_receipts' then
    if new.status not in ('CANCELLED', 'BOUNCED') and new.mode <> 'CASH' and doc_ref_norm(new.reference_no) is not null then
      select receipt_no into v_doc from customer_receipts where customer_id = new.customer_id and id <> new.id and status not in ('CANCELLED', 'BOUNCED')
         and doc_ref_norm(reference_no) = doc_ref_norm(new.reference_no) limit 1;
      if found then raise exception 'Cheque / transfer reference % from this customer is already recorded on %', new.reference_no, v_doc; end if;
    end if;
  end if;
  return new;
end $$;

do $$ declare t text;
begin
  foreach t in array array['vendor_invoices', 'grns', 'vendor_payments', 'customer_receipts'] loop
    execute format('drop trigger if exists trg_no_dup_refs on %I', t);
    execute format('create trigger trg_no_dup_refs before insert or update on %I for each row execute function no_duplicate_refs()', t);
  end loop;
end $$;

-- the exact-match key on vendor invoices also blocked re-booking a cancelled one; the normalised index replaces it
alter table vendor_invoices drop constraint if exists vendor_invoices_vendor_id_vendor_invoice_no_key;
-- backstops against two users saving at the same moment
create unique index if not exists vendor_invoices_vendor_ref_uq on vendor_invoices (vendor_id, doc_ref_norm(vendor_invoice_no)) where status <> 'CANCELLED';
create unique index if not exists grns_vendor_dn_uq on grns (vendor_id, doc_ref_norm(vendor_dn_no)) where status <> 'CANCELLED' and doc_ref_norm(vendor_dn_no) is not null;
create unique index if not exists grns_vendor_inv_uq on grns (vendor_id, doc_ref_norm(vendor_invoice_no)) where status <> 'CANCELLED' and doc_ref_norm(vendor_invoice_no) is not null;
create unique index if not exists vendor_payments_ref_uq on vendor_payments (vendor_id, doc_ref_norm(reference_no)) where status not in ('CANCELLED', 'BOUNCED') and mode <> 'CASH' and doc_ref_norm(reference_no) is not null;
create unique index if not exists customer_receipts_ref_uq on customer_receipts (customer_id, doc_ref_norm(reference_no)) where status not in ('CANCELLED', 'BOUNCED') and mode <> 'CASH' and doc_ref_norm(reference_no) is not null;
