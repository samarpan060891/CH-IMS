-- =====================================================================
-- Citi Homes IMS - 015 Excess / short / damaged handling
--   Supplier GRN : DN qty, received, damaged -> accepted (<= PO balance), excess & damaged held in Quarantine
--                  damaged -> automatic draft purchase return; excess -> Purchase accepts (PO amended) or returns
--   Floor receipt: good / damaged per line; damaged auto-returned to Quarantine (project credited, re-issuable)
--   Floor returns: shop floor raises, Stores verifies & posts
-- =====================================================================

-- ---------- columns ----------
alter table stock_lots add column hold_reason text check (hold_reason in ('DAMAGED','EXCESS','RETURN_DAMAGED'));
alter table grn_lines
  add column dn_qty      numeric(14,3),                     -- quantity per supplier delivery note
  add column damaged_qty numeric(14,3) not null default 0,
  add column excess_qty  numeric(14,3) not null default 0,  -- set on posting, reduced when accepted / returned
  add column short_qty   numeric(14,3) generated always as (greatest(coalesce(dn_qty, 0) - received_qty, 0)) stored;
alter table grn_lines add constraint damaged_le_received check (damaged_qty >= 0 and damaged_qty <= received_qty);
alter table prt_lines add column lot_id uuid references stock_lots(id);
alter table issue_lines add column damaged_qty numeric(14,3) not null default 0;

alter table material_returns drop constraint material_returns_status_check;
alter table material_returns add constraint material_returns_status_check check (status in ('DRAFT','SUBMITTED','POSTED','CANCELLED'));
alter table material_returns add column requested_by uuid references profiles(id), add column submitted_at timestamptz;
alter table return_lines add column requested_qty numeric(14,3);

-- ---------- GRN posting with damaged / excess ----------
create or replace function public.post_grn(p_grn uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  g grns%rowtype; l record; v_cls item_classes%rowtype; v_po purchase_orders%rowtype;
  v_tol numeric; v_goods_aed numeric; v_goods_qty numeric; v_chg_val numeric; v_chg_qty numeric;
  v_lc numeric; v_cost numeric; v_lot uuid; v_loc uuid; v_qa uuid; v_proj uuid; i int;
  v_dmg numeric; v_good numeric; v_bal numeric; v_acc numeric; v_exc numeric;
  v_prt uuid; v_prt_n int := 0; v_exc_total numeric := 0;
begin
  if not has_role('stores') then raise exception 'Only Stores can post a GRN'; end if;
  select * into g from grns where id = p_grn for update;
  if not found then raise exception 'GRN not found'; end if;
  if g.status <> 'DRAFT' then raise exception 'GRN % is already %', g.grn_no, g.status; end if;
  if not exists (select 1 from grn_lines where grn_id = p_grn and received_qty > 0) then
    raise exception 'GRN has no received quantities';
  end if;

  if g.receipt_type = 'PO' then
    select * into v_po from purchase_orders where id = g.po_id for update;
    if v_po.status not in ('RELEASED','PARTIALLY_RECEIVED') then
      raise exception 'PO % is not released (status %)', v_po.po_no, v_po.status;
    end if;
    if exists (select 1 from grn_lines gl left join po_lines pl on pl.id = gl.po_line_id
                where gl.grn_id = p_grn and (pl.id is null or pl.po_id <> g.po_id)) then
      raise exception 'Every GRN line must reference a line of PO %', v_po.po_no;
    end if;
  end if;
  select grn_over_receipt_pct into v_tol from company_settings;
  select id into v_qa from locations where loc_type = 'QUARANTINE' order by created_at limit 1;

  -- landed cost spread over everything physically received
  select coalesce(sum(received_qty * rate),0) * g.exchange_rate, coalesce(sum(received_qty),0)
    into v_goods_aed, v_goods_qty from grn_lines where grn_id = p_grn;
  select coalesce(sum(amount_aed) filter (where alloc_basis = 'VALUE'),0),
         coalesce(sum(amount_aed) filter (where alloc_basis = 'QTY'),0)
    into v_chg_val, v_chg_qty from grn_charges where grn_id = p_grn;
  if v_chg_val > 0 and v_goods_aed = 0 then raise exception 'Cannot allocate value-based charges on zero-value receipt'; end if;

  for l in select gl.*, it.class_id, it.code item_code, pl.project_id po_project
             from grn_lines gl join items it on it.id = gl.item_id
             left join po_lines pl on pl.id = gl.po_line_id
            where gl.grn_id = p_grn order by gl.line_no loop
    v_dmg := coalesce(l.damaged_qty, 0);
    v_good := l.received_qty - v_dmg;
    if l.po_line_id is not null then
      select greatest(qty * (1 + v_tol / 100) - received_qty, 0) into v_bal from po_lines where id = l.po_line_id for update;
      v_acc := least(v_good, v_bal);
    else
      v_acc := v_good;
    end if;
    v_exc := v_good - v_acc;
    update grn_lines set accepted_qty = v_acc, excess_qty = v_exc where id = l.id;
    if l.po_line_id is not null and v_acc > 0 then
      update po_lines set received_qty = received_qty + v_acc where id = l.po_line_id;
    end if;
    continue when l.received_qty <= 0;

    v_proj := coalesce(l.po_project, l.project_id, case when g.receipt_type = 'CUSTOMER_SUPPLIED' then g.project_id end);
    v_lc := 0;
    if v_goods_aed > 0 then v_lc := v_lc + v_chg_val * (l.rate * g.exchange_rate) / v_goods_aed; end if;
    if v_goods_qty > 0 then v_lc := v_lc + v_chg_qty / v_goods_qty; end if;
    v_cost := round(l.rate * g.exchange_rate + v_lc, 4);
    update grn_lines set landed_cost_per_unit = round(v_lc,4), unit_cost_aed = v_cost, project_id = v_proj where id = l.id;

    select * into v_cls from item_classes where id = l.class_id;
    v_loc := coalesce(l.location_id, g.location_id, (select id from locations where code = 'MS'));

    if v_cls.tracking = 'SERIAL' then
      -- tools / machines: only accepted units are registered; damaged / excess units go back with the supplier
      if v_acc <> trunc(v_acc) then raise exception 'Serialised item % must be received in whole numbers', l.item_code; end if;
      for i in 1 .. v_acc::int loop
        insert into assets (asset_tag, item_id, serial_no, grn_line_id, purchase_date, purchase_cost, vendor_id, location_id, status, project_id)
        values (next_asset_tag(v_cls.code), l.item_id,
                case when coalesce(array_length(l.serial_nos,1),0) >= i then l.serial_nos[i] end,
                l.id, g.grn_date, v_cost, g.vendor_id, v_loc, 'IN_STORE', coalesce(v_proj, g.project_id));
      end loop;
      if v_acc > 0 then
        insert into stock_ledger (txn_date, txn_type, item_id, location_id, qty, unit_cost, value, doc_type, doc_id, doc_no, doc_line_id, project_id, remarks)
        values (g.grn_date, 'GRN', l.item_id, v_loc, v_acc, v_cost, round(v_acc * v_cost, 2), 'GRN', g.id, g.grn_no, l.id, coalesce(v_proj, g.project_id), 'Capitalised to asset register');
      end if;
    else
      if item_valuation(l.item_id) = 'WAVG' then perform wavg_receive(l.item_id, l.received_qty, v_cost); end if;
      if v_acc > 0 then
        insert into stock_lots (item_id, location_id, lot_no, batch_no, source_type, source_id, received_date, mfg_date, expiry_date,
                                unit_cost, qty_in, qty_on_hand, vendor_id, project_id)
        values (l.item_id, v_loc, coalesce(nullif(l.lot_no,''), g.grn_no || '-' || l.line_no), l.batch_no, 'GRN', l.id,
                coalesce(l.original_receipt_date, g.grn_date), l.mfg_date, l.expiry_date, v_cost, v_acc, v_acc, g.vendor_id, v_proj)
        returning id into v_lot;
        insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value, doc_type, doc_id, doc_no, doc_line_id, project_id, remarks)
        values (g.grn_date, 'GRN', l.item_id, v_loc, v_lot, v_acc, v_cost, round(v_acc * v_cost, 2), 'GRN', g.id, g.grn_no, l.id, v_proj,
                case when v_proj is not null then 'Reserved for project' end);
      end if;
      if v_dmg > 0 then
        insert into stock_lots (item_id, location_id, lot_no, batch_no, source_type, source_id, received_date, unit_cost, qty_in, qty_on_hand,
                                vendor_id, project_id, status, hold_reason)
        values (l.item_id, v_qa, g.grn_no || '-' || l.line_no || '-DMG', l.batch_no, 'GRN', l.id, g.grn_date, v_cost, v_dmg, v_dmg,
                g.vendor_id, v_proj, 'HOLD', 'DAMAGED')
        returning id into v_lot;
        insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value, doc_type, doc_id, doc_no, doc_line_id, project_id, remarks)
        values (g.grn_date, 'GRN', l.item_id, v_qa, v_lot, v_dmg, v_cost, round(v_dmg * v_cost, 2), 'GRN', g.id, g.grn_no, l.id, v_proj, 'Damaged on receipt — on hold');
      end if;
      if v_exc > 0 then
        insert into stock_lots (item_id, location_id, lot_no, batch_no, source_type, source_id, received_date, unit_cost, qty_in, qty_on_hand,
                                vendor_id, project_id, status, hold_reason)
        values (l.item_id, v_qa, g.grn_no || '-' || l.line_no || '-EXC', l.batch_no, 'GRN', l.id, g.grn_date, v_cost, v_exc, v_exc,
                g.vendor_id, v_proj, 'HOLD', 'EXCESS')
        returning id into v_lot;
        insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value, doc_type, doc_id, doc_no, doc_line_id, project_id, remarks)
        values (g.grn_date, 'GRN', l.item_id, v_qa, v_lot, v_exc, v_cost, round(v_exc * v_cost, 2), 'GRN', g.id, g.grn_no, l.id, v_proj, 'Excess over PO — awaiting Purchase decision');
      end if;
    end if;

    if l.rate > 0 then update items set last_purchase_rate = v_cost where id = l.item_id; end if;
    if g.receipt_type = 'PO' then
      insert into item_vendors (item_id, vendor_id, price, currency) values (l.item_id, g.vendor_id, l.rate, g.currency)
      on conflict (item_id, vendor_id) do update set price = excluded.price, currency = excluded.currency;
    end if;

    -- damaged -> automatic draft purchase return
    if v_dmg > 0 and g.vendor_id is not null then
      if v_prt is null then
        insert into purchase_returns (vendor_id, grn_id, return_type, status, reason)
        values (g.vendor_id, g.id, 'REJECTED_AT_GRN', 'DRAFT', 'Damaged on receipt — ' || g.grn_no)
        returning id into v_prt;
      end if;
      insert into prt_lines (prt_id, grn_line_id, item_id, qty, rate_aed, vat_rate) values (v_prt, l.id, l.item_id, v_dmg, v_cost, l.vat_rate);
      v_prt_n := v_prt_n + 1;
    end if;
    v_exc_total := v_exc_total + v_exc;
  end loop;

  if g.receipt_type = 'PO' then
    update purchase_orders set status = case
        when not exists (select 1 from po_lines where po_id = g.po_id and received_qty < qty) then 'RECEIVED'
        else 'PARTIALLY_RECEIVED' end
     where id = g.po_id;
  end if;
  update grns set status = 'POSTED', posted_at = now(), posted_by = auth.uid() where id = p_grn;
  insert into audit_log (entity, entity_id, action, details) values ('grn', p_grn, 'POSTED', jsonb_build_object('grn_no', g.grn_no));

  if v_prt is not null then
    perform notify('purchase', null, 'Damaged goods on ' || g.grn_no, v_prt_n || ' line(s) held in Quarantine — review the draft purchase return', 'd/prt/' || v_prt, 'prt', v_prt);
  end if;
  if v_exc_total > 0 then
    perform notify('purchase', null, 'Excess received on ' || g.grn_no, 'Accept it (PO amended) or return it to the supplier', 'holds', 'grn', g.id);
  end if;
end $$;

-- ---------- excess decision: accept into the PO, or return to supplier ----------
create or replace function public.grn_excess_decide(p_lot uuid, p_action text) returns text
language plpgsql security definer set search_path = public as $$
declare lot stock_lots%rowtype; gl grn_lines%rowtype; g grns%rowtype; v_dest uuid; v_prt uuid; v_cost numeric; v_po text;
begin
  select * into lot from stock_lots where id = p_lot for update;
  if not found or lot.hold_reason is distinct from 'EXCESS' or lot.qty_on_hand <= 0 then raise exception 'This is not open excess stock'; end if;
  select * into gl from grn_lines where id = lot.source_id;
  select * into g from grns where id = gl.grn_id;

  if p_action = 'ACCEPT' then
    if not has_role('purchase') then raise exception 'Only Purchase can accept excess'; end if;
    if gl.po_line_id is null then raise exception 'Excess can only be accepted against a PO line'; end if;
    update po_lines set qty = qty + lot.qty_on_hand, received_qty = received_qty + lot.qty_on_hand where id = gl.po_line_id;
    update grn_lines set accepted_qty = accepted_qty + lot.qty_on_hand, excess_qty = greatest(excess_qty - lot.qty_on_hand, 0) where id = gl.id;
    v_dest := coalesce(gl.location_id, g.location_id, (select id from locations where code = 'MS'));
    v_cost := lot_issue_cost(lot.id);
    insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value, doc_type, doc_id, doc_no, doc_line_id, project_id, remarks)
    values (current_date, 'TRANSFER_OUT', lot.item_id, lot.location_id, lot.id, -lot.qty_on_hand, v_cost, -round(lot.qty_on_hand * v_cost, 2), 'GRN', g.id, g.grn_no, gl.id, lot.project_id, 'Excess accepted'),
           (current_date, 'TRANSFER_IN', lot.item_id, v_dest, lot.id, lot.qty_on_hand, v_cost, round(lot.qty_on_hand * v_cost, 2), 'GRN', g.id, g.grn_no, gl.id, lot.project_id, 'Excess accepted into stock');
    update stock_lots set location_id = v_dest, status = 'AVAILABLE', hold_reason = null where id = lot.id;
    select po_no into v_po from purchase_orders where id = g.po_id;
    insert into audit_log (entity, entity_id, action, details)
    values ('purchase_order', g.po_id, 'EXCESS_ACCEPTED', jsonb_build_object('grn_no', g.grn_no, 'grn_line', gl.id, 'qty', lot.qty_on_hand));
    perform notify('factory_manager', null, 'PO ' || v_po || ' amended: excess accepted',
                   'GRN ' || g.grn_no || ' — qty ' || lot.qty_on_hand || ' added to the PO', 'd/po/' || g.po_id, 'po', g.po_id);
    return 'ACCEPTED';
  elsif p_action = 'RETURN' then
    if not has_role('purchase','stores') then raise exception 'Not allowed'; end if;
    insert into purchase_returns (vendor_id, grn_id, return_type, status, reason)
    values (g.vendor_id, g.id, 'REJECTED_AT_GRN', 'DRAFT', 'Excess over PO — ' || g.grn_no) returning id into v_prt;
    insert into prt_lines (prt_id, grn_line_id, item_id, qty, rate_aed, vat_rate, lot_id)
    values (v_prt, gl.id, lot.item_id, lot.qty_on_hand, lot.unit_cost, gl.vat_rate, lot.id);
    return v_prt::text;
  end if;
  raise exception 'Unknown action %', p_action;
end $$;
grant execute on function public.grn_excess_decide(uuid, text) to authenticated;
revoke execute on function public.grn_excess_decide(uuid, text) from anon;

-- ---------- purchase returns: held (damaged / excess) stock leaves Quarantine ----------
create or replace function public.post_purchase_return(p_prt uuid) returns void
language plpgsql security definer set search_path = public as $$
declare h purchase_returns%rowtype; g grns%rowtype; l record; lt record; v_done numeric; v_lot uuid;
        v_sub numeric := 0; v_vat numeric := 0; v_left numeric; v_take numeric; v_serial boolean;
begin
  if not has_role('stores','purchase') then raise exception 'Not allowed'; end if;
  select * into h from purchase_returns where id = p_prt for update;
  if h.status <> 'DRAFT' then raise exception 'Return is already %', h.status; end if;
  select * into g from grns where id = h.grn_id;
  if g.status <> 'POSTED' then raise exception 'GRN is not posted'; end if;

  for l in select pl.*, gl.grn_id src_grn, gl.rejected_qty, gl.accepted_qty, gl.po_line_id
             from prt_lines pl join grn_lines gl on gl.id = pl.grn_line_id where pl.prt_id = p_prt loop
    if l.src_grn <> h.grn_id then raise exception 'Line does not belong to GRN %', g.grn_no; end if;
    select c.tracking = 'SERIAL' into v_serial from items i join item_classes c on c.id = i.class_id where i.id = l.item_id;
    select coalesce(sum(x.qty),0) into v_done from prt_lines x join purchase_returns p on p.id = x.prt_id
     where x.grn_line_id = l.grn_line_id and p.status = 'POSTED' and p.return_type = h.return_type;

    if h.return_type = 'REJECTED_AT_GRN' then
      if l.qty + v_done > l.rejected_qty + 0.0005 then raise exception 'Return exceeds damaged / excess qty of the GRN line'; end if;
      if not v_serial then
        v_left := l.qty;
        for lt in select id, location_id, qty_on_hand, hold_reason from stock_lots
                   where source_type = 'GRN' and source_id = l.grn_line_id and hold_reason in ('DAMAGED','EXCESS') and qty_on_hand > 0
                     and (l.lot_id is null or id = l.lot_id)
                   order by (hold_reason = 'DAMAGED') desc, created_at loop
          exit when v_left <= 0.0005;
          v_take := least(v_left, lt.qty_on_hand);
          perform * from fifo_consume(l.item_id, lt.location_id, v_take, null, 'PURCHASE_RETURN', 'PRT', h.id, h.prt_no, l.id, h.return_date, null, null, lt.id, true);
          if lt.hold_reason = 'EXCESS' then update grn_lines set excess_qty = greatest(excess_qty - v_take, 0) where id = l.grn_line_id; end if;
          v_left := v_left - v_take;
        end loop;
        if v_left > 0.0005 then raise exception 'Only % held in Quarantine for this line', round(l.qty - v_left, 3); end if;
      end if;
    else
      if l.qty + v_done > l.accepted_qty + 0.0005 then raise exception 'Return exceeds accepted qty'; end if;
      select id into v_lot from stock_lots where source_type = 'GRN' and source_id = l.grn_line_id and hold_reason is null
       order by created_at limit 1;
      if v_lot is null then raise exception 'Original GRN lot not found (serialised items are returned from the asset register)'; end if;
      perform * from fifo_consume(l.item_id, (select location_id from stock_lots where id = v_lot), l.qty, null,
                                  'PURCHASE_RETURN', 'PRT', h.id, h.prt_no, l.id, h.return_date, null, null, v_lot, true);
      if l.po_line_id is not null then
        update po_lines set returned_qty = returned_qty + l.qty,
               received_qty = received_qty - case when h.replacement_required then l.qty else 0 end
         where id = l.po_line_id;
      end if;
    end if;
    v_sub := v_sub + l.amount;
    v_vat := v_vat + round(l.amount * l.vat_rate / 100, 2);
  end loop;

  if h.return_type = 'FROM_STOCK' and h.replacement_required and g.po_id is not null then
    update purchase_orders set status = 'PARTIALLY_RECEIVED' where id = g.po_id and status in ('RECEIVED','CLOSED');
  end if;
  update purchase_returns set status = 'POSTED', subtotal = v_sub, vat_amount = v_vat, total_amount = v_sub + v_vat,
         posted_at = now(), posted_by = auth.uid() where id = p_prt;
end $$;

-- ---------- material returns: shared core (no role check) + floor submission ----------
create or replace function public.post_return_core(p_ret uuid) returns void
language plpgsql security definer set search_path = public as $$
declare h material_returns%rowtype; iss material_issues%rowtype; l record; a record; v_lot stock_lots%rowtype;
        v_loc uuid; v_left numeric; v_take numeric; v_val numeric; v_total numeric := 0; v_new uuid;
begin
  select * into h from material_returns where id = p_ret for update;
  if h.status not in ('DRAFT','SUBMITTED') then raise exception 'Return is already %', h.status; end if;
  select * into iss from material_issues where id = h.issue_id;
  if iss.status <> 'POSTED' then raise exception 'Source issue is not posted'; end if;

  for l in select rl.*, il.issue_id src_issue, il.qty issued_qty, il.returned_qty already
             from return_lines rl join issue_lines il on il.id = rl.issue_line_id
            where rl.return_id = p_ret for update of il loop
    if l.src_issue <> h.issue_id then raise exception 'Return line does not belong to issue %', iss.issue_no; end if;
    continue when l.qty <= 0;
    if l.qty > l.issued_qty - l.already + 0.0005 then
      raise exception 'Return qty % exceeds un-returned balance %', l.qty, l.issued_qty - l.already;
    end if;
    v_loc := case when l.condition = 'GOOD' then h.to_location_id
                  else (select id from locations where loc_type = 'QUARANTINE' order by created_at limit 1) end;
    v_left := l.qty; v_val := 0;
    for a in select * from issue_line_lots where issue_line_id = l.issue_line_id and qty > returned_qty order by seq desc for update loop
      exit when v_left <= 0.0005;
      v_take := least(v_left, a.qty - a.returned_qty);
      select * into v_lot from stock_lots where id = a.lot_id;
      if item_valuation(l.item_id) = 'WAVG' then perform wavg_receive(l.item_id, v_take, a.unit_cost); end if;
      if l.condition = 'GOOD' and v_lot.location_id = v_loc and v_lot.status = 'AVAILABLE' then
        update stock_lots set qty_on_hand = qty_on_hand + v_take where id = v_lot.id;
        v_new := v_lot.id;
      else
        insert into stock_lots (item_id, location_id, lot_no, batch_no, source_type, source_id, parent_lot_id,
                                received_date, mfg_date, expiry_date, unit_cost, qty_in, qty_on_hand, vendor_id, project_id, status, hold_reason)
        values (l.item_id, v_loc, v_lot.lot_no, v_lot.batch_no, 'RETURN', l.id, v_lot.id, v_lot.received_date,
                v_lot.mfg_date, v_lot.expiry_date, a.unit_cost, v_take, v_take, v_lot.vendor_id, v_lot.project_id,
                case when l.condition = 'GOOD' then 'AVAILABLE' else 'HOLD' end,
                case when l.condition = 'GOOD' then null else 'RETURN_DAMAGED' end)
        returning id into v_new;
      end if;
      update issue_line_lots set returned_qty = returned_qty + v_take where id = a.id;
      insert into stock_ledger (txn_date, txn_type, item_id, location_id, lot_id, qty, unit_cost, value,
                                doc_type, doc_id, doc_no, doc_line_id, project_id, cost_center_id, remarks)
      values (h.return_date, 'RETURN', l.item_id, v_loc, v_new, v_take, a.unit_cost, round(v_take * a.unit_cost, 2),
              'RETURN', h.id, h.return_no, l.id, iss.project_id, iss.cost_center_id, l.condition);
      v_val := v_val + round(v_take * a.unit_cost, 2);
      v_left := v_left - v_take;
    end loop;
    update issue_lines set returned_qty = returned_qty + l.qty where id = l.issue_line_id;
    update return_lines set value = v_val where id = l.id;
    v_total := v_total + v_val;
  end loop;
  update material_returns set status = 'POSTED', total_value = v_total, posted_at = now(), posted_by = auth.uid() where id = p_ret;
end $$;
revoke execute on function public.post_return_core(uuid) from public, anon, authenticated;

create or replace function public.post_return(p_ret uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not has_role('stores') then raise exception 'Only Stores can post a return'; end if;
  perform post_return_core(p_ret);
end $$;

create or replace function public.return_action(p_ret uuid, p_action text) returns text
language plpgsql security definer set search_path = public as $$
declare h material_returns%rowtype; v_issue text;
begin
  select * into h from material_returns where id = p_ret for update;
  if not found then raise exception 'Return not found'; end if;
  if p_action = 'SUBMIT' then
    if not has_role('shop_floor','production_incharge','stores') then raise exception 'Not allowed'; end if;
    if h.status <> 'DRAFT' then raise exception 'Return is %', h.status; end if;
    if not exists (select 1 from return_lines where return_id = p_ret and qty > 0) then raise exception 'Enter at least one return quantity'; end if;
    update return_lines set requested_qty = qty where return_id = p_ret;
    update material_returns set status = 'SUBMITTED', submitted_at = now(), requested_by = coalesce(requested_by, auth.uid()) where id = p_ret;
    select issue_no into v_issue from material_issues where id = h.issue_id;
    perform notify('stores', null, 'Material return ' || h.return_no || ' from the floor', 'Verify and receive · against ' || v_issue, 'd/ret/' || p_ret, 'ret', p_ret);
    return 'SUBMITTED';
  elsif p_action = 'CANCEL' then
    if h.status not in ('DRAFT','SUBMITTED') then raise exception 'Return is %', h.status; end if;
    update material_returns set status = 'CANCELLED' where id = p_ret;
    return 'CANCELLED';
  end if;
  raise exception 'Unknown action %', p_action;
end $$;
grant execute on function public.return_action(uuid, text) to authenticated;
revoke execute on function public.return_action(uuid, text) from anon;

-- floor can draft returns; Stores edits (verifies) drafts and submitted returns
drop policy doc_insert on material_returns;
drop policy doc_update on material_returns;
drop policy doc_delete on material_returns;
drop policy line_write on return_lines;
create policy doc_insert on material_returns for insert to authenticated
  with check (public.has_role('stores','shop_floor','production_incharge') and status = 'DRAFT');
create policy doc_update on material_returns for update to authenticated
  using ((public.has_role('shop_floor','production_incharge') and status = 'DRAFT') or (public.has_role('stores') and status in ('DRAFT','SUBMITTED')))
  with check ((public.has_role('shop_floor','production_incharge') and status = 'DRAFT') or (public.has_role('stores') and status in ('DRAFT','SUBMITTED')));
create policy doc_delete on material_returns for delete to authenticated
  using (public.has_role('stores','shop_floor','production_incharge') and status = 'DRAFT');
create policy line_write on return_lines for all to authenticated
  using (exists (select 1 from material_returns h where h.id = return_lines.return_id and
                 ((public.has_role('shop_floor','production_incharge') and h.status = 'DRAFT') or (public.has_role('stores') and h.status in ('DRAFT','SUBMITTED')))))
  with check (exists (select 1 from material_returns h where h.id = return_lines.return_id and
                 ((public.has_role('shop_floor','production_incharge') and h.status = 'DRAFT') or (public.has_role('stores') and h.status in ('DRAFT','SUBMITTED')))));

-- ---------- floor acknowledgement: good / damaged / short / excess ----------
-- p_lines: [{"line_id": "...", "received_qty": good qty, "damaged_qty": damaged qty}]
drop function if exists public.issue_acknowledge(uuid, jsonb, text);
create or replace function public.issue_acknowledge(p_issue uuid, p_lines jsonb default '[]', p_remarks text default null)
returns text language plpgsql security definer set search_path = public as $$
declare h material_issues%rowtype; l record; v_good numeric; v_dmg numeric; v_short boolean := false; v_over boolean := false;
        v_any_dmg boolean := false; v_ret uuid; v_n int := 0; v_status text;
begin
  if not has_role('shop_floor','production_incharge') then raise exception 'Only shop-floor users can acknowledge receipt'; end if;
  select * into h from material_issues where id = p_issue for update;
  if not found then raise exception 'Issue not found'; end if;
  if h.status <> 'POSTED' then raise exception 'Issue is not posted yet'; end if;
  if h.ack_status is distinct from 'PENDING' then raise exception 'Receipt already %', lower(coalesce(h.ack_status, 'n/a')); end if;

  for l in select * from issue_lines where issue_id = p_issue order by line_no loop
    select (x->>'received_qty')::numeric, (x->>'damaged_qty')::numeric into v_good, v_dmg
      from jsonb_array_elements(coalesce(p_lines, '[]')) x where (x->>'line_id')::uuid = l.id;
    v_dmg := coalesce(v_dmg, 0);
    v_good := coalesce(v_good, l.qty - v_dmg);
    if v_good < 0 or v_dmg < 0 then raise exception 'Quantities cannot be negative'; end if;
    if v_good + v_dmg < l.qty - 0.0005 then v_short := true; end if;
    if v_good + v_dmg > l.qty + 0.0005 then v_over := true; end if;
    if v_dmg > l.qty - l.returned_qty + 0.0005 then raise exception 'Damaged qty exceeds what was issued'; end if;
    update issue_lines set received_qty = v_good, damaged_qty = v_dmg where id = l.id;
    if v_dmg > 0 then
      v_any_dmg := true;
      if v_ret is null then
        insert into material_returns (issue_id, to_location_id, status, returned_by_name, remarks, requested_by)
        values (p_issue, (select id from locations where loc_type = 'QUARANTINE' order by created_at limit 1), 'DRAFT',
                (select coalesce(nullif(full_name, ''), email) from profiles where id = auth.uid()), 'Damaged on receipt at shop floor', auth.uid())
        returning id into v_ret;
      end if;
      v_n := v_n + 1;
      insert into return_lines (return_id, issue_line_id, item_id, qty, requested_qty, condition, reason)
      values (v_ret, l.id, l.item_id, v_dmg, v_dmg, 'DAMAGED', 'Damaged on receipt at floor');
      -- damaged units no longer count as issued against the request, so Stores can issue a replacement
      if l.mr_line_id is not null then
        update mr_lines set issued_qty = greatest(issued_qty - v_dmg, 0) where id = l.mr_line_id;
      end if;
    end if;
  end loop;

  if (v_short or v_over or v_any_dmg) and coalesce(p_remarks, '') = '' then
    raise exception 'Explain the short / excess / damage in the remarks';
  end if;
  if v_ret is not null then
    perform post_return_core(v_ret);
    if h.mr_id is not null then
      update material_requests set status = 'PARTIALLY_ISSUED' where id = h.mr_id and status in ('ISSUED','CLOSED');
    end if;
  end if;

  v_status := case when v_short or v_over then 'DISCREPANCY' else 'ACKNOWLEDGED' end;
  update material_issues set ack_status = v_status, ack_by = auth.uid(), ack_at = now(), ack_remarks = p_remarks where id = p_issue;
  if v_any_dmg then
    perform notify('stores', null, 'Damaged material returned from floor: ' || h.issue_no,
                   v_n || ' item(s) in Quarantine — re-issue replacement, claim or scrap', 'holds', 'issue', p_issue);
  end if;
  return v_status;
end $$;
grant execute on function public.issue_acknowledge(uuid, jsonb, text) to authenticated;
revoke execute on function public.issue_acknowledge(uuid, jsonb, text) from anon;

-- ---------- hold stock (quarantine) view ----------
create or replace view public.v_hold_stock with (security_invoker = true) as
select l.id lot_id, l.hold_reason, l.item_id, i.code item_code, i.name item_name, u.code uom, l.lot_no, l.qty_on_hand, l.unit_cost,
       round(l.qty_on_hand * l.unit_cost, 2) value, l.created_at, current_date - l.created_at::date age_days, l.location_id, loc.code location_code,
       l.project_id, p.code project_code, l.vendor_id, v.name vendor_name,
       g.id grn_id, g.grn_no, pr.po_no, gl.id grn_line_id
  from stock_lots l
  join items i on i.id = l.item_id join uoms u on u.id = i.uom_id join locations loc on loc.id = l.location_id
  left join projects p on p.id = l.project_id
  left join vendors v on v.id = l.vendor_id
  left join grn_lines gl on l.source_type = 'GRN' and gl.id = l.source_id
  left join grns g on g.id = gl.grn_id
  left join purchase_orders pr on pr.id = g.po_id
 where l.status = 'HOLD' and l.qty_on_hand > 0;

-- ---------- supplier receipt exceptions (short vs DN, damaged, excess) ----------
create or replace view public.v_grn_exceptions with (security_invoker = true) as
select g.id grn_id, g.grn_no, g.grn_date, v.name vendor_name, po.po_no, g.vendor_dn_no, i.code item_code, i.name item_name, u.code uom,
       gl.dn_qty, gl.received_qty, gl.damaged_qty, gl.accepted_qty, gl.excess_qty, gl.short_qty, gl.rejection_reason, gl.unit_cost_aed
  from grn_lines gl join grns g on g.id = gl.grn_id and g.status = 'POSTED'
  join items i on i.id = gl.item_id join uoms u on u.id = i.uom_id
  left join vendors v on v.id = g.vendor_id left join purchase_orders po on po.id = g.po_id
 where gl.damaged_qty > 0 or gl.short_qty > 0 or gl.received_qty - gl.damaged_qty > gl.accepted_qty;
