// Click Dottore - elenco unico delle specializzazioni (in ordine alfabetico)
// Usato dalla ricerca della pagina principale, dal modulo "Nuovo medico" dell'area riservata
// e dal modulo Lavora con noi: per aggiungere o togliere una voce basta modificare questo file
// (e aggiungere la stessa chiave in prestazioni-catalogo.js).
window.SPECIALIZZAZIONI = [
    'Allergologia ed Immunologia clinica', 'Anatomia Patologica', 'Anestesia Rianimazione, Terapia Intensiva e del dolore',
    'Audiologia e foniatria', 'Cardiochirurgia', 'Chiropratica',
    'Chirurgia Generale', 'Chirurgia Maxillo-Facciale', 'Chirurgia pediatrica',
    'Chirurgia plastica, ricostruttiva ed estetica', 'Chirurgia Toracica', 'Chirurgia Vascolare',
    'Dermatologia e Venereologia', 'Ematologia', 'Endocrinologia e malattie del metabolismo',
    'Farmacologia e Tossicologia Clinica', 'Fisioterapia', 'Genetica medica',
    'Geriatria', 'Ginecologia ed Ostetricia', 'Gnatologia',
    'Igiene e Medicina Preventiva', 'Logopedia', 'Malattie dell’apparato cardiovascolare',
    'Malattie dell’apparato digerente', 'Malattie dell’apparato respiratorio', 'Malattie Infettive e Tropicali',
    'Medicina d’emergenza-urgenza', 'Medicina del Lavoro', 'Medicina dello sport e dell’esercizio fisico',
    'Medicina di comunità e delle cure primarie', 'Medicina e Cure Palliative', 'Medicina fisica e riabilitativa',
    'Medicina interna', 'Medicina Legale', 'Medicina nucleare',
    'Medicina termale', 'Microbiologia e Virologia', 'Nefrologia',
    'Neurochirurgia', 'Neurologia', 'Neuropsichiatria infantile',
    'Odontoiatria', 'Oftalmologia', 'Oncologia medica',
    'Ortodonzia', 'Ortopedia e traumatologia', 'Osteopatia',
    'Otorinolaringoiatria', 'Patologia Clinica e Biochimica Clinica', 'Pediatria',
    'Podologia', 'Psichiatria', 'Psicologia',
    'Psicoterapia', 'Radiodiagnostica', 'Radioterapia',
    'Reumatologia', 'Scienza dell’alimentazione', 'Senologia',
    'Statistica sanitaria e Biometria', 'Urologia',
];

// Nomi usati fino a novembre 2026, con la specializzazione che li ha sostituiti:
// servono per i medici e le candidature già salvati con il nome precedente.
window.SPECIALIZZAZIONI_PRECEDENTI = {
    'Algologia (Terapia del Dolore)': 'Anestesia Rianimazione, Terapia Intensiva e del dolore',
    'Allergologia e Immunologia Clinica': 'Allergologia ed Immunologia clinica',
    'Andrologia': 'Urologia',
    'Anestesia e Rianimazione': 'Anestesia Rianimazione, Terapia Intensiva e del dolore',
    'Angiologia': 'Chirurgia Vascolare',
    'Audiologia e Foniatria': 'Audiologia e foniatria',
    'Biologia Nutrizionale': 'Scienza dell’alimentazione',
    'Cardiologia': 'Malattie dell’apparato cardiovascolare',
    'Chirurgia Bariatrica': 'Chirurgia Generale',
    'Chirurgia Pediatrica': 'Chirurgia pediatrica',
    'Chirurgia Plastica, Estetica e Ricostruttiva': 'Chirurgia plastica, ricostruttiva ed estetica',
    'Chirurgia Refrattiva': 'Oftalmologia',
    'Diabetologia': 'Endocrinologia e malattie del metabolismo',
    'Dietologia': 'Scienza dell’alimentazione',
    'Endocrinologia': 'Endocrinologia e malattie del metabolismo',
    'Epatologia': 'Malattie dell’apparato digerente',
    'Fisiatria (Medicina Fisica e Riabilitativa)': 'Medicina fisica e riabilitativa',
    'Gastroenterologia': 'Malattie dell’apparato digerente',
    'Genetica Medica': 'Genetica medica',
    'Ginecologia e Ostetricia': 'Ginecologia ed Ostetricia',
    'Malattie Infettive (Infettivologia)': 'Malattie Infettive e Tropicali',
    'Medicina Aeronautica e Spaziale': 'Medicina del Lavoro',
    'Medicina dello Sport': 'Medicina dello sport e dell’esercizio fisico',
    'Medicina Generale (Medico di Famiglia)': 'Medicina di comunità e delle cure primarie',
    'Medicina Interna': 'Medicina interna',
    'Medicina Nucleare': 'Medicina nucleare',
    'Medicina Termale': 'Medicina termale',
    'Neuropsichiatria Infantile': 'Neuropsichiatria infantile',
    'Neuropsicologia': 'Neurologia',
    'Nutrizione Clinica': 'Scienza dell’alimentazione',
    'Oculistica (Oftalmologia)': 'Oftalmologia',
    'Oncologia': 'Oncologia medica',
    'Ortopedia e Traumatologia': 'Ortopedia e traumatologia',
    'Ortottica': 'Oftalmologia',
    'Pneumologia': 'Malattie dell’apparato respiratorio',
    'Proctologia': 'Chirurgia Generale',
    'Radiologia (Radiodiagnostica)': 'Radiodiagnostica',
};

// Altri modi di cercare una specializzazione (nomi precedenti e parole d'uso comune):
// nei suggerimenti compare la specializzazione dell'elenco.
window.SINONIMI_SPECIALIZZAZIONI = {
    'Allergologia ed Immunologia clinica': ['Allergologia e Immunologia Clinica', 'allergologo'],
    'Anestesia Rianimazione, Terapia Intensiva e del dolore': ['Algologia', 'Terapia del Dolore', 'Anestesia e Rianimazione', 'anestesista', 'algologo'],
    'Audiologia e foniatria': ['audiologo', 'foniatra'],
    'Chiropratica': ['chiropratico'],
    'Chirurgia Generale': ['Chirurgia Bariatrica', 'Proctologia', 'chirurgo', 'proctologo'],
    'Chirurgia Maxillo-Facciale': ['chirurgo maxillo-facciale'],
    'Chirurgia plastica, ricostruttiva ed estetica': ['Chirurgia Plastica, Estetica e Ricostruttiva', 'chirurgo plastico', 'chirurgo estetico'],
    'Chirurgia Vascolare': ['Angiologia', 'angiologo', 'chirurgo vascolare'],
    'Dermatologia e Venereologia': ['dermatologo', 'dermatologa'],
    'Ematologia': ['ematologo'],
    'Endocrinologia e malattie del metabolismo': ['Diabetologia', 'Endocrinologia', 'endocrinologo', 'diabetologo', 'tiroide', 'diabete'],
    'Fisioterapia': ['fisioterapista'],
    'Geriatria': ['geriatra'],
    'Ginecologia ed Ostetricia': ['Ginecologia e Ostetricia', 'ginecologo', 'ginecologa', 'ostetrica'],
    'Gnatologia': ['gnatologo', 'bite'],
    'Logopedia': ['logopedista'],
    'Malattie dell’apparato cardiovascolare': ['Cardiologia', 'cardiologo', 'cardiologa', 'cardiaco', 'cuore'],
    'Malattie dell’apparato digerente': ['Epatologia', 'Gastroenterologia', 'gastroenterologo', 'epatologo', 'endoscopia', 'fegato'],
    'Malattie dell’apparato respiratorio': ['Pneumologia', 'pneumologo', 'polmoni', 'broncopneumologia'],
    'Malattie Infettive e Tropicali': ['Malattie Infettive', 'Infettivologia', 'infettivologo', 'medicina dei viaggi'],
    'Medicina del Lavoro': ['Medicina Aeronautica e Spaziale'],
    'Medicina dello sport e dell’esercizio fisico': ['Medicina dello Sport', 'medico sportivo', 'idoneità sportiva'],
    'Medicina di comunità e delle cure primarie': ['Medicina Generale', 'Medico di Famiglia', 'medico di base'],
    'Medicina fisica e riabilitativa': ['Fisiatria', 'fisiatra', 'riabilitazione'],
    'Nefrologia': ['nefrologo'],
    'Neurologia': ['Neuropsicologia', 'neurologo', 'neuropsicologo'],
    'Odontoiatria': ['dentista', 'odontoiatra', 'denti'],
    'Oftalmologia': ['Chirurgia Refrattiva', 'Oculistica', 'Ortottica', 'oculista', 'oftalmologo', 'occhi', 'ortottista'],
    'Oncologia medica': ['Oncologia', 'oncologo'],
    'Ortodonzia': ['ortodontista', 'apparecchio per i denti'],
    'Ortopedia e traumatologia': ['ortopedico'],
    'Osteopatia': ['osteopata'],
    'Otorinolaringoiatria': ['otorino'],
    'Pediatria': ['pediatra'],
    'Podologia': ['podologo', 'piedi'],
    'Psichiatria': ['psichiatra'],
    'Psicologia': ['psicologo', 'psicologa'],
    'Psicoterapia': ['psicoterapeuta'],
    'Radiodiagnostica': ['Radiologia', 'radiologo', 'ecografia'],
    'Reumatologia': ['reumatologo'],
    'Scienza dell’alimentazione': ['Biologia Nutrizionale', 'Dietologia', 'Nutrizione Clinica', 'nutrizionista', 'dietologo', 'dietista', 'dieta'],
    'Senologia': ['senologo', 'seno'],
    'Urologia': ['Andrologia', 'urologo', 'andrologo'],
};

// Specializzazione dell'elenco corrispondente a un testo: nome attuale, nome precedente o sinonimo
// (senza distinguere maiuscole, accenti e apostrofi). Restituisce null se non corrisponde a nessuna.
window.specializzazioneDa = (function () {
    const norm = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/['’`´.\-,()]+/g, ' ').replace(/\s+/g, ' ').trim();
    const mappa = new Map();
    window.SPECIALIZZAZIONI.forEach((s) => mappa.set(norm(s), s));
    Object.entries(window.SPECIALIZZAZIONI_PRECEDENTI).forEach(([v, s]) => { if (!mappa.has(norm(v))) mappa.set(norm(v), s); });
    Object.entries(window.SINONIMI_SPECIALIZZAZIONI).forEach(([s, l]) => l.forEach((x) => { if (!mappa.has(norm(x))) mappa.set(norm(x), s); }));
    return (testo) => mappa.get(norm(testo)) || null;
})();
