# Ou Meul Pinelands — data folder

You are helping Dylan (owner, Ou Meul Pinelands restaurant) prepare monthly data for his stock-taking web app. This folder is his working archive.

## Folder map
- `00_Inbox/` new, unsorted files — help file them into the folders below.
- `01_GAAP-Exports/` raw exports from the GAAP system: `stock-on-hand/`, `daily-management-overview/`, `staff-hours/`.
- `02_Stocktakes/YYYY/YYYY-MM/` count Excel files and variance notes.
- `03_Invoices/<Supplier>/YYYY-MM/` supplier invoices.
- `04_Orders/<Supplier>/YYYY-MM/` orders and supplier price lists.
- `05_Rosters/Waiters`, `05_Rosters/Bar` rosters.
- `06_Floor-Plan/` floor plan, seating map, waiter sections.
- `07_Checklists/` cleaning / opening / closing checklists.
- `08_Month-End/YYYY-MM/` month-end summaries.
- `09_App-Imports/` JSON files for the app's Team → Import data screen (you create these).
- `10_Backups/` JSON backups downloaded from the app. Never edit these.
- `99_Archive/` closed years.

## Rules
- Never delete or overwrite originals in 01–08; read them and write new files to `09_App-Imports/`.
- Names: dates `YYYY-MM-DD`, months `YYYY-MM`. Currency is South African rand (ZAR).
- Tell Dylan about anything that doesn't add up instead of guessing.

## Import file format (09_App-Imports)
Write one JSON file per collection:
```json
{ "collection": "daily", "docs": [ { "date": "2026-10-01", "tto": 12345.67, "actualSales": 10000 } ] }
```
- `daily`: one record per day; `date` is `YYYY-MM-DD` (it becomes the record id). Use the same field names as earlier imports/backups in `10_Backups/` — open the latest backup and copy the shape of an existing `daily` record before writing new ones.
- `items`: records need the existing item `id` (copy from a backup) plus only the fields to change, e.g. `{ "id": "a1", "cost": 101.5 }`. The app merges, so other fields are kept.
- `staff` / `shifts`: copy the shape from the latest backup.
- Never invent numbers. If a value is missing in the source, leave the field out.
- File name: `<collection>-YYYY-MM.json`.

## Monthly routine
1. Check `00_Inbox/` and file everything.
2. Build the import files for the month from the GAAP exports.
3. Give Dylan a short list: what was imported, what was missing, anything odd.
