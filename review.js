const id = new URLSearchParams(location.search).get("id");
const $ = x => document.getElementById(x);
let payload = null;
const mkLink = (href, label) => { const a = document.createElement("a"); a.href = href; a.textContent = label; a.target = "_blank"; a.rel = "noopener noreferrer"; a.addEventListener("click", e => e.stopPropagation()); return a; };
// only http(s) addresses become links; everything is inserted as text, never as HTML
function linkify(text, parent) {
  const re = /https?:\/\/[^\s<>"']+/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    let u = m[0]; const trail = (u.match(/[.,;:)\]]+$/) || [""])[0];
    if (trail) u = u.slice(0, -trail.length);
    parent.append(mkLink(u, u)); if (trail) parent.append(trail);
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}
const itemLink = q => /^Q\d+$/.test(q) ? mkLink("https://www.wikidata.org/wiki/" + q, q) : document.createTextNode(q);


function update() {
  const checked = [...document.querySelectorAll("input[type=checkbox]")].filter(c => c.checked);
  const n = checked.length;
  const over = n > payload.maxPerEdit;
  const m = new Map();                                   // statements: URLs of one website share one P1343 statement
  for (const c of checked) { const k = payload.rows.find(r => r.id === Number(c.dataset.id))?.gkey ?? c.dataset.id; m.set(k, (m.get(k) || 0) + 1); }
  const groups = [...m.values()];
  $("ok").disabled = n === 0 || over;
  $("ok").textContent = n ? `Save ${n} to Wikidata${groups.length > 1 ? ` (${groups.join("+")})` : ""}` : "Nothing selected";
  $("msg").textContent = over ? `At most ${payload.maxPerEdit} statements per edit (Settings) – untick some.` : "";
}

(async () => {
  payload = await chrome.runtime.sendMessage({ type: "review-get", id });
  if (!payload) { document.body.textContent = "This review is no longer active."; return; }
  $("title").replaceChildren("Review changes to ", itemLink(payload.item));
  $("sub").textContent = payload.itemLabel || "";
  for (const r of payload.rows) {
    const d = document.createElement("label");
    d.className = "row";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = !r.needsApproval; cb.dataset.id = r.id; cb.onchange = update;
    const b = document.createElement("div");
    const h = document.createElement("div");
    h.textContent = r.label + " – " + r.note;
    if (r.viaSearch) { const t = document.createElement("span"); t.className = "tag s"; t.textContent = "from site search – check it"; h.append(t); }
    if (r.needsApproval) { const t = document.createElement("span"); t.className = "tag s"; t.textContent = "partial title match – tick to approve"; h.append(t); }
    if (r.viaArchive) { const t = document.createElement("span"); t.className = "tag"; t.textContent = "live site unreachable"; h.append(t); }
    const u = document.createElement("div");
    u.className = "t";
    if (r.url && r.text === r.url) linkify(r.text, u);                    // a URL row: the URL itself is the link
    else { u.append(r.text); if (r.url) { u.append("  –  "); u.append(mkLink(r.url, "open the page")); } }
    if (r.archive) { u.append("   (+ Wayback "); u.append(r.archiveUrl ? mkLink(r.archiveUrl, r.archive) : r.archive); u.append(")"); }
    b.append(h, u); d.append(cb, b); $("rows").append(d);
  }
  if (payload.present.length) {
    $("pres").querySelector("summary").textContent = `${payload.present.length} already on the item`;
    for (const line of payload.present) { const d = document.createElement("div"); linkify(line, d); $("presl").append(d); }
  } else $("pres").hidden = true;
  update();
  $("ok").focus();
})();

$("ok").onclick = () => {
  const selected = [...document.querySelectorAll("input[type=checkbox]")].filter(c => c.checked).map(c => Number(c.dataset.id));
  chrome.runtime.sendMessage({ type: "review-done", id, selected });
};
$("cancel").onclick = () => chrome.runtime.sendMessage({ type: "review-done", id, cancel: true });
addEventListener("keydown", e => { if (e.key === "Escape") $("cancel").click(); });
