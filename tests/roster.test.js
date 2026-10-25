/* Browser test for the Roster tab, including working with no internet.
   Run:  node tests/roster.test.js     (needs the playwright package, like smoke.test.js) */
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html";
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[path.extname(f)] || "text/plain" }); res.end(fs.readFileSync(f));
});

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? "PASS  " : "FAIL  ") + msg); if (!cond) failed++; };

async function newPage(browser, backendScript, opts = {}) {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1200, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"], ...opts });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|net::ERR/.test(m.text())) errors.push("console: " + m.text()); });
  await page.route(/googleapis|gstatic/, r => r.abort());
  await page.addInitScript({ path: path.join(root, "tests/mock-backend.js") });
  await page.addInitScript(backendScript);
  return { page, errors, ctx };
}

const grid = page => page.$$eval("select[data-key]", els => Object.fromEntries(els.map(e => [e.dataset.key, e.value])));
const tile = async (page, label) => page.$$eval("#rTiles .tile", (ts, l) => { const t = ts.find(x => x.querySelector(".lbl").textContent === l); return t ? t.querySelector(".v").textContent : null; }, label);
const counts = page => page.$$eval("#rCounts tbody tr:not(.tot)", rows => Object.fromEntries(rows.map(r => { const c = [...r.children].map(x => x.textContent.trim()); return [c[0].replace(/set days$/, "").trim(), { open: +c[1], mid: +c[2], close: +c[3], host: +c[4], total: +c[5], wk: +c[6], we: +c[7] }]; })));
async function balance(page, label = "Auto-balance") {
  await page.click(`#rActions [data-act="all"]`);
  await page.waitForFunction(() => !document.querySelector('#rActions [data-act="all"]').disabled, null, { timeout: 15000 });
  await page.waitForTimeout(100);
}

(async () => {
  await new Promise(r => server.listen(0, r));
  const base = "http://127.0.0.1:" + server.address().port + "/index.html";
  const browser = await chromium.launch();
  const owner = `window.OM_TEST_BACKEND=()=>OM_MOCK.make({role:"owner",name:"Dylan"})`;

  /* 1. The week Brad asked for: Melody off Mon+Tue, works Wed-Sun, only opens; everyone else shares the rest. */
  {
    const { page, errors, ctx } = await newPage(browser, owner);
    await page.goto(base);
    await page.waitForSelector("#appRoot:not([hidden])");
    await page.click('.tabs button[data-tab="roster"]');
    await page.waitForSelector("#rGrid select[data-key]");
    ok(await page.isVisible("#view-roster"), "Roster tab opens");
    await page.fill("#rWeek", "2026-10-26"); await page.dispatchEvent("#rWeek", "change");
    await page.waitForFunction(() => /26 Oct/.test(document.querySelector("#rRange").textContent));
    ok((await page.textContent("#rRange")).includes("Mon 26 Oct to Sun 1 Nov 2026"), "week label: " + await page.textContent("#rRange"));
    let g = await grid(page);
    ok(Object.keys(g).length === 47, "grid has 47 spots for the usual week: " + Object.keys(g).length);
    ok((await tile(page, "Spots filled")) === "0 / 47", "all spots start empty");

    // Melody: off Mon, Tue (tap once), must work Wed-Sun (tap twice)
    const av = (n, d) => `.rav[data-n="${n}"][data-d="${d}"]`;
    for (const d of ["2026-10-26", "2026-10-27"]) await page.click(av("Melody", d));
    for (const d of ["2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]) { await page.click(av("Melody", d)); await page.click(av("Melody", d)); }
    ok((await page.textContent(av("Melody", "2026-10-26"))) === "OFF" && (await page.textContent(av("Melody", "2026-10-28"))) === "WORK", "tapping a day cycles free > OFF > WORK");
    // Melody only opens
    await page.click("#rp-waiters summary");
    await page.selectOption('select[data-wf="only"][data-wi="11"]', "open");
    await page.waitForFunction(() => OM_MOCK.store.settings && OM_MOCK.store.settings.get("roster"));
    ok(await page.evaluate(() => OM_MOCK.store.settings.get("roster").waiters.find(w => w.name === "Melody").only === "open"), "'only opens' for Melody is saved in settings/roster");

    await balance(page);
    g = await grid(page);
    ok(Object.values(g).every(Boolean), "Auto-balance fills every spot");
    ok((await tile(page, "Spots filled")) === "47 / 47", "tile says 47 / 47");
    const c = await counts(page);
    ok(c.Melody && c.Melody.total === 5 && c.Melody.open === 5 && c.Melody.wk === 2, "Melody: 5 shifts, all opens, Wed-Sun: " + JSON.stringify(c.Melody));
    const others = Object.entries(c).filter(([n]) => n !== "Melody" && c[n].total > 0);
    ok(others.length === 11 || others.length === 12 - 1, "11 other waiters are working: " + others.length);
    const tot = others.map(([, v]) => v.total);
    ok(Math.max(...tot) - Math.min(...tot) <= 1, "everyone else within one shift of each other: " + others.map(([n, v]) => n + v.total).join(" "));
    ok(others.every(([, v]) => v.wk === 2), "everyone else has exactly 2 shifts Mon-Thu");
    ok(Object.values(c).reduce((a, v) => a + v.total, 0) === 47, "counts add up to 47");
    ok(!Object.keys(c).some(n => /Nigel|Calvin/.test(n) && c[n].total), "Nigel and Calvin (special days) are not used");
    ok(!(await page.isVisible("#rWarn")), "no problems listed");

    // Saved to the database
    await page.waitForFunction(() => OM_MOCK.store.rosters && OM_MOCK.store.rosters.get("2026-10-26"));
    const saved = await page.evaluate(() => OM_MOCK.store.rosters.get("2026-10-26"));
    ok(Object.keys(saved.cells).length === 47, "roster saved under the Monday date with 47 cells");
    ok(saved.by === "Dylan", "saved with who changed it");

    // Manual choice locks the spot; re-balancing keeps it
    const key = "2026-10-30|close|2";
    await page.selectOption(`select[data-key="${key}"]`, "Zoe");
    ok(await page.$eval(`select[data-key="${key}"]`, e => e.closest("td").classList.contains("pinned")), "a name picked by hand is locked");
    await balance(page);
    g = await grid(page);
    ok(g[key] === "Zoe", "Auto-balance keeps the locked name");
    await page.click(`[data-lock="${key}"]`);
    ok(!(await page.$eval(`select[data-key="${key}"]`, e => e.closest("td").classList.contains("pinned"))), "tapping the padlock unlocks");

    // A mistake is shown: Melody on Monday
    await page.selectOption('select[data-key="2026-10-26|open|0"]', "Melody");
    await page.waitForSelector("#rWarn:not([hidden])");
    const warn = await page.textContent("#rWarn");
    ok(/Melody/.test(warn) && /OFF/.test(warn), "putting Melody on her off day is flagged: " + warn.replace(/\s+/g, " ").slice(0, 120));
    // Fill empty only keeps everything else
    const before = await grid(page);
    await page.selectOption('select[data-key="2026-10-26|open|0"]', "");
    await page.click('#rActions [data-act="fill"]');
    await page.waitForFunction(() => !document.querySelector('#rActions [data-act="fill"]').disabled);
    await page.waitForTimeout(100);
    const after = await grid(page);
    const diff = Object.keys(before).filter(k => before[k] !== after[k]);
    ok(diff.length === 1 && diff[0] === "2026-10-26|open|0", "Fill empty spots only changes the one empty spot");
    ok(after["2026-10-26|open|0"] && after["2026-10-26|open|0"] !== "Melody", "the empty spot was filled with someone who can work");

    // Needs
    await page.click("#rp-need summary");
    await page.fill('input[data-need="2026-10-27|open"]', "4"); await page.dispatchEvent('input[data-need="2026-10-27|open"]', "change");
    ok(Object.keys(await grid(page)).length === 48, "asking for a 4th opener on Tuesday adds a spot");
    ok((await tile(page, "Spots filled")) === "47 / 48", "tile shows one empty spot");
    await page.click("#rNeedReset");
    ok(Object.keys(await grid(page)).length === 47, "back to the usual numbers");

    // Wage estimate matches Dylan's Excel total once all spots are filled
    await balance(page);
    const wage = await tile(page, "Wage estimate");
    ok(/11\D?404[.,]08/.test((wage || "").replace(/\s/g, " ").replace(/ /g, " ").replace(/ /g, "")) || /11.?404.08/.test(wage || ""), "wage estimate is R 11 404,08, same as the Excel: " + wage);

    // Share and export
    await page.click('#rActions [data-act="text"]');
    await page.waitForTimeout(200);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    ok(/WAITERS ROSTER/.test(clip) && /MON 26 OCT/.test(clip) && /6TO1:/.test(clip) && /9 TO 4:/.test(clip) && /SHIFTS THIS WEEK/.test(clip), "WhatsApp text copied (with Sunday 9 TO 4)");
    await page.click('#rActions [data-act="xlsx"]');
    await page.waitForFunction(() => window.OM_MOCK.downloads && window.OM_MOCK.downloads.length);
    ok(await page.evaluate(() => /roster-2026-10-26\.xlsx$/.test(OM_MOCK.downloads[0].filename)), "Excel file offered");

    // Next week: copy last week, then balance with last week's variety rule
    await page.click("#rNext");
    await page.waitForFunction(() => /2 Nov/.test(document.querySelector("#rRange").textContent));
    ok(Object.values(await grid(page)).every(v => !v), "next week starts empty");
    await page.click('#rActions [data-act="copy"]');
    ok(Object.values(await grid(page)).every(Boolean), "Copy last week fills next week");
    await page.click('#rActions [data-act="clear"]'); // first tap only arms
    ok((await page.textContent('#rActions [data-act="clear"]')).includes("Tap again"), "Clear needs a second tap");
    await page.click('#rActions [data-act="clear"]');
    ok(Object.values(await grid(page)).every(v => !v), "second tap clears the unlocked spots");
    await page.click("#rPrev");
    ok((await tile(page, "Spots filled")) === "47 / 47", "going back shows the saved week");

    ok(errors.length === 0, "no script errors " + errors.join(" | "));
    await ctx.close();
  }

  /* 2. Working with no internet: edits stay on screen and are kept until the connection returns. */
  {
    const { page, errors, ctx } = await newPage(browser, owner);
    await page.goto(base);
    await page.waitForSelector("#appRoot:not([hidden])");
    await page.click('.tabs button[data-tab="roster"]');
    await page.fill("#rWeek", "2026-11-02"); await page.dispatchEvent("#rWeek", "change");
    await page.waitForFunction(() => /2 Nov/.test(document.querySelector("#rRange").textContent));
    await ctx.setOffline(true);
    await page.evaluate(() => { OM_MOCK.goOffline(); window.dispatchEvent(new Event("offline")); });
    ok(await page.isVisible("#offlineBar"), "offline bar appears");
    await balance(page);
    ok((await tile(page, "Spots filled")) === "47 / 47", "auto-balance works with no internet");
    await page.selectOption('select[data-key="2026-11-04|close|0"]', "Zama");
    await page.waitForFunction(() => /device/.test(document.querySelector("#rStatus").textContent));
    ok(/Saved on this device/.test(await page.textContent("#rStatus")), "status: " + await page.textContent("#rStatus"));
    ok((await grid(page))["2026-11-04|close|0"] === "Zama", "edit stays on screen while offline");
    await ctx.setOffline(false);
    await page.evaluate(() => { OM_MOCK.goOnline(); window.dispatchEvent(new Event("online")); });
    await page.waitForFunction(() => /^Saved/.test(document.querySelector("#rStatus").textContent));
    ok(!(await page.isVisible("#offlineBar")), "offline bar goes away");
    const saved = await page.evaluate(() => OM_MOCK.store.rosters.get("2026-11-02"));
    ok(saved && saved.cells["2026-11-04|close|0"] === "Zama" && Object.keys(saved.cells).length === 47, "everything done offline is kept after reconnecting");
    ok(errors.length === 0, "no script errors offline " + errors.join(" | "));
    await ctx.close();
  }

  /* 3. The app itself opens with no internet (service worker). */
  {
    const { page, errors, ctx } = await newPage(browser, owner);
    await page.goto(base);
    await page.waitForSelector("#appRoot:not([hidden])");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(async () => (await caches.keys()).length > 0 && (await (await caches.open("om-shell-v1")).keys()).length >= 10, null, { timeout: 10000 });
    ok(true, "service worker installed and the app files are saved on the device");
    await page.reload(); // now controlled by the worker
    await page.waitForSelector("#appRoot:not([hidden])");
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector("#appRoot:not([hidden])", { timeout: 10000 });
    ok(true, "app reloads and opens with no internet");
    await page.click('.tabs button[data-tab="roster"]');
    await page.waitForSelector("#rGrid select[data-key]");
    ok(await page.isVisible("#offlineBar"), "offline bar shows after an offline reload");
    ok(await page.evaluate(() => typeof OM_ROSTER_ENGINE.solve === "function"), "roster engine is available offline");
    ok(errors.length === 0, "no script errors on an offline start " + errors.join(" | "));
    await ctx.close();
  }

  /* 4. Permissions */
  {
    const seed = { rosters: { "2026-10-26": { week: "2026-10-26", cells: { "2026-10-26|open|0": "Freddie" }, pins: {}, avail: {}, need: {} } } };
    const viewer = `window.OM_TEST_BACKEND=()=>OM_MOCK.make({role:"staff",tabs:["roster"],readOnly:true,name:"Melody",seed:${JSON.stringify(seed)}})`;
    const { page, errors, ctx } = await newPage(browser, viewer);
    await page.goto(base);
    await page.waitForSelector("#appRoot:not([hidden])");
    await page.fill("#rWeek", "2026-10-26"); await page.dispatchEvent("#rWeek", "change");
    await page.waitForFunction(() => document.querySelector('select[data-key="2026-10-26|open|0"]') && document.querySelector('select[data-key="2026-10-26|open|0"]').value === "Freddie");
    ok(await page.$eval('select[data-key="2026-10-26|open|0"]', e => e.disabled), "view-only person can't change the roster");
    ok(await page.isHidden('#rActions [data-act="all"]'), "view-only person has no Auto-balance button");
    ok(await page.isVisible('#rActions [data-act="print"]') && await page.isVisible('#rActions [data-act="text"]'), "view-only person can still print and copy");
    ok(!(await page.evaluate(() => OM_MOCK.writes.length)), "no writes from a view-only person");
    ok(errors.length === 0, "no script errors for view-only " + errors.join(" | "));
    await ctx.close();

    const counter = `window.OM_TEST_BACKEND=()=>OM_MOCK.make({role:"staff",tabs:["count"],name:"Counter"})`;
    const c2 = await newPage(browser, counter);
    await c2.page.goto(base);
    await c2.page.waitForSelector("#appRoot:not([hidden])");
    ok(!(await c2.page.evaluate(() => OM_MOCK.listened.some(p => /roster/.test(p)))), "a person without the Roster tab never asks for roster data");
    ok(await c2.page.isHidden('.tabs button[data-tab="roster"]'), "Roster tab hidden for them");
    await c2.ctx.close();
  }

  await browser.close();
  server.close();
  console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
