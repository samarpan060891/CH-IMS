-- 052 Sales role (quotations, sales orders, customers). Separate migration: a new enum value can't be used in the same transaction.
alter type app_role add value if not exists 'sales';
