// Click Dottore - ricerca dei medici prenotabili online (pagina principale)
import { supabase, esc } from './app.js';

function pulisci(valore) {
    // caratteri che hanno un significato speciale nei filtri diventano "qualsiasi testo"
    return String(valore || '').replace(/[%,()"\\*]/g, '%').replace(/\s+/g, ' ').trim();
}

async function cercaMedici(specialita, luogo) {
    const el = document.getElementById('elenco-medici');
    if (!el) return;
    el.innerHTML = `<div class="col-span-full text-center text-sm text-slate-500 py-10"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Ricerca dei medici...</div>`;

    let q = supabase.from('medici_pubblici').select('*').order('cognome').limit(100);
    const s = pulisci(specialita);
    if (s) q = q.or(`specializzazione.ilike."%${s}%",cognome.ilike."%${s}%",nome.ilike."%${s}%"`);
    const citta = pulisci(String(luogo || '').replace(/\([^)]*\)/g, ' ').replace(/\b\d{5}\b/g, ' '));
    if (citta) q = q.ilike('citta', `%${citta}%`);

    const { data: medici, error } = await q;
    if (error) {
        el.innerHTML = `<div class="col-span-full bg-white border border-slate-200 rounded-2xl p-10 text-center text-sm text-slate-500">Ricerca non riuscita, riprova tra poco.</div>`;
        return;
    }
    const ids = (medici || []).map((m) => m.id);
    const { data: prestazioni } = ids.length
        ? await supabase.from('prestazioni_pubbliche').select('medico_id, nome').in('medico_id', ids).order('nome')
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
        const pr = (prestazioni || []).filter((p) => p.medico_id === m.id);
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
                <ul class="text-xs text-slate-600 space-y-1">${pr.slice(0, 3).map((p) => `<li><i class="fa-solid fa-check text-skybrand-500 mr-1.5"></i>${esc(p.nome)}</li>`).join('')}${pr.length > 3 ? `<li class="text-slate-400">e altre ${pr.length - 3}</li>` : ''}</ul>
                <a href="prenota.html?medico=${encodeURIComponent(m.id)}" class="mt-auto text-center px-4 py-2.5 bg-skybrand-500 hover:bg-skybrand-600 text-white text-sm font-semibold rounded-xl transition">Prenota online</a>
            </article>`;
    }).join('');
}

window.cercaMedici = cercaMedici;
