-- Internal helpers must only run inside the posting functions (which execute as owner)
revoke execute on function public.fifo_consume(uuid,uuid,numeric,uuid,text,text,uuid,text,uuid,date,uuid,uuid,uuid,boolean) from authenticated;
revoke execute on function public.wavg_receive(uuid,numeric,numeric) from authenticated;
revoke execute on function public.next_asset_tag(text) from authenticated;
revoke execute on function public.lot_issue_cost(uuid) from authenticated;
revoke execute on function public.handle_new_user() from authenticated;
revoke execute on function public.po_lines_recalc() from authenticated;
revoke execute on function public.pr_ordered_sync() from authenticated;
revoke execute on function public.vil_recalc() from authenticated;
revoke execute on function public.disposal_lines_recalc() from authenticated;
-- next_doc_no stays executable: it is evaluated as a column default by the inserting user

alter function public.touch_updated_at() set search_path = public;
alter function public.items_guard()      set search_path = public;
alter function public.assets_guard()     set search_path = public;
alter function public.profiles_guard()   set search_path = public;
