// =====================================================================
// Click Dottore - funzione server "api" (Supabase Edge Function)
//
// Percorsi:
//   POST /api/richiesta-online        il paziente registrato chiede uno slot libero al medico
//   POST /api/paga                    il paziente paga la quota dopo la conferma del medico (Stripe)
//   POST /api/annulla-richiesta       il paziente ritira una richiesta non ancora pagata
//   GET  /api/info-bollettino         dati del bollettino dell'hub (pagina paga.html)
//   POST /api/paga-bollettino         pagamento online del bollettino dell'hub
//   GET  /api/stato-prenotazione      esito del pagamento (pagina di conferma)
//   POST /api/stripe-webhook          notifiche di Stripe
//   POST /api/prenota-hub             richiesta o prenotazione confermata da un hub
//   POST /api/aggiorna-prenotazione   conferma, rifiuto, annullamento, incasso, bollettino...
//   POST /api/medico                  orari, chiusure, prestazioni e tariffe del medico
//   POST /api/admin                   hub, medici, utenze, impostazioni, conti con gli hub
//   POST /api/recupero-password       link per reimpostare la password
//   POST /api/registrati              registrazione del paziente (email di conferma)
//   POST /api/aggiorna-profilo        il paziente aggiorna i propri dati
//   POST /api/promemoria              promemoria al paziente il giorno prima della visita (chiamato ogni ora da pg_cron)
//
// Segreti richiesti (Edge Functions > Secrets):
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY
// Facoltativi: EMAIL_FROM, EMAIL_REPLY_TO, SITE_URL
// =====================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const SITE = (Deno.env.get("SITE_URL") ?? "https://clickdottore.it").replace(/\/$/, "");
const ALLOWED_ORIGINS = [SITE, SITE.replace("https://", "https://www.")];
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "Click Dottore <prenotazioni@clickdottore.it>";
const EMAIL_REPLY_TO = Deno.env.get("EMAIL_REPLY_TO") ?? "";

function secretKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    if (keys && typeof keys.default === "string") return keys.default;
  } catch (_) { /* uso la chiave legacy */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

const db = createClient(Deno.env.get("SUPABASE_URL")!, secretKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------
// Utilità generali
// ---------------------------------------------------------------------
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : SITE,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json; charset=utf-8" },
  });
}

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function euro(cents: number): string {
  return (cents / 100).toLocaleString("it-IT", { style: "currency", currency: "EUR" });
}

function dataOra(iso: string): string {
  return new Date(iso).toLocaleString("it-IT", {
    timeZone: "Europe/Rome", weekday: "long", day: "numeric", month: "long",
    year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function testo(v: unknown, campo: string, max = 120, obbligatorio = true): string {
  const s = String(v ?? "").trim();
  if (obbligatorio && !s) throw new HttpError(400, `Campo mancante: ${campo}`);
  if (s.length > max) throw new HttpError(400, `Campo troppo lungo: ${campo}`);
  return s;
}

function uuid(v: unknown, campo: string): string {
  const s = String(v ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(s)) throw new HttpError(400, `Valore non valido: ${campo}`);
  return s;
}

type Paziente = {
  nome: string; cognome: string; codice_fiscale: string; data_nascita: string;
  telefono: string; email: string;
};

function validaPaziente(p: Record<string, unknown> | undefined): Paziente {
  if (!p || typeof p !== "object") throw new HttpError(400, "Dati del paziente mancanti");
  const nome = testo(p.nome, "nome", 60);
  const cognome = testo(p.cognome, "cognome", 60);
  const cf = testo(p.codice_fiscale, "codice fiscale", 16).toUpperCase().replace(/\s/g, "");
  if (!/^[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/.test(cf)) {
    throw new HttpError(400, "Codice fiscale non valido");
  }
  const nascita = testo(p.data_nascita, "data di nascita", 10);
  const d = new Date(nascita + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nascita) || isNaN(d.getTime()) || d > new Date() || d.getUTCFullYear() < 1900) {
    throw new HttpError(400, "Data di nascita non valida");
  }
  const telefono = testo(p.telefono, "telefono", 20).replace(/[\s.-]/g, "");
  if (!/^\+?[0-9]{6,15}$/.test(telefono)) throw new HttpError(400, "Numero di telefono non valido");
  const email = testo(p.email, "email", 120).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, "Email non valida");
  return { nome, cognome, codice_fiscale: cf, data_nascita: nascita, telefono, email };
}

async function quotaCents(): Promise<number> {
  const { data, error } = await db.from("impostazioni").select("valore").eq("chiave", "quota_cents").single();
  if (error || !data) throw new HttpError(500, "Quota non configurata");
  const n = parseInt(data.valore, 10);
  if (!Number.isFinite(n) || n < 50) throw new HttpError(500, "Quota non valida");
  return n;
}

async function registra(utente: string | null, azione: string, prenotazione_id: string | null, dettagli: unknown = null) {
  await db.from("registro").insert({ utente, azione, prenotazione_id, dettagli });
}

// ---------------------------------------------------------------------
// Utente autenticato (personale)
// ---------------------------------------------------------------------
type Profilo = {
  id: string; ruolo: "admin" | "operatore" | "medico"; nome: string; email: string;
  hub_id: string | null; medico_id: string | null; attivo: boolean;
};

async function utente(req: Request): Promise<Profilo> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Accesso richiesto");
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, "Sessione non valida, accedi di nuovo");
  const { data: profilo } = await db.from("profili").select("*").eq("id", data.user.id).maybeSingle();
  if (!profilo || !profilo.attivo) throw new HttpError(403, "Utenza non abilitata");
  return profilo as Profilo;
}

// Paziente registrato: restituisce l'id se il token appartiene a un account paziente, altrimenti null
async function pazienteDaToken(req: Request): Promise<string | null> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token || token.startsWith("sb_")) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: paz } = await db.from("pazienti").select("id").eq("id", data.user.id).maybeSingle();
  return paz?.id ?? null;
}

// ---------------------------------------------------------------------
// Stripe (API REST, senza librerie)
// ---------------------------------------------------------------------
function appiattisci(obj: unknown, prefisso: string, out: URLSearchParams) {
  if (obj === undefined || obj === null) return;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => appiattisci(v, `${prefisso}[${i}]`, out));
  } else if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      appiattisci(v, prefisso ? `${prefisso}[${k}]` : k, out);
    }
  } else {
    out.append(prefisso, String(obj));
  }
}

async function stripe(metodo: "GET" | "POST", percorso: string, params?: Record<string, unknown>) {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new HttpError(503, "Pagamenti non ancora configurati");
  const body = new URLSearchParams();
  if (params) appiattisci(params, "", body);
  const url = `https://api.stripe.com/v1/${percorso}` + (metodo === "GET" && params ? `?${body}` : "");
  const r = await fetch(url, {
    method: metodo,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: metodo === "POST" ? body : undefined,
  });
  const dati = await r.json();
  if (!r.ok) {
    console.error("Errore Stripe", dati?.error);
    throw new HttpError(502, "Errore del servizio di pagamento");
  }
  return dati;
}

async function firmaStripeValida(raw: string, header: string | null): Promise<boolean> {
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret || !header) return false;
  const parti = Object.fromEntries(
    header.split(",").map((p) => p.split("=")).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]),
  );
  const firme = header.split(",").map((p) => p.trim()).filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  const t = parti["t"];
  if (!t || !firme.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const chiave = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", chiave, new TextEncoder().encode(`${t}.${raw}`));
  const atteso = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return firme.some((f) => f.length === atteso.length && f === atteso);
}

// ---------------------------------------------------------------------
// Email (Resend)
// ---------------------------------------------------------------------
async function inviaEmail(a: string, oggetto: string, html: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) { console.warn("RESEND_API_KEY mancante: email non inviata a", a); return; }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: EMAIL_FROM, to: [a], subject: oggetto, html,
      ...(EMAIL_REPLY_TO ? { reply_to: EMAIL_REPLY_TO } : {}),
    }),
  });
  if (!r.ok) console.error("Errore invio email", r.status, await r.text());
}

function layoutEmail(titolo: string, corpo: string): string {
  return `<!doctype html><html lang="it"><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;border:1px solid #e2e8f0">
<tr><td style="padding:24px 28px 8px"><img src="${SITE}/logo.png" alt="Click Dottore" height="40" style="height:40px"></td></tr>
<tr><td style="padding:8px 28px 4px"><h1 style="font-size:20px;margin:0 0 12px">${esc(titolo)}</h1></td></tr>
<tr><td style="padding:0 28px 24px;font-size:15px;line-height:1.55">${corpo}</td></tr>
</table>
<p style="font-size:12px;color:#64748b;margin:16px 0 0">Click Dottore · Sportello medico sanitario · <a href="${SITE}" style="color:#64748b">clickdottore.it</a></p>
</td></tr></table></body></html>`;
}

function boxCodice(codice: string): string {
  return `<div style="margin:16px 0;padding:14px 18px;border-radius:12px;background:#eff6ff;border:1px solid #bfdbfe;font-size:13px;color:#334155">Codice prenotazione<br><span style="font-size:22px;font-weight:bold;letter-spacing:1px;color:#1e3a8a;font-family:'Courier New',monospace">${esc(codice)}</span></div>`;
}

async function caricaPrenotazione(id: string) {
  const { data, error } = await db.from("prenotazioni")
    .select("*, medico:medici(*), prestazione:prestazioni(*), hub:hub(*)")
    .eq("id", id).single();
  if (error || !data) throw new HttpError(404, "Prenotazione non trovata");
  return data;
}


// ---------------------------------------------------------------------
// Impostazioni, orari e controlli comuni
// ---------------------------------------------------------------------
const ORA = 60 * 60 * 1000;
const GIORNO_ROMA = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" });
const minimo = (...d: Date[]) => new Date(Math.min(...d.map((x) => x.getTime())));

async function impostazione(chiave: string, predefinito = ""): Promise<string> {
  const { data } = await db.from("impostazioni").select("valore").eq("chiave", chiave).maybeSingle();
  return data?.valore ?? predefinito;
}

async function percentualeHub(): Promise<number> {
  const n = parseInt(await impostazione("quota_hub_percento", "80"), 10);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 80;
}

function tokenCasuale(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function consensi(body: Record<string, unknown>) {
  if (body.consenso_privacy !== true || body.consenso_dati_sanitari !== true) {
    throw new HttpError(400, "Servono i consensi al trattamento dei dati");
  }
}

// Lo slot richiesto deve essere uno di quelli liberi del medico
async function verificaSlot(prestazione_id: string, inizioIso: unknown) {
  const inizio = new Date(String(inizioIso ?? ""));
  if (isNaN(inizio.getTime())) throw new HttpError(400, "Scegli giorno e orario della visita");
  await db.rpc("scadi_prenotazioni");
  const { data: pr } = await db.from("prestazioni")
    .select("id, attivo, medico:medici(id, attivo)")
    .eq("id", prestazione_id).maybeSingle();
  // deno-lint-ignore no-explicit-any
  const m = (pr as any)?.medico;
  if (!pr || !pr.attivo || !m?.attivo) throw new HttpError(400, "Medico o prestazione non disponibili");
  const { data: slot, error } = await db.rpc("slot_liberi", {
    p_prestazione: prestazione_id, p_dal: GIORNO_ROMA.format(inizio), p_giorni: 1,
  });
  if (error) { console.error(error); throw new HttpError(500, "Impossibile verificare gli orari"); }
  // deno-lint-ignore no-explicit-any
  const s = (slot ?? []).find((x: any) => new Date(x.inizio).getTime() === inizio.getTime());
  if (!s) throw new HttpError(409, "L'orario scelto non è più disponibile, scegline un altro");
  return { medico_id: m.id as string, inizio: new Date(s.inizio), fine: new Date(s.fine) };
}

// deno-lint-ignore no-explicit-any
function erroreInserimento(error: any): never {
  if (error?.code === "23P01") throw new HttpError(409, "L'orario scelto è appena stato occupato, scegline un altro");
  console.error(error);
  throw new HttpError(500, "Impossibile registrare la prenotazione");
}

// Il medico deve confermare entro 48 ore dal ricevimento della richiesta (e comunque entro un'ora prima della visita)
const scadenzaRisposta = (inizio: Date) => minimo(new Date(Date.now() + 48 * ORA), new Date(inizio.getTime() - ORA));

// Politica di rimborso: se il paziente ci ripensa, il ticket si rimborsa solo con almeno 48 ore di preavviso
const PREAVVISO_RIMBORSO = 48 * ORA;
// deno-lint-ignore no-explicit-any
const rimborsabile = (p: any) => !!p.visita_il && new Date(p.visita_il).getTime() - Date.now() >= PREAVVISO_RIMBORSO;
const TESTO_POLITICA = "Puoi annullare dalla tua area personale: il ticket viene rimborsato solo se annulli almeno 48 ore prima della visita, altrimenti non è rimborsabile.";

// ---------------------------------------------------------------------
// Email legate alle prenotazioni (nelle email al medico nessun dato del paziente)
// ---------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
type Pren = any;
const nomeMedico = (p: Pren) => `Dott. ${p.medico.nome} ${p.medico.cognome}`;
const cella = (k: string, v: string) =>
  `<tr><td style="color:#64748b;padding-right:12px;vertical-align:top">${k}</td><td>${v}</td></tr>`;

function tabellaVisita(p: Pren, extra = ""): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.7;margin:8px 0 12px">
    ${cella("Medico", `<strong>${esc(nomeMedico(p))}</strong> · ${esc(p.medico.specializzazione)}`)}
    ${cella("Prestazione", esc(p.prestazione.nome))}
    ${cella("Data e ora", `<strong>${esc(dataOra(p.visita_il))}</strong>`)}
    ${p.medico.indirizzo ? cella("Indirizzo", `${esc(p.medico.indirizzo)}, ${esc(p.medico.citta)}`) : cella("Città", esc(p.medico.citta))}
    ${extra}
  </table>`;
}

async function avvisaMedicoRichiesta(p: Pren) {
  const chi = p.canale === "hub" ? `${esc(p.hub?.nome ?? "una struttura")} chiede` : "un paziente chiede";
  await inviaEmail(p.medico.email, `Richiesta di prenotazione: ${p.prestazione.nome}, ${dataOra(p.visita_il)}`,
    layoutEmail("Un paziente vuole prenotare una visita", `
      <p>Gentile ${esc(nomeMedico(p))},<br>${chi} di prenotare la prestazione <strong>${esc(p.prestazione.nome)}</strong>
      per <strong>${esc(dataOra(p.visita_il))}</strong>.</p>
      ${boxCodice(p.codice)}
      <p>Accedi alla tua area riservata per vedere i dati del paziente e <strong>confermare o rifiutare</strong> la richiesta
      entro 48 ore dal ricevimento${p.scadenza ? `, cioè entro <strong>${esc(dataOra(p.scadenza))}</strong>` : ""}.
      Se non rispondi entro questo termine la richiesta scade e l'orario torna libero.</p>
      ${pulsanteEmail(`${SITE}/area.html`, "Conferma o rifiuta")}`));
}

async function avvisaPazienteRichiesta(p: Pren) {
  await inviaEmail(p.paziente_email, `Richiesta inviata ${p.codice}`, layoutEmail("Richiesta di prenotazione inviata", `
    <p>Gentile ${esc(p.paziente_nome)} ${esc(p.paziente_cognome)},<br>abbiamo inoltrato la tua richiesta al medico.</p>
    ${boxCodice(p.codice)}
    ${tabellaVisita(p)}
    <p>Non devi pagare nulla adesso. Riceverai un'email appena il medico conferma: da quel momento avrai 24 ore per pagare
    la quota di prenotazione di ${euro(p.quota_cents)} dalla tua area personale.</p>
    ${pulsanteEmail(`${SITE}/area-paziente.html`, "Vai alla tua area")}`));
}

async function avvisaPazienteDaPagare(p: Pren) {
  await inviaEmail(p.paziente_email, `Il medico ha confermato: completa la prenotazione ${p.codice}`,
    layoutEmail("Il medico ha confermato la tua richiesta", `
      <p>Gentile ${esc(p.paziente_nome)} ${esc(p.paziente_cognome)},<br>${esc(nomeMedico(p))} ha confermato la disponibilità per la tua visita.</p>
      ${boxCodice(p.codice)}
      ${tabellaVisita(p)}
      <p>Per confermare definitivamente la prenotazione paga la quota di <strong>${euro(p.quota_cents)}</strong>
      entro <strong>${esc(dataOra(p.scadenza))}</strong>. Se non paghi entro questo termine l'orario torna disponibile per altri pazienti.</p>
      <p style="color:#64748b;font-size:13px">${esc(TESTO_POLITICA)}</p>
      ${pulsanteEmail(`${SITE}/area-paziente.html`, `Paga ${euro(p.quota_cents)} e conferma`)}`));
}

async function avvisaRifiuto(p: Pren) {
  const motivo = p.motivo_rifiuto ? `<p>Motivo indicato dal medico: ${esc(p.motivo_rifiuto)}</p>` : "";
  if (p.canale === "online") {
    await inviaEmail(p.paziente_email, `Richiesta non accettata ${p.codice}`, layoutEmail("Il medico non può accettare la richiesta", `
      <p>Gentile ${esc(p.paziente_nome)} ${esc(p.paziente_cognome)},<br>${esc(nomeMedico(p))} non può accettare la richiesta per ${esc(dataOra(p.visita_il))}.</p>
      ${motivo}
      <p>Non ti è stato addebitato nulla. Puoi scegliere un altro orario o un altro medico.</p>
      ${pulsanteEmail(`${SITE}/index.html`, "Cerca un altro orario")}`));
  } else if (p.hub?.email) {
    await inviaEmail(p.hub.email, `Richiesta rifiutata ${p.codice}`, layoutEmail("Richiesta rifiutata dal medico", `
      <p>${esc(nomeMedico(p))} ha rifiutato la richiesta per <strong>${esc(p.prestazione.nome)}</strong> del ${esc(dataOra(p.visita_il))}
      (paziente ${esc(p.paziente_nome)} ${esc(p.paziente_cognome)}).</p>${boxCodice(p.codice)}${motivo}
      ${pulsanteEmail(`${SITE}/area.html`, "Apri l'area riservata")}`));
  }
}

// Visita confermata: ricevuta al paziente, avviso al medico e all'hub quando serve
async function avvisaVisitaConfermata(p: Pren, opzioni: { medico?: boolean; hub?: boolean } = {}) {
  const quota = p.canale === "online"
    ? cella("Quota di prenotazione", `${euro(p.quota_cents)} pagata`)
    : cella("Quota di prenotazione", p.pagata_il ? `${euro(p.quota_cents)} pagata` : `${euro(p.quota_cents)}, da pagare presso ${esc(p.hub?.nome ?? "la struttura")} o con il bollettino online`);
  await inviaEmail(p.paziente_email, `Visita confermata ${p.codice}`, layoutEmail("La tua visita è confermata", `
    <p>Gentile ${esc(p.paziente_nome)} ${esc(p.paziente_cognome)},<br>la tua visita è confermata${p.canale === "hub" ? ` (prenotata presso ${esc(p.hub?.nome ?? "la struttura")})` : ""}.</p>
    ${boxCodice(p.codice)}
    ${tabellaVisita(p, quota)}
    <p>Conserva il codice: ti servirà per qualsiasi comunicazione. Se non puoi presentarti, avvisa il prima possibile.</p>
    <p style="color:#64748b;font-size:13px">${p.canale === "online" ? esc(TESTO_POLITICA) : `Il ticket viene rimborsato solo se annulli almeno 48 ore prima della visita, rivolgendoti a ${esc(p.hub?.nome ?? "la struttura")}; altrimenti non è rimborsabile.`}</p>`));
  if (opzioni.medico) {
    await inviaEmail(p.medico.email, `Visita confermata ${p.codice}: ${dataOra(p.visita_il)}`, layoutEmail("Visita confermata", `
      <p>Gentile ${esc(nomeMedico(p))},<br>è confermata la visita per <strong>${esc(p.prestazione.nome)}</strong>
      il <strong>${esc(dataOra(p.visita_il))}</strong>${p.canale === "hub" ? `, registrata da ${esc(p.hub?.nome ?? "una struttura")} dopo averla concordata con te` : ": il paziente ha pagato la quota di prenotazione"}.</p>
      ${boxCodice(p.codice)}
      <p>I dati del paziente sono nella tua area riservata.</p>
      ${pulsanteEmail(`${SITE}/area.html`, "Apri l'area riservata")}`));
  }
  if (opzioni.hub && p.hub?.email) {
    await inviaEmail(p.hub.email, `Il medico ha confermato ${p.codice}`, layoutEmail("Visita confermata dal medico", `
      <p>${esc(nomeMedico(p))} ha confermato la visita di ${esc(p.paziente_nome)} ${esc(p.paziente_cognome)}
      per <strong>${esc(p.prestazione.nome)}</strong> il <strong>${esc(dataOra(p.visita_il))}</strong>.</p>
      ${boxCodice(p.codice)}
      <p>Dall'area riservata puoi registrare l'incasso della quota o stampare il bollettino da pagare online.</p>
      ${pulsanteEmail(`${SITE}/area.html`, "Apri l'area riservata")}`));
  }
}

// ---------------------------------------------------------------------
// Pagamenti Stripe
// ---------------------------------------------------------------------
async function creaCheckout(p: Pren, cancelUrl: string): Promise<string> {
  if (!Deno.env.get("STRIPE_SECRET_KEY")) throw new HttpError(503, "I pagamenti online non sono ancora attivi, riprova più tardi");
  const sessione = await stripe("POST", "checkout/sessions", {
    mode: "payment",
    locale: "it",
    customer_email: p.paziente_email,
    client_reference_id: p.id,
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
    success_url: `${SITE}/prenotazione-confermata.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "eur",
        unit_amount: p.quota_cents,
        product_data: {
          name: `Quota di prenotazione ${p.codice}`,
          description: `${p.prestazione.nome} - ${nomeMedico(p)} - ${dataOra(p.visita_il)}`,
        },
      },
    }],
    metadata: { prenotazione_id: p.id },
    payment_intent_data: { metadata: { prenotazione_id: p.id }, description: `Click Dottore ${p.codice}` },
  });
  await db.from("prenotazioni").update({ stripe_session_id: sessione.id }).eq("id", p.id);
  return sessione.url;
}

async function confermaPagamento(prenotazioneId: string, sessionId: string, paymentIntent: string | null) {
  const { data, error } = await db.rpc("conferma_pagamento", {
    p_prenotazione: prenotazioneId, p_session_id: sessionId, p_payment_intent: paymentIntent,
  });
  if (error) { console.error(error); throw new HttpError(500, "Errore nella conferma del pagamento"); }
  const r = Array.isArray(data) ? data[0] : data;
  if (!r?.r_appena_pagata) return r;
  try {
    const p = await caricaPrenotazione(r.r_id);
    if (p.canale === "online" && p.stato !== "confermata") {
      // pagata dopo la scadenza e orario non più libero: rimborso automatico
      if (paymentIntent) await stripe("POST", "refunds", { payment_intent: paymentIntent, metadata: { prenotazione_id: p.id } });
      await db.from("prenotazioni").update({ stato: "rimborsata", aggiornata_il: new Date().toISOString() }).eq("id", p.id);
      await inviaEmail(p.paziente_email, `Pagamento rimborsato ${p.codice}`, layoutEmail("Pagamento rimborsato", `
        <p>Gentile ${esc(p.paziente_nome)} ${esc(p.paziente_cognome)},<br>il pagamento è arrivato dopo la scadenza e nel frattempo l'orario
        è stato prenotato da un altro paziente. Ti abbiamo rimborsato la quota di ${euro(p.quota_cents)}: la vedrai sulla carta entro alcuni giorni lavorativi.</p>
        ${pulsanteEmail(`${SITE}/index.html`, "Scegli un altro orario")}`));
    } else if (p.canale === "online") {
      await avvisaVisitaConfermata(p, { medico: true });
    } else {
      await inviaEmail(p.paziente_email, `Quota pagata ${p.codice}`, layoutEmail("Quota di prenotazione pagata", `
        <p>Gentile ${esc(p.paziente_nome)} ${esc(p.paziente_cognome)},<br>abbiamo ricevuto il pagamento della quota di ${euro(p.quota_cents)}.</p>
        ${boxCodice(p.codice)}${tabellaVisita(p)}`));
      if (p.hub?.email) {
        await inviaEmail(p.hub.email, `Bollettino pagato ${p.codice}`, layoutEmail("Bollettino pagato online", `
          <p>Il paziente ${esc(p.paziente_nome)} ${esc(p.paziente_cognome)} ha pagato online la quota di ${euro(p.quota_cents)}.</p>
          ${boxCodice(p.codice)}<p>La tua parte (${euro(p.quota_hub_cents)}) compare nel saldo della scheda Conti.</p>`));
      }
    }
  } catch (e) { console.error("Avvisi dopo il pagamento non inviati", e); }
  return r;
}

async function statoPrenotazione(req: Request) {
  const sessionId = new URL(req.url).searchParams.get("session_id") ?? "";
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) throw new HttpError(400, "Sessione non valida");
  const campi = "id, codice, stato, canale, quota_cents, pagata_il, visita_il, medico:medici(nome, cognome, specializzazione, citta, indirizzo), prestazione:prestazioni(nome)";
  let { data: p } = await db.from("prenotazioni").select(campi).eq("stripe_session_id", sessionId).maybeSingle();
  if (!p || !p.pagata_il) {
    // il webhook potrebbe non essere ancora arrivato: controllo direttamente con Stripe
    const s = await stripe("GET", `checkout/sessions/${sessionId}`);
    const pid = s.metadata?.prenotazione_id ?? s.client_reference_id;
    if (pid && s.payment_status === "paid") await confermaPagamento(pid, sessionId, s.payment_intent ?? null);
    if (pid) ({ data: p } = await db.from("prenotazioni").select(campi).eq("id", pid).maybeSingle());
  }
  if (!p) throw new HttpError(404, "Prenotazione non trovata");
  return json(req, {
    pagata: !!p.pagata_il, stato: p.stato, canale: p.canale, codice: p.codice, quota_cents: p.quota_cents, visita_il: p.visita_il,
    // deno-lint-ignore no-explicit-any
    medico: (p as any).medico, prestazione: (p as any).prestazione?.nome,
  });
}

async function stripeWebhook(req: Request) {
  const raw = await req.text();
  if (!(await firmaStripeValida(raw, req.headers.get("Stripe-Signature")))) {
    return new Response("firma non valida", { status: 400 });
  }
  const evento = JSON.parse(raw);
  const s = evento.data?.object ?? {};
  const pid = s.metadata?.prenotazione_id ?? s.client_reference_id;
  if (pid && ((evento.type === "checkout.session.completed" && s.payment_status === "paid") ||
      evento.type === "checkout.session.async_payment_succeeded")) {
    await confermaPagamento(pid, s.id, s.payment_intent ?? null);
  }
  return new Response("ok", { status: 200 });
}

// ---------------------------------------------------------------------
// Paziente registrato: richiesta, pagamento, annullamento
// ---------------------------------------------------------------------
async function richiestaOnline(req: Request) {
  const paziente_id = await pazienteDaToken(req);
  if (!paziente_id) throw new HttpError(401, "Per prenotare accedi al tuo account o registrati");
  const body = await req.json().catch(() => ({}));
  if (body.sito) throw new HttpError(400, "Richiesta non valida");   // campo trappola anti-bot
  const prestazione_id = uuid(body.prestazione_id, "prestazione");
  const paziente = validaPaziente(body.paziente);
  consensi(body);
  const note = testo(body.note, "note", 500, false) || null;

  const { count } = await db.from("prenotazioni").select("id", { count: "exact", head: true })
    .eq("paziente_id", paziente_id).in("stato", ["richiesta", "da_pagare"]);
  if ((count ?? 0) >= 5) throw new HttpError(429, "Hai già 5 richieste in attesa: aspetta la risposta dei medici o annullane qualcuna");

  const slot = await verificaSlot(prestazione_id, body.inizio);
  const quota = await quotaCents();
  const { data: codice, error: errCodice } = await db.rpc("genera_codice", { p_canale: "online", p_hub_codice: null });
  if (errCodice || !codice) throw new HttpError(500, "Impossibile generare il codice");

  const { data: pren, error } = await db.from("prenotazioni").insert({
    codice, canale: "online", paziente_id, medico_id: slot.medico_id, prestazione_id,
    paziente_nome: paziente.nome, paziente_cognome: paziente.cognome,
    paziente_codice_fiscale: paziente.codice_fiscale, paziente_data_nascita: paziente.data_nascita,
    paziente_telefono: paziente.telefono, paziente_email: paziente.email, note,
    consenso_privacy: true, consenso_dati_sanitari: true, quota_cents: quota,
    stato: "richiesta", visita_il: slot.inizio.toISOString(), visita_fine: slot.fine.toISOString(),
    scadenza: scadenzaRisposta(slot.inizio).toISOString(),
  }).select("id, codice").single();
  if (error || !pren) erroreInserimento(error);

  await registra(paziente_id, "richiesta_online", pren.id);
  try {
    const p = await caricaPrenotazione(pren.id);
    await avvisaMedicoRichiesta(p);
    await avvisaPazienteRichiesta(p);
  } catch (e) { console.error("Avvisi non inviati", e); }
  return json(req, { id: pren.id, codice: pren.codice });
}

async function paga(req: Request) {
  const paziente_id = await pazienteDaToken(req);
  if (!paziente_id) throw new HttpError(401, "Accedi di nuovo per pagare");
  const body = await req.json().catch(() => ({}));
  const id = uuid(body.id, "prenotazione");
  await db.rpc("scadi_prenotazioni");
  const p = await caricaPrenotazione(id);
  if (p.paziente_id !== paziente_id) throw new HttpError(404, "Prenotazione non trovata");
  if (p.pagata_il) throw new HttpError(409, "La quota è già stata pagata");
  if (p.stato === "scaduta") throw new HttpError(409, "Il tempo per pagare è scaduto e l'orario è tornato libero: invia una nuova richiesta");
  if (p.stato !== "da_pagare") throw new HttpError(409, "Questa prenotazione non è in attesa di pagamento");
  const url = await creaCheckout(p, `${SITE}/area-paziente.html`);
  // l'orario resta riservato mentre il paziente completa il pagamento
  const tieni = new Date(Date.now() + 35 * 60 * 1000);
  if (!p.scadenza || new Date(p.scadenza) < tieni) {
    await db.from("prenotazioni").update({ scadenza: tieni.toISOString() }).eq("id", id).eq("stato", "da_pagare");
  }
  return json(req, { url });
}

// Annulla applicando la politica di rimborso.
//   causa "paziente": ripensamento del paziente -> rimborso solo con almeno 48 ore di preavviso
//   causa "struttura": il medico o la struttura non possono erogare la visita -> rimborso
type EsitoRimborso = "nessun_pagamento" | "stripe" | "hub" | "trattenuta";
async function eseguiAnnullamento(p: Pren, causa: "paziente" | "struttura", motivo: string | null, utenteId: string | null): Promise<EsitoRimborso> {
  let esito: EsitoRimborso;
  if (!p.pagata_il) esito = "nessun_pagamento";
  else if (causa === "paziente" && !rimborsabile(p)) esito = "trattenuta";
  else if (p.incassata_da === "click_dottore" && p.stripe_payment_intent) esito = "stripe";
  else esito = "hub";
  if (esito === "stripe") {
    await stripe("POST", "refunds", { payment_intent: p.stripe_payment_intent, metadata: { prenotazione_id: p.id } });
  }
  const { error } = await db.from("prenotazioni").update({
    stato: esito === "stripe" ? "rimborsata" : "annullata", scadenza: null,
    quota_trattenuta: esito === "trattenuta", nota_medico: motivo ?? p.nota_medico, aggiornata_il: new Date().toISOString(),
  }).eq("id", p.id);
  if (error) { console.error(error); throw new HttpError(500, "Annullamento non riuscito"); }
  await registra(utenteId, "annulla", p.id, { causa, esito });
  return esito;
}

function testoRimborso(p: Pren, esito: EsitoRimborso): string {
  switch (esito) {
    case "nessun_pagamento": return "Non ti è stato addebitato nulla.";
    case "stripe": return `La quota di ${euro(p.quota_cents)} ti verrà rimborsata sulla carta usata per il pagamento entro alcuni giorni lavorativi.`;
    case "hub": return `Per il rimborso della quota di ${euro(p.quota_cents)} rivolgiti a ${esc(p.hub?.nome ?? "la struttura")} presso cui hai prenotato.`;
    default: return `L'annullamento è avvenuto a meno di 48 ore dalla visita: come previsto dalle condizioni di prenotazione, la quota di ${euro(p.quota_cents)} non è rimborsabile.`;
  }
}

async function avvisaAnnullamento(p: Pren, esito: EsitoRimborso, motivo: string | null, opzioni: { paziente: boolean; medico: boolean; daPaziente?: boolean }) {
  if (opzioni.paziente) {
    await inviaEmail(p.paziente_email, `Prenotazione annullata ${p.codice}`, layoutEmail("La tua prenotazione è stata annullata", `
      <p>Gentile ${esc(p.paziente_nome)} ${esc(p.paziente_cognome)},<br>la prenotazione per <strong>${esc(p.prestazione.nome)}</strong>
      con ${esc(nomeMedico(p))} del ${esc(dataOra(p.visita_il))} è stata annullata${opzioni.daPaziente ? " su tua richiesta" : ""}.</p>
      ${boxCodice(p.codice)}${motivo ? `<p>Motivo: ${esc(motivo)}</p>` : ""}<p>${testoRimborso(p, esito)}</p>`));
  }
  if (opzioni.medico) {
    await inviaEmail(p.medico.email, `Prenotazione annullata ${p.codice}`, layoutEmail("Prenotazione annullata", `
      <p>Gentile ${esc(nomeMedico(p))},<br>la ${p.stato === "richiesta" ? "richiesta" : "prenotazione"} per <strong>${esc(p.prestazione.nome)}</strong> del ${esc(dataOra(p.visita_il))}
      è stata annullata${opzioni.daPaziente ? " dal paziente" : p.canale === "hub" ? ` da ${esc(p.hub?.nome ?? "l'hub")}` : ""}. L'orario è di nuovo disponibile.</p>${boxCodice(p.codice)}`));
  }
}

// Il paziente annulla dalla sua area (richiesta, quota da pagare o visita confermata)
async function annullaRichiestaPaziente(req: Request) {
  const paziente_id = await pazienteDaToken(req);
  if (!paziente_id) throw new HttpError(401, "Accedi di nuovo per annullare");
  const body = await req.json().catch(() => ({}));
  const id = uuid(body.id, "prenotazione");
  const p = await caricaPrenotazione(id);
  if (p.paziente_id !== paziente_id) throw new HttpError(404, "Prenotazione non trovata");
  if (!["richiesta", "da_pagare", "confermata"].includes(p.stato)) throw new HttpError(409, "Questa prenotazione è già chiusa");
  if (p.visita_il && new Date(p.visita_il).getTime() < Date.now()) throw new HttpError(409, "La visita è già passata");
  if (p.pagata_il && !rimborsabile(p) && body.senza_rimborso !== true) {
    throw new HttpError(409, "Mancano meno di 48 ore alla visita: annullando, la quota non sarà rimborsata. Conferma per procedere.");
  }
  const esito = await eseguiAnnullamento(p, "paziente", null, paziente_id);
  await avvisaAnnullamento(p, esito, null, { paziente: !!p.pagata_il, medico: true, daPaziente: true });
  return json(req, { ok: true, esito });
}

// ---------------------------------------------------------------------
// Bollettino dell'hub pagabile online (pagina pubblica paga.html)
// ---------------------------------------------------------------------
async function prenotazioneDaToken(token: string) {
  if (!/^[a-f0-9]{48}$/.test(token)) throw new HttpError(404, "Bollettino non trovato");
  const { data } = await db.from("prenotazioni").select("id").eq("token_pagamento", token).maybeSingle();
  if (!data) throw new HttpError(404, "Bollettino non trovato");
  return await caricaPrenotazione(data.id);
}

async function infoBollettino(req: Request) {
  const p = await prenotazioneDaToken(new URL(req.url).searchParams.get("t") ?? "");
  return json(req, {
    codice: p.codice, stato: p.stato, pagata: !!p.pagata_il, quota_cents: p.quota_cents, visita_il: p.visita_il,
    paziente: `${p.paziente_nome} ${String(p.paziente_cognome).charAt(0)}.`,
    medico: { nome: p.medico.nome, cognome: p.medico.cognome, specializzazione: p.medico.specializzazione, citta: p.medico.citta },
    prestazione: p.prestazione.nome, hub: p.hub?.nome ?? null,
    pagabile: p.stato === "confermata" && !p.pagata_il,
  });
}

async function pagaBollettino(req: Request) {
  const body = await req.json().catch(() => ({}));
  const token = String(body.t ?? "");
  const p = await prenotazioneDaToken(token);
  if (p.pagata_il) throw new HttpError(409, "La quota è già stata pagata");
  if (p.stato !== "confermata") throw new HttpError(409, "Questa prenotazione non è pagabile online");
  return json(req, { url: await creaCheckout(p, `${SITE}/paga.html?t=${token}`) });
}

// ---------------------------------------------------------------------
// Prenotazione dell'hub
// ---------------------------------------------------------------------
async function prenotaHub(req: Request) {
  const io = await utente(req);
  const body = await req.json().catch(() => ({}));
  let hubId = io.hub_id;
  if (io.ruolo === "admin" && body.hub_id) hubId = uuid(body.hub_id, "hub");
  if (!hubId) throw new HttpError(403, "La tua utenza non è collegata a un hub");
  const { data: hub } = await db.from("hub").select("*").eq("id", hubId).maybeSingle();
  if (!hub || !hub.attivo) throw new HttpError(403, "Hub non attivo");

  const prestazione_id = uuid(body.prestazione_id, "prestazione");
  const paziente = validaPaziente(body.paziente);
  consensi(body);
  const note = testo(body.note, "note", 500, false) || null;
  const giaConfermata = body.gia_confermata === true;
  const slot = await verificaSlot(prestazione_id, body.inizio);

  const quota = await quotaCents();
  const quotaHub = Math.round(quota * (await percentualeHub()) / 100);
  const { data: codice, error: errCodice } = await db.rpc("genera_codice", { p_canale: "hub", p_hub_codice: hub.codice });
  if (errCodice || !codice) throw new HttpError(500, "Impossibile generare il codice");
  const ora = new Date().toISOString();

  const { data: pren, error } = await db.from("prenotazioni").insert({
    codice, canale: "hub", hub_id: hub.id, creata_da: io.id, medico_id: slot.medico_id, prestazione_id,
    paziente_nome: paziente.nome, paziente_cognome: paziente.cognome,
    paziente_codice_fiscale: paziente.codice_fiscale, paziente_data_nascita: paziente.data_nascita,
    paziente_telefono: paziente.telefono, paziente_email: paziente.email, note,
    consenso_privacy: true, consenso_dati_sanitari: true,
    quota_cents: quota, quota_hub_cents: quotaHub, token_pagamento: tokenCasuale(),
    stato: giaConfermata ? "confermata" : "richiesta",
    confermata_il: giaConfermata ? ora : null,
    visita_il: slot.inizio.toISOString(), visita_fine: slot.fine.toISOString(),
    scadenza: giaConfermata ? null : scadenzaRisposta(slot.inizio).toISOString(),
  }).select("id, codice, stato").single();
  if (error || !pren) erroreInserimento(error);

  await registra(io.id, giaConfermata ? "prenotazione_hub_confermata" : "richiesta_hub", pren.id);
  try {
    const p = await caricaPrenotazione(pren.id);
    if (giaConfermata) await avvisaVisitaConfermata(p, { medico: true });
    else await avvisaMedicoRichiesta(p);
  } catch (e) { console.error("Avvisi non inviati", e); }
  return json(req, { id: pren.id, codice: pren.codice, stato: pren.stato });
}

// ---------------------------------------------------------------------
// Azioni su una prenotazione (medico, hub, amministratore)
// ---------------------------------------------------------------------
async function aggiornaPrenotazione(req: Request) {
  const io = await utente(req);
  const body = await req.json().catch(() => ({}));
  const id = uuid(body.id, "prenotazione");
  const azione = String(body.azione ?? "");
  await db.rpc("scadi_prenotazioni");
  const p = await caricaPrenotazione(id);

  const eAdmin = io.ruolo === "admin";
  const eMedico = io.medico_id !== null && io.medico_id === p.medico_id;
  const eHub = io.hub_id !== null && io.hub_id === p.hub_id;
  if (!eAdmin && !eMedico && !eHub) throw new HttpError(403, "Non puoi modificare questa prenotazione");

  const ora = new Date().toISOString();
  const aggiorna = async (campi: Record<string, unknown>) => {
    const { data, error } = await db.from("prenotazioni").update({ ...campi, aggiornata_il: ora }).eq("id", id).select("*").single();
    if (error) { console.error(error); throw new HttpError(500, "Aggiornamento non riuscito"); }
    await registra(io.id, azione, id, campi);
    return { ...p, ...data };
  };

  switch (azione) {
    case "conferma": {
      if (!eAdmin && !eMedico) throw new HttpError(403, "Solo il medico può confermare");
      if (p.stato === "scaduta") throw new HttpError(409, "La richiesta è scaduta e l'orario è tornato libero");
      if (p.stato !== "richiesta") throw new HttpError(409, "La richiesta non è in attesa di conferma");
      if (p.canale === "online") {
        const scadenza = minimo(new Date(Date.now() + 24 * ORA), new Date(p.visita_il));
        const agg = await aggiorna({ stato: "da_pagare", confermata_il: ora, scadenza: scadenza.toISOString() });
        await avvisaPazienteDaPagare(agg);
      } else {
        const agg = await aggiorna({ stato: "confermata", confermata_il: ora, scadenza: null });
        await avvisaVisitaConfermata(agg, { hub: true });
      }
      break;
    }
    case "rifiuta": {
      if (!eAdmin && !eMedico) throw new HttpError(403, "Solo il medico può rifiutare");
      if (p.stato !== "richiesta") throw new HttpError(409, "La richiesta non è in attesa di conferma");
      const motivo = testo(body.nota, "motivo", 500, false) || null;
      const agg = await aggiorna({ stato: "rifiutata", motivo_rifiuto: motivo, scadenza: null });
      await avvisaRifiuto(agg);
      break;
    }
    case "completa": {
      if (!eAdmin && !eMedico) throw new HttpError(403, "Solo il medico può chiudere la visita");
      if (p.stato !== "confermata") throw new HttpError(409, "Solo le visite confermate si possono segnare come svolte");
      await aggiorna({ stato: "completata" });
      break;
    }
    case "annulla": {
      if (!["richiesta", "da_pagare", "confermata"].includes(p.stato)) throw new HttpError(409, "La prenotazione è già chiusa");
      const motivo = testo(body.nota, "motivo", 500, false) || null;
      // "paziente" = ripensamento del paziente (rimborso solo con 48 ore di preavviso); altrimenti la visita salta per il medico o la struttura
      const causa = body.causa === "paziente" ? "paziente" : "struttura";
      const esito = await eseguiAnnullamento(p, causa, motivo, io.id);
      await avvisaAnnullamento(p, esito, motivo, {
        paziente: p.canale === "online" || p.stato === "confermata", medico: !eMedico, daPaziente: causa === "paziente",
      });
      return json(req, { ok: true, esito });
    }
    case "registra_incasso": {
      if (!eAdmin && !eHub) throw new HttpError(403, "Solo l'hub registra gli incassi");
      if (p.canale !== "hub") throw new HttpError(400, "Le quote online si pagano con Stripe");
      if (p.pagata_il) throw new HttpError(409, "La quota risulta già pagata");
      if (!["richiesta", "confermata"].includes(p.stato)) throw new HttpError(409, "Stato non compatibile con l'incasso");
      const metodo = String(body.metodo_pagamento ?? "");
      if (!["pos", "contanti", "altro"].includes(metodo)) throw new HttpError(400, "Indica come è stata pagata la quota");
      await aggiorna({ pagata_il: ora, incassata_da: "hub", metodo_pagamento: metodo });
      break;
    }
    case "bollettino": {
      if (!eAdmin && !eHub) throw new HttpError(403, "Solo l'hub stampa il bollettino");
      if (p.canale !== "hub") throw new HttpError(400, "Il bollettino è solo per le prenotazioni degli hub");
      if (p.pagata_il) throw new HttpError(409, "La quota risulta già pagata");
      if (p.stato !== "confermata") throw new HttpError(409, "Il bollettino si stampa dopo la conferma del medico");
      let token = p.token_pagamento;
      if (!token) {
        token = tokenCasuale();
        await db.from("prenotazioni").update({ token_pagamento: token }).eq("id", id);
      }
      await registra(io.id, "bollettino", id);
      return json(req, { url: `${SITE}/paga.html?t=${token}` });
    }
    case "segna_rimborsata": {
      if (p.canale !== "hub") throw new HttpError(400, "I rimborsi online sono automatici");
      if (!eAdmin && !eHub) throw new HttpError(403, "Solo l'hub può segnare il rimborso");
      if (p.stato !== "annullata" || p.incassata_da !== "hub") throw new HttpError(409, "Non c'è una quota incassata da rimborsare");
      if (p.quota_trattenuta) throw new HttpError(409, "Annullata a meno di 48 ore dalla visita su richiesta del paziente: la quota non è rimborsabile");
      await aggiorna({ stato: "rimborsata" });
      break;
    }
    default:
      throw new HttpError(400, "Azione non riconosciuta");
  }
  return json(req, { ok: true });
}

// ---------------------------------------------------------------------
// Il medico gestisce orari, chiusure, prestazioni e tariffe
// ---------------------------------------------------------------------
const ORARIO = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;

async function gestioneMedico(req: Request) {
  const io = await utente(req);
  const body = await req.json().catch(() => ({}));
  let medicoId = io.medico_id;
  if (io.ruolo === "admin" && body.medico_id) medicoId = uuid(body.medico_id, "medico");
  if (!medicoId) throw new HttpError(403, "La tua utenza non è collegata a un medico");
  const azione = String(body.azione ?? "");

  switch (azione) {
    case "salva_disponibilita": {
      const fasce = Array.isArray(body.fasce) ? body.fasce : [];
      if (fasce.length > 40) throw new HttpError(400, "Troppe fasce orarie");
      // deno-lint-ignore no-explicit-any
      const righe = fasce.map((f: any) => {
        const giorno = Number(f?.giorno);
        const inizio = String(f?.inizio ?? ""), fine = String(f?.fine ?? "");
        if (!Number.isInteger(giorno) || giorno < 1 || giorno > 7) throw new HttpError(400, "Giorno non valido");
        if (!ORARIO.test(inizio) || !ORARIO.test(fine)) throw new HttpError(400, "Orario non valido (usa il formato 09:30)");
        if (fine <= inizio) throw new HttpError(400, `Fascia ${inizio}-${fine}: l'orario di fine deve essere dopo l'inizio`);
        return { medico_id: medicoId, giorno_settimana: giorno, ora_inizio: inizio, ora_fine: fine };
      });
      for (const a of righe) {
        for (const b of righe) {
          if (a !== b && a.giorno_settimana === b.giorno_settimana && a.ora_inizio < b.ora_fine && b.ora_inizio < a.ora_fine) {
            throw new HttpError(400, "Due fasce dello stesso giorno si sovrappongono");
          }
        }
      }
      await db.from("disponibilita").delete().eq("medico_id", medicoId);
      if (righe.length) {
        const { error } = await db.from("disponibilita").insert(righe);
        if (error) { console.error(error); throw new HttpError(500, "Salvataggio non riuscito"); }
      }
      await registra(io.id, "salva_disponibilita", null, { medico_id: medicoId, fasce: righe.length });
      return json(req, { ok: true });
    }
    case "aggiungi_chiusura": {
      const dal = String(body.dal ?? ""), al = String(body.al ?? body.dal ?? "");
      if (!DATA.test(dal) || !DATA.test(al) || al < dal) throw new HttpError(400, "Date di chiusura non valide");
      const { error } = await db.from("chiusure").insert({
        medico_id: medicoId, dal, al, motivo: testo(body.motivo, "motivo", 120, false) || null,
      });
      if (error) throw new HttpError(500, "Salvataggio non riuscito");
      return json(req, { ok: true });
    }
    case "elimina_chiusura": {
      await db.from("chiusure").delete().eq("id", uuid(body.id, "chiusura")).eq("medico_id", medicoId);
      return json(req, { ok: true });
    }
    case "salva_prestazione": {
      const durata = Math.round(Number(body.durata_minuti));
      if (!Number.isFinite(durata) || durata < 5 || durata > 480) throw new HttpError(400, "Durata non valida (da 5 a 480 minuti)");
      let prezzo: number | null = null;
      if (body.prezzo_euro !== undefined && body.prezzo_euro !== null && String(body.prezzo_euro).trim() !== "") {
        prezzo = Math.round(Number(String(body.prezzo_euro).replace(",", ".")) * 100);
        if (!Number.isFinite(prezzo) || prezzo < 0 || prezzo > 10000000) throw new HttpError(400, "Tariffa non valida");
      }
      const riga = {
        nome: testo(body.nome, "nome della prestazione", 120),
        descrizione: testo(body.descrizione, "descrizione", 300, false) || null,
        prezzo_visita_cents: prezzo, durata_minuti: durata, attivo: body.attivo !== false,
      };
      if (body.id) {
        const { data, error } = await db.from("prestazioni").update(riga)
          .eq("id", uuid(body.id, "prestazione")).eq("medico_id", medicoId).select("id").maybeSingle();
        if (error || !data) throw new HttpError(404, "Prestazione non trovata");
      } else {
        const { error } = await db.from("prestazioni").insert({ ...riga, medico_id: medicoId });
        if (error) throw new HttpError(500, "Salvataggio non riuscito");
      }
      await registra(io.id, "salva_prestazione", null, { medico_id: medicoId, nome: riga.nome });
      return json(req, { ok: true });
    }
    case "salva_profilo": {
      const { error } = await db.from("medici").update({
        indirizzo: testo(body.indirizzo, "indirizzo", 160, false) || null,
        telefono: testo(body.telefono, "telefono", 30, false) || null,
      }).eq("id", medicoId);
      if (error) throw new HttpError(500, "Salvataggio non riuscito");
      return json(req, { ok: true });
    }
    default:
      throw new HttpError(400, "Azione non riconosciuta");
  }
}


async function linkAccesso(tipo: "invite" | "recovery", email: string) {
  const { data, error } = await db.auth.admin.generateLink({
    type: tipo, email, options: { redirectTo: `${SITE}/imposta-password.html` },
  });
  if (error || !data?.properties?.action_link) {
    console.error(error);
    throw new HttpError(tipo === "invite" ? 409 : 500,
      tipo === "invite" ? "Impossibile creare l'utenza (l'email è già registrata?)" : "Impossibile generare il link");
  }
  return { link: data.properties.action_link, userId: data.user?.id };
}


async function admin(req: Request) {
  const io = await utente(req);
  if (io.ruolo !== "admin") throw new HttpError(403, "Solo l'amministratore");
  const body = await req.json().catch(() => ({}));
  const azione = String(body.azione ?? "");

  switch (azione) {
    case "crea_hub": {
      const riga = {
        tipo: body.tipo === "medico" ? "medico" : "struttura",
        nome: testo(body.nome, "nome", 120),
        codice: testo(body.codice, "codice hub", 10).toUpperCase(),
        citta: testo(body.citta, "città", 80, false) || null,
        indirizzo: testo(body.indirizzo, "indirizzo", 160, false) || null,
        email: testo(body.email, "email", 120, false) || null,
        telefono: testo(body.telefono, "telefono", 30, false) || null,
      };
      if (!/^[A-Z0-9]{3,10}$/.test(riga.codice)) throw new HttpError(400, "Codice hub: da 3 a 10 lettere maiuscole o cifre");
      const { data, error } = await db.from("hub").insert(riga).select().single();
      if (error) throw new HttpError(409, error.code === "23505" ? "Codice hub già usato" : "Impossibile creare l'hub");
      await registra(io.id, "crea_hub", null, { id: data.id });
      return json(req, data);
    }
    case "crea_medico": {
      const riga = {
        nome: testo(body.nome, "nome", 60), cognome: testo(body.cognome, "cognome", 60),
        specializzazione: testo(body.specializzazione, "specializzazione", 120),
        citta: testo(body.citta, "città", 80), indirizzo: testo(body.indirizzo, "indirizzo", 160, false) || null,
        email: testo(body.email, "email", 120).toLowerCase(), telefono: testo(body.telefono, "telefono", 30, false) || null,
      };
      const { data, error } = await db.from("medici").insert(riga).select().single();
      if (error) throw new HttpError(500, "Impossibile creare il medico");
      const prestazioni = Array.isArray(body.prestazioni) ? body.prestazioni : [];
      for (const pr of prestazioni) {
        const nome = testo(pr?.nome, "prestazione", 120, false);
        if (nome) await db.from("prestazioni").insert({ medico_id: data.id, nome, descrizione: testo(pr?.descrizione, "descrizione", 300, false) || null });
      }
      await registra(io.id, "crea_medico", null, { id: data.id });
      return json(req, data);
    }
    case "crea_prestazione": {
      const { data, error } = await db.from("prestazioni").insert({
        medico_id: uuid(body.medico_id, "medico"), nome: testo(body.nome, "nome", 120),
        descrizione: testo(body.descrizione, "descrizione", 300, false) || null,
      }).select().single();
      if (error) throw new HttpError(500, "Impossibile creare la prestazione");
      return json(req, data);
    }
    case "imposta_attivo": {
      const tabella = String(body.tabella ?? "");
      if (!["hub", "medici", "prestazioni", "profili"].includes(tabella)) throw new HttpError(400, "Tabella non valida");
      const id = uuid(body.id, "id");
      if (tabella === "profili" && id === io.id) throw new HttpError(400, "Non puoi disattivare la tua utenza");
      const { error } = await db.from(tabella).update({ attivo: body.attivo === true }).eq("id", id);
      if (error) throw new HttpError(500, "Aggiornamento non riuscito");
      await registra(io.id, "imposta_attivo", null, { tabella, id, attivo: body.attivo === true });
      return json(req, { ok: true });
    }
    case "invita_utente": {
      const email = testo(body.email, "email", 120).toLowerCase();
      const nome = testo(body.nome, "nome", 120);
      const ruolo = String(body.ruolo ?? "");
      if (!["admin", "operatore", "medico"].includes(ruolo)) throw new HttpError(400, "Ruolo non valido");
      const hub_id = body.hub_id ? uuid(body.hub_id, "hub") : null;
      const medico_id = body.medico_id ? uuid(body.medico_id, "medico") : null;
      if (ruolo === "operatore" && !hub_id) throw new HttpError(400, "L'operatore deve essere collegato a un hub");
      if (ruolo === "medico" && !medico_id) throw new HttpError(400, "Scegli il medico collegato all'utenza");

      const { link, userId } = await linkAccesso("invite", email);
      const { error } = await db.from("profili").insert({ id: userId, ruolo, nome, email, hub_id, medico_id });
      if (error) {
        console.error(error);
        if (userId) await db.auth.admin.deleteUser(userId);
        throw new HttpError(500, "Impossibile creare il profilo");
      }
      await inviaEmail(email, "Il tuo accesso a Click Dottore", layoutEmail("Benvenuto in Click Dottore", `
        <p>Ciao ${esc(nome)},<br>è stata creata per te un'utenza ${ruolo === "admin" ? "di amministratore" : ruolo === "medico" ? "medico" : "di operatore"} su Click Dottore.</p>
        <p>Per attivarla scegli la tua password con il pulsante qui sotto. Il link vale per 24 ore.</p>
        <p><a href="${esc(link)}" style="display:inline-block;background:#0284c7;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:bold">Scegli la password</a></p>`));
      await registra(io.id, "invita_utente", null, { email, ruolo });
      return json(req, { ok: true });
    }
    case "imposta_impostazioni": {
      if (body.quota_cents !== undefined) {
        const cents = Math.round(Number(body.quota_cents));
        if (!Number.isFinite(cents) || cents < 50 || cents > 10000) throw new HttpError(400, "Quota non valida (da 0,50 € a 100 €)");
        await db.from("impostazioni").upsert({ chiave: "quota_cents", valore: String(cents) });
      }
      if (body.quota_hub_percento !== undefined) {
        const pct = Math.round(Number(body.quota_hub_percento));
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new HttpError(400, "Percentuale dell'hub non valida (da 0 a 100)");
        await db.from("impostazioni").upsert({ chiave: "quota_hub_percento", valore: String(pct) });
      }
      if (body.iban !== undefined) {
        const iban = String(body.iban ?? "").toUpperCase().replace(/\s/g, "");
        if (iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) throw new HttpError(400, "IBAN non valido");
        await db.from("impostazioni").upsert({ chiave: "iban_click_dottore", valore: iban });
      }
      if (body.intestatario !== undefined) {
        await db.from("impostazioni").upsert({ chiave: "intestatario_iban", valore: testo(body.intestatario, "intestatario", 120, false) });
      }
      await registra(io.id, "imposta_impostazioni", null, body);
      return json(req, { ok: true });
    }
    case "registra_regolazione": {
      const hub_id = uuid(body.hub_id, "hub");
      const cents = Math.round(Number(String(body.importo_euro ?? "").replace(",", ".")) * 100);
      if (!Number.isFinite(cents) || cents <= 0 || cents > 100000000) throw new HttpError(400, "Importo non valido");
      const verso = String(body.verso ?? "");
      if (!["hub_a_cd", "cd_a_hub"].includes(verso)) throw new HttpError(400, "Indica chi ha fatto il bonifico");
      const data = String(body.data ?? "") || new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new HttpError(400, "Data non valida");
      const { error } = await db.from("regolazioni").insert({
        hub_id, importo_cents: verso === "hub_a_cd" ? cents : -cents, data,
        nota: testo(body.nota, "nota", 200, false) || null, registrata_da: io.id,
      });
      if (error) { console.error(error); throw new HttpError(500, "Registrazione non riuscita"); }
      await registra(io.id, "registra_regolazione", null, { hub_id, cents, verso });
      return json(req, { ok: true });
    }
    case "imposta_quota": {
      const cents = Math.round(Number(body.quota_cents));
      if (!Number.isFinite(cents) || cents < 50 || cents > 10000) throw new HttpError(400, "Quota non valida (da 0,50 € a 100 €)");
      await db.from("impostazioni").upsert({ chiave: "quota_cents", valore: String(cents) });
      await registra(io.id, "imposta_quota", null, { cents });
      return json(req, { ok: true });
    }
    default:
      throw new HttpError(400, "Azione non riconosciuta");
  }
}

async function recuperoPassword(req: Request) {
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const rispostaNeutra = json(req, { ok: true });   // non rivela se l'email esiste
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return rispostaNeutra;
  let { data: prof } = await db.from("profili").select("id, nome, attivo").eq("email", email).maybeSingle();
  if (!prof) {
    const { data: paz } = await db.from("pazienti").select("id, nome").eq("email", email).maybeSingle();
    if (paz) prof = { ...paz, attivo: true };
  }
  if (!prof || !prof.attivo) return rispostaNeutra;

  const unOraFa = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await db.from("registro").select("id", { count: "exact", head: true })
    .eq("azione", "recupero_password").eq("utente", prof.id).gte("quando", unOraFa);
  if ((count ?? 0) >= 3) return rispostaNeutra;

  const { link } = await linkAccesso("recovery", email);
  await inviaEmail(email, "Reimposta la tua password di Click Dottore", layoutEmail("Reimposta la password", `
    <p>Ciao ${esc(prof.nome)},<br>abbiamo ricevuto una richiesta di reimpostare la password della tua utenza.</p>
    <p><a href="${esc(link)}" style="display:inline-block;background:#0284c7;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:bold">Scegli una nuova password</a></p>
    <p style="color:#64748b;font-size:13px">Se non sei stato tu, ignora questa email: la password resta quella di prima.</p>`));
  await registra(prof.id, "recupero_password", null);
  return rispostaNeutra;
}

// ---------------------------------------------------------------------
// Account dei pazienti
// ---------------------------------------------------------------------
const pulsanteEmail = (link: string, testo: string) =>
  `<p><a href="${esc(link)}" style="display:inline-block;background:#0284c7;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:bold">${esc(testo)}</a></p>`;

async function emailGiaRegistrato(email: string) {
  await inviaEmail(email, "Hai già un account Click Dottore", layoutEmail("Hai già un account", `
    <p>Qualcuno (probabilmente tu) ha provato a registrarsi su Click Dottore con questo indirizzo email, ma esiste già un account collegato.</p>
    <p>Puoi accedere con la tua password. Se non la ricordi, dalla pagina di accesso scegli "Password dimenticata?".</p>
    ${pulsanteEmail(`${SITE}/accedi.html`, "Vai all'accesso")}
    <p style="color:#64748b;font-size:13px">Se non sei stato tu, ignora questa email: il tuo account non è stato modificato.</p>`));
}

async function registrati(req: Request) {
  const body = await req.json().catch(() => ({}));
  if (body.sito) throw new HttpError(400, "Richiesta non valida");   // campo trappola anti-bot
  const dati = validaPaziente(body);
  if (body.consenso_privacy !== true) throw new HttpError(400, "Serve l'accettazione dell'informativa privacy e dei termini");
  const email = dati.email;
  const rispostaNeutra = json(req, { ok: true });   // non rivela se l'email è già registrata

  // limiti anti-abuso: 3 richieste all'ora per email, 60 all'ora in totale
  const unOraFa = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: perEmail } = await db.from("registro").select("id", { count: "exact", head: true })
    .eq("azione", "registrazione").eq("dettagli->>email", email).gte("quando", unOraFa);
  if ((perEmail ?? 0) >= 3) throw new HttpError(429, "Troppi tentativi con questa email, riprova tra un'ora");
  const { count: totali } = await db.from("registro").select("id", { count: "exact", head: true })
    .eq("azione", "registrazione").gte("quando", unOraFa);
  if ((totali ?? 0) >= 60) throw new HttpError(429, "Troppe registrazioni in questo momento, riprova più tardi");
  await registra(null, "registrazione", null, { email });

  // email già usata dal personale o da un paziente con account attivo
  const { data: staff } = await db.from("profili").select("id").eq("email", email).maybeSingle();
  if (staff) { await emailGiaRegistrato(email); return rispostaNeutra; }
  const { data: esistente } = await db.from("pazienti").select("id").eq("email", email).maybeSingle();

  let link: string;
  let userId: string;
  if (esistente) {
    const { data: u } = await db.auth.admin.getUserById(esistente.id);
    if (u?.user?.email_confirmed_at) { await emailGiaRegistrato(email); return rispostaNeutra; }
    // account mai confermato: rimando un nuovo link (la password si sceglie solo dal link)
    ({ link } = await linkAccesso("recovery", email));
    userId = esistente.id;
  } else {
    // la password si sceglie dopo aver aperto il link ricevuto per email:
    // così nessuno può creare l'account di un altro con una password che conosce
    const { data: gen, error } = await db.auth.admin.generateLink({
      type: "invite", email,
      options: { redirectTo: `${SITE}/imposta-password.html`, data: { tipo: "paziente" } },
    });
    if (error || !gen?.properties?.action_link || !gen.user) {
      if (error && /already|registered|exists/i.test(error.message)) { await emailGiaRegistrato(email); return rispostaNeutra; }
      console.error("Registrazione non riuscita", error);
      throw new HttpError(500, "Registrazione non riuscita, riprova tra poco");
    }
    link = gen.properties.action_link;
    userId = gen.user.id;
  }

  const ora = new Date().toISOString();
  const { error: errPaz } = await db.from("pazienti").upsert({
    id: userId, nome: dati.nome, cognome: dati.cognome, codice_fiscale: dati.codice_fiscale,
    data_nascita: dati.data_nascita, telefono: dati.telefono, email,
    consenso_privacy_il: ora, aggiornato_il: ora,
  });
  if (errPaz) {
    console.error(errPaz);
    if (!esistente) await db.auth.admin.deleteUser(userId);
    throw new HttpError(500, "Registrazione non riuscita, riprova tra poco");
  }

  await inviaEmail(email, "Attiva il tuo account Click Dottore", layoutEmail("Attiva il tuo account", `
    <p>Ciao ${esc(dati.nome)},<br>grazie per esserti registrato su Click Dottore.</p>
    <p>Per attivare l'account conferma il tuo indirizzo email e scegli la password con il pulsante qui sotto. Il link vale 24 ore e si può usare una sola volta.</p>
    ${pulsanteEmail(link, "Conferma e scegli la password")}
    <p>Dopo l'attivazione potrai prenotare le visite con i tuoi dati già compilati e ritrovare tutte le tue prenotazioni nella tua area personale.</p>
    <p style="color:#64748b;font-size:13px">Se non hai chiesto tu la registrazione, ignora questa email: l'account non verrà attivato.</p>`));
  return rispostaNeutra;
}

// Promemoria il giorno prima della visita. Chiamato ogni ora da pg_cron: la funzione del database
// "prenotazioni_da_ricordare" segna e restituisce una sola volta le visite confermate di domani (dalle 9 in poi).
async function promemoria(req: Request) {
  const { data: righe, error } = await db.rpc("prenotazioni_da_ricordare");
  if (error) { console.error(error); throw new HttpError(500, "Promemoria non disponibili"); }
  let inviati = 0;
  for (const r of righe ?? []) {
    try {
      const p = await caricaPrenotazione(r.id);
      const daPagare = p.canale === "hub" && !p.pagata_il
        ? `<p>La quota di prenotazione di ${euro(p.quota_cents)} risulta ancora da pagare: puoi saldarla presso ${esc(p.hub?.nome ?? "la struttura")}${p.token_pagamento ? ` oppure <a href="${SITE}/paga.html?t=${p.token_pagamento}" style="color:#0284c7">online con il bollettino</a>` : ""}.</p>`
        : "";
      await inviaEmail(p.paziente_email, `Promemoria: domani la tua visita ${p.codice}`, layoutEmail("Domani hai una visita", `
        <p>Gentile ${esc(p.paziente_nome)} ${esc(p.paziente_cognome)},<br>ti ricordiamo l'appuntamento di domani.</p>
        ${boxCodice(p.codice)}
        ${tabellaVisita(p)}
        ${daPagare}
        <p>Ti consigliamo di arrivare qualche minuto prima e di portare con te un documento, la tessera sanitaria ed eventuali esami precedenti.</p>
        <p style="color:#64748b;font-size:13px">Se non puoi presentarti avvisa il medico il prima possibile. Mancando meno di 48 ore alla visita, in caso di annullamento la quota di prenotazione non è rimborsabile.</p>`));
      inviati++;
    } catch (e) { console.error("Promemoria non inviato", r.id, e); }
  }
  return json(req, { inviati });
}

async function aggiornaProfilo(req: Request) {
  const id = await pazienteDaToken(req);
  if (!id) throw new HttpError(401, "Accedi di nuovo per modificare i tuoi dati");
  const body = await req.json().catch(() => ({}));
  const { data: attuale } = await db.from("pazienti").select("email").eq("id", id).single();
  const dati = validaPaziente({ ...body, email: attuale!.email });   // l'email non si cambia da qui
  const { error } = await db.from("pazienti").update({
    nome: dati.nome, cognome: dati.cognome, codice_fiscale: dati.codice_fiscale,
    data_nascita: dati.data_nascita, telefono: dati.telefono, aggiornato_il: new Date().toISOString(),
  }).eq("id", id);
  if (error) { console.error(error); throw new HttpError(500, "Salvataggio non riuscito"); }
  await registra(id, "aggiorna_profilo", null);
  return json(req, { ok: true });
}


// ---------------------------------------------------------------------
// Smistamento delle richieste
// ---------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const percorso = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  try {
    if (percorso === "stripe-webhook" && req.method === "POST") return await stripeWebhook(req);
    if (percorso === "stato-prenotazione" && req.method === "GET") return await statoPrenotazione(req);
    if (percorso === "info-bollettino" && req.method === "GET") return await infoBollettino(req);
    if (req.method !== "POST") throw new HttpError(405, "Metodo non consentito");
    switch (percorso) {
      case "richiesta-online": return await richiestaOnline(req);
      case "paga": return await paga(req);
      case "annulla-richiesta": return await annullaRichiestaPaziente(req);
      case "paga-bollettino": return await pagaBollettino(req);
      case "prenota-hub": return await prenotaHub(req);
      case "aggiorna-prenotazione": return await aggiornaPrenotazione(req);
      case "medico": return await gestioneMedico(req);
      case "admin": return await admin(req);
      case "recupero-password": return await recuperoPassword(req);
      case "registrati": return await registrati(req);
      case "aggiorna-profilo": return await aggiornaProfilo(req);
      case "promemoria": return await promemoria(req);
      default: throw new HttpError(404, "Percorso sconosciuto");
    }
  } catch (e) {
    if (e instanceof HttpError) return json(req, { errore: e.message }, e.status);
    console.error(e);
    return json(req, { errore: "Errore imprevisto, riprova" }, 500);
  }
});
