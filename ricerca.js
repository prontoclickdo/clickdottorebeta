// Click Dottore - ricerca dei medici prenotabili online (pagina principale)
import { supabase, esc, euro } from './app.js';

function pulisci(valore) {
    // caratteri che hanno un significato speciale nei filtri diventano "qualsiasi testo"
    return String(valore || '').replace(/[%,()"\\*]/g, '%').replace(/\s+/g, ' ').trim();
}

// testo confrontabile: minuscolo, senza accenti e spazi doppi
function norm(v) {
    return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
}
const PAROLE_VUOTE = new Set(['e', 'ed', 'di', 'del', 'della', 'dei', 'delle', 'la', 'il', 'lo', 'le', 'dott', 'dottor', 'dottore', 'dottoressa', 'dr', 'dssa', 'ssa', 'prof', 'professor', 'professore', 'professoressa']);
function paroleSignificative(testo) {
    return norm(testo).replace(/%/g, ' ').split(' ').filter((w) => w.length >= 2 && !PAROLE_VUOTE.has(w)).slice(0, 6);
}
// Un medico corrisponde se:
// - tutte le parole cercate compaiono nel nome e cognome ("Laura Bianchi", "Bianchi", "dott. Rossi"), oppure
// - la specializzazione cercata contiene quella del medico o viceversa
//   ("Dermatologia e Venereologia" trova "Dermatologia"; "derma" trova "Dermatologia")
function corrisponde(m, cercato) {
    const q = norm(cercato).replace(/%/g, ' ').trim();
    const parole = paroleSignificative(cercato);
    if (!q || !parole.length) return true;
    const nomeCompleto = norm(`${m.nome} ${m.cognome}`);
    if (parole.every((w) => nomeCompleto.includes(w))) return true;
    const spec = norm(m.specializzazione);
    return !!spec && (spec.includes(q) || q.includes(spec));
}

async function cercaMedici(specialita, luogo) {
    const el = document.getElementById('elenco-medici');
    if (!el) return;
    el.innerHTML = `<div class="col-span-full text-center text-sm text-slate-500 py-10"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Ricerca dei medici...</div>`;

    let q = supabase.from('medici_pubblici').select('*').order('cognome').limit(300);
    const s = pulisci(specialita);
    // candidati: medici in cui compare almeno una delle parole cercate (nome, cognome o specializzazione)
    const parole = paroleSignificative(s);
    if (parole.length) q = q.or(parole.flatMap((w) => [`specializzazione.ilike."%${w}%"`, `cognome.ilike."%${w}%"`, `nome.ilike."%${w}%"`]).join(','));
    const citta = pulisci(String(luogo || '').replace(/\([^)]*\)/g, ' ').replace(/\b\d{5}\b/g, ' '));
    if (citta) q = q.ilike('citta', `%${citta}%`);

    const { data: trovati, error } = await q;
    let medici = s ? (trovati || []).filter((m) => corrisponde(m, s)) : (trovati || []);

    // medici che eseguono la prestazione cercata (es. "Ecocardiogramma", "Holter cardiaco 24 ore")
    let prestCercata = null;
    // la parte tra parentesi è un dettaglio: "Elettrocardiogramma (ECG)" trova anche "Elettrocardiogramma"
    const sPrest = pulisci(String(specialita || '').replace(/\([^)]*\)/g, ' '));
    if (sPrest && !error) {
        const { data: perPrestazione } = await supabase.from('prestazioni_pubbliche').select('medico_id, nome')
            .ilike('nome', `%${sPrest}%`).limit(1000);
        if (perPrestazione?.length) {
            prestCercata = norm(sPrest);
            const gia = new Set(medici.map((m) => m.id));
            const altri = [...new Set(perPrestazione.map((p) => p.medico_id))].filter((id) => !gia.has(id));
            if (altri.length) {
                let q2 = supabase.from('medici_pubblici').select('*').in('id', altri);
                if (citta) q2 = q2.ilike('citta', `%${citta}%`);
                const { data: extra } = await q2;
                medici = medici.concat(extra || []);
            }
        }
    }
    // in ordine alfabetico per cognome e nome
    medici.sort((a, b) => `${a.cognome} ${a.nome}`.localeCompare(`${b.cognome} ${b.nome}`, 'it', { sensitivity: 'base' }));
    if (error) {
        el.innerHTML = `<div class="col-span-full bg-white border border-slate-200 rounded-2xl p-10 text-center text-sm text-slate-500">Ricerca non riuscita, riprova tra poco.</div>`;
        return;
    }
    const ids = (medici || []).map((m) => m.id);
    const { data: prestazioni } = ids.length
        ? await supabase.from('prestazioni_pubbliche').select('medico_id, nome, prezzo_visita_cents').in('medico_id', ids).order('nome')
        : { data: [] };
    const conPrestazioni = (medici || []).filter((m) => (prestazioni || []).some((p) => p.medico_id === m.id));

    const titolo = document.getElementById('results-title');
    if (titolo) titolo.textContent = conPrestazioni.length ? `${conPrestazioni.length} ${conPrestazioni.length === 1 ? 'medico disponibile' : 'medici disponibili'}` : 'Risultati di ricerca';

    if (!conPrestazioni.length) {
        el.innerHTML = `
            <div class="col-span-full bg-white border border-slate-200 rounded-2xl p-10 text-center max-w-2xl mx-auto">
                <div class="w-14 h-14 bg-skybrand-50 text-skybrand-500 rounded-full flex items-center justify-center mx-auto mb-4 text-xl"><i class="fa-solid fa-user-doctor"></i></div>
                <h3 class="text-lg font-bold text-slate-900 mb-2">Nessun medico prenotabile online per questa ricerca</h3>
                <p class="text-slate-500 text-sm leading-relaxed">Prova con un'altra specializzazione o un'altra città. Il servizio è in avvio e nuovi medici si aggiungono di continuo.</p>
            </div>`;
        return;
    }

    el.innerHTML = conPrestazioni.map((m) => {
        // prima la prestazione cercata, poi le visite, poi le altre in ordine di prezzo
        const cercata = (p) => !!prestCercata && norm(p.nome).includes(prestCercata);
        const pr = (prestazioni || []).filter((p) => p.medico_id === m.id)
            .sort((a, b) => (cercata(b) - cercata(a)) || (/visita/i.test(b.nome) - /visita/i.test(a.nome)) || ((a.prezzo_visita_cents ?? 1e9) - (b.prezzo_visita_cents ?? 1e9)));
        const prezzi = pr.map((p) => p.prezzo_visita_cents).filter((c) => c != null);
        const minimo = prezzi.length ? Math.min(...prezzi) : null;
        return `
            <article class="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col gap-4 hover:border-skybrand-300 transition">
                <div class="flex items-start gap-3">
                    <div class="w-12 h-12 rounded-xl bg-skybrand-50 text-skybrand-500 flex items-center justify-center text-xl shrink-0"><i class="fa-solid fa-user-doctor"></i></div>
                    <div class="min-w-0">
                        <h3 class="font-bold text-slate-900">Dott. ${esc(m.nome)} ${esc(m.cognome)}</h3>
                        <p class="text-sm text-slate-500">${esc(m.specializzazione)}</p>
                        <p class="text-xs text-slate-500 mt-0.5"><i class="fa-solid fa-location-dot text-skybrand-500 mr-1"></i>${esc(m.citta)}</p>
                    </div>
                </div>
                <ul class="text-xs text-slate-600 space-y-1.5">${pr.slice(0, 4).map((p) => `
                    <li class="flex items-baseline justify-between gap-3"><span class="min-w-0 ${cercata(p) ? 'font-semibold text-skybrand-700' : ''}"><i class="fa-solid fa-check text-skybrand-500 mr-1.5"></i>${esc(p.nome)}</span>${p.prezzo_visita_cents != null ? `<span class="shrink-0 font-semibold text-slate-900">${euro(p.prezzo_visita_cents)}</span>` : ''}</li>`).join('')}
                    ${pr.length > 4 ? `<li class="text-slate-400">e altre ${pr.length - 4} prestazioni</li>` : ''}</ul>
                ${minimo != null ? `<p class="text-xs text-slate-500">Prestazioni a partire da <strong class="text-slate-900">${euro(minimo)}</strong></p>` : ''}
                <a href="prenota.html?medico=${encodeURIComponent(m.id)}" class="mt-auto text-center px-4 py-2.5 bg-skybrand-500 hover:bg-skybrand-600 text-white text-sm font-semibold rounded-xl transition">Prenota online</a>
            </article>`;
    }).join('');
}

window.cercaMedici = cercaMedici;
