import { buildCandidates, originsFor, checkUrl, dedupeIds, effectiveMatch, cats, cleanTerm, usable, DEFAULTS,
  exportSettingsObject, parseSettingsImport, parseSearchScript, langsOf, KINDS, MEDIAWIKI_EXCLUDE } from "./lib.js";
import { getSites, getSettings, saveAll, getFileLink, setFileLink, updateFileLink, clearFileLink, readDataFile, writeDataFile, filePermission } from "./store.js";

const $ = id => document.getElementById(id);
let sites = [], idx = -1, settings = { ...DEFAULTS };

// ---------- website editor (one at a time) ----------
const FIELDS = [
  ["name", "f_name"], ["qid", "f_qid"], ["idProperty", "f_idprop"], ["category", "f_category"],
  ["templates", "f_templates", "lines"], ["plurals", "f_plurals", "bool"], ["archive", "f_archive", "bool"],
  ["separator", "f_sep", "sepset", "hyphen"], ["caseMode", "f_case", "text", "lower"], ["urlMode", "f_mode", "text", "nohash"],
  ["searchUrl", "f_searchUrl"], ["searchMode", "f_searchMode", "text", "fetch"], ["pickBy", "f_pickBy", "text", "title"],
  ["titleMatch", "f_titleMatch", "text", "equal"], ["approvePartial", "f_approvePartial", "bool"], ["language", "f_language"], ["searchScript", "f_searchScript"], ["searchMax", "f_searchMax"], ["searchRegex", "f_searchRegex"], ["searchExclude", "f_searchExclude"],
  ["idValue", "f_idvalue"], ["redirects", "f_redirects", "text", ""], ["textFragment", "f_textFragment", "text", ""], ["match", "f_match"], ["notFound", "f_notfound"], ["nonLetter", "f_nonletter"], ["smallWords", "f_small"]
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

$("mediawikiPreset").onclick = () => {
  if (idx < 0) return;
  const s = sites[idx];
  const host = effectiveMatch({ ...s, searchUrl: "", templates: s.templates || [] }).split("/")[0];
  if (!host) { alert("Fill in “Match” (Advanced) or a URL template for this wiki first, so its domain is known."); return; }
  const set = (key, id, val) => { s[key] = val; const el = $(id); if (el.type === "checkbox") el.checked = val; else el.value = val; el.dispatchEvent(new Event("input", { bubbles: true })); };
  set("searchUrl", "f_searchUrl", `https://${host}/w/index.php?title=Special:Search&search={q}&fulltext=1&limit=20`);
  set("searchMode", "f_searchMode", "fetch");
  set("pickBy", "f_pickBy", "title");
  set("titleMatch", "f_titleMatch", "contain");
  set("approvePartial", "f_approvePartial", true);
  set("redirects", "f_redirects", "accept");
  if (!(s.searchExclude || "").trim()) set("searchExclude", "f_searchExclude", MEDIAWIKI_EXCLUDE);
  if (!s.searchMax) set("searchMax", "f_searchMax", "5");
};

$("googlePreset").onclick = () => {
  if (idx < 0) return;
  const s = sites[idx];
  const host = effectiveMatch({ ...s, searchUrl: "", templates: s.templates || [] }).split("/")[0];
  if (!host || /(^|\.)google\./.test(host)) { alert("Fill in “Match” (Advanced) or a URL template for this website first, so the search can be limited to its domain."); return; }
  const set = (key, id, val) => { s[key] = val; const el = $(id); el.value = val; el.dispatchEvent(new Event("input", { bubbles: true })); };
  set("searchUrl", "f_searchUrl", `https://www.google.com/search?q=site:${host}+{q}`);
  set("searchMode", "f_searchMode", "tab");
  set("pickBy", "f_pickBy", "slug");
  if (!s.searchMax) set("searchMax", "f_searchMax", "5");
  if (!(s.searchScript || "").trim()) set("searchScript", "f_searchScript", 'click button "Accept all"\ncollect\npages link "Page {n}" max=3');
};

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
  ["maxTotal", "s_maxTotal", "num"], ["maxlag", "s_maxlag", "num"], ["captchaWaitSeconds", "s_captchaWaitSeconds", "num"], ["scriptMaxClicks", "s_scriptMaxClicks", "num"], ["scriptMaxSeconds", "s_scriptMaxSeconds", "num"], ["missTtlDays", "s_missTtlDays", "num"],
  ["related", "s_related", "bool"], ["textFragment", "s_textFragment", "bool"], ["useHistory", "s_useHistory", "bool"], ["logToFile", "s_logToFile", "bool"]
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
  o.captchaWaitSeconds = Math.max(0, Math.min(900, o.captchaWaitSeconds));
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
  const fileMsg = await writeLinkedFile(clean, settings);
  sites = clean; idx = Math.min(idx, sites.length - 1); renderSelect(); if (idx >= 0) loadEditor(); loadSettings();
  const st = $("status");
  st.className = granted ? "ok" : "bad";
  st.textContent = (granted ? "Saved ✓" : "Saved, but access to some websites was denied – checking those won't work.") + (fileMsg ? "  " + fileMsg : "");
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

// ---------- site access: all websites in one go ----------
async function refreshPerm() {
  const all = await chrome.permissions.contains({ origins: ["*://*/*"] });
  $("permStatus").textContent = all ? "✓ all websites are allowed" : "– only the websites in your templates / search URLs (requested when you press “Save all”)";
  $("permNone").hidden = !all;
}
$("permAll").onclick = async () => {
  let ok = false;
  try { ok = await chrome.permissions.request({ origins: ["*://*/*"] }); } catch (e) { console.error(e); }
  await refreshPerm();
  if (!ok) $("permStatus").textContent += "  (not granted)";
};
$("permNone").onclick = async () => { try { await chrome.permissions.remove({ origins: ["*://*/*"] }); } catch (e) { console.error(e); } await refreshPerm(); };

// ---------- website data file (File System Access API) ----------
const JSON_TYPES = [{ description: "JSON", accept: { "application/json": [".json"] } }];
const fileApi = () => typeof window.showOpenFilePicker === "function" && typeof window.showSaveFilePicker === "function";
async function ensureRW(handle) {
  if ((await filePermission(handle, "readwrite")) === "granted") return true;
  try { return (await handle.requestPermission({ mode: "readwrite" })) === "granted"; } catch { return false; }
}
const currentClean = () => sites.map(normalizeSite).filter(s => s.qid || s.idProperty || s.templates.length || s.match || s.searchUrl);

let fileNote = "";                                     // last problem, shown until the next action
async function refreshFileUi() {
  const link = await getFileLink().catch(() => null);
  const { fileStatus } = await chrome.storage.local.get("fileStatus");
  const supported = fileApi();
  $("fileOpen").disabled = $("fileNew").disabled = !supported;
  if (!supported) { $("fileState").textContent = "This browser does not offer the file-picker API – the browser copy is used."; return; }
  if (!link) { $("fileState").textContent = "Not connected – your websites are stored inside the browser only."; }
  else {
    const perm = await filePermission(link.handle, "readwrite");
    $("fileState").textContent = `Connected: ${link.name} · access: ${perm === "granted" ? "granted ✓" : "needs to be granted again (button below)"}` +
      (fileStatus ? ` · last: ${fileStatus.ok ? "OK" : "⚠"} ${fileStatus.msg}` : "");
  }
  if (fileNote) $("fileState").textContent += `  ⚠ ${fileNote}`;
  for (const id of ["fileReload", "fileRegrant", "fileOff"]) $(id).hidden = !link;
  $("fileInc").checked = !!link?.includeSettings;
}

async function loadFromHandle(handle, announce) {
  const data = await readDataFile(handle);
  if (!confirm(`Load ${data.sites.length} website${data.sites.length === 1 ? "" : "s"} from “${handle.name}”? They replace the websites currently in the editor.`)) return null;
  sites = data.sites; idx = sites.length ? 0 : -1;
  await chrome.storage.local.set({ sites });                               // browser copy = fallback
  if ($("fileInc").checked && data.settings) { settings = { ...settings, ...data.settings }; loadSettings(); await chrome.storage.local.set({ settings }); }
  renderSelect(); if (idx >= 0) loadEditor();
  if (announce) $("status").textContent = `Loaded ${data.sites.length} websites from ${handle.name}.`;
  return data;
}

$("fileOpen").onclick = async () => {
  fileNote = "";
  try {
    const [h] = await window.showOpenFilePicker({ types: JSON_TYPES, multiple: false });
    if (!(await ensureRW(h))) { fileNote = "Access to the file was not granted."; return; }
    const data = await loadFromHandle(h, true);
    if (data) await setFileLink(h, { includeSettings: $("fileInc").checked, lastSeen: data.modified });
  } catch (e) { if (e?.name !== "AbortError") fileNote = "Could not use the file: " + (e.message || e); }
  refreshFileUi();
};
$("fileNew").onclick = async () => {
  fileNote = "";
  try {
    const h = await window.showSaveFilePicker({ suggestedName: "wikidata-source-saver-data.json", types: JSON_TYPES });
    if (!(await ensureRW(h))) { fileNote = "Access to the file was not granted."; return; }
    settings = collectSettings();
    const mod = await writeDataFile(h, currentClean(), settings, $("fileInc").checked);
    await setFileLink(h, { includeSettings: $("fileInc").checked, lastSeen: mod });
    $("status").textContent = `Created ${h.name} with ${currentClean().length} websites.`;
  } catch (e) { if (e?.name !== "AbortError") fileNote = "Could not create the file: " + (e.message || e); }
  refreshFileUi();
};
$("fileReload").onclick = async () => {
  fileNote = "";
  const link = await getFileLink(); if (!link) return;
  try { if (await ensureRW(link.handle)) { const d = await loadFromHandle(link.handle, true); if (d) await updateFileLink({ lastSeen: d.modified }); } }
  catch (e) { fileNote = "Could not read the file: " + (e.message || e); }
  refreshFileUi();
};
$("fileRegrant").onclick = async () => {
  fileNote = ""; const link = await getFileLink(); if (link) await ensureRW(link.handle); refreshFileUi(); };
$("fileOff").onclick = async () => {
  fileNote = ""; if (confirm("Disconnect from the file? Your websites stay in the browser copy; the file is left untouched.")) { await clearFileLink(); refreshFileUi(); } };
$("fileInc").onchange = async () => { await updateFileLink({ includeSettings: $("fileInc").checked }); };

// called by "Save all": keep the file in step with the editor
async function writeLinkedFile(clean, settingsNow) {
  const link = await getFileLink().catch(() => null);
  if (!link) return "";
  try {
    if (!(await ensureRW(link.handle))) return "⚠ the file was not updated: access to it needs to be granted again.";
    const f = await link.handle.getFile();
    if (f.lastModified > (link.lastSeen || 0) &&
        !confirm(`“${link.name}” was changed since you last loaded or saved it (another computer, Nextcloud sync…). Overwrite it with the websites in this editor?`)) {
      return "⚠ the file was left unchanged (it is newer than your editor).";
    }
    const mod = await writeDataFile(link.handle, clean, settingsNow, link.includeSettings);
    await updateFileLink({ lastSeen: mod });
    return `✓ written to ${link.name}.`;
  } catch (e) { return "⚠ the file could not be written: " + (e.message || e); }
  finally { refreshFileUi(); }
}

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
const missT = v => (typeof v === "number" ? v : v?.t) || 0;
const missWhy = v => (typeof v === "number" ? "cached by an earlier version" : v?.why) || "";
$("preview").onclick = async () => {
  const cands = testCandidates();
  const { misses } = await getHist();
  const out = $("tout"); out.hidden = false;
  out.textContent = cands.length
    ? cands.map(c => `${c.site.name || c.site.qid || c.site.idProperty}${c.prop ? `  →  ${c.prop}: ${c.value}` : "  →  P1343 + P2699"}${c.site.archive ? "  [+ Wayback]" : ""}\n  ${c.url}` +
        (misses[c.url] ? `\n  ⚠ cached as NOT existing since ${new Date(missT(misses[c.url])).toISOString().slice(0, 10)} (${missWhy(misses[c.url])}) – runs skip this URL; “Check if they exist” clears the entry if the page exists` : "")).join("\n")
    : "No URLs: pick a category with templates and enter a plain term (letters/numbers).";
};
// "Check if they exist": one request at a time, spaced out. When it ends you get a summary on the page, a symbol on the
// toolbar icon (visible from any tab) and a desktop notification – so you can do other work while it runs
// (keep this Settings tab open; a background tab is fine).
let checkCtrl = null;
async function flagFinished(text, kind) {
  try {
    const { status } = await chrome.storage.session.get("status");
    if (status?.running) return;                       // a save run owns the badge right now
    const k = KINDS[kind];
    await chrome.action.setBadgeBackgroundColor({ color: k.color });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: k.text });
    await chrome.action.setBadgeText({ text });
    const clear = () => chrome.action.setBadgeText({ text: "" });
    if (document.visibilityState === "visible" && document.hasFocus()) setTimeout(clear, 8000);
    else {                                             // you're elsewhere: leave it until you come back to this tab
      const back = () => { if (document.visibilityState === "visible") { document.removeEventListener("visibilitychange", back); setTimeout(clear, 3000); } };
      document.addEventListener("visibilitychange", back);
    }
  } catch (e) { console.warn("badge failed", e); }
}

$("checkstop").onclick = () => checkCtrl?.abort();
$("check").onclick = async () => {
  if (checkCtrl) return;
  const cands = testCandidates().slice(0, 20);
  const out = $("tout"); out.hidden = false;
  $("checksum").hidden = true;
  if (!cands.length) { out.textContent = "No URLs: pick a category with templates and enter a plain term."; return; }
  try { await chrome.permissions.request({ origins: originsFor(cands.map(c => c.site)) }); } catch (e) { console.error(e); }
  const { misses: cache } = await getHist();
  let cleared = 0;
  const ctrl = checkCtrl = new AbortController();
  $("check").disabled = true; $("checkstop").hidden = false;
  out.textContent = "";
  const gap = settings.hostDelayMs === 0 ? 0 : Math.max(800, settings.hostDelayMs);
  let n = 0, found = 0, missing = 0, problems = 0;
  for (const c of cands) {
    if (ctrl.signal.aborted) break;
    $("checkmsg").textContent = `Checking ${n + 1} of ${cands.length}…`;
    const sig = AbortSignal.any([ctrl.signal, AbortSignal.timeout(12000)]);
    const r = await checkUrl(c.url, c.site, settings, undefined, sig);
    if (ctrl.signal.aborted) break;                    // stopped by the button: don't count the interrupted one
    n++;
    const trouble = !r.found && (r.reason === "stopped" || /timeout|network|rate-limited|blocking|permission|HTTP 5|HTTP 403|HTTP 429/.test(r.reason));
    if (r.found) found++; else if (trouble) problems++; else missing++;
    const wasCached = r.found && cache[c.url];
    if (wasCached) { delete cache[c.url]; cleared++; }
    const d = document.createElement("div");
    d.innerHTML = `<span class="${r.found ? "ok" : "bad"}">${r.found ? "✓ found" : "✗ " + (r.reason === "stopped" ? "timeout" : r.reason)}</span> `;
    d.append(`${c.site.name || c.site.qid || c.site.idProperty} – ${c.url}${wasCached ? "  (removed from the “doesn't exist” cache)" : ""}`);
    out.appendChild(d);
    if (gap) { try { await new Promise((res, rej) => { const t = setTimeout(res, gap); ctrl.signal.addEventListener("abort", () => { clearTimeout(t); rej(); }, { once: true }); }); } catch { break; } }
  }
  if (cleared) await chrome.storage.local.set({ misses: cache });
  const stopped = ctrl.signal.aborted;
  checkCtrl = null; $("check").disabled = false; $("checkstop").hidden = true; $("checkmsg").textContent = "";
  const term = $("tterm").value.trim();
  const summary = `${stopped ? "Stopped after" : "Finished:"} ${n} of ${cands.length} URLs checked – ${found} exist, ${missing} don't, ${problems} had problems` +
    (problems ? " (timeouts, blocks or missing permission)" : "") + "." + (cleared ? ` ${cleared} URL${cleared > 1 ? "s were" : " was"} removed from the “doesn't exist” cache.` : "");
  const sum = $("checksum"); sum.hidden = false; sum.textContent = (stopped ? "■ " : "✓ ") + summary;
  const kind = stopped ? "stopped" : "checked";
  const badge = stopped ? KINDS.stopped.badge : `${found}/${n}`;
  await flagFinished(badge, kind);
  try {
    chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png",
      title: `${badge}  ${stopped ? "Template check stopped" : "Template check finished"}`, message: `${term ? "“" + term + "”: " : ""}${summary}` });
  } catch (e) { console.warn("notification failed", e); }
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
    for (const [u, v] of Object.entries(d.misses || {})) if (missT(v) > missT(misses[u])) misses[u] = typeof v === "number" ? { t: v, why: "imported" } : v;
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
  showStats(); showLastRun(); refreshPerm(); refreshFileUi();
})();
