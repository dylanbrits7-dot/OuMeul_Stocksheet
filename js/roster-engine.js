/* Ou Meul Stock: roster engine. Pure functions, no page or database access, so it also runs in Node for tests.

   A week is a list of "cells": one cell per person needed on a shift, e.g. "2026-10-26|open|0".
   solve() fills the cells; analyze() counts shifts per person and lists problems.

   Hard rules (the solver never breaks one unless it has no other choice):
     - nobody works two shifts on the same day
     - nobody works on a day marked OFF
     - a "must work" person gets a shift on every day marked MUST
     - nobody finishes late (close / host) and then starts early (open / mid) the next morning
     - only people who may host are put on the host spot
     - a person set to "only open" (or only close, mid, host) is only given that kind of shift
     - pinned cells (set by hand) are never changed
   Soft rules (balanced as far as the numbers allow):
     - everyone's total shifts within one of each other (not counting people with fixed days)
     - Monday to Thursday and Friday to Sunday shared evenly
     - early and late shifts shared evenly
     - at most one mid / host shift and one Sunday each
     - no more than 3 days in a row
     - stay close to what was already on the roster, and avoid repeating last week's same-day shift */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OM_ROSTER_ENGINE = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SLOTS = ["open", "mid", "close", "host"];
  const isLate = s => s === 2 || s === 3;
  const isEarly = s => s === 0 || s === 1;
  const cellKey = (date, slot, k) => date + "|" + slot + "|" + k;

  // Weights. Hard rules are far heavier than anything soft.
  const W = {
    empty: 5000, double: 4000, off: 4000, must: 3000, clopen: 1500, host: 4000, only: 2500,
    total: 14, weekday: 9, weekend: 9, open: 3, close: 3, extra: 6, sunday: 6, run: 25, keep: 2.5, same: 1.2
  };

  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function prepare(input) {
    const dates = input.dates, D = dates.length;
    const names = input.waiters.map(w => w.name);
    const P = names.length;
    const pIndex = new Map(names.map((n, i) => [n, i]));
    const cells = [];
    dates.forEach((date, d) => SLOTS.forEach((s, si) => {
      const n = Math.max(0, Number(((input.need || {})[date] || {})[s]) | 0);
      for (let k = 0; k < n; k++) cells.push({ key: cellKey(date, s, k), day: d, slot: si, k, date });
    }));
    const off = Array.from({ length: P }, () => new Uint8Array(D));
    const must = Array.from({ length: P }, () => new Uint8Array(D));
    const avail = input.avail || {};
    names.forEach((n, p) => dates.forEach((date, d) => {
      const v = (avail[n] || {})[date];
      if (v === "off") off[p][d] = 1; else if (v === "must") must[p][d] = 1;
    }));
    const canHost = input.waiters.map(w => w.canHost !== false);
    const only = input.waiters.map(w => (w.only ? SLOTS.indexOf(w.only) : -1));
    const pins = new Int16Array(cells.length).fill(-1);
    const baseIdx = new Int16Array(cells.length).fill(-1);
    cells.forEach((c, i) => {
      const pn = (input.pins || {})[c.key];
      if (pn != null && pIndex.has(pn)) pins[i] = pIndex.get(pn);
      const bn = (input.base || {})[c.key];
      if (bn != null && pIndex.has(bn)) baseIdx[i] = pIndex.get(bn);
    });
    // Last week's shift per person and day (for variety), and how last Sunday ended (for the Monday turnaround).
    const lastWeek = names.map(n => ((input.lastWeek || {})[n] || []).map(s => (s ? SLOTS.indexOf(s) : -1)));
    const prevLate = names.map(n => { const s = (input.prev || {})[n]; return s ? isLate(SLOTS.indexOf(s)) : false; });
    // Mean loads, over people who can work at all this week.
    let active = 0;
    for (let p = 0; p < P; p++) { let ok = false; for (let d = 0; d < D; d++) if (!off[p][d]) ok = true; if (ok) active++; }
    active = Math.max(1, active);
    const wkCut = Math.min(4, D);
    let wkCells = 0, weCells = 0, openCells = 0, closeCells = 0;
    cells.forEach(c => { if (c.day < wkCut) wkCells++; else weCells++; if (c.slot === 0) openCells++; if (c.slot === 2) closeCells++; });
    return {
      input, dates, D, names, P, pIndex, cells, off, must, canHost, only, pins, baseIdx, lastWeek, prevLate, wkCut,
      mean: { total: cells.length / active, wk: wkCells / active, we: weCells / active, open: openCells / active, close: closeCells / active }
    };
  }

  // Cost of a full assignment (lower is better). `a[i]` is a person index or -1.
  function makeCost(M) {
    const { D, P, cells, off, must, canHost, only, baseIdx, lastWeek, prevLate, wkCut, mean } = M;
    const slotAt = new Int8Array(P * D);
    const tot = new Int16Array(P), wk = new Int16Array(P), we = new Int16Array(P), op = new Int16Array(P), cl = new Int16Array(P), mh = new Int16Array(P), sun = new Int16Array(P);
    return function cost(a) {
      let c = 0;
      slotAt.fill(-1); tot.fill(0); wk.fill(0); we.fill(0); op.fill(0); cl.fill(0); mh.fill(0); sun.fill(0);
      for (let i = 0; i < cells.length; i++) {
        const p = a[i], cell = cells[i];
        if (p < 0) { c += W.empty; continue; }
        const idx = p * D + cell.day;
        if (slotAt[idx] >= 0) c += W.double; else slotAt[idx] = cell.slot;
        if (off[p][cell.day]) c += W.off;
        if (cell.slot === 3 && !canHost[p]) c += W.host;
        if (only[p] >= 0 && only[p] !== cell.slot) c += W.only;
        if (baseIdx[i] >= 0 && baseIdx[i] !== p) c += W.keep;
        const lw = lastWeek[p][cell.day];
        if (lw !== undefined && lw === cell.slot) c += W.same;
        tot[p]++;
        if (cell.day < wkCut) wk[p]++; else we[p]++;
        if (cell.slot === 0) op[p]++; else if (cell.slot === 2) cl[p]++; else mh[p]++;
        if (cell.day === D - 1) sun[p]++;
      }
      for (let p = 0; p < P; p++) {
        let run = 0;
        for (let d = 0; d < D; d++) {
          const s = slotAt[p * D + d];
          if (s >= 0) {
            run++; if (run > 3) c += W.run;
            if (d + 1 < D) { const s2 = slotAt[p * D + d + 1]; if (s2 >= 0 && isLate(s) && isEarly(s2)) c += W.clopen; }
          } else { run = 0; if (must[p][d]) c += W.must; }
        }
        if (prevLate[p]) { const s0 = slotAt[p * D]; if (s0 >= 0 && isEarly(s0)) c += W.clopen; }
        // People who are off all week carry no load (they only matter for the hard rules above).
        let free = 0; for (let d = 0; d < D; d++) if (!off[p][d]) free++;
        if (free === 0) continue;
        const dt = tot[p] - mean.total, dw = wk[p] - mean.wk, de = we[p] - mean.we, dop = op[p] - mean.open, dcl = cl[p] - mean.close;
        c += W.total * dt * dt + W.weekday * dw * dw + W.weekend * de * de + W.open * dop * dop + W.close * dcl * dcl;
        if (mh[p] > 1) c += W.extra * (mh[p] - 1) * (mh[p] - 1);
        if (sun[p] > 1) c += W.sunday * (sun[p] - 1) * (sun[p] - 1);
      }
      return c;
    };
  }

  function initial(M, rand) {
    const { cells, P, D, off, must, canHost, only, pins } = M;
    const a = new Int16Array(cells.length).fill(-1);
    const busy = new Uint8Array(P * D);
    const load = new Int16Array(P);
    cells.forEach((c, i) => { if (pins[i] >= 0) { a[i] = pins[i]; busy[pins[i] * D + c.day] = 1; load[pins[i]]++; } });
    // People who must work a day get a place that day first.
    for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) {
      if (!must[p][d] || busy[p * D + d]) continue;
      const free = [];
      cells.forEach((c, i) => { if (c.day === d && a[i] < 0 && (c.slot !== 3 || canHost[p])) free.push(i); });
      if (!free.length) continue;
      const i = free[Math.floor(rand() * free.length)];
      a[i] = p; busy[p * D + d] = 1; load[p]++;
    }
    cells.forEach((c, i) => {
      if (a[i] >= 0) return;
      let best = -1, bs = 1e9;
      for (let p = 0; p < P; p++) {
        if (busy[p * D + c.day] || off[p][c.day]) continue;
        if (c.slot === 3 && !canHost[p]) continue;
        const s = load[p] + rand() * 0.9 + (only[p] >= 0 && only[p] !== c.slot ? 50 : 0);
        if (s < bs) { bs = s; best = p; }
      }
      if (best >= 0) { a[i] = best; busy[best * D + c.day] = 1; load[best]++; }
    });
    return a;
  }

  function anneal(M, cost, a0, rand, iters) {
    const { cells, P, pins } = M;
    const free = [];
    cells.forEach((c, i) => { if (pins[i] < 0) free.push(i); });
    let a = Int16Array.from(a0), cur = cost(a), best = Int16Array.from(a), bestC = cur;
    if (!free.length || P < 2) return { a: best, c: bestC };
    const t0 = 7, t1 = 0.08, ratio = Math.pow(t1 / t0, 1 / iters);
    let T = t0;
    for (let it = 0; it < iters; it++, T *= ratio) {
      const i = free[Math.floor(rand() * free.length)];
      const old = a[i];
      let j = -1, oldJ = -1;
      if (rand() < 0.55 && free.length > 1) {
        j = free[Math.floor(rand() * free.length)];
        if (j === i || a[j] === old) continue;
        oldJ = a[j]; a[i] = oldJ; a[j] = old;
      } else {
        const q = Math.floor(rand() * P);
        if (q === old) continue;
        a[i] = q;
      }
      const nc = cost(a), dlt = nc - cur;
      if (dlt <= 0 || rand() < Math.exp(-dlt / T)) {
        cur = nc;
        if (cur < bestC) { bestC = cur; best.set(a); }
      } else {
        a[i] = old; if (j >= 0) a[j] = oldJ;
      }
    }
    return { a: best, c: bestC };
  }

  // Try every single swap and replacement until nothing improves.
  function polish(M, cost, a) {
    const { cells, P, pins } = M;
    const free = [];
    cells.forEach((c, i) => { if (pins[i] < 0) free.push(i); });
    let cur = cost(a), improved = true, guard = 0;
    while (improved && guard++ < 40) {
      improved = false;
      for (const i of free) {
        const old = a[i];
        for (let q = 0; q < P; q++) {
          if (q === old) continue;
          a[i] = q; const nc = cost(a);
          if (nc < cur - 1e-9) { cur = nc; improved = true; break; } else a[i] = old;
        }
      }
      for (let x = 0; x < free.length; x++) for (let y = x + 1; y < free.length; y++) {
        const i = free[x], j = free[y];
        if (a[i] === a[j]) continue;
        const t = a[i]; a[i] = a[j]; a[j] = t;
        const nc = cost(a);
        if (nc < cur - 1e-9) { cur = nc; improved = true; } else { a[j] = a[i]; a[i] = t; }
      }
    }
    return cur;
  }

  /* solve(input) -> { cells: {key: name}, cost }
     input: { dates:[YYYY-MM-DD x7], need:{date:{open,mid,close,host}}, waiters:[{name,canHost,only}],
              avail:{name:{date:"off"|"must"}}, pins:{key:name}, base:{key:name},
              prev:{name:slot}, lastWeek:{name:[slot|null x7]}, seed, effort } */
  function solve(input) {
    const M = prepare(input);
    const cost = makeCost(M);
    const effort = Math.max(1, Number(input.effort) || 1);
    const seed = Number(input.seed) || 1;
    let best = null, bestC = Infinity;
    const restarts = 5;
    for (let r = 0; r < restarts; r++) {
      const rand = rng(seed * 7919 + r * 104729 + 17);
      const a0 = initial(M, rand);
      const res = anneal(M, cost, a0, rand, Math.round(40000 * effort));
      const c = polish(M, cost, res.a);
      if (c < bestC) { bestC = c; best = Int16Array.from(res.a); }
      if (bestC < 1) break;
    }
    const out = {};
    M.cells.forEach((cell, i) => { if (best[i] >= 0) out[cell.key] = M.names[best[i]]; });
    return { cells: out, cost: bestC };
  }

  /* analyze(input, cells) -> { rows:[{name,open,mid,close,host,total,wk,we,sun,days:[slot|null]}], warnings:[...], spread }
     `cells` is {key: name}. Warnings: {type, ...} with type one of
     empty, double, off, must, clopen, host, only, run, unknown. */
  function analyze(input, cellsMap) {
    const M = prepare(input);
    const { D, P, names, cells, off, must, canHost, only, wkCut, pIndex } = M;
    const warnings = [];
    const slotAt = Array.from({ length: P }, () => new Array(D).fill(null));
    const rows = names.map(n => ({ name: n, open: 0, mid: 0, close: 0, host: 0, total: 0, wk: 0, we: 0, sun: 0, days: new Array(D).fill(null) }));
    const unknown = new Set();
    cells.forEach(cell => {
      const nm = (cellsMap || {})[cell.key];
      if (!nm) { warnings.push({ type: "empty", date: cell.date, slot: SLOTS[cell.slot], k: cell.k }); return; }
      if (!pIndex.has(nm)) { unknown.add(nm); return; }
      const p = pIndex.get(nm), r = rows[p];
      if (slotAt[p][cell.day]) warnings.push({ type: "double", name: nm, date: cell.date });
      else slotAt[p][cell.day] = SLOTS[cell.slot];
      if (off[p][cell.day]) warnings.push({ type: "off", name: nm, date: cell.date });
      if (cell.slot === 3 && !canHost[p]) warnings.push({ type: "host", name: nm, date: cell.date });
      if (only[p] >= 0 && only[p] !== cell.slot) warnings.push({ type: "only", name: nm, date: cell.date, slot: SLOTS[cell.slot] });
      r[SLOTS[cell.slot]]++; r.total++;
      if (cell.day < wkCut) r.wk++; else r.we++;
      if (cell.day === D - 1) r.sun++;
    });
    unknown.forEach(nm => warnings.push({ type: "unknown", name: nm }));
    rows.forEach((r, p) => {
      r.days = slotAt[p].slice();
      let run = 0;
      for (let d = 0; d < D; d++) {
        const s = slotAt[p][d];
        if (s) {
          run++; if (run === 4) warnings.push({ type: "run", name: r.name, date: M.dates[d] });
          const s2 = d + 1 < D ? slotAt[p][d + 1] : null;
          if (s2 && (s === "close" || s === "host") && (s2 === "open" || s2 === "mid")) warnings.push({ type: "clopen", name: r.name, date: M.dates[d + 1] });
        } else { run = 0; if (must[p][d]) warnings.push({ type: "must", name: r.name, date: M.dates[d] }); }
      }
      if (M.prevLate[p] && slotAt[p][0] && (slotAt[p][0] === "open" || slotAt[p][0] === "mid")) warnings.push({ type: "clopen", name: r.name, date: M.dates[0] });
    });
    // Spread between people who are free to take a normal share (no fixed days, no off days).
    const normal = rows.filter((r, p) => {
      for (let d = 0; d < D; d++) if (off[p][d] || must[p][d]) return false;
      return true;
    });
    const t = normal.map(r => r.total);
    const spread = t.length ? Math.max(...t) - Math.min(...t) : 0;
    return { rows, warnings, spread };
  }

  return { SLOTS, cellKey, solve, analyze, prepare };
});
