import { buildCandidates, originsFor, checkUrl, dedupeIds, effectiveMatch, cats, cleanTerm, usable, DEFAULTS,
  exportSettingsObject, parseSettingsImport, parseSearchScript, langsOf, KINDS } from "./lib.js";
import { getSites, getSettings, saveAll } from "./store.js";

const $ = id => document.getElementById(id);
let sites = [], idx = -1, settings = { ...DEFAULTS };

// ---------- website editor (one at a time) ----------
const FIELDS = [
  ["name", "f_name"], ["qid", "f_qid"], ["idProperty", "f_idprop"], ["category", "f_category"],
  ["templates", "f_templates", "lines"], ["plurals", "f_plurals", "bool"], ["archive", "f_archive", "bool"],
  ["separator", "f_sep", "sepset", "hyphen"], ["caseMode", "f_case", "text", "lower"], ["urlMode", "f_mode", "text", "nohash"],
  ["searchUrl", "f_searchUrl"], ["searchMode", "f_searchMode", "text", "fetch"], ["pickBy", "f_pickBy", "text", "title"],
  ["titleMatch", "f_titleMatch", "text", "equal"], ["approvePartial", "f_approvePartial", "bool"], ["language", "f_language"], ["searchScript", "f_searchScript"], ["searchMax", "f_searchMax"], ["searchRegex", "f_searchRegex"], ["searchExclude", "f_searchExclude"],
  ["idValue", "f_idvalue"], ["match", "f_match"], ["notFound", "f_notfound"], ["nonLetter", "f_nonletter"], ["smallWords", "f_small"]
];

const siteLabel = s => {
  const incomplete = !usable({ ...s, templates: s.templates || [] }) || !(s.match || (s.templates || []).length || s.searchUrl);
  const c = cats(s).join(", ");
  return `${s.name || effectiveMatch({ ...s, templates: s.templates || [] }) || s.qid || s.idProperty || "(new website)"}${c ? "  ·  " + c : ""}${incomplete ? "  ⚠ incomplete" : ""}`;
};

const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

function buildCatFilter() {
  const f = $("catFilter"), keep = f.value || lsGet("siteFilter", "*");
  const all = [...new Set(sites.flatMap(cats))].sort();
  f.innerHTML = "";
  const add = (v, t) => { const o = document.createElement("option"); o.value = v; o.textContent = t; f.append(o); };
  add("*", `all categories (${sites.length})`);
  for (const c of all) add("c:" + c, `${c} (${sites.filter(s => cats(s).includes(c)).length})`);
  add("none", `(no category) (${sites.filter(s => !cats(s).length).length})`);
  f.value = [...f.options].some(o => o.value === keep) ? keep : "*";
}

function visibleIndexes() {
  const f = $("catFilter").value, mode = $("sortSel").value;
  let ix = sites.map((_, i) => i).filter(i => f === "*" || (f === "none" ? !cats(sites[i]).length : cats(sites[i]).includes(f.slice(2))));
  if (idx >= 0 && !ix.includes(idx)) ix.push(idx);                  // the website being edited always stays in the list
  const nm = i => (sites[i].name || effectiveMatch({ ...sites[i], templates: sites[i].templates || [] }) || "~").toLowerCase();
  const key = { name: i => nm(i), cat: i => (cats(sites[i])[0] || "~") + "|" + nm(i), lang: i => (langsOf(sites[i])[0] || "~") + "|" + nm(i) }[mode];
  if (key) ix.sort((a, b) => key(a).localeCompare(key(b)));
  return ix;
}

function renderSelect() {
  buildCatFilter();
  const sel = $("siteSel");
  sel.innerHTML = "";
  const ix = visibleIndexes();
  for (const i of ix) { const o = document.createElement("option"); o.value = i; o.textContent = siteLabel(sites[i]); sel.append(o); }
  if (idx >= 0) sel.value = idx;
  $("shown").textContent = `${ix.length} of ${sites.length} websites shown`;
  $("editor").hidden = idx < 0;
  $("dup").disabled = $("del").disabled = idx < 0;
  refreshCats();
}
$("catFilter").onchange = () => { lsSet("siteFilter", $("catFilter").value); const ix = visibleIndexes(); if (ix.length && !ix.includes(idx)) idx = ix[0]; renderSelect(); if (idx >= 0) loadEditor(); };
$("sortSel").value = lsGet("siteSort", "saved");
$("sortSel").onchange = () => { lsSet("siteSort", $("sortSel").value); renderSelect(); };

function loadEditor() {
  const s = sites[idx];
  if (!s) return;
  for (const [key, id, type, def] of FIELDS) {
    const el = $(id), v = s[key];
    if (type === "bool") el.checked = !!v;
    else if (type === "sepset") { const on = String(v || def).split(/[,\s]+/); el.querySelectorAll("input[data-sep]").forEach(c => c.checked = on.includes(c.dataset.sep)); }
    else if (type === "lines") el.value = (v || []).join("\n");
    else el.value = v ?? def ?? "";
  }
}

function readField([key, id, type, def]) {
  const el = $(id);
  if (type === "bool") return el.checked;
  if (type === "sepset") { const on = [...el.querySelectorAll("input[data-sep]")].filter(c => c.checked).map(c => c.dataset.sep); return on.length ? on.join(",") : "hyphen"; }
  if (type === "lines") return el.value.split("\n").map(x => x.trim()).filter(Boolean);
  return el.value;
}

for (const f of FIELDS) {
  $(f[1]).addEventListener("input", () => {
    if (idx < 0) return;
    sites[idx][f[0]] = readField(f);
    const o = [...$("siteSel").options].find(x => Number(x.value) === idx); if (o) o.textContent = siteLabel(sites[idx]);
    refreshCats();
  });
}

function select(i) { idx = i; renderSelect(); loadEditor(); }
$("siteSel").onchange = () => select(Number($("siteSel").value));
$("new").onclick = () => { sites.push({}); select(sites.length - 1); $("f_name").focus(); };
$("dup").onclick = () => { const c = structuredClone(sites[idx]); c.name = (c.name || "") + " (copy)"; sites.splice(idx + 1, 0, c); select(idx + 1); };
$("del").onclick = () => {
  if (!confirm(`Delete “${siteLabel(sites[idx])}”?`)) return;
  sites.splice(idx, 1); select(Math.min(idx, sites.length - 1));
};

function normalizeSite(s) {
  const o = { ...s };
  o.qid = ((s.qid || "").match(/Q\d+/i) || [""])[0].toUpperCase();
  o.idProperty = ((s.idProperty || "").match(/P\d+/i) || [""])[0].toUpperCase();
  o.templates = (s.templates || []).map(t => t.trim()).filter(Boolean);
  for (const k of ["name", "category", "match", "notFound", "nonLetter", "smallWords", "searchUrl", "searchRegex", "searchExclude", "idValue"]) o[k] = (s[k] || "").trim();
  o.searchMax = Number(s.searchMax) > 0 ? Number(s.searchMax) : "";
  o.searchScript = (s.searchScript || "").trim();
  o.language = (s.language || "").trim().toLowerCase();
  return o;
}

function refreshCats() {
  const all = [...new Set(sites.flatMap(cats))];
  $("cats").innerHTML = all.map(c => `<option value="${c.replace(/"/g, "&quot;")}">`).join("");
  const sel = $("tcat"), prev = sel.value;
  sel.innerHTML = "";
  for (const c of all) { const o = document.createElement("option"); o.textContent = c; sel.append(o); }
  if (all.includes(prev)) sel.value = prev;
}

// ---------- settings ----------
const SET_FIELDS = [
  ["username", "s_username"], ["labelLang", "s_labelLang"], ["review", "s_review"], ["redirects", "s_redirects"],
  ["reviewThreshold", "s_reviewThreshold", "num"], ["maxPerEdit", "s_maxPerEdit", "num"], ["minEditInterval", "s_minEditInterval", "num"],
  ["maxEditsPerHour", "s_maxEditsPerHour", "num"], ["hostDelayMs", "s_hostDelayMs", "num"], ["maxPerSite", "s_maxPerSite", "num"],
  ["maxTotal", "s_maxTotal", "num"], ["maxlag", "s_maxlag", "num"], ["scriptMaxClicks", "s_scriptMaxClicks", "num"], ["scriptMaxSeconds", "s_scriptMaxSeconds", "num"], ["missTtlDays", "s_missTtlDays", "num"],
  ["related", "s_related", "bool"], ["useHistory", "s_useHistory", "bool"], ["logToFile", "s_logToFile", "bool"]
];
function loadSettings(src = settings) {
  for (const [k, id, t] of SET_FIELDS) { const el = $(id); if (t === "bool") el.checked = !!src[k]; else el.value = src[k] ?? ""; }
}
function collectSettings() {
  const o = {};
  for (const [k, id, t] of SET_FIELDS) {
    const el = $(id);
    if (t === "bool") o[k] = el.checked;
    else if (t === "num") { const n = Number(el.value); o[k] = Number.isFinite(n) && el.value !== "" ? n : DEFAULTS[k]; }
    else o[k] = el.value.trim() || DEFAULTS[k];
  }
  o.maxPerEdit = Math.max(1, Math.min(20, o.maxPerEdit));
  o.maxlag = Math.max(0, Math.min(60, o.maxlag));
  o.scriptMaxClicks = Math.max(1, Math.min(200, o.scriptMaxClicks));
  o.scriptMaxSeconds = Math.max(10, Math.min(600, o.scriptMaxSeconds));
  o.hostDelayMs = Math.max(500, o.hostDelayMs);          // never hammer a website
  o.username = o.username === DEFAULTS.username ? "" : o.username;
  return o;
}

$("save").onclick = async () => {
  for (let i = 0; i < sites.length; i++) {            // a broken search script is reported before anything is saved
    try { parseSearchScript(sites[i].searchScript || ""); }
    catch (e) { select(i); const st = $("status"); st.className = "bad"; st.textContent = `Search script of “${siteLabel(sites[i])}”: ${e.message}`; return; }
  }
  const clean = sites.map(normalizeSite).filter(s => s.qid || s.idProperty || s.templates.length || s.match || s.searchUrl);
  const origins = originsFor(clean);
  let granted = true;
  if (origins.length) { try { granted = await chrome.permissions.request({ origins }); } catch (e) { console.error(e); granted = false; } }
  settings = collectSettings();
  await saveAll(clean, settings);
  sites = clean; idx = Math.min(idx, sites.length - 1); renderSelect(); if (idx >= 0) loadEditor(); loadSettings();
  const st = $("status");
  st.className = granted ? "ok" : "bad";
  st.textContent = granted ? "Saved ✓" : "Saved, but access to some websites was denied – checking those won't work.";
  setTimeout(() => st.textContent = "", 5000);
};

$("sexport").onclick = () => {
  const blob = new Blob([JSON.stringify(exportSettingsObject(collectSettings()), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `wikidata-source-saver-settings-${new Date().toISOString().slice(0, 10)}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$("simport").onclick = () => $("sfile").click();
$("sfile").onchange = async () => {
  const f = $("sfile").files[0]; $("sfile").value = "";
  if (!f) return;
  const st = $("status");
  try {
    const imported = parseSettingsImport(await f.text());
    loadSettings({ ...DEFAULTS, ...collectSettings(), ...imported });
    st.className = ""; st.textContent = `Imported ${Object.keys(imported).length} settings into the fields – press “Save all” to keep them.`;
  } catch (e) { st.className = "bad"; st.textContent = "Import failed: " + e.message; }
};

// ---------- debug log ----------
async function getLogs() { return (await chrome.storage.local.get("logs")).logs || []; }
function saveText(text, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const logName = l => `wikidata-source-saver-${l.time.replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")}-${l.item || "noitem"}.log`;
$("logdl").onclick = async () => { const l = (await getLogs()).at(-1); if (l) saveText(l.text, logName(l)); else $("logmsg").textContent = "No log yet – run the tool once."; };
$("logdlall").onclick = async () => { const ls = await getLogs(); if (ls.length) saveText(ls.map(l => l.text).join("\n\n\n"), "wikidata-source-saver-logs.log"); else $("logmsg").textContent = "No log yet."; };
$("logshow").onclick = async () => { const l = (await getLogs()).at(-1); const o = $("logout"); o.hidden = false; o.textContent = l ? l.text : "No log yet."; };
$("logclear").onclick = async () => { await chrome.storage.local.remove("logs"); $("logout").hidden = true; $("logmsg").textContent = "Cleared."; };
$("s_logToFile").onchange = async () => {
  if (!$("s_logToFile").checked) return;
  let ok = false;
  try { ok = await chrome.permissions.request({ permissions: ["downloads"] }); } catch (e) { console.error(e); }
  if (!ok) { $("s_logToFile").checked = false; $("logmsg").textContent = "Permission denied – log files can't be saved automatically (you can still download logs here)."; }
  else $("logmsg").textContent = "Permission granted – press “Save all” to switch it on.";
};

// ---------- live status ----------
function showStatus(s) {
  const on = !!s?.running;
  $("run").classList.toggle("on", on);
  $("stop").hidden = !on;
  $("runtext").textContent = on
    ? `⏳ Working: ${s.stage}${s.total ? ` (${s.done}/${s.total})` : ""}`
    : "Idle.";
}
chrome.storage.session.get("status").then(r => showStatus(r.status));
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "session" && ch.status) showStatus(ch.status.newValue);
  if (area === "local" && ch.lastRun) showLastRun();
  if (area === "local" && (ch.history || ch.misses)) showStats();
});
$("stop").onclick = () => chrome.runtime.sendMessage({ type: "stop" });

async function showLastRun() {
  const { lastRun } = await chrome.storage.local.get("lastRun");
  if (lastRun) $("lastrun").textContent = `${new Date(lastRun.time).toLocaleString()} – ${lastRun.item}\n` + lastRun.lines.join("\n");
}

// ---------- template tester ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
function testCandidates() {
  const cleaned = sites.map(normalizeSite);
  const t = cleanTerm($("tterm").value);
  const ids = t ? dedupeIds([{ words: t.words }]) : [];
  return buildCandidates(cleaned, { category: $("tcat").value }, ids, { perSite: settings.maxPerSite, total: settings.maxTotal });
}
$("preview").onclick = () => {
  const cands = testCandidates();
  const out = $("tout"); out.hidden = false;
  out.textContent = cands.length
    ? cands.map(c => `${c.site.name || c.site.qid || c.site.idProperty}${c.prop ? `  →  ${c.prop}: ${c.value}` : "  →  P1343 + P2699"}${c.site.archive ? "  [+ Wayback]" : ""}\n  ${c.url}`).join("\n")
    : "No URLs: pick a category with templates and enter a plain term (letters/numbers).";
};
$("check").onclick = async () => {
  const cands = testCandidates().slice(0, 20);
  const out = $("tout"); out.hidden = false;
  if (!cands.length) { out.textContent = "No URLs: pick a category with templates and enter a plain term."; return; }
  try { await chrome.permissions.request({ origins: originsFor(cands.map(c => c.site)) }); } catch (e) { console.error(e); }
  out.textContent = "";
  for (const c of cands) {                       // one at a time, spaced out
    const r = await checkUrl(c.url, c.site, settings);
    const d = document.createElement("div");
    d.innerHTML = `<span class="${r.found ? "ok" : "bad"}">${r.found ? "✓ found" : "✗ " + r.reason}</span> `;
    d.append(`${c.site.name || c.site.qid || c.site.idProperty} – ${c.url}`);
    out.appendChild(d);
    await sleep(Math.max(800, settings.hostDelayMs));
  }
};

// ---------- history log ----------
async function getHist() {
  const { history = { items: {} }, misses = {} } = await chrome.storage.local.get(["history", "misses"]);
  return { history, misses };
}
async function showStats() {
  const { history, misses } = await getHist();
  const items = Object.keys(history.items);
  const n = items.reduce((a, q) => a + Object.keys(history.items[q]).length, 0);
  const pushed = items.reduce((a, q) => a + Object.values(history.items[q]).filter(r => r.k === "pushed").length, 0);
  $("hstats").textContent = `${n} statements on ${items.length} items (${pushed} pushed by this tool, ${n - pushed} found already present) · ${Object.keys(misses).length} cached “doesn't exist” pages`;
}
$("hexport").onclick = async () => {
  const { history, misses } = await getHist();
  const blob = new Blob([JSON.stringify({ format: "wikidata-source-saver-history", version: 1, exported: new Date().toISOString(), history, misses }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `wikidata-source-saver-history-${new Date().toISOString().slice(0, 10)}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$("himport").onclick = () => $("hfile").click();
$("hfile").onchange = async () => {
  const f = $("hfile").files[0]; $("hfile").value = "";
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (d.format !== "wikidata-source-saver-history" || !d.history?.items) throw new Error("not a history file");
    const { history, misses } = await getHist();
    let added = 0;
    for (const [q, recs] of Object.entries(d.history.items)) {
      const mine = history.items[q] = history.items[q] || {};
      for (const [k, r] of Object.entries(recs)) if (!mine[k] || (r.t || 0) > (mine[k].t || 0)) { if (!mine[k]) added++; mine[k] = r; }
    }
    for (const [u, t] of Object.entries(d.misses || {})) misses[u] = Math.max(misses[u] || 0, t);
    await chrome.storage.local.set({ history, misses });
    $("hstats").textContent = `Imported (${added} new statements). `; setTimeout(showStats, 2500);
  } catch (e) { alert("Import failed: " + e.message); }
};
$("hrecent").onclick = async () => {
  const { history } = await getHist();
  const rows = Object.entries(history.items).flatMap(([q, recs]) => Object.values(recs).map(r => ({ q, ...r })))
    .sort((a, b) => b.t - a.t).slice(0, 100);
  const out = $("hout"); out.hidden = false;
  out.textContent = rows.map(r => `${new Date(r.t).toISOString().slice(0, 16).replace("T", " ")}  ${r.k === "pushed" ? "pushed " : "present"}  ${r.q}  ${r.n}  ${r.p ? r.p + ": " + r.v : r.u}${r.a ? "  (+archive)" : ""}`).join("\n") || "Empty.";
};
$("hclear").onclick = async () => { if (confirm("Delete the whole history log?")) { await chrome.storage.local.set({ history: { items: {} } }); showStats(); } };
$("hclearmiss").onclick = async () => { await chrome.storage.local.set({ misses: {} }); showStats(); };
$("hforgetbtn").onclick = async () => {
  const q = ($("hforget").value.match(/Q\d+/i) || [""])[0].toUpperCase();
  if (!q) return;
  const { history } = await getHist(); delete history.items[q];
  await chrome.storage.local.set({ history }); $("hforget").value = ""; showStats();
};

// ---------- import / export websites ----------
$("export").onclick = () => $("exportbox").value = JSON.stringify(sites.map(normalizeSite), null, 2);
$("import").onclick = async () => {
  try {
    const arr = JSON.parse($("exportbox").value);
    if (!Array.isArray(arr)) throw 0;
    sites = arr; idx = arr.length ? 0 : -1; renderSelect(); if (idx >= 0) loadEditor();
    $("status").textContent = "Imported – press “Save all” to keep it."; $("status").className = "";
  } catch { alert("Invalid JSON"); }
};

// ---------- theme ----------
const themeSel = $("theme");
try { themeSel.value = localStorage.getItem("theme") || ""; } catch {}
themeSel.onchange = () => {
  const v = themeSel.value;
  if (v) document.documentElement.dataset.theme = v; else delete document.documentElement.dataset.theme;
  try { v ? localStorage.setItem("theme", v) : localStorage.removeItem("theme"); } catch {}
};

// ---------- badge legend ----------
for (const [kind, k] of Object.entries(KINDS)) {
  const b = document.createElement("span");
  b.textContent = k.badge; b.style.cssText = `background:${k.color};color:${k.text};padding:1px 7px;border-radius:3px;font:bold 12px monospace;text-align:center`;
  const d = document.createElement("span"); d.textContent = k.label;
  $("legend").append(b, d);
}

// ---------- start ----------
(async () => {
  sites = await getSites();
  settings = await getSettings();
  loadSettings();
  const add = new URLSearchParams(location.search).get("add");
  if (add && !sites.some(s => effectiveMatch({ ...s, templates: s.templates || [] }) === add)) sites.push({ match: add });
  idx = add ? sites.length - 1 : (sites.length ? 0 : -1);
  renderSelect(); if (idx >= 0) loadEditor();
  if (add) $("f_qid").focus();
  const cmds = await chrome.commands.getAll();
  $("shortcut").textContent = cmds.find(c => c.name === "save-source")?.shortcut || "(no shortcut set)";
  showStats(); showLastRun();
})();
