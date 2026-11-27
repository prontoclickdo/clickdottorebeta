// Suggerimenti dei medici nella casella "Specializzazione o medico":
// si cercano per nome, cognome e titolo (Dott., Dott.ssa o quello scelto dal medico) già dalla prima lettera.
(function () {
    const URL_MEDICI = 'https://awxrrjwzlqghkmsqgkpw.supabase.co/rest/v1/medici_pubblici?select=id,nome,cognome,genere,titolo,specializzazione,citta,prenotabile&order=cognome';
    const CHIAVE = 'sb_publishable_r2K5TaXfKd8Bjj7iQek_Aw_WgIlHDQy';
    const norm = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/['’`´.\-]+/g, ' ').replace(/\s+/g, ' ').trim();

    const titolo = (m) => (m.genere === 'F' ? 'Dott.ssa' : m.genere === 'A' && m.titolo ? m.titolo : 'Dott.');
    let medici = null, attesa = null;
    const inAttesa = [];

    function carica() {
        if (attesa) return attesa;
        attesa = fetch(URL_MEDICI, { headers: { apikey: CHIAVE, Authorization: `Bearer ${CHIAVE}` } })
            .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
            .then((righe) => {
                medici = righe.map((m) => {
                    const t = titolo(m);
                    // parole cercabili: titolo (anche per esteso), nome e cognome
                    const extra = m.genere === 'F' ? 'dottoressa' : m.genere === 'M' ? 'dottore' : '';
                    return { ...m, etichetta: `${t} ${m.nome} ${m.cognome}`, parole: norm(`${t} ${extra} ${m.nome} ${m.cognome}`).split(' ') };
                });
                inAttesa.splice(0).forEach((f) => f());
                return medici;
            })
            .catch(() => { attesa = null; medici = null; });
        return attesa;
    }

    // medici in cui ogni parola digitata è l'inizio di una parola tra titolo, nome e cognome
    function trova(testo) {
        const parti = norm(testo).split(' ').filter(Boolean);
        if (!parti.length || !medici) return [];
        return medici
            .filter((m) => parti.every((p) => m.parole.some((w) => w.startsWith(p))))
            .sort((a, b) => a.cognome.localeCompare(b.cognome, 'it', { sensitivity: 'base' }) || a.nome.localeCompare(b.nome, 'it', { sensitivity: 'base' }));
    }

    window.SuggerimentiMedici = {
        carica,
        trova,
        pronti: () => !!medici,
        // richiama la funzione quando l'elenco è arrivato (per aggiornare la tendina già aperta)
        quandoPronti: (f) => { if (medici) f(); else { inAttesa.push(f); carica(); } },
        link: (m) => `prenota.html?medico=${encodeURIComponent(m.id)}`,
        dettagli: (m) => [m.specializzazione, m.citta].filter(Boolean).join(' · '),
    };
})();
