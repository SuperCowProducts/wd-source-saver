const tbody = document.querySelector("#tbl tbody");
const status = document.getElementById("status");
const MODES = [
  ["nohash", "Page URL without #fragment (default)"],
  ["noquery", "Strip ?query and #fragment"],
  ["canonical", "Use <link rel=canonical> if present"],
  ["asis", "Exactly as in the address bar"]
];

function addRow(s = {}, focusQid = false) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input class="match" placeholder="example.com"></td>
    <td><input class="qid" placeholder="Q12345"></td>
    <td><input class="name" placeholder="Example News"></td>
    <td><select class="mode">${MODES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></td>
    <td><button class="del" title="Remove">✕</button></td>`;
  tr.querySelector(".match").value = s.match || "";
  tr.querySelector(".qid").value = s.qid || "";
  tr.querySelector(".name").value = s.name || "";
  tr.querySelector(".mode").value = s.urlMode || "nohash";
  tr.querySelector(".del").onclick = () => tr.remove();
  tbody.appendChild(tr);
  if (focusQid) { tr.classList.add("row-new"); tr.querySelector(".qid").focus(); }
}

function collect() {
  return [...tbody.querySelectorAll("tr")].map(tr => {
    const qid = (tr.querySelector(".qid").value.match(/Q\d+/i) || [""])[0].toUpperCase();
    return {
      match: tr.querySelector(".match").value.trim(),
      qid,
      name: tr.querySelector(".name").value.trim(),
      urlMode: tr.querySelector(".mode").value
    };
  }).filter(s => s.match && s.qid);
}

async function load() {
  const { sites = [] } = await chrome.storage.sync.get("sites");
  tbody.innerHTML = "";
  sites.forEach(s => addRow(s));
  const add = new URLSearchParams(location.search).get("add");
  if (add && !sites.some(s => s.match === add)) addRow({ match: add }, true);
  if (!tbody.children.length) addRow();
  const cmds = await chrome.commands.getAll();
  const c = cmds.find(c => c.name === "save-source");
  document.getElementById("shortcut").textContent = c?.shortcut || "(no shortcut set)";
}

document.getElementById("add").onclick = () => addRow({}, false);
document.getElementById("save").onclick = async () => {
  await chrome.storage.sync.set({ sites: collect() });
  status.textContent = "Saved ✓";
  setTimeout(() => status.textContent = "", 2000);
  load();
};
document.getElementById("export").onclick = () =>
  document.getElementById("json").value = JSON.stringify(collect(), null, 2);
document.getElementById("import").onclick = async () => {
  try {
    const arr = JSON.parse(document.getElementById("json").value);
    if (!Array.isArray(arr)) throw 0;
    await chrome.storage.sync.set({ sites: arr });
    load();
  } catch { alert("Invalid JSON"); }
};
load();

// ---------- theme ----------
const themeSel = document.getElementById("theme");
try { themeSel.value = localStorage.getItem("theme") || ""; } catch {}
themeSel.onchange = () => {
  const v = themeSel.value;
  if (v) document.documentElement.dataset.theme = v; else delete document.documentElement.dataset.theme;
  try { v ? localStorage.setItem("theme", v) : localStorage.removeItem("theme"); } catch {}
};
