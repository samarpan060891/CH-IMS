-- 051b Requests can also be raised from the "Requests for new entries" screen: checks and notifications move to triggers.
-- Owners follow who maintains each master in the app.

create or replace function public.master_owner_roles(p_kind text, p_list text default null) returns app_role[]
language sql immutable as $$
  select case p_kind
    when 'VENDOR' then array['purchase','finance']::app_role[]
    when 'CUSTOMER' then array['finance','factory_manager']::app_role[]
    when 'GL_ACCOUNT' then array['finance']::app_role[]
    when 'COST_CENTER' then array['finance','factory_manager']::app_role[]
    when 'ITEM' then array['stores','purchase']::app_role[]
    when 'UOM' then array['stores','purchase']::app_role[]
    when 'PROJECT' then array['factory_manager','finance']::app_role[]
    when 'EMPLOYEE' then array['hr_officer','factory_manager']::app_role[]
    when 'WORK_CENTER' then array['factory_manager','finance']::app_role[]
    when 'LOOKUP' then case p_list when 'BANK' then array['finance']::app_role[] when 'BRAND' then array['stores','purchase']::app_role[]
                                   when 'UNIT_TYPE' then array['factory_manager']::app_role[] when 'ROOM' then array['factory_manager','production_incharge']::app_role[]
                                   else array['hr_officer']::app_role[] end
    else array['admin']::app_role[] end
$$;

alter table master_requests add constraint master_requests_list_chk check (kind <> 'LOOKUP' or list_key in ('DEPARTMENT','DESIGNATION','NATIONALITY','BANK','BRAND','UNIT_TYPE','ROOM','ACCOMMODATION'));

create or replace function public.trg_mdr_check() returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.name := trim(new.name);
  if new.name = '' then raise exception 'Enter the name of what is needed'; end if;
  new.status := 'PENDING'; new.requested_by := coalesce(auth.uid(), new.requested_by);
  new.created_ref := null; new.created_value := null; new.handled_by := null; new.handled_at := null;
  if new.kind <> 'LOOKUP' then new.list_key := null; end if;
  if new.kind = 'LOOKUP' and exists (select 1 from lookup_values where list_key = new.list_key and lower(value) = lower(new.name) and is_active) then
    raise exception '"%" is already in the list — pick it', new.name;
  end if;
  if exists (select 1 from master_requests where kind = new.kind and coalesce(list_key, '') = coalesce(new.list_key, '') and lower(name) = lower(new.name) and status = 'PENDING') then
    raise exception 'A request for "%" is already waiting', new.name;
  end if;
  return new;
end $$;
create trigger mdr_check before insert on master_requests for each row execute function trg_mdr_check();

create or replace function public.trg_mdr_notify() returns trigger language plpgsql security definer set search_path = public as $$
declare r app_role; v_noun text := lower(replace(coalesce(new.list_key, new.kind), '_', ' '));
begin
  foreach r in array master_owner_roles(new.kind, new.list_key) loop
    perform notify(r, null, 'New ' || v_noun || ' requested: ' || new.name,
      coalesce(new.details, '') || coalesce(' · for ' || new.context, ''), 'd/mdr/' || new.id, 'mdr', new.id);
  end loop;
  return null;
end $$;
create trigger mdr_notify after insert on master_requests for each row execute function trg_mdr_notify();

create or replace function public.master_request_create(p_kind text, p_name text, p_details text default null, p_list text default null, p_context text default null)
returns text language plpgsql security definer set search_path = public as $$
declare v_no text;
begin
  if not is_active_user() then raise exception 'Sign in first'; end if;
  insert into master_requests (kind, list_key, name, details, context) values (p_kind, p_list, p_name, p_details, p_context) returning req_no into v_no;
  return v_no;
end $$;

create policy mdr_insert on master_requests for insert to authenticated with check (public.is_active_user());
