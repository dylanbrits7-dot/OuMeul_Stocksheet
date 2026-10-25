/* Ou Meul Stock: Roster tab (waiters' shifts for the week).

   Works without internet: the roster is a Firestore document, and Firestore keeps edits on the device and uploads
   them when the connection returns. Nothing here waits for the server, so the screen never hangs when offline.

   Needs js/roster-engine.js (the balancing rules). app.js calls OM_ROSTER.init(backend, helpers) after sign-in and
   OM_ROSTER.render() whenever the Roster tab is shown.

   Data
     rosters/{Monday date}  { week, need, cells, pins, avail, updatedAt, by }
        cells  "YYYY-MM-DD|slot|k" -> waiter name        pins   same keys, locked by hand
        avail  waiter -> { date -> "off" | "must" }        need   date -> { open, mid, close, host }
     settings/roster        { waiters:[{name, canHost, only, active}], pay:{rate, hours, sundayX, hostPaid} } */
(function () {
  "use strict";
  const E = window.OM_ROSTER_ENGINE;
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const SLOTS = ["open", "mid", "close", "host"];
  const SLOT_LABEL = { open: "Open", mid: "Mid", close: "Close", host: "Host" };
  const SLOT_CODE = { open: "6TO1", mid: "9 TO 3", close: "13CLOSE", host: "HOST" };
  const SUNDAY_CLOSE = "9 TO 4";
  const LETTER = { open: "O", mid: "M", close: "C", host: "H" };
  const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DEFAULT_WAITERS = [
    "Freddie", "Valerie", "Blessing", "Disney", "Prisilla", "Zoe", "Gaynor", "Carla", "Thelita", "Mongi", "Zama", "Melody"
  ].map(name => ({ name, canHost: true, only: "", active: true }))
    .concat(["Nigel", "Calvin"].map(name => ({ name, canHost: false, only: "", active: false }))); // special days only
  const DEFAULT_PAY = { rate: 30.33, hours: 8, sundayX: 1.5, hostPaid: false };

  /* ---------- dates (plain YYYY-MM-DD strings, no time zones) ---------- */
  const pad = n => String(n).padStart(2, "0");
  const parts = s => s.split("-").map(Number);
  function addDays(s, n) { const [y, m, d] = parts(s); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.getUTCFullYear() + "-" + pad(t.getUTCMonth() + 1) + "-" + pad(t.getUTCDate()); }
  function dow(s) { const [y, m, d] = parts(s); return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; } // Monday = 0
  const mondayOf = s => addDays(s, -dow(s));
  function todayIso() { const t = new Date(); return t.getFullYear() + "-" + pad(t.getMonth() + 1) + "-" + pad(t.getDate()); }
  function dayShort(s) { const [, m, d] = parts(s); return d + " " + MO[m - 1]; }
  const dayLabel = s => WD[dow(s)] + " " + dayShort(s);
  // From Friday on, the roster you are most likely working on is next week's.
  function defaultWeek() { const t = todayIso(), m = mondayOf(t); return dow(t) >= 4 ? addDays(m, 7) : m; }
  const defNeed = i => i < 4 ? { open: 3, mid: 0, close: 3, host: 0 } : i < 6 ? { open: 3, mid: 1, close: 3, host: 1 } : { open: 3, mid: 0, close: 3, host: 1 };

  const R = n => "R " + Number(n).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const clone = o => JSON.parse(JSON.stringify(o));
  function stable(o) {
    if (Array.isArray(o)) return o.map(stable);
    if (o && typeof o === "object") return Object.keys(o).sort().reduce((r, k) => (r[k] = stable(o[k]), r), {});
    return o;
  }
  const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
  const blank = w => ({ week: w, need: {}, cells: {}, pins: {}, avail: {} });
  const body = d => ({ need: d.need || {}, cells: d.cells || {}, pins: d.pins || {}, avail: d.avail || {} });

  /* ---------- state ---------- */
  let api = null, db = null, user = null, canWrite = true, started = false;
  let waiters = clone(DEFAULT_WAITERS), pay = { ...DEFAULT_PAY };
  let docs = {}, meta = {};            // week -> saved roster; week -> { pending, cache }
  let week = defaultWeek();
  let cur = blank(week);               // the roster being edited
  let dirty = false, saveTimer = null, inflight = 0, balancing = false;
  let armed = null, armedTimer = null;
  let an = null;                       // latest analysis of `cur`
  let seedN = 0;
  const open = { avail: true, need: false, waiters: false };

  const dates = () => Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const activeWaiters = () => waiters.filter(w => w.active !== false);
  const needOf = date => ({ ...defNeed(dow(date)), ...((cur.need || {})[date] || {}) });
  function spots() {
    const out = [];
    dates().forEach((date, day) => { const n = needOf(date); SLOTS.forEach(slot => { for (let k = 0; k < (n[slot] | 0); k++) out.push({ key: E.cellKey(date, slot, k), date, day, slot, k }); }); });
    return out;
  }

  /* ---------- talking to the engine ---------- */
  function engineInput(extra) {
    const ds = dates(), need = {};
    ds.forEach(d => { need[d] = needOf(d); });
    const act = activeWaiters();
    const list = act.map(w => ({ name: w.name, canHost: w.canHost !== false, only: w.only || undefined }));
    const avail = clone(cur.avail || {});
    if (extra && (extra.forAnalysis || extra.keepOthers)) {
      // People who are on the roster but switched off in the list: still counted, and never given new shifts.
      const known = new Set(list.map(w => w.name));
      Object.values(cur.cells).forEach(n => {
        if (!n || known.has(n)) return;
        known.add(n); list.push({ name: n, canHost: true });
        if (extra.keepOthers) { avail[n] = {}; ds.forEach(d => { avail[n][d] = "off"; }); }
      });
    }
    const prevDoc = docs[addDays(week, -7)];
    const prev = {}, lastWeek = {};
    if (prevDoc && prevDoc.cells) {
      const pds = ds.map(d => addDays(d, -7));
      list.forEach(w => { lastWeek[w.name] = pds.map(() => null); });
      Object.entries(prevDoc.cells).forEach(([key, name]) => {
        const [date, slot] = key.split("|"), i = pds.indexOf(date);
        if (i < 0 || !lastWeek[name]) return;
        lastWeek[name][i] = slot;
        if (i === 6 && slot === "host") prev[name] = "host"; // Sunday "close" is 9 TO 4, so it ends early; a host stays late
      });
    }
    const pins = {};
    Object.entries(cur.pins || {}).forEach(([k, v]) => { if (cur.cells[k] === v) pins[k] = v; });
    return { dates: ds, need, waiters: list, avail, pins, prev, lastWeek };
  }
  function analyse() { an = E.analyze(engineInput({ forAnalysis: true }), cur.cells); }

  /* ---------- saving ---------- */
  function payload() {
    const sp = spots(), keys = new Set(sp.map(s => s.key)), ds = dates();
    const cells = {}, pins = {}, avail = {}, need = {};
    Object.entries(cur.cells).forEach(([k, v]) => { if (v && keys.has(k)) cells[k] = v; });
    Object.entries(cur.pins).forEach(([k, v]) => { if (v && cells[k] === v) pins[k] = v; });
    Object.entries(cur.avail).forEach(([n, m]) => {
      const o = {};
      Object.entries(m || {}).forEach(([d, v]) => { if ((v === "off" || v === "must") && ds.includes(d)) o[d] = v; });
      if (Object.keys(o).length) avail[n] = o;
    });
    ds.forEach(d => { need[d] = needOf(d); });
    return { week: cur.week, need, cells, pins, avail, updatedAt: Date.now(), by: (user && user.name) || "" };
  }
  function scheduleSave() {
    if (!canWrite) return;
    dirty = true; clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 350);
    renderStatus();
  }
  function flushSave() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!dirty || !db || !canWrite) return;
    dirty = false;
    const p = payload();
    inflight++;
    // Do not wait for this: offline, the promise only settles once the server has the data.
    db.doc("rosters/" + p.week).set(p).then(() => { inflight--; if (!reconcile()) renderStatus(); }, e => { inflight--; api.writeErr(e); renderStatus(); });
    renderStatus();
  }
  function saveSettings() {
    if (!canWrite || !db) return;
    db.doc("settings/roster").set({ waiters: waiters.map(w => ({ name: w.name, canHost: w.canHost !== false, only: w.only || "", active: w.active !== false })), pay }).catch(e => api.writeErr(e));
  }

  /* ---------- changing the roster ---------- */
  function changed() { analyse(); scheduleSave(); renderDerived(); }
  function setCell(key, name) {
    if (name) { cur.cells[key] = name; cur.pins[key] = name; } else { delete cur.cells[key]; delete cur.pins[key]; }
    changed();
  }
  function toggleLock(key) {
    if (!cur.cells[key]) return;
    if (cur.pins[key] === cur.cells[key]) delete cur.pins[key]; else cur.pins[key] = cur.cells[key];
    changed();
  }
  function cycleAvail(btn) {
    const name = btn.dataset.n, date = btn.dataset.d;
    const m = cur.avail[name] || (cur.avail[name] = {});
    const v = m[date];
    if (!v) m[date] = "off"; else if (v === "off") m[date] = "must"; else delete m[date];
    const now = m[date];
    btn.className = "rav " + (now || ""); btn.textContent = now === "off" ? "OFF" : now === "must" ? "WORK" : "free";
    btn.setAttribute("aria-label", name + ", " + dayLabel(date) + ": " + (now === "off" ? "off" : now === "must" ? "must work" : "free"));
    changed();
  }
  function setRowAvail(name, how) {
    if (!how) return;
    const m = {};
    if (how === "off" || how === "must") dates().forEach(d => { m[d] = how; });
    cur.avail[name] = m;
    changed(); renderAvail();
  }
  function setNeed(date, slot, n) {
    cur.need = cur.need || {};
    cur.need[date] = { ...needOf(date), [slot]: Math.max(0, Math.min(9, n | 0)) };
    changed();
  }

  function solve(mode) {
    if (!canWrite || balancing) return;
    const act = activeWaiters();
    if (act.length < 2) { api.toast("Add at least two waiters in the Waiters panel first"); return; }
    balancing = true; renderActions();
    setTimeout(() => {
      try {
        const input = engineInput(mode === "fill" ? { keepOthers: true } : null);
        if (mode === "fill") { // keep everything that is already filled in, only fill the gaps
          input.pins = {};
          Object.entries(cur.cells).forEach(([k, v]) => { if (v) input.pins[k] = v; });
        } else if (mode === "all") {
          input.base = {};
          Object.entries(cur.cells).forEach(([k, v]) => { if (v) input.base[k] = v; });
        }
        input.seed = mode === "shuffle" ? (Date.now() % 100000) + 1 : (parts(week).reduce((a, b) => a * 31 + b, 7) % 100000) + 1 + seedN * 17;
        const res = E.solve(input);
        const next = {};
        Object.entries(res.cells).forEach(([k, v]) => { next[k] = v; });
        cur.cells = next;
        // a lock only stays if its cell still holds that person
        Object.keys(cur.pins).forEach(k => { if (cur.cells[k] !== cur.pins[k]) delete cur.pins[k]; });
        seedN++;
        analyse(); scheduleSave();
        const bad = an.warnings.filter(w => w.type !== "run").length;
        api.toast(bad ? "Done, but " + bad + " thing" + (bad === 1 ? "" : "s") + " need a look" : "Roster balanced");
      } catch (e) { api.toast("Couldn't balance the roster: " + (e && e.message || e)); }
      balancing = false; renderAll();
    }, 30);
  }

  function arm(id, run) { // two-tap confirm for things that throw work away
    if (armed === id) { clearTimeout(armedTimer); armed = null; renderActions(); run(); return; }
    armed = id; clearTimeout(armedTimer);
    armedTimer = setTimeout(() => { armed = null; renderActions(); }, 3500);
    renderActions();
  }
  const hasContent = () => Object.keys(cur.cells).length > 0;
  function clearAll(onlyUnlocked) {
    if (onlyUnlocked) Object.keys(cur.cells).forEach(k => { if (cur.pins[k] !== cur.cells[k]) delete cur.cells[k]; });
    else { cur.cells = {}; cur.pins = {}; }
    changed(); renderAll();
  }
  function copyLastWeek() {
    const prev = docs[addDays(week, -7)];
    if (!prev || !prev.cells || !Object.keys(prev.cells).length) { api.toast("There is no roster for last week to copy"); return; }
    const keys = new Set(spots().map(s => s.key)), next = {};
    Object.entries(prev.cells).forEach(([k, name]) => {
      const [d, slot, i] = k.split("|"), nk = E.cellKey(addDays(d, 7), slot, i);
      if (keys.has(nk)) next[nk] = name;
    });
    cur.cells = next; cur.pins = {};
    changed(); renderAll();
    api.toast("Copied last week's roster. Press Auto-balance if you want it re-shuffled.");
  }

  /* ---------- week navigation and loading ---------- */
  function goWeek(w) {
    flushSave();
    week = mondayOf(w);
    load();
    renderAll();
  }
  function load() { cur = docs[week] ? { week, ...clone(body(docs[week])) } : blank(week); analyse(); }

  // Take over the saved copy of this week when it differs from what is on screen and nothing of ours is waiting to be saved.
  function reconcile() {
    if (dirty || inflight > 0) return false;
    const saved = docs[week] ? body(docs[week]) : body(blank(week));
    if (same(body(cur), saved)) return false;
    load(); renderAll();
    return true;
  }
  function onRosters(snap) {
    const nd = {}, nm = {};
    snap.docs.forEach(d => { nd[d.id] = d.data(); nm[d.id] = { pending: !!(d.metadata && d.metadata.hasPendingWrites), cache: !!(d.metadata && d.metadata.fromCache) }; });
    docs = nd; meta = nm;
    if (reconcile()) return;
    analyse(); renderDerived(); // last week's roster feeds this week's variety rules
  }
  function onSettings(snap) {
    if (!snap.exists) return;
    const d = snap.data() || {};
    if (Array.isArray(d.waiters) && d.waiters.length) waiters = d.waiters.filter(w => w && w.name).map(w => ({ name: String(w.name), canHost: w.canHost !== false, only: w.only || "", active: w.active !== false }));
    if (d.pay) pay = { ...DEFAULT_PAY, ...d.pay };
    analyse(); renderAll();
  }

  /* ---------- drawing ---------- */
  const LOCK_ON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor"/><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>';
  const LOCK_OFF = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor"/><path d="M5 7V5a3 3 0 0 1 5.6-1.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

  function renderStatus() {
    const el = $("#rStatus"); if (!el) return;
    const m = meta[week] || {}, offline = typeof navigator !== "undefined" && navigator.onLine === false;
    let kind = "info", text;
    if (!canWrite) text = "View only. You can look at the roster, print it and copy it.";
    else if (dirty) text = "Saving…";
    else if (inflight > 0 || m.pending) { if (offline) { kind = "warn"; text = "Saved on this device. It uploads by itself when you're back online."; } else text = "Uploading…"; }
    else if (!docs[week]) text = "Nothing saved for this week yet. Everything you change is saved by itself.";
    else {
      const d = docs[week], when = d.updatedAt ? new Date(d.updatedAt) : null;
      text = "Saved" + (d.by ? " · last change by " + d.by : "") + (when ? " · " + dayShort(when.getFullYear() + "-" + pad(when.getMonth() + 1) + "-" + pad(when.getDate())) + " " + pad(when.getHours()) + ":" + pad(when.getMinutes()) : "");
      if (offline && m.cache) text += " · you're offline, this is the copy kept on this device";
    }
    el.className = "note " + kind; el.textContent = text;
  }

  function renderHead() {
    const ds = dates();
    $("#rWeek").value = week;
    $("#rRange").textContent = dayLabel(ds[0]) + " to " + dayLabel(ds[6]) + " " + parts(ds[6])[0];
    $("#rPrint").textContent = "Waiters roster: " + dayLabel(ds[0]) + " to " + dayLabel(ds[6]);
  }

  function renderActions() {
    const el = $("#rActions"); if (!el) return;
    const w = canWrite;
    const t = (id, text) => armed === id ? "Tap again to confirm" : text;
    el.innerHTML =
      `<div class="row">${w ? `
        <button class="btn primary" data-act="all"${balancing ? " disabled" : ""}>${balancing ? "Balancing…" : "Auto-balance"}</button>
        <button class="btn" data-act="fill"${balancing ? " disabled" : ""} title="Keep everyone already placed and only fill the empty spots">Fill empty spots</button>
        <button class="btn" data-act="shuffle"${balancing ? " disabled" : ""} title="Try a different fair arrangement">Shuffle</button>
        <button class="btn${armed === "copy" ? " danger" : ""}" data-act="copy">${t("copy", "Copy last week")}</button>
        <button class="btn${armed === "clear" ? " danger" : ""}" data-act="clear">${t("clear", "Clear unlocked")}</button>
        <button class="btn${armed === "wipe" ? " danger" : ""}" data-act="wipe">${t("wipe", "Clear all")}</button>` : ""}
        <span class="rsp"></span>
        <button class="btn" data-act="print">Print</button>
        <button class="btn" data-act="xlsx">Excel</button>
        <button class="btn" data-act="text">Copy for WhatsApp</button>
      </div>`;
  }

  function renderSummary() {
    const el = $("#rTiles"); if (!el || !an) return;
    const sp = spots(), filled = sp.filter(s => cur.cells[s.key]).length;
    const normal = an.rows.filter(r => activeWaiters().some(w => w.name === r.name) && !hasFixedDays(r.name));
    const tot = normal.map(r => r.total);
    const lo = tot.length ? Math.min(...tot) : 0, hi = tot.length ? Math.max(...tot) : 0;
    const bad = an.warnings.filter(w => w.type !== "run").length;
    let wage = 0;
    an.rows.forEach(r => { wage += payFor(r); });
    const tiles = [
      ["Spots filled", filled + " / " + sp.length, filled === sp.length ? "" : (sp.length - filled) + " empty"],
      ["Shifts each", tot.length ? (lo === hi ? String(lo) : lo + " to " + hi) : "—", tot.length ? (hi - lo <= 1 ? "Balanced" : "Uneven: " + (hi - lo) + " apart") : "No waiters"],
      ["Things to check", String(bad), bad ? "See the list below" : "All rules are met"]
    ];
    if (pay.rate > 0) tiles.push(["Wage estimate", R(wage), pay.hours + " h × " + R(pay.rate) + ", Sunday ×" + pay.sundayX + (pay.hostPaid ? "" : ", host not counted")]);
    el.innerHTML = tiles.map(([k, v, s]) => `<div class="tile${k === "Things to check" && bad ? " short" : ""}"><div class="lbl">${esc(k)}</div><div class="v">${esc(v)}</div><div class="sub">${esc(s)}</div></div>`).join("");
  }
  function hasFixedDays(name) {
    const m = (cur.avail || {})[name] || {};
    return dates().some(d => m[d] === "off" || m[d] === "must");
  }
  function payFor(r) {
    if (!(pay.rate > 0)) return 0;
    let t = 0;
    r.days.forEach((s, i) => { if (!s) return; if (s === "host" && !pay.hostPaid) return; t += pay.hours * pay.rate * (i === 6 ? pay.sundayX : 1); });
    return t;
  }

  function warnText(w) {
    const dl = w.date ? dayLabel(w.date) : "";
    switch (w.type) {
      case "empty": return ["hi", `${dl}: ${SLOT_LABEL[w.slot]} spot ${w.k + 1} is empty`, "Pick a waiter, or press Auto-balance."];
      case "double": return ["hi", `${w.name} has two shifts on ${dl}`, "Move one of them to someone else."];
      case "off": return ["hi", `${w.name} is on the roster on ${dl}`, "That day is marked OFF for them."];
      case "must": return ["hi", `${w.name} has no shift on ${dl}`, "That day is marked MUST WORK for them."];
      case "clopen": return ["hi", `${w.name} closes the night before ${dl}`, "and starts early the next morning."];
      case "host": return ["hi", `${w.name} is hosting on ${dl}`, "but isn't ticked as able to host in the Waiters panel."];
      case "only": return ["hi", `${w.name} is on ${SLOT_LABEL[w.slot]} on ${dl}`, "They are set to one kind of shift only."];
      case "run": return ["md", `${w.name} works 4 days in a row`, "by " + dl + "."];
      case "inactive": return ["md", `${w.name} is switched off in the Waiters panel`, "Their shifts are still counted."];
      default: return ["md", `${w.name || "Someone"} is not on the waiters list`, "Add them in the Waiters panel."];
    }
  }
  function renderWarnings() {
    const el = $("#rWarn"); if (!el || !an) return;
    const act = new Set(activeWaiters().map(w => w.name));
    // A long run of days is only worth a note when nobody asked for it: someone marked must-work every day can't avoid it.
    const mustSome = n => dates().some(d => ((cur.avail[n] || {})[d]) === "must");
    const list = an.warnings.filter(w => !(w.type === "run" && mustSome(w.name)));
    const seen = new Set();
    Object.values(cur.cells).forEach(n => { if (n && !act.has(n) && !seen.has(n)) { seen.add(n); list.push({ type: "inactive", name: n }); } });
    if (!list.length) { el.hidden = true; el.innerHTML = ""; return; }
    list.sort((a, b) => (warnText(a)[0] === "hi" ? 0 : 1) - (warnText(b)[0] === "hi" ? 0 : 1));
    const shown = list.slice(0, 14);
    el.hidden = false;
    el.innerHTML = shown.map(w => { const [s, t, d] = warnText(w); return `<div class="flag"><span class="sev ${s}">${s === "hi" ? "Fix" : "Check"}</span><div><b>${esc(t)}</b><span class="d">${esc(d)}</span></div></div>`; }).join("") +
      (list.length > shown.length ? `<div class="flag"><span class="sev md">More</span><div><b>${list.length - shown.length} more</b></div></div>` : "");
  }

  function renderGrid() {
    const el = $("#rGrid"); if (!el) return;
    const ds = dates(), t = todayIso();
    const names = activeWaiters().map(w => w.name);
    const onDay = {}; // date -> { name: slot }
    Object.entries(cur.cells).forEach(([k, n]) => { if (!n) return; const [d, s] = k.split("|"); (onDay[d] = onDay[d] || {})[n] = s; });
    const badKeys = new Set();
    (an ? an.warnings : []).forEach(w => {
      if (w.type === "empty") badKeys.add(E.cellKey(w.date, w.slot, w.k));
      else if (w.date && w.name) Object.entries(cur.cells).forEach(([k, n]) => { if (n === w.name && k.startsWith(w.date + "|")) badKeys.add(k); });
    });
    const dayCount = {};
    spots().forEach(sp => { const c = dayCount[sp.date] || (dayCount[sp.date] = { total: 0, filled: 0 }); c.total++; if (cur.cells[sp.key]) c.filled++; });
    const head = ds.map((d, i) => {
      const { total, filled } = dayCount[d] || { total: 0, filled: 0 };
      return `<th class="rday${d === t ? " today" : ""}">${WD[i]}<small>${dayShort(d)}</small><small class="rfill${filled < total ? " low" : ""}">${filled}/${total}</small></th>`;
    }).join("");
    let rows = "";
    SLOTS.forEach(slot => {
      const maxN = Math.max(...ds.map(d => needOf(d)[slot] | 0));
      for (let k = 0; k < maxN; k++) {
        rows += `<tr class="${k === 0 ? "rgrp" : ""}"><th class="rl" scope="row">${k === 0 ? `${SLOT_LABEL[slot]}<small>${slot === "close" ? "13CLOSE · Sun " + SUNDAY_CLOSE : SLOT_CODE[slot]}</small>` : ""}</th>`;
        ds.forEach((d, i) => {
          if (k >= (needOf(d)[slot] | 0)) { rows += '<td class="rnone"></td>'; return; }
          const key = E.cellKey(d, slot, k), name = cur.cells[key] || "";
          const pinned = !!name && cur.pins[key] === name, bad = badKeys.has(key);
          const label = `${SLOT_LABEL[slot]} spot ${k + 1}, ${dayLabel(d)}`;
          const offSet = n => ((cur.avail[n] || {})[d]) === "off";
          const opts = ['<option value="">—</option>'];
          const list = names.slice();
          if (name && !list.includes(name)) list.push(name);
          list.forEach(n => {
            const where = onDay[d] && onDay[d][n] && n !== name ? " · " + SLOT_LABEL[onDay[d][n]] : "";
            const off = offSet(n) ? " · off" : "";
            opts.push(`<option value="${esc(n)}"${n === name ? " selected" : ""}>${esc(n)}${esc(off || where)}</option>`);
          });
          rows += `<td class="rc${bad ? " bad" : ""}${name ? "" : " empty"}${pinned ? " pinned" : ""}"><select data-key="${esc(key)}" aria-label="${esc(label)}"${canWrite ? "" : " disabled"}>${opts.join("")}</select>` +
            (name && canWrite ? `<button class="lock" data-lock="${esc(key)}" aria-pressed="${pinned}" aria-label="${pinned ? "Locked. Auto-balance won't move " : "Lock "}${esc(name)} on ${esc(label)}" title="${pinned ? "Locked: Auto-balance keeps this" : "Tap to lock this spot"}">${pinned ? LOCK_ON : LOCK_OFF}</button>` : "") +
            `</td>`;
        });
        rows += "</tr>";
      }
    });
    if (!rows) rows = '<tr><td class="muted" colspan="8">No shifts are needed this week. Open "Shifts needed per day" below.</td></tr>';
    el.innerHTML = `<table class="rgridt"><thead><tr><th class="rl"></th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderCounts() {
    const el = $("#rCounts"); if (!el || !an) return;
    const ds = dates(), act = new Set(activeWaiters().map(w => w.name));
    const rows = an.rows.filter(r => act.has(r.name) || r.total > 0);
    const showPay = pay.rate > 0;
    const sum = k => rows.reduce((a, r) => a + r[k], 0);
    const chip = (r, i) => {
      const s = r.days[i], v = ((cur.avail[r.name] || {})[ds[i]]);
      if (s) return `<td class="rd ${s}">${LETTER[s]}</td>`;
      if (v === "off") return '<td class="rd off">off</td>';
      return '<td class="rd none">·</td>';
    };
    el.innerHTML = `<table class="rcount"><thead><tr><th>Waiter</th><th class="n">Open</th><th class="n">Mid</th><th class="n">Close</th><th class="n">Host</th><th class="n">Total</th><th class="n">Mon–Thu</th><th class="n">Fri–Sun</th>${WD.map(d => `<th class="rd">${d}</th>`).join("")}${showPay ? '<th class="n rpay">Est. pay</th>' : ""}</tr></thead><tbody>` +
      rows.map(r => `<tr${act.has(r.name) ? "" : ' class="rgone"'}><td><b>${esc(r.name)}</b>${hasFixedDays(r.name) ? ' <span class="tag">set days</span>' : ""}</td><td class="n">${r.open}</td><td class="n">${r.mid}</td><td class="n">${r.close}</td><td class="n">${r.host}</td><td class="n"><b>${r.total}</b></td><td class="n">${r.wk}</td><td class="n">${r.we}</td>${ds.map((_, i) => chip(r, i)).join("")}${showPay ? `<td class="n rpay">${R(payFor(r))}</td>` : ""}</tr>`).join("") +
      `<tr class="tot"><td>Total</td><td class="n">${sum("open")}</td><td class="n">${sum("mid")}</td><td class="n">${sum("close")}</td><td class="n">${sum("host")}</td><td class="n">${sum("total")}</td><td class="n">${sum("wk")}</td><td class="n">${sum("we")}</td><td colspan="7"></td>${showPay ? `<td class="n rpay">${R(rows.reduce((a, r) => a + payFor(r), 0))}</td>` : ""}</tr></tbody></table>`;
    $("#rCountNote").textContent = "O = open, M = mid, C = close, H = host. “set days” means that person has days marked off or must-work, so they're left out of the “shifts each” comparison.";
  }

  function renderAvail() {
    const el = $("#rAvail"); if (!el) return;
    const ds = dates();
    const st = { off: ["OFF", "off"], must: ["WORK", "must"] };
    el.innerHTML = `<table class="ravail"><thead><tr><th>Waiter</th>${ds.map((d, i) => `<th>${WD[i]}<small>${dayShort(d)}</small></th>`).join("")}<th>Quick set</th></tr></thead><tbody>` +
      activeWaiters().map(w => `<tr><th class="rl" scope="row">${esc(w.name)}</th>${ds.map(d => {
        const v = (cur.avail[w.name] || {})[d], s = st[v] || ["free", ""];
        return `<td><button class="rav ${s[1]}" data-n="${esc(w.name)}" data-d="${d}" aria-label="${esc(w.name)}, ${esc(dayLabel(d))}: ${v === "off" ? "off" : v === "must" ? "must work" : "free"}"${canWrite ? "" : " disabled"}>${s[0]}</button></td>`;
      }).join("")}<td><select data-avrow="${esc(w.name)}" aria-label="Quick set for ${esc(w.name)}"${canWrite ? "" : " disabled"}><option value="">Set row…</option><option value="free">Free all week</option><option value="off">Off all week</option><option value="must">Must work every day</option></select></td></tr>`).join("") +
      "</tbody></table>";
  }

  function renderNeeds() {
    const el = $("#rNeeds"); if (!el) return;
    const ds = dates();
    el.innerHTML = `<table class="rneed"><thead><tr><th></th>${ds.map((d, i) => `<th>${WD[i]}<small>${dayShort(d)}</small></th>`).join("")}</tr></thead><tbody>` +
      SLOTS.map(s => `<tr><th class="rl" scope="row">${SLOT_LABEL[s]}</th>${ds.map(d => `<td><input type="number" inputmode="numeric" min="0" max="9" value="${needOf(d)[s] | 0}" data-need="${d}|${s}" aria-label="${SLOT_LABEL[s]} waiters needed on ${esc(dayLabel(d))}"${canWrite ? "" : " disabled"}></td>`).join("")}</tr>`).join("") +
      "</tbody></table>";
  }

  function renderWaiters() {
    const el = $("#rWaiters"); if (!el) return;
    el.innerHTML = `<table class="rwait"><thead><tr><th>Waiter</th><th>Can host</th><th>Only works</th><th>On the list</th></tr></thead><tbody>` +
      waiters.map((w, i) => `<tr${w.active === false ? ' class="rgone"' : ""}><th class="rl" scope="row">${esc(w.name)}</th>
        <td><input type="checkbox" data-wi="${i}" data-wf="canHost"${w.canHost !== false ? " checked" : ""} aria-label="${esc(w.name)} can host"${canWrite ? "" : " disabled"}></td>
        <td><select data-wi="${i}" data-wf="only" aria-label="${esc(w.name)} only works"${canWrite ? "" : " disabled"}>${[["", "Any shift"], ["open", "Open only"], ["mid", "Mid only"], ["close", "Close only"], ["host", "Host only"]].map(([v, t]) => `<option value="${v}"${(w.only || "") === v ? " selected" : ""}>${t}</option>`).join("")}</select></td>
        <td><input type="checkbox" data-wi="${i}" data-wf="active"${w.active !== false ? " checked" : ""} aria-label="${esc(w.name)} is on the list"${canWrite ? "" : " disabled"}></td></tr>`).join("") +
      "</tbody></table>";
    const f = $("#rPay");
    if (f) {
      f.querySelector('[data-pf="rate"]').value = pay.rate;
      f.querySelector('[data-pf="hours"]').value = pay.hours;
      f.querySelector('[data-pf="sundayX"]').value = pay.sundayX;
      f.querySelector('[data-pf="hostPaid"]').checked = !!pay.hostPaid;
      f.querySelectorAll("input").forEach(i => { i.disabled = !canWrite; });
    }
    $("#rAddWrap").hidden = !canWrite;
  }

  function renderDerived() { renderStatus(); renderSummary(); renderWarnings(); renderGrid(); renderCounts(); }
  function renderAll() {
    if (!started) return;
    renderHead(); renderStatus(); renderActions(); renderSummary(); renderWarnings(); renderGrid(); renderCounts(); renderAvail(); renderNeeds(); renderWaiters();
    ["avail", "need", "waiters"].forEach(k => { const d = $("#rp-" + k); if (d) d.open = !!open[k]; });
  }

  /* ---------- sharing ---------- */
  function codeFor(slot, date) { return slot === "close" && dow(date) === 6 ? SUNDAY_CLOSE : SLOT_CODE[slot]; }
  function sheetRows() {
    const ds = dates(), out = [["", ...ds.map(dayLabel)]];
    SLOTS.forEach(slot => {
      const maxN = Math.max(...ds.map(d => needOf(d)[slot] | 0));
      for (let k = 0; k < maxN; k++) out.push([k === 0 ? (slot === "close" ? "13CLOSE (Sun " + SUNDAY_CLOSE + ")" : SLOT_CODE[slot]) : "", ...ds.map(d => k < (needOf(d)[slot] | 0) ? (cur.cells[E.cellKey(d, slot, k)] || "") : "")]);
    });
    return out;
  }
  function countRows() {
    const ds = dates(), act = new Set(activeWaiters().map(w => w.name));
    const out = [["Waiter", "Open", "Mid", "Close", "Host", "Total", "Mon-Thu", "Fri-Sun", ...ds.map(d => WD[dow(d)])].concat(pay.rate > 0 ? ["Est. pay"] : [])];
    an.rows.filter(r => act.has(r.name) || r.total > 0).forEach(r => out.push([r.name, r.open, r.mid, r.close, r.host, r.total, r.wk, r.we, ...r.days.map(s => s ? LETTER[s] : ""), ...(pay.rate > 0 ? [Math.round(payFor(r) * 100) / 100] : [])]));
    return out;
  }
  function whatsappText() {
    const ds = dates(), lines = ["*WAITERS ROSTER*", dayLabel(ds[0]) + " to " + dayLabel(ds[6]), ""];
    ds.forEach(d => {
      lines.push("*" + dayLabel(d).toUpperCase() + "*");
      SLOTS.forEach(slot => {
        const n = needOf(d)[slot] | 0; if (!n) return;
        const who = []; for (let k = 0; k < n; k++) who.push(cur.cells[E.cellKey(d, slot, k)] || "?");
        lines.push(codeFor(slot, d) + ": " + who.join(", "));
      });
      lines.push("");
    });
    lines.push("*SHIFTS THIS WEEK*");
    const act = new Set(activeWaiters().map(w => w.name));
    an.rows.filter(r => act.has(r.name) || r.total > 0).forEach(r => lines.push(r.name + ": " + r.total));
    return lines.join("\n");
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); api.toast("Copied. Paste it into WhatsApp."); return; } catch (e) { /* fall through */ }
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch (e) { }
    ta.remove();
    api.toast(ok ? "Copied. Paste it into WhatsApp." : "Couldn't copy on this device");
  }

  /* ---------- events ---------- */
  function wire() {
    const root = $("#view-roster");
    $("#rPrev").addEventListener("click", () => goWeek(addDays(week, -7)));
    $("#rNext").addEventListener("click", () => goWeek(addDays(week, 7)));
    $("#rThis").addEventListener("click", () => goWeek(defaultWeek()));
    $("#rWeek").addEventListener("change", e => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) goWeek(e.target.value); });

    root.addEventListener("click", e => {
      const act = e.target.closest("[data-act]");
      if (act) {
        const a = act.dataset.act;
        if (a === "all" || a === "fill" || a === "shuffle") solve(a);
        else if (a === "copy") { if (hasContent()) arm("copy", copyLastWeek); else copyLastWeek(); }
        else if (a === "clear") arm("clear", () => clearAll(true));
        else if (a === "wipe") arm("wipe", () => clearAll(false));
        else if (a === "print") window.print();
        else if (a === "xlsx") api.offerXlsx("ou-meul-waiters-roster-" + week + ".xlsx", [["Roster", sheetRows()], ["Shift counts", countRows()]]);
        else if (a === "text") copyText(whatsappText());
        return;
      }
      const lk = e.target.closest("[data-lock]");
      if (lk) { toggleLock(lk.dataset.lock); return; }
      const av = e.target.closest(".rav");
      if (av) { cycleAvail(av); return; }
      if (e.target.closest("#rAddBtn")) addWaiter();
      if (e.target.closest("#rNeedReset")) { cur.need = {}; changed(); renderGrid(); renderNeeds(); }
    });
    root.addEventListener("change", e => {
      const t = e.target;
      if (t.matches("select[data-key]")) {
        const k = t.dataset.key, y = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
        setCell(k, t.value);
        if (y) { const n = root.querySelector('select[data-key="' + (window.CSS && CSS.escape ? CSS.escape(y) : y) + '"]'); if (n) n.focus(); }
      } else if (t.matches("select[data-avrow]")) {
        setRowAvail(t.dataset.avrow, t.value);
      } else if (t.matches("input[data-need]")) {
        const [d, s] = t.dataset.need.split("|"); setNeed(d, s, parseInt(t.value, 10) || 0);
      } else if (t.matches("[data-wi]")) {
        const w = waiters[+t.dataset.wi]; if (!w) return;
        const f = t.dataset.wf;
        if (f === "canHost" || f === "active") w[f] = t.checked; else w[f] = t.value;
        saveSettings(); analyse(); renderAll();
      } else if (t.matches("[data-pf]")) {
        const f = t.dataset.pf;
        if (f === "hostPaid") pay.hostPaid = t.checked; else pay[f] = Math.max(0, parseFloat(String(t.value).replace(",", ".")) || 0);
        saveSettings(); renderSummary(); renderCounts();
      }
    });
    root.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.id === "rAddName") { e.preventDefault(); addWaiter(); } });
    ["avail", "need", "waiters"].forEach(k => { const d = $("#rp-" + k); if (d) d.addEventListener("toggle", () => { open[k] = d.open; }); });
    window.addEventListener("online", renderStatus);
    window.addEventListener("offline", renderStatus);
    document.addEventListener("visibilitychange", () => { if (document.hidden) flushSave(); });
    window.addEventListener("pagehide", flushSave);
  }
  function addWaiter() {
    const inp = $("#rAddName"), name = inp.value.replace(/[|\/]/g, " ").replace(/\s+/g, " ").trim().slice(0, 30);
    if (!name) return;
    if (waiters.some(w => w.name.toLowerCase() === name.toLowerCase())) { api.toast(name + " is already on the list"); return; }
    waiters.push({ name, canHost: true, only: "", active: true });
    inp.value = "";
    saveSettings(); analyse(); renderAll();
    api.toast(name + " added");
  }

  /* ---------- start ---------- */
  function init(backend, helpers) {
    if (started) return;
    started = true;
    api = helpers; db = backend.db; user = backend.user;
    canWrite = backend.user.canWrite !== false;
    wire();
    load();
    renderAll();
    db.collection("rosters").orderBy("week", "desc").limit(80).onSnapshot({ includeMetadataChanges: true }, onRosters, e => api.toast("Roster stopped updating (" + e.code + "). Reload the page."));
    db.doc("settings/roster").onSnapshot(onSettings, () => { });
  }
  function render() { if (started) renderAll(); }

  window.OM_ROSTER = { init, render, _test: { addDays, dow, mondayOf, defaultWeek } };
})();
