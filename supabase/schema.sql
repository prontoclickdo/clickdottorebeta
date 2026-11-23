-- =====================================================================
-- Click Dottore - schema del database delle prenotazioni
-- Da eseguire una volta nel SQL Editor di Supabase.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Impostazioni generali (es. importo della quota di prenotazione)
-- ---------------------------------------------------------------------
create table public.impostazioni (
  chiave text primary key,
  valore text not null
);
insert into public.impostazioni (chiave, valore) values ('quota_cents', '300');

-- ---------------------------------------------------------------------
-- Hub: strutture private o medici che prenotano per conto dei pazienti
-- ---------------------------------------------------------------------
create table public.hub (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('struttura', 'medico')),
  nome text not null,
  codice text not null unique check (codice ~ '^[A-Z0-9]{3,10}$'),   -- es. MT014, usato nei codici CDH
  citta text,
  indirizzo text,
  email text,
  telefono text,
  attivo boolean not null default true,
  creato_il timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Medici e prestazioni
-- ---------------------------------------------------------------------
create table public.medici (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  cognome text not null,
  specializzazione text not null,
  citta text not null,
  indirizzo text,
  email text not null,          -- riceve le notifiche delle prenotazioni
  telefono text,
  attivo boolean not null default true,
  creato_il timestamptz not null default now()
);

create table public.prestazioni (
  id uuid primary key default gen_random_uuid(),
  medico_id uuid not null references public.medici(id) on delete cascade,
  nome text not null,
  descrizione text,
  prezzo_visita_cents integer check (prezzo_visita_cents is null or prezzo_visita_cents >= 0),  -- solo informativo
  attivo boolean not null default true,
  creato_il timestamptz not null default now()
);
create index on public.prestazioni (medico_id);

-- ---------------------------------------------------------------------
-- Utenze del personale (create solo dall'amministratore)
-- ---------------------------------------------------------------------
create table public.profili (
  id uuid primary key references auth.users(id) on delete cascade,
  ruolo text not null check (ruolo in ('admin', 'operatore', 'medico')),
  nome text not null,
  email text not null,
  hub_id uuid references public.hub(id),        -- operatore: obbligatorio; medico: se fa da hub
  medico_id uuid references public.medici(id),  -- medico: obbligatorio
  attivo boolean not null default true,
  creato_il timestamptz not null default now(),
  check (ruolo <> 'operatore' or hub_id is not null),
  check (ruolo <> 'medico' or medico_id is not null)
);

-- ---------------------------------------------------------------------
-- Prenotazioni
-- ---------------------------------------------------------------------
create table public.prenotazioni (
  id uuid primary key default gen_random_uuid(),
  codice text unique,                     -- CDO-... (online) / CDH-<hub>-... (hub), generato a pagamento avvenuto
  canale text not null check (canale in ('online', 'hub')),
  hub_id uuid references public.hub(id),
  creata_da uuid references public.profili(id),
  medico_id uuid not null references public.medici(id),
  prestazione_id uuid not null references public.prestazioni(id),
  paziente_nome text not null,
  paziente_cognome text not null,
  paziente_codice_fiscale text not null,
  paziente_data_nascita date not null,
  paziente_telefono text not null,
  paziente_email text not null,
  note text,
  consenso_privacy boolean not null,
  consenso_dati_sanitari boolean not null,
  quota_cents integer not null check (quota_cents >= 0),
  incassata_da text not null check (incassata_da in ('click_dottore', 'hub')),
  metodo_pagamento text,                  -- stripe / pos / contanti / altro
  stato text not null default 'in_attesa_pagamento' check (stato in (
    'in_attesa_pagamento', 'pagata', 'presa_in_carico', 'visita_fissata',
    'completata', 'annullata', 'rimborsata', 'scaduta')),
  stripe_session_id text unique,
  stripe_payment_intent text,
  pagata_il timestamptz,
  visita_il timestamptz,
  nota_medico text,
  creata_il timestamptz not null default now(),
  aggiornata_il timestamptz not null default now(),
  check (canale <> 'hub' or hub_id is not null),
  check (consenso_privacy and consenso_dati_sanitari)
);
create index on public.prenotazioni (medico_id, creata_il desc);
create index on public.prenotazioni (hub_id, creata_il desc);

-- Registro delle azioni (chi ha fatto cosa e quando)
create table public.registro (
  id bigserial primary key,
  quando timestamptz not null default now(),
  utente uuid,
  azione text not null,
  prenotazione_id uuid,
  dettagli jsonb
);

-- ---------------------------------------------------------------------
-- Codice univoco: CDO-2026-7F3K9Q / CDH-MT014-2026-4P8R2N
-- (parte finale casuale, senza caratteri ambigui come 0/O e 1/I)
-- ---------------------------------------------------------------------
create or replace function public.genera_codice(p_canale text, p_hub_codice text)
returns text
language plpgsql
set search_path = public, extensions
as $$
declare
  alfabeto constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  parte text;
  anno text := to_char(now() at time zone 'Europe/Rome', 'YYYY');
  risultato text;
  i int;
begin
  loop
    parte := '';
    for i in 1..6 loop
      parte := parte || substr(alfabeto, 1 + (get_byte(gen_random_bytes(1), 0) % 32), 1);
    end loop;
    if p_canale = 'online' then
      risultato := 'CDO-' || anno || '-' || parte;
    else
      risultato := 'CDH-' || p_hub_codice || '-' || anno || '-' || parte;
    end if;
    exit when not exists (select 1 from public.prenotazioni where codice = risultato);
  end loop;
  return risultato;
end;
$$;

-- Conferma del pagamento online (chiamata dal webhook di Stripe).
-- Idempotente: se la prenotazione è già pagata non cambia nulla e restituisce appena_pagata = false.
create or replace function public.conferma_pagamento_online(p_session_id text, p_payment_intent text)
returns table (prenotazione_id uuid, codice text, appena_pagata boolean)
language plpgsql
set search_path = public
as $$
declare
  p public.prenotazioni;
begin
  select * into p from public.prenotazioni where stripe_session_id = p_session_id for update;
  if not found then
    return;
  end if;
  if p.stato in ('in_attesa_pagamento', 'scaduta') then
    update public.prenotazioni
       set stato = 'pagata',
           codice = public.genera_codice('online', null),
           pagata_il = now(),
           stripe_payment_intent = p_payment_intent,
           aggiornata_il = now()
     where id = p.id
     returning * into p;
    insert into public.registro (azione, prenotazione_id, dettagli)
    values ('pagamento_online', p.id, jsonb_build_object('session', p_session_id));
    return query select p.id, p.codice, true;
  else
    return query select p.id, p.codice, false;
  end if;
end;
$$;

-- Le funzioni interne le usa solo il server (chiave segreta), mai il browser
revoke execute on function public.genera_codice(text, text) from public, anon, authenticated;
revoke execute on function public.conferma_pagamento_online(text, text) from public, anon, authenticated;
grant execute on function public.genera_codice(text, text) to service_role;
grant execute on function public.conferma_pagamento_online(text, text) to service_role;

-- ---------------------------------------------------------------------
-- Funzioni di supporto per le regole di accesso
-- ---------------------------------------------------------------------
create or replace function public.mio_ruolo() returns text
language sql stable security definer set search_path = public as $$
  select ruolo from public.profili where id = auth.uid() and attivo
$$;
create or replace function public.mio_hub() returns uuid
language sql stable security definer set search_path = public as $$
  select hub_id from public.profili where id = auth.uid() and attivo
$$;
create or replace function public.mio_medico() returns uuid
language sql stable security definer set search_path = public as $$
  select medico_id from public.profili where id = auth.uid() and attivo
$$;
revoke execute on function public.mio_ruolo() from public, anon;
revoke execute on function public.mio_hub() from public, anon;
revoke execute on function public.mio_medico() from public, anon;
grant execute on function public.mio_ruolo() to authenticated;
grant execute on function public.mio_hub() to authenticated;
grant execute on function public.mio_medico() to authenticated;

-- ---------------------------------------------------------------------
-- Regole di accesso (Row Level Security)
-- Le scritture passano tutte dalle funzioni server; il browser può solo leggere
-- ciò che gli spetta.
-- ---------------------------------------------------------------------
alter table public.impostazioni enable row level security;
alter table public.hub          enable row level security;
alter table public.medici       enable row level security;
alter table public.prestazioni  enable row level security;
alter table public.profili      enable row level security;
alter table public.prenotazioni enable row level security;
alter table public.registro     enable row level security;

-- impostazioni: lettura per tutti (l'importo della quota è pubblico)
create policy "impostazioni leggibili" on public.impostazioni
  for select to anon, authenticated using (true);

-- hub: l'amministratore li vede tutti, il personale solo il proprio
create policy "hub visibili al personale" on public.hub
  for select to authenticated
  using (public.mio_ruolo() = 'admin' or id = public.mio_hub());

-- medici e prestazioni: il personale li vede tutti (per prenotare)
create policy "medici visibili al personale" on public.medici
  for select to authenticated using (public.mio_ruolo() is not null);
create policy "prestazioni visibili al personale" on public.prestazioni
  for select to authenticated using (public.mio_ruolo() is not null);

-- profili: ognuno vede il proprio, l'amministratore tutti
create policy "profilo proprio o admin" on public.profili
  for select to authenticated
  using (id = auth.uid() or public.mio_ruolo() = 'admin');

-- prenotazioni: admin tutte; hub le proprie; medico quelle a lui destinate
create policy "prenotazioni visibili" on public.prenotazioni
  for select to authenticated
  using (
    public.mio_ruolo() = 'admin'
    or (hub_id is not null and hub_id = public.mio_hub())
    or medico_id = public.mio_medico()
  );

-- registro: solo admin
create policy "registro admin" on public.registro
  for select to authenticated using (public.mio_ruolo() = 'admin');

-- ---------------------------------------------------------------------
-- Viste pubbliche per la ricerca sul sito (solo dati non sensibili)
-- ---------------------------------------------------------------------
create view public.medici_pubblici as
  select m.id, m.nome, m.cognome, m.specializzazione, m.citta
    from public.medici m
   where m.attivo;

create view public.prestazioni_pubbliche as
  select p.id, p.medico_id, p.nome, p.descrizione, p.prezzo_visita_cents
    from public.prestazioni p
    join public.medici m on m.id = p.medico_id
   where p.attivo and m.attivo;

grant select on public.medici_pubblici, public.prestazioni_pubbliche to anon, authenticated;

-- ---------------------------------------------------------------------
-- Permessi sulle tabelle (il progetto non li assegna in automatico).
-- Le righe visibili restano limitate dalle regole RLS definite sopra.
-- ---------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant select on public.impostazioni to anon, authenticated;
grant select on public.hub, public.medici, public.prestazioni, public.profili,
                public.prenotazioni, public.registro to authenticated;
