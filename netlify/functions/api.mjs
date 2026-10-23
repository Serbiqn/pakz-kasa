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
// Env promenljive (Netlify > Site configuration > Environment variables):
//   DUSAN_PASSWORD, PAVLE_PASSWORD, SESSION_SECRET (bilo koji dugačak random tekst)

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

function secret() {
  return env("SESSION_SECRET") || `${env("DUSAN_PASSWORD")}|${env("PAVLE_PASSWORD")}|pakz-kasa`;
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

// ---------- Handler ----------
export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const method = req.method;

  try {
    if (path === "login" && method === "POST") {
      const { user, password } = await req.json().catch(() => ({}));
      const u = USERS[user];
      const expected = u && env(u.env);
      if (!u) return json({ error: "Izaberi korisnika." }, 400);
      if (!expected) return json({ error: `Šifra za ${u.name} nije podešena na Netlify-u (${u.env}).` }, 500);
      if (!safeEqual(password || "", expected)) {
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

    if (path === "rate" && method === "GET") {
      return json(await getRate(url.searchParams.get("date")));
    }

    if (path === "state" && method === "GET") {
      const { data } = await load();
      return json({ version: data.version, entries: data.entries, log: data.log.slice(-300).reverse(), me });
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
          return { entry: e };
        });
        if (out.error) return json({ error: out.error }, out.status || 400);
        return json({ ok: true, entry: out.result.entry, version: out.data.version });
      }

      if (method === "DELETE" && id) {
        const out = await mutate(async (data) => {
          const i = data.entries.findIndex((e) => e.id === id);
          if (i < 0) return { error: "Stavka ne postoji.", status: 404 };
          const [prev] = data.entries.splice(i, 1);
          data.log.push({ id: crypto.randomUUID(), at: now, by: me, action: "delete", before: pick(prev), full: prev });
          return {};
        });
        if (out.error) return json({ error: out.error }, out.status || 400);
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
          return {};
        });
        if (out.error) return json({ error: out.error }, out.status || 400);
        return json({ ok: true, version: out.data.version });
      }
    }

    return json({ error: "Nepoznata ruta." }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: "Greška na serveru: " + (err?.message || err) }, 500);
  }
};
