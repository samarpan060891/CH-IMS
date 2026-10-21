-- Citi Homes IMS - 027: BOQ-line inheritance trigger reads source columns through jsonb (shared by tables with different columns);
-- post_install_log: drop an unused record variable that shadowed a table alias (no-op when already fixed)
do $$ begin
  execute replace(pg_get_functiondef('public.post_install_log(uuid)'::regprocedure), 'c record; l record;', 'l record;');
end $$;

create or replace function public.trg_boq_inherit() returns trigger
language plpgsql security definer set search_path = public as $$
declare j jsonb := to_jsonb(new); v uuid;
begin
  if new.boq_line_id is null then
    if tg_table_name = 'po_lines' then
      select boq_line_id into v from pr_lines where id = (j->>'pr_line_id')::uuid;
    elsif tg_table_name = 'grn_lines' then
      select boq_line_id into v from po_lines where id = (j->>'po_line_id')::uuid;
    elsif tg_table_name = 'production_orders' then
      select boq_line_id into v from production_orders where id = (j->>'parent_wo_id')::uuid;
    elsif tg_table_name = 'dispatch_lines' then
      select boq_line_id into v from production_orders where id = (j->>'production_order_id')::uuid;
    end if;
    new.boq_line_id := v;
  end if;
  return new;
end $$;
