/**
 * BLACKBOX Chrome/Edge Extension Content Script
 * Automatically injects the Blackbox Browser Agent SDK into any localhost application.
 */
(function injectBlackboxSdk() {
  if (window.location.port === '9876') return;
  if (document.getElementById('__blackbox_sdk_script__')) return;

  const script = document.createElement('script');
  script.id = '__blackbox_sdk_script__';
  script.src = 'http://localhost:9876/sdk/browser-agent.js';
  script.setAttribute('data-blackbox-endpoint', 'http://localhost:9876');
  script.async = false;
  (document.head || document.documentElement).appendChild(script);
})();
