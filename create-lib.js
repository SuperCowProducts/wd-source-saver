// Create a new Wikidata item from the page you are on (pure functions: used by background.js, create.js and the tests).
//
// A website's "Create item" recipe is one line per thing to fill in:
//
//   label ##.title-text                          the label (language of the website, or label:de ##…)
//   description =scholarly article               a description (a fixed text after "=")
//   alias ##.alt-title                           every match becomes an alias
//   P356 ##.doi-link .anchor-text                an ID / string / URL / item / monolingual-text statement
//   P856 {url}                                   the page's own address (as saved by the website's URL mode)
//   P31 =Q13442814                               a fixed value ("=" text; {url} {id} {title} are replaced)
//
// Where a value comes from:  ##css selector   (text of the first match; "##meta[name=citation_title] @content" reads an attribute)
//                            {url} {id} {title}   or   =fixed text   (may contain {url} {id} {title})
// Lines starting with "#" followed by a space, or "//", are comments.

const TARGET = /^(label|description|alias|P\d+)(?::([A-Za-z][A-Za-z0-9-]*))?\s+(\S[\s\S]*)$/i;

export function parseRecipe(lines) {
  const rows = [], errors = [];
  (Array.isArray(lines) ? lines : String(lines || "").split(/\r?\n/)).map(x => String(x).trim()).forEach((line, n) => {
    if (!line || /^#\s/.test(line) || line === "#" || line.startsWith("//")) return;
    const m = line.match(TARGET);
    if (!m) { errors.push(`“${line.slice(0, 60)}”: start with label, description, alias or a property (P123), then where the value comes from`); return; }
    const kind = /^P/i.test(m[1]) ? "prop" : m[1].toLowerCase();
    const row = { line, kind, prop: kind === "prop" ? m[1].toUpperCase() : "", lang: (m[2] || "").toLowerCase() };
    let src = m[3].trim();
    if (src.startsWith("##")) {
      let sel = src.slice(2).trim(), attr = "";
      const a = sel.match(/\s@([A-Za-z_:][\w:.-]*)$/);                // "…selector @href"
      if (a) { attr = a[1]; sel = sel.slice(0, a.index).trim(); }
      if (!sel) { errors.push(`“${line.slice(0, 60)}”: the selector after ## is empty`); return; }
      row.src = { type: "css", sel, attr };
    } else {
      if (src.startsWith("=")) src = src.slice(1).trim();
      if (!src) { errors.push(`“${line.slice(0, 60)}”: the value is empty`); return; }
      row.src = { type: "text", text: src };
    }
    if (row.kind !== "prop" && row.lang && !/^[a-z]{2,3}(-[a-z0-9]+)*$/.test(row.lang)) { errors.push(`“${line.slice(0, 60)}”: “${row.lang}” is not a language code`); return; }
    rows.push(row);
  });
  return { rows, errors };
}

export const fillTokens = (text, t) => String(text).replace(/\{(url|id|title)\}/gi, (_, k) => t[k.toLowerCase()] ?? "");

// Runs INSIDE the page (chrome.scripting.executeScript): specs [{i, sel, attr, all}] -> {title, results: {i: {values: [..], error?}}}
export function readCreateSpecsInPage(specs) {
  const clean = s => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const results = {};
  for (const sp of specs || []) {
    try {
      const els = [...document.querySelectorAll(sp.sel)];
      // @href / @src / @link / @url give the full address (relative links resolved against the page); @link/@url also accept a wrapper around the <a>
      const LINKY = /^(href|src|action|poster|data|cite|srcset)$/i;
      const absolute = v => { try { return new URL(v, document.baseURI).href; } catch { return v; } };
      const attrOf = el => {
        if (!sp.attr) return el.innerText || el.textContent;
        if (/^(link|url)$/i.test(sp.attr)) {
          const a = el.matches("[href]") ? el : (el.closest("a[href]") || el.querySelector("a[href]"));
          return a ? absolute(a.getAttribute("href")) : "";
        }
        const v = el.getAttribute(sp.attr);
        return v && LINKY.test(sp.attr) && !/^srcset$/i.test(sp.attr) ? absolute(v.trim()) : v;
      };
      const vals = els.map(el => clean(attrOf(el))).filter(Boolean);
      results[sp.i] = { values: sp.all ? [...new Set(vals)] : vals.slice(0, 1), matches: els.length };
    } catch (e) { results[sp.i] = { values: [], matches: 0, error: String(e && e.message || e) }; }
  }
  return { title: clean(document.title), results };
}

// ---------- values ----------
export const STRING_TYPES = new Set(["string", "external-id", "url", "commonsMedia", "math", "geo-shape", "tabular-data", "musical-notation"]);
const stripScheme = s => String(s).replace(/^https?:\/\/(?:www\.)?/i, "");
export function stripFormatter(value, formatter) {                       // "https://doi.org/10.1/x" + formatter "https://doi.org/$1" -> "10.1/x"
  const i = String(formatter || "").indexOf("$1");
  if (i < 0) return value;
  const prefix = stripScheme(formatter.slice(0, i)), suffix = formatter.slice(i + 2), v = stripScheme(value);
  if (!prefix || !v.toLowerCase().startsWith(prefix.toLowerCase())) return value;
  let r = v.slice(prefix.length);
  if (suffix && r.toLowerCase().endsWith(suffix.toLowerCase())) r = r.slice(0, -suffix.length);
  try { r = decodeURIComponent(r); } catch { /* keep */ }
  return r;
}

// info = {datatype, formatter, regex, label} of the property (null = unknown property). -> {ok, value, why?, datavalue?}
export function makeValue(prop, info, raw, lang = "") {
  let v = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
  if (!v) return { ok: false, value: "", why: "nothing found – type the value, or untick this row" };
  if (!info) return { ok: false, value: v, why: `${prop} was not found on Wikidata` };
  const dt = info.datatype;
  if (dt === "wikibase-item") {
    const q = (v.match(/\bQ\d+\b/i) || [""])[0].toUpperCase();
    return q ? { ok: true, value: q, datavalue: { type: "wikibase-entityid", value: { "entity-type": "item", "numeric-id": Number(q.slice(1)), id: q } } }
             : { ok: false, value: v, why: "an item such as Q123 is needed" };
  }
  if (dt === "monolingualtext") {
    const l = String(lang || "").toLowerCase();
    if (!/^[a-z]{2,3}(-[a-z0-9]+)*$/.test(l)) return { ok: false, value: v, why: "a language code is needed (en, de…)" };
    return { ok: true, value: v, datavalue: { type: "monolingualtext", value: { text: v, language: l } } };
  }
  if (!STRING_TYPES.has(dt)) return { ok: false, value: v, why: `datatype “${dt}” is not supported here – add it on Wikidata afterwards` };
  if (dt === "external-id") {
    v = stripFormatter(v, info.formatter);
    if (prop === "P356") v = v.replace(/^doi:\s*/i, "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").toUpperCase();   // DOIs are stored upper-case, without the resolver
    if (info.regex) { let ok = true; try { ok = new RegExp(`^(?:${info.regex})$`).test(v); } catch { /* unusable pattern: no check */ } if (!ok) return { ok: false, value: v, why: `does not match the format of ${prop}` }; }
  } else if (dt === "url") {
    if (!/^(https?|ftp):\/\/[^\s/$.?#][^\s]*$/i.test(v)) return { ok: false, value: v, why: "a full web address (https://…) is needed" };
  }
  if (v.length > 1500) return { ok: false, value: v, why: "longer than 1500 characters" };
  return { ok: true, value: v, datavalue: { type: "string", value: v } };
}
export const claimFor = (prop, datavalue) => ({ type: "statement", rank: "normal", mainsnak: { snaktype: "value", property: prop, datavalue } });

// ---------- the draft shown in the window ----------
// recipe rows + what was read from the page -> {labels, descriptions, aliases, statements}
//   read:  {title, results}  from readCreateSpecsInPage;  tokens: {url, id, title};  infos: Map prop -> info;  defLang: language of the website
export function buildDraft(rows, read, tokens, infos, defLang) {
  const valuesOf = (row, i) => row.src.type === "text" ? [fillTokens(row.src.text, tokens)] : (read.results?.[i]?.values || []);
  const noteOf = (row, i) => row.src.type === "text" ? row.line : read.results?.[i]?.error ? `${row.line} – selector error: ${read.results[i].error}`
    : read.results?.[i]?.matches ? row.line : `${row.line} – no element matches`;
  const labels = [], descriptions = [], aliases = [], statements = [];
  const firstWins = (list, row, i) => {                                   // label/description: the first line that finds something wins; if none does, an empty row to type into
    const lang = row.lang || defLang, have = list.find(x => x.lang === lang);
    const v = valuesOf(row, i)[0] || "";
    if (!have) list.push({ lang, value: v, note: noteOf(row, i) });
    else if (!have.value && v) { have.value = v; have.note = noteOf(row, i); }
  };
  rows.forEach((row, i) => {
    if (row.kind === "label") firstWins(labels, row, i);
    else if (row.kind === "description") firstWins(descriptions, row, i);
    else if (row.kind === "alias") for (const v of valuesOf(row, i)) { const lang = row.lang || defLang; if (!aliases.some(a => a.lang === lang && a.value === v)) aliases.push({ lang, value: v, note: noteOf(row, i) }); }
    else {
      const info = infos.get(row.prop) || null, raw = valuesOf(row, i)[0] || "", lang = row.lang || defLang;
      const mv = makeValue(row.prop, info, raw, lang);
      if (statements.some(s => s.prop === row.prop && s.value === mv.value && s.lang === lang)) return;
      statements.push({ id: "s" + i, prop: row.prop, info, lang, value: mv.value, ok: mv.ok, why: mv.why || "", note: noteOf(row, i) });
    }
  });
  return { labels, descriptions, aliases, statements };
}

// ---------- what is sent to Wikidata ----------
export function buildItemData({ labels = [], descriptions = [], aliases = [], claims = [] }) {
  const data = { labels: {}, descriptions: {}, aliases: {}, claims };
  for (const x of labels) if (x.lang && x.value) data.labels[x.lang] = { language: x.lang, value: x.value };
  for (const x of descriptions) if (x.lang && x.value) data.descriptions[x.lang] = { language: x.lang, value: x.value };
  for (const x of aliases) if (x.lang && x.value && data.labels[x.lang]?.value !== x.value) (data.aliases[x.lang] = data.aliases[x.lang] || []).push({ language: x.lang, value: x.value });
  return data;
}
export const LANG_OK = l => /^[a-z]{2,3}(-[a-z0-9]+)*$/.test(String(l || ""));
// problems that Wikidata would refuse (null = fine)
export function draftProblem({ labels = [], descriptions = [], aliases = [] }) {
  const L = labels.filter(x => x.value);
  if (!L.length) return "a label is needed";
  for (const [n, list, max] of [["label", labels, 250], ["description", descriptions, 250], ["alias", aliases, 250]])
    for (const x of list) {
      if (!x.value) continue;
      if (!LANG_OK(x.lang)) return `“${x.lang || "(empty)"}” is not a language code (${n})`;
      if (x.value.length > max) return `a ${n} is longer than ${max} characters`;
    }
  for (const [n, list] of [["label", labels], ["description", descriptions]]) {
    const seen = new Set();
    for (const x of list) if (x.value) { if (seen.has(x.lang)) return `two ${n}s in “${x.lang}”`; seen.add(x.lang); }
  }
  if (labels.some(l => l.value && descriptions.some(d => d.lang === l.lang && d.value && d.value === l.value))) return "label and description must differ in the same language";
  return null;
}
