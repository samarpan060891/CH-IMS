-- 079 Supplier references on a posted GRN (delivery note no. / date, invoice no. / date, vehicle) can be filled in or
-- corrected later; they do not touch stock or cost. Stores, Purchase and Finance; every change goes to the audit log;
-- dates still cannot be in the future (trigger from 076).
create or replace function grn_update_refs(p_grn uuid, p_dn_no text, p_dn_date date, p_inv_no text, p_inv_date date, p_vehicle text)
returns void language plpgsql security definer set search_path = public as $$
declare g grns%rowtype;
begin
  if not has_role('stores', 'purchase', 'finance') then raise exception 'Only Stores, Purchase or Finance can update GRN references'; end if;
  select * into g from grns where id = p_grn for update;
  if not found then raise exception 'GRN not found'; end if;
  if g.status = 'CANCELLED' then raise exception 'GRN % is cancelled', g.grn_no; end if;
  update grns set vendor_dn_no = nullif(trim(p_dn_no), ''), vendor_dn_date = p_dn_date,
                  vendor_invoice_no = nullif(trim(p_inv_no), ''), vendor_invoice_date = p_inv_date, vehicle_no = nullif(trim(p_vehicle), '')
   where id = p_grn;
  insert into audit_log (entity, entity_id, action, details) values ('grn', p_grn, 'REFS_UPDATED', jsonb_build_object('grn_no', g.grn_no,
    'before', jsonb_build_object('dn_no', g.vendor_dn_no, 'dn_date', g.vendor_dn_date, 'invoice_no', g.vendor_invoice_no, 'invoice_date', g.vendor_invoice_date, 'vehicle', g.vehicle_no),
    'after', jsonb_build_object('dn_no', p_dn_no, 'dn_date', p_dn_date, 'invoice_no', p_inv_no, 'invoice_date', p_inv_date, 'vehicle', p_vehicle)));
end $$;
revoke execute on function grn_update_refs(uuid, text, date, text, date, text) from public, anon;
