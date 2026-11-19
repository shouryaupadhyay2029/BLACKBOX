/**
 * BLACKBOX Chrome/Edge Extension — Background Service Worker
 * Handles global keyboard shortcut (Alt+Shift+B) and communicates with the Blackbox Daemon.
 */
chrome.commands.onCommand.addListener((command) => {
  if (command === 'freeze-capsule') {
    fetch('http://localhost:9876/api/freeze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ triggerReason: 'CHROME_EXTENSION_SHORTCUT' }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data && data.studioUrl) {
          chrome.tabs.create({ url: data.studioUrl });
        }
      })
      .catch(() => {});
  }
});
