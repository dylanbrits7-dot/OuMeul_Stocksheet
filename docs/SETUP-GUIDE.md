# Hand-over guide — installing the Ou Meul Stock app for Dylan

For Brad. Goal: Dylan has a web app on **his own GitHub (free hosting)** with **his own Firebase (free database + logins)**, so nobody pays Claude to operate it. Do these steps **with Dylan present** — the accounts must be his, and passwords/verification codes are his to type.

Time: about 45 minutes. Cost: R0 on the free plans (limits in section 8).

## What you need
- The project folder (`ou-meul-stock-app`) on your PC.
- Dylan's email address (Gmail is simplest — Firebase uses a Google account).
- Git installed (https://git-scm.com) — or use GitHub Desktop, or upload files in the browser.

---

## 1. Dylan's GitHub account and repository

> **Already done:** account `dylanbrits7-dot`, repo https://github.com/dylanbrits7-dot/OuMeul_Stocksheet.git. Live address once Pages is on: https://dylanbrits7-dot.github.io/OuMeul_Stocksheet/ . Skip to step 3 (push the code) — make sure the repo is **Public**.

1. Dylan goes to https://github.com/signup with his email and creates the account (he chooses the username and password, and verifies his email).
2. Create a repository: **New repository** → name `OuMeul_Stocksheet` (already created) → **Public** → *don't* add a README → Create.
   - GitHub Pages on the free plan needs a **public** repo. The code contains no secrets (the Firebase web config is meant to be public; the **rules** protect the data). Staff data is never in the repo.
3. Put the code in. Either:
   - **Browser upload:** repo page → *uploading an existing file* → drag in the contents of `ou-meul-stock-app` (index.html, css, js, firebase-config.js, firestore.rules, docs …) → Commit. **or**
   - **Git:**
     ```
     cd ou-meul-stock-app
     git init
     git add .
     git commit -m "Ou Meul Stock app"
     git branch -M main
     git remote add origin https://github.com/dylanbrits7-dot/OuMeul_Stocksheet.git
     git push -u origin main
     ```
     (GitHub asks Dylan to sign in.)
4. Turn on hosting: repo → **Settings → Pages** → Source: *Deploy from a branch* → Branch `main`, folder `/ (root)` → Save. After a minute the site is live at `https://dylanbrits7-dot.github.io/OuMeul_Stocksheet/`.

## 2. Firebase project (Dylan's Google account)

1. https://console.firebase.google.com → sign in as Dylan → **Add project** → name `ou-meul-stock` → turn Google Analytics **off** → Create.
2. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable → Save.**
3. **Authentication → Settings → Authorized domains → Add domain:** `dylanbrits7-dot.github.io`.
4. **Build → Firestore Database → Create database** → *Production mode* → location: choose `eur3` or the nearest (e.g. a Europe region; South Africa is not always offered) → Enable.
5. **Firestore → Rules:** delete what's there, paste the whole of `firestore.rules` from the project, **Publish**.
6. **Project settings (gear) → General → Your apps → Web (</>)** → nickname `ou-meul-web` → Register (no Firebase Hosting). Copy the `firebaseConfig` values.
7. Open `firebase-config.js` in the project and replace the four `PASTE_…` values (`apiKey`, `authDomain`, `projectId`, `appId`) with the copied ones. Save, then upload/commit it to GitHub again (replace the file). Pages republishes in about a minute.

## 3. Make Dylan the owner (one-time)

1. Open the live site. Tap **Create account**, enter Dylan's name, email and password → he lands on "Waiting for approval".
2. Firebase console → **Firestore Database → Data → `users`** → click Dylan's document (its id is his user id) and edit:
   - `role` = `owner`
   - `approved` = `true` (boolean)
3. Dylan refreshes the site. He now sees all tabs plus **Team**.
4. Everyone else signs up themselves and is approved in the app (see MANUAL.md section 2). No more console work.

## 4. Load the data

Brad's source files are in `source-files/` and `source-chats/` (stock list in `stock/stocktake.xlsx`, GAAP exports, rosters, etc.).

- Items: in the app, Items tab → import the GAAP stock-on-hand export (see the Items tab's import).
- If you prepare a JSON file, use Team → Import data (formats in MANUAL.md section 9).
- **Existing data in the old Claude-hosted draft is not migrated automatically.** If Dylan wants it, open the old draft once he has Claude access, and export it; otherwise re-import from GAAP.

## 5. Data folder + Claude on Dylan's PC

1. Copy `data-folder-template` to `Documents\OuMeul-Data` on Dylan's PC (rename it).
2. In his Claude desktop app, connect that folder. The `CLAUDE.md` inside tells Claude the layout. Monthly workflow: MANUAL.md section 9.
3. Move his historic files in using the numbered folders (`source-files/` has a suggested mapping: rosters → `05_Rosters`, floor-plan → `06_Floor-Plan`, checklists → `07_Checklists`, orders → `04_Orders`, stock → `02_Stocktakes`).

## 6. Add the shortcut for staff
On each phone: open the site → browser menu → **Add to Home screen**.

## 7. Updating the app later
Change the files → push/upload to GitHub → refresh (Pages redeploys in about a minute). If the rules changed, paste the new `firestore.rules` into Firebase → Rules → Publish. The **Roster** tab needs this: the rules add `rosters` and `settings/roster`. Then, in the Team tab, tick **Roster** for the people who plan the roster (owners always have it).

## 8. Limits and costs (free "Spark" plan, checked at the time of writing — confirm in the console)
- Firestore: about 50,000 reads and 20,000 writes per day, 1 GiB stored. A normal restaurant day is far below this. The app only listens to what each person's tabs need.
- Authentication (email/password): free.
- GitHub Pages: free for public repos.
- No Firebase Storage is used (so no card is needed). Invoice photos are stored inside the database in small pages — keep photos modest, or file the originals in `03_Invoices`.
- If the daily limit is ever hit, the app shows a "resource-exhausted" message and recovers the next day.

## 9. Safety checklist
- Dylan keeps the GitHub and Google passwords; Brad should not keep them. Add Brad as a collaborator if he'll maintain it.
- Only Dylan (owner) can see Daily/Staff unless he ticks them for someone.
- Weekly: Team → Download backup → `10_Backups`.
- Don't share the owner account.

## 10. Known caveats (be honest with Dylan)
- Built and tested here against a simulated database; the first run on the live Firebase project is the real test — run through: sign up, approve, new stocktake, count, finalise, backup, import.
- "Read invoice" (automatic reading by Claude) is switched off, because it needs Claude credits. Invoices can still be captured by hand.
- Firestore security rules limit each person to their tabs; test with a second account (Counter preset) and confirm they can't open Daily/Staff.
