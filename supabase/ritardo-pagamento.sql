-- =====================================================================
-- Click Dottore - abbonamento non pagato: 15 giorni di visibilità
-- Da eseguire dopo senza-esenzioni.sql.
--
-- Quando un abbonamento smette di essere attivo (pagamento non riuscito,
-- disdetta, ecc.) si registra la data. Per 15 giorni il medico / hub resta
-- visibile nella ricerca e sulla mappa con "Al momento non disponibile per
-- prenotazioni" (non prenotabile); dal 16° giorno viene nascosto.
-- Utenze e credenziali restano: tornando a pagare tutto si riattiva.
-- =====================================================================

alter table public.abbonamenti add column if not exists non_attivo_dal timestamptz;

-- la data si registra al passaggio da attivo a non attivo e si azzera al ritorno attivo
create or replace function public.segna_non_attivo() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.stato in ('active', 'trialing') then
    new.non_attivo_dal := null;
  elsif new.non_attivo_dal is null and tg_op = 'UPDATE' and old.stato in ('active', 'trialing') then
    new.non_attivo_dal := now();
  end if;
  return new;
end;
$$;
drop trigger if exists abbonamenti_non_attivo on public.abbonamenti;
create trigger abbonamenti_non_attivo before insert or update of stato on public.abbonamenti
  for each row execute function public.segna_non_attivo();

-- visibile nella ricerca: abbonamento attivo, oppure non attivo da al massimo 15 giorni
create or replace function public.abbonamento_visibile(p_hub uuid, p_medico uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.abbonamento_valido(p_hub, p_medico)
  or exists (
    select 1 from public.abbonamenti a
     where ((p_hub is not null and a.hub_id = p_hub) or (p_medico is not null and a.medico_id = p_medico))
       and a.non_attivo_dal > now() - interval '15 days'
  ) or (p_medico is not null and exists (
    select 1 from public.profili pr
      join public.abbonamenti a on a.hub_id = pr.hub_id
     where pr.ruolo = 'medico_hub' and pr.attivo and pr.medico_id = p_medico
       and a.non_attivo_dal > now() - interval '15 days'
  ))
$$;
grant execute on function public.abbonamento_visibile(uuid, uuid) to anon, authenticated, service_role;

-- Medici nella ricerca: visibili per 15 giorni anche senza abbonamento attivo, ma non prenotabili
create or replace view public.medici_pubblici as
  select m.id, m.nome, m.cognome, m.specializzazione, m.citta, m.lat, m.lng,
         (select pr.hub_id
            from public.profili pr
            join public.hub_prenotabili hp on hp.id = pr.hub_id
           where pr.ruolo = 'medico_hub' and pr.attivo and pr.medico_id = m.id
           limit 1) as hub_proprio,
         m.genere, m.titolo, m.dicitura_specializzazione,
         public.abbonamento_valido(null, m.id) as prenotabile
    from public.medici m
   where m.attivo and public.abbonamento_visibile(null, m.id);
grant select on public.medici_pubblici to anon, authenticated;

-- Prestazioni e prezzi: visibili insieme al medico
create or replace view public.prestazioni_pubbliche as
  select p.id, p.medico_id, p.nome, p.descrizione, p.prezzo_visita_cents, p.durata_minuti
    from public.prestazioni p
    join public.medici m on m.id = p.medico_id
   where p.attivo and m.attivo and public.abbonamento_visibile(null, m.id);
grant select on public.prestazioni_pubbliche to anon, authenticated;

-- Mappa degli hub: stessa regola dei 15 giorni
create or replace view public.hub_pubblici as
  select h.id, h.nome, h.tipo, h.citta, h.indirizzo, h.telefono, h.lat, h.lng,
         public.abbonamento_valido(h.id, null) as prenotabile
    from public.hub h
   where h.attivo and h.lat is not null and h.lng is not null and public.abbonamento_visibile(h.id, null);
grant select on public.hub_pubblici to anon, authenticated;
