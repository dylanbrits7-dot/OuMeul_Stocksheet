/* Smoke test: loads the app in Chromium with a fake database and clicks through it.
   Run:  node tests/smoke.test.js     (needs the playwright package; see tests/README.md) */
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html";
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[path.extname(f)] || "text/plain" }); res.end(fs.readFileSync(f));
});

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? "PASS  " : "FAIL  ") + msg); if (!cond) failed++; };

async function newPage(browser, backendScript) {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  // No internet needed: block fonts and the Firebase CDN.
  await page.route(/googleapis|gstatic/, r => r.abort());
  if (backendScript) await page.addInitScript({ path: path.join(root, "tests/mock-backend.js") }), await page.addInitScript(backendScript);
  return { page, errors, ctx };
}

(async () => {
  await new Promise(r => server.listen(0, r));
  const base = "http://127.0.0.1:" + server.address().port + "/index.html";
  const browser = await chromium.launch();

  /* 1. Not configured yet */
  {
    const { page, errors, ctx } = await newPage(browser);
    await page.goto(base);
    await page.waitForSelector("#setupBox:not([hidden])", { timeout: 5000 });
    ok(true, "shows the Setup needed screen when Firebase isn't configured");
    ok((await page.isHidden("#appRoot")), "app stays hidden until configured");
    ok(errors.length === 0, "no script errors on the setup screen " + errors.join("|"));
    await ctx.close();
  }

  /* 2. Owner session, full click-through */
  {
    const seed = {
      items: {
        a1: { code: "100", name: "Butter", area: "Kitchen Prep", unit: "kg", gaap: 12, cost: 95, loc: "kitchen" },
        a2: { code: "200", name: "Flour", area: "Dry Goods & Spices", unit: "kg", gaap: 50, cost: 12, loc: "dry" },
        a3: { code: "300", name: "Coffee beans", area: "Coffee & Tea", unit: "kg", gaap: 11.5, cost: 300, loc: "bar" }
      },
      users: {
        u1: { name: "Dylan", email: "d@example.com", role: "owner", approved: true, tabs: [] },
        u2: { name: "Nwabisa", email: "n@example.com", role: "staff", approved: false, tabs: [], readOnly: false }
      }
    };
    const { page, errors, ctx } = await newPage(browser, `window.OM_TEST_BACKEND=()=>OM_MOCK.make({role:"owner",name:"Dylan",seed:${JSON.stringify(seed)}})`);
    await page.goto(base);
    await page.waitForSelector("#appRoot:not([hidden])");
    ok(await page.isHidden("#authScreen"), "owner: app opens, sign-in screen hidden");
    const tabNames = await page.$$eval(".tabs button:not([hidden])", bs => bs.map(b => b.dataset.tab));
    ok(tabNames.length === 10 && tabNames.includes("team"), "owner sees all 9 tabs plus Team: " + tabNames.join(","));
    ok((await page.textContent("#whoName")) === "Dylan", "shows who is signed in");

    // start a stocktake and count an item
    await page.click("#newSessionBtn");
    await page.selectOption("#newKind", "full");
    await page.fill("#newSessionName", "Smoke stocktake");
    await page.click("#createSessionBtn");
    await page.waitForFunction(() => OM_MOCK.writes.some(w => w[1].startsWith("sessions/")));
    ok(true, "New stocktake writes a session");
    await page.waitForSelector("#countList [data-id], #countList .row, #countList input", { timeout: 5000 });
    const firstInput = await page.$("#countList input");
    ok(!!firstInput, "count list shows items to count");
    if (firstInput) {
      await firstInput.fill("7");
      await page.waitForFunction(() => OM_MOCK.writes.filter(w => w[1].startsWith("sessions/")).length >= 2, null, { timeout: 8000 });
      ok(true, "typing a count saves to the session");
    }

    // visit every tab
    for (const t of ["variance", "order", "waste", "daily", "staff", "sheets", "invoices", "items", "team", "count"]) {
      await page.click(`.tabs button[data-tab="${t}"]`);
      await page.waitForTimeout(150);
      const shown = await page.$eval("#view-" + t, el => !el.hidden);
      ok(shown, "tab opens: " + t);
    }
    ok(await page.isHidden("#invRead"), "Read invoice (needs Claude) is hidden");

    // Team: approve the pending person
    await page.click('.tabs button[data-tab="team"]');
    const pendingRow = await page.$('tr[data-uid="u2"].pending');
    ok(!!pendingRow, "Team shows the new person as waiting for approval");
    await page.check('tr[data-uid="u2"] input[data-ok]');
    await page.waitForFunction(() => OM_MOCK.store.users.get("u2").approved === true);
    const u2 = await page.evaluate(() => OM_MOCK.store.users.get("u2"));
    ok(u2.approved && u2.tabs.join() === "count", "approving gives the basic Count tab: " + JSON.stringify(u2.tabs));
    await page.selectOption('tr[data-uid="u2"] select[data-preset]', "manager");
    await page.waitForFunction(() => OM_MOCK.store.users.get("u2").tabs.includes("order"));
    const u2b = await page.evaluate(() => OM_MOCK.store.users.get("u2").tabs);
    ok(!u2b.includes("daily") && !u2b.includes("staff") && u2b.includes("variance"), "Manager preset leaves out Daily and Staff: " + u2b.join());

    // Backup download
    const [dl] = await Promise.all([page.waitForFunction(() => window.OM_MOCK.downloads && window.OM_MOCK.downloads.length), page.click("#tmExport")]);
    const backup = await page.evaluate(() => JSON.parse(OM_MOCK.downloads[0].data));
    ok(backup._format === "ou-meul-backup" && backup.collections.items.length === 3, "backup contains the 3 items");
    ok(backup.collections.items[0].id && !JSON.stringify(backup).includes("password"), "backup records carry their ids");

    // Import a monthly daily file
    const importFile = path.join(__dirname, "_import-test.json");
    fs.writeFileSync(importFile, JSON.stringify({ collection: "daily", docs: [{ date: "2026-10-01", tto: 12345.67, actualSales: 10000 }, { date: "2026-10-02", tto: 9000, actualSales: 7800 }] }));
    await page.setInputFiles("#tmFile", importFile);
    await page.click("#tmPreview");
    await page.waitForSelector("#tmImpMsg .note.info");
    ok((await page.textContent("#tmImpMsg")).includes("daily 2"), "import preview counts the records");
    await page.click("#tmRun");
    await page.waitForFunction(() => OM_MOCK.store.daily && OM_MOCK.store.daily.size === 2);
    ok(await page.evaluate(() => OM_MOCK.store.daily.has("2026-10-01")), "daily records are stored under their date");
    fs.unlinkSync(importFile);
    // price update that must keep the rest of the item
    const priceFile = path.join(__dirname, "_price-test.json");
    fs.writeFileSync(priceFile, JSON.stringify({ collection: "items", docs: [{ id: "a1", cost: 101.5 }] }));
    await page.setInputFiles("#tmFile", priceFile);
    await page.click("#tmPreview"); await page.waitForSelector("#tmImpMsg .note.info");
    await page.click("#tmRun");
    await page.waitForFunction(() => OM_MOCK.store.items.get("a1").cost === 101.5);
    const a1 = await page.evaluate(() => OM_MOCK.store.items.get("a1"));
    ok(a1.name === "Butter" && a1.cost === 101.5, "importing a price keeps the rest of the item (merge)");
    fs.unlinkSync(priceFile);

    // Daily tab now has data
    await page.click('.tabs button[data-tab="daily"]');
    await page.waitForTimeout(300);
    ok(await page.isVisible("#dMain"), "Daily tab shows the imported days");

    ok(errors.length === 0, "no script errors during the owner click-through " + errors.join(" | "));
    await ctx.close();
  }

  /* 3. Counter-only person */
  {
    const seed = { items: { a1: { code: "100", name: "Butter", area: "Kitchen Prep", unit: "kg", gaap: 12, cost: 95, loc: "kitchen" } },
      sessions: { s1: { name: "Monday", status: "open", startedAt: Date.now(), kind: "full", loc: {} } } };
    const { page, errors, ctx } = await newPage(browser, `window.OM_TEST_BACKEND=()=>OM_MOCK.make({role:"staff",tabs:["count"],name:"Bongani",seed:${JSON.stringify(seed)}})`);
    await page.goto(base);
    await page.waitForSelector("#appRoot:not([hidden])");
    const tabNames = await page.$$eval(".tabs button:not([hidden])", bs => bs.map(b => b.dataset.tab));
    ok(tabNames.join() === "count", "counter sees only the Count tab: " + tabNames.join());
    await page.waitForTimeout(400);
    const listened = await page.evaluate(() => OM_MOCK.listened);
    const forbidden = ["staff", "shifts", "daily", "orderSheets", "orderLog", "invoices", "settings/pay"].filter(c => listened.includes(c));
    ok(forbidden.length === 0, "counter's app never asks for money/staff data (listened: " + [...new Set(listened)].join(", ") + ")");
    ok(await page.isHidden('.tabs button[data-tab="team"]'), "counter has no Team tab");
    ok(errors.length === 0, "no script errors for the counter " + errors.join(" | "));
    await ctx.close();
  }

  /* 4. View-only person */
  {
    const seed = { items: { a1: { code: "100", name: "Butter", area: "Kitchen Prep", unit: "kg", gaap: 12, cost: 95, loc: "kitchen" } },
      sessions: { s1: { name: "Monday", status: "open", startedAt: Date.now(), kind: "full", loc: {} } } };
    const { page, errors, ctx } = await newPage(browser, `window.OM_TEST_BACKEND=()=>OM_MOCK.make({role:"staff",tabs:["count","items"],readOnly:true,name:"Viewer",seed:${JSON.stringify(seed)}})`);
    await page.goto(base);
    await page.waitForSelector("#appRoot:not([hidden])");
    await page.waitForTimeout(300);
    ok(await page.isHidden("#newSessionBtn") || await page.$eval("#newSessionBtn", b => b.disabled), "view-only person can't start a stocktake");
    ok(errors.length === 0, "no script errors for view-only " + errors.join(" | "));
    await ctx.close();
  }

  await browser.close(); server.close();
  console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
