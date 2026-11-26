-- =====================================================================
-- Click Dottore - ruoli distinti: medico, hub (operatore), medico + hub
-- Da eseguire dopo ticket-hub.sql.
--
-- - "medico": solo medico. Non può avere un hub collegato, quindi non
--   collega Stripe e non incassa ticket: vede solo se il ticket è pagato.
-- - "operatore": utenza di un hub. Collega il conto Stripe e incassa.
-- - "medico_hub": medico che fa anche da hub. Ha sia il medico sia l'hub;
--   l'abbonamento è quello dell'hub e vale anche per il medico.
-- =====================================================================

-- Il medico puro non resta collegato a un hub (es. Laura Bianchi)
update public.profili set hub_id = null where ruolo = 'medico' and hub_id is not null;

alter table public.profili drop constraint if exists profili_ruolo_check;
alter table public.profili add constraint profili_ruolo_check
  check (ruolo in ('admin', 'operatore', 'medico', 'medico_hub'));
alter table public.profili add constraint profili_medico_senza_hub
  check (ruolo <> 'medico' or hub_id is null);
alter table public.profili add constraint profili_medico_hub_completo
  check (ruolo <> 'medico_hub' or (hub_id is not null and medico_id is not null));

-- Abbonamento valido: per il medico vale anche quello dell'hub di una sua utenza "medico + hub"
create or replace function public.abbonamento_valido(p_hub uuid, p_medico uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.abbonamenti a
     where ((p_hub is not null and a.hub_id = p_hub) or (p_medico is not null and a.medico_id = p_medico))
       and (a.esente or a.stato in ('active', 'trialing'))
  ) or (p_medico is not null and exists (
    select 1 from public.profili pr
      join public.abbonamenti a on a.hub_id = pr.hub_id
     where pr.ruolo = 'medico_hub' and pr.attivo and pr.medico_id = p_medico
       and (a.esente or a.stato in ('active', 'trialing'))
  ))
$$;

-- ---------------------------------------------------------------------
-- Dati di prova: Dott. Paolo Neri, ortopedico a Bari, che fa anche da hub
-- ---------------------------------------------------------------------
with h as (
  insert into public.hub (tipo, nome, codice, citta, indirizzo, email, lat, lng)
  values ('medico', 'Studio Dott. Paolo Neri', 'NERI', 'Bari', 'Corso Vittorio Emanuele II',
          'prontogithub+medicohub@gmail.com', 41.1260, 16.8690)
  returning id
), m as (
  insert into public.medici (nome, cognome, specializzazione, citta, indirizzo, email, lat, lng)
  values ('Paolo', 'Neri', 'Ortopedia e Traumatologia', 'Bari', 'Corso Vittorio Emanuele II',
          'prontogithub+medicohub@gmail.com', 41.1260, 16.8690)
  returning id
), pr as (
  insert into public.prestazioni (medico_id, nome, descrizione, prezzo_visita_cents, durata_minuti)
  select m.id, 'Visita ortopedica', 'Prima visita ortopedica', 10000, 30 from m
  returning medico_id
), orari as (
  insert into public.disponibilita (medico_id, giorno_settimana, ora_inizio, ora_fine)
  select m.id, d.giorno_settimana, d.ora_inizio, d.ora_fine
    from m, public.disponibilita d
   where d.medico_id = 'c4b3c20f-5caa-4622-bf89-d6b182dda338'
  returning 1
)
-- esente dall'abbonamento per le prove (si toglie dalla scheda Hub)
insert into public.abbonamenti (hub_id, esente)
select h.id, true from h
returning hub_id;
