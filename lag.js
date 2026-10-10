const id = new URLSearchParams(location.search).get("id");
const $ = x => document.getElementById(x);
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
const done = v => chrome.runtime.sendMessage(v === null ? { type: "review-done", id, cancel: true } : { type: "review-done", id, selected: v });

(async () => {
  const p = await chrome.runtime.sendMessage({ type: "review-get", id });
  if (!p) { document.body.textContent = "This question is no longer active."; return; }
  $("what").replaceChildren(`${p.rows.length} change${p.rows.length > 1 ? "s" : ""} to `, itemLink(p.item),
    ` ${p.rows.length > 1 ? "are" : "is"} ready, but Wikidata refused the save because its servers are behind` +
    (p.lag != null ? ` (${p.lag}s lag, your maxlag is ${p.maxlag}s).` : ` (your maxlag is ${p.maxlag}s).`));
  for (const r of p.rows) { const li = document.createElement("li"); linkify(r, li); $("rows").append(li); }
  $("info").textContent = p.info || "";
  $("off").focus();
})();
$("off").onclick = () => done("off");
$("retry").onclick = () => done("retry");
$("cancel").onclick = () => done(null);
addEventListener("keydown", e => { if (e.key === "Escape") done(null); });
