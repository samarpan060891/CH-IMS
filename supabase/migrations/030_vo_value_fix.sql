-- Citi Homes IMS - 030: variation value on approval must be summed after the status is APPROVED
-- (v_vo_lines then uses the stored before / after values). No-op when 029 already contains the fix.
do $$
declare d text := pg_get_functiondef('public.vo_action(uuid, text, text)'::regprocedure);
begin
  if position('v_vo_lines reads the stored' in d) = 0 then
    execute replace(d, E'  end loop;\n  select coalesce(sum(value_change), 0)',
                       E'  end loop;\n  update variation_orders set status = ''APPROVED'' where id = p_vo;   -- v_vo_lines reads the stored before / after values once approved\n  select coalesce(sum(value_change), 0)');
  end if;
end $$;
