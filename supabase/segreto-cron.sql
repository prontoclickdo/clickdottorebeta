-- =====================================================================
-- Click Dottore - codice segreto per le chiamate automatiche (pg_cron)
-- Le funzioni server "promemoria" e "verifica-pagamenti" rispondono solo se la
-- richiesta porta l'intestazione x-cron-secret con il codice salvato qui.
-- Il codice è generato a caso nel database e non è leggibile dal sito
-- (nessuna regola di accesso per visitatori e utenti: lo legge solo il server).
-- Da eseguire dopo promemoria.sql e ticket-hub.sql. Si può rieseguire:
-- il codice esistente non cambia (per cambiarlo: delete della riga e nuova esecuzione).
-- =====================================================================

create table if not exists public.chiavi_interne (
  nome text primary key,
  valore text not null
);
alter table public.chiavi_interne enable row level security;
revoke all on public.chiavi_interne from public, anon, authenticated;
grant all on public.chiavi_interne to service_role;

insert into public.chiavi_interne (nome, valore)
values ('cron', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (nome) do nothing;

-- I due processi automatici inviano il codice (letto dalla tabella a ogni esecuzione)
select cron.schedule('promemoria-visite', '5 * * * *', $cron$
  select net.http_post(
    url := 'https://awxrrjwzlqghkmsqgkpw.supabase.co/functions/v1/api/promemoria',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_r2K5TaXfKd8Bjj7iQek_Aw_WgIlHDQy',
      'x-cron-secret', (select valore from public.chiavi_interne where nome = 'cron')),
    body := '{}'::jsonb
  );
$cron$);

select cron.schedule('verifica-pagamenti-hub', '*/5 * * * *', $cron$
  select net.http_post(
    url := 'https://awxrrjwzlqghkmsqgkpw.supabase.co/functions/v1/api/verifica-pagamenti',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_r2K5TaXfKd8Bjj7iQek_Aw_WgIlHDQy',
      'x-cron-secret', (select valore from public.chiavi_interne where nome = 'cron')),
    body := '{}'::jsonb
  );
$cron$);

-- verifica: i due processi e il loro comando
select jobname, schedule, position('x-cron-secret' in command) > 0 as invia_codice
  from cron.job where jobname in ('promemoria-visite', 'verifica-pagamenti-hub');
