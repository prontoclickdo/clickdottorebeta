-- =====================================================================
-- Click Dottore - posizione degli hub sulla mappa pubblica (pagina hub.html)
-- Da eseguire dopo schema.sql.
-- =====================================================================

alter table public.hub
  add column lat double precision check (lat between -90 and 90),
  add column lng double precision check (lng between -180 and 180);

-- Hub visibili a tutti sulla mappa: solo quelli attivi e con una posizione
create or replace view public.hub_pubblici as
  select id, nome, tipo, citta, indirizzo, telefono, lat, lng
    from public.hub
   where attivo and lat is not null and lng is not null;

grant select on public.hub_pubblici to anon, authenticated;
