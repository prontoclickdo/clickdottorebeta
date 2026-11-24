-- =====================================================================
-- Click Dottore - promemoria al paziente il giorno prima della visita
-- Ogni ora pg_cron chiama la funzione server "api/promemoria", che invia l'email
-- per le visite confermate di domani (dalle 9 del mattino in poi), una sola volta per visita.
-- Da eseguire dopo conferma-medico.sql.
-- =====================================================================

create extension if not exists pg_net;

alter table public.prenotazioni add column promemoria_inviato_il timestamptz;

-- Segna e restituisce, una sola volta, le visite confermate di domani
create or replace function public.prenotazioni_da_ricordare()
returns table (id uuid)
language sql security definer set search_path = public as $$
  update public.prenotazioni p
     set promemoria_inviato_il = now()
   where p.stato = 'confermata'
     and p.promemoria_inviato_il is null
     and p.visita_il is not null
     and (p.visita_il at time zone 'Europe/Rome')::date = (now() at time zone 'Europe/Rome')::date + 1
     and extract(hour from now() at time zone 'Europe/Rome') >= 9
  returning p.id;
$$;
revoke execute on function public.prenotazioni_da_ricordare() from public, anon, authenticated;
grant execute on function public.prenotazioni_da_ricordare() to service_role;

-- Ogni ora, al minuto 5
select cron.schedule('promemoria-visite', '5 * * * *', $cron$
  select net.http_post(
    url := 'https://awxrrjwzlqghkmsqgkpw.supabase.co/functions/v1/api/promemoria',
    headers := '{"Content-Type": "application/json", "apikey": "sb_publishable_r2K5TaXfKd8Bjj7iQek_Aw_WgIlHDQy"}'::jsonb,
    body := '{}'::jsonb
  );
$cron$);
