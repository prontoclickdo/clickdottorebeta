-- =====================================================================
-- Click Dottore - niente più esenzioni dall'abbonamento
-- Medici, hub e medici+hub accedono all'area riservata (e compaiono nella
-- ricerca e tra gli hub) solo con un abbonamento Stripe attivo.
-- Da eseguire dopo genere-altro.sql.
-- =====================================================================
create or replace function public.abbonamento_valido(p_hub uuid, p_medico uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.abbonamenti a
     where ((p_hub is not null and a.hub_id = p_hub) or (p_medico is not null and a.medico_id = p_medico))
       and a.stato in ('active', 'trialing')
  ) or (p_medico is not null and exists (
    select 1 from public.profili pr
      join public.abbonamenti a on a.hub_id = pr.hub_id
     where pr.ruolo = 'medico_hub' and pr.attivo and pr.medico_id = p_medico
       and a.stato in ('active', 'trialing')
  ))
$$;

-- la colonna dell'esenzione viene eliminata: non è più possibile concederla
alter table public.abbonamenti drop column if exists esente;

-- righe rimaste senza abbonamento Stripe (erano solo esenzioni) non servono più
delete from public.abbonamenti where stripe_customer_id is null and stripe_subscription_id is null;
