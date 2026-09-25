-- =====================================================================
-- Citi Homes IMS - 001 Foundation & Master Data
-- =====================================================================
create extension if not exists pgcrypto;

-- ---------- Roles & users ----------
create type app_role as enum ('admin','purchase','stores','shop_floor','factory_manager','finance');

create table profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  full_name     text not null default '',
  email         text,
  role          app_role not null default 'shop_floor',
  employee_code text,
  is_active     boolean not null default false,   -- admin must activate
  created_at    timestamptz not null default now()
);

create or replace function public.my_role() returns app_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and is_active
$$;

-- admin always passes
create or replace function public.has_role(variadic roles app_role[]) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles
                 where id = auth.uid() and is_active
                   and (role = any(roles) or role = 'admin'))
$$;

create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and is_active)
$$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Company settings ----------
create table company_settings (
  id                 int primary key default 1 check (id = 1),
  company_name       text not null,
  trn                text,
  address            text,
  phone              text,
  email              text,
  base_currency      text not null default 'AED',
  default_vat_rate   numeric(5,2) not null default 5,
  logo_url           text,
  overstock_months   numeric(5,2) not null default 3,   -- stock cover above this = overstock
  abc_a_pct          numeric(5,2) not null default 70,  -- cumulative value % for A
  abc_b_pct          numeric(5,2) not null default 90,  -- cumulative value % for B
  updated_at         timestamptz not null default now()
);
insert into company_settings (company_name)
values ('Citi Homes Kitchen and Wooden Furniture Manufacturing LLC');

-- ---------- Document numbering ----------
create table doc_sequences (
  doc_type text not null,
  yr       int  not null,
  next_no  int  not null default 1,
  primary key (doc_type, yr)
);

create or replace function public.next_doc_no(p_type text, p_date date default current_date)
returns text language plpgsql security definer set search_path = public as $$
declare v_no int; v_yr int := extract(year from p_date);
begin
  insert into doc_sequences (doc_type, yr) values (p_type, v_yr)
  on conflict (doc_type, yr) do nothing;
  update doc_sequences set next_no = next_no + 1
   where doc_type = p_type and yr = v_yr
  returning next_no - 1 into v_no;
  return p_type || '/' || v_yr || '/' || lpad(v_no::text, 5, '0');
end $$;

-- generic updated_at trigger
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

-- ---------- Units of measure ----------
create table uoms (
  id    uuid primary key default gen_random_uuid(),
  code  text not null unique,
  name  text not null,
  decimals int not null default 2
);
insert into uoms (code, name, decimals) values
 ('NOS','Numbers',0),('PCS','Pieces',0),('SHT','Sheets',0),('SET','Set',0),('PR','Pair',0),
 ('BOX','Box',0),('ROL','Roll',2),('KG','Kilogram',3),('LTR','Litre',3),('MTR','Metre',2),
 ('SQM','Square Metre',3),('CBM','Cubic Metre',4),('CFT','Cubic Feet',3),('LM','Running Metre',2);

-- ---------- Item classification ----------
-- tracking: LOT = quantity stock in lots/batches; SERIAL = one asset record per unit
create table item_classes (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,
  name              text not null,
  valuation_method  text not null check (valuation_method in ('FIFO','WAVG','ASSET')),
  tracking          text not null default 'LOT' check (tracking in ('LOT','SERIAL')),
  is_returnable     boolean not null default false,   -- tool crib: issued to a person, must come back
  needs_calibration boolean not null default false,
  is_scrap          boolean not null default false,
  sort_order        int not null default 0,
  is_active         boolean not null default true
);
insert into item_classes (code,name,valuation_method,tracking,is_returnable,needs_calibration,is_scrap,sort_order) values
 ('RM',  'Raw Materials',                    'FIFO', 'LOT',    false,false,false,1),
 ('CON', 'Consumables',                      'WAVG', 'LOT',    false,false,false,2),
 ('PKG', 'Packing Materials',                'WAVG', 'LOT',    false,false,false,3),
 ('SPR', 'Machine Spares',                   'WAVG', 'LOT',    false,false,false,4),
 ('MAC', 'Machines (Assets)',                'ASSET','SERIAL', false,false,false,5),
 ('PWT', 'Power Tools',                      'ASSET','SERIAL', true, false,false,6),
 ('HNT', 'Hand Tools',                       'ASSET','SERIAL', true, false,false,7),
 ('MST', 'Measuring Tools',                  'ASSET','SERIAL', true, true, false,8),
 ('OFE', 'Office Equipment',                 'ASSET','SERIAL', false,false,false,9),
 ('LAE', 'Labour Accommodation Equipment',   'ASSET','SERIAL', false,false,false,10),
 ('SCR', 'Scrap',                            'WAVG', 'LOT',    false,false,true, 11);

create table item_categories (
  id        uuid primary key default gen_random_uuid(),
  class_id  uuid not null references item_classes(id),
  parent_id uuid references item_categories(id),
  code      text not null unique,
  name      text not null,
  is_active boolean not null default true
);
insert into item_categories (class_id, code, name)
select c.id, v.code, v.name from item_classes c
join (values
 ('RM','RM-BRD','Boards & Panels (MDF/Ply/Particle)'),('RM','RM-SWD','Solid Wood & Timber'),
 ('RM','RM-VEN','Veneers & Laminates'),('RM','RM-EDG','Edge Banding'),('RM','RM-HDW','Hardware & Fittings'),
 ('RM','RM-FIN','Paints, Lacquers & Stains'),('RM','RM-ADH','Adhesives'),('RM','RM-GLS','Glass & Mirrors'),
 ('RM','RM-CTP','Countertops & Stone'),('RM','RM-UPH','Upholstery & Fabric'),
 ('CON','CON-ABR','Abrasives & Sandpaper'),('CON','CON-FAS','Screws, Nails & Fasteners'),
 ('CON','CON-CUT','Cutting Blades & Bits'),('CON','CON-SAF','Safety & PPE'),('CON','CON-GEN','General Consumables'),
 ('PKG','PKG-GEN','Packing Materials'),
 ('SPR','SPR-GEN','Machine Spares'),
 ('MAC','MAC-CNC','CNC & Panel Saws'),('MAC','MAC-EDG','Edge Banders'),('MAC','MAC-SPR','Spray Booths & Compressors'),('MAC','MAC-GEN','Other Machines'),
 ('PWT','PWT-GEN','Power Tools'),('HNT','HNT-GEN','Hand Tools'),('MST','MST-GEN','Measuring Tools'),
 ('OFE','OFE-IT','IT Equipment'),('OFE','OFE-FUR','Office Furniture'),
 ('LAE','LAE-BED','Beds & Mattresses'),('LAE','LAE-APP','Appliances'),('LAE','LAE-GEN','Other Accommodation Items'),
 ('SCR','SCR-WOD','Wood Scrap & Offcuts'),('SCR','SCR-MET','Metal Scrap'),('SCR','SCR-GEN','Other Scrap')
) as v(cls, code, name) on v.cls = c.code;

-- ---------- Payment terms ----------
create table payment_terms (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null,
  credit_days int  not null default 0,
  basis       text not null default 'INVOICE' check (basis in ('INVOICE','GRN','EOM')), -- EOM = end of month of invoice + days
  advance_pct numeric(5,2) not null default 0,
  is_active   boolean not null default true
);
insert into payment_terms (code,name,credit_days,basis,advance_pct) values
 ('ADV100','100% Advance',0,'INVOICE',100),
 ('COD','Cash on Delivery',0,'GRN',0),
 ('NET30','30 Days from Invoice',30,'INVOICE',0),
 ('NET60','60 Days from Invoice',60,'INVOICE',0),
 ('NET90','90 Days from Invoice',90,'INVOICE',0),
 ('PDC60','60 Days PDC',60,'INVOICE',0),
 ('EOM30','30 Days after Month End',30,'EOM',0),
 ('ADV30B','30% Advance, Balance 30 Days',30,'INVOICE',30);

-- ---------- Vendors ----------
create table vendors (
  id                    uuid primary key default gen_random_uuid(),
  code                  text not null unique,
  name                  text not null,
  vendor_type           text not null default 'LOCAL' check (vendor_type in ('LOCAL','IMPORT')),
  vat_registered        boolean not null default true,
  trn                   text,                        -- UAE Tax Registration Number (15 digits)
  trade_license_no      text,
  trade_license_expiry  date,
  address               text,
  emirate               text,
  country               text not null default 'United Arab Emirates',
  contact_person        text,
  phone                 text,
  email                 text,
  currency              text not null default 'AED',
  payment_term_id       uuid references payment_terms(id),
  credit_limit          numeric(14,2),
  bank_name             text,
  bank_account_name     text,
  iban                  text,
  swift_code            text,
  supplies_classes      text[] not null default '{}',  -- class codes the vendor supplies
  rating                int check (rating between 1 and 5),
  status                text not null default 'ACTIVE' check (status in ('ACTIVE','ON_HOLD','BLOCKED')),
  remarks               text,
  created_by            uuid default auth.uid() references profiles(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint trn_format check (trn is null or trn ~ '^[0-9]{15}$')
);
create trigger vendors_touch before update on vendors for each row execute function touch_updated_at();

-- ---------- Locations (hierarchical) ----------
create table locations (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  name       text not null,
  loc_type   text not null check (loc_type in ('WAREHOUSE','ZONE','RACK','BIN','SHOP_FLOOR','QUARANTINE','SCRAP_YARD','LABOUR_CAMP','OFFICE','SITE')),
  parent_id  uuid references locations(id),
  is_stock   boolean not null default true,   -- stock held here counts in store inventory
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
insert into locations (code,name,loc_type,is_stock) values
 ('MS','Main Store','WAREHOUSE',true),
 ('QA','Quarantine / QC Hold','QUARANTINE',true),
 ('SF','Shop Floor','SHOP_FLOOR',false),
 ('SY','Scrap Yard','SCRAP_YARD',true),
 ('LC','Labour Camp','LABOUR_CAMP',false),
 ('OF','Office','OFFICE',false);

-- ---------- Employees (tool custody, accommodation, requesters) ----------
create table employees (
  id          uuid primary key default gen_random_uuid(),
  emp_code    text not null unique,
  name        text not null,
  department  text,
  designation text,
  is_active   boolean not null default true
);

-- ---------- Cost centres (non-project issues: maintenance, admin, camp ...) ----------
create table cost_centers (
  id        uuid primary key default gen_random_uuid(),
  code      text not null unique,
  name      text not null,
  is_active boolean not null default true
);
insert into cost_centers (code,name) values
 ('MNT','Maintenance'),('ADM','Administration'),('CAMP','Labour Camp'),('GEN','General Factory Overhead');

-- ---------- Projects / Make-to-stock orders ----------
create table projects (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  name         text not null,
  project_type text not null default 'PROJECT' check (project_type in ('PROJECT','MTS')),
  customer     text,
  site_address text,
  start_date   date,
  end_date     date,
  status       text not null default 'OPEN' check (status in ('OPEN','ON_HOLD','CLOSED')),
  budget_material numeric(14,2),
  created_by   uuid default auth.uid() references profiles(id),
  created_at   timestamptz not null default now()
);

-- ---------- Items ----------
create table items (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,
  name              text not null,
  description       text,
  class_id          uuid not null references item_classes(id),
  category_id       uuid references item_categories(id),
  uom_id            uuid not null references uoms(id),
  -- furniture-specific specs
  brand             text,
  specification     text,        -- grade, finish, colour
  length_mm         numeric(10,2),
  width_mm          numeric(10,2),
  thickness_mm      numeric(10,2),
  -- control flags
  valuation_override text check (valuation_override in ('FIFO','WAVG')),
  batch_controlled  boolean not null default true,
  has_expiry        boolean not null default false,   -- adhesives, lacquers -> FEFO
  shelf_life_days   int,
  vat_rate          numeric(5,2) not null default 5,
  -- buffer / reorder
  safety_stock      numeric(14,3) not null default 0,  -- buffer (red zone floor)
  reorder_level     numeric(14,3) not null default 0,
  reorder_qty       numeric(14,3) not null default 0,
  max_stock         numeric(14,3) not null default 0,
  moq               numeric(14,3) not null default 0,
  order_multiple    numeric(14,3) not null default 0,
  lead_time_days    int not null default 0,
  -- costing
  standard_cost     numeric(14,4) not null default 0,
  avg_cost          numeric(14,4) not null default 0,   -- maintained for WAVG items
  last_purchase_rate numeric(14,4),
  default_location_id uuid references locations(id),
  image_url         text,
  is_active         boolean not null default true,
  created_by        uuid default auth.uid() references profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index items_class_idx on items(class_id);
create trigger items_touch before update on items for each row execute function touch_updated_at();

create or replace function public.item_valuation(p_item uuid) returns text
language sql stable set search_path = public as $$
  select coalesce(i.valuation_override, c.valuation_method)
    from items i join item_classes c on c.id = i.class_id where i.id = p_item
$$;

-- vendor price list / approved sources
create table item_vendors (
  id              uuid primary key default gen_random_uuid(),
  item_id         uuid not null references items(id) on delete cascade,
  vendor_id       uuid not null references vendors(id) on delete cascade,
  vendor_item_code text,
  price           numeric(14,4),
  currency        text not null default 'AED',
  moq             numeric(14,3),
  lead_time_days  int,
  is_preferred    boolean not null default false,
  valid_to        date,
  unique (item_id, vendor_id)
);

-- ---------- Audit log ----------
create table audit_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  user_id    uuid default auth.uid(),
  entity     text not null,
  entity_id  uuid,
  action     text not null,
  details    jsonb
);
