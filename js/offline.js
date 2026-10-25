/* Ou Meul Stock: offline support.
   - shows a bar while the device has no internet
   - registers sw.js, which keeps the app's own files on the device so the app opens with no signal
   Data is kept offline by Firestore itself (see backend.js, enablePersistence). */
(function () {
  "use strict";
  const bar = document.getElementById("offlineBar");
  const update = () => { if (bar) bar.hidden = navigator.onLine !== false; };
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();

  const secure = location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if ("serviceWorker" in navigator && secure) {
    window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => { /* works online only */ }); });
  }
})();
