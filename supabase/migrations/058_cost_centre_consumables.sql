-- 058 Consumables, packing and machine spares can again be requested / issued straight to a cost centre (factory, maintenance, camp …)
-- without an internal order. Other items (raw material, finished goods …) still go to a project, sales order or internal order.
alter table item_classes add column cost_centre_issue boolean not null default false;
update item_classes set cost_centre_issue = true where code in ('CON','PKG','SPR');

create or replace function public.trg_cc_issue_items() returns trigger language plpgsql security definer set search_path = public as $$
declare v_purpose text; v_bad text;
begin
  if tg_table_name = 'mr_lines' then select purpose into v_purpose from material_requests where id = new.mr_id;
  else select purpose into v_purpose from material_issues where id = new.issue_id; end if;
  if v_purpose = 'COST_CENTER' then
    select i.code || ' — ' || i.name into v_bad from items i join item_classes c on c.id = i.class_id where i.id = new.item_id and not c.cost_centre_issue;
    if v_bad is not null then
      raise exception '% cannot be issued to a cost centre — only consumables, packing and spares. Use a project, sales order or internal order.', v_bad;
    end if;
  end if;
  return new;
end $$;
create trigger mr_lines_cc_items before insert or update of item_id on mr_lines for each row execute function trg_cc_issue_items();
create trigger issue_lines_cc_items before insert or update of item_id on issue_lines for each row execute function trg_cc_issue_items();
