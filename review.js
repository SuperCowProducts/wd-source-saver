const id = new URLSearchParams(location.search).get("id");
const $ = x => document.getElementById(x);
let payload = null;

function update() {
  const n = [...document.querySelectorAll("input[type=checkbox]")].filter(c => c.checked).length;
  const over = n > payload.maxPerEdit;
  $("ok").disabled = n === 0 || over;
  $("ok").textContent = n ? `Save ${n} to Wikidata` : "Nothing selected";
  $("msg").textContent = over ? `At most ${payload.maxPerEdit} statements per edit (Settings) – untick some.` : "";
}

(async () => {
  payload = await chrome.runtime.sendMessage({ type: "review-get", id });
  if (!payload) { document.body.textContent = "This review is no longer active."; return; }
  $("title").textContent = `Review changes to ${payload.item}`;
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
    u.className = "t"; u.textContent = r.text + (r.archive ? `   (+ Wayback ${r.archive})` : "");
    b.append(h, u); d.append(cb, b); $("rows").append(d);
  }
  if (payload.present.length) {
    $("pres").querySelector("summary").textContent = `${payload.present.length} already on the item`;
    $("presl").textContent = payload.present.join("\n");
    $("presl").style.whiteSpace = "pre-wrap";
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
