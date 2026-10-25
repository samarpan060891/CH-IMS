-- 084 Operators per machine: people working together at one machine while it runs (operator + helper = 2).
-- BOM man-hours = machine hours × operators (labour cost); the stage still takes the machine hours, so completion
-- dates use the larger of machine hours and man-hours ÷ operators.
alter table work_centers add column if not exists operators int not null default 1;
alter table work_centers drop constraint if exists work_centers_operators_check;
alter table work_centers add constraint work_centers_operators_check check (operators >= 1);
update work_centers set operators = 2 where code = 'PNL-NPC330';   -- beam saw: operator + helper
