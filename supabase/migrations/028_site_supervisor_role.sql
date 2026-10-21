-- Citi Homes IMS - 028: site supervisor role (own migration: a new enum value must be committed before use)
alter type app_role add value if not exists 'site_supervisor';
