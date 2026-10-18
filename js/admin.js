/* Ou Meul Stock: Team tab (owner only): who can sign in and which tabs they see, plus backup and import. */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const TABS = [
    ["count", "Count"], ["variance", "Variance"], ["order", "Order"], ["waste", "Waste"], ["daily", "Daily"],
    ["staff", "Staff"], ["sheets", "Count sheets"], ["invoices", "Invoices"], ["items", "Items"]
  ];
  const PRESETS = [
    ["", "Set to…"],
    ["counter", "Counter: count only"],
    ["stockroom", "Stock room: count, count sheets, waste"],
    ["manager", "Manager: everything except Daily & Staff"],
    ["all", "All tabs"],
    ["none", "No tabs"]
  ];
  const PRESET_TABS = {
    counter: ["count"],
    stockroom: ["count", "sheets", "waste"],
    manager: ["count", "variance", "order", "waste", "sheets", "invoices", "items"],
    all: TABS.map(t => t[0]),
    none: []
  };
  // Collections included in a backup / accepted by import. Subcollections (drafts, invoice photo pages) are not included.
  const COLLECTIONS = ["items", "lists", "settings", "sessions", "waste", "daily", "staff", "shifts", "orderSheets", "orderLog", "invoices"];

  let B = null, users = [], armed = null, importPlan = null;

  function init(backend) {
    B = backend;
    B.db.collection("users").onSnapshot(snap => {
      users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const pending = users.filter(u => u.role !== "owner" && !u.approved).length;
      const tb = document.querySelector('.tabs button[data-tab="team"]');
      if (tb) tb.innerHTML = "Team" + (pending ? `<span class="badge">${pending}</span>` : "");
      render();
    }, e => { const b = $("#teamBody"); if (b) b.innerHTML = `<tr><td colspan="6" class="muted">Couldn't load people (${esc(e.code)}).</td></tr>`; });
    $("#tmExport").addEventListener("click", exportAll);
    $("#tmFile").addEventListener("change", () => { importPlan = null; $("#tmRun").disabled = true; $("#tmPreview").disabled = !$("#tmFile").files.length; $("#tmImpMsg").innerHTML = ""; });
    $("#tmColl").addEventListener("change", () => { importPlan = null; $("#tmRun").disabled = true; });
    $("#tmPreview").addEventListener("click", previewImport);
    $("#tmRun").addEventListener("click", runImport);
    $("#teamBody").addEventListener("change", onChange);
    $("#teamBody").addEventListener("click", onClick);
  }

  function render() {
    const body = $("#teamBody");
    if (!body) return;
    if (!users.length) { body.innerHTML = '<tr><td colspan="6" class="muted">No one yet.</td></tr>'; return; }
    const rank = u => u.role === "owner" ? 2 : (u.approved ? 1 : 0);
    const list = users.slice().sort((a, b) => (rank(a) - rank(b)) || (a.name || "").localeCompare(b.name || ""));
    const me = B.user.id;
    body.innerHTML = list.map(u => {
      const owner = u.role === "owner", pend = !owner && !u.approved;
      const tabs = new Set(u.tabs || []);
      const dis = owner ? " disabled" : "";
      return `<tr data-uid="${esc(u.id)}" class="${owner ? "owner" : pend ? "pending" : ""}">
        <td><b>${esc(u.name || "—")}</b>${owner ? ' <span class="em">(owner)</span>' : ""}${pend ? ' <span class="em">waiting for approval</span>' : ""}<br><span class="em">${esc(u.email || "")}</span></td>
        <td>${owner ? '<span class="em">Everything</span>' : `<select data-preset aria-label="Quick set for ${esc(u.name)}">${PRESETS.map(p => `<option value="${p[0]}">${esc(p[1])}</option>`).join("")}</select>`}</td>
        <td><div class="tabbox">${TABS.map(t => `<label><input type="checkbox" data-tab="${t[0]}"${tabs.has(t[0]) || owner ? " checked" : ""}${dis}> ${esc(t[1])}</label>`).join("")}</div></td>
        <td><input type="checkbox" data-ro${u.readOnly ? " checked" : ""}${dis} aria-label="View only for ${esc(u.name)}"></td>
        <td><input type="checkbox" data-ok${u.approved || owner ? " checked" : ""}${dis} aria-label="Approved: ${esc(u.name)}"></td>
        <td>${owner || u.id === me ? "" : `<button class="btn ghost" data-rm>${armed === u.id ? "Tap again" : "Remove"}</button>`}</td>
      </tr>`;
    }).join("");
  }

  async function save(uid, patch) {
    try { await B.db.doc("users/" + uid).update(patch); toast("Saved"); }
    catch (e) { toast("Couldn't save: " + (e.code || e.message)); }
  }
  function toast(msg) { const t = $("#toast"); if (!t) return; t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 2400); }

  function onChange(e) {
    const tr = e.target.closest("tr[data-uid]"); if (!tr) return;
    const uid = tr.dataset.uid, el = e.target;
    const checked = () => [...tr.querySelectorAll("input[data-tab]")].filter(x => x.checked).map(x => x.dataset.tab);
    if (el.matches("input[data-tab]")) save(uid, { tabs: checked() });
    else if (el.matches("[data-ro]")) save(uid, { readOnly: el.checked });
    else if (el.matches("[data-ok]")) {
      const u = users.find(x => x.id === uid);
      // Approving someone with no tabs gives them the basic counter set, so they aren't stuck.
      const patch = { approved: el.checked };
      if (el.checked && !(u.tabs || []).length) patch.tabs = PRESET_TABS.counter;
      save(uid, patch);
    }
    else if (el.matches("[data-preset]")) { const p = el.value; if (p) save(uid, { tabs: PRESET_TABS[p], approved: p === "none" ? false : true }); }
  }
  async function onClick(e) {
    const b = e.target.closest("[data-rm]"); if (!b) return;
    const uid = b.closest("tr").dataset.uid;
    if (armed !== uid) { armed = uid; render(); setTimeout(() => { if (armed === uid) { armed = null; render(); } }, 4000); return; }
    armed = null;
    try { await B.db.doc("users/" + uid).delete(); try { await B.db.doc("profiles/" + uid).delete(); } catch (x) { } toast("Removed"); }
    catch (err) { toast("Couldn't remove: " + (err.code || err.message)); }
  }

  /* ---------- backup ---------- */
  async function exportAll() {
    const btn = $("#tmExport"), msg = $("#tmExportMsg");
    btn.disabled = true; msg.textContent = "Collecting…";
    try {
      const collections = {};
      for (const c of COLLECTIONS) {
        const snap = await B.db.collection(c).get();
        collections[c] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      }
      const payload = { _format: "ou-meul-backup", exportedAt: new Date().toISOString(), collections };
      const day = new Date().toISOString().slice(0, 10);
      await B.downloads.save({ filename: `ou-meul-backup-${day}.json`, data: JSON.stringify(payload) });
      msg.textContent = "Backup downloaded: " + COLLECTIONS.map(c => `${c} ${collections[c].length}`).join(", ");
    } catch (e) { msg.textContent = "Couldn't make the backup: " + (e.code || e.message); }
    btn.disabled = false;
  }

  /* ---------- import ---------- */
  function asDocs(x) {
    if (Array.isArray(x)) return x;
    if (x && typeof x === "object") return Object.entries(x).map(([id, v]) => ({ id, ...v }));
    return [];
  }
  function plan(json, chosen) {
    // Full backup
    if (json && json._format === "ou-meul-backup" && json.collections) {
      return Object.entries(json.collections).filter(([c]) => COLLECTIONS.includes(c)).map(([c, v]) => [c, asDocs(v)]);
    }
    // One collection with a label
    if (json && json.collection && json.docs) return [[json.collection, asDocs(json.docs)]];
    // A plain list, collection chosen from the drop-down
    if (chosen) return [[chosen, asDocs(json)]];
    return null;
  }
  function docId(c, d) {
    if (d.id) return String(d.id);
    if (c === "daily" && d.date) return String(d.date);
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }
  async function previewImport() {
    const msg = $("#tmImpMsg"); importPlan = null; $("#tmRun").disabled = true;
    const f = $("#tmFile").files[0]; if (!f) return;
    let json;
    try { json = JSON.parse(await f.text()); } catch (e) { msg.innerHTML = '<div class="note err">That file isn\'t valid JSON.</div>'; return; }
    const p = plan(json, $("#tmColl").value);
    if (!p) { msg.innerHTML = '<div class="note warn">This file is a plain list. Choose which collection it belongs to, then check it again.</div>'; return; }
    const bad = p.filter(([c]) => !COLLECTIONS.includes(c));
    if (bad.length) { msg.innerHTML = `<div class="note err">Unknown collection: ${esc(bad.map(b => b[0]).join(", "))}.</div>`; return; }
    const total = p.reduce((t, [, d]) => t + d.length, 0);
    if (!total) { msg.innerHTML = '<div class="note warn">There are no records in this file.</div>'; return; }
    importPlan = p;
    msg.innerHTML = `<div class="note info">Ready to import ${total} record${total > 1 ? "s" : ""}: ${p.map(([c, d]) => `${esc(c)} ${d.length}`).join(", ")}. Records with the same id are updated.</div>`;
    $("#tmRun").disabled = false;
  }
  async function runImport() {
    if (!importPlan) return;
    const msg = $("#tmImpMsg"), btn = $("#tmRun"); btn.disabled = true;
    let done = 0; const total = importPlan.reduce((t, [, d]) => t + d.length, 0);
    try {
      for (const [c, docs] of importPlan) {
        for (let i = 0; i < docs.length; i += 400) {
          const batch = B.db.batch();
          docs.slice(i, i + 400).forEach(d => {
            const { id, ...rest } = d;
            batch.set(B.db.collection(c).doc(docId(c, d)), rest, { merge: $("#tmMerge").checked });
          });
          await batch.commit();
          done += Math.min(400, docs.length - i);
          msg.innerHTML = `<div class="note info">Importing… ${done} of ${total}</div>`;
        }
      }
      msg.innerHTML = `<div class="note info">Imported ${done} record${done > 1 ? "s" : ""}.</div>`;
      importPlan = null; $("#tmFile").value = "";
    } catch (e) {
      msg.innerHTML = `<div class="note err">Stopped after ${done} of ${total}: ${esc(e.code || e.message)}. Records already written are kept. Fix the problem and import again; the same ids are simply updated again.</div>`;
    }
    $("#tmPreview").disabled = true;
  }

  window.OM_ADMIN = { init, render };
})();
