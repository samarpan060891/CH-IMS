-- dbm_decide: clear the "coming from dbm_decide" flag once the item update is done
create or replace function public.dbm_decide(p_id uuid, p_action text, p_target numeric default null, p_comments text default null)
returns void language plpgsql security definer set search_path = public as $$
declare b buffer_suggestions%rowtype;
begin
  if not has_role('purchase','factory_manager') then raise exception 'Only Purchase or the Factory Manager can decide buffer changes'; end if;
  select * into b from buffer_suggestions where id = p_id for update;
  if not found or b.status <> 'PENDING' then raise exception 'Suggestion is no longer pending'; end if;
  if p_action = 'ACCEPT' then
    if coalesce(p_target, b.suggested_target) <= 0 then raise exception 'Target must be greater than zero'; end if;
    update buffer_suggestions set status = 'ACCEPTED', applied_target = coalesce(p_target, b.suggested_target),
           decided_by = auth.uid(), decided_at = now(), comments = p_comments where id = p_id;
    perform set_config('ims.dbm_decide', '1', true);
    update items set buffer_target = coalesce(p_target, b.suggested_target), buffer_adjusted_at = current_date where id = b.item_id;
    perform set_config('ims.dbm_decide', '', true);
  elsif p_action = 'REJECT' then
    update buffer_suggestions set status = 'REJECTED', decided_by = auth.uid(), decided_at = now(), comments = p_comments where id = p_id;
    update items set buffer_reviewed_at = current_date where id = b.item_id;
  else
    raise exception 'Unknown action %', p_action;
  end if;
end $$;
