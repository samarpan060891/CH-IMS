-- CitiCore - 035: HR Officer role (own migration: a new enum value must be committed before use)
alter type app_role add value if not exists 'hr_officer';
