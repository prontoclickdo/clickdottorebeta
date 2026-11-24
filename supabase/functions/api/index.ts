// =====================================================================
// Click Dottore - funzione server "api" (Supabase Edge Function)
//
// Percorsi:
//   POST /api/prenota-online          prenotazione autonoma del paziente + pagamento Stripe
//   GET  /api/stato-prenotazione      esito del pagamento (pagina di conferma)
//   POST /api/stripe-webhook          notifiche di Stripe (pagamento riuscito / scaduto)
//   POST /api/prenota-hub             prenotazione fatta da una struttura o da un medico (hub)
//   POST /api/aggiorna-prenotazione   presa in carico, data visita, annullamento...
//   POST /api/admin                   gestione hub, medici, prestazioni, utenze, quota
//   POST /api/recupero-password       link per reimpostare la password
//   POST /api/registrati              registrazione del paziente (email di conferma)
//   POST /api/aggiorna-profilo        il paziente aggiorna i propri dati
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

// Avvisa il medico (senza dati sanitari nell'email) e invia la ricevuta al paziente
async function notificaNuovaPrenotazione(id: string) {
  const p = await caricaPrenotazione(id);
  const medico = `Dott. ${p.medico.nome} ${p.medico.cognome}`;
  const tramite = p.canale === "hub" ? `tramite ${esc(p.hub?.nome ?? "una struttura")}` : "online dal paziente";

  await inviaEmail(
    p.medico.email,
    `Nuova prenotazione ${p.codice} - ${p.prestazione.nome}`,
    layoutEmail("Hai una nuova prenotazione", `
      <p>Gentile ${esc(medico)},<br>è arrivata una nuova prenotazione ${tramite} per la prestazione <strong>${esc(p.prestazione.nome)}</strong>.</p>
      ${boxCodice(p.codice)}
      <p>Per vedere i dati del paziente e fissare data e ora della visita, accedi alla tua area riservata.</p>
      <p><a href="${SITE}/area.html" style="display:inline-block;background:#0284c7;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:bold">Apri l'area riservata</a></p>`),
  );

  await inviaEmail(
    p.paziente_email,
    `Prenotazione confermata ${p.codice}`,
    layoutEmail("La tua prenotazione è confermata", `
      <p>Gentile ${esc(p.paziente_nome)} ${esc(p.paziente_cognome)},<br>abbiamo registrato la tua prenotazione ${p.canale === "hub" ? `effettuata presso ${esc(p.hub?.nome ?? "la struttura")}` : ""}.</p>
      ${boxCodice(p.codice)}
      <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.7">
        <tr><td style="color:#64748b;padding-right:12px">Medico</td><td><strong>${esc(medico)}</strong> · ${esc(p.medico.specializzazione)}</td></tr>
        <tr><td style="color:#64748b;padding-right:12px">Prestazione</td><td>${esc(p.prestazione.nome)}</td></tr>
        <tr><td style="color:#64748b;padding-right:12px">Città</td><td>${esc(p.medico.citta)}</td></tr>
        <tr><td style="color:#64748b;padding-right:12px">Quota di prenotazione</td><td>${euro(p.quota_cents)} pagata</td></tr>
      </table>
      <p>Il medico ti contatterà nei prossimi giorni per fissare data e ora della visita. Conserva il codice: ti servirà per qualsiasi comunicazione.</p>`),
  );
}

// ---------------------------------------------------------------------
// Controlli comuni alle prenotazioni
// ---------------------------------------------------------------------
async function verificaMedicoPrestazione(medico_id: string, prestazione_id: string) {
  const { data: pr } = await db.from("prestazioni")
    .select("id, nome, attivo, medico:medici(id, nome, cognome, attivo)")
    .eq("id", prestazione_id).eq("medico_id", medico_id).maybeSingle();
  // deno-lint-ignore no-explicit-any
  const m = (pr as any)?.medico;
  if (!pr || !pr.attivo || !m || !m.attivo) throw new HttpError(400, "Medico o prestazione non disponibili");
  return { prestazione: pr.nome as string, medico: `Dott. ${m.nome} ${m.cognome}` };
}

function consensi(body: Record<string, unknown>) {
  if (body.consenso_privacy !== true || body.consenso_dati_sanitari !== true) {
    throw new HttpError(400, "Servono i consensi al trattamento dei dati");
  }
}

// ---------------------------------------------------------------------
// Percorsi
// ---------------------------------------------------------------------
async function prenotaOnline(req: Request) {
  if (!Deno.env.get("STRIPE_SECRET_KEY")) throw new HttpError(503, "I pagamenti online non sono ancora attivi, riprova più tardi");
  const body = await req.json().catch(() => ({}));
  if (body.sito) throw new HttpError(400, "Richiesta non valida");   // campo trappola anti-bot
  const medico_id = uuid(body.medico_id, "medico");
  const prestazione_id = uuid(body.prestazione_id, "prestazione");
  const paziente = validaPaziente(body.paziente);
  consensi(body);
  const note = testo(body.note, "note", 500, false) || null;
  const info = await verificaMedicoPrestazione(medico_id, prestazione_id);

  // limite anti-abuso: massimo 5 tentativi in 10 minuti con la stessa email
  const dieciMinutiFa = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count } = await db.from("prenotazioni").select("id", { count: "exact", head: true })
    .eq("paziente_email", paziente.email).gte("creata_il", dieciMinutiFa);
  if ((count ?? 0) >= 5) throw new HttpError(429, "Troppi tentativi, riprova tra qualche minuto");

  const quota = await quotaCents();
  const paziente_id = await pazienteDaToken(req);
  const { data: pren, error } = await db.from("prenotazioni").insert({
    canale: "online", medico_id, prestazione_id, paziente_id,
    paziente_nome: paziente.nome, paziente_cognome: paziente.cognome,
    paziente_codice_fiscale: paziente.codice_fiscale, paziente_data_nascita: paziente.data_nascita,
    paziente_telefono: paziente.telefono, paziente_email: paziente.email, note,
    consenso_privacy: true, consenso_dati_sanitari: true,
    quota_cents: quota, incassata_da: "click_dottore", metodo_pagamento: "stripe",
  }).select("id").single();
  if (error || !pren) { console.error(error); throw new HttpError(500, "Impossibile registrare la prenotazione"); }

  const sessione = await stripe("POST", "checkout/sessions", {
    mode: "payment",
    locale: "it",
    customer_email: paziente.email,
    client_reference_id: pren.id,
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
    success_url: `${SITE}/prenotazione-confermata.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${SITE}/prenota.html?medico=${medico_id}&prestazione=${prestazione_id}&annullato=1`,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "eur",
        unit_amount: quota,
        product_data: { name: `Quota di prenotazione - ${info.prestazione}`, description: info.medico },
      },
    }],
    metadata: { prenotazione_id: pren.id },
    payment_intent_data: { metadata: { prenotazione_id: pren.id }, description: `Click Dottore - ${info.prestazione}` },
  });

  await db.from("prenotazioni").update({ stripe_session_id: sessione.id }).eq("id", pren.id);
  return json(req, { url: sessione.url });
}

async function confermaSessione(sessionId: string, paymentIntent: string | null) {
  const { data, error } = await db.rpc("conferma_pagamento_online", {
    p_session_id: sessionId, p_payment_intent: paymentIntent,
  });
  if (error) { console.error(error); throw new HttpError(500, "Errore nella conferma del pagamento"); }
  const riga = Array.isArray(data) ? data[0] : data;
  if (riga?.appena_pagata) {
    try { await notificaNuovaPrenotazione(riga.prenotazione_id); } catch (e) { console.error("Notifica non inviata", e); }
  }
  return riga;
}

async function statoPrenotazione(req: Request) {
  const sessionId = new URL(req.url).searchParams.get("session_id") ?? "";
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) throw new HttpError(400, "Sessione non valida");
  let { data: p } = await db.from("prenotazioni")
    .select("id, codice, stato, quota_cents, medico:medici(nome, cognome, specializzazione, citta), prestazione:prestazioni(nome)")
    .eq("stripe_session_id", sessionId).maybeSingle();
  if (!p) throw new HttpError(404, "Prenotazione non trovata");

  // Se il webhook non è ancora arrivato, controllo direttamente con Stripe
  if (p.stato === "in_attesa_pagamento") {
    const s = await stripe("GET", `checkout/sessions/${sessionId}`);
    if (s.payment_status === "paid") {
      await confermaSessione(sessionId, s.payment_intent ?? null);
      ({ data: p } = await db.from("prenotazioni")
        .select("id, codice, stato, quota_cents, medico:medici(nome, cognome, specializzazione, citta), prestazione:prestazioni(nome)")
        .eq("stripe_session_id", sessionId).maybeSingle());
    }
  }
  return json(req, {
    stato: p!.stato, codice: p!.codice, quota_cents: p!.quota_cents,
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
  if ((evento.type === "checkout.session.completed" && s.payment_status === "paid") ||
      evento.type === "checkout.session.async_payment_succeeded") {
    await confermaSessione(s.id, s.payment_intent ?? null);
  } else if (evento.type === "checkout.session.expired") {
    await db.from("prenotazioni").update({ stato: "scaduta", aggiornata_il: new Date().toISOString() })
      .eq("stripe_session_id", s.id).eq("stato", "in_attesa_pagamento");
  }
  return new Response("ok", { status: 200 });
}

async function prenotaHub(req: Request) {
  const io = await utente(req);
  const body = await req.json().catch(() => ({}));
  let hubId = io.hub_id;
  if (io.ruolo === "admin" && body.hub_id) hubId = uuid(body.hub_id, "hub");
  if (!hubId) throw new HttpError(403, "La tua utenza non è collegata a un hub");
  const { data: hub } = await db.from("hub").select("*").eq("id", hubId).maybeSingle();
  if (!hub || !hub.attivo) throw new HttpError(403, "Hub non attivo");

  const medico_id = uuid(body.medico_id, "medico");
  const prestazione_id = uuid(body.prestazione_id, "prestazione");
  const paziente = validaPaziente(body.paziente);
  consensi(body);
  const note = testo(body.note, "note", 500, false) || null;
  const metodo = String(body.metodo_pagamento ?? "");
  if (!["pos", "contanti", "altro"].includes(metodo)) throw new HttpError(400, "Indica come è stata pagata la quota");
  await verificaMedicoPrestazione(medico_id, prestazione_id);

  const quota = await quotaCents();
  const { data: codice, error: errCodice } = await db.rpc("genera_codice", { p_canale: "hub", p_hub_codice: hub.codice });
  if (errCodice || !codice) throw new HttpError(500, "Impossibile generare il codice");

  const { data: pren, error } = await db.from("prenotazioni").insert({
    codice, canale: "hub", hub_id: hub.id, creata_da: io.id, medico_id, prestazione_id,
    paziente_nome: paziente.nome, paziente_cognome: paziente.cognome,
    paziente_codice_fiscale: paziente.codice_fiscale, paziente_data_nascita: paziente.data_nascita,
    paziente_telefono: paziente.telefono, paziente_email: paziente.email, note,
    consenso_privacy: true, consenso_dati_sanitari: true,
    quota_cents: quota, incassata_da: "hub", metodo_pagamento: metodo,
    stato: "pagata", pagata_il: new Date().toISOString(),
  }).select("id, codice").single();
  if (error || !pren) { console.error(error); throw new HttpError(500, "Impossibile registrare la prenotazione"); }

  await registra(io.id, "prenotazione_hub", pren.id, { metodo });
  try { await notificaNuovaPrenotazione(pren.id); } catch (e) { console.error("Notifica non inviata", e); }
  return json(req, { codice: pren.codice, id: pren.id });
}

async function aggiornaPrenotazione(req: Request) {
  const io = await utente(req);
  const body = await req.json().catch(() => ({}));
  const id = uuid(body.id, "prenotazione");
  const azione = String(body.azione ?? "");
  const p = await caricaPrenotazione(id);

  const eAdmin = io.ruolo === "admin";
  const eMedico = io.medico_id !== null && io.medico_id === p.medico_id;
  const eHub = io.hub_id !== null && io.hub_id === p.hub_id;
  if (!eAdmin && !eMedico && !eHub) throw new HttpError(403, "Non puoi modificare questa prenotazione");

  const ora = new Date().toISOString();
  const aggiorna = async (campi: Record<string, unknown>) => {
    const { error } = await db.from("prenotazioni").update({ ...campi, aggiornata_il: ora }).eq("id", id);
    if (error) { console.error(error); throw new HttpError(500, "Aggiornamento non riuscito"); }
    await registra(io.id, azione, id, campi);
  };
  const medicoNome = `Dott. ${p.medico.nome} ${p.medico.cognome}`;

  switch (azione) {
    case "prendi_in_carico": {
      if (!eAdmin && !eMedico) throw new HttpError(403, "Solo il medico può prendere in carico");
      if (p.stato !== "pagata") throw new HttpError(409, "La prenotazione non è in attesa di presa in carico");
      await aggiorna({ stato: "presa_in_carico" });
      break;
    }
    case "fissa_visita": {
      if (!eAdmin && !eMedico) throw new HttpError(403, "Solo il medico può fissare la visita");
      if (!["pagata", "presa_in_carico", "visita_fissata"].includes(p.stato)) throw new HttpError(409, "Stato non compatibile");
      const quando = new Date(String(body.visita_il ?? ""));
      if (isNaN(quando.getTime()) || quando.getTime() < Date.now() - 60 * 60 * 1000) throw new HttpError(400, "Data e ora non valide");
      const nota = testo(body.nota, "nota", 500, false) || null;
      await aggiorna({ stato: "visita_fissata", visita_il: quando.toISOString(), nota_medico: nota });
      await inviaEmail(p.paziente_email, `Visita fissata - ${p.codice}`, layoutEmail("La tua visita è stata fissata", `
        <p>Gentile ${esc(p.paziente_nome)} ${esc(p.paziente_cognome)},<br>${esc(medicoNome)} ha fissato la tua visita.</p>
        ${boxCodice(p.codice)}
        <p style="font-size:16px"><strong>${esc(dataOra(quando.toISOString()))}</strong></p>
        <p>Prestazione: ${esc(p.prestazione.nome)}${p.medico.indirizzo ? `<br>Indirizzo: ${esc(p.medico.indirizzo)}, ${esc(p.medico.citta)}` : ""}</p>
        ${nota ? `<p>Nota del medico: ${esc(nota)}</p>` : ""}`));
      break;
    }
    case "completa": {
      if (!eAdmin && !eMedico) throw new HttpError(403, "Solo il medico può chiudere la visita");
      await aggiorna({ stato: "completata" });
      break;
    }
    case "annulla": {
      if (["annullata", "rimborsata", "completata"].includes(p.stato)) throw new HttpError(409, "La prenotazione è già chiusa");
      const motivo = testo(body.nota, "motivo", 500, false) || null;
      let nuovoStato = "annullata";
      if (p.canale === "online" && p.stripe_payment_intent && p.stato !== "in_attesa_pagamento") {
        await stripe("POST", "refunds", { payment_intent: p.stripe_payment_intent, metadata: { prenotazione_id: id } });
        nuovoStato = "rimborsata";
      }
      await aggiorna({ stato: nuovoStato, nota_medico: motivo ?? p.nota_medico });
      await inviaEmail(p.paziente_email, `Prenotazione annullata - ${p.codice}`, layoutEmail("La tua prenotazione è stata annullata", `
        <p>Gentile ${esc(p.paziente_nome)} ${esc(p.paziente_cognome)},<br>la prenotazione per <strong>${esc(p.prestazione.nome)}</strong> con ${esc(medicoNome)} è stata annullata.</p>
        ${boxCodice(p.codice ?? "-")}
        ${motivo ? `<p>Motivo: ${esc(motivo)}</p>` : ""}
        <p>${nuovoStato === "rimborsata"
          ? `La quota di ${euro(p.quota_cents)} ti verrà rimborsata sulla carta usata per il pagamento entro alcuni giorni lavorativi.`
          : `Per il rimborso della quota rivolgiti a ${esc(p.hub?.nome ?? "la struttura")} presso cui hai prenotato.`}</p>`));
      break;
    }
    case "segna_rimborsata": {
      if (p.canale !== "hub") throw new HttpError(400, "I rimborsi online sono automatici");
      if (!eAdmin && !eHub) throw new HttpError(403, "Solo l'hub può segnare il rimborso");
      await aggiorna({ stato: "rimborsata" });
      break;
    }
    default:
      throw new HttpError(400, "Azione non riconosciuta");
  }
  return json(req, { ok: true });
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
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const percorso = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  try {
    if (percorso === "stripe-webhook" && req.method === "POST") return await stripeWebhook(req);
    if (percorso === "stato-prenotazione" && req.method === "GET") return await statoPrenotazione(req);
    if (req.method !== "POST") throw new HttpError(405, "Metodo non consentito");
    switch (percorso) {
      case "prenota-online": return await prenotaOnline(req);
      case "prenota-hub": return await prenotaHub(req);
      case "aggiorna-prenotazione": return await aggiornaPrenotazione(req);
      case "admin": return await admin(req);
      case "recupero-password": return await recuperoPassword(req);
      case "registrati": return await registrati(req);
      case "aggiorna-profilo": return await aggiornaProfilo(req);
      default: throw new HttpError(404, "Percorso sconosciuto");
    }
  } catch (e) {
    if (e instanceof HttpError) return json(req, { errore: e.message }, e.status);
    console.error(e);
    return json(req, { errore: "Errore imprevisto, riprova" }, 500);
  }
});
