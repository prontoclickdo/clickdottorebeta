// Click Dottore - configurazione di Tailwind CSS v3 (la stessa che prima era scritta in ogni pagina per il Play CDN).
// Per ricompilare vendor/tailwind/tailwind.css dopo aver aggiunto classi:  npm install && npm run build:css
/** @type {import('tailwindcss').Config} */
module.exports = {
    // tutte le pagine e tutti gli script: molte classi sono scritte nel JavaScript
    content: ['./*.html', './*.js', '!./tailwind.config.js'],
    theme: {
        extend: {
            fontFamily: {
                sans: ['Inter', 'sans-serif'],
            },
            colors: {
                skybrand: {
                    50: '#eff5fc',
                    100: '#dce8f8',
                    200: '#b9d1f0',
                    300: '#8db3e5',
                    400: '#5a8fd6',
                    500: '#2a71c8',
                    600: '#31579c',
                    700: '#284780',
                    800: '#213a66',
                    900: '#0f172a',
                },
            },
        },
    },
};
