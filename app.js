// Click Dottore - funzioni comuni alle pagine di prenotazione e all'area riservata
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

export const SUPABASE_URL = 'https://awxrrjwzlqghkmsqgkpw.supabase.co';
// Chiave pubblica (publishable): pensata per stare nel browser, i dati sono protetti dalle regole del database
export const SUPABASE_KEY = 'sb_publishable_r2K5TaXfKd8Bjj7iQek_Aw_WgIlHDQy';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
});

// Chiamata alla funzione server "api"
export async function api(percorso, { metodo = 'POST', dati, conAccesso = false, query } = {}) {
    const headers = { apikey: SUPABASE_KEY };
    if (dati !== undefined) headers['Content-Type'] = 'application/json';
    if (conAccesso) {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) throw new Error('Sessione scaduta: accedi di nuovo');
        headers.Authorization = `Bearer ${token}`;
    }
    const url = `${SUPABASE_URL}/functions/v1/api/${percorso}${query ? `?${new URLSearchParams(query)}` : ''}`;
    let risposta;
    try {
        risposta = await fetch(url, { method: metodo, headers, body: dati !== undefined ? JSON.stringify(dati) : undefined });
    } catch (_) {
        throw new Error('Connessione non riuscita, controlla la rete e riprova');
    }
    const corpo = await risposta.json().catch(() => ({}));
    if (!risposta.ok) throw new Error(corpo.errore || 'Errore imprevisto, riprova');
    return corpo;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const euro = (cents) => (Number(cents || 0) / 100).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
export const dataOra = (iso) => iso ? new Date(iso).toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
export const data = (iso) => iso ? new Date(iso + (iso.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';

export async function quotaCents() {
    const { data: riga } = await supabase.from('impostazioni').select('valore').eq('chiave', 'quota_cents').maybeSingle();
    return riga ? parseInt(riga.valore, 10) : null;
}

export const STATI = {
    richiesta: ['Da confermare', 'bg-amber-50 text-amber-700'],
    da_pagare: ['Confermata, quota da pagare', 'bg-skybrand-50 text-skybrand-700'],
    confermata: ['Confermata', 'bg-emerald-50 text-emerald-700'],
    completata: ['Svolta', 'bg-slate-100 text-slate-600'],
    rifiutata: ['Rifiutata', 'bg-red-50 text-red-700'],
    annullata: ['Annullata', 'bg-red-50 text-red-700'],
    rimborsata: ['Annullata e rimborsata', 'bg-red-50 text-red-700'],
    scaduta: ['Scaduta', 'bg-slate-100 text-slate-500'],
};
export function badgeStato(stato) {
    const [testo, classi] = STATI[stato] || [stato, 'bg-slate-100 text-slate-600'];
    return `<span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${classi}">${esc(testo)}</span>`;
}

// ---------------------------------------------------------------------
// Modulo dati del paziente (usato da prenotazione online e prenotazione hub)
// ---------------------------------------------------------------------
const classeCampo = 'w-full bg-white border border-slate-300 rounded-xl px-3.5 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-skybrand-200 focus:border-skybrand-400';
export { classeCampo };

export function htmlCampiPaziente(valori = {}) {
    const v = (k) => esc(valori[k] ?? '');
    const campo = (nome, etichetta, tipo, extra = '') => `
        <label class="block">
            <span class="block text-xs font-semibold text-slate-600 mb-1">${etichetta}</span>
            <input name="${nome}" type="${tipo}" value="${v(nome)}" required class="${classeCampo}" ${extra}>
        </label>`;
    return `
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            ${campo('nome', 'Nome', 'text', 'autocomplete="given-name" maxlength="60"')}
            ${campo('cognome', 'Cognome', 'text', 'autocomplete="family-name" maxlength="60"')}
            ${campo('codice_fiscale', 'Codice fiscale', 'text', 'maxlength="16" autocapitalize="characters" style="text-transform:uppercase"')}
            ${campo('data_nascita', 'Data di nascita', 'date', `max="${new Date().toISOString().slice(0, 10)}"`)}
            ${campo('telefono', 'Telefono', 'tel', 'autocomplete="tel" maxlength="20"')}
            ${campo('email', 'Email', 'email', 'autocomplete="email" maxlength="120"')}
        </div>
        <label class="block mt-4">
            <span class="block text-xs font-semibold text-slate-600 mb-1">Note per il medico <span class="font-normal text-slate-400">(facoltative)</span></span>
            <textarea name="note" rows="3" maxlength="500" class="${classeCampo}" placeholder="Es. disponibilità preferita, motivo della visita in breve">${v('note')}</textarea>
        </label>`;
}

export function leggiPaziente(form) {
    const f = new FormData(form);
    const g = (k) => String(f.get(k) ?? '').trim();
    return {
        paziente: {
            nome: g('nome'), cognome: g('cognome'),
            codice_fiscale: g('codice_fiscale').toUpperCase().replace(/\s/g, ''),
            data_nascita: g('data_nascita'), telefono: g('telefono'), email: g('email').toLowerCase(),
        },
        note: g('note'),
    };
}

export function erroriPaziente(p) {
    const errori = [];
    if (!p.nome) errori.push('Inserisci il nome');
    if (!p.cognome) errori.push('Inserisci il cognome');
    if (!/^[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/.test(p.codice_fiscale)) errori.push('Il codice fiscale non è valido');
    if (!p.data_nascita) errori.push('Inserisci la data di nascita');
    if (!/^\+?[0-9]{6,15}$/.test(p.telefono.replace(/[\s.-]/g, ''))) errori.push('Il numero di telefono non è valido');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(p.email)) errori.push("L'email non è valida");
    return errori;
}

export function messaggio(el, testo, tipo = 'errore') {
    if (!el) return;
    if (!testo) { el.innerHTML = ''; el.classList.add('hidden'); return; }
    const classi = tipo === 'ok'
        ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
        : tipo === 'info' ? 'bg-skybrand-50 border-skybrand-200 text-skybrand-700' : 'bg-red-50 border-red-200 text-red-700';
    el.className = `rounded-xl border px-4 py-3 text-sm ${classi}`;
    el.innerHTML = Array.isArray(testo) ? `<ul class="list-disc pl-5 space-y-0.5">${testo.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : esc(testo);
}

// ---------------------------------------------------------------------
// Orari della visita (sempre nel fuso orario italiano)
// ---------------------------------------------------------------------
const FMT_GIORNO = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', day: 'numeric', month: 'short' });
const FMT_ORA = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
const FMT_CHIAVE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' });
const FMT_LUNGO = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

// es. "mercoledì 25 novembre 2026 alle ore 09:30"
export const quando = (iso) => iso ? FMT_LUNGO.format(new Date(iso)) : '';

export async function slotLiberi(prestazioneId, giorni = 28) {
    const { data: righe, error } = await supabase.rpc('slot_liberi', {
        p_prestazione: prestazioneId, p_dal: FMT_CHIAVE.format(new Date()), p_giorni: giorni,
    });
    if (error) throw new Error('Impossibile caricare gli orari disponibili');
    return righe || [];
}

// Scelta di giorno e ora tra gli slot liberi; chiama onScegli(iso) quando si sceglie un orario
export function selettoreSlot(el, slots, onScegli, iniziale = null) {
    const perGiorno = new Map();
    for (const s of slots) {
        const k = FMT_CHIAVE.format(new Date(s.inizio));
        if (!perGiorno.has(k)) perGiorno.set(k, []);
        perGiorno.get(k).push(s);
    }
    const giorni = [...perGiorno.keys()];
    let scelto = iniziale && slots.some((s) => new Date(s.inizio).getTime() === new Date(iniziale).getTime()) ? new Date(iniziale).toISOString() : null;
    let giorno = scelto ? FMT_CHIAVE.format(new Date(scelto)) : giorni[0];
    const disegna = () => {
        if (!giorni.length) {
            el.innerHTML = '<p class="text-sm text-slate-500">Nessun orario disponibile nelle prossime settimane per questa prestazione.</p>';
            return;
        }
        const chip = (k) => {
            const sel = k === giorno;
            return `<button type="button" data-giorno="${k}" class="shrink-0 w-20 px-2 py-2 rounded-xl border text-xs text-center transition ${sel ? 'bg-skybrand-500 text-white border-transparent' : 'bg-white border-slate-200 text-slate-700 hover:border-skybrand-300'}">
                <span class="block font-semibold capitalize">${esc(FMT_GIORNO.format(new Date(perGiorno.get(k)[0].inizio)))}</span>
                <span class="block ${sel ? 'text-white/80' : 'text-slate-500'}">${perGiorno.get(k).length} liberi</span></button>`;
        };
        const ora = (s) => {
            const iso = new Date(s.inizio).toISOString();
            const sel = iso === scelto;
            return `<button type="button" data-ora="${iso}" class="px-2 py-2.5 rounded-xl border text-sm font-semibold transition ${sel ? 'bg-skybrand-500 text-white border-transparent' : 'bg-white border-slate-200 text-slate-800 hover:border-skybrand-300'}">${FMT_ORA.format(new Date(s.inizio))}</button>`;
        };
        el.innerHTML = `
            <div class="flex gap-2 overflow-x-auto pb-2">${giorni.map(chip).join('')}</div>
            <div class="grid grid-cols-3 sm:grid-cols-6 gap-2 mt-3">${perGiorno.get(giorno).map(ora).join('')}</div>`;
    };
    el.onclick = (e) => {
        const b = e.target.closest('button');
        if (!b || !el.contains(b)) return;
        if (b.dataset.giorno) { giorno = b.dataset.giorno; disegna(); }
        if (b.dataset.ora) { scelto = b.dataset.ora; disegna(); onScegli(scelto); }
    };
    disegna();
}

export const durata = (min) => min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}` : `${min} min`;
