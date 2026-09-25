-- =====================================================================
-- Citi Homes IMS - 016 Automatic debit-note suggestion when a supplier bills
-- more than was accepted (short vs DN, damaged, excess not accepted)
-- Invoice lines carry the BILLED qty; billing may go up to what the supplier delivered
-- per DN / received, and anything above the accepted qty becomes a draft debit note.
-- =====================================================================
alter table vendor_debit_notes add column auto_generated boolean not null default false;
alter table vendor_invoice_lines add column claim_qty numeric(14,3) not null default 0;

create or replace function public.post_vendor_invoice(p_inv uuid) returns void
language plpgsql security definer set search_path = public as $$
declare h vendor_invoices%rowtype; l record; v_billed numeric; v_term uuid; v_grn_date date; v_var boolean := false;
        v_cap numeric; v_claim numeric; v_claim_amt numeric := 0; v_claim_vat numeric := 0; v_reason text := ''; v_dn uuid;
begin
  if not has_role('finance') then raise exception 'Only Finance can post vendor invoices'; end if;
  select * into h from vendor_invoices where id = p_inv for update;
  if h.status <> 'DRAFT' then raise exception 'Invoice already %', h.status; end if;
  if not exists (select 1 from vendor_invoice_lines where invoice_id = p_inv) then raise exception 'Invoice has no lines'; end if;

  for l in select vil.*, gl.accepted_qty, gl.received_qty, gl.dn_qty, gl.rate grn_rate, gl.grn_id, g.grn_no, g.vendor_id grn_vendor,
                  g.status grn_status, pl.rate po_rate, i.code item_code
             from vendor_invoice_lines vil
             left join grn_lines gl on gl.id = vil.grn_line_id
             left join grns g on g.id = gl.grn_id
             left join po_lines pl on pl.id = gl.po_line_id
             left join items i on i.id = vil.item_id
            where vil.invoice_id = p_inv loop
    v_claim := 0;
    if l.grn_line_id is not null then
      if l.grn_status <> 'POSTED' then raise exception 'GRN line is not posted'; end if;
      if l.grn_vendor <> h.vendor_id then raise exception 'GRN belongs to another vendor'; end if;
      select coalesce(sum(x.qty),0) into v_billed from vendor_invoice_lines x join vendor_invoices i on i.id = x.invoice_id
       where x.grn_line_id = l.grn_line_id and i.status = 'POSTED';
      -- the supplier may bill what they claim to have delivered (DN) or what physically arrived, whichever is higher
      v_cap := greatest(coalesce(l.dn_qty, 0), l.received_qty);
      if v_billed + l.qty > v_cap + 0.0005 then
        raise exception 'Invoiced qty for % exceeds delivered qty (DN / received %, already invoiced %)', l.item_code, v_cap, v_billed;
      end if;
      -- portion of this invoice above the accepted qty is claimable
      v_claim := greatest(v_billed + l.qty - l.accepted_qty, 0) - greatest(v_billed - l.accepted_qty, 0);
      if abs(l.rate - coalesce(l.po_rate, l.grn_rate)) > 0.0001 then v_var := true; end if;
      if v_claim > 0.0005 then
        v_claim_amt := v_claim_amt + round(v_claim * l.rate * h.exchange_rate, 2);
        v_claim_vat := v_claim_vat + round(v_claim * l.rate * h.exchange_rate * l.vat_rate / 100, 2);
        v_reason := v_reason || format('%s %s: billed %s, accepted %s (GRN %s); ', l.item_code, coalesce(l.description, ''),
                                       v_billed + l.qty, l.accepted_qty, l.grn_no);
      end if;
    end if;
    update vendor_invoice_lines set claim_qty = round(v_claim, 3) where id = l.id;
    if l.grn_charge_id is not null and exists (
         select 1 from vendor_invoice_lines x join vendor_invoices i on i.id = x.invoice_id
          where x.grn_charge_id = l.grn_charge_id and i.status = 'POSTED') then
      raise exception 'This landed-cost charge is already invoiced';
    end if;
  end loop;

  select coalesce(h.payment_term_id, po.payment_term_id, v.payment_term_id) into v_term
    from vendors v left join purchase_orders po on po.id = h.po_id where v.id = h.vendor_id;
  select max(g.grn_date) into v_grn_date from vendor_invoice_lines x
    join grn_lines gl on gl.id = x.grn_line_id join grns g on g.id = gl.grn_id where x.invoice_id = p_inv;

  update vendor_invoices set status = 'POSTED', posted_at = now(), posted_by = auth.uid(), has_variance = v_var,
         payment_term_id = v_term,
         due_date = coalesce(due_date, compute_due_date(v_term, h.invoice_date, v_grn_date), h.invoice_date)
   where id = p_inv;

  if v_claim_amt > 0 then
    insert into vendor_debit_notes (vendor_id, invoice_id, reason, amount_aed, vat_amount, status, auto_generated)
    values (h.vendor_id, p_inv, 'Claim on invoice ' || h.vendor_invoice_no || ' — billed above accepted qty (short / damaged / excess): ' || v_reason,
            v_claim_amt, v_claim_vat, 'DRAFT', true)
    returning id into v_dn;
    perform notify('finance', null, 'Debit note suggested for invoice ' || h.vendor_invoice_no,
                   'AED ' || to_char(v_claim_amt + v_claim_vat, 'FM999,999,990.00') || ' billed above accepted quantities — review and post',
                   'd/dn/' || v_dn, 'dn', v_dn);
  end if;
end $$;

-- a purchase return's debit note must not double-claim what an automatic invoice claim already covers
create or replace view public.v_grn_claims with (security_invoker = true) as
select gl.id grn_line_id, gl.grn_id, coalesce(sum(vil.claim_qty) filter (where vi.status = 'POSTED'), 0) claimed_qty
  from grn_lines gl
  left join vendor_invoice_lines vil on vil.grn_line_id = gl.id
  left join vendor_invoices vi on vi.id = vil.invoice_id
 group by gl.id, gl.grn_id;
