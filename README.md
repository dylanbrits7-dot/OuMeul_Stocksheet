# Ou Meul Stock

Stock-taking, variance, ordering, waste, daily, staff and waiters' roster app for Ou Meul Pinelands. Static web app (HTML/CSS/JS) + Firebase Auth + Firestore, hosted on GitHub Pages.

- `index.html`, `css/`, `js/` — the app
- `firebase-config.js` — paste the Firebase web config here
- `firestore.rules` — paste into Firebase → Firestore → Rules
- `sw.js`, `manifest.webmanifest`, `icons/` — lets the app open with no internet and be added to a phone's home screen
- `js/roster-engine.js`, `js/roster.js` — the waiters' roster balancer and its tab
- `docs/MANUAL.md` — user manual (Dylan and staff)
- `docs/SETUP-GUIDE.md` — installation / hand-over
- `data-folder-template/` — folder structure for Dylan's PC
- `tests/` — optional automated tests (`npm i playwright`, then `node tests/smoke.test.js` and `node tests/roster.test.js`; `node tests/roster-engine.test.js` needs nothing)
