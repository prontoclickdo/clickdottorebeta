-- =====================================================================
-- Click Dottore - abbonamenti mensili (Stripe) per medici e hub
-- Da eseguire dopo le migrazioni precedenti.
--
-- Un medico (utenza "medico") o un hub (utenze "operatore") può usare
-- l'area riservata solo con un abbonamento attivo o se l'amministratore
-- lo ha segnato come esente. Senza abbonamento le credenziali restano
-- valide ma l'accesso ai dati è bloccato, e il medico o l'hub non
-- compare nella ricerca pubblica e sulla mappa.
-- =====================================================================

create table public.abbonamenti (
  id uuid primary key default gen_random_uuid(),
  hub_id uuid unique references public.hub(id) on delete cascade,
  medico_id uuid unique references public.medici(id) on delete cascade,
  piano text check (piano in ('starter', 'plus', 'premium')),
  stato text not null default 'nessuno',        -- stato dell'abbonamento in Stripe (active, past_due, canceled...)
  esente boolean not null default false,        -- accesso gratuito concesso dall'amministratore
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  periodo_fine timestamptz,                     -- prossimo rinnovo o fine dell'accesso se disdetto
  disdetta_a_fine_periodo boolean not null default false,
  aggiornato_il timestamptz not null default now(),
  check ((hub_id is null) <> (medico_id is null))
);

alter table public.abbonamenti enable row level security;
grant all on public.abbonamenti to service_role;
grant select on public.abbonamenti to authenticated;
-- solo l'amministratore legge la tabella; medici e hub vedono il proprio stato tramite la funzione server

-- Abbonamento valido per un hub o per un medico
create or replace function public.abbonamento_valido(p_hub uuid, p_medico uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.abbonamenti a
     where ((p_hub is not null and a.hub_id = p_hub) or (p_medico is not null and a.medico_id = p_medico))
       and (a.esente or a.stato in ('active', 'trialing'))
  )
$$;

-- Utenza abilitata: l'amministratore sempre, medici e hub solo con abbonamento valido
create or replace function public.profilo_abilitato(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case when p.ruolo = 'admin' then true
                when p.ruolo = 'medico' then public.abbonamento_valido(null, p.medico_id)
                else public.abbonamento_valido(p.hub_id, null) end
      from public.profili p
     where p.id = p_id and p.attivo
  ), false)
$$;

revoke execute on function public.abbonamento_valido(uuid, uuid) from public, anon;
revoke execute on function public.profilo_abilitato(uuid) from public, anon;
grant execute on function public.abbonamento_valido(uuid, uuid) to authenticated, service_role;
grant execute on function public.profilo_abilitato(uuid) to authenticated, service_role;

create policy "abbonamenti visibili all'admin" on public.abbonamenti
  for select to authenticated using (public.mio_ruolo() = 'admin');

-- Le regole di accesso ai dati usano queste funzioni: senza abbonamento
-- restituiscono null e l'utenza non vede più nulla (resta solo il proprio profilo).
create or replace function public.mio_ruolo() returns text
language sql stable security definer set search_path = public as $$
  select ruolo from public.profili where id = auth.uid() and attivo and public.profilo_abilitato(id)
$$;
create or replace function public.mio_hub() returns uuid
language sql stable security definer set search_path = public as $$
  select hub_id from public.profili where id = auth.uid() and attivo and public.profilo_abilitato(id)
$$;
create or replace function public.mio_medico() returns uuid
language sql stable security definer set search_path = public as $$
  select medico_id from public.profili where id = auth.uid() and attivo and public.profilo_abilitato(id)
$$;

-- ---------------------------------------------------------------------
-- Ricerca pubblica: solo medici e hub con abbonamento valido
-- ---------------------------------------------------------------------
create or replace view public.medici_pubblici as
  select m.id, m.nome, m.cognome, m.specializzazione, m.citta
    from public.medici m
   where m.attivo and public.abbonamento_valido(null, m.id);

create or replace view public.prestazioni_pubbliche as
  select p.id, p.medico_id, p.nome, p.descrizione, p.prezzo_visita_cents, p.durata_minuti
    from public.prestazioni p
    join public.medici m on m.id = p.medico_id
   where p.attivo and m.attivo and public.abbonamento_valido(null, m.id);

create or replace view public.hub_pubblici as
  select id, nome, tipo, citta, indirizzo, telefono, lat, lng
    from public.hub h
   where attivo and lat is not null and lng is not null and public.abbonamento_valido(h.id, null);

-- Le viste girano con i permessi del proprietario: la funzione deve essere eseguibile anche dai visitatori
grant execute on function public.abbonamento_valido(uuid, uuid) to anon;

-- Orari liberi: solo per i medici con abbonamento valido (vale per pazienti e hub)
create or replace function public.slot_liberi(p_prestazione uuid, p_dal date, p_giorni integer default 14)
returns table (inizio timestamptz, fine timestamptz)
language sql stable security definer set search_path = public as $$
  with pr as (
    select p.medico_id, make_interval(mins => p.durata_minuti) as durata
      from public.prestazioni p join public.medici m on m.id = p.medico_id
     where p.id = p_prestazione and p.attivo and m.attivo and public.abbonamento_valido(null, m.id)
  ),
  giorni as (
    select g::date as giorno
      from generate_series(greatest(p_dal, (now() at time zone 'Europe/Rome')::date),
                           p_dal + least(greatest(p_giorni, 1), 60) - 1, interval '1 day') g
  ),
  candidati as (
    select (s at time zone 'Europe/Rome') as inizio,
           ((s + pr.durata) at time zone 'Europe/Rome') as fine,
           pr.medico_id
      from giorni
      join pr on true
      join public.disponibilita d
        on d.medico_id = pr.medico_id and d.giorno_settimana = extract(isodow from giorni.giorno)
      cross join lateral generate_series(giorni.giorno + d.ora_inizio,
                                         giorni.giorno + d.ora_fine - pr.durata,
                                         pr.durata) s
     where not exists (select 1 from public.chiusure c
                        where c.medico_id = pr.medico_id and giorni.giorno between c.dal and c.al)
  )
  select distinct c.inizio, c.fine
    from candidati c
   where c.inizio > now() + interval '2 hours'
     and not exists (
       select 1 from public.prenotazioni b
        where b.medico_id = c.medico_id
          and b.stato in ('richiesta', 'da_pagare', 'confermata')
          and (b.scadenza is null or b.scadenza > now())
          and b.visita_il is not null and b.visita_fine is not null
          and tstzrange(b.visita_il, b.visita_fine) && tstzrange(c.inizio, c.fine))
   order by 1;
$$;
grant execute on function public.slot_liberi(uuid, date, integer) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Prezzi dei piani (in centesimi, modificabili dall'area riservata)
-- ---------------------------------------------------------------------
insert into public.impostazioni (chiave, valore) values
  ('abbonamento_starter_cents', '1990'),
  ('abbonamento_plus_cents', '3990'),
  ('abbonamento_premium_cents', '5990')
on conflict (chiave) do nothing;

-- Il medico di prova Mario Rossi resta utilizzabile senza abbonamento
insert into public.abbonamenti (medico_id, esente)
  select id, true from public.medici where id = 'c4b3c20f-5caa-4622-bf89-d6b182dda338'
on conflict (medico_id) do update set esente = true;

-- Anche l'hub di prova (codice PROVA) resta utilizzabile senza abbonamento
insert into public.abbonamenti (hub_id, esente)
  select id, true from public.hub where codice = 'PROVA'
on conflict (hub_id) do update set esente = true;
