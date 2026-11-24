-- =====================================================================
-- Click Dottore - account dei pazienti (registrazione dal sito)
-- Da eseguire una volta nel SQL Editor di Supabase, dopo schema.sql.
-- =====================================================================

-- Dati anagrafici del paziente registrato (uno per account)
create table public.pazienti (
  id uuid primary key references auth.users(id) on delete cascade,
  nome text not null,
  cognome text not null,
  codice_fiscale text not null,
  data_nascita date not null,
  telefono text not null,
  email text not null,
  consenso_privacy_il timestamptz not null,
  creato_il timestamptz not null default now(),
  aggiornato_il timestamptz not null default now()
);
create unique index pazienti_email_unica on public.pazienti (lower(email));

-- Collegamento facoltativo tra prenotazione e account del paziente
alter table public.prenotazioni
  add column paziente_id uuid references public.pazienti(id) on delete set null;
create index on public.prenotazioni (paziente_id, creata_il desc);

alter table public.pazienti enable row level security;

-- pazienti: ognuno vede i propri dati, l'amministratore tutti (le modifiche passano dalla funzione server)
create policy "paziente vede i propri dati" on public.pazienti
  for select to authenticated
  using (id = auth.uid() or public.mio_ruolo() = 'admin');

-- prenotazioni: in più, il paziente vede le proprie
drop policy "prenotazioni visibili" on public.prenotazioni;
create policy "prenotazioni visibili" on public.prenotazioni
  for select to authenticated
  using (
    public.mio_ruolo() = 'admin'
    or (hub_id is not null and hub_id = public.mio_hub())
    or medico_id = public.mio_medico()
    or paziente_id = auth.uid()
  );

-- medici e prestazioni: il paziente vede quelli delle proprie prenotazioni
create policy "medici delle mie prenotazioni" on public.medici
  for select to authenticated
  using (exists (select 1 from public.prenotazioni p where p.medico_id = medici.id and p.paziente_id = auth.uid()));
create policy "prestazioni delle mie prenotazioni" on public.prestazioni
  for select to authenticated
  using (exists (select 1 from public.prenotazioni p where p.prestazione_id = prestazioni.id and p.paziente_id = auth.uid()));

grant all on public.pazienti to service_role;
grant select on public.pazienti to authenticated;
