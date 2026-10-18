/* Test-only: an in-memory stand-in for Firestore so the app can be exercised without Firebase.
   Usage (before js/backend.js loads):
     window.OM_TEST_BACKEND = () => OM_MOCK.make({ role: "owner", tabs: [...], seed: {...} });
   The mock records what the app listens to (OM_MOCK.listened) and every write (OM_MOCK.writes). */
(function () {
  const store = {};            // "collection path" -> Map(id -> data)
  const subs = [];             // active listeners
  const listened = [];
  const writes = [];
  const clone = o => JSON.parse(JSON.stringify(o));

  const coll = p => store[p] || (store[p] = new Map());
  const split = path => { const i = path.lastIndexOf("/"); return [path.slice(0, i), path.slice(i + 1)]; };

  function notify() { subs.slice().forEach(s => s.fire()); }

  function snapOf(path, order, lim) {
    let docs = [...coll(path).entries()].map(([id, d]) => ({ id, d }));
    if (order) {
      docs.sort((a, b) => {
        const x = a.d[order.f], y = b.d[order.f];
        const r = x === y ? 0 : (x > y ? 1 : -1);
        return order.dir === "desc" ? -r : r;
      });
    }
    if (lim) docs = docs.slice(0, lim);
    const out = docs.map(({ id, d }) => ({ id, exists: true, data: () => clone(d) }));
    return { docs: out, size: out.length, empty: !out.length, docChanges: () => out.map(x => ({ type: "modified", doc: x })) };
  }

  function query(path, order, lim) {
    const q = {
      orderBy: (f, dir) => query(path, { f, dir: dir || "asc" }, lim),
      limit: n => query(path, order, n),
      get: async () => snapOf(path, order, lim),
      onSnapshot: (cb, err) => {
        listened.push(path);
        const s = { fire: () => Promise.resolve().then(() => cb(snapOf(path, order, lim))) };
        subs.push(s); s.fire();
        return () => { const i = subs.indexOf(s); if (i >= 0) subs.splice(i, 1); };
      },
      doc: id => docRef(path + "/" + id)
    };
    return q;
  }

  function docRef(path) {
    const [cp, id] = split(path);
    const snap = () => { const d = coll(cp).get(id); return { id, exists: !!d, data: () => d ? clone(d) : undefined }; };
    return {
      id,
      get: async () => snap(),
      set: async (data, opts) => { writes.push(["set", path]); const cur = coll(cp).get(id); coll(cp).set(id, opts && opts.merge && cur ? { ...cur, ...clone(data) } : clone(data)); notify(); },
      update: async (data) => {
        writes.push(["update", path]);
        const cur = coll(cp).get(id); if (!cur) throw Object.assign(new Error("not found"), { code: "not-found" });
        coll(cp).set(id, { ...cur, ...clone(data) }); notify();
      },
      delete: async () => { writes.push(["delete", path]); coll(cp).delete(id); notify(); },
      onSnapshot: (cb) => {
        listened.push(path);
        const s = { fire: () => Promise.resolve().then(() => cb(snap())) };
        subs.push(s); s.fire();
        return () => { const i = subs.indexOf(s); if (i >= 0) subs.splice(i, 1); };
      }
    };
  }

  const db = {
    collection: p => query(p),
    doc: p => docRef(p),
    batch: () => {
      const ops = [];
      return { set: (ref, data, opts) => ops.push(() => ref.set(data, opts)), commit: async () => { for (const o of ops) await o(); } };
    }
  };

  window.OM_MOCK = {
    store, writes, listened, db,
    make({ role = "owner", tabs = [], readOnly = false, seed = {}, name = "Test Person" }) {
      Object.entries(seed).forEach(([c, docs]) => { Object.entries(docs).forEach(([id, d]) => coll(c).set(id, clone(d))); });
      const owner = role === "owner";
      const all = ["count", "variance", "order", "waste", "daily", "staff", "sheets", "invoices", "items"];
      const saved = [];
      return {
        db,
        user: { id: "u1", name, email: "t@example.com", isOwner: owner, tabs: owner ? all : tabs, canWrite: owner || !readOnly, profiles: async ids => Object.fromEntries(ids.map(i => [i, { name: "Someone" }])) },
        downloads: { save: async f => { saved.push(f); window.OM_MOCK.downloads = saved; } },
        signOut: () => { }
      };
    }
  };
})();
