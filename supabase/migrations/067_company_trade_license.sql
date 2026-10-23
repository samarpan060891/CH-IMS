-- 067 Company trade licence (printed with the TRN on every document)
alter table company_settings
  add column if not exists trade_license_no text,
  add column if not exists trade_license_authority text;
update company_settings set
  trade_license_no = coalesce(trade_license_no, 'LIC-IND-38653'),
  trade_license_authority = coalesce(trade_license_authority, 'Umm Al Quwain Department of Economic Development');
