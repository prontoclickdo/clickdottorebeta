/*
 * Click Dottore - Tema chiaro / scuro
 *
 * Il tema segue SOLO le impostazioni del dispositivo di chi visita il sito
 * (prefers-color-scheme: macOS, Windows, iOS, Android, ecc.):
 * - modalità scura attiva sul dispositivo  -> sito scuro
 * - modalità scura non attiva              -> sito chiaro
 * Se l'utente cambia l'impostazione mentre è sul sito, il tema si aggiorna da solo.
 * Non c'è nessun pulsante per cambiarlo a mano.
 *
 * Va caricato nell'<head>, senza defer, per evitare il lampo di sfondo chiaro.
 */
(function () {
    'use strict';

    var root = document.documentElement;
    var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

    // Rimuove la scelta manuale salvata dalla versione precedente del sito (pulsante luna/sole)
    try { localStorage.removeItem('pcd-theme'); } catch (e) { /* storage non disponibile */ }

    function current() { return mq && mq.matches ? 'dark' : 'light'; }

    function apply() {
        var theme = current();
        root.classList.toggle('dark', theme === 'dark');
        root.style.colorScheme = theme;
        var meta = document.querySelector('meta[name="theme-color"]');
        if (!meta) {
            meta = document.createElement('meta');
            meta.name = 'theme-color';
            document.head.appendChild(meta);
        }
        meta.content = theme === 'dark' ? '#0b1220' : '#ffffff';
    }

    function applyWithoutTransitions() {
        // disattiva le transizioni, applica il tema, forza il ricalcolo e le riattiva al frame successivo
        root.classList.add('theme-switching');
        apply();
        void root.offsetHeight;
        requestAnimationFrame(function () {
            requestAnimationFrame(function () { root.classList.remove('theme-switching'); });
        });
    }

    apply();

    if (mq) {
        if (mq.addEventListener) mq.addEventListener('change', applyWithoutTransitions);
        else if (mq.addListener) mq.addListener(applyWithoutTransitions);
    }

    window.PCDTheme = { get: current };
})();
