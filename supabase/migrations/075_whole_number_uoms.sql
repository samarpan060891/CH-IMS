-- 075 Whole-number units (decimals = 0 on the unit of measure): bundles, cans, spools and rolls join pieces, sets, pairs,
-- boxes and sheets. BOM quantities per piece stay fractional; documents do not:
--   · material request and requisition lines (often generated from BOM fractions) are rounded UP to whole units
--   · PO, GRN, issue, transfer and purchase-return lines refuse fractions
-- Offcut pieces (part of a sheet) and items counted in pieces (slats in bundles: part of a bundle, whole pieces) are
-- exempt, and on updates only the quantities that changed are checked.
update uoms set decimals = 0 where code in ('BDL', 'CAN', 'SPL', 'ROL');

create or replace function enforce_whole_qty() returns trigger language plpgsql security definer set search_path = public as $$
declare j jsonb := to_jsonb(new); o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
        v_dec int; v_uom text; v_item text; v_dim boolean; v_off boolean; c text; v numeric; i int; changed boolean := false;
begin
  select u.decimals, u.code, it.code, it.dim_tracking into v_dec, v_uom, v_item, v_dim
    from items it join uoms u on u.id = it.uom_id where it.id = nullif(j->>'item_id', '')::uuid;
  -- items counted in pieces (timber slats in bundles) may take part of a bundle: their pieces are the whole count
  if v_dec is null or v_dec > 0 or coalesce(v_dim, false) then return new; end if;
  if nullif(j->>'lot_id', '') is not null then
    select is_offcut into v_off from stock_lots where id = (j->>'lot_id')::uuid;
    if coalesce(v_off, false) then return new; end if;
  end if;
  for i in 1 .. tg_nargs - 1 loop
    c := tg_argv[i];
    v := nullif(j->>c, '')::numeric;
    if v is null or v = trunc(v) then continue; end if;
    if o is not null and (o->>c) is not distinct from (j->>c) then continue; end if;   -- unchanged on update
    if tg_argv[0] = 'round' then
      j := jsonb_set(j, array[c], to_jsonb(ceil(v))); changed := true;
    else
      raise exception '% is counted in whole % — % cannot be %', v_item, v_uom, replace(c, '_', ' '), trim_scale(v);
    end if;
  end loop;
  if changed then new := jsonb_populate_record(new, j); end if;
  return new;
end $$;

drop trigger if exists trg_whole_qty on mr_lines;
create trigger trg_whole_qty before insert or update on mr_lines for each row execute function enforce_whole_qty('round', 'requested_qty', 'approved_qty');
drop trigger if exists trg_whole_qty on pr_lines;
create trigger trg_whole_qty before insert or update on pr_lines for each row execute function enforce_whole_qty('round', 'qty');
drop trigger if exists trg_whole_qty on po_lines;
create trigger trg_whole_qty before insert or update on po_lines for each row execute function enforce_whole_qty('reject', 'qty');
drop trigger if exists trg_whole_qty on grn_lines;
create trigger trg_whole_qty before insert or update on grn_lines for each row execute function enforce_whole_qty('reject', 'dn_qty', 'received_qty', 'damaged_qty');
drop trigger if exists trg_whole_qty on issue_lines;
create trigger trg_whole_qty before insert or update on issue_lines for each row execute function enforce_whole_qty('reject', 'qty');
drop trigger if exists trg_whole_qty on transfer_lines;
create trigger trg_whole_qty before insert or update on transfer_lines for each row execute function enforce_whole_qty('reject', 'qty');
drop trigger if exists trg_whole_qty on prt_lines;
create trigger trg_whole_qty before insert or update on prt_lines for each row execute function enforce_whole_qty('reject', 'qty');
