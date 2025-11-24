// Service Worker registration snippet (site-wide)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
      .then(function (reg) {
        console.log('Service worker registered with scope:', reg.scope);
      })
      .catch(function (err) {
        console.error('Service worker registration failed:', err);
      });
  });
}
