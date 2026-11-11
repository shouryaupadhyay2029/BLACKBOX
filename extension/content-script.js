/**
 * KALA Chrome Extension — Content Script Injector
 * Automatically injects the KALA Browser Agent into any localhost page
 * (excluding the KALA Studio UI port 9876 itself).
 */
(function () {
  if (window.location.port === '9876') return;

  const script = document.createElement('script');
  script.src = 'http://localhost:9876/sdk/browser-agent.js';
  script.setAttribute('data-kala-endpoint', 'http://localhost:9876');
  script.async = false;
  (document.head || document.documentElement).appendChild(script);
})();
