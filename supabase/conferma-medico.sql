-- =====================================================================
-- Click Dottore - prenotazione con conferma del medico
--   * il medico imposta orari settimanali, chiusure, prestazioni, tariffe e durata
--   * il paziente (registrato) sceglie uno slot libero e invia una richiesta
--   * il medico conferma o rifiuta; il paziente paga la quota entro 24 ore
--   * gli hub inviano richieste o confermano dopo aver sentito il medico al telefono,
--     poi incassano allo sportello o stampano un bollettino pagabile online
--   * conti con gli hub: l'hub tiene l'80% della quota, Click Dottore il 20%
-- Da eseguire una volta nel SQL Editor di Supabase, dopo schema.sql e pazienti.sql.
-- =====================================================================

create extension if not exists btree_gist with schema extensions;

-- Impostazioni nuove
insert into public.impostazioni (chiave, valore) values
  ('quota_hub_percento', '80'),
  ('iban_click_dottore', ''),
  ('intestatario_iban', '')
on conflict (chiave) do nothing;

-- Durata della prestazione (determina la lunghezza degli slot)
alter table public.prestazioni
  add column durata_minuti integer not null default 30 check (durata_minuti between 5 and 480);

-- Orari settimanali di disponibilità del medico (1 = lunedì ... 7 = domenica)
create table public.disponibilita (
  id uuid primary key default gen_random_uuid(),
  medico_id uuid not null references public.medici(id) on delete cascade,
  giorno_settimana smallint not null check (giorno_settimana between 1 and 7),
  ora_inizio time not null,
  ora_fine time not null,
  check (ora_fine > ora_inizio)
);
create index on public.disponibilita (medico_id);

-- Giorni di chiusura (ferie, congressi...)
create table public.chiusure (
  id uuid primary key default gen_random_uuid(),
  medico_id uuid not null references public.medici(id) on delete cascade,
  dal date not null,
  al date not null,
  motivo text,
  check (al >= dal)
);
create index on public.chiusure (medico_id);

-- ---------------------------------------------------------------------
-- Prenotazioni: nuovi stati e campi
--   richiesta   -> in attesa della conferma del medico
--   rifiutata   -> il medico ha rifiutato
--   da_pagare   -> confermata dal medico, il paziente deve pagare la quota (online)
--   confermata  -> visita confermata (online: pagata; hub: quota gestita dall'hub)
--   completata / annullata / rimborsata / scaduta
-- ---------------------------------------------------------------------
alter table public.prenotazioni drop constraint prenotazioni_stato_check;
update public.prenotazioni set stato = case
    when stato in ('pagata', 'presa_in_carico', 'visita_fissata') then 'confermata'
    when stato = 'in_attesa_pagamento' then 'scaduta'
    else stato end;
alter table public.prenotazioni add constraint prenotazioni_stato_check check (stato in (
  'richiesta', 'rifiutata', 'da_pagare', 'confermata', 'completata', 'annullata', 'rimborsata', 'scaduta'));
alter table public.prenotazioni alter column stato set default 'richiesta';
alter table public.prenotazioni alter column incassata_da drop not null;   -- noto solo quando la quota è pagata

alter table public.prenotazioni
  add column visita_fine timestamptz,
  add column scadenza timestamptz,              -- entro quando il medico deve rispondere / il paziente deve pagare
  add column confermata_il timestamptz,
  add column motivo_rifiuto text,
  add column token_pagamento text unique,       -- link del bollettino pagabile online (prenotazioni hub)
  add column quota_hub_cents integer not null default 0 check (quota_hub_cents >= 0);   -- parte della quota che spetta all'hub

-- Lo stesso medico non può avere due prenotazioni attive sovrapposte
alter table public.prenotazioni add constraint prenotazioni_no_sovrapposizioni
  exclude using gist (medico_id with =, tstzrange(visita_il, visita_fine) with &&)
  where (stato in ('richiesta', 'da_pagare', 'confermata') and visita_il is not null and visita_fine is not null);

create index on public.prenotazioni (stato, scadenza);

-- Richieste non confermate e quote non pagate in tempo: lo slot torna libero
create or replace function public.scadi_prenotazioni() returns integer
language sql security definer set search_path = public as $$
  with s as (
    update public.prenotazioni set stato = 'scaduta', aggiornata_il = now()
     where stato in ('richiesta', 'da_pagare') and scadenza is not null and scadenza < now()
    returning 1)
  select count(*)::int from s;
$$;
revoke execute on function public.scadi_prenotazioni() from public, anon, authenticated;
grant execute on function public.scadi_prenotazioni() to service_role;

-- Slot liberi di una prestazione a partire da un giorno (orari italiani)
create or replace function public.slot_liberi(p_prestazione uuid, p_dal date, p_giorni integer default 14)
returns table (inizio timestamptz, fine timestamptz)
language sql stable security definer set search_path = public as $$
  with pr as (
    select p.medico_id, make_interval(mins => p.durata_minuti) as durata
      from public.prestazioni p join public.medici m on m.id = p.medico_id
     where p.id = p_prestazione and p.attivo and m.attivo
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

-- Conferma di un pagamento Stripe (quota online o bollettino dell'hub). Idempotente.
create or replace function public.conferma_pagamento(p_prenotazione uuid, p_session_id text, p_payment_intent text)
returns table (r_id uuid, r_codice text, r_appena_pagata boolean, r_stato text)
language plpgsql set search_path = public as $$
declare
  p public.prenotazioni;
begin
  select * into p from public.prenotazioni where id = p_prenotazione for update;
  if not found then return; end if;
  if p.pagata_il is not null then
    return query select p.id, p.codice, false, p.stato;
    return;
  end if;
  update public.prenotazioni
     set pagata_il = now(),
         stripe_session_id = p_session_id,
         stripe_payment_intent = p_payment_intent,
         incassata_da = 'click_dottore',
         metodo_pagamento = case when p.canale = 'hub' then 'bollettino' else 'stripe' end,
         stato = case when p.stato = 'da_pagare' then 'confermata' else p.stato end,
         scadenza = case when p.stato = 'da_pagare' then null else p.scadenza end,
         aggiornata_il = now()
   where id = p.id
  returning * into p;
  -- pagata dopo la scadenza: se l'orario è ancora libero la visita viene confermata lo stesso
  if p.canale = 'online' and p.stato = 'scaduta' then
    begin
      update public.prenotazioni set stato = 'confermata', scadenza = null where id = p.id returning * into p;
    exception when exclusion_violation then
      null;   -- orario occupato: la funzione server rimborsa la quota
    end;
  end if;
  insert into public.registro (azione, prenotazione_id, dettagli)
  values ('pagamento_stripe', p.id, jsonb_build_object('session', p_session_id));
  return query select p.id, p.codice, true, p.stato;
end;
$$;
revoke execute on function public.conferma_pagamento(uuid, text, text) from public, anon, authenticated;
grant execute on function public.conferma_pagamento(uuid, text, text) to service_role;
drop function if exists public.conferma_pagamento_online(text, text);

-- ---------------------------------------------------------------------
-- Conti con gli hub
--   incasso allo sportello -> l'hub deve versare a Click Dottore la sua parte (20%)
--   bollettino pagato online -> Click Dottore deve versare all'hub la sua parte (80%)
-- ---------------------------------------------------------------------
create table public.regolazioni (
  id uuid primary key default gen_random_uuid(),
  hub_id uuid not null references public.hub(id),
  importo_cents integer not null check (importo_cents <> 0),   -- positivo: versato dall'hub a Click Dottore; negativo: versato da Click Dottore all'hub
  data date not null default current_date,
  nota text,
  registrata_da uuid references public.profili(id),
  creata_il timestamptz not null default now()
);
create index on public.regolazioni (hub_id);

create view public.conti_hub with (security_invoker = true) as
  select h.id as hub_id, h.nome, h.codice,
         coalesce(sum(p.quota_cents - p.quota_hub_cents) filter (where p.incassata_da = 'hub'), 0)::int as dovuto_a_click_dottore,
         coalesce(sum(p.quota_hub_cents) filter (where p.incassata_da = 'click_dottore'), 0)::int as dovuto_all_hub,
         (select coalesce(sum(r.importo_cents), 0) from public.regolazioni r where r.hub_id = h.id)::int as versato_netto
    from public.hub h
    left join public.prenotazioni p
      on p.hub_id = h.id and p.canale = 'hub' and p.pagata_il is not null and p.stato in ('confermata', 'completata')
   group by h.id, h.nome, h.codice;

-- ---------------------------------------------------------------------
-- Regole di accesso
-- ---------------------------------------------------------------------
alter table public.disponibilita enable row level security;
alter table public.chiusure      enable row level security;
alter table public.regolazioni   enable row level security;

create policy "orari visibili al medico e all'admin" on public.disponibilita
  for select to authenticated using (public.mio_ruolo() = 'admin' or medico_id = public.mio_medico());
create policy "chiusure visibili al medico e all'admin" on public.chiusure
  for select to authenticated using (public.mio_ruolo() = 'admin' or medico_id = public.mio_medico());
create policy "regolazioni visibili all'hub e all'admin" on public.regolazioni
  for select to authenticated using (public.mio_ruolo() = 'admin' or hub_id = public.mio_hub());

-- la vista pubblica delle prestazioni mostra anche la durata
create or replace view public.prestazioni_pubbliche as
  select p.id, p.medico_id, p.nome, p.descrizione, p.prezzo_visita_cents, p.durata_minuti
    from public.prestazioni p
    join public.medici m on m.id = p.medico_id
   where p.attivo and m.attivo;

grant all on public.disponibilita, public.chiusure, public.regolazioni, public.conti_hub to service_role;
grant select on public.disponibilita, public.chiusure, public.regolazioni, public.conti_hub to authenticated;
grant select on public.prestazioni_pubbliche to anon, authenticated;
