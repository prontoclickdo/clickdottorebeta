-- =====================================================================
-- Click Dottore - richieste di adesione di medici e hub (pagina "Lavora con noi")
-- Da eseguire dopo schema.sql.
-- =====================================================================

create table public.candidature (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('medico', 'struttura', 'medico_hub')),
  nome text not null,
  cognome text,
  struttura text,                -- ragione sociale o nome della struttura
  specializzazione text,
  citta text not null,
  provincia text,
  indirizzo text,
  telefono text not null,
  email text not null,
  partita_iva text,
  messaggio text,
  consenso_privacy_il timestamptz not null,
  stato text not null default 'nuova' check (stato in ('nuova', 'in_valutazione', 'accettata', 'rifiutata')),
  creata_il timestamptz not null default now()
);
create index on public.candidature (creata_il desc);

alter table public.candidature enable row level security;
create policy "candidature visibili all'admin" on public.candidature
  for select to authenticated using (public.mio_ruolo() = 'admin');

grant all on public.candidature to service_role;
grant select on public.candidature to authenticated;

-- indirizzo a cui inviare le richieste (si imposta dall'area riservata, scheda Impostazioni)
insert into public.impostazioni (chiave, valore) values ('email_candidature', '') on conflict (chiave) do nothing;
