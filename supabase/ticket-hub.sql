-- =====================================================================
-- Click Dottore - ticket al 10% della prestazione, incassato dagli hub
-- Da eseguire dopo abbonamenti.sql.
--
-- - Il ticket di prenotazione è una percentuale (impostazione ticket_percento,
--   10%) della tariffa della prestazione prenotata.
-- - Ogni prenotazione online viene affidata all'hub della città del medico
--   (o all'hub più vicino): l'hub incassa l'intero ticket sul proprio conto
--   Stripe collegato (Stripe Connect) e può gestire la richiesta.
-- - Click Dottore non trattiene più nulla dei ticket: percepisce solo gli
--   abbonamenti di medici e hub.
-- =====================================================================

-- Conto Stripe collegato dell'hub (Stripe Connect)
alter table public.hub
  add column if not exists stripe_account_id text unique,
  add column if not exists stripe_pronto boolean not null default false;   -- può già ricevere pagamenti

-- Coordinate del comune del medico, per trovare l'hub più vicino
alter table public.medici
  add column if not exists lat double precision,
  add column if not exists lng double precision;

-- Conto Stripe su cui è stato pagato il ticket (quello dell'hub)
alter table public.prenotazioni
  add column if not exists stripe_account_id text;

-- Percentuale del ticket sulla tariffa della prestazione
insert into public.impostazioni (chiave, valore) values ('ticket_percento', '10')
on conflict (chiave) do nothing;

-- L'hub percepisce l'intero ticket (nessuna quota a Click Dottore)
insert into public.impostazioni (chiave, valore) values ('quota_hub_percento', '100')
on conflict (chiave) do update set valore = '100';

-- Pagamento confermato: se è avvenuto sul conto dell'hub, la quota risulta incassata dall'hub
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
         incassata_da = case when p.stripe_account_id is not null then 'hub' else 'click_dottore' end,
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
  values ('pagamento_stripe', p.id, jsonb_build_object('session', p_session_id, 'conto', p.stripe_account_id));
  return query select p.id, p.codice, true, p.stato;
end;
$$;
revoke execute on function public.conferma_pagamento(uuid, text, text) from public, anon, authenticated;
grant execute on function public.conferma_pagamento(uuid, text, text) to service_role;

-- I pagamenti sui conti degli hub non arrivano al webhook di Click Dottore:
-- ogni 5 minuti la funzione server controlla con Stripe i pagamenti ancora in sospeso
select cron.schedule('verifica-pagamenti-hub', '*/5 * * * *', $cron$
  select net.http_post(
    url := 'https://awxrrjwzlqghkmsqgkpw.supabase.co/functions/v1/api/verifica-pagamenti',
    headers := '{"Content-Type": "application/json", "apikey": "sb_publishable_r2K5TaXfKd8Bjj7iQek_Aw_WgIlHDQy"}'::jsonb,
    body := '{}'::jsonb
  );
$cron$);
