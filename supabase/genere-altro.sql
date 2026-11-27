-- =====================================================================
-- Click Dottore - genere "Altro": il professionista sceglie il proprio
-- titolo (es. "Dott.", "Dott.ssa") e la dicitura della specializzazione
-- (es. "Specialista in"). Da eseguire dopo genere-medici.sql.
-- =====================================================================
alter table public.medici drop constraint if exists medici_genere_check;
alter table public.medici add constraint medici_genere_check check (genere in ('M', 'F', 'A'));
alter table public.medici
  add column if not exists titolo text check (titolo is null or titolo ~ '^[[:alpha:] .''*-]{1,15}$'),
  add column if not exists dicitura_specializzazione text check (dicitura_specializzazione is null or dicitura_specializzazione ~ '^[[:alpha:] .''*-]{1,30}$');

create or replace view public.medici_pubblici as
  select m.id, m.nome, m.cognome, m.specializzazione, m.citta, m.lat, m.lng,
         (select pr.hub_id
            from public.profili pr
            join public.hub_prenotabili hp on hp.id = pr.hub_id
           where pr.ruolo = 'medico_hub' and pr.attivo and pr.medico_id = m.id
           limit 1) as hub_proprio,
         m.genere, m.titolo, m.dicitura_specializzazione
    from public.medici m
   where m.attivo and public.abbonamento_valido(null, m.id);
grant select on public.medici_pubblici to anon, authenticated;
