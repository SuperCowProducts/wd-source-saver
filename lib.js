// Shared helpers (used by the background service worker and the options page)

export const SEPARATORS = { hyphen: "-", underscore: "_", plus: "+", space: "%20", none: "" };

export const stripProto = u =>
  String(u || "").trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^www\./i, "");

export function normUrl(u) {
  try {
    const x = new URL(u);
    return x.hostname.toLowerCase().replace(/^www\./, "") + x.pathname.replace(/\/+$/, "") + x.search + x.hash;
  } catch { return String(u).trim(); }
}
const sameUrlLoose = (a, b) => normUrl(a).toLowerCase() === normUrl(b).toLowerCase();

// ---------- templates ----------
export const usable = s => !!(s.qid || s.idProperty);

export const cleanTemplates = site =>
  (site.templates || []).map(t => t.trim()).filter(t => t.includes("{id}"));

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PH = /(\{[^{}]+\})/; // {id} {first} {FIRST} or a choice group {a|b|c}

function templateRegex(tpl) {
  const t = stripProto(tpl);
  let src = "", seenId = false;
  for (const part of t.split(PH)) {
    if (part === "{id}") { src += seenId ? "\\1" : "([^/?#]+)"; seenId = true; }
    else if (part === "{first}" || part === "{FIRST}") src += "[^/?#]+";
    else if (/^\{[^{}]*\|[^{}]*\}$/.test(part)) {
      src += "(?:" + part.slice(1, -1).split("|").map(x => esc(x.trim())).join("|") + ")";
    } else src += esc(part);
  }
  return { re: new RegExp("^" + src + "/?$", "i"), hasQuery: t.includes("?") };
}

export function effectiveMatch(site) {
  let m = (site.match || "").trim();
  if (!m) {
    const t = cleanTemplates(site)[0];
    if (t) m = stripProto(t).split(PH)[0].split("?")[0].replace(/\/$/, "");
  }
  return stripProto(m).toLowerCase();
}

export function splitWords(raw, sepKey) {
  if (sepKey === "none") {
    let d = raw;
    try { d = decodeURIComponent(raw); } catch { /* keep raw */ }
    return d.split(/(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean); // MonotonicFunction -> Monotonic, Function
  }
  const parts =
    sepKey === "hyphen" ? raw.split(/-+/) :
    sepKey === "underscore" ? raw.split(/_+/) :
    sepKey === "plus" ? raw.split(/\++/) :
    sepKey === "space" ? raw.split(/(?:%20|\+|\s)+/i) : [raw];
  return parts.map(p => { try { return decodeURIComponent(p); } catch { return p; } }).filter(Boolean);
}

export const DEFAULT_SMALL = "a, an, and, as, at, but, by, for, in, nor, of, on, or, the, to, up";
const smallSet = site => new Set(String(site.smallWords || DEFAULT_SMALL).toLowerCase().split(/[\s,;]+/).filter(Boolean));

function applyCase(words, mode, small = new Set()) {
  switch (mode) {
    case "upper": return words.map(w => w.toUpperCase());
    case "titlesmall": // Title Case, but small words (of, the, …) stay lowercase – except the first word
      return words.map((w, i) => i > 0 && small.has(w.toLowerCase())
        ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    case "title": return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    case "keep": return words;
    case "capitalize": return words.map((w, i) => i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase());
    default: return words.map(w => w.toLowerCase());
  }
}

// Encoded ID plus its first letter (for templates like /terms/{first}/{id}.asp)
export function idParts(words, site) {
  const cased = applyCase(words, site.caseMode || "lower", smallSet(site));
  const sep = SEPARATORS[site.separator || "hyphen"] ?? "-";
  const id = cased.map(encodeURIComponent).join(sep);
  const ch = (cased[0] || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").charAt(0);
  const dir = /\p{L}/u.test(ch) ? null : ((site.nonLetter || "").trim() || null);
  const rawSep = { hyphen: "-", underscore: "_", plus: " ", space: " ", none: "" }[site.separator || "hyphen"] ?? "-";
  return {
    id,
    raw: cased.join(rawSep), // un-encoded ID, used as the value of an external-ID property
    lower: dir ?? encodeURIComponent(ch.toLowerCase()),
    upper: dir ?? encodeURIComponent(ch.toUpperCase())
  };
}

function expandChoices(u) {
  const m = u.match(/\{([^{}]*\|[^{}]*)\}/);
  if (!m) return [u];
  return m[1].split("|").map(x => x.trim()).filter(Boolean)
    .flatMap(opt => expandChoices(u.replace(m[0], () => opt)));
}

// One template -> one URL, or several when it contains a {a|b|c} choice group
export function buildUrls(tpl, parts) {
  let u = tpl.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "https://" + u;
  u = u.split("{id}").join(parts.id).split("{first}").join(parts.lower).split("{FIRST}").join(parts.upper);
  return expandChoices(u);
}

// ---------- plural / singular guesses (English, last word only) ----------
const INVARIANT = /(ics|series|species)$/i;
export function altForms(word) {
  const w = word, l = w.toLowerCase();
  if (l.length < 3 || INVARIANT.test(l)) return [];
  const out = [];
  if (/s$/.test(l) && !/(ss|us|is)$/.test(l)) {            // looks plural -> singular guesses
    if (/ies$/.test(l)) out.push(w.slice(0, -3) + "y");
    if (/ices$/.test(l)) out.push(w.slice(0, -4) + "ix", w.slice(0, -4) + "ex");
    if (/(ses|xes|zes|ches|shes)$/.test(l)) out.push(w.slice(0, -2));
    if (/ses$/.test(l)) out.push(w.slice(0, -2) + "is");   // analyses -> analysis
    if (/ves$/.test(l)) out.push(w.slice(0, -3) + "f", w.slice(0, -3) + "fe");
    out.push(w.slice(0, -1));
  } else {                                                  // looks singular -> plural guesses
    if (/(s|x|z|ch|sh)$/.test(l)) out.push(w + "es");
    else if (/[^aeiou]y$/.test(l)) out.push(w.slice(0, -1) + "ies");
    else out.push(w + "s");
    if (/(ix|ex)$/.test(l)) out.push(w.slice(0, -2) + "ices");
    if (/is$/.test(l)) out.push(w.slice(0, -2) + "es");
    if (/um$/.test(l)) out.push(w.slice(0, -2) + "a");
    if (/us$/.test(l)) out.push(w.slice(0, -2) + "i");
    if (/fe?$/.test(l)) out.push(w.replace(/fe?$/i, "ves"));
  }
  return [...new Set(out)].filter(x => x.toLowerCase() !== l);
}

export function termForms(words, site) {
  if (!site.plurals || !words.length) return [words];
  const head = words.slice(0, -1);
  return [words, ...altForms(words[words.length - 1]).map(f => [...head, f])];
}

// "Theoremof" -> ["Theorem","of"]   (CamelCase IDs glue lowercase small words onto the previous word)
function splitGlued(chunk, small) {
  const out = [];
  let rest = chunk;
  for (;;) {
    const sw = small.find(w => rest.length - w.length >= 3 && rest.endsWith(w));
    if (!sw) break;
    out.unshift(sw);
    rest = rest.slice(0, rest.length - sw.length);
  }
  return [rest, ...out];
}

function wordVariants(words, site) {
  const base = [words];
  if ((site.separator || "hyphen") === "none" && site.caseMode === "titlesmall") {
    const small = [...smallSet(site)].filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
    // a title rarely ends in a small word, so never split the last chunk (Function != Functi+on)
    const split = words.flatMap((w, i) => i === words.length - 1 ? [w] : splitGlued(w, small));
    if (split.length !== words.length) base.push(split);
  }
  return base;
}

// ---------- which configured site is the current page? ----------
export function findCurrent(sites, tabUrl) {
  const u = new URL(tabUrl);
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = host + u.pathname;

  let best = null;
  for (const site of sites) {
    if (!usable(site)) continue;
    for (const tpl of cleanTemplates(site)) {
      const { re, hasQuery } = templateRegex(tpl);
      const m = (hasQuery ? path + u.search : path).match(re);
      if (m && (!best || tpl.length > best.score)) {
        let raw = m[1];
        if (site.separator === "plus") raw = raw.replace(/\+/g, " ");
        try { raw = decodeURIComponent(raw); } catch { /* keep */ }
        best = { site, score: tpl.length,
          extracted: { template: tpl, raw, words: splitWords(m[1], site.separator || "hyphen") } };
        best.extracted.variants = wordVariants(best.extracted.words, site);
      }
    }
  }
  if (best) return { site: best.site, extracted: best.extracted };

  let bs = null, bl = -1;
  const hp = path.toLowerCase();
  for (const site of sites) {
    const m = effectiveMatch(site);
    if (!usable(site) || !m) continue;
    const ok = m.includes("/") ? hp.startsWith(m) : (host === m || host.endsWith("." + m));
    if (ok && m.length > bl) { bs = site; bl = m.length; }
  }
  return bs ? { site: bs, extracted: null } : null;
}

// ---------- candidates on related sites ----------
export function dedupeIds(ids) {
  const seen = new Set();
  return ids.filter(i => {
    if (!i.words.length) return false;
    const k = i.words.join(" ").toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

export function buildCandidates(sites, currentSite, ids, limit = 120) {
  const cat = (currentSite?.category || "").trim().toLowerCase();
  if (!cat) return [];
  const out = [], seen = new Set();
  for (const site of sites) {
    if (!usable(site) || (site.category || "").trim().toLowerCase() !== cat) continue;
    for (const tpl of cleanTemplates(site)) for (const id of ids) for (const words of termForms(id.words, site)) {
      const parts = idParts(words, site);
      for (const url of buildUrls(tpl, parts)) {
        const k = normUrl(url);
        if (seen.has(k) || out.length >= limit) continue;
        seen.add(k);
        out.push({ site, template: tpl, url, value: parts.raw });
      }
    }
  }
  return out;
}

export function originsFor(sites) {
  const set = new Set();
  if (sites.some(s => s.archive)) set.add("*://web.archive.org/*");
  for (const s of sites) for (const t of cleanTemplates(s)) {
    try {
      const h = new URL(buildUrls(t, { id: "x", raw: "x", lower: "x", upper: "X" })[0]).hostname;
      set.add(`*://${h}/*`);
      set.add(`*://${h.startsWith("www.") ? h.slice(4) : "www." + h}/*`);
    } catch { /* ignore bad templates */ }
  }
  return [...set];
}

// ---------- clipboard ----------
// "Q123"  |  "https://www.wikidata.org/wiki/Q123"  |  "Q123, use, use of property" (extra terms)
export function parseClipboard(text) {
  const m = (text || "").match(/\bQ\d+\b/i);
  if (!m) return null;
  const urlTok = (text.match(/\S*wikidata\.org\S*/i) || [])[0];
  const rest = text.replace(urlTok || m[0], " ");
  let extras = rest.split(/[,;\n\r]+/).map(s => s.trim().replace(/^["'“”]+|["'“”]+$/g, "")).filter(Boolean);
  extras = extras.filter(s => s.length <= 60).slice(0, 8);
  return { item: m[0].toUpperCase(), extras };
}

// ---------- does the page exist? ----------
export async function checkUrl(url, site, settings) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { redirect: "follow", credentials: "omit", signal: ctrl.signal });
    if (!res.ok) { res.body?.cancel(); return { found: false, reason: `HTTP ${res.status}` }; }
    let finalUrl = res.url || url;
    if (!sameUrlLoose(finalUrl, url)) {
      if (settings.redirects !== "accept") { res.body?.cancel(); return { found: false, reason: "redirected elsewhere" }; }
    }
    if (site.notFound && site.notFound.trim()) {
      const body = await res.text();
      try { if (new RegExp(site.notFound, "i").test(body)) return { found: false, reason: "matched 'not found' text" }; }
      catch { /* bad regex: ignore */ }
    } else res.body?.cancel();
    return { found: true, url: finalUrl.split("#")[0] };
  } catch (e) {
    return { found: false, reason: e.name === "AbortError" ? "timeout" : "network error" };
  } finally { clearTimeout(timer); }
}

// ---------- Wayback Machine ----------
export const tsToDate = ts => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;

// https://web.archive.org/web/20251102125306/https://example.org/x  ->  { timestamp, original }
export function unwrapArchive(u) {
  const m = String(u).match(/^https?:\/\/web\.archive\.org\/web\/(\d{4,14})(?:[a-z]{2}_)?\/(.+)$/i);
  if (!m) return null;
  let inner = m[2].replace(/^(https?):\/(?!\/)/i, "$1://");
  if (!/^https?:\/\//i.test(inner)) inner = "https://" + inner;
  return { timestamp: m[1], original: inner };
}

// Latest successful (HTTP 200) capture of a URL, via the Wayback CDX API
export async function waybackLatest(url) {
  const q = "https://web.archive.org/cdx/search/cdx?output=json&limit=-1&fl=timestamp,original&filter=statuscode:200&url=" +
    encodeURIComponent(url.split("#")[0]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(q, { credentials: "omit", signal: ctrl.signal });
      if (!res.ok) continue;
      const txt = (await res.text()).trim();
      if (!txt) return { found: false };
      const rows = JSON.parse(txt);               // [["timestamp","original"], ["2025…","https://…"]]
      const row = rows.length > 1 ? rows[rows.length - 1] : null;
      if (!row) return { found: false };
      const [ts, orig] = row;
      return { found: true, timestamp: ts, date: tsToDate(ts), url: `https://web.archive.org/web/${ts}/${orig}` };
    } catch { /* retry once */ } finally { clearTimeout(timer); }
  }
  return { found: false, error: true };
}
