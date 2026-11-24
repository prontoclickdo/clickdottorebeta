-- =====================================================================
-- Click Dottore - politica di rimborso
-- Se il paziente annulla a meno di 48 ore dalla visita la quota non si rimborsa:
-- la prenotazione resta "annullata" con quota_trattenuta = true e conta nei conti con gli hub.
-- Da eseguire dopo conferma-medico.sql.
-- =====================================================================

alter table public.prenotazioni
  add column quota_trattenuta boolean not null default false;

create or replace view public.conti_hub with (security_invoker = true) as
  select h.id as hub_id, h.nome, h.codice,
         coalesce(sum(p.quota_cents - p.quota_hub_cents) filter (where p.incassata_da = 'hub'), 0)::int as dovuto_a_click_dottore,
         coalesce(sum(p.quota_hub_cents) filter (where p.incassata_da = 'click_dottore'), 0)::int as dovuto_all_hub,
         (select coalesce(sum(r.importo_cents), 0) from public.regolazioni r where r.hub_id = h.id)::int as versato_netto
    from public.hub h
    left join public.prenotazioni p
      on p.hub_id = h.id and p.canale = 'hub' and p.pagata_il is not null
     and (p.stato in ('confermata', 'completata') or p.quota_trattenuta)
   group by h.id, h.nome, h.codice;
