-- 059 Consumables: PPE and cleaning items with sub-categories (issued like other consumables, e.g. to a cost centre)
insert into item_categories (class_id, code, name, is_active)
select id, 'CON-CLN', 'Cleaning & housekeeping', true from item_classes where code = 'CON'
on conflict do nothing;

insert into item_categories (class_id, parent_id, code, name, is_active)
select c.class_id, c.id, s.code, s.name, true
  from item_categories c
  join (values ('CON-SAF', 'CON-SAF-FTW', 'Safety footwear'), ('CON-SAF', 'CON-SAF-GLV', 'Gloves'), ('CON-SAF', 'CON-SAF-EYE', 'Eye & face protection'),
               ('CON-SAF', 'CON-SAF-HED', 'Head protection'), ('CON-SAF', 'CON-SAF-EAR', 'Ear protection'), ('CON-SAF', 'CON-SAF-RSP', 'Masks & respiratory'),
               ('CON-SAF', 'CON-SAF-WEA', 'Coveralls & hi-vis'),
               ('CON-CLN', 'CON-CLN-RAG', 'Cotton rags & wipes'), ('CON-CLN', 'CON-CLN-CHM', 'Cleaning chemicals & detergents'),
               ('CON-CLN', 'CON-CLN-BRM', 'Brooms, mops & brushes'), ('CON-CLN', 'CON-CLN-BIN', 'Garbage bags & bins')) s(parent, code, name)
    on s.parent = c.code
 where not exists (select 1 from item_categories x where x.code = s.code);
