-- =====================================================================
-- Click Dottore - rimozione del vecchio sistema dei bonifici hub ↔ Click Dottore
-- Il ticket va per intero agli hub e ai medici+hub; Click Dottore incassa
-- solo gli abbonamenti mensili Stripe. Da eseguire dopo ritardo-pagamento.sql.
-- =====================================================================
drop view if exists public.conti_hub;
drop table if exists public.regolazioni;
delete from public.impostazioni where chiave in ('quota_hub_percento', 'iban_click_dottore', 'intestatario_iban');
