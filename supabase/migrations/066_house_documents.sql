-- 066 House document style (Citi Homes PO system): signatures per user, authorised signatory, PO wording,
-- payment schedule, and document numbers PREFIX-CH + YY-MM-NNN restarting each month.

-- ---------- signatures: one image per user (PNG data URL), shown on printed documents ----------
create table user_signatures (
  user_id uuid primary key references profiles(id) on delete cascade,
  image text not null check (length(image) < 400000 and image like 'data:image/%'),
  updated_at timestamptz not null default now()
);
alter table user_signatures enable row level security;
create policy read_active on user_signatures for select using (is_active_user());
create policy own_write on user_signatures for all using (user_id = auth.uid() or has_role('admin')) with check (user_id = auth.uid() or has_role('admin'));
alter table profiles add column if not exists job_title text;          -- printed under the signature (blank = role)

-- ---------- company: authorised signatory, document code, standard PO terms ----------
alter table company_settings
  add column if not exists doc_company_code text not null default 'CH',
  add column if not exists auth_sign_name text,
  add column if not exists auth_sign_title text,
  add column if not exists auth_sign_user_id uuid references profiles(id),
  add column if not exists po_terms_goods jsonb,
  add column if not exists po_terms_works jsonb;
update company_settings set
  auth_sign_name = coalesce(auth_sign_name, 'Usman Barkat'),
  auth_sign_title = coalesce(auth_sign_title, 'Chief Operating Officer (COO)'),
  po_terms_goods = coalesce(po_terms_goods, '[
    "Goods shall strictly conform to the specifications, grades, dimensions and quantities stated in this Purchase Order and the Supplier''s quotation / proforma invoice.",
    "Any variation in quantity, specification, brand, grade, finish or price shall require prior written approval from Citi Homes Management.",
    "All goods are subject to inspection and approval upon delivery. Goods not conforming to the specification may be rejected.",
    "The Supplier shall replace or rectify any damaged, defective or non-conforming goods at no additional cost.",
    "Delivery shall be made within {delivery_days} days from the date of this Purchase Order, to the delivery address stated above.",
    "The Supplier shall provide a Delivery Note and a Tax Invoice referencing this Purchase Order number upon delivery.",
    "Payment shall be made in accordance with the agreed payment terms, after satisfactory delivery and acceptance.",
    "Delays in delivery without prior approval may result in cancellation of this Purchase Order.",
    "{company} reserves the right to reject goods not meeting the required specifications and quality standards.",
    "This Purchase Order shall be governed by the applicable laws of the United Arab Emirates."]'::jsonb),
  po_terms_works = coalesce(po_terms_works, '[
    "Works shall be carried out strictly in accordance with the specifications, drawings, and adhering to quality standards.",
    "Any variation in quantity, specification, brand, finish, or scope shall require prior written approval from Citi Homes Management.",
    "All materials and workmanship are subject to inspection and approval upon delivery/completion.",
    "The Contractor shall replace or rectify any damaged, defective, or non-conforming work or materials at no additional cost.",
    "The Contractor shall ensure existing structure, plant & machinery safety. Any damage to existing infrastructure shall be claimed from the Contractor.",
    "Works shall be completed within the agreed schedule of {delivery_days} days.",
    "The Contractor shall provide a Delivery Note, Invoice, and other relevant documents upon completion/delivery.",
    "Payment shall be made in accordance with the agreed payment terms, after satisfactory delivery and acceptance. Final payment will be calculated on actual measurements where applicable.",
    "Delays in completion without prior approval may result in cancellation of this Purchase Order.",
    "{company} reserves the right to reject works or materials not meeting the required specifications and quality standards.",
    "This Purchase Order shall be governed by the applicable laws of the United Arab Emirates."]'::jsonb);

-- ---------- PO wording, delivery and payment schedule ----------
alter table purchase_orders
  add column if not exists subject text,
  add column if not exists award_text text,
  add column if not exists quote_label text default 'quotation',
  add column if not exists terms_set text not null default 'goods' check (terms_set in ('goods', 'works')),
  add column if not exists delivery_days int,
  add column if not exists delivery_address text,
  add column if not exists payment_type text check (payment_type in ('Cheque', 'Cash', 'Bank transfer')),
  add column if not exists quoted_total numeric;
create table po_payment_lines (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references purchase_orders(id) on delete cascade,
  line_no int,
  pct numeric not null check (pct > 0 and pct <= 100),
  text text not null
);
create index on po_payment_lines (po_id);
alter table po_payment_lines enable row level security;
create policy read_active on po_payment_lines for select using (is_active_user());
create policy po_pay_write on po_payment_lines for all
  using (has_role('purchase', 'factory_manager') and exists (select 1 from purchase_orders p where p.id = po_id and p.status in ('DRAFT', 'REJECTED')))
  with check (has_role('purchase', 'factory_manager') and exists (select 1 from purchase_orders p where p.id = po_id and p.status in ('DRAFT', 'REJECTED')));

-- ---------- numbering: PO-CH26-10-001 (type - company code + YY - MM - 3-digit sequence, monthly) ----------
alter table doc_sequences add column if not exists mon int not null default 0;
alter table doc_sequences drop constraint doc_sequences_pkey;
alter table doc_sequences add primary key (doc_type, yr, mon);
create or replace function next_doc_no(p_type text, p_date date default current_date)
returns text language plpgsql security definer set search_path = public as $$
declare v_no int; v_yr int := extract(year from p_date); v_mon int := extract(month from p_date);
        v_co text := coalesce((select nullif(doc_company_code, '') from company_settings limit 1), 'CH');
begin
  insert into doc_sequences (doc_type, yr, mon) values (p_type, v_yr, v_mon) on conflict (doc_type, yr, mon) do nothing;
  update doc_sequences set next_no = next_no + 1 where doc_type = p_type and yr = v_yr and mon = v_mon returning next_no - 1 into v_no;
  return p_type || '-' || v_co || to_char(p_date, 'YY') || '-' || to_char(p_date, 'MM') || '-'
         || case when v_no > 999 then v_no::text else lpad(v_no::text, 3, '0') end;
end $$;
-- payroll runs had the same prefix as vendor payments
alter table payroll_runs alter column run_no set default next_doc_no('PRL');
