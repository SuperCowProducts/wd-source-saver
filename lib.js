// Shared helpers (used by the background service worker, the options page and the review page)

export const DEFAULTS = {
  related: true, redirects: "skip", labelLang: "en", username: "",
  review: "auto",          // auto = ask when more than reviewThreshold new statements or when anything came from a site search
  reviewThreshold: 3,
  maxPerEdit: 5,           // statements added in ONE edit
  minEditInterval: 60,     // seconds between edits (Wikimedia: unflagged bots should stay below 1 edit/minute)
  maxEditsPerHour: 30,
  useHistory: true, missTtlDays: 14,
  captchaWaitSeconds: 180, // a robot check ("Confirm you are not a robot") pauses the run this long so YOU can solve it in the tab; 0 = give up at once
  textFragment: true,      // text selected on the page becomes a #:~:text= fragment in the saved URL
  maxlag: 5,               // seconds; sent ONLY with edits (reads never need it). 0 = off – a temporary strategy while Wikidata is congested
  scriptMaxClicks: 60,     // search scripts: hard limits per search
  scriptMaxSeconds: 180,
  logToFile: false,        // also save a .log file to Downloads after every run (needs the optional 'downloads' permission)
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
const PFX = /^\s*(P\d+)(?::(\S+))?\s+(?=\S)/i;   // P10715  |  P10715:{first}/{id}
export function parseTemplates(site) {
  return (site.templates || []).map(l => String(l).trim()).filter(Boolean).map(l => {
    const m = l.match(PFX);
    return { tpl: m ? l.slice(m[0].length).trim() : l, prop: m ? m[1].toUpperCase() : null, val: m?.[2] || null };
  }).filter(x => x.tpl.includes("{id}") || x.tpl.includes("{path}"));
}
// templates whose URL can be BUILT from a term ({path} IDs have unknown directories, so they are only ever read)
export const buildableTemplates = site => parseTemplates(site).filter(x => x.tpl.includes("{id}") && !x.tpl.includes("{path}")).map(x => x.tpl);
export const cleanTemplates = site => parseTemplates(site).map(x => x.tpl);
export const siteDefaultProp = site => ((site.idProperty || "").match(/P\d+/i) || [""])[0].toUpperCase();
// How the VALUE of the ID property is written. Default {id}; e.g. {first}/{id} when Wikidata stores "f/financial-statements".
//   per template:   P10715:{first}/{id} https://www.investopedia.com/terms/{first}/{id}.asp
//   per website:    "ID value pattern" field (used by templates without their own pattern)
export function valuePattern(site, tpl) {
  const t = parseTemplates(site).find(x => x.tpl === tpl);
  return t?.val || String(site.idValue || "").trim() || "{id}";
}
export function fillValue(pattern, { raw, first }) {
  const f = first ?? raw.charAt(0);
  return String(pattern || "{id}").split("{id}").join(raw).split("{path}").join(raw).split("{first}").join(f.toLowerCase()).split("{FIRST}").join(f.toUpperCase());
}
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
  if (m) return { prop: m.prop, value: m.value };
  const prop = siteDefaultProp(site) === "P1343" ? "" : siteDefaultProp(site);
  return { prop, value: null };
}

// ---------- languages ----------
// Terms may carry a language (clipboard:  "Q123, en: Pythagorean theorem, it: teorema di Pitagora"); a website may
// declare the languages it serves ("en, it"). No language on either side = no restriction.
export const langsOf = site => String(site.language || "").split(/[,\s;]+/).map(x => x.toLowerCase()).filter(Boolean);
const primary = l => String(l || "").toLowerCase().split("-")[0];
export const langOk = (term, site) => {
  const ls = langsOf(site);
  return !term.lang || !ls.length || ls.some(l => primary(l) === primary(term.lang));
};
export const termsForSite = (terms, site) => terms.filter(t => langOk(t, site));

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
  let src = "", groups = 0, idGroup = 0, multi = false;
  const names = [];
  for (const part of t.split(PH)) {
    if (part === "{path}") {                      // several directories: history/encyclopedias/industrial-capitalism
      if (idGroup) src += "\\" + idGroup; else { src += "([^?#]+)"; idGroup = ++groups; names.push("id"); multi = true; }
    }
    else if (part === "{id}") { if (idGroup) src += "\\" + idGroup; else { src += "([^/?#]+)"; idGroup = ++groups; names.push("id"); } }
    else if (part === "{first}" || part === "{FIRST}") { src += "([^/?#]+)"; groups++; names.push("first"); }
    else if (/^\{[^{}]*\|[^{}]*\}$/.test(part)) {
      src += "(?:" + part.slice(1, -1).split("|").map(x => esc(x.trim())).join("|") + ")";
    } else src += esc(part);
  }
  return { re: new RegExp("^" + src + "/?$", "i"), hasQuery: t.includes("?"), names, multi };
}

export function effectiveMatch(site) {
  let m = (site.match || "").trim();
  if (!m) {
    const t = cleanTemplates(site)[0];
    if (t) m = stripProto(t).split(PH)[0].split("?")[0].replace(/\/$/, "");
    else if (site.searchUrl) {
      let dec = site.searchUrl.replace(/\+/g, " ");
      try { dec = decodeURIComponent(dec); } catch { /* keep */ }
      const sm = dec.match(/site:([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i);       // Google "site:encyclopedia.com term" -> the results live on that site
      m = sm ? sm[1] : stripProto(site.searchUrl).split(PH)[0].split("/")[0];
    }
  }
  return stripProto(m).toLowerCase();
}
export const siteHost = site => effectiveMatch(site).split("/")[0];

// A site may be inconsistent (investopedia: incomestatement vs income-statement): "none,hyphen" tries both.
export const sepList = site => {
  const l = String(site.separator || "hyphen").split(/[,\s]+/).filter(x => x in SEPARATORS);
  return l.length ? [...new Set(l)] : ["hyphen"];
};
const SEP_CHAR = { hyphen: "-", underscore: "_", plus: "+" };
// which of the site's separators does this particular ID use?
export function pickSep(raw, site) {
  const l = sepList(site);
  for (const k of l) {
    if (k === "none") continue;
    if (k === "space" ? /(%20|\s)/i.test(raw) : raw.includes(SEP_CHAR[k])) return k;
  }
  return l.includes("none") ? "none" : l[0];
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
  const sk = sepList(site)[0];
  const sep = SEPARATORS[sk] ?? "-";
  const id = cased.map(encodeURIComponent).join(sep);
  const ch = (cased[0] || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").charAt(0);
  const dir = /\p{L}/u.test(ch) ? null : ((site.nonLetter || "").trim() || null);
  const rawSep = { hyphen: "-", underscore: "_", plus: " ", space: " ", none: "" }[sk] ?? "-";
  return {
    id, raw: cased.join(rawSep),
    rawLower: dir ?? ch.toLowerCase(),
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
  u = u.split("{id}").join(parts.id).split("{path}").join(parts.id).split("{first}").join(parts.lower).split("{FIRST}").join(parts.upper);
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
    const { re, hasQuery, names, multi } = templateRegex(tpl);
    const m = (hasQuery ? path + u.search : path).match(re);
    if (m && (!best || tpl.length > best.score)) {
      let idEnc = m[names.indexOf("id") + 1];
      if (multi) idEnc = idEnc.replace(/\/+$/, "");
      const slugEnc = multi ? idEnc.split("/").pop() : idEnc;        // for a multi-directory ID the term comes from the last part
      const fi = names.indexOf("first");
      let first; if (fi >= 0) { first = m[fi + 1]; try { first = decodeURIComponent(first); } catch { /* keep */ } }
      let raw = idEnc;
      const sep = pickSep(slugEnc, site);
      if (sep === "plus") raw = raw.replace(/\+/g, " ");
      try { raw = decodeURIComponent(raw); } catch { /* keep */ }
      let slug = slugEnc; try { slug = decodeURIComponent(slugEnc); } catch { /* keep */ }
      best = { score: tpl.length, template: tpl, raw, slug, multi, sep, prop: templateProp(site, tpl), words: splitWords(slugEnc, sep),
        value: fillValue(valuePattern(site, tpl), { raw, first }) };   // what is stored in the ID property
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
  const k = key(extracted.slug ?? extracted.raw);
  for (const t of terms) if (key(t.text) === k) return t.words;
  return null;
}

export function dedupeIds(ids) {
  const seen = new Set();
  return ids.filter(i => {
    if (!i.words.length) return false;
    const k = (i.lang || "") + "|" + i.words.join(" ").toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

// ---------- candidates on related websites ----------
export function buildCandidates(sites, currentSite, ids, { perSite = 30, total = 90 } = {}) {
  if (!cats(currentSite).length) return [];
  const out = [], seen = new Set(), count = new Map();
  for (const id of ids) for (const site of sites) {
    if (!usable(site) || !sharesCat(currentSite, site) || !langOk(id, site)) continue;
    for (const sep of sepList(site)) for (const words of termForms(id.words, site)) {
      const parts = idParts(words, { ...site, separator: sep });
      for (const tpl of buildableTemplates(site)) for (const url of buildUrls(tpl, parts)) {
        const n = count.get(site) || 0;
        if (n >= perSite || out.length >= total) continue;
        const k = normUrl(url);
        if (seen.has(k)) continue;
        seen.add(k); count.set(site, n + 1);
        out.push({ site, template: tpl, url, prop: templateProp(site, tpl), sep,
          value: fillValue(valuePattern(site, tpl), { raw: parts.raw, first: parts.rawLower }) });
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
// Optional extra terms follow, separated by commas, semicolons or new lines. Multi-word terms are fine, and a
// language tag ("it:") applies to itself and to the untagged terms after it, until the next tag:
//     Q123, en: Pythagorean theorem, Pythagoras' theorem, it: teorema di Pitagora
// Terms before any tag have no language (all websites use them). Anything that is not a plain short phrase
// (JSON, URLs, symbols…) is ignored; text that does not start with an item is rejected outright.
export function parseClipboard(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 600) return null;
  const m = t.match(/^(?:https?:\/\/(?:www\.|m\.)?wikidata\.org\/(?:wiki|entity)\/)?(Q\d+)(?![\w])[^\s,;]*/i);
  if (!m) return null;
  const extras = [];
  let lang = "";
  for (const piece of t.slice(m[0].length).split(/[,;\n\r]+/)) {
    let p = piece.trim();
    const tag = p.match(/^([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)\s*:\s*(.*)$/);
    if (tag) { lang = tag[1].toLowerCase(); p = tag[2]; }
    const term = cleanTerm(p.trim().replace(/^["'“”]+|["'“”]+$/g, ""));
    if (term && !extras.some(e => e.lang === lang && e.text.toLowerCase() === term.text.toLowerCase())) extras.push({ ...term, lang });
    if (extras.length >= 12) break;
  }
  return { item: m[1].toUpperCase(), extras };   // extras: [{text, words, lang}]
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

// ---------- redirects: is the target still "the same page"? ----------
const lastSeg = u => { try { return decodeURIComponent(new URL(u).pathname.split("/").filter(Boolean).pop() || ""); } catch { return ""; } };
const compact = s => normText(s).replace(/ /g, "");
export const slugSimilar = (a, b) => { const x = compact(lastSeg(a)), y = compact(lastSeg(b)); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };
// Why a redirect from -> to must NOT be accepted (null = fine): leaves the website, isn't a content page of it, or is about something else.
export function redirectProblem(site, from, to) {
  let b; try { new URL(from); b = new URL(to); } catch { return "invalid URL"; }
  const host = siteHost(site), h = b.hostname.toLowerCase().replace(/^www\./, "");
  if (host && !(h === host || h.endsWith("." + host))) return "it leaves the website";
  if (cleanTemplates(site).length && !matchTemplates(site, to)) return "the target doesn't match any URL template of this website";
  if (!slugSimilar(from, to)) return "the target page is about something else";
  return null;
}

// ---------- does the page exist? ----------
const plainFetch = (u, o = {}) => { const { timeoutMs, ...rest } = o; return fetch(u, rest); };

export async function checkUrl(url, site, settings, fetcher = plainFetch, signal) {
  try {
    const res = await fetcher(url, { redirect: "follow", credentials: "omit", timeoutMs: 10000, signal });
    if (!res.ok) { res.body?.cancel(); return { found: false, reason: `HTTP ${res.status}`, definitive: [404, 410].includes(res.status) }; }
    const finalUrl = res.url || url;
    if (!sameUrlLoose(finalUrl, url)) {            // case / trailing slash / www / http-https differences are always fine
      if ((site.redirects || settings.redirects) !== "accept") {
        res.body?.cancel(); return { found: false, reason: "redirected elsewhere", definitive: true };
      }
      const why = redirectProblem(site, url, finalUrl);
      if (why) { res.body?.cancel(); return { found: false, reason: `redirected to ${finalUrl} – not accepted: ${why}`, definitive: true }; }
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

async function cdxRow(url, filter, fetcher, signal) {
  const q = "https://web.archive.org/cdx/search/cdx?output=json&limit=-1&fl=timestamp,original&filter=" + filter + "&url=" +
    encodeURIComponent(url.split("#")[0]);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetcher(q, { credentials: "omit", timeoutMs: 15000, signal });
      if (!res.ok) continue;
      const txt = (await res.text()).trim();
      if (!txt) return null;
      const rows = JSON.parse(txt);                  // [["timestamp","original"], ["2025…","https://…"]]
      return rows.length > 1 ? rows[rows.length - 1] : null;
    } catch (e) { if (signal?.aborted || e.blocked) break; }
  }
  return "error";
}
const waybackUrl = (ts, orig) => `https://web.archive.org/web/${ts}/${orig}`;

// Latest capture of a URL. If only a REDIRECT was captured for it (the site "corrects" our spelling:
// …/Harmonic_Number -> …/Harmonic_number) the redirect is followed, so the result carries the correct address in `original`.
export async function waybackLatest(url, fetcher = plainFetch, signal) {
  const row = await cdxRow(url, "statuscode:200", fetcher, signal);
  if (row === "error") return { found: false, error: true };
  if (row) return { found: true, timestamp: row[0], date: tsToDate(row[0]), url: waybackUrl(row[0], row[1]), original: row[1] };
  const redir = await cdxRow(url, "statuscode:30[0-9]", fetcher, signal);
  if (redir && redir !== "error") {
    const fixed = await resolveArchiveUrl({ url: waybackUrl(redir[0], redir[1]), timestamp: redir[0], date: tsToDate(redir[0]), original: redir[1] }, fetcher, signal);
    if (fixed.corrected) return { found: true, ...fixed };
  }
  return { found: false };
}

// The Wayback Machine itself may redirect to the correctly spelled capture; the address we END on is the one to store.
export async function resolveArchiveUrl(arch, fetcher = plainFetch, signal) {
  try {
    const res = await fetcher(arch.url, { method: "HEAD", redirect: "follow", credentials: "omit", timeoutMs: 15000, signal });
    const un = res.ok ? unwrapArchive(res.url || "") : null;
    if (un && res.url !== arch.url) return { ...arch, url: res.url, timestamp: un.timestamp, date: tsToDate(un.timestamp), original: un.original, corrected: true };
  } catch { /* keep what we have */ }
  return arch;
}

// MediaWiki search results also list talk/user/special/file pages; those are never articles worth citing.
// (Pseudo-namespaces such as ProofWiki's "Symbols:" or "Definition:" are ordinary articles and are NOT excluded.)
const NS = "Talk|User|User_talk|Special|File|File_talk|Category|Category_talk|Template|Template_talk|Help|Help_talk|MediaWiki|MediaWiki_talk|Project|Project_talk|Wikipedia|Wikipedia_talk";
export const MEDIAWIKI_EXCLUDE = `/wiki/(${NS})(:|%3A)|[?&]title=(${NS})(:|%3A)`;

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

// search engines wrap result links: google.com/url?q=<target>, duckduckgo.com/l/?uddg=<target>
function unwrapRedirect(href) {
  try {
    const u = new URL(href);
    let t = null;
    if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname) && u.pathname === "/url") t = u.searchParams.get("q") || u.searchParams.get("url");
    else if (/(^|\.)duckduckgo\.com$/i.test(u.hostname) && u.pathname.startsWith("/l/")) t = u.searchParams.get("uddg");
    if (t && /^https?:\/\//i.test(t)) return t;
  } catch { /* not a URL */ }
  return href;
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
  const slugs = [...new Set(termNorms.flatMap(t => {
    const w = t.split(" "), base = [t.replace(/ /g, "-")];
    for (const f of altForms(w[w.length - 1]).slice(0, 2)) base.push([...w.slice(0, -1), f].join("-"));   // one-sided-limit / one-sided-limits
    return base;
  }))];
  const re = site.searchRegex ? safeRegex(site.searchRegex) : null;
  const exclude = site.searchExclude ? safeRegex(site.searchExclude) : null;
  const sp = searchPage ? normUrl(searchPage) : "";
  const out = [], seen = new Set();
  for (const { href: rawHref, text } of links) {
    const href = unwrapRedirect(rawHref);
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

// ======================================================================
// search scripts (for result pages that need clicking: "See results", tabs, "Page 2", "Page 3" …)
// ======================================================================
//   click <role|text> "name" [exact]      role = button, link, tab, heading, option, menuitem, checkbox, radio, listitem
//   collect                               remember every link on the page now
//   pages link "Page {n}" [max=10]        click Page 2, Page 3 … (collecting each) until there is no such link
//   wait 1500                             milliseconds (max 5000)
//   each "Videos", "Articles"             repeat the indented lines for every value; {x} = the value
//     click text "{x}"
// Pasted Playwright locators work as click steps:  get_by_role("button", name="…")   get_by_text("…")
export function parseSearchScript(text) {
  const lines = [];
  String(text || "").split(/\r?\n/).forEach((l, i) => {
    if (l.trim() && !l.trim().startsWith("#")) lines.push({ n: i + 1, indent: l.match(/^\s*/)[0].replace(/\t/g, "    ").length, s: l.trim() });
  });
  const quoted = s => [...s.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)].map(m => (m[1] ?? m[2]).replace(/\\(.)/g, "$1"));
  const fail = (L, msg) => { throw new Error(`line ${L.n}: ${msg}`); };
  const one = L => {
    const s = L.s, q = quoted(s);
    let m;
    if (/^collect\b/i.test(s)) return { op: "collect" };
    if ((m = s.match(/^wait\s+(\d+)/i))) return { op: "wait", ms: Math.min(5000, Number(m[1])) };
    if ((m = s.match(/^click\s+(\w+)\s+["']/i))) return { op: "click", kind: m[1].toLowerCase(), name: q[0], exact: /\bexact\s*$/i.test(s) };
    if ((m = s.match(/^pages\s+(\w+)\s+["']/i))) {
      if (!q[0]?.includes("{n}")) fail(L, 'pages needs a name containing {n}, e.g. pages link "Page {n}"');
      return { op: "pages", kind: m[1].toLowerCase(), tpl: q[0], max: Math.min(30, Number((s.match(/max=(\d+)/i) || [])[1]) || 10) };
    }
    if (/^each\b/i.test(s)) { if (!q.length) fail(L, 'each needs values, e.g. each "Videos", "Articles"'); return { op: "each", values: q, body: [] }; }
    if ((m = s.match(/^(?:page\.)?get_by_role\(\s*["'](\w+)["']\s*(?:,\s*name\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'))?/i))) {
      const name = m[2] ?? m[3]; if (name == null) fail(L, "get_by_role needs name=...");
      return { op: "click", kind: m[1].toLowerCase(), name, exact: /exact\s*=\s*True/i.test(s) };
    }
    if ((m = s.match(/^(?:page\.)?get_by_text\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/i))) return { op: "click", kind: "text", name: m[1] ?? m[2], exact: /exact\s*=\s*True/i.test(s) };
    return fail(L, `don't understand "${s.slice(0, 50)}"`);
  };
  let pos = 0;
  const block = indent => {
    const steps = [];
    while (pos < lines.length && lines[pos].indent >= indent) {
      const L = lines[pos];
      if (L.indent > indent) fail(L, "unexpected indentation");
      pos++;
      const st = one(L);
      if (st.op === "each") {
        if (pos < lines.length && lines[pos].indent > L.indent) st.body = block(lines[pos].indent);
        else fail(L, '"each" needs an indented block below it');
      }
      steps.push(st);
    }
    return steps;
  };
  const steps = lines.length ? block(lines[0].indent) : [];
  if (pos < lines.length) fail(lines[pos], "unexpected indentation");
  return steps;
}

// Runs INSIDE the page (chrome.scripting.executeScript) – must stay self-contained.
export function pageOp(op, a) {
  const norm = s => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const visible = e => {
    for (let n = e; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hidden) return false;
      const st = getComputedStyle(n);
      if (st.display === "none" || st.visibility === "hidden") return false;
    }
    return true;
  };
  if (op === "collect") {
    return [...document.querySelectorAll("a[href]")].map(x => ({ href: x.href, text: (x.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200) }));
  }
  const ROLE = {
    button: 'button,[role=button],input[type=button],input[type=submit]', link: "a[href],[role=link]", tab: "[role=tab]",
    heading: "h1,h2,h3,h4,h5,h6,[role=heading]", option: "option,[role=option]", menuitem: "[role=menuitem]",
    checkbox: "input[type=checkbox],[role=checkbox]", radio: "input[type=radio],[role=radio]", listitem: "li,[role=listitem]"
  };
  const nameOf = e => e.getAttribute("aria-label") || e.innerText || e.textContent || e.value || e.title || e.alt || "";
  const want = norm(a.name);
  let els, textOf;
  if (a.kind === "text") {
    textOf = e => norm(e.textContent);
    els = [...document.querySelectorAll("body *")].filter(e => !/^(SCRIPT|STYLE|NOSCRIPT)$/.test(e.tagName) && visible(e) && textOf(e).includes(want));
    els = els.filter(e => !els.some(o => o !== e && e.contains(o)));       // the innermost element holding the text
  } else {
    textOf = e => norm(nameOf(e));
    els = [...document.querySelectorAll(ROLE[a.kind] || `[role=${a.kind}]`)].filter(visible);
  }
  const pick = els.find(e => textOf(e) === want) || (a.exact ? null : els.find(e => textOf(e).includes(want)));
  if (!pick) return { ok: false };
  if (pick.scrollIntoView) pick.scrollIntoView({ block: "center" });
  pick.click();
  return { ok: true, tag: pick.tagName };
}

// Every way a run can end has its own badge symbol + colour (and the same symbol leads the notification title).
export const KINDS = {
  ok:        { badge: "✓",  color: "#2e7d32", text: "#ffffff", ms: 4000, label: "Saved" },
  partial:   { badge: "+!", color: "#ef6c00", text: "#ffffff", ms: 7000, label: "Saved, but some websites had problems" },
  present:   { badge: "=",  color: "#fbc02d", text: "#000000", ms: 6000, label: "Already on Wikidata – nothing changed" },
  nothing:   { badge: "0",  color: "#9e9e9e", text: "#000000", ms: 6000, label: "Nothing found" },
  checked:   { badge: "3/9", color: "#00796b", text: "#ffffff", ms: 0, label: "Template check finished (exist / checked) – Settings → Test your templates" },
  robot:     { badge: "BOT", color: "#f57c00", text: "#000000", ms: 0, label: "Robot check – solve it in the tab that opened" },
  stopped:   { badge: "■",  color: "#616161", text: "#ffffff", ms: 4000, label: "Stopped" },
  cancelled: { badge: "✗",  color: "#616161", text: "#ffffff", ms: 4000, label: "Cancelled" },
  login:     { badge: "LOG", color: "#6a1b9a", text: "#ffffff", ms: 8000, label: "Not logged in to Wikidata" },
  clipboard: { badge: "Q?", color: "#0097a7", text: "#ffffff", ms: 8000, label: "No item in the clipboard" },
  config:    { badge: "CFG", color: "#5d4037", text: "#ffffff", ms: 8000, label: "Website not configured" },
  page:      { badge: "URL", color: "#795548", text: "#ffffff", ms: 6000, label: "This page can't be used" },
  perm:      { badge: "PRM", color: "#ad1457", text: "#ffffff", ms: 8000, label: "Permission needed" },
  lag:       { badge: "LAG", color: "#ef6c00", text: "#ffffff", ms: 8000, label: "Wikidata is busy (maxlag / rate limit)" },
  cap:       { badge: "CAP", color: "#455a64", text: "#ffffff", ms: 8000, label: "Edit limit reached" },
  net:       { badge: "NET", color: "#546e7a", text: "#ffffff", ms: 8000, label: "Network problem" },
  blocked:   { badge: "BLK", color: "#d84315", text: "#ffffff", ms: 8000, label: "Websites blocked / rate-limited us" },
  api:       { badge: "API", color: "#c62828", text: "#ffffff", ms: 8000, label: "Wikidata refused the request" },
  error:     { badge: "!",  color: "#b71c1c", text: "#ffffff", ms: 8000, label: "Unexpected error" }
};

// ======================================================================
// robot checks ("Confirm you are not a robot", CAPTCHAs, Cloudflare "Just a moment…")
// ======================================================================
const ROBOT_STRONG = [/confirm you are not a robot/, /are you a robot/, /verify (that )?you(?:'| a)re (a )?human/, /verify you are human/,
  /unusual traffic/, /press (&|and) hold/, /checking your browser/, /just a moment/, /not a robot/, /human verification/];
const ROBOT_WEAK = [/captcha/, /security check/, /access denied/];
export const looksLikeRobotCheckText = (text, links) => {
  const t = String(text || "").toLowerCase();
  if (ROBOT_STRONG.some(p => p.test(t))) return true;
  return links < 15 && ROBOT_WEAK.some(p => p.test(t));      // a normal page that merely mentions "reCAPTCHA" has many links
};
export function looksLikeRobotCheckHtml(html) {
  const s = String(html || "");
  const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  const text = s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 6000);
  return looksLikeRobotCheckText(title + " " + text, (s.match(/<a\b[^>]*href/gi) || []).length);
}
// Runs INSIDE the page – must stay self-contained.
export function robotCheckInPage() {
  const STRONG = [/confirm you are not a robot/, /are you a robot/, /verify (that )?you(?:'| a)re (a )?human/, /verify you are human/, /unusual traffic/, /press (&|and) hold/, /checking your browser/, /just a moment/, /not a robot/, /human verification/];
  const WEAK = [/captcha/, /security check/, /access denied/];
  const text = ((document.title || "") + " " + (document.body ? (document.body.innerText || document.body.textContent || "") : "")).slice(0, 6000).toLowerCase();
  const links = document.querySelectorAll("a[href]").length;
  if (STRONG.some(p => p.test(text))) return true;
  if (links < 15 && WEAK.some(p => p.test(text))) return true;
  return !!document.querySelector('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"],#cf-challenge-running,#challenge-form,.g-recaptcha,.h-captcha') && links < 15;
}

// ======================================================================
// text fragments: selected text -> https://…#:~:text=punto%20interno
// ======================================================================
export function textFragmentFor(selection) {
  const t = String(selection || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!t) return "";
  const enc = s => encodeURIComponent(s).replace(/-/g, "%2D");          // "-" , "," and "&" are special inside a text directive
  if (t.length <= 100) return "#:~:text=" + enc(t);
  const w = t.split(" ");                                                 // long selection: first words , last words
  return "#:~:text=" + enc(w.slice(0, 5).join(" ").slice(0, 80)) + "," + enc(w.slice(-5).join(" ").slice(-80));
}
