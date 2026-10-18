/* Ou Meul Stock: sign-in, permissions and the Firebase connection.
   Gives app.js a "backend" object: { db, user, downloads }.
   For automated tests, define window.OM_TEST_BACKEND (a function returning that object) before this file loads. */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const ALL_TABS = ["count", "variance", "order", "waste", "daily", "staff", "sheets", "invoices", "items"];
  let started = false;

  function showOnly(id) {
    ["loginForm", "signupForm", "resetForm", "pendingBox", "setupBox"].forEach(x => { $("#" + x).hidden = x !== id; });
    $("#authScreen").hidden = false;
    $("#appRoot").hidden = true;
  }
  function authMsg(text, kind) {
    const m = $("#authMsg");
    if (!text) { m.hidden = true; return; }
    m.className = "note " + (kind || "info");
    m.textContent = text;
    m.hidden = false;
  }
  const friendly = e => {
    const c = e && e.code || "";
    if (/user-not-found|wrong-password|invalid-credential|invalid-login/.test(c)) return "That email and password don't match. Try again or use Forgot password.";
    if (c === "auth/email-already-in-use") return "There is already an account with that email. Sign in instead.";
    if (c === "auth/weak-password") return "Choose a longer password (at least 8 characters).";
    if (c === "auth/invalid-email") return "That email address doesn't look right.";
    if (c === "auth/too-many-requests") return "Too many attempts. Wait a few minutes and try again.";
    if (c === "auth/network-request-failed") return "No internet connection. Try again when you're online.";
    return "Something went wrong (" + (c || (e && e.message) || "unknown") + ").";
  };

  function makeDownloads() {
    return {
      async save({ filename, data }) {
        const ext = (filename.split(".").pop() || "").toLowerCase();
        const type = { csv: "text/csv;charset=utf-8", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", json: "application/json", html: "text/html;charset=utf-8" }[ext] || "application/octet-stream";
        const blob = new Blob([data], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
      }
    };
  }

  function makeUser(db, uid, doc, authUser) {
    const owner = doc.role === "owner";
    const tabs = owner ? ALL_TABS.slice() : (doc.tabs || []).filter(t => ALL_TABS.includes(t));
    return {
      id: uid,
      name: doc.name || (authUser && authUser.email) || "Someone",
      email: authUser && authUser.email || "",
      isOwner: owner,
      tabs,
      canWrite: owner || !doc.readOnly,
      async profiles(ids) {
        const out = {};
        await Promise.all(ids.map(async id => {
          try { const s = await db.doc("profiles/" + id).get(); if (s.exists) out[id] = s.data(); } catch (e) { /* not allowed to read: shown as "Someone" */ }
        }));
        return out;
      }
    };
  }

  function startApp(backend) {
    if (started) return;
    started = true;
    $("#authScreen").hidden = true;
    $("#appRoot").hidden = false;
    $("#whoName").textContent = backend.user.name;
    const so = $("#signOutBtn");
    if (backend.signOut) so.addEventListener("click", () => backend.signOut()); else so.hidden = true;
    if (backend.user.isOwner) {
      const t = document.querySelector('.tabs button[data-tab="team"]');
      if (t) t.hidden = false;
    }
    window.OM_START(backend);
    if (backend.user.isOwner && window.OM_ADMIN) window.OM_ADMIN.init(backend);
  }

  async function boot() {
    // Test hook
    if (window.OM_TEST_BACKEND) { startApp(await window.OM_TEST_BACKEND()); return; }

    const cfg = window.OM_FIREBASE_CONFIG;
    if (!window.firebase || !cfg || !cfg.apiKey || /PASTE/i.test(cfg.apiKey)) { showOnly("setupBox"); return; }

    firebase.initializeApp(cfg);
    const auth = firebase.auth();
    const db = firebase.firestore();
    db.settings({ ignoreUndefinedProperties: true });
    try { await db.enablePersistence({ synchronizeTabs: true }); } catch (e) { /* private window or old browser: works online only */ }

    let pendingName = "";
    let unsubOwn = null;
    let appliedKey = null;

    const toLogin = () => { authMsg(""); showOnly("loginForm"); };
    $("#toSignup").addEventListener("click", () => { authMsg(""); showOnly("signupForm"); });
    $("#toReset").addEventListener("click", () => { authMsg(""); $("#rsEmail").value = $("#liEmail").value; showOnly("resetForm"); });
    document.querySelectorAll("[data-back]").forEach(b => b.addEventListener("click", toLogin));
    const out = async () => { try { await auth.signOut(); } catch (e) { } location.reload(); };
    $("#pendingOut").addEventListener("click", out);

    $("#loginForm").addEventListener("submit", async e => {
      e.preventDefault(); authMsg("");
      try { await auth.signInWithEmailAndPassword($("#liEmail").value.trim(), $("#liPass").value); }
      catch (err) { authMsg(friendly(err), "err"); }
    });
    $("#signupForm").addEventListener("submit", async e => {
      e.preventDefault(); authMsg("");
      pendingName = $("#suName").value.trim();
      try {
        const cred = await auth.createUserWithEmailAndPassword($("#suEmail").value.trim(), $("#suPass").value);
        try { await cred.user.updateProfile({ displayName: pendingName }); } catch (x) { }
      } catch (err) { pendingName = ""; authMsg(friendly(err), "err"); }
    });
    $("#resetForm").addEventListener("submit", async e => {
      e.preventDefault(); authMsg("");
      try { await auth.sendPasswordResetEmail($("#rsEmail").value.trim()); showOnly("loginForm"); authMsg("If that email has an account, a reset link is on its way.", "info"); }
      catch (err) { authMsg(friendly(err), "err"); }
    });

    auth.onAuthStateChanged(async u => {
      if (unsubOwn) { unsubOwn(); unsubOwn = null; }
      if (!u) { if (!started) toLogin(); return; }
      const ref = db.doc("users/" + u.uid);
      try {
        let snap = await ref.get();
        if (!snap.exists) {
          // First sign-in: ask for access. The owner approves it in the Team tab.
          await ref.set({
            name: pendingName || u.displayName || (u.email || "").split("@")[0],
            email: u.email || "", role: "staff", approved: false, tabs: [], readOnly: false, createdAt: Date.now()
          });
        }
      } catch (err) { authMsg("Couldn't reach the database (" + (err.code || err.message) + "). Check your internet and reload.", "err"); showOnly("loginForm"); return; }

      unsubOwn = ref.onSnapshot(async snap => {
        const d = snap.data();
        if (!d) return;
        const user = makeUser(db, u.uid, d, u);
        const key = JSON.stringify([d.approved, d.role, user.tabs, !!d.readOnly]);
        if (started) {
          if (appliedKey && key !== appliedKey) { alert_("Your access was changed. The app will reload."); setTimeout(() => location.reload(), 1500); }
          return;
        }
        if (!(d.approved === true || d.role === "owner") || !user.tabs.length) {
          $("#pendingTitle").textContent = d.approved === true ? "No tabs yet" : "Waiting for approval";
          $("#pendingText").textContent = d.approved === true
            ? "You're approved, but the owner hasn't chosen any tabs for you yet. This page updates by itself."
            : "Your account is created. The owner needs to approve it and choose what you can see. This page updates by itself once that's done.";
          showOnly("pendingBox");
          return;
        }
        appliedKey = key;
        try { await db.doc("profiles/" + u.uid).set({ name: user.name }); } catch (e) { }
        startApp({ db, user, downloads: makeDownloads(), signOut: out, auth });
      }, err => { authMsg("Couldn't load your account (" + (err.code || err.message) + ").", "err"); showOnly("loginForm"); });
    });

    function alert_(msg) { const t = document.querySelector("#toast"); if (t) { t.textContent = msg; t.hidden = false; } }
  }

  let booted = false;
  const go = () => { if (booted) return; booted = true; boot(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go();
})();
