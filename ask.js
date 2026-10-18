// "What should be searched for?" – shown when the matched URL template has no {id} (e.g. {path}), so the URL holds no single term.
import { cleanTerm } from "./lib.js";
const id = new URLSearchParams(location.search).get("id");
const $ = x => document.getElementById(x);
const done = v => chrome.runtime.sendMessage(v === null ? { type: "review-done", id, cancel: true } : { type: "review-done", id, selected: v });

(async () => {
  const p = await chrome.runtime.sendMessage({ type: "review-get", id });
  if (!p) { document.body.textContent = "This question is no longer active."; return; }
  const code = document.createElement("code"); code.textContent = p.url;
  if (p.noId) $("what").replaceChildren("The address of this ", p.site, " page (", code, ") doesn't hold a single word or ID, so type the term to look for on the other websites:");
  else $("what").replaceChildren("Confirm the term to look for on the other websites. The address (", code, ") suggests the term below – shorten or change it if the page is about something narrower or broader:");
  $("info").textContent = "Whatever you had selected on the page is offered as the answer. Settings → “Confirm the search term” turns this question off.";
  if (p.extras && p.extras.length) $("ex").textContent = "Also searched (typed after the item): " + p.extras.join(", ");
  $("term").value = p.suggestion || "";
  $("term").focus(); $("term").select();
})();

function submit() {
  const t = cleanTerm($("term").value.replace(/[?!:;\s]+$/, ""));
  if (!t) { $("err").textContent = "Type 1–6 words (letters, digits, spaces, hyphens, apostrophes), 60 characters at most."; return; }
  done(t.text);
}
$("ok").onclick = submit;
$("skip").onclick = () => done(null);
$("term").addEventListener("input", () => { $("err").textContent = ""; });
addEventListener("keydown", e => { if (e.key === "Enter") submit(); if (e.key === "Escape") done(null); });
