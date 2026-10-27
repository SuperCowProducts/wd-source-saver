import { EN_WORDS } from "./wordlist-en.js";
// Shared helpers (used by the background service worker, the options page and the review page)

export const DEFAULTS = {
  related: true, redirects: "skip", labelLang: "en", username: "",
  relatedMode: "sites",    // how other sources are found: sites = ask every website of the category (URL guesses + site searches) | google = ONE verbatim Google search per term
  googlePages: 2,          // result pages read in that Google search (about 10 results each)
  googleKeywords: "",      // helper words added to every Google search, e.g. law -> "public property" law (they steer the results; the page need not contain them)
  confirmTerm: "always",   // ask which term to search for on other websites: always | noid (only when the template has no {id}) | never
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

// ---------- YouTube video URLs ----------
// watch?v=ID&t=30s, watch?v=ID&t=45, …&si=…&feature=…, youtu.be/ID?t=3, m.youtube.com, /shorts/ID, /live/ID, /embed/ID are ONE video.
export function youtubeVideoId(x) {                                  // URL or string -> the 11-character video ID ("" = not a YouTube video address)
  let u; try { u = x instanceof URL ? x : new URL(x); } catch { return ""; }
  const h = u.hostname.toLowerCase().replace(/^(?:www|m|music)\./, "");
  let id = "";
  if (h === "youtu.be") id = u.pathname.split("/")[1] || "";
  else if (h === "youtube.com" || h === "youtube-nocookie.com") {
    const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/);
    id = u.pathname === "/watch" ? (u.searchParams.get("v") || "") : (m ? m[1] : "");
  }
  return /^[\w-]{11}$/.test(id) ? id : "";
}
export const isYouTubeHost = h => /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(String(h || ""));
// start time, playlist position, share/tracking parameters: they change the link, not the video
const YT_NOISE = /^(t|start|end|time_continue|si|feature|pp|ab_channel|list|index|app|fbclid|gclid|utm_.*)$/i;
export function cleanYouTubeUrl(url) {
  let u; try { u = new URL(url); } catch { return url; }
  if (!youtubeVideoId(u)) return url;
  for (const k of [...u.searchParams.keys()]) if (YT_NOISE.test(k)) u.searchParams.delete(k);
  u.hash = "";
  return u.toString();
}
export function normUrl(u) {
  try {
    const x = new URL(u);
    const yt = youtubeVideoId(x); if (yt) return "youtube.com/watch?v=" + yt;                 // every variation of one video is the same address
    return x.hostname.toLowerCase().replace(/^www\./, "") + x.pathname.replace(/\/+$/, "") + x.search + x.hash;
  } catch { return String(u).trim(); }
}
const sameUrlLoose = (a, b) => normUrl(a).toLowerCase() === normUrl(b).toLowerCase();


// a website can belong to several categories: "math, geometry"
// An entry may be a choice group that follows the {a|b} choice of the template that matched the page URL:
//   templates  https://www.ebsco.com/research-starters/{economics|mathematics}/{id}
//   categories {ec|mt}              -> a page under /economics/ searches category ec, under /mathematics/ category mt
const catEntries = s => String(s.category || "").split(/[,;]/).map(x => x.trim().toLowerCase()).filter(Boolean)
  .map(x => { const m = x.match(/^\{([^{}]*\|[^{}]*)\}$/); return m ? m[1].split("|").map(y => y.trim()).filter(Boolean) : x; });
// all categories the website can belong to (a choice group counts with every alternative)
export const cats = s => [...new Set(catEntries(s).flat())];
// the categories of the CURRENT page: choice groups resolved by what the page URL matched (all alternatives when unknown)
export function catsFor(site, extracted) {
  const out = [];
  for (const e of catEntries(site)) {
    if (!Array.isArray(e)) { out.push(e); continue; }
    const ch = (extracted?.choices || []).find(c => c.of === e.length);
    out.push(...(ch ? [e[ch.index]] : e));
  }
  return [...new Set(out)];
}
export const sharesCat = (a, b) => { const cb = cats(b); return (Array.isArray(a) ? a : cats(a)).some(c => cb.includes(c)); };

// A template line may start with the Wikidata property that stores its ID:
//   P9999 https://www.econlib.org/library/Enc/{id}.html      -> saved as  P9999: <id>
//   https://www.econlib.org/library/Topics/{a|b}/{id}.html   -> site's default property if set, else P1343 + P2699
//   P1343 https://…/{id}.html                                -> force the P1343 + P2699 fallback
const PFX = /^\s*(P\d+)(?::(\S+))?\s+(?=\S)/i;   // P10715  |  P10715:{first}/{id}
// A DIRECT LINK: a template line without any {…}, e.g. https://www.example.com/about/history. It has no ID: it matches exactly that page
// (a query string only when the line has one; #fragment, www., http/https and a trailing / never matter) and is saved as P1343 + P2699 with the URL as it is.
const DIRECT = /^(?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#]\S*)?$/i;
export const isDirectTemplate = t => !/[{}\s]/.test(String(t || "").trim()) && DIRECT.test(String(t || "").trim());
export function parseTemplates(site) {
  return (site.templates || []).map(l => String(l).trim()).filter(Boolean).map(l => {
    const m = l.match(PFX);
    const tpl = m ? l.slice(m[0].length).trim() : l;
    if (isDirectTemplate(tpl)) return { tpl, prop: null, val: null, direct: true };   // no ID: a property prefix would have nothing to store
    return { tpl, prop: m ? m[1].toUpperCase() : null, val: m?.[2] || null };
  }).filter(x => x.direct || x.tpl.includes("{id}") || x.tpl.includes("{path}"));
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
  if (t?.direct) return "";                                          // a direct link has no ID to store: always P1343 + P2699
  const p = t && t.prop !== null ? t.prop : siteDefaultProp(site);
  return p === "P1343" ? "" : p;
}
// IDs that the URL does not contain but the PAGE does. A website lists where to look, one "place" per line; the first line that yields a value wins:
//   meta NAME [| regex]            <meta name|property|itemprop="NAME" content="…">
//   css SELECTOR [@attr] [| regex] text (or attribute) of the first element matching a CSS selector
//   jsonld KEY [| regex]           value of KEY anywhere in the page's JSON-LD blocks
//   html REGEX  (or just REGEX)    a regular expression over the page's HTML source; group 1 = the ID (no group = whole match)
// "| regex" narrows the value that was found (group 1, or the whole match). The URL template still gives the WORDS of the page;
// only the VALUE of the ID property comes from the page ({id} in an "ID value pattern" stands for it).
export const pageIdPatterns = site => (Array.isArray(site.pageId) ? site.pageId : String(site.pageId || "").split(/\r?\n/)).map(x => String(x).trim()).filter(Boolean);
export const usable = s => !!(s.qid || s.idProperty || parseTemplates(s).some(t => t.prop && t.prop !== "P1343"));
// for a URL that came from a search: which property + value? (value null = can't be read)
export function propForUrl(site, url) {
  const m = matchTemplates(site, url);
  const fromPage = pageIdPatterns(site).length > 0;                     // the ID is only on the page: a URL alone can't give it
  if (m) return { prop: m.prop, value: m.prop && fromPage ? null : m.value };
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
  const names = [], choiceDefs = [];
  for (const part of t.split(PH)) {
    if (part === "{path}") {                      // several directories: history/encyclopedias/industrial-capitalism
      if (idGroup) src += "\\" + idGroup; else { src += "([^?#]+)"; idGroup = ++groups; names.push("id"); multi = true; }
    }
    else if (part === "{id}") { if (idGroup) src += "\\" + idGroup; else { src += "([^/?#]+)"; idGroup = ++groups; names.push("id"); } }
    else if (part === "{first}" || part === "{FIRST}") { src += "([^/?#]+)"; groups++; names.push("first"); }
    else if (/^\{[^{}]*\|[^{}]*\}$/.test(part)) {
      const alts = part.slice(1, -1).split("|").map(x => x.trim()).filter(Boolean);
      src += "(" + alts.map(esc).join("|") + ")"; groups++; names.push("choice"); choiceDefs.push(alts);   // captured: which alternative the URL used
    } else src += esc(part);
  }
  return { re: new RegExp("^" + src + "/?$", "i"), hasQuery: t.includes("?"), names, multi, choiceDefs };
}

export function effectiveMatch(site) {
  let m = (site.match || "").trim();
  if (!m) {
    const pts = parseTemplates(site), t = (pts.find(x => !x.direct) || pts[0])?.tpl;
    if (t) m = isDirectTemplate(t) ? stripProto(t).split(/[/?#]/)[0] : stripProto(t).split(PH)[0].split("?")[0].replace(/\/$/, "");     // a direct link only names the website (it matches that page alone)
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

// "economy of scale" -> the noun that takes the plural is "economy", not "scale". The head noun is the word before the
// first preposition/conjunction (if there is one after at least one other word); otherwise it is the last word.
const LINKERS = new Set(["of", "for", "in", "on", "to", "with", "from", "by", "per", "at", "and", "vs", "versus"]);
export function headIndex(words) {
  for (let i = 1; i < words.length; i++) if (LINKERS.has(words[i].toLowerCase())) return i - 1;
  return words.length - 1;
}
// All spellings worth trying: the term itself, then other number forms of the head noun (and of the last word when it differs)
export function wordVariants(words, max = 3) {
  if (!words.length) return [words];
  const out = [words], seen = new Set([words.join(" ").toLowerCase()]);
  const idxs = [...new Set([headIndex(words), words.length - 1])];
  for (const i of idxs) for (const f of altForms(words[i]).slice(0, 2)) {
    const w = words.slice(); w[i] = f;
    const k = w.join(" ").toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(w); }
  }
  return out.slice(0, max + 1);
}

export function termForms(words, site) {
  if (!site.plurals || !words.length) return [words];
  return wordVariants(words);
}

// ---------- which configured site is this URL? ----------
export function matchTemplates(site, urlStr) {
  let u; try { u = new URL(urlStr); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = host + u.pathname;
  let best = null;
  for (const tpl of cleanTemplates(site)) {
    const { re, hasQuery, names, multi, choiceDefs } = templateRegex(tpl);
    const m = (hasQuery ? path + u.search : path).match(re);
    if (m && isDirectTemplate(tpl)) {                                // a direct link: this very page, no ID (an exact link beats every pattern)
      if (!best || !best.direct) best = { score: 1e4 + tpl.length, template: tpl, direct: true, raw: "", slug: "", multi: false, sep: "none", choices: [], prop: "", words: [], value: "" };
      continue;
    }
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
      let ci = 0;                                            // which alternative of each {a|b} group did the URL use?
      const choices = names.map((n, i) => n === "choice" ? m[i + 1] : null).filter(v => v !== null).map(v => {
        const alts = choiceDefs[ci++];
        return { value: v, index: Math.max(0, alts.findIndex(a => a.toLowerCase() === v.toLowerCase())), of: alts.length };
      });
      best = { score: tpl.length, template: tpl, raw, slug, multi, sep, choices, prop: templateProp(site, tpl), words: splitWords(slugEnc, sep),
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
  if (best) return best.extracted.direct ? { site: best.site, extracted: null, direct: true } : { site: best.site, extracted: best.extracted };

  let bs = null, bl = -1;
  const hp = path.toLowerCase();
  for (const site of sites) {
    const m = effectiveMatch(site);
    if (!usable(site) || !m) continue;
    if (!(site.match || "").trim() && parseTemplates(site).length && parseTemplates(site).every(x => x.direct)) continue;   // only direct links: they match their own page, not the whole website
    const ok = m.includes("/") ? hp.startsWith(m) : (host === m || host.endsWith("." + m));
    if (ok && m.length > bl) { bs = site; bl = m.length; }
  }
  return bs ? { site: bs, extracted: null } : null;
}

// For IDs without separators (MonotonicFunction, FundamentalTheoremofArithmetic) the words can't be known from
// the URL alone. Only accept a reading that matches a term we got from Wikidata (label/alias) or the clipboard.
// ---------- splitting run-together IDs ("incomestatement" -> income statement) ----------
// Viterbi over a frequency-ranked English word list (Zipf's law: cost of a word ~ log(rank)), like the wordninja library.
let _seg = null;
function segModel() {
  if (_seg) return _seg;
  const words = EN_WORDS.split(" "), cost = new Map(), lg = Math.log(words.length);
  words.forEach((w, i) => cost.set(w, Math.log((i + 1) * lg)));
  return (_seg = { cost, max: words.reduce((m, w) => Math.max(m, w.length), 0) });
}
// Returns an array of words, or null when the string does not split into at least two known words
export function segmentWords(str) {
  const { cost, max } = segModel();
  const out = [];
  for (const run of String(str).toLowerCase().match(/[a-z]+|\d+/g) || []) {
    if (/^\d/.test(run)) { out.push(run); continue; }
    const n = run.length, best = [0], from = [0];
    for (let i = 1; i <= n; i++) {
      let bc = Infinity, bk = 0;
      for (let k = Math.max(0, i - max); k < i; k++) {
        const c = cost.get(run.slice(k, i));
        const t = best[k] + (c === undefined ? 9e9 : c);
        if (t < bc) { bc = t; bk = k; }
      }
      best[i] = bc; from[i] = bk;
    }
    if (best[n] >= 9e9) return null;                                   // some part is not a known word: do not guess
    const parts = [];
    for (let i = n; i > 0; i = from[i]) parts.unshift(run.slice(from[i], i));
    out.push(...parts);
  }
  if (out.length < 2) return null;
  // tiny fragments are usually a bad split (ebitda -> eb it da): only real short words are allowed
  return out.every(w => w.length > 2 || /^\d/.test(w) || SHORT_OK.has(w)) ? out : null;
}
const SHORT_OK = new Set("a i of to in on an as at by is it or no so up us we he be do go my me if vs and the for".split(" "));

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
export function buildCandidates(sites, currentSite, ids, { perSite = 30, total = 90, curCats = null } = {}) {
  const mine = curCats || cats(currentSite);               // curCats: the categories of this page (choice groups resolved)
  if (!mine.length) return [];
  const out = [], seen = new Set(), count = new Map();
  for (const id of ids) for (const site of sites) {
    if (!usable(site) || !sharesCat(mine, site) || !langOk(id, site)) continue;
    for (const sep of sepList(site)) for (const words of termForms(id.words, site)) {
      const parts = idParts(words, { ...site, separator: sep });
      for (const tpl of buildableTemplates(site)) for (const url of buildUrls(tpl, parts)) {
        const n = count.get(site) || 0;
        if (n >= perSite || out.length >= total) continue;
        const k = normUrl(url);
        if (seen.has(k)) continue;
        seen.add(k); count.set(site, n + 1);
        const prop = templateProp(site, tpl), fromPage = !!prop && pageIdPatterns(site).length > 0;   // fromPage: the ID value is read from the page once it is found
        out.push({ site, template: tpl, url, prop, sep, fromPage,
          value: fromPage ? null : fillValue(valuePattern(site, tpl), { raw: parts.raw, first: parts.rawLower }) });
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
// The clipboard must START with the entity: an item "Q123", or a lexeme "L123" (also a form "L123-F1" or sense "L123-S1"),
// or a Wikidata URL (…/wiki/Q123, …/entity/Q123, …/wiki/Lexeme:L123, …/wiki/Lexeme:L123#F1).
// Optional extra terms follow, separated by commas, semicolons or new lines. Multi-word terms are fine, and a
// language tag ("it:") applies to itself and to the untagged terms after it, until the next tag:
//     Q123, en: Pythagorean theorem, Pythagoras' theorem, it: teorema di Pitagora
// Terms before any tag have no language (all websites use them). Anything that is not a plain short phrase
// (JSON, URLs, symbols…) is ignored; text that does not start with an item is rejected outright.
export function parseClipboard(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 600) return null;
  const lm = t.match(/^([^\n\r]{1,150}?)\s*\((Q\d+|L\d+(?:-[FS]\d+)?)\)$/i);      // "Pythagorean theorem (Q11518)", "run (L1234)"
  if (lm && !/[{}\[\]<>"]/.test(lm[1])) return { item: lm[2].toUpperCase(), extras: [] };
  const m = t.match(/^(?:https?:\/\/(?:www\.|m\.)?wikidata\.org\/(?:wiki|entity)\/)?(?:(Q\d+)(?![\w])|(?:Lexeme:)?(L\d+)(?:-([FS]\d+)|#([FS]\d+))?(?![\w-]))[^\s,;]*/i);
  if (!m) return null;
  const id = m[1] ? m[1].toUpperCase() : m[2].toUpperCase() + ((m[3] || m[4]) ? "-" + (m[3] || m[4]).toUpperCase() : "");
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
  return { item: id, extras };   // item = Q123 / L123 / L123-F1 / L123-S1;  extras: [{text, words, lang}]
}

// ---------- defining a website from an item / property ----------
//   "Harvard Business School Online (Q133732538)"   "Investopedia term ID (P10715)"   "P10715"   https://www.wikidata.org/wiki/Property:P10715
// A bare item (Q123) is ambiguous (it is also what you normally copy to SAVE statements on), so it only counts when asked for explicitly.
export function parseSiteClipboard(text, { allowBareItem = false } = {}) {
  const t = String(text || "").trim();
  if (!t || t.length > 250 || /[\n\r]/.test(t)) return null;
  let m = t.match(/^(.{1,150}?)\s*\(([QP]\d+)\)$/i);
  if (m && !/[{}\[\]<>"]/.test(m[1])) { const id = m[2].toUpperCase(); return { id, kind: id[0] === "P" ? "property" : "item", label: m[1].trim() }; }
  const head = "(?:https?:\\/\\/(?:www\\.|m\\.)?wikidata\\.org\\/(?:wiki|entity)\\/)?";
  m = t.match(new RegExp("^" + head + "(?:Property:)?(P\\d+)(?:[#?].*)?$", "i"));
  if (m) return { id: m[1].toUpperCase(), kind: "property", label: "" };
  if (allowBareItem) {
    m = t.match(new RegExp("^" + head + "(Q\\d+)(?:[#?].*)?$", "i"));
    if (m) return { id: m[1].toUpperCase(), kind: "item", label: "" };
  }
  return null;
}
// formatter URL (P1630), which always holds $1 (Wikidata requires it), -> a URL template. {id} is ONE path segment, {path} several directories; which one is read off the URL:
//   $1 is the whole first path segment and the last one too (https://www.encyclopedia.com/$1, https://example.org/$1/)  -> {path}: the ID is the page's whole path
//   anything else (…/terms/$1.asp, …/entry/$1, …/$1/definition, …?id=$1)                                              -> {id}
export function formatterTemplate(f) {
  const s = String(f || "").trim();
  const m = s.match(/^(https?:\/\/[^\/?#]+)(\/[^?#]*)?([?#].*)?$/i);
  if (!m || !s.includes("$1")) return null;
  const ph = /^\/\$1\/?$/.test(m[2] || "") ? "{path}" : "{id}";
  return s.split("$1").join(ph);
}
// string values worth using: not deprecated; preferred rank wins over normal
export function usableValues(claims) {
  const ok = (claims || []).filter(c => c.rank !== "deprecated" && c.mainsnak?.snaktype === "value" && typeof c.mainsnak.datavalue?.value === "string");
  const pref = ok.filter(c => c.rank === "preferred");
  return [...new Set((pref.length ? pref : ok).map(c => c.mainsnak.datavalue.value.trim()))];
}

// Page on wikidata.org for an entity id (Q123, L123, L123-F1, L123-S1); null when it is none of those
export function entityUrl(id) {
  const m = String(id || "").match(/^(?:(Q\d+)|(L\d+)(?:-([FS]\d+))?)$/);
  if (!m) return null;
  return "https://www.wikidata.org/wiki/" + (m[1] || "Lexeme:" + m[2] + (m[3] ? "#" + m[3] : ""));
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

export async function checkUrl(url, site, settings, fetcher = plainFetch, signal, wantBody = false) {
  try {
    const res = await fetcher(url, { redirect: "follow", credentials: site.cookies ? "include" : "omit", timeoutMs: 10000, signal });
    if (!res.ok) { res.body?.cancel(); return { found: false, reason: `HTTP ${res.status}`, definitive: [404, 410].includes(res.status) }; }
    const finalUrl = res.url || url;
    if (!sameUrlLoose(finalUrl, url)) {            // case / trailing slash / www / http-https differences are always fine
      if ((site.redirects || settings.redirects) !== "accept") {
        res.body?.cancel(); return { found: false, reason: "redirected elsewhere", definitive: true };
      }
      const why = redirectProblem(site, url, finalUrl);
      if (why) { res.body?.cancel(); return { found: false, reason: `redirected to ${finalUrl} – not accepted: ${why}`, definitive: true }; }
    }
    let html;
    if ((site.notFound && site.notFound.trim()) || wantBody) {
      const body = await res.text();
      if (wantBody) html = body.slice(0, 6e6);
      if (site.notFound && site.notFound.trim()) {
        try { if (new RegExp(site.notFound, "i").test(body)) return { found: false, reason: "matched 'not found' text", definitive: true }; }
        catch { /* bad regex: ignore */ }
      }
    } else res.body?.cancel();
    return { found: true, url: finalUrl.split("#")[0], ...(html !== undefined ? { html } : {}) };
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

// ---------- blocked sites ----------
// The block list holds two kinds of entries:
//   example.com               a whole website (also blocks www. and subdomains)
//   youtube.com/@handle       ONE YouTube channel (youtube.com/channel/UC… for channels without a handle); other channels of youtube.com stay allowed
// A video URL only holds the video ID, so which channel it belongs to is read from YouTube (see ytChannelOf in background.js).
const YT_CHANNEL = /^(?:(?:www|m|music)\.)?youtube\.com\/(@[^/?#\s]+|channel\/UC[\w-]{20,})/i;
// "@NASA" / "youtube.com/@NASA/videos" / "https://www.youtube.com/channel/UC…" -> "youtube.com/@nasa" / "youtube.com/channel/UC…" ("" when it is no channel)
export function youtubeChannelKey(x) {
  let t = String(x || "").replace(/#.*$/, "").trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  if (/^@[^/?#\s]+$/.test(t)) t = "youtube.com/" + t;                // a bare @handle
  const m = t.match(YT_CHANNEL);
  if (!m) return "";
  let part = m[1];
  if (part[0] === "@") { try { part = decodeURIComponent(part); } catch { /* keep */ } return "youtube.com/" + part.toLowerCase(); }
  return "youtube.com/" + part;                                       // channel IDs are case-sensitive
}
// "https://www.Example.com/forum/x" -> "example.com"; a YouTube channel URL -> "youtube.com/@handle" ("" when it can't be a website). A blocked site also blocks its subdomains.
export function normBlockHost(x) {
  const ch = youtubeChannelKey(x);
  if (ch) return ch;
  const t = String(x || "").replace(/#.*$/, "").trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?:].*$/, "").replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(t) ? t : "";
}
// the entry of the block list that covers this URL ("" = not blocked). A whole-website entry, or - for a YouTube channel/handle URL - that channel's entry.
// (A youtube.com/watch URL holds no channel: that is checked with blockedChannel once the channel is known.)
export function blockedHost(list, url) {
  let h = ""; try { h = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
  for (const b of list || []) if (h === b || h.endsWith("." + b)) return b;
  const ch = youtubeChannelKey(url);
  return ch && (list || []).includes(ch) ? ch : "";
}
// a channel key (youtube.com/@handle) that is on the list -> that entry, else ""
export const blockedChannel = (list, key) => (key && (list || []).includes(key)) ? key : "";
// the video-page URL of YouTube (watch / shorts / live / embed): its channel is not in the URL
export const isYouTubeVideoUrl = u => { const sc = scraperFor(u); return !!(sc && sc.qualProp === "P1651" && sc.idFromUrl(new URL(u))); };
// YouTube's oEmbed answer for a video -> channel key. author_url is https://www.youtube.com/@handle (or /channel/UC… for old channels); other shapes (/user/, /c/) can't be matched to a handle -> ""
export const channelKeyFromAuthorUrl = u => youtubeChannelKey(u);
export const channelLabel = key => String(key || "").replace(/^youtube\.com\//, "").replace(/^channel\//, "channel ");

// ---------- "one verbatim Google search" mode ----------
// Google's Verbatim mode (tbs=li:1, the same as Tools > Verbatim) searches the words as typed: no synonyms, spelling corrections or dropped words. The term is also put in double quotes, so it must appear as that exact phrase. hl=en keeps the buttons the search script clicks in English.
// helper words ("key terms") that give the expression its context: "public property" law -> Google leans to the legal concept instead of real estate.
// The expression stays verbatim (quoted, and tbs=li:1 below); the key terms are only helpers, a hit need not contain them.
export const cleanKeywords = k => String(k || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
export const googleQuery = (term, keywords) => { const k = cleanKeywords(keywords); return `"${term}"` + (k ? " " + k : ""); };       // the expression is ALWAYS quoted (an exact phrase), with or without key terms
export const googleVerbatimUrl = (term, keywords = "") => `https://www.google.com/search?q=${encodeURIComponent(googleQuery(term, keywords))}&tbs=li:1&hl=en`;
export const googleScript = pages => 'click button "Accept all"\ncollect' + (pages > 1 ? `\npages link "Page {n}" max=${Math.min(5, pages)}` : "");
const GOOGLE_NOISE = /(^|\.)(google\.[a-z.]+|googleusercontent\.com|gstatic\.com|googleadservices\.com|doubleclick\.net|wikidata\.org|schema\.org)$/i;
// links read from a Google results page -> [{url, text}]: redirects unwrapped, Google's own links/ads dropped, one entry per page (the longest link text = the title)
export function googleHits(links) {
  const out = new Map();
  for (const l of links || []) {
    const href = unwrapRedirect(l.href || "");
    let u; try { u = new URL(href); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || GOOGLE_NOISE.test(u.hostname)) continue;
    u.hash = "";
    const k = normUrl(u.href), text = String(l.text || "").replace(/\s+/g, " ").trim();
    const old = out.get(k);
    if (!old) out.set(k, { url: cleanYouTubeUrl(u.href), text });
    else if (text.length > old.text.length) old.text = text;
  }
  return [...out.values()];
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
    return wordVariants(t.split(" ")).map(w => w.join("-"));   // one-sided-limit / one-sided-limits, economy-of-scale / economies-of-scale
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
  busy:      { badge: "…",  color: "#546e7a", text: "#ffffff", ms: 6000, label: "Another run is still active" },
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
// ---------- IDs that the URL does not show but the page carries ----------
// YouTube: a video page's source is the CHANNEL (the Wikidata item whose YouTube handle, P11245, equals the handle embedded in the page).
export const PAGE_SCRAPERS = [{
  name: "YouTube channel handle",
  test: u => /(^|\.)youtube\.com$/i.test(u.hostname) && /^\/(watch|shorts|live|embed)\b/.test(u.pathname),
  func: youtubeInPage,
  prop: "P11245",                                     // property that holds the scraped value on the item to use as the source
  qualProp: "P1651",                                  // the video ID is a qualifier of the P1343 statement (instead of the URL, P2699)
  idFromUrl: u => u.searchParams.get("v") || (u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{6,})/) || [])[1] || "",
  noTerms: true                                       // a video ID is not a word: do not search other websites for it
}];
export const scraperFor = urlStr => { try { const u = new URL(urlStr); return PAGE_SCRAPERS.find(x => x.test(u)) || null; } catch { return null; } };

// runs INSIDE the page (chrome.scripting.executeScript): self-contained, returns {value, from}
export function youtubeInPage() {
  const handleOf = h => {
    try { const m = decodeURIComponent(new URL(h, location.href).pathname).match(/^\/@([^/]+)/); return m ? m[1] : ""; } catch { return ""; }
  };
  // 1. the channel link under the video (always the current video; the page is a single-page app, so it beats the old JSON blobs)
  for (const sel of ['ytd-watch-metadata ytd-video-owner-renderer a[href*="/@"]', "#owner a[href*='/@']", "#upload-info a[href*='/@']",
                     "ytd-reel-video-renderer[is-active] a[href*='/@']", 'ytd-channel-name a[href*="/@"]']) {
    const a = document.querySelector(sel); const h = a && handleOf(a.getAttribute("href"));
    if (h) return { value: h, from: "channel link under the video" };
  }
  // 2. structured data embedded in the page: <span itemprop="author"><link itemprop="url" href="…/@handle">
  const l = document.querySelector('[itemprop="author"] link[itemprop="url"], link[itemprop="url"][href*="/@"]');
  const h2 = l && handleOf(l.getAttribute("href"));
  if (h2) return { value: h2, from: "embedded author data" };
  // 3. the player response: "ownerProfileUrl":"http://www.youtube.com/@handle"
  for (const sc of document.scripts) {
    const t = sc.textContent;
    if (!t || t.length > 4e6 || !t.includes("ownerProfileUrl")) continue;
    const m = t.match(/"ownerProfileUrl":"[^"]*?\/(@[^"\\/]+)"/);
    if (m) { try { return { value: decodeURIComponent(m[1].slice(1)), from: "player data" }; } catch { return { value: m[1].slice(1), from: "player data" }; } }
  }
  return { value: "", from: "" };
}

// runs INSIDE the page (chrome.scripting.executeScript): self-contained. The HTML is analysed in the offscreen document (extractPageId),
// so the page you are on and pages that were only fetched go through the same code.
export function pageHtmlInPage() {
  const h = document.documentElement ? document.documentElement.outerHTML : "";
  return h.length > 6e6 ? h.slice(0, 6e6) : h;
}

export function parsePageIdSpec(line) {
  const t = String(line || "").trim();
  const split = s => { const i = s.indexOf(" | "); return i < 0 ? [s.trim(), null] : [s.slice(0, i).trim(), s.slice(i + 3).trim()]; };
  let m;
  if ((m = t.match(/^meta\s+(.+)$/i)))   { const [arg, rx] = split(m[1]); return { kind: "meta", arg, rx }; }
  if ((m = t.match(/^jsonld\s+(.+)$/i))) { const [arg, rx] = split(m[1]); return { kind: "jsonld", arg, rx }; }
  if ((m = t.match(/^css\s+(.+)$/i)))    { const [a, rx] = split(m[1]); const am = a.match(/^(.*?)\s+@([\w:-]+)$/); return { kind: "css", arg: (am ? am[1] : a).trim(), attr: am ? am[2] : null, rx }; }
  if ((m = t.match(/^html\s+(.+)$/i)))   return { kind: "html", rx: m[1] };
  return { kind: "html", rx: t };
}

// doc: a parsed Document; html: its source. -> {value, from} or {value:"", bad:[…], hints:[…]} (hints: snippets around long numbers, to help write a pattern)
export function extractPageId(doc, html, lines, baseUrl) {
  // @href / @src / @link / @url resolve relative addresses against the page (baseUrl) when it is known
  const linkAttr = (el, attr) => {
    const abs = v => { try { return baseUrl ? new URL(v, baseUrl).href : v; } catch { return v; } };
    if (/^(link|url)$/i.test(attr)) { const a = el.matches("[href]") ? el : (el.closest("a[href]") || el.querySelector("a[href]")); return a ? abs(a.getAttribute("href")) : ""; }
    const v = el.getAttribute(attr);
    return v && /^(href|src|action|poster|data|cite)$/i.test(attr) ? abs(v.trim()) : v;
  };
  const bad = [];
  const rxOf = src => { try { return new RegExp(src, "i"); } catch { bad.push(src); return null; } };
  const narrow = (v, rx) => {
    v = String(v ?? "").trim();
    if (v && rx) { const r = rxOf(rx), m = r && v.match(r); v = m ? String(m[1] ?? m[0]).trim() : ""; }
    return v && v.length <= 100 ? v : "";
  };
  const jsonFind = (o, key) => {
    if (Array.isArray(o)) { for (const x of o) { const r = jsonFind(x, key); if (r !== undefined) return r; } return undefined; }
    if (o && typeof o === "object") {
      if (key in o && (typeof o[key] === "string" || typeof o[key] === "number")) return o[key];
      for (const v of Object.values(o)) { const r = jsonFind(v, key); if (r !== undefined) return r; }
    }
    return undefined;
  };
  for (const line of lines || []) {
    const sp = parsePageIdSpec(line);
    let v = "";
    try {
      if (sp.kind === "html") { const r = rxOf(sp.rx), m = r && html.match(r); v = m ? narrow(m[1] ?? m[0], null) : ""; }
      else if (sp.kind === "meta") {
        const want = sp.arg.toLowerCase();
        const el = [...doc.querySelectorAll("meta")].find(x => ["name", "property", "itemprop", "http-equiv"].some(a => (x.getAttribute(a) || "").toLowerCase() === want));
        v = narrow(el && el.getAttribute("content"), sp.rx);
      } else if (sp.kind === "css") {
        const el = doc.querySelector(sp.arg);
        v = narrow(el && (sp.attr ? linkAttr(el, sp.attr) : el.textContent), sp.rx);
      } else if (sp.kind === "jsonld") {
        for (const sc of doc.querySelectorAll('script[type="application/ld+json"]')) {
          let j; try { j = JSON.parse(sc.textContent); } catch { continue; }
          const f = jsonFind(j, sp.arg);
          if (f !== undefined && (v = narrow(f, sp.rx))) break;
        }
      }
    } catch { bad.push(line); }
    if (v) return { value: v, from: line };
  }
  const found = [], re = /\d{6,}/g; let m;
  while ((m = re.exec(html)) && found.length < 60) found.push(html.slice(Math.max(0, m.index - 45), m.index + m[0].length + 12).replace(/\s+/g, " "));
  const likely = x => /entry|doi|\bid\b|identifier|record|canonical/i.test(x);
  return { value: "", bad, hints: [...found.filter(likely), ...found.filter(x => !likely(x))].slice(0, 8) };
}
// what is stored in the ID property when its value came from the page ({id} in the value pattern = the value read)
export const pageValueFor = (site, tpl, v) => fillValue(valuePattern(site, tpl), { raw: v, first: v.charAt(0) });

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
