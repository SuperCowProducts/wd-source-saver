// Shared helpers (used by the background service worker, the options page and the review page)

export const DEFAULTS = {
  related: true, redirects: "skip", labelLang: "en", username: "",
  review: "auto",          // auto = ask when more than reviewThreshold new statements or when anything came from a site search
  reviewThreshold: 3,
  maxPerEdit: 5,           // statements added in ONE edit
  minEditInterval: 60,     // seconds between edits (Wikimedia: unflagged bots should stay below 1 edit/minute)
  maxEditsPerHour: 30,
  useHistory: true, missTtlDays: 14,
  hostDelayMs: 1200,       // minimum gap between two requests to the same website
  maxPerSite: 30, maxTotal: 90
};

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


// a website can belong to several categories: "math, geometry"
export const cats = s => String(s.category || "").split(/[,;]/).map(x => x.trim().toLowerCase()).filter(Boolean);
export const sharesCat = (a, b) => { const cb = cats(b); return cats(a).some(c => cb.includes(c)); };

// A template line may start with the Wikidata property that stores its ID:
//   P9999 https://www.econlib.org/library/Enc/{id}.html      -> saved as  P9999: <id>
//   https://www.econlib.org/library/Topics/{a|b}/{id}.html   -> site's default property if set, else P1343 + P2699
//   P1343 https://…/{id}.html                                -> force the P1343 + P2699 fallback
const PFX = /^\s*(P\d+)\s+(?=\S)/i;
export function parseTemplates(site) {
  return (site.templates || []).map(l => String(l).trim()).filter(Boolean).map(l => {
    const m = l.match(PFX);
    return { tpl: m ? l.slice(m[0].length).trim() : l, prop: m ? m[1].toUpperCase() : null };
  }).filter(x => x.tpl.includes("{id}"));
}
export const cleanTemplates = site => parseTemplates(site).map(x => x.tpl);
export const siteDefaultProp = site => ((site.idProperty || "").match(/P\d+/i) || [""])[0].toUpperCase();
// property that stores the ID for this template ("" = fall back to P1343 + P2699)
export function templateProp(site, tpl) {
  const t = parseTemplates(site).find(x => x.tpl === tpl);
  const p = t && t.prop !== null ? t.prop : siteDefaultProp(site);
  return p === "P1343" ? "" : p;
}
export const usable = s => !!(s.qid || s.idProperty || parseTemplates(s).some(t => t.prop && t.prop !== "P1343"));
// for a URL that came from a search: which property + value? (value null = can't be read)
export function propForUrl(site, url) {
  const m = matchTemplates(site, url);
  if (m) return { prop: m.prop, value: m.raw };
  const prop = siteDefaultProp(site) === "P1343" ? "" : siteDefaultProp(site);
  return { prop, value: null };
}

// ---------- text helpers ----------
// Case-, accent- and punctuation-insensitive form of a text (ß->ss, Æ->ae, Ł->l …)
const FOLD = { "ß": "ss", "æ": "ae", "œ": "oe", "ø": "o", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "ı": "i" };
export const normText = s => String(s || "").toLowerCase()
  .replace(/[ßæœøłđðþı]/g, c => FOLD[c])
  .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// "PythagoreanTheorem" -> "Pythagorean Theorem" (capitals as word boundaries), then normalised
export const normTextCamel = s => normText(String(s || "").replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2"));

// A search/URL term must be a plain short phrase. Anything odd (symbols, formulas, very long) is dropped,
// so we never send junk to a website.
export function cleanTerm(t) {
  t = String(t || "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 60) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} '’\-.,]*$/u.test(t)) return null;
  const words = t.replace(/['’]/g, "").split(/[\s_\-]+/)
    .map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);
  if (!words.length || words.length > 6) return null;
  return { text: t, words };
}

// ---------- templates ----------
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
    else if (site.searchUrl) m = stripProto(site.searchUrl).split(PH)[0].split("/")[0];
  }
  return stripProto(m).toLowerCase();
}
export const siteHost = site => effectiveMatch(site).split("/")[0];

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
    case "titlesmall":
      return words.map((w, i) => i > 0 && small.has(w.toLowerCase())
        ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    case "title": return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    case "keep": return words;
    case "capitalize": return words.map((w, i) => i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase());
    default: return words.map(w => w.toLowerCase());
  }
}

// Encoded ID plus raw ID and first letter (for templates like /terms/{first}/{id}.asp)
export function idParts(words, site) {
  const cased = applyCase(words, site.caseMode || "lower", smallSet(site));
  const sep = SEPARATORS[site.separator || "hyphen"] ?? "-";
  const id = cased.map(encodeURIComponent).join(sep);
  const ch = (cased[0] || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").charAt(0);
  const dir = /\p{L}/u.test(ch) ? null : ((site.nonLetter || "").trim() || null);
  const rawSep = { hyphen: "-", underscore: "_", plus: " ", space: " ", none: "" }[site.separator || "hyphen"] ?? "-";
  return {
    id, raw: cased.join(rawSep),
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
  if (/s$/.test(l) && !/(ss|us|is)$/.test(l)) {
    if (/ies$/.test(l)) out.push(w.slice(0, -3) + "y");
    if (/ices$/.test(l)) out.push(w.slice(0, -4) + "ix", w.slice(0, -4) + "ex");
    if (/(ses|xes|zes|ches|shes)$/.test(l)) out.push(w.slice(0, -2));
    if (/ses$/.test(l)) out.push(w.slice(0, -2) + "is");
    if (/ves$/.test(l)) out.push(w.slice(0, -3) + "f", w.slice(0, -3) + "fe");
    out.push(w.slice(0, -1));
  } else {
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
  return [words, ...altForms(words[words.length - 1]).slice(0, 2).map(f => [...head, f])];
}

// ---------- which configured site is this URL? ----------
export function matchTemplates(site, urlStr) {
  let u; try { u = new URL(urlStr); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = host + u.pathname;
  let best = null;
  for (const tpl of cleanTemplates(site)) {
    const { re, hasQuery } = templateRegex(tpl);
    const m = (hasQuery ? path + u.search : path).match(re);
    if (m && (!best || tpl.length > best.score)) {
      let raw = m[1];
      if (site.separator === "plus") raw = raw.replace(/\+/g, " ");
      try { raw = decodeURIComponent(raw); } catch { /* keep */ }
      best = { score: tpl.length, template: tpl, raw, prop: templateProp(site, tpl), words: splitWords(m[1], site.separator || "hyphen") };
    }
  }
  return best;
}

export function findCurrent(sites, tabUrl) {
  const u = new URL(tabUrl);
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = host + u.pathname;

  let best = null;
  for (const site of sites) {
    if (!usable(site)) continue;
    const m = matchTemplates(site, tabUrl);
    if (m && (!best || m.score > best.score)) best = { site, score: m.score, extracted: m };
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

// For IDs without separators (MonotonicFunction, FundamentalTheoremofArithmetic) the words can't be known from
// the URL alone. Only accept a reading that matches a term we got from Wikidata (label/alias) or the clipboard.
export function alignToTerms(extracted, terms) {
  const key = s => normText(s).replace(/ /g, "");
  const k = key(extracted.raw);
  for (const t of terms) if (key(t.text) === k) return t.words;
  return null;
}

export function dedupeIds(ids) {
  const seen = new Set();
  return ids.filter(i => {
    if (!i.words.length) return false;
    const k = i.words.join(" ").toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

// ---------- candidates on related websites ----------
export function buildCandidates(sites, currentSite, ids, { perSite = 30, total = 90 } = {}) {
  if (!cats(currentSite).length) return [];
  const out = [], seen = new Set(), count = new Map();
  for (const id of ids) for (const site of sites) {
    if (!usable(site) || !sharesCat(currentSite, site)) continue;
    for (const words of termForms(id.words, site)) {
      const parts = idParts(words, site);
      for (const tpl of cleanTemplates(site)) for (const url of buildUrls(tpl, parts)) {
        const n = count.get(site) || 0;
        if (n >= perSite || out.length >= total) continue;
        const k = normUrl(url);
        if (seen.has(k)) continue;
        seen.add(k); count.set(site, n + 1);
        out.push({ site, template: tpl, url, value: parts.raw, prop: templateProp(site, tpl) });
      }
    }
  }
  return out;
}

export function originsFor(sites) {
  const set = new Set();
  const add = u => {
    try {
      const h = new URL(u).hostname;
      set.add(`*://${h}/*`);
      set.add(`*://${h.startsWith("www.") ? h.slice(4) : "www." + h}/*`);
    } catch { /* ignore bad templates */ }
  };
  if (sites.some(s => s.archive)) set.add("*://web.archive.org/*");
  for (const s of sites) {
    for (const t of cleanTemplates(s)) add(buildUrls(t, { id: "x", raw: "x", lower: "x", upper: "X" })[0]);
    if (s.searchUrl) add(searchUrl(s, "x"));
  }
  return [...set];
}

// ---------- clipboard ----------
// The clipboard must START with the item: "Q123" or a Wikidata URL (…/wiki/Q123, …/entity/Q123).
// Optional extra terms may follow, separated by commas or new lines: "Q123, use of property, possession".
// Anything that is not a plain short phrase (JSON, URLs, symbols…) is ignored, and text that does not start
// with an item is rejected outright – a Q-id buried in some pasted text is never used.
export function parseClipboard(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 400) return null;
  const m = t.match(/^(?:https?:\/\/(?:www\.|m\.)?wikidata\.org\/(?:wiki|entity)\/)?(Q\d+)(?![\w])[^\s,;]*/i);
  if (!m) return null;
  const extras = [];
  for (const piece of t.slice(m[0].length).split(/[,;\n\r]+/)) {
    const term = cleanTerm(piece.trim().replace(/^["'“”]+|["'“”]+$/g, ""));
    if (term && !extras.some(e => e.text.toLowerCase() === term.text.toLowerCase())) extras.push(term);
    if (extras.length >= 5) break;
  }
  return { item: m[1].toUpperCase(), extras };   // extras: [{text, words}]
}

// ---------- statement identity (for the history log) ----------
export function keyFor(site, url, value, prop) {
  return prop ? `I|${prop}|${value}` : `S|${(site.qid || "").toUpperCase()}|${normUrl(url).toLowerCase()}`;
}

export function applyUrlMode(url, mode) {
  const u = new URL(url);
  if (mode === "noquery") u.search = "";
  if (mode !== "asis") u.hash = "";
  return u.toString();
}

// ---------- does the page exist? ----------
const plainFetch = (u, o = {}) => { const { timeoutMs, ...rest } = o; return fetch(u, rest); };

export async function checkUrl(url, site, settings, fetcher = plainFetch, signal) {
  try {
    const res = await fetcher(url, { redirect: "follow", credentials: "omit", timeoutMs: 10000, signal });
    if (!res.ok) { res.body?.cancel(); return { found: false, reason: `HTTP ${res.status}`, definitive: [404, 410].includes(res.status) }; }
    const finalUrl = res.url || url;
    if (!sameUrlLoose(finalUrl, url) && settings.redirects !== "accept") {
      res.body?.cancel(); return { found: false, reason: "redirected elsewhere", definitive: true };
    }
    if (site.notFound && site.notFound.trim()) {
      const body = await res.text();
      try { if (new RegExp(site.notFound, "i").test(body)) return { found: false, reason: "matched 'not found' text", definitive: true }; }
      catch { /* bad regex: ignore */ }
    } else res.body?.cancel();
    return { found: true, url: finalUrl.split("#")[0] };
  } catch (e) {
    if (e.blocked) return { found: false, reason: "host rate-limited/blocking – stopped contacting it" };
    if (signal?.aborted) return { found: false, reason: "stopped", stopped: true };
    return { found: false, reason: e.name === "TimeoutError" || e.name === "AbortError" ? "timeout" : "network error" };
  }
}

// ---------- Wayback Machine ----------
export const tsToDate = ts => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;

export function unwrapArchive(u) {
  const m = String(u).match(/^https?:\/\/web\.archive\.org\/web\/(\d{4,14})(?:[a-z]{2}_)?\/(.+)$/i);
  if (!m) return null;
  let inner = m[2].replace(/^(https?):\/(?!\/)/i, "$1://");
  if (!/^https?:\/\//i.test(inner)) inner = "https://" + inner;
  return { timestamp: m[1], original: inner };
}

export async function waybackLatest(url, fetcher = plainFetch, signal) {
  const q = "https://web.archive.org/cdx/search/cdx?output=json&limit=-1&fl=timestamp,original&filter=statuscode:200&url=" +
    encodeURIComponent(url.split("#")[0]);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetcher(q, { credentials: "omit", timeoutMs: 15000, signal });
      if (!res.ok) continue;
      const txt = (await res.text()).trim();
      if (!txt) return { found: false };
      const rows = JSON.parse(txt);
      const row = rows.length > 1 ? rows[rows.length - 1] : null;
      if (!row) return { found: false };
      const [ts, orig] = row;
      return { found: true, timestamp: ts, date: tsToDate(ts), url: `https://web.archive.org/web/${ts}/${orig}` };
    } catch (e) { if (signal?.aborted || e.blocked) break; }
  }
  return { found: false, error: true };
}

// ---------- a website's own search engine ----------
export function searchUrl(site, q) {
  let u = String(site.searchUrl || "").trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "https://" + u;
  return u.split("{q20}").join(encodeURIComponent(q)).split("{q}").join(encodeURIComponent(q).replace(/%20/g, "+"));
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

// all <a href> in an HTML string -> [{href (absolute), text}]
export function extractLinks(html, base) {
  const out = [];
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = decodeEntities(m[1] ?? m[2] ?? m[3] ?? "");
    const text = decodeEntities(m[4].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    if (!href || href.startsWith("#") || /^(javascript|mailto|tel):/i.test(href)) continue;
    try { out.push({ href: new URL(href, base).toString(), text }); } catch { /* skip */ }
  }
  return out;
}

const safeRegex = s => { try { return new RegExp(s, "i"); } catch { return null; } };

function titleOk(t, n, mode) {
  if (mode === "start") return t === n || t.startsWith(n + " ");
  if (mode === "contain") return (" " + t + " ").includes(" " + n + " ");
  return t === n;
}

// /math/basic-geo/basic-geometry-pythagorean-theorem/geo-pythagorean-theorem/v/pythagorean-theorem-2
//   -> /math/basic-geo/basic-geometry-pythagorean-theorem   (shortest path whose last segment contains the term)
export function stripToGeneral(u, slugs) {
  const segs = u.pathname.split("/").filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    let s = segs[i];
    try { s = decodeURIComponent(s); } catch { /* keep */ }
    s = "-" + normText(s.replace(/\.[a-z0-9]{2,5}$/i, "")).replace(/ /g, "-") + "-";
    if (slugs.some(sl => sl && s.includes("-" + sl + "-"))) return u.origin + "/" + segs.slice(0, i + 1).join("/");
  }
  return null;
}

// Pick the relevant links from a search results page.
//  pickBy "title": link text must match a term (default)   e.g. <a href="../pythagoras.html">Pythagorean Theorem</a>
//  pickBy "slug":  link URL must contain the term; the most general matching path is kept
// -> [{url, exact}]  exact = the link text EQUALS a term (always true in slug mode); exact matches come first
export function pickResultsDetailed(links, site, terms, searchPage) {
  const host = siteHost(site);
  const max = Number(site.searchMax) || 5;
  const termNorms = [...new Set(terms.map(t => normText(t.text)).filter(Boolean))];
  const slugs = termNorms.map(t => t.replace(/ /g, "-"));
  const re = site.searchRegex ? safeRegex(site.searchRegex) : null;
  const exclude = site.searchExclude ? safeRegex(site.searchExclude) : null;
  const sp = searchPage ? normUrl(searchPage) : "";
  const out = [], seen = new Set();
  for (const { href, text } of links) {
    let u; try { u = new URL(href); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const h = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host && !(h === host || h.endsWith("." + host))) continue;
    u.hash = "";
    if (normUrl(u.toString()) === sp) continue;
    let url = null, exact = true;
    if ((site.pickBy || "title") === "slug") url = stripToGeneral(u, slugs);
    else {
      const mode = site.titleMatch || "equal";
      const variants = [normText(text), normTextCamel(text)].filter(Boolean);
      const isEqual = n => variants.some(t => titleOk(t, n, "equal")) ||
        (variants[0] && variants[0].replace(/ /g, "") === n.replace(/ /g, "")); // "pythagoreantheorem"
      const ok = mode === "equal" ? termNorms.some(isEqual)
        : termNorms.some(n => variants.some(t => titleOk(t, n, mode)) || isEqual(n));
      if (ok) { url = u.toString(); exact = termNorms.some(isEqual); }
    }
    if (!url || (re && !re.test(url))) continue;
    if (exclude && (exclude.test(url) || exclude.test(u.toString()))) continue; // drop if the result OR its stripped form matches
    const k = normUrl(url).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push({ url, exact });
  }
  return [...out.filter(x => x.exact), ...out.filter(x => !x.exact)].slice(0, max);
}
export const pickResults = (...args) => pickResultsDetailed(...args).map(x => x.url);

// ---------- settings export / import ----------
export function exportSettingsObject(settings) {
  const s = {};
  for (const k of Object.keys(DEFAULTS)) if (k in settings) s[k] = settings[k];
  return { format: "wikidata-source-saver-settings", version: 1, exported: new Date().toISOString(), settings: s };
}

// Only known keys, only values of the right type; anything else is ignored.
export function parseSettingsImport(text) {
  const d = JSON.parse(text);
  if (d?.format !== "wikidata-source-saver-settings" || !d.settings || typeof d.settings !== "object") {
    throw new Error("not a Wikidata Source Saver settings file");
  }
  const out = {};
  for (const [k, def] of Object.entries(DEFAULTS)) {
    if (!(k in d.settings)) continue;
    const v = d.settings[k];
    if (typeof def === "number") { const n = Number(v); if (Number.isFinite(n) && n >= 0) out[k] = n; }
    else if (typeof def === "boolean") out[k] = !!v;
    else if (typeof v === "string") out[k] = v.slice(0, 100);
  }
  if (out.review && !["auto", "always", "never"].includes(out.review)) delete out.review;
  if (out.redirects && !["skip", "accept"].includes(out.redirects)) delete out.redirects;
  return out;
}
