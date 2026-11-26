-- =====================================================================
-- Click Dottore - il paziente sceglie l'hub che gestisce la prenotazione
-- Da eseguire dopo ruoli-medico-hub.sql.
--
-- - Se il medico ha un'utenza "medico che fa anche da hub", l'hub è il suo
--   (scelto in automatico).
-- - Altrimenti il paziente sceglie l'hub: gli viene suggerito quello del suo
--   comune o il più vicino.
-- =====================================================================

-- Comune del paziente, ricordato per suggerire l'hub alle prenotazioni successive
alter table public.pazienti add column if not exists citta text;

-- Hub che possono gestire prenotazioni online e incassare il ticket:
-- attivi, con abbonamento valido e conto Stripe pronto
create or replace view public.hub_prenotabili as
  select h.id, h.nome, h.tipo, h.citta, h.indirizzo, h.lat, h.lng
    from public.hub h
   where h.attivo and h.stripe_pronto and h.stripe_account_id is not null
     and public.abbonamento_valido(h.id, null);
grant select on public.hub_prenotabili to anon, authenticated;

-- Medici pubblici: in più coordinate del comune e hub proprio (se il medico fa anche da hub)
create or replace view public.medici_pubblici as
  select m.id, m.nome, m.cognome, m.specializzazione, m.citta, m.lat, m.lng,
         (select pr.hub_id
            from public.profili pr
            join public.hub_prenotabili hp on hp.id = pr.hub_id
           where pr.ruolo = 'medico_hub' and pr.attivo and pr.medico_id = m.id
           limit 1) as hub_proprio
    from public.medici m
   where m.attivo and public.abbonamento_valido(null, m.id);
grant select on public.medici_pubblici to anon, authenticated;
