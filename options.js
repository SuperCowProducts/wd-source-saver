import { buildCandidates, originsFor, checkUrl, dedupeIds, cleanTemplates, effectiveMatch } from "./lib.js";

const $ = id => document.getElementById(id);
const sitesEl = $("sites");

const SEP = [["hyphen", "hyphen  ( - )"], ["underscore", "underscore  ( _ )"], ["plus", "plus  ( + )"], ["space", "space  ( %20 )"], ["none", "none (single token)"]];
const CASE = [["lower", "lowercase"], ["capitalize", "Capitalized first word"], ["title", "Title Case Each Word"], ["titlesmall", "Title Case, small words lowercase (of, the…)"], ["upper", "UPPERCASE"], ["keep", "keep as is"]];
const MODES = [
  ["nohash", "Page URL without #fragment"], ["noquery", "Strip ?query and #fragment"],
  ["canonical", "<link rel=canonical> if present"], ["asis", "Exactly as in address bar"]
];
const opts = list => list.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");

function addCard(s = {}, isNew = false) {
  const el = document.createElement("section");
  el.className = "card" + (isNew ? " new" : "");
  el.innerHTML = `
    <button class="del" title="Remove this website">✕</button>
    <div class="grid4">
      <label>Name<input class="name" placeholder="MathWorld"></label>
      <label>Website item (P1343)<input class="qid" placeholder="Q12345"></label>
      <label>…or ID property<input class="idprop" placeholder="P2812" title="If this website has its own Wikidata property, the ID is saved with it instead of P1343/P2699"></label>
      <label>Category<input class="category" list="cats" placeholder="math"></label>
    </div>
    <label>URL templates <span class="hint">– one per line. <code>{id}</code> = the term, <code>{first}</code> / <code>{FIRST}</code> = its first letter (lower/upper case), <code>{algebra|data|geometry}</code> = try each choice</span>
      <textarea class="templates" rows="2" placeholder="https://www.mathwords.com/{first}/{id}.htm"></textarea></label>
    <label style="margin-top:6px"><input type="checkbox" class="plurals" style="width:auto"> Also try plural / singular forms of the term (last word)</label>
    <label style="margin-top:6px"><input type="checkbox" class="archive" style="width:auto"> Unreliable site: always add the latest Wayback Machine snapshot (P1065 + P2960) and accept pages that only exist in the archive</label>
    <div class="grid" style="margin-top:8px">
      <label>Words in the ID separated by<select class="sep">${opts(SEP)}</select></label>
      <label>Letter case in the ID<select class="case">${opts(CASE)}</select></label>
      <label>URL to save for this page<select class="mode">${opts(MODES)}</select></label>
    </div>
    <details><summary>Advanced</summary>
      <div class="grid2">
        <label>Match (domain or domain/path) – leave empty to derive from template<input class="match" placeholder="law.cornell.edu/wex"></label>
        <label>"Page not found" text/regex (for sites that return 200 for missing pages)<input class="notfound" placeholder="Page not found|No results"></label>
        <label>Small words kept lowercase in "Title Case, small words" <span class="hint">(default: a, an, and, as, at, but, by, for, in, nor, of, on, or, the, to, up)</span><input class="small" placeholder="of, the, and"></label>
        <label>Folder for IDs starting with a digit/symbol (for <code>{first}</code>) – empty = the character itself<input class="nonletter" placeholder="0-9"></label>
      </div>
    </details>`;
  const q = sel => el.querySelector(sel);
  q(".name").value = s.name || "";
  q(".qid").value = s.qid || "";
  q(".idprop").value = s.idProperty || "";
  q(".category").value = s.category || "";
  q(".templates").value = (s.templates || []).join("\n");
  q(".plurals").checked = !!s.plurals;
  q(".archive").checked = !!s.archive;
  q(".sep").value = s.separator || "hyphen";
  q(".case").value = s.caseMode || "lower";
  q(".mode").value = s.urlMode || "nohash";
  q(".match").value = s.match || "";
  q(".notfound").value = s.notFound || "";
  q(".nonletter").value = s.nonLetter || "";
  q(".small").value = s.smallWords || "";
  q(".del").onclick = () => { el.remove(); refreshCats(); };
  sitesEl.appendChild(el);
  if (isNew) q(".qid").focus();
  return el;
}

function collect() {
  return [...sitesEl.querySelectorAll(".card")].map(el => {
    const q = sel => el.querySelector(sel);
    const s = {
      name: q(".name").value.trim(),
      qid: (q(".qid").value.match(/Q\d+/i) || [""])[0].toUpperCase(),
      idProperty: (q(".idprop").value.match(/P\d+/i) || [""])[0].toUpperCase(),
      category: q(".category").value.trim(),
      templates: q(".templates").value.split("\n").map(t => t.trim()).filter(Boolean),
      plurals: q(".plurals").checked,
      archive: q(".archive").checked,
      separator: q(".sep").value,
      caseMode: q(".case").value,
      urlMode: q(".mode").value,
      match: q(".match").value.trim(),
      notFound: q(".notfound").value.trim(),
      nonLetter: q(".nonletter").value.trim(),
      smallWords: q(".small").value.trim()
    };
    return s;
  }).filter(s => (s.qid || s.idProperty) && (s.match || s.templates.length));
}

function refreshCats() {
  const cats = [...new Set(collect().map(s => s.category).filter(Boolean))];
  $("cats").innerHTML = cats.map(c => `<option value="${c.replace(/"/g, "&quot;")}">`).join("");
  const sel = $("tcat"), prev = sel.value;
  sel.innerHTML = cats.map(c => `<option>${c.replace(/</g, "&lt;")}</option>`).join("");
  if (cats.includes(prev)) sel.value = prev;
}
sitesEl.addEventListener("input", refreshCats);

function getSettings() {
  return { related: $("related").checked, redirects: $("redirects").value };
}

async function load() {
  const { sites = [], settings = {} } = await chrome.storage.sync.get(["sites", "settings"]);
  sitesEl.innerHTML = "";
  sites.forEach(s => addCard(s));
  const add = new URLSearchParams(location.search).get("add");
  if (add && !sites.some(s => effectiveMatch(s) === add)) addCard({ match: add }, true);
  if (!sitesEl.children.length) addCard();
  $("related").checked = settings.related !== false;
  $("redirects").value = settings.redirects || "skip";
  refreshCats();
  const cmds = await chrome.commands.getAll();
  $("shortcut").textContent = cmds.find(c => c.name === "save-source")?.shortcut || "(no shortcut set)";
  showLastRun();
}

async function showLastRun() {
  const { lastRun } = await chrome.storage.local.get("lastRun");
  if (!lastRun) return;
  $("lastrun").textContent = `${new Date(lastRun.time).toLocaleString()} – ${lastRun.item}\n` + lastRun.lines.join("\n");
}

$("add").onclick = () => addCard({}, false);

$("save").onclick = async () => {
  const sites = collect();
  const origins = originsFor(sites);
  let granted = true;
  if (origins.length) {
    try { granted = await chrome.permissions.request({ origins }); } catch (e) { console.error(e); granted = false; }
  }
  await chrome.storage.sync.set({ sites, settings: getSettings() });
  const st = $("status");
  st.style.color = granted ? "var(--ok)" : "var(--bad)";
  st.textContent = granted ? "Saved ✓" : "Saved, but access to some websites was denied – checking those won't work.";
  setTimeout(() => st.textContent = "", 5000);
  refreshCats();
};

// ----- template tester -----
function testCandidates() {
  const sites = collect();
  const words = $("tterm").value.trim().split(/[\s_\-]+/).filter(Boolean);
  const ids = dedupeIds([{ words }]);
  return { sites, cands: buildCandidates(sites, { category: $("tcat").value }, ids) };
}

$("preview").onclick = () => {
  const { cands } = testCandidates();
  const out = $("tout"); out.hidden = false;
  out.textContent = cands.length ? cands.map(c => `${c.site.name || c.site.qid || c.site.idProperty}${c.site.idProperty ? `  →  ${c.site.idProperty}: ${c.value}` : ""}${c.site.archive ? "  [+ Wayback]" : ""}\n  ${c.url}`).join("\n") : "No URLs: pick a category with templates and enter a term.";
};

$("check").onclick = async () => {
  const { cands } = testCandidates();
  const out = $("tout"); out.hidden = false;
  if (!cands.length) { out.textContent = "No URLs: pick a category with templates and enter a term."; return; }
  const origins = originsFor(cands.map(c => c.site));
  try { await chrome.permissions.request({ origins }); } catch (e) { console.error(e); }
  out.textContent = "Checking…";
  const settings = getSettings();
  const rs = await Promise.all(cands.map(async c => ({ c, r: await checkUrl(c.url, c.site, settings) })));
  out.innerHTML = "";
  for (const { c, r } of rs) {
    const d = document.createElement("div");
    d.innerHTML = `<span class="${r.found ? "ok" : "bad"}">${r.found ? "✓ found" : "✗ " + r.reason}</span> `;
    d.append(`${c.site.name || c.site.qid || c.site.idProperty} – ${c.url}`);
    out.appendChild(d);
  }
};

// ----- import / export -----
$("export").onclick = () => $("exportbox").value = JSON.stringify(collect(), null, 2);
$("import").onclick = async () => {
  try {
    const arr = JSON.parse($("exportbox").value);
    if (!Array.isArray(arr)) throw 0;
    await chrome.storage.sync.set({ sites: arr });
    load();
  } catch { alert("Invalid JSON"); }
};

// ----- theme -----
const themeSel = $("theme");
try { themeSel.value = localStorage.getItem("theme") || ""; } catch {}
themeSel.onchange = () => {
  const v = themeSel.value;
  if (v) document.documentElement.dataset.theme = v; else delete document.documentElement.dataset.theme;
  try { v ? localStorage.setItem("theme", v) : localStorage.removeItem("theme"); } catch {}
};

load();
