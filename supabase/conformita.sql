-- =====================================================================
-- Click Dottore - adeguamenti dopo la revisione di informativa e termini
-- Da eseguire dopo codici-provincia.sql.
--
-- 1) Visita spostata dal medico o dall'hub: se il paziente non accetta
--    il nuovo orario e annulla, il ticket è rimborsato per intero.
-- 2) Presa d'atto sul diritto di recesso prima del pagamento.
-- 3) Cancellazione automatica dei dati, con i tempi dell'informativa:
--    - richieste non concluse (rifiutate, scadute, annullate senza pagamento): cancellate dopo 12 mesi;
--    - prenotazioni concluse: dati del paziente resi anonimi 24 mesi dopo la visita;
--    - registro delle operazioni: cancellato dopo 12 mesi;
--    - richieste "Lavora con noi" non accettate: cancellate dopo 24 mesi.
-- =====================================================================

alter table public.prenotazioni add column if not exists spostata_dalla_struttura boolean not null default false;
alter table public.prenotazioni add column if not exists recesso_rinuncia_il timestamptz;

create or replace function public.pulizia_dati() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  n_richieste int; n_anonime int; n_registro int; n_candidature int;
begin
  -- richieste mai concluse
  delete from public.prenotazioni
   where pagata_il is null
     and stato in ('rifiutata', 'scaduta', 'annullata')
     and aggiornata_il < now() - interval '12 months';
  get diagnostics n_richieste = row_count;

  -- prenotazioni concluse: restano solo i dati non personali (date, medico, prestazione, importi)
  update public.prenotazioni
     set paziente_nome = 'Anonimo', paziente_cognome = 'Anonimo', paziente_codice_fiscale = 'ANONIMO',
         paziente_data_nascita = date '1900-01-01', paziente_telefono = '-', paziente_email = 'anonimo@invalid',
         paziente_id = null, note = null, nota_medico = null, motivo_rifiuto = null, token_pagamento = null
   where paziente_email <> 'anonimo@invalid'
     and stato not in ('richiesta', 'da_pagare', 'confermata')
     and coalesce(visita_il, aggiornata_il) < now() - interval '24 months';
  get diagnostics n_anonime = row_count;

  delete from public.registro where quando < now() - interval '12 months';
  get diagnostics n_registro = row_count;

  delete from public.candidature where stato <> 'accettata' and creata_il < now() - interval '24 months';
  get diagnostics n_candidature = row_count;

  return jsonb_build_object('richieste_cancellate', n_richieste, 'prenotazioni_anonimizzate', n_anonime,
                            'registro_cancellato', n_registro, 'candidature_cancellate', n_candidature);
end;
$$;
revoke execute on function public.pulizia_dati() from public, anon, authenticated;

select cron.unschedule('pulizia-dati') where exists (select 1 from cron.job where jobname = 'pulizia-dati');
select cron.schedule('pulizia-dati', '17 3 * * *', $cron$ select public.pulizia_dati(); $cron$);
