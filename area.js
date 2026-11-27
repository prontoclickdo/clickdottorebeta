// Click Dottore - area riservata (amministratore, operatori degli hub, medici)
import {
    supabase, api, esc, euro, dataOra, data, quando, durata, ticketPercento, ticketDi, percentoTesto, badgeStato,
    htmlCampiPaziente, leggiPaziente, erroriPaziente, messaggio, classeCampo, slotLiberi, selettoreSlot, seguiCambioUtente,
} from './app.js?v=5';

const $ = (id) => document.getElementById(id);
const RUOLI = { admin: 'Amministratore', operatore: 'Hub', medico: 'Medico', medico_hub: 'Medico e hub' };
const ATTIVE = ['richiesta', 'da_pagare', 'confermata'];
const CHIUSE = ['completata', 'annullata', 'rimborsata', 'rifiutata', 'scaduta'];
const GIORNI = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica'];
const METODI = { pos: 'POS / carta', contanti: 'contanti', bonifico: 'bonifico istantaneo', altro: 'altro', stripe: 'carta online', bollettino: 'bollettino online' };

const st = {
    io: null, scheda: null, percento: 10, stripeHub: null,
    prenotazioni: [], filtro: 'attive', cerca: '',
    medici: [], prestazioni: [], hub: [], profili: [],
    nuova: { medicoId: null, cercaMedico: '', hubId: null, prestazioneId: null, slot: null, esito: null },
    pannelloId: null,
    medicoGestito: null, listinoSpec: null,      // medico di cui si modificano orari e tariffe (il proprio, o scelto dall'admin)
    orari: [], chiusure: [],
    impostazioni: {}, conti: [], regolazioni: [], candidature: [],
    daConfermare: 0,
    abbonamento: null, abbonamenti: [],
};

const btnPrimario = 'px-4 py-2.5 bg-skybrand-500 hover:bg-skybrand-600 text-white text-sm font-semibold rounded-xl transition disabled:opacity-60';
const btnSecondario = 'px-4 py-2.5 border border-slate-300 text-slate-700 text-sm font-medium rounded-xl hover:border-skybrand-400 transition disabled:opacity-60';
const btnPericolo = 'px-4 py-2.5 border border-red-200 text-red-700 text-sm font-medium rounded-xl hover:bg-red-50 transition disabled:opacity-60';
const card = 'bg-white border border-slate-200 rounded-2xl p-5';

function avviso(testo, tipo = 'errore') {
    const el = $('msg-globale');
    if (!testo) { el.hidden = true; return; }
    el.hidden = false;
    messaggio(el, testo, tipo);
    if (tipo === 'ok') setTimeout(() => { el.hidden = true; }, 5000);
}

// ---------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------
async function avvia() {
    const { data: s } = await supabase.auth.getSession();
    if (!s.session) return location.replace('accedi.html');
    const { data: profilo } = await supabase.from('profili')
        .select('*, hub:hub(nome, codice, tipo), medico:medici(nome, cognome, genere, titolo)')
        .eq('id', s.session.user.id).maybeSingle();
    if (!profilo) {
        // account di un paziente: ha la sua area personale
        const { data: paz } = await supabase.from('pazienti').select('id').eq('id', s.session.user.id).maybeSingle();
        if (paz) return location.replace('area-paziente.html');
    }
    $('caricamento').hidden = true;
    $('testata-destra').innerHTML = `
        <span class="hidden sm:block text-right leading-tight"><span class="block font-semibold text-slate-800">${esc(profilo?.nome || s.session.user.email)}</span>
        <span class="block text-xs text-slate-500">${esc(RUOLI[profilo?.ruolo] || '')}</span></span>
        <button type="button" data-esci class="px-3 py-2 border border-slate-300 rounded-xl text-slate-700 hover:border-skybrand-400 transition"><i class="fa-solid fa-right-from-bracket"></i><span class="hidden sm:inline ml-1.5">Esci</span></button>`;
    if (!profilo || !profilo.attivo) { $('bloccato').hidden = false; return; }
    st.io = profilo;
    st.percento = await ticketPercento();
    st.medicoGestito = profilo.medico_id || null;

    const dove = profilo.ruolo === 'admin' ? 'Click Dottore'
        : profilo.hub ? `${profilo.hub.nome} · codice hub ${profilo.hub.codice}`
        : profilo.medico ? `${profilo.medico?.genere === 'F' ? 'Dott.ssa' : profilo.medico?.genere === 'A' && profilo.medico?.titolo ? profilo.medico.titolo : 'Dott.'} ${profilo.medico.nome} ${profilo.medico.cognome}` : '';
    $('sottotitolo').textContent = `${RUOLI[profilo.ruolo]}${dove ? ' · ' + dove : ''}`;
    $('app').hidden = false;

    // medici e hub: l'area si sblocca solo con un abbonamento valido
    if (profilo.ruolo !== 'admin') {
        const qs = new URLSearchParams(location.search);
        const esito = qs.get('abbonamento');
        if (esito) history.replaceState(null, '', location.pathname);
        st.abbonamento = await api('stato-abbonamento', { conAccesso: true, dati: { session_id: qs.get('session_id') || undefined } });
        $('sottotitolo').textContent = `${RUOLI[profilo.ruolo]} · ${st.abbonamento.nome}`;
        if (!st.abbonamento.valido) {
            mostraPiani();
            if (esito === 'ok') avviso('Pagamento ricevuto: stiamo attivando l\'abbonamento. Se l\'area non si sblocca entro un minuto, ricarica la pagina.', 'info');
            if (esito === 'annullato') avviso('Pagamento annullato: nessun addebito è stato effettuato.', 'info');
            return;
        }
        if (esito === 'ok') setTimeout(() => avviso('Abbonamento attivo: benvenuto in Click Dottore!', 'ok'), 300);
    }

    // avviso delle richieste da confermare (per il medico), sopra le schede
    const banner = document.createElement('div');
    banner.id = 'avviso-richieste';
    banner.hidden = true;
    banner.className = 'mb-4';
    $('schede').before(banner);

    if (profilo.ruolo === 'admin') await Promise.all([caricaHub(), caricaMedici(), caricaProfili()]);
    else await caricaMedici();
    if (profilo.medico_id || profilo.hub_id) {
        await contaRichieste();
        setInterval(controllaNuoveRichieste, 60000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) controllaNuoveRichieste(); });
    }
    if (st.daConfermare) st.filtro = 'da_confermare';
    if (profilo.hub_id && profilo.ruolo !== 'admin') {
        const ritorno = new URLSearchParams(location.search).get('stripe');
        if (ritorno) history.replaceState(null, '', location.pathname);
        await caricaStatoStripe();
        if (ritorno) return vai('incassi');
    }
    vai(profilo.ruolo === 'operatore' ? 'nuova' : 'prenotazioni');
}

// ---------------------------------------------------------------------
// Avviso delle nuove richieste per il medico
// ---------------------------------------------------------------------
async function contaRichieste() {
    if (!st.io?.medico_id && !st.io?.hub_id) return 0;
    let q = supabase.from('prenotazioni').select('id', { count: 'exact', head: true })
        .eq('stato', 'richiesta').gt('scadenza', new Date().toISOString());
    // il medico conferma le proprie richieste, l'hub quelle dei medici della sua zona (il medico che fa da hub entrambe)
    q = st.io.medico_id && st.io.hub_id ? q.or(`medico_id.eq.${st.io.medico_id},hub_id.eq.${st.io.hub_id}`)
        : st.io.medico_id ? q.eq('medico_id', st.io.medico_id) : q.eq('hub_id', st.io.hub_id);
    const { count } = await q;
    st.daConfermare = count || 0;
    disegnaAvvisoRichieste();
    return st.daConfermare;
}

function disegnaAvvisoRichieste() {
    const el = $('avviso-richieste');
    if (!el) return;
    const n = st.daConfermare;
    document.title = `${n ? `(${n}) ` : ''}Area riservata – Click Dottore`;
    if (!n) { el.hidden = true; if (st.scheda) schede(); return; }
    el.hidden = false;
    el.innerHTML = `
        <div class="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div class="text-sm text-amber-900"><i class="fa-solid fa-bell mr-2"></i><strong>${n === 1 ? 'Hai 1 richiesta di prenotazione' : `Hai ${n} richieste di prenotazione`}</strong> da confermare o rifiutare.</div>
            <button type="button" data-vedi-richieste class="shrink-0 px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold rounded-xl transition">Vedi le richieste</button>
        </div>`;
    if (st.scheda) schede();
}

async function controllaNuoveRichieste() {
    const prima = st.daConfermare;
    await contaRichieste();
    if (st.daConfermare !== prima && st.scheda === 'prenotazioni' && $('pannello').hidden) {
        await caricaPrenotazioni();
        disegnaPrenotazioni();
    }
}

function schede() {
    const io = st.io, r = io.ruolo;
    const elenco = [['prenotazioni', 'Prenotazioni', 'fa-list-check']];
    if (r === 'admin' || io.hub_id) elenco.push(['nuova', 'Nuova prenotazione', 'fa-plus']);
    if (r === 'admin' || io.medico_id) elenco.push(['orari', 'Orari', 'fa-clock'], ['tariffe', 'Prestazioni e tariffe', 'fa-tags']);
    if (r === 'admin') elenco.push(['conti', 'Conti hub (storico)', 'fa-scale-balanced']);
    else if (io.hub_id) elenco.push(['incassi', 'Incassi', 'fa-wallet']);
    if (r === 'admin') elenco.push(['medici', 'Medici', 'fa-user-doctor'], ['hub', 'Hub', 'fa-hospital'], ['utenze', 'Utenze', 'fa-users'], ['candidature', 'Candidature', 'fa-envelope-open-text'], ['impostazioni', 'Impostazioni', 'fa-gear']);
    if (r === 'operatore') elenco.unshift(elenco.splice(1, 1)[0]);
    if (r !== 'admin') elenco.push(['abbonamento', 'Abbonamento', 'fa-id-card']);
    $('schede').innerHTML = elenco.map(([id, testo, icona]) => `
        <button type="button" data-scheda="${id}" class="shrink-0 px-4 py-2 rounded-xl text-sm font-medium border transition ${st.scheda === id ? 'bg-skybrand-500 text-white border-transparent' : 'bg-white border-slate-200 text-slate-700 hover:border-skybrand-300'}">
            <i class="fa-solid ${icona} mr-1.5"></i>${testo}${id === 'prenotazioni' && st.daConfermare ? ` <span class="ml-1 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full text-xs font-bold bg-amber-500 text-white">${st.daConfermare}</span>` : ''}</button>`).join('');
}

async function vai(scheda) {
    st.scheda = scheda;
    avviso('');
    schede();
    const v = $('vista');
    v.innerHTML = `<div class="text-center text-sm text-slate-500 py-10"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Caricamento...</div>`;
    try {
        if (scheda === 'prenotazioni') { await caricaPrenotazioni(); disegnaPrenotazioni(); }
        if (scheda === 'nuova') disegnaNuova();
        if (scheda === 'orari') { await caricaOrari(); disegnaOrari(); }
        if (scheda === 'tariffe') { await caricaMedici(); disegnaTariffe(); }
        if (scheda === 'conti') { await caricaConti(); disegnaConti(); }
        if (scheda === 'incassi') { await Promise.all([caricaStatoStripe(), caricaPrenotazioni()]); disegnaIncassi(); }
        if (scheda === 'medici') { await Promise.all([caricaMedici(), caricaAbbonamenti()]); disegnaMedici(); }
        if (scheda === 'hub') { await Promise.all([caricaHub(), caricaAbbonamenti()]); disegnaHub(); }
        if (scheda === 'abbonamento') { st.abbonamento = await api('stato-abbonamento', { conAccesso: true, dati: {} }); disegnaAbbonamento(); }
        if (scheda === 'utenze') { await Promise.all([caricaProfili(), caricaHub(), caricaMedici()]); disegnaUtenze(); }
        if (scheda === 'impostazioni') { await caricaImpostazioni(); disegnaImpostazioni(); }
        if (scheda === 'candidature') { await caricaCandidature(); disegnaCandidature(); }
    } catch (err) {
        v.innerHTML = '';
        avviso(err.message || 'Caricamento non riuscito');
    }
}

// ---------------------------------------------------------------------
// Caricamento dati
// ---------------------------------------------------------------------
async function caricaPrenotazioni() {
    const { data: righe, error } = await supabase.from('prenotazioni')
        .select('*, medico:medici(nome, cognome, genere, titolo, specializzazione, citta, indirizzo), prestazione:prestazioni(nome, durata_minuti), hub:hub(nome, codice)')
        .order('creata_il', { ascending: false }).limit(500);
    if (error) throw new Error('Impossibile caricare le prenotazioni');
    // le richieste scadute ma non ancora aggiornate dal server si mostrano già come scadute
    const ora = Date.now();
    st.prenotazioni = (righe || []).map((p) => (['richiesta', 'da_pagare'].includes(p.stato) && p.scadenza && new Date(p.scadenza).getTime() < ora ? { ...p, stato: 'scaduta' } : p));
    if (st.io.medico_id || st.io.hub_id) {
        st.daConfermare = st.prenotazioni.filter((p) => p.stato === 'richiesta' && ((st.io.medico_id && p.medico_id === st.io.medico_id) || (st.io.hub_id && p.hub_id === st.io.hub_id))).length;
        disegnaAvvisoRichieste();
    }
}
async function caricaMedici() {
    const [{ data: m }, { data: p }] = await Promise.all([
        supabase.from('medici').select('*').order('cognome'),
        supabase.from('prestazioni').select('*').order('nome'),
    ]);
    st.medici = m || []; st.prestazioni = p || [];
    if (!st.medicoGestito && st.io.ruolo === 'admin' && st.medici.length) st.medicoGestito = st.medici[0].id;
}
async function caricaHub() {
    const { data: h } = await supabase.from('hub').select('*').order('nome');
    st.hub = h || [];
}
async function caricaAbbonamenti() {
    const { data: a } = await supabase.from('abbonamenti').select('*');
    st.abbonamenti = a || [];
}
async function caricaProfili() {
    const { data: p } = await supabase.from('profili').select('*, hub:hub(nome, codice), medico:medici(nome, cognome, genere, titolo)').order('creato_il', { ascending: false });
    st.profili = p || [];
}
async function caricaOrari() {
    if (!st.medici.length) await caricaMedici();
    if (!st.medicoGestito) { st.orari = []; st.chiusure = []; return; }
    const [{ data: o }, { data: c }] = await Promise.all([
        supabase.from('disponibilita').select('*').eq('medico_id', st.medicoGestito).order('giorno_settimana').order('ora_inizio'),
        supabase.from('chiusure').select('*').eq('medico_id', st.medicoGestito).gte('al', new Date().toISOString().slice(0, 10)).order('dal'),
    ]);
    st.orari = (o || []).map((f) => ({ giorno: f.giorno_settimana, inizio: f.ora_inizio.slice(0, 5), fine: f.ora_fine.slice(0, 5) }));
    st.chiusure = c || [];
}
async function caricaImpostazioni() {
    const { data: righe } = await supabase.from('impostazioni').select('chiave, valore');
    st.impostazioni = Object.fromEntries((righe || []).map((r) => [r.chiave, r.valore]));
}
async function caricaConti() {
    await caricaImpostazioni();
    const [{ data: c }, { data: r }] = await Promise.all([
        supabase.from('conti_hub').select('*').order('nome'),
        supabase.from('regolazioni').select('*, hub:hub(nome)').order('data', { ascending: false }).limit(100),
    ]);
    st.conti = c || []; st.regolazioni = r || [];
}

// Selettore del medico per l'amministratore (orari e tariffe)
function sceltaMedico() {
    if (st.io.ruolo !== 'admin') return '';
    return `<div class="${card} mb-4"><label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Medico</span>
        <select id="medico-gestito" class="${classeCampo}">${st.medici.map((m) => `<option value="${m.id}" ${m.id === st.medicoGestito ? 'selected' : ''}>${m?.genere === 'F' ? 'Dott.ssa' : m?.genere === 'A' && m?.titolo ? m.titolo : 'Dott.'} ${esc(m.cognome)} ${esc(m.nome)} · ${esc(m.specializzazione)}</option>`).join('')}</select></label></div>`;
}

// ---------------------------------------------------------------------
// Prenotazioni
// ---------------------------------------------------------------------
function prenotazioniFiltrate() {
    const q = st.cerca.trim().toLowerCase();
    return st.prenotazioni.filter((p) => {
        if (st.filtro === 'da_confermare' && p.stato !== 'richiesta') return false;
        if (st.filtro === 'attive' && !ATTIVE.includes(p.stato)) return false;
        if (st.filtro === 'chiuse' && !CHIUSE.includes(p.stato)) return false;
        if (!q) return true;
        return [p.codice, p.paziente_nome, p.paziente_cognome, p.paziente_codice_fiscale, p.medico?.cognome]
            .some((x) => String(x || '').toLowerCase().includes(q));
    }).sort((a, b) => {
        // le attive in ordine di visita, le altre dalla più recente
        if (st.filtro !== 'chiuse' && st.filtro !== 'tutte') return new Date(a.visita_il || 0) - new Date(b.visita_il || 0);
        return 0;
    });
}

function disegnaPrenotazioni() {
    const filtri = [['da_confermare', 'Da confermare'], ['attive', 'Attive'], ['chiuse', 'Chiuse'], ['tutte', 'Tutte']];
    const nRichieste = st.prenotazioni.filter((p) => p.stato === 'richiesta').length;
    $('vista').innerHTML = `
        <div class="flex flex-col md:flex-row md:items-center gap-3 mb-4">
            <div class="flex gap-2 overflow-x-auto">${filtri.map(([id, t]) => `
                <button type="button" data-filtro="${id}" class="shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border transition ${st.filtro === id ? 'bg-slate-900 text-white border-transparent' : 'bg-white border-slate-200 text-slate-600'}">${t}${id === 'da_confermare' && nRichieste ? ` (${nRichieste})` : ''}</button>`).join('')}
            </div>
            <input id="cerca-prenotazioni" type="search" value="${esc(st.cerca)}" placeholder="Cerca per codice, paziente o codice fiscale" class="${classeCampo} md:max-w-sm md:ml-auto">
        </div>
        <div id="elenco-prenotazioni" class="space-y-2"></div>`;
    disegnaElencoPrenotazioni();
}

function disegnaElencoPrenotazioni() {
    const righe = prenotazioniFiltrate();
    const comeMedico = (p) => st.io.ruolo === 'admin' || (st.io.medico_id && st.io.medico_id === p.medico_id) || (st.io.hub_id && st.io.hub_id === p.hub_id);
    $('elenco-prenotazioni').innerHTML = righe.length ? righe.map((p) => `
        <div class="${card} !p-4 ${p.stato === 'richiesta' ? 'border-amber-300' : ''}">
            <button type="button" data-apri="${p.id}" class="w-full text-left flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                <div class="sm:w-60 shrink-0">
                    <div class="font-semibold text-slate-900 text-sm"><i class="fa-regular fa-calendar mr-1.5 text-slate-400"></i>${p.visita_il ? esc(dataOra(p.visita_il)) : 'orario da definire'}</div>
                    <div class="text-xs text-slate-500 font-mono">${esc(p.codice || '')}</div>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="font-semibold text-slate-800 truncate">${esc(p.paziente_cognome)} ${esc(p.paziente_nome)}</div>
                    <div class="text-xs text-slate-500 truncate">${esc(p.prestazione?.nome || '')} · ${p.medico?.genere === 'F' ? 'Dott.ssa' : p.medico?.genere === 'A' && p.medico?.titolo ? p.medico.titolo : 'Dott.'} ${esc(p.medico?.cognome || '')} · ${p.canale === 'online' ? `online${p.hub?.nome && st.io.ruolo === 'admin' ? ` · ${esc(p.hub.nome)}` : ''}` : esc(p.hub?.nome || 'hub')}</div>
                </div>
                <div class="shrink-0 text-right">${badgeStato(p.stato)}${p.stato === 'richiesta' && p.scadenza ? `<div class="text-xs text-slate-500 mt-1">rispondi entro ${esc(dataOra(p.scadenza))}</div>` : ''}</div>
            </button>
            ${p.stato === 'richiesta' && comeMedico(p) ? `
                <div class="flex gap-2 mt-3 pt-3 border-t border-slate-100">
                    <button type="button" data-rapida="conferma" data-id="${p.id}" class="${btnPrimario} !py-2"><i class="fa-solid fa-check mr-1"></i> Conferma</button>
                    <button type="button" data-apri="${p.id}" class="${btnSecondario} !py-2">Dettagli o rifiuta</button>
                </div>` : ''}
        </div>`).join('')
        : `<div class="${card} text-center text-sm text-slate-500 py-10">${st.filtro === 'da_confermare' ? 'Nessuna richiesta da confermare.' : 'Nessuna prenotazione in questo elenco.'}</div>`;
}

function apriPannello(id) {
    const p = st.prenotazioni.find((x) => x.id === id);
    if (!p) return;
    st.pannelloId = id;
    const io = st.io;
    const comeMedico = io.ruolo === 'admin' || (io.medico_id && io.medico_id === p.medico_id);
    const comeHub = io.ruolo === 'admin' || (io.hub_id && io.hub_id === p.hub_id);
    const riga = (k, v) => v ? `<div><dt class="text-xs text-slate-500">${k}</dt><dd class="font-medium text-slate-900 break-words">${v}</dd></div>` : '';
    const attiva = ATTIVE.includes(p.stato);
    const quotaTesto = p.pagata_il
        ? `${euro(p.quota_cents)} pagata il ${dataOra(p.pagata_il)}${p.metodo_pagamento ? ` (${esc(METODI[p.metodo_pagamento] || p.metodo_pagamento)})` : ''}`
        : `${euro(p.quota_cents)} da pagare`;
    const gestisce = comeMedico || comeHub;
    const visitaPassata = p.visita_il && new Date(p.visita_il).getTime() < Date.now();
    const conRimborso = p.visita_il && new Date(p.visita_il).getTime() - Date.now() >= 48 * 3600 * 1000;

    $('pannello-corpo').innerHTML = `
        <div class="flex items-start justify-between gap-3">
            <div><div class="font-mono text-lg font-bold text-slate-900">${esc(p.codice || '')}</div>
            <div class="text-xs text-slate-500">Ricevuta il ${dataOra(p.creata_il)}</div></div>
            ${badgeStato(p.stato)}
        </div>
        <div class="rounded-xl bg-skybrand-50 border border-skybrand-200 p-3 text-sm text-slate-800"><i class="fa-regular fa-calendar mr-1.5"></i><strong>${p.visita_il ? esc(quando(p.visita_il)) : 'Orario da definire'}</strong>${p.prestazione?.durata_minuti ? ` · ${durata(p.prestazione.durata_minuti)}` : ''}
            ${['richiesta', 'da_pagare'].includes(p.stato) && p.scadenza ? `<div class="text-xs text-slate-500 mt-1">${p.stato === 'richiesta' ? 'Il medico deve rispondere' : 'Il paziente deve pagare'} entro ${esc(dataOra(p.scadenza))}</div>` : ''}</div>
        <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            ${riga('Paziente', `${esc(p.paziente_nome)} ${esc(p.paziente_cognome)}`)}
            ${riga('Codice fiscale', esc(p.paziente_codice_fiscale))}
            ${riga('Data di nascita', data(p.paziente_data_nascita))}
            ${riga('Telefono', `<a class="text-skybrand-600" href="tel:${esc(p.paziente_telefono)}">${esc(p.paziente_telefono)}</a>`)}
            ${riga('Email', `<a class="text-skybrand-600" href="mailto:${esc(p.paziente_email)}">${esc(p.paziente_email)}</a>`)}
            ${riga('Prestazione', esc(p.prestazione?.nome))}
            ${riga('Medico', `${p.medico?.genere === 'F' ? 'Dott.ssa' : p.medico?.genere === 'A' && p.medico?.titolo ? p.medico.titolo : 'Dott.'} ${esc(p.medico?.nome)} ${esc(p.medico?.cognome)}`)}
            ${riga('Canale', p.canale === 'online' ? 'Online dal paziente' : `Hub: ${esc(p.hub?.nome)} (${esc(p.hub?.codice)})`)}
            ${riga('Ticket', quotaTesto)}
            ${riga('Ticket incassato da', p.hub ? `${esc(p.hub.nome)}${p.canale === 'online' ? ' (hub di riferimento)' : ''}` : '')}
        </dl>
        ${p.note ? `<div class="rounded-xl bg-slate-50 border border-slate-200 p-3 text-sm"><div class="text-xs text-slate-500 mb-1">Note del paziente</div>${esc(p.note)}</div>` : ''}
        ${p.motivo_rifiuto ? `<div class="rounded-xl bg-slate-50 border border-slate-200 p-3 text-sm"><div class="text-xs text-slate-500 mb-1">Motivo del rifiuto</div>${esc(p.motivo_rifiuto)}</div>` : ''}
        ${p.nota_medico ? `<div class="rounded-xl bg-slate-50 border border-slate-200 p-3 text-sm"><div class="text-xs text-slate-500 mb-1">Nota</div>${esc(p.nota_medico)}</div>` : ''}
        <div id="msg-pannello" hidden></div>
        <div class="space-y-4 no-print">
            ${gestisce && p.stato === 'richiesta' ? `
                <div class="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3">
                    <div class="text-sm font-semibold text-amber-900">Richiesta da confermare</div>
                    <p class="text-xs text-amber-900/80">Va confermata entro 48 ore dal ricevimento${!comeMedico || io.ruolo === 'admin' ? ', dopo aver sentito il medico' : ''}. ${p.canale === 'online' ? (p.quota_cents > 0 ? 'Se confermi, il paziente riceve un\'email e ha 24 ore per pagare il ticket: poi la visita è definitiva.' : 'Se confermi, la visita è subito definitiva: per questa prestazione non c\'è ticket da pagare.') : 'Se confermi, la visita è definitiva e il medico e l\'hub vengono avvisati.'} Se l'orario non va bene, puoi spostarlo qui sotto.</p>
                    <button type="button" data-azione="conferma" class="${btnPrimario} w-full"><i class="fa-solid fa-check mr-1"></i> Conferma la visita</button>
                    <textarea data-motivo-rifiuto rows="2" maxlength="500" placeholder="Motivo del rifiuto (facoltativo, viene comunicato)" class="${classeCampo}"></textarea>
                    <button type="button" data-azione="rifiuta" class="${btnPericolo} w-full">Rifiuta la richiesta</button>
                </div>` : ''}
            ${comeHub && !p.pagata_il && p.quota_cents > 0 && (p.canale === 'hub' ? ['richiesta', 'confermata'].includes(p.stato) : p.stato === 'da_pagare') ? `
                <div class="rounded-xl border border-slate-200 p-4 space-y-3">
                    <div class="text-sm font-semibold text-slate-800">Ticket di prenotazione (${euro(p.quota_cents)})</div>
                    <p class="text-xs text-slate-500">Se il paziente paga in presenza (contanti o POS) o con bonifico istantaneo, registra qui l'incasso${p.canale === 'online' ? ': la visita diventa confermata e il medico e il paziente ricevono la conferma via email' : ''}.</p>
                    <div class="flex gap-2">
                        <select data-metodo onchange="this.classList.toggle('!text-slate-400', !this.value)" class="${classeCampo} !text-slate-400"><option value="" class="text-slate-400">Pagato con...</option><option value="contanti" class="text-slate-900">Contanti</option><option value="pos" class="text-slate-900">POS / carta</option><option value="bonifico" class="text-slate-900">Bonifico istantaneo</option></select>
                        <button type="button" data-azione="registra_incasso" class="${btnPrimario} shrink-0">Registra il pagamento</button>
                    </div>
                    ${p.canale === 'online' ? '<p class="text-xs text-slate-500">In alternativa il paziente può pagare con carta dalla sua area personale.</p>'
                        : p.stato === 'confermata'
                        ? `<button type="button" data-bollettino class="${btnSecondario} w-full"><i class="fa-solid fa-qrcode mr-1"></i> Stampa il bollettino da pagare online</button>
                           <p class="text-xs text-slate-500">Il paziente inquadra il QR code e paga con carta quando vuole.</p>`
                        : '<p class="text-xs text-slate-500">Il bollettino da pagare online si stampa dopo la conferma del medico.</p>'}
                </div>` : ''}
            ${gestisce && ['richiesta', 'da_pagare', 'confermata'].includes(p.stato) && !visitaPassata ? `
                <div class="rounded-xl border border-slate-200 p-4 space-y-3">
                    <div class="text-sm font-semibold text-slate-800">Sposta la data</div>
                    <div id="sposta-slot"><button type="button" data-apri-sposta class="${btnSecondario} w-full"><i class="fa-regular fa-calendar mr-1"></i> Scegli un nuovo orario</button></div>
                    <button type="button" data-conferma-sposta hidden class="${btnPrimario} w-full">Sposta la visita al nuovo orario</button>
                    <p class="text-xs text-slate-500">Il paziente${comeMedico && !comeHub ? ' e l\'hub ricevono' : comeHub && !comeMedico ? ' e il medico ricevono' : ' riceve'} un'email con il nuovo orario.</p>
                </div>` : ''}
            ${comeMedico && p.stato === 'confermata' && visitaPassata ? `<button type="button" data-azione="completa" class="${btnSecondario} w-full">Segna la visita come svolta</button>` : ''}
            ${(comeMedico || comeHub) && attiva ? `
                <div class="rounded-xl border border-red-200 p-4 space-y-3">
                    <div class="text-sm font-semibold text-red-700">Annulla la prenotazione</div>
                    <select data-causa class="${classeCampo}">
                        <option value="struttura">${comeMedico && !comeHub ? 'Non posso effettuare la visita' : 'Il medico o la struttura non possono effettuare la visita'} (quota rimborsata)</option>
                        <option value="paziente">Ripensamento del paziente (${conRimborso ? 'quota rimborsata: mancano almeno 48 ore' : 'quota NON rimborsabile: mancano meno di 48 ore'})</option>
                    </select>
                    <textarea data-motivo rows="2" maxlength="500" placeholder="Motivo (viene comunicato al paziente)" class="${classeCampo}"></textarea>
                    <button type="button" data-azione="annulla" class="${btnPericolo} w-full">Annulla la prenotazione</button>
                    ${p.pagata_il ? `<p class="text-xs text-slate-500">${p.stripe_payment_intent ? 'Se il ticket va rimborsato, il rimborso sulla carta del paziente parte automaticamente dal conto Stripe dell\'hub.' : 'Se il ticket va rimborsato, restituiscilo al paziente e poi segnalo come rimborsato.'}</p>` : ''}
                </div>` : ''}
            ${p.quota_trattenuta ? `<p class="text-sm text-slate-600 rounded-xl bg-slate-50 border border-slate-200 p-3">Annullata dal paziente a meno di 48 ore dalla visita: la quota non è rimborsabile.</p>` : ''}
            ${comeHub && p.canale === 'hub' && p.stato === 'annullata' && p.incassata_da === 'hub' && !p.stripe_payment_intent && !p.quota_trattenuta ? `<button type="button" data-azione="segna_rimborsata" class="${btnSecondario} w-full">Segna la quota come rimborsata al paziente</button>` : ''}
            <button type="button" onclick="window.print()" class="${btnSecondario} w-full"><i class="fa-solid fa-print mr-1"></i> Stampa</button>
        </div>`;
    $('pannello').hidden = false;
    document.body.style.overflow = 'hidden';
}

function chiudiPannello() {
    $('pannello').hidden = true;
    document.body.style.overflow = '';
    st.pannelloId = null;
}

async function azionePrenotazione(azione, extra = {}, bottone, id = st.pannelloId) {
    const msg = $('msg-pannello');
    if (['annulla', 'rifiuta'].includes(azione) && bottone?.dataset.confermato !== '1') {
        bottone.dataset.confermato = '1';
        bottone.textContent = azione === 'annulla' ? 'Clicca di nuovo per confermare l\'annullamento' : 'Clicca di nuovo per rifiutare';
        return;
    }
    if (bottone) bottone.disabled = true;
    const testi = {
        conferma: 'Visita confermata: il paziente è stato avvisato', rifiuta: 'Richiesta rifiutata', completa: 'Visita segnata come svolta',
        sposta: 'Visita spostata: il paziente è stato avvisato',
        annulla: 'Prenotazione annullata', registra_incasso: 'Pagamento registrato: il medico vede la visita confermata', segna_rimborsata: 'Rimborso registrato',
    };
    try {
        await api('aggiorna-prenotazione', { conAccesso: true, dati: { id, azione, ...extra } });
        await caricaPrenotazioni();
        disegnaPrenotazioni();
        if (st.pannelloId) {
            apriPannello(st.pannelloId);
            $('msg-pannello').hidden = false;
            messaggio($('msg-pannello'), testi[azione] || 'Prenotazione aggiornata', 'ok');
        } else {
            avviso(testi[azione] || 'Prenotazione aggiornata', 'ok');
        }
    } catch (err) {
        if (msg && st.pannelloId) { msg.hidden = false; messaggio(msg, err.message); } else avviso(err.message);
        if (bottone) bottone.disabled = false;
    }
}

async function stampaBollettino(bottone) {
    const finestra = window.open('', '_blank');   // aperta subito, così il browser non la blocca
    bottone.disabled = true;
    try {
        const { url } = await api('aggiorna-prenotazione', { conAccesso: true, dati: { id: st.pannelloId, azione: 'bollettino' } });
        if (finestra) finestra.location = `${url}&stampa=1`; else location.href = `${url}&stampa=1`;
    } catch (err) {
        if (finestra) finestra.close();
        $('msg-pannello').hidden = false;
        messaggio($('msg-pannello'), err.message);
    }
    bottone.disabled = false;
}

// ---------------------------------------------------------------------
// Nuova prenotazione (hub)
// ---------------------------------------------------------------------
function mediciPrenotabili() {
    return st.medici.filter((m) => m.attivo && st.prestazioni.some((p) => p.medico_id === m.id && p.attivo));
}

function disegnaNuova() {
    const n = st.nuova;
    if (n.esito) return disegnaEsitoNuova();
    const isAdmin = st.io.ruolo === 'admin';
    const hubAttivi = st.hub.filter((h) => h.attivo);
    if (isAdmin && !n.hubId && hubAttivi.length) n.hubId = hubAttivi[0].id;
    const medici = mediciPrenotabili();
    const medico = medici.find((m) => m.id === n.medicoId);
    const prest = medico ? st.prestazioni.filter((p) => p.medico_id === medico.id && p.attivo) : [];
    if (medico && !prest.some((p) => p.id === n.prestazioneId)) { n.prestazioneId = prest.length === 1 ? prest[0].id : null; n.slot = null; }

    $('vista').innerHTML = `
        <form id="form-nuova" novalidate class="space-y-4 max-w-3xl">
            ${isAdmin ? `<div class="${card}"><label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Hub che registra la prenotazione</span>
                <select name="hub_id" class="${classeCampo}">${hubAttivi.map((h) => `<option value="${h.id}" ${h.id === n.hubId ? 'selected' : ''}>${esc(h.nome)} (${esc(h.codice)})</option>`).join('')}</select></label>
                ${hubAttivi.length ? '' : '<p class="text-sm text-red-700 mt-2">Prima crea almeno un hub nella scheda Hub.</p>'}</div>` : ''}
            <div class="${card} space-y-3">
                <h2 class="text-sm font-bold text-slate-500 uppercase tracking-wider">1 · Medico e prestazione</h2>
                ${medico ? `
                    <div class="flex items-center justify-between gap-3 rounded-xl bg-skybrand-50 border border-skybrand-200 p-3">
                        <div><div class="font-semibold text-slate-900">${medico?.genere === 'F' ? 'Dott.ssa' : medico?.genere === 'A' && medico?.titolo ? medico.titolo : 'Dott.'} ${esc(medico.nome)} ${esc(medico.cognome)}</div><div class="text-xs text-slate-500">${esc(medico.specializzazione)} · ${esc(medico.citta)}${medico.telefono ? ` · tel. ${esc(medico.telefono)}` : ''}</div></div>
                        <button type="button" data-cambia-medico class="text-sm text-skybrand-600 font-medium">Cambia</button>
                    </div>
                    <div class="space-y-2">${prest.map((p) => `
                        <label class="flex items-start gap-3 p-3 rounded-xl border border-slate-200 cursor-pointer"><input type="radio" name="prestazione_id" value="${p.id}" class="mt-1 w-4 h-4" ${p.id === n.prestazioneId ? 'checked' : ''}><span><span class="block font-medium text-slate-900">${esc(p.nome)}</span>
                        <span class="block text-xs text-slate-500">${durata(p.durata_minuti)}${p.prezzo_visita_cents != null ? ` · tariffa ${euro(p.prezzo_visita_cents)}` : ''}${p.descrizione ? ` · ${esc(p.descrizione)}` : ''}</span></span></label>`).join('')}</div>`
                : `
                    <input type="search" id="cerca-medico" value="${esc(n.cercaMedico)}" placeholder="Cerca per cognome, specializzazione o città" class="${classeCampo}">
                    <div id="risultati-medici" class="space-y-2 max-h-80 overflow-y-auto"></div>`}
            </div>
            ${medico ? `
            <div class="${card}">
                <h2 class="text-sm font-bold text-slate-500 uppercase tracking-wider mb-3">2 · Giorno e ora</h2>
                <div id="slot-nuova"><p class="text-sm text-slate-500">Scegli prima la prestazione.</p></div>
            </div>
            <div class="${card}">
                <h2 class="text-sm font-bold text-slate-500 uppercase tracking-wider mb-3">3 · Dati del paziente</h2>
                ${htmlCampiPaziente()}
            </div>
            <div class="${card} space-y-3 text-sm text-slate-700">
                <h2 class="text-sm font-bold text-slate-500 uppercase tracking-wider">4 · Consensi e conferma</h2>
                <label class="flex items-start gap-3"><input type="checkbox" name="consenso_privacy" class="mt-1 w-4 h-4 shrink-0"><span>Il paziente ha ricevuto l'informativa privacy e accetta i termini del servizio.</span></label>
                <label class="flex items-start gap-3"><input type="checkbox" name="consenso_dati_sanitari" class="mt-1 w-4 h-4 shrink-0"><span>Il paziente acconsente al trattamento dei suoi dati relativi alla salute per organizzare la visita.</span></label>
                <div class="pt-2 space-y-2">
                    <label class="flex items-start gap-3 p-3 rounded-xl border border-slate-200 cursor-pointer"><input type="radio" name="modo" value="richiesta" class="mt-1 w-4 h-4" checked>
                        <span><span class="block font-medium text-slate-900">Invia la richiesta al medico</span><span class="block text-xs text-slate-500">Il medico riceve un'email e conferma o rifiuta dalla sua area riservata.</span></span></label>
                    <label class="flex items-start gap-3 p-3 rounded-xl border border-slate-200 cursor-pointer"><input type="radio" name="modo" value="confermata" class="mt-1 w-4 h-4">
                        <span><span class="block font-medium text-slate-900">Ho già sentito il medico per telefono: conferma subito</span><span class="block text-xs text-slate-500">La visita è confermata adesso; il medico e il paziente ricevono la conferma via email.</span></span></label>
                </div>
                <p id="ticket-nuova" class="text-xs text-slate-500">${testoTicketNuova()}</p>
            </div>
            <div id="msg-nuova" hidden></div>
            <button type="submit" id="btn-nuova" class="${btnPrimario} px-6 py-3">Registra</button>` : ''}
        </form>`;
    if (!medico) disegnaRisultatiMedici(medici);
    else if (n.prestazioneId) caricaSlotNuova();
}

async function caricaSlotNuova() {
    const el = $('slot-nuova');
    const id = st.nuova.prestazioneId;
    if (!el || !id) return;
    el.innerHTML = '<p class="text-sm text-slate-500"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Carico gli orari liberi...</p>';
    try {
        const slots = await slotLiberi(id);
        if (st.nuova.prestazioneId !== id || !$('slot-nuova')) return;
        selettoreSlot($('slot-nuova'), slots, (iso) => { st.nuova.slot = iso; }, st.nuova.slot);
    } catch (err) {
        el.innerHTML = `<p class="text-sm text-red-700">${esc(err.message)}</p>`;
    }
}

function disegnaRisultatiMedici(medici) {
    const q = st.nuova.cercaMedico.trim().toLowerCase();
    const trovati = medici.filter((m) => !q || `${m.nome} ${m.cognome} ${m.specializzazione} ${m.citta}`.toLowerCase().includes(q)).slice(0, 50);
    const el = $('risultati-medici');
    if (!el) return;
    el.innerHTML = trovati.length ? trovati.map((m) => `
        <button type="button" data-scegli-medico="${m.id}" class="w-full text-left p-3 rounded-xl border border-slate-200 hover:border-skybrand-300 transition">
            <div class="font-semibold text-slate-900">${m?.genere === 'F' ? 'Dott.ssa' : m?.genere === 'A' && m?.titolo ? m.titolo : 'Dott.'} ${esc(m.nome)} ${esc(m.cognome)}</div>
            <div class="text-xs text-slate-500">${esc(m.specializzazione)} · ${esc(m.citta)}</div>
        </button>`).join('')
        : `<p class="text-sm text-slate-500 py-3">Nessun medico trovato${st.medici.length ? '' : ': non ci sono ancora medici con prestazioni attive'}.</p>`;
}

async function inviaNuova(form) {
    const msg = $('msg-nuova');
    const { paziente, note } = leggiPaziente(form);
    const errori = [];
    if (!st.nuova.prestazioneId) errori.push('Scegli la prestazione');
    else if (!st.nuova.slot) errori.push('Scegli giorno e ora della visita');
    errori.push(...erroriPaziente(paziente));
    if (!form.consenso_privacy.checked || !form.consenso_dati_sanitari.checked) errori.push('Servono entrambi i consensi del paziente');
    msg.hidden = false;
    if (errori.length) return messaggio(msg, errori);
    msg.hidden = true;
    const giaConfermata = form.querySelector('input[name=modo]:checked')?.value === 'confermata';
    const btn = $('btn-nuova');
    btn.disabled = true; btn.textContent = 'Registrazione...';
    try {
        const r = await api('prenota-hub', {
            conAccesso: true,
            dati: {
                prestazione_id: st.nuova.prestazioneId, inizio: st.nuova.slot, paziente, note,
                consenso_privacy: true, consenso_dati_sanitari: true, gia_confermata: giaConfermata,
                hub_id: st.io.ruolo === 'admin' ? form.hub_id?.value : undefined,
            },
        });
        const medico = st.medici.find((m) => m.id === st.nuova.medicoId);
        st.nuova.esito = { ...r, paziente, medico, prestazione: st.prestazioni.find((p) => p.id === st.nuova.prestazioneId), inizio: st.nuova.slot };
        disegnaEsitoNuova();
    } catch (err) {
        msg.hidden = false;
        messaggio(msg, err.message);
        btn.disabled = false; btn.textContent = 'Registra';
        if (/orario/i.test(err.message)) { st.nuova.slot = null; caricaSlotNuova(); }
    }
}

function disegnaEsitoNuova() {
    const e = st.nuova.esito;
    const confermata = e.stato === 'confermata';
    $('vista').innerHTML = `
        <div class="${card} max-w-2xl space-y-5">
            <div class="flex items-center gap-3">
                <div class="w-11 h-11 rounded-full ${confermata ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'} flex items-center justify-center text-lg"><i class="fa-solid ${confermata ? 'fa-check' : 'fa-paper-plane'}"></i></div>
                <div><h2 class="text-lg font-bold text-slate-900">${confermata ? 'Visita confermata' : 'Richiesta inviata al medico'}</h2>
                <p class="text-sm text-slate-500">${confermata ? 'Medico e paziente ricevono la conferma via email.' : 'Il medico riceve un\'email; quando conferma ti avvisiamo e la trovi tra le prenotazioni attive.'}</p></div>
            </div>
            <div class="rounded-2xl bg-skybrand-50 border border-skybrand-200 p-5 text-center">
                <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Codice prenotazione</div>
                <div class="text-2xl sm:text-3xl font-bold tracking-wider text-slate-900 font-mono">${esc(e.codice)}</div>
            </div>
            <dl class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div><dt class="text-xs text-slate-500">Paziente</dt><dd class="font-medium text-slate-900">${esc(e.paziente.nome)} ${esc(e.paziente.cognome)}</dd></div>
                <div><dt class="text-xs text-slate-500">Medico</dt><dd class="font-medium text-slate-900">${e.medico?.genere === 'F' ? 'Dott.ssa' : e.medico?.genere === 'A' && e.medico?.titolo ? e.medico.titolo : 'Dott.'} ${esc(e.medico?.nome)} ${esc(e.medico?.cognome)}</dd></div>
                <div><dt class="text-xs text-slate-500">Prestazione</dt><dd class="font-medium text-slate-900">${esc(e.prestazione?.nome)}</dd></div>
                <div><dt class="text-xs text-slate-500">Data e ora</dt><dd class="font-medium text-slate-900">${esc(quando(e.inizio))}</dd></div>
                <div><dt class="text-xs text-slate-500">Ticket</dt><dd class="font-medium text-slate-900">${ticketDi(e.prestazione?.prezzo_visita_cents, st.percento) ? `${euro(ticketDi(e.prestazione?.prezzo_visita_cents, st.percento))} da incassare` : 'nessun ticket'}</dd></div>
            </dl>
            <div class="no-print flex flex-col sm:flex-row gap-3">
                <button type="button" data-apri-dopo="${e.id}" class="${btnSecondario}">Apri la prenotazione${confermata ? ' (incasso o bollettino)' : ''}</button>
                <button type="button" onclick="window.print()" class="${btnSecondario}"><i class="fa-solid fa-print mr-1"></i> Stampa per il paziente</button>
                <button type="button" data-nuova-ancora class="${btnPrimario}">Nuova prenotazione</button>
            </div>
        </div>`;
}

// ---------------------------------------------------------------------
// Orari di disponibilità e chiusure del medico
// ---------------------------------------------------------------------
function disegnaOrari() {
    if (!st.medicoGestito) { $('vista').innerHTML = `<div class="${card} text-sm text-slate-500">Nessun medico da gestire.</div>`; return; }
    const fascia = (f, i) => `
        <div class="flex items-center gap-2" data-fascia="${i}">
            <input type="time" data-campo="inizio" value="${esc(f.inizio)}" step="300" class="${classeCampo} !w-32">
            <span class="text-slate-400">–</span>
            <input type="time" data-campo="fine" value="${esc(f.fine)}" step="300" class="${classeCampo} !w-32">
            <button type="button" data-togli-fascia="${i}" aria-label="Togli la fascia" class="w-9 h-9 shrink-0 rounded-lg border border-slate-200 text-slate-500 hover:text-red-600"><i class="fa-solid fa-xmark"></i></button>
        </div>`;
    $('vista').innerHTML = `
        ${sceltaMedico()}
        <div class="grid grid-cols-1 lg:grid-cols-5 gap-5">
            <div class="${card} lg:col-span-3 space-y-4">
                <div>
                    <h2 class="font-bold text-slate-900">Orari settimanali</h2>
                    <p class="text-sm text-slate-500">I pazienti e gli hub possono chiedere solo gli orari liberi dentro queste fasce. La lunghezza di ogni appuntamento dipende dalla durata della prestazione.</p>
                </div>
                ${GIORNI.map((nome, g) => {
                    const fasce = st.orari.map((f, i) => [f, i]).filter(([f]) => f.giorno === g + 1);
                    return `<div class="flex flex-col sm:flex-row sm:items-start gap-2 py-3 border-t border-slate-100">
                        <div class="sm:w-28 shrink-0 pt-2 text-sm font-semibold text-slate-800">${nome}</div>
                        <div class="flex-1 space-y-2">
                            ${fasce.length ? fasce.map(([f, i]) => fascia(f, i)).join('') : '<p class="text-sm text-slate-400 pt-2">Chiuso</p>'}
                            <button type="button" data-aggiungi-fascia="${g + 1}" class="text-sm text-skybrand-600 font-medium"><i class="fa-solid fa-plus mr-1"></i>Aggiungi fascia</button>
                        </div>
                    </div>`;
                }).join('')}
                <div id="msg-orari" hidden></div>
                <button type="button" data-salva-orari class="${btnPrimario}">Salva gli orari</button>
            </div>
            <div class="lg:col-span-2 space-y-5">
                <form data-medico="aggiungi_chiusura" class="${card} space-y-3">
                    <h2 class="font-bold text-slate-900">Giorni di chiusura</h2>
                    <p class="text-sm text-slate-500">Ferie, congressi o giorni in cui non ricevi: in quelle date non si possono chiedere visite.</p>
                    <div class="grid grid-cols-2 gap-3">
                        <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Dal</span><input name="dal" type="date" required class="${classeCampo}"></label>
                        <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Al</span><input name="al" type="date" class="${classeCampo}"></label>
                    </div>
                    <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Motivo (facoltativo)</span><input name="motivo" maxlength="120" class="${classeCampo}" placeholder="Es. ferie"></label>
                    <button type="submit" class="${btnSecondario} w-full">Aggiungi chiusura</button>
                </form>
                <div class="space-y-2">${st.chiusure.length ? st.chiusure.map((c) => `
                    <div class="${card} !p-3 flex items-center justify-between gap-3 text-sm">
                        <div><span class="font-medium text-slate-900">${data(c.dal)}${c.al !== c.dal ? ` – ${data(c.al)}` : ''}</span>${c.motivo ? ` <span class="text-slate-500">· ${esc(c.motivo)}</span>` : ''}</div>
                        <button type="button" data-elimina-chiusura="${c.id}" class="text-red-700 text-sm font-medium">Elimina</button>
                    </div>`).join('') : '<p class="text-sm text-slate-500">Nessuna chiusura in programma.</p>'}</div>
            </div>
        </div>`;
}

// legge le fasce dai campi (per non perdere le modifiche non salvate)
function leggiFasce() {
    document.querySelectorAll('[data-fascia]').forEach((riga) => {
        const f = st.orari[Number(riga.dataset.fascia)];
        if (!f) return;
        f.inizio = riga.querySelector('[data-campo=inizio]').value;
        f.fine = riga.querySelector('[data-campo=fine]').value;
    });
}

async function salvaOrari(bottone) {
    leggiFasce();
    const msg = $('msg-orari');
    const incomplete = st.orari.some((f) => !f.inizio || !f.fine);
    msg.hidden = false;
    if (incomplete) return messaggio(msg, 'Completa o togli le fasce senza orario');
    bottone.disabled = true;
    try {
        await api('medico', { conAccesso: true, dati: { azione: 'salva_disponibilita', medico_id: st.medicoGestito, fasce: st.orari } });
        messaggio(msg, 'Orari salvati: da adesso i pazienti vedono i nuovi orari liberi', 'ok');
    } catch (err) {
        messaggio(msg, err.message);
    }
    bottone.disabled = false;
}

// ---------------------------------------------------------------------
// Prestazioni e tariffe del medico
// ---------------------------------------------------------------------
// Listino della specializzazione: il medico spunta le prestazioni che offre e ne fissa tariffa e durata
const chiaveNome = (v) => String(v || '').trim().toLowerCase();
function specializzazioneListino(medico) {
    const cat = window.CATALOGO_PRESTAZIONI || {};
    if (st.listinoSpec && cat[st.listinoSpec]) return st.listinoSpec;
    if (cat[medico.specializzazione]) return medico.specializzazione;
    const n = chiaveNome(medico.specializzazione);
    return Object.keys(cat).find((k) => n && (chiaveNome(k).includes(n) || n.includes(chiaveNome(k)))) || Object.keys(cat)[0];
}

function listino(medico, prest) {
    const cat = window.CATALOGO_PRESTAZIONI || {};
    const spec = specializzazioneListino(medico);
    const voci = cat[spec] || [];
    const perNome = new Map(prest.map((p) => [chiaveNome(p.nome), p]));
    const righe = voci.map(([nome, durataBase]) => {
        const p = perNome.get(chiaveNome(nome));
        const offerta = !!p?.attivo;
        return `
            <div data-voce="${esc(nome)}" class="grid grid-cols-12 gap-2 items-center py-2.5">
                <label class="col-span-12 sm:col-span-6 flex items-start gap-2.5 text-sm text-slate-800 cursor-pointer">
                    <input type="checkbox" data-offerta ${offerta ? 'checked' : ''} class="mt-0.5 w-4 h-4 shrink-0"><span>${esc(nome)}</span></label>
                <label class="col-span-6 sm:col-span-3 flex items-center gap-1.5"><input data-prezzo type="number" min="0" step="0.01" value="${p?.prezzo_visita_cents != null ? (p.prezzo_visita_cents / 100).toFixed(2) : ''}" placeholder="Tariffa" class="${classeCampo} !py-2"><span class="text-xs text-slate-500">€</span></label>
                <label class="col-span-6 sm:col-span-3 flex items-center gap-1.5"><input data-durata type="number" min="5" max="480" step="5" value="${p?.durata_minuti || durataBase}" class="${classeCampo} !py-2"><span class="text-xs text-slate-500">min</span></label>
            </div>`;
    }).join('');
    const offerte = voci.filter(([nome]) => perNome.get(chiaveNome(nome))?.attivo).length;
    return `
        <form data-listino class="${card} space-y-3">
            <div class="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
                <div>
                    <h2 class="font-bold text-slate-900">Listino delle prestazioni</h2>
                    <p class="text-xs text-slate-500 mt-0.5">${offerte} di ${voci.length} offerte</p>
                </div>
                <label class="block sm:w-72"><span class="block text-xs font-semibold text-slate-600 mb-1">Specializzazione</span>
                    <select data-listino-spec class="${classeCampo}">${Object.keys(cat).map((k) => `<option ${k === spec ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></label>
            </div>
            <p class="text-sm text-slate-500">Spunta le prestazioni che offri e indica tariffa e durata: compaiono ai pazienti nella ricerca della pagina principale e durante la prenotazione. Togliendo la spunta la prestazione non è più prenotabile (le prenotazioni già fatte restano valide).</p>
            <div class="hidden sm:grid grid-cols-12 gap-2 text-xs font-semibold text-slate-500 border-b border-slate-100 pb-1">
                <span class="col-span-6">Prestazione</span><span class="col-span-3">Tariffa</span><span class="col-span-3">Durata</span></div>
            <div class="divide-y divide-slate-100">${righe}</div>
            <button type="submit" class="${btnPrimario} w-full sm:w-auto">Salva il listino</button>
        </form>`;
}

async function inviaListino(form) {
    const voci = [...form.querySelectorAll('[data-voce]')].map((r) => ({
        nome: r.dataset.voce,
        offerta: r.querySelector('[data-offerta]').checked,
        prezzo_euro: r.querySelector('[data-prezzo]').value,
        durata_minuti: r.querySelector('[data-durata]').value,
    }));
    const senzaPrezzo = voci.find((v) => v.offerta && String(v.prezzo_euro).trim() === '');
    if (senzaPrezzo) return avviso(`Indica la tariffa di «${senzaPrezzo.nome}»`);
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
        const r = await api('medico', { conAccesso: true, dati: { azione: 'salva_listino', medico_id: st.medicoGestito, voci } });
        await vai('tariffe');
        avviso(`Listino salvato: ${r.offerte} ${r.offerte === 1 ? 'prestazione offerta' : 'prestazioni offerte'}`, 'ok');
    } catch (err) {
        avviso(err.message);
        btn.disabled = false;
    }
}

function disegnaTariffe() {
    const medico = st.medici.find((m) => m.id === st.medicoGestito);
    if (!medico) { $('vista').innerHTML = `${sceltaMedico()}<div class="${card} text-sm text-slate-500">Nessun medico da gestire.</div>`; return; }
    const tutte = st.prestazioni.filter((p) => p.medico_id === medico.id);
    const nelListino = new Set(((window.CATALOGO_PRESTAZIONI || {})[specializzazioneListino(medico)] || []).map(([n]) => chiaveNome(n)));
    const prest = tutte.filter((p) => !nelListino.has(chiaveNome(p.nome)));
    const modulo = (p) => `
        <form data-medico="salva_prestazione" class="${card} space-y-3">
            ${p ? `<input type="hidden" name="id" value="${p.id}">` : '<h2 class="font-bold text-slate-900">Nuova prestazione</h2>'}
            <div class="grid grid-cols-1 sm:grid-cols-6 gap-3">
                <label class="block sm:col-span-6"><span class="block text-xs font-semibold text-slate-600 mb-1">Nome della prestazione</span>
                    <input name="nome" required maxlength="120" value="${esc(p?.nome || '')}" class="${classeCampo}" placeholder="Es. Visita cardiologica"></label>
                <label class="block sm:col-span-6"><span class="block text-xs font-semibold text-slate-600 mb-1">Descrizione (facoltativa)</span>
                    <input name="descrizione" maxlength="300" value="${esc(p?.descrizione || '')}" class="${classeCampo}"></label>
                <label class="block sm:col-span-2"><span class="block text-xs font-semibold text-slate-600 mb-1">Tariffa della visita (€)</span>
                    <input name="prezzo_euro" type="number" min="0" step="0.01" value="${p?.prezzo_visita_cents != null ? (p.prezzo_visita_cents / 100).toFixed(2) : ''}" class="${classeCampo}" placeholder="Es. 100"></label>
                <label class="block sm:col-span-2"><span class="block text-xs font-semibold text-slate-600 mb-1">Durata (minuti)</span>
                    <input name="durata_minuti" type="number" min="5" max="480" step="5" required value="${p?.durata_minuti || 30}" class="${classeCampo}"></label>
                <label class="flex items-center gap-2 sm:col-span-2 sm:pt-6 text-sm text-slate-700"><input type="checkbox" name="attivo" ${!p || p.attivo ? 'checked' : ''} class="w-4 h-4"> Prenotabile</label>
            </div>
            <button type="submit" class="${p ? btnSecondario : btnPrimario}">${p ? 'Salva le modifiche' : 'Aggiungi la prestazione'}</button>
        </form>`;
    $('vista').innerHTML = `
        ${sceltaMedico()}
        <div class="grid grid-cols-1 lg:grid-cols-5 gap-5">
            <div class="lg:col-span-3 space-y-4">
                ${listino(medico, tutte)}
                <p class="text-sm text-slate-500">La tariffa è il costo della visita che il paziente paga a te. Il ticket di prenotazione (${percentoTesto(st.percento)} della tariffa) è separato e va all'hub.</p>
                ${prest.length ? `<h2 class="font-bold text-slate-900 pt-2">Altre prestazioni</h2>${prest.map(modulo).join('')}` : ''}
            </div>
            <div class="lg:col-span-2 space-y-5">
                ${modulo(null).replace('Nuova prestazione', 'Prestazione non presente nel listino')}
                <form data-medico="salva_profilo" class="${card} space-y-3">
                    <h2 class="font-bold text-slate-900">Dati del medico e dello studio</h2>
                    <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Genere</span>
                    <select name="genere" required data-genere class="${classeCampo}"><option value="">Scegli...</option><option value="M" ${medico.genere === 'M' ? 'selected' : ''}>Maschile (Dott., Specializzato)</option><option value="F" ${medico.genere === 'F' ? 'selected' : ''}>Femminile (Dott.ssa, Specializzata)</option><option value="A" ${medico.genere === 'A' ? 'selected' : ''}>Altro (da specificare)</option></select></label>
                <div data-genere-altro ${medico.genere === 'A' ? '' : 'hidden'} class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Titolo con cui essere identificato/a</span>
                        <input name="titolo" maxlength="15" value="${esc(medico.titolo || '')}" placeholder="Es. Dott., Dott.ssa, Dr." class="${classeCampo}"></label>
                    <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Dicitura della specializzazione</span>
                        <input name="dicitura_specializzazione" maxlength="30" value="${esc(medico.dicitura_specializzazione || '')}" placeholder="Es. Specialista in" class="${classeCampo}"></label>
                </div>
                    <p class="text-xs text-slate-500 -mt-1">Serve per indicare correttamente titolo e specializzazione nella ricerca, nelle pagine e nelle email. Con "Altro" il professionista sceglie come essere identificato/a.</p>
                    <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Indirizzo dello studio</span>
                        <input name="indirizzo" maxlength="160" value="${esc(medico.indirizzo || '')}" class="${classeCampo}" placeholder="Comunicato al paziente con la conferma"></label>
                    <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Telefono (visibile agli hub)</span>
                        <input name="telefono" type="tel" maxlength="30" value="${esc(medico.telefono || '')}" class="${classeCampo}"></label>
                    <button type="submit" class="${btnSecondario} w-full">Salva</button>
                </form>
            </div>
        </div>`;
}

async function inviaMedico(form) {
    const azione = form.dataset.medico;
    const f = Object.fromEntries(new FormData(form).entries());
    const dati = { azione, medico_id: st.medicoGestito, ...f };
    if (azione === 'salva_prestazione') dati.attivo = form.attivo.checked;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
        await api('medico', { conAccesso: true, dati });
        const testi = { salva_prestazione: 'Prestazione salvata', salva_profilo: 'Dati del medico salvati', aggiungi_chiusura: 'Chiusura aggiunta' };
        await vai(st.scheda);
        avviso(testi[azione] || 'Salvato', 'ok');
    } catch (err) {
        avviso(err.message);
        btn.disabled = false;
    }
}

// ---------------------------------------------------------------------
// Conti con gli hub (80% all'hub, 20% a Click Dottore)
// ---------------------------------------------------------------------
const saldo = (c) => c.dovuto_a_click_dottore - c.dovuto_all_hub - c.versato_netto;

function testoSaldo(c, perHub) {
    const s = saldo(c);
    if (s === 0) return '<span class="text-emerald-700 font-semibold">In pari</span>';
    if (s > 0) return `<span class="text-amber-700 font-semibold">${perHub ? 'Devi versare' : 'L\'hub deve versare'} ${euro(s)}${perHub ? ' a Click Dottore' : ''}</span>`;
    return `<span class="text-skybrand-700 font-semibold">${perHub ? 'Click Dottore ti deve' : 'Da versare all\'hub'} ${euro(-s)}</span>`;
}

function disegnaConti() {
    const pct = st.impostazioni.quota_hub_percento || '80';
    const iban = st.impostazioni.iban_click_dottore || '';
    const intestatario = st.impostazioni.intestatario_iban || 'Click Dottore';
    const regolazioni = (r) => r.length ? r.map((x) => `
        <div class="flex items-center justify-between gap-3 text-sm py-2 border-t border-slate-100">
            <div><div class="font-medium text-slate-900">${data(x.data)} · ${x.importo_cents > 0 ? 'bonifico dell\'hub a Click Dottore' : 'bonifico di Click Dottore all\'hub'}${st.io.ruolo === 'admin' ? ` · ${esc(x.hub?.nome || '')}` : ''}</div>${x.nota ? `<div class="text-xs text-slate-500">${esc(x.nota)}</div>` : ''}</div>
            <div class="font-semibold text-slate-900">${euro(Math.abs(x.importo_cents))}</div>
        </div>`).join('') : '<p class="text-sm text-slate-500">Nessun bonifico registrato.</p>';

    if (st.io.ruolo !== 'admin') {
        const c = st.conti.find((x) => x.hub_id === st.io.hub_id) || { dovuto_a_click_dottore: 0, dovuto_all_hub: 0, versato_netto: 0 };
        const s = saldo(c);
        $('vista').innerHTML = `
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 max-w-5xl">
                <div class="${card} space-y-4">
                    <h2 class="font-bold text-slate-900">Saldo con Click Dottore</h2>
                    <div class="text-2xl">${testoSaldo(c, true)}</div>
                    <dl class="grid grid-cols-1 gap-2 text-sm">
                        <div class="flex justify-between"><dt class="text-slate-500">Quote incassate allo sportello: parte di Click Dottore (${100 - Number(pct)}%)</dt><dd class="font-medium">${euro(c.dovuto_a_click_dottore)}</dd></div>
                        <div class="flex justify-between"><dt class="text-slate-500">Bollettini pagati online: la tua parte (${pct}%)</dt><dd class="font-medium">${euro(c.dovuto_all_hub)}</dd></div>
                        <div class="flex justify-between"><dt class="text-slate-500">Bonifici già registrati (netto)</dt><dd class="font-medium">${euro(c.versato_netto)}</dd></div>
                    </dl>
                    ${s > 0 ? `<div class="rounded-xl bg-amber-50 border border-amber-200 p-4 text-sm text-slate-800 space-y-1">
                        <p class="font-semibold">Versa ${euro(s)} con bonifico istantaneo, il prima possibile:</p>
                        ${iban ? `<p>IBAN <span class="font-mono font-semibold select-all">${esc(iban)}</span></p><p>Intestato a ${esc(intestatario)}</p>` : '<p>L\'IBAN di Click Dottore non è ancora stato indicato: contatta l\'amministratore.</p>'}
                        <p>Causale: <span class="font-mono select-all">Quote Click Dottore hub ${esc(st.io.hub?.codice || '')}</span></p>
                        <p class="text-xs text-slate-500">Il saldo si aggiorna quando Click Dottore registra il bonifico ricevuto.</p>
                    </div>` : ''}
                    ${s < 0 ? '<p class="text-sm text-slate-600">Click Dottore ti verserà la tua parte delle quote pagate online con bonifico.</p>' : ''}
                </div>
                <div class="${card}"><h2 class="font-bold text-slate-900 mb-2">Bonifici registrati</h2>${regolazioni(st.regolazioni)}</div>
            </div>`;
        return;
    }

    $('vista').innerHTML = `
        <div class="grid grid-cols-1 lg:grid-cols-5 gap-5">
            <div class="lg:col-span-3 space-y-3">
                <p class="text-sm text-slate-500">Saldi delle quote incassate con il sistema precedente (parte di Click Dottore sulle prenotazioni degli hub). Con il nuovo sistema il ticket va per intero all'hub e qui non si aggiunge più nulla. Saldo positivo = l'hub deve versare a Click Dottore.</p>
                ${st.conti.length ? st.conti.map((c) => `
                    <div class="${card} !p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div><div class="font-semibold text-slate-900">${esc(c.nome)} <span class="font-mono text-xs text-slate-500">${esc(c.codice)}</span></div>
                        <div class="text-xs text-slate-500">sportello: ${euro(c.dovuto_a_click_dottore)} a Click Dottore · bollettini: ${euro(c.dovuto_all_hub)} all'hub · bonifici: ${euro(c.versato_netto)}</div></div>
                        <div class="text-sm shrink-0">${testoSaldo(c, false)}</div>
                    </div>`).join('') : `<div class="${card} text-sm text-slate-500">Nessun hub.</div>`}
                <div class="${card}"><h2 class="font-bold text-slate-900 mb-2">Ultimi bonifici registrati</h2>${regolazioni(st.regolazioni)}</div>
            </div>
            <form data-admin="registra_regolazione" class="${card} space-y-3 lg:col-span-2 self-start">
                <h2 class="font-bold text-slate-900">Registra un bonifico</h2>
                <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Hub</span>
                    <select name="hub_id" required class="${classeCampo}">${st.conti.map((c) => `<option value="${c.hub_id}">${esc(c.nome)} (${esc(c.codice)})</option>`).join('')}</select></label>
                <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Verso</span>
                    <select name="verso" class="${classeCampo}"><option value="hub_a_cd">Ricevuto dall'hub</option><option value="cd_a_hub">Inviato all'hub</option></select></label>
                <div class="grid grid-cols-2 gap-3">
                    <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Importo (€)</span><input name="importo_euro" type="number" min="0.01" step="0.01" required class="${classeCampo}"></label>
                    <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Data</span><input name="data" type="date" value="${new Date().toISOString().slice(0, 10)}" class="${classeCampo}"></label>
                </div>
                <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Nota (facoltativa)</span><input name="nota" maxlength="200" class="${classeCampo}" placeholder="Es. CRO del bonifico"></label>
                <button type="submit" class="${btnPrimario} w-full">Registra</button>
            </form>
        </div>`;
}

// ---------------------------------------------------------------------
// Amministrazione
// ---------------------------------------------------------------------
const campo = (nome, etichetta, tipo = 'text', extra = '') => `
    <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">${etichetta}</span>
    <input name="${nome}" type="${tipo}" class="${classeCampo}" ${extra}></label>`;
const interruttore = (tabella, id, attivo) => `
    <button type="button" data-attivo="${tabella}:${id}:${attivo ? '0' : '1'}" class="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold border ${attivo ? 'border-emerald-200 text-emerald-700 bg-emerald-50' : 'border-slate-200 text-slate-500 bg-slate-50'}">${attivo ? 'Attivo' : 'Disattivato'}</button>`;

function disegnaMedici() {
    $('vista').innerHTML = `
        <div class="grid grid-cols-1 lg:grid-cols-5 gap-5">
            <form data-admin="crea_medico" class="${card} space-y-3 lg:col-span-2 self-start">
                <h2 class="font-bold text-slate-900">Nuovo medico</h2>
                <div class="grid grid-cols-2 gap-3">${campo('nome', 'Nome', 'text', 'required')}${campo('cognome', 'Cognome', 'text', 'required')}</div>
                <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Genere</span>
                    <select name="genere" required data-genere class="${classeCampo}"><option value="">Scegli...</option><option value="M" ${'' === 'M' ? 'selected' : ''}>Maschile (Dott., Specializzato)</option><option value="F" ${'' === 'F' ? 'selected' : ''}>Femminile (Dott.ssa, Specializzata)</option><option value="A" ${'' === 'A' ? 'selected' : ''}>Altro (da specificare)</option></select></label>
                <div data-genere-altro ${'' === 'A' ? '' : 'hidden'} class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Titolo con cui essere identificato/a</span>
                        <input name="titolo" maxlength="15" value="" placeholder="Es. Dott., Dott.ssa, Dr." class="${classeCampo}"></label>
                    <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Dicitura della specializzazione</span>
                        <input name="dicitura_specializzazione" maxlength="30" value="" placeholder="Es. Specialista in" class="${classeCampo}"></label>
                </div>
                <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Specializzazione</span>
                    <select name="specializzazione" required class="${classeCampo}"><option value="">Scegli dall'elenco</option>${(window.SPECIALIZZAZIONI || []).map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>
                <div class="grid grid-cols-2 gap-3">${campo('citta', 'Città', 'text', 'required')}${campo('telefono', 'Telefono', 'tel')}</div>
                ${campo('indirizzo', 'Indirizzo dello studio', 'text', 'placeholder="Comunicato al paziente con la data della visita"')}
                ${campo('email', 'Email per le notifiche', 'email', 'required')}
                <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Prestazioni (una per riga)</span>
                    <textarea name="prestazioni" rows="3" class="${classeCampo}" placeholder="Prima visita cardiologica&#10;Elettrocardiogramma"></textarea></label>
                <button type="submit" class="${btnPrimario} w-full">Aggiungi il medico</button>
            </form>
            <div class="lg:col-span-3 space-y-3">
                ${st.medici.length ? st.medici.map((m) => {
                    const pr = st.prestazioni.filter((p) => p.medico_id === m.id);
                    return `<div class="${card} space-y-3">
                        <div class="flex items-start justify-between gap-3">
                            <div><div class="font-semibold text-slate-900">${m?.genere === 'F' ? 'Dott.ssa' : m?.genere === 'A' && m?.titolo ? m.titolo : 'Dott.'} ${esc(m.nome)} ${esc(m.cognome)}</div>
                            <div class="text-xs text-slate-500">${esc(m.specializzazione)} · ${esc(m.citta)} · ${esc(m.email)}</div></div>
                            ${interruttore('medici', m.id, m.attivo)}
                        </div>
                        ${rigaAbbonamento('medico', m.id)}
                        <div class="space-y-1.5">${pr.map((p) => `<div class="flex items-center justify-between gap-2 text-sm"><span class="text-slate-700">${esc(p.nome)}</span>${interruttore('prestazioni', p.id, p.attivo)}</div>`).join('') || '<p class="text-xs text-slate-500">Nessuna prestazione: il medico non compare nelle ricerche.</p>'}</div>
                        <form data-admin="crea_prestazione" class="flex gap-2"><input type="hidden" name="medico_id" value="${m.id}"><input name="nome" required placeholder="Nuova prestazione" class="${classeCampo}"><button type="submit" class="${btnSecondario} shrink-0">Aggiungi</button></form>
                    </div>`;
                }).join('') : `<div class="${card} text-sm text-slate-500 text-center py-10">Nessun medico ancora.</div>`}
            </div>
        </div>`;
}

function disegnaHub() {
    $('vista').innerHTML = `
        <div class="grid grid-cols-1 lg:grid-cols-5 gap-5">
            <form data-admin="crea_hub" class="${card} space-y-3 lg:col-span-2 self-start">
                <h2 class="font-bold text-slate-900">Nuovo hub</h2>
                <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Tipo</span>
                    <select name="tipo" class="${classeCampo}"><option value="struttura">Struttura privata</option><option value="medico">Medico che fa da hub</option></select></label>
                ${campo('nome', 'Nome', 'text', 'required')}
                ${campo('codice', 'Codice hub (entra nei codici CDH)', 'text', 'required maxlength="10" placeholder="Es. MT014" style="text-transform:uppercase"')}
                <div class="grid grid-cols-2 gap-3">${campo('citta', 'Città')}${campo('telefono', 'Telefono', 'tel')}</div>
                ${campo('indirizzo', 'Indirizzo')}
                ${campo('email', 'Email', 'email')}
                ${campo('coordinate', 'Coordinate sulla mappa (facoltative)', 'text', 'placeholder="Es. 40.6664, 16.6043"')}
                <p class="text-xs text-slate-500">La posizione sulla mappa pubblica degli hub si ricava da indirizzo e città; scrivi le coordinate solo per correggerla.</p>
                <button type="submit" class="${btnPrimario} w-full">Aggiungi l'hub</button>
            </form>
            <div class="lg:col-span-3 space-y-3">
                ${st.hub.length ? st.hub.map((h) => `
                    <div class="${card} space-y-3">
                        <div class="flex items-start justify-between gap-3">
                            <div><div class="font-semibold text-slate-900">${esc(h.nome)} <span class="font-mono text-xs text-slate-500">${esc(h.codice)}</span></div>
                            <div class="text-xs text-slate-500">${h.tipo === 'medico' ? 'Medico che fa da hub' : 'Struttura privata'}${h.citta ? ' · ' + esc(h.citta) : ''}${h.email ? ' · ' + esc(h.email) : ''}</div>
                            <div class="text-xs mt-1">${h.stripe_pronto ? '<span class="text-emerald-700"><i class="fa-solid fa-circle-check mr-1"></i>Stripe attivo: riceve i ticket</span>' : h.stripe_account_id ? '<span class="text-amber-700"><i class="fa-solid fa-circle-exclamation mr-1"></i>Stripe da completare</span>' : '<span class="text-slate-500"><i class="fa-regular fa-circle mr-1"></i>Stripe non collegato</span>'}</div>
                            <div class="text-xs mt-1 ${h.lat != null ? 'text-emerald-700' : 'text-amber-700'}"><i class="fa-solid fa-location-dot mr-1"></i>${h.lat != null ? (h.attivo ? 'Visibile sulla mappa degli hub' : 'Ha una posizione, ma non è attivo: non compare sulla mappa') : 'Senza posizione: non compare sulla mappa (aggiungi indirizzo e città)'}</div></div>
                            ${interruttore('hub', h.id, h.attivo)}
                        </div>
                        ${rigaAbbonamento('hub', h.id)}
                        <details class="text-sm">
                            <summary class="cursor-pointer text-skybrand-600 font-medium">Modifica dati e posizione</summary>
                            <form data-admin="aggiorna_hub" class="space-y-3 mt-3">
                                <input type="hidden" name="id" value="${h.id}">
                                <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Nome</span><input name="nome" required value="${esc(h.nome)}" class="${classeCampo}"></label>
                                <div class="grid grid-cols-2 gap-3">
                                    <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Città</span><input name="citta" value="${esc(h.citta || '')}" class="${classeCampo}"></label>
                                    <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Telefono</span><input name="telefono" type="tel" value="${esc(h.telefono || '')}" class="${classeCampo}"></label>
                                </div>
                                <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Indirizzo</span><input name="indirizzo" value="${esc(h.indirizzo || '')}" class="${classeCampo}"></label>
                                <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Email</span><input name="email" type="email" value="${esc(h.email || '')}" class="${classeCampo}"></label>
                                <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Coordinate (lascia vuoto per ricavarle da indirizzo e città)</span><input name="coordinate" value="" placeholder="${h.lat != null ? `Attuali: ${Number(h.lat).toFixed(5)}, ${Number(h.lng).toFixed(5)}` : 'Es. 40.6664, 16.6043'}" class="${classeCampo}"></label>
                                <button type="submit" class="${btnSecondario} w-full">Salva</button>
                            </form>
                        </details>
                    </div>`).join('') : `<div class="${card} text-sm text-slate-500 text-center py-10">Nessun hub ancora.</div>`}
            </div>
        </div>`;
}

function disegnaUtenze() {
    $('vista').innerHTML = `
        <div class="grid grid-cols-1 lg:grid-cols-5 gap-5">
            <form data-admin="invita_utente" class="${card} space-y-3 lg:col-span-2 self-start">
                <h2 class="font-bold text-slate-900">Nuova utenza</h2>
                <p class="text-xs text-slate-500">La persona riceve un'email con il link per scegliere la password.</p>
                ${campo('nome', 'Nome e cognome', 'text', 'required')}
                ${campo('email', 'Email', 'email', 'required')}
                <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Ruolo</span>
                    <select name="ruolo" class="${classeCampo}"><option value="operatore">Hub</option><option value="medico">Medico</option><option value="medico_hub">Medico che fa anche da hub</option><option value="admin">Amministratore</option></select></label>
                <p class="text-xs text-slate-500">Solo le utenze "Hub" e "Medico che fa anche da hub" collegano il conto Stripe e incassano i ticket; il medico vede soltanto se il ticket è stato pagato.</p>
                <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Hub collegato (per "Hub" e "Medico che fa anche da hub")</span>
                    <select name="hub_id" class="${classeCampo}"><option value="">Nessuno</option>${st.hub.map((h) => `<option value="${h.id}">${esc(h.nome)} (${esc(h.codice)})</option>`).join('')}</select></label>
                <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Medico collegato (per "Medico" e "Medico che fa anche da hub")</span>
                    <select name="medico_id" class="${classeCampo}"><option value="">Nessuno</option>${st.medici.map((m) => `<option value="${m.id}">${m?.genere === 'F' ? 'Dott.ssa' : m?.genere === 'A' && m?.titolo ? m.titolo : 'Dott.'} ${esc(m.cognome)} ${esc(m.nome)} · ${esc(m.specializzazione)}</option>`).join('')}</select></label>
                <button type="submit" class="${btnPrimario} w-full">Crea e invia l'invito</button>
            </form>
            <div class="lg:col-span-3 space-y-3">
                ${st.profili.map((p) => `
                    <div class="${card} flex items-start justify-between gap-3">
                        <div class="min-w-0"><div class="font-semibold text-slate-900 truncate">${esc(p.nome)}</div>
                        <div class="text-xs text-slate-500 break-words">${esc(p.email)} · ${RUOLI[p.ruolo]}${p.hub ? ' · ' + esc(p.hub.nome) : ''}${p.medico ? ` · Dott. ${esc(p.medico.cognome)}` : ''}</div></div>
                        ${p.id === st.io.id ? '<span class="text-xs text-slate-400 shrink-0">Tu</span>' : interruttore('profili', p.id, p.attivo)}
                    </div>`).join('')}
            </div>
        </div>`;
}

// ---------------------------------------------------------------------
// Candidature da "Lavora con noi"
// ---------------------------------------------------------------------
const STATI_CANDIDATURA = { nuova: 'Nuova', in_valutazione: 'In valutazione', accettata: 'Accettata', rifiutata: 'Rifiutata' };
const TIPI_CANDIDATURA = { medico: 'Medico', struttura: 'Struttura (hub)', medico_hub: 'Medico che vuole fare da hub' };

async function caricaCandidature() {
    const [{ data }] = await Promise.all([
        supabase.from('candidature').select('*').order('creata_il', { ascending: false }).limit(300),
        caricaImpostazioni(),
    ]);
    st.candidature = data || [];
}

function disegnaCandidature() {
    const dest = st.impostazioni.email_candidature;
    $('vista').innerHTML = `
        <div class="space-y-3 max-w-4xl">
            <p class="text-sm ${dest ? 'text-slate-500' : 'text-amber-700'}">${dest ? `Le nuove richieste arrivano anche per email a <strong>${esc(dest)}</strong>.` : 'Nessuna email di destinazione impostata: le richieste sono solo qui. Impostala nella scheda Impostazioni.'}</p>
            ${st.candidature.length ? st.candidature.map((c) => `
                <div class="${card} space-y-2">
                    <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                        <div>
                            <div class="font-semibold text-slate-900">${esc(c.tipo === 'struttura' ? c.struttura : `${c.nome} ${c.cognome || ''}`)}</div>
                            <div class="text-xs text-slate-500">${esc(TIPI_CANDIDATURA[c.tipo] || c.tipo)}${c.specializzazione ? ' · ' + esc(c.specializzazione) : ''} · ${esc(c.citta)}${c.provincia ? ` (${esc(c.provincia)})` : ''} · ${dataOra(c.creata_il)}</div>
                        </div>
                        <select data-stato-candidatura="${c.id}" class="${classeCampo} !w-auto !py-1.5 text-xs">${Object.entries(STATI_CANDIDATURA).map(([k, v]) => `<option value="${k}" ${k === c.stato ? 'selected' : ''}>${v}</option>`).join('')}</select>
                    </div>
                    <div class="text-sm text-slate-700 flex flex-wrap gap-x-4 gap-y-1">
                        ${c.tipo === 'struttura' ? `<span>Referente: ${esc(c.nome)} ${esc(c.cognome || '')}</span>` : ''}
                        <a class="text-skybrand-600" href="mailto:${esc(c.email)}">${esc(c.email)}</a>
                        <a class="text-skybrand-600" href="tel:${esc(c.telefono)}">${esc(c.telefono)}</a>
                        ${c.indirizzo ? `<span>${esc(c.indirizzo)}</span>` : ''}
                        ${c.partita_iva ? `<span>P. IVA ${esc(c.partita_iva)}</span>` : ''}
                    </div>
                    ${c.messaggio ? `<p class="text-sm text-slate-600 whitespace-pre-wrap rounded-xl bg-slate-50 border border-slate-200 p-3">${esc(c.messaggio)}</p>` : ''}
                </div>`).join('') : `<div class="${card} text-sm text-slate-500 text-center py-10">Nessuna richiesta ricevuta.</div>`}
        </div>`;
}

function disegnaImpostazioni() {
    const i = st.impostazioni;
    $('vista').innerHTML = `
        <form data-admin="imposta_impostazioni" class="${card} space-y-4 max-w-lg">
            <div>
                <h2 class="font-bold text-slate-900">Ticket di prenotazione</h2>
                <p class="text-sm text-slate-500">Percentuale della tariffa della prestazione pagata dal paziente, sia online sia tramite hub. Il ticket va per intero all'hub di riferimento: Click Dottore percepisce solo gli abbonamenti.</p>
            </div>
            <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Percentuale sulla tariffa (%)</span>
                <input name="ticket_percento" type="number" min="0.1" max="100" step="0.1" value="${esc(i.ticket_percento ?? '10')}" required class="${classeCampo}"></label>
            <div class="pt-2 border-t border-slate-100">
                <h2 class="font-bold text-slate-900 mt-2">Prezzi degli abbonamenti mensili</h2>
                <p class="text-sm text-slate-500">Valgono per i nuovi abbonamenti di medici e hub; chi è già abbonato mantiene il prezzo sottoscritto.</p>
            </div>
            <div class="grid grid-cols-3 gap-3">${PIANI.map((p) => `
                <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">${PIANI_INFO[p].nome} (€)</span>
                    <input name="abbonamento_${p}" type="number" min="1" max="1000" step="0.01" value="${(Number(i[`abbonamento_${p}_cents`] ?? PIANI_INFO[p].cents) / 100).toFixed(2)}" required class="${classeCampo}"></label>`).join('')}
            </div>
            <div class="pt-2 border-t border-slate-100">
                <h2 class="font-bold text-slate-900 mt-2">Conto per i bonifici degli hub</h2>
                <p class="text-sm text-slate-500">Mostrato agli hub nella scheda Conti, per versare la parte di Click Dottore con bonifico istantaneo.</p>
            </div>
            <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">IBAN</span>
                <input name="iban" maxlength="40" value="${esc(i.iban_click_dottore ?? '')}" class="${classeCampo} font-mono" style="text-transform:uppercase"></label>
            <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Intestatario</span>
                <input name="intestatario" maxlength="120" value="${esc(i.intestatario_iban ?? '')}" class="${classeCampo}"></label>
            <div class="pt-2 border-t border-slate-100">
                <h2 class="font-bold text-slate-900 mt-2">Richieste da "Lavora con noi"</h2>
                <p class="text-sm text-slate-500">Indirizzo che riceve per email ogni nuova richiesta di medici e hub. Le richieste restano comunque nella scheda Candidature.</p>
            </div>
            <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Email di destinazione</span>
                <input name="email_candidature" type="email" maxlength="120" value="${esc(i.email_candidature ?? '')}" class="${classeCampo}" placeholder="Es. adesioni@clickdottore.it"></label>
            <button type="submit" class="${btnPrimario}">Salva</button>
        </form>`;
}

async function inviaAdmin(form) {
    const azione = form.dataset.admin;
    const f = Object.fromEntries(new FormData(form).entries());
    const btn = form.querySelector('button[type=submit]');
    let dati = { azione, ...f };
    if (azione === 'crea_medico') dati.prestazioni = String(f.prestazioni || '').split('\n').map((s) => s.trim()).filter(Boolean).map((nome) => ({ nome }));
    if (azione === 'crea_hub') dati.codice = String(f.codice || '').toUpperCase();
    if (azione === 'imposta_impostazioni') {
        dati = {
            azione, ticket_percento: String(f.ticket_percento).replace(',', '.'),
            iban: f.iban, intestatario: f.intestatario, email_candidature: f.email_candidature,
        };
        for (const p of PIANI) dati[`abbonamento_${p}_cents`] = Math.round(Number(String(f[`abbonamento_${p}`]).replace(',', '.')) * 100);
    }
    if (azione === 'invita_utente') { dati.hub_id = f.hub_id || null; dati.medico_id = f.medico_id || null; }
    btn.disabled = true;
    try {
        await api('admin', { conAccesso: true, dati });
        const testi = {
            crea_medico: 'Medico aggiunto', crea_prestazione: 'Prestazione aggiunta', crea_hub: 'Hub aggiunto',
            invita_utente: 'Utenza creata: l\'invito è stato inviato via email', imposta_impostazioni: 'Impostazioni salvate', aggiorna_hub: 'Hub aggiornato',
            registra_regolazione: 'Bonifico registrato',
        };
        if (azione === 'imposta_impostazioni') st.percento = Number(dati.ticket_percento);
        await vai(st.scheda);
        avviso(testi[azione] || 'Fatto', 'ok');
    } catch (err) {
        avviso(err.message);
        btn.disabled = false;
    }
}

// ---------------------------------------------------------------------
// Spostamento della data (medico e hub)
// ---------------------------------------------------------------------
async function apriSposta() {
    const p = st.prenotazioni.find((x) => x.id === st.pannelloId);
    const el = document.getElementById('sposta-slot');
    if (!p || !el) return;
    st.nuovoOrario = null;
    el.innerHTML = '<p class="text-sm text-slate-500"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Carico gli orari liberi...</p>';
    try {
        const slots = await slotLiberi(p.prestazione_id);
        selettoreSlot(el, slots, (iso) => {
            st.nuovoOrario = iso;
            const b = $('pannello-corpo').querySelector('[data-conferma-sposta]');
            if (b) { b.hidden = false; b.textContent = `Sposta la visita a ${quando(iso)}`; }
        });
    } catch (err) {
        el.innerHTML = `<p class="text-sm text-red-700">${esc(err.message)}</p>`;
    }
}

// ---------------------------------------------------------------------
// Ticket e conto Stripe dell'hub
// ---------------------------------------------------------------------
function testoTicketNuova() {
    const pr = st.prestazioni.find((x) => x.id === st.nuova?.prestazioneId);
    const t = pr ? ticketDi(pr.prezzo_visita_cents, st.percento) : 0;
    const quanto = pr ? (t ? `di ${euro(t)}` : '') : `(il ${percentoTesto(st.percento)} della tariffa)`;
    if (pr && !t) return 'Per questa prestazione non c\'è ticket da incassare.';
    return `Il ticket ${quanto} spetta interamente al tuo hub: lo incassi allo sportello o con il bollettino online, dal dettaglio della prenotazione.`;
}

async function caricaStatoStripe() {
    try {
        st.stripeHub = await api('stato-stripe-hub', { conAccesso: true, dati: {} });
    } catch (err) {
        st.stripeHub = { errore: err.message };
    }
    const el = $('avviso-stripe') || (() => {
        const d = document.createElement('div');
        d.id = 'avviso-stripe';
        d.className = 'mb-4';
        $('schede').before(d);
        return d;
    })();
    const s = st.stripeHub;
    el.hidden = !!s.pronto || !!s.errore;
    if (!el.hidden) {
        el.innerHTML = `
            <div class="rounded-2xl border border-skybrand-200 bg-skybrand-50 px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div class="text-sm text-slate-800"><i class="fa-solid fa-wallet mr-2 text-skybrand-600"></i><strong>${s.collegato ? 'Completa la registrazione su Stripe' : 'Collega il tuo conto Stripe'}</strong> per ricevere i ticket delle prenotazioni online dei medici della tua zona.</div>
                <button type="button" data-collega-stripe class="shrink-0 ${btnPrimario} !py-2">${s.collegato ? 'Completa su Stripe' : 'Collega Stripe'}</button>
            </div>`;
    }
}

async function collegaStripe(btn) {
    const testo = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Apertura di Stripe...';
    try {
        const { url } = await api('collega-stripe', { conAccesso: true, dati: {} });
        location.href = url;
    } catch (err) {
        avviso(err.message);
        btn.disabled = false;
        btn.innerHTML = testo;
    }
}

function disegnaIncassi() {
    const s = st.stripeHub || {};
    const mie = st.prenotazioni.filter((p) => p.hub_id === st.io.hub_id);
    const incassate = mie.filter((p) => p.pagata_il && p.stato !== 'rimborsata');
    const inizioMese = new Date(); inizioMese.setDate(1); inizioMese.setHours(0, 0, 0, 0);
    const somma = (r) => r.reduce((t, p) => t + (p.quota_cents || 0), 0);
    const delMese = incassate.filter((p) => new Date(p.pagata_il) >= inizioMese);
    const online = incassate.filter((p) => p.stripe_payment_intent);
    const sportello = incassate.filter((p) => !p.stripe_payment_intent);
    const stato = s.errore ? `<p class="text-sm text-red-700">${esc(s.errore)}</p>`
        : s.pronto ? `<p class="text-sm text-emerald-700 font-semibold"><i class="fa-solid fa-circle-check mr-1"></i>Conto Stripe attivo: ricevi i ticket pagati online.</p>
            ${s.accrediti_attivi ? '' : '<p class="text-xs text-amber-700">Stripe non ha ancora attivato i versamenti sul tuo conto bancario: completa i dati richiesti dalla dashboard di Stripe.</p>'}
            <a href="https://dashboard.stripe.com" target="_blank" rel="noopener" class="${btnSecondario} w-full sm:w-auto"><i class="fa-solid fa-arrow-up-right-from-square mr-1"></i> Apri la dashboard Stripe</a>`
        : s.collegato ? `<p class="text-sm text-amber-700 font-semibold"><i class="fa-solid fa-circle-exclamation mr-1"></i>Registrazione su Stripe da completare${s.da_completare ? ` (${s.da_completare} ${s.da_completare === 1 ? 'dato mancante' : 'dati mancanti'})` : ''}.</p>
            <button type="button" data-collega-stripe class="${btnPrimario}">Completa su Stripe</button>`
        : `<p class="text-sm text-slate-600">Per ricevere i ticket pagati online dai pazienti serve un conto Stripe intestato al tuo hub. La registrazione si fa sul sito di Stripe e richiede pochi minuti (dati dell'attività, documento e IBAN).</p>
            <button type="button" data-collega-stripe class="${btnPrimario}">Collega Stripe</button>`;
    $('vista').innerHTML = `
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 max-w-5xl">
            <div class="${card} space-y-3">
                <h2 class="font-bold text-slate-900">Conto Stripe per i ticket</h2>
                ${stato}
                <p class="text-xs text-slate-500">Il ticket (${percentoTesto(st.percento)} della tariffa della visita) delle prenotazioni online dei medici della tua città, o di cui sei l'hub più vicino, si paga direttamente sul tuo conto Stripe. Le commissioni di Stripe sono a carico del conto che incassa; i rimborsi dovuti al paziente partono in automatico dallo stesso conto.</p>
            </div>
            <div class="${card} space-y-3">
                <h2 class="font-bold text-slate-900">Ticket incassati</h2>
                <dl class="grid grid-cols-1 gap-2 text-sm">
                    <div class="flex justify-between"><dt class="text-slate-500">Questo mese</dt><dd class="font-semibold text-slate-900">${euro(somma(delMese))}</dd></div>
                    <div class="flex justify-between"><dt class="text-slate-500">Totale pagati online (Stripe)</dt><dd class="font-medium">${euro(somma(online))}</dd></div>
                    <div class="flex justify-between"><dt class="text-slate-500">Totale incassati allo sportello</dt><dd class="font-medium">${euro(somma(sportello))}</dd></div>
                    <div class="flex justify-between"><dt class="text-slate-500">Prenotazioni con ticket incassato</dt><dd class="font-medium">${incassate.length}</dd></div>
                </dl>
                <p class="text-xs text-slate-500">Click Dottore non trattiene nulla sui ticket: il tuo hub paga solo l'abbonamento mensile.</p>
            </div>
        </div>`;
}

// ---------------------------------------------------------------------
// Abbonamento mensile di medici e hub
// ---------------------------------------------------------------------
const PIANI = ['starter', 'plus', 'premium'];
const PIANI_INFO = {
    starter: { nome: 'Starter', cents: 1990, icona: 'fa-seedling', punti: ['Tutte le funzioni dell\'area riservata', 'Prenotazioni, orari, prestazioni e conti', 'Visibilità nella ricerca e sulla mappa del sito'] },
    plus: { nome: 'Plus', cents: 3990, icona: 'fa-star', punti: ['Tutto ciò che include Starter', 'Funzioni prioritarie (in arrivo)'] },
    premium: { nome: 'Premium', cents: 5990, icona: 'fa-crown', punti: ['Tutto ciò che include Plus', 'Massima priorità e funzioni esclusive (in arrivo)'] },
};
const STATI_ABBONAMENTO = {
    active: ['Attivo', 'bg-emerald-50 text-emerald-700 border-emerald-200'],
    trialing: ['In prova', 'bg-emerald-50 text-emerald-700 border-emerald-200'],
    past_due: ['Pagamento non riuscito', 'bg-red-50 text-red-700 border-red-200'],
    unpaid: ['Non pagato', 'bg-red-50 text-red-700 border-red-200'],
    canceled: ['Disdetto', 'bg-slate-50 text-slate-600 border-slate-200'],
    incomplete: ['Pagamento da completare', 'bg-amber-50 text-amber-700 border-amber-200'],
    incomplete_expired: ['Pagamento scaduto', 'bg-slate-50 text-slate-600 border-slate-200'],
    paused: ['In pausa', 'bg-amber-50 text-amber-700 border-amber-200'],
    nessuno: ['Nessun abbonamento', 'bg-slate-50 text-slate-600 border-slate-200'],
};
const badgeAbbonamento = (stato, esente) => {
    const [testo, classi] = esente ? ['Esente', 'bg-skybrand-50 text-skybrand-700 border-skybrand-200'] : (STATI_ABBONAMENTO[stato] || [stato, 'bg-slate-50 text-slate-600 border-slate-200']);
    return `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${classi}">${esc(testo)}</span>`;
};

async function vaiAStripe(btn, percorso, dati) {
    const testo = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Apertura di Stripe...';
    try {
        const { url } = await api(percorso, { conAccesso: true, dati });
        location.href = url;
    } catch (err) {
        avviso(err.message);
        btn.disabled = false;
        btn.innerHTML = testo;
    }
}

function schedePiani(attuale = null) {
    const prezzi = st.abbonamento?.prezzi || {};
    return `<div class="grid grid-cols-1 md:grid-cols-3 gap-4">${PIANI.map((p) => {
        const info = PIANI_INFO[p];
        const inEvidenza = p === 'plus';
        const pulsante = attuale
            ? (attuale === p ? `<div class="w-full text-center px-4 py-2.5 rounded-xl text-sm font-semibold bg-slate-100 text-slate-500">Piano attuale</div>`
                : `<button type="button" data-cambia-piano="${p}" class="${inEvidenza ? btnPrimario : btnSecondario} w-full">Passa a ${info.nome}</button>`)
            : `<button type="button" data-abbonati="${p}" class="${inEvidenza ? btnPrimario : btnSecondario} w-full">Scegli ${info.nome}</button>`;
        return `<div class="${card} flex flex-col gap-4 ${inEvidenza ? 'border-skybrand-400 ring-1 ring-skybrand-400' : ''}">
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-2"><span class="w-9 h-9 rounded-xl bg-skybrand-50 text-skybrand-600 flex items-center justify-center"><i class="fa-solid ${info.icona}"></i></span><h3 class="font-bold text-slate-900">${info.nome}</h3></div>
                ${inEvidenza ? '<span class="text-xs font-semibold text-skybrand-700 bg-skybrand-50 px-2 py-0.5 rounded-full">Consigliato</span>' : ''}
            </div>
            <div><span class="text-3xl font-bold text-slate-900">${euro(prezzi[p] ?? info.cents)}</span><span class="text-sm text-slate-500"> / mese</span></div>
            <ul class="space-y-2 text-sm text-slate-600 flex-grow">${info.punti.map((x) => `<li class="flex gap-2"><i class="fa-solid fa-check text-skybrand-500 mt-1"></i><span>${esc(x)}</span></li>`).join('')}</ul>
            ${pulsante}
        </div>`;
    }).join('')}</div>`;
}

// Area bloccata: scelta del piano o regolarizzazione del pagamento
function mostraPiani() {
    const a = st.abbonamento;
    $('schede').hidden = true;
    const scaduta = a.periodo_fine && ['canceled', 'unpaid'].includes(a.stato);
    $('vista').innerHTML = a.in_sospeso ? `
        <div class="${card} max-w-xl mx-auto text-center space-y-4 py-8">
            <span class="w-14 h-14 mx-auto rounded-2xl bg-red-50 text-red-600 flex items-center justify-center text-2xl"><i class="fa-solid fa-lock"></i></span>
            <h2 class="text-lg font-bold text-slate-900">Area riservata sospesa</h2>
            <p class="text-sm text-slate-600">L'ultimo pagamento dell'abbonamento ${a.piano ? esc(PIANI_INFO[a.piano].nome) + ' ' : ''}non è andato a buon fine. Le tue credenziali restano valide: appena il pagamento viene regolarizzato l'area si sblocca di nuovo.</p>
            <div class="flex flex-col sm:flex-row gap-2 justify-center">
                ${a.fattura ? `<a href="${esc(a.fattura)}" class="${btnPrimario}"><i class="fa-solid fa-credit-card mr-2"></i>Paga la fattura in sospeso</a>` : ''}
                <button type="button" data-portale class="${a.fattura ? btnSecondario : btnPrimario}"><i class="fa-solid fa-gear mr-2"></i>Gestisci pagamento</button>
            </div>
        </div>` : `
        <div class="space-y-5">
            <div class="${card} text-center space-y-2 py-6">
                <span class="w-12 h-12 mx-auto rounded-2xl bg-skybrand-50 text-skybrand-600 flex items-center justify-center text-xl"><i class="fa-solid fa-lock"></i></span>
                <h2 class="text-lg font-bold text-slate-900">${scaduta ? 'Il tuo abbonamento è terminato' : 'Attiva il tuo abbonamento'}</h2>
                <p class="text-sm text-slate-600 max-w-xl mx-auto">${scaduta ? 'Scegli di nuovo un piano per riattivare l\'area riservata: i tuoi dati sono ancora tutti qui.' : 'Per usare l\'area riservata di Click Dottore scegli un abbonamento mensile. Il pagamento è gestito in sicurezza da Stripe e puoi disdire quando vuoi dalla scheda Abbonamento.'}</p>
            </div>
            ${schedePiani()}
            <p class="text-xs text-slate-500 text-center">Prezzi mensili IVA inclusa. Il rinnovo è automatico ogni mese; se un pagamento non va a buon fine l'area riservata viene sospesa finché non è regolarizzato.</p>
        </div>`;
}

function disegnaAbbonamento() {
    const a = st.abbonamento;
    if (a.esente) {
        $('vista').innerHTML = `<div class="${card} max-w-xl space-y-2"><div class="flex items-center gap-2"><h2 class="font-bold text-slate-900">Abbonamento</h2>${badgeAbbonamento(a.stato, true)}</div>
            <p class="text-sm text-slate-600">Click Dottore ti ha concesso l'accesso all'area riservata senza abbonamento.</p></div>`;
        return;
    }
    const fine = a.periodo_fine ? data(a.periodo_fine.slice(0, 10)) : null;
    $('vista').innerHTML = `
        <div class="space-y-5">
            <div class="${card} space-y-4">
                <div class="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <div class="flex items-center gap-2"><h2 class="font-bold text-slate-900">Piano ${a.piano ? esc(PIANI_INFO[a.piano].nome) : ''}</h2>${badgeAbbonamento(a.stato, false)}</div>
                        <p class="text-sm text-slate-500 mt-1">${a.disdetta
                            ? `<i class="fa-solid fa-circle-exclamation text-amber-500 mr-1"></i>Disdetto: l'accesso resta attivo fino al ${esc(fine || '')}, poi l'area riservata verrà bloccata.`
                            : fine ? `Prossimo rinnovo il ${esc(fine)}.` : ''}</p>
                    </div>
                    ${a.gestibile ? `<button type="button" data-portale class="${btnSecondario}"><i class="fa-solid fa-file-invoice mr-2"></i>Pagamenti, fatture e disdetta</button>` : ''}
                </div>
            </div>
            <div>
                <h3 class="font-semibold text-slate-900 mb-3">${a.disdetta ? 'Riattiva o cambia piano' : 'Cambia piano'}</h3>
                ${schedePiani(a.disdetta ? '__' : a.piano)}
            </div>
        </div>`;
}

function rigaAbbonamento(tipo, id) {
    const a = st.abbonamenti.find((x) => (tipo === 'hub' ? x.hub_id : x.medico_id) === id);
    const esente = !!a?.esente;
    const dettaglio = a && !esente && a.piano ? ` · ${PIANI_INFO[a.piano]?.nome || ''}${a.periodo_fine ? ` · ${a.disdetta_a_fine_periodo ? 'fino al' : 'rinnovo'} ${data(a.periodo_fine.slice(0, 10))}` : ''}` : '';
    return `<div class="flex flex-wrap items-center justify-between gap-2 text-xs border-t border-slate-100 pt-3">
        <span class="text-slate-600"><i class="fa-solid fa-id-card mr-1 text-slate-400"></i>Abbonamento: ${badgeAbbonamento(a?.stato || 'nessuno', esente)}<span class="ml-1">${esc(dettaglio)}</span></span>
        <button type="button" data-esente="${tipo}:${id}:${esente ? '0' : '1'}" class="px-3 py-1.5 rounded-lg font-semibold border ${esente ? 'border-skybrand-200 text-skybrand-700 bg-skybrand-50' : 'border-slate-200 text-slate-600 bg-white hover:border-skybrand-300'}">${esente ? 'Togli esenzione' : 'Rendi esente'}</button>
    </div>`;
}

// ---------------------------------------------------------------------
// Eventi
// ---------------------------------------------------------------------
document.addEventListener('click', async (e) => {
    const t = e.target.closest('button, [data-chiudi]');
    if (!t) return;
    if (t.hasAttribute('data-esci')) { await supabase.auth.signOut(); return location.replace('accedi.html'); }
    if (t.dataset.scheda) return vai(t.dataset.scheda);
    if (t.hasAttribute('data-vedi-richieste')) { st.filtro = 'da_confermare'; return vai('prenotazioni'); }
    if (t.dataset.filtro) { st.filtro = t.dataset.filtro; return disegnaPrenotazioni(); }
    if (t.dataset.rapida) return azionePrenotazione(t.dataset.rapida, {}, t, t.dataset.id);
    if (t.dataset.apri) return apriPannello(t.dataset.apri);
    if (t.dataset.apriDopo) {
        st.filtro = 'tutte';
        await vai('prenotazioni');
        return apriPannello(t.dataset.apriDopo);
    }
    if (t.hasAttribute('data-chiudi')) return chiudiPannello();
    if (t.hasAttribute('data-bollettino')) return stampaBollettino(t);
    if (t.hasAttribute('data-apri-sposta')) return apriSposta();
    if (t.hasAttribute('data-conferma-sposta')) {
        if (!st.nuovoOrario) return;
        return azionePrenotazione('sposta', { inizio: st.nuovoOrario }, t);
    }
    if (t.hasAttribute('data-collega-stripe')) return collegaStripe(t);
    if (t.dataset.azione) {
        const corpo = $('pannello-corpo');
        const extra = {};
        if (t.dataset.azione === 'annulla') { extra.nota = corpo.querySelector('[data-motivo]')?.value; extra.causa = corpo.querySelector('[data-causa]')?.value; }
        if (t.dataset.azione === 'rifiuta') extra.nota = corpo.querySelector('[data-motivo-rifiuto]')?.value;
        if (t.dataset.azione === 'registra_incasso') {
            extra.metodo_pagamento = corpo.querySelector('[data-metodo]')?.value;
            if (!extra.metodo_pagamento) { $('msg-pannello').hidden = false; return messaggio($('msg-pannello'), 'Scegli come è stato pagato il ticket'); }
        }
        return azionePrenotazione(t.dataset.azione, extra, t);
    }
    if (t.dataset.scegliMedico) { st.nuova.medicoId = t.dataset.scegliMedico; st.nuova.prestazioneId = null; st.nuova.slot = null; return disegnaNuova(); }
    if (t.hasAttribute('data-cambia-medico')) { st.nuova.medicoId = null; st.nuova.prestazioneId = null; st.nuova.slot = null; return disegnaNuova(); }
    if (t.hasAttribute('data-nuova-ancora')) { st.nuova = { medicoId: null, cercaMedico: '', hubId: st.nuova.hubId, prestazioneId: null, slot: null, esito: null }; return disegnaNuova(); }
    if (t.dataset.aggiungiFascia) {
        leggiFasce();
        const g = Number(t.dataset.aggiungiFascia);
        const ultime = st.orari.filter((f) => f.giorno === g);
        st.orari.push(ultime.length ? { giorno: g, inizio: '15:00', fine: '19:00' } : { giorno: g, inizio: '09:00', fine: '13:00' });
        return disegnaOrari();
    }
    if (t.dataset.togliFascia) { leggiFasce(); st.orari.splice(Number(t.dataset.togliFascia), 1); return disegnaOrari(); }
    if (t.hasAttribute('data-salva-orari')) return salvaOrari(t);
    if (t.dataset.eliminaChiusura) {
        t.disabled = true;
        try {
            await api('medico', { conAccesso: true, dati: { azione: 'elimina_chiusura', id: t.dataset.eliminaChiusura, medico_id: st.medicoGestito } });
            await vai('orari');
        } catch (err) { avviso(err.message); t.disabled = false; }
        return;
    }
    if (t.dataset.abbonati) return vaiAStripe(t, 'abbonati', { piano: t.dataset.abbonati });
    if (t.hasAttribute('data-portale')) return vaiAStripe(t, 'portale-abbonamento', {});
    if (t.dataset.cambiaPiano) {
        const p = t.dataset.cambiaPiano;
        const prezzo = euro(st.abbonamento?.prezzi?.[p]);
        if (!confirm(`Passare al piano ${PIANI_INFO[p].nome} (${prezzo} al mese)? La differenza per i giorni restanti del mese viene addebitata o accreditata subito sulla carta dell'abbonamento.`)) return;
        t.disabled = true;
        try {
            await api('cambia-piano', { conAccesso: true, dati: { piano: p } });
            await vai('abbonamento');
            avviso(`Piano ${PIANI_INFO[p].nome} attivo`, 'ok');
        } catch (err) { avviso(err.message); t.disabled = false; }
        return;
    }
    if (t.dataset.esente) {
        const [tipo, id, valore] = t.dataset.esente.split(':');
        t.disabled = true;
        try {
            await api('admin', { conAccesso: true, dati: { azione: 'imposta_esente', tipo, id, esente: valore === '1' } });
            await vai(st.scheda);
        } catch (err) { avviso(err.message); t.disabled = false; }
        return;
    }
    if (t.dataset.attivo) {
        const [tabella, id, valore] = t.dataset.attivo.split(':');
        t.disabled = true;
        try {
            await api('admin', { conAccesso: true, dati: { azione: 'imposta_attivo', tabella, id, attivo: valore === '1' } });
            await vai(st.scheda);
        } catch (err) { avviso(err.message); t.disabled = false; }
    }
});

document.addEventListener('submit', (e) => {
    const form = e.target;
    if (form.id === 'form-nuova') { e.preventDefault(); return inviaNuova(form); }
    if (form.dataset.medico) { e.preventDefault(); return inviaMedico(form); }
    if (form.hasAttribute('data-listino')) { e.preventDefault(); return inviaListino(form); }
    if (form.dataset.admin) { e.preventDefault(); return inviaAdmin(form); }
});

document.addEventListener('input', (e) => {
    if (e.target.id === 'cerca-prenotazioni') { st.cerca = e.target.value; disegnaElencoPrenotazioni(); }
    if (e.target.id === 'cerca-medico') {
        st.nuova.cercaMedico = e.target.value;
        disegnaRisultatiMedici(mediciPrenotabili());
    }
});
document.addEventListener('change', (e) => {
    // genere "Altro": compaiono titolo e dicitura scelti dal professionista
    if (e.target.hasAttribute('data-genere')) {
        const altro = e.target.closest('form')?.querySelector('[data-genere-altro]');
        if (altro) {
            altro.hidden = e.target.value !== 'A';
            const titolo = altro.querySelector('[name=titolo]');
            titolo.required = e.target.value === 'A';
            if (e.target.value === 'A') titolo.focus();
        }
    }
    if (e.target.hasAttribute('data-listino-spec')) { st.listinoSpec = e.target.value; return disegnaTariffe(); }
    // spuntando una prestazione del listino il cursore va sulla tariffa
    if (e.target.hasAttribute('data-offerta') && e.target.checked) {
        const prezzo = e.target.closest('[data-voce]')?.querySelector('[data-prezzo]');
        if (prezzo && !prezzo.value) prezzo.focus();
    }
    if (e.target.name === 'hub_id' && e.target.closest('#form-nuova')) st.nuova.hubId = e.target.value;
    if (e.target.name === 'prestazione_id' && e.target.closest('#form-nuova')) {
        st.nuova.prestazioneId = e.target.value;
        st.nuova.slot = null;
        if ($('ticket-nuova')) $('ticket-nuova').textContent = testoTicketNuova();
        caricaSlotNuova();
    }
    if (e.target.id === 'medico-gestito') { st.medicoGestito = e.target.value; st.listinoSpec = null; vai(st.scheda); }
    if (e.target.dataset.statoCandidatura) {
        api('admin', { conAccesso: true, dati: { azione: 'stato_candidatura', id: e.target.dataset.statoCandidatura, stato: e.target.value } })
            .then(() => avviso('Stato aggiornato', 'ok')).catch((err) => avviso(err.message));
    }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('pannello').hidden) chiudiPannello(); });

supabase.auth.onAuthStateChange((evento) => { if (evento === 'SIGNED_OUT') location.replace('accedi.html'); });
seguiCambioUtente();

avvia().catch((err) => {
    $('caricamento').hidden = true;
    $('app').hidden = false;
    avviso(err.message || 'Errore di caricamento');
});
