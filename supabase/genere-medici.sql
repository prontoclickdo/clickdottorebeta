-- =====================================================================
-- Click Dottore - genere del medico (per "Dott." / "Dott.ssa" e
-- "Specializzato" / "Specializzata"), compilabile dal medico o dall'admin
-- Da eseguire dopo scelta-hub.sql.
-- =====================================================================
alter table public.medici add column if not exists genere text check (genere in ('M', 'F'));

-- Vista pubblica dei medici: in più il genere
create or replace view public.medici_pubblici as
  select m.id, m.nome, m.cognome, m.specializzazione, m.citta, m.lat, m.lng,
         (select pr.hub_id
            from public.profili pr
            join public.hub_prenotabili hp on hp.id = pr.hub_id
           where pr.ruolo = 'medico_hub' and pr.attivo and pr.medico_id = m.id
           limit 1) as hub_proprio,
         m.genere
    from public.medici m
   where m.attivo and public.abbonamento_valido(null, m.id);
grant select on public.medici_pubblici to anon, authenticated;

-- Medici di prova
update public.medici set genere = 'F' where nome = 'Laura' and cognome = 'Bianchi';
update public.medici set genere = 'M' where genere is null and nome in ('Mario', 'Paolo');
