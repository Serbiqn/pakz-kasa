// ================= Pakz Kasa — frontend =================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const USERS = { dusan: "Dušan", pavle: "Pavle" };
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

const store = {
  get(k, d) { try { const v = localStorage.getItem("pk_" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("pk_" + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem("pk_" + k); } catch {} },
};

const S = {
  token: store.get("token", null),
  me: store.get("me", null),
  entries: [],
  log: [],
  version: -1,
  cur: store.get("cur", "EUR"),
  sound: store.get("sound", true),
  rate: null,
  rates: {},
  filter: "all",
  q: "",
  editing: null,
  eCur: "EUR",
};

// ================= format =================
const nf0 = new Intl.NumberFormat("sr-Latn-RS", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("sr-Latn-RS", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const nfRate = new Intl.NumberFormat("sr-Latn-RS", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const fmtEUR = (n) => `${Math.abs(n) >= 1000 ? nf0.format(Math.round(n)) : nf2.format(Math.round(n * 100) / 100)} €`;
const fmtRSD = (n) => `${nf0.format(Math.round(n))} RSD`;
const fmt = (eur, rsd, cur = S.cur) => (cur === "EUR" ? fmtEUR(eur) : fmtRSD(rsd));
const fmtAlt = (eur, rsd) => (S.cur === "EUR" ? fmtRSD(rsd) : fmtEUR(eur));
const signed = (s, n) => (n < 0 ? "−" + s.replace("-", "") : s);
const dShort = (iso) => new Intl.DateTimeFormat("sr-Latn-RS", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso + "T12:00:00"));
const monthName = (ym) => new Intl.DateTimeFormat("sr-Latn-RS", { month: "long", year: "numeric" }).format(new Date(ym + "-15T12:00:00"));
const monthShort = (ym) => new Intl.DateTimeFormat("sr-Latn-RS", { month: "short" }).format(new Date(ym + "-15T12:00:00")).replace(".", "");
const todayISO = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Belgrade" }).format(new Date());
const timeAgo = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "upravo";
  if (s < 3600) return `pre ${Math.floor(s / 60)} min`;
  if (s < 86400) return `pre ${Math.floor(s / 3600)} h`;
  if (s < 7 * 86400) return `pre ${Math.floor(s / 86400)} d`;
  return new Intl.DateTimeFormat("sr-Latn-RS", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (id) => `<svg><use href="#i-${id}"/></svg>`;
const parseNum = (v) => Number(String(v ?? "").trim().replace(/\s/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));

// ================= API =================
async function api(path, opts = {}) {
  const res = await fetch("/api/" + path, {
    ...opts,
    headers: { "content-type": "application/json", ...(S.token ? { authorization: "Bearer " + S.token } : {}), ...(opts.headers || {}) },
  });
  if (res.status === 401 && path !== "login") { logout(true); throw new Error("Sesija je istekla, uloguj se ponovo."); }
  const isJson = (res.headers.get("content-type") || "").includes("json");
  const body = isJson ? await res.json() : await res.blob();
  if (!res.ok) throw new Error(body?.error || `Greška (${res.status})`);
  return body;
}

// ================= calculations =================
function compute(entries) {
  const z = () => ({ eur: 0, rsd: 0 });
  const c = { inc: z(), shared: z(), pd: z(), pp: z(), count: 0, students: new Set(), maxInc: null, months: {} };
  for (const e of entries) {
    const ym = e.date.slice(0, 7);
    const m = (c.months[ym] ||= { inEur: 0, inRsd: 0, outEur: 0, outRsd: 0 });
    if (e.type === "income") {
      c.inc.eur += e.eur; c.inc.rsd += e.rsd; c.count++;
      if (e.student) c.students.add(e.student.toLowerCase());
      if (!c.maxInc || e.eur > c.maxInc.eur) c.maxInc = e;
      m.inEur += e.eur; m.inRsd += e.rsd;
    } else {
      const t = e.type === "shared" ? c.shared : e.person === "dusan" ? c.pd : c.pp;
      t.eur += e.eur; t.rsd += e.rsd;
      m.outEur += e.eur; m.outRsd += e.rsd;
    }
  }
  const share = (p) => ({
    eur: c.inc.eur / 2 - c.shared.eur / 2 - p.eur,
    rsd: c.inc.rsd / 2 - c.shared.rsd / 2 - p.rsd,
  });
  c.dusan = share(c.pd);
  c.pavle = share(c.pp);
  c.pot = { eur: c.dusan.eur + c.pavle.eur, rsd: c.dusan.rsd + c.pavle.rsd };
  c.personal = { eur: c.pd.eur + c.pp.eur, rsd: c.pd.rsd + c.pp.rsd };
  const ms = Object.entries(c.months);
  c.bestMonth = ms.reduce((b, [k, v]) => (!b || v.inEur > b[1].inEur ? [k, v] : b), null);
  return c;
}

// ================= levels + achievements =================
const LEVELS = [
  { at: 0, name: "Start", color: "#9a93bb", icon: "zap" },
  { at: 500, name: "Bronza", color: "#e0975a", icon: "gem" },
  { at: 1000, name: "Srebro", color: "#cfd6e6", icon: "gem" },
  { at: 2500, name: "Zlato", color: "#ffc94d", icon: "gem" },
  { at: 5000, name: "Platina", color: "#8fe3ff", icon: "gem" },
  { at: 10000, name: "Dijamant", color: "#7dc3ff", icon: "gem" },
  { at: 25000, name: "Elita", color: "#c08bff", icon: "crown" },
  { at: 50000, name: "Legenda", color: "#ff8fd0", icon: "crown" },
  { at: 100000, name: "Pakz Imperija", color: "#ffe08a", icon: "crown" },
];
const levelOf = (eur) => {
  let i = 0;
  while (i + 1 < LEVELS.length && eur >= LEVELS[i + 1].at) i++;
  return { i, cur: LEVELS[i], next: LEVELS[i + 1] || null };
};
const ACH = [
  { id: "first", name: "Prva uplata", desc: "Prva zarada upisana", icon: "star", test: (c) => c.count >= 1 },
  { id: "five", name: "5 učenika", desc: "5 različitih učenika", icon: "graduation", test: (c) => c.students.size >= 5 },
  { id: "ten", name: "10 uplata", desc: "Deset zarada", icon: "flame", test: (c) => c.count >= 10 },
  { id: "fish", name: "Velika riba", desc: "Uplata od 150 €+", icon: "fish", test: (c) => (c.maxInc?.eur || 0) >= 150 },
  { id: "k1", name: "1.000 € klub", desc: "Ukupno 1.000 €", icon: "trophy", test: (c) => c.inc.eur >= 1000 },
  { id: "month1k", name: "Mesec od 1.000", desc: "1.000 € u jednom mesecu", icon: "rocket", test: (c) => (c.bestMonth?.[1].inEur || 0) >= 1000 },
  { id: "twentyfive", name: "25 uplata", desc: "Dvadeset pet zarada", icon: "target", test: (c) => c.count >= 25 },
  { id: "k5", name: "5.000 €", desc: "Ukupno 5.000 €", icon: "crown", test: (c) => c.inc.eur >= 5000 },
  { id: "k10", name: "10K", desc: "Ukupno 10.000 €", icon: "gem", test: (c) => c.inc.eur >= 10000 },
];
const unlockedSet = (c) => new Set(ACH.filter((a) => a.test(c)).map((a) => a.id));

// ================= count-up =================
function countTo(el, to, format, dur = 1100) {
  const from = Number(el.dataset.v ?? 0);
  el.dataset.v = to;
  if (REDUCED || from === to) { el.textContent = format(to); return; }
  const t0 = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 4);
  cancelAnimationFrame(el._raf);
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    el.textContent = format(from + (to - from) * ease(p));
    if (p < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}
const bump = (el) => { if (!el || REDUCED) return; el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); };

// ================= render =================
function render() {
  const c = compute(S.entries);
  S.calc = c;
  renderTop();
  renderHero(c);
  renderSplit(c);
  renderStats(c);
  renderChart(c);
  renderAch(c);
  renderRecent();
  renderHistory();
  renderLog();
}

function renderTop() {
  $("#meAvatar").textContent = USERS[S.me]?.[0] || "?";
  $("#meAvatar").className = "avatar sm " + S.me;
  $("#meName").textContent = USERS[S.me] || "";
  $$(".topbar .cur-toggle button").forEach((b) => b.classList.toggle("active", b.dataset.cur === S.cur));
  $("#soundBtn").innerHTML = icon(S.sound ? "volume" : "mute");
  $("#soundBtn").setAttribute("aria-label", S.sound ? "Isključi zvuk" : "Uključi zvuk");
  if (S.rate) {
    $("#rateChip span").innerHTML = `1 € = <b>${nfRate.format(S.rate.middle)}</b> RSD <small>· NBS</small>`;
    $("#rateChip").title = `NBS srednji kurs za ${dShort(S.rate.rateDate)}${S.rate.stale ? " (poslednji poznat)" : ""}`;
  }
}

function renderHero(c) {
  const main = S.cur === "EUR" ? c.inc.eur : c.inc.rsd;
  countTo($("#totalMain"), main, (v) => fmt(v, v));
  countTo($("#totalSub"), S.cur === "EUR" ? c.inc.rsd : c.inc.eur, (v) => (S.cur === "EUR" ? fmtRSD(v) : fmtEUR(v)));
  const ym = todayISO().slice(0, 7);
  const m = c.months[ym];
  $("#monthPill").innerHTML = m?.inEur ? `${icon("trend")} +${fmt(m.inEur, m.inRsd)} ovog meseca` : "";

  const L = levelOf(c.inc.eur);
  const badge = $("#levelBadge");
  badge.style.setProperty("--lvl", L.cur.color);
  badge.innerHTML = `${icon(L.cur.icon)}<span>Nivo ${L.i + 1} · ${L.cur.name}</span>`;
  if (L.next) {
    const span = L.next.at - L.cur.at;
    const pct = Math.max(2, Math.min(100, ((c.inc.eur - L.cur.at) / span) * 100));
    requestAnimationFrame(() => ($("#xpFill").style.width = pct + "%"));
    const left = L.next.at - c.inc.eur;
    $("#levelNext").innerHTML = `Još <b>${fmtEUR(left)}</b> do nivoa <b style="color:${L.next.color}">${L.next.name}</b>`;
    $("#levelSteps").innerHTML = `<span>${fmtEUR(L.cur.at)}</span><span>${Math.floor(pct)}%</span><span>${fmtEUR(L.next.at)}</span>`;
  } else {
    $("#xpFill").style.width = "100%";
    $("#levelNext").innerHTML = `<b>Maksimalni nivo!</b>`;
    $("#levelSteps").innerHTML = "";
  }

  countTo($("#potMain"), S.cur === "EUR" ? c.pot.eur : c.pot.rsd, (v) => signed(fmt(v, v), v));
  countTo($("#potSub"), S.cur === "EUR" ? c.pot.rsd : c.pot.eur, (v) => signed(S.cur === "EUR" ? fmtRSD(v) : fmtEUR(v), v));
  $("#potIn").textContent = "+" + fmt(c.inc.eur, c.inc.rsd);
  $("#potShared").textContent = (c.shared.eur ? "−" : "") + fmt(c.shared.eur, c.shared.rsd);
  $("#potPersonal").textContent = (c.personal.eur ? "−" : "") + fmt(c.personal.eur, c.personal.rsd);
}

function renderSplit(c) {
  for (const [p, card] of [["dusan", "#cardDusan"], ["pavle", "#cardPavle"]]) {
    const s = c[p], own = p === "dusan" ? c.pd : c.pp, el = $(card);
    if (!el.dataset.built) {
      el.innerHTML = `
        <div class="person-head"><span class="avatar">${USERS[p][0]}</span>
          <div><div class="person-name">${USERS[p]}</div><div class="person-role">${p === S.me ? "Ti" : "Partner"} · 50%</div></div></div>
        <div class="person-amount" data-k="amt">0 €</div>
        <div class="person-sub" data-k="sub">0 RSD</div>
        <ul class="person-lines" data-k="lines"></ul>
        <div data-k="warn"></div>`;
      el.dataset.built = 1;
    }
    $('[data-k="amt"]', el).dataset.v ??= 0;
    countTo($('[data-k="amt"]', el), S.cur === "EUR" ? s.eur : s.rsd, (v) => signed(fmt(v, v), v));
    countTo($('[data-k="sub"]', el), S.cur === "EUR" ? s.rsd : s.eur, (v) => signed(S.cur === "EUR" ? fmtRSD(v) : fmtEUR(v), v));
    const line = (label, eur, rsd, cls, sign) =>
      `<li><span>${label}</span><b class="${cls}">${eur ? sign : ""}${fmt(eur, rsd)}<small>${fmtAlt(eur, rsd)}</small></b></li>`;
    $('[data-k="lines"]', el).innerHTML =
      line("Pola zarade", c.inc.eur / 2, c.inc.rsd / 2, "pos", "+") +
      line("Pola zajedničkih troškova", c.shared.eur / 2, c.shared.rsd / 2, "neg", "−") +
      line("Lični troškovi / isplate", own.eur, own.rsd, "neg", "−");
    $('[data-k="warn"]', el).innerHTML = s.eur < -0.01
      ? `<div class="negative-warn">${USERS[p]} duguje ${fmt(-s.eur, -s.rsd)} kasi</div>` : "";
  }
  const a = Math.max(0, c.dusan.eur), b = Math.max(0, c.pavle.eur), t = a + b;
  $("#sbD").style.width = (t ? (a / t) * 100 : 50) + "%";
  $("#sbP").style.width = (t ? (b / t) * 100 : 50) + "%";
}

function renderStats(c) {
  const avg = c.count ? { eur: c.inc.eur / c.count, rsd: c.inc.rsd / c.count } : { eur: 0, rsd: 0 };
  const best = c.bestMonth;
  const tiles = [
    ["si-green", "trend", c.count, "uplata ukupno"],
    ["si-blue", "graduation", c.students.size, "različitih učenika"],
    ["si-violet", "target", fmt(avg.eur, avg.rsd), "prosečna uplata"],
    ["si-gold", "trophy", best ? fmt(best[1].inEur, best[1].inRsd) : "—", best ? `rekord · ${monthName(best[0])}` : "rekordni mesec"],
  ];
  $("#stats").innerHTML = tiles.map(([cls, ic, v, l]) =>
    `<div class="stat glass reveal"><span class="stat-icon ${cls}">${icon(ic)}</span><div><div class="stat-v">${v}</div><div class="stat-l">${l}</div></div></div>`).join("");
}

function renderChart(c) {
  const keys = Object.keys(c.months).sort();
  if (!keys.length) { $("#chart").innerHTML = `<div class="chart-empty">Još nema podataka</div>`; return; }
  // poslednjih 8 meseci, popuni praznine
  const last = keys[keys.length - 1];
  const list = [];
  let [y, m] = last.split("-").map(Number);
  const first = keys[0];
  for (let i = 0; i < 8; i++) {
    const k = `${y}-${String(m).padStart(2, "0")}`;
    list.unshift(k);
    if (k <= first && list.length >= 4) break;
    m--; if (!m) { m = 12; y--; }
  }
  const max = Math.max(1, ...list.map((k) => Math.max(c.months[k]?.inEur || 0, c.months[k]?.outEur || 0)));
  const bestK = c.bestMonth?.[0];
  $("#chart").innerHTML = list.map((k) => {
    const v = c.months[k] || { inEur: 0, inRsd: 0, outEur: 0, outRsd: 0 };
    const label = S.cur === "EUR" ? fmtEUR(v.inEur) : nf0.format(Math.round(v.inRsd / 1000)) + "k";
    return `<div class="bar-col ${k === bestK ? "best" : ""}" title="${monthName(k)}: +${fmt(v.inEur, v.inRsd)}${v.outEur ? ` / −${fmt(v.outEur, v.outRsd)}` : ""}">
      <div class="bar-stack">
        <div class="bar in" data-h="${(v.inEur / max) * 100}">${v.inEur ? `<span class="bar-val">${label}</span>` : ""}</div>
        ${v.outEur ? `<div class="bar out" data-h="${(v.outEur / max) * 100}"></div>` : ""}
      </div>
      <span class="bar-label">${monthShort(k)}</span></div>`;
  }).join("");
  requestAnimationFrame(() => requestAnimationFrame(() =>
    $$("#chart .bar").forEach((b, i) => setTimeout(() => (b.style.height = Math.max(2, b.dataset.h) + "%"), i * 60))));
}

function renderAch(c) {
  const on = unlockedSet(c);
  $("#achCount").textContent = `${on.size} / ${ACH.length}`;
  $("#achievements").innerHTML = ACH.map((a) =>
    `<div class="ach ${on.has(a.id) ? "on" : "off"}" title="${esc(a.desc)}">
      <div class="ach-ic">${icon(on.has(a.id) ? a.icon : "lock")}</div><b>${a.name}</b><small>${a.desc}</small></div>`).join("");
}

const sorted = () => [...S.entries].sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || "").localeCompare(a.createdAt || ""));

function entryTitle(e) {
  if (e.type === "income") return e.student ? esc(e.student) : e.note ? esc(e.note) : "Zarada";
  if (e.type === "shared") return e.note ? esc(e.note) : "Zajednički trošak";
  return e.note ? esc(e.note) : `Za ${USERS[e.person] === "Dušan" ? "Dušana" : "Pavla"}`;
}
function entryRow(e) {
  const ic = e.type === "income" ? "trend" : e.type === "shared" ? "users" : "user";
  const sign = e.type === "income" ? "+" : "−";
  const cls = e.type === "income" ? "pos" : "neg";
  const meta = [dShort(e.date)];
  if (e.type === "income" && e.student && e.note) meta.push(esc(e.note));
  if (e.type === "personal") meta.push(`lično · ${USERS[e.person]}`);
  if (e.type === "shared") meta.push("pola-pola");
  const tag = e.tag ? `<span class="tag ${e.tag === "kompletna edukacija" ? "full" : ""}">${esc(e.tag)}</span>` : "";
  const orig = e.currency === "RSD" && S.cur === "EUR" ? fmtRSD(e.rsd) : e.currency === "EUR" && S.cur === "RSD" ? fmtEUR(e.eur) : fmtAlt(e.eur, e.rsd);
  return `<li class="entry" data-id="${e.id}" tabindex="0" role="button" aria-label="Izmeni stavku">
    <span class="entry-ic ${e.type} ${e.person || ""}">${icon(ic)}</span>
    <div class="entry-main"><div class="entry-title">${entryTitle(e)}</div><div class="entry-meta">${meta.join(" · ")} ${tag}</div></div>
    <div class="entry-amt"><b class="${cls}">${sign}${fmt(e.eur, e.rsd)}</b><small>${orig}</small></div></li>`;
}

function renderRecent() {
  const list = sorted().slice(0, 6);
  $("#recent").innerHTML = list.length ? list.map(entryRow).join("")
    : `<li class="empty"><b>Kasa je prazna</b>Klikni „Dodaj“ i upiši prvu zaradu — ili <label class="link" for="importFile" style="cursor:pointer">učitaj backup fajl</label>.</li>`;
}

function matches(e) {
  const f = S.filter;
  if (f === "income" && e.type !== "income") return false;
  if (f === "shared" && e.type !== "shared") return false;
  if (f.startsWith("personal-") && !(e.type === "personal" && e.person === f.split("-")[1])) return false;
  if (S.q) {
    const hay = `${e.student} ${e.note} ${e.tag} ${e.amount}`.toLowerCase();
    if (!hay.includes(S.q.toLowerCase())) return false;
  }
  return true;
}
function renderHistory() {
  const list = sorted().filter(matches);
  if (!list.length) { $("#historyList").innerHTML = `<div class="card glass empty"><b>Ništa nije nađeno</b>Promeni filter ili pretragu.</div>`; return; }
  const groups = {};
  for (const e of list) (groups[e.date.slice(0, 7)] ||= []).push(e);
  $("#historyList").innerHTML = Object.entries(groups).map(([ym, es]) => {
    const inc = es.filter((e) => e.type === "income");
    const out = es.filter((e) => e.type !== "income");
    const sum = (a, k) => a.reduce((s, e) => s + e[k], 0);
    return `<article class="card glass month-group">
      <div class="month-head"><h3>${monthName(ym)}</h3>
        <span><b>+${fmt(sum(inc, "eur"), sum(inc, "rsd"))}</b>${out.length ? ` · −${fmt(sum(out, "eur"), sum(out, "rsd"))}` : ""}</span></div>
      <ul class="entries">${es.map(entryRow).join("")}</ul></article>`;
  }).join("");
}

function describe(x) {
  if (!x) return "";
  const amt = `${x.type === "income" ? "+" : "−"}${x.currency === "EUR" ? fmtEUR(x.amount) : fmtRSD(x.amount)}`;
  const what = x.type === "income" ? "zaradu" : x.type === "shared" ? "zajednički trošak" : `lični trošak (${USERS[x.person]})`;
  const who = x.student || x.note;
  return `${what} <b>${amt}</b>${who ? ` · ${esc(who)}` : ""}`;
}
function renderLog() {
  if (!S.log.length) { $("#timeline").innerHTML = `<li class="empty"><b>Još nema promena</b>Ovde će se videti ko je šta dodao, izmenio ili obrisao.</li>`; return; }
  const ids = new Set(S.entries.map((e) => e.id));
  const verbs = { add: "je dodao", edit: "je izmenio", delete: "je obrisao", restore: "je vratio", import: "je vratio backup" };
  $("#timeline").innerHTML = S.log.map((l) => {
    let diff = "";
    if (l.action === "edit" && l.before && l.after) {
      const ch = [];
      const f = { amount: "iznos", currency: "valuta", date: "datum", note: "beleška", student: "učenik", tag: "tag", type: "tip", person: "osoba" };
      for (const k of Object.keys(f)) if ((l.before[k] ?? "") !== (l.after[k] ?? "")) ch.push(`${f[k]}: <s>${esc(l.before[k] || "—")}</s> → ${esc(l.after[k] || "—")}`);
      diff = ch.length ? `<div class="tl-diff">${ch.join(" · ")}</div>` : "";
    }
    const undo = l.action === "delete" && l.before && !ids.has(l.before.id)
      ? ` <button class="link" data-restore="${l.id}">${icon("undo")} Vrati</button>` : "";
    const body = l.action === "import" ? esc(l.summary || "") : describe(l.after || l.before);
    return `<li class="tl"><span class="avatar sm ${l.by}">${USERS[l.by]?.[0] || "?"}</span>
      <div class="tl-body"><div class="tl-text"><b>${USERS[l.by] || l.by}</b> <span class="act ${l.action}">${verbs[l.action] || l.action}</span> ${body}${undo}</div>${diff}
      <div class="tl-time">${timeAgo(l.at)}</div></div></li>`;
  }).join("");
}

// ================= sound + confetti =================
let actx;
function sound(kind = "coin") {
  if (!S.sound) return;
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    const t = actx.currentTime;
    const notes = kind === "coin" ? [[987.8, 0], [1318.5, 0.08]] : kind === "level" ? [[523.3, 0], [659.3, 0.1], [784, 0.2], [1046.5, 0.3]] : [[440, 0], [330, 0.09]];
    for (const [f, d] of notes) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = kind === "soft" ? "sine" : "triangle";
      o.frequency.setValueAtTime(f, t + d);
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(kind === "soft" ? 0.08 : 0.18, t + d + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + (kind === "level" ? 0.5 : 0.35));
      o.connect(g).connect(actx.destination);
      o.start(t + d); o.stop(t + d + 0.6);
    }
  } catch {}
}

const cv = $("#confetti"), cx = cv.getContext("2d");
let parts = [], running = false;
function confetti(power = 1, origin) {
  if (REDUCED) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const colors = ["#45b4ef", "#5a7af2", "#8a46f5", "#c08bff", "#ffc94d", "#3ee0a1", "#ffffff"];
  const n = Math.round(90 * power);
  const ox = origin?.x ?? innerWidth / 2, oy = origin?.y ?? innerHeight * 0.35;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = 5 + Math.random() * 9 * Math.min(1.6, power);
    parts.push({
      x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 6, g: 0.28 + Math.random() * 0.1,
      w: 6 + Math.random() * 6, h: 4 + Math.random() * 6, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
      c: colors[(Math.random() * colors.length) | 0], life: 0, max: 90 + Math.random() * 60, coin: Math.random() < 0.18,
    });
  }
  if (!running) { running = true; requestAnimationFrame(tick); }
}
function tick() {
  cx.clearRect(0, 0, innerWidth, innerHeight);
  parts = parts.filter((p) => p.life < p.max && p.y < innerHeight + 40);
  for (const p of parts) {
    p.life++; p.vx *= 0.985; p.vy = p.vy * 0.985 + p.g; p.x += p.vx; p.y += p.vy; p.r += p.vr;
    cx.save(); cx.globalAlpha = Math.min(1, (p.max - p.life) / 30); cx.translate(p.x, p.y); cx.rotate(p.r);
    if (p.coin) {
      cx.fillStyle = "#ffc94d"; cx.beginPath(); cx.ellipse(0, 0, 6, 6 * Math.abs(Math.cos(p.r * 2)) + 0.5, 0, 0, Math.PI * 2); cx.fill();
    } else { cx.fillStyle = p.c; cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r))); }
    cx.restore();
  }
  if (parts.length) requestAnimationFrame(tick); else { running = false; cx.clearRect(0, 0, innerWidth, innerHeight); }
}

// ================= toasts =================
function toast(title, sub = "", kind = "ok", ic = "check", action) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="toast-ic">${icon(ic)}</span><div><b>${title}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  if (action) {
    const b = document.createElement("button");
    b.className = "link"; b.textContent = action.label;
    b.onclick = () => { action.run(); close(); };
    el.appendChild(b);
  }
  $("#toasts").appendChild(el);
  const close = () => { el.classList.add("out"); setTimeout(() => el.remove(), 300); };
  setTimeout(close, action ? 7000 : kind === "gold" ? 5200 : 3600);
}

// ================= state sync =================
function setSync(state, text) {
  const el = $("#sync");
  el.className = "sync " + (state || "");
  $("span", el).textContent = text || (state === "busy" ? "Čuvam…" : state === "err" ? "Nema veze" : "Sinhronizovano");
}

async function loadState({ silent, local } = {}) {
  if (!silent) setSync("busy", "Učitavam…");
  try {
    const st = await api("state");
    const changed = st.version !== S.version;
    const prevIds = new Set(S.entries.map((e) => e.id));
    const firstLoad = S.version === -1;
    const before = !firstLoad && changed ? compute(S.entries) : null;
    S.entries = st.entries; S.log = st.log; S.version = st.version;
    if (changed) {
      render();
      if (before && !local) announceRemote(prevIds, before);
    }
    setSync();
  } catch (e) {
    setSync("err");
    if (!silent) toast("Ne mogu da učitam podatke", esc(e.message), "err", "alert");
  }
}

// kada partner nešto doda — vidiš odmah
function announceRemote(prevIds, before) {
  const fresh = S.entries.filter((e) => !prevIds.has(e.id) && e.createdBy !== S.me);
  for (const e of fresh) {
    if (e.type === "income") {
      toast(`${USERS[e.createdBy]} je dodao +${fmt(e.eur, e.rsd)}`, e.student ? esc(e.student) : "Nova zarada", "ok", "trend");
      confetti(0.6); sound("coin");
    } else toast(`${USERS[e.createdBy]} je upisao trošak`, `−${fmt(e.eur, e.rsd)}`, "info", "activity");
  }
  celebrateProgress(before, S.calc);
}

function celebrateProgress(before, after) {
  const L0 = levelOf(before.inc.eur), L1 = levelOf(after.inc.eur);
  if (L1.i > L0.i) {
    setTimeout(() => { toast(`Novi nivo: ${L1.cur.name}!`, `Ukupno ${fmtEUR(after.inc.eur)} zarađeno`, "gold", L1.cur.icon); confetti(2.2); sound("level"); bump($("#levelBadge")); }, 700);
  }
  const a0 = unlockedSet(before), a1 = unlockedSet(after);
  let delay = 900;
  for (const a of ACH) if (a1.has(a.id) && !a0.has(a.id)) {
    setTimeout(() => { toast(`Otključano: ${a.name}`, a.desc, "gold", a.icon); confetti(1.2, { x: innerWidth * 0.75, y: innerHeight * 0.6 }); sound("level"); }, delay);
    delay += 1300;
  }
}

// ================= modal =================
async function rateFor(date) {
  if (S.rates[date]) return S.rates[date];
  const r = await api("rate?date=" + date);
  S.rates[date] = r;
  return r;
}

function openModal(entry) {
  S.editing = entry || null;
  const f = $("#entryForm");
  f.reset();
  $("#formError").textContent = "";
  $("#sheetTitle").textContent = entry ? "Izmeni stavku" : "Nova stavka";
  $("#deleteBtn").hidden = !entry;
  $("#deleteBtn").dataset.confirm = "";
  $("#deleteBtn").innerHTML = `${icon("trash")}Obriši`;
  $(`input[name="type"][value="${entry?.type || "income"}"]`).checked = true;
  if (entry?.person) $(`input[name="person"][value="${entry.person}"]`).checked = true;
  $("#amount").value = entry ? nf2.format(entry.amount).replace(/\./g, "") : "";
  $("#date").value = entry?.date || todayISO();
  $("#student").value = entry?.student || "";
  $("#note").value = entry?.note || "";
  S.eCur = entry?.currency || store.get("lastCur", "EUR");
  S.tag = entry?.tag || "";
  S.manualRate = entry?.rateManual ? entry.rate : null;
  S.entryRate = entry ? { middle: entry.rate, rateDate: entry.rateDate } : null;
  $("#rateManual").hidden = !S.manualRate;
  $("#rateManual").value = S.manualRate ? nfRate.format(S.manualRate) : "";
  syncModal();
  $("#modal").hidden = false;
  document.body.style.overflow = "hidden";
  setTimeout(() => $("#amount").focus(), 60);
  updateRate();
}
function closeModal() {
  $("#modal").hidden = true;
  document.body.style.overflow = "";
  S.editing = null;
}
function syncModal() {
  const type = $('input[name="type"]:checked').value;
  $("#personRow").hidden = type !== "personal";
  $("#studentField").style.display = type === "income" ? "" : "none";
  $("#tagField").hidden = type !== "income";
  $("#note").placeholder = type === "income" ? "npr. preko PayPala" : type === "shared" ? "npr. reklame, alati…" : "npr. mikrofon, isplata…";
  $$("[data-ecur]").forEach((b) => b.classList.toggle("active", b.dataset.ecur === S.eCur));
  $$("#tagChips .chip").forEach((b) => b.classList.toggle("active", b.dataset.tag === S.tag));
  $("#saveBtn span").textContent = S.editing ? "Sačuvaj izmene" : type === "income" ? "Dodaj zaradu" : "Upiši trošak";
  updateConvert();
}
function currentRate() {
  if (S.manualRate) return S.manualRate;
  return S.entryRate?.middle || S.rate?.middle || 117.2;
}
function updateConvert() {
  const v = parseNum($("#amount").value);
  const r = currentRate();
  if (!(v > 0)) { $("#convert").innerHTML = `Upiši iznos u ${S.eCur === "EUR" ? "evrima" : "dinarima"}`; return; }
  const type = $('input[name="type"]:checked').value;
  const eur = S.eCur === "EUR" ? v : v / r, rsd = S.eCur === "RSD" ? v : v * r;
  const other = S.eCur === "EUR" ? fmtRSD(rsd) : fmtEUR(eur);
  const half = type === "personal" ? "" : ` · po <b>${S.eCur === "EUR" ? fmtEUR(eur / 2) : fmtRSD(rsd / 2)}</b> svakom`;
  $("#convert").innerHTML = `= <b>${other}</b>${half}`;
}
async function updateRate() {
  const date = $("#date").value || todayISO();
  if (S.manualRate) { $("#rateInfo").textContent = "Ručni kurs:"; $("#rateEditBtn").textContent = "Vrati NBS kurs"; updateConvert(); return; }
  $("#rateEditBtn").textContent = "Promeni kurs";
  // ako izmena zadržava isti datum, zadržava i zaključani kurs
  if (S.editing && S.editing.date === date && !S.editing.rateManual) {
    S.entryRate = { middle: S.editing.rate, rateDate: S.editing.rateDate };
  } else {
    $("#rateInfo").textContent = "Kurs: učitavam…";
    try { S.entryRate = await rateFor(date); } catch { S.entryRate = S.rate; }
  }
  const r = S.entryRate;
  $("#rateInfo").innerHTML = r ? `NBS srednji kurs (${dShort(r.rateDate || date)}) <b>1 € = ${nfRate.format(r.middle)} RSD</b>${r.stale ? " (poslednji poznat)" : ""}` : "Kurs nije dostupan";
  updateConvert();
}

async function saveEntry(ev) {
  ev.preventDefault();
  const type = $('input[name="type"]:checked').value;
  const amount = parseNum($("#amount").value);
  if (!(amount > 0)) { $("#formError").textContent = "Upiši iznos veći od nule."; $("#amount").focus(); return; }
  if (S.manualRate && !(S.manualRate > 50 && S.manualRate < 500)) { $("#formError").textContent = "Kurs nije ispravan."; return; }
  const entry = {
    type, amount, currency: S.eCur, date: $("#date").value || todayISO(),
    note: $("#note").value.trim(), student: type === "income" ? $("#student").value.trim() : "",
    tag: type === "income" ? S.tag : "", person: type === "personal" ? $('input[name="person"]:checked').value : undefined,
    rate: S.manualRate || undefined, rateManual: !!S.manualRate,
  };
  const btn = $("#saveBtn");
  btn.disabled = true; btn.classList.add("loading");
  setSync("busy");
  const before = compute(S.entries);
  const wasEdit = !!S.editing;
  try {
    if (wasEdit) await api("entries/" + S.editing.id, { method: "PUT", body: JSON.stringify({ entry }) });
    else await api("entries", { method: "POST", body: JSON.stringify({ entry }) });
    store.set("lastCur", S.eCur);
    closeModal();
    S.version = -2; // forsiraj render
    const prevIds = new Set(S.entries.map((e) => e.id));
    await loadState({ silent: true, local: true });
    const added = S.entries.find((e) => !prevIds.has(e.id));
    if (!wasEdit && added) celebrateAdd(added);
    else toast("Izmena sačuvana", "Upisano u istoriju promena", "ok", "check");
    celebrateProgress(before, S.calc);
  } catch (e) {
    $("#formError").textContent = e.message;
    setSync("err");
  } finally {
    btn.disabled = false; btn.classList.remove("loading");
  }
}
function celebrateAdd(e) {
  if (e.type === "income") {
    const half = fmt(e.eur / 2, e.rsd / 2);
    toast(`+${fmt(e.eur, e.rsd)} u kasi!`, `Dušan +${half} · Pavle +${half}`, "ok", "trend");
    confetti(Math.min(2, 0.8 + e.eur / 250)); sound("coin");
    bump($("#totalMain")); bump($("#cardDusan")); bump($("#cardPavle"));
  } else {
    const who = e.type === "shared" ? "Skinuto obojici pola-pola" : `Skinuto sa dela: ${USERS[e.person]}`;
    toast(`Trošak upisan: −${fmt(e.eur, e.rsd)}`, who, "info", e.type === "shared" ? "users" : "user");
    sound("soft");
    bump(e.type === "shared" ? $("#potMain") : $(e.person === "dusan" ? "#cardDusan" : "#cardPavle"));
  }
}

async function deleteEntry() {
  const btn = $("#deleteBtn");
  if (!btn.dataset.confirm) { btn.dataset.confirm = 1; btn.innerHTML = `${icon("trash")}Sigurno? Klikni opet`; return; }
  const id = S.editing.id;
  try {
    setSync("busy");
    await api("entries/" + id, { method: "DELETE" });
    closeModal();
    await loadState({ silent: true, local: true });
    const logItem = S.log.find((l) => l.action === "delete" && l.before?.id === id);
    toast("Stavka obrisana", "Sačuvana je u istoriji promena", "info", "trash",
      logItem ? { label: "Vrati", run: () => restore(logItem.id) } : null);
  } catch (e) { $("#formError").textContent = e.message; setSync("err"); }
}
async function restore(logId) {
  try {
    setSync("busy");
    await api("entries/restore", { method: "POST", body: JSON.stringify({ logId }) });
    await loadState({ silent: true, local: true });
    toast("Stavka vraćena", "", "ok", "undo");
  } catch (e) { toast("Ne mogu da vratim", esc(e.message), "err", "alert"); setSync(); }
}

// ================= auth =================
function showApp() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  scrollTo(0, 0);
  loadState();
  api("rate").then((r) => { S.rate = r; renderTop(); }).catch(() => {});
}
function logout(expired) {
  S.token = null; S.me = null; S.version = -1; S.entries = []; S.log = [];
  store.del("token"); store.del("me");
  $("#app").hidden = true; showLogin();
  $$("#cardDusan, #cardPavle").forEach((el) => { el.dataset.built = ""; el.innerHTML = ""; });
  if (expired) $("#loginError").textContent = "Sesija je istekla, uloguj se ponovo.";
}

$("#loginForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const user = $('#loginForm input[name="user"]:checked').value;
  const password = $("#password").value;
  const btn = $("#loginForm button[type=submit]");
  btn.disabled = true; $("#loginError").textContent = "";
  try {
    const r = await api("login", { method: "POST", body: JSON.stringify({ user, password }) });
    S.token = r.token; S.me = r.user;
    store.set("token", r.token); store.set("me", r.user); store.set("lastUser", r.user);
    $("#password").value = "";
    showApp();
    setTimeout(() => toast(`Zdravo, ${r.name}!`, "Dobrodošao u Pakz Kasu", "ok", "zap"), 400);
  } catch (e) {
    $("#loginError").textContent = e.message;
    $("#password").select();
  } finally { btn.disabled = false; }
});

// ================= events =================
$$(".tab").forEach((t) => t.addEventListener("click", () => goTab(t.dataset.tab)));
function goTab(name) {
  $$(".tab").forEach((t) => { t.classList.toggle("active", t.dataset.tab === name); t.setAttribute("aria-selected", t.dataset.tab === name); });
  $$(".tab-panel").forEach((p) => { const on = p.id === "tab-" + name; p.hidden = !on; p.classList.toggle("active", on); });
  scrollTo({ top: 0, behavior: REDUCED ? "auto" : "smooth" });
}
document.addEventListener("click", (ev) => {
  const go = ev.target.closest("[data-goto]");
  if (go) goTab(go.dataset.goto);
  const row = ev.target.closest(".entry[data-id]");
  if (row) openModal(S.entries.find((e) => e.id === row.dataset.id));
  const rs = ev.target.closest("[data-restore]");
  if (rs) restore(rs.dataset.restore);
  if (ev.target.closest("[data-close]")) closeModal();
  if (!ev.target.closest(".menu-wrap")) { $("#meMenu").hidden = true; $("#meBtn").setAttribute("aria-expanded", "false"); }
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !$("#mini").hidden) closeMini();
  else if (ev.key === "Escape" && !$("#modal").hidden) closeModal();
  if (ev.key === "Enter" && ev.target.matches(".entry[data-id]")) ev.target.click();
  if ((ev.key === "n" || ev.key === "N") && !ev.target.matches("input, textarea") && $("#modal").hidden && !$("#app").hidden) { ev.preventDefault(); openModal(); }
});

$("#fab").addEventListener("click", () => openModal());
$$(".topbar .cur-toggle button").forEach((b) => b.addEventListener("click", () => {
  S.cur = b.dataset.cur; store.set("cur", S.cur);
  $$("[data-v]").forEach((el) => delete el.dataset.v);
  render();
}));
$("#soundBtn").addEventListener("click", () => { S.sound = !S.sound; store.set("sound", S.sound); renderTop(); if (S.sound) sound("coin"); });
$("#meBtn").addEventListener("click", () => { const m = $("#meMenu"); m.hidden = !m.hidden; $("#meBtn").setAttribute("aria-expanded", String(!m.hidden)); });
$("#logoutBtn").addEventListener("click", () => logout());
// ---------- mali dijalog ----------
let miniSubmit = null;
function openMini(title, body, actions, onSubmit) {
  $("#meMenu").hidden = true;
  $("#miniTitle").textContent = title;
  $("#miniBody").innerHTML = body;
  $("#miniActions").innerHTML = actions;
  $("#miniError").textContent = "";
  miniSubmit = onSubmit;
  $("#mini").hidden = false;
  setTimeout(() => $("#miniBody input")?.focus(), 60);
}
const closeMini = () => { $("#mini").hidden = true; miniSubmit = null; };
$("#miniForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = ev.submitter || $("#miniActions .primary");
  if (!miniSubmit) return;
  btn && (btn.disabled = true);
  try { await miniSubmit(btn?.value || "save"); } catch (e) { $("#miniError").textContent = e.message; }
  finally { btn && (btn.disabled = false); }
});
document.addEventListener("click", (ev) => { if (ev.target.closest("[data-mini-close]")) closeMini(); });

$("#discordBtn").addEventListener("click", async () => {
  let st = { discord: false };
  try { st = await api("settings"); } catch {}
  openMini("Discord kanal", `
    <span class="status-pill ${st.discord ? "on" : "off"}">${st.discord ? `Povezano ${esc(st.discordHint || "")}` : "Nije povezano"}</span>
    <p class="mini-text">Svaka nova uplata, trošak, izmena i brisanje stiže u kanal, sa stanjem ko koliko ima.</p>
    ${st.discordFromEnv ? `<p class="mini-text">Link je podešen na Netlify-u.</p>` : `
    <ol class="mini-steps"><li>Discord kanal → ⚙️ Edit Channel → Integrations → Webhooks</li><li>New Webhook → <b>Copy Webhook URL</b></li><li>Nalepi ga ovde i sačuvaj</li></ol>
    <label class="field"><span class="field-label">Webhook link</span>
      <input id="hookInput" type="password" autocomplete="off" placeholder="${st.discord ? "Nalepi novi link da ga zameniš" : "https://discord.com/api/webhooks/…"}" /></label>`}`,
    `${st.discord ? `<button type="submit" class="btn ghost" value="test">${icon("zap")}Pošalji test</button>` : ""}
     ${st.discordFromEnv ? "" : `<button type="submit" class="btn primary grow" value="save"><span>Sačuvaj</span></button>`}`,
    async (action) => {
      if (action === "test") {
        await api("discord-test", { method: "POST", body: "{}" });
        toast("Discord radi", "Test poruka je poslata u kanal", "ok", "zap");
        return closeMini();
      }
      const v = $("#hookInput").value.trim();
      if (!v) throw new Error("Nalepi webhook link.");
      await api("settings", { method: "POST", body: JSON.stringify({ discordWebhook: v }) });
      await api("discord-test", { method: "POST", body: "{}" }).catch(() => {});
      closeMini();
      toast("Discord povezan", "Poslao sam test poruku u kanal", "ok", "zap"); confetti(0.7); sound("coin");
    });
});

$("#pwBtn").addEventListener("click", () => {
  openMini("Promeni šifru", `
    <p class="mini-text">Menjaš šifru za <b>${USERS[S.me]}</b>.</p>
    <label class="field"><span class="field-label">Trenutna šifra</span><input id="pwCur" type="password" autocomplete="current-password" /></label>
    <label class="field"><span class="field-label">Nova šifra</span><input id="pwNew" type="password" autocomplete="new-password" minlength="6" /></label>`,
    `<button type="submit" class="btn primary grow"><span>Sačuvaj šifru</span></button>`,
    async () => {
      await api("password", { method: "POST", body: JSON.stringify({ current: $("#pwCur").value, next: $("#pwNew").value }) });
      closeMini(); toast("Šifra promenjena", "Važi od sledećeg logina", "ok", "lock");
    });
});
$("#exportBtn").addEventListener("click", async () => {
  try {
    const blob = await api("export");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `pakz-kasa-backup-${todayISO()}.json`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast("Backup sačuvan", "JSON fajl je preuzet", "ok", "download");
  } catch (e) { toast("Backup nije uspeo", esc(e.message), "err", "alert"); }
});
$("#importFile").addEventListener("change", async (ev) => {
  const file = ev.target.files[0]; ev.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.entries)) throw new Error("Ovo nije Pakz Kasa backup.");
    if (!confirm(`Vratiti backup sa ${data.entries.length} stavki? Trenutni podaci biće zamenjeni (ostaju u istoriji promena).`)) return;
    await api("import", { method: "POST", body: JSON.stringify({ entries: data.entries }) });
    await loadState({ silent: true, local: true });
    toast("Backup vraćen", `${data.entries.length} stavki`, "ok", "upload");
  } catch (e) { toast("Ne mogu da vratim backup", esc(e.message), "err", "alert"); }
});

$$('input[name="type"]').forEach((r) => r.addEventListener("change", syncModal));
$$("[data-ecur]").forEach((b) => b.addEventListener("click", () => { S.eCur = b.dataset.ecur; syncModal(); $("#amount").focus(); }));
$$("#tagChips .chip").forEach((b) => b.addEventListener("click", () => { S.tag = S.tag === b.dataset.tag ? "" : b.dataset.tag; syncModal(); }));
$("#amount").addEventListener("input", updateConvert);
$("#date").addEventListener("change", updateRate);
$("#rateEditBtn").addEventListener("click", () => {
  if (S.manualRate) { S.manualRate = null; $("#rateManual").hidden = true; updateRate(); return; }
  S.manualRate = currentRate();
  $("#rateManual").hidden = false; $("#rateManual").value = nfRate.format(S.manualRate);
  $("#rateManual").focus(); $("#rateManual").select(); updateRate();
});
$("#rateManual").addEventListener("input", () => { S.manualRate = parseNum($("#rateManual").value) || null; updateConvert(); });
$("#entryForm").addEventListener("submit", saveEntry);
$("#deleteBtn").addEventListener("click", deleteEntry);
$$("#filterChips .chip").forEach((c) => c.addEventListener("click", () => {
  S.filter = c.dataset.f; $$("#filterChips .chip").forEach((x) => x.classList.toggle("active", x === c)); renderHistory();
}));
$("#search").addEventListener("input", (e) => { S.q = e.target.value.trim(); renderHistory(); });

// automatsko osvežavanje (da vidiš šta je partner upisao)
setInterval(() => { if (S.token && !document.hidden && $("#modal").hidden) loadState({ silent: true }); }, 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.token) loadState({ silent: true }); });
setInterval(() => { if (S.token && !$("#tab-log").hidden) renderLog(); }, 60000);

// ================= boot =================
const lastUser = store.get("lastUser", "dusan");
const lu = $(`#loginForm input[value="${lastUser}"]`); if (lu) lu.checked = true;
async function showLogin() {
  $("#login").hidden = false;
  try {
    const st = await api("setup");
    $("#setupForm").hidden = !st.needsSetup;
    $("#loginForm").hidden = !!st.needsSetup;
    $(".login-sub").textContent = st.needsSetup ? "Dobrodošao — još samo šifre i kasa je spremna" : "Zarada Pakz programa — Dušan & Pavle";
  } catch {}
}
$("#setupShow").addEventListener("change", (e) => { $("#setupDusan").type = $("#setupPavle").type = e.target.checked ? "text" : "password"; });
$("#setupForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const dusan = $("#setupDusan").value, pavle = $("#setupPavle").value;
  const btn = $("#setupForm button[type=submit]");
  $("#setupError").textContent = "";
  if (dusan.length < 6 || pavle.length < 6) { $("#setupError").textContent = "Svaka šifra mora imati bar 6 znakova."; return; }
  btn.disabled = true;
  try {
    await api("setup", { method: "POST", body: JSON.stringify({ dusan, pavle }) });
    const r = await api("login", { method: "POST", body: JSON.stringify({ user: "dusan", password: dusan }) });
    S.token = r.token; S.me = r.user;
    store.set("token", r.token); store.set("me", r.user); store.set("lastUser", r.user);
    $("#setupDusan").value = $("#setupPavle").value = "";
    $("#setupForm").hidden = true; $("#loginForm").hidden = false;
    showApp();
    setTimeout(() => { toast("Kasa je spremna!", "Šifre su postavljene", "gold", "crown"); confetti(1.4); sound("level"); }, 400);
  } catch (e) { $("#setupError").textContent = e.message; }
  finally { btn.disabled = false; }
});

if (S.token && S.me) showApp(); else showLogin();
