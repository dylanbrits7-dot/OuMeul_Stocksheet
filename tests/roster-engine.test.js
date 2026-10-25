/* Unit tests for the roster engine. Run:  node tests/roster-engine.test.js */
const E = require("../js/roster-engine.js");
let failed = 0;
const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) failed++; };

const dates = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"];
const need = {};
dates.forEach((d, i) => { need[d] = i < 4 ? { open: 3, close: 3 } : i < 6 ? { open: 3, mid: 1, close: 3, host: 1 } : { open: 3, close: 3, host: 1 }; });
const names12 = ["Freddie", "Valerie", "Blessing", "Disney", "Prisilla", "Zoe", "Gaynor", "Carla", "Thelita", "Mongi", "Zama", "Melody"];
const waiters = names => names.map(name => ({ name, canHost: true }));

function check(input, label, opts = {}) {
  const t0 = Date.now();
  const r = E.solve(input);
  const ms = Date.now() - t0;
  const a = E.analyze(input, r.cells);
  const hard = a.warnings.filter(w => w.type !== "run");
  ok(hard.length === 0, `${label}: no hard problems ${hard.length ? JSON.stringify(hard.slice(0, 4)) : ""}`);
  const rows = a.rows.filter(x => !(opts.exclude || []).includes(x.name));
  const tot = rows.map(x => x.total);
  ok(Math.max(...tot) - Math.min(...tot) <= 1, `${label}: others within one shift of each other (${rows.map(x => x.name + x.total).join(" ")})`);
  if (opts.weekday2) ok(rows.every(x => x.wk === opts.weekday2), `${label}: everyone else exactly ${opts.weekday2} shifts Mon-Thu`);
  const sums = Object.keys(need).reduce((n, d) => n + Object.values(need[d]).reduce((x, y) => x + y, 0), 0);
  ok(Object.keys(r.cells).length === sums, `${label}: every slot filled (${sums})`);
  ok(ms < 4000, `${label}: solved in ${ms} ms`);
  return { r, a };
}

/* 1. This week: Melody off Mon+Tue, must work Wed-Sun; 12 waiters including the new ones. */
{
  const avail = { Melody: {} };
  dates.slice(0, 2).forEach(d => avail.Melody[d] = "off");
  dates.slice(2).forEach(d => avail.Melody[d] = "must");
  const input = { dates, need, waiters: waiters(names12), avail, seed: 1 };
  const { a } = check(input, "Melody week", { exclude: ["Melody"], weekday2: 2 });
  const mel = a.rows.find(x => x.name === "Melody");
  ok(mel.total === 5 && mel.days[0] === null && mel.days[1] === null, "Melody works Wed-Sun and not Mon/Tue");
  ok(a.rows.filter(x => x.name !== "Melody").every(x => x.open >= 1 && x.open <= 2 && x.close >= 1 && x.close <= 2), "early and late shifts spread (1-2 each)");
  ok(a.rows.every(x => x.sun <= 1), "nobody works more than one Sunday");
}

/* 2. Same week, with a pinned cell and an off day (Valerie off Thursday). */
{
  const avail = { Melody: {}, Valerie: { "2026-10-29": "off" } };
  dates.slice(0, 2).forEach(d => avail.Melody[d] = "off");
  dates.slice(2).forEach(d => avail.Melody[d] = "must");
  const pins = { "2026-10-30|close|2": "Zoe" };
  const input = { dates, need, waiters: waiters(names12), avail, pins, seed: 3 };
  const { r, a } = check(input, "Valerie off Thursday + pin", { exclude: ["Melody", "Valerie"] });
  ok(r.cells["2026-10-30|close|2"] === "Zoe", "pinned cell kept");
  const val = a.rows.find(x => x.name === "Valerie");
  ok(val.days[3] === null, "Valerie is off on Thursday");
}

/* 3. Re-balancing keeps pinned cells and mostly stays close to a base roster. */
{
  const input0 = { dates, need, waiters: waiters(names12), avail: {}, seed: 5 };
  const first = E.solve(input0).cells;
  const input1 = { ...input0, base: first, seed: 9 };
  const second = E.solve(input1).cells;
  const same = Object.keys(first).filter(k => first[k] === second[k]).length;
  ok(same >= Object.keys(first).length * 0.9, `re-balance keeps most of the existing roster (${same}/${Object.keys(first).length})`);
}

/* 4. Last Sunday's closer is not put on Monday's open. */
{
  const input = { dates, need, waiters: waiters(names12), avail: {}, prev: Object.fromEntries(names12.slice(0, 8).map(n => [n, "close"])), seed: 2 };
  const { a } = check(input, "Monday turnaround");
  ok(!a.warnings.some(w => w.type === "clopen"), "no close-to-open turnaround across the weekend");
}

/* 5. Not enough people: reports problems instead of crashing. */
{
  const input = { dates, need, waiters: waiters(["A", "B", "C"]), avail: {}, seed: 1 };
  const r = E.solve(input);
  const a = E.analyze(input, r.cells);
  ok(a.warnings.length > 0, "3 waiters for 47 slots: warnings are reported");
}

/* 6. Same seed gives the same roster. */
{
  const input = { dates, need, waiters: waiters(names12), avail: {}, seed: 7 };
  ok(JSON.stringify(E.solve(input).cells) === JSON.stringify(E.solve(input).cells), "same seed gives the same roster");
}

/* 7. Dylan's other week: Blessing on leave (not on the list), Melody off Mon-Wed and Sun, Valerie off Thursday. */
{
  const n = names12.filter(x => x !== "Blessing");
  const avail = { Melody: { "2026-10-26": "off", "2026-10-27": "off", "2026-10-28": "off", "2026-11-01": "off" }, Valerie: { "2026-10-29": "off" } };
  ["2026-10-29", "2026-10-30", "2026-10-31"].forEach(d => avail.Melody[d] = "must");
  const input = { dates, need, waiters: waiters(n), avail, seed: 11 };
  check(input, "11 waiters, several rules", { exclude: ["Melody", "Valerie"] });
}

/* 8. Melody is set to "only open": she works Wed-Sun, always on the opening shift. */
{
  const avail = { Melody: {} };
  dates.slice(0, 2).forEach(d => avail.Melody[d] = "off");
  dates.slice(2).forEach(d => avail.Melody[d] = "must");
  const ws = names12.map(name => ({ name, canHost: true, only: name === "Melody" ? "open" : undefined }));
  const input = { dates, need, waiters: ws, avail, seed: 4 };
  const { r, a } = check(input, "Melody only opens", { exclude: ["Melody"], weekday2: 2 });
  const mel = a.rows.find(x => x.name === "Melody");
  ok(mel.open === 5 && mel.total === 5, "Melody has 5 shifts, all openings");
  ok(!a.warnings.some(w => w.type === "only"), "no 'only' warnings");
  const manual = { ...r.cells, "2026-10-28|close|0": "Melody" };
  ok(E.analyze(input, manual).warnings.some(w => w.type === "only" && w.name === "Melody"), "putting an 'only open' person on a close is reported");
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
