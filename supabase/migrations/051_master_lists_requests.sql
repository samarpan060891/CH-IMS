-- 051 No manual entries for parameters
-- * Drop-down lists (departments, designations, nationalities, banks, brands, unit types, rooms / areas, accommodation …)
--   kept in one table; fields pick from them instead of free text.
-- * Master-data requests: when a supplier, customer, ledger account / cost head, cost centre, item, project, employee,
--   work centre, unit of measure or list value is missing, the user requests it; the responsible role creates it
--   (list values are added on approval), and the requester is told it can now be selected.
-- * Scrap buyers are customers.

create table lookup_values (
  id         uuid primary key default gen_random_uuid(),
  list_key   text not null check (list_key in ('DEPARTMENT','DESIGNATION','NATIONALITY','BANK','BRAND','UNIT_TYPE','ROOM','ACCOMMODATION')),
  value      text not null,
  sort_order int not null default 50,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (list_key, value)
);
insert into lookup_values (list_key, value, sort_order) select 'DEPARTMENT', v, n from unnest(array['Production','Stores','Purchase','Projects & site','Installation','Quality control','Design & estimation','Finance','HR & admin','Sales','Maintenance','Logistics']) with ordinality t(v, n);
insert into lookup_values (list_key, value, sort_order) select 'DESIGNATION', v, n from unnest(array['Carpenter','Helper','Machine operator','CNC operator','Edge bander operator','Polisher / painter','Fitter / installer','Foreman','Supervisor','Production in-charge','Site supervisor','Store keeper','Driver','Draftsman','Estimator','Purchase officer','Accountant','HR officer','Factory manager']) with ordinality t(v, n);
insert into lookup_values (list_key, value, sort_order) select 'NATIONALITY', v, n from unnest(array['India','Pakistan','Bangladesh','Nepal','Sri Lanka','Philippines','Egypt','Syria','Jordan','Lebanon','Sudan','Uganda','Kenya','Ghana','Nigeria','United Arab Emirates','Other']) with ordinality t(v, n);
insert into lookup_values (list_key, value, sort_order) select 'BANK', v, n from unnest(array['Emirates NBD','First Abu Dhabi Bank','Abu Dhabi Commercial Bank','Dubai Islamic Bank','Abu Dhabi Islamic Bank','Mashreq','RAKBANK','Commercial Bank of Dubai','Emirates Islamic','Sharjah Islamic Bank','Ajman Bank','National Bank of Fujairah','HSBC','Standard Chartered','Citibank']) with ordinality t(v, n);
insert into lookup_values (list_key, value, sort_order) select 'BRAND', v, n from unnest(array['Egger','Kronospan','Blum','Hettich','Häfele','Grass','Salice','Titus','Rehau']) with ordinality t(v, n);
insert into lookup_values (list_key, value, sort_order) select 'UNIT_TYPE', v, n from unnest(array['Studio','1 BR','2 BR','3 BR','4 BR','Penthouse','Townhouse','Villa','Retail','Office']) with ordinality t(v, n);
insert into lookup_values (list_key, value, sort_order) select 'ROOM', v, n from unnest(array['Kitchen','Pantry','Laundry','Master bedroom','Bedroom 2','Bedroom 3','Bedroom 4','Living','Dining','Entrance / foyer','Master bathroom','Bathroom 2','Powder room','Maid room','Store','Balcony','Corridor']) with ordinality t(v, n);
-- whatever is already typed in becomes a defined value so nothing is lost
insert into lookup_values (list_key, value) select distinct 'DEPARTMENT', department from employees where nullif(trim(department), '') is not null on conflict do nothing;
insert into lookup_values (list_key, value) select distinct 'DESIGNATION', designation from employees where nullif(trim(designation), '') is not null on conflict do nothing;
insert into lookup_values (list_key, value) select distinct 'NATIONALITY', nationality from employees where nullif(trim(nationality), '') is not null on conflict do nothing;
insert into lookup_values (list_key, value) select distinct 'ACCOMMODATION', accommodation from employees where nullif(trim(accommodation), '') is not null on conflict do nothing;
insert into lookup_values (list_key, value) select distinct 'BRAND', brand from items where nullif(trim(brand), '') is not null on conflict do nothing;
insert into lookup_values (list_key, value) select distinct 'BANK', bank_name from vendors where nullif(trim(bank_name), '') is not null on conflict do nothing;
insert into lookup_values (list_key, value) select distinct 'UNIT_TYPE', unit_type from project_units where nullif(trim(unit_type), '') is not null on conflict do nothing;
insert into lookup_values (list_key, value) select distinct 'UNIT_TYPE', unit_type from boq_lines where nullif(trim(unit_type), '') is not null on conflict do nothing;

-- who looks after each list / master
create or replace function public.master_owner_roles(p_kind text, p_list text default null) returns app_role[]
language sql immutable as $$
  select case p_kind
    when 'VENDOR' then array['purchase','finance']::app_role[]
    when 'CUSTOMER' then array['finance']::app_role[]
    when 'GL_ACCOUNT' then array['finance']::app_role[]
    when 'COST_CENTER' then array['finance','factory_manager']::app_role[]
    when 'ITEM' then array['stores','purchase']::app_role[]
    when 'UOM' then array['stores','purchase']::app_role[]
    when 'PROJECT' then array['factory_manager']::app_role[]
    when 'EMPLOYEE' then array['hr_officer']::app_role[]
    when 'WORK_CENTER' then array['factory_manager']::app_role[]
    when 'LOOKUP' then case p_list when 'BANK' then array['finance']::app_role[] when 'BRAND' then array['stores','purchase']::app_role[]
                                   when 'UNIT_TYPE' then array['factory_manager']::app_role[] when 'ROOM' then array['factory_manager','production_incharge']::app_role[]
                                   else array['hr_officer']::app_role[] end
    else array['admin']::app_role[] end
$$;

alter table lookup_values enable row level security;
create policy read_active on lookup_values for select to authenticated using (public.is_active_user());
create policy owner_write on lookup_values for all to authenticated
  using (public.has_role(variadic public.master_owner_roles('LOOKUP', list_key)))
  with check (public.has_role(variadic public.master_owner_roles('LOOKUP', list_key)));

create table master_requests (
  id            uuid primary key default gen_random_uuid(),
  req_no        text not null unique default next_doc_no('MDR'),
  req_date      date not null default current_date,
  kind          text not null check (kind in ('VENDOR','CUSTOMER','GL_ACCOUNT','COST_CENTER','ITEM','UOM','PROJECT','EMPLOYEE','WORK_CENTER','LOOKUP')),
  list_key      text,
  name          text not null,
  details       text,
  context       text,
  status        text not null default 'PENDING' check (status in ('PENDING','CREATED','REJECTED','CANCELLED')),
  created_ref   uuid,
  created_value text,
  comments      text,
  requested_by  uuid default auth.uid() references profiles(id),
  created_at    timestamptz not null default now(),
  handled_by    uuid references profiles(id), handled_at timestamptz
);

create or replace function public.master_request_create(p_kind text, p_name text, p_details text default null, p_list text default null, p_context text default null)
returns text language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_no text; r app_role; v_noun text;
begin
  if not is_active_user() then raise exception 'Sign in first'; end if;
  if nullif(trim(p_name), '') is null then raise exception 'Enter the name of what is needed'; end if;
  if p_kind = 'LOOKUP' and exists (select 1 from lookup_values where list_key = p_list and lower(value) = lower(trim(p_name)) and is_active) then raise exception '"%" already exists in the list — pick it', trim(p_name); end if;
  if exists (select 1 from master_requests where kind = p_kind and coalesce(list_key, '') = coalesce(p_list, '') and lower(name) = lower(trim(p_name)) and status = 'PENDING') then
    raise exception 'A request for "%" is already waiting', trim(p_name);
  end if;
  insert into master_requests (kind, list_key, name, details, context) values (p_kind, p_list, trim(p_name), p_details, p_context) returning id, req_no into v_id, v_no;
  v_noun := lower(replace(coalesce(p_list, p_kind), '_', ' '));
  foreach r in array master_owner_roles(p_kind, p_list) loop
    perform notify(r, null, 'New ' || v_noun || ' requested: ' || trim(p_name), coalesce(p_details, '') || coalesce(' · for ' || p_context, ''), 'd/mdr/' || v_id, 'mdr', v_id);
  end loop;
  return v_no;
end $$;

create or replace function public.master_request_resolve(p_id uuid, p_action text, p_ref uuid default null, p_value text default null, p_comments text default null)
returns text language plpgsql security definer set search_path = public as $$
declare q master_requests%rowtype; v text;
begin
  select * into q from master_requests where id = p_id for update;
  if not found then raise exception 'Request not found'; end if;
  if p_action = 'CANCEL' then
    if q.requested_by is distinct from auth.uid() and not has_role(variadic master_owner_roles(q.kind, q.list_key)) then raise exception 'Not allowed'; end if;
    if q.status <> 'PENDING' then raise exception 'Request is %', q.status; end if;
    update master_requests set status = 'CANCELLED' where id = p_id; return 'CANCELLED';
  end if;
  if not has_role(variadic master_owner_roles(q.kind, q.list_key)) then raise exception 'Only % can handle this request', array_to_string(master_owner_roles(q.kind, q.list_key), ' / '); end if;
  if q.status <> 'PENDING' then raise exception 'Request is %', q.status; end if;
  if p_action = 'CREATED' then
    if q.kind = 'LOOKUP' then
      v := coalesce(nullif(trim(p_value), ''), q.name);
      insert into lookup_values (list_key, value) values (q.list_key, v) on conflict (list_key, value) do update set is_active = true;
    elsif p_ref is null then raise exception 'Pick the record you created';
    end if;
    update master_requests set status = 'CREATED', created_ref = p_ref, created_value = coalesce(v, p_value), comments = p_comments, handled_by = auth.uid(), handled_at = now() where id = p_id;
    perform notify(null, q.requested_by, 'Ready: ' || coalesce(v, q.name), 'Your request ' || q.req_no || ' is done — you can now select it' || coalesce(' · ' || p_comments, ''), 'd/mdr/' || p_id, 'mdr', p_id);
    return 'CREATED';
  elsif p_action = 'REJECTED' then
    if nullif(trim(p_comments), '') is null then raise exception 'Say why (e.g. it already exists as …)'; end if;
    update master_requests set status = 'REJECTED', comments = p_comments, handled_by = auth.uid(), handled_at = now() where id = p_id;
    perform notify(null, q.requested_by, 'Request ' || q.req_no || ' not approved: ' || q.name, p_comments, 'd/mdr/' || p_id, 'mdr', p_id);
    return 'REJECTED';
  end if;
  raise exception 'Unknown action %', p_action;
end $$;

alter table master_requests enable row level security;
create policy mdr_read on master_requests for select to authenticated
  using (requested_by = auth.uid() or public.has_role(variadic public.master_owner_roles(kind, list_key)));

-- scrap buyers come from the customer master
alter table scrap_disposals add column customer_id uuid references customers(id);

grant execute on function public.master_request_create(text, text, text, text, text), public.master_request_resolve(uuid, text, uuid, text, text), public.master_owner_roles(text, text) to authenticated;
revoke execute on function public.master_request_create(text, text, text, text, text), public.master_request_resolve(uuid, text, uuid, text, text) from anon;
