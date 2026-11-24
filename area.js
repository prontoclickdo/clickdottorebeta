// Click Dottore - area riservata (amministratore, operatori degli hub, medici)
import {
    supabase, api, esc, euro, dataOra, data, quotaCents, badgeStato, STATI,
    htmlCampiPaziente, leggiPaziente, erroriPaziente, messaggio, classeCampo,
} from './app.js';

const $ = (id) => document.getElementById(id);
const RUOLI = { admin: 'Amministratore', operatore: 'Operatore', medico: 'Medico' };
const ATTIVE = ['pagata', 'presa_in_carico', 'visita_fissata'];

const st = {
    io: null, scheda: null, quota: null,
    prenotazioni: [], filtro: 'attive', cerca: '',
    medici: [], prestazioni: [], hub: [], profili: [],
    nuova: { medicoId: null, cercaMedico: '', hubId: null, esito: null },
    pannelloId: null,
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
        .select('*, hub:hub(nome, codice, tipo), medico:medici(nome, cognome)')
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
    st.quota = await quotaCents();

    const dove = profilo.ruolo === 'admin' ? 'Click Dottore'
        : profilo.hub ? `${profilo.hub.nome} · codice hub ${profilo.hub.codice}`
        : profilo.medico ? `Dott. ${profilo.medico.nome} ${profilo.medico.cognome}` : '';
    $('sottotitolo').textContent = `${RUOLI[profilo.ruolo]}${dove ? ' · ' + dove : ''}`;
    $('app').hidden = false;

    if (profilo.ruolo === 'admin') {
        await Promise.all([caricaHub(), caricaMedici(), caricaProfili()]);
    } else {
        await caricaMedici();
    }
    vai(profilo.ruolo === 'operatore' ? 'nuova' : 'prenotazioni');
}

function schede() {
    const r = st.io.ruolo;
    const elenco = [['prenotazioni', 'Prenotazioni', 'fa-list-check']];
    if (r === 'admin' || st.io.hub_id) elenco.push(['nuova', 'Nuova prenotazione', 'fa-plus']);
    if (r === 'admin') elenco.push(['medici', 'Medici', 'fa-user-doctor'], ['hub', 'Hub', 'fa-hospital'], ['utenze', 'Utenze', 'fa-users'], ['impostazioni', 'Impostazioni', 'fa-gear']);
    if (r === 'operatore') elenco.reverse();
    $('schede').innerHTML = elenco.map(([id, testo, icona]) => `
        <button type="button" data-scheda="${id}" class="shrink-0 px-4 py-2 rounded-xl text-sm font-medium border transition ${st.scheda === id ? 'bg-skybrand-500 text-white border-transparent' : 'bg-white border-slate-200 text-slate-700 hover:border-skybrand-300'}">
            <i class="fa-solid ${icona} mr-1.5"></i>${testo}</button>`).join('');
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
        if (scheda === 'medici') { await caricaMedici(); disegnaMedici(); }
        if (scheda === 'hub') { await caricaHub(); disegnaHub(); }
        if (scheda === 'utenze') { await Promise.all([caricaProfili(), caricaHub(), caricaMedici()]); disegnaUtenze(); }
        if (scheda === 'impostazioni') disegnaImpostazioni();
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
        .select('*, medico:medici(nome, cognome, specializzazione, citta, indirizzo), prestazione:prestazioni(nome), hub:hub(nome, codice)')
        .order('creata_il', { ascending: false }).limit(500);
    if (error) throw new Error('Impossibile caricare le prenotazioni');
    st.prenotazioni = righe || [];
}
async function caricaMedici() {
    const [{ data: m }, { data: p }] = await Promise.all([
        supabase.from('medici').select('*').order('cognome'),
        supabase.from('prestazioni').select('*').order('nome'),
    ]);
    st.medici = m || []; st.prestazioni = p || [];
}
async function caricaHub() {
    const { data: h } = await supabase.from('hub').select('*').order('nome');
    st.hub = h || [];
}
async function caricaProfili() {
    const { data: p } = await supabase.from('profili').select('*, hub:hub(nome, codice), medico:medici(nome, cognome)').order('creato_il', { ascending: false });
    st.profili = p || [];
}

// ---------------------------------------------------------------------
// Prenotazioni
// ---------------------------------------------------------------------
function prenotazioniFiltrate() {
    const q = st.cerca.trim().toLowerCase();
    return st.prenotazioni.filter((p) => {
        if (st.filtro === 'attive' && !ATTIVE.includes(p.stato)) return false;
        if (st.filtro === 'da_gestire' && p.stato !== 'pagata') return false;
        if (st.filtro === 'chiuse' && !['completata', 'annullata', 'rimborsata'].includes(p.stato)) return false;
        if (st.filtro === 'tutte' && ['in_attesa_pagamento', 'scaduta'].includes(p.stato) && st.io.ruolo !== 'admin') return false;
        if (!q) return true;
        return [p.codice, p.paziente_nome, p.paziente_cognome, p.paziente_codice_fiscale, p.medico?.cognome]
            .some((x) => String(x || '').toLowerCase().includes(q));
    });
}

function disegnaPrenotazioni() {
    const filtri = [['attive', 'Attive'], ['da_gestire', 'Da prendere in carico'], ['chiuse', 'Chiuse'], ['tutte', 'Tutte']];
    const daGestire = st.prenotazioni.filter((p) => p.stato === 'pagata').length;
    $('vista').innerHTML = `
        <div class="flex flex-col md:flex-row md:items-center gap-3 mb-4">
            <div class="flex gap-2 overflow-x-auto">${filtri.map(([id, t]) => `
                <button type="button" data-filtro="${id}" class="shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border transition ${st.filtro === id ? 'bg-slate-900 text-white border-transparent' : 'bg-white border-slate-200 text-slate-600'}">${t}${id === 'da_gestire' && daGestire ? ` (${daGestire})` : ''}</button>`).join('')}
            </div>
            <input id="cerca-prenotazioni" type="search" value="${esc(st.cerca)}" placeholder="Cerca per codice, paziente o codice fiscale" class="${classeCampo} md:max-w-sm md:ml-auto">
        </div>
        <div id="elenco-prenotazioni" class="space-y-2"></div>`;
    disegnaElencoPrenotazioni();
}

function disegnaElencoPrenotazioni() {
    const righe = prenotazioniFiltrate();
    $('elenco-prenotazioni').innerHTML = righe.length ? righe.map((p) => `
        <button type="button" data-apri="${p.id}" class="w-full text-left ${card} !p-4 hover:border-skybrand-300 transition flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
            <div class="sm:w-56 shrink-0">
                <div class="font-mono font-bold text-slate-900 text-sm">${esc(p.codice || 'in attesa di pagamento')}</div>
                <div class="text-xs text-slate-500">${dataOra(p.creata_il)} · ${p.canale === 'online' ? 'online' : esc(p.hub?.nome || 'hub')}</div>
            </div>
            <div class="flex-1 min-w-0">
                <div class="font-semibold text-slate-800 truncate">${esc(p.paziente_cognome)} ${esc(p.paziente_nome)}</div>
                <div class="text-xs text-slate-500 truncate">${esc(p.prestazione?.nome || '')} · Dott. ${esc(p.medico?.cognome || '')}${p.visita_il ? ` · visita ${dataOra(p.visita_il)}` : ''}</div>
            </div>
            <div class="shrink-0">${badgeStato(p.stato)}</div>
        </button>`).join('')
        : `<div class="${card} text-center text-sm text-slate-500 py-10">Nessuna prenotazione in questo elenco.</div>`;
}

function apriPannello(id) {
    const p = st.prenotazioni.find((x) => x.id === id);
    if (!p) return;
    st.pannelloId = id;
    const io = st.io;
    const comeMedico = io.ruolo === 'admin' || (io.medico_id && io.medico_id === p.medico_id);
    const comeHub = io.ruolo === 'admin' || (io.hub_id && io.hub_id === p.hub_id);
    const riga = (k, v) => v ? `<div><dt class="text-xs text-slate-500">${k}</dt><dd class="font-medium text-slate-900 break-words">${v}</dd></div>` : '';
    const chiusa = ['annullata', 'rimborsata', 'completata', 'in_attesa_pagamento', 'scaduta'].includes(p.stato);
    const valoreVisita = p.visita_il ? new Date(new Date(p.visita_il).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';

    $('pannello-corpo').innerHTML = `
        <div class="flex items-start justify-between gap-3">
            <div><div class="font-mono text-lg font-bold text-slate-900">${esc(p.codice || 'in attesa di pagamento')}</div>
            <div class="text-xs text-slate-500">Creata il ${dataOra(p.creata_il)}</div></div>
            ${badgeStato(p.stato)}
        </div>
        <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            ${riga('Paziente', `${esc(p.paziente_nome)} ${esc(p.paziente_cognome)}`)}
            ${riga('Codice fiscale', esc(p.paziente_codice_fiscale))}
            ${riga('Data di nascita', data(p.paziente_data_nascita))}
            ${riga('Telefono', `<a class="text-skybrand-600" href="tel:${esc(p.paziente_telefono)}">${esc(p.paziente_telefono)}</a>`)}
            ${riga('Email', `<a class="text-skybrand-600" href="mailto:${esc(p.paziente_email)}">${esc(p.paziente_email)}</a>`)}
            ${riga('Prestazione', esc(p.prestazione?.nome))}
            ${riga('Medico', `Dott. ${esc(p.medico?.nome)} ${esc(p.medico?.cognome)}`)}
            ${riga('Canale', p.canale === 'online' ? 'Online dal paziente' : `Hub: ${esc(p.hub?.nome)} (${esc(p.hub?.codice)})`)}
            ${riga('Quota', `${euro(p.quota_cents)} · incassata da ${p.incassata_da === 'hub' ? 'hub' : 'Click Dottore'}${p.metodo_pagamento ? ` (${esc(p.metodo_pagamento)})` : ''}`)}
            ${riga('Visita', p.visita_il ? dataOra(p.visita_il) : '')}
        </dl>
        ${p.note ? `<div class="rounded-xl bg-slate-50 border border-slate-200 p-3 text-sm"><div class="text-xs text-slate-500 mb-1">Note del paziente</div>${esc(p.note)}</div>` : ''}
        ${p.nota_medico ? `<div class="rounded-xl bg-slate-50 border border-slate-200 p-3 text-sm"><div class="text-xs text-slate-500 mb-1">Nota del medico</div>${esc(p.nota_medico)}</div>` : ''}
        <div id="msg-pannello" hidden></div>
        <div class="space-y-4 no-print">
            ${comeMedico && p.stato === 'pagata' ? `<button type="button" data-azione="prendi_in_carico" class="${btnPrimario} w-full">Prendi in carico</button>` : ''}
            ${comeMedico && ATTIVE.includes(p.stato) ? `
                <form data-form-visita class="rounded-xl border border-slate-200 p-4 space-y-3">
                    <div class="text-sm font-semibold text-slate-800">${p.visita_il ? 'Sposta la visita' : 'Fissa data e ora della visita'}</div>
                    <input type="datetime-local" name="visita_il" required value="${valoreVisita}" class="${classeCampo}">
                    <textarea name="nota" rows="2" maxlength="500" placeholder="Nota per il paziente (facoltativa)" class="${classeCampo}"></textarea>
                    <button type="submit" class="${btnPrimario} w-full">Conferma e avvisa il paziente</button>
                    <p class="text-xs text-slate-500">Il paziente riceve un'email con data, ora e indirizzo.</p>
                </form>` : ''}
            ${comeMedico && p.stato === 'visita_fissata' ? `<button type="button" data-azione="completa" class="${btnSecondario} w-full">Segna la visita come svolta</button>` : ''}
            ${(comeMedico || comeHub) && !chiusa ? `
                <div class="rounded-xl border border-red-200 p-4 space-y-3">
                    <div class="text-sm font-semibold text-red-700">Annulla la prenotazione</div>
                    <textarea data-motivo rows="2" maxlength="500" placeholder="Motivo (viene comunicato al paziente)" class="${classeCampo}"></textarea>
                    <button type="button" data-azione="annulla" class="${btnPericolo} w-full">${p.canale === 'online' ? 'Annulla e rimborsa la quota' : 'Annulla la prenotazione'}</button>
                </div>` : ''}
            ${comeHub && p.canale === 'hub' && p.stato === 'annullata' ? `<button type="button" data-azione="segna_rimborsata" class="${btnSecondario} w-full">Segna la quota come rimborsata al paziente</button>` : ''}
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

async function azionePrenotazione(azione, extra = {}, bottone) {
    const msg = $('msg-pannello');
    if (azione === 'annulla' && bottone?.dataset.confermato !== '1') {
        bottone.dataset.confermato = '1';
        bottone.textContent = 'Clicca di nuovo per confermare l\'annullamento';
        return;
    }
    if (bottone) bottone.disabled = true;
    try {
        await api('aggiorna-prenotazione', { conAccesso: true, dati: { id: st.pannelloId, azione, ...extra } });
        await caricaPrenotazioni();
        disegnaPrenotazioni();
        apriPannello(st.pannelloId);
        msg.hidden = false;
        messaggio(msg, 'Prenotazione aggiornata', 'ok');
    } catch (err) {
        msg.hidden = false;
        messaggio(msg, err.message);
        if (bottone) bottone.disabled = false;
    }
}

// ---------------------------------------------------------------------
// Nuova prenotazione (hub)
// ---------------------------------------------------------------------
function disegnaNuova() {
    const n = st.nuova;
    if (n.esito) return disegnaEsitoNuova();
    const isAdmin = st.io.ruolo === 'admin';
    const hubAttivi = st.hub.filter((h) => h.attivo);
    if (isAdmin && !n.hubId && hubAttivi.length) n.hubId = hubAttivi[0].id;
    const medici = st.medici.filter((m) => m.attivo && st.prestazioni.some((p) => p.medico_id === m.id && p.attivo));
    const medico = medici.find((m) => m.id === n.medicoId);
    const prest = medico ? st.prestazioni.filter((p) => p.medico_id === medico.id && p.attivo) : [];

    $('vista').innerHTML = `
        <form id="form-nuova" novalidate class="space-y-4 max-w-3xl">
            ${isAdmin ? `<div class="${card}"><label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Hub che registra la prenotazione</span>
                <select name="hub_id" class="${classeCampo}">${hubAttivi.map((h) => `<option value="${h.id}" ${h.id === n.hubId ? 'selected' : ''}>${esc(h.nome)} (${esc(h.codice)})</option>`).join('')}</select></label>
                ${hubAttivi.length ? '' : '<p class="text-sm text-red-700 mt-2">Prima crea almeno un hub nella scheda Hub.</p>'}</div>` : ''}
            <div class="${card} space-y-3">
                <h2 class="text-sm font-bold text-slate-500 uppercase tracking-wider">1 · Medico e prestazione</h2>
                ${medico ? `
                    <div class="flex items-center justify-between gap-3 rounded-xl bg-skybrand-50 border border-skybrand-200 p-3">
                        <div><div class="font-semibold text-slate-900">Dott. ${esc(medico.nome)} ${esc(medico.cognome)}</div><div class="text-xs text-slate-500">${esc(medico.specializzazione)} · ${esc(medico.citta)}</div></div>
                        <button type="button" data-cambia-medico class="text-sm text-skybrand-600 font-medium">Cambia</button>
                    </div>
                    <div class="space-y-2">${prest.map((p, i) => `
                        <label class="flex items-start gap-3 p-3 rounded-xl border border-slate-200 cursor-pointer"><input type="radio" name="prestazione_id" value="${p.id}" class="mt-1 w-4 h-4" ${prest.length === 1 || i === 0 ? 'checked' : ''}><span><span class="block font-medium text-slate-900">${esc(p.nome)}</span>${p.descrizione ? `<span class="block text-xs text-slate-500">${esc(p.descrizione)}</span>` : ''}</span></label>`).join('')}</div>`
                : `
                    <input type="search" id="cerca-medico" value="${esc(n.cercaMedico)}" placeholder="Cerca per cognome, specializzazione o città" class="${classeCampo}">
                    <div id="risultati-medici" class="space-y-2 max-h-80 overflow-y-auto"></div>`}
            </div>
            ${medico ? `
            <div class="${card}">
                <h2 class="text-sm font-bold text-slate-500 uppercase tracking-wider mb-3">2 · Dati del paziente</h2>
                ${htmlCampiPaziente()}
            </div>
            <div class="${card} space-y-3 text-sm text-slate-700">
                <h2 class="text-sm font-bold text-slate-500 uppercase tracking-wider">3 · Consensi e pagamento</h2>
                <label class="flex items-start gap-3"><input type="checkbox" name="consenso_privacy" class="mt-1 w-4 h-4 shrink-0"><span>Il paziente ha ricevuto l'informativa privacy e accetta i termini del servizio.</span></label>
                <label class="flex items-start gap-3"><input type="checkbox" name="consenso_dati_sanitari" class="mt-1 w-4 h-4 shrink-0"><span>Il paziente acconsente al trattamento dei suoi dati relativi alla salute per organizzare la visita.</span></label>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                    <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Come ha pagato la quota${st.quota ? ` di ${euro(st.quota)}` : ''}?</span>
                        <select name="metodo_pagamento" class="${classeCampo}"><option value="">Scegli...</option><option value="pos">POS / carta</option><option value="contanti">Contanti</option><option value="altro">Altro</option></select></label>
                </div>
                <label class="flex items-start gap-3"><input type="checkbox" name="pagato" class="mt-1 w-4 h-4 shrink-0"><span>Confermo che la quota è stata incassata dall'hub.</span></label>
            </div>
            <div id="msg-nuova" hidden></div>
            <button type="submit" id="btn-nuova" class="${btnPrimario} px-6 py-3">Registra la prenotazione</button>` : ''}
        </form>`;
    if (!medico) disegnaRisultatiMedici(medici);
}

function disegnaRisultatiMedici(medici) {
    const q = st.nuova.cercaMedico.trim().toLowerCase();
    const trovati = medici.filter((m) => !q || `${m.nome} ${m.cognome} ${m.specializzazione} ${m.citta}`.toLowerCase().includes(q)).slice(0, 50);
    const el = $('risultati-medici');
    if (!el) return;
    el.innerHTML = trovati.length ? trovati.map((m) => `
        <button type="button" data-scegli-medico="${m.id}" class="w-full text-left p-3 rounded-xl border border-slate-200 hover:border-skybrand-300 transition">
            <div class="font-semibold text-slate-900">Dott. ${esc(m.nome)} ${esc(m.cognome)}</div>
            <div class="text-xs text-slate-500">${esc(m.specializzazione)} · ${esc(m.citta)}</div>
        </button>`).join('')
        : `<p class="text-sm text-slate-500 py-3">Nessun medico trovato${st.medici.length ? '' : ': non ci sono ancora medici con prestazioni attive'}.</p>`;
}

async function inviaNuova(form) {
    const msg = $('msg-nuova');
    const { paziente, note } = leggiPaziente(form);
    const errori = erroriPaziente(paziente);
    const prestazione_id = [...form.querySelectorAll('input[name=prestazione_id]')].find((r) => r.checked)?.value;
    if (!prestazione_id) errori.unshift('Scegli la prestazione');
    if (!form.consenso_privacy.checked || !form.consenso_dati_sanitari.checked) errori.push('Servono entrambi i consensi del paziente');
    if (!form.metodo_pagamento.value) errori.push('Indica come è stata pagata la quota');
    if (!form.pagato.checked) errori.push('Conferma che la quota è stata incassata');
    msg.hidden = false;
    if (errori.length) return messaggio(msg, errori);
    msg.hidden = true;
    const btn = $('btn-nuova');
    btn.disabled = true; btn.textContent = 'Registrazione...';
    try {
        const r = await api('prenota-hub', {
            conAccesso: true,
            dati: {
                medico_id: st.nuova.medicoId, prestazione_id, paziente, note,
                consenso_privacy: true, consenso_dati_sanitari: true,
                metodo_pagamento: form.metodo_pagamento.value,
                hub_id: st.io.ruolo === 'admin' ? form.hub_id?.value : undefined,
            },
        });
        const medico = st.medici.find((m) => m.id === st.nuova.medicoId);
        st.nuova.esito = { codice: r.codice, paziente, medico, prestazione: st.prestazioni.find((p) => p.id === prestazione_id) };
        disegnaEsitoNuova();
    } catch (err) {
        msg.hidden = false;
        messaggio(msg, err.message);
        btn.disabled = false; btn.textContent = 'Registra la prenotazione';
    }
}

function disegnaEsitoNuova() {
    const e = st.nuova.esito;
    $('vista').innerHTML = `
        <div class="${card} max-w-2xl space-y-5">
            <div class="flex items-center gap-3">
                <div class="w-11 h-11 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center text-lg"><i class="fa-solid fa-check"></i></div>
                <div><h2 class="text-lg font-bold text-slate-900">Prenotazione registrata</h2><p class="text-sm text-slate-500">Il medico è stato avvisato e il paziente riceve la conferma via email.</p></div>
            </div>
            <div class="rounded-2xl bg-skybrand-50 border border-skybrand-200 p-5 text-center">
                <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Codice prenotazione</div>
                <div class="text-2xl sm:text-3xl font-bold tracking-wider text-slate-900 font-mono">${esc(e.codice)}</div>
            </div>
            <dl class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div><dt class="text-xs text-slate-500">Paziente</dt><dd class="font-medium text-slate-900">${esc(e.paziente.nome)} ${esc(e.paziente.cognome)}</dd></div>
                <div><dt class="text-xs text-slate-500">Medico</dt><dd class="font-medium text-slate-900">Dott. ${esc(e.medico?.nome)} ${esc(e.medico?.cognome)}</dd></div>
                <div><dt class="text-xs text-slate-500">Prestazione</dt><dd class="font-medium text-slate-900">${esc(e.prestazione?.nome)}</dd></div>
                <div><dt class="text-xs text-slate-500">Quota</dt><dd class="font-medium text-slate-900">${st.quota ? euro(st.quota) : ''}</dd></div>
            </dl>
            <div class="no-print flex flex-col sm:flex-row gap-3">
                <button type="button" onclick="window.print()" class="${btnSecondario}"><i class="fa-solid fa-print mr-1"></i> Stampa per il paziente</button>
                <button type="button" data-nuova-ancora class="${btnPrimario}">Nuova prenotazione</button>
            </div>
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
                ${campo('specializzazione', 'Specializzazione', 'text', 'required placeholder="Es. Cardiologia"')}
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
                            <div><div class="font-semibold text-slate-900">Dott. ${esc(m.nome)} ${esc(m.cognome)}</div>
                            <div class="text-xs text-slate-500">${esc(m.specializzazione)} · ${esc(m.citta)} · ${esc(m.email)}</div></div>
                            ${interruttore('medici', m.id, m.attivo)}
                        </div>
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
                <button type="submit" class="${btnPrimario} w-full">Aggiungi l'hub</button>
            </form>
            <div class="lg:col-span-3 space-y-3">
                ${st.hub.length ? st.hub.map((h) => `
                    <div class="${card} flex items-start justify-between gap-3">
                        <div><div class="font-semibold text-slate-900">${esc(h.nome)} <span class="font-mono text-xs text-slate-500">${esc(h.codice)}</span></div>
                        <div class="text-xs text-slate-500">${h.tipo === 'medico' ? 'Medico che fa da hub' : 'Struttura privata'}${h.citta ? ' · ' + esc(h.citta) : ''}${h.email ? ' · ' + esc(h.email) : ''}</div></div>
                        ${interruttore('hub', h.id, h.attivo)}
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
                    <select name="ruolo" class="${classeCampo}"><option value="operatore">Operatore di un hub</option><option value="medico">Medico</option><option value="admin">Amministratore</option></select></label>
                <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Hub (obbligatorio per l'operatore; per il medico solo se fa da hub)</span>
                    <select name="hub_id" class="${classeCampo}"><option value="">Nessuno</option>${st.hub.map((h) => `<option value="${h.id}">${esc(h.nome)} (${esc(h.codice)})</option>`).join('')}</select></label>
                <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Medico collegato (per il ruolo medico)</span>
                    <select name="medico_id" class="${classeCampo}"><option value="">Nessuno</option>${st.medici.map((m) => `<option value="${m.id}">Dott. ${esc(m.cognome)} ${esc(m.nome)} · ${esc(m.specializzazione)}</option>`).join('')}</select></label>
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

function disegnaImpostazioni() {
    $('vista').innerHTML = `
        <form data-admin="imposta_quota" class="${card} space-y-3 max-w-md">
            <h2 class="font-bold text-slate-900">Quota di prenotazione</h2>
            <p class="text-sm text-slate-500">Importo pagato dal paziente per ogni prenotazione, sia online sia tramite hub.</p>
            <label class="block"><span class="block text-xs font-semibold text-slate-600 mb-1">Importo in euro</span>
                <input name="quota_euro" type="number" min="0.5" max="100" step="0.01" value="${st.quota ? (st.quota / 100).toFixed(2) : ''}" required class="${classeCampo}"></label>
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
    if (azione === 'imposta_quota') dati = { azione, quota_cents: Math.round(Number(String(f.quota_euro).replace(',', '.')) * 100) };
    if (azione === 'invita_utente') { dati.hub_id = f.hub_id || null; dati.medico_id = f.medico_id || null; }
    btn.disabled = true;
    try {
        await api('admin', { conAccesso: true, dati });
        const testi = { crea_medico: 'Medico aggiunto', crea_prestazione: 'Prestazione aggiunta', crea_hub: 'Hub aggiunto', invita_utente: 'Utenza creata: l\'invito è stato inviato via email', imposta_quota: 'Quota aggiornata' };
        if (azione === 'imposta_quota') st.quota = dati.quota_cents;
        await vai(st.scheda);
        avviso(testi[azione] || 'Fatto', 'ok');
    } catch (err) {
        avviso(err.message);
        btn.disabled = false;
    }
}

// ---------------------------------------------------------------------
// Eventi
// ---------------------------------------------------------------------
document.addEventListener('click', async (e) => {
    const t = e.target.closest('button, [data-chiudi]');
    if (!t) return;
    if (t.hasAttribute('data-esci')) { await supabase.auth.signOut(); return location.replace('accedi.html'); }
    if (t.dataset.scheda) return vai(t.dataset.scheda);
    if (t.dataset.filtro) { st.filtro = t.dataset.filtro; return disegnaPrenotazioni(); }
    if (t.dataset.apri) return apriPannello(t.dataset.apri);
    if (t.hasAttribute('data-chiudi')) return chiudiPannello();
    if (t.dataset.azione) {
        const motivo = $('pannello-corpo').querySelector('[data-motivo]')?.value;
        return azionePrenotazione(t.dataset.azione, t.dataset.azione === 'annulla' ? { nota: motivo } : {}, t);
    }
    if (t.dataset.scegliMedico) { st.nuova.medicoId = t.dataset.scegliMedico; return disegnaNuova(); }
    if (t.hasAttribute('data-cambia-medico')) { st.nuova.medicoId = null; return disegnaNuova(); }
    if (t.hasAttribute('data-nuova-ancora')) { st.nuova = { medicoId: null, cercaMedico: '', hubId: st.nuova.hubId, esito: null }; return disegnaNuova(); }
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
    if (form.hasAttribute('data-form-visita')) {
        e.preventDefault();
        const valore = form.visita_il.value;
        if (!valore) return;
        return azionePrenotazione('fissa_visita', { visita_il: new Date(valore).toISOString(), nota: form.nota.value }, form.querySelector('button[type=submit]'));
    }
    if (form.dataset.admin) { e.preventDefault(); return inviaAdmin(form); }
});

document.addEventListener('input', (e) => {
    if (e.target.id === 'cerca-prenotazioni') { st.cerca = e.target.value; disegnaElencoPrenotazioni(); }
    if (e.target.id === 'cerca-medico') {
        st.nuova.cercaMedico = e.target.value;
        disegnaRisultatiMedici(st.medici.filter((m) => m.attivo && st.prestazioni.some((p) => p.medico_id === m.id && p.attivo)));
    }
});
document.addEventListener('change', (e) => {
    if (e.target.name === 'hub_id' && e.target.closest('#form-nuova')) st.nuova.hubId = e.target.value;
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('pannello').hidden) chiudiPannello(); });

supabase.auth.onAuthStateChange((evento) => { if (evento === 'SIGNED_OUT') location.replace('accedi.html'); });

avvia().catch((err) => {
    $('caricamento').hidden = true;
    $('app').hidden = false;
    avviso(err.message || 'Errore di caricamento');
});
