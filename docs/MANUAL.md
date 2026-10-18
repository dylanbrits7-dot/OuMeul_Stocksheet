# Ou Meul Stock — User Manual

For Dylan and the Ou Meul Pinelands team. The app runs in any browser (phone, tablet, PC). You sign in with your email and password. No Claude subscription is needed to use it.

---

## 1. Signing in

- **First time:** open the app link, tap **Create account**, enter your name, email and a password. You will see "Waiting for approval". Tell Dylan — he approves you and chooses which tabs you can use.
- **After that:** sign in with your email and password. Forgot it? Tap **Forgot password** and follow the email.
- **Sign out:** the button next to your name at the top.

## 2. Who sees what (Dylan / owner)

Open the **Team** tab (only owners see it). Every person who signed up appears there; new ones are highlighted.

| Setting | What it does |
|---|---|
| **Approved** | Tick to let the person in. Untick to lock them out. |
| **Tabs they can use** | Tick only the tabs that person needs. Everything else is hidden from them — and the database refuses to give them that data even if they try. |
| **View only** | They can look but not change anything. |
| **Quick set** | Counter (Count only) · Stock room (Count, Count sheets, Waste) · Manager (everything except Daily & Staff) · All tabs · No tabs |
| **Remove** | Tap twice. Takes away their access. |

Changes save straight away and apply the next time that person opens the app.

**Suggested set-up:** bar/kitchen counters → *Counter*; store-room person → *Stock room*; floor/GM → *Manager*; only Dylan (and anyone he trusts with money) gets **Daily** and **Staff**, because those hold takings and pay rates.

## 3. The tabs

| Tab | Used for |
|---|---|
| **Count** | Stocktakes. Start a count, count by location, save drafts, finalise. |
| **Variance** | Compare counted stock against GAAP stock-on-hand; recount the differences. |
| **Order** | Order sheets by supplier with minimum / target levels; suggested quantities. |
| **Waste** | Log spoilage / breakages; tick "also booked in GAAP" if it was already adjusted there. |
| **Daily** | Daily management overview (takings, sales, etc.) imported from GAAP. |
| **Staff** | Staff hours and shifts. Pay rates live here only. |
| **Count sheets** | Printable count sheets by location, category or in GAAP order. |
| **Invoices** | Capture supplier invoices (photos + details) and match prices. |
| **Items** | The stock list: codes, names, unit, cost, GAAP quantity, location. |
| **Team** | Owner only: people, backup, import. |

## 4. Weekly stocktake (every Monday)

1. **In GAAP:** export *Stock on hand*. Save it in `02_Stocktakes/<year>/<year>-<month>/` (see section 7).
2. **Items tab:** import the GAAP export so each item has its GAAP quantity.
3. **Count tab → New stocktake.** Choose *full* (or a partial count), give it a name, create.
4. Each counter picks their **location** (Kitchen, Store room shelves, Store room fridges, Shop, Front counter, Bar) and types in counts. Leave **Show GAAP qty** switched **off** so counts stay blind.
5. Counts save as you type. **Save draft** keeps a copy; **Clear all counts** wipes the counts for a restart; **Drafts** reopens a saved one.
6. **Variance tab:** items where the count differs from GAAP are listed. Have someone recount those and update.
7. When happy, **Finalise & lock**. Download the Excel, then post the adjustments in GAAP. Save the Excel into the same stocktake folder.

Printed count sheets: **Count sheets** tab → choose location / category / GAAP order → Print.

## 5. Ordering

**Order** tab → pick the supplier sheet (Food store, Bootlegger, …). Set each item's **minimum** and **target**; the app suggests quantity = target − on hand when stock is at or below the minimum. Orders you place are logged. Keep the supplier's own price list/PDF in `04_Orders/<Supplier>/`.

## 6. Month end

1. Do the last stocktake of the month and finalise it.
2. Download a **backup** (Team tab → *Download backup*) → `10_Backups`.
3. Put the month's GAAP exports, invoices and orders in their folders (section 7).
4. Optional: have Claude (on Dylan's own computer) prepare the monthly import file — section 8 — and import it in Team → *Import data*.

## 7. The data folder (on Dylan's PC)

Create one folder, for example `Documents\OuMeul-Data`, and connect **that folder** to Dylan's local Claude. A ready-made structure with a CLAUDE.md that explains it to Claude is in the project under `data-folder-template/` — copy it as `OuMeul-Data`.

```
OuMeul-Data/
├── CLAUDE.md                     <- tells Claude what is where (from the template)
├── 00_Inbox/                     <- drop anything new here first
├── 01_GAAP-Exports/
│   ├── stock-on-hand/            <- YYYY-MM-DD stock-on-hand.xlsx / .csv
│   ├── daily-management-overview/<- YYYY-MM daily overview
│   └── staff-hours/              <- YYYY-MM staff hours
├── 02_Stocktakes/
│   └── 2026/2026-10/             <- count Excel, variance notes, signed sheets
├── 03_Invoices/
│   └── <Supplier>/2026-10/       <- invoice PDFs / photos
├── 04_Orders/
│   └── <Supplier>/2026-10/       <- weekly orders, price lists (e.g. Bootlegger price list)
├── 05_Rosters/
│   ├── Waiters/                  <- waiters roster + section allocations
│   └── Bar/                      <- bar roster PDFs
├── 06_Floor-Plan/                <- floor plan, seating map, waiter sections
├── 07_Checklists/                <- deep-clean and opening/closing checklists
├── 08_Month-End/
│   └── 2026-10/                  <- month-end summary, reconciliations
├── 09_App-Imports/               <- JSON files prepared for Team → Import data
├── 10_Backups/                   <- ou-meul-backup-YYYY-MM-DD.json from the app
└── 99_Archive/                   <- finished years
```

**Naming rules:** dates as `YYYY-MM-DD`, months as `YYYY-MM`, no spaces at the start, supplier names consistent (`Bootlegger`, `Food-Store`).

## 8. Monthly import with your own Claude

You don't need to pay Claude to *run* the app. Claude is only useful once a month to turn the raw files into the app's import format. With the data folder connected to Claude on Dylan's PC, paste a prompt like:

> Read CLAUDE.md. Take the GAAP daily management overview in `01_GAAP-Exports/daily-management-overview/` for 2026-10 and write `09_App-Imports/daily-2026-10.json` in the format described in CLAUDE.md.

Do the same for staff hours (`staff`/`shifts`) or item prices (`items`). Then in the app: **Team → Import data → choose the file → Check file → Import**. Import never deletes anything; records with the same id are updated. "Keep fields that aren't in the file" (ticked by default) means a price update won't wipe the rest of an item.

Import file formats the app accepts:
- a full backup (`ou-meul-backup-….json`),
- `{ "collection": "daily", "docs": [ { "date": "2026-10-01", ... } ] }`,
- or a plain list, with the collection chosen from the dropdown.

## 9. Backups

- **Team → Download backup** produces `ou-meul-backup-YYYY-MM-DD.json` (everything except invoice photos). Do it weekly after the count, and always at month end. Keep in `10_Backups`.
- **Restore:** Team → Import data → choose the backup → Import.

## 10. Troubleshooting

| Problem | Fix |
|---|---|
| "Waiting for approval" | Dylan must approve you in Team. |
| A tab is missing | You haven't been given it. Ask Dylan. |
| Everything is view-only | "View only" is ticked for you. |
| "Couldn't save: permission-denied" | You don't have rights for that tab. Ask Dylan. |
| "resource-exhausted" / "quota" | The free daily limit of the database was hit. Wait until the next day (resets at midnight Pacific ≈ 09:00 SA time) or ask Brad about the paid plan. |
| Page looks old after an update | Refresh the page (pull down on a phone); sign out and in if needed. |
| Forgot password | Sign-in page → Forgot password. |
| Works offline? | The app remembers recent data and keeps working briefly offline; changes sync when back online. Don't rely on it for long periods. |
