-- =====================================================================
-- Click Dottore - medici e hub di prova nascosti dal sito pubblico (27/11/2026)
-- Eseguito prima dell'apertura: nessuna cancellazione, solo attivo = false.
-- Restano nel database con utenze, prenotazioni e abbonamenti di prova.
-- Per riattivarli: stesse istruzioni con "attivo = true".
-- Per eliminarli definitivamente (irreversibile senza backup) valutare prima
-- le prenotazioni collegate.
-- =====================================================================
update public.medici set attivo = false where id in (
  '5b3f2dea-e9bc-4bed-b5ba-4c6155cef265',   -- Laura Bianchi
  'a84b7f8f-24c2-410f-8fa1-8afa8f04e4c1',   -- Paolo Neri
  '35e57d6a-0516-4c2c-8a2e-1fbba0d8633f',   -- Prova Verifica
  'c4b3c20f-5caa-4622-bf89-d6b182dda338');  -- Mario Rossi
update public.hub set attivo = false where id in (
  'd8ea7480-75ec-492d-961c-d052055fd963',   -- Hub di prova (PROVA)
  'eabd772a-4cbf-4228-8b8d-382545ff92be');  -- Studio Dott. Paolo Neri (NERI)
