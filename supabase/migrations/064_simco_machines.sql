-- 064 SIMCO machine list as work centres (SIMCO_Machine_List.xlsx, 28 machines)
-- The 9 generic machine work centres become the matching SIMCO machines (same ids, so nothing linked to them breaks);
-- the rest are added. Compressors, air dryers, air tank and dust collector are UTILITY work centres: breakdowns,
-- PM and maintenance cost like any machine, but never a production stage (routing, production orders, job work).

alter table work_centers drop constraint work_centers_kind_check;
alter table work_centers add constraint work_centers_kind_check check (kind in ('MACHINE', 'MANUAL', 'UTILITY'));

create or replace function trg_no_utility_stage() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.work_center_id is not null and exists (select 1 from work_centers where id = new.work_center_id and kind = 'UTILITY') then
    raise exception 'A utility (compressor, dust collector …) cannot be a production stage';
  end if;
  return new;
end $$;
create trigger no_utility_stage before insert or update of work_center_id on bom_template_routing for each row execute function trg_no_utility_stage();
create trigger no_utility_stage before insert or update of work_center_id on wo_operations for each row execute function trg_no_utility_stage();
create trigger no_utility_stage before insert or update of work_center_id on sales_order_lines for each row execute function trg_no_utility_stage();
create trigger no_utility_stage before insert or update of work_center_id on quotation_lines for each row execute function trg_no_utility_stage();

-- generic → real machine (code, name, kW, route order)
update work_centers w set code = v.code, name = v.name, power_kw = v.kw, sort_order = v.so
  from (values ('TSZ', 'RIP-MJ143', 'MJ143E Automatic multi rip saw — HICAS', 39.57, 30),
               ('CUT', 'PNL-NPC330', 'NPC330 Panel dividing saw — Nanxing', 23.5, 40),
               ('PLT', 'PLN-PF530', 'PF 530N Surface planer — FIMAL', 4, 50),
               ('CNCD', 'CNC-ND612', 'ND612S CNC 6-sided drilling — Nanxing', 19.7, 120),
               ('CNCL', 'CNC-MDK4120', 'MDK4120D CNC lock hole & hinge slot — Yuton', 8.3, 130),
               ('CNCR', 'CNC-NCG2812', 'NCG2812E CNC router (nesting) — Nanxing', 24, 140),
               ('LATH', 'LTH-FM15030', 'FM15030 CNC wood lathe', 9, 150),
               ('EDG', 'EDG-NB7CJ', 'NB7CJ Edge bander (wood strip + coil tape) — Nanxing', 22, 190),
               ('SPR', 'SPR-ROOMS', 'Spray rooms — primer, top coater & dry room', 18.25, 240)) v(old, code, name, kw, so)
 where w.code = v.old;

insert into work_centers (code, name, kind, power_kw, hours_per_day, utilisation_pct, working_days_per_year, sort_order, is_active, default_grade_id)
select v.code, v.name, v.kind, v.kw, 9, 85, 312, v.so, true,
       case when v.kind = 'MACHINE' then (select id from labour_grades where code = 'CNC') end
  from (values ('SAW-Q45', 'Q45 Circular saw with scoring', 'MACHINE', 8.25, 10),
               ('SAW-RN900', 'RN 900 Radial arm saw — OMGA', 'MACHINE', 2.9, 20),
               ('THK-D963', 'D-963 S Thicknesser — Felder', 'MACHINE', 7.3, 60),
               ('MLD-F700', 'F700 Z Spindle moulder — Felder', 'MACHINE', 7.3, 70),
               ('MLD-PONE', 'P.ONE 4+ Universal five head moulder — Futura Metalstar', 'MACHINE', 23, 80),
               ('JNT-F9TS', 'F9TS Combined milling (frame joints) — OMEC', 'MACHINE', 9.5, 90),
               ('JNT-CMA72', 'CMA 72 Economy bit mortiser — CMA 2000', 'MACHINE', 2.24, 100),
               ('BOR-ALFA21', 'ALFA 21 Multi boring — Vitap', 'MACHINE', 1.86, 110),
               ('VNR-RJB3200', 'RJB3200 Hydraulic veneer clipper', 'MACHINE', 4, 160),
               ('VNR-MH1109', 'MH1109 Veneer splicer', 'MACHINE', 0.63, 170),
               ('PRS-PL70', 'PL 70 Hot press 3000x1300', 'MACHINE', 20.2, 180),
               ('EDG-NB7CJN', 'NB7CJN Edge bander (narrow parts) — Nanxing', 'MACHINE', 22.4, 200),
               ('SND-1352ST', 'FINISH 1352 ST Wide belt sander — Felder', 'MACHINE', 11, 210),
               ('SND-DT1300', 'DT1300-4S Brush & sanding — DTWMAC', 'MACHINE', 7.75, 220),
               ('UTL-CMP-SIRIO', 'SIRIO 38-10 Screw air compressor — NU AIR', 'UTILITY', 37, 900),
               ('UTL-DRYER', 'PS-80A / PS-43A Refrigerant air dryers (x2)', 'UTILITY', 1.64, 910),
               ('UTL-CMP-K60T', 'K60T/900F Piston air compressor (backup)', 'UTILITY', 22, 920),
               ('UTL-AIRTANK', 'Air receiver tank 1000 L + desoiling filters', 'UTILITY', 0, 930),
               ('UTL-DUST', 'Central dust collector 60HP + ducting', 'UTILITY', 48.7, 940)) v(code, name, kind, kw, so)
on conflict (code) do nothing;

-- manual stages in process order: assembly after sanding, spray, then upholstery, glass/veneer finish, QC, packing
update work_centers set sort_order = v.so from (values ('ASM', 230), ('UPH', 250), ('SGV', 255), ('QC', 260), ('PCK', 270)) v(code, so) where work_centers.code = v.code;
