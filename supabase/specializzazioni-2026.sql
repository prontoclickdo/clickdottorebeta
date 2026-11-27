-- Click Dottore - nuovo elenco delle specializzazioni (novembre 2026)
-- Aggiorna i medici e le candidature salvati con i nomi precedenti delle specializzazioni,
-- usando la stessa tabella di corrispondenza di specializzazioni.js (window.SPECIALIZZAZIONI_PRECEDENTI).
-- Le prestazioni dei medici non cambiano: i nomi sono rimasti gli stessi.
-- Medicina Estetica e Medicina Subacquea e Iperbarica sono state eliminate: nessun medico le usava.
-- Si può eseguire più volte: le righe già aggiornate non vengono toccate.
-- Da eseguire nell'editor SQL di Supabase.

begin;

create temporary table nuove_specializzazioni (precedente text primary key, attuale text not null) on commit drop;
insert into nuove_specializzazioni (precedente, attuale) values
    ('Algologia (Terapia del Dolore)', 'Anestesia Rianimazione, Terapia Intensiva e del dolore'),
    ('Allergologia e Immunologia Clinica', 'Allergologia ed Immunologia clinica'),
    ('Andrologia', 'Urologia'),
    ('Anestesia e Rianimazione', 'Anestesia Rianimazione, Terapia Intensiva e del dolore'),
    ('Angiologia', 'Chirurgia Vascolare'),
    ('Audiologia e Foniatria', 'Audiologia e foniatria'),
    ('Biologia Nutrizionale', 'Scienza dell’alimentazione'),
    ('Cardiologia', 'Malattie dell’apparato cardiovascolare'),
    ('Chirurgia Bariatrica', 'Chirurgia Generale'),
    ('Chirurgia Pediatrica', 'Chirurgia pediatrica'),
    ('Chirurgia Plastica, Estetica e Ricostruttiva', 'Chirurgia plastica, ricostruttiva ed estetica'),
    ('Chirurgia Refrattiva', 'Oftalmologia'),
    ('Diabetologia', 'Endocrinologia e malattie del metabolismo'),
    ('Dietologia', 'Scienza dell’alimentazione'),
    ('Endocrinologia', 'Endocrinologia e malattie del metabolismo'),
    ('Epatologia', 'Malattie dell’apparato digerente'),
    ('Fisiatria (Medicina Fisica e Riabilitativa)', 'Medicina fisica e riabilitativa'),
    ('Gastroenterologia', 'Malattie dell’apparato digerente'),
    ('Genetica Medica', 'Genetica medica'),
    ('Ginecologia e Ostetricia', 'Ginecologia ed Ostetricia'),
    ('Malattie Infettive (Infettivologia)', 'Malattie Infettive e Tropicali'),
    ('Medicina Aeronautica e Spaziale', 'Medicina del Lavoro'),
    ('Medicina dello Sport', 'Medicina dello sport e dell’esercizio fisico'),
    ('Medicina Interna', 'Medicina interna'),
    ('Medicina Nucleare', 'Medicina nucleare'),
    ('Medicina Termale', 'Medicina termale'),
    ('Neuropsichiatria Infantile', 'Neuropsichiatria infantile'),
    ('Neuropsicologia', 'Neurologia'),
    ('Nutrizione Clinica', 'Scienza dell’alimentazione'),
    ('Oculistica (Oftalmologia)', 'Oftalmologia'),
    ('Oncologia', 'Oncologia medica'),
    ('Ortopedia e Traumatologia', 'Ortopedia e traumatologia'),
    ('Ortottica', 'Oftalmologia'),
    ('Pneumologia', 'Malattie dell’apparato respiratorio'),
    ('Proctologia', 'Chirurgia Generale'),
    ('Radiologia (Radiodiagnostica)', 'Radiodiagnostica');

update public.medici m set specializzazione = n.attuale
  from nuove_specializzazioni n where lower(trim(m.specializzazione)) = lower(n.precedente);

update public.candidature c set specializzazione = n.attuale
  from nuove_specializzazioni n where lower(trim(c.specializzazione)) = lower(n.precedente);

commit;

-- verifica: specializzazioni dei medici dopo l'aggiornamento
select specializzazione, count(*) as medici from public.medici group by specializzazione order by specializzazione;
