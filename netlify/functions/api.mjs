// Pakz Kasa — API (Netlify Function v2 + Netlify Blobs)
// Rute:
//   POST /api/login            { user: "dusan"|"pavle", password }
//   GET  /api/state            -> { entries, log, version }
//   POST /api/entries          { entry }      dodaj
//   PUT  /api/entries/:id      { entry }      izmeni
//   DELETE /api/entries/:id                   obriši
//   GET  /api/rate?date=YYYY-MM-DD            NBS srednji kurs EUR
//   GET  /api/export                          backup (JSON)
//   POST /api/import           { entries }    vrati backup
//
// Podešavanje bez Netlify-a: šifre se postavljaju na sajtu pri prvom otvaranju,
// tajni ključ se pravi sam, Discord webhook se lepi u meniju sajta (sve u Blobs).
// Opciono (ima prednost ako postoji): env DUSAN_PASSWORD, PAVLE_PASSWORD, SESSION_SECRET, DISCORD_WEBHOOK_URL

import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import seed from "./seed.mjs";

export const config = { path: "/api/*" };

const USERS = {
  dusan: { name: "Dušan", env: "DUSAN_PASSWORD" },
  pavle: { name: "Pavle", env: "PAVLE_PASSWORD" },
};
const TYPES = ["income", "shared", "personal"];
const DATA_KEY = "ledger";
const MAX_LOG = 1000;
const TOKEN_DAYS = 60;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const env = (k) => (globalThis.Netlify?.env?.get(k) ?? process.env[k] ?? "").trim();

// ---------- Podešavanja (šifre, tajni ključ, Discord) čuvaju se u Blobs ----------
let CFG = null;
async function cfg(force) {
  if (CFG && !force) return CFG;
  const s = store();
  let c = await s.get("config", { type: "json" });
  if (!c || !c.secret) {
    const fresh = { ...(c || {}), secret: crypto.randomBytes(32).toString("hex"), users: c?.users || {} };
    const w = await s.setJSON("config", fresh, c ? {} : { onlyIfNew: true });
    c = w?.modified === false ? await s.get("config", { type: "json" }) : fresh;
  }
  c.users ||= {};
  CFG = c;
  return c;
}
async function saveCfg(patch) {
  const c = { ...(await cfg(true)), ...patch };
  await store().setJSON("config", c);
  CFG = c;
  return c;
}
const hashPw = (pw, salt = crypto.randomBytes(16).toString("hex")) =>
  ({ salt, hash: crypto.scryptSync(String(pw), salt, 32).toString("hex") });
function checkStored(rec, pw) {
  if (!rec?.salt || !rec?.hash) return false;
  const h = crypto.scryptSync(String(pw), rec.salt, 32);
  const want = Buffer.from(rec.hash, "hex");
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}
const hasPassword = (u) => !!(env(USERS[u].env) || CFG?.users?.[u]?.hash);
const needsSetup = () => !hasPassword("dusan") && !hasPassword("pavle");
const webhook = () => env("DISCORD_WEBHOOK_URL") || CFG?.discordWebhook || "";
const validHook = (h) => /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(h || "");

function secret() {
  return env("SESSION_SECRET") || CFG?.secret || "pakz-kasa-fallback";
}
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}
function verify(token) {
  if (!token || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expect = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  const a = Buffer.from(mac), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!USERS[p.u] || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const store = () => getStore({ name: "pakz-kasa", consistency: "strong" });

async function load() {
  const s = store();
  const res = await s.getWithMetadata(DATA_KEY, { type: "json" });
  if (!res || !res.data) {
    const fresh = { version: 0, entries: (seed.entries || []).map((e) => ({ ...e })), log: [] };
    return { data: fresh, etag: null };
  }
  return { data: res.data, etag: res.etag };
}

// Čitaj → izmeni → upiši, uz zaštitu od istovremenih izmena
async function mutate(fn) {
  const s = store();
  for (let i = 0; i < 6; i++) {
    const { data, etag } = await load();
    const result = await fn(data);
    if (result?.error) return result;
    data.version = (data.version || 0) + 1;
    if (data.log.length > MAX_LOG) data.log = data.log.slice(-MAX_LOG);
    const opts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
    const w = await s.setJSON(DATA_KEY, data, opts);
    if (w?.modified !== false) return { data, result };
    await new Promise((r) => setTimeout(r, 80 * (i + 1)));
  }
  return { error: "Neko je baš sad menjao podatke — pokušaj ponovo.", status: 409 };
}

// ---------- Kurs ----------
const todayBelgrade = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Belgrade" }).format(new Date());

async function getRate(date) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : todayBelgrade();
  const s = store();
  const today = todayBelgrade();
  const cacheKey = `rate-${d}`;
  const cached = await s.get(cacheKey, { type: "json" });
  // Današnji kurs osvežavamo na svakih 3h (NBS objavljuje oko 8h), stari datumi su trajni
  if (cached && (d < today || Date.now() - cached.fetchedAt < 3 * 3600e3)) return cached;
  const url = d === today
    ? "https://kurs.resenje.org/api/v1/currencies/eur/rates/today"
    : `https://kurs.resenje.org/api/v1/currencies/eur/rates/${d}`;
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const middle = Number(j.exchange_middle);
    if (!(middle > 50 && middle < 500)) throw new Error("los kurs");
    const out = { date: d, rateDate: j.date || d, middle, source: "NBS srednji kurs", fetchedAt: Date.now() };
    await s.setJSON(cacheKey, out);
    await s.setJSON("rate-last", out);
    return out;
  } catch (e) {
    if (cached) return { ...cached, stale: true };
    const last = await s.get("rate-last", { type: "json" });
    if (last) return { ...last, stale: true };
    return { date: d, rateDate: d, middle: 117.2, source: "rezervni kurs", stale: true, fetchedAt: Date.now() };
  }
}

// ---------- Validacija stavke ----------
const round2 = (n) => Math.round(n * 100) / 100;

async function normalize(rawInput, prev) {
  const input = Object.fromEntries(Object.entries(rawInput || {}).filter(([, v]) => v !== undefined && v !== null));
  const e = { ...(prev || {}), ...input };
  if (!TYPES.includes(e.type)) return { error: "Nepoznat tip stavke." };
  e.amount = Number(String(e.amount).replace(",", "."));
  if (!(e.amount > 0) || e.amount > 1e9) return { error: "Iznos mora biti veći od nule." };
  if (!["EUR", "RSD"].includes(e.currency)) return { error: "Valuta mora biti EUR ili RSD." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || "")) e.date = todayBelgrade();
  if (e.type === "personal") {
    if (!USERS[e.person]) return { error: "Izaberi za koga je trošak." };
  } else delete e.person;
  e.note = String(e.note || "").slice(0, 300).trim();
  e.student = String(e.student || "").slice(0, 80).trim();
  e.tag = String(e.tag || "").slice(0, 40).trim();

  const manual = Number(String(input.rate ?? "").replace(",", "."));
  const dateChanged = prev && prev.date !== e.date;
  if (input.rate != null && input.rate !== "" && manual > 50 && manual < 500 && input.rateManual) {
    e.rate = manual; e.rateManual = true; e.rateDate = e.date;
  } else if (!prev || dateChanged || !prev.rate || (prev.rateManual && !input.rateManual)) {
    const r = await getRate(e.date);
    e.rate = r.middle; e.rateDate = r.rateDate; e.rateManual = false;
  }
  e.eur = e.currency === "EUR" ? round2(e.amount) : round2(e.amount / e.rate);
  e.rsd = e.currency === "RSD" ? round2(e.amount) : round2(e.amount * e.rate);
  return { entry: e };
}

const pick = (e) => e && {
  id: e.id, type: e.type, person: e.person, amount: e.amount, currency: e.currency,
  eur: e.eur, rsd: e.rsd, date: e.date, note: e.note, student: e.student, tag: e.tag,
};

// ---------- Discord ----------
// Env: DISCORD_WEBHOOK_URL (Discord kanal → Edit Channel → Integrations → Webhooks → Copy URL)
const NAME_ACC = { dusan: "Dušana", pavle: "Pavla" };
const nfDisc = new Intl.NumberFormat("sr-Latn-RS", { maximumFractionDigits: 2 });
const nfDisc0 = new Intl.NumberFormat("sr-Latn-RS", { maximumFractionDigits: 0 });
const dmy = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${d}.${m}.${y}.`; };
const amt = (e) => `${nfDisc.format(e.amount)} ${e.currency === "EUR" ? "eur" : "din"}`;
const both = (eur, rsd) => `**${nfDisc.format(Math.round(eur * 100) / 100)} €** · ${nfDisc0.format(Math.round(rsd))} RSD`;

function line(e) {
  if (!e) return "";
  const sign = e.type === "income" ? "" : "−";
  const parts = [`${sign}${amt(e)}`];
  if (e.type === "income" && e.student) parts.push(e.student);
  if (e.type !== "income" && e.note) parts.push(e.note);
  parts.push(dmy(e.date));
  let s = parts.join(" - ");
  const extra = e.type === "income" ? e.tag : e.type === "shared" ? "zajednički trošak, pola-pola" : `za ${NAME_ACC[e.person]}`;
  if (extra) s += ` (${extra})`;
  if (e.type === "income" && e.note) s += ` · ${e.note}`;
  return s;
}

function totals(entries) {
  const t = { inE: 0, inR: 0, shE: 0, shR: 0, dE: 0, dR: 0, pE: 0, pR: 0 };
  for (const e of entries) {
    if (e.type === "income") { t.inE += e.eur; t.inR += e.rsd; }
    else if (e.type === "shared") { t.shE += e.eur; t.shR += e.rsd; }
    else if (e.person === "dusan") { t.dE += e.eur; t.dR += e.rsd; }
    else { t.pE += e.eur; t.pR += e.rsd; }
  }
  const d = { eur: t.inE / 2 - t.shE / 2 - t.dE, rsd: t.inR / 2 - t.shR / 2 - t.dR };
  const p = { eur: t.inE / 2 - t.shE / 2 - t.pE, rsd: t.inR / 2 - t.shR / 2 - t.pR };
  return { inE: t.inE, inR: t.inR, d, p, pot: { eur: d.eur + p.eur, rsd: d.rsd + p.rsd } };
}

async function discord(req, { action, by, entry, before, entries }) {
  const hook = webhook();
  if (!validHook(hook)) return false;
  const who = USERS[by]?.name || by;
  let content;
  if (action === "add") content = line(entry);
  else if (action === "edit") content = `✏️ ${who} izmenio: ~~${line(before)}~~ → ${line(entry)}`;
  else if (action === "delete") content = `🗑️ ${who} obrisao: ~~${line(before)}~~`;
  else if (action === "restore") content = `↩️ ${who} vratio: ${line(entry)}`;
  else if (action === "test") content = "✅ Pakz Kasa je povezana sa ovim kanalom.";
  const t = totals(entries);
  const color = action === "add" && entry?.type === "income" ? 0x3ee0a1 : action === "add" ? 0xff7a9a : 0x7b3cf0;
  const origin = new URL(req.url).origin;
  const body = {
    username: "Pakz Kasa",
    avatar_url: `${origin}/logo.jpg`,
    content,
    allowed_mentions: { parse: [] },
    embeds: [{
      color,
      fields: [
        { name: "Ukupno zarađeno", value: both(t.inE, t.inR), inline: false },
        { name: "Dušan", value: both(t.d.eur, t.d.rsd), inline: true },
        { name: "Pavle", value: both(t.p.eur, t.p.rsd), inline: true },
        { name: "U kasi", value: both(t.pot.eur, t.pot.rsd), inline: true },
      ],
      footer: { text: `${action === "add" ? "Upisao" : "Promena"}: ${who}${entry?.rate ? ` · kurs 1 € = ${nfDisc.format(entry.rate)} RSD` : ""}` },
      url: origin,
      title: "Otvori Pakz Kasu",
    }],
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(hook + "?wait=true", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!r.ok) console.error("discord", r.status, await r.text().catch(() => ""));
    return r.ok;
  } catch (e) { console.error("discord", e?.message); return false; }
  finally { clearTimeout(timer); }
}

// ---------- Handler ----------
export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const method = req.method;

  try {
    await cfg(true);

    if (path === "setup" && method === "GET") {
      return json({ needsSetup: needsSetup() });
    }

    // prvo podešavanje: postavljaju se šifre za oba korisnika, samo jednom
    if (path === "setup" && method === "POST") {
      await cfg(true);
      if (!needsSetup()) return json({ error: "Šifre su već postavljene." }, 409);
      const { dusan, pavle } = await req.json().catch(() => ({}));
      if (String(dusan || "").length < 6 || String(pavle || "").length < 6)
        return json({ error: "Svaka šifra mora imati bar 6 znakova." }, 400);
      if (dusan === pavle) return json({ error: "Šifre za Dušana i Pavla moraju biti različite." }, 400);
      await saveCfg({ users: { dusan: hashPw(dusan), pavle: hashPw(pavle) }, setupAt: new Date().toISOString() });
      return json({ ok: true });
    }

    if (path === "login" && method === "POST") {
      const { user, password } = await req.json().catch(() => ({}));
      const u = USERS[user];
      if (!u) return json({ error: "Izaberi korisnika." }, 400);
      const envPw = env(u.env);
      const rec = CFG.users?.[user];
      if (!envPw && !rec?.hash) return json({ error: `Šifra za ${u.name} još nije postavljena.` }, 400);
      const ok = envPw ? safeEqual(password || "", envPw) : checkStored(rec, password || "");
      if (!ok) {
        await new Promise((r) => setTimeout(r, 600));
        return json({ error: "Pogrešna šifra." }, 401);
      }
      const token = sign({ u: user, exp: Date.now() + TOKEN_DAYS * 86400e3 });
      return json({ token, user, name: u.name });
    }

    // sve ostalo traži login
    const auth = verify((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
    if (!auth) return json({ error: "Nisi ulogovan." }, 401);
    const me = auth.u;
    const now = new Date().toISOString();

    if (path === "password" && method === "POST") {
      const { current, next } = await req.json().catch(() => ({}));
      if (env(USERS[me].env)) return json({ error: "Šifra je podešena na Netlify-u, tamo se i menja." }, 400);
      if (!checkStored(CFG.users?.[me], current || "")) return json({ error: "Trenutna šifra nije tačna." }, 401);
      if (String(next || "").length < 6) return json({ error: "Nova šifra mora imati bar 6 znakova." }, 400);
      await saveCfg({ users: { ...CFG.users, [me]: hashPw(next) } });
      return json({ ok: true });
    }

    if (path === "settings" && method === "GET") {
      const h = webhook();
      return json({ discord: validHook(h), discordFromEnv: !!env("DISCORD_WEBHOOK_URL"), discordHint: h ? "…" + h.slice(-6) : "" });
    }

    if (path === "settings" && method === "POST") {
      const { discordWebhook } = await req.json().catch(() => ({}));
      const h = String(discordWebhook ?? "").trim();
      if (h && !validHook(h)) return json({ error: "To ne liči na Discord webhook link (https://discord.com/api/webhooks/…)." }, 400);
      await saveCfg({ discordWebhook: h });
      return json({ ok: true, discord: !!h });
    }

    if (path === "rate" && method === "GET") {
      return json(await getRate(url.searchParams.get("date")));
    }

    if (path === "state" && method === "GET") {
      const { data } = await load();
      return json({ version: data.version, entries: data.entries, log: data.log.slice(-300).reverse(), me });
    }

    if (path === "discord-test" && method === "POST") {
      if (!validHook(webhook())) return json({ error: "Discord kanal još nije povezan (Meni → Discord kanal)." }, 400);
      const { data } = await load();
      const ok = await discord(req, { action: "test", by: me, entries: data.entries });
      return ok ? json({ ok: true }) : json({ error: "Discord je odbio poruku — proveri webhook URL." }, 502);
    }

    if (path === "export" && method === "GET") {
      const { data } = await load();
      return new Response(JSON.stringify({ exportedAt: now, exportedBy: me, ...data }, null, 2), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="pakz-kasa-backup-${todayBelgrade()}.json"`,
          "cache-control": "no-store",
        },
      });
    }

    if (path === "import" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (!Array.isArray(body.entries)) return json({ error: "Fajl nije ispravan backup." }, 400);
      const out = await mutate(async (data) => {
        const before = data.entries.length;
        data.entries = body.entries.filter((e) => e && e.id && TYPES.includes(e.type));
        data.log.push({ id: crypto.randomUUID(), at: now, by: me, action: "import",
          summary: `Vraćen backup: ${before} → ${data.entries.length} stavki` });
      });
      if (out.error) return json({ error: out.error }, out.status || 400);
      return json({ ok: true, version: out.data.version });
    }

    const m = path.match(/^entries(?:\/([\w-]+))?$/);
    if (m) {
      const id = m[1];
      const body = method === "DELETE" ? {} : await req.json().catch(() => ({}));

      if (method === "POST" && !id) {
        const out = await mutate(async (data) => {
          const n = await normalize(body.entry || {});
          if (n.error) return n;
          const e = { ...n.entry, id: crypto.randomUUID(), createdBy: me, createdAt: now };
          data.entries.push(e);
          data.log.push({ id: crypto.randomUUID(), at: now, by: me, action: "add", after: pick(e) });
          return { entry: e };
        });
        if (out.error) return json({ error: out.error }, out.status || 400);
        await discord(req, { action: "add", by: me, entry: out.result.entry, entries: out.data.entries });
        return json({ ok: true, entry: out.result.entry, version: out.data.version });
      }

      if (method === "PUT" && id) {
        const out = await mutate(async (data) => {
          const i = data.entries.findIndex((e) => e.id === id);
          if (i < 0) return { error: "Stavka ne postoji (možda je obrisana).", status: 404 };
          const prev = data.entries[i];
          const { id: _x, createdBy, createdAt, ...rest } = body.entry || {};
          const n = await normalize(rest, prev);
          if (n.error) return n;
          const e = { ...n.entry, id, createdBy: prev.createdBy, createdAt: prev.createdAt, updatedBy: me, updatedAt: now };
          data.entries[i] = e;
          data.log.push({ id: crypto.randomUUID(), at: now, by: me, action: "edit", before: pick(prev), after: pick(e) });
          return { entry: e, prev };
        });
        if (out.error) return json({ error: out.error }, out.status || 400);
        await discord(req, { action: "edit", by: me, entry: out.result.entry, before: out.result.prev, entries: out.data.entries });
        return json({ ok: true, entry: out.result.entry, version: out.data.version });
      }

      if (method === "DELETE" && id) {
        const out = await mutate(async (data) => {
          const i = data.entries.findIndex((e) => e.id === id);
          if (i < 0) return { error: "Stavka ne postoji.", status: 404 };
          const [prev] = data.entries.splice(i, 1);
          data.log.push({ id: crypto.randomUUID(), at: now, by: me, action: "delete", before: pick(prev), full: prev });
          return { prev };
        });
        if (out.error) return json({ error: out.error }, out.status || 400);
        await discord(req, { action: "delete", by: me, before: out.result.prev, entries: out.data.entries });
        return json({ ok: true, version: out.data.version });
      }

      // vrati obrisanu stavku iz istorije
      if (method === "POST" && id === "restore") {
        const out = await mutate(async (data) => {
          const logItem = data.log.find((l) => l.id === body.logId && l.action === "delete" && l.full);
          if (!logItem) return { error: "Ne mogu da nađem obrisanu stavku.", status: 404 };
          if (data.entries.some((e) => e.id === logItem.full.id)) return { error: "Stavka je već vraćena.", status: 409 };
          data.entries.push(logItem.full);
          data.log.push({ id: crypto.randomUUID(), at: now, by: me, action: "restore", after: pick(logItem.full) });
          return { entry: logItem.full };
        });
        if (out.error) return json({ error: out.error }, out.status || 400);
        await discord(req, { action: "restore", by: me, entry: out.result.entry, entries: out.data.entries });
        return json({ ok: true, version: out.data.version });
      }
    }

    return json({ error: "Nepoznata ruta." }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: "Greška na serveru: " + (err?.message || err) }, 500);
  }
};
